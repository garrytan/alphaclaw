const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { deriveCostBreakdown } = require("../../lib/server/cost-utils");

const costUtilsPath = require.resolve("../../lib/server/cost-utils");
const originalResolveFilename = Module._resolveFilename;

describe("server/cost-utils", () => {
  it("prices Claude Opus 4.7 including prompt cache tokens", () => {
    const breakdown = deriveCostBreakdown({
      provider: "anthropic",
      model: "anthropic/claude-opus-4-7",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 20_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.inputCost).toBeCloseTo(0.5, 8);
    expect(breakdown.outputCost).toBeCloseTo(0.25, 8);
    expect(breakdown.cacheReadCost).toBeCloseTo(0.4, 8);
    expect(breakdown.cacheWriteCost).toBeCloseTo(0.125, 8);
    expect(breakdown.totalCost).toBeCloseTo(1.275, 8);
  });

  it("matches Claude Opus 4.7 dot-form model IDs", () => {
    const breakdown = deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-opus-4.7",
      inputTokens: 1_000_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.totalCost).toBeCloseTo(5, 8);
  });

  it("prices each GPT-5.6 tier", () => {
    const expected = {
      "gpt-5.6-sol": 35,
      "gpt-5.6-terra": 17.5,
      "gpt-5.6-luna": 7,
    };
    for (const [model, total] of Object.entries(expected)) {
      const breakdown = deriveCostBreakdown({
        provider: "openai",
        model,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(breakdown.pricingFound).toBe(true);
      expect(breakdown.totalCost).toBeCloseTo(total, 8);
    }
  });
});

describe("server/cost-utils openclaw dist pricing scraper", () => {
  let tmpRoot = null;

  const patchOpenclawResolution = (entryPath) => {
    Module._resolveFilename = function (request, ...rest) {
      if (request === "openclaw") {
        if (!entryPath) {
          const error = new Error("Cannot find module 'openclaw'");
          error.code = "MODULE_NOT_FOUND";
          throw error;
        }
        return entryPath;
      }
      return originalResolveFilename.call(this, request, ...rest);
    };
  };

  const loadFreshCostUtils = () => {
    delete require.cache[costUtilsPath];
    return require(costUtilsPath);
  };

  afterEach(() => {
    Module._resolveFilename = originalResolveFilename;
    delete require.cache[costUtilsPath];
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it("scrapes pricing entries and default-model constants from dist files", () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cost-utils-"));
    const distDir = path.join(tmpRoot, "dist");
    fs.mkdirSync(distDir);
    fs.writeFileSync(
      path.join(distDir, "model-selection.js"),
      [
        'var a={id:"anthropic/claude-opus-4.7",cost:{input:11,output:22,cacheRead:1.1,cacheWrite:2.2}};',
        'var b={id:"anthropic/claude-sonnet-4-5",cost:{input:3,output:15}};',
        'var c={id:"broken/no-usable-cost",cost:{foo:1}};',
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(distDir, "config.js"),
      [
        'const FOO_DEFAULT_MODEL_ID = "openai/gpt-fake-default";',
        "const FOO_DEFAULT_COST = {input:2.5,output:10,cacheRead:0.25,cacheWrite:3.125};",
        "const BAR_DEFAULT_MODEL_REF = `qwen/qwen-fake`;",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(distDir, "unrelated.js"),
      'var d={id:"skipped/model",cost:{input:1,output:2}};',
    );
    fs.writeFileSync(path.join(distDir, "notes.txt"), "not javascript");
    // A directory with a matching name forces the readFileSync failure branch.
    fs.mkdirSync(path.join(distDir, "configure.js"));

    patchOpenclawResolution(path.join(distDir, "index.js"));
    const costUtils = loadFreshCostUtils();
    const pricingMap = costUtils.loadOpenclawNodeModulesPricingMap();

    const opusPricing = {
      input: 11,
      output: 22,
      cacheRead: 1.1,
      cacheWrite: 2.2,
    };
    expect(pricingMap.get("anthropic/claude-opus-4.7")).toEqual(opusPricing);
    expect(pricingMap.get("anthropic/claude-opus-4-7")).toEqual(opusPricing);
    expect(pricingMap.get("claude-opus-4.7")).toEqual(opusPricing);
    expect(pricingMap.get("claude-opus-4-7")).toEqual(opusPricing);

    const sonnetPricing = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 };
    expect(pricingMap.get("anthropic/claude-sonnet-4-5")).toEqual(sonnetPricing);
    expect(pricingMap.get("anthropic/claude-sonnet-4.5")).toEqual(sonnetPricing);
    expect(pricingMap.get("claude-sonnet-4-5")).toEqual(sonnetPricing);
    expect(pricingMap.get("claude-sonnet-4.5")).toEqual(sonnetPricing);

    expect(pricingMap.get("openai/gpt-fake-default")).toEqual({
      input: 2.5,
      output: 10,
      cacheRead: 0.25,
      cacheWrite: 3.125,
    });
    expect(pricingMap.get("gpt-fake-default")).toBeTruthy();

    expect(pricingMap.has("broken/no-usable-cost")).toBe(false);
    expect(pricingMap.has("qwen/qwen-fake")).toBe(false);
    expect(pricingMap.has("skipped/model")).toBe(false);

    // Second load within the TTL returns the cached map instance.
    expect(costUtils.loadOpenclawNodeModulesPricingMap()).toBe(pricingMap);

    const breakdown = costUtils.deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.totalCost).toBeCloseTo(11 + 22 + 1.1 + 2.2, 8);

    expect(
      costUtils.resolvePricingFromOpenclawNodeModules({
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toEqual(sonnetPricing);
    expect(costUtils.resolvePricingFromOpenclawNodeModules({ model: "" })).toBe(
      null,
    );
    expect(
      costUtils.resolvePricingFromOpenclawNodeModules({
        provider: "x",
        model: "unknown-model-zzz",
      }),
    ).toBe(null);
  });

  it("falls back to the static pricing map when openclaw is not installed", () => {
    patchOpenclawResolution(null);
    const costUtils = loadFreshCostUtils();

    const longContext = costUtils.deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 300_000,
      outputTokens: 250_000,
    });
    expect(longContext.pricingFound).toBe(true);
    expect(longContext.inputCost).toBeCloseTo(3, 8);
    expect(longContext.outputCost).toBeCloseTo(9.375, 8);

    const shortContext = costUtils.deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 100_000,
      outputTokens: 100_000,
    });
    expect(shortContext.inputCost).toBeCloseTo(0.5, 8);
    expect(shortContext.outputCost).toBeCloseTo(2.5, 8);

    const substringMatch = costUtils.deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-haiku-4-6-20260101",
      inputTokens: 1_000_000,
    });
    expect(substringMatch.pricingFound).toBe(true);
    expect(substringMatch.inputCost).toBeCloseTo(0.8, 8);

    // PR #86: prefix shadowing is dead — the most specific key wins, and
    // provider-qualified ids resolve their trailing component exactly.
    const gpt55 = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "openai/gpt-5.5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(gpt55.totalCost).toBeCloseTo(35.0, 8); // gpt-5 shadow gave 11.25

    const gpt54mini = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "openai/gpt-5.4-mini",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(gpt54mini.totalCost).toBeCloseTo(5.25, 8);

    // Fork-only regression: gpt-4o used to shadow gpt-4o-mini for
    // provider-qualified ids (12.5 instead of 0.75 per 1M+1M).
    const gpt4oMini = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "openai/gpt-4o-mini",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(gpt4oMini.totalCost).toBeCloseTo(0.75, 8);

    // All eight PR #86 additions resolve to their own entries.
    const kExpectedPerMillionTotals = {
      "gpt-5.5": 35.0,
      "gpt-5.4-mini": 5.25,
      "kimi-k2.6:cloud": 3.8,
      "deepseek-v4-flash:cloud": 0.42,
      "glm-5.1:cloud": 5.8,
      "grok-4.3": 3.75,
      "qwen3-coder-next": 0.91,
      "minimax-m3:cloud": 3.0,
    };
    for (const [modelId, expectedTotal] of Object.entries(
      kExpectedPerMillionTotals,
    )) {
      const breakdown = costUtils.deriveCostBreakdown({
        provider: "",
        model: modelId,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(breakdown.pricingFound, modelId).toBe(true);
      expect(breakdown.totalCost, modelId).toBeCloseTo(expectedTotal, 8);
    }

    // Boundary rule: alphanumeric-adjacent lookalikes never family-match.
    const falsePositive = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "gpt-5x",
      inputTokens: 1_000_000,
    });
    expect(falsePositive.pricingFound).toBe(false);
    const digitRun = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "gpt-55",
      inputTokens: 1_000_000,
    });
    expect(digitRun.pricingFound).toBe(false);

    // Family fallback still works across namespace styles (boundary match on
    // the full id, most specific key first).
    const bedrockStyle = costUtils.deriveCostBreakdown({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-8-v1:0",
      inputTokens: 1_000_000,
    });
    expect(bedrockStyle.pricingFound).toBe(true);
    const datedCodex = costUtils.deriveCostBreakdown({
      provider: "openai",
      model: "gpt-5.1-codex-20260101",
      inputTokens: 1_000_000,
    });
    expect(datedCodex.inputCost).toBeCloseTo(2.5, 8);

    const unknown = costUtils.deriveCostBreakdown({
      provider: "x",
      model: "totally-unknown-model",
    });
    expect(unknown).toEqual({
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      pricingFound: false,
    });

    expect(costUtils.deriveCostBreakdown({}).pricingFound).toBe(false);
  });

  it("returns an empty pricing map when the dist dir cannot be read", () => {
    patchOpenclawResolution(
      path.join(os.tmpdir(), "alphaclaw-missing-dist", "index.js"),
    );
    const costUtils = loadFreshCostUtils();

    const pricingMap = costUtils.loadOpenclawNodeModulesPricingMap();

    expect(pricingMap.size).toBe(0);
  });

  it("bills cache-read tokens at 10% of the input rate when a static entry omits cacheRead (F083)", () => {
    patchOpenclawResolution(null);
    const costUtils = loadFreshCostUtils();
    // claude-haiku-4-6 is a static entry with input/output only.
    const breakdown = costUtils.deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-haiku-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.cacheReadCost).toBeGreaterThan(0);
    expect(breakdown.cacheReadCost).toBeCloseTo(0.8 * 0.1, 8);
    expect(breakdown.totalCost).toBeCloseTo(0.08, 8);
  });
});
