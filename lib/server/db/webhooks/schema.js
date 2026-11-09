const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook_name TEXT NOT NULL,
      method TEXT,
      headers TEXT,
      payload TEXT,
      payload_truncated INTEGER DEFAULT 0,
      payload_size INTEGER,
      source_ip TEXT,
      gateway_status INTEGER,
      gateway_body TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_requests_hook_ts
    ON webhook_requests(hook_name, created_at DESC);
  `);
  // GST-2134: how AlphaClaw authenticated each delivery, and how long the
  // gateway took to answer. Added in place on a webhooks.db from before.
  const columns = new Set(
    database.prepare("PRAGMA table_info(webhook_requests)").all().map((column) => column.name),
  );
  if (!columns.has("auth_method")) database.exec("ALTER TABLE webhook_requests ADD COLUMN auth_method TEXT");
  if (!columns.has("gateway_ms")) database.exec("ALTER TABLE webhook_requests ADD COLUMN gateway_ms INTEGER");
  // GST-2134 PR 2: signed-delivery keys the gateway already accepted, so a
  // replayed or retried delivery is answered without running the hook again.
  database.exec(`
    CREATE TABLE IF NOT EXISTS hook_replay (
      hook_name TEXT NOT NULL,
      replay_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (hook_name, replay_key)
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_hook_replay_expiry
    ON hook_replay(hook_name, expires_at);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS oauth_callbacks (
      callback_id TEXT PRIMARY KEY,
      hook_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      rotated_at TEXT,
      last_used_at TEXT
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_oauth_callbacks_hook_name
    ON oauth_callbacks(hook_name);
  `);
};

module.exports = {
  createSchema,
};
