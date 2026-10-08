// Who is the gateway, really? Linux /proc readers behind the stop ladder in
// gateway.js. The managed child AlphaClaw spawns is OpenClaw's compile-cache
// launcher (`openclaw.mjs` respawns a worker whenever Node's compile-cache
// leaf differs from the packaged one, which it does under AlphaClaw's
// NODE_COMPILE_CACHE) — the process that owns the port is the launcher's
// child. Nothing here signals a process; it only answers "which pids, do
// they still carry the start ticks we saw, and who holds the listener".
// Every reader returns [] / null off Linux or on an unreadable /proc.
const fs = require("fs");
const lockContention = require("./openclaw-lock-contention");

const kMaxProcScan = 8192;
// /proc/net/tcp socket state column: 0A = LISTEN.
const kTcpListenState = "0A";
// /proc/<pid>/stat after the comm: index 2 is pgrp (field 5).
const kProcStatPgrpIndex = 2;

const listProcPids = (fsModule = fs) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return [];
  }
  const pids = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    if (pids.length >= kMaxProcScan) break;
    pids.push(Number.parseInt(name, 10));
  }
  return pids;
};

// Direct children of `pid` (PPid links). Bounded, synchronous, never throws.
const listChildPids = (pid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const children = [];
  for (const candidate of listProcPids(fsModule)) {
    if (candidate === pid) continue;
    if (lockContention.readProcParentPid(candidate, { fsModule }) === pid) {
      children.push(candidate);
    }
  }
  return children;
};

// `pid` and every descendant, breadth-first, parents before children (so a
// caller signalling in order reaches the launcher before its worker).
const listProcessTree = (pid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const tree = [pid];
  const seen = new Set(tree);
  for (let i = 0; i < tree.length && tree.length < kMaxProcScan; i += 1) {
    for (const child of listChildPids(tree[i], { fsModule })) {
      if (seen.has(child)) continue;
      seen.add(child);
      tree.push(child);
    }
  }
  return tree;
};

// Process group id from /proc/<pid>/stat (null when unreadable).
const readProcessGroupId = (pid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw;
  try {
    raw = fsModule.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const pgrp = Number.parseInt(raw.slice(close + 1).trim().split(/\s+/)[kProcStatPgrpIndex] ?? "", 10);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
};

const parseListeningInodes = (raw, port) => {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const line of String(raw || "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    if (!cols[1].endsWith(`:${hexPort}`) || cols[3] !== kTcpListenState) continue;
    inodes.add(cols[9]);
  }
  return inodes;
};

// Pids holding a LISTEN socket on `port` (IPv4 and IPv6), via the socket
// inode in /proc/net/tcp{,6} matched against every /proc/<pid>/fd link.
// Unique, ascending. [] when nothing listens or /proc is unavailable.
const findPortListenerPids = (port, { fsModule = fs } = {}) => {
  if (!Number.isInteger(port) || port <= 0) return [];
  const inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const inode of parseListeningInodes(fsModule.readFileSync(table, "utf8"), port)) {
        inodes.add(inode);
      }
    } catch {
      // table missing (no IPv6, non-Linux) — the other one may still answer
    }
  }
  if (inodes.size === 0) return [];
  const targets = new Set(Array.from(inodes, (inode) => `socket:[${inode}]`));
  const owners = new Set();
  for (const pid of listProcPids(fsModule)) {
    let fds;
    try {
      fds = fsModule.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // not ours to read, or raced with exit
    }
    for (const fd of fds) {
      try {
        if (targets.has(fsModule.readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          owners.add(pid);
          break;
        }
      } catch {}
    }
  }
  return Array.from(owners).sort((a, b) => a - b);
};

// Does /proc/<pid>/cmdline look like an OpenClaw process at all? A listener
// that is not one is a foreign service on our port — never a kill target.
const isOpenclawPid = (pid, { fsModule = fs } = {}) => {
  try {
    const argv = String(fsModule.readFileSync(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .filter(Boolean);
    return lockContention.isOpenclawArgv(argv);
  } catch {
    return false;
  }
};

// A pid is "the same process we resolved" only while its start ticks match
// the snapshot taken at resolve time; a reused pid has different ticks. null
// ticks (unreadable at resolve) can only be confirmed by liveness.
const isSameProcess = (pid, startTicks, { fsModule = fs } = {}) => {
  if (!lockContention.pidAlive(pid)) return false;
  if (startTicks == null) return true;
  return lockContention.readProcStartTicks(pid, { fsModule }) === startTicks;
};

module.exports = {
  listChildPids,
  listProcessTree,
  readProcessGroupId,
  findPortListenerPids,
  isOpenclawPid,
  isSameProcess,
  // Exported for tests.
  parseListeningInodes,
};
