const crypto = require("crypto");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../db/pragmas");

// The remote side's durable state (relay/remote.db, 0600 in the 0700 relay
// directory): OAuth clients, pending consents, authorization codes, tokens
// (stored as sha256 hashes, never in the clear), thread bindings, the wake
// queue and the audit log of grants, refreshes, revokes and bindings.
//
// A binding holds the engine token of its capy-* agent and the thread's Capy
// webhook URL, because AlphaClaw must use both; neither is ever returned by
// an API. Its capability (what the thread presents to act as the agent) is
// stored as a hash. A binding past its until date stops waking but is kept,
// so its agent (and that agent's history) can only be bound again with the
// same capability; only the owner frees it (Relay page) or a client revoke.
const kAuditRetentionDays = 90;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const randomToken = (prefix = "") => prefix + crypto.randomBytes(32).toString("base64url");

const createSchema = (db) => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS oauth_clients (" +
      " client_id TEXT PRIMARY KEY, info TEXT NOT NULL, created_at INTEGER NOT NULL," +
      " consented_at INTEGER, revoked_at INTEGER, last_used_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS oauth_pending (" +
      " id TEXT PRIMARY KEY, client_id TEXT NOT NULL, params TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS oauth_codes (" +
      " code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL," +
      " resource TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS oauth_tokens (" +
      " token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, family TEXT NOT NULL," +
      " resource TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL," +
      " used_at INTEGER, revoked_at INTEGER);" +
      "CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family);" +
      "CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens (client_id);" +
      "CREATE TABLE IF NOT EXISTS relay_bindings (" +
      " agent TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, webhook_url TEXT NOT NULL," +
      " until_at INTEGER NOT NULL, capability_hash TEXT NOT NULL, agent_token TEXT NOT NULL," +
      " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dead_at INTEGER, last_wake_at INTEGER, last_wake_status TEXT);" +
      "CREATE TABLE IF NOT EXISTS relay_wakes (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL," +
      " state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL," +
      " last_error TEXT, UNIQUE (agent, message_id));" +
      "CREATE INDEX IF NOT EXISTS relay_wakes_due ON relay_wakes (state, next_at);" +
      "CREATE TABLE IF NOT EXISTS relay_remote_audit (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, client_id TEXT, agent TEXT, detail TEXT);" +
      "CREATE INDEX IF NOT EXISTS relay_remote_audit_at ON relay_remote_audit (at);",
  );
};

