const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const { createRecoveryCheckpoint, readRecoveryCheckpoint, verifyRecoveryCheckpoint, inspectRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");

let temp;
let stateDir;
let backupsDir;
const sourceBuild = { version: "2026.9.3", channel: "stable" };
const targetBuild = { version: "2026.9.4", channel: "beta" };
const identify = (file) => {
  const stat = fs.statSync(file);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
};
const fileEntry = (archivePath, text = "{}", kind = "config") => {
  const sourcePath = path.join(stateDir, archivePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, text);
  return { sourcePath, archivePath, kind, bytes: Buffer.byteLength(text), sourceIdentity: identify(sourcePath) };
};
const fixture = () => ({ stateDir, requestedStateDir: stateDir, configPath: path.join(stateDir, "openclaw.json"), files: [fileEntry("openclaw.json")], dbs: [] });
const create = (inventory, options = {}) => createRecoveryCheckpoint({ inventory, backupsDir, operationId: "op-one", sourceBuild, targetBuild, ...options });
const activeChildPid = () => process._getActiveHandles().find((handle) => handle.constructor.name === "ChildProcess" && handle.exitCode === null)?.pid;
const addDb = (inventory, archivePath = "state/openclaw.sqlite") => {
  const sourcePath = path.join(stateDir, archivePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const db = new DatabaseSync(sourcePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('in-wal'); PRAGMA user_version=7;");
  const stat = fs.statSync(sourcePath);
  inventory.dbs.push({ sourcePath, archivePath, dbKind: archivePath.startsWith("agents/") ? "agent" : "state", agentId: archivePath.startsWith("agents/") ? "main" : null, bytes: stat.size, sourceIdentity: { dev: stat.dev, ino: stat.ino } });
  return db;
};
const rewriteManifest = (file, mutate) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(file, "manifest.json")));
  mutate(manifest);
  const raw = JSON.stringify(manifest);
  fs.writeFileSync(path.join(file, "manifest.json"), raw);
  fs.writeFileSync(path.join(file, "ready.json"), JSON.stringify({ id: manifest.id, manifestSha256: createHash("sha256").update(raw).digest("hex") }));
};

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-checkpoint-"));
  stateDir = path.join(temp, "state");
  backupsDir = path.join(temp, "backups");
  fs.mkdirSync(stateDir);
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

