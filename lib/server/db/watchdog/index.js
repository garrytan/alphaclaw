const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createSchema, kNotableEventsPredicateSql } = require("./schema");

let db = null;
let pruneTimer = null;
// Prepared statements are tied to the connection they came from; the cache is
// cleared whenever the connection changes (init/close).
const stmtCache = new Map();

const kDefaultLimit = 20;
const kMaxLimit = 200;
const kPruneIntervalMs = 12 * 60 * 60 * 1000;

const ensureDb = () => {
  if (!db) throw new Error("Watchdog DB not initialized");
  return db;
};

const prepareCached = (sql) => {
  const database = ensureDb();
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = database.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
};

const closeWatchdogDb = () => {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  stmtCache.clear();
  if (!db) return;
  const database = db;
  db = null;
  database.close();
};

const initWatchdogDb = ({ rootDir, pruneDays = 30 }) => {
  closeWatchdogDb();
  const dbDir = path.join(rootDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "watchdog.db");
  stmtCache.clear();
  db = new DatabaseSync(dbPath);
  createSchema(db);
  pruneWatchdogEvents(pruneDays);
  pruneTimer = setInterval(() => {
    try {
      pruneWatchdogEvents(pruneDays);
    } catch (err) {
      console.error(`[watchdog-db] prune error: ${err.message}`);
    }
  }, kPruneIntervalMs);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
  return { path: dbPath };
};

const insertWatchdogEvent = ({
  eventType,
  source,
  status,
  details = null,
  correlationId = "",
}) => {
  const stmt = prepareCached(`
    INSERT INTO watchdog_events (
      event_type,
      source,
      status,
      details,
      correlation_id
    ) VALUES (
      $event_type,
      $source,
      $status,
      $details,
      $correlation_id
    )
  `);
  const result = stmt.run({
    $event_type: String(eventType || ""),
    $source: String(source || ""),
    $status: String(status || "failed"),
    $details:
      details == null
        ? null
        : typeof details === "string"
          ? details
          : JSON.stringify(details),
    $correlation_id: String(correlationId || ""),
  });
  return Number(result.lastInsertRowid || 0);
};

const getRecentEvents = ({ limit = kDefaultLimit, includeRoutine = false } = {}) => {
  const safeLimit = Math.max(
    1,
    Math.min(Number.parseInt(String(limit || kDefaultLimit), 10) || kDefaultLimit, kMaxLimit),
  );
  const whereClause = includeRoutine ? "" : `WHERE ${kNotableEventsPredicateSql}`;
  const rows = prepareCached(`
      SELECT id, event_type, source, status, details, correlation_id, created_at
      FROM watchdog_events
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $limit
    `).all({ $limit: safeLimit });
  const mapped = rows.map((row) => {
    let parsedDetails = row.details;
    if (typeof row.details === "string" && row.details) {
      try {
        parsedDetails = JSON.parse(row.details);
      } catch {}
    }
    return {
      id: row.id,
      eventType: row.event_type,
      source: row.source,
      status: row.status,
      details: parsedDetails,
      correlationId: row.correlation_id || "",
      createdAt: row.created_at,
    };
  });
  return mapped;
};

const pruneWatchdogEvents = (days = 30) => {
  const safeDays = Math.max(1, Number.parseInt(String(days || 30), 10) || 30);
  const modifier = `-${safeDays} days`;
  const result = prepareCached(`
      DELETE FROM watchdog_events
      WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $modifier)
    `).run({ $modifier: modifier });
  return Number(result.changes || 0);
};

module.exports = {
  initWatchdogDb,
  closeWatchdogDb,
  insertWatchdogEvent,
  getRecentEvents,
  pruneWatchdogEvents,
  kNotableEventsPredicateSql,
};
