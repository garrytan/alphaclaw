const { spawnSync } = require("node:child_process");
const { resolveBackupPolicy, compileExcludePattern, boundBackupRefusals } = require("../../lib/server/openclaw-backup-policy");

describe("bounded backup-policy glob matching", () => {
  it("matches a repeated-star rule without blocking on a long filename", () => {
    // Isolate the synchronous matcher so a backtracking regression cannot
    // hang the whole test worker. Ten seconds is only a deadlock backstop;
    // this test makes no subsecond wall-clock assertion.
    const result = spawnSync(process.execPath, ["-e", `
      const { resolveBackupPolicy } = require(process.argv[1]);
      const pattern = "a*".repeat(120) + "b";
      const rootPattern = "state/scratch/" + "**/".repeat(60) + "b";
      const policy = resolveBackupPolicy({ excludes: [pattern], rootExcludes: [rootPattern] });
      process.stdout.write(JSON.stringify({
        refused: policy.refused,
        excludes: policy.excludes,
        workspaceMiss: policy.applied[0].test("a".repeat(255)),
        workspaceHit: policy.applied[0].test("a".repeat(254) + "b"),
        rootMiss: policy.rootApplied[0].test("state/scratch/" + "a/".repeat(120) + "c"),
        rootHit: policy.rootApplied[0].test("state/scratch/" + "a/".repeat(120) + "b"),
      }));
    `, require.resolve("../../lib/server/openclaw-backup-policy")], { timeout: 10_000, encoding: "utf8" });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      refused: [], excludes: ["a*".repeat(120) + "b"],
      workspaceMiss: false, workspaceHit: true, rootMiss: false, rootHit: true,
    });
  }, 15_000);

  it.each([
    ["junk/**/tail", "junk/tail", true],
    ["junk/**/tail", "junk/a/b/tail", true],
    ["junk/**/tail", "junk//tail", false],
    ["junk/**/**/tail", "junk/a/b/tail", true],
    ["junk/**/a*/**/tail", "junk/abc/tail", true],
    ["junk/**/a*/**/tail", "junk/x/abc/y/tail", true],
    ["junk/**/a*/**/tail", "junk/x/bc/y/tail", false],
    ["junk/**", "junk/", true],
    ["junk/**", "junk", false],
    ["junk/**", "junk/a/b", true],
    ["junk/**", "junk/a\nb", false],
    ["junk/*/tail", "junk/a/b/tail", false],
    ["junk/??", "junk/ab", true],
    ["junk/??", "junk/a", false],
    ["junk/a***b", "junk/aab", true],
    ["junk/a***b", "junk/a/b", false],
    ["junk/[x].(y)+$", "junk/[x].(y)+$", true],
    ["junk/ä", "JUNK/Ä", true],
    ["junk/s", "junk/ſ", false],
    ["junk/k", "junk/K", false],
    ["junk/ß", "junk/SS", false],
    ["junk/?", "junk/😀", false],
    ["junk/??", "junk/😀", true],
    ["junk", "junk\n", false],
  ])("preserves glob semantics for %s against %s", (pattern, subject, expected) => {
    expect(compileExcludePattern(pattern).compiled.test(subject)).toBe(expected);
  });
});

describe("bounded backup-policy refusals", () => {
  it("inspects only 64 candidates per scope from lazy million-pattern arrays", () => {
    let reads = 0;
    const patterns = (prefix) => new Proxy([], {
      get(target, key) {
        if (key === "length") return 1_000_000;
        if (typeof key === "string" && /^\d+$/.test(key)) {
          if (Number(key) >= 64) throw new Error("read beyond the candidate limit");
          reads++;
          return `${prefix}${key}`;
        }
        return Reflect.get(target, key);
      },
      has: () => true,
    });
    const result = resolveBackupPolicy({ excludes: patterns("junk-"), rootExcludes: patterns("state/cache-") });
    expect(reads).toBe(128);
    expect(result.excludes).toHaveLength(64);
    expect(result.rootExcludes).toHaveLength(64);
    expect(result.refused).toEqual([expect.objectContaining({ pattern: "[additional exclusions]", omittedCount: 2 * (1_000_000 - 64) })]);
  });

  it("caps both scopes together at 64 details and one counted overflow", () => {
    const result = resolveBackupPolicy({
      excludes: Array.from({ length: 64 }, (_, index) => `/workspace-${index}`),
      rootExcludes: Array.from({ length: 64 }, (_, index) => `/root-${index}`),
    });
    expect(result.refused).toHaveLength(65);
    expect(result.refused.at(-1)).toMatchObject({ scope: "root", omittedCount: 64 });
    expect(result.excludes).toEqual([]);
    expect(result.rootExcludes).toEqual([]);
    expect(JSON.stringify(result.refused).length).toBeLessThan(60_000);
  });

  it("bounds and sanitizes rejected labels and dynamic protection reasons", () => {
    const long = compileExcludePattern(`\0${"x".repeat(20_000)}\n`);
    expect(long.refused.pattern).toHaveLength(256);
    expect(long.refused.pattern).not.toMatch(/[\x00-\x1f\x7f]/);
    const dynamic = compileExcludePattern("state/owners/**", { scope: "root", inventory: {
      stateDir: "/root", protectedPaths: [`/root/state/owners/\x1b${"x".repeat(3000)}`],
    } });
    expect(dynamic.refused.reason).toHaveLength(512);
    expect(dynamic.refused.reason).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("describes non-string inputs without invoking their string conversion", () => {
    const array = [];
    array.length = 1_000_000;
    array.toString = () => { throw new Error("array conversion must not run"); };
    const object = { toString() { throw new Error("object conversion must not run"); } };
    const result = resolveBackupPolicy({ excludes: [array, object, null, 3, true], rootExcludes: [] });
    expect(result.refused.map((entry) => entry.pattern)).toEqual(["[array]", "[object]", "null", "[number]", "[boolean]"]);
    expect(resolveBackupPolicy(array).refused[0].pattern).toBe("[array]");
    expect(resolveBackupPolicy({ rootExcludes: object }).refused[0].pattern).toBe("[object]");
  });

  it("keeps overflow counts stable through frozen-policy revalidation", () => {
    let result = resolveBackupPolicy({
      excludes: Array.from({ length: 80 }, (_, index) => `/invalid-${index}`),
      rootExcludes: Array.from({ length: 64 }, (_, index) => `state/cache-${index}`),
    });
    expect(result.refused.at(-1).omittedCount).toBe(16);
    const inventory = { stateDir: "/root", protectedPaths: Array.from({ length: 64 }, (_, index) => `/root/state/cache-${index}`) };
    for (let iteration = 0; iteration < 3; iteration++) {
      result = resolveBackupPolicy(result, { inventory });
      expect(result.refused).toHaveLength(65);
      expect(result.refused.at(-1).omittedCount).toBe(80);
      expect(result.rootExcludes).toEqual([]);
    }
  });

  it("preserves counted overflow when merging additional bounded refusal groups", () => {
    const details = Array.from({ length: 64 }, (_, index) => ({ scope: "workspace", pattern: `old-${index}`, reason: "old refusal" }));
    const overflow = [{ scope: "workspace", pattern: "[additional exclusions]", omittedCount: 100, reason: "previous overflow" }];
    const additional = Array.from({ length: 64 }, (_, index) => ({ scope: "root", pattern: `state/cache-${index}`, reason: "inventory unavailable" }));
    const result = boundBackupRefusals(details, overflow, additional);
    expect(result).toHaveLength(65);
    expect(result.at(-1).omittedCount).toBe(164);
    expect(boundBackupRefusals(result)).toEqual(result);
  });
});
