// Security-relevant coverage OWNED by the shared module (eng review issue 7):
// the prototype-pollution guard and protected-prefix denylist used by BOTH
// the gateway medic and the boot config reconciler live here — a future
// medic-test refactor must not orphan these cases.
const {
  kUnrecognizedKeyPattern,
  kProtectedKeyPathPrefixes,
  isProtectedKeyPath,
  extractBlamedConfigPaths,
  removeKeyPathsFromConfigObject,
} = require("../../lib/server/openclaw-config-keys");

describe("server/openclaw-config-keys", () => {
  describe("extractBlamedConfigPaths", () => {
    it("parses the production stripe-crash stderr shapes", () => {
      const { unrecognized, invalid } = extractBlamedConfigPaths([
        'gateway.controlUi: Unrecognized key: "environment"',
        'Unrecognized key: "audit"',
        "  - gateway.controlUi: Invalid input",
      ]);
      expect(unrecognized).toEqual([
        "gateway.controlUi.environment",
        "audit",
      ]);
      expect(invalid).toEqual([
        { path: "gateway.controlUi", problem: "Invalid input" },
      ]);
    });

    it("ignores unrecognized-key text embedded mid-line (echoed values)", () => {
      const { unrecognized } = extractBlamedConfigPaths([
        'received "gateway: Unrecognized key: \\"auth\\"" from upstream',
      ]);
      expect(unrecognized).toEqual([]);
      expect(kUnrecognizedKeyPattern.test("x Unrecognized key: \"y\"")).toBe(
        false,
      );
    });

    it("parses the #20 retired-key error lines verbatim", () => {
      const { unrecognized } = extractBlamedConfigPaths([
        'meta: Unrecognized key: "lastTouchedAt"',
        'diagnostics: Unrecognized key: "memoryPressureSnapshot"',
        'agents.defaults.compaction: Unrecognized keys: "truncateAfterCompaction", "maxHistoryShare", "reserveTokens"',
      ]);
      expect(unrecognized).toContain("meta.lastTouchedAt");
      expect(unrecognized).toContain("diagnostics.memoryPressureSnapshot");
      expect(unrecognized).toContain(
        "agents.defaults.compaction.truncateAfterCompaction",
      );
      // The plural line carries every key — issue #20's actual output shape.
      expect(unrecognized).toContain(
        "agents.defaults.compaction.maxHistoryShare",
      );
      expect(unrecognized).toContain(
        "agents.defaults.compaction.reserveTokens",
      );
    });
  });

  describe("isProtectedKeyPath", () => {
    it("protects exact paths, children, and ANCESTORS of protected prefixes", () => {
      for (const prefix of kProtectedKeyPathPrefixes) {
        expect(isProtectedKeyPath(prefix)).toBe(true);
        expect(isProtectedKeyPath(`${prefix}.child`)).toBe(true);
      }
      // Deleting "gateway" would delete gateway.auth with it.
      expect(isProtectedKeyPath("gateway")).toBe(true);
      expect(isProtectedKeyPath("gateway.controlUi")).toBe(true);
      expect(isProtectedKeyPath("gateway.controlUi.environment")).toBe(false);
      expect(isProtectedKeyPath("meta.lastTouchedAt")).toBe(false);
    });
  });

  describe("removeKeyPathsFromConfigObject", () => {
    it("removes nested keys, prunes now-empty parents, fires the backup hook once", () => {
      const config = {
        meta: { lastTouchedAt: "2026-07-01" },
        cron: { maxConcurrentRuns: 4, keep: true },
      };
      const hook = vi.fn();
      const removed = removeKeyPathsFromConfigObject(
        config,
        ["meta.lastTouchedAt", "cron.maxConcurrentRuns"],
        { onBeforeFirstRemoval: hook },
      );
      expect(removed).toEqual(["meta.lastTouchedAt", "cron.maxConcurrentRuns"]);
      expect(config.meta).toBeUndefined(); // empty parent pruned
      expect(config.cron).toEqual({ keep: true }); // non-empty parent kept
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("deletes a literal dotted ROOT key instead of walking it as a path", () => {
      const config = {
        "channels.telegram.enabled": true,
        channels: { telegram: { enabled: "nested-must-survive" } },
      };
      const removed = removeKeyPathsFromConfigObject(config, [
        "channels.telegram.enabled",
      ]);
      expect(removed).toEqual(["channels.telegram.enabled"]);
      expect(config.channels.telegram.enabled).toBe("nested-must-survive");
    });

    it("never walks __proto__/constructor/prototype segments", () => {
      const config = { safe: true };
      const removed = removeKeyPathsFromConfigObject(config, [
        "__proto__",
        "constructor.prototype",
        "a.__proto__.b",
      ]);
      expect(removed).toEqual([]);
      expect(config.safe).toBe(true);
      expect({}.polluted).toBeUndefined();
    });

    it("skipKeyPath fails CLOSED when the callback throws", () => {
      const config = { audit: {} };
      const removed = removeKeyPathsFromConfigObject(config, ["audit"], {
        skipKeyPath: () => {
          throw new Error("cannot verify");
        },
      });
      expect(removed).toEqual([]);
      expect(config.audit).toEqual({});
    });

    it("skips absent keys without firing the backup hook", () => {
      const config = { present: 1 };
      const hook = vi.fn();
      const removed = removeKeyPathsFromConfigObject(
        config,
        ["absent.path", "also.absent"],
        { onBeforeFirstRemoval: hook },
      );
      expect(removed).toEqual([]);
      expect(hook).not.toHaveBeenCalled();
    });
  });
});
