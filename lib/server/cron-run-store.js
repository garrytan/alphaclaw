const fs = require("fs");
const path = require("path");
const { openTrackedReadonlyDatabase, resolveOpenclawStateDbPath, hasTable } = require("./openclaw-state-db");
const { isStateDbQuiet, StateDbQuietError } = require("./state-db-quiet");
const { sanitizeCronJobId, normalizeRunStatus, normalizeDeliveryStatus, parseRunLogLine } = require("./cron-run-files");
const { compareVersionParts } = require("./helpers");
const { CronHistoryUnavailableError } = require("./cron-run-errors");

const kBatchSize = 50;
const runtimeBackend = (version) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) return null;
  if (compareVersionParts(version, "2026.5.30-beta.1") < 0) return "file";
  return compareVersionParts(version, "2026.7.2-beta.1") < 0 ? "legacy" : "task";
};

const readShape = (db, backend) => {
  if (!backend) {
    const hasLegacy = hasTable(db, "cron_run_logs");
    const hasTasks = hasTable(db, "task_runs");
    if (hasLegacy === hasTasks) throw new Error("Ambiguous cron history authority");
    backend = hasLegacy ? "legacy" : "task";
  }
  const legacy = backend === "legacy";
  const table = legacy ? "cron_run_logs" : "task_runs";
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const required = legacy
    ? ["store_key", "job_id", "ts", "seq", "entry_json"]
    : ["task_id", "runtime", "source_id", "created_at", "ended_at", "last_event_at", "child_session_key", "error", "terminal_summary", "detail_json"];
  if (!required.every((name) => columns.has(name))) throw new Error("Unsupported cron history schema");
  const indexes = db.prepare("SELECT (SELECT group_concat(name, ',') FROM pragma_index_info(idx.name)) AS columns FROM pragma_index_list(?) AS idx WHERE idx.partial = 0").all(table);
  const prefix = legacy ? "store_key,job_id," : "runtime,source_id,ended_at,";
  if (!indexes.some((index) => index.columns?.startsWith(prefix))) throw new Error("Unsupported cron history indexes");
  const json = legacy ? "entry_json" : "detail_json";
  const value = (key, column) => {
    const detail = `json_extract(${json}, '$.${key}')`;
    if (!column || !columns.has(column)) return detail;
    return legacy ? `COALESCE(${column}, ${detail})` : `CASE WHEN json_type(${json}, '$.${key}') IS NULL THEN ${column} ELSE ${detail} END`;
  };
  const text = (key, column) => {
    const expression = value(key, column);
    return `CASE WHEN typeof(${expression}) = 'text' THEN ${expression} ELSE NULL END`;
  };
  return {
    table, legacy, json, value, text,
    job: legacy ? "job_id" : "source_id",
    tie: legacy ? "seq" : "created_at, task_id",
    partition: legacy ? "store_key = ?" : "runtime = 'cron'",
    visible: legacy
      ? "json_extract(entry_json, '$.action') = 'finished' AND json_extract(entry_json, '$.jobId') = job_id"
      : "json_extract(detail_json, '$.kind') = 'cron-run' AND json_extract(detail_json, '$.storeKey') = ?",
  };
};

const projectRow = (shape, row) => {
  const detail = JSON.parse(row[shape.json]);
  const entry = shape.legacy ? { ...detail } : {
    error: row.error, summary: row.terminal_summary, ...detail,
    action: "finished", jobId: row.source_id, ts: row.ts,
    sessionKey: row.child_session_key ?? undefined,
  };
  if (shape.legacy) {
    for (const [column, key] of [
      ["ts", "ts"], ["job_id", "jobId"], ["status", "status"], ["error", "error"],
      ["summary", "summary"], ["delivery_status", "deliveryStatus"], ["delivery_error", "deliveryError"],
      ["session_id", "sessionId"], ["session_key", "sessionKey"], ["run_at_ms", "runAtMs"],
      ["duration_ms", "durationMs"], ["next_run_at_ms", "nextRunAtMs"], ["model", "model"], ["provider", "provider"],
    ]) {
      if (row[column] != null) entry[key] = row[column];
    }
    if (row.delivered != null) entry.delivered = Number(row.delivered) !== 0;
  }
  for (const key of ["status", "error", "summary", "deliveryStatus", "deliveryError", "sessionId", "sessionKey", "model", "provider"]) {
    if (typeof entry[key] !== "string") delete entry[key];
  }
  for (const key of ["runAtMs", "durationMs", "nextRunAtMs"]) {
    if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) delete entry[key];
  }
  const parsed = parseRunLogLine(JSON.stringify(entry), entry.jobId);
  if (!parsed) throw new Error("Invalid cron outcome");
  return parsed;
};

