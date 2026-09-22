const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

// OpenClaw 2026.9.4+ records the running gateway as a row in the state
// database (`state_leases`, scope "gateway-owner", key "global"; verified
// 2026-09-20 against the 2026.9.5 dist: src/infra/gateway-owner-lease.ts,
// openclaw-state-lease-store). A starting gateway reclaims the row only when it
// can PROVE the recorded holder dead — same hostname, pid gone or start time
// changed — and otherwise refuses with "Another Gateway owner lease is still
// active for this state directory" until `expires_at` passes. The holder
// heartbeats every 30 s and each beat extends expiry by the 300 s TTL, so a
// gateway that died without releasing (SIGKILL, a removed container, a host
// reboot) leaves a lease that lapses at most 300 s after its last beat. From
// a NEW container the hostname never matches, so upstream cannot reclaim it
// and the refusal is exactly the pid-reuse/fresh-namespace shape the boot
// spine already reasons about for its own pidfile.
//
// The reader is READ-ONLY. The ONE write this module performs is
// reclaimStaleForeignGatewayOwnerLease: it deletes the gateway-owner row only
// when (a) its holder is on ANOTHER host (a same-host row is upstream's to
// judge — it reclaims a dead same-host holder itself, so a same-host refusal
// means a live gateway), (b) that holder has missed >= 3 heartbeats (90 s;
// a live gateway beats every 30 s, fenced on `expires_at > now`), and (c) the
// DELETE is fenced on the row's owner id AND last heartbeat, so a holder that
// beats between our read and our write is never removed. Waiting out the full
// TTL instead costs an unclean container replacement ~5 min of gateway
// downtime — longer than the container tier's health budget.
const kGatewayOwnerLeaseTtlMs = 300_000;
const kGatewayOwnerLeaseHeartbeatMs = 30_000;
const kGatewayOwnerLeaseStaleAfterMs = 3 * kGatewayOwnerLeaseHeartbeatMs;
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
