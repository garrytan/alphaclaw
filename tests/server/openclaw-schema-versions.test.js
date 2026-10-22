// OpenClaw schema-version oracles (#76/#78): PRAGMA user_version against real
// node:sqlite files (corrupt, busy, missing), and the declared schema read
// from public package.json metadata only (absent = unknown, malformed =
// explicitly unknown, the dist is never scanned).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
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

// Legacy dist chunks that declared the schema as constants. The resolver must
// never read them: package.json metadata is the only authority.
const writeDist = (packageDir, files) => {
  const distDir = path.join(packageDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, name), content);
  }
  return packageDir;
};
const writePackageJson = (packageDir, pkg) =>
  fs.writeFileSync(path.join(packageDir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
const legacyChunks = {
  "openclaw-state-db-contract-A.mjs": "const OPENCLAW_STATE_SCHEMA_VERSION = 15;\n",
  "openclaw-agent-db-contract-B.mjs": "const OPENCLAW_AGENT_SCHEMA_VERSION = 19;\n",
};

// The shared cases run against both forms; the wrappers are async so
// `.resolves` reads uniformly — the sync form's own synchrony is pinned below.
const kResolvers = [
  ["sync", async (dir, options) => resolveDeclaredSchemaVersions(dir, options)],
  ["async", (dir, options) => resolveDeclaredSchemaVersionsAsync(dir, options)],
];

describe("openclaw-schema-versions: resolver forms", () => {
  it("the sync form returns a plain object (bin phase) and the async form a promise (server phase)", () => {
    const packageDir = mkTemp("alphaclaw-schema-forms-");
    try {
      writePackageJson(packageDir, { openclaw: { schemaVersions: { state: 20, agent: 24 } } });
      const sync = resolveDeclaredSchemaVersions(packageDir);
      expect(sync).not.toBeInstanceOf(Promise);
      expect(sync).toMatchObject({ state: 20, agent: 24, source: "declared" });
      expect(resolveDeclaredSchemaVersionsAsync(packageDir)).toBeInstanceOf(Promise);
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  });
});

describe.each(kResolvers)("openclaw-schema-versions: resolveDeclaredSchemaVersions (%s)", (_label, resolve) => {
  let packageDir = "";
  beforeEach(() => {
    packageDir = mkTemp("alphaclaw-schema-pkg-");
  });
  afterEach(() => {
    fs.rmSync(packageDir, { recursive: true, force: true });
  });
  const noDistReads = () => {
    const readdirSync = vi.fn(() => { throw new Error("must not scan dist"); });
    const readdir = vi.fn(async () => { throw new Error("must not scan dist"); });
    return { readdirSync, readdir, fsModule: { ...fs, readdirSync, promises: { ...fs.promises, readdir } } };
  };

  it("reads public metadata and never enumerates the dist", async () => {
    writePackageJson(packageDir, { openclaw: { schemaVersions: { state: 20, agent: 24 } } });
    writeDist(packageDir, { "openclaw-agent-db-contract-old.js": "const OPENCLAW_AGENT_SCHEMA_VERSION = 99;\n" });
    const { readdirSync, readdir, fsModule } = noDistReads();
    expect(await resolve(packageDir, { fsModule })).toMatchObject({
      state: 20, agent: 24, metadata: "valid", files: ["package.json"], source: "declared",
    });
    expect(readdirSync).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it("answers unknown for absent metadata even when legacy dist chunks declare constants", async () => {
    writePackageJson(packageDir, { name: "openclaw", version: "2026.8.2" });
    writeDist(packageDir, legacyChunks);
    const { readdirSync, readdir, fsModule } = noDistReads();
    await expect(resolve(packageDir, { fsModule })).resolves.toEqual({ state: null, agent: null, files: [], source: "declared" });
    expect(readdirSync).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it.each([null, {}, { state: 15 }, { state: -1, agent: 19 }, { state: 15, agent: "19" }, { state: 1.5, agent: 19 }])(
    "keeps malformed metadata %j explicitly unknown", async (schemaVersions) => {
      writePackageJson(packageDir, { openclaw: { schemaVersions } });
      writeDist(packageDir, legacyChunks);
      expect(await resolve(packageDir)).toMatchObject({ state: null, agent: null, metadata: "invalid", unknownKinds: ["state", "agent"] });
    },
  );

  it("keeps an unparseable package.json explicitly unknown", async () => {
    writePackageJson(packageDir, "{ not json");
    expect(await resolve(packageDir)).toMatchObject({ state: null, agent: null, metadata: "invalid" });
  });

  it("answers unknown for a missing package.json or package dir", async () => {
    await expect(resolve(packageDir)).resolves.toEqual({ state: null, agent: null, files: [], source: "declared" });
    await expect(resolve(path.join(packageDir, "nope"))).resolves.toEqual({ state: null, agent: null, files: [], source: "declared" });
  });
});