const makeReader = (db, shape, storeKey, databasePath) => {
  db.function("cron_contains", (text, query) => String(text || "").toLowerCase().includes(query) ? 1 : 0);
  const select = ({ jobId, sinceMs = 0, untilMs = null, status, deliveryStatus, query, sortDir = "desc", limit, offset = 0, count = false, ordered = true }) => {
    const job = sanitizeCronJobId(jobId);
    const clauses = [shape.partition, `${shape.job} = ?`, shape.visible];
    const params = shape.legacy ? [storeKey, job] : [job, storeKey];
    const normalizedStatus = normalizeRunStatus(status);
    const normalizedDelivery = normalizeDeliveryStatus(deliveryStatus);
    if (normalizedStatus !== "all") {
      clauses.push(`${shape.value("status", shape.legacy ? "status" : null)} = ?`);
      params.push(normalizedStatus);
    }
    if (normalizedDelivery !== "all") {
      clauses.push(`COALESCE(${shape.text("deliveryStatus", shape.legacy ? "delivery_status" : null)}, 'not-requested') = ?`);
      params.push(normalizedDelivery);
    }
    const queryText = String(query || "").trim().toLowerCase();
    if (queryText) {
      const fields = ["summary", "error", "model", "provider"].map((key) => `COALESCE(${shape.text(key, shape.legacy ? key : key === "summary" ? "terminal_summary" : key === "error" ? "error" : null)}, '')`);
      clauses.push(`cron_contains(${fields.join(" || ' ' || ")}, ?)`);
      params.push(queryText);
    }
    const direction = sortDir === "asc" ? "ASC" : "DESC";
    const branches = shape.legacy ? [["ts", "ts > 0"]] : [
      ["ended_at", "ended_at IS NOT NULL AND ended_at > 0"],
      ["COALESCE(last_event_at, created_at)", "ended_at IS NULL AND COALESCE(last_event_at, created_at) > 0"],
    ];
    const allParams = [];
    const selects = branches.map(([timestamp, predicate]) => {
      const where = [...clauses, predicate];
      const branchParams = [...params];
      if (sinceMs > 0) { where.push(`${timestamp} >= ?`); branchParams.push(sinceMs); }
      if (untilMs != null) { where.push(`${timestamp} <= ?`); branchParams.push(untilMs); }
      allParams.push(...branchParams);
      return `SELECT ${count ? "COUNT(*) AS count" : `*, ${timestamp} AS ts`} FROM ${shape.table} WHERE ${where.join(" AND ")}`;
    });
    let sql = selects.join(" UNION ALL ");
    if (count) sql = `SELECT SUM(count) AS total FROM (${sql})`;
    else {
      if (ordered) sql += ` ORDER BY ts ${direction}, ${shape.tie.split(", ").map((key) => `${key} ${direction}`).join(", ")}`;
      if (limit != null) { sql += " LIMIT ? OFFSET ?"; allParams.push(limit, offset); }
    }
    return { sql, params: allParams };
  };
  const readPage = (options) => {
    const limit = Math.max(1, Math.min(200, Number.parseInt(options.limit, 10) || 20));
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const count = select({ ...options, count: true });
    const total = db.prepare(count.sql).get(...count.params).total;
    const page = select({ ...options, limit, offset });
    const entries = db.prepare(page.sql).all(...page.params).map((row) => projectRow(shape, row));
    const nextOffset = offset + entries.length;
    return { runLogPath: databasePath, entries, total, offset, limit, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
  };
  const readPages = (jobIds, options) => {
    const byJobId = Object.fromEntries(jobIds.map((jobId) => [jobId, []]));
    for (let start = 0; start < jobIds.length; start += kBatchSize) {
      const queries = jobIds.slice(start, start + kBatchSize).map((jobId) => select({ ...options, jobId, offset: 0 }));
      const rows = db.prepare(queries.map(({ sql }) => `SELECT * FROM (${sql})`).join(" UNION ALL ")).all(...queries.flatMap(({ params }) => params));
      for (const row of rows) {
        const entry = projectRow(shape, row);
        byJobId[entry.jobId].push(entry);
      }
    }
    return byJobId;
  };
  const visit = (options, fn) => {
    const query = select({ ...options, ordered: false });
    for (const row of db.prepare(query.sql).iterate(...query.params)) fn(projectRow(shape, row));
  };
  const durationStats = (options) => {
    const query = select({ ...options, ordered: false });
    const duration = shape.value("durationMs", shape.legacy ? "duration_ms" : null);
    const row = db.prepare(`SELECT COALESCE(SUM(duration), 0) AS totalDurationMs, COUNT(*) AS sampleCount FROM (SELECT ${duration} AS duration FROM (${query.sql})) WHERE typeof(duration) IN ('integer', 'real') AND duration BETWEEN 0 AND 9007199254740991 AND duration = CAST(duration AS INTEGER)`).get(...query.params);
    return { ...row, avgDurationMs: row.sampleCount > 0 ? Math.round(row.totalDurationMs / row.sampleCount) : 0 };
  };
  return { readPage, readPages, visit, durationStats };
};

const createCronRunStore = ({ openclawDir, getInstalledVersion }) => {
  let observedDatabase = false;
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  const storeKey = path.resolve(openclawDir, "cron", "jobs.json");
  return (read) => {
    if (isStateDbQuiet()) throw new StateDbQuietError();
    let db;
    try {
      const version = getInstalledVersion ? String(getInstalledVersion() || "") : "";
      const backend = runtimeBackend(version);
      if (backend === "file") return null;
      try {
        fs.statSync(databasePath);
      } catch (error) {
        if (error.code === "ENOENT" && !observedDatabase && !getInstalledVersion) return null;
        throw error;
      }
      observedDatabase = true;
      db = openTrackedReadonlyDatabase(databasePath);
      db.exec("BEGIN");
      return read(makeReader(db, readShape(db, backend), storeKey, databasePath));
    } catch (error) {
      throw new CronHistoryUnavailableError(error);
    } finally {
      if (db) db.close();
    }
  };
};

module.exports = { createCronRunStore };
