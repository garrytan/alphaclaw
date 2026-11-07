import { describe, expect, it } from "vitest";
import { buildArchiveModel, buildRelayPageModel, kArchiveCodeCopy, kRelayPhaseCopy } from "../../lib/public/js/components/relay-tab/model.js";

describe("Relay page model", () => {
  it("has copy for every service phase", () => {
    for (const phase of ["off", "idle", "downloading", "engine_starting", "provisioning", "ready", "failed"]) {
      expect(kRelayPhaseCopy[phase]).toBeTruthy();
    }
  });

  it("orders what needs the owner first: approvals the agent asked for, then failed or open runs", () => {
    const model = buildRelayPageModel({
      status: { enabled: true, phase: "ready", agentName: "wintermute", engine: { port: 18787, exposure: { exposedOn: [] } } },
      runs: [
        { messageId: "1", state: "answered" },
        { messageId: "2", state: "interrupted", code: "run_interrupted" },
        { messageId: "3", state: "dispatched" },
        { messageId: "4", state: "hop_limit" },
      ],
      messages: [
        { messageId: "a", from: "wintermute", to: "capy-1", text: "That restart awaits approval relay-0a1b2c3d from Garry.", createdAt: "t2" },
        { messageId: "b", from: "wintermute", to: "capy-1", text: "Still waiting on approval relay-0a1b2c3d.", createdAt: "t1" },
        { messageId: "c", from: "capy-1", to: "wintermute", text: "approval relay-ffffffff please", createdAt: "t0" },
      ],
    });
    expect(model.waitingOnOwner).toEqual([{ approvalId: "relay-0a1b2c3d", to: "capy-1", at: "t2", messageId: "a" }]);
    expect(model.problems.map((run) => run.messageId)).toEqual(["2", "4"]);
    expect(model.open.map((run) => run.messageId)).toEqual(["3"]);
    expect(model.exposureWarning).toBeNull();
  });

  it("shows the failure title and the exposure warning", () => {
    const failed = buildRelayPageModel({ status: { enabled: true, phase: "failed", error: { code: "secrets_missing", title: "The relay database exists but its keys are missing" } } });
    expect(failed).toMatchObject({ phaseLabel: "Not running", phaseTone: "danger", phaseText: "The relay database exists but its keys are missing" });
    const exposed = buildRelayPageModel({ status: { enabled: true, phase: "ready", engine: { port: 18787, exposure: { exposedOn: ["10.0.0.5"] } } } });
    expect(exposed.exposureWarning).toContain("10.0.0.5 port 18787");
    expect(buildRelayPageModel({ status: { enabled: false } }).phase).toBe("off");
  });

  it("a ready relay whose bridge is failing shows the failure, not Ready (ALPH-63)", () => {
    const failure = "The gateway's session list failed 3 times in a row, so running relay messages cannot be checked.";
    const model = buildRelayPageModel({ status: { enabled: true, phase: "ready", bridge: { failure } } });
    expect(model).toMatchObject({ phaseLabel: "Not answering", phaseTone: "danger", phaseText: failure, bridgeFailure: failure });
    expect(buildRelayPageModel({ status: { enabled: true, phase: "ready", bridge: { failure: null } } }).phaseLabel).toBe("Ready");
  });
});

describe("Relay brain archive model (ALPH-68 PR3)", () => {
  it("names why nothing is saved, and lists conversations waiting for Retry", () => {
    expect(buildArchiveModel(null)).toMatchObject({ phase: "off", canRetry: false });
    expect(buildArchiveModel({ enabled: false, phase: "off", code: null })).toMatchObject({ phase: "off", label: "Off", canRetry: false });
    expect(buildArchiveModel({ enabled: true, phase: "unavailable", code: "source_missing" })).toMatchObject({ label: "Not set up", tone: "neutral" });
    expect(buildArchiveModel({ enabled: true, phase: "unavailable", code: "gbrain_missing" })).toMatchObject({ label: "Not set up", tone: "neutral" });
    expect(buildArchiveModel({ enabled: true, phase: "unavailable", code: "source_federated" })).toMatchObject({ label: "Not saving", tone: "danger" });
    const model = buildArchiveModel({
      enabled: true,
      phase: "ready",
      counts: { idle: 3, due: 1, backoff: 1, parked: 1, pages: 4, pendingWrites: 1, commitsQueued: 0 },
      parked: [{ code: "masked_refused", count: 1 }],
      lastSavedAt: "2026-11-07T00:00:00Z",
    });
    expect(model).toMatchObject({ label: "Saving", pages: 4, waiting: 2, pendingWrites: 1, canRetry: true });
    expect(model.parked[0]).toMatchObject({ code: "masked_refused", tone: "danger" });
    for (const code of Object.keys(kArchiveCodeCopy)) expect(kArchiveCodeCopy[code].text).toBeTruthy();
  });

  it("names each peer past its archive budget and when it resumes", () => {
    const model = buildArchiveModel({
      enabled: true,
      phase: "ready",
      overBudget: [
        { peer: "capy-x", code: "peer_budget_daily", conversations: 2, resumesAt: "2026-11-08T00:00:00.000Z" },
        { peer: "capy-y", code: "peer_budget_total", conversations: 1, resumesAt: null },
      ],
      budget: { peerDailyBytes: 8 * 1024 * 1024, peerTotalBytes: 512 * 1024 * 1024 },
    });
    expect(model.overBudget.map((row) => row.text)).toEqual([
      "@capy-x reached today's budget (8 MB); 2 conversations resume after 00:00 UTC.",
      "@capy-y is past its total budget (512 MB); 1 conversation is not saved until the budget is raised and Retry is pressed.",
    ]);
    expect(buildArchiveModel({ enabled: true, phase: "ready" }).overBudget).toEqual([]);
  });
});
