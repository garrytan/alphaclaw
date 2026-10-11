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

// Numeric /proc entries, capped at kMaxProcScan; `capped` says the cap cut
// the listing short (a reader that must be exhaustive treats that as
// incomplete, see findPortListeners).
const scanProcPids = (fsModule = fs) => {
  let entries;
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return { pids: [], capped: false };
  }
  const pids = [];
  let capped = false;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    if (pids.length >= kMaxProcScan) {
      capped = true;
      break;
    }
    pids.push(Number.parseInt(name, 10));
  }
  return { pids, capped };
};

const listProcPids = (fsModule = fs) => scanProcPids(fsModule).pids;

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
const findPortListenerPids = (port, { fsModule = fs } = {}) => findPortListeners(port, { fsModule }).pids;

// The same scan with an honesty bit: `complete` is false when the answer
// may be missing a listener — both socket tables unreadable, the kMaxProcScan
// cap cut the pid listing short, or a /proc/<pid>/fd directory we were not
// allowed to read (EACCES/EPERM; ENOENT/ESRCH is a process that exited
// mid-scan and is skipped) while some listening socket on the port still has
// no known owner. A denied directory is harmless once every listening inode
// has been matched to a pid (an unprivileged scan always meets root's
// processes; what matters is whether the listener itself was found). The
// lsof shim (lib/server/lsof-shim) turns an incomplete answer into
// "unknown" rather than reporting the port free.
const findPortListeners = (port, { fsModule = fs } = {}) => {
  if (!Number.isInteger(port) || port <= 0) return { complete: true, pids: [] };
  const inodes = new Set();
  let readableTables = 0;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const inode of parseListeningInodes(fsModule.readFileSync(table, "utf8"), port)) {
        inodes.add(inode);
      }
      readableTables += 1;
    } catch {
      // table missing (no IPv6, non-Linux) — the other one may still answer
    }
  }
  if (readableTables === 0) return { complete: false, pids: [] };
  if (inodes.size === 0) return { complete: true, pids: [] };
  const targets = new Set(Array.from(inodes, (inode) => `socket:[${inode}]`));
  const matched = new Set();
  const owners = new Set();
  const { pids, capped } = scanProcPids(fsModule);
  let denied = false;
  for (const pid of pids) {
    let fds;
    try {
      fds = fsModule.readdirSync(`/proc/${pid}/fd`);
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ESRCH") denied = true;
      continue; // not ours to read, or raced with exit
    }
    for (const fd of fds) {
      let target;
      try {
        target = fsModule.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!targets.has(target)) continue;
      matched.add(target);
      owners.add(pid);
    }
  }
  const complete = !capped && (!denied || matched.size === targets.size);
  return { complete, pids: Array.from(owners).sort((a, b) => a - b) };
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
  findPortListeners,
  isOpenclawPid,
  isSameProcess,
  // Exported for tests.
  parseListeningInodes,
  kMaxProcScan,
};
