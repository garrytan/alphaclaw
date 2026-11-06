const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../db/pragmas");

// The bridge's durable state (relay/bridge.db): the engine event cursor and
// one row per relay message addressed to the box agent, with its state:
//   queued -> dispatched -> answered | failed | interrupted | unknown
//   queued -> rate_limited | hop_limit   (refused before any run)
//   dispatched -> reconciling -> answered | interrupted   (gateway restart)
// Bodies are not stored here: they live in the engine and are read back when
// a message is dispatched, so retention has one place to act.
const kTerminalStates = Object.freeze(["answered", "failed", "interrupted", "unknown", "rate_limited", "hop_limit"]);
const kRefusedStates = Object.freeze(["rate_limited", "hop_limit"]);

const createSchema = (db) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS relay_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS relay_messages (" +
      " message_id TEXT PRIMARY KEY," +
      " sender TEXT NOT NULL," +
      " conversation_id TEXT NOT NULL," +
      " thread_root TEXT NOT NULL," +
      " session_key TEXT NOT NULL," +
      " hop INTEGER NOT NULL DEFAULT 0," +
      " state TEXT NOT NULL," +
      " code TEXT," +
      " run_id TEXT," +
      " attempts INTEGER NOT NULL DEFAULT 0," +
      " next_attempt_at INTEGER NOT NULL DEFAULT 0," +
      " reply_message_id TEXT," +
      " received_at INTEGER NOT NULL," +
      " dispatched_at INTEGER," +
      " ended_at INTEGER," +
      " updated_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_state ON relay_messages (state, received_at);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_sender ON relay_messages (sender, received_at);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_run ON relay_messages (run_id);",
  );
};

const kColumns = Object.freeze({
  state: "state",
  code: "code",
  runId: "run_id",
  attempts: "attempts",
  nextAttemptAt: "next_attempt_at",
  replyMessageId: "reply_message_id",
  dispatchedAt: "dispatched_at",
  endedAt: "ended_at",
});

const toRow = (row) =>
  row
    ? {
        messageId: row.message_id,
        sender: row.sender,
        conversationId: row.conversation_id,
        threadRoot: row.thread_root,
        sessionKey: row.session_key,
        hop: row.hop,
        state: row.state,
        code: row.code || null,
        runId: row.run_id || null,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        replyMessageId: row.reply_message_id || null,
        receivedAt: row.received_at,
        dispatchedAt: row.dispatched_at || null,
        endedAt: row.ended_at || null,
        updatedAt: row.updated_at,
      }
    : null;

const openBridgeStore = ({ dbPath, now = Date.now, fsModule = fs }) => {
  fsModule.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  try {
    fsModule.chmodSync(dbPath, 0o600);
  } catch {}

  const getCursor = () => db.prepare("SELECT since FROM relay_cursor WHERE id = 1").get()?.since ?? null;
  const setCursor = (since) =>
    db.prepare("INSERT INTO relay_cursor (id, since) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET since = excluded.since").run(since);
  const get = (messageId) => toRow(db.prepare("SELECT * FROM relay_messages WHERE message_id = ?").get(String(messageId)));
  const getByRunId = (runId) => toRow(db.prepare("SELECT * FROM relay_messages WHERE run_id = ?").get(String(runId)));

  const insert = ({ messageId, sender, conversationId, threadRoot, sessionKey, hop = 0, state = "queued", code = null }) => {
    const at = now();
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO relay_messages (message_id, sender, conversation_id, thread_root, session_key, hop, state, code, received_at, updated_at, ended_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        String(messageId),
        sender,
        conversationId,
        String(threadRoot),
        sessionKey,
        hop,
        state,
        code,
        at,
        at,
        kTerminalStates.includes(state) ? at : null,
      );
    return result.changes === 1;
  };

  const update = (messageId, fields) => {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(kColumns)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      sets.push(column + " = ?");
      values.push(fields[key] ?? null);
    }
    if (fields.state && kTerminalStates.includes(fields.state) && !Object.prototype.hasOwnProperty.call(fields, "endedAt")) {
      sets.push("ended_at = ?");
      values.push(now());
    }
    sets.push("updated_at = ?");
    values.push(now());
    values.push(String(messageId));
    db.prepare("UPDATE relay_messages SET " + sets.join(", ") + " WHERE message_id = ?").run(...values);
  };

  const listByState = (states) => {
    const list = [].concat(states);
    return db
      .prepare("SELECT * FROM relay_messages WHERE state IN (" + list.map(() => "?").join(", ") + ") ORDER BY received_at, message_id")
      .all(...list)
      .map(toRow);
  };

  const countRecentFromSender = (sender, sinceMs) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_messages WHERE sender = ? AND received_at >= ? AND state NOT IN (" +
          kRefusedStates.map(() => "?").join(", ") +
          ")",
      )
      .get(sender, sinceMs, ...kRefusedStates).n;

  const recent = ({ limit = 50, before = null } = {}) =>
    db
      .prepare(
        "SELECT * FROM relay_messages" + (before ? " WHERE received_at < ?" : "") + " ORDER BY received_at DESC, message_id DESC LIMIT ?",
      )
      .all(...(before ? [before, limit] : [limit]))
      .map(toRow);

  const counts = () => {
    const out = {};
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM relay_messages GROUP BY state").all()) out[row.state] = row.n;
    return out;
  };

  const prune = (retentionDays) => {
    if (!retentionDays) return 0;
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
    const placeholders = kTerminalStates.map(() => "?").join(", ");
    return db
      .prepare("DELETE FROM relay_messages WHERE received_at < ? AND state IN (" + placeholders + ")")
      .run(cutoff, ...kTerminalStates).changes;
  };

  const backupTo = (targetPath) => db.exec("VACUUM INTO '" + String(targetPath).replace(/'/g, "''") + "'");

  return {
    getCursor,
    setCursor,
    get,
    getByRunId,
    insert,
    update,
    listByState,
    countRecentFromSender,
    recent,
    counts,
    prune,
    backupTo,
    close: () => db.close(),
  };
};

module.exports = { openBridgeStore, kTerminalStates };
