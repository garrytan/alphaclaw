const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// OpenClaw 2026.9.4+ records the running gateway as a row in the state
// database (`state_leases`, scope "gateway-owner", key "global"; verified
// 2026-09-20 against the 2026.9.5 dist: src/infra/gateway-owner-lease.ts,
// openclaw-state-lease-store; re-verified 2026-10-12 against the 2026.10.2
// dist: gateway-owner-lease-*.mjs, gateway-state-owner-*.mjs). The row's
// expiry is the 300 s STARTUP_MIGRATION_LEASE_TTL_MS, extended by every
// heartbeat; 2026.10.2 beats every 15 s (GATEWAY_OWNER_HEARTBEAT_MS = 15e3,
// `heartbeatMs` in acquireGatewayOwnerLease; 2026.9.x beat every 30 s), so a
// gateway that died without releasing (SIGKILL, a removed container, a host
// reboot) leaves a lease that lapses at most 300 s after its last beat.
//
// A starting gateway reclaims the row when it can PROVE the holder dead. On
// 2026.9.x that meant same hostname, pid gone or start time changed —
// otherwise it refused with "Another Gateway owner lease is still active for
// this state directory" until `expires_at` passed, so from a NEW container
// (hostname never matches) it could not reclaim at all. 2026.10.2 adds
// classifyGatewayOwnerProcessNamespace: a holder recorded on another host or
// PID namespace is "dead" once its heartbeat is older than 90 s
// (GATEWAY_OWNER_HEARTBEAT_STALE_MS = 9e4) and, while younger, the start
// refuses with "cannot verify Gateway ownership from this process (different
// PID namespace)" (classified owner_lease_held in openclaw-lock-contention.js).
//
// The reader is READ-ONLY. The ONE write this module performs is
// reclaimStaleForeignGatewayOwnerLease: it deletes the gateway-owner row only
// when (a) its holder is on ANOTHER host (a same-host row is upstream's to
// judge — it reclaims a dead same-host holder itself, so a same-host refusal
// means a live gateway), (b) that holder's heartbeat is older than upstream's
// own 90 s staleness threshold (six missed 15 s beats; a live gateway is
// fenced on `expires_at > now`), and (c) the DELETE is fenced on the row's
// owner id AND last heartbeat, so a holder that beats between our read and our
// write is never removed. On 2026.10.2 this is the same verdict upstream now
// reaches itself, so it is a defensive belt rather than the only way out — it
// stays because the watchdog's relaunch grace is keyed to the row's recorded
// EXPIRY (up to 300 s): without the reclaim it would sit out the full TTL
// even though the next start would already succeed 90 s after the last beat.
// It can never be more eager than upstream: same threshold, fenced delete.
const kGatewayOwnerLeaseTtlMs = 300_000;
const kGatewayOwnerLeaseHeartbeatMs = 15_000;
// Pinned to upstream's GATEWAY_OWNER_HEARTBEAT_STALE_MS, NOT derived from the
// heartbeat: 2026.10.2 halved the beat and kept 90 s.
const kGatewayOwnerLeaseStaleAfterMs = 90_000;
const kGatewayOwnerLeaseScope = "gateway-owner";
const kGatewayOwnerLeaseKey = "global";
const kReadonlyBusyTimeoutMs = 1_500;
// An untrusted DB string that reaches operator notices: a closed token shape.
const kHostTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const toInt = (value) => {
  const n = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const parseOwner = (payloadJson) => {
  if (typeof payloadJson !== "string" || !payloadJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const owner = parsed && typeof parsed === "object" ? parsed.owner : null;
  if (!owner || typeof owner !== "object") return null;
  const pid = toInt(owner.pid);
  const host = typeof owner.host === "string" && kHostTokenPattern.test(owner.host) ? owner.host : null;
  const startedAt = owner.startedAt === null ? null : toInt(owner.startedAt);
  const rawPort = toInt(parsed.port);
  const port = rawPort !== null && rawPort >= 1 && rawPort <= 65535 ? rawPort : null;
  const mode = parsed.mode === "foreground" || parsed.mode === "supervised" ? parsed.mode : null;
  return { pid: pid && pid > 0 ? pid : null, host, startedAt, port, mode };
};

// { status: "missing" | "absent" | "unreadable" | "expired" | "held",
//   expiresAt, heartbeatAt, remainingMs, owner: { pid, host, startedAt, port, mode } | null,
//   error? }
// "missing"    no state database at that path
// "absent"     database readable, no state_leases table or no gateway-owner row
// "unreadable" the database could not be opened or read (busy, corrupt, ...)
// "expired"    a row exists but its expires_at has passed
// "held"       a row exists and has not expired — the gateway will refuse
const readGatewayOwnerLease = ({
  stateDbPath,
  nowMs = Date.now(),
  fsModule = fs,
  DatabaseSyncImpl = DatabaseSync,
} = {}) => {
  if (!stateDbPath) return { status: "missing", expiresAt: null, heartbeatAt: null, remainingMs: 0, owner: null };
  let exists = null;
  try {
    exists = fsModule.existsSync(stateDbPath);
  } catch {}
  if (exists === false) return { status: "missing", expiresAt: null, heartbeatAt: null, remainingMs: 0, owner: null };
  let db = null;
  try {
    db = new DatabaseSyncImpl(stateDbPath, { readOnly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${kReadonlyBusyTimeoutMs};`);
    } catch {}
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'")
      .get();
    if (!table) return { status: "absent", expiresAt: null, heartbeatAt: null, remainingMs: 0, owner: null };
    const row = db
      .prepare(
        "SELECT owner, expires_at, heartbeat_at, payload_json FROM state_leases WHERE scope = ? AND lease_key = ?",
      )
      .get(kGatewayOwnerLeaseScope, kGatewayOwnerLeaseKey);
    if (!row) return { status: "absent", expiresAt: null, heartbeatAt: null, remainingMs: 0, owner: null };
    const expiresAt = toInt(row.expires_at);
    const heartbeatAt = toInt(row.heartbeat_at);
    const owner = parseOwner(row.payload_json);
    const remainingMs = expiresAt === null ? 0 : Math.max(0, expiresAt - nowMs);
    return {
      status: expiresAt !== null && expiresAt > nowMs ? "held" : "expired",
      expiresAt,
      heartbeatAt,
      remainingMs,
      owner,
    };
  } catch (error) {
    return {
      status: "unreadable",
      expiresAt: null,
      heartbeatAt: null,
      remainingMs: 0,
      owner: null,
      error: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) },
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
};

// { status: "reclaimed" | "skipped" | "unreadable", reason, lease, error? }
// reasons: missing | absent | expired | host_unknown | same_host |
//          fresh_heartbeat | renewed_concurrently | write_failed
const reclaimStaleForeignGatewayOwnerLease = ({
  stateDbPath,
  nowMs = Date.now(),
  hostname = require("os").hostname(),
  staleAfterMs = kGatewayOwnerLeaseStaleAfterMs,
  fsModule = fs,
  DatabaseSyncImpl = DatabaseSync,
  // Test seam: runs between the fenced read and the fenced delete.
  onBeforeDelete = null,
} = {}) => {
  const lease = readGatewayOwnerLease({ stateDbPath, nowMs, fsModule, DatabaseSyncImpl });
  const skip = (reason) => ({ status: "skipped", reason, lease });
  if (lease.status === "missing" || lease.status === "absent") return skip(lease.status);
  if (lease.status === "unreadable") return { status: "unreadable", reason: "unreadable", lease, error: lease.error };
  if (lease.status === "expired") return skip("expired");
  if (!lease.owner?.host) return skip("host_unknown");
  if (lease.owner.host === hostname) return skip("same_host");
  if (lease.heartbeatAt === null || nowMs - lease.heartbeatAt < staleAfterMs) return skip("fresh_heartbeat");
  let db = null;
  try {
    db = new DatabaseSyncImpl(stateDbPath);
    try {
      db.exec(`PRAGMA busy_timeout = ${kReadonlyBusyTimeoutMs};`);
    } catch {}
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare("SELECT owner, heartbeat_at, expires_at FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get(kGatewayOwnerLeaseScope, kGatewayOwnerLeaseKey);
      if (typeof onBeforeDelete === "function") onBeforeDelete({ db, row });
      // Re-fence inside the transaction: same owner, same last beat, still held.
      if (!row || toInt(row.heartbeat_at) !== lease.heartbeatAt || (toInt(row.expires_at) ?? 0) <= nowMs) {
        db.exec("ROLLBACK");
        return skip(row ? "renewed_concurrently" : "absent");
      }
      const deleted = db
        .prepare(
          "DELETE FROM state_leases WHERE scope = ? AND lease_key = ? AND owner = ? AND heartbeat_at = ?",
        )
        .run(kGatewayOwnerLeaseScope, kGatewayOwnerLeaseKey, row.owner, row.heartbeat_at);
      const changes = typeof deleted.changes === "bigint" ? Number(deleted.changes) : deleted.changes;
      if (changes !== 1) {
        db.exec("ROLLBACK");
        return skip("renewed_concurrently");
      }
      db.exec("COMMIT");
      return { status: "reclaimed", reason: "stale_foreign_host", lease };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } catch (error) {
    return {
      status: "unreadable",
      reason: "write_failed",
      lease,
      error: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) },
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
};

module.exports = {
  kGatewayOwnerLeaseTtlMs,
  kGatewayOwnerLeaseHeartbeatMs,
  kGatewayOwnerLeaseStaleAfterMs,
  kGatewayOwnerLeaseScope,
  kGatewayOwnerLeaseKey,
  readGatewayOwnerLease,
  reclaimStaleForeignGatewayOwnerLease,
};
