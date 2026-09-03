const modulePath = require.resolve("../../lib/server/gateway-restart-handoff");

// The module keeps a per-PID consume cache at module scope (the consume is
// destructive upstream, so all callers must share one result) — reload it per
// test so cached verdicts never leak between cases.
const loadModule = () => {
  delete require.cache[modulePath];
  return require(modulePath);
};

const kConsumeCommand = (pid) =>
  `gateway restart-handoff consume --expected-pid ${pid} --json`;

const acceptedPayload = (pid) => ({
  ok: true,
  protocol: "openclaw.gateway.restart-handoff",
  protocolVersion: 1,
  status: "accepted",
  handoff: {
    intentId: "intent-1",
    pid,
    source: "config-apply",
    reason: "config changed",
    restartKind: "gateway",
    supervisorMode: "external",
  },
});

describe("server/gateway-restart-handoff", () => {
  afterEach(() => {
    delete require.cache[modulePath];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("consumes via the hidden CLI and parses an accepted handoff", async () => {
    const { consumeRestartHandoff } = loadModule();
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify(acceptedPayload(4242)),
      stderr: "",
    }));

    const result = await consumeRestartHandoff({ clawCmd, pid: 4242 });

    expect(clawCmd).toHaveBeenCalledWith(kConsumeCommand(4242), {
      quiet: true,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      status: "accepted",
      reason: null,
      handoff: expect.objectContaining({
        pid: 4242,
        source: "config-apply",
        reason: "config changed",
        restartKind: "gateway",
      }),
    });
  });

  it("parses none/rejected verdicts and tolerates CLI noise around the JSON", async () => {
    const { consumeRestartHandoff } = loadModule();
    const clawCmd = vi.fn(async (command) => {
      const pid = Number(command.match(/--expected-pid (\d+)/)[1]);
      if (pid === 1) {
        return {
          ok: true,
          stdout: [
            "(node) some deprecation warning",
            JSON.stringify({
              ok: true,
              protocol: "openclaw.gateway.restart-handoff",
              protocolVersion: 1,
              status: "none",
              reason: "missing",
            }),
            "trailing plugin chatter",
          ].join("\n"),
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          protocol: "openclaw.gateway.restart-handoff",
          protocolVersion: 1,
          status: "rejected",
          reason: "pid-mismatch",
          handoffPid: 99,
        }),
      };
    });

    expect(await consumeRestartHandoff({ clawCmd, pid: 1 })).toEqual({
      status: "none",
      reason: "missing",
      handoff: null,
    });
    expect(await consumeRestartHandoff({ clawCmd, pid: 2 })).toEqual({
      status: "rejected",
      reason: "pid-mismatch",
      handoff: null,
    });
  });

  it("maps non-ok exits, unparseable stdout, and thrown errors to status error", async () => {
    const { consumeRestartHandoff } = loadModule();

    // Exit 1 (store-unavailable) / timeout: clawCmd resolves ok:false.
    const storeDown = vi.fn(async () => ({ ok: false, stdout: "", stderr: "boom", code: 1 }));
    expect(await consumeRestartHandoff({ clawCmd: storeDown, pid: 10 })).toEqual(
      { status: "error", reason: null, handoff: null },
    );

    // Garbage stdout without the protocol marker.
    const garbage = vi.fn(async () => ({ ok: true, stdout: "not json { at all" }));
    expect(await consumeRestartHandoff({ clawCmd: garbage, pid: 11 })).toEqual(
      { status: "error", reason: null, handoff: null },
    );

    // clawCmd itself throwing must never propagate.
    const throwing = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    expect(await consumeRestartHandoff({ clawCmd: throwing, pid: 12 })).toEqual(
      { status: "error", reason: null, handoff: null },
    );
  });

  it("returns error without spawning the CLI for invalid PIDs", async () => {
    const { consumeRestartHandoff } = loadModule();
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "" }));

    for (const pid of [0, -1, 1.5, "abc", null, undefined]) {
      expect(await consumeRestartHandoff({ clawCmd, pid })).toEqual({
        status: "error",
        reason: null,
        handoff: null,
      });
    }
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("consumes each PID exactly once and shares the one result across callers", async () => {
    const { consumeRestartHandoff, peekRestartHandoff } = loadModule();
    let resolveCmd;
    const clawCmd = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCmd = resolve;
        }),
    );

    // Two callers race before the CLI settles: one invocation, shared result.
    const first = consumeRestartHandoff({ clawCmd, pid: 4242 });
    const second = consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(clawCmd).toHaveBeenCalledTimes(1);

    resolveCmd({ ok: true, stdout: JSON.stringify(acceptedPayload(4242)) });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe("accepted");

    // A later caller (e.g. a managed restart path) still reads the cache —
    // the destructive consume must never run twice for one PID.
    const third = await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(third).toEqual(firstResult);
    expect(clawCmd).toHaveBeenCalledTimes(1);

    // peek is a non-consuming read: settled result for known PIDs, null (and
    // no CLI spawn) otherwise.
    expect(peekRestartHandoff(4242)).toEqual(firstResult);
    expect(peekRestartHandoff(7777)).toBeNull();
    expect(clawCmd).toHaveBeenCalledTimes(1);
  });

  it("expires cached verdicts with the 60s row TTL so recycled PIDs re-consume", async () => {
    vi.useFakeTimers();
    const { consumeRestartHandoff } = loadModule();
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        protocol: "openclaw.gateway.restart-handoff",
        protocolVersion: 1,
        status: "none",
        reason: "missing",
      }),
    }));

    await consumeRestartHandoff({ clawCmd, pid: 4242 });
    await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(clawCmd).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await consumeRestartHandoff({ clawCmd, pid: 4242 });
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("caps the cache and evicts the oldest PID first", async () => {
    const { consumeRestartHandoff } = loadModule();
    const clawCmd = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        protocol: "openclaw.gateway.restart-handoff",
        protocolVersion: 1,
        status: "none",
        reason: "missing",
      }),
    }));

    for (let pid = 1; pid <= 9; pid += 1) {
      await consumeRestartHandoff({ clawCmd, pid });
    }
    expect(clawCmd).toHaveBeenCalledTimes(9);

    // pid 1 was evicted (cap 8): consuming it again spawns the CLI; pid 9 is
    // still cached.
    await consumeRestartHandoff({ clawCmd, pid: 1 });
    expect(clawCmd).toHaveBeenCalledTimes(10);
    await consumeRestartHandoff({ clawCmd, pid: 9 });
    expect(clawCmd).toHaveBeenCalledTimes(10);
  });
});
