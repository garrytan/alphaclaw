const {
  normalizeThinkingLevel,
  resolveThinkingOptionsForModel,
} = require("../../lib/server/openclaw-thinking");

describe("server/openclaw-thinking", () => {
  it("normalizes modern thinking levels without private OpenClaw exports", () => {
    expect(normalizeThinkingLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkingLevel("max")).toBe("max");
    expect(normalizeThinkingLevel("ultra")).toBe("ultra");
    expect(normalizeThinkingLevel("unknown")).toBeNull();
  });

  // Since OpenClaw 2026.9.7 (#155393) Ultra is a harness mode, independent of
  // the model's native reasoning controls: the codex runtime offers it for any
  // model with a native effort, and upstream lowers it to the model's highest
  // effort at the provider boundary. Luna (native efforts low → max) gains it.
  it("passes through upstream's harness Ultra for Codex Sol, Terra and Luna", async () => {
    const optionsByModel = {};
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      optionsByModel[model] = await resolveThinkingOptionsForModel({
        modelKey: `openai/${model}`,
        agentRuntime: "codex",
      });
    }

    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(optionsByModel[model].levels.map((entry) => entry.id), model).toContain("ultra");
    }
    expect(optionsByModel["gpt-5.6-luna"].levels.map((entry) => entry.id)).toContain(
      "max",
    );
  });
});
