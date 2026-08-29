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
  // WAL keeps readers unblocked during writes; NORMAL sync is the standard
  // WAL pairing (durable enough for operational telemetry, far fewer fsyncs).
  // busy_timeout FIRST: the one-time WAL migration needs an exclusive lock,
  // and running it with the default timeout of 0 throws SQLITE_BUSY (a boot
  // crash) if a draining predecessor process still holds a write lock; 10s
  // covers the predecessor's full shutdown-drain deadline.
  db.exec("PRAGMA busy_timeout = 10000;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  createSchema(db);
  pruneWatchdogEvents(pruneDays);
  pruneWatchdogIncidents(pruneDays);
  pruneTimer = setInterval(() => {
    try {
      pruneWatchdogEvents(pruneDays);
      pruneWatchdogIncidents(pruneDays);
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
  // Stamped only by the incident tracker's wrapped sink; every other caller
  // (topic registry/discovery, release channel) leaves events unstamped.
  incidentId = null,
}) => {
  const stmt = prepareCached(`
    INSERT INTO watchdog_events (
      event_type,
      source,
      status,
      details,
      correlation_id,
      incident_id
    ) VALUES (
      $event_type,
      $source,
      $status,
      $details,
      $correlation_id,
      $incident_id
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
    $incident_id: Number.isInteger(incidentId) && incidentId > 0 ? incidentId : null,
  });
  return Number(result.lastInsertRowid || 0);
};

// Single synchronous DatabaseSync connection: BEGIN IMMEDIATE serializes the
// open+stamp+event write so an incident row can never exist without its
// opening event (or vice versa). Callers must be synchronous inside fn.
const withTransaction = (fn) => {
  const database = ensureDb();
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    database.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK;");
    } catch {}
    throw err;
  }
};

const safeParseJson = (raw) => {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt blob: render "record unreadable" downstream, never a 500.
    return { unreadable: true };
  }
};

// The one-open unique index means an orphaned open row (a tracker error
// mid-incident, a crash between writes) would block every future insert; the
// tracker adopts it instead of failing forever.
const getOpenIncident = () => {
  const database = ensureDb();
  const row = database
    .prepare(
      "SELECT id, incident_key, opened_at FROM watchdog_incidents WHERE status = 'open' LIMIT 1",
    )
    .get();
  return row
    ? { id: Number(row.id), incidentKey: row.incident_key, openedAt: row.opened_at }
    : null;
};

const insertIncident = ({ incidentKey }) => {
  const database = ensureDb();
  const result = database
    .prepare(
      "INSERT INTO watchdog_incidents (incident_key, status) VALUES ($key, 'open')",
    )
    .run({ $key: String(incidentKey || "gateway_degraded") });
  return Number(result.lastInsertRowid || 0);
};

const resolveIncident = (
  incidentId,
  { status = "resolved", summaryJson = null } = {},
) => {
  const database = ensureDb();
  const result = database
    .prepare(`
      UPDATE watchdog_incidents
      SET status = $status,
          resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          summary_json = COALESCE($summary, summary_json)
      WHERE id = $id AND status = 'open'
    `)
    .run({
      $status: String(status || "resolved"),
      $summary: summaryJson == null ? null : JSON.stringify(summaryJson),
      $id: Number(incidentId),
    });
  return Number(result.changes || 0) > 0;
};

const updateIncidentSummary = (incidentId, summaryJson) => {
  const database = ensureDb();
  const result = database
    .prepare(
      "UPDATE watchdog_incidents SET summary_json = $summary WHERE id = $id",
    )
    .run({ $summary: JSON.stringify(summaryJson), $id: Number(incidentId) });
  return Number(result.changes || 0) > 0;
};

const updateIncidentOverseer = (incidentId, overseerJson) => {
  const database = ensureDb();
  const result = database
    .prepare(
      "UPDATE watchdog_incidents SET overseer_json = $overseer WHERE id = $id",
    )
    .run({ $overseer: JSON.stringify(overseerJson), $id: Number(incidentId) });
  return Number(result.changes || 0) > 0;
};

// Boot scan: a process restart mid-incident leaves an `open` row behind.
// Terminal timestamp = the incident's LAST stamped event (not boot time), so
// duration and the overseer's log window stay truthful.
const abandonOpenIncidents = () => {
  const database = ensureDb();
  const openRows = database
    .prepare("SELECT id FROM watchdog_incidents WHERE status = 'open'")
    .all();
  if (!openRows.length) return [];
  database
    .prepare(`
      UPDATE watchdog_incidents
      SET status = 'abandoned',
          resolved_at = COALESCE(
            (SELECT MAX(created_at) FROM watchdog_events
             WHERE watchdog_events.incident_id = watchdog_incidents.id),
            opened_at
          )
      WHERE status = 'open'
    `)
    .run();
  return openRows.map((row) => Number(row.id));
};

const mapIncidentRow = (row) => ({
  id: Number(row.id),
  incidentKey: row.incident_key,
  status: row.status,
  openedAt: row.opened_at,
  resolvedAt: row.resolved_at || null,
  summary: safeParseJson(row.summary_json),
  overseer: safeParseJson(row.overseer_json),
  eventCount: Number(row.event_count || 0),
});

const kIncidentListDefaultLimit = 10;
const kIncidentListMaxLimit = 50;

const listIncidents = ({ limit = kIncidentListDefaultLimit, before = null } = {}) => {
  const database = ensureDb();
  const safeLimit = Math.max(
    1,
    Math.min(
      Number.parseInt(String(limit || kIncidentListDefaultLimit), 10) ||
        kIncidentListDefaultLimit,
      kIncidentListMaxLimit,
    ),
  );
  const beforeId = Number.parseInt(String(before ?? ""), 10);
  const whereClause = Number.isInteger(beforeId) && beforeId > 0 ? "WHERE i.id < $before" : "";
  const params = { $limit: safeLimit };
  if (whereClause) params.$before = beforeId;
  const rows = database
    .prepare(`
      SELECT i.*, (
        SELECT COUNT(*) FROM watchdog_events e WHERE e.incident_id = i.id
      ) AS event_count
      FROM watchdog_incidents i
      ${whereClause}
      ORDER BY i.id DESC
      LIMIT $limit
    `)
    .all(params);
  return rows.map(mapIncidentRow);
};

const getIncidentById = (incidentId) => {
  const database = ensureDb();
  const row = database
    .prepare(`
      SELECT i.*, (
        SELECT COUNT(*) FROM watchdog_events e WHERE e.incident_id = i.id
      ) AS event_count
      FROM watchdog_incidents i WHERE i.id = $id
    `)
    .get({ $id: Number(incidentId) });
  return row ? mapIncidentRow(row) : null;
};

const kIncidentEventsMaxLimit = 200;

// First N chronologically: the trigger story matters more than the tail, and
// the rollup carries the outcome. totalCount lets the route emit an honest
// truncation marker.
const getIncidentEvents = (incidentId, { limit = kIncidentEventsMaxLimit } = {}) => {
  const database = ensureDb();
  const safeLimit = Math.max(
    1,
    Math.min(
      Number.parseInt(String(limit || kIncidentEventsMaxLimit), 10) ||
        kIncidentEventsMaxLimit,
      kIncidentEventsMaxLimit,
    ),
  );
  const totalRow = database
    .prepare(
      "SELECT COUNT(*) AS total FROM watchdog_events WHERE incident_id = $id",
    )
    .get({ $id: Number(incidentId) });
  const rows = database
    .prepare(`
      SELECT id, event_type, source, status, details, correlation_id, created_at
      FROM watchdog_events
      WHERE incident_id = $id
      ORDER BY id ASC
      LIMIT $limit
    `)
    .all({ $id: Number(incidentId), $limit: safeLimit });
  return {
    totalCount: Number(totalRow?.total || 0),
    events: rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      source: row.source,
      status: row.status,
      details: safeParseJson(row.details) ?? row.details,
      correlationId: row.correlation_id || "",
      createdAt: row.created_at,
    })),
  };
};

const pruneWatchdogIncidents = (days = 30) => {
  const database = ensureDb();
  const safeDays = Math.max(1, Number.parseInt(String(days || 30), 10) || 30);
  const modifier = `-${safeDays} days`;
  const result = database
    .prepare(`
      DELETE FROM watchdog_incidents
      WHERE status != 'open'
        AND opened_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $modifier)
    `)
    .run({ $modifier: modifier });
  return Number(result.changes || 0);
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
  withTransaction,
  getOpenIncident,
  insertIncident,
  resolveIncident,
  updateIncidentSummary,
  updateIncidentOverseer,
  abandonOpenIncidents,
  listIncidents,
  getIncidentById,
  getIncidentEvents,
  pruneWatchdogIncidents,
  kNotableEventsPredicateSql,
};
