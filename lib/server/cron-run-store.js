const path = require("path");
const { openReadonlyDatabase, resolveOpenclawStateDbPath } = require("./openclaw-state-db");
const { sanitizeCronJobId, normalizeRunStatus, normalizeDeliveryStatus, parseRunLogLine } = require("./cron-run-files");
const { CronHistoryUnavailableError } = require("./cron-run-errors");

const kBatchSize = 50;
const kRequiredColumns = ["task_id", "runtime", "source_id", "created_at", "ended_at", "last_event_at", "child_session_key", "error", "terminal_summary", "detail_json"];

// Every supported OpenClaw (2026.9.3+) records cron outcomes as `task_runs`
// rows. The guard refuses any other table shape instead of guessing.
const readShape = (db) => {
  const columns = new Set(db.prepare("PRAGMA table_info(task_runs)").all().map((row) => row.name));
  if (!kRequiredColumns.every((name) => columns.has(name))) throw new Error("Unsupported cron history schema");
  const indexes = db.prepare("SELECT (SELECT group_concat(name, ',') FROM pragma_index_info(idx.name)) AS columns FROM pragma_index_list(?) AS idx WHERE idx.partial = 0").all("task_runs");
  if (!indexes.some((index) => index.columns?.startsWith("runtime,source_id,ended_at,"))) throw new Error("Unsupported cron history indexes");
  const value = (key, column) => {
    const detail = `json_extract(detail_json, '$.${key}')`;
    if (!column) return detail;
    return `CASE WHEN json_type(detail_json, '$.${key}') IS NULL THEN ${column} ELSE ${detail} END`;
  };
  const text = (key, column) => {
    const expression = value(key, column);
    return `CASE WHEN typeof(${expression}) = 'text' THEN ${expression} ELSE NULL END`;
  };
  return { value, text };
};

const projectRow = (row) => {
  const entry = {
    error: row.error, summary: row.terminal_summary, ...JSON.parse(row.detail_json),
    action: "finished", jobId: row.source_id, ts: row.ts,
    sessionKey: row.child_session_key ?? undefined,
  };
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
    const clauses = ["runtime = 'cron'", "source_id = ?", "json_extract(detail_json, '$.kind') = 'cron-run'", "json_extract(detail_json, '$.storeKey') = ?"];
    const params = [job, storeKey];
    const normalizedStatus = normalizeRunStatus(status);
    const normalizedDelivery = normalizeDeliveryStatus(deliveryStatus);
    if (normalizedStatus !== "all") {
      clauses.push(`${shape.value("status")} = ?`);
      params.push(normalizedStatus);
    }
    if (normalizedDelivery !== "all") {
      clauses.push(`COALESCE(${shape.text("deliveryStatus")}, 'not-requested') = ?`);
      params.push(normalizedDelivery);
    }
    const queryText = String(query || "").trim().toLowerCase();
    if (queryText) {
      const fields = ["summary", "error", "model", "provider"].map((key) => `COALESCE(${shape.text(key, { summary: "terminal_summary", error: "error" }[key])}, '')`);
      clauses.push(`cron_contains(${fields.join(" || ' ' || ")}, ?)`);
      params.push(queryText);
    }
    const direction = sortDir === "asc" ? "ASC" : "DESC";
    const branches = [
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
      return `SELECT ${count ? "COUNT(*) AS count" : `*, ${timestamp} AS ts`} FROM task_runs WHERE ${where.join(" AND ")}`;
    });
    let sql = selects.join(" UNION ALL ");
    if (count) sql = `SELECT SUM(count) AS total FROM (${sql})`;
    else {
      if (ordered) sql += ` ORDER BY ts ${direction}, created_at ${direction}, task_id ${direction}`;
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
    const entries = db.prepare(page.sql).all(...page.params).map(projectRow);
    const nextOffset = offset + entries.length;
    return { runLogPath: databasePath, entries, total, offset, limit, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
  };
  const readPages = (jobIds, options) => {
    const byJobId = Object.fromEntries(jobIds.map((jobId) => [jobId, []]));
    for (let start = 0; start < jobIds.length; start += kBatchSize) {
      const queries = jobIds.slice(start, start + kBatchSize).map((jobId) => select({ ...options, jobId, offset: 0 }));
      const rows = db.prepare(queries.map(({ sql }) => `SELECT * FROM (${sql})`).join(" UNION ALL ")).all(...queries.flatMap(({ params }) => params));
      for (const row of rows) {
        const entry = projectRow(row);
        byJobId[entry.jobId].push(entry);
      }
    }
    return byJobId;
  };
  const visit = (options, fn) => {
    const query = select({ ...options, ordered: false });
    for (const row of db.prepare(query.sql).iterate(...query.params)) fn(projectRow(row));
  };
  const durationStats = (options) => {
    const query = select({ ...options, ordered: false });
    const duration = shape.value("durationMs");
    const row = db.prepare(`SELECT COALESCE(SUM(duration), 0) AS totalDurationMs, COUNT(*) AS sampleCount FROM (SELECT ${duration} AS duration FROM (${query.sql})) WHERE typeof(duration) IN ('integer', 'real') AND duration BETWEEN 0 AND 9007199254740991 AND duration = CAST(duration AS INTEGER)`).get(...query.params);
    return { ...row, avgDurationMs: row.sampleCount > 0 ? Math.round(row.totalDurationMs / row.sampleCount) : 0 };
  };
  return { readPage, readPages, visit, durationStats };
};

const createCronRunStore = ({ openclawDir }) => {
  const databasePath = resolveOpenclawStateDbPath({ openclawDir });
  const storeKey = path.resolve(openclawDir, "cron", "jobs.json");
  return (read) => {
    let db;
    try {
      db = openReadonlyDatabase(databasePath);
      db.exec("BEGIN");
      return read(makeReader(db, readShape(db), storeKey, databasePath));
    } catch (error) {
      throw new CronHistoryUnavailableError(error);
    } finally {
      if (db) db.close();
    }
  };
};

module.exports = { createCronRunStore };
