// AlphaClaw's AgentRun reporter queue (GST-2907): one SQLite file written
// only by the AlphaClaw server process (the plugin writes spool files, never
// this database), so a lock here can never stall a gateway turn.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const kMaxUnsentRows = 20000;
const kSentRetentionMs = 7 * 24 * 60 * 60 * 1000;

const kSchema = `
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_description TEXT NOT NULL DEFAULT '',
  class TEXT NOT NULL,
  contents INTEGER NOT NULL DEFAULT 0,
  session_label TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  input_text TEXT NOT NULL DEFAULT '',
  texts_json TEXT NOT NULL DEFAULT '[]',
  answer_text TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  tools_json TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT NOT NULL DEFAULT 'null',
  evidence_complete INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  start_body TEXT,
  batches_json TEXT,
  complete_body TEXT,
  batches_sent INTEGER NOT NULL DEFAULT 0,
  agentrun_run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, source_run_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_due ON turns(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS agents (
  agent_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const openOutbox = ({ dbPath, now = () => Date.now() }) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec(kSchema);

  const insert = db.prepare(`INSERT OR IGNORE INTO turns (
    source, source_run_id, agent_key, agent_name, agent_description, class, contents, session_label,
    started_at, ended_at, status, model, input_text, texts_json, answer_text, error_text, tools_json,
    usage_json, evidence_complete, created_at, updated_at
  ) VALUES (
    $source, $source_run_id, $agent_key, $agent_name, $agent_description, $class, $contents, $session_label,
    $started_at, $ended_at, $status, $model, $input_text, $texts_json, $answer_text, $error_text, $tools_json,
    $usage_json, $evidence_complete, $now, $now
  )`);

  // Returns true when the row is new.
  const addTurn = (turn) =>
    insert.run({
      $source: turn.source,
      $source_run_id: turn.sourceRunId,
      $agent_key: turn.agentKey,
      $agent_name: turn.agentName,
      $agent_description: turn.agentDescription || "",
      $class: turn.class,
      $contents: turn.contents ? 1 : 0,
      $session_label: turn.sessionLabel || "",
      $started_at: turn.startedAt ?? null,
      $ended_at: turn.endedAt ?? null,
      $status: turn.status,
      $model: turn.model || "",
      $input_text: turn.inputText || "",
      $texts_json: JSON.stringify(turn.texts || []),
      $answer_text: turn.answerText || "",
      $error_text: turn.errorText || "",
      $tools_json: JSON.stringify(turn.tools || []),
      $usage_json: JSON.stringify(turn.usage ?? null),
      $evidence_complete: turn.evidenceComplete ? 1 : 0,
      $now: now(),
    }).changes > 0;

  const due = (limit = 50) =>
    db
      .prepare("SELECT * FROM turns WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?")
      .all(now(), limit);

  const update = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((key) => `${key} = $${key}`).join(", ");
    const params = Object.fromEntries(keys.map((key) => [`$${key}`, fields[key]]));
    db.prepare(`UPDATE turns SET ${sets}, updated_at = $updated_at WHERE id = $id`).run({ ...params, $updated_at: now(), $id: id });
  };

  const agentOf = (agentKey) => db.prepare("SELECT * FROM agents WHERE agent_key = ?").get(agentKey) || null;
  const saveAgent = ({ agentKey, agentId, runtime, definitionHash }) =>
    db
      .prepare(
        "INSERT INTO agents (agent_key, agent_id, runtime, definition_hash, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(agent_key) DO UPDATE SET agent_id = excluded.agent_id, runtime = excluded.runtime, " +
          "definition_hash = excluded.definition_hash, updated_at = excluded.updated_at",
      )
      .run(agentKey, agentId, runtime, definitionHash, now());
  const forgetAgent = (agentKey) => db.prepare("DELETE FROM agents WHERE agent_key = ?").run(agentKey);

  // Bounds: oldest unsent rows beyond the cap are dropped; sent rows older
  // than the retention are deleted. Returns { dropped, deleted }.
  const prune = ({ maxUnsent = kMaxUnsentRows, retentionMs = kSentRetentionMs } = {}) => {
    const unsent = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE state = 'queued'").get().n;
    let dropped = 0;
    if (unsent > maxUnsent) {
      dropped = db
        .prepare(
          "UPDATE turns SET state = 'dropped', last_error = 'queue_overflow', updated_at = ? WHERE id IN " +
            "(SELECT id FROM turns WHERE state = 'queued' ORDER BY id ASC LIMIT ?)",
        )
        .run(now(), unsent - maxUnsent).changes;
    }
    const deleted = db
      .prepare("DELETE FROM turns WHERE state IN ('sent', 'expired', 'dropped') AND updated_at < ?")
      .run(now() - retentionMs).changes;
    return { dropped, deleted };
  };

  const counts = () =>
    Object.fromEntries(db.prepare("SELECT state, COUNT(*) AS n FROM turns GROUP BY state").all().map((row) => [row.state, row.n]));

  return { db, addTurn, due, update, agentOf, saveAgent, forgetAgent, prune, counts, close: () => db.close() };
};

module.exports = { openOutbox, kMaxUnsentRows, kSentRetentionMs };
