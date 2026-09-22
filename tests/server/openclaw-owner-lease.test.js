const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kGatewayOwnerLeaseTtlMs,
  kGatewayOwnerLeaseHeartbeatMs,
  kGatewayOwnerLeaseStaleAfterMs,
  kGatewayOwnerLeaseScope,
  kGatewayOwnerLeaseKey,
  readGatewayOwnerLease,
  reclaimStaleForeignGatewayOwnerLease,
} = require("../../lib/server/openclaw-owner-lease");

// Column set of upstream's `state_leases` table as 2026.9.5 creates it
// (acquireOpenClawStateLeaseInTransaction inserts exactly these).
const createLeaseTable = (db) =>
  db.exec(`CREATE TABLE state_leases (
    scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL,
    expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT,
    created_at INTEGER, updated_at INTEGER, PRIMARY KEY (scope, lease_key))`);

const insertLease = (db, { expiresAt, heartbeatAt, payload, scope = kGatewayOwnerLeaseScope, key = kGatewayOwnerLeaseKey }) =>
  db
    .prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(scope, key, "owner-uuid", expiresAt, heartbeatAt, payload === null ? null : JSON.stringify(payload), 1, 1);

describe("server/openclaw-owner-lease (2026.9.4+ gateway-owner lease, read-only)", () => {
  let dir;
  let dbPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-owner-lease-"));
    dbPath = path.join(dir, "openclaw.sqlite");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("pins the upstream constants the wait is derived from (STARTUP_MIGRATION_LEASE_TTL_MS = 300 s, heartbeat 30 s)", () => {
    expect(kGatewayOwnerLeaseTtlMs).toBe(300_000);
    expect(kGatewayOwnerLeaseHeartbeatMs).toBe(30_000);
    expect(kGatewayOwnerLeaseScope).toBe("gateway-owner");
    expect(kGatewayOwnerLeaseKey).toBe("global");
  });

  it("missing database → missing; database without the table → absent; table without the row → absent", () => {
    expect(readGatewayOwnerLease({ stateDbPath: dbPath })).toEqual({
      status: "missing", expiresAt: null, heartbeatAt: null, remainingMs: 0, owner: null,
    });
    expect(readGatewayOwnerLease({})).toMatchObject({ status: "missing" });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (x)");
    db.close();
    expect(readGatewayOwnerLease({ stateDbPath: dbPath })).toMatchObject({ status: "absent", owner: null });
    const db2 = new DatabaseSync(dbPath);
    createLeaseTable(db2);
    insertLease(db2, { expiresAt: 5_000_000, heartbeatAt: 4_700_000, payload: null, scope: "other-scope" });
    db2.close();
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 1 })).toMatchObject({ status: "absent" });
  });

  it("a row inside its expiry is held: expiry, last heartbeat, remaining wait and the holder's identity from payload_json", () => {
    const db = new DatabaseSync(dbPath);
    createLeaseTable(db);
    insertLease(db, {
      expiresAt: 1_000_300_000,
      heartbeatAt: 1_000_000_000,
      payload: { owner: { pid: 7, host: "a1b2c3d4e5f6", startedAt: 123456 }, port: 18789, mode: "foreground", supervisor: null },
    });
    db.close();
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 1_000_100_000 })).toEqual({
      status: "held",
      expiresAt: 1_000_300_000,
      heartbeatAt: 1_000_000_000,
      remainingMs: 200_000,
      owner: { pid: 7, host: "a1b2c3d4e5f6", startedAt: 123456, port: 18789, mode: "foreground" },
    });
    // At and after expires_at the row is expired (upstream deletes `expires_at <= now` at acquire time).
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 1_000_300_000 })).toMatchObject({ status: "expired", remainingMs: 0 });
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 2_000_000_000 })).toMatchObject({ status: "expired", remainingMs: 0 });
  });

  it("holder fields are untrusted DB text: a non-token host, a bad pid or an unparseable payload read as unknown, never throw", () => {
    const db = new DatabaseSync(dbPath);
    createLeaseTable(db);
    insertLease(db, {
      expiresAt: 900, heartbeatAt: 800,
      payload: { owner: { pid: -3, host: "<script>alert(1)</script>", startedAt: "x" }, port: 99999, mode: "weird" },
    });
    db.close();
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 100 })).toMatchObject({
      status: "held", remainingMs: 800,
      owner: { pid: null, host: null, startedAt: null, port: null, mode: null },
    });
    const db2 = new DatabaseSync(dbPath);
    db2.exec("UPDATE state_leases SET payload_json = '{not json', expires_at = NULL");
    db2.close();
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: 100 })).toMatchObject({
      status: "expired", expiresAt: null, owner: null,
    });
  });

  it("an unopenable database is unreadable (with the error named) — the caller falls back to the full TTL", () => {
    fs.writeFileSync(dbPath, "this is not a sqlite file, just bytes long enough to be read as a header 0123456789abcdef");
    const result = readGatewayOwnerLease({ stateDbPath: dbPath });
    expect(result.status).toBe("unreadable");
    expect(result.owner).toBeNull();
    expect(typeof result.error.message).toBe("string");
    // Injected failures (busy, EACCES) take the same arm.
    const Busy = class { constructor() { const e = new Error("database is locked"); e.code = "ERR_SQLITE_ERROR"; throw e; } };
    expect(readGatewayOwnerLease({ stateDbPath: dbPath, DatabaseSyncImpl: Busy })).toMatchObject({
      status: "unreadable", error: { code: "ERR_SQLITE_ERROR" },
    });
  });

  describe("reclaimStaleForeignGatewayOwnerLease — the one write, fenced", () => {
    const seed = ({ host = "otherhost", heartbeatAt, expiresAt, pid = 7 }) => {
      const db = new DatabaseSync(dbPath);
      createLeaseTable(db);
      insertLease(db, { expiresAt, heartbeatAt, payload: { owner: { pid, host, startedAt: 1 }, port: 18789, mode: "foreground", supervisor: null } });
      db.close();
    };
    const rowCount = () => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare("SELECT COUNT(*) AS n FROM state_leases").get().n; } finally { db.close(); } };

    it("pins the staleness rule: three missed 30 s heartbeats", () => {
      expect(kGatewayOwnerLeaseStaleAfterMs).toBe(90_000);
    });

    it("reclaims a FOREIGN-host row whose heartbeat is >= 90 s old and still inside its TTL; the row is gone", () => {
      const now = 1_000_000_000;
      seed({ heartbeatAt: now - 100_000, expiresAt: now + 200_000 });
      const result = reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" });
      expect(result).toMatchObject({ status: "reclaimed", reason: "stale_foreign_host", lease: { status: "held", owner: { host: "otherhost", pid: 7 } } });
      expect(Number(rowCount())).toBe(0);
      expect(readGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now })).toMatchObject({ status: "absent" });
    });

    it("never touches a same-host row (upstream judges its own host), a fresh heartbeat, an unknown host, an expired/absent/missing row", () => {
      const now = 1_000_000_000;
      seed({ host: "thishost", heartbeatAt: now - 100_000, expiresAt: now + 200_000 });
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "same_host" });
      expect(Number(rowCount())).toBe(1);
      fs.rmSync(dbPath);
      seed({ heartbeatAt: now - 89_999, expiresAt: now + 200_000 });
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "fresh_heartbeat" });
      expect(Number(rowCount())).toBe(1);
      fs.rmSync(dbPath);
      const db = new DatabaseSync(dbPath); createLeaseTable(db);
      insertLease(db, { expiresAt: now + 200_000, heartbeatAt: now - 100_000, payload: { owner: { pid: 7, host: "<bad host>", startedAt: 1 }, port: 1, mode: "foreground" } });
      db.close();
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "host_unknown" });
      fs.rmSync(dbPath);
      seed({ heartbeatAt: now - 400_000, expiresAt: now - 1 });
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "expired" });
      fs.rmSync(dbPath);
      const db2 = new DatabaseSync(dbPath); createLeaseTable(db2); db2.close();
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "absent" });
      fs.rmSync(dbPath);
      expect(reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, nowMs: now, hostname: "thishost" })).toMatchObject({ status: "skipped", reason: "missing" });
    });

    it("a holder that beats between the read and the delete keeps its row (owner + heartbeat fence)", () => {
      const now = 1_000_000_000;
      seed({ heartbeatAt: now - 100_000, expiresAt: now + 200_000 });
      const result = reclaimStaleForeignGatewayOwnerLease({
        stateDbPath: dbPath, nowMs: now, hostname: "thishost",
        onBeforeDelete: ({ db }) => db.prepare("UPDATE state_leases SET heartbeat_at = ?, expires_at = ?").run(now - 1, now + 300_000),
      });
      expect(result).toMatchObject({ status: "skipped", reason: "renewed_concurrently" });
      expect(Number(rowCount())).toBe(1);
    });

    it("a database that cannot be opened for writing is unreadable/write_failed, never a throw", () => {
      fs.writeFileSync(dbPath, "not a sqlite file, just bytes long enough to be read as a header 0123456789abcdef");
      const result = reclaimStaleForeignGatewayOwnerLease({ stateDbPath: dbPath, hostname: "thishost" });
      expect(result.status).toBe("unreadable");
      expect(result.reason).toBe("unreadable");
    });
  });
});
