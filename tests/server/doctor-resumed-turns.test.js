const { createResumedDoctorTurnStop, findResumedDoctorRunId } = require("../../lib/server/doctor/resumed-turns");

// Message shapes as sessions.get returns them on the pinned OpenClaw 2026.10.9
// (recorded against the real gateway: a SIGKILLed Doctor turn, its restart
// recovery, then a person's own turn in the same session).
const doctorMessage = (runId) => ({ role: "user", idempotencyKey: `doctor-run-${runId}:user`, __openclaw: { idempotencyKey: `doctor-run-${runId}:user`, seq: 1 } });
const recoveryMessage = (key, recoveryRunId) => ({
  role: "user",
  idempotencyKey: `${recoveryRunId}:user`,
  provenance: { kind: "internal_system", sourceSessionKey: key, sourceTool: "main_session_restart_recovery" },
  __openclaw: { idempotencyKey: `${recoveryRunId}:user`, seq: 2 },
});
const personMessage = (idem) => ({ role: "user", idempotencyKey: `${idem}:user`, __openclaw: { idempotencyKey: `${idem}:user`, seq: 3 } });
const assistant = { role: "assistant", content: [{ type: "text", text: "working" }] };

const harness = ({ lists, transcripts = {}, abortBody = (params) => ({ ok: true, aborted: true, runIds: [params.runId] }), activeRunId = 0, ready = [true] } = {}) => {
  const calls = [];
  let listIndex = 0;
  const clawCmd = vi.fn(async (command) => {
    const method = /gateway call '?([a-z.]+)'?/.exec(command)?.[1];
    const params = JSON.parse(/--params '(.*)' --json/.exec(command)[1]);
    calls.push({ method, params });
    if (method === "sessions.list") return { ok: true, stdout: JSON.stringify({ sessions: lists[Math.min(listIndex++, lists.length - 1)] }) };
    if (method === "sessions.get") return { ok: true, stdout: JSON.stringify({ messages: transcripts[params.key] || [] }) };
    const body = abortBody(params, calls.filter((call) => call.method === "chat.abort").length);
    return { ok: true, stdout: typeof body === "string" ? body : JSON.stringify(body) };
  });
  let readyIndex = 0;
  const probeReadiness = vi.fn(async () => ({ ok: true, kind: ready[Math.min(readyIndex++, ready.length - 1)] ? "ready" : "starting" }));
  const insertEvent = vi.fn();
  const logger = { log: vi.fn() };
  const stop = createResumedDoctorTurnStop({
    clawCmd,
    getActiveRunId: () => activeRunId,
    probeReadiness,
    resolveReadyzUrl: () => "http://127.0.0.1:1/readyz",
    insertEvent,
    sleep: async () => {},
    logger,
  });
  const aborts = () => calls.filter((call) => call.method === "chat.abort").map((call) => call.params);
  return { stop, calls, aborts, insertEvent, logger, probeReadiness };
};

const active = (key) => ({ key, hasActiveRun: true });

