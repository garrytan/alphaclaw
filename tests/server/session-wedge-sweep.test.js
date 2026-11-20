const { createSessionWedgeSweep, classifySessions, kWedgeReasons } = require("../../lib/server/session-wedge-sweep");

const kLaunchAt = 1_800_000_000_000;
// sessions.list compact rows as OpenClaw 2026.11.6 answers them after a
// relaunch: a turn a SIGKILL cut off keeps its startedAt and has no endedAt
// or status; a resumed or finished one has status "done" and an endedAt.
const lostRow = (key, extra = {}) => ({ key, agentId: "main", sessionId: `id-${key}`, hasActiveRun: false, abortedLastRun: false, startedAt: kLaunchAt - 120_000, updatedAt: kLaunchAt - 119_000, ...extra });
const doneRow = (key, extra = {}) => ({ ...lostRow(key), status: "done", endedAt: kLaunchAt - 60_000, ...extra });

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
  return { sweep, notify, insertEvent, advance: (ms) => { clock += ms; }, at: () => clock };
};

describe("post-relaunch lost-turn check (OpenClaw 2026.11.5+)", () => {
  let log;
  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const lines = () => log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[alphaclaw] wedge-sweep "));

  it("counts as lost only a turn that started before the launch, never ended, has no status and no active run", () => {
    const rows = [
      lostRow("lost"),
      doneRow("finished"),
      lostRow("ended-without-status", { endedAt: kLaunchAt - 1_000 }),
      lostRow("running-status", { status: "running" }),
      lostRow("active", { hasActiveRun: true }),
      lostRow("resumed-after-launch", { startedAt: kLaunchAt + 3_000 }),
      lostRow("before-the-window", { startedAt: kLaunchAt - 10 * 60 * 60 * 1000 }),
      lostRow("doctor"),
      { key: "agent:main:never-ran", agentId: "main", hasActiveRun: false, updatedAt: kLaunchAt - 1_000 },
      null,
    ];
    const { lost } = classifySessions({ rows, launchAtMs: kLaunchAt, sinceMs: kLaunchAt - 6 * 60 * 60 * 1000, skip: (key) => key === "doctor" });
    expect(lost.map(({ row, reason }) => [row.key, reason])).toEqual([["lost", kWedgeReasons.LOST]]);
  });

  it("after a crash relaunch: waits for ready + 90 s, then tells the owner once which turn was lost, through sessions.list alone", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:telegram:direct:1", { displayName: "Garry DM" }), doneRow("agent:main:other")] } }) });
    const { sweep, notify, insertEvent, at } = createSweep(gateway);
    const result = await sweep.onGatewayLaunch({ generation: 2, startedAt: kLaunchAt });
    expect(result).toEqual({ alerted: ["agent:main:telegram:direct:1"] });
    expect(at()).toBe(kLaunchAt + 90_000);
    expect(gateway.calls.map(({ method }) => method)).toEqual(["sessions.list"]);
    expect(gateway.calls[0].params).toMatchObject({ limit: 200, rowMode: "compact" });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("🐺 *AlphaClaw Watchdog*");
    expect(message).toContain("The gateway stopped without a clean shutdown, so a turn it was running was lost:");
    expect(message).toContain("• Garry DM");
    expect(message).toContain("Send a message in that session to pick the work up again.");
    expect(opts).toEqual({ eventType: "session_wedge", id: "session-lost-2" });
    expect(insertEvent.mock.calls.map(([event]) => [event.status, event.details.sessionKey, event.details.reason])).toEqual([["alerted", "agent:main:telegram:direct:1", "lost"]]);
    expect(lines()).toEqual([
      "[alphaclaw] wedge-sweep alerted session=agent:main:telegram:direct:1 reason=lost generation=2",
      "[alphaclaw] wedge-sweep done generation=2 checked=2 lost=1",
    ]);
  });

  it("names every lost turn of one relaunch in a single notice", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:a"), lostRow("agent:ops:b")] } }) });
    const { sweep, notify } = createSweep(gateway);
    expect(await sweep.onGatewayLaunch({ generation: 3, startedAt: kLaunchAt })).toEqual({ alerted: ["agent:main:a", "agent:ops:b"] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("so 2 turns it was running were lost:");
  });

  it("after a graceful restart OpenClaw resumed the turn itself, so the check stays silent", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [doneRow("agent:main:x", { startedAt: kLaunchAt + 3_000, endedAt: kLaunchAt + 6_000 })] } }) });
    const { sweep, notify, insertEvent } = createSweep(gateway);
    expect(await sweep.onGatewayLaunch({ generation: 4, startedAt: kLaunchAt })).toEqual({ alerted: [] });
    expect(notify).not.toHaveBeenCalled();
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("reports a lost turn once: the next relaunch looks back only to the previous launch", async () => {
    const rows = [lostRow("agent:main:a")];
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: rows } }) });
    const { sweep, notify, advance, at } = createSweep(gateway);
    expect((await sweep.onGatewayLaunch({ generation: 5, startedAt: kLaunchAt })).alerted).toEqual(["agent:main:a"]);
    advance(10 * 60_000);
    const second = at();
    expect((await sweep.onGatewayLaunch({ generation: 6, startedAt: second })).alerted).toEqual([]);
    rows.push(lostRow("agent:main:b", { startedAt: second + 60_000 }));
    advance(5 * 60_000);
    expect((await sweep.onGatewayLaunch({ generation: 7, startedAt: at() })).alerted).toEqual(["agent:main:b"]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("never reports a session skipSession names", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:doctor:7")] } }) });
    const skipSession = vi.fn(() => true);
    const { sweep, notify } = createSweep(gateway, { skipSession });
    expect(await sweep.onGatewayLaunch({ generation: 8, startedAt: kLaunchAt })).toEqual({ alerted: [] });
    expect(skipSession).toHaveBeenCalledWith("agent:main:doctor:7", kLaunchAt - 119_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a cold restart's two launch notices for one generation share one check", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:a")] } }) });
    const { sweep, notify } = createSweep(gateway);
    const first = sweep.onGatewayLaunch({ generation: 9, startedAt: kLaunchAt });
    const second = sweep.onGatewayLaunch({ generation: 9, startedAt: kLaunchAt + 500 });
    expect(second).toBe(first);
    expect(await first).toEqual({ alerted: ["agent:main:a"] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a newer launch supersedes a pending check; a gateway that never becomes ready is skipped; a failed read is logged", async () => {
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:a")] } }) });
    const { sweep, notify } = createSweep(gateway);
    const stale = sweep.onGatewayLaunch({ generation: 10, startedAt: kLaunchAt });
    const fresh = sweep.onGatewayLaunch({ generation: 11, startedAt: kLaunchAt + 1_000 });
    expect(await stale).toEqual({ skipped: "superseded" });
    expect(await fresh).toEqual({ alerted: ["agent:main:a"] });
    expect(notify).toHaveBeenCalledTimes(1);

    const never = createSweep(createGateway({}), { probeReadiness: vi.fn(async () => ({ ok: true, kind: "starting" })) });
    expect(await never.sweep.onGatewayLaunch({ generation: 12, startedAt: kLaunchAt })).toEqual({ skipped: "not_ready" });

    const unreadable = createSweep(createGateway({}));
    expect(await unreadable.sweep.onGatewayLaunch({ generation: 13, startedAt: kLaunchAt })).toEqual({ skipped: "read_failed" });
    expect(lines()).toContain("[alphaclaw] wedge-sweep skipped generation=13 reason=read_failed");
  });

  it("checks a boot that took about 8 minutes to become ready (GST-2884)", async () => {
    let probes = 0;
    const gateway = createGateway({ "sessions.list": () => ({ body: { sessions: [lostRow("agent:main:a")] } }) });
    const { sweep } = createSweep(gateway, { probeReadiness: vi.fn(async () => (++probes > 96 ? { ok: true, kind: "ready" } : { ok: true, kind: "starting" })) });
    expect(await sweep.onGatewayLaunch({ generation: 14, startedAt: kLaunchAt })).toEqual({ alerted: ["agent:main:a"] });
  });
});
