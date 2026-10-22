// <managedDir>/boot-history.json — the only thing the boot timeline persists
// (honest boot status, PR 3). One row per terminal boot outcome, last 20,
// written by the real server once its timeline ends — after the boot-instance
// guard admitted this process (bin refuses a second start before the server
// module ever loads, and the timeline only begins at listen), so a refused
// start can never write here.
//
// Rows keep failures and aborts for diagnosis, but estimates use ONLY
// successful, complete boots that ended at verified native readiness
// (outcome "ready"): three quick refusals must not teach the next genuine
// upgrade that it usually takes seconds, and three timeouts must not make
// thirty minutes look normal.
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");
const { isNonArrayObject } = require("../utils/object");

const kBootHistoryFileName = "boot-history.json";
const kBootHistorySchema = "alphaclaw.boot-history.v1";
const kBootHistoryMax = 20;
// "Usually about X" needs this many comparable successful boots; with fewer
// the card shows only elapsed time.
const kEstimateSampleCount = 3;

const historyPath = (managedDir) => path.join(managedDir, kBootHistoryFileName);


// Lenient read: missing → empty, corrupt → empty with status "unreadable"
// (the history is derived diagnostics, never a config; the next append
// starts it over and says so in the log).
const readBootHistory = ({ managedDir, fsModule = fs } = {}) => {
  if (!managedDir) return { status: "missing", entries: [] };
  let raw;
  try {
    raw = fsModule.readFileSync(historyPath(managedDir), "utf8");
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unreadable", entries: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isNonArrayObject) : null;
    if (!entries) return { status: "unreadable", entries: [] };
    return { status: "ok", entries };
  } catch {
    return { status: "unreadable", entries: [] };
  }
};

const appendBootHistory = ({ managedDir, entry, fsModule = fs, logger = console } = {}) => {
  if (!managedDir || !isNonArrayObject(entry)) return false;
  const current = readBootHistory({ managedDir, fsModule });
  if (current.status === "unreadable") {
    logger.warn?.(`[alphaclaw] ${kBootHistoryFileName} was unreadable; starting the boot history over`);
  }
  const entries = [...current.entries, entry].slice(-kBootHistoryMax);
  try {
    writeFileAtomic(
      historyPath(managedDir),
      `${JSON.stringify({ schema: kBootHistorySchema, entries }, null, 2)}\n`,
      { fsModule },
    );
    return true;
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not write ${kBootHistoryFileName}: ${error?.message || error}`);
    return false;
  }
};

const isComparableSuccess = (entry, kind) =>
  entry?.outcome === "ready" &&
  entry?.complete === true &&
  entry?.kind === kind &&
  Number.isFinite(entry?.totalMs) &&
  entry.totalMs > 0;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// → { estimateMs, samples, basis } | null. Median of the last three
// comparable successful boots of the same kind. An OpenClaw upgrade prefers
// upgrades to the same OpenClaw version and falls back to upgrades of any
// version (an install rarely upgrades to one version twice); the fallback
// still needs three samples.
const estimateBootDuration = ({ entries = [], kind, openclawVersion = null } = {}) => {
  const successes = (Array.isArray(entries) ? entries : []).filter((entry) =>
    isComparableSuccess(entry, kind),
  );
  const pick = (rows, basis) =>
    rows.length >= kEstimateSampleCount
      ? {
          estimateMs: median(rows.slice(-kEstimateSampleCount).map((entry) => entry.totalMs)),
          samples: kEstimateSampleCount,
          basis,
        }
      : null;
  if (kind === "upgrading_openclaw" && openclawVersion) {
    const sameVersion = pick(
      successes.filter((entry) => entry.openclawVersion === openclawVersion),
      "same_version",
    );
    if (sameVersion) return sameVersion;
  }
  return pick(successes, kind === "upgrading_openclaw" ? "any_version" : "same_kind");
};

module.exports = {
  kBootHistoryFileName,
  kBootHistorySchema,
  kBootHistoryMax,
  kEstimateSampleCount,
  readBootHistory,
  appendBootHistory,
  estimateBootDuration,
};
