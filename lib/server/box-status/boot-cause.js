// Why this AlphaClaw process booted, for the restart history. A graceful exit
// (SIGTERM, SIGINT, the crash guards' own drain) and a self-update restart each
// leave <managedDir>/last-shutdown.json; the next process consumes it once at
// startup, so a later process that finds none knows its predecessor died
// without one: the platform replaced or killed the container, or AlphaClaw
// crashed past its crash guards. The two cannot be told apart from inside, so
// that cause is `unclean_exit`, "platform or crash". The gap is the time from
// the persisted last-serving stamp (gateway-downtime-note.js) to this boot's
// start: how long the box was down or unaccounted for.
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");

const kShutdownRecordFileName = "last-shutdown.json";
// A record older than the last serving stamp by more than this was written
// before a later process served, and that process then died without one.
const kStaleRecordToleranceMs = 60_000;

const kBootCauses = Object.freeze({
  SHUTDOWN: "shutdown",
  RESTART: "restart",
  UNCLEAN_EXIT: "unclean_exit",
  FIRST_BOOT: "first_boot",
});

const kRecordKinds = new Set([kBootCauses.SHUTDOWN, kBootCauses.RESTART]);

const shortText = (value) => (value == null || value === "" ? null : String(value).slice(0, 64));

const writeShutdownRecord = ({ managedDir, kind, reason = null, code = null, fsModule = fs, now = Date.now, logger = console }) => {
  try {
    writeFileAtomic(
      path.join(managedDir, kShutdownRecordFileName),
      `${JSON.stringify({ kind, reason: shortText(reason), code: Number.isInteger(code) ? code : null, atMs: now() })}\n`,
      { fsModule },
    );
    return true;
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not record the shutdown (${error?.code || error?.message || error})`);
    return false;
  }
};

// Reads the previous process's record and removes it, so it explains one
// boot only.
const consumeShutdownRecord = ({ managedDir, fsModule = fs }) => {
  const filePath = path.join(managedDir, kShutdownRecordFileName);
  let parsed = null;
  try {
    parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch {}
  try {
    fsModule.unlinkSync(filePath);
  } catch {}
  if (!parsed || !kRecordKinds.has(parsed.kind) || !Number.isFinite(parsed.atMs)) return null;
  return { kind: parsed.kind, reason: shortText(parsed.reason), code: Number.isInteger(parsed.code) ? parsed.code : null, atMs: parsed.atMs };
};

const labelFor = ({ kind, reason = null, code = null }) => {
  if (kind === kBootCauses.RESTART) return `AlphaClaw restart (${reason || "update"})`;
  if (kind === kBootCauses.SHUTDOWN) {
    return code ? `AlphaClaw exited on an error (${reason || `exit ${code}`})` : `Clean shutdown (${reason || "signal"})`;
  }
  if (kind === kBootCauses.UNCLEAN_EXIT) return "Platform or crash";
  return "First boot";
};

// → { kind, label, reason, shutdownAt, gapMs }
const classifyBootCause = ({ shutdown = null, lastServingAt = null, startedAtMs, hasHistory = false }) => {
  const gapMs = Number.isFinite(lastServingAt) && Number.isFinite(startedAtMs) && startedAtMs >= lastServingAt
    ? Math.round(startedAtMs - lastServingAt)
    : null;
  const current = shutdown && !(Number.isFinite(lastServingAt) && lastServingAt > shutdown.atMs + kStaleRecordToleranceMs)
    ? shutdown
    : null;
  if (current) {
    return { kind: current.kind, label: labelFor(current), reason: current.reason, shutdownAt: new Date(current.atMs).toISOString(), gapMs };
  }
  const kind = lastServingAt == null && !hasHistory ? kBootCauses.FIRST_BOOT : kBootCauses.UNCLEAN_EXIT;
  return { kind, label: labelFor({ kind }), reason: null, shutdownAt: null, gapMs };
};

module.exports = {
  kBootCauses,
  kShutdownRecordFileName,
  writeShutdownRecord,
  consumeShutdownRecord,
  classifyBootCause,
};
