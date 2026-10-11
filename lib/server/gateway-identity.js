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

// Every member of process group `pgid` — including members the tree walk
// cannot see because their parent died and PID 1 adopted them (the box's
// two-day-old `node trip-reminder-stream.mjs` had ppid 1 and the gateway's
// pgid). Ascending; [] off Linux / unreadable /proc.
const listProcessGroupMembers = (pgid, { fsModule = fs } = {}) => {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const members = [];
  for (const pid of listProcPids(fsModule)) {
    if (lockContention.readProcStatResult(pid, { fsModule }).stat?.pgrp === pgid) members.push(pid);
  }
  return members.sort((a, b) => a - b);
};

const readProcArgv = (pid, fsModule) => {
  try {
    return lockContention.parseProcCmdline(fsModule.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null;
  }
};

// The PROGRAM is OpenClaw (argv rules 1/2/2b, never rule 3's "some argument
// names an entry script"). The stop ladder judges "gone" on exactly these.
const isOpenclawProgramPid = (pid, { fsModule = fs } = {}) => {
  const argv = readProcArgv(pid, fsModule);
  return argv != null && lockContention.isOpenclawProgramArgv(argv);
};

// `comm` plus, for a JS runtime, the script's basename — the only two facts
// about a process that reach the record, the log and the Watchdog tab.
// "" when nothing is readable.
const describeProcessCommand = (pid, { fsModule = fs } = {}) => {
  let comm = "";
  try {
    comm = String(fsModule.readFileSync(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {}
  const fromArgv = lockContention.describeArgvProgram(readProcArgv(pid, fsModule) ?? []);
  return (fromArgv || comm).slice(0, 80);
};

// Does the thread group still have a runnable thread? A zombie LEADER
// (state Z in /proc/<pid>/stat) can head a group whose other threads are
// still running: the leader called exit while a sibling thread lives on. true
// / false / null (task dir unreadable). Linux only.
const hasLiveThread = (pid, fsModule) => {
  let tids;
  try {
    tids = fsModule.readdirSync(`/proc/${pid}/task`);
  } catch {
    return null;
  }
  for (const tid of tids) {
    let raw;
    try {
      raw = fsModule.readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
    } catch {
      continue; // a thread that exited mid-scan is not live
    }
    const stat = lockContention.parseProcStat(raw);
    if (stat && !stat.dead) return true;
  }
  return false;
};

// Liveness with three answers (bug #137 RC1). The ladder may declare the
// gateway stopped only on `gone`, must keep waiting on `alive`, and must
// NEITHER relaunch NOR signal a pid on `unknown` — missing evidence is not
// permission to do anything.
//   gone     kill(pid, 0) → ESRCH; or /proc/<pid>/stat carries different
//            start ticks (the pid was reused); or the state is Z/X with no
//            live thread (a zombie: dead, waiting for a slow init to reap)
//   alive    a readable, non-dead stat whose start ticks match ours (or a
//            Z leader whose thread group still has a running thread)
//   unknown  the kernel says the pid exists but /proc cannot be read or
//            parsed (hidepid, EACCES, /proc absent, a torn read) — or the
//            ticks we need for identity are unreadable
// `reason` is a short token for evidence lines. Never throws.
const kProcessVerdicts = Object.freeze({ GONE: "gone", ALIVE: "alive", UNKNOWN: "unknown" });
const resolveProcessVerdict = (
  pid,
  startTicks = null,
  { fsModule = fs, kill = process.kill.bind(process) } = {},
) => {
  if (!Number.isInteger(pid) || pid <= 0) return { verdict: kProcessVerdicts.GONE, reason: "invalid_pid" };
  let killError = null;
  try {
    kill(pid, 0);
  } catch (error) {
    killError = String(error?.code || "EUNKNOWN");
  }
  if (killError === "ESRCH") return { verdict: kProcessVerdicts.GONE, reason: "esrch" };
  const { stat, errorCode } = lockContention.readProcStatResult(pid, { fsModule });
  if (!stat) {
    // Only the kernel's own "no such process" is proof; a missing /proc entry
    // while kill(0) still succeeds is a race or a hidden /proc.
    if (killError != null && (errorCode === "ENOENT" || errorCode === "ESRCH")) {
      return { verdict: kProcessVerdicts.GONE, reason: "exited" };
    }
    return { verdict: kProcessVerdicts.UNKNOWN, reason: `stat_${String(errorCode).toLowerCase()}` };
  }
  if (startTicks != null && stat.startTicks != null && stat.startTicks !== startTicks) {
    return { verdict: kProcessVerdicts.GONE, reason: "pid_reused" };
  }
  if (stat.dead) {
    const live = hasLiveThread(pid, fsModule);
    if (live === false) return { verdict: kProcessVerdicts.GONE, reason: `state_${stat.state.toLowerCase()}` };
    if (live === true) return { verdict: kProcessVerdicts.ALIVE, reason: "zombie_leader_live_thread" };
    return { verdict: kProcessVerdicts.UNKNOWN, reason: "task_unreadable" };
  }
  if (startTicks != null && stat.startTicks == null) {
    return { verdict: kProcessVerdicts.UNKNOWN, reason: "ticks_unreadable" };
  }
  return { verdict: kProcessVerdicts.ALIVE, reason: `state_${String(stat.state || "?").toLowerCase()}` };
};

// A pid is "the same process we resolved" only while it is provably alive
// with the start ticks we snapshotted. Boolean on purpose (the mocks in the
// restart tests and the memory monitor read it as one); the ladder itself
// reads the three-way verdict.
const isSameProcess = (pid, startTicks, { fsModule = fs } = {}) =>
  resolveProcessVerdict(pid, startTicks, { fsModule }).verdict === kProcessVerdicts.ALIVE;

module.exports = {
  listChildPids,
  listProcessTree,
  listProcessGroupMembers,
  readProcessGroupId,
  findPortListenerPids,
  findPortListeners,
  isOpenclawPid,
  isOpenclawProgramPid,
  describeProcessCommand,
  resolveProcessVerdict,
  kProcessVerdicts,
  isSameProcess,
  // Exported for tests.
  parseListeningInodes,
  kMaxProcScan,
};
