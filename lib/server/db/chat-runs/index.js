// Durable chat-run outcomes (D1): status/timestamps/ids + a CLASSIFIED,
// length-capped error string — NEVER message content or raw gateway error
// text. This store is the "durable outcome truth" behind the in-memory run
// registry: it powers the stop/interrupt/unknown markers merged into history,
// cross-restart send dedupe, and boot reconciliation (dangling in-flight rows
// always resolve to a terminal answer — the house pattern from db/doctor).
//
// One row per LOGICAL message (UNIQUE(session_key, client_msg_id) — dedupe
// binds the session, a client-controlled id never replays another session's
// outcome). Only a durably proven non-submission may be claimed again.
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
// A factory keeps independent stores isolated (including integration tests).
const createChatRunsStore = () => {
let db = null;
let insertsSincePrune = 0;

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
    submissionState: row.submission_state || "unknown",
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

// Never evict live submission evidence. Admission makes room using terminal
// rows only, and refuses when protected rows occupy a cap.
const kTerminalSql = kTerminalStatuses.map((s) => `'${s}'`).join(",");
const pruneChatRuns = () => {
  const database = ensureDb();
  database.prepare(`DELETE FROM chat_runs
    WHERE status IN (${kTerminalSql})
      AND julianday(created_at) < julianday('now', '-${kPruneMaxAgeDays} days')`).run();
  database.prepare(`DELETE FROM chat_runs WHERE status IN (${kTerminalSql}) AND id IN (
    SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
      PARTITION BY session_key ORDER BY (status NOT IN (${kTerminalSql})) DESC, id DESC
    ) AS rowNumber FROM chat_runs) WHERE rowNumber > ${kPruneKeepPerSession}
  )`).run();
  database.prepare(`DELETE FROM chat_runs WHERE status IN (${kTerminalSql}) AND id NOT IN (
    SELECT id FROM chat_runs ORDER BY (status NOT IN (${kTerminalSql})) DESC, id DESC
    LIMIT ${kPruneKeepGlobal}
  )`).run();
};

const initChatRunsDb = ({ rootDir, markInterruptedRuns = true }) => {
  closeChatRunsDb();
  const dbDir = path.join(rootDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "chat-runs.db");
  db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  insertsSincePrune = 0;
  if (markInterruptedRuns) reconcileInterruptedRuns();
  pruneChatRuns();
  return { path: dbPath };
};

const findRun = ({ sessionKey, clientMsgId }) => toRowModel(ensureDb()
  .prepare("SELECT * FROM chat_runs WHERE session_key = ? AND client_msg_id = ?")
  .get(String(sessionKey || ""), String(clientMsgId || "")));

// One transaction owns the evidence check, capacity reservation, and claim.
// The claim itself means "possibly submitted": a crash at any subsequent
// instruction is ambiguous. A safe error must be invalidated BEFORE reuse.
const claimSend = ({ sessionKey, clientMsgId, messageId, retry = false }) => {
  const database = ensureDb();
  const key = [String(sessionKey || ""), String(clientMsgId || "")];
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = findRun({ sessionKey, clientMsgId });
    if (existing && !(existing.status === "error" && existing.submissionState === "not_submitted")) {
      database.exec("COMMIT");
      return { claimed: false, row: existing };
    }
    if (!existing && retry) {
      database.exec("COMMIT");
      return { claimed: false, reason: "unknown_outcome" };
    }
    if (!existing) {
      if (++insertsSincePrune >= 500) {
        pruneChatRuns();
        insertsSincePrune = 0;
      }
      const makeRoom = (where, args, cap) => {
        const count = Number(database.prepare(`SELECT COUNT(*) AS n FROM chat_runs ${where}`).get(...args).n);
        if (count < cap) return true;
        database.prepare(`DELETE FROM chat_runs WHERE id IN (
          SELECT id FROM chat_runs ${where}${where ? " AND" : " WHERE"} status IN (${kTerminalSql})
          ORDER BY id LIMIT ?
        )`).run(...args, count - cap + 1);
        return Number(database.prepare(`SELECT COUNT(*) AS n FROM chat_runs ${where}`).get(...args).n) < cap;
      };
      if (!makeRoom("WHERE session_key = ?", [key[0]], kPruneKeepPerSession) ||
          !makeRoom("", [], kPruneKeepGlobal)) {
        database.exec("ROLLBACK");
        return { claimed: false, reason: "too_many_pending" };
      }
      database.prepare(`INSERT INTO chat_runs
        (session_key, client_msg_id, message_id, status, submission_state)
        VALUES (?, ?, ?, 'pending', 'possibly_submitted')`).run(...key, String(messageId || ""));
    } else {
      database.prepare(`UPDATE chat_runs SET message_id = ?, run_id = NULL,
        last_seq = NULL, status = 'pending', submission_state = 'possibly_submitted',
        confidence = NULL, stop_confirmed = NULL, error_code = NULL, error = NULL,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = NULL,
        stop_requested_at = NULL, ended_at = NULL
        WHERE session_key = ? AND client_msg_id = ?
          AND status = 'error' AND submission_state = 'not_submitted'`).run(String(messageId || ""), ...key);
    }
    database.exec("COMMIT");
    return { claimed: true };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
};

// Kept as a public facade for existing callers; no unconditional upsert.
const recordSend = (args) => claimSend(args);

const markRunning = ({ sessionKey, clientMsgId, runId }) => {
  const database = ensureDb();
  database
    .prepare(`
      UPDATE chat_runs
      SET status = 'running', submission_state = 'submitted', run_id = $run_id, started_at = $started_at
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
  notSubmitted = false,
}) => {
  const database = ensureDb();
  database
    .prepare(`
      UPDATE chat_runs
      SET status = $status,
          submission_state = CASE WHEN $not_submitted = 1 AND run_id IS NULL
            AND $status = 'error' THEN 'not_submitted' ELSE submission_state END,
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
      $not_submitted: notSubmitted === true ? 1 : 0,
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

// Compatibility facade: "recent" now means retained, never a retry window.
// Expiry belongs to bounded terminal retention; it cannot authorize dispatch.
const findRecentTerminal = (key) => {
  const row = findRun(key);
  return row && kTerminalStatuses.includes(row.status) ? row : null;
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

return {
  initChatRunsDb,
  claimSend,
  findRun,
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

};

module.exports = { ...createChatRunsStore(), createChatRunsStore };
