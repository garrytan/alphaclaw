const fs = require("fs");
const os = require("os");
const path = require("path");

const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const makeOutbox = (overrides = {}) => {
  const openclawDir = mkTemp("notify-outbox-test-");
  const nowRef = { now: 1_000_000 };
  const outbox = createNotifyOutbox({
    openclawDir,
    nowFn: () => nowRef.now,
    logger: kSilentLogger,
    ...overrides,
  });
  return { outbox, openclawDir, nowRef };
};

describe("server/notify-outbox", () => {
  it("deduplicates by event id — re-enqueueing never doubles a message", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "hello", eventType: "info" });
    outbox.enqueue({ id: "e1", message: "hello", eventType: "info" });
    const deliver = vi.fn(async () => ({ ok: true }));
    const result = await outbox.flush({ deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
  });

  it("acks ONLY on {ok:true}: an {ok:false} delivery is retried next flush", async () => {
    const { outbox, nowRef } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "important failure notice" });
    const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
    await outbox.flush({ deliver: failing });
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();
    expect(outbox.listEvents()[0].lastError).toBe("api down");

    // Past the backoff deferral the event is retried.
    nowRef.now += 60_000;
    const succeeding = vi.fn(async () => ({ ok: true }));
    const second = await outbox.flush({ deliver: succeeding });
    expect(second.delivered).toBe(1);
    expect(outbox.listEvents()[0].deliveredAt).toBeTruthy();

    // Already-delivered events never redeliver.
    const third = await outbox.flush({ deliver: succeeding });
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(third.delivered).toBe(0);
  });

  it("stops retrying after the attempt cap", async () => {
    const { outbox, nowRef } = makeOutbox({ maxAttempts: 2 });
    outbox.enqueue({ id: "e1", message: "msg" });
    const failing = vi.fn(async () => ({ ok: false }));
    await outbox.flush({ deliver: failing });
    nowRef.now += 60_000;
    await outbox.flush({ deliver: failing });
    nowRef.now += 120_000;
    await outbox.flush({ deliver: failing });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("a thrown deliver counts as a failed attempt, never rejects the flush", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "msg" });
    await expect(
      outbox.flush({
        deliver: async () => {
          throw new Error("socket reset");
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ failed: 1 }));
    expect(outbox.listEvents()[0].lastError).toBe("socket reset");
  });

  it("evicts delivered events before undelivered ones on overflow", async () => {
    const { outbox } = makeOutbox({ keepCount: 3 });
    outbox.enqueue({ id: "e1", message: "first" });
    outbox.enqueue({ id: "e2", message: "second" });
    await outbox.flush({ deliver: async () => ({ ok: true }) });
    // e1/e2 delivered; e3 undelivered fills the cap.
    outbox.enqueue({ id: "e3", message: "third" });
    // e4 overflows: the oldest DELIVERED event ages out, never the
    // undelivered one.
    outbox.enqueue({ id: "e4", message: "fourth" });

    const events = outbox.listEvents();
    expect(events.map((entry) => entry.id)).toEqual(["e2", "e3", "e4"]);
    expect(events.find((entry) => entry.id === "e3").deliveredAt).toBeNull();
    expect(events.find((entry) => entry.id === "e4").deliveredAt).toBeNull();
  });

  it("keeps the newest undelivered events when undelivered alone exceed keepCount", async () => {
    const { outbox } = makeOutbox({ keepCount: 3 });
    outbox.enqueue({ id: "e1", message: "first" });
    outbox.enqueue({ id: "e2", message: "second" });
    outbox.enqueue({ id: "e3", message: "third" });
    outbox.enqueue({ id: "e4", message: "fourth" });
    expect(outbox.listEvents().map((entry) => entry.id)).toEqual([
      "e2",
      "e3",
      "e4",
    ]);

    outbox.enqueue({ id: "e5", message: "fifth" });
    // Order preserved, newest kept.
    expect(outbox.listEvents().map((entry) => entry.id)).toEqual([
      "e3",
      "e4",
      "e5",
    ]);
  });

  it("does not lose an event enqueued concurrently during a flush", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "first" });
    let enqueuedDuringFlush = false;
    const deliver = vi.fn(async () => {
      if (!enqueuedDuringFlush) {
        enqueuedDuringFlush = true;
        // A live enqueue racing the in-flight flush writes a newer file; the
        // flush's write-back must merge onto a fresh read, not clobber it.
        outbox.enqueue({ id: "e-new", message: "queued mid-flush" });
      }
      return { ok: true };
    });
    await outbox.flush({ deliver });
    const ids = outbox.listEvents().map((entry) => entry.id);
    expect(ids).toContain("e-new");
    expect(
      outbox.listEvents().find((entry) => entry.id === "e-new").deliveredAt,
    ).toBeNull();
    // The original event's delivery ack still persisted through the merge.
    expect(
      outbox.listEvents().find((entry) => entry.id === "e1").deliveredAt,
    ).toBeTruthy();
  });

  it("logs via logger.error when an event crosses maxAttempts (giving up)", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { outbox, nowRef } = makeOutbox({ maxAttempts: 2, logger });
    outbox.enqueue({ id: "e1", message: "critical upgrade failure" });
    const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
    await outbox.flush({ deliver: failing });
    expect(logger.error).not.toHaveBeenCalled();
    nowRef.now += 60_000;
    await outbox.flush({ deliver: failing });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0][0];
    expect(message).toContain("GIVING UP");
    expect(message).toContain('"e1"');
    expect(message).toContain("critical upgrade failure");
  });

  it("persists across instances (restart survival)", async () => {
    const { outbox, openclawDir, nowRef } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "queued just before restart" });
    const reborn = createNotifyOutbox({
      openclawDir,
      // Same logical clock as the pre-restart instance: with a real Date.now
      // the fixture's 1970-era createdAt would look 48h-stale and abandon.
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
    });
    const deliver = vi.fn(async () => ({ ok: true }));
    const result = await reborn.flush({ deliver });
    expect(result.delivered).toBe(1);
    expect(deliver.mock.calls[0][0].message).toBe(
      "queued just before restart",
    );
  });

  // Backoff + replay-until-age-out (#21 Bug 7): a broken box may take hours
  // to heal — the outbox must keep trying the whole time, then fail loudly.
  describe("backoff and 48h abandonment", () => {
    it("defers a failed delivery by exponential backoff (base, doubling per attempt)", async () => {
      const { outbox, nowRef } = makeOutbox();
      outbox.enqueue({ id: "e1", message: "msg" });
      const failing = vi.fn(async () => ({ ok: false, reason: "down" }));
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(1_000_000 + 60_000);

      // A flush before the deferral elapses does not attempt delivery.
      const succeeding = vi.fn(async () => ({ ok: true }));
      await outbox.flush({ deliver: succeeding });
      expect(succeeding).not.toHaveBeenCalled();

      // At the deferral boundary it retries; the second failure doubles.
      nowRef.now += 60_000;
      await outbox.flush({ deliver: failing });
      expect(failing).toHaveBeenCalledTimes(2);
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 120_000);
    });

    it("caps the backoff delay at backoffMaxMs", async () => {
      const { outbox, nowRef } = makeOutbox({
        backoffBaseMs: 100,
        backoffMaxMs: 300,
      });
      outbox.enqueue({ id: "e1", message: "msg" });
      const failing = vi.fn(async () => ({ ok: false }));
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 100);
      nowRef.now += 100;
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 200);
      nowRef.now += 200;
      await outbox.flush({ deliver: failing });
      // 100 * 2^2 = 400 → capped at 300.
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 300);
      nowRef.now += 300;
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 300);
    });

    it("keeps retrying past the legacy 5-attempt cap until delivery succeeds", async () => {
      const { outbox, nowRef } = makeOutbox({
        backoffBaseMs: 1,
        backoffMaxMs: 1,
      });
      outbox.enqueue({ id: "e1", message: "eventually delivered" });
      const failing = vi.fn(async () => ({ ok: false, reason: "still down" }));
      for (let i = 0; i < 10; i += 1) {
        await outbox.flush({ deliver: failing });
        nowRef.now += 2;
      }
      expect(failing).toHaveBeenCalledTimes(10);

      const succeeding = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver: succeeding });
      expect(result.delivered).toBe(1);
      expect(outbox.listEvents()[0].attempts).toBe(11);
      expect(outbox.listEvents()[0].deliveredAt).toBeTruthy();
    });

    it("abandons past 48h exactly once: one GIVING-UP log + one persisted watchdog event, never retried", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ logger, insertEvent });
      outbox.enqueue({
        id: "e1",
        message: "critical never-delivered failure",
        eventType: "upgrade_failed",
        operationId: "op-9",
      });
      const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
      await outbox.flush({ deliver: failing });
      expect(logger.error).not.toHaveBeenCalled();

      nowRef.now += 48 * 60 * 60 * 1000;
      const deliver = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.abandoned).toBe(1);
      const entry = outbox.listEvents()[0];
      expect(entry.abandonedAt).toBe(nowRef.now);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toContain("GIVING UP");
      expect(logger.error.mock.calls[0][0]).toContain('"e1"');
      expect(logger.error.mock.calls[0][0]).toContain(
        "critical never-delivered failure",
      );
      expect(insertEvent).toHaveBeenCalledTimes(1);
      expect(insertEvent.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          eventType: "notification_abandoned",
          source: "notify-outbox",
          status: "failed",
          correlationId: "op-9",
        }),
      );
      expect(insertEvent.mock.calls[0][0].details).toEqual(
        expect.objectContaining({
          id: "e1",
          notifyEventType: "upgrade_failed",
          attempts: 1,
          lastError: "api down",
        }),
      );

      // A later flush neither retries nor re-logs nor re-emits (abandonedAt
      // is terminal).
      const again = await outbox.flush({ deliver });
      expect(deliver).not.toHaveBeenCalled();
      expect(again.abandoned).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    it("a throwing insertEvent sink never breaks the abandonment flush", async () => {
      const insertEvent = vi.fn(() => {
        throw new Error("watchdog db closed");
      });
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      nowRef.now += 48 * 60 * 60 * 1000;
      const result = await outbox.flush({ deliver: async () => ({ ok: true }) });
      expect(result.abandoned).toBe(1);
      expect(outbox.listEvents()[0].abandonedAt).toBe(nowRef.now);
    });

    it("an outbox file written before backoff/abandonment existed loads and delivers unchanged", async () => {
      // Old files have neither nextAttemptAt nor abandonedAt, and may carry
      // attempts at the legacy 5-attempt cap — they must load, be eligible
      // immediately, and retry under the new policy.
      const openclawDir = mkTemp("notify-outbox-legacy-");
      const outboxPath = path.join(
        openclawDir,
        ".alphaclaw",
        "notify-outbox.json",
      );
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.writeFileSync(
        outboxPath,
        `${JSON.stringify(
          {
            events: [
              {
                id: "old-1",
                eventType: "upgrade_failed",
                operationId: null,
                message: "queued by an older alphaclaw",
                createdAt: 999_000,
                attempts: 5,
                deliveredAt: null,
                lastError: "api down",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const outbox = createNotifyOutbox({
        openclawDir,
        nowFn: () => 1_000_000,
        logger: kSilentLogger,
      });
      const deliver = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver });
      expect(result.delivered).toBe(1);
      expect(deliver.mock.calls[0][0].id).toBe("old-1");
      expect(outbox.listEvents()[0].deliveredAt).toBe(1_000_000);
    });
  });
});

describe("server/upgrade-notifier routing", () => {
  const makeNotifier = ({ prefs, sendResults = {} } = {}) => {
    const { outbox } = makeOutbox();
    const sendToTarget = vi.fn(async (target) => {
      const key = `${target.channel}:${target.target}`;
      return sendResults[key] ?? { ok: true };
    });
    const fanout = vi.fn(async () => ({ ok: true, sent: 3 }));
    const operatorsStore = {
      read: () => ({
        notifications: prefs || { preferredChannel: null, adminTargets: [] },
      }),
    };
    const notifier = createUpgradeNotifier({
      notifier: { notify: fanout, sendToTarget },
      outbox,
      operatorsStore,
      logger: kSilentLogger,
    });
    return { notifier, sendToTarget, fanout, outbox };
  };

  it("no adminTargets configured → today's fan-out, unchanged default", async () => {
    const { notifier, fanout, sendToTarget } = makeNotifier();
    await notifier.notify("hello", { id: "e1" });
    await notifier.flush();
    expect(fanout).toHaveBeenCalledWith("hello", { eventType: "info" });
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it("preferred channel targets only — no fallback copy on success", async () => {
    const { notifier, sendToTarget, fanout } = makeNotifier({
      prefs: {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: "111" },
          { channel: "slack", target: "U222", accountId: null },
        ],
      },
    });
    await notifier.notify("update done", { id: "e1" });
    await notifier.flush();
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget.mock.calls[0][0]).toEqual(
      expect.objectContaining({ channel: "telegram", target: "111" }),
    );
    expect(fanout).not.toHaveBeenCalled();
  });

  it("falls back to remaining admin targets ONLY on delivery error, message prefixed", async () => {
    const { notifier, sendToTarget } = makeNotifier({
      prefs: {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: "111" },
          { channel: "slack", target: "U222", accountId: null },
        ],
      },
      sendResults: { "telegram:111": { ok: false, reason: "blocked" } },
    });
    await notifier.notify("upgrade failed", { id: "e1" });
    await notifier.flush();
    expect(sendToTarget).toHaveBeenCalledTimes(2);
    expect(sendToTarget.mock.calls[1][0].channel).toBe("slack");
    expect(sendToTarget.mock.calls[1][1]).toBe("(fallback) upgrade failed");
  });

  it("upgrade-lifecycle messages deep-link to the hash route (the SPA 404s on /upgrade)", async () => {
    const { outbox } = makeOutbox();
    const sendToTarget = vi.fn(async () => ({ ok: true }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: vi.fn(async () => ({ ok: true })), sendToTarget },
      outbox,
      operatorsStore: {
        read: () => ({
          notifications: {
            preferredChannel: null,
            adminTargets: [{ channel: "telegram", target: "111" }],
          },
        }),
      },
      getBaseUrl: () => "https://claw.example.com/",
      logger: kSilentLogger,
    });
    await notifier.notify("update finished", {
      id: "e1",
      operationId: "op-1",
    });
    await notifier.flush();
    expect(sendToTarget.mock.calls[0][1]).toBe(
      "update finished\n🔗 https://claw.example.com/#/upgrade",
    );
  });

  it("degrades to a single direct delivery when the outbox is unavailable", async () => {
    // enqueue() returning null (e.g. disk full) must not drop the message —
    // and must not pretend it was queued either.
    const outboxStub = {
      enqueue: vi.fn(() => null),
      flush: vi.fn(async () => ({ delivered: 0, failed: 0, pending: 0 })),
      listEvents: () => [],
    };
    const sendToTarget = vi.fn(async () => ({ ok: true }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: vi.fn(async () => ({ ok: true })), sendToTarget },
      outbox: outboxStub,
      operatorsStore: {
        read: () => ({
          notifications: {
            preferredChannel: null,
            adminTargets: [{ channel: "telegram", target: "111" }],
          },
        }),
      },
      logger: kSilentLogger,
    });

    const result = await notifier.notify("disk is full", { id: "e1" });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget.mock.calls[0][1]).toBe("disk is full");
    expect(result.ok).toBe(true);
    expect(result.queued).toBeUndefined();
    // The degrade path never schedules a flush of the broken outbox.
    expect(outboxStub.flush).not.toHaveBeenCalled();
  });

  it("all admin targets failing leaves the event unacked for retry", async () => {
    const { notifier, outbox } = makeNotifier({
      prefs: {
        preferredChannel: null,
        adminTargets: [{ channel: "telegram", target: "111" }],
      },
      sendResults: { "telegram:111": { ok: false, reason: "down" } },
    });
    await notifier.notify("msg", { id: "e1" });
    await notifier.flush();
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();
  });
});
