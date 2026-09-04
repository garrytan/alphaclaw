// Conventions the live tiers must keep (AGENTS.md "test:live" note). They are
// pinned hermetically because the live tiers themselves only run on demand,
// and each rule here was learned from a real red run:
//   - the real OpenClaw CLIs print NOTHING (not even their --json reports)
//     when they inherit vitest's VITEST variable, so every spawn env must go
//     through scrubTestRunnerEnv() instead of spreading process.env
//     (2026-09-02: the dev-head build read as "updater output was not
//     parseable" for exactly this reason).
const fs = require("fs");
const path = require("path");

const kLiveDir = path.resolve(__dirname, "../live");
const kRawEnvPattern = /\.\.\.\s*process\.env\b|\benv\s*:\s*process\.env\b|\benv\s*=\s*process\.env\b/;

const liveFiles = () =>
  fs
    .readdirSync(kLiveDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(kLiveDir, name));

describe("live-tier conventions", () => {
  it("has live files to check", () => {
    expect(liveFiles().length).toBeGreaterThan(5);
  });

  it("never spreads or passes a raw process.env into a spawn env — scrubTestRunnerEnv() only", () => {
    const offenders = [];
    for (const file of liveFiles()) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.trim().startsWith("//")) return;
        if (kRawEnvPattern.test(line)) {
          offenders.push(`${path.relative(kLiveDir, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("scrubTestRunnerEnv drops every VITEST* key and NODE_OPTIONS, keeps the rest", () => {
    const { scrubTestRunnerEnv } = require("../live/live-helpers");
    const scrubbed = scrubTestRunnerEnv({
      VITEST: "true",
      VITEST_POOL_ID: "1",
      VITEST_WORKER_ID: "2",
      NODE_OPTIONS: "--import x",
      PATH: "/bin",
      OPENCLAW_HOME: "/tmp/h",
    });
    expect(scrubbed).toEqual({ PATH: "/bin", OPENCLAW_HOME: "/tmp/h" });
  });
});
