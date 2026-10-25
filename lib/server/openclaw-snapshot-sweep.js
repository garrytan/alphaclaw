// Abandoned OpenClaw SQLite snapshot copies (ALPH-34, ALPH-36).
//
// OpenClaw 2026.10.7 reads SQLite databases through a private snapshot: it
// copies the database into a staging directory named
// openclaw-sqlite-readonly-v2-<id> (older builds: openclaw-sqlite-readonly-
// <pid>-<id>) under <XDG_CACHE_HOME or $HOME/.cache>/openclaw, falling back to
// openclaw-<uid> beside it. A copy cut short by a restart, a kill or a failed
// read leaves fs-safe's staged `.fs-safe-<uuid>.tmp` (a full-size database
// copy) behind, and a running gateway leaves a new one every 30-60 minutes.
// OpenClaw's own reclamation skips such a directory for good: it refuses any
// file it does not recognize ("Unrecognized snapshot artifact"), and it runs
// only on an idle gateway, at most 512 MB per pass. Each orphan is the size of
// the database it copied, several GB on a busy box.
//
// AlphaClaw removes them before each gateway launch and every 30 minutes
// while the gateway runs (the watchdog's snapshot sweep timer). A directory
// goes only when it belongs to this user, its copy is older than the age
// floor, and no process holds a file in it open, read from /proc right before
// the delete (OpenClaw's snapshot tokens are held file locks, so a live reader
// always has one). The age is the newest mtime of the copy's own files:
// directory mtimes move whenever an entry is created or removed, and the
// owner.sqlite* token files are touched by OpenClaw's lock traffic, so neither
// says when the copy was written (OpenClaw's reclamation skips the token
// files the same way). Without a readable /proc nothing is removed. Every
// sweep logs one line with what it saw.
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
const kSnapshotSweepIntervalMs = 30 * 60 * 1000;
const kMaxEntriesPerSnapshot = 10_000;
const kTokenFiles = new Set(["owner.sqlite", "owner.sqlite-journal", "owner.sqlite-wal", "owner.sqlite-shm"]);
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
// large to inspect. newestMs is the newest copy file; token files count only
// when there is no other file, and the directory's own mtime only when it
// holds no file at all. Never follows symlinks.
const measure = (directory, uid) => {
  let bytes = 0;
  let copyMs = 0;
  let tokenMs = 0;
  let directoryMs = 0;
  let entries = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (uid !== undefined && stat.uid !== uid) return null;
    entries += 1;
    if (entries > kMaxEntriesPerSnapshot) return null;
    if (stat.isDirectory()) {
      directoryMs = Math.max(directoryMs, stat.mtimeMs);
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
      continue;
    }
    bytes += Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : stat.size;
    if (kTokenFiles.has(path.basename(current))) tokenMs = Math.max(tokenMs, stat.mtimeMs);
    else copyMs = Math.max(copyMs, stat.mtimeMs);
  }
  return { bytes, newestMs: copyMs || tokenMs || directoryMs };
};

const isHeld = (directory, openPaths) => {
  const prefix = `${directory}${path.sep}`;
  for (const target of openPaths) {
    if (target === directory || target.startsWith(prefix)) return true;
  }
  return false;
};

// Every snapshot directory in OpenClaw's staging roots, as { directory,
// legacy }. Never follows a symlinked entry.
const listSnapshotDirectories = ({ env = process.env, uid = process.getuid?.() } = {}) => {
  const directories = [];
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
      directories.push({ directory: path.join(realRoot, entry.name), legacy });
    }
  }
  return directories;
};

const formatBytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

const formatSweepLine = (trigger, result) => {
  const skipped = result.held + result.recent + result.failed + result.unverified;
  return (
    `[alphaclaw] snapshot sweep (${trigger}): ${result.candidates} candidate${result.candidates === 1 ? "" : "s"}, ` +
    `removed ${result.removed} (${formatBytes(result.freedBytes)}), ` +
    `skipped ${skipped} (${result.held} in use, ${result.recent} under the age floor, ` +
    `${result.failed} not ours or unreadable, ${result.unverified} unchecked without /proc; ${formatBytes(result.keptBytes)} kept)`
  );
};

