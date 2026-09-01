// Best-effort sweep of stale upstream openclaw state-lifecycle locks.
//
// Incident 2026-09-01: a container kill mid-boot left /tmp/openclaw-state-locks-0
// behind; every subsequent gateway boot (and every CLI invocation — openclaw
// >= 2026.9.1-beta.1 serializes ALL CLI work on this lock) wedged on it until
// a human intervened. This module clears provably-abandoned locks before we
// launch the gateway.
//
// UPSTREAM-INTERNALS COUPLING: the lock directory name/layout belongs to
// openclaw, not us. Verified against openclaw 2026.9.1-beta.1 (lock entries
// observed at `${tmpdir}/openclaw-state-locks-<n>`; no documented owner
// metadata — hence the explicit-pid + mtime heuristics below). An upstream
// rename degrades this belt to a harmless no-op (see the zero-match
// breadcrumb). Upstream lock ownership/fencing is under design
// (openclaw/openclaw#121069) — re-verify this module against whatever lands,
// and delete it once upstream owns cleanup.
//
// SAFETY DOCTRINE (reviewed twice, cross-model):
//   - Live owners are sacred: a lock whose pid is alive AND whose
//     /proc/<pid>/cmdline looks like openclaw/node is kept unconditionally.
//   - Alive + provably-foreign cmdline is PID-reuse *proof* (new namespace
//     recycled the number) => removable.
//   - Unknown is never dead: unreadable cmdline, EPERM, weird kill errnos,
//     unparseable pid files => keep.
//   - PID-less entries are removed only when demonstrably abandoned: at boot
//     when a /proc scan shows NO live openclaw process at all, or after 30
//     minutes with the gateway port observed released.
//   - Never probe or delete through symlinks; never touch foreign-uid
//     entries; deletion goes through an atomic quarantine-rename so a racing
//     freshly-created legitimate lock can never be the thing we rm.
//   - Every decision is logged under [state-lock-sweep]; a silent keep is
//     how the original incident stayed invisible.
const fs = require("fs");
const os = require("os");
const path = require("path");

const kLockEntryPattern = /^openclaw-state-locks(-\d+)?$/;
const kMaxPidFileBytes = 4096;
const kMaxDirProbeEntries = 10;
const kStaleMtimeMs = 30 * 60 * 1000;
const kMaxLinuxPid = 4194304;
const kOpenclawishCmdline = /openclaw|(^|\/)node(\s|$|\0)/i;

const defaultReadCmdline = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
};

// Bounded /proc scan: is any OTHER live process openclaw-ish? Used only at
// boot, where "no live openclaw anywhere" makes PID-less locks provably
// abandoned. Returns true/false, or null when /proc is unavailable (macOS,
// hardened mounts) — callers treat null as "unknown ⇒ keep".
const defaultHasLiveOpenclawProcess = ({
  fsModule = fs,
  readCmdline = defaultReadCmdline,
  selfPid = process.pid,
} = {}) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const cmdline = readCmdline(pid);
    // Only "openclaw" counts here: alphaclaw itself (and this very process's
    // node workers) legitimately run node, and treating every node process
    // as a lock owner would neuter the boot rule entirely.
    if (cmdline && /openclaw/i.test(cmdline)) return true;
  }
  return false;
};

