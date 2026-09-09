const fs = require("node:fs");
const { parseProcStat } = require("../openclaw-lock-contention");

const kMaxIdentityBytes = 4096;
const kBootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Reuse the lifecycle owner's stat parser. Retain the original decimal start
// ticks too: process identities are tokens, not quantities to round.
const parseProcessStat = (raw) => {
  if (typeof raw !== "string" || raw.length > kMaxIdentityBytes) return null;
  const parsed = parseProcStat(raw);
  const pidMatch = /^(\d+) \(/.exec(raw);
  const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  const pid = Number(pidMatch?.[1]);
  if (!parsed || !Number.isSafeInteger(pid) || pid <= 0 ||
      parsed.parentPid === null || !/^\d+$/.test(startTicks || "")) return null;
  return { pid, parentPid: parsed.parentPid, startTicks };
};

const readSmallFile = (filePath, fsModule = fs) => {
  let fd;
  try {
    fd = fsModule.openSync(filePath, "r");
    const buffer = Buffer.alloc(kMaxIdentityBytes + 1);
    const bytes = fsModule.readSync(fd, buffer, 0, buffer.length, 0);
    return bytes <= kMaxIdentityBytes ? buffer.toString("utf8", 0, bytes) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsModule.closeSync(fd); } catch {}
    }
  }
};

const getProcessIdentity = (pid, { fsModule = fs } = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const parsed = parseProcessStat(readSmallFile(`/proc/${pid}/stat`, fsModule));
  return parsed?.pid === pid ? { pid, startTicks: parsed.startTicks } : null;
};

const getLinuxBootId = ({ fsModule = fs } = {}) => {
  const value = readSmallFile("/proc/sys/kernel/random/boot_id", fsModule)?.trim();
  return kBootIdPattern.test(value || "") ? value : null;
};

module.exports = { getProcessIdentity, getLinuxBootId, parseProcessStat };
