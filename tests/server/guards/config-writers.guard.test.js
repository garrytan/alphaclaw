// Guard (a): no raw writes to the managed config files. openclaw.json,
// alphaclaw.json and exec-approvals.json must be written through
// updateOpenclawConfig / updateAlphaclawConfig / writeFileAtomic (locked,
// atomic, fail-closed on an existing-but-unparseable file). A raw
// writeFileSync is the "read {} on parse error, then persist the wipe" class
// the audit confirmed at F213 (P1) and six P2 sites.
const { auditTree, formatHits } = require("./guard-utils");
const { scanConfigWriters } = require("./scanners");

// Every entry is a KNOWN raw writer with the fix-wave PR that removes it.
// Add a new entry only with a why-comment; prefer routing through the helper.
const kKnownOffenders = {
  // PR 7 — webhooks config writer (also downgrades agents.entries).
  "lib/server/webhooks.js::configPath": "PR 7: writeConfig → updateOpenclawConfig",
  // PR 7 — gmail-watch hooks preset.
  "lib/server/gmail-watch.js::configPath": "PR 7: ensureHooksPreset → updateOpenclawConfig",
  // PR 7 — onboarding writers (import + sanitize + codex plugin).
  "lib/server/onboarding/index.js::configPath": "PR 7: import config write → updateOpenclawConfig",
  "lib/server/onboarding/openclaw.js::configPath": "PR 7: sanitize/ensure writers → updateOpenclawConfig",
  // PR 7 — exec-approvals file-era writer.
  "lib/server/exec-defaults-config.js::filePath": "PR 7: exec-approvals.json → writeFileAtomic",
  // PR 4 — gateway token→${ENV} scrub and channel sync (F013).
  "lib/server/gateway.js::configPath": "PR 4: syncChannelConfig scrub → updateOpenclawConfig",
  // PR 2 — boot §10/§11 rewrites (F005).
  "bin/alphaclaw.js::configPath": "PR 2: boot sanitize/migrate → atomic write",
  // Deliberate: the CLI restore copies the git-tracked bytes verbatim into a
  // MISSING openclaw.json — there is nothing to fail closed on. Keep raw.
  "lib/cli/openclaw-config-restore.js::configPath": "intentional: verbatim restore of a missing file",
};

describe("guard: managed config files are never written raw", () => {
  it("detects a raw writeFileSync to a managed config via a bound identifier (self-test)", () => {
    const fixture = [
      'const configPath = path.join(dir, "openclaw.json");',
      "fs.writeFileSync(configPath, JSON.stringify(cfg));",
    ].join("\n");
    expect(scanConfigWriters(fixture, "lib/server/planted.js")).toHaveLength(1);
  });

  it("detects a literal managed path and ignores temp files and comments (self-test)", () => {
    const fixture = [
      '// fs.writeFileSync(path.join(dir, "alphaclaw.json"), x); commented out',
      'fs.writeFileSync(path.join(dir, "alphaclaw.json"), x);',
      'const tmpPath = `${configPath}.tmp`; fs.writeFileSync(tmpPath, x);',
    ].join("\n");
    const hits = scanConfigWriters(fixture, "lib/server/planted.js");
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toContain("alphaclaw.json");
  });

  it("has no new raw writers outside the allowlist, and no stale allowlist entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib", "bin"],
      scan: scanConfigWriters,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `New raw managed-config writer(s). Route them through updateOpenclawConfig / updateAlphaclawConfig / writeFileAtomic, or allowlist with a why-comment:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(
      stale,
      `Allowlist entries no longer match — the offender was fixed, remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
