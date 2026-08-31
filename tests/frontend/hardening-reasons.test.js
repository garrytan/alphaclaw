import { describe, expect, it } from "vitest";
import {
  getHardeningReasonCopy,
  kHardeningReasonCopy,
} from "../../lib/public/js/lib/hardening-reasons.js";
// The CANONICAL enum — imported from the server so map/server drift fails CI
// instead of relying on keep-in-sync comments. (Tests may import server
// modules; the client bundle must not.)
import { kHardeningReasonValues } from "../../lib/server/doctor/constants.js";

describe("frontend/hardening reasons copy map", () => {
  it("covers every canonical server reason value", () => {
    // 11 values; the fallback is out-of-enum behavior, not an entry to count,
    // and config_unreadable is a state-level reason owned by the badge.
    expect(kHardeningReasonValues.length).toBe(11);
    for (const reason of kHardeningReasonValues) {
      const entry = kHardeningReasonCopy[reason];
      expect(entry, `missing map entry for server reason "${reason}"`).toBeTruthy();
      expect(entry.cause.length).toBeGreaterThan(0);
      expect(entry.short.length).toBeGreaterThan(0);
    }
  });

  it("has no client-only entries the server can never emit", () => {
    const canonical = new Set(kHardeningReasonValues);
    for (const key of Object.keys(kHardeningReasonCopy)) {
      expect(canonical.has(key), `client-only reason "${key}"`).toBe(true);
    }
  });

  it("prefers the managed variant for AlphaClaw-managed files", () => {
    const managed = getHardeningReasonCopy("escapes_workspace", { managed: true });
    expect(managed.short).toContain("restart AlphaClaw");
    const unmanaged = getHardeningReasonCopy("escapes_workspace");
    expect(unmanaged.short).toContain("Replace the symlink");
    // Entries without a managed variant fall back to the shared short.
    expect(getHardeningReasonCopy("total_limit", { managed: true }).short).toBe(
      getHardeningReasonCopy("total_limit").short,
    );
  });

  it("never advises raising a budget for the fixed 2 MiB read cap", () => {
    for (const managed of [true, false]) {
      const copy = getHardeningReasonCopy("file_too_large", { managed });
      expect(copy.short).not.toContain("bootstrapMaxChars");
      expect(copy.short).not.toContain("bootstrapTotalMaxChars");
    }
  });

  it.each([
    ["", "unknown-empty"],
    ["some_future_reason", "unknown-string"],
    [null, "null"],
    [undefined, "undefined"],
    [42, "number"],
    [{}, "object"],
    ["constructor", "prototype-key"],
  ])("falls back honestly for out-of-enum reason %s (%s)", (reason) => {
    const copy = getHardeningReasonCopy(reason, { managed: true });
    expect(copy.cause).toContain("cause not recognized");
    expect(copy.short).toContain("Drift Doctor");
  });
});
