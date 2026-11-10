// Guard (f): a credential file is never written looser than 0600. On
// 2026-11-10 an updateOpenclawConfig write turned a box's openclaw.json from
// 0600 into 0644 (GST-2299): writeFileAtomic's mode was opt-in, so a replace
// without one landed at the umask default and any local user could read the
// gateway's credentials. writeFileAtomic now keeps an existing file's bits,
// and every credential writer names 0600 so a NEW file is private too. The
// scanner flags a writeFileAtomic / writeFileAtomicIfChanged call whose
// target names a credential path (or that sits in a secret-store module)
// and passes no mode, or a mode with group or other bits.
const { auditTree, formatHits } = require("./guard-utils");
const { scanLooseSecretWriters } = require("./scanners");

// Keep it empty: pass mode 0o600 instead. Add an entry only with a
// why-comment for a write the scanner mistakes for a credential.
const kKnownOffenders = {};

describe("guard: credential files are never written looser than 0600", () => {
  it("flags a credential write with no mode or a loose mode (self-test)", () => {
    const fixture = [
      'const configPath = path.join(dir, "openclaw.json");',
      "writeFileAtomic(configPath, JSON.stringify(cfg), { fsModule });",
      'writeFileAtomic(path.join(dir, ".env"), body, { mode: 0o644 });',
      "writeFileAtomic(paths.secretsFile, body, {",
      "  fsModule,",
      "  mode: 0o640,",
      "});",
      "const backup = path.join(",
      "  dir,",
      "  `alphaclaw.json.${stamp}.bak`,",
      ");",
      "writeFileAtomicIfChanged(backup, body);",
    ].join("\n");
    const hits = scanLooseSecretWriters(fixture, "lib/server/planted.js");
    expect(hits.map((hit) => hit.key)).toEqual([
      "lib/server/planted.js::configPath",
      'lib/server/planted.js::path.join(dir, ".env")',
      "lib/server/planted.js::paths.secretsFile",
      "lib/server/planted.js::backup",
    ]);
  });

  it("accepts a private literal or bound mode and ignores ordinary files (self-test)", () => {
    const fixture = [
      "const kStoreMode = 0o600;",
      'const tokenPath = path.join(dir, "admin-token");',
      "writeFileAtomic(tokenPath, token, { fsModule, mode: kStoreMode });",
      'writeFileAtomic(path.join(dir, "auth-profiles.json"), body, { mode: 0o400 });',
      "// writeFileAtomic(credentialsPath, body); commented out",
      'writeFileAtomic(path.join(dir, "boot-report.json"), body, { fsModule });',
    ].join("\n");
    expect(scanLooseSecretWriters(fixture, "lib/server/planted.js")).toEqual([]);
  });

  it("treats every write in a secret-store module as a credential write (self-test)", () => {
    const fixture = "writeFileAtomic(statePath, JSON.stringify(state), { fs });";
    expect(scanLooseSecretWriters(fixture, "lib/server/google-state.js")).toHaveLength(1);
  });

  it("has no new loose credential writers outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib", "bin"],
      scan: scanLooseSecretWriters,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Credential writer(s) that can land a file looser than 0600. Pass mode: 0o600, or allowlist with a why-comment:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(
      stale,
      `Allowlist entries no longer match — the offender was fixed, remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
