const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_admin_confirms (
      id TEXT PRIMARY KEY,
      op_id TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      code TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      redeemed_at TEXT
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_admin_confirms_active
    ON agent_admin_confirms(op_id, params_hash, status);
  `);
};

module.exports = { createSchema };
