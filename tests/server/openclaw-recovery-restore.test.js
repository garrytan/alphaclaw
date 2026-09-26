const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { buildRecoveryInventory } = require("../../lib/server/openclaw-recovery-plan");
const { createRecoveryCheckpoint, readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
const { hasDatabaseRecoveryCoverage } = require("../../lib/server/openclaw-recovery-coverage");
const { writeFileAtomic } = require("../../lib/server/utils/safe-file");

const sourceBuild = Object.freeze({ channel: "stable", version: "2026.9.5" });
const targetBuild = Object.freeze({ channel: "beta", version: "2026.9.6-beta.1" });
const configBytes = Buffer.from('{\r\n  "agents": {"list": [{"id": "main"}, {"id": "research"}]},\r\n  "settings": {"label": "Original café", "enabled": false, "count": 0}\r\n}\r\n');
const databaseSpecs = Object.freeze([
  { archivePath: "state/openclaw.sqlite", version: 17, role: "global", agentId: null },
  { archivePath: "agents/main/agent/openclaw-agent.sqlite", version: 21, role: "agent", agentId: "main" },
  { archivePath: "agents/research/agent/openclaw-agent.sqlite", version: 21, role: "agent", agentId: "research" },
]);
const omittedFiles = Object.freeze({
  "workspace/newer-notes.md": "keep newer workspace\n",
  "workspace/scratch/large-history.jsonl": '{"newer":true}\n',
  "agents/main/sessions/newer-session.jsonl": '{"history":"newer"}\n',
  "credentials/newer-secret.json": '{"fixture":"not captured"}\n',
  ".alphaclaw/newer-lifecycle.json": '{"generation":10}\n',
  "alphaclaw.json": '{"updates":{"openclaw":{"releaseChannel":"beta"}}}\n',
  ".env": "FIXTURE_SECRET=omitted\n",
});

let root;
let source;
let destination;
let backupsDir;
let savedDir;

const write = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
};

