const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  createStateEra,
  hasExecApprovalsRow,
  tableHasColumns,
  isSqliteEraRuntime,
  kExecApprovalsSqliteMinVersion,
  readAuthSharedStoreLocation,
  readChannelAllowEntriesByAccount,
  deletePairingRequestByCode,
  deleteChannelPairingRows,
} = require("../../lib/server/openclaw-state-era");
const { kOpenclawStateDbPath } = require("../../lib/server/openclaw-state-db");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-state-era-test-"));

const createStateDb = (openclawDir, { table = true, row = false, columns } = {}) => {
  const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  if (table) {
    db.exec(
      columns ||
        "CREATE TABLE exec_approvals_config (config_key TEXT NOT NULL PRIMARY KEY, raw_json TEXT NOT NULL)",
    );
    if (row) {
      db.prepare(
        "INSERT INTO exec_approvals_config (config_key, raw_json) VALUES ('current', '{}')",
      ).run();
    }
  }
  db.close();
  return databasePath;
};

const quietLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("server/openclaw-state-era row detection", () => {
  it("requires a ROW — the eagerly-created empty table (pinned 2026.7.1-2) is not the sqlite era", () => {
    const tableOnly = createTempOpenclawDir();
    createStateDb(tableOnly, { table: true, row: false });
    expect(hasExecApprovalsRow({ openclawDir: tableOnly })).toBe(false);

    const withRow = createTempOpenclawDir();
    createStateDb(withRow, { table: true, row: true });
    expect(hasExecApprovalsRow({ openclawDir: withRow })).toBe(true);
  });

  it("is false when the state db or table is missing", () => {
    const noDb = createTempOpenclawDir();
    expect(hasExecApprovalsRow({ openclawDir: noDb })).toBe(false);

    const noTable = createTempOpenclawDir();
    createStateDb(noTable, { table: false });
    expect(hasExecApprovalsRow({ openclawDir: noTable })).toBe(false);
  });

  it("schema guard fails closed when expected columns are missing", () => {
    const reshaped = createTempOpenclawDir();
    createStateDb(reshaped, {
      columns: "CREATE TABLE exec_approvals_config (something_else TEXT PRIMARY KEY)",
      row: false,
    });
    expect(hasExecApprovalsRow({ openclawDir: reshaped })).toBe(false);
  });

  it("degrades to false with a warning on an unreadable database — never throws", () => {
    const openclawDir = createTempOpenclawDir();
    const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "this is not a sqlite database", "utf8");
    const logger = quietLogger();
    expect(hasExecApprovalsRow({ openclawDir, logger })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("state-db check"),
    );
  });

  it("respects an injected fsModule existence answer (memory-fs harnesses)", () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    const fakeFs = { existsSync: () => false };
    expect(hasExecApprovalsRow({ fsModule: fakeFs, openclawDir })).toBe(false);
  });
});

