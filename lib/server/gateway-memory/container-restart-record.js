const fs = require("node:fs");
const { writeFileAtomic } = require("../utils/safe-file");
const { getProcessBootId } = require("../boot-id");
const { plainName } = require("./process-command");

// "The container restarted at its memory limit" as a boot cause (ALPH-25).
//
//   memory tick, container >= 90% ──▶ recordFull   state "full", last sample
//   memory tick, container  < 90% ──▶ recordClear  state "cleared" (once)
//   watchdog stop (clean shutdown) ──▶ markClean   state "clean_shutdown"
//   next boot ──▶ consumeAtBoot: an open "full" record from another process,
//                 sampled within the window before this process started,
//                 at >= 95% of the limit or with memory.events max (v1
//                 failcnt) rising in that sample, is a restart at the limit.
//                 The record is then marked reported so it is told once.
//
// The usage is non-reclaimable memory, so a container pinned at memory.max
// can read 92%: the kernel keeps reclaiming page cache to fit. The rising
// max counter is the direct proof that it reached the limit.
//
// The record is rewritten on every full tick, so its sample is the previous
// process's last observation, at most one tick before its last tick. The
// window covers that tick plus the platform's restart and this boot. Writes
// happen only while the container is full; a quiet box never touches disk.
const kSchema = "alphaclaw.container-pressure.v1";
const kContainerPressureFileName = "container-pressure.json";
const kRestartAtLimitFraction = 0.95;
const kRestartAtLimitWindowMs = 5 * 60_000;
const kClockSkewMs = 60_000;

const finitePositive = (value) => Number.isFinite(value) && value > 0;

const createContainerPressureRecord = ({ filePath, fsModule = fs, logger = console, bootIdFn = getProcessBootId }) => {
  let open = false;
  let warned = false;
  const write = (record) => {
    try {
      writeFileAtomic(filePath, JSON.stringify({ schema: kSchema, bootId: bootIdFn(), ...record }), { fsModule });
      return true;
    } catch (err) {
      if (!warned) logger.warn?.(`[watchdog] could not write ${kContainerPressureFileName}: ${err?.message || err}`);
      warned = true;
      return false;
    }
  };
  const recordFull = ({ atMs, usedBytes, limitBytes, limitHit = false, largest = null }) => {
    if (!Number.isFinite(atMs) || !Number.isFinite(usedBytes) || !finitePositive(limitBytes)) return;
    open = true;
    write({ state: "full", atMs, usedBytes, limitBytes, limitHit: limitHit === true,
      largest: largest && Number.isFinite(largest.rssBytes)
        ? { command: largest.command ?? null, rssBytes: largest.rssBytes } : null });
  };
  // A close that could not be written stays open, so the next sample or the
  // shutdown retries it instead of leaving a stale "full" record behind.
  const recordClear = (atMs) => {
    if (open) open = !write({ state: "cleared", atMs });
  };
  const markClean = (atMs) => {
    if (open) open = !write({ state: "clean_shutdown", atMs });
  };
  const consumeAtBoot = ({ processStartedAtMs }) => {
    let record;
    try { record = JSON.parse(String(fsModule.readFileSync(filePath, "utf8"))); }
    catch { return null; }
    if (record?.schema !== kSchema || record.state !== "full" || record.bootId === bootIdFn()) return null;
    write({ ...record, state: "reported", reportedAtMs: processStartedAtMs });
    const { atMs, usedBytes, limitBytes } = record;
    if (!Number.isFinite(atMs) || !Number.isFinite(usedBytes) || !finitePositive(limitBytes)) return null;
    const gapMs = processStartedAtMs - atMs;
    const atLimit = record.limitHit === true || usedBytes / limitBytes >= kRestartAtLimitFraction;
    if (!atLimit || gapMs < -kClockSkewMs || gapMs > kRestartAtLimitWindowMs) return null;
    const largest = record.largest && Number.isFinite(record.largest.rssBytes)
      ? { command: typeof record.largest.command === "string" ? plainName(record.largest.command) : null, rssBytes: record.largest.rssBytes }
      : null;
    return { atMs, usedBytes, limitBytes, largest };
  };
  return { recordFull, recordClear, markClean, consumeAtBoot };
};

module.exports = { createContainerPressureRecord, kContainerPressureFileName,
  kRestartAtLimitFraction, kRestartAtLimitWindowMs };
