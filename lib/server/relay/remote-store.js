const crypto = require("crypto");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { applyOperationalPragmas } = require("../db/pragmas");
const { principalKeyFor, principalKeyForClient, kGrantTiers, kRoutes, kDefaultLanesMax, kMaxLanes } = require("../../plugin/relay-guard/grants");

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
//
// Relay trust v2 (GST-2090) adds:
//   relay_grants    who acts as the owner: one row per grant, principal
//                   "agent:<capy-...>" in PR1; a revoke keeps the row as a
//                   tombstone, so neither the env-list import nor its
//                   fallback can bring a revoked delegate back.
//   relay_handoffs  a binding handed from one thread to its successor: a
//                   one-time claim code (stored hashed), one hour, single use.
//   relay_bindings  generation (bumped by every claim), and the previous
//                   holder's capability hash, kept only so a claim whose
//                   answer was lost can be handed off again until the
//                   successor's first call.
//   PR3: "capy" grants (principal "client:<id>", a Capy project and owner,
//   with an OAuth client of their own), relay_attestations (one row per
//   Capy token id, claims only) and the binding's thread_code,
//   attested_until and attested_claims, set only from a verified token.
// The migration only adds tables and columns; it rewrites no row.
const kAuditRetentionDays = 90;
const kHandoffTtlMs = 60 * 60 * 1000;
const kJwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";

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
      " agent TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_id TEXT NOT NULL, webhook_url TEXT NOT NULL," +
      " until_at INTEGER NOT NULL, capability_hash TEXT NOT NULL, agent_token TEXT NOT NULL," +
      " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dead_at INTEGER, last_wake_at INTEGER, last_wake_status TEXT," +
      " UNIQUE (client_id, thread_id));" +
      "CREATE TABLE IF NOT EXISTS relay_wakes (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL," +
      " state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL," +
      " last_error TEXT, UNIQUE (agent, message_id));" +
      "CREATE INDEX IF NOT EXISTS relay_wakes_due ON relay_wakes (state, next_at);" +
      "CREATE TABLE IF NOT EXISTS relay_remote_audit (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, client_id TEXT, agent TEXT, detail TEXT);" +
      "CREATE INDEX IF NOT EXISTS relay_remote_audit_at ON relay_remote_audit (at);" +
      "CREATE INDEX IF NOT EXISTS relay_remote_audit_client ON relay_remote_audit (client_id, event, at);" +
      "CREATE INDEX IF NOT EXISTS relay_remote_audit_agent ON relay_remote_audit (agent, event, at);" +
      "CREATE TABLE IF NOT EXISTS relay_grants (" +
      " id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL, principal_key TEXT NOT NULL, principal TEXT NOT NULL, tier TEXT NOT NULL," +
      " kinds TEXT, lanes_max INTEGER, hourly_cap INTEGER, require_route TEXT NOT NULL DEFAULT 'any'," +
      " created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT);" +
      "CREATE INDEX IF NOT EXISTS relay_grants_principal ON relay_grants (principal_key);" +
      "CREATE TABLE IF NOT EXISTS relay_handoffs (" +
      " id TEXT PRIMARY KEY, agent TEXT NOT NULL, client_id TEXT NOT NULL, from_thread TEXT NOT NULL, successor_thread TEXT NOT NULL," +
      " generation INTEGER NOT NULL, code_hash TEXT NOT NULL UNIQUE, webhook_url TEXT, created_at INTEGER NOT NULL," +
      " expires_at INTEGER NOT NULL, claimed_at INTEGER, cancelled_at INTEGER);" +
      "CREATE INDEX IF NOT EXISTS relay_handoffs_agent ON relay_handoffs (agent);" +
      "CREATE TABLE IF NOT EXISTS relay_attestations (" +
      " jti TEXT PRIMARY KEY, client_id TEXT NOT NULL, resource TEXT NOT NULL, agent TEXT, claims TEXT NOT NULL," +
      " expires_at INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);",
  );
  const columns = db.prepare("PRAGMA table_info(relay_bindings)").all().map((column) => column.name);
  const add = (name, type) => {
    if (!columns.includes(name)) db.exec("ALTER TABLE relay_bindings ADD COLUMN " + name + " " + type);
  };
  add("generation", "INTEGER NOT NULL DEFAULT 1");
  add("thread_code", "TEXT");
  add("attested_until", "INTEGER");
  add("attested_claims", "TEXT");
  add("prior_capability_hash", "TEXT");
  add("prior_client_id", "TEXT");
  add("prior_until", "INTEGER");
};