describe("server/openclaw-state-era tableHasColumns", () => {
  it("verifies table and column presence and rejects unsafe identifiers", () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: false });
    const db = new DatabaseSync(path.join(openclawDir, kOpenclawStateDbPath), {
      readOnly: true,
    });
    try {
      expect(tableHasColumns(db, "exec_approvals_config", ["config_key", "raw_json"])).toBe(true);
      expect(tableHasColumns(db, "exec_approvals_config", ["config_key", "nope"])).toBe(false);
      expect(tableHasColumns(db, "missing_table", ["config_key"])).toBe(false);
      expect(tableHasColumns(db, 'bad"; DROP TABLE x; --', ["config_key"])).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("server/openclaw-state-era runtime floor", () => {
  it("only a well-formed version at or above the SQLite-era floor counts", () => {
    expect(kExecApprovalsSqliteMinVersion).toBe("2026.9.1-beta.1");
    expect(isSqliteEraRuntime("2026.10.4")).toBe(true);
    expect(isSqliteEraRuntime("2026.9.1-beta.1")).toBe(true);
    expect(isSqliteEraRuntime("2026.9.1")).toBe(true);
    expect(isSqliteEraRuntime("2026.8.1-beta.3")).toBe(false);
    expect(isSqliteEraRuntime("2026.7.1-2")).toBe(false);
    for (const unknown of [null, undefined, "", "a1b2c3d", "latest", "v2026.10.4"]) {
      expect(isSqliteEraRuntime(unknown)).toBe(false);
    }
  });
});

describe("server/openclaw-state-era exec-approvals backend decision", () => {
  const eraFor = (openclawDir, version, extra = {}) =>
    createStateEra({ openclawDir, getInstalledVersion: () => version, ...extra });

  it("row + SQLite-era runtime: sqlite backend, reap allowed", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    expect(await eraFor(openclawDir, "2026.10.4").resolveExecApprovalsBackend()).toEqual({
      backend: "sqlite",
      signal: "row",
      rowPresent: true,
      runtimeSqliteEra: true,
      reapAllowed: true,
    });
  });

  it("row + UNKNOWN runtime (dev sha, unreadable version): reap NOT allowed — the row is historical state", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    for (const version of [null, "a1b2c3d"]) {
      expect(await eraFor(openclawDir, version).resolveExecApprovalsBackend()).toMatchObject({
        backend: "sqlite",
        rowPresent: true,
        runtimeSqliteEra: false,
        reapAllowed: false,
      });
    }
    const throwing = createStateEra({
      openclawDir,
      getInstalledVersion: () => {
        throw new Error("unreadable");
      },
      logger: quietLogger(),
    });
    expect(await throwing.resolveExecApprovalsBackend()).toMatchObject({ reapAllowed: false });
  });

  it("row + OLDER runtime (restored backup / forced downgrade): reap NOT allowed", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    expect(await eraFor(openclawDir, "2026.7.1-2").resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      rowPresent: true,
      runtimeSqliteEra: false,
      reapAllowed: false,
    });
  });

  it("no row (fresh install, or a legacy file awaiting doctor import): sqlite backend, no reap", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: false });
    expect(await eraFor(openclawDir, "2026.10.4").resolveExecApprovalsBackend()).toEqual({
      backend: "sqlite",
      signal: "pin",
      rowPresent: false,
      runtimeSqliteEra: true,
      reapAllowed: false,
    });
    expect(await eraFor(createTempOpenclawDir(), null).resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      reapAllowed: false,
    });
  });
});

// ── PR-2 surfaces: shared auth flag + pairing store ──────────────────────────

const withStateDb = (openclawDir, setup) => {
  const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    setup(db);
  } finally {
    db.close();
  }
  return databasePath;
};

const createPairingTables = (db) => {
  db.exec(
    "CREATE TABLE channel_pairing_requests (channel_key TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', last_seen_at TEXT NOT NULL DEFAULT '', meta_json TEXT, PRIMARY KEY (channel_key, account_id, request_id))",
  );
  db.exec(
    "CREATE TABLE channel_pairing_allow_entries (channel_key TEXT NOT NULL, account_id TEXT NOT NULL, entry TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_key, account_id, entry))",
  );
};

describe("server/openclaw-state-era auth.sharedStore flag", () => {
  it("reads state-db when the migration flipped the machine state", () => {
    const openclawDir = createTempOpenclawDir();
    withStateDb(openclawDir, (db) => {
      db.exec(
        "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0)",
      );
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json) VALUES ('auth.sharedStore', ?)",
      ).run(JSON.stringify({ location: "state-db" }));
    });
    expect(readAuthSharedStoreLocation({ openclawDir })).toBe("state-db");
  });

  it("is legacy when the db, table, or flag row is missing (incl. the pinned v1 schema)", () => {
    const noDb = createTempOpenclawDir();
    expect(readAuthSharedStoreLocation({ openclawDir: noDb })).toBe("legacy");

    // Pinned-version state db: no config_machine_state table at all.
    const v1Schema = createTempOpenclawDir();
    withStateDb(v1Schema, (db) => {
      db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY)");
    });
    expect(readAuthSharedStoreLocation({ openclawDir: v1Schema })).toBe("legacy");

    // Beta schema pre-migration: table exists, flag row absent.
    const noRow = createTempOpenclawDir();
    withStateDb(noRow, (db) => {
      db.exec(
        "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL)",
      );
    });
    expect(readAuthSharedStoreLocation({ openclawDir: noRow })).toBe("legacy");
  });

  it("is unreadable — distinct from legacy — when the db cannot be opened", () => {
    const openclawDir = createTempOpenclawDir();
    const databasePath = path.join(openclawDir, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a database", "utf8");
    expect(
      readAuthSharedStoreLocation({ openclawDir, logger: quietLogger() }),
    ).toBe("unreadable");
  });
});

