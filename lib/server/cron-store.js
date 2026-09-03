const fs = require("fs");
const path = require("path");
const { openReadonlyOpenclawStateDb, hasTable } = require("./openclaw-state-db");

const kCronStoreFile = "jobs.json";

const readJsonFile = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const parseJsonObject = (value, fallback = {}) => {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
};

const normalizeJobs = (storeValue) => {
  if (!storeValue || typeof storeValue !== "object") return [];
  if (!Array.isArray(storeValue.jobs)) return [];
  return storeValue.jobs
    .filter((job) => job && typeof job === "object")
    .map((job) => ({
      ...job,
      id: String(job.id || "").trim(),
      name: String(job.name || "").trim(),
      enabled: job.enabled !== false,
      state: job.state && typeof job.state === "object" ? job.state : {},
      payload: job.payload && typeof job.payload === "object" ? job.payload : {},
      delivery: job.delivery && typeof job.delivery === "object" ? job.delivery : {},
      schedule: job.schedule && typeof job.schedule === "object" ? job.schedule : {},
    }))
    .filter((job) => job.id);
};

const applyProjectedStateValue = ({ state, row, column, property, transform }) => {
  if (row[column] == null) return;
  state[property] = transform ? transform(row[column]) : Number(row[column]);
};

const readStateFromSqliteRow = (row) => {
  const state = parseJsonObject(row.state_json, {});
  const numericColumns = [
    ["next_run_at_ms", "nextRunAtMs"],
    ["running_at_ms", "runningAtMs"],
    ["last_run_at_ms", "lastRunAtMs"],
    ["last_duration_ms", "lastDurationMs"],
    ["consecutive_errors", "consecutiveErrors"],
    ["consecutive_skipped", "consecutiveSkipped"],
    ["schedule_error_count", "scheduleErrorCount"],
    ["last_failure_alert_at_ms", "lastFailureAlertAtMs"],
  ];
  numericColumns.forEach(([column, property]) => {
    applyProjectedStateValue({ state, row, column, property });
  });

  const stringColumns = [
    ["last_run_status", "lastRunStatus"],
    ["last_error", "lastError"],
    ["last_delivery_status", "lastDeliveryStatus"],
    ["last_delivery_error", "lastDeliveryError"],
  ];
  stringColumns.forEach(([column, property]) => {
    applyProjectedStateValue({
      state,
      row,
      column,
      property,
      transform: (value) => String(value),
    });
  });
  applyProjectedStateValue({
    state,
    row,
    column: "last_delivered",
    property: "lastDelivered",
    transform: (value) => Number(value) !== 0,
  });
  return state;
};

const readJobFromSqliteRow = (row) => {
  const job = parseJsonObject(row.job_json, null);
  if (!job) return null;
  const updatedAtMs = Number(row.runtime_updated_at_ms ?? row.updated_at);
  return {
    ...job,
    ...(Number.isFinite(updatedAtMs) ? { updatedAtMs } : {}),
    state: readStateFromSqliteRow(row),
  };
};

// Lazy connection cache keyed by openclawDir: listJobs used to open (and
// close) a fresh DatabaseSync handle on EVERY call — a sync open per poll on
// the hot path. Handles are reopened after a short TTL so a db file swapped
// underneath us (OpenClaw rotation/upgrade) is picked up within 30s.
const stateDbHandles = new Map(); // openclawDir -> { handle, openedAt }
const kStateDbReopenTtlMs = 30000;

const closeCronStoreDb = () => {
  for (const entry of stateDbHandles.values()) {
    try {
      entry.handle.db.close();
    } catch {}
  }
  stateDbHandles.clear();
};

const dropStateDbHandle = (openclawDir) => {
  const entry = stateDbHandles.get(openclawDir);
  if (!entry) return;
  try {
    entry.handle.db.close();
  } catch {}
  stateDbHandles.delete(openclawDir);
};

const getStateDbHandle = ({ openclawDir }) => {
  const cached = stateDbHandles.get(openclawDir);
  if (cached && Date.now() - cached.openedAt >= kStateDbReopenTtlMs) {
    dropStateDbHandle(openclawDir);
  } else if (cached) {
    try {
      // Cheap liveness probe; a closed/stale handle throws and is replaced.
      cached.handle.db.prepare("SELECT 1").get();
      return cached.handle;
    } catch {
      dropStateDbHandle(openclawDir);
    }
  }
  const handle = openReadonlyOpenclawStateDb({ openclawDir });
  if (handle) stateDbHandles.set(openclawDir, { handle, openedAt: Date.now() });
  return handle;
};

const readSqliteCronStore = ({ openclawDir, legacyStorePath }) => {
  const handle = getStateDbHandle({ openclawDir });
  if (!handle) return null;

  const { db, databasePath } = handle;
  try {
    if (!hasTable(db, "cron_jobs")) return null;

    const rows = db
      .prepare(
        "SELECT * FROM cron_jobs WHERE store_key = ? " +
          "ORDER BY sort_order ASC, updated_at ASC, job_id ASC",
      )
      .all(path.resolve(legacyStorePath));
    const jobs = rows.map(readJobFromSqliteRow).filter(Boolean);
    return {
      storePath: databasePath,
      version: 1,
      jobs: normalizeJobs({ jobs }),
    };
  } catch (error) {
    // A handle that went bad mid-query (db swapped/rotated underneath us) is
    // dropped so the next call reopens cleanly.
    dropStateDbHandle(openclawDir);
    throw error;
  }
};

const readCronStore = ({ openclawDir }) => {
  const cronDir = path.join(openclawDir, "cron");
  const legacyStorePath = path.join(cronDir, kCronStoreFile);
  const sqliteStore = readSqliteCronStore({ openclawDir, legacyStorePath });
  if (sqliteStore) return sqliteStore;

  return {
    storePath: legacyStorePath,
    version: 1,
    jobs: normalizeJobs(readJsonFile(legacyStorePath)),
  };
};

module.exports = {
  readCronStore,
  closeCronStoreDb,
};
