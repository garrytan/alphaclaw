const fs = require("fs");
const path = require("path");

// Free space for the volumes AlphaClaw depends on: the one holding the
// OpenClaw state dir, plus the volume Node writes diagnostic reports and heap
// snapshots to when NODE_OPTIONS points them elsewhere. statfs is one cheap
// syscall per volume. free = bavail (what a non-root writer can still use).
// A path that cannot be read yields an "unknown" volume, which never alerts.

const kDiagnosticFlags = Object.freeze([
  { flag: "--diagnostic-dir", id: "diagnostic" },
  { flag: "--report-directory", id: "report" },
  { flag: "--report-dir", id: "report" },
]);

const splitNodeOptions = (value) => {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value || "")))) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
};

// Node's own default (the working directory) is ignored: only an explicit
// flag moves reports onto a volume worth watching on its own.
const parseDiagnosticDirs = (nodeOptions, { cwd = process.cwd() } = {}) => {
  const args = splitNodeOptions(nodeOptions);
  const found = [];
  args.forEach((arg, index) => {
    for (const { flag, id } of kDiagnosticFlags) {
      let value = null;
      if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      else if (arg === flag) value = args[index + 1] ?? null;
      if (!value || value.startsWith("--")) continue;
      const dir = path.resolve(cwd, value);
      if (!found.some((entry) => entry.path === dir)) found.push({ id, path: dir });
    }
  });
  return found;
};

const findMountPoint = (target, dev, fsImpl = fs) => {
  let current = target;
  try { current = fsImpl.realpathSync(target); } catch {}
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    try {
      if (fsImpl.statSync(parent).dev !== dev) return current;
    } catch {
      return current;
    }
    current = parent;
  }
};

const unknownVolume = (id, volumePath, reason) => ({ id, path: volumePath, status: "unknown", reason });

const readDiskVolumes = ({ stateDir, env = process.env, fsImpl = fs } = {}) => {
  const targets = [{ id: "state", path: stateDir }, ...parseDiagnosticDirs(env?.NODE_OPTIONS)];
  const seenDevs = new Set();
  const volumes = [];
  for (const target of targets) {
    if (!target.path) continue;
    let stat;
    try {
      stat = fsImpl.statSync(target.path);
    } catch {
      volumes.push(unknownVolume(target.id, target.path, "missing"));
      continue;
    }
    if (seenDevs.has(stat.dev)) continue;
    seenDevs.add(stat.dev);
    let statfs;
    try {
      statfs = fsImpl.statfsSync(target.path);
    } catch {
      volumes.push(unknownVolume(target.id, target.path, "statfs_failed"));
      continue;
    }
    const sizeBytes = Number(statfs.blocks) * Number(statfs.bsize);
    const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
    if (!(sizeBytes > 0) || !Number.isFinite(freeBytes) || freeBytes < 0) {
      volumes.push(unknownVolume(target.id, target.path, "statfs_invalid"));
      continue;
    }
    volumes.push({
      id: target.id,
      path: target.path,
      mountPath: findMountPoint(target.path, stat.dev, fsImpl),
      dev: stat.dev,
      status: "fresh",
      freeBytes,
      sizeBytes,
    });
  }
  return volumes;
};

module.exports = { parseDiagnosticDirs, readDiskVolumes, findMountPoint };
