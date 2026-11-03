const { buildPromptFilesCards } = require("../../lib/server/doctor/prompt-files-cards");
const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");

describe("doctor prompt-files cards (ALPH-58)", () => {
  it("emits nothing without prompt-file state", () => {
    expect(buildPromptFilesCards(null)).toEqual([]);
    expect(buildPromptFilesCards({ referenceDisabled: false, rulesRestoredAt: null })).toEqual([]);
  });

  it("explains a reference opt-out as an info card in its own namespace, with no agent fix", () => {
    const [card] = buildPromptFilesCards({ referenceDisabled: true, referenceDetectedAt: Date.UTC(2026, 10, 2) });
    expect(card).toMatchObject({
      sourceKey: "det:prompt-files:reference-off",
      priority: "P2",
      category: "project context",
    });
    expect(card.summary).toContain("2026-11-02T00:00:00.000Z");
    expect(card.summary).toContain("alphaclaw telegram topics list");
    expect(card.recommendation).toContain("POST /api/doctor/prompt-files/reference");
    expect(card.fixPrompt).toBeUndefined();
  });

  it("says 'an earlier sync' when the flag carries no detection time, never the epoch", () => {
    const [card] = buildPromptFilesCards({ referenceDisabled: true, referenceDetectedAt: null });
    expect(card.summary).toContain("noticed an earlier sync");
    expect(card.summary).not.toContain("1970");
  });

  it("warns once per rules restore, so dismissing one never hides the next", () => {
    const [first] = buildPromptFilesCards({ rulesRestoredAt: 1000 });
    const [second] = buildPromptFilesCards({ rulesRestoredAt: 2000 });
    expect(first).toMatchObject({ sourceKey: "det:prompt-files:rules-restored:1000", priority: "P1" });
    expect(second.sourceKey).toBe("det:prompt-files:rules-restored:2000");
    expect(first.sourceKey.startsWith("det:hardening:")).toBe(false);
  });

  it("rides the deterministic card pass", () => {
    const cards = buildDeterministicCards({
      workspaceRoot: "/nonexistent-workspace",
      managedRoot: "/nonexistent-managed",
      profile: {},
      readLatestDoctorRun: () => null,
      promptFiles: { referenceDisabled: true, referenceDetectedAt: 1, rulesRestoredAt: 5 },
    });
    const keys = cards.map((card) => card.sourceKey).filter((key) => key.startsWith("det:prompt-files:"));
    expect(keys).toEqual(["det:prompt-files:reference-off", "det:prompt-files:rules-restored:5"]);
    expect(cards.find((card) => card.sourceKey === "det:prompt-files:reference-off")).toMatchObject({
      status: "open",
      source: expect.any(String),
    });
  });
});
