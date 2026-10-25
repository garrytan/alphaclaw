// Disk-full facts for the watchdog: does gateway or Doctor output say the disk
// ran out (ENOSPC, or EDQUOT for a quota), how much space is free on the
// disks the gateway writes to, and the one sentence the incident, the notice
// and the status card show. Output is untrusted text, so it only ever
// suggests a full disk; the free space measured here is what the watchdog
// acts on.
const fs = require("fs");
const path = require("path");

const kDiskFullPattern = /\bENOSPC\b|no space left on device|\bEDQUOT\b|disk quota exceeded/i;
const kMegabyte = 1024 * 1024;

const nearestExistingDirectory = (target, fsModule) => {
  let current = path.resolve(String(target));
  for (;;) {
    try {
      if (fsModule.statSync(current).isDirectory()) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
};

// The fullest of `dirs` as { dir, freeBytes } (bytes available to this
// user), or null when none of them can be measured.
const measureFullestDisk = (dirs = [], { statfs = (target) => fs.statfsSync(target), fsModule = fs } = {}) => {
  let fullest = null;
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const stats = statfs(nearestExistingDirectory(dir, fsModule));
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(freeBytes) || freeBytes < 0) continue;
      if (!fullest || freeBytes < fullest.freeBytes) fullest = { dir, freeBytes };
    } catch {}
  }
  return fullest;
};

const formatMegabytes = (bytes) => `${Math.max(0, Math.floor(Number(bytes) / kMegabyte))} MB`;

const describeDiskFull = ({ dir, freeBytes }) =>
  `The disk holding ${dir} is full (${formatMegabytes(freeBytes)} free); the gateway can't start until space is freed.`;

// What a signed-out person may read: that the disk is full, never which disk
// or how much is left.
const kPublicDiskFullMessage =
  "The server's disk is full, so signing in and saving changes fail until space is freed on it.";
const kDiskFullErrorCodes = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL"]);
const isDiskFullError = (err) =>
  kDiskFullErrorCodes.has(err?.code) ||
  /database or disk is full/i.test(String(err?.message || "")) ||
  kDiskFullPattern.test(String(err?.message || ""));

// The login page's notice: shown while a request failed for space in the last
// few minutes, or while the disk measures nearly empty.
const createPublicDiskFullNotice = ({
  dirs = [],
  measure = measureFullestDisk,
  floorBytes = 16 * kMegabyte,
  recentMs = 10 * 60 * 1000,
  nowFn = Date.now,
} = {}) => {
  let lastErrorAt = 0;
  return {
    noteError: () => {
      lastErrorAt = nowFn();
    },
    read: () => {
      const recent = lastErrorAt > 0 && nowFn() - lastErrorAt < recentMs;
      if (!recent && !((measure(dirs)?.freeBytes ?? Infinity) < floorBytes)) return null;
      return { code: "disk_full", message: kPublicDiskFullMessage };
    },
  };
};

module.exports = {
  kDiskFullPattern,
  kPublicDiskFullMessage,
  isDiskFullError,
  createPublicDiskFullNotice,
  describeDiskFull,
  formatMegabytes,
  measureFullestDisk,
};
