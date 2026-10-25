// The operator's read-only process table (ALPH-40): every process this
// container can see in /proc, which part of the box owns it, how long it has
// run, its memory and, for keys the caller names, a fingerprint of the value it
// holds in its environment. Built so nobody needs a shell to answer "what is
// running here, and is it still on the old env?".
//
// Bounds: at most kMaxPids pids are read, the whole collection stops at
// kScanBudgetMs, the command line is read up to kMaxCmdlineBytes and shown
// redacted up to kMaxCommandChars, the environment up to kMaxEnvironBytes, and
// PSS (smaps_rollup) only for the kMaxPssProcesses largest processes inside
// kPssBudgetMs. A read stays fresh for kCacheMs, so a polling panel does not
// rescan /proc.
//
// Secrets: the command line goes through the shared redaction (the deployment's
// env-file values, secret-named env values, secret flags and token shapes).
// Environment values never leave this module: each selected key is reported as
// an HMAC under a key that exists only in this process's memory, so hashes are
// comparable within one AlphaClaw process (between two processes, or against
// the .env file) and useless for guessing the value.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { collectSecretArgValues, collectSecretValues, redactLine } = require("../utils/redact");

const kMaxPids = 4096;
const kScanBudgetMs = 750;
const kMaxCmdlineBytes = 8 * 1024;
const kMaxCommandChars = 400;
const kMaxStatBytes = 4096;
const kMaxStatusBytes = 16 * 1024;
const kMaxEnvironBytes = 256 * 1024;
const kMaxSmapsBytes = 16 * 1024;
const kMaxPssProcesses = 32;
const kPssBudgetMs = 500;
const kDefaultLimit = 100;
const kMaxLimit = 500;
const kMaxEnvKeys = 8;
const kCacheMs = 5000;
const kClockTicksPerSecond = 100;
const kEnvKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const kOwners = Object.freeze(["gateway", "tool", "alphaclaw", "other"]);
const kHashKey = crypto.randomBytes(32);

const hashEnvValue = (key, value) =>
  crypto.createHmac("sha256", kHashKey).update(key + "\0" + value).digest("hex").slice(0, 16);

// "A,B" -> ["A","B"]: unique, valid names only, or an error the route returns.
const parseEnvKeys = (raw) => {
  if (raw == null || raw === "") return { keys: [] };
  if (typeof raw !== "string") return { error: "envKeys must be given once" };
  const keys = [...new Set(raw.split(",").map((key) => key.trim()).filter(Boolean))];
  if (keys.length > kMaxEnvKeys) return { error: "envKeys takes at most " + kMaxEnvKeys + " names" };
  const bad = keys.find((key) => !kEnvKeyPattern.test(key));
  if (bad !== undefined) return { error: "envKeys holds an invalid name" };
  return { keys };
};

const readBounded = async (filePath, maxBytes) => {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) return { data: buffer.subarray(0, used), truncated: false };
      used += bytesRead;
    }
    return { data: buffer, truncated: true };
  } finally {
    await handle.close();
  }
};
const readText = async (filePath, maxBytes) => {
  try {
    const { data, truncated } = await readBounded(filePath, maxBytes);
    return truncated ? null : data.toString("utf8");
  } catch {
    return null;
  }
};

const parseStat = (raw) => {
  if (!raw) return null;
  const close = raw.lastIndexOf(")");
  const open = raw.indexOf("(");
  if (close < 0 || open < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(startTicks)) return null;
  return { name: raw.slice(open + 1, close).slice(0, 64), state: fields[0], parentPid, startTicks };
};

const parseStatus = (raw) => {
  if (!raw) return {};
  const uid = /^Uid:\s+(\d+)/m.exec(raw);
  const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(raw);
  return {
    uid: uid ? Number(uid[1]) : null,
    rssBytes: rss ? Number(rss[1]) * 1024 : null,
  };
};

const parsePss = (raw) => {
  const match = /^Pss:\s+(\d+)\s+kB/m.exec(raw || "");
  return match ? Number(match[1]) * 1024 : null;
};

// uid -> name from /etc/passwd, read once per collection.
const readUserNames = async (passwdPath) => {
  const names = new Map();
  const text = await readText(passwdPath, 256 * 1024);
  for (const line of String(text || "").split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && /^\d+$/.test(uid || "")) names.set(Number(uid), name.slice(0, 32));
  }
  return names;
};

