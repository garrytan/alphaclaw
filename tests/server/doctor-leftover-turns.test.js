const { createLeftoverDoctorTurnStop } = require("../../lib/server/doctor/leftover-turns");

const rowsFor = (...rows) => JSON.stringify({ sessions: rows });

const harness = ({ lists, activeKey = null, ready = [true] } = {}) => {
  const calls = [];
  let listIndex = 0;
  const clawCmd = vi.fn(async (command) => {
    const method = /gateway call '?([a-z.]+)'?/.exec(command)?.[1];
    const params = JSON.parse(/--params '(.*)' --json/.exec(command)[1]);
    calls.push({ method, params });
    if (method === "sessions.list") return { ok: true, stdout: lists[Math.min(listIndex++, lists.length - 1)] };
    return { ok: true, stdout: "{}" };
  });
  let readyIndex = 0;
  const probeReadiness = vi.fn(async () => ({ ok: true, kind: ready[Math.min(readyIndex++, ready.length - 1)] ? "ready" : "starting" }));
  const insertEvent = vi.fn();
  const logger = { log: vi.fn() };
  const stop = createLeftoverDoctorTurnStop({
    clawCmd,
    getActiveRunSessionKey: () => activeKey,
    probeReadiness,
    resolveReadyzUrl: () => "http://127.0.0.1:1/readyz",
    insertEvent,
    sleep: async () => {},
    logger,
  });
  const aborted = () => calls.filter((call) => call.method === "chat.abort").map((call) => call.params.sessionKey);
  return { stop, calls, aborted, insertEvent, logger, probeReadiness };
};

describe("leftover Doctor turns after a gateway restart", () => {
  it("stops a Doctor turn the gateway resumed on its own and leaves every other running session alone", async () => {
    const h = harness({
      lists: [
        rowsFor({ key: "agent:main:main", hasActiveRun: true }),
        rowsFor(
          { key: "agent:main:doctor:12", hasActiveRun: true },
          { key: "agent:main:doctor:11", hasActiveRun: false },
          { key: "agent:main:telegram:direct:1", hasActiveRun: true },
          { key: "agent:main:doctor:12:sub", hasActiveRun: true },
        ),
        rowsFor({ key: "agent:ops:doctor:13", hasActiveRun: true }, { key: "agent:main:doctor:13", hasActiveRun: true }),
        rowsFor(),
      ],
    });
    const result = await h.stop.onGatewayLaunch({ generation: 1 });
    expect(result.stopped).toEqual(["agent:main:doctor:12", "agent:main:doctor:13"]);
    expect(h.aborted()).toEqual(["agent:main:doctor:12", "agent:main:doctor:13"]);
    expect(h.calls.filter((call) => call.method === "sessions.list")).toHaveLength(8);
    expect(h.calls[0].params).toEqual({ activeOnly: true, limit: 200, rowMode: "compact" });
    expect(h.logger.log).toHaveBeenCalledWith("[alphaclaw] doctor: stopped the leftover Doctor turn agent:main:doctor:12 the gateway picked up again after a restart");
    expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ kind: "leftover_turn_stopped", sessionKey: "agent:main:doctor:12", ok: true }) }));
  });

  it("counts a turn chat.abort did not stop as not stopped, and tries it again at the next look", async () => {
    let aborts = 0;
    const clawCmd = vi.fn(async (command) => {
      if (command.includes("chat.abort")) {
        aborts += 1;
        return { ok: true, stdout: JSON.stringify({ ok: true, aborted: aborts > 1 }) };
      }
      return { ok: true, stdout: aborts < 2 ? rowsFor({ key: "agent:main:doctor:15", hasActiveRun: true }) : rowsFor() };
    });
    const logger = { log: vi.fn() };
    const stop = createLeftoverDoctorTurnStop({
      clawCmd,
      probeReadiness: async () => ({ ok: true, kind: "ready" }),
      resolveReadyzUrl: () => "http://x/readyz",
      sleep: async () => {},
      logger,
    });
    expect((await stop.onGatewayLaunch({ generation: 9 })).stopped).toEqual(["agent:main:doctor:15"]);
    expect(aborts).toBe(2);
    expect(logger.log.mock.calls[0][0]).toContain("could not stop the leftover Doctor turn agent:main:doctor:15");
  });

  it("never stops the run AlphaClaw is driving now", async () => {
    const h = harness({ activeKey: "agent:main:doctor:14", lists: [rowsFor({ key: "agent:main:doctor:14", hasActiveRun: true })] });
    expect((await h.stop.onGatewayLaunch({ generation: 2 })).stopped).toEqual([]);
    expect(h.aborted()).toEqual([]);
  });

  it("waits for the gateway to be ready first, and joins the second notice of one launch", async () => {
    const h = harness({ ready: [false, false, true], lists: [rowsFor()] });
    const first = h.stop.onGatewayLaunch({ generation: 3 });
    const second = h.stop.onGatewayLaunch({ generation: 3 });
    expect(second).toBe(first);
    await first;
    expect(h.probeReadiness).toHaveBeenCalledTimes(3);
  });

  it("a newer launch supersedes the checks of an older one", async () => {
    const h = harness({ lists: [rowsFor()] });
    const older = h.stop.onGatewayLaunch({ generation: 4 });
    const newer = h.stop.onGatewayLaunch({ generation: 5 });
    expect(await older).toMatchObject({ skipped: "superseded" });
    expect(await newer).toEqual({ stopped: [] });
  });
});