describe("bounded config checkpoints", () => {
  it("publishes private exact files with operation and build bindings", async () => {
    const inventory = fixture();
    inventory.files.push(fileEntry("identity/device.json", '{"id":"device"}', "legacy_identity"));
    const result = await create(inventory);
    expect(result.kind).toBe("config_only");
    expect(result.checkpoint).toMatchObject({ verified: true, fileCount: 2, sourceBuild, targetBuild });
    expect(result.restore).toEqual({ configAvailable: true, databaseSetAvailable: false });
    expect(result.databases).toMatchObject({ complete: false, verified: false, entries: [] });
    for (const relative of ["", "payload", "payload/identity"]) expect(fs.statSync(path.join(result.file, relative)).mode & 0o777).toBe(0o700);
    for (const relative of ["manifest.json", "ready.json", "payload/openclaw.json", "payload/identity/device.json"]) expect(fs.statSync(path.join(result.file, relative)).mode & 0o777).toBe(0o600);
    expect(await verifyRecoveryCheckpoint(result.file, { operationId: "op-one", sourceBuild, targetBuild })).toEqual(result);
    await expect(readRecoveryCheckpoint(result.file, { operationId: "other" })).rejects.toMatchObject({ code: "CHECKPOINT_BINDING_MISMATCH" });
  });

  it("never opens, stats or hashes discovered DBs on config-only work", async () => {
    const inventory = fixture();
    inventory.dbs.push({ sourcePath: path.join(stateDir, "state/openclaw.sqlite"), archivePath: "state/openclaw.sqlite", dbKind: "state", bytes: 2 ** 40, sourceIdentity: { dev: 1, ino: 2 } });
    const fsModule = new Proxy(fs, { get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args) => {
        if (typeof args[0] === "string" && args[0].includes(".sqlite")) throw new Error("DB access forbidden");
        return value(...args);
      };
    } });
    const result = await create(inventory, { fsModule });
    expect(result.manifest.discoveredDatabaseCount).toBe(1);
    expect(await readRecoveryCheckpoint(result.file, { fsModule })).toEqual(result);
  });

  it("preserves a configured root alias without rewriting logical identity", async () => {
    const inventory = fixture();
    const alias = path.join(temp, "alias");
    fs.symlinkSync(stateDir, alias);
    inventory.requestedStateDir = alias;
    inventory.stateDir = alias;
    inventory.configPath = path.join(alias, "openclaw.json");
    inventory.files[0].sourcePath = inventory.configPath;
    const result = await create(inventory);
    expect(result.manifest).toMatchObject({ stateDir, requestedStateDir: alias });
    expect(result.manifest.files[0].sourcePath).toBe(inventory.configPath);
  });

  it("accepts exact custom config and agent paths from the independent inventory", async () => {
    const { buildRecoveryInventory } = require("../../lib/server/openclaw-recovery-plan");
    fileEntry("config/custom.json", JSON.stringify({ agents: { list: [{ id: "main", agentDir: path.join(stateDir, "custom-agent") }] } }));
    fileEntry("custom-agent/auth-profiles.json", "{}", "auth");
    const inventory = await buildRecoveryInventory({ stateDir, spawnEnv: { OPENCLAW_CONFIG_PATH: path.join(stateDir, "config/custom.json") } });
    const result = await create(inventory);
    expect(result.manifest.configArchivePath).toBe("config/custom.json");
    expect(result.manifest.files.map((entry) => entry.archivePath)).toEqual(["config/custom.json", "custom-agent/auth-profiles.json"]);
    expect(await readRecoveryCheckpoint(result.file, { inventory })).toEqual(result);
  });

  it("binds verification to independent config inventory", async () => {
    const inventory = fixture();
    const result = await create(inventory);
    const changed = structuredClone(inventory);
    changed.files[0].sourceIdentity.ino += 1;
    await expect(readRecoveryCheckpoint(result.file, { inventory: changed })).rejects.toMatchObject({ code: "CHECKPOINT_BINDING_MISMATCH" });
  });

  it.each(["per-file", "total", "count"])("refuses %s limits before publication", async (limit) => {
    const inventory = fixture();
    if (limit === "per-file") inventory.files = [fileEntry("openclaw.json", "x".repeat(1024 * 1024 + 1))];
    if (limit === "total") for (let i = 0; i < 17; i++) inventory.files.push(fileEntry(`agents/agent${i}/agent/auth.json`, "x".repeat(1024 * 1024)));
    if (limit === "count") inventory.files = Array(257).fill(inventory.files[0]);
    await expect(create(inventory)).rejects.toMatchObject({ code: "CHECKPOINT_LIMIT" });
    expect(fs.existsSync(backupsDir)).toBe(false);
  });

  it.each([".env", "credentials/token.json", "../escape", "alphaclaw.json", "state/openclaw.sqlite-wal"])("rejects unapproved payload %s", async (archivePath) => {
    const inventory = fixture();
    inventory.files.push({ ...inventory.files[0], archivePath });
    await expect(create(inventory)).rejects.toMatchObject({ code: "CHECKPOINT_UNSAFE_PATH" });
  });

  it.each(["symlink", "interior", "hardlink"])("rejects %s secret aliases", async (kind) => {
    const inventory = fixture();
    const secret = path.join(temp, ".env");
    fs.writeFileSync(secret, "hidden");
    if (kind === "interior") {
      const identity = path.join(temp, "identity");
      fs.mkdirSync(identity);
      fs.writeFileSync(path.join(identity, "device.json"), "hidden");
      fs.symlinkSync(identity, path.join(stateDir, "identity"));
      inventory.files.push({ sourcePath: path.join(stateDir, "identity/device.json"), archivePath: "identity/device.json", sourceIdentity: identify(path.join(identity, "device.json")) });
    } else {
      fs.unlinkSync(inventory.configPath);
      if (kind === "symlink") fs.symlinkSync(secret, inventory.configPath);
      else fs.linkSync(secret, inventory.configPath);
      inventory.files[0].sourceIdentity = identify(inventory.configPath);
    }
    await expect(create(inventory)).rejects.toThrow();
  });

  it("detects descriptor-time changes and cleans staging", async () => {
    const inventory = fixture();
    let changed = false;
    const fsModule = { ...fs, readSync(...args) {
      const result = fs.readSync(...args);
      if (!changed) { changed = true; fs.writeFileSync(inventory.configPath, "changed"); }
      return result;
    } };
    await expect(create(inventory, { fsModule })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it("detects path replacement after copying", async () => {
    const inventory = fixture();
    await expect(create(inventory, { onProgress() {
      fs.renameSync(inventory.configPath, `${inventory.configPath}.old`);
      fs.writeFileSync(inventory.configPath, "{}");
    } })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it("refuses a retargeted configured root alias before publication", async () => {
    const inventory = fixture();
    const alias = path.join(temp, "alias");
    const other = path.join(temp, "other");
    fs.mkdirSync(other);
    fs.symlinkSync(stateDir, alias);
    inventory.requestedStateDir = alias;
    await expect(create(inventory, { onProgress() {
      fs.unlinkSync(alias);
      fs.symlinkSync(other, alias);
    } })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it.each(["budget", "lease", "quiet"])("unwinds %s failure without usable staging", async (failure) => {
    const inventory = fixture();
    let stopped = false;
    await expect(create(inventory, {
      nowFn: () => stopped && failure === "budget" ? 20_000 : 0,
      isLeaseValid: () => failure !== "lease" || !stopped,
      isQuiet: () => failure !== "quiet" || !stopped,
      onProgress: () => { stopped = true; },
    })).rejects.toMatchObject({ code: `CHECKPOINT_${failure === "budget" ? "BUDGET" : `${failure.toUpperCase()}_LOST`}` });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it("requires a durable ready marker and never accepts staging directories", async () => {
    const result = await create(fixture());
    fs.unlinkSync(path.join(result.file, "ready.json"));
    await expect(readRecoveryCheckpoint(result.file)).rejects.toThrow();
    const staging = path.join(backupsDir, `.${result.checkpoint.id}.staging`);
    fs.renameSync(result.file, staging);
    await expect(readRecoveryCheckpoint(staging)).rejects.toMatchObject({ code: "CHECKPOINT_NOT_READY" });
  });

  it("detects damaged payloads, manifest binding, unsafe metadata and permissions", async () => {
    const result = await create(fixture());
    fs.writeFileSync(path.join(result.file, "payload/openclaw.json"), "[]");
    await expect(readRecoveryCheckpoint(result.file)).rejects.toMatchObject({ code: "CHECKPOINT_PAYLOAD_INVALID" });
    fs.writeFileSync(path.join(result.file, "payload/openclaw.json"), "{}");
    fs.chmodSync(path.join(result.file, "manifest.json"), 0o644);
    await expect(readRecoveryCheckpoint(result.file)).rejects.toMatchObject({ code: "CHECKPOINT_PERMISSIONS" });
    fs.chmodSync(path.join(result.file, "manifest.json"), 0o600);
    rewriteManifest(result.file, (manifest) => { manifest.files[0].archivePath = "../.env"; });
    await expect(readRecoveryCheckpoint(result.file)).rejects.toMatchObject({ code: "CHECKPOINT_MANIFEST_INVALID" });
  });

  it("leaves legacy archives untouched on success and failed publication", async () => {
    fs.mkdirSync(backupsDir);
    const legacy = path.join(backupsDir, "old.alphaclaw.tar.gz");
    fs.writeFileSync(legacy, "legacy");
    const inventory = fixture();
    const fsModule = { ...fs, renameSync() { throw new Error("publication failed"); } };
    await expect(create(inventory, { fsModule })).rejects.toThrow("publication failed");
    expect(fs.readdirSync(backupsDir)).toEqual([path.basename(legacy)]);
    await create(inventory);
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy");
  });

  it.each(["root", "parent", "dangling"])("refuses a %s backup-directory alias without writing through it", async (kind) => {
    const inventory = fixture();
    const external = path.join(temp, "external");
    if (kind !== "dangling") fs.mkdirSync(external);
    if (kind === "parent") {
      const alias = path.join(temp, "alias");
      fs.symlinkSync(external, alias);
      backupsDir = path.join(alias, "new-backups");
    } else fs.symlinkSync(external, backupsDir);
    await expect(create(inventory)).rejects.toMatchObject({ code: "CHECKPOINT_DESTINATION_ALIAS" });
    if (kind !== "dangling") expect(fs.readdirSync(external)).toEqual([]);
    else expect(fs.existsSync(external)).toBe(false);
  });

  it("tightens an existing real backup directory without changing retained archive files", async () => {
    const inventory = fixture();
    fs.mkdirSync(backupsDir, { mode: 0o755 });
    fs.chmodSync(backupsDir, 0o755);
    const archive = path.join(backupsDir, "retained.tar.gz");
    fs.writeFileSync(archive, "retained");
    const before = fs.statSync(archive);
    await create(inventory);
    expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(archive, "utf8")).toBe("retained");
    expect(fs.statSync(archive).mode).toBe(before.mode);
    expect(fs.statSync(archive).ino).toBe(before.ino);
  });

  it.each(["failure", "ineffective"])("fails closed when backup-root chmod is a %s", async (mode) => {
    const inventory = fixture();
    fs.mkdirSync(backupsDir, { mode: 0o755 });
    fs.chmodSync(backupsDir, 0o755);
    const fsModule = { ...fs, fchmodSync() {
      if (mode === "failure") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    } };
    await expect(create(inventory, { fsModule })).rejects.toMatchObject({ code: mode === "failure" ? "EACCES" : "CHECKPOINT_PERMISSIONS" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
    expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o755);
  });

  it("cleans up ENOSPC failures while writing the durable ready marker", async () => {
    const inventory = fixture();
    const fsModule = { ...fs, openSync(file, ...args) {
      if (typeof file === "string" && file.endsWith("ready.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return fs.openSync(file, ...args);
    } };
    await expect(create(inventory, { fsModule })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });
});

describe("explicit database-set checkpoints", () => {
  it("does not call an empty database inventory complete migration recovery", async () => {
    const result = await create(fixture(), { includeDatabases: true });
    expect(result.databases).toMatchObject({ complete: false, verified: false, requiredPaths: [], entries: [] });
    expect(Object.isFrozen(result.databases.requiredPaths)).toBe(true);
    expect(result.restore.databaseSetAvailable).toBe(false);
    expect((await readRecoveryCheckpoint(result.file)).restore.databaseSetAvailable).toBe(false);
  });

  it("captures WAL commits in standalone snapshots with schema and full-set metadata", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const second = addDb(inventory, "agents/main/agent/openclaw-agent.sqlite");
    try {
      const result = await create(inventory, { includeDatabases: true });
      expect(result.kind).toBe("database_set");
      expect(result.databases).toMatchObject({ complete: true, verified: true });
      expect(result.databases.entries).toHaveLength(2);
      expect(result.databases.requiredPaths).toEqual(inventory.dbs.map((entry) => entry.archivePath).sort());
      expect(Object.isFrozen(result.databases.requiredPaths)).toBe(true);
      for (const entry of result.databases.entries) {
        expect(entry).toMatchObject({ integrity: "ok", userVersion: 7, verified: true, path: entry.archivePath });
        const copyPath = path.join(result.file, "payload", entry.archivePath);
        expect(fs.existsSync(`${copyPath}-wal`)).toBe(false);
        const copy = new DatabaseSync(copyPath, { readOnly: true });
        expect(copy.prepare("SELECT value FROM items").get().value).toBe("in-wal");
        copy.close();
      }
      expect((await readRecoveryCheckpoint(result.file)).restore.databaseSetAvailable).toBe(true);
      expect((await readRecoveryCheckpoint(result.file, { inventory })).restore.databaseSetAvailable).toBe(true);
      const changed = structuredClone(inventory);
      changed.dbs.pop();
      await expect(readRecoveryCheckpoint(result.file, { inventory: changed })).rejects.toMatchObject({ code: "CHECKPOINT_BINDING_MISMATCH" });
    } finally { source.close(); second.close(); }
  });

  it("rejects insufficient disk space before any staging work", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    try {
      await expect(create(inventory, { includeDatabases: true, fsModule: { ...fs, statfsSync: () => ({ bavail: 0, bsize: 4096 }) } })).rejects.toMatchObject({ code: "CHECKPOINT_DISK_SPACE" });
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally { source.close(); }
  });

  it("accepts a clean closed WAL database when read-only SQLite creates an empty WAL", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    source.close();
    const database = inventory.dbs[0].sourcePath;
    expect(fs.existsSync(`${database}-wal`)).toBe(false);
    const before = fs.readFileSync(database);
    const result = await create(inventory, { includeDatabases: true });
    expect(fs.readFileSync(database)).toEqual(before);
    if (fs.existsSync(`${database}-wal`)) expect(fs.statSync(`${database}-wal`).size).toBe(0);
    expect(result.databases.verified).toBe(true);
    expect((await readRecoveryCheckpoint(result.file)).restore.databaseSetAvailable).toBe(true);
  });

  it("rejects a newly created WAL containing real committed writes", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    source.close();
    const database = inventory.dbs[0].sourcePath;
    expect(fs.existsSync(`${database}-wal`)).toBe(false);
    let writer;
    try {
      await expect(create(inventory, { includeDatabases: true, onProgress(progress) {
        if (progress.phase !== "database" || writer) return;
        writer = new DatabaseSync(database);
        writer.exec("INSERT INTO items VALUES ('new-wal-data')");
      } })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
      expect(writer).toBeTruthy();
      expect(fs.statSync(`${database}-wal`).size).toBeGreaterThan(0);
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally { writer?.close(); }
  });

  it("rejects empty read-created WAL files with broader permissions than the source", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    source.close();
    const database = inventory.dbs[0].sourcePath;
    fs.chmodSync(database, 0o600);
    const fsModule = { ...fs, chmodSync(file, mode) {
      fs.chmodSync(file, mode);
      if (file.endsWith("openclaw.sqlite")) {
        if (!fs.existsSync(`${database}-wal`)) fs.writeFileSync(`${database}-wal`, "");
        fs.chmodSync(`${database}-wal`, 0o644);
      }
    } };
    await expect(create(inventory, { includeDatabases: true, fsModule })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it("refuses aliased SQLite shared-memory sidecars before opening the source", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const shm = `${inventory.dbs[0].sourcePath}-shm`;
    const secret = path.join(temp, ".env");
    fs.writeFileSync(secret, "secret");
    fs.unlinkSync(shm);
    fs.symlinkSync(secret, shm);
    try {
      await expect(create(inventory, { includeDatabases: true })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_ALIAS" });
      expect(fs.existsSync(backupsDir)).toBe(false);
      expect(fs.readFileSync(secret, "utf8")).toBe("secret");
    } finally { source.close(); }
  });

  it("fails on corrupt source databases without publishing a partial set", async () => {
    const inventory = fixture();
    const sourcePath = path.join(stateDir, "state/openclaw.sqlite");
    fs.mkdirSync(path.dirname(sourcePath));
    fs.writeFileSync(sourcePath, "not sqlite");
    inventory.dbs.push({ sourcePath, archivePath: "state/openclaw.sqlite", dbKind: "state", sourceIdentity: identify(sourcePath) });
    await expect(create(inventory, { includeDatabases: true })).rejects.toMatchObject({ code: "CHECKPOINT_DATABASE_INVALID" });
    expect(fs.readdirSync(backupsDir)).toEqual([]);
  });

  it("accepts read-induced WAL ctime changes when content and all other identity fields are unchanged", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const wal = `${inventory.dbs[0].sourcePath}-wal`;
    const beforeStat = fs.statSync(wal);
    const beforeBytes = fs.readFileSync(wal);
    let observed = false;
    try {
      const result = await create(inventory, { includeDatabases: true, onProgress(progress) {
        if (progress.phase !== "database" || observed) return;
        observed = true;
        const reader = new DatabaseSync(inventory.dbs[0].sourcePath, { readOnly: true });
        reader.prepare("PRAGMA user_version").get();
        reader.close();
        fs.chmodSync(wal, beforeStat.mode & 0o777);
      } });
      const afterStat = fs.statSync(wal);
      expect(observed).toBe(true);
      expect(afterStat.ctimeMs).toBeGreaterThan(beforeStat.ctimeMs);
      for (const key of ["dev", "ino", "size", "mtimeMs", "mode", "nlink"]) expect(afterStat[key]).toBe(beforeStat[key]);
      expect(fs.readFileSync(wal)).toEqual(beforeBytes);
      expect(result.databases.verified).toBe(true);
      expect((await readRecoveryCheckpoint(result.file)).restore.databaseSetAvailable).toBe(true);
    } finally { source.close(); }
  });

  it("still rejects changed WAL permissions despite allowing ctime-only reads", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const wal = `${inventory.dbs[0].sourcePath}-wal`;
    const beforeMode = fs.statSync(wal).mode & 0o777;
    const fsModule = { ...fs, chmodSync(file, mode) {
      fs.chmodSync(file, mode);
      if (file.endsWith("openclaw.sqlite")) fs.chmodSync(wal, beforeMode ^ 0o020);
    } };
    try {
      await expect(create(inventory, { includeDatabases: true, fsModule })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally { source.close(); }
  });

  it("detects source WAL mutation after a snapshot", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const wal = `${inventory.dbs[0].sourcePath}-wal`;
    const beforeBytes = fs.readFileSync(wal);
    let mutated = false;
    try {
      await expect(create(inventory, { includeDatabases: true, onProgress(progress) {
        if (progress.phase === "database" && !mutated) { mutated = true; source.exec("INSERT INTO items VALUES ('changed')"); }
      } })).rejects.toMatchObject({ code: "CHECKPOINT_SOURCE_CHANGED" });
      expect(mutated).toBe(true);
      expect(fs.readFileSync(wal)).not.toEqual(beforeBytes);
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally { source.close(); }
  });

  it("kills and joins the SQLite subprocess before returning cancellation", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    const controller = new AbortController();
    let childPid;
    try {
      await expect(create(inventory, { includeDatabases: true, signal: controller.signal, onProgress(progress) {
        if (progress.phase === "database") {
          childPid = activeChildPid();
          controller.abort();
        }
      } })).rejects.toMatchObject({ code: "CHECKPOINT_CANCELLED" });
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(fs.readdirSync(backupsDir)).toEqual([]);
      source.exec("INSERT INTO items VALUES ('after-cancel')");
    } finally { source.close(); }
  });

  it.each(["quiet", "lease", "budget"])("joins the SQLite worker on %s loss", async (reason) => {
    const inventory = fixture();
    const source = addDb(inventory);
    let started = false;
    let childPid;
    try {
      await expect(create(inventory, {
        includeDatabases: true,
        isQuiet: () => reason !== "quiet" || !started,
        isLeaseValid: () => reason !== "lease" || !started,
        nowFn: () => reason === "budget" && started ? 480_001 : 0,
        onProgress(progress) {
          if (progress.phase !== "database") return;
          childPid = activeChildPid();
          started = true;
        },
      })).rejects.toMatchObject({ code: reason === "budget" ? "CHECKPOINT_BUDGET" : `CHECKPOINT_${reason.toUpperCase()}_LOST` });
      expect(childPid).toBeGreaterThan(0);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(fs.readdirSync(backupsDir)).toEqual([]);
    } finally { source.close(); }
  });

  it("does not let callers shrink the inventory during a capture", async () => {
    const inventory = fixture();
    const source = addDb(inventory, "openclaw.sqlite");
    try {
      const result = await create(inventory, { includeDatabases: true, onProgress(progress) {
        if (progress.phase === "config") inventory.dbs.length = 0;
      } });
      expect(result.databases.requiredPaths).toEqual(["openclaw.sqlite"]);
      expect(result.databases.entries).toHaveLength(1);
    } finally { source.close(); }
  });

  it("refuses a damaged snapshot and incomplete or rebound database inventory", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    try {
      const result = await create(inventory, { includeDatabases: true });
      rewriteManifest(result.file, (manifest) => { manifest.databases[0].agentId = "another"; });
      await expect(readRecoveryCheckpoint(result.file)).rejects.toMatchObject({ code: "CHECKPOINT_MANIFEST_INVALID" });
      rewriteManifest(result.file, (manifest) => { manifest.databases[0].agentId = null; });
      const snapshot = path.join(result.file, "payload/state/openclaw.sqlite");
      const fd = fs.openSync(snapshot, "r+");
      fs.writeSync(fd, Buffer.alloc(100), 0, 100, 0);
      fs.closeSync(fd);
      await expect(readRecoveryCheckpoint(result.file)).rejects.toMatchObject({ code: "CHECKPOINT_DATABASE_INVALID" });
    } finally { source.close(); }
  });
});

describe("cheap unchanged-checkpoint inspection", () => {
  it("preserves forward-only annotation without claiming database coverage", async () => {
    const record = await create(fixture());
    record.kind = "forward_only";
    const inspected = inspectRecoveryCheckpoint(record.file, { record, backupsDir });
    expect(inspected.ok).toBe(true);
    expect(inspected.recovery.kind).toBe("forward_only");
    expect(inspected.recovery.manifest.kind).toBe("config_only");
    expect(inspected.recovery.databases).toMatchObject({ complete: false, verified: false });
    expect(inspected.recovery.restore.databaseSetAvailable).toBe(false);
  });

  it("verifies record bindings and stats without opening database payloads", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    try {
      const record = await create(inventory, { includeDatabases: true });
      const opened = [];
      const fsModule = { ...fs, openSync(file, ...args) {
        opened.push(file);
        if (String(file).includes(".sqlite")) throw new Error("no database reads allowed");
        return fs.openSync(file, ...args);
      } };
      const inspected = inspectRecoveryCheckpoint(record.file, { record, backupsDir, fsModule });
      expect(inspected).toEqual({ ok: true, reason: null, recovery: record });
      expect(opened).toEqual([path.join(record.file, "manifest.json"), path.join(record.file, "ready.json")]);
      expect(record.checkpoint.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.manifest.files[0].publishedIdentity).toMatchObject(identify(path.join(record.file, "payload/openclaw.json")));
      expect(record.databases.entries[0].publishedIdentity).toMatchObject(identify(path.join(record.file, "payload/state/openclaw.sqlite")));
    } finally { source.close(); }
  });

  it.each(["operationId", "sourceBuild", "targetBuild", "manifestSha256", "fileCount", "bytes"])("refuses mismatched record %s", async (key) => {
    const record = await create(fixture());
    record.checkpoint[key] = key === "bytes" || key === "fileCount" ? 50 : "different";
    expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_BINDING_MISMATCH" });
  });

  it("refuses rewritten manifests even when their ready marker was updated", async () => {
    const record = await create(fixture());
    rewriteManifest(record.file, (manifest) => { manifest.operationId = "other"; });
    expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_BINDING_MISMATCH" });
  });

  it.each(["config", "database"])("detects changed %s payload identity without reading it", async (kind) => {
    const inventory = fixture();
    const source = addDb(inventory);
    try {
      const record = await create(inventory, { includeDatabases: true });
      const payload = path.join(record.file, "payload", kind === "config" ? "openclaw.json" : "state/openclaw.sqlite");
      const before = fs.statSync(payload);
      fs.utimesSync(payload, before.atime, new Date(before.mtimeMs + 1000));
      expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_PAYLOAD_CHANGED" });
    } finally { source.close(); }
  });

  it("rejects missing records, roots outside backups and interior payload aliases", async () => {
    const record = await create(fixture());
    expect(inspectRecoveryCheckpoint(record.file, { backupsDir }).ok).toBe(false);
    expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir: temp }).ok).toBe(false);
    const payload = path.join(record.file, "payload");
    const moved = path.join(temp, "moved");
    fs.renameSync(payload, moved);
    fs.symlinkSync(moved, payload);
    expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_SOURCE_ALIAS" });
  });

  it("refuses records with a missing required database or unverified entry", async () => {
    const inventory = fixture();
    const source = addDb(inventory);
    try {
      const record = await create(inventory, { includeDatabases: true });
      record.databases.entries[0].verified = false;
      expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_BINDING_MISMATCH" });
      record.databases.entries[0].verified = true;
      record.databases.requiredPaths = [];
      expect(inspectRecoveryCheckpoint(record.file, { record, backupsDir })).toEqual({ ok: false, reason: "CHECKPOINT_BINDING_MISMATCH" });
    } finally { source.close(); }
  });
});
