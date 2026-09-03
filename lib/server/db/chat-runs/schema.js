const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_msg_id TEXT NOT NULL,
      run_id TEXT,
      message_id TEXT,
      last_seq INTEGER,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence TEXT,
      stop_confirmed INTEGER,
      error_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      started_at TEXT,
      stop_requested_at TEXT,
      ended_at TEXT,
      UNIQUE(session_key, client_msg_id)
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_runs_session
    ON chat_runs(session_key, created_at DESC);
  `);
};

module.exports = { createSchema };
