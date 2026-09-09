const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { parseProcessStat } = require("./process-identity");

const kPssIntervalMs = 5 * 60 * 1000;
const kPssStaleMs = 6 * 60 * 1000;
const kPssMaxMembers = 128;
const kPssMaxBytes = 16 * 1024;
const kPssBudgetMs = 1000;

const unavailable = (reason, processCount = 0) => ({
  status: "unavailable", reason, atMs: null, rssBytes: null, pssBytes: null,
  privateBytes: null, privateHugetlbBytes: null, readCount: 0, processCount,
  durationMs: null,
});

const parseSmapsRollup = (text) => {
  if (typeof text !== "string" || Buffer.byteLength(text) > kPssMaxBytes) return null;
  const read = (name) => {
    const matches = [...text.matchAll(new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, "gm"))];
    if (matches.length !== 1) return null;
    const bytes = Number(matches[0][1]) * 1024;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  };
  const rssBytes = read("Rss");
  const pssBytes = read("Pss");
  const clean = read("Private_Clean");
  const dirty = read("Private_Dirty");
  if ([rssBytes, pssBytes, clean, dirty].some((value) => value === null)) return null;
  const privateBytes = clean + dirty;
  if (!Number.isSafeInteger(privateBytes) || pssBytes > rssBytes || privateBytes > rssBytes) return null;
  return { rssBytes, pssBytes, privateBytes, privateHugetlbBytes: read("Private_Hugetlb") };
};

// One bounded read chain, with the handle kept until the kernel operation
// settles. A deadline stops NEW work; it cannot cancel an in-kernel proc read.
// The byte ceiling includes all reads of the file. A completely filled buffer
// is rejected conservatively because proving EOF would consume an extra byte.
const readBounded = async (filePath, maxBytes, fsModule) => {
  const handle = await fsModule.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) return buffer.toString("utf8", 0, used);
      used += bytesRead;
    }
    throw Object.assign(new Error("Process memory sample reaches its read bound"), { code: "SAMPLE_TOO_LARGE" });
  } finally {
    await handle.close();
  }
};

const classifyReadError = (error) => {
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission_denied";
  if (error?.code === "ENOENT" || error?.code === "ESRCH") return "process_unavailable";
  if (error?.code === "SAMPLE_TOO_LARGE") return "invalid_sample";
  return "read_failed";
};

