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

module.exports = {
  kDiskFullPattern,
  describeDiskFull,
  formatMegabytes,
  measureFullestDisk,
};
