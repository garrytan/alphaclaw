// The last gateway restart, for the box status (ALPH-40): who asked, why, how
// it ended and how long the gateway was down. gateway.js reports every cold
// restart here (setGatewayRestartRecorder); the record is one small JSON file
// in the managed dir so it survives an AlphaClaw restart. A record still
// "running" that an earlier AlphaClaw process wrote can never finish: it reads
// as "interrupted".
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../utils/safe-file");
const { redactLine } = require("../utils/redact");

const kLastRestartFileName = "last-gateway-restart.json";

const finiteOrNull = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

const createLastRestartStore = ({ managedDir, bootId, fsModule = fs, nowFn = Date.now, logger = console } = {}) => {
  const filePath = path.join(managedDir, kLastRestartFileName);
  let current = null;

  const persist = () => {
    try {
      writeFileAtomic(filePath, JSON.stringify(current) + "\n", { fsModule });
    } catch (error) {
      logger.warn?.("[alphaclaw] could not record the last gateway restart (" + (error?.code || error?.message || error) + ")");
    }
  };

  const recorder = {
    requested: ({ opId, source, reason, restartClass }) => {
      current = {
        opId: String(opId || "").slice(0, 64) || null,
        source: source ? String(source).slice(0, 64) : null,
        reason: reason ? redactLine(String(reason), { maxLength: 200 }) : null,
        restartClass: restartClass ? String(restartClass).slice(0, 16) : null,
        bootId,
        requestedAt: new Date(nowFn()).toISOString(),
        finishedAt: null,
        outcome: "running",
        durationMs: null,
        downtimeMs: null,
        how: null,
      };
      persist();
    },
    finished: ({ opId, outcome, durationMs, downtimeMs, how }) => {
      if (!current || current.opId !== opId) return;
      current = {
        ...current,
        finishedAt: new Date(nowFn()).toISOString(),
        outcome: String(outcome || "failed").slice(0, 32),
        durationMs: finiteOrNull(durationMs),
        downtimeMs: finiteOrNull(downtimeMs),
        how: how ? String(how).slice(0, 32) : null,
      };
      persist();
    },
  };

  const read = () => {
    let record = current;
    if (!record) {
      try {
        record = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
      } catch {
        return null;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    }
    const { bootId: recordBootId, ...rest } = record;
    return rest.outcome === "running" && recordBootId !== bootId ? { ...rest, outcome: "interrupted" } : rest;
  };

  return { recorder, read };
};

const toIso = (value) => (Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null);

const projectCause = (cause) => cause && typeof cause === "object" ? {
  kind: cause.kind ?? null,
  label: cause.label ?? null,
  reason: cause.reason ?? null,
  shutdownAt: cause.shutdownAt ?? null,
  gapMs: finiteOrNull(cause.gapMs),
} : null;

const projectBoot = (entry) => entry ? {
  bootId: entry.bootId ?? null,
  kind: entry.kind ?? null,
  outcome: entry.outcome ?? null,
  reason: entry.reason ?? null,
  startedAt: toIso(entry.startedAt),
  endedAt: toIso(entry.endedAt),
  totalMs: finiteOrNull(entry.totalMs),
  alphaclawVersion: entry.alphaclawVersion ?? null,
  openclawVersion: entry.openclawVersion ?? null,
  cause: projectCause(entry.cause),
} : null;

// GET /api/box/restart: the last gateway restart (source, reason, outcome,
// downtime), AlphaClaw's boots (a container or AlphaClaw restart, with how
// long it took to be ready and why it booted: boots is the retained history,
// newest first; lastBoot and previousBoot are its first two rows), and the
// gateway's last unexpected exit.
const readRestartStatus = ({ store, readBootHistory = () => ({ entries: [] }), getWatchdogStatus = () => ({}) }) => {
  const entries = (() => { try { return readBootHistory()?.entries || []; } catch { return []; } })();
  const lastExit = (() => { try { return getWatchdogStatus()?.lastExit || null; } catch { return null; } })();
  return {
    ok: true,
    gateway: store.read(),
    lastBoot: projectBoot(entries.at(-1)),
    previousBoot: projectBoot(entries.at(-2)),
    boots: entries.toReversed().map(projectBoot),
    lastGatewayExit: lastExit ? {
      at: lastExit.at ?? null,
      code: lastExit.code ?? null,
      signal: lastExit.signal ?? null,
      cause: lastExit.cause ?? null,
    } : null,
  };
};

module.exports = { createLastRestartStore, readRestartStatus, kLastRestartFileName };
