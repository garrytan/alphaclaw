const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createSchema } = require("./schema");
const { applyOperationalPragmas } = require("../pragmas");

let db = null;

const ensureDb = () => {
  if (!db) throw new Error("Agent-admin DB not initialized");
  return db;
};

const closeAgentAdminDb = () => {
  if (!db) return;
  const database = db;
  db = null;
  database.close();
};

const initAgentAdminDb = ({ rootDir }) => {
  closeAgentAdminDb();
  const dbDir = path.join(rootDir, "db");
  // Self-create the db dir like every sibling db module — don't depend on
  // initAuthDb running first (init order could change).
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "agent-admin.db");
  db = new DatabaseSync(dbPath);
  // Shared pragmas (busy_timeout FIRST, then WAL): a concurrent redeem/create
  // serializes instead of throwing SQLITE_BUSY (A27), and the one-time WAL
  // migration cannot fail-fast against a racing CLI process.
  applyOperationalPragmas(db, { busyTimeoutMs: 5000 });
  createSchema(db);
  return { path: dbPath };
};

const insertConfirm = ({
  id,
  opId,
  paramsHash,
  code,
  summary,
  expiresAt,
}) => {
  const database = ensureDb();
  database
    .prepare(`
      INSERT INTO agent_admin_confirms (id, op_id, params_hash, code, summary, expires_at)
      VALUES ($id, $op_id, $params_hash, $code, $summary, $expires_at)
    `)
    .run({
      $id: String(id),
      $op_id: String(opId),
      $params_hash: String(paramsHash),
      $code: String(code),
      $summary: String(summary || ""),
      $expires_at: String(expiresAt),
    });
};

// Active = pending AND unexpired. Dedup key is (op_id, params_hash).
const findActiveConfirm = ({ opId, paramsHash, nowIso }) => {
  const database = ensureDb();
  return (
    database
      .prepare(`
        SELECT * FROM agent_admin_confirms
        WHERE op_id = $op_id AND params_hash = $params_hash
          AND status = 'pending' AND expires_at > $now
        ORDER BY created_at DESC LIMIT 1
      `)
      .get({ $op_id: String(opId), $params_hash: String(paramsHash), $now: nowIso }) ||
    null
  );
};

const countPending = ({ nowIso }) => {
  const database = ensureDb();
  const row = database
    .prepare(`
      SELECT COUNT(*) AS n FROM agent_admin_confirms
      WHERE status = 'pending' AND expires_at > $now
    `)
    .get({ $now: nowIso });
  return Number(row?.n || 0);
};

const listPending = ({ nowIso }) => {
  const database = ensureDb();
  return database
    .prepare(`
      SELECT id, op_id, code, summary, created_at, expires_at
      FROM agent_admin_confirms
      WHERE status = 'pending' AND expires_at > $now
      ORDER BY created_at DESC LIMIT 50
    `)
    .all({ $now: nowIso });
};

// Single-use redemption: an atomic conditional UPDATE that only matches a
// pending, unexpired, code-and-params-matching row. Returns the redeemed row
// or a reason. The WHERE clause is the concurrency guard — two racing redeems
// cannot both match (A27, doctor-token pattern + expiry + params binding).
const redeemConfirm = ({ code, opId, paramsHash, nowIso, maxAttempts = 3 }) => {
  const database = ensureDb();
  const row = database
    .prepare(`
      SELECT * FROM agent_admin_confirms
      WHERE op_id = $op_id AND params_hash = $params_hash AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `)
    .get({ $op_id: String(opId), $params_hash: String(paramsHash) });
  if (!row) return { ok: false, reason: "confirm_invalid" };
  if (row.expires_at <= nowIso) {
    database
      .prepare(`UPDATE agent_admin_confirms SET status = 'expired' WHERE id = $id`)
      .run({ $id: row.id });
    return { ok: false, reason: "confirm_expired" };
  }
  // Normalize both sides (B7): codes are minted uppercase "XXXX-XXXX", but an
  // admin relaying via chat may drop the dash or lowercase it — that should not
  // burn a redemption attempt on an otherwise-correct code.
  const normalize = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalize(row.code) !== normalize(code)) {
    const attempts = Number(row.attempts || 0) + 1;
    const status = attempts >= maxAttempts ? "exhausted" : "pending";
    database
      .prepare(`UPDATE agent_admin_confirms SET attempts = $a, status = $s WHERE id = $id`)
      .run({ $a: attempts, $s: status, $id: row.id });
    return {
      ok: false,
      reason: attempts >= maxAttempts ? "confirm_attempts_exhausted" : "confirm_invalid",
    };
  }
  const result = database
    .prepare(`
      UPDATE agent_admin_confirms
      SET status = 'redeemed', redeemed_at = $now
      WHERE id = $id AND status = 'pending'
    `)
    .run({ $id: row.id, $now: nowIso });
  if (Number(result.changes || 0) !== 1) {
    return { ok: false, reason: "confirm_invalid" };
  }
  return { ok: true, confirmId: row.id };
};

const pruneExpired = ({ nowIso }) => {
  const database = ensureDb();
  const result = database
    .prepare(`
      DELETE FROM agent_admin_confirms
      WHERE status != 'pending' OR expires_at <= $now
    `)
    .run({ $now: nowIso });
  return Number(result.changes || 0);
};

module.exports = {
  initAgentAdminDb,
  closeAgentAdminDb,
  insertConfirm,
  findActiveConfirm,
  countPending,
  listPending,
  redeemConfirm,
  pruneExpired,
};
