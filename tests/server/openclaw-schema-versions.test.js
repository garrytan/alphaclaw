// OpenClaw schema-version oracles (#76/#78): PRAGMA user_version against real
// node:sqlite files (corrupt, busy, missing), the never-executing dist scan
// for the declared OPENCLAW_{STATE,AGENT}_SCHEMA_VERSION constants (two
// passes, agreement rule, read budget), compareSchema, and the seeded/learned
// schema table (declared > seeded; observed is evidence only).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kSchemaVersionsFileName,
  kSchemaContractFilePattern,
  kDeclaredScanFallbackMaxBytes,
  kDeclaredScanReadBudgetBytes,
  kSeededSchemaVersions,
  readSqliteUserVersion,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
  compareSchema,
  createSchemaVersionTable,
} = require("../../lib/server/openclaw-schema-versions");

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Same shape as openclaw-backup-offline-copy.test.js writeDb: a real WAL DB
// with one table and an explicit user_version.
const writeDb = (file, { rows = 3, userVersion = 7 } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t(x INTEGER)");
  for (let i = 0; i < rows; i += 1) db.exec(`INSERT INTO t VALUES (${i})`);
  if (userVersion !== null) db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
};

describe("openclaw-schema-versions: readSqliteUserVersion", () => {
  let tempDir = "";
  beforeEach(() => {
    tempDir = mkTemp("alphaclaw-schema-uv-");
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads PRAGMA user_version from a real database with the default read-only open", () => {
    const file = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    writeDb(file, { userVersion: 17 });
    expect(readSqliteUserVersion(file)).toEqual({ userVersion: 17, status: "ok" });
  });

  it("reports 0 as the integer 0 — null is reserved for indeterminate", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file, { userVersion: null });
    const result = readSqliteUserVersion(file);
    expect(result).toEqual({ userVersion: 0, status: "ok" });
    expect(result.userVersion).not.toBeNull();
  });

  it("classifies a missing file as missing without opening anything", () => {
    const open = vi.fn();
    const result = readSqliteUserVersion(path.join(tempDir, "state", "openclaw.sqlite"), { open });
    expect(result).toEqual({ userVersion: null, status: "missing" });
    expect(open).not.toHaveBeenCalled();
  });

  it("classifies garbage bytes as corrupt (SQLITE_NOTADB) and names the code", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from("not a sqlite database; ".repeat(40)));
    const result = readSqliteUserVersion(file);
    expect(result.userVersion).toBeNull();
    expect(result.status).toBe("corrupt");
    expect(result.error.code).toBe("SQLITE_NOTADB");
    expect(result.error.errcode & 0xff).toBe(26);
    expect(result.error.message).toMatch(/not a database/i);
  });

  it("classifies a database held under an exclusive write lock as busy", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new DatabaseSync(file);
    writer.exec("CREATE TABLE t(x); PRAGMA user_version = 5; BEGIN EXCLUSIVE; INSERT INTO t VALUES (1);");
    try {
      // Injected open with a short busy_timeout keeps the test fast; the
      // default 2000 ms wait is the production posture.
      const open = (dbPath) => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        db.exec("PRAGMA busy_timeout = 25;");
        return db;
      };
      const result = readSqliteUserVersion(file, { open });
      expect(result.userVersion).toBeNull();
      expect(result.status).toBe("busy");
      expect(result.error.code).toBe("SQLITE_BUSY");
    } finally {
      writer.close();
    }
  });

  it("passes the path to the injected open and closes the handle even when the read throws", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file, { userVersion: 3 });
    const close = vi.fn();
    const failure = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
      errstr: "database disk image is malformed",
    });
    const open = vi.fn(() => ({
      prepare: () => ({
        get: () => {
          throw failure;
        },
      }),
      close,
    }));
    const result = readSqliteUserVersion(file, { open });
    expect(open).toHaveBeenCalledWith(file);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      userVersion: null,
      status: "corrupt",
      error: { code: "SQLITE_CORRUPT", errcode: 11, message: "database disk image is malformed" },
    });
  });

  it("closes a handle that read successfully", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file, { userVersion: 15 });
    const close = vi.fn();
    const open = () => ({ prepare: () => ({ get: () => ({ user_version: 15 }) }), close });
    expect(readSqliteUserVersion(file, { open })).toEqual({ userVersion: 15, status: "ok" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("maps an extended busy code (SQLITE_BUSY_SNAPSHOT 517) to busy", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file);
    const open = () => {
      throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 517 });
    };
    expect(readSqliteUserVersion(file, { open }).status).toBe("busy");
  });

  it("falls back to SQLite's wording when an injected open throws without errcode", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file);
    const corrupt = () => {
      throw new Error("file is not a database");
    };
    const locked = () => {
      throw new Error("database is locked");
    };
    const other = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    expect(readSqliteUserVersion(file, { open: corrupt }).status).toBe("corrupt");
    expect(readSqliteUserVersion(file, { open: locked }).status).toBe("busy");
    const result = readSqliteUserVersion(file, { open: other });
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("EACCES");
  });

  it("reports a non-integer user_version as an error, never as 0", () => {
    const file = path.join(tempDir, "state", "openclaw.sqlite");
    writeDb(file);
    const open = () => ({ prepare: () => ({ get: () => ({ user_version: "fifteen" }) }), close() {} });
    const result = readSqliteUserVersion(file, { open });
    expect(result.userVersion).toBeNull();
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("USER_VERSION_UNREADABLE");
  });
});