const extractPidFromText = (text) => {
  const raw = String(text ?? "").slice(0, kMaxPidFileBytes);
  if (!raw.trim()) return { pid: null, source: "empty" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.pid !== undefined) {
        const pid = Number(parsed.pid);
        return { pid: Number.isInteger(pid) ? pid : NaN, source: "json" };
      }
      // Valid JSON with NO top-level pid: a nested `"pid":` (a worker list,
      // a lastOwner record) does NOT name the current holder — falling
      // through to the fragment regex here could read a dead sub-pid and
      // clear a LIVE owner's lock. PID-less on purpose.
      return { pid: null, source: "json_no_pid" };
    }
  } catch {
    // Unparseable/truncated content only: fall through to the line form.
  }
  // Explicit pid-named line ONLY (`pid=123` / `pid: 123`). No bare
  // first-integer fallback: a timestamp-first payload would parse as a huge
  // int, kill() would throw, and a LIVE owner's lock would read as dead.
  const match = raw.match(/(?:^|[\n\r{,\s])"?pid"?\s*[=:]\s*"?(\d{1,10})/i);
  if (match) return { pid: Number(match[1]), source: "line" };
  return { pid: null, source: "none" };
};

const readEntryPid = ({ fullPath, stats, fsModule }) => {
  try {
    if (stats.isFile()) {
      return extractPidFromText(
        fsModule.readFileSync(fullPath, "utf8").slice(0, kMaxPidFileBytes),
      );
    }
    if (stats.isDirectory()) {
      const children = fsModule.readdirSync(fullPath).slice(0, kMaxDirProbeEntries);
      for (const child of children) {
        if (!/^(pid|owner)$|\.lock$/i.test(child)) continue;
        const childPath = path.join(fullPath, child);
        const childStats = fsModule.lstatSync(childPath);
        if (!childStats.isFile()) continue; // never read through symlinks
        const found = extractPidFromText(
          fsModule.readFileSync(childPath, "utf8").slice(0, kMaxPidFileBytes),
        );
        if (found.pid !== null) return found;
      }
    }
  } catch {
    return { pid: null, source: "error" };
  }
  return { pid: null, source: "none" };
};

const probeAlive = (pid, killFn) => {
  try {
    killFn(pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    if (error && error.code === "EPERM") return "alive"; // exists, other uid
    return "unknown"; // RangeError/EINVAL/anything else: unknown ≠ dead
  }
};

// Pure per-entry decision. Returns { action: "clear"|"keep", reason }.
const decideLockEntry = ({
  stats,
  selfUid,
  pidInfo,
  alive,
  cmdline,
  ageMs,
  site,
  portReleased,
  noLiveOpenclaw,
}) => {
  if (!stats.isFile() && !stats.isDirectory()) {
    return { action: "keep", reason: "symlink_or_special" };
  }
  if (
    typeof selfUid === "number" &&
    typeof stats.uid === "number" &&
    stats.uid !== selfUid
  ) {
    return { action: "keep", reason: "foreign_uid" };
  }
  if (pidInfo.pid !== null) {
    if (
      !Number.isInteger(pidInfo.pid) ||
      pidInfo.pid <= 1 ||
      pidInfo.pid > kMaxLinuxPid
    ) {
      return { action: "keep", reason: "invalid_pid" };
    }
    if (alive === "dead") return { action: "clear", reason: "dead_owner" };
    if (alive === "unknown") return { action: "keep", reason: "kill_unknown" };
    // alive
    if (cmdline === null) return { action: "keep", reason: "live_unverified" };
    if (kOpenclawishCmdline.test(cmdline)) {
      return { action: "keep", reason: "live_owner" };
    }
    // Readable, provably-foreign cmdline: the pid was recycled by an
    // unrelated process after a namespace reset — the lock's real owner is
    // gone. This is the incident's own killed-boot shape.
    return { action: "clear", reason: "pid_reused" };
  }
  // PID-less entries.
  if (site === "boot" && noLiveOpenclaw === true) {
    return { action: "clear", reason: "boot_no_live_openclaw" };
  }
  if (ageMs > kStaleMtimeMs && portReleased === true) {
    return { action: "clear", reason: "stale_mtime" };
  }
  return { action: "keep", reason: "young_or_unproven" };
};

// Atomic reap: rename to a quarantine name first (atomic on the same fs), so
// a legitimate lock recreated under the ORIGINAL name between our inspection
// and the delete is untouched; only the quarantined inode is removed. The
// POST-rename verify is the load-bearing half: the rename grabs whatever
// currently sits at the name, so we compare the quarantined inode against
// the one we actually inspected — on mismatch (a fresh legitimate lock won
// the race) it is renamed straight back, untouched.
const reapEntry = ({ fullPath, fsModule, inspected }) => {
  const quarantinePath = `${fullPath}.reaping.${process.pid}`;
  fsModule.renameSync(fullPath, quarantinePath);
  let quarantined = null;
  try {
    quarantined = fsModule.lstatSync(quarantinePath);
  } catch {
    quarantined = null;
  }
  if (
    !quarantined ||
    (inspected &&
      (quarantined.ino !== inspected.ino ||
        quarantined.isFile() !== inspected.isFile() ||
        quarantined.isDirectory() !== inspected.isDirectory()))
  ) {
    try {
      fsModule.renameSync(quarantinePath, fullPath);
    } catch {}
    return false;
  }
  try {
    fsModule.rmSync(quarantinePath, { recursive: true, force: true });
  } catch (error) {
    try {
      fsModule.renameSync(quarantinePath, fullPath);
    } catch {}
    throw error;
  }
  return true;
};

const sweepStaleOpenclawStateLocks = ({
  tmpDir = os.tmpdir(),
  fsModule = fs,
  nowFn = Date.now,
  killFn = (pid, signal) => process.kill(pid, signal),
  readCmdline = defaultReadCmdline,
  hasLiveOpenclawProcess = null,
  log = (msg) => console.log(msg),
  site = "cold_start", // "boot" | "launch" | "cold_start"
  portReleased = null,
  afterFailedReady = false,
} = {}) => {
  const result = { cleared: [], kept: [], errors: [] };
  // Kill switch read PER CALL (tests re-enable per case; ops can flip it and
  // restart without a rebuild). Deployment-only env — never honored from the
  // agent-writable .env (see lib/server/deployment-only-env.js).
  if (process.env.ALPHACLAW_STATE_LOCK_SWEEP_DISABLED === "1") {
    return result;
  }
  let names;
  try {
    names = fsModule.readdirSync(tmpDir);
  } catch (error) {
    result.errors.push({ path: tmpDir, error: String(error?.code || error) });
    return result;
  }
  // Name-filter BEFORE any lstat — never stat all of /tmp.
  const matches = names.filter((name) => kLockEntryPattern.test(name));
  if (matches.length === 0) {
    if (afterFailedReady) {
      // Belt-disarmed breadcrumb: a readiness wait just failed and the sweep
      // found NOTHING matching — either the failure has another cause, or
      // upstream renamed the lock dir and this belt is a silent no-op now.
      log(
        `[state-lock-sweep] zero entries matched in ${tmpDir} after a failed readiness wait — if openclaw renamed its state-lock dir this belt is disarmed`,
      );
    }
    return result;
  }
  const selfUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  let noLiveOpenclaw = null;
  if (site === "boot") {
    const scan = hasLiveOpenclawProcess || defaultHasLiveOpenclawProcess;
    const live = scan({ fsModule: fs, readCmdline });
    noLiveOpenclaw = live === null ? null : !live;
  }
  for (const name of matches) {
    const fullPath = path.join(tmpDir, name);
    try {
      const stats = fsModule.lstatSync(fullPath);
      const pidInfo =
        stats.isFile() || stats.isDirectory()
          ? readEntryPid({ fullPath, stats, fsModule })
          : { pid: null, source: "special" };
      const validPid =
        pidInfo.pid !== null &&
        Number.isInteger(pidInfo.pid) &&
        pidInfo.pid > 1 &&
        pidInfo.pid <= kMaxLinuxPid;
      const alive = validPid ? probeAlive(pidInfo.pid, killFn) : null;
      const cmdline = validPid && alive === "alive" ? readCmdline(pidInfo.pid) : null;
      const ageMs = Math.max(0, nowFn() - stats.mtimeMs);
      const decision = decideLockEntry({
        stats,
        selfUid,
        pidInfo,
        alive,
        cmdline,
        ageMs,
        site,
        portReleased,
        noLiveOpenclaw,
      });
      const detail = `pid=${pidInfo.pid ?? "none"} age=${Math.round(ageMs / 1000)}s site=${site}`;
      if (decision.action === "clear") {
        // Quarantine-rename first, verify the QUARANTINED inode against the
        // one we inspected, delete only on match; a racing fresh legitimate
        // lock is renamed straight back untouched (X5 — the pre-rename
        // recheck alone leaves a swap window).
        const reaped = reapEntry({ fullPath, fsModule, inspected: stats });
        if (!reaped) {
          result.kept.push({ path: fullPath, reason: "changed_under_us" });
          log(
            `[state-lock-sweep] kept ${fullPath} (changed_under_us ${detail})`,
          );
          continue;
        }
        result.cleared.push({ path: fullPath, reason: decision.reason });
        log(
          `[state-lock-sweep] cleared ${fullPath} (${decision.reason} ${detail})`,
        );
      } else {
        result.kept.push({ path: fullPath, reason: decision.reason });
        log(
          `[state-lock-sweep] kept ${fullPath} (${decision.reason} ${detail})`,
        );
      }
    } catch (error) {
      result.errors.push({
        path: fullPath,
        error: String(error?.code || error?.message || error),
      });
      log(
        `[state-lock-sweep] error on ${fullPath}: ${String(error?.code || error?.message || error)}`,
      );
    }
  }
  return result;
};

module.exports = {
  sweepStaleOpenclawStateLocks,
  decideLockEntry,
  extractPidFromText,
  defaultHasLiveOpenclawProcess,
};
