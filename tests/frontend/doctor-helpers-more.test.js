import { describe, expect, it } from "vitest";
import {
  buildDoctorRunMarkers,
  buildDoctorStatusFilterOptions,
  formatDoctorCategory,
  formatDoctorCharCount,
  getDoctorAutoRunStatusLine,
  getDoctorBootstrapWarningTitle,
  getDoctorCategoryTone,
  getDoctorChangeLabel,
  getDoctorPriorityTone,
  getDoctorRunDisabledReason,
  getDoctorRunPillDetail,
  getDoctorStatusTone,
  getDoctorWarningMessage,
  shouldShowDoctorWarning,
} from "../../lib/public/js/components/doctor/helpers.js";

const bootstrapStatus = ({ truncated = [], nearLimit = [] } = {}) => ({
  bootstrapContext: {
    activeTruncatedFiles: truncated,
    activeNearLimitFiles: nearLimit,
  },
});

describe("frontend/doctor helpers (extended)", () => {
  it("maps priorities to tones", () => {
    expect(getDoctorPriorityTone("P0")).toBe("danger");
    expect(getDoctorPriorityTone(" p1 ")).toBe("warning");
    expect(getDoctorPriorityTone("P2")).toBe("neutral");
    expect(getDoctorPriorityTone()).toBe("neutral");
  });

  it("maps statuses to tones", () => {
    expect(getDoctorStatusTone("Fixed")).toBe("success");
    expect(getDoctorStatusTone("working")).toBe("info");
    expect(getDoctorStatusTone("dismissed")).toBe("neutral");
    expect(getDoctorStatusTone("open")).toBe("warning");
    expect(getDoctorStatusTone()).toBe("warning");
  });

  it("maps categories to tones with a default", () => {
    expect(getDoctorCategoryTone("mixed-concerns")).toBe("cyan");
    expect(getDoctorCategoryTone("something else")).toBe("info");
    expect(getDoctorCategoryTone()).toBe("info");
  });

  it("formats empty categories as Workspace", () => {
    expect(formatDoctorCategory("")).toBe("Workspace");
    expect(formatDoctorCategory(null)).toBe("Workspace");
  });

  it("suppresses the warning for missing or in-progress statuses", () => {
    expect(shouldShowDoctorWarning(null)).toBe(false);
    expect(
      shouldShowDoctorWarning({
        runInProgress: true,
        needsInitialRun: false,
        stale: true,
        changeSummary: { hasMeaningfulChanges: true },
      }),
    ).toBe(false);
  });

  it("builds warning messages for all change states", () => {
    expect(getDoctorWarningMessage(null)).toBe("");
    expect(
      getDoctorWarningMessage({ changeSummary: { changedFilesCount: 0 } }),
    ).toBe("Doctor has not been run in the last week.");
    expect(getDoctorWarningMessage({})).toBe(
      "Doctor has not been run in the last week.",
    );
    expect(
      getDoctorWarningMessage({ changeSummary: { changedFilesCount: 1 } }),
    ).toBe(
      "Drift Doctor has not been run in the last week and 1 file changed since the last review.",
    );
  });

  it("formats char counts", () => {
    expect(formatDoctorCharCount(1234)).toBe("1,234 chars");
    expect(formatDoctorCharCount()).toBe("0 chars");
  });

  it("builds bootstrap warning titles for each combination", () => {
    expect(getDoctorBootstrapWarningTitle(null)).toBe("");
    expect(getDoctorBootstrapWarningTitle(bootstrapStatus())).toBe("");

    const truncatedFile = { path: "notes.md", rawChars: 10, injectedChars: 4 };
    const nearLimitFile = { path: "todo.md", rawChars: 9 };
    const managedFile = { path: "hooks/bootstrap/managed.md", rawChars: 9 };

    expect(
      getDoctorBootstrapWarningTitle(
        bootstrapStatus({
          truncated: [truncatedFile, managedFile],
          nearLimit: [nearLimitFile, managedFile],
        }),
      ),
    ).toBe("Some of your main files are being truncated or nearing the limit:");
    expect(
      getDoctorBootstrapWarningTitle(
        bootstrapStatus({ nearLimit: [nearLimitFile] }),
      ),
    ).toBe("One of your main files is nearing the limit:");
    expect(
      getDoctorBootstrapWarningTitle(
        bootstrapStatus({ nearLimit: [nearLimitFile, { path: "b.md" }] }),
      ),
    ).toBe("Some of your main files are nearing the limit:");
    expect(
      getDoctorBootstrapWarningTitle(
        bootstrapStatus({ truncated: [truncatedFile] }),
      ),
    ).toBe("One of your main files is being truncated:");
    expect(
      getDoctorBootstrapWarningTitle(
        bootstrapStatus({ truncated: [truncatedFile, { path: "b.md" }] }),
      ),
    ).toBe("Some of your main files are being truncated:");
  });

  it("labels change summaries with correct pluralization", () => {
    expect(getDoctorChangeLabel({ changedFilesCount: 1 })).toBe(
      "1 change since last run",
    );
    expect(getDoctorChangeLabel({ changedFilesCount: 2 })).toBe(
      "2 changes since last run",
    );
    expect(getDoctorChangeLabel(null)).toBe("No changes since last run");
  });

  it("describes run pills for every run shape", () => {
    expect(getDoctorRunPillDetail(null)).toBe("");
    expect(getDoctorRunPillDetail("not-an-object")).toBe("");
    expect(getDoctorRunPillDetail({ status: "running" })).toBe("Running");
    expect(getDoctorRunPillDetail({ status: "completed", cardCount: 1 })).toBe(
      "1 finding",
    );
    expect(getDoctorRunPillDetail({ status: "completed", cardCount: 3 })).toBe(
      "3 findings",
    );
  });

  it("builds run markers for failures and P2-only runs", () => {
    expect(buildDoctorRunMarkers(null)).toEqual([]);
    expect(buildDoctorRunMarkers({ status: "failed" })).toEqual([
      { tone: "neutral", count: 0, label: "Failed" },
    ]);
    expect(
      buildDoctorRunMarkers({
        status: "completed",
        cardCount: 2,
        priorityCounts: { P0: 0, P1: 0, P2: 2 },
      }),
    ).toEqual([{ tone: "neutral", count: 0, label: "P2" }]);
  });

  it("lists the status filter options", () => {
    expect(buildDoctorStatusFilterOptions().map((option) => option.value)).toEqual([
      "open",
      "working",
      "dismissed",
      "fixed",
    ]);
  });

  it("maps the new categories to tones", () => {
    expect(getDoctorCategoryTone("project context")).toBe("warning");
    expect(getDoctorCategoryTone("stale_guidance")).toBe("warning");
    expect(getDoctorCategoryTone("Contradiction")).toBe("danger");
    expect(getDoctorCategoryTone("memory-hygiene")).toBe("info");
    expect(getDoctorCategoryTone("skills")).toBe("cyan");
    expect(getDoctorCategoryTone("openclaw_doctor")).toBe("secondary");
    // Existing fallback stays intact.
    expect(getDoctorCategoryTone("unmapped category")).toBe("info");
  });

  it("explains why the Run button is disabled", () => {
    // Gateway readiness wins over every other condition.
    expect(
      getDoctorRunDisabledReason({
        runInProgress: true,
        gatewayReadiness: { ok: false, reason: "gateway is restarting" },
      }),
    ).toBe("Gateway not ready: gateway is restarting");
    expect(
      getDoctorRunDisabledReason({
        gatewayReadiness: { ok: false, reason: "" },
      }),
    ).toBe("Gateway not ready.");
    // Enabled states return an empty reason.
    expect(
      getDoctorRunDisabledReason({
        runInProgress: true,
        gatewayReadiness: { ok: true, reason: "" },
      }),
    ).toBe("");
    expect(getDoctorRunDisabledReason({ needsInitialRun: true })).toBe("");
    expect(
      getDoctorRunDisabledReason({
        changeSummary: { changedFilesCount: 2 },
      }),
    ).toBe("");
    // No changes (or no status yet) keeps the legacy disabled reason.
    expect(
      getDoctorRunDisabledReason({
        changeSummary: { changedFilesCount: 0 },
      }),
    ).toBe("No workspace changes since the last completed Drift Doctor run.");
    expect(getDoctorRunDisabledReason(null)).toBe(
      "No workspace changes since the last completed Drift Doctor run.",
    );
    // Old payloads without gatewayReadiness never treat the gateway as down.
    expect(getDoctorRunDisabledReason({ needsInitialRun: true, gatewayReadiness: undefined })).toBe("");
  });

  it("summarizes the scheduled-scan check line", () => {
    expect(getDoctorAutoRunStatusLine(null)).toBe("");
    expect(getDoctorAutoRunStatusLine({})).toBe("");
    expect(
      getDoctorAutoRunStatusLine({ lastCheckAt: "not-a-date" }),
    ).toBe("");
    const line = getDoctorAutoRunStatusLine({
      lastCheckAt: "2026-08-28T10:00:00.000Z",
      lastSkipReason: "not-stale",
    });
    expect(line.startsWith("Last check: ")).toBe(true);
    expect(line.endsWith("— workspace not stale yet")).toBe(true);
    const ranLine = getDoctorAutoRunStatusLine({
      lastCheckAt: "2026-08-28T10:00:00.000Z",
      lastSkipReason: "ran",
    });
    expect(ranLine.endsWith("— ran a scan")).toBe(true);
    // Unknown reasons pass through verbatim; empty reasons drop the suffix.
    expect(
      getDoctorAutoRunStatusLine({
        lastCheckAt: "2026-08-28T10:00:00.000Z",
        lastSkipReason: "mystery",
      }).endsWith("— mystery"),
    ).toBe(true);
    expect(
      getDoctorAutoRunStatusLine({
        lastCheckAt: "2026-08-28T10:00:00.000Z",
        lastSkipReason: "",
      }).includes("—"),
    ).toBe(false);
  });
});