// Fake overlay package dirs shaped like upstream's dist output.
const writeDist = (packageDir, files) => {
  const distDir = path.join(packageDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, name), content);
  }
  return packageDir;
};

const stateContract = (version) =>
  `const OPENCLAW_STATE_SCHEMA_VERSION = ${version};\nexport { OPENCLAW_STATE_SCHEMA_VERSION as O };\n`;
const agentContract = (version) =>
  `const OPENCLAW_AGENT_SCHEMA_VERSION = ${version};\nexport { OPENCLAW_AGENT_SCHEMA_VERSION as O };\n`;

// Both forms share the two-pass logic; the shared cases run against each. The
// wrappers are async so `.resolves` reads uniformly — the sync form's own
// synchrony is pinned separately below.
const kResolvers = [
  ["sync", async (dir, options) => resolveDeclaredSchemaVersions(dir, options)],
  ["async", (dir, options) => resolveDeclaredSchemaVersionsAsync(dir, options)],
];

describe("openclaw-schema-versions: resolver forms", () => {
  it("the sync form returns a plain object (bin phase) and the async form a promise (server phase)", () => {
    const packageDir = mkTemp("alphaclaw-schema-forms-");
    try {
      writeDist(packageDir, { "openclaw-state-db-contract-A.js": stateContract(15) });
      const sync = resolveDeclaredSchemaVersions(packageDir);
      expect(sync).not.toBeInstanceOf(Promise);
      expect(sync).toMatchObject({ state: 15, source: "declared" });
      expect(resolveDeclaredSchemaVersionsAsync(packageDir)).toBeInstanceOf(Promise);
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  });
});

describe.each(kResolvers)("openclaw-schema-versions: resolveDeclaredSchemaVersions (%s)", (_label, resolve) => {
  let packageDir = "";
  beforeEach(() => {
    packageDir = mkTemp("alphaclaw-schema-dist-");
  });
  afterEach(() => {
    fs.rmSync(packageDir, { recursive: true, force: true });
  });

  it("reads one constant per contract chunk (the 2026.9.2 layout)", async () => {
    writeDist(packageDir, {
      "openclaw-agent-db-contract-CGTyjij4.js": agentContract(19),
      "openclaw-state-db-contract-DYCYxE4w.js": stateContract(15),
      "openclaw-CLI-abc123.js": "console.log('unrelated');",
    });
    await expect(resolve(packageDir)).resolves.toEqual({
      state: 15,
      agent: 19,
      files: ["openclaw-agent-db-contract-CGTyjij4.js", "openclaw-state-db-contract-DYCYxE4w.js"],
      source: "declared",
    });
  });

  it("accepts duplicate hashed copies that agree (the 2026.8.2 layout)", async () => {
    writeDist(packageDir, {
      "openclaw-agent-db-contract-AAAA.js": agentContract(19),
      "openclaw-agent-db-contract-BBBB.js": agentContract(19),
      "openclaw-state-db-contract-CCCC.js": stateContract(15),
      "openclaw-state-db-contract-DDDD.js": stateContract(15),
    });
    const result = await resolve(packageDir);
    expect(result.state).toBe(15);
    expect(result.agent).toBe(19);
    expect(result.files).toHaveLength(4);
  });

  it("returns null for a kind whose copies disagree, keeping the other kind", async () => {
    writeDist(packageDir, {
      "openclaw-agent-db-contract-AAAA.js": agentContract(19),
      "openclaw-agent-db-contract-BBBB.js": agentContract(21),
      "openclaw-state-db-contract-CCCC.js": stateContract(15),
    });
    const result = await resolve(packageDir);
    expect(result.agent).toBeNull();
    expect(result.state).toBe(15);
    // Both disagreeing files are named so the caller can log them.
    expect(result.files).toEqual(
      expect.arrayContaining(["openclaw-agent-db-contract-AAAA.js", "openclaw-agent-db-contract-BBBB.js"]),
    );
  });

  it("reads the migration-required chunk (the 2026.9.1-beta.1 layout)", async () => {
    writeDist(packageDir, {
      "openclaw-state-db-contract-Xyz.js": stateContract(12),
      "openclaw-agent-db-migration-required-Qrs.js": `${agentContract(17)}export function needsMigration(v){return v<OPENCLAW_AGENT_SCHEMA_VERSION}`,
    });
    const result = await resolve(packageDir);
    expect(result).toMatchObject({ state: 12, agent: 17 });
  });

  it("falls back to a small oddly-named chunk only for a kind pass 1 missed", async () => {
    writeDist(packageDir, {
      "openclaw-state-db-contract-Xyz.js": stateContract(15),
      // Not a contract name; found by pass 2 through the `database` hint.
      "chunk-database-helpers-9f8e.js": `export const x = 1;\n${agentContract(19)}`,
      // A small pass-2 candidate that DISAGREES on state must not override
      // pass 1's authoritative contract chunk.
      "legacy-schema-shim-0a1b.js": stateContract(12),
    });
    const result = await resolve(packageDir);
    expect(result.state).toBe(15);
    expect(result.agent).toBe(19);
    expect(result.files).toEqual(["chunk-database-helpers-9f8e.js", "openclaw-state-db-contract-Xyz.js"]);
  });

  it("ignores pass-2 candidates at or above the 64 KB threshold", async () => {
    const padding = "/".repeat(kDeclaredScanFallbackMaxBytes);
    writeDist(packageDir, {
      "big-db-bundle-1234.js": `${padding}\n${agentContract(19)}`,
      "tiny-db-bundle-5678.js": stateContract(15),
    });
    const result = await resolve(packageDir);
    expect(result.agent).toBeNull();
    expect(result.state).toBe(15);
  });

  it("ignores files whose names carry no db/schema/database hint in pass 2", async () => {
    writeDist(packageDir, {
      "openclaw-cli-main-1234.js": `${stateContract(15)}${agentContract(19)}`,
    });
    await expect(resolve(packageDir)).resolves.toEqual({
      state: null,
      agent: null,
      files: [],
      source: "declared",
    });
  });

  it("returns nulls for an empty dist and for a package without dist", async () => {
    writeDist(packageDir, {});
    await expect(resolve(packageDir)).resolves.toEqual({ state: null, agent: null, files: [], source: "declared" });
    await expect(resolve(path.join(packageDir, "nope"))).resolves.toEqual({
      state: null,
      agent: null,
      files: [],
      source: "declared",
    });
  });

  it("skips files that would exceed the read budget instead of truncating them", async () => {
    const small = stateContract(15);
    writeDist(packageDir, {
      "openclaw-state-db-contract-A.js": small,
      "openclaw-agent-db-contract-B.js": `${"/".repeat(200)}\n${agentContract(19)}`,
    });
    expect(kDeclaredScanReadBudgetBytes).toBe(16 * 1024 * 1024);
    const result = await resolve(packageDir, { readBudgetBytes: small.length + 10 });
    expect(result.state).toBe(15);
    expect(result.agent).toBeNull();
    expect(result.files).toEqual(["openclaw-state-db-contract-A.js"]);
  });

  it("never executes candidate code and ignores comparisons that are not declarations", async () => {
    writeDist(packageDir, {
      "openclaw-state-db-contract-A.js": `throw new Error("executed");\nprocess.exit(1);\n${stateContract(15)}`,
      "openclaw-agent-db-contract-B.js":
        "if (found === OPENCLAW_AGENT_SCHEMA_VERSION) {}\nif (found >= OPENCLAW_AGENT_SCHEMA_VERSION) {}\nOPENCLAW_AGENT_SCHEMA_VERSION == 21;\n",
    });
    const result = await resolve(packageDir);
    expect(result.state).toBe(15);
    expect(result.agent).toBeNull();
  });

  it("only considers regular files at the dist root", async () => {
    writeDist(packageDir, { "openclaw-state-db-contract-A.js": stateContract(15) });
    fs.mkdirSync(path.join(packageDir, "dist", "openclaw-agent-db-contract-dir.js"));
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"));
    fs.writeFileSync(path.join(packageDir, "dist", "extensions", "openclaw-agent-db-contract-Z.js"), agentContract(19));
    const result = await resolve(packageDir);
    expect(result).toMatchObject({ state: 15, agent: null });
  });

  it("exposes the pass-1 name pattern", () => {
    expect(kSchemaContractFilePattern.test("openclaw-agent-db-contract-CGTyjij4.js")).toBe(true);
    expect(kSchemaContractFilePattern.test("openclaw-state-db-contract-DYCYxE4w.js")).toBe(true);
    expect(kSchemaContractFilePattern.test("openclaw-agent-db-migration-required-Q.js")).toBe(true);
    expect(kSchemaContractFilePattern.test("openclaw-agent-db-contract-CGTyjij4.js.map")).toBe(false);
    expect(kSchemaContractFilePattern.test("chunk-database-helpers.js")).toBe(false);
  });
});

describe("openclaw-schema-versions: compareSchema", () => {
  it.each([
    [{ found: 15, target: 15 }, "exact"],
    [{ found: 0, target: 0 }, "exact"],
    [{ found: 17, target: 19 }, "migration-required"],
    [{ found: 0, target: 15 }, "migration-required"],
    [{ found: 21, target: 19 }, "incompatible"],
    [{ found: null, target: 19 }, "unknown"],
    [{ found: 17, target: null }, "unknown"],
    [{ found: undefined, target: undefined }, "unknown"],
    [{ found: "17", target: 19 }, "unknown"],
    [{ found: 1.5, target: 19 }, "unknown"],
    [{ found: -1, target: 19 }, "unknown"],
  ])("compareSchema(%j) → %s", (input, expected) => {
    expect(compareSchema(input)).toBe(expected);
  });

  it("tolerates a missing argument object", () => {
    expect(compareSchema()).toBe("unknown");
  });
});

describe("openclaw-schema-versions: schema table", () => {
  let managedDir = "";
  let logger;
  const nowFn = () => 1_757_000_000_000;
  beforeEach(() => {
    managedDir = path.join(mkTemp("alphaclaw-schema-table-"), ".alphaclaw");
    logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  });
  afterEach(() => {
    fs.rmSync(path.dirname(managedDir), { recursive: true, force: true });
  });

  const makeTable = (overrides = {}) => createSchemaVersionTable({ managedDir, nowFn, logger, ...overrides });
  const tablePath = () => path.join(managedDir, kSchemaVersionsFileName);
  const readFile = () => JSON.parse(fs.readFileSync(tablePath(), "utf8"));

  it("ships the verified seed table, frozen", () => {
    expect(kSeededSchemaVersions).toEqual({
      "2026.7.1-2": { state: 1, agent: null },
      "2026.8.2": { state: 15, agent: 19 },
      "2026.9.1-beta.1": { state: 12, agent: 17 },
      "2026.9.1": { state: 15, agent: 19 },
      "2026.9.2": { state: 15, agent: 19 },
    });
    expect(Object.isFrozen(kSeededSchemaVersions)).toBe(true);
    expect(Object.isFrozen(kSeededSchemaVersions["2026.9.2"])).toBe(true);
  });

  it("requires a managedDir (the store's, never recomputed here)", () => {
    expect(() => createSchemaVersionTable({ nowFn, logger })).toThrow(/managedDir/);
  });

  it("answers from the seeds when the file is missing, without a warning", () => {
    const table = makeTable();
    expect(table.filePath).toBe(tablePath());
    const view = table.read();
    expect(view.origin).toBe("missing");
    expect(view.byVersion["2026.9.2"]).toEqual({ state: 15, agent: 19, source: "seeded", at: null, observed: null });
    expect(table.supportedFor("2026.7.1-2")).toEqual({ state: 1, agent: null, source: "seeded" });
    expect(table.supportedFor("2026.9.1-beta.1")).toEqual({ state: 12, agent: 17, source: "seeded" });
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(table.supportedFor("2026.10.0")).toEqual({ state: null, agent: null, source: null });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(fs.existsSync(tablePath())).toBe(false);
  });

  it("falls back to the seeds on corrupt JSON with exactly one warning, never throwing", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(tablePath(), '{"byVersion": {"2026.9.2": {"state": 99');
    const table = makeTable();
    expect(() => table.read()).not.toThrow();
    expect(table.read().origin).toBe("unreadable");
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    table.read();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(tablePath());
    expect(logger.warn.mock.calls[0][0]).toContain("seeded");
  });

  it("treats a parseable file without byVersion as unreadable (seeds + one warning)", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(tablePath(), '{"versions": []}\n');
    const table = makeTable();
    expect(table.supportedFor("2026.8.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("recordDeclared overrides a seeded entry and persists atomically", () => {
    const table = makeTable();
    expect(table.recordDeclared("2026.9.2", { state: 16, agent: 20 })).toEqual({
      state: 16,
      agent: 20,
      source: "declared",
    });
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 16, agent: 20, source: "declared" });
    expect(readFile()).toEqual({
      byVersion: { "2026.9.2": { state: 16, agent: 20, source: "declared", at: nowFn() } },
    });
    // Seeds are never written; no temp file survives the rename.
    expect(fs.readdirSync(managedDir)).toEqual([kSchemaVersionsFileName]);
    // A fresh table instance reads the same answer back.
    expect(makeTable().supportedFor("2026.9.2")).toEqual({ state: 16, agent: 20, source: "declared" });
    expect(makeTable().read().byVersion["2026.9.2"]).toEqual({
      state: 16,
      agent: 20,
      source: "declared",
      at: nowFn(),
      observed: null,
    });
  });

  it("recordDeclared learns a version the seeds do not know", () => {
    const table = makeTable();
    table.recordDeclared("2026.10.0", { state: 16, agent: 19 });
    expect(table.supportedFor("2026.10.0")).toEqual({ state: 16, agent: 19, source: "declared" });
    expect(table.read().byVersion["2026.7.1-2"].source).toBe("seeded");
  });

  it("recordDeclared with nothing declared is a no-op that never shadows a seed", () => {
    const table = makeTable();
    expect(table.recordDeclared("2026.7.1-2", { state: null, agent: null })).toEqual({
      state: 1,
      agent: null,
      source: "seeded",
    });
    expect(fs.existsSync(tablePath())).toBe(false);
    expect(table.supportedFor("2026.7.1-2")).toEqual({ state: 1, agent: null, source: "seeded" });
  });

  it("recordDeclared merges per field over an earlier declaration of the same version", () => {
    const table = makeTable();
    table.recordDeclared("2026.10.0", { state: 16, agent: 19 });
    // A later, partial scan (budget skip) must not erase the agent constant.
    expect(table.recordDeclared("2026.10.0", { state: 16, agent: null })).toEqual({
      state: 16,
      agent: 19,
      source: "declared",
    });
  });

  it("recordObserved is evidence only and never becomes supported", () => {
    const table = makeTable();
    // Same numbers as the seed, then a HIGHER observed state: still seeded.
    expect(table.recordObserved("2026.9.2", { state: 16, agent: 19 })).toEqual({ state: 16, agent: 19, at: nowFn() });
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(table.read().byVersion["2026.9.2"]).toEqual({
      state: 15,
      agent: 19,
      source: "seeded",
      at: null,
      observed: { state: 16, agent: 19, at: nowFn() },
    });
    // An unknown version with only observed evidence supports nothing.
    table.recordObserved("2026.10.0", { state: 15, agent: 19 });
    expect(table.supportedFor("2026.10.0")).toEqual({ state: null, agent: null, source: null });
    expect(table.read().byVersion["2026.10.0"]).toEqual({
      state: null,
      agent: null,
      source: null,
      at: null,
      observed: { state: 15, agent: 19, at: nowFn() },
    });
    // The file carries just the evidence for that version.
    expect(readFile().byVersion["2026.10.0"]).toEqual({ observed: { state: 15, agent: 19, at: nowFn() } });
    expect(readFile().byVersion["2026.9.2"]).toEqual({ observed: { state: 16, agent: 19, at: nowFn() } });
  });

  it("recordObserved keeps a declared entry intact and recordDeclared keeps the evidence", () => {
    const table = makeTable();
    table.recordDeclared("2026.10.0", { state: 16, agent: 19 });
    table.recordObserved("2026.10.0", { state: 16, agent: 19 });
    expect(table.supportedFor("2026.10.0")).toEqual({ state: 16, agent: 19, source: "declared" });
    table.recordDeclared("2026.10.0", { state: 16, agent: 20 });
    expect(table.read().byVersion["2026.10.0"]).toEqual({
      state: 16,
      agent: 20,
      source: "declared",
      at: nowFn(),
      observed: { state: 16, agent: 19, at: nowFn() },
    });
  });

  it("recordObserved with no integers is a no-op", () => {
    const table = makeTable();
    expect(table.recordObserved("2026.9.2", { state: null, agent: undefined })).toBeNull();
    expect(fs.existsSync(tablePath())).toBe(false);
  });

  it("drops persisted entries whose source is not declared (seeded/crash/hand edits)", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      tablePath(),
      `${JSON.stringify({
        byVersion: {
          "2026.9.2": { state: 99, agent: 99, source: "seeded", at: 1 },
          "2026.9.1": { state: 98, agent: 98, source: "crash", at: 1 },
          "2026.8.2": { state: "15", agent: 19.5, source: "declared", at: 1 },
          __proto__: { state: 1, agent: 1, source: "declared", at: 1 },
        },
      })}\n`,
    );
    const table = makeTable();
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(table.supportedFor("2026.9.1")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(table.supportedFor("2026.8.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    expect(Object.keys(table.read().byVersion)).not.toContain("__proto__");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("rejects reserved and empty version keys", () => {
    const table = makeTable();
    expect(() => table.recordDeclared("__proto__", { state: 1, agent: 1 })).toThrow(TypeError);
    expect(() => table.recordObserved("constructor", { state: 1, agent: 1 })).toThrow(TypeError);
    expect(() => table.recordDeclared("", { state: 1, agent: 1 })).toThrow(TypeError);
    expect(() => table.recordDeclared(2026, { state: 1, agent: 1 })).toThrow(TypeError);
    expect(fs.existsSync(tablePath())).toBe(false);
  });

  it("a failed write logs one warning and never throws; the seed still answers", () => {
    const fsModule = {
      ...fs,
      writeFileSync: () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    };
    const table = makeTable({ fsModule });
    expect(() => table.recordDeclared("2026.9.2", { state: 16, agent: 20 })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not write .*openclaw-schema-versions\.json.*no space left/);
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
  });

  it("stamps `at` from the injected clock", () => {
    let now = 100;
    const table = makeTable({ nowFn: () => now });
    table.recordDeclared("2026.10.0", { state: 16, agent: 19 });
    now = 200;
    table.recordObserved("2026.10.0", { state: 16, agent: 19 });
    expect(readFile().byVersion["2026.10.0"]).toEqual({
      state: 16,
      agent: 19,
      source: "declared",
      at: 100,
      observed: { state: 16, agent: 19, at: 200 },
    });
  });
});
