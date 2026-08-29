// Shared verbatim between the partial index below and getRecentEvents'
// WHERE clause: SQLite only uses a partial index when it can prove the
// query's predicate implies the index predicate, which in practice means
// the SQL text must match exactly.
const kNotableEventsPredicateSql =
  "NOT (event_type = 'health_check' AND status = 'ok')";

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
};
