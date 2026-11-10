const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../db/pragmas");

// The bridge's durable state (relay/bridge.db): the engine event cursor and
// one row per relay message addressed to the box agent, with its state:
//   queued -> dispatched -> completing -> answered | failed | interrupted | unknown
//   queued -> rate_limited | hop_limit   (refused before any run)
//   dispatched -> reconciling -> answered | interrupted   (gateway restart)
//   any run end -> replying -> its final state   (the engine did not take
//                  the reply; pending_reply holds it until it is posted)
// Bodies are not stored here: they live in the engine and are read back when
// a message is dispatched, so retention has one place to act.
// trust is the tier the bridge decided right before chat.send ("delegate" or
// "peer", GST-1982) and approval the owner's approval a delegate's message
// carried (JSON); the relay guard reads both through
// lib/plugin/relay-guard/trust.js.
//
// Relay trust v2 (GST-2090) adds per-message provenance: the lane (its own
// queue and box session), the route the remote call came in on, the grant
// and binding generation the tier was decided under, and the approval's
// state. relay_results keeps a long answer's parts (masked, as the reply)
// for relay_result, pruned with its message.
//
// relay_confirmations (PR2) holds the owner's confirmations for a delegate's
// high-risk calls. The guards write "requested" rows and spend "confirmed"
// ones through lib/plugin/relay-guard/confirm.js; the bridge sends the link
// and records the owner's answer (confirmations.js):
//   requested -> pending (link sent) -> confirmed -> spent
//                                    -> denied | expired
//   any open state -> cancelled (the sender was revoked or removed)
// confirmation_ref on a message is the ref its sender passed to retry a call
// the owner approved.
const kTerminalStates = Object.freeze(["answered", "failed", "interrupted", "unknown", "rate_limited", "hop_limit", "lane_limit"]);
const kRefusedStates = Object.freeze(["rate_limited", "hop_limit", "lane_limit"]);
const kOpenStates = Object.freeze(["queued", "dispatched", "completing", "reconciling", "replying"]);

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
      " pending_reply TEXT," +
      " received_at INTEGER NOT NULL," +
      " dispatched_at INTEGER," +
      " ended_at INTEGER," +
      " updated_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_state ON relay_messages (state, received_at);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_sender ON relay_messages (sender, received_at);" +
      "CREATE INDEX IF NOT EXISTS relay_messages_run ON relay_messages (run_id);",
  );
  const columns = db.prepare("PRAGMA table_info(relay_messages)").all().map((column) => column.name);
  if (!columns.includes("pending_reply")) db.exec("ALTER TABLE relay_messages ADD COLUMN pending_reply TEXT");
  if (!columns.includes("trust")) db.exec("ALTER TABLE relay_messages ADD COLUMN trust TEXT");
  if (!columns.includes("approval")) db.exec("ALTER TABLE relay_messages ADD COLUMN approval TEXT");
  for (const [name, type] of [
    ["lane", "TEXT"],
    ["route", "TEXT"],
    ["grant_id", "TEXT"],
    ["binding_generation", "INTEGER"],
    ["attested_until", "INTEGER"],
    ["approval_ref", "TEXT"],
    ["approval_state", "TEXT"],
    ["confirmation_ref", "TEXT"],
  ]) {
    if (!columns.includes(name)) db.exec("ALTER TABLE relay_messages ADD COLUMN " + name + " " + type);
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS relay_results (ref TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender TEXT NOT NULL, lane TEXT," +
      " parts TEXT NOT NULL, created_at INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS relay_results_message ON relay_results (message_id);" +
      "CREATE TABLE IF NOT EXISTS relay_confirmations (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender TEXT NOT NULL, lane TEXT," +
      " generation INTEGER, kind TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, token_hash TEXT UNIQUE, csrf TEXT," +
      " created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, notified_at INTEGER, decided_at INTEGER, decided_by TEXT, spent_at INTEGER, spent_message_id TEXT);" +
      "CREATE INDEX IF NOT EXISTS relay_confirmations_match ON relay_confirmations (sender, action, target, state);" +
      "CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT);",
  );
};

const toConfirmation = (row) =>
  row
    ? {
        id: row.id,
        messageId: row.message_id,
        sender: row.sender,
        lane: row.lane || null,
        generation: Number.isInteger(row.generation) ? row.generation : null,
        kind: row.kind,
        action: row.action,
        target: row.target,
        state: row.state,
        csrf: row.csrf || null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        notifiedAt: row.notified_at || null,
        decidedAt: row.decided_at || null,
        decidedBy: row.decided_by || null,
        spentAt: row.spent_at || null,
        spentMessageId: row.spent_message_id || null,
      }
    : null;
const kInFlightStates = Object.freeze(["dispatched", "completing", "reconciling"]);

