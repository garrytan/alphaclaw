import { describe, expect, it } from "vitest";
import {
  buildBusyLabel,
  buildDeletionNotice,
  buildExpectationLine,
  buildReceiptLine,
  buildRemovalLine,
  buildSnapshotLine,
  formatBytes,
  kRemovedOutcomes,
  resolveBlockedReason,
} from "../../lib/public/js/components/agents-tab/delete-agent-copy.js";

const preview = (overrides = {}) => ({
  agentId: "ops",
  state: "configured",
  refusal: null,
  gatewayServing: true,
  busy: false,
  counts: { bindings: 2, cronJobs: 1 },
  history: { hasDatabase: true, bytes: 200_000_000, approximate: false },
  workspace: { exists: true, bytes: 100_000_000, approximate: false, retainedBy: null },
  snapshot: { available: true, reason: null, fits: true, neededBytes: 1e9, availableBytes: 5e9 },
  ...overrides,
});

describe("Delete Agent dialog copy", () => {
  it("leads with what is removed: counts pluralized, zeros left out", () => {
    expect(buildRemovalLine({ bindings: 2, cronJobs: 1 })).toBe("Removes the agent, its 2 channel bindings and 1 cron job. Other agents keep running and the gateway doesn't restart.");
    expect(buildRemovalLine({ bindings: 1, cronJobs: 0 })).toBe("Removes the agent, its 1 channel binding. Other agents keep running and the gateway doesn't restart.");
    expect(buildRemovalLine({ bindings: 0, cronJobs: null })).toBe("Removes the agent. Other agents keep running and the gateway doesn't restart.");
  });

  it("says what the snapshot saves, in every coverage case", () => {
    expect(buildSnapshotLine({ preview: preview(), snapshotOn: true })).toBe(
      "Saves its chat history and workspace (300 MB) in a folder on this box first. Restoring is a manual step for now (README: Deleted agents' data). If the snapshot fails, nothing is deleted.",
    );
    expect(buildSnapshotLine({ preview: preview(), snapshotOn: false })).toBe("No snapshot. AlphaClaw keeps no copy of its chat history.");
    expect(buildSnapshotLine({ preview: preview({ workspace: { exists: true, bytes: 0, retainedBy: "main" } }), snapshotOn: true })).toMatch(
      /^Saves its chat history \(200 MB\) in a folder on this box first\. Its workspace stays where it is because main uses it\./,
    );
    expect(buildSnapshotLine({ preview: preview({ history: { hasDatabase: false, bytes: 0 } }), snapshotOn: true })).toMatch(/^Saves its workspace \(100 MB\).*It has no chat history yet\./);
    expect(buildSnapshotLine({ preview: preview({ history: { hasDatabase: false, bytes: 0 }, workspace: { exists: false, bytes: 0 } }), snapshotOn: true })).toBe(
      "Nothing to save yet: it has no chat history and no workspace files.",
    );
    expect(buildSnapshotLine({ preview: preview({ workspace: { exists: true, bytes: 3e9, approximate: true } }), snapshotOn: true })).toContain("(at least 3.2 GB)");
    expect(buildSnapshotLine({ preview: preview({ snapshot: { available: false, reason: "Its database isn't in the standard place." } }), snapshotOn: false })).toBe(
      "A snapshot isn't possible: Its database isn't in the standard place.",
    );
    expect(buildSnapshotLine({ preview: preview({ snapshot: { available: true, fits: false, neededBytes: 1.1e9, availableBytes: 4e8 } }), snapshotOn: true })).toBe(
      "Needs 1.1 GB free, 400 MB available. Turn off the snapshot to delete without one.",
    );
  });

  it("names why Delete is disabled, as visible text", () => {
    const ready = { loading: false, data: preview(), error: null };
    expect(resolveBlockedReason({ previewState: ready, snapshotOn: true })).toBeNull();
    expect(resolveBlockedReason({ previewState: { loading: true }, snapshotOn: true })).toBe("Checking the agent…");
    expect(resolveBlockedReason({ previewState: { loading: false, error: new Error("x") }, snapshotOn: true })).toMatch(/turn off the snapshot/);
    expect(resolveBlockedReason({ previewState: { loading: false, error: new Error("x") }, snapshotOn: false })).toBeNull();
    expect(resolveBlockedReason({ previewState: { ...ready, data: preview({ gatewayServing: false }) }, snapshotOn: false })).toBe("The gateway isn't running. Delete the agent once it's back.");
    expect(resolveBlockedReason({ previewState: { ...ready, data: preview({ refusal: "Default agent cannot be deleted" }) }, snapshotOn: false })).toBe("Default agent cannot be deleted");
    expect(resolveBlockedReason({ previewState: { ...ready, data: preview({ busy: true }) }, snapshotOn: false })).toMatch(/Another agent delete/);
    expect(resolveBlockedReason({ previewState: { ...ready, data: preview({ snapshot: { available: true, fits: false } }) }, snapshotOn: true })).toBe("Not enough disk for the snapshot.");
    expect(resolveBlockedReason({ previewState: { ...ready, data: preview({ snapshot: { available: false } }) }, snapshotOn: true })).toBe("Turn off the snapshot to delete this agent.");
  });

  it("one honest busy label, an expectation for big agents, receipts and notices", () => {
    expect(buildBusyLabel({ snapshotOn: true })).toBe("Saving snapshot and deleting…");
    expect(buildBusyLabel({ snapshotOn: false })).toBe("Deleting…");
    expect(buildExpectationLine({ preview: preview(), snapshotOn: true })).toBeNull();
    expect(buildExpectationLine({ preview: preview({ history: { bytes: 3e9 } }), snapshotOn: true })).toBe("This can take a few minutes for 3.1 GB.");
    expect(buildReceiptLine({ agentId: "ops", agentName: "Ops", outcome: "deleted", archive: { name: "2026-10-28-ops-abc123", bytes: 300_000_000 } })).toBe(
      "Deleted Ops. Snapshot saved (300 MB) as 2026-10-28-ops-abc123.",
    );
    expect(buildReceiptLine({ agentId: "ops", outcome: "deleted", archive: null })).toBe("Deleted ops. No snapshot was kept.");
    expect(buildDeletionNotice({ agentId: "ops", outcome: "cleanup_incomplete" })).toMatchObject({ action: "finish" });
    expect(buildDeletionNotice({ agentId: "ops", outcome: "unknown" })).toMatchObject({ action: "check", text: "Couldn't confirm whether ops was deleted." });
    expect(buildDeletionNotice({ agentId: "ops", outcome: "deleted" })).toBeNull();
    expect([...kRemovedOutcomes].sort()).toEqual(["cleanup_incomplete", "config_only", "deleted"]);
    expect(formatBytes(512)).toBe("1 KB");
  });
});