const sweepAbandonedSnapshotCopies = ({
  env = process.env,
  nowMs = Date.now(),
  procRoot = "/proc",
  uid = process.getuid?.(),
  trigger = "launch",
  // A run that knows which directories it is responsible for (a CLI it just
  // killed) passes them with a shorter age: the copy's files must still have
  // been quiet that long, and the open-file check still applies.
  onlyDirectories = null,
  minAgeMs = null,
  logger = console,
} = {}) => {
  const result = { candidates: 0, removed: 0, freedBytes: 0, held: 0, recent: 0, failed: 0, unverified: 0, keptBytes: 0 };
  try {
    const candidates = listSnapshotDirectories({ env, uid }).filter(
      ({ directory }) => !onlyDirectories || onlyDirectories.has(directory),
    );
    result.candidates = candidates.length;
    result.failed += Math.max(0, candidates.length - kMaxSnapshotsPerSweep);
    for (const { directory, legacy } of candidates.slice(0, kMaxSnapshotsPerSweep)) {
      let measured = null;
      try {
        measured = measure(directory, uid);
        if (!measured) {
          result.failed += 1;
          continue;
        }
        const floorMs = minAgeMs ?? (legacy ? kLegacySnapshotMinAgeMs : kSnapshotMinAgeMs);
        if (nowMs - measured.newestMs < floorMs) {
          result.recent += 1;
          result.keptBytes += measured.bytes;
          continue;
        }
        const openPaths = readOpenPaths(procRoot);
        if (!openPaths) {
          result.unverified += 1;
          result.keptBytes += measured.bytes;
          continue;
        }
        if (isHeld(directory, openPaths)) {
          result.held += 1;
          result.keptBytes += measured.bytes;
          continue;
        }
        fs.rmSync(directory, { recursive: true, force: true });
        result.removed += 1;
        result.freedBytes += measured.bytes;
      } catch {
        result.failed += 1;
        if (measured) result.keptBytes += measured.bytes;
      }
    }
  } catch {
    result.failed += 1;
  }
  logger.log(formatSweepLine(trigger, result));
  return result;
};

// An openclaw CLI killed mid-copy leaves its copy behind at once: doctor
// --lint copies the whole agent database four times and outlives its 60 s
// timeout on a multi-GB database (ALPH-36). Call before spawning; after a
// kill, sweepAfterKill() removes only the directories that appeared since,
// once their files have been quiet for kKilledRunQuietMs and no process holds
// one open.
const kKilledRunQuietMs = 10_000;
const trackSnapshotCopiesOfRun = ({ env = process.env, uid = process.getuid?.(), logger = console, trigger = "killed-run" } = {}) => {
  const list = () => {
    try {
      return listSnapshotDirectories({ env, uid }).map(({ directory }) => directory);
    } catch {
      return [];
    }
  };
  const before = new Set(list());
  return {
    sweepAfterKill: () => {
      const timer = setTimeout(() => {
        const created = new Set(list().filter((directory) => !before.has(directory)));
        if (created.size === 0) return;
        sweepAbandonedSnapshotCopies({ env, uid, logger, trigger, onlyDirectories: created, minAgeMs: kKilledRunQuietMs });
      }, kKilledRunQuietMs);
      timer.unref?.();
    },
  };
};

module.exports = {
  kKilledRunQuietMs,
  kSnapshotMinAgeMs,
  kSnapshotSweepIntervalMs,
  kLegacySnapshotMinAgeMs,
  listSnapshotDirectories,
  resolveSnapshotRoots,
  sweepAbandonedSnapshotCopies,
  trackSnapshotCopiesOfRun,
};
