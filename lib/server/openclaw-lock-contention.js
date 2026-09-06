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

// ── Gateway process patterns (two, deliberately different) ──────────────────
// EVIDENCE pattern: any gateway-ish openclaw process — a `gateway run` child,
// a `gateway --force` supervisor, the `openclaw-gateway` binary, but ALSO the
// one-shot CLI verbs (`gateway status|stop|restart|call`). Right for the
// restart-incumbent verdict and human evidence lines, where an over-inclusive
// pid list only makes a swap harder to prove (never a false success).
const kGatewayProcessPattern = /(^|\s)gateway(\s|$)|openclaw-gateway/;
// SERVING pattern: only processes that can OWN the gateway port — the long-
// running `gateway run` worker, the `gateway --force` launcher that stays as
// its process-tree root, or the `openclaw-gateway` binary. CLI verbs are
// excluded on purpose: a `gateway status` invoked by the operator (or by our
// own doctor) must never be adopted as the serving identity, sampled for
// memory, or counted as a second root that makes the identity ambiguous.
const kGatewayServingCmdlinePattern =
  /(^|\s)gateway\s+(run|--force)(\s|$)|openclaw-gateway/;

// Ownership-conflict wording a LOSING gateway contender prints on exit 1
// (verified against the published 2026.7.1-2 and 2026.9.1-beta.1 tarballs;
// registered in the TODOS belt-deletion list — upstream openclaw#121069 asks
// for a structured owner report). Two families:
//   gateway_conflict      another GATEWAY holds the port/lock: "another
//                         gateway instance is already listening", "gateway
//                         already running (pid N)", "failed to acquire
//                         gateway lock at <path>", "owns state-lifecycle",
//                         "existing gateway did not become healthy after …"
//   state_writer_conflict another embedded OpenClaw STATE WRITER (an agent
//                         process, a migration) holds the state directory:
//                         "state directory is locked by <role> (pid N)",
//                         "another embedded OpenClaw state writer is active
//                         (pid N)", "failed to acquire gateway state ownership"
// This is classification of stderr, not a query of the upstream lock owner.
const kGatewayOwnershipConflictPattern =
  /another gateway instance is already listening|gateway already running|failed to acquire gateway lock at|owns state-lifecycle|state directory is locked by|another embedded openclaw state writer is active|failed to acquire gateway state ownership|existing gateway did not become healthy/i;
const kStateWriterConflictPattern =
  /state directory is locked by|another embedded openclaw state writer|failed to acquire gateway state ownership/i;
const kConflictHolderPidPattern = /\(pid (\d+)\)/i;
const kConflictHolderRolePattern = /state directory is locked by ([^\s(]+)/i;

// null when the text carries no ownership-conflict wording; otherwise the
// family plus whatever the message names about the holder (pid, role).
const classifyOwnershipConflict = (text) => {
  const source = String(text ?? "");
  if (!kGatewayOwnershipConflictPattern.test(source)) return null;
  const pidMatch = source.match(kConflictHolderPidPattern);
  const roleMatch = source.match(kConflictHolderRolePattern);
  return {
    kind: kStateWriterConflictPattern.test(source)
      ? "state_writer_conflict"
      : "gateway_conflict",
    holderPid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    holderRole: roleMatch ? roleMatch[1] : null,
  };
};

// /proc/<pid>/stat: `<pid> (<comm>) <state> <ppid> … <starttime>` — the comm
// may contain spaces and parentheses, so fields are split AFTER the last ")".
// From there: index 0 = state (field 3), index 1 = ppid (field 4), index 19 =
// starttime in clock ticks since boot (field 22). Start ticks are the
// identity a pid number lacks: a reused pid has different start ticks, which
// is exactly how upstream's own owner check tells a live holder from a corpse.
const kProcStatStartTicksIndex = 19;
const kProcStatParentPidIndex = 1;
const parseProcStat = (raw) => {
  const text = String(raw ?? "");
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const startTicks = Number.parseInt(fields[kProcStatStartTicksIndex] ?? "", 10);
  const parentPid = Number.parseInt(fields[kProcStatParentPidIndex] ?? "", 10);
  return {
    parentPid: Number.isInteger(parentPid) && parentPid >= 0 ? parentPid : null,
    startTicks: Number.isInteger(startTicks) && startTicks >= 0 ? startTicks : null,
  };
};

const readProcStat = (pid, fsModule) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStat(fsModule.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null; // exited / unreadable / non-Linux
  }
};

// number | null — never throws.
const readProcStartTicks = (pid, { fsModule = fs } = {}) =>
  readProcStat(pid, fsModule)?.startTicks ?? null;

// number | null — never throws.
const readProcParentPid = (pid, { fsModule = fs } = {}) =>
  readProcStat(pid, fsModule)?.parentPid ?? null;

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
//
// `match(argv)` narrows the scan BEFORE the cap and `limit` sets the cap
// (default kMaxListed — right for the human evidence lines, wrong for a pid
// VERDICT): /proc lists pids ascending, so a cap applied to every
// openclaw-ish process on a busy host drops exactly the newest pids — the
// freshly spawned supervisor/gateway the restart-incumbent predicate must
// see. The gateway pid snapshot passes its own pattern and no cap.
const listLiveOpenclawProcesses = ({
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  isZombie = defaultIsZombie,
  selfPid = process.pid,
  match = null,
  limit = kMaxListed,
} = {}) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return [];
  }
  const cap =
    limit === Infinity ? Infinity : Number.isFinite(limit) && limit > 0 ? limit : kMaxListed;
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const raw = readCmdline(pid);
    if (!raw) continue; // kernel threads / exited / unreadable
    const argv = parseProcCmdline(raw);
    if (!isOpenclawArgv(argv)) continue;
    if (typeof match === "function" && !match(argv)) continue;
    if (isZombie(pid)) continue;
    found.push({ pid, cmdline: argv.join(" ").slice(0, kMaxCmdlineChars) });
    if (found.length >= cap) break;
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
  kGatewayProcessPattern,
  kGatewayServingCmdlinePattern,
  kGatewayOwnershipConflictPattern,
  classifyOwnershipConflict,
  parseProcStat,
  readProcStartTicks,
  readProcParentPid,
  describeLockContention,
  listLiveOpenclawProcesses,
  listLockDirs,
  looksLikeLockContention,
  isOpenclawArgv,
  parseProcCmdline,
};
