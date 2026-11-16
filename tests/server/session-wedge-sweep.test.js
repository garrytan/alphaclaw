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
        row("recent-interrupted", { status: "interrupted", updatedAt: kLaunchAt - 5 * 60_000 }),
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
      ["recent-interrupted", kWedgeReasons.NOT_RESUMED],
    ]);
  });

  it("leaves alone a session whose restarted Doctor turn AlphaClaw stopped, and still resumes or reports a person's turn in another Doctor session", () => {
    const stopped = "agent:main:doctor:7";
    const person = "agent:main:doctor:8";
    const wedgedPerson = "agent:main:doctor:9";
    const { recoverable, wedged } = classifySessions({
      rows: [row(stopped, { abortedLastRun: true }), row(person), row(wedgedPerson, { abortedLastRun: true })],
      recorded: new Map([[stopped, {}], [person, {}], [wedgedPerson, {}]]),
      launchAtMs: kLaunchAt,
      nowMs: kLaunchAt + 120_000,
      skip: (key) => key === stopped,
    });
    expect(recoverable.map(({ row: r }) => r.key)).toEqual([person]);
    expect(wedged.map(({ row: r, reason }) => [r.key, reason])).toEqual([[wedgedPerson, kWedgeReasons.NOT_RESUMED]]);
  });

  it("never resumes or reports a session skipSession names when it sweeps", async () => {
    const stopped = "agent:main:doctor:7";
    const gateway = createGateway({
      "sessions.list": async (params) => params.activeOnly
        ? { body: { sessions: [row(stopped, { hasActiveRun: true }), row("a", { hasActiveRun: true })] } }
        : { body: { sessions: [row(stopped, { abortedLastRun: true }), row("a")] } },
      "sessions.recover": async ({ key }) => ({ body: { ok: true, key, continuation: { status: "started", runId: "r1" } } }),
    });
    const { sweep, notify } = createSweep(gateway, { skipSession: (key) => key === stopped });
    await sweep.recordRunningSessions();
    expect(await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt })).toEqual({ recovered: ["a"], alerted: [] });
    expect(gateway.calls.filter((c) => c.method === "sessions.recover").map((c) => c.params.key)).toEqual(["a"]);
    expect(notify).not.toHaveBeenCalled();
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
      { key: "dm", agentId: "main" },
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
    expect(listCalls).toBe(4);
  });

  it("a crash relaunch with nothing recorded still finds a recently interrupted session; a recover error other than 'nothing to recover' is recorded, never retried as a reset", async () => {
    const gateway = createGateway({
      "sessions.list": async () => ({ body: { sessions: [row("x", { abortedLastRun: true, updatedAt: kLaunchAt - 30_000 })] } }),
      "sessions.recover": async () => ({ ok: false, body: { ok: false, error: { code: "INVALID_REQUEST", message: "Session recovery requires a restart-tombstoned session." } } }),
    });
    const { sweep, notify } = createSweep(gateway);
    const result = await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt });
    expect(result.alerted).toEqual(["x"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.recover", "sessions.list"]);

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

  it("a background exec whose completion OpenClaw refused while draining is reported as not delivered, even after the drain reports clean; a crash stays silent", async () => {
    const gateway = createGateway({ "sessions.list": async () => ({ body: { sessions: [] } }) });
    const { sweep, notify, insertEvent } = createSweep(gateway);
    await sweep.recordRunningSessions({ opId: "45ff1ae2aa" });
    sweep.observeGatewayOutput("[gateway] 2026-10-23T01:57:46.709+00:00 [gateway] still draining active work before restart: backgroundExecSessions=1\n");
    sweep.observeGatewayOutput("[gateway] 2026-10-23T01:58:08.029+00:00 [session-events] session event execution failed source=exec agentId=main sessionKey=agent:main:main eventId=e1 error=\"GatewayDrainingError: Gateway is restarting. Please try again shortly.\"\n");
    sweep.observeGatewayOutput("[gateway] 2026-10-23T01:58:08.031+00:00 [exec] completion delivery failed (GatewayDrain");
    sweep.observeGatewayOutput("ingError: Gateway is restarting. Please try again shortly.); inspect the process result.\n[gateway] 2026-10-23T01:58:08.240+00:00 [gateway] all active work drained\n");
    await sweep.onGatewayLaunch({ generation: 6, startedAt: kLaunchAt });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("A background command the agent was running finished while the gateway was restarting, but OpenClaw refused to deliver the result.");
    expect(message).not.toContain("The gateway restart stopped");
    expect(message).not.toMatch(/reset|pid/i);
    expect(opts).toEqual({ eventType: "session_wedge", id: "exec-stopped-6" });
    expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.count, e.details.reason])).toEqual([["exec_stopped", 1, "result_not_delivered"]]);
    expect(lines()).toContain("[alphaclaw] wedge-sweep exec-undelivered generation=6 op=45ff1ae2 count=1");

    // Both in one restart: one notice, one event per reason.
    notify.mockClear();
    insertEvent.mockClear();
    await sweep.recordRunningSessions({ opId: "second" });
    sweep.observeGatewayOutput("[exec] completion delivery failed (GatewayDrainingError: Gateway is restarting.)\nrestart drain budget 1ms exhausted; cutting short backgroundExecSessions=2\n");
    await sweep.onGatewayLaunch({ generation: 7, startedAt: kLaunchAt });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("The gateway restart stopped 2 commands");
    expect(notify.mock.calls[0][0]).toContain("refused to deliver the result");
    expect(insertEvent.mock.calls.map(([e]) => [e.details.count, e.details.reason])).toEqual([[2, "stopped"], [1, "result_not_delivered"]]);

    // A crash relaunch (no restart requested) never reads the output.
    notify.mockClear();
    sweep.observeGatewayOutput("[exec] completion delivery failed (GatewayDrainingError: Gateway is restarting.)\n");
    await sweep.onGatewayLaunch({ generation: 8, startedAt: kLaunchAt });
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
  describe("after any launch, a turn the restart cut off (GST-2884)", () => {
    const topicKey = "agent:main:telegram:group:-100123:topic:42";
    const topicRoute = { channel: "telegram", to: "telegram:-100123:topic:42", accountId: "default", threadId: 42 };
    const cutOff = (extra = {}) => row(topicKey, { status: "interrupted", abortedLastRun: true, updatedAt: kLaunchAt - 40_000, deliveryContext: topicRoute, ...extra });
    const notRecoverable = async () => ({ ok: false, body: { ok: false, error: { code: "INVALID_REQUEST", message: "Session recovery requires a restart-tombstoned session." } } });

    it("a pod kill records nothing, yet the boot's sweep offers the turn to sessions.recover and, when OpenClaw declines, posts one line to that topic and never resets", async () => {
      const gateway = createGateway({
        "sessions.list": async () => ({ body: { sessions: [cutOff()] } }),
        "sessions.recover": notRecoverable,
        send: async () => ({ body: { ok: true, messageId: "m1" } }),
      });
      const { sweep, notify, insertEvent } = createSweep(gateway);
      expect(await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt })).toEqual({ recovered: [], alerted: [topicKey] });
      expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.recover", "sessions.list", "send"]);
      const send = gateway.calls.find((c) => c.method === "send").params;
      expect(send).toEqual({
        channel: "telegram",
        to: "telegram:-100123:topic:42",
        accountId: "default",
        threadId: "42",
        message: expect.stringContaining("Please send your last message again."),
        idempotencyKey: `alphaclaw-cut-off-id-${topicKey}-${kLaunchAt - 40_000}`,
      });
      expect(send.message).not.toMatch(/\n|reset|\/new/i);
      expect(notify).not.toHaveBeenCalled();
      expect(insertEvent.mock.calls.map(([e]) => [e.status, e.details.channel, e.details.recorded])).toEqual([["told_chat", "telegram", false]]);
      expect(lines()).toContain(`[alphaclaw] wedge-sweep told chat session=${topicKey} channel=telegram reason=not_resumed generation=2`);
      expect(gateway.calls.map((c) => c.method)).not.toContain("sessions.reset");

      // The same cut-off turn is never posted twice.
      gateway.calls.length = 0;
      expect(await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt + 1000 })).toEqual({ recovered: [], alerted: [] });
      expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list"]);
    });

    it("an interrupted turn OpenClaw agrees to resume is recovered, and nobody is told", async () => {
      const gateway = createGateway({
        "sessions.list": async () => ({ body: { sessions: [cutOff()] } }),
        "sessions.recover": async ({ key }) => ({ body: { ok: true, key, continuation: { status: "started", runId: "r9" } } }),
      });
      const { sweep, notify } = createSweep(gateway);
      expect(await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt })).toEqual({ recovered: [topicKey], alerted: [] });
      expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list", "sessions.recover"]);
      expect(notify).not.toHaveBeenCalled();
    });

    it("waits while OpenClaw's own startup recovery is still resuming sessions one at a time, and tells nobody about a session it then resumed", async () => {
      let resumed = false;
      const gateway = createGateway({
        "sessions.list": async () => ({ body: { sessions: [resumed ? cutOff({ status: "running", hasActiveRun: true, abortedLastRun: false }) : cutOff()] } }),
        "sessions.recover": notRecoverable,
        send: async () => ({ body: { ok: true } }),
      });
      let polls = 0;
      let clock = kLaunchAt;
      let sweepRef;
      const sleep = vi.fn(async (ms) => {
        clock += ms;
        if (ms === 5_000 && ++polls === 100) {
          resumed = true;
          sweepRef.observeGatewayOutput("[gateway] [main-session-recovery] main-session restart recovery startup complete: started=2 settled=0 failed=0 skipped=0 boot=b pass=p\n");
        }
      });
      const { sweep, notify } = createSweep(gateway, { sleep, now: () => clock });
      sweepRef = sweep;
      const pending = sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
      sweep.observeGatewayOutput("[gateway] [main-session-recovery] marked 2 startup-orphaned main session(s) for restart recovery\n");
      expect(await pending).toEqual({ recovered: [], alerted: [] });
      expect(polls).toBe(100);
      expect(gateway.calls.map((c) => c.method)).toEqual(["sessions.list"]);
      expect(notify).not.toHaveBeenCalled();
      expect(lines()).toContain("[alphaclaw] wedge-sweep waiting generation=2 for=openclaw_recovery");
    });

    it("tells nobody when the turn changed during the confirm window, and stops waiting on OpenClaw's recovery after its cap", async () => {
      let listCalls = 0;
      const gateway = createGateway({
        "sessions.list": async () => {
          listCalls += 1;
          return { body: { sessions: [listCalls === 1 ? cutOff() : cutOff({ updatedAt: kLaunchAt + 200_000 })] } };
        },
        "sessions.recover": notRecoverable,
        send: async () => { throw new Error("must not be called"); },
      });
      const { sweep, notify } = createSweep(gateway, { recoveryWaitCapMs: 60_000 });
      const pending = sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
      sweep.observeGatewayOutput("started interrupted main session: agent:main:telegram:group:-100123:topic:7\n");
      expect(await pending).toEqual({ recovered: [], alerted: [] });
      expect(notify).not.toHaveBeenCalled();
      expect(listCalls).toBe(2);
    });

    it("falls back to the owner alert when the session has no chat route, is webchat, or the send fails", async () => {
      const rows = [
        cutOff(),
        row("agent:main:main", { abortedLastRun: true, updatedAt: kLaunchAt - 10_000, displayName: "Main" }),
        row("agent:main:dashboard:1", { abortedLastRun: true, updatedAt: kLaunchAt - 10_000, displayName: "Dashboard", deliveryContext: { channel: "webchat", to: "x" } }),
      ];
      const gateway = createGateway({
        "sessions.list": async () => ({ body: { sessions: rows } }),
        "sessions.recover": notRecoverable,
        send: async () => ({ ok: false, body: { ok: false, error: { message: "chat not found" } } }),
      });
      const { sweep, notify, insertEvent } = createSweep(gateway);
      const result = await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
      expect(result.alerted).toEqual([topicKey, "agent:main:main", "agent:main:dashboard:1"]);
      expect(gateway.calls.filter((c) => c.method === "send")).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toContain("3 sessions may be stuck after the gateway restarted:");
      expect(insertEvent.mock.calls.map(([e]) => e.status)).toEqual(["alerted", "alerted", "alerted"]);
    });

    it("waits for a slow boot well past the restart ready budget (the box was ready about 8 minutes after it listened)", async () => {
      let clock = kLaunchAt;
      const gateway = createGateway({ "sessions.list": async () => ({ body: { sessions: [] } }) });
      const probeReadiness = vi.fn(async () => ({ ok: true, kind: clock - kLaunchAt >= 460_000 ? "ready" : "starting" }));
      const { sweep } = createSweep(gateway, { probeReadiness, sleep: vi.fn(async (ms) => { clock += ms; }), now: () => clock });
      expect(await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt })).toEqual({ recovered: [], alerted: [] });
      expect(lines().some((line) => line.includes("reason=not_ready"))).toBe(false);
    });
  });
});
