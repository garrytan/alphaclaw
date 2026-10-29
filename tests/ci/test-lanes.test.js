const { readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

// Every test-shaped file under tests/ is run by exactly one CI lane, and each
// file of a sharded tier sits in exactly one leg. A file no lane runs is a
// coverage loss nobody sees; the allowlist names the files that are run by
// hand on purpose.
const kTestsDir = path.join(__dirname, "..");
const kTestShaped = /\.(test|e2e)\.[cm]?js$|-smoke\.(mjs|sh)$/;
// tests/browser/*-smoke.* run by hand (npm run test:ui:*), tracked as GST-57.
const kManualOnly = [/^tests\/browser\//];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "artifacts" || name === "fixtures") return [];
    return statSync(full).isDirectory() ? walk(full) : [path.relative(path.join(kTestsDir, ".."), full).split(path.sep).join("/")];
  });

const lanesOf = (file) => {
  const lanes = [];
  const vitestFile = /\.test\.js$/.test(file);
  if (vitestFile && !file.startsWith("tests/live/") && !file.startsWith("tests/container/")) lanes.push("hermetic (ci.yml npm test)");
  if (vitestFile && file.startsWith("tests/live/")) lanes.push("live (live-e2e.yml)");
  if (vitestFile && file.startsWith("tests/container/")) lanes.push("container (container-e2e.yml)");
  if (kManualOnly.some((pattern) => pattern.test(file))) lanes.push("manual");
  return lanes;
};

describe("ci/test lanes", () => {
  const files = walk(kTestsDir).filter((file) => kTestShaped.test(file));

  it("finds the suite", () => {
    expect(files.length).toBeGreaterThan(600);
  });

  it("runs every test-shaped file in exactly one lane", () => {
    const misplaced = files
      .map((file) => ({ file, lanes: lanesOf(file) }))
      .filter(({ lanes }) => lanes.length !== 1);
    expect(misplaced).toEqual([]);
  });

  it("keeps the hermetic include and the opt-in tiers the lanes above assume", () => {
    const config = readFileSync(path.join(kTestsDir, "..", "vitest.config.js"), "utf8");
    expect(config).toContain('include: ["tests/**/*.test.js"]');
    expect(config).toMatch(/kLiveE2eEnabled \? \[\] : \["tests\/live\/\*\*"\]/);
    expect(config).toMatch(/kContainerE2eEnabled \? \[\] : \["tests\/container\/\*\*"\]/);
  });
});
