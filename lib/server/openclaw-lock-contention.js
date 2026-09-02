// Read-only diagnostics for OpenClaw state-lifecycle lock CONTENTION.
//
// Incident 2026-09-01: a restart failed with "another OpenClaw process owns
// state-lifecycle" after a killed boot, and the responder read the leftover
// `/tmp/openclaw-state-locks-<uid>/` entry as a "stale lock". Verified against
// the openclaw 2026.9.1-beta.1 tarball (dist/state-database-coordinator-*.js,
// dist/node-sqlite-*.js): the coordinator is an exclusive SQLite transaction
// (`BEGIN EXCLUSIVE` on `<dir>/<family>.<hash>.lock.sqlite`) held by the
// owner's OPEN connection — a POSIX advisory lock the kernel releases the
// instant the holder dies. There is no lease row, no pid metadata, no expiry:
//   - a leftover lock FILE can never block anyone;
//   - "owns state-lifecycle" ALWAYS names a LIVE holder (or a busy-timeout
//     while one held it) — in the incident, the pre-restart process still
//     shutting down, which exited before the next attempt succeeded;
//   - deleting a held lock file would let a second acquirer take EXCLUSIVE on
//     a fresh inode — two owners of the state DB, the exact corruption the
//     coordinator prevents. So this module NEVER deletes anything.
// What helps a responder is knowing WHICH live process holds it. This mirrors
// upstream's own owner-status approach (dist/gateway-lock-*.js: /proc cmdline
// + isOpenClawArgv) to list live openclaw-ish processes, and appends that to
// restart-failure evidence and the boot log.
const fs = require("fs");
const os = require("os");

const kLockDirPattern = /^openclaw-state-locks(-\d+)?$/;
// Lifecycle-lock refusals + raw SQLite busy signatures (incident 2026-09-01).
const kLifecycleContentionPattern =
  /owns (state|gateway)-lifecycle|state-lifecycle|gateway-lifecycle|state-locks|SQLITE_BUSY|database is locked/i;
// State-lease failures (issue #54, verified against the 2026.9.1-beta.1 dist):
// the lease holder logs "SQLite transaction lock wait failed" when its UPDATE
// hits busy_timeout 0, then renew() throws OPENCLAW_STATE_LEASE_LOST
// ("<label> <scope>/<key> was lost"); acquire() fails with
// OPENCLAW_STATE_LEASE_TIMEOUT ("timed out waiting for <label> <scope>/<key>")
// after its 5 s wait or OPENCLAW_STATE_LEASE_STORAGE_FAILED ("failed to
// acquire <label> <scope>/<key>"). The word "lease" immediately before the
// <scope>/<key> token (one slash, no spaces) is what keeps "failed to
// acquire" / "timed out waiting for" from over-matching an ordinary URL or
// file path ("timed out waiting for https://host/path", "failed to acquire
// artifact /tmp/file") — a false lock_contention verdict would retry inside
// the quiesce and make the failure reuse-eligible. The label is several words
// on the real CLIs ("legacy audit migration lease", verified live on 2026.8.2
// and 2026.9.1-beta.1) and always ends in "lease", so the label slot is a
// bounded same-line span terminated by that word, never a single token.
const kStateLeasePattern =
  /SQLite transaction lock wait failed|OPENCLAW_STATE_LEASE_(?:LOST|TIMEOUT|STORAGE_FAILED)|\blease \S+\/\S+ was lost\b|timed out waiting for [^\n]{0,120}?\blease \S+\/\S+|failed to acquire [^\n]{0,120}?\blease \S+\/\S+/i;
// ONE source for both consumers: the restart/boot evidence path
// (looksLikeLockContention) and the backup classifier's lock_contention kind.
const kStateContentionPattern = new RegExp(
  `${kLifecycleContentionPattern.source}|${kStateLeasePattern.source}`,
  "i",
);
const kMaxCmdlineChars = 200;
const kMaxListed = 12;

const defaultReadCmdline = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
};

const defaultIsZombie = (pid) => {
  try {
    return (
      fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(\S)/m)?.[1] ===
      "Z"
    );
  } catch {
    return false;
  }
};

// Upstream's classification (isOpenClawArgv): the executable token is
// `openclaw`/`.../openclaw`, or any argv token ends with an openclaw entry
// script. We additionally accept `/openclaw/` path segments in any token (a
// `node /app/node_modules/openclaw/dist/entry.js gateway run` child).
const isOpenclawArgv = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const exe = String(argv[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  if (exe === "openclaw" || exe.endsWith("/openclaw") || exe.endsWith("openclaw-gateway")) {
    return true;
  }
  return argv.some((arg) => /(^|\/)openclaw(\/|$|\.m?js$)/i.test(String(arg ?? "")));
};

const parseProcCmdline = (raw) =>
  String(raw ?? "")
    .split("\0")
    .filter((entry) => entry.length > 0);

// Bounded /proc scan: live, non-zombie, non-self processes whose argv is
// openclaw-ish. Returns [] on non-Linux / unreadable /proc (never throws).
const listLiveOpenclawProcesses = ({
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  isZombie = defaultIsZombie,
  selfPid = process.pid,
} = {}) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const raw = readCmdline(pid);
    if (!raw) continue; // kernel threads / exited / unreadable
    const argv = parseProcCmdline(raw);
    if (!isOpenclawArgv(argv)) continue;
    if (isZombie(pid)) continue;
    found.push({ pid, cmdline: argv.join(" ").slice(0, kMaxCmdlineChars) });
    if (found.length >= kMaxListed) break;
  }
  return found;
};

const listLockDirs = ({ tmpDir = os.tmpdir(), fsModule = fs } = {}) => {
  try {
    return fsModule.readdirSync(tmpDir).filter((name) => kLockDirPattern.test(name));
  } catch {
    return [];
  }
};

const looksLikeLockContention = (text) =>
  kStateContentionPattern.test(String(text ?? ""));

// Human lines for evidence tails / process.log. Never throws.
const describeLockContention = ({
  site = "restart",
  tmpDir = os.tmpdir(),
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  isZombie = defaultIsZombie,
  selfPid = process.pid,
} = {}) => {
  const live = listLiveOpenclawProcesses({ fsModule, readCmdline, isZombie, selfPid });
  const lockDirs = listLockDirs({ tmpDir, fsModule });
  const lines = [];
  if (live.length > 0) {
    lines.push(
      `[alphaclaw] ${site}: ${live.length} live openclaw process(es) — a lifecycle lock holder is one of these: ${live
        .map((p) => `pid ${p.pid} (${p.cmdline})`)
        .join("; ")}`,
    );
  } else {
    lines.push(
      `[alphaclaw] ${site}: no live openclaw processes found — a lifecycle-lock refusal here would mean the holder already exited (retry should succeed)`,
    );
  }
  if (lockDirs.length > 0) {
    lines.push(
      `[alphaclaw] ${site}: lock dir(s) present in ${tmpDir}: ${lockDirs.join(", ")} — informational only; the coordinator is an exclusive SQLite transaction released on holder exit, so these files never block by themselves and must never be deleted while a holder may be live`,
    );
  }
  return { live, lockDirs, lines };
};

module.exports = {
  kStateContentionPattern,
  describeLockContention,
  listLiveOpenclawProcesses,
  listLockDirs,
  looksLikeLockContention,
  isOpenclawArgv,
  parseProcCmdline,
};