describe("server/openclaw-state-era pairing store", () => {
  it("reads allow entries grouped by normalized account id", () => {
    const openclawDir = createTempOpenclawDir();
    withStateDb(openclawDir, (db) => {
      createPairingTables(db);
      const insert = db.prepare(
        "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry) VALUES (?, ?, ?)",
      );
      insert.run("telegram", "default", "111");
      insert.run("telegram", "default", "222");
      insert.run("telegram", "Work", "333");
      insert.run("discord", "default", "999");
    });
    const map = readChannelAllowEntriesByAccount({ openclawDir, channel: "telegram" });
    expect(Array.from(map.get("default")).sort()).toEqual(["111", "222"]);
    expect(Array.from(map.get("work"))).toEqual(["333"]);
    expect(map.has("discord")).toBe(false);
  });

  it("returns an empty map when the db or tables are missing (file-era box)", () => {
    const noDb = createTempOpenclawDir();
    expect(readChannelAllowEntriesByAccount({ openclawDir: noDb, channel: "telegram" }).size).toBe(0);

    const noTables = createTempOpenclawDir();
    withStateDb(noTables, (db) => db.exec("CREATE TABLE cron_jobs (id TEXT PRIMARY KEY)"));
    expect(
      readChannelAllowEntriesByAccount({ openclawDir: noTables, channel: "telegram" }).size,
    ).toBe(0);
  });

  it("deletes a pending pairing request by code, case-insensitively and account-scoped", () => {
    const openclawDir = createTempOpenclawDir();
    const databasePath = withStateDb(openclawDir, (db) => {
      createPairingTables(db);
      const insert = db.prepare(
        "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code) VALUES (?, ?, ?, ?)",
      );
      insert.run("telegram", "default", "r1", "ABCD1234");
      insert.run("telegram", "work", "r2", "ABCD1234");
      insert.run("telegram", "default", "r3", "ZZZZ0000");
    });

    // Account-scoped delete removes only that account's request.
    expect(
      deletePairingRequestByCode({
        openclawDir,
        channel: "telegram",
        code: "abcd1234",
        accountId: "work",
      }),
    ).toEqual({ ok: true, deleted: 1 });

    // Unscoped delete removes the remaining match; unknown codes delete 0.
    expect(
      deletePairingRequestByCode({ openclawDir, channel: "telegram", code: "ABCD1234" }),
    ).toEqual({ ok: true, deleted: 1 });
    expect(
      deletePairingRequestByCode({ openclawDir, channel: "telegram", code: "NOPE" }),
    ).toEqual({ ok: true, deleted: 0 });

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT code FROM channel_pairing_requests").all();
      expect(rows.map((row) => row.code)).toEqual(["ZZZZ0000"]);
    } finally {
      db.close();
    }
  });

  it("delete is a no-op {ok:true, deleted:0} without a state db, and {ok:false} on an unreadable one", () => {
    const noDb = createTempOpenclawDir();
    expect(
      deletePairingRequestByCode({ openclawDir: noDb, channel: "telegram", code: "X" }),
    ).toEqual({ ok: true, deleted: 0 });

    const broken = createTempOpenclawDir();
    const databasePath = path.join(broken, kOpenclawStateDbPath);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a database", "utf8");
    const result = deletePairingRequestByCode({
      openclawDir: broken,
      channel: "telegram",
      code: "X",
      logger: quietLogger(),
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toBeTruthy();
  });

  it("clears an account's allow entries and requests (and a whole channel when unscoped)", () => {
    const openclawDir = createTempOpenclawDir();
    const databasePath = withStateDb(openclawDir, (db) => {
      createPairingTables(db);
      db.prepare(
        "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry) VALUES (?, ?, ?)",
      ).run("telegram", "work", "111");
      db.prepare(
        "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry) VALUES (?, ?, ?)",
      ).run("telegram", "default", "222");
      db.prepare(
        "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code) VALUES (?, ?, ?, ?)",
      ).run("telegram", "work", "r1", "AAAA1111");
    });

    expect(
      deleteChannelPairingRows({ openclawDir, channel: "telegram", accountId: "Work" }),
    ).toEqual({ ok: true, allowEntriesDeleted: 1, requestsDeleted: 1 });

    expect(deleteChannelPairingRows({ openclawDir, channel: "telegram" })).toEqual({
      ok: true,
      allowEntriesDeleted: 1,
      requestsDeleted: 0,
    });

    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM channel_pairing_allow_entries").get().n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM channel_pairing_requests").get().n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("server/openclaw-state-era read-only checks", () => {
  const { withReadonlyStateDb } = require("../../lib/server/openclaw-state-era");

  it("read-only checks ALWAYS arm busy_timeout = 2000", () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { row: true });
    const observed = withReadonlyStateDb(
      { openclawDir },
      "pragma-pin",
      (db) => db.prepare("PRAGMA busy_timeout").get().timeout,
      null,
    );
    expect(observed).toBe(2000);
  });
});
