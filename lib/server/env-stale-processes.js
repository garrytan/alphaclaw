const crypto = require("crypto");
const fs = require("fs");
const gatewayIdentity = require("./gateway-identity");
const { timingSafeStringEqual } = require("./utils/timing-safe");

// Which running processes still carry an env value that differs from what a
// fresh launch would get. Reads /proc/<pid>/environ of processes under this
// server's uid; each value is hashed the moment it is read and only key
// names, pids and command names leave this module. /proc/<pid>/environ is the
// environment the process was started with: a later setenv inside the process
// is invisible here, so this server's own pid is skipped (reloadEnv updates
// it in place).
const kMaxScannedProcesses = 4096;

const hashValue = (value) => crypto.createHash("sha256").update(value).digest("hex");

const kEquals = 0x3d;

const readEnvironHashes = (pid, keys, fsModule) => {
  const raw = fsModule.readFileSync(`/proc/${pid}/environ`);
  const hashes = new Map();
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index < raw.length && raw[index] !== 0) continue;
    const entry = raw.subarray(start, index);
    start = index + 1;
    const eq = entry.indexOf(kEquals);
    if (eq <= 0) continue;
    const key = entry.subarray(0, eq).toString("utf8");
    if (keys.has(key)) hashes.set(key, hashValue(entry.subarray(eq + 1)));
  }
  raw.fill(0);
  return hashes;
};

const describeState = ({ actualHash, expectedHash, inGatewayTree }) => {
  if (actualHash == null) return expectedHash != null && inGatewayTree ? "missing" : null;
  if (expectedHash == null) return "still_set";
  return timingSafeStringEqual(actualHash, expectedHash) ? null : "differs";
};

// keys: names to check. envFileValues: Map key -> value after the save (an
// absent key is deleted). gatewayEnv: the env a new gateway launch gets
// (gatewayLaunchEnv()); processes in the gateway's tree are judged against
// it, every other process against the .env value. A process that never had a
// key is reported only inside the gateway tree ("missing"): an unrelated
// process lacking a new key is normal.
const findStaleEnvProcesses = ({
  keys,
  envFileValues,
  gatewayEnv = null,
  getGatewayRootPid = () => null,
  fsModule = fs,
  selfPid = process.pid,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) => {
  const keySet = new Set((keys || []).filter(Boolean));
  if (!keySet.size) return { available: true, checkedKeys: 0, scannedProcesses: 0, unreadableProcesses: 0, stale: [] };
  if (process.platform !== "linux" || uid == null) return { available: false, reason: "no_proc" };
  let entries;
  try {
    entries = fsModule.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return { available: false, reason: "no_proc" };
  }
  const truncated = entries.length > kMaxScannedProcesses;
  const pids = entries.slice(0, kMaxScannedProcesses).map(Number).filter((pid) => pid !== selfPid);

  let gatewayTree = new Set();
  try {
    const rootPid = getGatewayRootPid();
    if (Number.isInteger(rootPid) && rootPid > 0) {
      gatewayTree = new Set(gatewayIdentity.listProcessTree(rootPid, { fsModule }));
    }
  } catch {}

  const expectedHash = (key, inGatewayTree) => {
    if (inGatewayTree && gatewayEnv) {
      return Object.prototype.hasOwnProperty.call(gatewayEnv, key) ? hashValue(String(gatewayEnv[key])) : null;
    }
    return envFileValues.has(key) ? hashValue(String(envFileValues.get(key))) : null;
  };
  const expectedByScope = new Map();
  for (const key of keySet) {
    expectedByScope.set(key, { gateway: expectedHash(key, true), other: expectedHash(key, false) });
  }

  const staleByKey = new Map();
  let scannedProcesses = 0;
  let unreadableProcesses = 0;
  for (const pid of pids) {
    let owner;
    try {
      owner = fsModule.statSync(`/proc/${pid}`).uid;
    } catch {
      continue;
    }
    if (owner !== uid) continue;
    let hashes;
    try {
      hashes = readEnvironHashes(pid, keySet, fsModule);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") unreadableProcesses += 1;
      continue;
    }
    scannedProcesses += 1;
    const inGatewayTree = gatewayTree.has(pid);
    let command = null;
    for (const key of keySet) {
      const expected = expectedByScope.get(key)[inGatewayTree ? "gateway" : "other"];
      const state = describeState({ actualHash: hashes.get(key) ?? null, expectedHash: expected, inGatewayTree });
      if (!state) continue;
      if (command == null) command = gatewayIdentity.describeProcessCommand(pid, { fsModule }) || "unknown";
      if (!staleByKey.has(key)) staleByKey.set(key, []);
      staleByKey.get(key).push({ pid, command, gateway: inGatewayTree, state });
    }
  }
  return {
    available: true,
    checkedKeys: keySet.size,
    scannedProcesses,
    unreadableProcesses,
    ...(truncated ? { truncated: true } : {}),
    stale: Array.from(staleByKey, ([key, processes]) => ({ key, processes })),
  };
};

module.exports = {
  findStaleEnvProcesses,
  kMaxScannedProcesses,
};
