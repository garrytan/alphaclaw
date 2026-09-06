const { readFileSync } = require("node:fs");
const path = require("node:path");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

// Docs-lint (fix wave PR 13): the README "Environment Variables" table is the
// operator's only inventory of knobs. Two drift classes the audit found:
// rows for knobs the code stopped reading, and knobs the code reads with no
// row. This pins the mechanical half of both; prose accuracy stays a review job.
const kRepoRoot = path.join(__dirname, "..", "..");
const readme = readFileSync(path.join(kRepoRoot, "README.md"), "utf8");

const envTableSection = () => {
  const start = readme.indexOf("## Environment Variables");
  expect(start).toBeGreaterThan(-1);
  const rest = readme.slice(start);
  const next = rest.indexOf("\n## ", 4);
  return next === -1 ? rest : rest.slice(0, next);
};

const documentedVars = () =>
  [...envTableSection().matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]);

// Every env var the server/launcher reads: `process.env.X`, a destructured
// `env.X`, or a string-keyed read through a helper (`readClampedEnvSeconds(
// "WATCHDOG_CHECK_INTERVAL")`, `process.env[key]` over a quoted list). The
// deployment-only registry itself is excluded — listing a name there is not
// reading it.
const readVars = () => {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    "grep",
    [
      "-rhoE",
      "process\\.env\\.[A-Z][A-Z0-9_]+|\\benv\\.[A-Z][A-Z0-9_]{3,}|\"[A-Z][A-Z0-9_]{3,}\"",
      "lib",
      "bin",
      "--include=*.js",
      "--include=*.mjs",
      "--exclude-dir=dist",
      "--exclude=deployment-only-env.js",
    ],
    { cwd: kRepoRoot, encoding: "utf8" },
  );
  return new Set(
    out
      .split("\n")
      .map((line) => line.replace(/^(process\.)?env\./, "").replace(/^"|"$/g, "").trim())
      .filter(Boolean),
  );
};

describe("docs/README environment-variable table", () => {
  it("documents every deployment-only knob (read at process start)", () => {
    const documented = new Set(documentedVars());
    const missing = kDeploymentOnlyEnvKeys.filter((key) => !documented.has(key));
    expect(missing, `add README env-table rows for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every documented variable is still read somewhere in lib/ or bin/", () => {
    const read = readVars();
    const stale = documentedVars().filter((name) => !read.has(name));
    expect(stale, `README rows for variables the code no longer reads: ${stale.join(", ")}`).toEqual([]);
  });

  it("has no duplicate rows", () => {
    const names = documentedVars();
    expect(new Set(names).size).toBe(names.length);
  });
});
