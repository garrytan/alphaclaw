const { createSessionWedgeSweep, classifySessions, kWedgeReasons } = require("../../lib/server/session-wedge-sweep");

const kLaunchAt = 1_800_000_000_000;
const row = (key, extra = {}) => ({ key, agentId: "main", sessionId: `id-${key}`, hasActiveRun: false, abortedLastRun: false, updatedAt: kLaunchAt - 60_000, ...extra });

// A fake `openclaw gateway call <method> --params <json> --json` behind clawCmd.
const createGateway = (handlers) => {
  const calls = [];
  const clawCmd = vi.fn(async (cmd) => {
    const match = /^gateway call '([^']+)' --params '(.*)' --json$/.exec(cmd);
    if (!match) throw new Error(`unexpected command: ${cmd}`);
    const [, method, params] = match;
    calls.push({ method, params: JSON.parse(params) });
    const answer = await handlers[method]?.(JSON.parse(params));
    if (!answer) return { ok: false, stdout: "", stderr: "no handler" };
    return { ok: answer.ok !== false, stdout: JSON.stringify(answer.body), stderr: "" };
  });
  return { clawCmd, calls };
};

const createSweep = (gateway, overrides = {}) => {
  const notify = vi.fn(async () => ({ ok: true }));
  const insertEvent = vi.fn();
  let clock = kLaunchAt;
  const sweep = createSessionWedgeSweep({
    clawCmd: gateway.clawCmd,
    notify,
    insertEvent,
    resolveReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    probeReadiness: vi.fn(async () => ({ ok: true, kind: "ready" })),
    sleep: vi.fn(async (ms) => { clock += ms; }),
    now: () => clock,
    ...overrides,
  });
  return { sweep, notify, insertEvent, advance: (ms) => { clock += ms; } };
};

