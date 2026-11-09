import { describe, expect, it } from "vitest";
import { buildResourceCapModel } from "../../lib/public/js/components/telegram-workspace/resource-cap-model.js";

describe("frontend/telegram-workspace resource cap model", () => {
  it("prefers the config read-back, then the server-computed values", () => {
    expect(
      buildResourceCapModel({
        topicCount: 2,
        configAgentMaxConcurrent: 40,
        configSubagentMaxConcurrent: undefined,
        concurrency: { computedMaxConcurrent: 24, computedSubagentMaxConcurrent: 22 },
      }),
    ).toMatchObject({ maxConcurrent: 40, subagentMaxConcurrent: 22 });
  });

  it("claims the machine-size cap only when the server derived it from the machine", () => {
    const concurrency = { computedMaxConcurrent: 24, computedSubagentMaxConcurrent: 22, resourceCap: 32 };
    expect(buildResourceCapModel({ topicCount: 1, concurrency: { ...concurrency, resourceCapSource: "machine" } }))
      .toMatchObject({ resourceCap: 32, resourceCapFromMachine: true });
    expect(buildResourceCapModel({ topicCount: 1, concurrency: { ...concurrency, resourceCapSource: "legacy" } }))
      .toMatchObject({ resourceCap: 32, resourceCapFromMachine: false });
    expect(buildResourceCapModel({ topicCount: 1, concurrency }).resourceCapFromMachine).toBe(false);
  });

  it("falls back to the local formula for a cached workspace saved without computed values", () => {
    // Finishing onboarding caches { agentMaxConcurrent: null, subagentMaxConcurrent: null }.
    expect(
      buildResourceCapModel({
        topicCount: 4,
        configAgentMaxConcurrent: null,
        configSubagentMaxConcurrent: null,
        concurrency: { agentMaxConcurrent: null, subagentMaxConcurrent: null },
      }),
    ).toEqual({ maxConcurrent: 12, subagentMaxConcurrent: 10, resourceCap: null, resourceCapFromMachine: false });
  });
});
