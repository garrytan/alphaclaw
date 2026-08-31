// Durable chat-run outcomes (D1): status/timestamps/ids + a CLASSIFIED,
// length-capped error string — NEVER message content or raw gateway error
// text. This store is the "durable outcome truth" behind the in-memory run
// registry: it powers the stop/interrupt/unknown markers merged into history,
// cross-restart send dedupe, and boot reconciliation (dangling in-flight rows
// always resolve to a terminal answer — the house pattern from db/doctor).
//
// One row per LOGICAL message (UNIQUE(session_key, client_msg_id) — dedupe
// binds the session, a client-controlled id never replays another session's
// outcome); a fresh retry of an old terminal row upserts back to pending.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../pragmas");
const { createSchema } = require("./schema");
const {
  kTerminalStatuses,
  kMarkerStatuses,
} = require("../../chat/protocol");
const { kMaxStoredErrorLength } = require("../../chat/errors");
const kPruneKeepPerSession = 200;
const kPruneMaxAgeDays = 90;
// Global row cap: the per-session cap is useless against a client minting
// UNIQUE session keys (1 row each, forever) — without a global ceiling an
// authenticated socket can grow chat-runs.db until disk exhaustion.
const kPruneKeepGlobal = 5000;
// Runtime prune cadence: boot-only pruning leaves a long-lived server
// unbounded, so prune again every N inserts (cheap, deterministic, no timer).
const kPruneEveryInserts = 500;
let insertsSincePrune = 0;

let db = null;

const ensureDb = () => {
  if (!db) throw new Error("Chat-runs DB not initialized");
  return db;
};

const closeChatRunsDb = () => {
  if (!db) return;
  const database = db;
  db = null;
  database.close();
};

const nowIso = () => new Date().toISOString();

const toRowModel = (row) => {
  if (!row) return null;
  return {
    sessionKey: row.session_key || "",
    clientMsgId: row.client_msg_id || "",
    runId: row.run_id || "",
    messageId: row.message_id || "",
    lastSeq: Number(row.last_seq) || 0,
    status: row.status || "",
    confidence: row.confidence || "",
    stopConfirmed:
      row.stop_confirmed === null || row.stop_confirmed === undefined
        ? null
        : Number(row.stop_confirmed),
    errorCode: row.error_code || "",
    error: row.error || "",
    createdAtMs: Date.parse(String(row.created_at || "")) || 0,
    endedAtMs: Date.parse(String(row.ended_at || "")) || 0,
  };
};

// Boot reconciliation (D9b): a dangling `pending` row is genuinely ambiguous
// (the send may or may not have reached the gateway) → `unknown`; a dangling
// `running` row definitely started and lost its stream with the process →
// `interrupted`, unconfirmed.
const reconcileInterruptedRuns = () => {
  const database = ensureDb();
  const endedAt = nowIso();
  database
    .prepare(`
      UPDATE chat_runs
      SET status = 'unknown',
          confidence = 'unconfirmed',
          error_code = 'unknown_outcome',
          error = 'AlphaClaw restarted before this send was confirmed — check the transcript before retrying.',
          ended_at = $ended_at
      WHERE status = 'pending'
    `)
    .run({ $ended_at: endedAt });
  database
    .prepare(`
      UPDATE chat_runs
      SET status = 'interrupted',
          confidence = 'unconfirmed',
          error = 'AlphaClaw restarted mid-run — the agent may have kept working.',
          ended_at = $ended_at
      WHERE status = 'running'
    `)
    .run({ $ended_at: endedAt });
};

const pruneChatRuns = () => {
  const database = ensureDb();
  database
    .prepare(`
      DELETE FROM chat_runs
      WHERE created_at < datetime('now', '-${kPruneMaxAgeDays} days')
    `)
    .run();
  // Per-session cap: keep the newest kPruneKeepPerSession rows per session.
  database
    .prepare(`
      DELETE FROM chat_runs
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY session_key ORDER BY id DESC
                 ) AS rowNumber
          FROM chat_runs
        )
        WHERE rowNumber > ${kPruneKeepPerSession}
      )
    `)
    .run();
  // Global cap: keep only the newest kPruneKeepGlobal rows overall.
  database
    .prepare(`
      DELETE FROM chat_runs
      WHERE id NOT IN (
        SELECT id FROM chat_runs ORDER BY id DESC LIMIT ${kPruneKeepGlobal}
      )
    `)
    .run();
};

const initChatRunsDb = ({ rootDir, markInterruptedRuns = true }) => {
  closeChatRunsDb();
  const dbDir = path.join(rootDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "chat-runs.db");
  db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  if (markInterruptedRuns) reconcileInterruptedRuns();
  pruneChatRuns();
  insertsSincePrune = 0;
  return { path: dbPath };
};

