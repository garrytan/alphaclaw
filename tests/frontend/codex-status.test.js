import { describe, expect, it } from "vitest";
import { buildCodexStatusErrorModel } from "../../lib/public/js/lib/codex-status.js";

describe("frontend/codex-status error model", () => {
  it("claims 'last known' only when a checked prior status exists", () => {
    const model = buildCodexStatusErrorModel(
      { connected: true },
      "status endpoint down",
    );
    expect(model.headline).toBe(
      "Status check failed — showing the last known Codex status",
    );
    expect(model.error).toBe("status endpoint down");
  });

  it("says the status is unknown when the FIRST check fails (no prior data)", () => {
    const model = buildCodexStatusErrorModel(null, "boom");
    expect(model.headline).toBe("Status check failed — Codex status unknown");
    expect(model.error).toBe("boom");
  });

  it("a genuinely-checked disconnected status still counts as last-known", () => {
    expect(
      buildCodexStatusErrorModel({ connected: false }, "boom").headline,
    ).toContain("showing the last known");
  });

  it("normalizes a missing or non-string message to an empty string", () => {
    expect(buildCodexStatusErrorModel(null, undefined).error).toBe("");
    expect(buildCodexStatusErrorModel({ connected: true }, true).error).toBe(
      "",
    );
  });
});