describe("session wedge sweep (ALPH-17 PR 6)", () => {
  let log;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const lines = () => log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[alphaclaw] wedge-sweep "));

  it("classifies only through supported row fields, and never touches a session with live work", () => {
    const recorded = new Map([["a", {}], ["b", {}], ["c", {}], ["live", {}]]);
    const { recoverable, wedged } = classifySessions({
      rows: [
        row("a"),
        row("b", { abortedLastRun: true }),
        row("c", { restartRecoveryStatus: "tombstoned" }),
        row("live", { hasActiveRun: true, abortedLastRun: true }),
        row("old-aborted", { abortedLastRun: true, updatedAt: kLaunchAt - 60 * 60_000 }),
        row("recent-aborted", { abortedLastRun: true, updatedAt: kLaunchAt - 5 * 60_000 }),
        row("recent-idle", { updatedAt: kLaunchAt - 5 * 60_000 }),
      ],
      recorded,
      launchAtMs: kLaunchAt,
      nowMs: kLaunchAt + 120_000,
    });
    expect(recoverable.map(({ row: r }) => r.key)).toEqual(["a"]);
    expect(wedged.map(({ row: r, reason }) => [r.key, reason])).toEqual([
      ["b", kWedgeReasons.NOT_RESUMED],
      ["c", kWedgeReasons.RECOVERY_GAVE_UP],
      ["recent-aborted", kWedgeReasons.NOT_RESUMED],
    ]);
  });

  it("records the sessions running when a restart is requested, through sessions.list activeOnly", async () => {
    const gateway = createGateway({
      "sessions.list": async () => ({ body: { sessions: [row("a", { hasActiveRun: true }), row("idle")] } }),
    });
    const { sweep } = createSweep(gateway);
    expect(await sweep.recordRunningSessions({ opId: "abcdef1234" })).toBe(1);
    expect(gateway.calls).toEqual([{ method: "sessions.list", params: { activeOnly: true, limit: 200, rowMode: "compact" } }]);
    expect(lines()).toContain("[alphaclaw] wedge-sweep recorded op=abcdef12 running=1");
  });

  it("after a restart: waits for ready + 90 s, recovers a recorded session OpenClaw says qualifies, stays silent when there is nothing to recover, alerts once for a turn that was not resumed", async () => {
    let listCalls = 0;
    const gateway = createGateway({
      "sessions.list": async (params) => {
        listCalls += 1;
        if (params.activeOnly) return { body: { sessions: [row("a", { hasActiveRun: true }), row("done", { hasActiveRun: true }), row("dm", { hasActiveRun: true })] } };
        return { body: { sessions: [row("a"), row("done"), row("dm", { abortedLastRun: true, displayName: "Telegram DM" })] } };
      },
      "sessions.recover": async ({ key }) => key === "a"
        ? { body: { ok: true, key, continuation: { status: "started", runId: "r1" } } }
        : { ok: false, body: { ok: false, error: { code: "INVALID_REQUEST", message: "Session recovery requires a restart-tombstoned session." } } },
    });
    const { sweep, notify, insertEvent } = createSweep(gateway);
    await sweep.recordRunningSessions();
    const result = await sweep.onGatewayLaunch({ generation: 7, startedAt: kLaunchAt });
    expect(result).toEqual({ recovered: ["a"], alerted: ["dm"] });
    expect(gateway.calls.filter((c) => c.method === "sessions.recover").map((c) => c.params)).toEqual([
      { key: "a", agentId: "main" },
      { key: "done", agentId: "main" },
    ]);
    expect(insertEvent.mock.calls.map(([e]) => [e.eventType, e.status, e.details.sessionKey])).toEqual([
      ["session_wedge", "recovered", "a"],
      ["session_wedge", "alerted", "dm"],
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("A session may be stuck after the gateway restarted:");
    expect(message).toContain("• Telegram DM: its interrupted turn was not resumed");
    expect(message).not.toMatch(/reset/i);
    expect(opts.eventType).toBe("session_wedge");
    expect(lines()).toContain("[alphaclaw] wedge-sweep done generation=7 checked=3 recorded=3 recovered=1 alerted=1");

    // The same unchanged row is not alerted again on the next relaunch.
    notify.mockClear();
    const again = await sweep.onGatewayLaunch({ generation: 8, startedAt: kLaunchAt + 1000 });
    expect(again.alerted).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(listCalls).toBe(3);
  });

  it("a crash relaunch with nothing recorded still finds a recently interrupted session; a recover error other than 'nothing to recover' is recorded, never retried as a reset", async () => {
    const gateway = createGateway({
      "sessions.list": async () => ({ body: { sessions: [row("x", { abortedLastRun: true, updatedAt: kLaunchAt - 30_000 })] } }),
      "sessions.recover": async () => { throw new Error("must not be called"); },
    });
    const { sweep, notify } = createSweep(gateway);
    const result = await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt });
    expect(result.alerted).toEqual(["x"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list"]);

    const failing = createGateway({
      "sessions.list": async (params) => ({ body: { sessions: [row("y", { hasActiveRun: !!params.activeOnly })] } }),
      "sessions.recover": async () => ({ ok: false, body: { ok: false, error: { message: "Session recovery is unavailable while the source still has active work." } } }),
    });
    const second = createSweep(failing);
    await second.sweep.recordRunningSessions();
    expect(await second.sweep.onGatewayLaunch({ generation: 4, startedAt: kLaunchAt })).toEqual({ recovered: [], alerted: [] });
    expect(second.insertEvent.mock.calls.map(([e]) => e.status)).toEqual(["failed"]);
    expect(failing.calls.map((c) => c.method)).not.toContain("sessions.reset");
  });

  it("a cold restart's two launch notices for one generation (the listening line, then /readyz ready) share one sweep and keep the recorded sessions", async () => {
    const gateway = createGateway({
      "sessions.list": async (params) => ({ body: { sessions: [row("exec-turn", { hasActiveRun: !!params.activeOnly })] } }),
      "sessions.recover": async () => ({ ok: false, body: { ok: false, error: { code: "INVALID_REQUEST", message: "Session recovery requires a restart-tombstoned session." } } }),
    });
    const { sweep, notify } = createSweep(gateway);
    await sweep.recordRunningSessions({ opId: "restart1" });
    const listening = sweep.onGatewayLaunch({ generation: 5, startedAt: kLaunchAt });
    const ready = sweep.onGatewayLaunch({ generation: 5, startedAt: kLaunchAt + 4000 });
    expect(ready).toBe(listening);
    expect(await ready).toEqual({ recovered: [], alerted: [] });
    expect(gateway.calls.filter((c) => c.method === "sessions.recover").map((c) => c.params.key)).toEqual(["exec-turn"]);
    expect(notify).not.toHaveBeenCalled();
    expect(lines().filter((line) => line.includes(" done "))).toEqual([
      "[alphaclaw] wedge-sweep done generation=5 checked=1 recorded=1 recovered=0 alerted=0",
    ]);
  });

  it("a restart that cuts short a background exec (OpenClaw's drain report) tells the owner once after the relaunch; a drained one stays silent", async () => {
    const gateway = createGateway({ "sessions.list": async () => ({ body: { sessions: [] } }) });
    const { sweep, notify, insertEvent } = createSweep(gateway);
    await sweep.recordRunningSessions({ opId: "abcdef1234" });
    sweep.observeGatewayOutput("[gateway] 2026-10-22T22:36:05Z [gateway] draining active work before restart with timeout 179991ms: queueSize=2 embeddedRuns=1 agentRuns=1\n");
    sweep.observeGatewayOutput("[gateway] 2026-10-22T22:38:36Z [gateway] still draining active work before restart: backgroundExecSess");
    sweep.observeGatewayOutput("ions=1\n[gateway] 2026-10-22T22:39:05Z [gateway] restart drain budget 179991.6ms exhausted; cutting short backgroundExecSessions=2\n");
    await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("The gateway restart stopped 2 commands the agent was running in the background.");
    expect(message).toContain("the agent was not told");
    expect(message).not.toMatch(/reset|pid/i);
    expect(opts).toEqual({ eventType: "session_wedge", id: "exec-stopped-2" });
    expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.count])).toEqual([["exec_stopped", 2]]);
    expect(lines()).toContain("[alphaclaw] wedge-sweep exec-stopped generation=2 op=abcdef12 count=2");

    // The next relaunch does not repeat it; a drain that finished its background work is silent.
    notify.mockClear();
    await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt });
    await sweep.recordRunningSessions({ opId: "second" });
    sweep.observeGatewayOutput("draining active work before restart with timeout 30000ms: backgroundExecSessions=1\nall active work drained\n");
    await sweep.onGatewayLaunch({ generation: 4, startedAt: kLaunchAt });
    // A crash relaunch (no restart requested) never reads the output.
    sweep.observeGatewayOutput("restart drain budget 1ms exhausted; cutting short backgroundExecSessions=3\n");
    await sweep.onGatewayLaunch({ generation: 5, startedAt: kLaunchAt });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a newer launch supersedes a pending sweep; a gateway that never becomes ready is skipped", async () => {
    const gateway = createGateway({ "sessions.list": async () => ({ body: { sessions: [] } }) });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { sweep } = createSweep(gateway, { sleep: vi.fn(() => gate) });
    const first = sweep.onGatewayLaunch({ generation: 1, startedAt: kLaunchAt });
    await Promise.resolve();
    const second = sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
    release();
    expect(await first).toEqual({ skipped: "superseded" });
    expect(await second).toMatchObject({ recovered: [], alerted: [] });

    const never = createSweep(gateway, { probeReadiness: vi.fn(async () => ({ ok: true, kind: "not_ready" })), readyTimeoutMs: 20_000 });
    expect(await never.sweep.onGatewayLaunch({ generation: 9 })).toEqual({ skipped: "not_ready" });
  });
});
