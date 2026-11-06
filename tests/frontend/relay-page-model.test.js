import { describe, expect, it } from "vitest";
import { buildRelayPageModel, kRelayPhaseCopy } from "../../lib/public/js/components/relay-tab/model.js";

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
});
