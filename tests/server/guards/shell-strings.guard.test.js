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
  // Deliberate: commands.js IS the shell wrapper (shellCmd/clawCmd) that every
  // trusted-constant command string goes through; the template only splices
  // the already-built command. Callers are what the guard polices.
  // clawCmd spawns `/bin/sh -c` itself (own process group for timeout kills).
  "lib/server/commands.js::sh -c <non-literal>": "intentional: the shell wrapper itself",
  "lib/server/commands.js::exec(`gog…`)": "intentional: the shell wrapper itself",
  // Refactor PR 15 taught the scanner clawCmd/clawCmdWithRetry/gogCmd and the
  // injected execSyncImpl/execImpl. An interpolation that is one quoting-helper
  // call or a numeric literal passes; these sites interpolate something else
  // that is still not data:
  // - a numeric constant or a pid (a number, never a string):
  "lib/server/doctor/service.js::clawCmd(`gateway call agent --expect-final --json…`)": "numeric timeout constant; --params is shellEscapeArg-quoted",
  "lib/server/doctor/service.js::clawCmd(`gateway call agent --json --timeout…`)": "numeric timeout constant; escapedParams is shellEscapeArg output, kept in a variable for the 120 kB byte budget",
  "lib/server/gateway-restart-handoff.js::clawCmd(`gateway restart-handoff consume --expect…`)": "pid is a process number",
  "lib/server/routes/nodes.js::clawCmd(`nodes invoke --node…`)": "numeric timeout constant; node id and params are quoteCliArg-quoted",
  // - a closed enum:
  "lib/server/routes/pairings.js::clawCmd(`pairing list --channel…`)": "ch iterates kAllowedPairingChannels (four constants)",
  // - a prefix assembled from quoteShellArg output plus constant command text:
  "lib/server/gmail-watch.js::gogCmd(`…`)": "prefix is '--client <quoteShellArg>' or empty; command is built with quoteShellArg in gmail-watch-lifecycle",
  "lib/server/google-disconnect.js::gogCmd(`…`)": "clientArg is '--client <quoteShellArg>' or empty",
  "lib/server/google-disconnect.js::gogCmd(`…`)#2": "clientArg is '--client <quoteShellArg>' or empty",
  "lib/server/routes/google.js::gogCmd(`…`)": "clientArg is '--client <quoteShellArg>' or empty",
  "lib/server/routes/google.js::gogCmd(`…`)#2": "clientArg as above; cmd comes from the constant API_TEST_COMMANDS table",
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
      "clawCmd(`agents bind --agent ${quoteShellArg(agentId)} --timeout ${30000}`); // helper + literal: fine",
      "clawCmd(`pairing list --channel ${ch}`);",
      "gogCmd(`auth remove ${quoteShellArg(a) + b}`); // not ONE helper call",
    ].join("\n");
    const hits = scanShellStrings(fixture, "lib/server/planted.js");
    expect(hits.map((h) => h.key.split("::")[1])).toEqual([
      "execSync(`git remote set-url origin \"…`)",
      "exec(…+…)",
      "clawCmd(`pairing list --channel…`)",
      "gogCmd(`auth remove…`)",
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
