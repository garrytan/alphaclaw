const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
import { describe, it, expect, beforeEach, afterEach } from "vitest";
const { buildRecoveryInventory, inspectRecoveryDatabases, kRecoveryLimits } = require("../../lib/server/openclaw-recovery-plan");

describe("bounded config-first recovery planner", () => {
  let root;
  let handles;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-plan-")); handles = []; });
  afterEach(() => { for (const db of handles) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  const database = (file, version, role = "global", agentId = null) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const db = new DatabaseSync(path.join(root, file));
    handles.push(db);
    db.exec(`PRAGMA user_version = ${version}; CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)`);
    db.prepare("INSERT INTO schema_meta VALUES ('primary', ?, ?, ?)").run(role, version, agentId);
    return db;
  };
  const inventory = (options = {}) => buildRecoveryInventory({ stateDir: root, spawnEnv: {}, ...options });
  const inspect = async (supported = { state: 17, agent: 21 }, options = {}) => inspectRecoveryDatabases({ inventory: await inventory(), supported, ...options });

  it("reads only allowlisted files and shallow owned directories", async () => {
    write("openclaw.json", { agents: { entries: { main: {} } } });
    write("identity/device.json", "identity");
    write("identity/device-auth.json", "legacy");
    write("agents/main/agent/auth-profiles.json", "auth");
    write("agents/main/agent/auth-state.json", "state");
    write("agents/main/agent/auth.json", "old");
    write("workspace/nested/openclaw.sqlite", "not SQLite");
    write("credentials/nested/auth.json", "do not walk");
    write(".env", "not copied");
    database("state/openclaw.sqlite", 17);
    database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    const opened = [];
    const fsModule = Object.create(fs);
    fsModule.opendirSync = (directory) => { opened.push(directory); return fs.opendirSync(directory); };
    const result = await inventory({ fsModule });
    expect(result.files).toHaveLength(6);
    expect(result.dbs).toHaveLength(2);
    expect(result.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files[0].sourceIdentity.sha256).toBe(result.configDigest);
    expect(opened).toEqual([path.join(root, "agents"), path.join(root, "state"), path.join(root, "agents/main/agent")]);
    expect(result.databaseSetComplete).toBe(true);
    expect((await inspect()).compatible).toBe(true);
  });

  it("discovers custom configured and registry-only owners without rewriting logical root", async () => {
    const logical = path.join(root, "logical");
    const actual = path.join(root, "actual");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, logical);
    write("actual/openclaw.json", { agents: { list: [{ id: "configured", agentDir: path.join(logical, "custom") }] } });
    const state = database("actual/state/openclaw.sqlite", 17);
    state.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT)");
    state.prepare("INSERT INTO agent_databases VALUES (?, ?)").run("registered", path.join(logical, "registry/agent.sqlite"));
    database("actual/custom/openclaw-agent.sqlite", 21, "agent", "configured");
    database("actual/registry/agent.sqlite", 21, "agent", "registered");
    const result = await inventory({ stateDir: logical });
    expect(result.requestedStateDir).toBe(logical);
    expect(result.stateDir).toBe(actual);
    expect(result.dbs.map((db) => db.agentId).filter(Boolean).sort()).toEqual(["configured", "registered"]);
    expect((await inspectRecoveryDatabases({ inventory: result, supported: { state: 17, agent: 21 } })).ok).toBe(true);
  });

  it("accepts logical-root config selectors without rewriting their environment identity", async () => {
    const logical = path.join(root, "logical");
    const actual = path.join(root, "actual");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, logical);
    write("actual/openclaw.json", {});
    const spawnEnv = Object.freeze({ OPENCLAW_STATE_DIR: logical, OPENCLAW_CONFIG_PATH: path.join(logical, "openclaw.json") });
    const result = await inventory({ stateDir: logical, spawnEnv });
    expect(result).toMatchObject({ requestedStateDir: logical, stateDir: actual, configPath: path.join(actual, "openclaw.json") });
    expect(spawnEnv).toEqual({ OPENCLAW_STATE_DIR: logical, OPENCLAW_CONFIG_PATH: path.join(logical, "openclaw.json") });
  });

  it("observes committed WAL content markers without copying or checkpointing", async () => {
    const db = database("state/openclaw.sqlite", 16);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '17')");
    const mainBefore = fs.readFileSync(path.join(root, "state/openclaw.sqlite"));
    const walBefore = fs.readFileSync(path.join(root, "state/openclaw.sqlite-wal"));
    expect((await inventory()).dbs[0]).toMatchObject({ bytes: mainBefore.length, walBytes: walBefore.length });
    expect(walBefore.length).toBeGreaterThan(0);
    const result = await inspect({ state: 16, agent: 19 });
    expect(result.compatible).toBe(false);
    expect(result.perDb[0]).toMatchObject({ userVersion: 16, contentVersion: 17 });
    expect(fs.readFileSync(path.join(root, "state/openclaw.sqlite"))).toEqual(mainBefore);
    expect(fs.readFileSync(path.join(root, "state/openclaw.sqlite-wal"))).toEqual(walBefore);
    const supported = await inspect();
    expect(supported).toMatchObject({ compatible: true, migrationRequired: false });
    expect(supported.perDb[0].deferredPublication).toBe(true);
  });

  it("accepts absent optional content markers but fails closed on legacy missing ownership", async () => {
    const db = database("state/openclaw.sqlite", 16);
    expect((await inventory()).dbs[0].walBytes).toBe(0);
    expect(await inspect()).toMatchObject({ compatible: true, migrationRequired: true });
    expect((await inspect()).byKind.state).toMatchObject({ count: 1, compatible: true, migrationRequired: true, foundVersion: 16, targetVersion: 17 });
    db.exec("DROP TABLE schema_meta");
    expect(await inspect()).toMatchObject({ ok: false, compatible: null, migrationRequired: null });
  });

  it.each(["wrong-role", "wrong-owner", "wrong-version"])("refuses %s ownership metadata", async (mode) => {
    const db = database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    db.exec(mode === "wrong-role" ? "UPDATE schema_meta SET role='global'" : mode === "wrong-owner" ? "UPDATE schema_meta SET agent_id='other'" : "UPDATE schema_meta SET schema_version=20");
    expect((await inspect()).compatible).toBe(null);
  });

  it("refuses unsupported target generations and physical state-16 markers", async () => {
    const db = database("state/openclaw.sqlite", 16);
    expect((await inspect({ state: 18, agent: 21 })).compatible).toBe(null);
    db.exec("CREATE TABLE skill_workshop_proposals (workspace_dir TEXT)");
    expect((await inspect()).reasons).toContain("state_schema_16_requires_physical_shape_validation");
  });

  it("reports active publication blockers and rejects invalid content markers", async () => {
    const db = database("state/openclaw.sqlite", 16);
    db.exec("CREATE TABLE update_runs (run_id TEXT, before_json TEXT, status TEXT, updated_at_ms INTEGER, finished_at_ms INTEGER)");
    db.prepare("INSERT INTO update_runs VALUES ('run', ?, 'running', ?, NULL)").run('{"version":"2026.9.2"}', Date.now());
    expect((await inspect()).reasons).toContain("state_schema_publication_blocked");
    db.exec("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '\"17\"')");
    expect((await inspect()).reasons).toContain("invalid_content_version");
  });

  it("bounds aggregate observations and rejects incomplete inventories", async () => {
    database("state/openclaw.sqlite", 17);
    expect(await inspect(undefined, { timeoutMs: 1 })).toMatchObject({ ok: false, compatible: null, reasons: ["RECOVERY_PROBE_TIMEOUT"] });
    expect((await inspectRecoveryDatabases({ inventory: { dbs: [], databaseSetComplete: false } })).ok).toBe(false);
  });

  it.each(["{invalid", '{"$include":"other.json"}', '{"agents":{"entries":[]}}'])("refuses unsupported config %s", async (config) => {
    write("openclaw.json", config);
    await expect(inventory()).rejects.toThrow();
  });

  it("bounds configuration bytes, file count, enumeration and registry rows", async () => {
    write("openclaw.json", " ".repeat(kRecoveryLimits.fileBytes + 1));
    await expect(inventory()).rejects.toThrow(/byte limit/);
    fs.unlinkSync(path.join(root, "openclaw.json"));
    for (let i = 0; i < 86; i++) for (const file of ["auth.json", "auth-state.json", "auth-profiles.json"]) write(`agents/a${i}/agent/${file}`, "{}");
    await expect(inventory()).rejects.toThrow(/file limit/);
    fs.rmSync(path.join(root, "agents"), { recursive: true });
    fs.mkdirSync(path.join(root, "agents"));
    for (let i = 0; i <= kRecoveryLimits.entries; i++) write(`agents/file${i}`, "");
    await expect(inventory()).rejects.toThrow(/enumeration limit/);
    fs.rmSync(path.join(root, "agents"), { recursive: true });
    const db = database("state/openclaw.sqlite", 17);
    db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT)");
    for (let i = 0; i < 513; i++) db.prepare("INSERT INTO agent_databases VALUES (?, ?)").run(`a${i}`, `custom/${i}.sqlite`);
    await expect(inventory()).rejects.toThrow(/row limit/);
  });

  it("enforces aggregate config bytes and the database-set cap", async () => {
    for (let i = 0; i < 6; i++) for (const file of ["auth.json", "auth-state.json", "auth-profiles.json"]) write(`agents/a${i}/agent/${file}`, " ".repeat(kRecoveryLimits.fileBytes));
    await expect(inventory()).rejects.toThrow(/byte limit/);
    fs.rmSync(path.join(root, "agents"), { recursive: true });
    for (let i = 0; i <= kRecoveryLimits.databases; i++) write(`agents/main/agent/db${i}.sqlite`, "");
    await expect(inventory()).rejects.toThrow(/file limit/);
  });

  it("ignores stale registry imports but rejects conflicting live ownership", async () => {
    const db = database("state/openclaw.sqlite", 17);
    db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT); INSERT INTO agent_databases VALUES ('old', 'missing.sqlite'), ('offline', 'imports/offline.sqlite')");
    write("imports/offline.sqlite", "not a live database");
    const result = await inventory();
    expect(result.dbs).toHaveLength(1);
    expect(result.skipped.map((item) => item.kind)).toEqual(["missing-registry-database", "registry-import-artifact"]);
    database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    db.exec("INSERT INTO agent_databases VALUES ('other', 'agents/main/agent/openclaw-agent.sqlite')");
    await expect(inventory()).rejects.toThrow(/Ambiguous agent directory owner/);
  });

  it("rejects changed identities and corrupt agent databases without a fallback copy", async () => {
    database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    const found = await inventory();
    found.dbs[0].sourceIdentity.ino += 1;
    expect((await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).compatible).toBe(null);
    write("agents/other/agent/broken.sqlite", "not a database");
    const result = await inspect();
    expect(result.compatible).toBe(null);
    expect(result.perDb.find((entry) => entry.agentId === "other")).toMatchObject({ sourcePath: path.join(root, "agents/other/agent/broken.sqlite"), status: "corrupt", error: { code: "SQLITE_NOTADB", errcode: 26 } });
  });

  it("retains registry corruption source and SQLite classification through the worker", async () => {
    write("state/openclaw.sqlite", "not a database");
    await expect(inventory()).rejects.toMatchObject({ sourcePath: path.join(root, "state/openclaw.sqlite"), status: "corrupt", code: "SQLITE_NOTADB", errcode: 26 });
  });

  it("reports lock contention as busy rather than corruption", async () => {
    const db = database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    const found = await inventory();
    db.exec("BEGIN EXCLUSIVE");
    try {
      const result = await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } });
      expect(result).toMatchObject({ ok: false, compatible: null });
      expect(result.perDb[0]).toMatchObject({ sourcePath: found.dbs[0].sourcePath, status: "busy", error: { code: "SQLITE_BUSY", errcode: 5 } });
    } finally { db.exec("ROLLBACK"); }
  });

  it("refuses storage environment disagreement and unsupported session selectors", async () => {
    await expect(inventory({ spawnEnv: { OPENCLAW_STATE_DIR: path.join(root, "different") } })).rejects.toThrow(/disagrees/);
    write("openclaw.json", { session: { store: "elsewhere" } });
    await expect(inventory()).rejects.toThrow(/storage selector/);
  });

  it.each(["external", "traversal", "symlink", "orphan", "alias"])("refuses %s database locators", async (mode) => {
    const db = database("state/openclaw.sqlite", 17);
    db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT)");
    if (mode === "external") db.prepare("INSERT INTO agent_databases VALUES ('main', ?)").run(path.join(os.tmpdir(), "external.sqlite"));
    if (mode === "traversal") db.exec("INSERT INTO agent_databases VALUES ('main', 'nested/../agent.sqlite')");
    if (mode === "symlink") fs.symlinkSync(path.join(root, "missing"), path.join(root, "agents"));
    if (mode === "orphan") write("agents/main/agent/openclaw-agent.sqlite-wal", "orphan");
    if (mode === "alias") fs.linkSync(path.join(root, "state/openclaw.sqlite"), path.join(root, "state/alias.sqlite"));
    await expect(inventory()).rejects.toThrow();
  });

  it("keeps fresh configuration absence explicit", async () => {
    expect(await inventory()).toMatchObject({ configPresent: false, configDigest: null, files: [], dbs: [] });
    expect(await inspect()).toMatchObject({ ok: true, compatible: true, migrationRequired: false });
  });
});