const createProcessPssSampler = ({
  fsModule = fs,
  nowFn = Date.now,
  monotonicNowFn = () => performance.now(),
  platform = process.platform,
  intervalMs = kPssIntervalMs,
  staleMs = kPssStaleMs,
  maxMembers = kPssMaxMembers,
  budgetMs = kPssBudgetMs,
} = {}) => {
  let current = null;
  let active = null;
  const identityKey = (identity) => identity ? `${identity.pid}:${identity.startTicks}` : "none";
  const membershipKey = (members) => members.map((member) =>
    `${identityKey(member)}:${member.parentPid}`).sort().join(",");

  const collect = async (entry, snapshot, members, fingerprint) => {
    const startedAtMs = nowFn();
    const started = monotonicNowFn();
    const withinBudget = () => monotonicNowFn() - started < budgetMs;
    const totals = { rssBytes: 0, pssBytes: 0, privateBytes: 0, privateHugetlbBytes: 0 };
    let readCount = 0;
    let hugeComplete = true;
    let reason = members.length > maxMembers ? "member_limit" :
      snapshot.status !== "fresh" ? "incomplete_tree" : null;
    for (const member of members.slice(0, maxMembers)) {
      if (current !== entry) return;
      if (!withinBudget()) { reason = "deadline"; break; }
      try {
        const before = parseProcessStat(await readBounded(`/proc/${member.pid}/stat`, 4096, fsModule));
        if (identityKey(before) !== identityKey(member) || before?.parentPid !== member.parentPid) {
          reason = "process_changed"; continue;
        }
        if (!withinBudget()) { reason = "deadline"; break; }
        const rollup = parseSmapsRollup(await readBounded(`/proc/${member.pid}/smaps_rollup`, kPssMaxBytes, fsModule));
        if (!withinBudget()) { reason = "deadline"; break; }
        const after = parseProcessStat(await readBounded(`/proc/${member.pid}/stat`, 4096, fsModule));
        if (!withinBudget()) { reason = "deadline"; break; }
        if (identityKey(after) !== identityKey(member) || after?.parentPid !== member.parentPid) {
          reason = "process_changed"; continue;
        }
        if (!rollup) { reason = "invalid_sample"; continue; }
        for (const key of ["rssBytes", "pssBytes", "privateBytes"]) totals[key] += rollup[key];
        if (rollup.privateHugetlbBytes === null) hugeComplete = false;
        else totals.privateHugetlbBytes += rollup.privateHugetlbBytes;
        readCount += 1;
      } catch (error) {
        reason = classifyReadError(error);
      }
    }
    if (current !== entry) return;
    const complete = !reason && readCount === members.length && members.length > 0;
    const measured = readCount > 0;
    const result = {
      status: complete ? "fresh" : measured ? "partial" : "unavailable",
      reason,
      atMs: startedAtMs,
      completedAtMs: nowFn(),
      topologyAtMs: snapshot.atMs,
      rssBytes: complete ? totals.rssBytes : null,
      pssBytes: complete ? totals.pssBytes : null,
      privateBytes: complete ? totals.privateBytes : null,
      privateHugetlbBytes: complete && hugeComplete ? totals.privateHugetlbBytes : null,
      sampledRssBytes: measured ? totals.rssBytes : null,
      sampledPssBytes: measured ? totals.pssBytes : null,
      sampledPrivateBytes: measured ? totals.privateBytes : null,
      readCount,
      processCount: snapshot.processCount ?? members.length,
      durationMs: Math.max(0, Math.round(monotonicNowFn() - started)),
    };
    // Retain the last complete diagnostic when a refresh fails. Consumers
    // see "stale" and the failure, never a fresh old physical-memory total.
    if (!complete && entry.value?.pssBytes !== null && entry.value?.pssBytes !== undefined) {
      entry.value = { ...entry.value, status: "stale", reason,
        lastAttemptAtMs: startedAtMs, lastAttemptReadCount: readCount };
    } else entry.value = result;
    entry.fingerprint = fingerprint;
  };

  const read = (snapshot, members = []) => {
    if (platform !== "linux") return unavailable("unsupported", members.length);
    if (!snapshot.root || !snapshot.worker || !members.length) {
      current = null;
      return unavailable("process_unavailable", members.length);
    }
    const key = `${identityKey(snapshot.root)}/${identityKey(snapshot.worker)}`;
    if (!current || current.key !== key) {
      current = { key, value: null, attemptedAtMs: null, fingerprint: null };
    }
    const entry = current;
    const fingerprint = membershipKey(members);
    const now = nowFn();
    if (!active && (entry.attemptedAtMs === null || now - entry.attemptedAtMs >= intervalMs)) {
      entry.attemptedAtMs = now;
      const job = { entry };
      active = job;
      // A microtask keeps even the first open off the synchronous resources
      // read. There is ONE chain globally, including across root replacement.
      job.promise = Promise.resolve().then(() => collect(entry, snapshot, members, fingerprint))
        .catch(() => {
          if (current === entry) entry.value = unavailable("read_failed", members.length);
        })
        .finally(() => { if (active === job) active = null; });
    }
    if (!entry.value) return { ...unavailable(null, members.length), status: "collecting" };
    const value = { ...entry.value };
    if (fingerprint !== entry.fingerprint) return { ...value, status: "stale", reason: "membership_changed" };
    if (snapshot.status !== "fresh" && value.status === "fresh") {
      return { ...value, status: "stale", reason: "incomplete_tree" };
    }
    if (now - value.atMs > staleMs || now < value.atMs) return { ...value, status: "stale", reason: "sample_stale" };
    return value;
  };

  return {
    read,
    // Invalidation never releases an in-flight operation. Its eventual
    // completion is discarded; the next read can refresh once it settles.
    reset: () => { current = null; },
    settleForTests: async () => { await active?.promise; },
  };
};

module.exports = { createProcessPssSampler, parseSmapsRollup, kPssIntervalMs,
  kPssStaleMs, kPssMaxMembers, kPssBudgetMs };
