const fs = require("fs");
const os = require("os");
const path = require("path");

// The numeric machine summary rides TRUSTED prompt tiers (gateway medic,
// upgrade overseer). The memory-trend contribution must stay number+enum
// only, appear only when a source is registered and returns a valid trend,
// and be resettable so tests can't contaminate each other.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "machine-summary-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  getMachineSummaryForPrompt,
  registerGatewayMemoryTrendSource,
  resetGatewayMemoryTrendSourceForTests,
} = require("../../lib/server/machine-summary");

describe("server/machine-summary gateway memory trend", () => {
  afterEach(() => {
    resetGatewayMemoryTrendSourceForTests();
  });

  it("omits trend fields entirely when no source is registered", () => {
    const summary = getMachineSummaryForPrompt();
    expect(summary).not.toHaveProperty("gatewayMemoryTrendState");
    expect(summary).not.toHaveProperty("gatewayRssTrendMbPerHour");
    // The pre-existing numeric contract is untouched.
    expect(summary).toHaveProperty("memoryMb");
    expect(summary).toHaveProperty("tier");
  });

  it("forwards state enum + numeric slope when registered", () => {
    registerGatewayMemoryTrendSource(() => ({
      state: "leak_suspected",
      slopeMbPerHour: 65.2,
      rssMb: 812,
    }));
    const summary = getMachineSummaryForPrompt();
    expect(summary.gatewayMemoryTrendState).toBe("leak_suspected");
    expect(summary.gatewayRssTrendMbPerHour).toBe(65.2);
  });

  it("drops fields on a null trend, an unknown state, or a non-finite slope", () => {
    registerGatewayMemoryTrendSource(() => null);
    expect(getMachineSummaryForPrompt()).not.toHaveProperty(
      "gatewayMemoryTrendState",
    );

    registerGatewayMemoryTrendSource(() => ({
      state: "TOTALLY MADE UP",
      slopeMbPerHour: 10,
    }));
    expect(getMachineSummaryForPrompt()).not.toHaveProperty(
      "gatewayMemoryTrendState",
    );

    registerGatewayMemoryTrendSource(() => ({
      state: "normal",
      slopeMbPerHour: Number.NaN,
    }));
    const summary = getMachineSummaryForPrompt();
    expect(summary.gatewayMemoryTrendState).toBe("normal");
    expect(summary).not.toHaveProperty("gatewayRssTrendMbPerHour");
  });

  it("a throwing source degrades to absent fields, never a failed summary", () => {
    registerGatewayMemoryTrendSource(() => {
      throw new Error("boom");
    });
    const summary = getMachineSummaryForPrompt();
    expect(summary).not.toHaveProperty("gatewayMemoryTrendState");
    expect(summary).toHaveProperty("memoryMb");
  });

  it("shape stays number+enum only — no strings besides the closed enums", () => {
    registerGatewayMemoryTrendSource(() => ({
      state: "critical",
      slopeMbPerHour: 120,
      episodeId: "should-not-appear",
      freeText: "should-not-appear",
    }));
    const summary = getMachineSummaryForPrompt();
    for (const [key, value] of Object.entries(summary)) {
      if (value === null || typeof value === "number") continue;
      expect(["tier", "gatewayMemoryTrendState"]).toContain(key);
    }
    expect(summary).not.toHaveProperty("episodeId");
    expect(summary).not.toHaveProperty("freeText");
  });
});
