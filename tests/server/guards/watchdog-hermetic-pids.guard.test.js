// Guard: the watchdog unit harnesses never fall back to real process
// liveness. They hand the watchdog fake pids (100, 4242, …); left to the
// production defaults (lock-contention pidAlive / readProcStartTicks and
// resolveProcessVerdict), a real process that happens to own one of those
// pids on the CI runner makes a fake gateway look alive and flips the test.
// Each harness must inject all three unconditionally, never only when the
// test passes its own.
const fs = require("fs");
const path = require("path");

const kRepoRoot = path.resolve(__dirname, "../../..");
const kHarnessFiles = [
  "tests/server/watchdog.test.js",
  "tests/server/watchdog-crash-recovery.test.js",
  "tests/server/watchdog-restart-failure.test.js",
];
const kLivenessSeams = ["pidAlive", "readProcStartTicks", "resolvePidVerdict"];

const scanHarness = (source) => {
  const problems = [];
  for (const seam of kLivenessSeams) {
    if (new RegExp(`\\.\\.\\.\\(\\s*${seam}\\s*\\?`).test(source)) {
      problems.push(`${seam} is injected only when a test passes it`);
    }
    if (!new RegExp(`^\\s*${seam}(\\s*:[^\\n]*)?,\\s*$`, "m").test(source)) {
      problems.push(`${seam} is never injected into createWatchdog`);
    }
  }
  return problems;
};

describe("guard: watchdog harnesses use a hermetic process table", () => {
  it("flags a conditional or missing liveness seam (self-test)", () => {
    const conditional = [
      "createWatchdog({",
      "  ...(pidAlive ? { pidAlive } : {}),",
      "  readProcStartTicks,",
      '  resolvePidVerdict: () => "gone",',
      "});",
    ].join("\n");
    expect(scanHarness(conditional)).toEqual([
      "pidAlive is injected only when a test passes it",
      "pidAlive is never injected into createWatchdog",
    ]);
  });

  it.each(kHarnessFiles)("%s injects pidAlive, readProcStartTicks and resolvePidVerdict", (file) => {
    const source = fs.readFileSync(path.join(kRepoRoot, file), "utf8");
    expect(scanHarness(source)).toEqual([]);
  });
});