const seedStoppedDatabase = (file, spec, value, journal = "WAL") => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const [file, raw] = process.argv.slice(1);
    const { version, role, agentId, value, journal } = JSON.parse(raw);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=" + journal + "; PRAGMA wal_autocheckpoint=0");
    db.exec("PRAGMA user_version=" + version);
    db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)");
    db.prepare("INSERT INTO schema_meta VALUES ('primary', ?, ?, ?)").run(role, version, agentId);
    db.exec("CREATE TABLE recovery_fixture(id INTEGER PRIMARY KEY, logical_value TEXT, payload BLOB)");
    db.prepare("INSERT INTO recovery_fixture VALUES (1, ?, ?)").run(value, Buffer.from([0, 1, 127, 128, 255]));
    if (journal === "WAL") process.kill(process.pid, "SIGKILL");
    db.close();
  `;
  const result = spawnSync(process.execPath, ["-e", script, file, JSON.stringify({ ...spec, value, journal })], {
    env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  if (journal === "WAL") {
    expect(result.signal, result.stderr).toBe("SIGKILL");
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    expect(fs.statSync(`${file}-shm`).size).toBeGreaterThan(0);
  } else expect(result.status, result.stderr).toBe(0);
};

const capture = async ({ includeDatabases = false, journal = "WAL" } = {}) => {
  write(path.join(source, "openclaw.json"), configBytes);
  write(path.join(source, "agents/main/agent/auth-profiles.json"), '{"legacy":"captured but not replayed onto SQLite"}\n');
  for (const spec of databaseSpecs) seedStoppedDatabase(path.join(source, spec.archivePath), spec, `captured:${spec.agentId || "state"}`, journal);
  const inventory = await buildRecoveryInventory({ stateDir: source, spawnEnv: {} });
  return createRecoveryCheckpoint({ inventory, backupsDir, operationId: "restore-drill", sourceBuild, targetBuild, includeDatabases });
};

const prepareDestination = () => {
  write(path.join(destination, "openclaw.json"), '{"settings":{"label":"newer destination"}}\n');
  write(path.join(destination, "agents/main/agent/auth-profiles.json"), '{"legacy":"newer presence must not become migration input"}\n');
  for (const [relative, bytes] of Object.entries(omittedFiles)) write(path.join(destination, relative), bytes);
  for (const spec of databaseSpecs) {
    const file = path.join(destination, spec.archivePath);
    seedStoppedDatabase(file, spec, `newer:${spec.agentId || "state"}`);
    write(`${file}-journal`, "stale rollback journal fixture");
  }
};

const treeBytes = (directory, prefix = "") => {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, treeBytes(file, relative));
    else files[relative] = fs.readFileSync(file);
  }
  return files;
};

const runOfflineRestoreDrill = async ({ record, build = sourceBuild, restoreDatabases = false }) => {
  const verified = await readRecoveryCheckpoint(record.file, {
    operationId: record.checkpoint.operationId,
    sourceBuild: build,
    targetBuild: record.checkpoint.targetBuild,
  });
  if (verified.checkpoint.manifestSha256 !== record.checkpoint.manifestSha256) throw new Error("Checkpoint manifest does not match the recorded artifact");
  if (restoreDatabases && !hasDatabaseRecoveryCoverage(verified)) throw new Error("Checkpoint has no complete database recovery set");
  const config = verified.manifest.files.find((entry) => entry.archivePath === verified.manifest.configArchivePath);
  const selected = [config, ...(restoreDatabases ? verified.manifest.databases : [])];
  const replacements = selected.map((entry) => ({
    archivePath: entry.archivePath,
    captured: path.join(record.file, "payload", entry.archivePath),
    target: path.join(destination, entry.archivePath),
    database: verified.manifest.databases.includes(entry),
  }));
  for (const { target, database } of replacements) {
    for (const suffix of database ? ["", "-wal", "-shm", "-journal"] : [""]) {
      if (fs.existsSync(`${target}${suffix}`) && !fs.lstatSync(`${target}${suffix}`).isFile()) throw new Error("Restore destination is not a regular file");
    }
  }
  fs.mkdirSync(savedDir, { mode: 0o700 });
  for (const { archivePath, captured, target, database } of replacements) {
    const saved = path.join(savedDir, archivePath);
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    for (const suffix of database ? ["", "-wal", "-shm", "-journal"] : [""]) {
      if (fs.existsSync(`${target}${suffix}`)) fs.renameSync(`${target}${suffix}`, `${saved}${suffix}`);
    }
    if (!database) writeFileAtomic(target, fs.readFileSync(captured), { mode: 0o600 });
    else {
      fs.copyFileSync(captured, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  return { verified, restoredPaths: replacements.map((entry) => entry.archivePath) };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-restore-"));
  source = path.join(root, "source");
  destination = path.join(root, "destination");
  backupsDir = path.join(root, "backups");
  savedDir = path.join(root, "saved-before-restore");
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(destination, { mode: 0o700 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("directory-checkpoint offline restore runbook", () => {
  it("restores config/settings bytes only and preserves every omitted destination byte", async () => {
    const record = await capture();
    prepareDestination();
    const before = treeBytes(destination);
    const restored = await runOfflineRestoreDrill({ record });
    expect(restored.restoredPaths).toEqual(["openclaw.json"]);
    expect(fs.readFileSync(path.join(destination, "openclaw.json"))).toEqual(configBytes);
    expect(JSON.parse(fs.readFileSync(path.join(destination, "openclaw.json"))).settings).toEqual({ label: "Original café", enabled: false, count: 0 });
    const expected = { ...before, "openclaw.json": configBytes };
    expect(treeBytes(destination)).toEqual(expected);
    expect(treeBytes(savedDir)).toEqual({ "openclaw.json": before["openclaw.json"] });
    expect(restored.verified.kind).toBe("config_only");
    expect(restored.verified.restore).toEqual({ configAvailable: true, databaseSetAvailable: false });
    expect(hasDatabaseRecoveryCoverage(restored.verified)).toBe(false);
    expect(restored.verified.manifest.files.some((entry) => entry.archivePath.endsWith("auth-profiles.json"))).toBe(true);
    expect(fs.statSync(path.join(destination, "openclaw.json")).mode & 0o777).toBe(0o600);
  });

  it.each(["WAL", "DELETE"])("restores the complete %s-captured DB set after saving all newer destinations and sidecars", async (journal) => {
    const record = await capture({ includeDatabases: true, journal });
    prepareDestination();
    const before = treeBytes(destination);
    const restored = await runOfflineRestoreDrill({ record, restoreDatabases: true });
    expect(hasDatabaseRecoveryCoverage(restored.verified)).toBe(true);
    expect(new Set(restored.restoredPaths)).toEqual(new Set(["openclaw.json", ...databaseSpecs.map((entry) => entry.archivePath)]));
    expect(record.databases.requiredPaths).toHaveLength(databaseSpecs.length);
    const untouched = { ...before };
    delete untouched["openclaw.json"];
    expect(fs.readFileSync(path.join(savedDir, "openclaw.json"))).toEqual(before["openclaw.json"]);
    for (const spec of databaseSpecs) {
      const file = path.join(destination, spec.archivePath);
      const payload = path.join(record.file, "payload", spec.archivePath);
      expect(fs.readFileSync(file)).toEqual(fs.readFileSync(payload));
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        expect(fs.readFileSync(path.join(savedDir, `${spec.archivePath}${suffix}`))).toEqual(before[`${spec.archivePath}${suffix}`]);
        delete untouched[`${spec.archivePath}${suffix}`];
        if (suffix) expect(fs.existsSync(`${file}${suffix}`)).toBe(false);
      }
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
        expect(db.prepare("PRAGMA user_version").get().user_version).toBe(spec.version);
        expect(db.prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key='primary'").get()).toEqual({ role: spec.role, agent_id: spec.agentId });
        const seed = db.prepare("SELECT logical_value, payload FROM recovery_fixture WHERE id=1").get();
        expect(seed.logical_value).toBe(`captured:${spec.agentId || "state"}`);
        expect(Buffer.from(seed.payload)).toEqual(Buffer.from([0, 1, 127, 128, 255]));
      } finally { db.close(); }
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    for (const [relative, bytes] of Object.entries(untouched)) expect(fs.readFileSync(path.join(destination, relative))).toEqual(bytes);
    expect(fs.readFileSync(path.join(destination, "openclaw.json"))).toEqual(configBytes);
    expect(fs.statSync(savedDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a database restore from config-only recovery before modifying any destination", async () => {
    const record = await capture();
    prepareDestination();
    const before = treeBytes(destination);
    await expect(runOfflineRestoreDrill({ record, restoreDatabases: true })).rejects.toThrow("no complete database recovery set");
    expect(treeBytes(destination)).toEqual(before);
    expect(fs.existsSync(savedDir)).toBe(false);
  });

  it.each(["mismatched-build", "corrupt-config", "corrupt-database", "corrupt-manifest", "missing-manifest", "missing-ready", "missing-database"])("refuses %s before displacing or modifying any destination", async (failure) => {
    const record = await capture({ includeDatabases: true });
    prepareDestination();
    const before = treeBytes(destination);
    let build = sourceBuild;
    if (failure === "mismatched-build") build = targetBuild;
    if (failure === "corrupt-config") fs.writeFileSync(path.join(record.file, "payload/openclaw.json"), "{}");
    if (failure === "corrupt-database") {
      const fd = fs.openSync(path.join(record.file, "payload", databaseSpecs.at(-1).archivePath), "r+");
      try { fs.writeSync(fd, Buffer.alloc(100), 0, 100, 0); } finally { fs.closeSync(fd); }
    }
    if (failure === "corrupt-manifest") fs.writeFileSync(path.join(record.file, "manifest.json"), "{broken");
    if (failure === "missing-manifest") fs.unlinkSync(path.join(record.file, "manifest.json"));
    if (failure === "missing-ready") fs.unlinkSync(path.join(record.file, "ready.json"));
    if (failure === "missing-database") fs.unlinkSync(path.join(record.file, "payload", databaseSpecs.at(-1).archivePath));
    await expect(runOfflineRestoreDrill({ record, build, restoreDatabases: true })).rejects.toThrow();
    expect(treeBytes(destination)).toEqual(before);
    expect(fs.existsSync(savedDir)).toBe(false);
  });
});
