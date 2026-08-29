const hasColumn = (database, tableName, columnName) => {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
};

const ensureColumn = (database, tableName, columnName, definition) => {
  if (hasColumn(database, tableName, columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
};

const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS doctor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at TEXT,
      status TEXT NOT NULL,
      engine TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      workspace_fingerprint TEXT,
      workspace_manifest_json TEXT,
      prompt_version TEXT NOT NULL,
      summary TEXT,
      raw_result_json TEXT,
      error TEXT,
      reused_from_run_id INTEGER
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS doctor_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS doctor_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      priority TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      recommendation TEXT NOT NULL,
      evidence_json TEXT,
      target_paths_json TEXT,
      fix_prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES doctor_runs(id) ON DELETE CASCADE
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_doctor_runs_started_at
    ON doctor_runs(started_at DESC);
  `);
  ensureColumn(database, "doctor_runs", "workspace_fingerprint", "TEXT");
  ensureColumn(database, "doctor_runs", "workspace_manifest_json", "TEXT");
  ensureColumn(database, "doctor_runs", "reused_from_run_id", "INTEGER");
  ensureColumn(database, "doctor_cards", "fix_run_id", "TEXT");
  ensureColumn(database, "doctor_cards", "fix_token_hash", "TEXT");
  ensureColumn(database, "doctor_cards", "fix_started_at", "TEXT");
  ensureColumn(database, "doctor_cards", "fix_completed_at", "TEXT");
  // Doctor-v2 wave: which context profile + installed OpenClaw version a run
  // was analyzed under (both are part of the fingerprint-reuse guard), and
  // card provenance (source + stable source_key for sourced-card dedupe).
  ensureColumn(database, "doctor_runs", "context_profile", "TEXT");
  ensureColumn(database, "doctor_runs", "openclaw_version", "TEXT");
  ensureColumn(database, "doctor_cards", "source", "TEXT");
  ensureColumn(database, "doctor_cards", "source_key", "TEXT");
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_doctor_cards_run_id
    ON doctor_cards(run_id, created_at DESC);
  `);
  // Sourced-card dismissal suppression reads DISTINCT dismissed source_keys
  // once per run; the partial index keeps that off the ever-growing table.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_doctor_cards_dismissed_source_key
    ON doctor_cards(source_key)
    WHERE status = 'dismissed' AND source_key IS NOT NULL AND source_key <> '';
  `);
};

module.exports = {
  createSchema,
};
