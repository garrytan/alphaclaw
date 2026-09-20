const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kGatewayOwnerLeaseTtlMs,
  kGatewayOwnerLeaseHeartbeatMs,
  kGatewayOwnerLeaseScope,
  kGatewayOwnerLeaseKey,
  readGatewayOwnerLease,
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
});
