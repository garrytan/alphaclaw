// Shared truth table for the OpenClaw process matcher (v0.9.81, review
// amendment D3 / cross-model D16). Every row carries TWO expectations because
// "OpenClaw process" ≠ "gateway process": `openclaw doctor --fix` is an
// OpenClaw process but not a gateway; `tail -F .../openclaw/openclaw.log` is
// neither. Consumed by openclaw-lock-contention.test.js (isOpenclawArgv +
// listLiveOpenclawProcesses over a fake /proc) and gateway.test.js
// (listGatewayPids must resolve every `gateway: true` row) so the four
// consumers of the one matcher can never drift apart.
//
//   openclaw — isOpenclawArgv(argv) must return this
//   gateway  — kGatewayProcessPattern must match the joined cmdline AND the
//              process must be an OpenClaw process (the EVIDENCE pattern
//              gateway.js listGatewayPids applies by default)
const kOpenclawArgvFixtures = [
  // ── must match: the program IS OpenClaw ──────────────────────────────────
  { name: "bare CLI gateway run", argv: ["openclaw", "gateway", "run"], openclaw: true, gateway: true },
  { name: "bare CLI doctor", argv: ["/usr/local/bin/openclaw", "doctor", "--fix"], openclaw: true, gateway: false },
  {
    name: "AlphaClaw PATH shim gateway run",
    argv: ["/data/.openclaw/.alphaclaw/bin/openclaw", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "node + dist/entry.js gateway run",
    argv: ["node", "/app/node_modules/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "node with a runtime flag before the entry script",
    argv: ["node", "--max-old-space-size=2048", "/app/node_modules/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "node with a value-taking flag (space-separated) before the entry script",
    argv: ["node", "--require", "/opt/preload.js", "/app/node_modules/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "node + package openclaw.mjs gateway --force",
    argv: ["node", "/app/node_modules/openclaw/openclaw.mjs", "gateway", "--force"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "versioned node binary + overlay entry script",
    argv: ["/usr/bin/node22", "/data/.openclaw/openclaw-overlay/2026.9.3/node_modules/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "dev checkout entry script",
    argv: ["node", "/data/.openclaw/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "bun + bare openclaw.mjs from the package dir",
    argv: ["bun", "openclaw.mjs", "status"],
    openclaw: true,
    gateway: false,
  },
  { name: "gateway binary", argv: ["/opt/x/openclaw-gateway"], openclaw: true, gateway: true },
  {
    name: "shebang wrapper named openclaw, run by the kernel as sh <script> (stays the launcher root of a gateway run)",
    argv: ["/bin/sh", "/data/.openclaw/.alphaclaw/bin/openclaw", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "bash wrapper named openclaw with a shell flag before the script",
    argv: ["bash", "-e", "/usr/local/bin/openclaw", "doctor"],
    openclaw: true,
    gateway: false,
  },
  {
    name: "Windows CLI shim",
    argv: ["C:\\Users\\op\\AppData\\Roaming\\npm\\openclaw.cmd", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  // THE shape this repo launches (v0.9.81 review P1): gateway.js spawns
  // `openclaw gateway run` via PATH → AlphaClaw's shim execs
  // `node "<root>/node_modules/.bin/openclaw" "$@"` → the live gateway's argv
  // is `node …/node_modules/.bin/openclaw gateway run` (the npm bin shim is a
  // node script whose basename is `openclaw`). Every AlphaClaw CLI shell-out
  // has the same prefix.
  {
    name: "the repo's own gateway launcher: node + npm bin shim + gateway run",
    argv: ["/usr/local/bin/node", "/app/node_modules/.bin/openclaw", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "the repo's own gateway launcher under the overlay tree",
    argv: ["node", "/data/.openclaw/openclaw-overlay/2026.9.3/node_modules/.bin/openclaw", "gateway", "--force"],
    openclaw: true,
    gateway: true,
  },
  {
    name: "AlphaClaw's own transient sessions shell-out (a real OpenClaw process; the settle loop, not the matcher, tolerates it)",
    argv: ["node", "/app/node_modules/.bin/openclaw", "sessions", "--json", "--all-agents"],
    openclaw: true,
    gateway: false,
  },
  {
    name: "upstream parity: a wrapper that passes the entry script as a later argument",
    argv: ["/usr/bin/some-wrapper", "--exec", "/srv/node_modules/openclaw/dist/entry.js", "gateway", "run"],
    openclaw: true,
    gateway: true,
  },
  // ── must NOT match: the program is something else; `openclaw` is only in a path ──
  {
    name: "log follower on OpenClaw's log file (the production false positive)",
    argv: ["tail", "-c", "+1", "-F", "/tmp/openclaw/openclaw-2026-09-08.log"],
    openclaw: false,
    gateway: false,
  },
  { name: "pager on a log under /openclaw/", argv: ["less", "/data/openclaw/x.log"], openclaw: false, gateway: false },
  { name: "grep for the word", argv: ["grep", "openclaw", "/etc/passwd"], openclaw: false, gateway: false },
  { name: "a hook script under the state dir", argv: ["node", "/data/.openclaw/hooks/x.js"], openclaw: false, gateway: false },
  { name: "sqlite shell on the state db", argv: ["sqlite3", "/data/.openclaw/openclaw/state/openclaw.sqlite"], openclaw: false, gateway: false },
  { name: "editor on a config under /openclaw/", argv: ["vim", "/data/.openclaw/openclaw/openclaw.json"], openclaw: false, gateway: false },
  { name: "cat on docs under /openclaw/", argv: ["cat", "/srv/openclaw/README.md"], openclaw: false, gateway: false },
  { name: "AlphaClaw itself", argv: ["node", "/app/bin/alphaclaw.js", "start"], openclaw: false, gateway: false },
  { name: "another node app with a generic dist/entry.js", argv: ["node", "/srv/other/dist/entry.js"], openclaw: false, gateway: false },
  { name: "another node app", argv: ["node", "/srv/other/index.js"], openclaw: false, gateway: false },
  { name: "node -e with the word in the code", argv: ["node", "-e", "console.log('openclaw')"], openclaw: false, gateway: false },
  { name: "a shell whose CWD argument is the package dir", argv: ["sh", "-c", "cd /app/node_modules/openclaw/ && ls"], openclaw: false, gateway: false },
  { name: "sh -c invoking the CLI by name (the command string is -c's value, not a script)", argv: ["sh", "-c", "openclaw gateway run"], openclaw: false, gateway: false },
  { name: "a shell running an unrelated script under an openclaw dir", argv: ["bash", "/opt/openclaw/scripts/rotate-logs.sh"], openclaw: false, gateway: false },
  { name: "the word gateway without OpenClaw", argv: ["node", "/srv/other/gateway.js", "gateway", "run"], openclaw: false, gateway: false },
  { name: "crond", argv: ["/usr/sbin/crond", "-n"], openclaw: false, gateway: false },
  { name: "empty argv (kernel thread)", argv: [], openclaw: false, gateway: false },
];

module.exports = { kOpenclawArgvFixtures };