const parseEnviron = (data, keys) => {
  const wanted = new Set(keys);
  const found = new Map();
  for (const entry of data.toString("utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (wanted.has(key) && !found.has(key)) found.set(key, entry.slice(eq + 1));
  }
  return found;
};

// The environment block for the selected keys: per key the HMAC (null when the
// process does not have the key) and how it compares with the env file.
const describeEnv = async ({ procRoot, pid, keys, reference }) => {
  let read;
  try {
    read = await readBounded(path.join(procRoot, String(pid), "environ"), kMaxEnvironBytes);
  } catch (error) {
    return { readable: false, reason: error?.code === "EACCES" || error?.code === "EPERM" ? "permission_denied" : "unreadable" };
  }
  const values = parseEnviron(read.data, keys);
  const out = {};
  for (const key of keys) {
    const hash = values.has(key) ? hashEnvValue(key, values.get(key)) : null;
    const expected = reference[key];
    out[key] = {
      hash,
      envFile: hash === null ? (read.truncated ? "unknown" : "unset") : expected === undefined ? "not_in_env_file" : hash === expected ? "match" : "mismatch",
    };
  }
  const present = keys.filter((key) => values.has(key)).map((key) => key + "=" + out[key].hash);
  return {
    readable: true,
    truncated: read.truncated,
    fingerprint: present.length ? crypto.createHash("sha256").update(present.join("\n")).digest("hex").slice(0, 16) : null,
    keys: out,
  };
};

// Who owns each pid. The gateway's managed root and its serving worker are
// "gateway" (launcher / worker; other branches of the root are
// launcher_child); everything below the worker is a "tool" the agent ran.
// AlphaClaw's own process is "alphaclaw" (server) and its other descendants
// are its children (Doctor, git, CLI calls). Anything else is "other",
// including the processes above AlphaClaw (the container's init or a wrapper
// script), marked role "ancestor".
const classify = ({ records, selfPid, gatewayRootPid, gatewayPid }) => {
  const children = new Map();
  for (const record of records.values()) {
    if (!children.has(record.parentPid)) children.set(record.parentPid, []);
    children.get(record.parentPid).push(record.pid);
  }
  const walk = (start) => {
    const seen = new Set();
    if (!records.has(start)) return seen;
    const queue = [start];
    seen.add(start);
    for (let i = 0; i < queue.length; i += 1) {
      for (const child of children.get(queue[i]) || []) {
        if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
    return seen;
  };
  const rootPid = gatewayRootPid ?? gatewayPid;
  const gatewayTree = rootPid ? walk(rootPid) : new Set();
  const workerTree = gatewayPid && gatewayTree.has(gatewayPid) ? walk(gatewayPid) : new Set();
  const selfTree = walk(selfPid);
  const ancestors = new Set();
  for (let pid = records.get(selfPid)?.parentPid; pid && records.has(pid) && !ancestors.has(pid); pid = records.get(pid).parentPid) {
    ancestors.add(pid);
  }
  return (pid) => {
    if (pid === gatewayPid && gatewayTree.has(pid)) return { owner: "gateway", role: "worker" };
    if (pid === rootPid && gatewayTree.has(pid)) return { owner: "gateway", role: pid === gatewayPid ? "worker" : "launcher" };
    if (workerTree.has(pid)) return { owner: "tool", role: "gateway_child" };
    if (gatewayTree.has(pid)) return { owner: "gateway", role: "launcher_child" };
    if (pid === selfPid) return { owner: "alphaclaw", role: "server" };
    if (selfTree.has(pid)) return { owner: "alphaclaw", role: "child" };
    if (ancestors.has(pid)) return { owner: "other", role: "ancestor" };
    return { owner: "other", role: null };
  };
};

const createProcessTable = ({
  procRoot = "/proc",
  passwdPath = "/etc/passwd",
  selfPid = process.pid,
  execPath = process.execPath,
  nodeVersion = process.version,
  // () => { gatewayRootPid, gatewayPid } — the watchdog's view of the gateway.
  getGatewayTarget = () => ({}),
  // () => [{ key, value }] — the deployment's .env (lib/server/env.js).
  readEnvFile = () => [],
  alphaclawVersion = null,
  getOpenclawVersion = () => null,
  env = process.env,
  nowFn = Date.now,
  monotonicNowFn = () => performance.now(),
  cacheMs = kCacheMs,
} = {}) => {
  const cache = new Map();
  let realExecPath = null;
  try { realExecPath = fs.realpathSync(execPath); } catch {}

  const collect = async ({ envKeys, limit }) => {
    const started = monotonicNowFn();
    const expired = () => monotonicNowFn() - started >= kScanBudgetMs;
    const atMs = nowFn();
    let names;
    try {
      names = await fs.promises.readdir(procRoot);
    } catch {
      return { ok: true, status: "unavailable", reason: "proc_unavailable", atMs, processes: [] };
    }
    const pids = names.filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
    let truncated = pids.length > kMaxPids;
    let reason = truncated ? "pid_limit" : null;
    const uptimeText = await readText(path.join(procRoot, "uptime"), 256);
    const uptimeSec = Number(String(uptimeText || "").split(/\s+/)[0]);
    const envFileVars = (() => { try { return readEnvFile() || []; } catch { return []; } })();
    const secrets = collectSecretValues({ env, envFileVars });
    const reference = {};
    for (const { key, value } of envFileVars) {
      if (envKeys.includes(key) && !(key in reference)) reference[key] = hashEnvValue(key, String(value ?? ""));
    }
    const users = await readUserNames(passwdPath);
    const records = new Map();
    for (const pid of pids.slice(0, kMaxPids)) {
      if (expired()) { truncated = true; reason = "scan_deadline"; break; }
      const dir = path.join(procRoot, String(pid));
      const stat = parseStat(await readText(path.join(dir, "stat"), kMaxStatBytes));
      if (!stat) continue;
      const status = parseStatus(await readText(path.join(dir, "status"), kMaxStatusBytes));
      let argv = null;
      try {
        const { data } = await readBounded(path.join(dir, "cmdline"), kMaxCmdlineBytes);
        argv = data.toString("utf8").split("\0").filter(Boolean);
      } catch {}
      let exe = null;
      try { exe = await fs.promises.readlink(path.join(dir, "exe")); } catch {}
      records.set(pid, { pid, ...stat, ...status, argv, exe });
    }
    const target = (() => { try { return getGatewayTarget() || {}; } catch { return {}; } })();
    const ownerOf = classify({
      records,
      selfPid,
      gatewayRootPid: Number.isSafeInteger(target.gatewayRootPid) ? target.gatewayRootPid : null,
      gatewayPid: Number.isSafeInteger(target.gatewayPid) ? target.gatewayPid : null,
    });
    const openclawVersion = (() => { try { return getOpenclawVersion() || null; } catch { return null; } })();
    const totals = Object.fromEntries(kOwners.map((owner) => [owner, { count: 0, rssBytes: 0 }]));
    const rows = [];
    for (const record of records.values()) {
      const { owner, role } = ownerOf(record.pid);
      totals[owner].count += 1;
      totals[owner].rssBytes += record.rssBytes || 0;
      const rawCommand = record.argv?.length ? record.argv.join(" ") : "[" + record.name + "]";
      const startedAtMs = Number.isFinite(uptimeSec)
        ? Math.round(atMs - (uptimeSec - record.startTicks / kClockTicksPerSecond) * 1000)
        : null;
      const isNode = !!record.exe && !!realExecPath && record.exe.replace(/ \(deleted\)$/, "") === realExecPath;
      rows.push({
        pid: record.pid,
        parentPid: record.parentPid,
        uid: record.uid,
        user: record.uid === null ? null : users.get(record.uid) ?? null,
        name: record.name,
        command: redactLine(rawCommand, { secrets: [...secrets, ...collectSecretArgValues(record.argv)], maxLength: kMaxCommandChars }),
        state: record.state,
        owner,
        role,
        startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
        uptimeSec: Number.isFinite(uptimeSec) ? Math.max(0, Math.round(uptimeSec - record.startTicks / kClockTicksPerSecond)) : null,
        rssBytes: record.rssBytes,
        pssBytes: null,
        version: owner === "alphaclaw" && role === "server" ? (alphaclawVersion ? "alphaclaw " + alphaclawVersion : null)
          : owner === "gateway" && (role === "worker" || role === "launcher") ? (openclawVersion ? "openclaw " + openclawVersion : null)
            : null,
        runtime: isNode ? "node " + nodeVersion : null,
      });
    }
    rows.sort((a, b) => (b.rssBytes || 0) - (a.rssBytes || 0) || a.pid - b.pid);
    const shown = rows.slice(0, limit);
    const pssStarted = monotonicNowFn();
    let pssMeasured = 0;
    for (const row of shown.slice(0, kMaxPssProcesses)) {
      if (monotonicNowFn() - pssStarted >= kPssBudgetMs) break;
      row.pssBytes = parsePss(await readText(path.join(procRoot, String(row.pid), "smaps_rollup"), kMaxSmapsBytes));
      if (row.pssBytes !== null) pssMeasured += 1;
    }
    if (envKeys.length) {
      for (const row of shown) {
        row.env = await describeEnv({ procRoot, pid: row.pid, keys: envKeys, reference });
      }
    }
    return {
      ok: true,
      status: truncated ? "partial" : "fresh",
      reason,
      atMs,
      scanned: records.size,
      total: rows.length,
      shown: shown.length,
      pssMeasured,
      totals,
      envKeys,
      envFile: envKeys.length ? Object.fromEntries(envKeys.map((key) => [key, reference[key] ?? null])) : undefined,
      processes: shown,
    };
  };

  const read = ({ envKeys = [], limit = kDefaultLimit } = {}) => {
    const boundedLimit = Math.min(kMaxLimit, Math.max(1, Number.isSafeInteger(limit) ? limit : kDefaultLimit));
    const key = envKeys.join(",") + "|" + boundedLimit;
    const now = nowFn();
    const cached = cache.get(key);
    if (cached && now >= cached.atMs && now - cached.atMs < cacheMs) return cached.promise;
    const promise = collect({ envKeys, limit: boundedLimit });
    cache.clear();
    cache.set(key, { atMs: now, promise });
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  };

  return { read };
};

module.exports = {
  createProcessTable,
  parseEnvKeys,
  kDefaultLimit,
  kMaxLimit,
  kMaxEnvKeys,
  kMaxPids,
  kScanBudgetMs,
  kCacheMs,
};
