import { describe, expect, it, vi } from "vitest";

// buildMedicAiLine is a pure view-model, but the module also imports the
// api + toast layers for the card component — mock those out so the test
// stays hermetic (same approach as upgrade-overseer-card.test.js).
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchOpenclawMedic: vi.fn(),
  updateOpenclawMedic: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import { buildMedicAiLine } from "../../lib/public/js/components/upgrade-tab/medic-card.js";

describe("frontend/upgrade medic card view-model", () => {
  it("returns null when there is no availability payload", () => {
    expect(buildMedicAiLine(null)).toBe(null);
    expect(buildMedicAiLine(undefined)).toBe(null);
  });

  it("renders the available line with the chosen provider/model", () => {
    expect(
      buildMedicAiLine({
        available: true,
        provider: "anthropic",
        model: "claude-fable-5",
      }),
    ).toEqual({
      tone: "ok",
      text: "AI escalation available (anthropic/claude-fable-5)",
    });
  });

  it("warns with the server message when unavailable", () => {
    expect(
      buildMedicAiLine({ available: false, message: "custom reason" }),
    ).toEqual({ tone: "warning", text: "custom reason" });
  });

  it("falls back to the no-key default and names the deterministic tiers", () => {
    const line = buildMedicAiLine({ available: false });
    expect(line.tone).toBe("warning");
    expect(line.text).toMatch(/no frontier-model API key/);
    expect(line.text).toMatch(/Deterministic repairs still run/);
  });
});
