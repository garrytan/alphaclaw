const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  createStateEra,
  hasExecApprovalsRow,
  tableHasColumns,
  kSqliteEra,
  kFileEra,
  kIndeterminate,
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

describe("server/openclaw-state-era era hint", () => {
  it("a known version decides conclusively in BOTH directions (gate signal)", async () => {
    const openclawDir = createTempOpenclawDir();
    const probe = vi.fn();

    const sqliteEra = createStateEra({
      openclawDir,
      getCapability: probe,
      gatesInfo: () => ({ version: "2026.9.1-beta.1", features: { execApprovalsSqlite: true } }),
    });
    expect(await sqliteEra.resolveEraHint()).toEqual({ hint: kSqliteEra, signal: "gate" });

    const fileEra = createStateEra({
      openclawDir,
      getCapability: probe,
      gatesInfo: () => ({ version: "2026.7.1-2", features: { execApprovalsSqlite: false } }),
    });
    expect(await fileEra.resolveEraHint()).toEqual({ hint: kFileEra, signal: "gate" });

    // The probe is never consulted when the gate answers.
    expect(probe).not.toHaveBeenCalled();
  });

  it("falls to the CLI probe when no version is known (dev builds), and to indeterminate on probe failure", async () => {
    const openclawDir = createTempOpenclawDir();

    const probed = createStateEra({
      openclawDir,
      getCapability: async () => "sqlite",
      gatesInfo: () => ({ version: null, features: {} }),
    });
    expect(await probed.resolveEraHint()).toEqual({ hint: kSqliteEra, signal: "probe" });

    const fileProbed = createStateEra({
      openclawDir,
      getCapability: async () => "file",
      gatesInfo: () => null,
    });
    expect(await fileProbed.resolveEraHint()).toEqual({ hint: kFileEra, signal: "probe" });

    const broken = createStateEra({
      openclawDir,
      getCapability: async () => "unknown",
      gatesInfo: () => null,
      logger: quietLogger(),
    });
    expect(await broken.resolveEraHint()).toEqual({
      hint: kIndeterminate,
      signal: "indeterminate",
    });
  });

  it("memoizes the hint per boot and re-resolves after invalidate()", async () => {
    const openclawDir = createTempOpenclawDir();
    const probe = vi.fn(async () => "file");
    const era = createStateEra({
      openclawDir,
      getCapability: probe,
      gatesInfo: () => null,
    });
    await era.resolveEraHint();
    await era.resolveEraHint();
    expect(probe).toHaveBeenCalledTimes(1);
    era.invalidate();
    await era.resolveEraHint();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("server/openclaw-state-era exec-approvals backend decision", () => {
  const gates = (version, sqlite) => () => ({
    version,
    features: { execApprovalsSqlite: sqlite },
  });

  it("row + sqlite-era hint: sqlite backend, reap allowed", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    const era = createStateEra({
      openclawDir,
      gatesInfo: gates("2026.9.1-beta.1", true),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      signal: "row",
      reapAllowed: true,
    });
  });

  it("row + indeterminate hint: sqlite backend, reap NOT allowed (row is historical state)", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    const era = createStateEra({
      openclawDir,
      getCapability: async () => "unknown",
      gatesInfo: () => null,
      logger: quietLogger(),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      reapAllowed: false,
    });
  });

  it("row + FILE-era hint (restored backup / forced downgrade): reap NOT allowed", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: true });
    const era = createStateEra({
      openclawDir,
      gatesInfo: gates("2026.7.1-2", false),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      reapAllowed: false,
    });
  });

  it("no row + sqlite-era hint (fresh beta): sqlite backend, no reap — a legacy file awaits doctor import", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: false });
    const era = createStateEra({
      openclawDir,
      gatesInfo: gates("2026.9.1-beta.1", true),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "sqlite",
      signal: "gate",
      reapAllowed: false,
    });
  });

  it("no row + determinate file era (the pinned version): file backend", async () => {
    const openclawDir = createTempOpenclawDir();
    createStateDb(openclawDir, { table: true, row: false });
    const era = createStateEra({
      openclawDir,
      gatesInfo: gates("2026.7.1-2", false),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "file",
      signal: "gate",
      reapAllowed: false,
    });
  });

  it("no row + indeterminate: indeterminate backend (writers fail closed)", async () => {
    const openclawDir = createTempOpenclawDir();
    const era = createStateEra({
      openclawDir,
      getCapability: async () => "unknown",
      gatesInfo: () => null,
      logger: quietLogger(),
    });
    expect(await era.resolveExecApprovalsBackend()).toMatchObject({
      backend: "indeterminate",
      reapAllowed: false,
    });
  });
});
