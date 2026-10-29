// Fixture tests for scripts/ci/balance-live-shards.mjs, the generator of
// tests/live/shards.json.
const kScript = "../../scripts/ci/balance-live-shards.mjs";

describe("ci/live shard balancer", () => {
  it("puts the longest file first on the lightest leg and every browser file on the last leg", async () => {
    const { balance } = await import(kScript);
    const files = ["a", "b", "c", "d", "ui1", "ui2"];
    const seconds = { a: 680, b: 340, c: 300, d: 40, ui1: 200, ui2: 100 };
    const legs = balance(files, seconds, { legs: 3, browser: (file) => file.startsWith("ui") });
    expect(legs).toEqual({
      leg1: { browser: false, budgetSeconds: 680, files: ["a"] },
      leg2: { browser: false, budgetSeconds: 380, files: ["b", "d"] },
      leg3: { browser: true, budgetSeconds: 600, files: ["c", "ui1", "ui2"] },
    });
  });

  it("counts a file with no measured time as 120 s and never leaves a file out", async () => {
    const { balance } = await import(kScript);
    const legs = balance(["new", "old"], { old: 10 }, { legs: 2 });
    expect(Object.values(legs).flatMap((leg) => leg.files).sort()).toEqual(["new", "old"]);
    expect(Object.values(legs).map((leg) => leg.budgetSeconds).sort((x, y) => x - y)).toEqual([10, 120]);
    expect(Object.values(legs).some((leg) => leg.browser)).toBe(false);
  });

  it("sizes a leg's limit to the larger of budget x 2.5 and its longest test timeout plus the reserve", async () => {
    const { legTimeoutMinutes } = await import(kScript);
    expect(legTimeoutMinutes({ budgetSeconds: 1200, maxTestTimeoutSeconds: 720 })).toBe(50);
    expect(legTimeoutMinutes({ budgetSeconds: 600, maxTestTimeoutSeconds: 3900 })).toBe(75);
    expect(legTimeoutMinutes({ budgetSeconds: 0, maxTestTimeoutSeconds: 0 })).toBe(10);
  });

  it("reads per-file times from vitest JSON reports, the last report winning", async () => {
    const { measuredSeconds } = await import(kScript);
    const report = (ms) => ({ testResults: [{ name: "/runner/work/x/tests/live/a.e2e.test.js", startTime: 1000, endTime: 1000 + ms }] });
    expect(measuredSeconds([report(4_400), report(61_600)])).toEqual({ "tests/live/a.e2e.test.js": 62 });
  });

  it("detects browser files directly and through control-ui-live.js", async () => {
    const { isBrowserFile, liveTestFiles } = await import(kScript);
    const browser = liveTestFiles().filter(isBrowserFile);
    expect(browser).toContain("tests/live/control-ui-styles.e2e.test.js");
    expect(browser).toContain("tests/live/control-ui-direct-open.e2e.test.js");
    expect(browser).not.toContain("tests/live/restart-exec-turn.e2e.test.js");
  });
});
