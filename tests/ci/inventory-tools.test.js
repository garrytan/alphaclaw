const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const kScripts = path.join(__dirname, "..", "..", "scripts", "ci");
const load = (name) => import(path.join(kScripts, name));

const report = (root, files) => ({
  testResults: Object.entries(files).map(([file, tests]) => ({
    name: path.join(root, file),
    status: tests.some((t) => t.status === "failed") ? "failed" : "passed",
    assertionResults: tests.map((t) => ({
      fullName: t.name,
      status: t.status ?? "passed",
      meta: { assertions: t.assertions ?? 1, retries: t.retries ?? 0 },
    })),
  })),
});

describe("ci/test-inventory", () => {
  it("keys tests by file, full name and occurrence, with status, assertions and retries", async () => {
    const { buildInventory } = await load("test-inventory.mjs");
    const inventory = buildInventory(
      [{ source: "a.json", report: report("/r", { "tests/a.test.js": [{ name: "x" }, { name: "x", status: "pending" }, { name: "y", assertions: 3, retries: 1 }] }) }],
      { root: "/r" },
    );
    expect(inventory.files).toEqual([{ file: "tests/a.test.js", status: "passed" }]);
    expect(inventory.tests).toEqual([
      { file: "tests/a.test.js", name: "x", occurrence: 0, status: "passed", assertions: 1, retries: 0 },
      { file: "tests/a.test.js", name: "x", occurrence: 1, status: "skipped", assertions: 1, retries: 0 },
      { file: "tests/a.test.js", name: "y", occurrence: 0, status: "passed", assertions: 3, retries: 1 },
    ]);
  });

  it("keys a name that embeds the clock on a placeholder, so two runs match", async () => {
    const { buildInventory } = await load("test-inventory.mjs");
    const run = (stamp) =>
      buildInventory(
        [{ source: "r", report: report("/r", { "tests/a.test.js": [{ name: `keeps freshness ({"sampledAt":"${stamp}"})` }] }) }],
        { root: "/r" },
      ).tests.map((t) => t.name);
    expect(run("2026-10-29T04:02:13.315Z")).toEqual(run("2026-10-30T11:00:00.001Z"));
    expect(run("2026-10-29T04:02:13.315Z")).toEqual(['keeps freshness ({"sampledAt":"<timestamp>"})']);
  });

  it("refuses an empty report and a file that ran in two legs", async () => {
    const { buildInventory } = await load("test-inventory.mjs");
    expect(() => buildInventory([])).toThrow(/no vitest JSON reports/);
    expect(() => buildInventory([{ source: "leg1", report: { testResults: [] } }])).toThrow(/lists no test files/);
    const leg = report("/r", { "tests/a.test.js": [{ name: "x" }] });
    expect(() =>
      buildInventory([{ source: "leg1", report: leg }, { source: "leg2", report: leg }], { root: "/r" }),
    ).toThrow(/ran in two reports/);
  });
});