const recordSend = ({ sessionKey, clientMsgId, messageId }) => {
  const database = ensureDb();
  insertsSincePrune += 1;
  if (insertsSincePrune >= kPruneEveryInserts) {
    insertsSincePrune = 0;
    pruneChatRuns();
  }
  database
    .prepare(`
      INSERT INTO chat_runs (session_key, client_msg_id, message_id, status)
      VALUES ($session_key, $client_msg_id, $message_id, 'pending')
      ON CONFLICT(session_key, client_msg_id) DO UPDATE SET
        message_id = $message_id,
        run_id = NULL,
        last_seq = NULL,
        status = 'pending',
        confidence = NULL,
        stop_confirmed = NULL,
        error_code = NULL,
        error = NULL,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        started_at = NULL,
        stop_requested_at = NULL,
        ended_at = NULL
    `)
    .run({
      $session_key: String(sessionKey || ""),
      $client_msg_id: String(clientMsgId || ""),
      $message_id: String(messageId || ""),
    });
};

const markRunning = ({ sessionKey, clientMsgId, runId }) => {
  const database = ensureDb();
  database
    .prepare(`
      UPDATE chat_runs
      SET status = 'running', run_id = $run_id, started_at = $started_at
      WHERE session_key = $session_key AND client_msg_id = $client_msg_id
    `)
    .run({
      $session_key: String(sessionKey || ""),
      $client_msg_id: String(clientMsgId || ""),
      $run_id: String(runId || ""),
      $started_at: nowIso(),
    });
};

const markStopRequested = ({ sessionKey, clientMsgId }) => {
  const database = ensureDb();
  database
    .prepare(`
      UPDATE chat_runs
      SET stop_requested_at = $stop_requested_at
      WHERE session_key = $session_key AND client_msg_id = $client_msg_id
    `)
    .run({
      $session_key: String(sessionKey || ""),
      $client_msg_id: String(clientMsgId || ""),
      $stop_requested_at: nowIso(),
    });
};

const markTerminal = ({
  sessionKey,
  clientMsgId,
  status,
  confidence = "",
  stopConfirmed = null,
  errorCode = "",
  error = "",
  lastSeq = 0,
  messageId = "",
  runId = "",
}) => {
  const database = ensureDb();
  database
    .prepare(`
      UPDATE chat_runs
      SET status = $status,
          confidence = $confidence,
          stop_confirmed = $stop_confirmed,
          error_code = $error_code,
          error = $error,
          last_seq = $last_seq,
          message_id = COALESCE(NULLIF($message_id, ''), message_id),
          run_id = COALESCE(NULLIF($run_id, ''), run_id),
          ended_at = $ended_at
      WHERE session_key = $session_key AND client_msg_id = $client_msg_id
    `)
    .run({
      $session_key: String(sessionKey || ""),
      $client_msg_id: String(clientMsgId || ""),
      $status: String(status || "error"),
      $confidence: String(confidence || ""),
      $stop_confirmed:
        stopConfirmed === null || stopConfirmed === undefined
          ? null
          : Number(stopConfirmed),
      $error_code: String(errorCode || ""),
      $error: String(error || "").slice(0, kMaxStoredErrorLength),
      $last_seq: Number(lastSeq) || 0,
      $message_id: String(messageId || ""),
      $run_id: String(runId || ""),
      $ended_at: nowIso(),
    });
};

const findRecentTerminal = ({ sessionKey, clientMsgId, windowMs, now }) => {
  const database = ensureDb();
  // ISO-8601 strings compare correctly lexicographically.
  const cutoffIso = new Date(
    (Number(now) || Date.now()) - (Number(windowMs) || 0),
  ).toISOString();
  const row = database
    .prepare(`
      SELECT * FROM chat_runs
      WHERE session_key = $session_key
        AND client_msg_id = $client_msg_id
        AND status IN (${kTerminalStatuses.map((s) => `'${s}'`).join(",")})
        AND ended_at >= $cutoff
      LIMIT 1
    `)
    .get({
      $session_key: String(sessionKey || ""),
      $client_msg_id: String(clientMsgId || ""),
      $cutoff: cutoffIso,
    });
  return toRowModel(row);
};

const listMarkers = (sessionKey, limit = 50) => {
  const database = ensureDb();
  const rows = database
    .prepare(`
      SELECT * FROM chat_runs
      WHERE session_key = $session_key
        AND status IN (${kMarkerStatuses.map((s) => `'${s}'`).join(",")})
      ORDER BY id DESC
      LIMIT $limit
    `)
    .all({
      $session_key: String(sessionKey || ""),
      $limit: Math.max(1, Number(limit) || 50),
    });
  return rows.map(toRowModel).reverse();
};

module.exports = {
  initChatRunsDb,
  closeChatRunsDb,
  recordSend,
  markRunning,
  markStopRequested,
  markTerminal,
  findRecentTerminal,
  listMarkers,
  reconcileInterruptedRuns,
  pruneChatRuns,
};
