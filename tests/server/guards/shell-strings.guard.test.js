// Guard (b): no shell strings built from data. Every child process must take
// argv (execFileCmd / execFileSync / spawn) — PR #28 C1/H1 fixed this class
// once and the audit found four survivors (bin §8 GOG_VERSION, §10 remote
// set-url, onboarding clone, webhooks git-sync). Flags: exec/execSync/
// shellCmd with an interpolated template literal or `+` concatenation,
// `shell: true`, and `sh -c`/`sh -lc` argv whose command is not a literal.
const { auditTree, formatHits } = require("./guard-utils");
const { scanShellStrings } = require("./scanners");

// Content-keyed (callee + command prefix). Every entry names the fix-wave PR
// that removes it, or why the shell string is deliberate.
const kKnownOffenders = {
  // PR 6 — self-update install (F038/F039).
  "lib/server/alphaclaw-version.js::childProcess.exec(`cp -af \"…`)": "PR 6: argv copy of the staged install (F038/F039)",
  // Deliberate: commands.js IS the shell wrapper (shellCmd/clawCmd) that every
  // trusted-constant command string goes through; the template only splices
  // the already-built command. Callers are what the guard polices.
  "lib/server/commands.js::exec(`openclaw…`)": "intentional: the shell wrapper itself",
  "lib/server/commands.js::exec(`gog…`)": "intentional: the shell wrapper itself",
  // PR 7 — the H1 fix quotes these through shellEscapeArg (single-quote
  // escaping); still a shell string, converted to argv with the other
  // onboarding writers.
  "lib/server/onboarding/index.js::shellCmd(`cd…`)": "PR 7: argv git init/remote (shellEscapeArg-quoted today)",
  "lib/server/onboarding/index.js::shellCmd(`cd…`)#2": "PR 7: argv git init/remote (shellEscapeArg-quoted today)",
};

describe("guard: child processes take argv, never data-built shell strings", () => {
  it("detects interpolated exec templates, concatenation, shell:true and sh -c <var> (self-test)", () => {
    const fixture = [
      "execSync(`git remote set-url origin \"${remoteUrl}\"`);",
      'exec("ls " + dir);',
      'spawn("cmd", [], { shell: true });',
      'spawnSync("sh", ["-c", script]);',
      'spawnSync("sh", ["-c", "command -v script"]); // literal: fine',
      "db.exec(`PRAGMA busy_timeout = ${ms};`); // sqlite, not a shell",
      "execSync(`git status`); // no interpolation: fine",
    ].join("\n");
    const hits = scanShellStrings(fixture, "lib/server/planted.js");
    expect(hits.map((h) => h.key.split("::")[1])).toEqual([
      "execSync(`git remote set-url origin \"…`)",
      "exec(…+…)",
      "shell:true",
      "sh -c <non-literal>",
    ]);
  });

  it("has no shell-string spawn sites outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib", "bin"],
      scan: scanShellStrings,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `New shell-string spawn site(s). Use execFileCmd/execFileSync/spawn with argv (and quoteShellArg only for trusted constants):\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
