const { createLeftoverDoctorTurnStop } = require("../../lib/server/doctor/leftover-turns");

const rowsFor = (...rows) => JSON.stringify({ sessions: rows });

const harness = ({ lists, abandoned = [], abortBody = () => ({ ok: true, aborted: true }), ready = [true] } = {}) => {
  const calls = [];
  let listIndex = 0;
  const clawCmd = vi.fn(async (command) => {
    const method = /gateway call '?([a-z.]+)'?/.exec(command)?.[1];
    const params = JSON.parse(/--params '(.*)' --json/.exec(command)[1]);
    calls.push({ method, params });
    if (method === "sessions.list") return { ok: true, stdout: lists[Math.min(listIndex++, lists.length - 1)] };
    return { ok: true, stdout: JSON.stringify(abortBody(calls.filter((call) => call.method === "chat.abort").length)) };
  });
  let readyIndex = 0;
  const probeReadiness = vi.fn(async () => ({ ok: true, kind: ready[Math.min(readyIndex++, ready.length - 1)] ? "ready" : "starting" }));
  const insertEvent = vi.fn();
  const logger = { log: vi.fn() };
  const forgotten = [];
  let abandonedKeys = [...abandoned];
  const stop = createLeftoverDoctorTurnStop({
    clawCmd,
    listAbandonedSessionKeys: () => abandonedKeys.filter((key) => !forgotten.includes(key)),
    forget: (key) => forgotten.push(key),
    probeReadiness,
    resolveReadyzUrl: () => "http://127.0.0.1:1/readyz",
    insertEvent,
    sleep: async () => {},
    logger,
  });
  const aborted = () => calls.filter((call) => call.method === "chat.abort").map((call) => call.params.sessionKey);
  const lists_ = () => calls.filter((call) => call.method === "sessions.list");
  return { stop, calls, aborted, lists: lists_, insertEvent, logger, probeReadiness, forgotten, setAbandoned: (keys) => { abandonedKeys = keys; } };
};

describe("leftover Doctor turns after a gateway restart", () => {
  it("stops the resumed turn of a run AlphaClaw abandoned, whenever over five minutes it shows up", async () => {
    const h = harness({
      abandoned: ["agent:main:doctor:12", "agent:main:doctor:13"],
      lists: [
        rowsFor({ key: "agent:main:main", hasActiveRun: true }),
        rowsFor({ key: "agent:main:doctor:12", hasActiveRun: true }, { key: "agent:main:doctor:11", hasActiveRun: false }),
        rowsFor(),
        rowsFor(),
        rowsFor(),
        rowsFor(),
        rowsFor(),
        rowsFor({ key: "agent:main:doctor:13", hasActiveRun: true }),
      ],
    });
    const result = await h.stop.onGatewayLaunch({ generation: 1 });
    expect(result.stopped).toEqual(["agent:main:doctor:12", "agent:main:doctor:13"]);
    expect(h.aborted()).toEqual(["agent:main:doctor:12", "agent:main:doctor:13"]);
    expect(h.lists()).toHaveLength(8);
    expect(h.calls[0].params).toEqual({ activeOnly: true, limit: 200, rowMode: "compact" });
    expect(h.logger.log).toHaveBeenCalledWith("[alphaclaw] doctor: stopped the leftover Doctor turn agent:main:doctor:12 the gateway picked up again after a restart");
    expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ kind: "leftover_turn_stopped", sessionKey: "agent:main:doctor:12", ok: true }) }));
  });

  it("never aborts a non-Doctor turn, a turn in another agent's or a sub session, or an active Doctor session AlphaClaw did not abandon", async () => {
    const h = harness({
      abandoned: ["agent:main:doctor:1"],
      lists: [rowsFor(
        { key: "agent:main:main", hasActiveRun: true },
        { key: "agent:ops:doctor:1", hasActiveRun: true },
        { key: "agent:main:doctor:1:sub", hasActiveRun: true },
        { key: "agent:main:doctorx:1", hasActiveRun: true },
        { key: "agent:main:doctor:12", hasActiveRun: true },
        { key: "agent:main:doctor:1", hasActiveRun: false },
        { key: "agent:main:telegram:direct:1", hasActiveRun: true },
      )],
    });
    expect((await h.stop.onGatewayLaunch({ generation: 2 })).stopped).toEqual([]);
    expect(h.aborted()).toEqual([]);
    expect(h.lists()).toHaveLength(8);
  });

  it("calls the gateway not at all when no run was abandoned", async () => {
    const h = harness({ lists: [rowsFor({ key: "agent:main:doctor:7", hasActiveRun: true })] });
    expect((await h.stop.onGatewayLaunch({ generation: 3 })).stopped).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("forgets the abandoned sessions once a launch's looks are done, so a later turn there is left alone", async () => {
    const h = harness({ abandoned: ["agent:main:doctor:20"], lists: [rowsFor()] });
    await h.stop.onGatewayLaunch({ generation: 4 });
    expect(h.forgotten).toEqual(["agent:main:doctor:20"]);
    const later = harness({ abandoned: [], lists: [rowsFor({ key: "agent:main:doctor:20", hasActiveRun: true })] });
    await later.stop.onGatewayLaunch({ generation: 5 });
    expect(later.aborted()).toEqual([]);
  });

  it("counts a turn chat.abort reports as not aborted as not stopped, and tries it again at the next look", async () => {
    const running = rowsFor({ key: "agent:main:doctor:15", hasActiveRun: true });
    const h = harness({
      abandoned: ["agent:main:doctor:15"],
      abortBody: (count) => ({ ok: true, aborted: count > 1 }),
      lists: [running, running, rowsFor()],
    });
    expect((await h.stop.onGatewayLaunch({ generation: 6 })).stopped).toEqual(["agent:main:doctor:15"]);
    expect(h.aborted()).toEqual(["agent:main:doctor:15", "agent:main:doctor:15"]);
    expect(h.logger.log.mock.calls[0][0]).toContain("could not stop the leftover Doctor turn agent:main:doctor:15");
  });

  it("waits for the gateway to be ready first, and joins the second notice of one launch", async () => {
    const h = harness({ abandoned: ["agent:main:doctor:3"], ready: [false, false, true], lists: [rowsFor()] });
    const first = h.stop.onGatewayLaunch({ generation: 7 });
    const second = h.stop.onGatewayLaunch({ generation: 7 });
    expect(second).toBe(first);
    await first;
    expect(h.probeReadiness).toHaveBeenCalledTimes(3);
  });

  it("a newer launch supersedes the checks of an older one and keeps watching the same sessions", async () => {
    const h = harness({ abandoned: ["agent:main:doctor:4"], lists: [rowsFor()] });
    const older = h.stop.onGatewayLaunch({ generation: 8 });
    const newer = h.stop.onGatewayLaunch({ generation: 9 });
    expect(await older).toMatchObject({ skipped: "superseded" });
    expect(await newer).toEqual({ stopped: [] });
    expect(h.forgotten).toEqual(["agent:main:doctor:4"]);
  });
});
