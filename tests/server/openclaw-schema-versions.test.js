// OpenClaw schema-version oracles (#76/#78): PRAGMA user_version against real
// node:sqlite files (corrupt, busy, missing), the never-executing dist scan
// for the declared OPENCLAW_{STATE,AGENT}_SCHEMA_VERSION constants (two
// passes, agreement rule, read budget).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kSchemaContractFilePattern,
  kDeclaredScanFallbackMaxBytes,
  kDeclaredScanReadBudgetBytes,
  readSqliteUserVersion,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
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