const kColumns = Object.freeze({
  state: "state",
  code: "code",
  runId: "run_id",
  attempts: "attempts",
  nextAttemptAt: "next_attempt_at",
  replyMessageId: "reply_message_id",
  pendingReply: "pending_reply",
  dispatchedAt: "dispatched_at",
  endedAt: "ended_at",
  trust: "trust",
  approval: "approval",
  grantId: "grant_id",
  approvalRef: "approval_ref",
  approvalState: "approval_state",
  attestedUntil: "attested_until",
  confirmationRef: "confirmation_ref",
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
        pendingReply: row.pending_reply || null,
        receivedAt: row.received_at,
        dispatchedAt: row.dispatched_at || null,
        endedAt: row.ended_at || null,
        trust: row.trust === "delegate" ? "delegate" : "peer",
        approval: row.approval || null,
        lane: row.lane || null,
        route: row.route || null,
        grantId: row.grant_id || null,
        bindingGeneration: Number.isInteger(row.binding_generation) ? row.binding_generation : null,
        attestedUntil: row.attested_until || null,
        approvalRef: row.approval_ref || null,
        approvalState: row.approval_state || null,
        confirmationRef: row.confirmation_ref || null,
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

  const insert = ({ messageId, sender, conversationId, threadRoot, sessionKey, hop = 0, state = "queued", code = null, lane = null, route = null, bindingGeneration = null, confirmationRef = null, attestedUntil = null }) => {
    const at = now();
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO relay_messages (message_id, sender, conversation_id, thread_root, session_key, hop, state, code, received_at, updated_at, ended_at, lane, route, binding_generation, confirmation_ref, attested_until)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        lane,
        route,
        Number.isInteger(bindingGeneration) ? bindingGeneration : null,
        confirmationRef || null,
        Number.isInteger(attestedUntil) && attestedUntil > 0 ? attestedUntil : null,
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

  // The lanes a sender has open (a message queued, running or replying),
  // the default lane as "".
  const openLanes = (sender) =>
    new Set(
      db
        .prepare("SELECT DISTINCT COALESCE(lane, '') AS lane FROM relay_messages WHERE sender = ? AND state IN (" + kOpenStates.map(() => "?").join(", ") + ")")
        .all(String(sender), ...kOpenStates)
        .map((row) => row.lane),
    );

  // Every lane a sender ever used (rows still kept), for the brain archive.
  const lanesForSender = (sender) =>
    db
      .prepare("SELECT DISTINCT lane FROM relay_messages WHERE sender = ? COLLATE NOCASE AND lane IS NOT NULL ORDER BY lane")
      .all(String(sender))
      .map((row) => row.lane);

  const saveResult = ({ ref, messageId, sender, lane = null, parts }) =>
    db
      .prepare("INSERT OR REPLACE INTO relay_results (ref, message_id, sender, lane, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ref, String(messageId), sender, lane, JSON.stringify(parts), now());
  const getResult = (ref) => {
    const row = db.prepare("SELECT * FROM relay_results WHERE ref = ?").get(String(ref));
    return row ? { ref: row.ref, messageId: row.message_id, sender: row.sender, lane: row.lane || null, parts: JSON.parse(row.parts) } : null;
  };

  const recent = ({ limit = 50, before = null } = {}) =>
    db
      .prepare(
        "SELECT * FROM relay_messages" + (before ? " WHERE received_at < ?" : "") + " ORDER BY received_at DESC, message_id DESC LIMIT ?",
      )
      .all(...(before ? [before, limit] : [limit]))
      .map(toRow);

  const listByConversation = (conversationId) =>
    db
      .prepare("SELECT * FROM relay_messages WHERE conversation_id = ? ORDER BY received_at, message_id")
      .all(String(conversationId))
      .map(toRow);

  const latestPerConversation = () =>
    db
      .prepare(
        "SELECT m.* FROM relay_messages m JOIN (SELECT conversation_id, MAX(received_at) AS at FROM relay_messages GROUP BY conversation_id) l" +
          " ON m.conversation_id = l.conversation_id AND m.received_at = l.at",
      )
      .all()
      .map(toRow);

  // Moves a row to toState only while it is still in one of fromStates, so
  // two finishers racing for one message cannot both post its reply.
  const claim = (messageId, fromStates, toState) => {
    const list = [].concat(fromStates);
    const at = now();
    return (
      db
        .prepare(
          "UPDATE relay_messages SET state = ?, updated_at = ? WHERE message_id = ? AND state IN (" + list.map(() => "?").join(", ") + ")",
        )
        .run(toState, at, String(messageId), ...list).changes === 1
    );
  };

  // A revoke, Remove, unbind or expiry: the sender's queued and in-flight
  // rows drop to the peer tier at once (the guard reads it on the next tool
  // call). Returns the in-flight rows so the caller can abort their runs.
  const demoteSender = (sender) => {
    const states = ["queued", ...kInFlightStates];
    const placeholders = states.map(() => "?").join(", ");
    const rows = db
      .prepare("SELECT * FROM relay_messages WHERE sender = ? AND state IN (" + placeholders + ")")
      .all(String(sender), ...states)
      .map(toRow);
    db.prepare("UPDATE relay_messages SET trust = 'peer', approval = NULL, updated_at = ? WHERE sender = ? AND state IN (" + placeholders + ")").run(
      now(),
      String(sender),
      ...states,
    );
    db.prepare("UPDATE relay_confirmations SET state = 'cancelled', decided_at = ? WHERE sender = ? AND state IN ('requested', 'pending', 'confirmed')").run(now(), String(sender));
    return rows.filter((row) => kInFlightStates.includes(row.state));
  };

  const counts = () => {
    const out = {};
    for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM relay_messages GROUP BY state").all()) out[row.state] = row.n;
    return out;
  };

  const prune = (retentionDays) => {
    if (!retentionDays) return 0;
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
    const placeholders = kTerminalStates.map(() => "?").join(", ");
    db.prepare("DELETE FROM relay_results WHERE created_at < ?").run(cutoff);
    db.prepare("DELETE FROM relay_confirmations WHERE created_at < ?").run(cutoff);
    return db
      .prepare("DELETE FROM relay_messages WHERE received_at < ? AND state IN (" + placeholders + ")")
      .run(cutoff, ...kTerminalStates).changes;
  };

  const confirmations = {
    get: (id) => toConfirmation(db.prepare("SELECT * FROM relay_confirmations WHERE id = ?").get(String(id))),
    byTokenHash: (hash) => toConfirmation(db.prepare("SELECT * FROM relay_confirmations WHERE token_hash = ?").get(String(hash))),
    listRequested: () => db.prepare("SELECT * FROM relay_confirmations WHERE state = 'requested' ORDER BY created_at LIMIT 50").all().map(toConfirmation),
    // The link went out: the row waits for the owner until expiresAt.
    markPending: (id, { tokenHash, csrf, expiresAt }) =>
      db
        .prepare("UPDATE relay_confirmations SET state = 'pending', token_hash = ?, csrf = ?, expires_at = ?, notified_at = ? WHERE id = ? AND state = 'requested'")
        .run(tokenHash, csrf, expiresAt, now(), String(id)).changes === 1,
    // The owner's answer, taken once and only while the link is live.
    decide: (id, { state, by, expiresAt }) =>
      db
        .prepare(
          "UPDATE relay_confirmations SET state = ?, decided_at = ?, decided_by = ?, expires_at = ?, token_hash = NULL WHERE id = ? AND state = 'pending' AND expires_at > ?",
        )
        .run(state, now(), by, expiresAt, String(id), now()).changes === 1,
    expire: () =>
      db
        .prepare("UPDATE relay_confirmations SET state = 'expired', token_hash = NULL WHERE state IN ('requested', 'pending', 'confirmed') AND expires_at <= ?")
        .run(now()).changes,
    countsSince: (since) => {
      const out = {};
      for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM relay_confirmations WHERE created_at >= ? GROUP BY state").all(since)) out[row.state] = row.n;
      return out;
    },
    listOpen: () =>
      db
        .prepare("SELECT * FROM relay_confirmations WHERE state IN ('requested', 'pending', 'confirmed') ORDER BY created_at DESC LIMIT 50")
        .all()
        .map(toConfirmation),
  };

  // Delegate activity since a time, for the owner's daily digest: messages
  // per grant and the lanes they used. Counts and ids only, never text.
  const delegateActivitySince = (since) => {
    const rows = db
      .prepare("SELECT sender, grant_id, COALESCE(lane, '') AS lane, COUNT(*) AS n FROM relay_messages WHERE trust = 'delegate' AND received_at >= ? GROUP BY sender, grant_id, lane")
      .all(since);
    return rows.map((row) => ({ sender: row.sender, grantId: row.grant_id || null, lane: row.lane || null, messages: row.n }));
  };

  const getMeta = (key) => db.prepare("SELECT value FROM relay_meta WHERE key = ?").get(String(key))?.value ?? null;
  const setMeta = (key, value) =>
    db.prepare("INSERT INTO relay_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(key), String(value));

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
    openLanes,
    lanesForSender,
    saveResult,
    getResult,
    recent,
    listByConversation,
    latestPerConversation,
    claim,
    demoteSender,
    counts,
    prune,
    confirmations,
    delegateActivitySince,
    getMeta,
    setMeta,
    backupTo,
    close: () => db.close(),
  };
};

module.exports = { openBridgeStore, kTerminalStates, kOpenStates };
