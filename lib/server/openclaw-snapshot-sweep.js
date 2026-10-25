// Abandoned OpenClaw SQLite snapshot copies (ALPH-34).
//
// OpenClaw 2026.10.7 reads SQLite databases through a private snapshot: it
// copies the database into a staging directory named
// openclaw-sqlite-readonly-v2-<id> (older builds: openclaw-sqlite-readonly-
// <pid>-<id>) under <XDG_CACHE_HOME or $HOME/.cache>/openclaw, falling back to
// openclaw-<uid> beside it. A copy cut short by a restart or a kill leaves
// fs-safe's staged `.fs-safe-<uuid>.tmp` (a full-size database copy) behind.
// OpenClaw's own reclamation skips such a directory for good: it refuses any
// file it does not recognize ("Unrecognized snapshot artifact"), and it runs
// only on an idle gateway, at most 512 MB per pass. Each orphan is the size of
// the database it copied, several GB on a busy box.
//
// AlphaClaw removes them before each gateway launch, when no gateway serves.
// A directory goes only when everything in it is older than the age floor,
// it belongs to this user, and no process holds a file in it open (OpenClaw's
// snapshot tokens are held file locks, so a live reader always has one).
// Without a readable /proc nothing is removed.
const fs = require("fs");
const os = require("os");
const path = require("path");

const kIdSuffix = "(?:[A-Za-z0-9]{6}|[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12})";
const kSnapshotPattern = new RegExp(`^openclaw-sqlite-readonly-v2-${kIdSuffix}$`);
const kLegacySnapshotPattern = new RegExp(`^openclaw-sqlite-readonly-[1-9]\\d*-${kIdSuffix}$`);
// OpenClaw's own grace is 15 minutes (24 hours for the legacy layout); the
// sweep waits longer and also requires that nothing holds a file open.
const kSnapshotMinAgeMs = 60 * 60 * 1000;
const kLegacySnapshotMinAgeMs = 24 * 60 * 60 * 1000;
const kMaxEntriesPerSnapshot = 10_000;
const kMaxSnapshotsPerSweep = 256;

const resolveSnapshotRoots = (env = process.env, uid = process.getuid?.()) => {
  const xdg = String(env.XDG_CACHE_HOME || "").trim();
  const home = String(env.HOME || "").trim() || os.homedir();
  const cacheRoot = path.isAbsolute(xdg) ? xdg : path.join(home, ".cache");
  return [path.join(cacheRoot, "openclaw"), ...(uid === undefined ? [] : [path.join(cacheRoot, `openclaw-${uid}`)])];
};

// Every path any visible process holds open, or null when /proc can't be read.
const readOpenPaths = (procRoot = "/proc") => {
  let pids;
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const open = new Set();
  for (const pid of pids) {
    let fds;
    try {
      fds = fs.readdirSync(path.join(procRoot, pid, "fd"));
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        open.add(fs.readlinkSync(path.join(procRoot, pid, "fd", fd)));
      } catch {}
    }
  }
  return open;
};

// { bytes, newestMs } of a directory tree, or null when it is not ours or too
// large to inspect. Never follows symlinks.
const measure = (directory, uid) => {
  let bytes = 0;
  let newestMs = 0;
  let entries = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (uid !== undefined && stat.uid !== uid) return null;
    entries += 1;
    if (entries > kMaxEntriesPerSnapshot) return null;
    newestMs = Math.max(newestMs, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else {
      bytes += Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : stat.size;
    }
  }
  return { bytes, newestMs };
};

const isHeld = (directory, openPaths) => {
  const prefix = `${directory}${path.sep}`;
  for (const target of openPaths) {
    if (target === directory || target.startsWith(prefix)) return true;
  }
  return false;
};

const formatBytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

const sweepAbandonedSnapshotCopies = ({
  env = process.env,
  nowMs = Date.now(),
  procRoot = "/proc",
  uid = process.getuid?.(),
  logger = console,
} = {}) => {
  const result = { removed: 0, freedBytes: 0, held: 0, recent: 0, failed: 0 };
  try {
    const candidates = [];
    for (const root of resolveSnapshotRoots(env, uid)) {
      let realRoot;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        continue;
      }
      for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const legacy = kLegacySnapshotPattern.test(entry.name);
        if (!legacy && !kSnapshotPattern.test(entry.name)) continue;
        candidates.push({ directory: path.join(realRoot, entry.name), legacy });
      }
    }
    if (candidates.length === 0) return result;
    const openPaths = readOpenPaths(procRoot);
    if (!openPaths) return result;
    for (const { directory, legacy } of candidates.slice(0, kMaxSnapshotsPerSweep)) {
      try {
        const measured = measure(directory, uid);
        if (!measured) {
          result.failed += 1;
          continue;
        }
        if (nowMs - measured.newestMs < (legacy ? kLegacySnapshotMinAgeMs : kSnapshotMinAgeMs)) {
          result.recent += 1;
          continue;
        }
        if (isHeld(directory, openPaths)) {
          result.held += 1;
          continue;
        }
        fs.rmSync(directory, { recursive: true, force: true });
        result.removed += 1;
        result.freedBytes += measured.bytes;
      } catch {
        result.failed += 1;
      }
    }
  } catch {
    result.failed += 1;
  }
  if (result.removed || result.failed) {
    logger.log(
      `[alphaclaw] snapshot sweep: removed ${result.removed} abandoned OpenClaw SQLite snapshot cop${result.removed === 1 ? "y" : "ies"}, ` +
        `freed ${formatBytes(result.freedBytes)} (kept ${result.held} in use, ${result.recent} recent; ${result.failed} could not be checked)`,
    );
  }
  return result;
};

module.exports = {
  kSnapshotMinAgeMs,
  kLegacySnapshotMinAgeMs,
  resolveSnapshotRoots,
  sweepAbandonedSnapshotCopies,
};
