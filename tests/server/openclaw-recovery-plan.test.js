const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
import { describe, it, expect, beforeEach, afterEach } from "vitest";
const { buildRecoveryInventory, inspectRecoveryDatabases, kRecoveryLimits } = require("../../lib/server/openclaw-recovery-plan");
const { pinnedBuild, copyPinnedBuild, evidence } = require("../fixtures/sqlite-artifact-build");

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

  it.each([false, true])("excludes proven corrupt scratch only after ownership discovery (reverse=%s)", async (reverse) => {
    write("openclaw.json", { agents: { list: [{ id: "custom", agentDir: path.join(root, "custom") }] } });
    database("state/openclaw.sqlite", 17);
    database("custom/openclaw-agent.sqlite", 21, "agent", "custom");
    const names = ["main.sqlite.generation-lock.sqlite", "main.sqlite.generation-writer.sqlite", "main.sqlite.reindex-lock.sqlite", "main.sqlite.memory-reindex-11111111-2222-3333-4444-555555555555"];
    for (const directory of ["state", "custom"]) for (const name of names) for (const suffix of ["", "-wal", "-shm", "-journal"]) write(`${directory}/${name}${suffix}`, "corrupt scratch");
    const fsModule = Object.create(fs);
    fsModule.opendirSync = (directory) => {
      const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (reverse ? -1 : 1) * a.name.localeCompare(b.name));
      return { readSync: () => entries.shift() || null, closeSync() {} };
    };
    const found = await inventory({ executingBuild: pinnedBuild, fsModule });
    expect(found.dbs).toHaveLength(2);
    expect(found.excludedArtifacts).toHaveLength(32);
    expect(await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).toMatchObject({ compatible: true, migrationRequired: false });
    for (const entry of found.excludedArtifacts) expect(fs.readFileSync(entry.sourcePath, "utf8")).toBe("corrupt scratch");
  });

  it("preserves registered transient-looking ownership and missing registered targets", async () => {
    const db = database("state/openclaw.sqlite", 17);
    db.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT); INSERT INTO agent_databases VALUES ('main', 'custom/main.sqlite.generation-lock.sqlite')");
    database("custom/main.sqlite.generation-lock.sqlite", 21, "agent", "main");
    let found = await inventory({ executingBuild: pinnedBuild });
    expect(found.dbs).toHaveLength(2);
    expect(found.excludedArtifacts).toEqual([]);
    expect((await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).compatible).toBe(true);
    db.exec("INSERT INTO agent_databases VALUES ('missing', 'missing/required.sqlite')");
    found = await inventory({ executingBuild: pinnedBuild });
    expect(found.databaseSetComplete).toBe(false);
    expect(await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).toMatchObject({ compatible: null, reasons: ["required_database_missing"] });
  });

  it.each(["main", "wal", "shm", "journal"])("rejects a transient %s hardlink even before the owner is enumerated", async (kind) => {
    database("state/openclaw.sqlite", 17);
    const target = kind === "main" ? "state/openclaw.sqlite" : `state/openclaw.sqlite-${kind}`;
    if (kind !== "main") write(target, "coordination");
    const alias = `state/a.sqlite.generation-lock.sqlite${kind === "main" ? "" : `-${kind}`}`;
    fs.linkSync(path.join(root, target), path.join(root, alias));
    await expect(inventory({ executingBuild: pinnedBuild })).rejects.toThrow(/alias|sidecar/);
  });

  it("retains unknown builds, backup/tmp families, and arbitrary empty files", async () => {
    database("state/openclaw.sqlite", 17);
    write("agents/main/agent/main.sqlite.generation-lock.sqlite", "");
    let found = await inventory();
    expect(found.excludedArtifacts).toEqual([]);
    expect((await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).reasons).toContain("unsupported_transient_artifact_contract");
    fs.unlinkSync(path.join(root, "agents/main/agent/main.sqlite.generation-lock.sqlite"));
    for (const family of ["backup", "tmp"]) write(`agents/main/agent/main.sqlite.${family}-11111111-2222-3333-4444-555555555555`, "");
    write("agents/main/agent/arbitrary.sqlite", "");
    found = await inventory({ executingBuild: pinnedBuild });
    const result = await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } });
    expect(result.compatible).toBeNull();
    expect(result.perDb.find((entry) => entry.sourcePath.endsWith("arbitrary.sqlite"))).toMatchObject({ empty: true, userVersion: 0, hasApplicationTables: false, reasons: ["empty_database_unverified"] });
    expect(found.excludedArtifacts).toEqual([]);
  });

  it("does not finalize exclusions when registry inspection fails", async () => {
    write("state/openclaw.sqlite", "corrupt");
    write("state/main.sqlite.generation-lock.sqlite", "corrupt scratch");
    await expect(inventory({ executingBuild: pinnedBuild })).rejects.toMatchObject({ inventory: { databaseSetComplete: false, excludedArtifacts: [], dbs: [expect.objectContaining({ archivePath: "state/openclaw.sqlite" })] } });
  });

  it("observes WAL-only application tables instead of labeling a database empty", async () => {
    const file = path.join(root, "agents/main/agent/empty.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    handles.push(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE application_data(value TEXT); INSERT INTO application_data VALUES ('saved')");
    const before = fs.readFileSync(file);
    const wal = fs.readFileSync(`${file}-wal`);
    const result = await inspect();
    expect(result.perDb[0]).toMatchObject({ empty: false, hasApplicationTables: true, compatible: null, reasons: ["database_owner_or_schema_metadata_mismatch"] });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readFileSync(`${file}-wal`)).toEqual(wal);
  });

  it("rejects sidecars replaced after discovery before opening SQLite", async () => {
    database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    const found = await inventory();
    write("alias-target", "do not mutate");
    fs.symlinkSync(path.join(root, "alias-target"), `${found.dbs[0].sourcePath}-shm`);
    const result = await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } });
    expect(result.compatible).toBeNull();
    expect(result.reasons).toContain("RECOVERY_SQLITE_UNSAFE_PATH");
    expect(fs.readFileSync(path.join(root, "alias-target"), "utf8")).toBe("do not mutate");
  });

  it("accepts the 2026.9.8 schema contracts (state 19, agent 24) and refuses the next unknown ones", async () => {
    database("state/openclaw.sqlite", 19);
    database("agents/main/agent/openclaw-agent.sqlite", 24, "agent", "main");
    expect(await inspect({ state: 19, agent: 24 })).toMatchObject({ compatible: true, migrationRequired: false });
    const future = await inspect({ state: 20, agent: 25 });
    expect(future.compatible).toBeNull();
    expect(future.perDb.every((entry) => entry.reasons.includes("unsupported_target_schema_contract"))).toBe(true);
  });

  it("reports observed versions even when the executing schema contract is unknown", async () => {
    database("state/openclaw.sqlite", 12);
    expect(await inspect({ state: null, agent: null })).toMatchObject({ compatible: null, perDb: [expect.objectContaining({ userVersion: 12, contentVersion: 12, hasApplicationTables: true, reasons: ["unsupported_target_schema_contract"] })] });
  });

  it("allows private SQLite coordination creation for a closed WAL without changing main data", async () => {
    const db = database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    db.exec("PRAGMA journal_mode=WAL");
    handles.splice(handles.indexOf(db), 1);
    db.close();
    const file = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
    fs.chmodSync(file, 0o600);
    const before = fs.readFileSync(file);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect((await inspect()).compatible).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(`${file}-wal`).size).toBe(0);
    for (const suffix of ["-wal", "-shm"]) expect(fs.statSync(`${file}${suffix}`).mode & 0o177).toBe(0);
  });

  it("holds a closed WAL in a read-only directory instead of bypassing coordination", async () => {
    const db = database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    db.exec("PRAGMA journal_mode=WAL");
    handles.splice(handles.indexOf(db), 1);
    db.close();
    const directory = path.join(root, "agents/main/agent");
    fs.chmodSync(directory, 0o500);
    try {
      const result = await inspect();
      expect(result.compatible).toBeNull();
      expect(result.perDb[0].status).toBe("error");
      expect(fs.existsSync(path.join(directory, "openclaw-agent.sqlite-wal"))).toBe(false);
    } finally { fs.chmodSync(directory, 0o700); }
  });

  it("refuses configuration or root changes between inventory and observation", async () => {
    write("openclaw.json", "{}");
    database("state/openclaw.sqlite", 17);
    const found = await inventory();
    write("openclaw.json", '{"agents":{"list":[]}}');
    expect((await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).compatible).toBeNull();
    const fresh = await inventory();
    fresh.rootIdentity.ino += 1;
    expect((await inspectRecoveryDatabases({ inventory: fresh, supported: { state: 17, agent: 21 } })).compatible).toBeNull();
  });

  it("invalidates producer qualification between discovery and inspection", async () => {
    database("state/openclaw.sqlite", 17);
    write("state/main.sqlite.generation-lock.sqlite", "scratch");
    const executingBuild = copyPinnedBuild(path.join(root, "producer"));
    const found = await inventory({ executingBuild });
    expect(found.excludedArtifacts).toHaveLength(1);
    fs.appendFileSync(path.join(executingBuild.packageDir, Object.keys(evidence.files)[0]), "\n");
    expect(await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).toMatchObject({ compatible: null, reasons: ["Executing SQLite artifact contract changed"] });
  });

  it("rejects retargeting a logical state root during discovery", async () => {
    fs.mkdirSync(path.join(root, "actual"));
    fs.mkdirSync(path.join(root, "replacement"));
    const logical = path.join(root, "logical");
    fs.symlinkSync(path.join(root, "actual"), logical);
    let checkpoints = 0;
    await expect(inventory({ stateDir: logical, checkpoint: () => {
      if (++checkpoints === 2) {
        fs.unlinkSync(logical);
        fs.symlinkSync(path.join(root, "replacement"), logical);
      }
    } })).rejects.toThrow(/root identity changed/);
  });

  it("preserves absent canonical ownership for legacy manual verification without blocking fresh boot", async () => {
    database("state/leftover.sqlite", 17);
    database("agents/main/agent/leftover.sqlite", 21, "agent", "main");
    const found = await inventory();
    expect(found.expectedDatabases).toEqual([
      { sourcePath: path.join(root, "state/openclaw.sqlite"), archivePath: "state/openclaw.sqlite", dbKind: "state", ownership: "canonical", present: false },
      { sourcePath: path.join(root, "agents/main/agent/openclaw-agent.sqlite"), archivePath: "agents/main/agent/openclaw-agent.sqlite", dbKind: "agent", agentId: "main", ownership: "canonical", present: false },
    ]);
    expect((await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 } })).compatible).toBe(true);
  });

  it("uses explicit registry destinations instead of guessing an extra canonical agent file", async () => {
    const db = database("state/openclaw.sqlite", 17);
    db.exec("CREATE TABLE agent_databases(agent_id TEXT,path TEXT); INSERT INTO agent_databases VALUES ('main','custom/registered.sqlite')");
    database("custom/registered.sqlite", 21, "agent", "main");
    expect((await inventory()).expectedDatabases).toEqual([
      expect.objectContaining({ archivePath: "state/openclaw.sqlite", ownership: "canonical", present: true }),
      expect.objectContaining({ archivePath: "custom/registered.sqlite", ownership: "registry", agentId: "main", present: true }),
    ]);
  });

  it("bounds configured ownership even before any database is created", async () => {
    write("openclaw.json", { agents: { list: Array.from({ length: kRecoveryLimits.databases + 1 }, (_, index) => ({ id: `agent${index}` })) } });
    await expect(inventory()).rejects.toThrow(/owner limit/);
  });

  it.each(["inventory", "inspection"])("refuses a config swapped to a FIFO at %s open without blocking", (phase) => {
    write("openclaw.json", "{}");
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { execFileSync } = require('child_process');
      const { buildRecoveryInventory, inspectRecoveryDatabases } = require(process.argv[1]);
      (async () => {
        const stateDir = process.argv[2];
        const config = path.join(stateDir, 'openclaw.json');
        const phase = process.argv[3];
        const openSync = fs.openSync;
        let swapped = false;
        const replaceAtOpen = (file, flags, ...args) => {
          if (file === config && !swapped) {
            swapped = true;
            fs.unlinkSync(config);
            execFileSync('mkfifo', [config]);
          }
          return openSync(file, flags, ...args);
        };
        if (phase === 'inventory') {
          try {
            await buildRecoveryInventory({ stateDir, spawnEnv: {}, fsModule: { ...fs, openSync: replaceAtOpen } });
            throw new Error('unexpected success');
          } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
        } else {
          const inventory = await buildRecoveryInventory({ stateDir, spawnEnv: {} });
          fs.openSync = replaceAtOpen;
          process.stdout.write(JSON.stringify(await inspectRecoveryDatabases({ inventory, supported: { state: 17, agent: 21 } })));
        }
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const output = require("child_process").execFileSync(process.execPath, ["-e", script, require.resolve("../../lib/server/openclaw-recovery-plan"), root, phase], { encoding: "utf8", timeout: 2000 });
    const result = JSON.parse(output);
    if (phase === "inventory") expect(result).toMatchObject({ code: "RECOVERY_INVENTORY_UNSUPPORTED" });
    else expect(result).toMatchObject({ compatible: null, reasons: ["Recovery configuration identity changed during open"] });
    expect(fs.lstatSync(path.join(root, "openclaw.json")).isFIFO()).toBe(true);
  });

  it.each(["", "-wal", "-shm", "-journal"])("refuses SQLite FIFO paths before the native open (%s)", async (suffix) => {
    database("agents/main/agent/openclaw-agent.sqlite", 21, "agent", "main");
    const found = await inventory();
    const file = `${found.dbs[0].sourcePath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
    require("child_process").execFileSync("mkfifo", [file]);
    const result = await inspectRecoveryDatabases({ inventory: found, supported: { state: 17, agent: 21 }, timeoutMs: 2000 });
    expect(result).toMatchObject({ compatible: null, reasons: ["RECOVERY_SQLITE_UNSAFE_PATH"] });
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });

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
    expect((await inspect({ state: 20, agent: 21 })).compatible).toBe(null);
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
