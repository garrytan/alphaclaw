// OpenClaw schema-version oracles (#76/#78): PRAGMA user_version against real
// node:sqlite files (corrupt, busy, missing), the never-executing dist scan
// for the declared OPENCLAW_{STATE,AGENT}_SCHEMA_VERSION constants (two
// passes, agreement rule, read budget), compareSchema, the seeded/learned
// schema table (declared > seeded; observed is evidence only), the launch
// compatibility gate (C1 belt / C2: declared / table / verb / all-null /
// corrupt / exec-approvals matrix) and the bootable-candidate chooser (B1.4:
// ordering, table pre-filter, prober confirmation, cap).
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
  kLaunchCompatReasons,
  assessLaunchCompatibility,
  kChooserMaxCandidates,
  lacksDatabasePreflightVerb,
  chooseBootableVersion,
} = require("../../lib/server/openclaw-schema-versions");
const { kBootVerdicts } = require("../../lib/server/boot-report");
const { kGatewayCrashCauses } = require("../../lib/server/gateway-crash-cause");

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

  it("uses public metadata without enumerating conflicting legacy chunks", async () => {
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ openclaw: { schemaVersions: { state: 15, agent: 19 } } }));
    writeDist(packageDir, { "openclaw-agent-db-contract-old.js": agentContract(99) });
    const readdirSync = vi.fn(() => { throw new Error("must not scan dist"); });
    const readdir = vi.fn(async () => { throw new Error("must not scan dist"); });
    const result = await resolve(packageDir, { fsModule: { ...fs, readdirSync, promises: { ...fs.promises, readdir } } });
    expect(result).toMatchObject({ state: 15, agent: 19, metadata: "valid", files: ["package.json"] });
    expect(readdirSync).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it.each([null, {}, { state: 15 }, { state: -1, agent: 19 }, { state: 15, agent: "19" }, { state: 1.5, agent: 19 }])(
    "keeps malformed metadata %j explicitly unknown instead of scanning a usable legacy declaration", async (schemaVersions) => {
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ openclaw: { schemaVersions } }));
      writeDist(packageDir, { "openclaw-agent-db-contract-old.js": agentContract(19) });
      expect(await resolve(packageDir)).toMatchObject({ state: null, agent: null, metadata: "invalid", unknownKinds: ["state", "agent"] });
    },
  );

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

  it("persists explicit unknown kinds over learned declarations and seeds across reopen", () => {
    const table = makeTable();
    table.recordDeclared("2026.9.2", { state: 16, agent: 20 });
    table.recordDeclared("2026.9.2", { state: 15, agent: null, unknownKinds: ["agent"] });
    expect(makeTable().supportedFor("2026.9.2")).toEqual({ state: 15, agent: null, source: "declared", unknownKinds: ["agent"] });
    table.recordDeclared("2026.9.2", { state: null, agent: null });
    expect(makeTable().supportedFor("2026.9.2").agent).toBeNull();
    table.recordDeclared("2026.9.2", { state: null, agent: null, unknownKinds: ["state", "agent"] });
    expect(makeTable().supportedFor("2026.9.2")).toMatchObject({ state: null, agent: null, unknownKinds: ["state", "agent"] });
  });

  it("keeps same-version dev declarations and observations under their full build identities", () => {
    const table = makeTable();
    const first = "a".repeat(40);
    const second = "a".repeat(39) + "b";
    table.recordDeclared("2026.9.2", { state: 12, agent: 17 }, { buildId: first });
    table.recordDeclared("2026.9.2", { state: 15, agent: 21 }, { buildId: second });
    table.recordObserved("2026.9.2", { state: 12, agent: 17 }, { buildId: first });
    const reopened = makeTable();
    expect(reopened.supportedFor("2026.9.2", { buildId: first })).toMatchObject({ state: 12, agent: 17 });
    expect(reopened.supportedFor("2026.9.2", { buildId: second })).toMatchObject({ state: 15, agent: 21 });
    expect(reopened.supportedFor("2026.9.2", { buildId: "c".repeat(40) })).toEqual({ state: null, agent: null, source: null });
    expect(reopened.supportedFor("2026.9.2")).toMatchObject({ state: 15, agent: 19, source: "seeded" });
    expect(reopened.read().byBuild[first].observed).toMatchObject({ agent: 17 });
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

// ── launch compatibility (C1 belt / C2) ────────────────────────────────────

const kStateDbPath = "/data/.openclaw/state/openclaw.sqlite";
const kAgentDbPath = (id) => `/data/.openclaw/agents/${id}/agent/openclaw-agent.sqlite`;
const stateEntry = () => ({ path: kStateDbPath, kind: "state" });
const agentEntry = (id = "main") => ({ path: kAgentDbPath(id), kind: "agent" });
const okRead = (userVersion) => ({ userVersion, status: "ok" });
// A reader seam keyed by path: `reads[path]` is the readSqliteUserVersion
// result that DB yields (a missing key reads as a missing file).
const readerFor = (reads) =>
  vi.fn((dbPath) => (Object.hasOwn(reads, dbPath) ? reads[dbPath] : { userVersion: null, status: "missing" }));

describe("openclaw-schema-versions: assessLaunchCompatibility", () => {
  const kReasons = kLaunchCompatReasons;

  it("pins the reason vocabulary to the boot verdicts and crash causes it shares words with", () => {
    expect(Object.isFrozen(kReasons)).toBe(true);
    expect(kReasons).toEqual({
      stateSchemaTooNew: "state_schema_too_new",
      agentSchemaTooNew: "agent_schema_too_new",
      stateDbUnreadable: "state_db_unreadable",
      stateDbPreflightBlocked: "state_db_preflight_blocked",
      legacyExecApprovalsPresent: "legacy_exec_approvals_present",
      stateDbBusy: "state_db_busy",
      stateDbIndeterminate: "state_db_indeterminate",
      supportedSchemaUnknown: "supported_schema_unknown",
    });
    // One word per defect across the gate, the boot report and the classifier.
    expect(kReasons.stateSchemaTooNew).toBe(kBootVerdicts.stateSchemaTooNew);
    expect(kReasons.agentSchemaTooNew).toBe(kBootVerdicts.agentSchemaTooNew);
    expect(kReasons.stateDbUnreadable).toBe(kBootVerdicts.stateDbUnreadable);
    expect(kReasons.legacyExecApprovalsPresent).toBe(kBootVerdicts.legacyExecApprovalsPresent);
    expect(kGatewayCrashCauses).toEqual(expect.arrayContaining([kReasons.stateSchemaTooNew, kReasons.agentSchemaTooNew]));
  });

  it("declared: every DB at or below the supported schema is compatible, without probing", async () => {
    const readUserVersion = readerFor({
      [kStateDbPath]: okRead(15),
      [kAgentDbPath("main")]: okRead(19),
      [kAgentDbPath("ops")]: okRead(17),
    });
    const probeState = vi.fn();
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry("main"), agentEntry("ops")],
      supported: { state: 15, agent: 19 },
      readUserVersion,
      probeState,
    });
    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.perDb).toEqual([
      { path: kStateDbPath, kind: "state", userVersion: 15, status: "ok", verdict: "exact", supported: 15 },
      { path: kAgentDbPath("main"), kind: "agent", userVersion: 19, status: "ok", verdict: "exact", supported: 19 },
      { path: kAgentDbPath("ops"), kind: "agent", userVersion: 17, status: "ok", verdict: "migration-required", supported: 19 },
    ]);
    expect(probeState).not.toHaveBeenCalled();
    // user_version is read fresh per DB (Eng 1A: never cached by the gate).
    expect(readUserVersion).toHaveBeenCalledTimes(3);
    expect(readUserVersion).toHaveBeenCalledWith(kStateDbPath);
  });

  it("declared: a state DB newer than the build supports is fail-closed (the #76 shape)", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: 1, agent: null },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(12), [kAgentDbPath("main")]: okRead(17) }),
      lacksVerb: true,
    });
    expect(result.compatible).toBe(false);
    // The blocking reason leads; the agent line's unknown is still reported.
    expect(result.reasons).toEqual([kReasons.stateSchemaTooNew, kReasons.supportedSchemaUnknown]);
    expect(result.perDb[0]).toMatchObject({ kind: "state", userVersion: 12, verdict: "incompatible", supported: 1 });
    expect(result.perDb[1]).toMatchObject({ kind: "agent", userVersion: 17, verdict: "unknown", supported: null });
  });

  it("declared: an agent DB newer than the build supports blocks on its own (#78's agent line)", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry("main"), agentEntry("ops")],
      supported: { state: 15, agent: 19 },
      readUserVersion: readerFor({
        [kStateDbPath]: okRead(15),
        [kAgentDbPath("main")]: okRead(21),
        [kAgentDbPath("ops")]: okRead(21),
      }),
    });
    expect(result.compatible).toBe(false);
    // Two agent DBs too new → one deduped reason.
    expect(result.reasons).toEqual([kReasons.agentSchemaTooNew]);
    expect(result.perDb.filter((row) => row.verdict === "incompatible")).toHaveLength(2);
  });

  it("table: the caller's table-resolved numbers are judged the same way as declared ones", async () => {
    const table = createSchemaVersionTable({ managedDir: mkTemp("alphaclaw-compat-table-"), logger: { warn: vi.fn() } });
    const supported = table.supportedFor("2026.9.1-beta.1");
    expect(supported).toEqual({ state: 12, agent: 17, source: "seeded" });
    const reads = { [kStateDbPath]: okRead(15), [kAgentDbPath("main")]: okRead(19) };
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported,
      readUserVersion: readerFor(reads),
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons).toEqual([kReasons.stateSchemaTooNew, kReasons.agentSchemaTooNew]);
    const fits = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: table.supportedFor("2026.9.2"),
      readUserVersion: readerFor(reads),
    });
    expect(fits).toMatchObject({ compatible: true, reasons: [] });
    fs.rmSync(path.dirname(table.filePath), { recursive: true, force: true });
  });

  it("verb: an unknown state schema is settled by the prober — pass is compatible", async () => {
    const probeState = vi.fn(async () => "pass");
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: null, agent: 19 },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15), [kAgentDbPath("main")]: okRead(19) }),
      lacksVerb: false,
      probeState,
    });
    expect(result.compatible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(probeState).toHaveBeenCalledTimes(1);
    expect(result.perDb[0]).toMatchObject({ kind: "state", verdict: "unknown", supported: null, probe: "pass" });
    // The agent row was judged by the numbers, not the probe.
    expect(result.perDb[1]).toMatchObject({ kind: "agent", verdict: "exact" });
    expect(result.perDb[1]).not.toHaveProperty("probe");
  });

  it("verb: a prober block is fail-closed with its own reason", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry()],
      supported: null,
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15) }),
      probeState: async () => "block",
    });
    expect(result).toMatchObject({ compatible: false, reasons: [kReasons.stateDbPreflightBlocked] });
    expect(result.perDb[0].probe).toBe("block");
  });

  it.each([["unsupported"], ["budget_exhausted"], [null], [undefined]])(
    "verb: a prober answer of %j proves nothing → indeterminate",
    async (answer) => {
      const result = await assessLaunchCompatibility({
        entries: [stateEntry()],
        supported: { state: null, agent: 19 },
        readUserVersion: readerFor({ [kStateDbPath]: okRead(15) }),
        probeState: async () => answer,
      });
      expect(result.compatible).toBeNull();
      expect(result.reasons).toEqual([kReasons.supportedSchemaUnknown]);
      expect(result.perDb[0].probe).toBe(answer ?? null);
    },
  );

  it("verb: a throwing prober reads as no answer, never as a throw out of the gate", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry()],
      supported: null,
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15) }),
      probeState: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(result).toMatchObject({ compatible: null, reasons: [kReasons.supportedSchemaUnknown] });
  });

  it("verb: a build without the verb is never probed (lacksVerb) and stays unknown", async () => {
    const probeState = vi.fn(async () => "pass");
    const result = await assessLaunchCompatibility({
      entries: [stateEntry()],
      supported: { state: null, agent: null },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(1) }),
      lacksVerb: true,
      probeState,
    });
    expect(result).toMatchObject({ compatible: null, reasons: [kReasons.supportedSchemaUnknown] });
    expect(probeState).not.toHaveBeenCalled();
    expect(result.perDb[0]).not.toHaveProperty("probe");
  });

  it("verb: the prober is not spent once the verdict is already false", async () => {
    const probeState = vi.fn(async () => "pass");
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: null, agent: 19 },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15), [kAgentDbPath("main")]: okRead(21) }),
      probeState,
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons).toEqual([kReasons.agentSchemaTooNew, kReasons.supportedSchemaUnknown]);
    expect(probeState).not.toHaveBeenCalled();
  });

  it("all-null: no oracle and no prober → null with a loud, specific reason", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: null,
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15), [kAgentDbPath("main")]: okRead(19) }),
    });
    expect(result.compatible).toBeNull();
    expect(result.reasons).toEqual([kReasons.supportedSchemaUnknown]);
    expect(result.perDb.map((row) => row.verdict)).toEqual(["unknown", "unknown"]);
  });

  it("all-null: a resolved state line does not vouch for an unknown agent line", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: null, agent: null },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15), [kAgentDbPath("main")]: okRead(19) }),
      probeState: async () => "pass",
    });
    expect(result).toMatchObject({ compatible: null, reasons: [kReasons.supportedSchemaUnknown] });
  });

  it("corrupt: a corrupt DB is fail-closed as state_db_unreadable even when the other DB is fine", async () => {
    const probeState = vi.fn(async () => "pass");
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: null, agent: 19 },
      readUserVersion: readerFor({
        [kStateDbPath]: { userVersion: null, status: "corrupt", error: { code: "SQLITE_NOTADB", errcode: 26, message: "file is not a database" } },
        [kAgentDbPath("main")]: okRead(19),
      }),
      probeState,
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons).toEqual([kReasons.stateDbUnreadable]);
    expect(result.perDb[0]).toEqual({
      path: kStateDbPath,
      kind: "state",
      userVersion: null,
      status: "corrupt",
      verdict: "unknown",
      supported: null,
    });
    expect(probeState).not.toHaveBeenCalled();
  });

  it("corrupt: an agent DB that is not a database is the same fail-closed word", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: 15, agent: 19 },
      readUserVersion: readerFor({
        [kStateDbPath]: okRead(15),
        [kAgentDbPath("main")]: { userVersion: null, status: "corrupt", error: { code: "SQLITE_CORRUPT" } },
      }),
    });
    expect(result).toMatchObject({ compatible: false, reasons: [kReasons.stateDbUnreadable] });
    expect(result.perDb[1]).toMatchObject({ kind: "agent", status: "corrupt" });
  });

  it("busy: a locked DB is indeterminate, not a refusal", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: 15, agent: 19 },
      readUserVersion: readerFor({
        [kStateDbPath]: { userVersion: null, status: "busy", error: { code: "SQLITE_BUSY" } },
        [kAgentDbPath("main")]: okRead(19),
      }),
    });
    expect(result).toMatchObject({ compatible: null, reasons: [kReasons.stateDbBusy] });
    expect(result.perDb[0]).toMatchObject({ status: "busy", userVersion: null, verdict: "unknown" });
  });

  it("error: any other unreadable status (EACCES, a throwing reader, garbage) is indeterminate", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry("a"), agentEntry("b")],
      supported: { state: 15, agent: 19 },
      readUserVersion: vi.fn((dbPath) => {
        if (dbPath === kStateDbPath) return { userVersion: null, status: "error", error: { code: "EACCES" } };
        if (dbPath === kAgentDbPath("a")) throw new Error("reader exploded");
        return { userVersion: "nineteen", status: "ok" };
      }),
    });
    expect(result).toMatchObject({ compatible: null, reasons: [kReasons.stateDbIndeterminate] });
    expect(result.perDb.map((row) => row.status)).toEqual(["error", "error", "error"]);
    expect(result.perDb[1].userVersion).toBeNull();
  });

  it("missing: a DB that vanished is skipped silently (row kept, no reason)", async () => {
    const result = await assessLaunchCompatibility({
      entries: [stateEntry(), agentEntry()],
      supported: { state: 15, agent: 19 },
      readUserVersion: readerFor({ [kAgentDbPath("main")]: okRead(19) }),
    });
    expect(result).toMatchObject({ compatible: true, reasons: [] });
    expect(result.perDb[0]).toMatchObject({ kind: "state", status: "missing", userVersion: null, verdict: "unknown" });
  });

  it("fresh box: no databases at all is trivially compatible", async () => {
    const readUserVersion = vi.fn();
    await expect(assessLaunchCompatibility({ entries: [], supported: null, readUserVersion })).resolves.toEqual({
      compatible: true,
      reasons: [],
      perDb: [],
    });
    await expect(assessLaunchCompatibility()).resolves.toEqual({ compatible: true, reasons: [], perDb: [] });
    expect(readUserVersion).not.toHaveBeenCalled();
  });

  it("exec-approvals: a legacy exec-approvals.json is fail-closed on its own, ahead of the DB reasons", async () => {
    const clean = await assessLaunchCompatibility({
      entries: [stateEntry()],
      supported: { state: 15, agent: 19 },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(15) }),
      legacyExecApprovalsPresent: true,
    });
    expect(clean).toMatchObject({ compatible: false, reasons: [kReasons.legacyExecApprovalsPresent] });
    const combined = await assessLaunchCompatibility({
      entries: [stateEntry()],
      supported: { state: 1, agent: null },
      readUserVersion: readerFor({ [kStateDbPath]: okRead(12) }),
      legacyExecApprovalsPresent: true,
    });
    expect(combined.compatible).toBe(false);
    expect(combined.reasons).toEqual([kReasons.legacyExecApprovalsPresent, kReasons.stateSchemaTooNew]);
    // Only the literal boolean counts — a truthy string from a sloppy caller does not refuse.
    const sloppy = await assessLaunchCompatibility({
      entries: [],
      legacyExecApprovalsPresent: "yes",
    });
    expect(sloppy.compatible).toBe(true);
  });

  it("ignores malformed entries instead of reading them", async () => {
    const readUserVersion = readerFor({ [kStateDbPath]: okRead(15) });
    const result = await assessLaunchCompatibility({
      entries: [null, { kind: "state" }, { path: "", kind: "state" }, { path: "/x", kind: "workspace" }, stateEntry()],
      supported: { state: 15, agent: 19 },
      readUserVersion,
    });
    expect(result.compatible).toBe(true);
    expect(result.perDb).toHaveLength(1);
    expect(readUserVersion).toHaveBeenCalledTimes(1);
  });

  it("reads real databases through the default readSqliteUserVersion seam", async () => {
    const tempDir = mkTemp("alphaclaw-compat-real-");
    try {
      const stateDb = path.join(tempDir, "state", "openclaw.sqlite");
      const agentDb = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const corruptDb = path.join(tempDir, "agents", "ops", "agent", "openclaw-agent.sqlite");
      writeDb(stateDb, { userVersion: 15 });
      writeDb(agentDb, { userVersion: 19 });
      const fits = await assessLaunchCompatibility({
        entries: [
          { path: stateDb, kind: "state" },
          { path: agentDb, kind: "agent" },
        ],
        supported: { state: 15, agent: 19 },
      });
      expect(fits).toMatchObject({ compatible: true, reasons: [] });
      expect(fits.perDb.map((row) => row.userVersion)).toEqual([15, 19]);
      fs.mkdirSync(path.dirname(corruptDb), { recursive: true });
      fs.writeFileSync(corruptDb, Buffer.from("not a sqlite database; ".repeat(40)));
      const broken = await assessLaunchCompatibility({
        entries: [
          { path: stateDb, kind: "state" },
          { path: corruptDb, kind: "agent" },
        ],
        supported: { state: 15, agent: 19 },
      });
      expect(broken).toMatchObject({ compatible: false, reasons: [kReasons.stateDbUnreadable] });
      expect(broken.perDb[1]).toMatchObject({ path: corruptDb, status: "corrupt" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── bootable-candidate chooser (B1.4) ──────────────────────────────────────

describe("openclaw-schema-versions: lacksDatabasePreflightVerb", () => {
  it.each([
    ["2026.7.1-2", true],
    ["2026.7.1", true],
    ["2026.8.0", false],
    ["2026.8.2", false],
    ["2026.9.1-beta.1", false],
    ["2026.9.2", false],
    ["", false],
    [null, false],
  ])("lacksDatabasePreflightVerb(%j) → %s", (version, expected) => {
    expect(lacksDatabasePreflightVerb(version)).toBe(expected);
  });
});

describe("openclaw-schema-versions: chooseBootableVersion", () => {
  // A table seam over a { version: { state, agent } } map; a version outside
  // the map is unknown (source null), like supportedFor on a real table.
  const tableOf = (byVersion) => ({
    supportedFor: vi.fn((version) =>
      Object.hasOwn(byVersion, version)
        ? { ...byVersion[version], source: "seeded" }
        : { state: null, agent: null, source: null },
    ),
  });
  const kRealTable = createSchemaVersionTable({ managedDir: mkTemp("alphaclaw-chooser-table-"), logger: { warn: vi.fn() } });
  afterAll(() => {
    fs.rmSync(path.dirname(kRealTable.filePath), { recursive: true, force: true });
  });

  it("exposes the cap the plan fixed (three newest overlays / three probes)", () => {
    expect(kChooserMaxCandidates).toBe(3);
  });

  it("ordering: expected first when the table permits it (unconfirmed without a prober)", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        lastKnownGood: "2026.9.1",
        overlays: ["2026.8.2", "2026.9.1", "2026.9.2"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "expected", confirmed: false });
  });

  it("ordering: lastKnownGood when expected cannot read the DB", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.9.1-beta.1",
        lastKnownGood: "2026.9.1",
        overlays: ["2026.9.2", "2026.9.1", "2026.9.1-beta.1"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.1", source: "lastKnownGood", confirmed: false });
  });

  it("ordering: then the NEWEST permitted overlay, whatever order the store listed them in", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.9.1-beta.1",
        lastKnownGood: "2026.7.1-2",
        overlays: ["2026.8.2", "2026.9.2", "2026.9.1"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "overlay", confirmed: false });
  });

  it("ordering: a prerelease sorts below its base release", async () => {
    // beta.1 supports {12,17}; the DB is at {12,17}: both 2026.9.1 and beta.1
    // are permitted, and 2026.9.1 is the newer of the two.
    await expect(
      chooseBootableVersion({
        overlays: ["2026.9.1-beta.1", "2026.9.1"],
        userVersions: { state: 12, agent: 17 },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.1", source: "overlay", confirmed: false });
    await expect(
      chooseBootableVersion({
        overlays: ["2026.9.1-beta.1"],
        userVersions: { state: 12, agent: 17 },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.1-beta.1", source: "overlay", confirmed: false });
  });

  it("ordering: an expected build that is also an overlay keeps the source expected and is probed once", async () => {
    const confirm = vi.fn(async () => "pass");
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        overlays: ["2026.9.2", "2026.9.1"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "expected", confirmed: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("2026.9.2");
  });

  it("pre-filter: a candidate whose supported schema is below the DB's is never shortlisted", async () => {
    const confirm = vi.fn(async () => "pass");
    // state 15 > beta.1's 12; agent 19 > beta.1's 17; 2026.7.1-2 supports state 1.
    await expect(
      chooseBootableVersion({
        expected: "2026.9.1-beta.1",
        lastKnownGood: "2026.7.1-2",
        overlays: ["2026.9.1-beta.1", "2026.7.1-2"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm,
      }),
    ).resolves.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("pre-filter: a kind with a known user_version needs a KNOWN supported number (no guessing)", async () => {
    const table = tableOf({ "2026.10.0": { state: 16, agent: null }, "2026.9.2": { state: 15, agent: 19 } });
    // 2026.10.0 would be newest, but its agent line is unknown while the box
    // has agent DBs → skipped in favour of a fully known candidate.
    await expect(
      chooseBootableVersion({
        overlays: ["2026.10.0", "2026.9.2"],
        userVersions: { state: 15, agent: 19 },
        table,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "overlay", confirmed: false });
    // A version the table has never heard of is not a candidate either.
    await expect(
      chooseBootableVersion({ expected: "2026.11.0", userVersions: { state: 15, agent: 19 }, table }),
    ).resolves.toBeNull();
  });

  it("pre-filter: a kind with no DB on the box is not compared (a 2026.7 box has no agent DBs)", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.7.1-2",
        userVersions: { state: 1, agent: null },
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.7.1-2", source: "expected", confirmed: false });
  });

  it("pre-filter: migration-required is permitted (the candidate upgrades the DB), too-new is not", async () => {
    const table = tableOf({ "2026.9.2": { state: 15, agent: 19 } });
    await expect(
      chooseBootableVersion({ expected: "2026.9.2", userVersions: { state: 12, agent: 17 }, table }),
    ).resolves.toMatchObject({ version: "2026.9.2" });
    await expect(
      chooseBootableVersion({ expected: "2026.9.2", userVersions: { state: 16, agent: 19 }, table }),
    ).resolves.toBeNull();
  });

  it("pre-filter: the current candidate declaration is checked even when the table knows its version", async () => {
    const table = tableOf({ "2026.9.2": { state: 15, agent: 19 } });
    const resolveSupported = vi.fn(async (version) => (version === "2026.10.0" ? { state: 16, agent: 20 } : null));
    await expect(
      chooseBootableVersion({
        expected: "2026.10.0",
        overlays: ["2026.9.2", "2026.10.0", "2026.10.1"],
        userVersions: { state: 16, agent: 20 },
        table,
        resolveSupported,
      }),
    ).resolves.toEqual({ version: "2026.10.0", source: "expected", confirmed: false });
    expect(resolveSupported).toHaveBeenCalledTimes(1);
    expect(resolveSupported).toHaveBeenCalledWith("2026.10.0");
    expect(table.supportedFor).toHaveBeenCalledWith("2026.10.0");
    // A local public declaration can contradict a remembered version entry.
    resolveSupported.mockClear();
    await chooseBootableVersion({
      expected: "2026.7.1-2",
      userVersions: { state: 1, agent: null },
      table: kRealTable,
      resolveSupported,
    });
    expect(resolveSupported).toHaveBeenCalledWith("2026.7.1-2");
    // A throwing scan reads as unknown.
    await expect(
      chooseBootableVersion({
        expected: "2026.10.1",
        userVersions: { state: 16, agent: 20 },
        table,
        resolveSupported: async () => {
          throw new Error("dist unreadable");
        },
      }),
    ).resolves.toBeNull();
  });

  it("pre-filter: explicit unknown from a local declaration cannot resurrect a usable seeded candidate", async () => {
    const confirm = vi.fn(async () => "pass");
    expect(await chooseBootableVersion({
      expected: "2026.9.2",
      table: kRealTable,
      userVersions: { state: 15, agent: 19 },
      resolveSupported: async () => ({ state: 15, agent: null, unknownKinds: ["agent"] }),
      confirm,
    })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirm: pass chooses the candidate as confirmed; block skips to the next permitted one", async () => {
    const confirm = vi.fn(async (version) => (version === "2026.9.2" ? "block" : "pass"));
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        lastKnownGood: "2026.9.1",
        overlays: ["2026.8.2"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm,
      }),
    ).resolves.toEqual({ version: "2026.9.1", source: "lastKnownGood", confirmed: true });
    expect(confirm.mock.calls.map(([version]) => version)).toEqual(["2026.9.2", "2026.9.1"]);
  });

  it("confirm: every permitted candidate blocked → null, and the table-rejected ones were never probed", async () => {
    const confirm = vi.fn(async () => "block");
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        overlays: ["2026.9.1", "2026.9.1-beta.1"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm,
      }),
    ).resolves.toBeNull();
    expect(confirm.mock.calls.map(([version]) => version)).toEqual(["2026.9.2", "2026.9.1"]);
  });

  it.each([["unsupported"], ["budget_exhausted"], [null]])(
    "confirm: %j on a build that has the verb proves nothing → skipped",
    async (answer) => {
      const confirm = vi.fn(async (version) => (version === "2026.9.2" ? answer : "pass"));
      await expect(
        chooseBootableVersion({
          expected: "2026.9.2",
          lastKnownGood: "2026.9.1",
          userVersions: { state: 15, agent: 19 },
          table: kRealTable,
          confirm,
        }),
      ).resolves.toEqual({ version: "2026.9.1", source: "lastKnownGood", confirmed: true });
    },
  );

  it("confirm: a pre-2026.8 candidate the verb cannot judge rests on the seeded table (unconfirmed)", async () => {
    const confirm = vi.fn(async () => "unsupported");
    await expect(
      chooseBootableVersion({
        expected: "2026.7.1-2",
        userVersions: { state: 1, agent: null },
        table: kRealTable,
        confirm,
      }),
    ).resolves.toEqual({ version: "2026.7.1-2", source: "expected", confirmed: false });
    // ...but a block from the prober (the config-shape guard) still skips it.
    await expect(
      chooseBootableVersion({
        expected: "2026.7.1-2",
        userVersions: { state: 1, agent: null },
        table: kRealTable,
        confirm: async () => "block",
      }),
    ).resolves.toBeNull();
    // The verb rule is injectable for callers that already know the answer.
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm,
        lacksVerb: () => true,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "expected", confirmed: false });
  });

  it("confirm: a throwing prober reads as no answer", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        lastKnownGood: "2026.9.1",
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        confirm: async (version) => {
          if (version === "2026.9.2") throw new Error("spawn failed");
          return "pass";
        },
      }),
    ).resolves.toEqual({ version: "2026.9.1", source: "lastKnownGood", confirmed: true });
  });

  it("cap: at most maxCandidates shortlisted candidates are probed, newest overlays first", async () => {
    const table = tableOf({
      "2026.12.0": { state: 15, agent: 19 },
      "2026.11.0": { state: 15, agent: 19 },
      "2026.10.0": { state: 15, agent: 19 },
      "2026.9.2": { state: 15, agent: 19 },
      "2026.9.1": { state: 15, agent: 19 },
    });
    const confirm = vi.fn(async () => "block");
    await expect(
      chooseBootableVersion({
        overlays: ["2026.9.1", "2026.10.0", "2026.12.0", "2026.9.2", "2026.11.0"],
        userVersions: { state: 15, agent: 19 },
        table,
        confirm,
      }),
    ).resolves.toBeNull();
    expect(confirm.mock.calls.map(([version]) => version)).toEqual(["2026.12.0", "2026.11.0", "2026.10.0"]);
    // Only the newest maxCandidates overlays are candidates at all, even
    // without a prober: an older compatible overlay outside the window is
    // not found (the plan's bound; the caller's pause + notice is the exit).
    const narrow = tableOf({ "2026.9.1": { state: 15, agent: 19 } });
    await expect(
      chooseBootableVersion({
        overlays: ["2026.9.1", "2026.10.0", "2026.12.0", "2026.9.2", "2026.11.0"],
        userVersions: { state: 15, agent: 19 },
        table: narrow,
      }),
    ).resolves.toBeNull();
    expect(narrow.supportedFor.mock.calls.map(([version]) => version)).toEqual(["2026.12.0", "2026.11.0", "2026.10.0"]);
  });

  it("cap: maxCandidates is overridable and bounds expected/lastKnownGood probes too", async () => {
    const confirm = vi.fn(async () => "block");
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        lastKnownGood: "2026.9.1",
        overlays: ["2026.8.2"],
        userVersions: { state: 15, agent: 19 },
        table: kRealTable,
        maxCandidates: 1,
        confirm,
      }),
    ).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("2026.9.2");
    // A nonsense cap falls back to the default rather than probing nothing or everything.
    confirm.mockClear();
    await chooseBootableVersion({
      expected: "2026.9.2",
      lastKnownGood: "2026.9.1",
      overlays: ["2026.8.2", "2026.7.1-2"],
      userVersions: { state: 15, agent: 19 },
      table: kRealTable,
      maxCandidates: 0,
      confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("null: nothing supplied, nothing permitted, or junk versions → null without touching the table", async () => {
    const table = tableOf({});
    await expect(chooseBootableVersion()).resolves.toBeNull();
    await expect(chooseBootableVersion({ userVersions: { state: 15, agent: 19 }, table })).resolves.toBeNull();
    await expect(
      chooseBootableVersion({ expected: 2026, lastKnownGood: "", overlays: [null, "  ", 7], userVersions: { state: 15, agent: 19 }, table }),
    ).resolves.toBeNull();
    expect(table.supportedFor).not.toHaveBeenCalled();
    // No table at all is "unknown" for every candidate, never a throw.
    await expect(chooseBootableVersion({ expected: "2026.9.2", userVersions: { state: 15, agent: 19 } })).resolves.toBeNull();
    // A table that throws is unknown too.
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        userVersions: { state: 15, agent: 19 },
        table: {
          supportedFor: () => {
            throw new Error("table exploded");
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("unknown DB: with no user_version known the table cannot exclude, so expected is taken first", async () => {
    await expect(
      chooseBootableVersion({
        expected: "2026.9.2",
        overlays: ["2026.9.1"],
        userVersions: null,
        table: kRealTable,
      }),
    ).resolves.toEqual({ version: "2026.9.2", source: "expected", confirmed: false });
  });
});
