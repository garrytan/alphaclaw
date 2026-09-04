const {
  kStateDbQuietEventKind,
  kStateDbQuietEnvKey,
  kListenerBeginBudgetMs,
  kHandleDrainBudgetMs,
  kBackupInProgressCode,
  kBackupInProgressMessage,
  kStateDbQuietRetryAfterSec,
  StateDbQuietError,
  onStateDbQuiet,
  beginStateDbQuiet,
  releaseStateDbQuiet,
  isStateDbQuiet,
  whenStateDbQuietReleased,
  getStateDbQuietState,
  enterStateDbHandle,
  exitStateDbHandle,
  withStateDbHandle,
  getStateDbHandleCount,
  resetStateDbQuietForTests,
} = require("../../lib/server/state-db-quiet");
const { sendIfStateDbQuietError } = require("../../lib/server/utils/state-db-quiet-http");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

const kOwner = "test-backup";
const kMaxMs = 60_000;

const makeListener = (name, overrides = {}) => ({
  name,
  begin: vi.fn(),
  end: vi.fn(),
  ...overrides,
});

const eventsOf = (onEvent, status) =>
  onEvent.mock.calls.map(([event]) => event).filter((event) => event.status === status);

// Attaches a settled flag to a promise so a test can assert "still pending"
// without racing a timeout against it.
const track = (promise) => {
  const state = { settled: false, error: null };
  promise.then(
    () => {
      state.settled = true;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
};

describe("server/state-db-quiet", () => {
  beforeEach(() => {
    resetStateDbQuietForTests({ listeners: true });
    delete process.env[kStateDbQuietEnvKey];
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStateDbQuietForTests({ listeners: true });
    delete process.env[kStateDbQuietEnvKey];
  });

  describe("begin", () => {
    it("sets the flag synchronously, awaits every listener's begin(), and returns a matching token", async () => {
      const order = [];
      const a = makeListener("a", {
        begin: vi.fn(async () => {
          order.push("a:begin");
        }),
      });
      const b = makeListener("b", {
        begin: vi.fn(() => {
          order.push("b:begin");
        }),
      });
      onStateDbQuiet(a);
      onStateDbQuiet(b);
      const onEvent = vi.fn();

      const pending = beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });
      expect(isStateDbQuiet()).toBe(true);
      const { token, release } = await pending;

      expect(order).toEqual(["a:begin", "b:begin"]);
      expect(token).toEqual(expect.objectContaining({ owner: kOwner, disabled: false }));
      expect(typeof release).toBe("function");
      expect(getStateDbQuietState()).toEqual(
        expect.objectContaining({ quiet: true, owner: kOwner, expired: false, openHandles: 0 }),
      );
      expect(getStateDbQuietState().since).toBeGreaterThan(0);
      expect(eventsOf(onEvent, "begin")).toHaveLength(1);
      expect(eventsOf(onEvent, "quiet")).toEqual([
        expect.objectContaining({
          kind: kStateDbQuietEventKind,
          owner: kOwner,
          maxMs: kMaxMs,
          listenerMs: expect.any(Number),
          drainMs: expect.any(Number),
        }),
      ]);
      expect(a.end).not.toHaveBeenCalled();
    });

    it("waits for an async listener that resolves later", async () => {
      vi.useFakeTimers();
      const listener = makeListener("slowish", {
        begin: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 500))),
      });
      onStateDbQuiet(listener);

      const pending = track(beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs }));
      await vi.advanceTimersByTimeAsync(400);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(pending.settled).toBe(true);
      expect(pending.error).toBeNull();
    });

    it("bounds a never-resolving listener by the shared budget and reports it — the barrier still forms", async () => {
      vi.useFakeTimers();
      const stuck = makeListener("stuck", { begin: vi.fn(() => new Promise(() => {})) });
      const fine = makeListener("fine");
      onStateDbQuiet(stuck);
      onStateDbQuiet(fine);
      const onEvent = vi.fn();

      const pending = track(beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent }));
      await vi.advanceTimersByTimeAsync(kListenerBeginBudgetMs - 1);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending.settled).toBe(true);
      expect(pending.error).toBeNull();
      expect(isStateDbQuiet()).toBe(true);
      expect(eventsOf(onEvent, "listener_timeout")).toEqual([
        expect.objectContaining({ budgetMs: kListenerBeginBudgetMs, listeners: ["stuck"] }),
      ]);
    });

    it("a throwing listener is reported, does not block, and still receives end() on release", async () => {
      const bad = makeListener("bad", {
        begin: vi.fn(() => {
          throw new Error("boom");
        }),
      });
      const rejecting = makeListener("rejecting", {
        begin: vi.fn(async () => {
          throw new Error("async boom");
        }),
      });
      const good = makeListener("good");
      onStateDbQuiet(bad);
      onStateDbQuiet(rejecting);
      onStateDbQuiet(good);
      const onEvent = vi.fn();

      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });
      expect(isStateDbQuiet()).toBe(true);
      expect(good.begin).toHaveBeenCalledTimes(1);
      expect(eventsOf(onEvent, "listener_error").map((event) => [event.listener, event.error])).toEqual([
        ["bad", "boom"],
        ["rejecting", "async boom"],
      ]);

      releaseStateDbQuiet(token);
      expect(bad.end).toHaveBeenCalledTimes(1);
      expect(rejecting.end).toHaveBeenCalledTimes(1);
      expect(good.end).toHaveBeenCalledTimes(1);
    });

    it("rolls back partially-begun listeners, clears the flag, and rethrows when the owner aborts a begin midway", async () => {
      vi.useFakeTimers();
      const first = makeListener("first");
      const stuck = makeListener("stuck", { begin: vi.fn(() => new Promise(() => {})) });
      const never = makeListener("never-reached");
      onStateDbQuiet(first);
      const unsubscribeStuck = onStateDbQuiet(stuck);
      const controller = new AbortController();
      const onEvent = vi.fn();

      const pending = track(
        beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent, signal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(pending.settled).toBe(false);
      expect(isStateDbQuiet()).toBe(true);
      onStateDbQuiet(never);

      controller.abort(new Error("quiesce deadline passed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(pending.settled).toBe(true);
      expect(pending.error).toEqual(expect.objectContaining({ message: "quiesce deadline passed" }));
      expect(isStateDbQuiet()).toBe(false);
      expect(getStateDbQuietState()).toEqual(expect.objectContaining({ quiet: false, expired: false }));
      // Every listener whose begin() was invoked is ended — in reverse — even the stuck one.
      expect(first.end).toHaveBeenCalledTimes(1);
      expect(stuck.end).toHaveBeenCalledTimes(1);
      expect(stuck.end.mock.invocationCallOrder[0]).toBeLessThan(first.end.mock.invocationCallOrder[0]);
      expect(never.begin).not.toHaveBeenCalled();
      expect(never.end).not.toHaveBeenCalled();
      expect(eventsOf(onEvent, "begin_failed")).toEqual([
        expect.objectContaining({ error: "quiesce deadline passed" }),
      ]);
      // No stray "quiet"/"expired" ever fires for the aborted attempt.
      await vi.advanceTimersByTimeAsync(kMaxMs + kListenerBeginBudgetMs);
      expect(eventsOf(onEvent, "quiet")).toEqual([]);
      expect(eventsOf(onEvent, "expired")).toEqual([]);

      // The barrier is reusable after a failed begin (the stuck listener is
      // gone; otherwise the next begin would wait out its budget again).
      unsubscribeStuck();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });
      expect(isStateDbQuiet()).toBe(true);
      releaseStateDbQuiet(token);
    });

    it("an already-aborted signal rejects before any state changes", async () => {
      const listener = makeListener("l");
      onStateDbQuiet(listener);
      const controller = new AbortController();
      controller.abort();
      await expect(
        beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
      expect(isStateDbQuiet()).toBe(false);
      expect(listener.begin).not.toHaveBeenCalled();
    });

    it("an abort after begin completed is ignored — the barrier stays held until release", async () => {
      const controller = new AbortController();
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({
        owner: kOwner,
        maxMs: kMaxMs,
        onEvent,
        signal: controller.signal,
      });
      controller.abort();
      expect(isStateDbQuiet()).toBe(true);
      expect(eventsOf(onEvent, "begin_failed")).toEqual([]);
      releaseStateDbQuiet(token);
    });

    it("is exclusive: a second begin while quiet (or still beginning) throws StateDbQuietError", async () => {
      vi.useFakeTimers();
      onStateDbQuiet(
        makeListener("slow", {
          begin: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 100))),
        }),
      );
      const first = beginStateDbQuiet({ owner: "first", maxMs: kMaxMs });
      await expect(beginStateDbQuiet({ owner: "second", maxMs: kMaxMs })).rejects.toMatchObject({
        name: "StateDbQuietError",
        code: kBackupInProgressCode,
        message: expect.stringMatching(/already quiet.*first/),
      });
      await vi.advanceTimersByTimeAsync(100);
      const { token } = await first;

      const error = await beginStateDbQuiet({ owner: "third", maxMs: kMaxMs }).catch((e) => e);
      expect(error).toBeInstanceOf(StateDbQuietError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(kBackupInProgressCode);
      expect(isStateDbQuiet()).toBe(true);
      releaseStateDbQuiet(token);
      expect(isStateDbQuiet()).toBe(false);
    });

    it("validates owner and maxMs before touching any state", async () => {
      await expect(beginStateDbQuiet({ maxMs: kMaxMs })).rejects.toThrow(TypeError);
      await expect(beginStateDbQuiet({ owner: kOwner, maxMs: 0 })).rejects.toThrow(TypeError);
      await expect(beginStateDbQuiet({ owner: kOwner, maxMs: Number.NaN })).rejects.toThrow(
        TypeError,
      );
      expect(isStateDbQuiet()).toBe(false);
    });

    it("never lets a throwing onEvent break the barrier", async () => {
      const onEvent = vi.fn(() => {
        throw new Error("logger down");
      });
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });
      expect(isStateDbQuiet()).toBe(true);
      expect(releaseStateDbQuiet(token)).toBe(true);
      expect(isStateDbQuiet()).toBe(false);
    });
  });

  describe("release", () => {
    it("releases only for the matching token and ignores foreign tokens", async () => {
      const listener = makeListener("l");
      onStateDbQuiet(listener);
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });

      expect(releaseStateDbQuiet({ id: token.id, owner: kOwner })).toBe(false);
      expect(releaseStateDbQuiet(null)).toBe(false);
      expect(isStateDbQuiet()).toBe(true);
      expect(listener.end).not.toHaveBeenCalled();

      expect(releaseStateDbQuiet(token)).toBe(true);
      expect(isStateDbQuiet()).toBe(false);
      expect(listener.end).toHaveBeenCalledTimes(1);
    });

    it("is idempotent via token.release() and runs listeners' end() once, in reverse order", async () => {
      const order = [];
      onStateDbQuiet(makeListener("a", { end: vi.fn(() => order.push("a")) }));
      onStateDbQuiet(makeListener("b", { end: vi.fn(() => order.push("b")) }));
      onStateDbQuiet(makeListener("c", { end: vi.fn(() => order.push("c")) }));
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });

      expect(token.release()).toBe(true);
      expect(token.release()).toBe(false);
      expect(releaseStateDbQuiet(token)).toBe(false);
      expect(order).toEqual(["c", "b", "a"]);
      expect(eventsOf(onEvent, "released")).toEqual([
        expect.objectContaining({ owner: kOwner, heldMs: expect.any(Number), token: token.id }),
      ]);
      expect(getStateDbQuietState()).toEqual(
        expect.objectContaining({ quiet: false, owner: kOwner, expired: false }),
      );
    });

    it("a stale token from an earlier period cannot release a later one", async () => {
      const first = await beginStateDbQuiet({ owner: "one", maxMs: kMaxMs });
      first.release();
      const second = await beginStateDbQuiet({ owner: "two", maxMs: kMaxMs });
      expect(releaseStateDbQuiet(first.token)).toBe(false);
      expect(isStateDbQuiet()).toBe(true);
      expect(getStateDbQuietState().owner).toBe("two");
      second.release();
    });

    it("clears the expiry timer so a released period never fires 'expired' later", async () => {
      vi.useFakeTimers();
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: 1000, onEvent });
      releaseStateDbQuiet(token);
      await vi.advanceTimersByTimeAsync(5000);
      expect(eventsOf(onEvent, "expired")).toEqual([]);
      expect(getStateDbQuietState().expired).toBe(false);
    });

    it("reports (and survives) a listener whose end() throws", async () => {
      onStateDbQuiet(
        makeListener("fragile", {
          end: vi.fn(() => {
            throw new Error("end boom");
          }),
        }),
      );
      const survivor = makeListener("survivor");
      onStateDbQuiet(survivor);
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });
      expect(releaseStateDbQuiet(token)).toBe(true);
      expect(survivor.end).toHaveBeenCalledTimes(1);
      expect(eventsOf(onEvent, "listener_error")).toEqual([
        expect.objectContaining({ listener: "fragile", phase: "end", error: "end boom" }),
      ]);
    });
  });

  describe("expiry", () => {
    it("marks the period expired, emits the event, ends listeners, and reads as not quiet — never silently reopens", async () => {
      vi.useFakeTimers();
      const listener = makeListener("l");
      onStateDbQuiet(listener);
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: 1000, onEvent });

      await vi.advanceTimersByTimeAsync(999);
      expect(isStateDbQuiet()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      expect(isStateDbQuiet()).toBe(false);
      expect(getStateDbQuietState()).toEqual(
        expect.objectContaining({ quiet: false, expired: true, owner: kOwner }),
      );
      expect(eventsOf(onEvent, "expired")).toEqual([
        expect.objectContaining({
          kind: kStateDbQuietEventKind,
          owner: kOwner,
          heldMs: 1000,
          token: token.id,
        }),
      ]);
      expect(listener.end).toHaveBeenCalledTimes(1);

      // The owner's late release is a no-op; the barrier is free for the next begin.
      expect(releaseStateDbQuiet(token)).toBe(false);
      expect(listener.end).toHaveBeenCalledTimes(1);
      const next = await beginStateDbQuiet({ owner: "next", maxMs: kMaxMs });
      expect(getStateDbQuietState()).toEqual(
        expect.objectContaining({ quiet: true, expired: false, owner: "next" }),
      );
      next.release();
    });
  });

  describe("kill switch", () => {
    it(`${kStateDbQuietEnvKey}=off resolves a no-op token, never sets the flag, and skips listeners`, async () => {
      process.env[kStateDbQuietEnvKey] = "off";
      const listener = makeListener("l");
      onStateDbQuiet(listener);
      const onEvent = vi.fn();

      const { token, release } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });

      expect(isStateDbQuiet()).toBe(false);
      expect(token.disabled).toBe(true);
      expect(listener.begin).not.toHaveBeenCalled();
      expect(eventsOf(onEvent, "disabled")).toEqual([
        expect.objectContaining({ owner: kOwner, envKey: kStateDbQuietEnvKey }),
      ]);
      expect(() => release()).not.toThrow();
      expect(releaseStateDbQuiet(token)).toBe(false);
      expect(listener.end).not.toHaveBeenCalled();
      // Two "disabled" begins in a row do not collide (no exclusivity without a barrier).
      await expect(beginStateDbQuiet({ owner: "again", maxMs: kMaxMs })).resolves.toBeTruthy();
    });

    it("only the literal 'off' disables the barrier", async () => {
      process.env[kStateDbQuietEnvKey] = "0";
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });
      expect(isStateDbQuiet()).toBe(true);
      expect(token.disabled).toBe(false);
      releaseStateDbQuiet(token);
    });

    it("is a deployment-only env key (alongside the prelaunch hook path)", () => {
      expect(kDeploymentOnlyEnvKeys).toContain(kStateDbQuietEnvKey);
      expect(kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_GATEWAY_PRELAUNCH_HOOK");
    });
  });

  describe("handle counter", () => {
    it("begin waits for in-flight handles to drain", async () => {
      vi.useFakeTimers();
      enterStateDbHandle();
      enterStateDbHandle();
      expect(getStateDbHandleCount()).toBe(2);
      const onEvent = vi.fn();

      const pending = track(beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent }));
      await vi.advanceTimersByTimeAsync(200);
      expect(pending.settled).toBe(false);
      expect(isStateDbQuiet()).toBe(true);
      exitStateDbHandle();
      await vi.advanceTimersByTimeAsync(200);
      expect(pending.settled).toBe(false);
      exitStateDbHandle();
      await vi.advanceTimersByTimeAsync(50);
      expect(pending.settled).toBe(true);
      expect(pending.error).toBeNull();
      expect(eventsOf(onEvent, "handles_open")).toEqual([]);
    });

    it("gives up waiting after the drain budget, reports the leak, and still forms the barrier", async () => {
      vi.useFakeTimers();
      enterStateDbHandle();
      const onEvent = vi.fn();
      const pending = track(beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent }));
      await vi.advanceTimersByTimeAsync(kHandleDrainBudgetMs + 50);
      expect(pending.settled).toBe(true);
      expect(pending.error).toBeNull();
      expect(isStateDbQuiet()).toBe(true);
      expect(eventsOf(onEvent, "handles_open")).toEqual([
        expect.objectContaining({ openHandles: 1, budgetMs: kHandleDrainBudgetMs }),
      ]);
      expect(getStateDbQuietState().openHandles).toBe(1);
    });

    it("withStateDbHandle brackets the call (including throws) and exit never underflows", () => {
      expect(withStateDbHandle(() => getStateDbHandleCount())).toBe(1);
      expect(getStateDbHandleCount()).toBe(0);
      expect(() =>
        withStateDbHandle(() => {
          throw new Error("inside");
        }),
      ).toThrow("inside");
      expect(getStateDbHandleCount()).toBe(0);
      expect(exitStateDbHandle()).toBe(0);
      expect(getStateDbHandleCount()).toBe(0);
    });
  });

  describe("listener registry", () => {
    it("requires a name and function hooks, and unsubscribe stops further callbacks", async () => {
      expect(() => onStateDbQuiet(null)).toThrow(TypeError);
      expect(() => onStateDbQuiet({ begin: () => {} })).toThrow(/name/);
      expect(() => onStateDbQuiet({ name: "x", begin: "nope" })).toThrow(/begin/);
      expect(() => onStateDbQuiet({ name: "x", end: 42 })).toThrow(/end/);

      const listener = makeListener("gone");
      const unsubscribe = onStateDbQuiet(listener);
      unsubscribe();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });
      releaseStateDbQuiet(token);
      expect(listener.begin).not.toHaveBeenCalled();
      expect(listener.end).not.toHaveBeenCalled();
    });

    it("accepts end-only and begin-only listeners", async () => {
      const endOnly = { name: "end-only", end: vi.fn() };
      const beginOnly = { name: "begin-only", begin: vi.fn() };
      onStateDbQuiet(endOnly);
      onStateDbQuiet(beginOnly);
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });
      releaseStateDbQuiet(token);
      expect(beginOnly.begin).toHaveBeenCalledTimes(1);
      expect(endOnly.end).toHaveBeenCalledTimes(1);
    });
  });

  describe("StateDbQuietError", () => {
    it("carries the fixed name/code and the operator-facing default message", () => {
      const error = new StateDbQuietError();
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("StateDbQuietError");
      expect(error.code).toBe(kBackupInProgressCode);
      expect(error.code).toBe("backup_in_progress");
      expect(error.message).toBe(kBackupInProgressMessage);
      expect(new StateDbQuietError("custom").message).toBe("custom");
    });
  });

  // Writers that already mutated something the barrier does not gate before
  // their state-db half was refused (a deleted channel account's pairing
  // rows, a redeemed one-use OAuth code) finish the write here — registered
  // listeners' end() cannot serve them: endListeners() only reaches the
  // entries recorded when begin() ran.
  describe("whenStateDbQuietReleased", () => {
    it("runs armed waiters exactly once on release, AFTER the listeners' end() (the stores are open again)", async () => {
      const order = [];
      onStateDbQuiet(makeListener("store", { end: vi.fn(() => order.push("end")) }));
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs });
      const waiter = vi.fn(() => order.push("waiter"));
      whenStateDbQuietReleased(waiter);
      expect(waiter).not.toHaveBeenCalled();

      token.release();
      expect(waiter).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["end", "waiter"]);
      token.release();
      expect(waiter).toHaveBeenCalledTimes(1);
    });

    it("runs on expiry as well — the writer is never stranded behind a barrier that timed out", async () => {
      vi.useFakeTimers();
      await beginStateDbQuiet({ owner: kOwner, maxMs: 1000 });
      const waiter = vi.fn();
      whenStateDbQuietReleased(waiter);
      await vi.advanceTimersByTimeAsync(999);
      expect(waiter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(waiter).toHaveBeenCalledTimes(1);
      expect(isStateDbQuiet()).toBe(false);
    });

    it("runs when a begin rolls back (owner abort) — armed while the barrier was still forming", async () => {
      onStateDbQuiet(makeListener("slow", { begin: () => new Promise(() => {}) }));
      const controller = new AbortController();
      const pending = beginStateDbQuiet({
        owner: kOwner,
        maxMs: kMaxMs,
        signal: controller.signal,
      });
      const waiter = vi.fn();
      whenStateDbQuietReleased(waiter);
      expect(waiter).not.toHaveBeenCalled();

      controller.abort(new Error("owner deadline"));
      await expect(pending).rejects.toThrow("owner deadline");
      expect(waiter).toHaveBeenCalledTimes(1);
      expect(isStateDbQuiet()).toBe(false);
    });

    it("runs on the next macrotask when no barrier is held, and a disarm cancels it", async () => {
      const waiter = vi.fn();
      whenStateDbQuietReleased(waiter);
      expect(waiter).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      expect(waiter).toHaveBeenCalledTimes(1);

      const cancelled = vi.fn();
      whenStateDbQuietReleased(cancelled)();
      await new Promise((resolve) => setImmediate(resolve));
      expect(cancelled).not.toHaveBeenCalled();
    });

    it("a disarmed waiter never runs on release; a throwing waiter is reported and never starves the others", async () => {
      const onEvent = vi.fn();
      const { token } = await beginStateDbQuiet({ owner: kOwner, maxMs: kMaxMs, onEvent });
      const disarmed = vi.fn();
      whenStateDbQuietReleased(disarmed)();
      whenStateDbQuietReleased(() => {
        throw new Error("boom");
      });
      const survivor = vi.fn();
      whenStateDbQuietReleased(survivor);

      token.release();
      expect(disarmed).not.toHaveBeenCalled();
      expect(survivor).toHaveBeenCalledTimes(1);
      expect(eventsOf(onEvent, "release_waiter_error")).toEqual([
        expect.objectContaining({ kind: kStateDbQuietEventKind, error: "boom" }),
      ]);
      expect(eventsOf(onEvent, "released")).toHaveLength(1);
    });

    it("requires a function", () => {
      expect(() => whenStateDbQuietReleased(null)).toThrow(TypeError);
      expect(() => whenStateDbQuietReleased("later")).toThrow(TypeError);
    });
  });

  describe("sendIfStateDbQuietError", () => {
    const makeRes = () => {
      const res = {
        headers: {},
        statusCode: null,
        body: undefined,
        set: vi.fn((key, value) => {
          res.headers[key] = value;
          return res;
        }),
        status: vi.fn((code) => {
          res.statusCode = code;
          return res;
        }),
        json: vi.fn((body) => {
          res.body = body;
          return res;
        }),
      };
      return res;
    };

    it("maps a StateDbQuietError to 409 backup_in_progress with Retry-After", () => {
      const res = makeRes();
      expect(sendIfStateDbQuietError(res, new StateDbQuietError())).toBe(true);
      expect(res.statusCode).toBe(409);
      expect(res.headers["Retry-After"]).toBe(String(kStateDbQuietRetryAfterSec));
      expect(res.headers["Retry-After"]).toBe("120");
      expect(res.body).toEqual({
        ok: false,
        code: "backup_in_progress",
        error: "A backup is in progress; retry in about two minutes.",
      });
    });

    it("leaves every other error to the caller", () => {
      const res = makeRes();
      expect(sendIfStateDbQuietError(res, new Error("other"))).toBe(false);
      expect(sendIfStateDbQuietError(res, null)).toBe(false);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});
