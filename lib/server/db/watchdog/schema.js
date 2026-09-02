// Additive-only schema. `createSchema` runs at every boot and must be
// idempotent against any prior version of this database, including pre-wave
// files that lack the incidents table and the incident_id column.
//
// Incident record state machine (written by lib/server/watchdog-incidents.js,
// a transition observer over the watchdog's event sink):
//
//            first bad watchdog event            recovery / healthy probe
//   (none) ────────────────────────────▶ open ─────────────────────────▶ resolved
//                                          │  server restart (boot scan)     │
//                                          └────────▶ abandoned ◀────────────┘
//   (never resolved→open: a new outage is a new row; at most ONE open row,
//    enforced by the partial unique index below + the single-threaded sink)

// Shared verbatim between the partial index below and getRecentEvents'
// WHERE clause: SQLite only uses a partial index when it can prove the
// query's predicate implies the index predicate, which in practice means
// the SQL text must match exactly.
const kNotableEventsPredicateSql =
  "NOT (event_type = 'health_check' AND status = 'ok')";

// The overseer's audit row. Shared with the abandon scan's SQL (which must
// ignore it when back-dating a terminal timestamp) and the overseer's emitter,
// so a rename cannot silently re-include those rows.
const kOverseerReviewEventType = "overseer_review";

const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT,
      correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_ts
    ON watchdog_events(created_at DESC);
  `);
  // Pragma-guarded additive column: ALTER TABLE has no IF NOT EXISTS.
  const eventColumns = database
    .prepare("SELECT name FROM pragma_table_info('watchdog_events')")
    .all()
    .map((row) => row.name);
  if (!eventColumns.includes("incident_id")) {
    database.exec("ALTER TABLE watchdog_events ADD COLUMN incident_id INTEGER;");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_incident
    ON watchdog_events(incident_id);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS watchdog_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT,
      summary_json TEXT,
      overseer_json TEXT
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_watchdog_incidents_status
    ON watchdog_incidents(status, opened_at);
  `);
  // At most one open incident at a time (belt to the tracker's in-memory
  // suspenders): a second open insert fails loudly instead of forking history.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_watchdog_incidents_one_open
    ON watchdog_incidents(status) WHERE status = 'open';
  `);
  // Small key/value slot for watchdog state that is evidence rather than
  // config (alphaclaw.json is git-synced config and the wrong home for it).
  // First tenant: the overseer's standalone situation report — a review that
  // belongs to no incident row. Same shape as doctor_meta.
  database.exec(`
    CREATE TABLE IF NOT EXISTS watchdog_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  // Fail open: a corrupt/locked db must not block watchdog startup — the
  // notable-events query still works unindexed, just slower.
  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_watchdog_events_notable
      ON watchdog_events(created_at DESC)
      WHERE ${kNotableEventsPredicateSql};
    `);
  } catch (err) {
    console.warn(
      `[watchdog-db] could not create idx_watchdog_events_notable (continuing unindexed): ${err?.message || err}`,
    );
  }
};

module.exports = {
  createSchema,
  kNotableEventsPredicateSql,
  kOverseerReviewEventType,
};