describe("resumed Doctor turns after a gateway restart", () => {
  it("stops the exact run the gateway restarted for a Doctor run, whenever over five minutes it shows up", async () => {
    const h = harness({
      lists: [[active("agent:main:main")], [active("agent:main:doctor:12")], [], [], [], [], [], [active("agent:main:doctor:13")]],
      transcripts: {
        "agent:main:doctor:12": [doctorMessage(12), assistant, recoveryMessage("agent:main:doctor:12", "rec-12")],
        "agent:main:doctor:13": [doctorMessage(13), recoveryMessage("agent:main:doctor:13", "rec-13")],
      },
    });
    const result = await h.stop.onGatewayLaunch({ generation: 1 });
    expect(result).toEqual({ stopped: ["rec-12", "rec-13"], missed: [] });
    expect(h.aborts()).toEqual([
      { sessionKey: "agent:main:doctor:12", runId: "rec-12" },
      { sessionKey: "agent:main:doctor:13", runId: "rec-13" },
    ]);
    expect(h.calls.filter((call) => call.method === "sessions.list")).toHaveLength(8);
    expect(h.calls[0].params).toEqual({ activeOnly: true, limit: 200, rowMode: "compact" });
    expect(h.calls.find((call) => call.method === "sessions.get").params).toEqual({ key: "agent:main:doctor:12", limit: 500 });
    expect(h.logger.log).toHaveBeenCalledWith("[alphaclaw] doctor: stopped Doctor run 12's turn, which the gateway restarted after a restart cut it off (agent:main:doctor:12, run rec-12)");
    expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ details: { kind: "resumed_turn_stopped", sessionKey: "agent:main:doctor:12", doctorRunId: 12, runId: "rec-12" } }));
  });

  it("never stops a person's own turn in a Doctor session, even one sent while the restarted turn is running", async () => {
    const key = "agent:main:doctor:7";
    const h = harness({
      lists: [[active(key)]],
      transcripts: { [key]: [doctorMessage(7), assistant, recoveryMessage(key, "rec-7"), personMessage("user-turn-1")] },
    });
    expect(await h.stop.onGatewayLaunch()).toEqual({ stopped: [], missed: [] });
    expect(h.aborts()).toEqual([]);
  });

  it("never stops a turn outside a Doctor run: other sessions, other agents, sub sessions, and transcripts that do not hold that Doctor run's message", async () => {
    const recovered = (key) => [doctorMessage(5), recoveryMessage(key, "rec-x")];
    const h = harness({
      lists: [[
        active("agent:main:main"),
        active("agent:ops:doctor:5"),
        active("agent:main:doctor:5:sub"),
        active("agent:main:doctorx:5"),
        active("agent:main:doctor:6"),
        active("agent:main:doctor:8"),
        active("agent:main:doctor:9"),
        { key: "agent:main:doctor:10", hasActiveRun: false },
      ]],
      transcripts: {
        "agent:main:main": recovered("agent:main:main"),
        "agent:ops:doctor:5": recovered("agent:ops:doctor:5"),
        "agent:main:doctor:6": [doctorMessage(5), recoveryMessage("agent:main:doctor:6", "rec-6")],
        "agent:main:doctor:8": [doctorMessage(8), { ...recoveryMessage("agent:main:doctor:8", "rec-8"), provenance: { kind: "internal_system", sourceSessionKey: "agent:main:main", sourceTool: "main_session_restart_recovery" } }],
        "agent:main:doctor:9": [doctorMessage(9), { ...recoveryMessage("agent:main:doctor:9", "rec-9"), provenance: { kind: "inter_session", sourceSessionKey: "agent:main:doctor:9", sourceTool: "sessions_send" } }],
        "agent:main:doctor:10": recovered("agent:main:doctor:10"),
      },
    });
    await h.stop.onGatewayLaunch();
    expect(h.aborts()).toEqual([]);
    expect([...new Set(h.calls.filter((call) => call.method === "sessions.get").map((call) => call.params.key))]).toEqual(["agent:main:doctor:6", "agent:main:doctor:8", "agent:main:doctor:9"]);
  });

  it("never stops a person's turn that recovery resumed in a Doctor session after the Doctor run ended", async () => {
    const key = "agent:main:doctor:7";
    const h = harness({
      lists: [[active(key)]],
      transcripts: { [key]: [doctorMessage(7), assistant, personMessage("person-123"), assistant, recoveryMessage(key, "recov-1")] },
    });
    expect(await h.stop.onGatewayLaunch()).toEqual({ stopped: [], missed: [] });
    expect(h.aborts()).toEqual([]);
    expect(h.stop.hasStopped(key)).toBe(false);
  });

  it("looks past earlier recovery messages to the turn they resume, and remembers the sessions it stopped for this launch only", async () => {
    const key = "agent:main:doctor:6";
    const h = harness({
      lists: [[active(key)]],
      transcripts: { [key]: [doctorMessage(6), recoveryMessage(key, "recov-a"), recoveryMessage(key, "recov-b")] },
    });
    expect(await h.stop.onGatewayLaunch({ generation: 1 })).toEqual({ stopped: ["recov-b"], missed: [] });
    expect(h.stop.hasStopped(key)).toBe(true);
    expect(h.stop.hasStopped("agent:main:doctor:5")).toBe(false);
    const next = h.stop.onGatewayLaunch({ generation: 2 });
    expect(h.stop.hasStopped(key)).toBe(false);
    await next;
  });

  it("says so when the gateway never got ready", async () => {
    let clock = 0;
    const logger = { log: vi.fn() };
    const stop = createResumedDoctorTurnStop({
      clawCmd: vi.fn(),
      probeReadiness: async () => ({ ok: true, kind: "starting" }),
      resolveReadyzUrl: () => "http://127.0.0.1:1/readyz",
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      readyTimeoutMs: 10_000,
      logger,
    });
    expect(await stop.onGatewayLaunch()).toEqual({ skipped: "not_ready" });
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] doctor: the gateway was not ready within 10 s, so no restarted Doctor turn was looked for");
  });

  it("never stops the run AlphaClaw is driving now", async () => {
    const key = "agent:main:doctor:4";
    const h = harness({ activeRunId: 4, lists: [[active(key)]], transcripts: { [key]: [doctorMessage(4), recoveryMessage(key, "rec-4")] } });
    await h.stop.onGatewayLaunch();
    expect(h.aborts()).toEqual([]);
  });

  it("counts a stop only when chat.abort confirms that run, tries again at the next look, and names a turn it never stopped once", async () => {
    const key = "agent:main:doctor:3";
    const replies = [
      "not json",
      { ok: true, aborted: false, runIds: [] },
      { ok: true, aborted: true, runIds: ["someone-else"] },
    ];
    const h = harness({
      lists: [[active(key)]],
      transcripts: { [key]: [doctorMessage(3), recoveryMessage(key, "rec-3")] },
      abortBody: (params, count) => (count <= replies.length ? replies[count - 1] : { ok: true, aborted: false }),
    });
    expect(await h.stop.onGatewayLaunch()).toEqual({ stopped: [], missed: ["rec-3"] });
    expect(h.aborts()).toHaveLength(8);
    expect(h.logger.log.mock.calls.map((call) => call[0])).toEqual(["[alphaclaw] doctor: could not stop the restarted Doctor turn in agent:main:doctor:3 (run rec-3); it may have ended on its own"]);

    const later = harness({
      lists: [[active(key)]],
      transcripts: { [key]: [doctorMessage(3), recoveryMessage(key, "rec-3")] },
      abortBody: (params, count) => (count === 1 ? { ok: true, aborted: false } : { ok: true, aborted: true, runIds: [params.runId] }),
    });
    expect(await later.stop.onGatewayLaunch()).toEqual({ stopped: ["rec-3"], missed: [] });
    expect(later.aborts()).toHaveLength(2);
  });

  it("waits for the gateway to be ready, and a newer launch supersedes the checks of an older one", async () => {
    const h = harness({ ready: [false, false, true], lists: [[]] });
    await h.stop.onGatewayLaunch({ generation: 1 });
    expect(h.probeReadiness).toHaveBeenCalledTimes(3);

    const superseded = harness({ lists: [[]] });
    const first = superseded.stop.onGatewayLaunch({ generation: 1 });
    expect(superseded.stop.onGatewayLaunch({ generation: 1 })).toBe(first);
    const second = superseded.stop.onGatewayLaunch({ generation: 2 });
    expect((await first).skipped).toBe("superseded");
    expect(await second).toEqual({ stopped: [], missed: [] });
  });

  it("finds the restarted run only from the latest user message, after that Doctor run's own message", () => {
    const key = "agent:main:doctor:2";
    expect(findResumedDoctorRunId([doctorMessage(2), recoveryMessage(key, "r")], key, 2)).toBe("r");
    expect(findResumedDoctorRunId([recoveryMessage(key, "r")], key, 2)).toBe("");
    expect(findResumedDoctorRunId([recoveryMessage(key, "r"), doctorMessage(2)], key, 2)).toBe("");
    expect(findResumedDoctorRunId([doctorMessage(2), recoveryMessage(key, "doctor-run-2")], key, 2)).toBe("");
    expect(findResumedDoctorRunId([doctorMessage(2), { ...recoveryMessage(key, "r"), idempotencyKey: "r", __openclaw: { idempotencyKey: "r" } }], key, 2)).toBe("");
    expect(findResumedDoctorRunId(null, key, 2)).toBe("");
    expect(findResumedDoctorRunId([doctorMessage(2), personMessage("p"), recoveryMessage(key, "r")], key, 2)).toBe("");
    expect(findResumedDoctorRunId([doctorMessage(2), recoveryMessage(key, "r0"), recoveryMessage(key, "r")], key, 2)).toBe("r");
    expect(findResumedDoctorRunId([doctorMessage(2), recoveryMessage("agent:main:main", "r0"), recoveryMessage(key, "r")], key, 2)).toBe("");
  });
});
