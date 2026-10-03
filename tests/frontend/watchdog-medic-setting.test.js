import { describe, expect, it, vi } from "vitest";

// buildMedicAiLine is a pure view-model; the module also imports the api +
// toast layers for the toggle row, so mock those to keep the test hermetic.
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchOpenclawMedic: vi.fn(),
  updateOpenclawMedic: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import {
  buildMedicAiLine,
  describeMedicSaveError,
} from "../../lib/public/js/components/watchdog-tab/settings/medic-setting.js";

describe("frontend/watchdog startup medic setting", () => {
  it("returns null when there is no availability payload", () => {
    expect(buildMedicAiLine(null)).toBe(null);
    expect(buildMedicAiLine(undefined)).toBe(null);
  });

  it("renders the available line with the chosen provider/model", () => {
    expect(
      buildMedicAiLine({ available: true, provider: "anthropic", model: "claude-fable-5" }),
    ).toEqual({ tone: "ok", text: "AI escalation available (anthropic/claude-fable-5)" });
  });

  it("warns with the server message when unavailable", () => {
    expect(buildMedicAiLine({ available: false, message: "custom reason" })).toEqual({
      tone: "warning",
      text: "custom reason",
    });
  });

  it("falls back to the no-key default and names the deterministic tiers", () => {
    const line = buildMedicAiLine({ available: false });
    expect(line.tone).toBe("warning");
    expect(line.text).toMatch(/no frontier-model API key/);
    expect(line.text).toMatch(/Deterministic repairs still run/);
  });

  it("names the state that survived a reverted save", () => {
    expect(describeMedicSaveError(true)).toContain("still disabled");
    expect(describeMedicSaveError(false)).toContain("still enabled");
  });
});
