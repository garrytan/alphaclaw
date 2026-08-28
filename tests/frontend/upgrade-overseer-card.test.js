import { describe, expect, it, vi } from "vitest";

// buildOverseerReportModel is a pure view-model, but the module also imports
// the api + toast layers for the card component — mock those out so the test
// stays hermetic (same approach as upgrade-tab.test.js).
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchOpenclawOverseer: vi.fn(),
  fetchOpenclawRuns: vi.fn(),
  updateOpenclawOverseer: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import { buildOverseerReportModel } from "../../lib/public/js/components/upgrade-tab/overseer-card.js";

describe("frontend/upgrade overseer report view-model", () => {
  it("returns null when there is no run or no overseer payload", () => {
    expect(buildOverseerReportModel(null)).toBe(null);
    expect(buildOverseerReportModel(undefined)).toBe(null);
    expect(buildOverseerReportModel({})).toBe(null);
    expect(buildOverseerReportModel({ overseer: null })).toBe(null);
  });

  it("reports a pending review while the overseer is still running", () => {
    const pending = buildOverseerReportModel({ overseer: { state: "pending" } });
    expect(pending.kind).toBe("pending");
    expect(pending.line).toContain("in progress");
    // A missing state is treated as pending too.
    expect(buildOverseerReportModel({ overseer: {} }).kind).toBe("pending");
  });

  it("uses the summary when unavailable/failed, with fallbacks when absent", () => {
    const unavailable = buildOverseerReportModel({
      overseer: { state: "unavailable", summary: "No claude CLI found" },
    });
    expect(unavailable).toEqual({
      kind: "unavailable",
      line: "No claude CLI found",
    });
    expect(
      buildOverseerReportModel({ overseer: { state: "unavailable" } }).line,
    ).toBe("Overseer was unavailable for this run.");

    const failed = buildOverseerReportModel({
      overseer: { state: "failed", summary: "Review crashed" },
    });
    expect(failed).toEqual({ kind: "failed", line: "Review crashed" });
    expect(
      buildOverseerReportModel({ overseer: { state: "failed" } }).line,
    ).toBe("The overseer review failed.");
  });

  it("maps each known verdict to a badge and falls back to unparseable", () => {
    const healthy = buildOverseerReportModel({
      overseer: { state: "done", verdict: "healthy" },
    });
    expect(healthy.kind).toBe("verdict");
    expect(healthy.verdict).toBe("healthy");
    expect(healthy.badge.tone).toBe("success");

    const suspect = buildOverseerReportModel({
      overseer: { state: "done", verdict: "suspect" },
    });
    expect(suspect.badge.tone).toBe("warning");

    const broken = buildOverseerReportModel({
      overseer: { state: "done", verdict: "broken" },
    });
    expect(broken.badge.tone).toBe("danger");

    // Unknown verdicts (and no verdict at all) collapse to unparseable.
    const unknown = buildOverseerReportModel({
      overseer: { state: "done", verdict: "banana" },
    });
    expect(unknown.badge.tone).toBe("neutral");
    // The raw verdict string is preserved on the model when present.
    expect(unknown.verdict).toBe("banana");

    const missing = buildOverseerReportModel({ overseer: { state: "done" } });
    expect(missing.badge.tone).toBe("neutral");
    expect(missing.verdict).toBe("unparseable");
    expect(missing.showActions).toBe(false);
  });

  it("hides the action buttons when the report is stale", () => {
    const stale = buildOverseerReportModel({
      overseer: { state: "stale", verdict: "healthy" },
    });
    expect(stale.kind).toBe("verdict");
    expect(stale.stale).toBe(true);
    expect(stale.showActions).toBe(false);
  });

  it("shows actions only for healthy/suspect/broken verdicts", () => {
    for (const verdict of ["healthy", "suspect", "broken"]) {
      const model = buildOverseerReportModel({
        overseer: { state: "done", verdict, appliesToCurrent: true },
      });
      expect(model.stale).toBe(false);
      expect(model.showActions).toBe(true);
      // Actions hide when the reviewed run is not the live build.
      const notLive = buildOverseerReportModel({
        overseer: { state: "done", verdict, appliesToCurrent: false },
      });
      expect(notLive.showActions).toBe(false);
    }
    const unparseable = buildOverseerReportModel({
      overseer: { state: "done", verdict: "unparseable" },
    });
    expect(unparseable.showActions).toBe(false);
  });

  it("passes summary and recommendation through with empty-string defaults", () => {
    const model = buildOverseerReportModel({
      overseer: {
        state: "done",
        verdict: "suspect",
        summary: "Gateway restarted twice",
        recommendation: "Watch the next run",
      },
    });
    expect(model.summary).toBe("Gateway restarted twice");
    expect(model.recommendation).toBe("Watch the next run");

    const bare = buildOverseerReportModel({
      overseer: { state: "done", verdict: "healthy" },
    });
    expect(bare.summary).toBe("");
    expect(bare.recommendation).toBe("");
  });
});