const openRemoteStore = ({ dbPath, now = Date.now }) => {
  const db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}

  const audit = (event, { clientId = null, agent = null, detail = null } = {}) => {
    db.prepare("INSERT INTO relay_remote_audit (at, event, client_id, agent, detail) VALUES (?, ?, ?, ?, ?)").run(
      now(),
      event,
      clientId,
      agent,
      detail ? JSON.stringify(detail) : null,
    );
  };

  const toClient = (row) =>
    row
      ? {
          clientId: row.client_id,
          info: JSON.parse(row.info),
          createdAt: row.created_at,
          consentedAt: row.consented_at,
          revokedAt: row.revoked_at,
          lastUsedAt: row.last_used_at,
        }
      : null;

  const toBinding = (row) =>
    row
      ? {
          agent: row.agent,
          threadId: row.thread_id,
          clientId: row.client_id,
          webhookUrl: row.webhook_url,
          until: row.until_at,
          capabilityHash: row.capability_hash,
          agentToken: row.agent_token,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deadAt: row.dead_at,
          lastWakeAt: row.last_wake_at,
          lastWakeStatus: row.last_wake_status,
        }
      : null;

  const clients = {
    get: (clientId) => toClient(db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(String(clientId))),
    insert: (info) => {
      db.prepare("INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)").run(info.client_id, JSON.stringify(info), now());
    },
    countPending: (since) =>
      db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE consented_at IS NULL AND revoked_at IS NULL AND created_at >= ?").get(since).n,
    markConsented: (clientId) => db.prepare("UPDATE oauth_clients SET consented_at = COALESCE(consented_at, ?) WHERE client_id = ?").run(now(), clientId),
    touch: (clientId) => db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").run(now(), clientId),
    revoke: (clientId) => {
      const at = now();
      db.prepare("UPDATE oauth_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ?").run(at, clientId);
      db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ?").run(at, clientId);
    },
    list: () => db.prepare("SELECT * FROM oauth_clients ORDER BY created_at DESC LIMIT 200").all().map(toClient),
    pruneUnconsented: (before) =>
      db.prepare("DELETE FROM oauth_clients WHERE consented_at IS NULL AND created_at < ?").run(before).changes,
  };

  const pending = {
    create: ({ clientId, params, ttlMs }) => {
      const id = randomToken();
      const csrf = randomToken();
      db.prepare("INSERT INTO oauth_pending (id, client_id, params, csrf, expires_at) VALUES (?, ?, ?, ?, ?)").run(
        id,
        clientId,
        JSON.stringify(params),
        csrf,
        now() + ttlMs,
      );
      return { id, csrf };
    },
    get: (id) => {
      const row = db.prepare("SELECT * FROM oauth_pending WHERE id = ?").get(String(id));
      if (!row || row.expires_at < now()) return null;
      return { id: row.id, clientId: row.client_id, params: JSON.parse(row.params), csrf: row.csrf };
    },
    take: (id) => db.prepare("DELETE FROM oauth_pending WHERE id = ?").run(String(id)).changes === 1,
    prune: () => db.prepare("DELETE FROM oauth_pending WHERE expires_at < ?").run(now()).changes,
  };

  const codes = {
    create: ({ clientId, challenge, redirectUri, resource, scopes, ttlMs }) => {
      const code = randomToken("arc_");
      db.prepare(
        "INSERT INTO oauth_codes (code_hash, client_id, challenge, redirect_uri, resource, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(sha256(code), clientId, challenge, redirectUri, resource, JSON.stringify(scopes || []), now() + ttlMs);
      return code;
    },
    get: (code) => {
      const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(code));
      if (!row) return null;
      return {
        clientId: row.client_id,
        challenge: row.challenge,
        redirectUri: row.redirect_uri,
        resource: row.resource,
        scopes: JSON.parse(row.scopes),
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
    },
    markUsed: (code) => db.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now(), sha256(code)).changes === 1,
    prune: () => db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now() - 24 * 60 * 60 * 1000).changes,
  };

  const tokens = {
    issue: ({ kind, clientId, family, resource, scopes, ttlMs }) => {
      const token = randomToken(kind === "access" ? "arat_" : "arrt_");
      db.prepare(
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, family, resource, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(sha256(token), kind, clientId, family, resource, JSON.stringify(scopes || []), now(), now() + ttlMs);
      return token;
    },
    get: (token) => {
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(sha256(token));
      if (!row) return null;
      return {
        kind: row.kind,
        clientId: row.client_id,
        family: row.family,
        resource: row.resource,
        scopes: JSON.parse(row.scopes),
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        revokedAt: row.revoked_at,
      };
    },
    markUsed: (token) =>
      db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL").run(now(), sha256(token))
        .changes === 1,
    revokeFamily: (family) => db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family = ?").run(now(), family).changes,
    prune: () => db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now() - 7 * 24 * 60 * 60 * 1000).changes,
    countActive: (clientId) =>
      db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ? AND kind = 'refresh' AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?").get(clientId, now()).n,
  };

  const bindings = {
    get: (agent) => toBinding(db.prepare("SELECT * FROM relay_bindings WHERE agent = ?").get(String(agent))),
    getByThread: (threadId) => toBinding(db.prepare("SELECT * FROM relay_bindings WHERE thread_id = ?").get(String(threadId))),
    upsert: ({ agent, threadId, clientId, webhookUrl, until, capabilityHash, agentToken }) => {
      const at = now();
      db.prepare(
        "INSERT INTO relay_bindings (agent, thread_id, client_id, webhook_url, until_at, capability_hash, agent_token, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT(agent) DO UPDATE SET client_id = excluded.client_id, webhook_url = excluded.webhook_url, until_at = excluded.until_at," +
          " agent_token = excluded.agent_token, updated_at = excluded.updated_at, dead_at = NULL",
      ).run(agent, threadId, clientId, webhookUrl, until, capabilityHash, agentToken, at, at);
    },
    remove: (agent) => {
      db.prepare("DELETE FROM relay_wakes WHERE agent = ?").run(String(agent));
      return db.prepare("DELETE FROM relay_bindings WHERE agent = ?").run(String(agent)).changes === 1;
    },
    removeForClient: (clientId) => {
      const agents = db.prepare("SELECT agent FROM relay_bindings WHERE client_id = ?").all(clientId).map((row) => row.agent);
      for (const agent of agents) bindings.remove(agent);
      return agents;
    },
    markDead: (agent, status) => db.prepare("UPDATE relay_bindings SET dead_at = ?, last_wake_status = ? WHERE agent = ?").run(now(), status, agent),
    noteWake: (agent, status) => db.prepare("UPDATE relay_bindings SET last_wake_at = ?, last_wake_status = ? WHERE agent = ?").run(now(), status, agent),
    list: () => db.prepare("SELECT * FROM relay_bindings ORDER BY updated_at DESC LIMIT 500").all().map(toBinding),
  };

  const wakes = {
    enqueue: ({ agent, messageId, payload }) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO relay_wakes (agent, message_id, payload, state, next_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .run(agent, String(messageId), JSON.stringify(payload), now(), now()).changes === 1,
    due: (limit = 20) =>
      db
        .prepare("SELECT * FROM relay_wakes WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?")
        .all(now(), limit)
        .map((row) => ({ id: row.id, agent: row.agent, messageId: row.message_id, payload: JSON.parse(row.payload), attempts: row.attempts })),
    nextDueAt: () => db.prepare("SELECT MIN(next_at) AS at FROM relay_wakes WHERE state = 'pending'").get().at,
    settle: (id, state, error = null) =>
      db.prepare("UPDATE relay_wakes SET state = ?, last_error = ?, attempts = attempts + 1 WHERE id = ?").run(state, error, id),
    retry: (id, nextAt, error) =>
      db.prepare("UPDATE relay_wakes SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?").run(nextAt, error, id),
    counts: () => {
      const out = {};
      for (const row of db.prepare("SELECT state, COUNT(*) AS n FROM relay_wakes GROUP BY state").all()) out[row.state] = row.n;
      return out;
    },
    prune: (before) => db.prepare("DELETE FROM relay_wakes WHERE state != 'pending' AND created_at < ?").run(before).changes,
  };

  const recentAudit = (limit = 50) =>
    db
      .prepare("SELECT * FROM relay_remote_audit ORDER BY id DESC LIMIT ?")
      .all(limit)
      .map((row) => ({ at: row.at, event: row.event, clientId: row.client_id, agent: row.agent, detail: row.detail ? JSON.parse(row.detail) : null }));

  const sweep = ({ auditRetentionDays = kAuditRetentionDays } = {}) => {
    const dayMs = 24 * 60 * 60 * 1000;
    pending.prune();
    codes.prune();
    tokens.prune();
    clients.pruneUnconsented(now() - dayMs);
    wakes.prune(now() - 30 * dayMs);
    if (auditRetentionDays > 0) db.prepare("DELETE FROM relay_remote_audit WHERE at < ?").run(now() - auditRetentionDays * dayMs);
  };

  return {
    clients,
    pending,
    codes,
    tokens,
    bindings,
    wakes,
    audit,
    recentAudit,
    sweep,
    db,
    close: () => db.close(),
  };
};

module.exports = { openRemoteStore, sha256, randomToken, kAuditRetentionDays };