const openRemoteStore = ({ dbPath, now = Date.now }) => {
  const db = new DatabaseSync(dbPath);
  applyOperationalPragmas(db);
  createSchema(db);
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {}

  const audit = (event, { clientId = null, agent = null, detail = null } = {}) =>
    Number(
      db.prepare("INSERT INTO relay_remote_audit (at, event, client_id, agent, detail) VALUES (?, ?, ?, ?, ?)").run(
        now(),
        event,
        clientId,
        agent,
        detail ? JSON.stringify(detail) : null,
      ).lastInsertRowid,
    );
  const removeAudit = (id) => db.prepare("DELETE FROM relay_remote_audit WHERE id = ?").run(id);

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
          generation: Number(row.generation) || 1,
          threadCode: row.thread_code || null,
          attestedUntil: row.attested_until || null,
          attestedClaims: row.attested_claims ? JSON.parse(row.attested_claims) : null,
          priorCapabilityHash: row.prior_capability_hash || null,
          priorClientId: row.prior_client_id || null,
          priorUntil: row.prior_until || null,
        }
      : null;

  const toGrant = (row) =>
    row
      ? {
          id: row.id,
          principalKind: row.principal_kind,
          principal: JSON.parse(row.principal),
          tier: row.tier,
          kinds: row.kinds ? JSON.parse(row.kinds) : null,
          lanesMax: row.lanes_max ?? null,
          hourlyCap: row.hourly_cap ?? null,
          requireRoute: row.require_route || "any",
          createdBy: row.created_by,
          createdAt: row.created_at,
          revokedAt: row.revoked_at || null,
          revokedBy: row.revoked_by || null,
        }
      : null;

  const toHandoff = (row) =>
    row
      ? {
          id: row.id,
          agent: row.agent,
          clientId: row.client_id,
          fromThread: row.from_thread,
          successorThread: row.successor_thread,
          generation: row.generation,
          webhookUrl: row.webhook_url || null,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          claimedAt: row.claimed_at || null,
          cancelledAt: row.cancelled_at || null,
        }
      : null;

  const clients = {
    get: (clientId) => toClient(db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(String(clientId))),
    insert: (info) => {
      db.prepare("INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)").run(info.client_id, JSON.stringify(info), now());
    },
    countPending: (since) =>
      db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE consented_at IS NULL AND revoked_at IS NULL AND created_at >= ?").get(since).n,
    updateInfo: (clientId, info) => db.prepare("UPDATE oauth_clients SET info = ? WHERE client_id = ?").run(JSON.stringify(info), String(clientId)),
    markConsented: (clientId) => db.prepare("UPDATE oauth_clients SET consented_at = COALESCE(consented_at, ?) WHERE client_id = ?").run(now(), clientId),
    touch: (clientId) => db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?").run(now(), clientId),
    revoke: (clientId) => {
      const at = now();
      db.prepare("UPDATE oauth_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ?").run(at, clientId);
      db.prepare("UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ?").run(at, clientId);
    },
    list: () => db.prepare("SELECT * FROM oauth_clients ORDER BY created_at DESC LIMIT 200").all().map(toClient),
    // The oldest registration still waiting for consent, removed with its
    // pending requests to make room for a new one.
    evictOldestPending: (since) => {
      const row = db
        .prepare("SELECT client_id FROM oauth_clients WHERE consented_at IS NULL AND revoked_at IS NULL AND created_at >= ? ORDER BY created_at, client_id LIMIT 1")
        .get(since);
      if (!row) return null;
      db.prepare("DELETE FROM oauth_pending WHERE client_id = ?").run(row.client_id);
      db.prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(row.client_id);
      return row.client_id;
    },
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
      return { id: row.id, clientId: row.client_id, params: JSON.parse(row.params), csrf: row.csrf, expiresAt: row.expires_at };
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
    countActiveForClient: (clientId) =>
      db.prepare("SELECT COUNT(*) AS n FROM relay_bindings WHERE client_id = ? AND until_at > ?").get(String(clientId), now()).n,
    getByThread: (clientId, threadId) =>
      toBinding(db.prepare("SELECT * FROM relay_bindings WHERE client_id = ? AND thread_id = ?").get(String(clientId), String(threadId))),
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
    // A handoff claim (remote-tools relay_claim): the successor's thread,
    // client, webhook and capability replace the holder's in one statement,
    // the generation goes up by one, and the holder's capability hash is kept
    // until priorUntil (or the successor's first call) so a claim whose answer
    // was lost can be handed off again. Returns false when the binding moved
    // on (another claim, a removal) since the caller read it.
    // The successor's attestation (PR3) replaces the holder's, or clears it
    // when the successor presents none.
    claim: ({ agent, generation, threadId, clientId, webhookUrl, capabilityHash, priorUntil, attestation = null }) =>
      db
        .prepare(
          "UPDATE relay_bindings SET prior_capability_hash = capability_hash, prior_client_id = client_id, prior_until = ?," +
            " thread_id = ?, client_id = ?, webhook_url = ?, capability_hash = ?, generation = generation + 1, updated_at = ?, dead_at = NULL," +
            " thread_code = ?, attested_until = ?, attested_claims = ?" +
            " WHERE agent = ? AND generation = ?",
        )
        .run(
          priorUntil,
          threadId,
          clientId,
          webhookUrl,
          capabilityHash,
          now(),
          attestation ? attestation.claims.thread : null,
          attestation ? attestation.expiresAt : null,
          attestation ? JSON.stringify(attestation.claims) : null,
          agent,
          generation,
        ).changes === 1,
    // A call accepted on a verified Capy attestation: the thread code comes
    // only from the token, and attested_until only moves forward.
    attest: (agent, attestation) =>
      db
        .prepare(
          "UPDATE relay_bindings SET thread_code = ?, attested_claims = ?, attested_until = MAX(COALESCE(attested_until, 0), ?) WHERE agent = ?",
        )
        .run(attestation.claims.thread, JSON.stringify(attestation.claims), attestation.expiresAt, String(agent)).changes === 1,
    // Ends the previous holder's re-issue window, and cancels any handoff it
    // re-issued that is still pending: once the successor has called, the
    // previous holder can no longer take the binding back.
    clearPrior: (agent) =>
      transaction(() => {
        const cleared = db
          .prepare("UPDATE relay_bindings SET prior_capability_hash = NULL, prior_client_id = NULL, prior_until = NULL WHERE agent = ? AND prior_capability_hash IS NOT NULL")
          .run(String(agent)).changes;
        if (cleared) db.prepare("UPDATE relay_handoffs SET cancelled_at = ? WHERE agent = ? AND claimed_at IS NULL AND cancelled_at IS NULL").run(now(), String(agent));
        return cleared;
      }),
    markDead: (agent, status) => db.prepare("UPDATE relay_bindings SET dead_at = ?, last_wake_status = ? WHERE agent = ?").run(now(), status, agent),
    noteWake: (agent, status) => db.prepare("UPDATE relay_bindings SET last_wake_at = ?, last_wake_status = ? WHERE agent = ?").run(now(), status, agent),
    list: () => db.prepare("SELECT * FROM relay_bindings ORDER BY updated_at DESC LIMIT 500").all().map(toBinding),
  };

  const wakes = {
    enqueue: ({ agent, messageId, payload, nextAt = now() }) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO relay_wakes (agent, message_id, payload, state, next_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .run(agent, String(messageId), JSON.stringify(payload), nextAt, now()).changes === 1,
    due: (limit = 20) =>
      db
        .prepare("SELECT * FROM relay_wakes WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?")
        .all(now(), limit)
        .map((row) => ({ id: row.id, agent: row.agent, messageId: row.message_id, payload: JSON.parse(row.payload), attempts: row.attempts })),
    pendingFor: (agent) => db.prepare("SELECT COUNT(*) AS n FROM relay_wakes WHERE agent = ? AND state = 'pending'").get(String(agent)).n,
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

  // Grants (GST-2090). Humans add and revoke them on the Relay page; the boot
  // import adds one per ALPHACLAW_RELAY_DELEGATE_AGENTS entry that has no
  // grant row at all, revoked rows included, so a revoke is never undone.
  const grants = {
    get: (id) => toGrant(db.prepare("SELECT * FROM relay_grants WHERE id = ?").get(String(id))),
    forAgent: (agent) => db.prepare("SELECT * FROM relay_grants WHERE principal_key = ? ORDER BY created_at, id").all(principalKeyFor(agent)).map(toGrant),
    list: () => db.prepare("SELECT * FROM relay_grants ORDER BY created_at DESC, id LIMIT 500").all().map(toGrant),
    create: ({ agent, tier = "delegate", lanesMax = kDefaultLanesMax, hourlyCap = null, requireRoute = "any", createdBy }) => {
      if (!kGrantTiers.includes(tier)) throw new Error("unknown grant tier " + tier);
      if (!kRoutes.includes(requireRoute)) throw new Error("unknown route " + requireRoute);
      const id = "rg_" + crypto.randomBytes(8).toString("hex");
      const lanes = Number.isInteger(lanesMax) ? Math.min(kMaxLanes, Math.max(1, lanesMax)) : kDefaultLanesMax;
      db.prepare(
        "INSERT INTO relay_grants (id, principal_kind, principal_key, principal, tier, lanes_max, hourly_cap, require_route, created_by, created_at)" +
          " VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, principalKeyFor(agent), JSON.stringify({ agent: String(agent).toLowerCase() }), tier, lanes, Number.isInteger(hourlyCap) ? hourlyCap : null, requireRoute, String(createdBy || "unknown"), now());
      return toGrant(db.prepare("SELECT * FROM relay_grants WHERE id = ?").get(id));
    },
    // A Capy grant (PR3) names a Capy project and thread owner. Its own OAuth
    // client, which only the jwt-bearer exchange can get tokens for, is
    // created with it (consented: the owner made the grant) and revoked with
    // it, and every binding made through that client takes this grant.
    createCapy: ({ project, user, tier = "delegate", lanesMax = kDefaultLanesMax, hourlyCap = null, requireRoute = "any", createdBy }) => {
      if (!kGrantTiers.includes(tier)) throw new Error("unknown grant tier " + tier);
      if (!kRoutes.includes(requireRoute)) throw new Error("unknown route " + requireRoute);
      const id = "rg_" + crypto.randomBytes(8).toString("hex");
      const clientId = "capy_" + id.slice(3);
      const lanes = Number.isInteger(lanesMax) ? Math.min(kMaxLanes, Math.max(1, lanesMax)) : kDefaultLanesMax;
      return transaction(() => {
        db.prepare("INSERT INTO oauth_clients (client_id, info, created_at, consented_at) VALUES (?, ?, ?, ?)").run(
          clientId,
          JSON.stringify({ client_id: clientId, client_name: "Capy machines (" + project + ")", redirect_uris: [], grant_types: [kJwtBearerGrant], capy_grant_id: id }),
          now(),
          now(),
        );
        db.prepare(
          "INSERT INTO relay_grants (id, principal_kind, principal_key, principal, tier, lanes_max, hourly_cap, require_route, created_by, created_at)" +
            " VALUES (?, 'capy', ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, principalKeyForClient(clientId), JSON.stringify({ project, user, clientId }), tier, lanes, Number.isInteger(hourlyCap) ? hourlyCap : null, requireRoute, String(createdBy || "unknown"), now());
        return toGrant(db.prepare("SELECT * FROM relay_grants WHERE id = ?").get(id));
      });
    },
    forClient: (clientId) =>
      db.prepare("SELECT * FROM relay_grants WHERE principal_key = ? ORDER BY created_at, id").all(principalKeyForClient(clientId)).map(toGrant),
    // Live Capy grants for this project and owner, newest first.
    liveCapy: ({ project, user }) =>
      db
        .prepare("SELECT * FROM relay_grants WHERE principal_kind = 'capy' AND revoked_at IS NULL ORDER BY created_at DESC, id")
        .all()
        .map(toGrant)
        .filter((grant) => grant.principal.project === project && grant.principal.user === user),
    revoke: (id, by) =>
      db.prepare("UPDATE relay_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL").run(now(), String(by || "unknown"), String(id)).changes === 1,
    importAgents: (agents, { createdBy = "env:ALPHACLAW_RELAY_DELEGATE_AGENTS" } = {}) => {
      const imported = [];
      for (const agent of Array.isArray(agents) ? agents : []) {
        if (db.prepare("SELECT 1 FROM relay_grants WHERE principal_key = ? LIMIT 1").get(principalKeyFor(agent))) continue;
        const grant = grants.create({ agent, tier: "delegate", createdBy });
        audit("grant_imported", { agent: String(agent).toLowerCase(), detail: { grantId: grant.id } });
        imported.push(grant);
      }
      return imported;
    },
  };

  // Capy attestations (PR3), one row per token id. A jti belongs to the first
  // client and resource that exchanged it and to the first binding that bound
  // or claimed with it; claims are stored, the token never is.
  const toAttestation = (row) =>
    row
      ? {
          jti: row.jti,
          clientId: row.client_id,
          resource: row.resource,
          agent: row.agent || null,
          claims: JSON.parse(row.claims),
          expiresAt: row.expires_at,
          firstAt: row.first_at,
          lastAt: row.last_at,
        }
      : null;
  const attestations = {
    get: (jti) => toAttestation(db.prepare("SELECT * FROM relay_attestations WHERE jti = ?").get(String(jti))),
    // { ok, row }: ok is false when the jti is already held by another client
    // or resource.
    record: ({ jti, clientId, resource, claims, expiresAt }) => {
      const at = now();
      db.prepare(
        "INSERT OR IGNORE INTO relay_attestations (jti, client_id, resource, claims, expires_at, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(String(jti), clientId, resource, JSON.stringify(claims), expiresAt, at, at);
      const row = attestations.get(jti);
      if (row.clientId !== clientId || row.resource !== resource) return { ok: false, row };
      db.prepare("UPDATE relay_attestations SET last_at = ? WHERE jti = ?").run(at, String(jti));
      return { ok: true, row };
    },
    // Ties the jti to a binding on its first bind or claim. false when it is
    // already tied to another one.
    bindAgent: (jti, agent) => {
      db.prepare("UPDATE relay_attestations SET agent = ? WHERE jti = ? AND agent IS NULL").run(String(agent), String(jti));
      return attestations.get(jti)?.agent === String(agent);
    },
    prune: (before) => db.prepare("DELETE FROM relay_attestations WHERE expires_at < ?").run(before).changes,
  };

  const handoffs = {
    // One pending handoff per agent: a new one cancels the last.
    create: ({ agent, clientId, fromThread, successorThread, generation, webhookUrl = null, ttlMs = kHandoffTtlMs }) => {
      const code = randomToken("arho_");
      const id = "rh_" + crypto.randomBytes(8).toString("hex");
      const at = now();
      db.prepare("UPDATE relay_handoffs SET cancelled_at = ? WHERE agent = ? AND claimed_at IS NULL AND cancelled_at IS NULL").run(at, agent);
      db.prepare(
        "INSERT INTO relay_handoffs (id, agent, client_id, from_thread, successor_thread, generation, code_hash, webhook_url, created_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, agent, clientId, fromThread, successorThread, generation, sha256(code), webhookUrl, at, at + ttlMs);
      return { code, handoff: toHandoff(db.prepare("SELECT * FROM relay_handoffs WHERE id = ?").get(id)) };
    },
    byCode: (code) => toHandoff(db.prepare("SELECT * FROM relay_handoffs WHERE code_hash = ?").get(sha256(code))),
    openFor: (agent) =>
      toHandoff(
        db
          .prepare("SELECT * FROM relay_handoffs WHERE agent = ? AND claimed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
          .get(String(agent), now()),
      ),
    markClaimed: (id) => db.prepare("UPDATE relay_handoffs SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND cancelled_at IS NULL").run(now(), id).changes === 1,
    cancelForAgent: (agent) => db.prepare("UPDATE relay_handoffs SET cancelled_at = ? WHERE agent = ? AND claimed_at IS NULL AND cancelled_at IS NULL").run(now(), String(agent)).changes,
    listPending: () =>
      db
        .prepare("SELECT * FROM relay_handoffs WHERE claimed_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100")
        .all(now())
        .map(toHandoff),
    prune: (before) => db.prepare("DELETE FROM relay_handoffs WHERE expires_at < ?").run(before).changes,
  };

  // A claim and its handoff row move together or not at all.
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  };

  const countEventsSince = (event, since) =>
    db.prepare("SELECT COUNT(*) AS n FROM relay_remote_audit WHERE event = ? AND at >= ?").get(String(event), since).n;

  const countAgentAudit = (event, agent, since) =>
    db.prepare("SELECT COUNT(*) AS n FROM relay_remote_audit WHERE agent = ? AND event = ? AND at >= ?").get(String(agent), event, since).n;

  // ungrantedOnly leaves out rows a granted agent spent, which its grant's
  // own cap meters, so a delegate cannot use up its connection's peers.
  const countAudit = (event, clientId, since, { ungrantedOnly = false } = {}) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_remote_audit WHERE client_id = ? AND event = ? AND at >= ?" +
          (ungrantedOnly ? " AND (detail IS NULL OR json_extract(detail, '$.grantId') IS NULL)" : ""),
      )
      .get(String(clientId), event, since).n;

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
    handoffs.prune(now() - 30 * dayMs);
    attestations.prune(now() - dayMs);
    if (auditRetentionDays > 0) db.prepare("DELETE FROM relay_remote_audit WHERE at < ?").run(now() - auditRetentionDays * dayMs);
  };

  return {
    clients,
    pending,
    codes,
    tokens,
    bindings,
    wakes,
    grants,
    handoffs,
    attestations,
    transaction,
    audit,
    removeAudit,
    countAudit,
    countAgentAudit,
    countEventsSince,
    recentAudit,
    sweep,
    db,
    close: () => db.close(),
  };
};

module.exports = { openRemoteStore, sha256, randomToken, kAuditRetentionDays, kHandoffTtlMs, kJwtBearerGrant };
