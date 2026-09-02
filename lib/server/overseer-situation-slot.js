// Persistence for the overseer's standalone situation report — a review that
// belongs to no incident row, so it cannot ride `watchdog_incidents.
// overseer_json`. Backed by one watchdog_meta key via the DI'd read/write.
//
// Record shape (v1):
//   { v: 1,
//     current:     the latest attempt (pending | done | failed | unavailable),
//     lastVerdict: the most recent `done` current — kept even when later
//                  attempts fail, so the card never loses a good report to
//                  three failed retries,
//     history:     [<=3 superseded currents] }
//
// Every reader goes through readRecord(): a `pending` older than the stale
// window (a crash mid-report) is rewritten to `failed` on the way out, so no
// consumer can show an eternal spinner. start() additionally clears ANY
// pending at boot — nothing can be in flight when the process starts.
const kHistoryKeep = 3;
const kStalePendingMs = 10 * 60 * 1000;
const kInterruptedSummary = "Interrupted by a server restart.";
// A pending found stale on READ was not necessarily cut by a restart (the run
// may have thrown after its stamp, or its final write failed) — say only what
// is known.
const kStaleSummary = "The situation report did not finish — no result was saved.";

// ALLOWLIST for the API projection: a field reaches the browser only by being
// named here. transcriptTail (raw model output) and any future server-only
// field stay behind the boundary by default.
const kApiFields = [
  "state",
  "verdict",
  "action",
  "headline",
  "summary",
  "recommendation",
  "manual",
  "situation",
  "at",
  "evidence",
  "reason",
];

const projectRecordForApi = (current) => {
  if (!current || typeof current !== "object") return null;
  const projected = {};
  for (const key of kApiFields) {
    if (current[key] !== undefined) projected[key] = current[key];
  }
  return projected;
};

const isRecord = (value) => value != null && typeof value === "object";

const emptyRecord = (unreadable = false) => ({
  current: null,
  lastVerdict: null,
  history: [],
  unreadable,
});

const createSituationSlot = ({
  read,
  write,
  nowFn = Date.now,
  log = () => {},
  stalePendingMs = kStalePendingMs,
} = {}) => {
  let unreadableLogged = false;
  let writeFailedLogged = false;

  const normalize = (tagged) => {
    if (!isRecord(tagged) || tagged.ok === false) {
      return emptyRecord(tagged?.reason === "unreadable");
    }
    const record = tagged.record;
    if (!isRecord(record)) return emptyRecord(false);
    // A blob written by a newer record version (rollback scenario) is not
    // shape-sniffed and never rewritten as v1: treat it as unreadable so the
    // card says so and the next review replaces it wholesale.
    if (Number.isFinite(record.v) && record.v > 1) return emptyRecord(true);
    return {
      current: isRecord(record.current) ? record.current : null,
      lastVerdict: isRecord(record.lastVerdict) ? record.lastVerdict : null,
      history: Array.isArray(record.history) ? record.history : [],
      unreadable: false,
    };
  };

  const readRaw = () => {
    try {
      return normalize(typeof read === "function" ? read() : null);
    } catch (error) {
      log(`situation slot read failed: ${error.message}`);
      return emptyRecord(true);
    }
  };

  const persistRecord = ({ current, lastVerdict, history }) => {
    try {
      if (typeof write !== "function") return { ok: false, error: "no writer" };
      const ok = write({ v: 1, current, lastVerdict, history });
      return ok ? { ok: true } : { ok: false, error: "write returned false" };
    } catch (error) {
      // Once per process: a read-only db would otherwise log on every 15s poll
      // that trips the stale-pending rewrite.
      if (!writeFailedLogged) {
        writeFailedLogged = true;
        log(`situation slot write failed: ${error.message}`);
      }
      return { ok: false, error: error.message };
    }
  };

  const interrupted = (current, { reason = "interrupted", summary = kInterruptedSummary } = {}) => ({
    ...current,
    state: "failed",
    reason,
    summary,
    at: nowFn(),
  });

  const readRecord = () => {
    const record = readRaw();
    if (record.unreadable && !unreadableLogged) {
      unreadableLogged = true;
      log("situation record is unreadable (corrupt blob); a new review replaces it");
    }
    const current = record.current;
    if (current?.state === "pending" && nowFn() - (current.at || 0) > stalePendingMs) {
      record.current = interrupted(current, { reason: "stale", summary: kStaleSummary });
      persistRecord(record);
    }
    return record;
  };

  // `supersede` pushes the previous current into history — used when a NEW
  // attempt starts (its pending stamp replaces the prior verdict). The final
  // done/failed write of the same attempt replaces the pending in place.
  const persist = (current, { supersede = false } = {}) => {
    const record = readRaw();
    const history =
      supersede && record.current
        ? [record.current, ...record.history].slice(0, kHistoryKeep)
        : record.history;
    const lastVerdict = current?.state === "done" ? current : record.lastVerdict;
    return persistRecord({ current, lastVerdict, history });
  };

  const markPendingInterrupted = () => {
    const record = readRaw();
    if (record.current?.state !== "pending") return false;
    record.current = interrupted(record.current);
    return persistRecord(record).ok;
  };

  const projectForApi = (record) => ({
    current: projectRecordForApi(record.current),
    lastVerdict: projectRecordForApi(record.lastVerdict),
    ...(record.unreadable ? { unreadable: true } : {}),
  });

  return { readRecord, persist, markPendingInterrupted, projectForApi };
};

module.exports = {
  createSituationSlot,
  projectRecordForApi,
  kStalePendingMs,
};