describe("ci/inventory-diff", () => {
  const inv = (tests, files = [...new Set(tests.map((t) => t.file))]) => ({
    schema: 1,
    files: files.map((file) => ({ file, status: "passed" })),
    tests: tests.map((t) => ({ occurrence: 0, status: "passed", assertions: 1, retries: 0, ...t })),
  });
  const base = inv([
    { file: "tests/a.test.js", name: "a1" },
    { file: "tests/a.test.js", name: "a2", assertions: 4 },
    { file: "tests/b.test.js", name: "b1" },
  ]);

  it("passes an unchanged or growing suite and reports additions", async () => {
    const { diffInventories } = await load("inventory-diff.mjs");
    const head = inv([...base.tests, { file: "tests/c.test.js", name: "c1" }]);
    const result = diffInventories(base, head);
    expect(result.losses).toEqual([]);
    expect(result.notes).toEqual([{ kind: "added", key: "tests/c.test.js :: c1" }]);
  });

  it("fails an undeclared removed test or file and prints the declaration to add", async () => {
    const { diffInventories, renderDiff } = await load("inventory-diff.mjs");
    const head = inv([{ file: "tests/a.test.js", name: "a1" }]);
    const result = diffInventories(base, head);
    expect(result.losses.map((l) => l.kind).sort()).toEqual(["removed file", "removed test"]);
    const text = renderDiff(result);
    expect(text).toContain("Removed-test-file: tests/b.test.js");
    expect(text).toContain("Removed-test: tests/a.test.js :: a2");
  });

  it("accepts removals declared anywhere in a squashed commit message", async () => {
    const { diffInventories, parseDeclarations } = await load("inventory-diff.mjs");
    const head = inv([{ file: "tests/a.test.js", name: "a1" }]);
    const message = "v0.10.200 Drop old tests (#300)\n\n* tidy\n\n  Removed-test-file: tests/b.test.js\nRemoved-test: tests/a.test.js :: a2\n";
    expect(diffInventories(base, head, { declarations: parseDeclarations(message) }).losses).toEqual([]);
  });

  it("fails a passing test that is now skipped unless declared, and any new failure", async () => {
    const { diffInventories, parseDeclarations } = await load("inventory-diff.mjs");
    const head = inv([
      { file: "tests/a.test.js", name: "a1", status: "skipped" },
      { file: "tests/a.test.js", name: "a2", assertions: 4, status: "failed" },
      { file: "tests/b.test.js", name: "b1" },
    ]);
    const losses = diffInventories(base, head).losses;
    expect(losses.map((l) => l.kind)).toEqual(["passed, now skipped", "passed, now failed"]);
    expect(losses[0].declare).toBe("Skipped-test: tests/a.test.js :: a1");
    const declared = diffInventories(base, head, { declarations: parseDeclarations("Skipped-test: tests/a.test.js :: a1") });
    expect(declared.losses.map((l) => l.kind)).toEqual(["passed, now failed"]);
  });

  it("reports fewer assertions, failing only under --strict; fails retries under --no-retries; catches a duplicate", async () => {
    const { diffInventories } = await load("inventory-diff.mjs");
    const head = inv([
      { file: "tests/a.test.js", name: "a1", retries: 1 },
      { file: "tests/a.test.js", name: "a2", assertions: 2 },
      { file: "tests/b.test.js", name: "b1" },
    ]);
    expect(diffInventories(base, head).losses).toEqual([]);
    expect(diffInventories(base, head).notes).toContainEqual({ kind: "fewer assertions", key: "tests/a.test.js :: a2", detail: "4 -> 2" });
    expect(diffInventories(base, head, { strict: true }).losses.map((l) => l.kind)).toEqual(["fewer assertions"]);
    expect(diffInventories(base, head, { noRetries: true }).losses.map((l) => l.kind)).toEqual(["retried"]);
    const dup = inv([...base.tests, { file: "tests/b.test.js", name: "b1" }]);
    expect(diffInventories(base, dup).losses.map((l) => l.kind)).toEqual(["ran twice (head)"]);
  });

  it("exits 1 on a loss and 0 with --report-only (CLI)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-diff-"));
    fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify(base));
    fs.writeFileSync(path.join(dir, "head.json"), JSON.stringify(inv([{ file: "tests/a.test.js", name: "a1" }])));
    const run = (...extra) =>
      spawnSync(process.execPath, [path.join(kScripts, "inventory-diff.mjs"), path.join(dir, "base.json"), path.join(dir, "head.json"), ...extra], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      });
    expect(run().status).toBe(1);
    const reportOnly = run("--report-only");
    expect(reportOnly.status).toBe(0);
    expect(reportOnly.stdout).toContain("::warning::Test inventory: 2 loss(es)");
  });
});

describe("ci/coverage-diff", () => {
  const file = (s, b, f) => ({
    statementMap: Object.fromEntries(Object.keys(s).map((k) => [k, { start: { line: Number(k) + 1 } }])),
    branchMap: Object.fromEntries(Object.keys(b).map((k) => [k, { type: "if" }])),
    fnMap: Object.fromEntries(Object.keys(f).map((k) => [k, { name: `fn${k}` }])),
    s,
    b,
    f,
  });
  const before = {
    "/m1/repo/lib/a.js": file({ 0: 1, 1: 1 }, { 0: [1, 0] }, { 0: 1 }),
    "/m1/repo/lib/b.js": file({ 0: 1 }, {}, {}),
  };

  it("passes identical coverage taken on different machines", async () => {
    const { diffCoverage } = await load("coverage-diff.mjs");
    const after = Object.fromEntries(Object.entries(before).map(([k, v]) => [k.replace("/m1/repo", "/home/runner/work/x"), v]));
    expect(diffCoverage(before, after).losses).toEqual([]);
  });

  it("fails a swapped branch arm at equal percentages, unless it is listed noise", async () => {
    const { diffCoverage, noiseBetween } = await load("coverage-diff.mjs");
    const after = { ...before, "/m1/repo/lib/a.js": file({ 0: 1, 1: 1 }, { 0: [0, 1] }, { 0: 1 }) };
    expect(diffCoverage(before, after).losses).toEqual([{ file: "lib/a.js", lost: ["b0.0"] }]);
    const noise = noiseBetween(before, after);
    expect(noise).toEqual({ "lib/a.js": ["b0.0", "b0.1"] });
    expect(diffCoverage(before, after, { noise }).losses).toEqual([]);
    const third = { ...before, "/m1/repo/lib/b.js": file({ 0: 0 }, {}, {}) };
    expect(noiseBetween(before, before, third)).toEqual({ "lib/b.js": ["s0"] });
  });

  it("lists a changed file with its percentages instead of comparing locations", async () => {
    const { diffCoverage } = await load("coverage-diff.mjs");
    const after = { ...before, "/m1/repo/lib/b.js": file({ 0: 1, 1: 0 }, {}, {}) };
    const result = diffCoverage(before, after);
    expect(result.losses).toEqual([]);
    expect(result.changed).toEqual([{ file: "lib/b.js", before: { statements: 100, branches: 100, functions: 100 }, after: { statements: 50, branches: 100, functions: 100 } }]);
  });
});
