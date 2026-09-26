const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const request = require("supertest");

const guardRecoveryIo = ({ stateDir, auditPath }) => {
  const fs = require("fs");
  const path = require("path");
  const sqlite = require("node:sqlite");
  const append = fs.appendFileSync.bind(fs);
  const originals = [];
  let active = true;
  const event = (value) => append(auditPath, `${JSON.stringify(value)}\n`);
  const wrap = (owner, name, check) => {
    if (typeof owner[name] !== "function") return;
    const original = owner[name];
    originals.push(() => { owner[name] = original; });
    owner[name] = function (...args) { if (active) check(...args); return original.apply(this, args); };
  };
  const stringify = (value) => typeof value === "string" ? value : value instanceof URL ? value.pathname : "";
  const database = (value) => /\.sqlite(?:-(?:wal|shm|journal))?$/.test(stringify(value));
  const omitted = (value) => {
    const selected = stringify(value);
    return ["workspace", "credentials", "scratch"].some((name) => selected === path.join(stateDir, name) || selected.startsWith(`${path.join(stateDir, name)}${path.sep}`));
  };
  const reject = (operation, selected) => {
    event({ forbidden: operation, selected: stringify(selected), stack: new Error().stack });
    throw new Error(`Scale acceptance forbids ${operation}: ${stringify(selected)}`);
  };
  for (const owner of [fs, fs.promises]) {
    for (const name of ["readdir", "readdirSync", "opendir", "opendirSync"]) wrap(owner, name, (file) => {
      event({ enumeration: name, directory: stringify(file) });
      if ((stringify(file) === stateDir && name !== "opendirSync") || omitted(file)) reject("broad state enumeration", file);
    });
    for (const name of ["readFile", "readFileSync", "createReadStream", "open", "openSync"]) wrap(owner, name, (file) => {
      if (owner === fs.promises && name === "open" && database(file)) return;
      if (database(file)) reject("raw database read/hash", file);
      if (omitted(file)) reject("omitted source read", file);
    });
    for (const name of ["copyFile", "copyFileSync", "cp", "cpSync"]) wrap(owner, name, (source, destination) => {
      if (database(source) || database(destination) || stringify(source) === stateDir || omitted(source)) reject("database or broad state copy", source);
    });
  }
  const opendir = fs.opendirSync;
  originals.push(() => { fs.opendirSync = opendir; });
  fs.opendirSync = (...args) => {
    const handle = opendir(...args);
    if (!active || stringify(args[0]) !== stateDir) return handle;
    let count = 0;
    const read = handle.readSync.bind(handle);
    handle.readSync = () => {
      const entry = read();
      if (entry && ++count > 4096) reject("unbounded shallow state enumeration", args[0]);
      if (entry) event({ boundedRootEntry: true });
      return entry;
    };
    return handle;
  };
  const open = fs.promises.open;
  originals.push(() => { fs.promises.open = open; });
  fs.promises.open = async (...args) => {
    const handle = await open(...args);
    if (!active || !database(args[0])) return handle;
    const file = stringify(args[0]);
    const limit = file.endsWith("-wal") ? 32 : file.endsWith("-journal") ? 28 : 100;
    let total = 0;
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      if (position !== 0 || !Number.isInteger(length) || length < 0 || total + length > limit) reject("unbounded database fingerprint", file);
      const result = await read(buffer, offset, length, position);
      total += result.bytesRead;
      event({ boundedFingerprint: file, bytes: result.bytesRead });
      return result;
    };
    for (const method of ["readFile", "createReadStream", "readv"]) handle[method] = () => reject("unbounded database handle read", file);
    return handle;
  };
  for (const name of ["exec", "prepare"]) wrap(sqlite.DatabaseSync.prototype, name, (sql) => {
    event({ sqlite: name, sql });
    if (/\bVACUUM\b|\b(?:integrity_check|quick_check|wal_checkpoint)\b/i.test(sql)) reject("database copying or traversal SQL", sql);
  });
  wrap(sqlite, "backup", (source) => reject("SQLite backup API", source));
  return () => { active = false; for (const restore of originals.reverse()) restore(); };
};

describe.skipIf(process.env.OPENCLAW_RECOVERY_SCALE !== "1")("config-only route-to-boot scale acceptance", () => {
  let root;
  let restoreIo;
  let restoreFork;
  afterEach(() => {
    restoreFork?.();
    restoreIo?.();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 1200000);

  it("ignores 250,000 scratch entries and a 3 GiB SQLite database through HTTP apply and boot", { timeout: 1800000, retry: 0 }, async () => {
    const startedAt = Date.now();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-scale-"));
    const stateDir = path.join(root, ".openclaw");
    const scratch = path.join(stateDir, "workspace", "scratch");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const auditPath = path.join(root, "io-audit.jsonl");
    const preloadPath = path.join(root, "probe-audit.cjs");
    const logger = { log() {}, warn() {}, error() {} };
    const sourceVersion = "2026.9.4";
    const targetVersion = "2026.9.5";
    const scratchCount = 250000;
    const databaseBytes = 3 * 1024 ** 3;
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
    fs.mkdirSync(path.join(stateDir, "credentials", "nested"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "credentials", "nested", "preserved"), "omitted credential artifact");
    fs.writeFileSync(path.join(stateDir, ".env"), "TEST_FIXTURE_ONLY=true\n");
    for (let shard = 0; shard < 250; shard++) {
      const directory = path.join(scratch, `shard-${shard}`);
      fs.mkdirSync(directory);
      for (let i = 0; i < 1000; i++) fs.closeSync(fs.openSync(path.join(directory, `entry-${i}`), "wx"));
    }
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version=17; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','global',17,NULL); CREATE TABLE scale_sentinel(value TEXT); INSERT INTO scale_sentinel VALUES ('preserved logical content')");
    db.close();
    fs.truncateSync(databasePath, databaseBytes);
    const databaseBefore = fs.statSync(databasePath);
    expect(databaseBefore.size).toBe(databaseBytes);
    expect(databaseBefore.blocks * 512).toBeLessThan(1024 * 1024);
    const countScratch = () => fs.readdirSync(scratch).reduce((count, shard) => count + fs.readdirSync(path.join(scratch, shard)).length, 0);
    expect(countScratch()).toBe(scratchCount);
    const fixtureMs = Date.now() - startedAt;

    const packageAt = (directory, version) => {
      fs.mkdirSync(path.join(directory, "dist", "extensions"), { recursive: true });
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "openclaw", version, bin: "openclaw.mjs", openclaw: { schemaVersions: { state: 17, agent: 21 } } }));
      fs.writeFileSync(path.join(directory, "openclaw.mjs"), `console.log(${JSON.stringify(version)});`);
      fs.writeFileSync(path.join(directory, "dist", "thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];");
      return directory;
    };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: sourceVersion } }));
    packageAt(path.join(root, "node_modules", "openclaw"), sourceVersion);
    fs.writeFileSync(preloadPath, `(${guardRecoveryIo.toString()})(${JSON.stringify({ stateDir, auditPath })});\n`);
    restoreIo = guardRecoveryIo({ stateDir, auditPath });
    const forks = [];
    const originalFork = childProcess.fork;
    childProcess.fork = (file, args, options) => {
      forks.push(path.basename(file));
      if (path.basename(file) !== "openclaw-recovery-probe.js") throw new Error(`Scale acceptance forbids snapshot worker: ${file}`);
      return originalFork(file, args, { ...options, execArgv: ["--require", preloadPath] });
    };
    restoreFork = () => { childProcess.fork = originalFork; };

    const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
    const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
    const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
    const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
    const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
    const { registerOpenclawChannelRoutes } = require("../../lib/server/routes/openclaw-channel");
    const { createOperationEventsService } = require("../../lib/server/operation-events");
    const order = [];
    const commands = [];
    const runner = async ({ command, args = [] }) => {
      commands.push({ command, args });
      if (command === "tar" || args.includes("backup") || args.includes("preflight") || args.some((arg) => /VACUUM|integrity_check/.test(arg))) throw new Error("Scale acceptance forbids archive or copied database CLI");
      if (args.includes("--version")) return { ok: true, tail: JSON.parse(fs.readFileSync(path.join(path.dirname(args[0]), "package.json"))).version };
      return { ok: true, tail: "{}" };
    };
    const makeInstance = () => {
      let sync;
      const store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir: stateDir, logger });
      const lock = createGatewayLifecycleLock();
      const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => sync?.getChannelInfo() || {}, isApplyInProgress: () => sync?.isApplyInProgress() || false });
      const operationEvents = createOperationEventsService();
      const releases = { isKnownVersion: (version) => version === targetVersion, isKnownCommit: () => false, getCatalog: async () => ({ ok: true, stable: [], beta: [] }), annotateCatalog: (catalog) => catalog };
      sync = createOpenclawChannelSync({ rootDir: root, openclawDir: stateDir, packageRoot: root, store,
        runStream: { runStreamed: runner }, resolveInstallDir: () => root, isOnboarded: () => true,
        releases, operationEvents, openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: stateDir }),
        installToTempDir: async ({ versionSpec }) => {
          order.push("prepare");
          const tmpDir = fs.mkdtempSync(path.join(root, "prepared-"));
          return { tmpDir, openclawPackageDir: packageAt(path.join(tmpDir, "node_modules", "openclaw"), versionSpec), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
        },
        gatewayQuiesce: { isRunning: async () => true, suppress: () => { order.push("suppress"); return "owner"; }, unsuppress: () => order.push("unsuppress"), stop: async () => { order.push("stop"); return true; }, start: async () => order.push("start") },
        acquireLifecycleLock: async (kind, options) => { order.push("acquire"); return lock.acquire(kind, options); },
        gatewayMutationPolicy: policy,
        dbQuiet: async () => { order.push("quiet"); return { release() {} }; }, dbResume: () => order.push("resume"),
        backupsDir: path.join(root, "backups"), diskSpace: () => ({ ok: true, free: 100e9 }), logger,
      });
      const app = express();
      app.use(express.json());
      registerOpenclawChannelRoutes({ app, fs, OPENCLAW_DIR: stateDir, isOnboarded: () => true, openclawChannelService: sync, openclawReleasesService: releases, operationEvents, restartRequiredState: { markRequired() {}, getSnapshot: async () => ({}) } });
      return { sync, store, app };
    };
    const routeStarted = Date.now();
    const first = makeInstance();
    first.store.writeSentinel({ installDir: root, version: sourceVersion });
    const response = await request(first.app).post("/api/openclaw/apply").send({ channel: "stable", version: targetVersion, intent: "update", recoveryMode: "config_only" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const ledger = createRunLedger({ openclawDir: stateDir });
    const operationId = response.body.operationId;
    let run;
    for (let attempt = 0; attempt < 3000; attempt++) {
      run = ledger.readRun(operationId);
      if (run?.state === "restart_expected" || run?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(run?.state, JSON.stringify(run)).toBe("restart_expected");
    expect(run.recovery).toMatchObject({ kind: "config_only", checkpoint: { fileCount: 1, bytes: 2 }, restore: { configAvailable: true, databaseSetAvailable: false } });
    expect(order).toEqual(["prepare", "acquire", "suppress", "stop", "quiet"]);
    const second = makeInstance();
    const activation = second.sync.syncAtBoot();
    expect(activation, JSON.stringify(activation)).toMatchObject({ ok: true, action: "activated" });
    expect(second.sync.getChannelInfo().installedVersion).toBe(targetVersion);
    const reconciliation = await second.sync.reconcileBootConfig();
    expect(["ok", "skipped"], JSON.stringify(reconciliation)).toContain(reconciliation.status);
    expect(ledger.readRun(operationId).state).toBe("activated");
    const third = makeInstance();
    expect(third.sync.syncAtBoot()).toMatchObject({ ok: true, action: "already_active" });
    expect((await third.sync.assessLaunchCompatibilityAtBoot()).compatible).toBe(true);
    const routeAndBootMs = Date.now() - routeStarted;

    const audit = fs.readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse);
    expect(audit.filter((event) => event.forbidden)).toEqual([]);
    expect(audit.some((event) => event.sqlite && /schema_meta/.test(event.sql))).toBe(true);
    expect(forks.length).toBeGreaterThan(0);
    expect(new Set(forks)).toEqual(new Set(["openclaw-recovery-probe.js"]));
    expect(commands.some((call) => call.command === "tar" || call.args.includes("backup") || call.args.includes("preflight"))).toBe(false);
    expect(audit.filter((event) => event.enumeration).length).toBeLessThan(200);
    restoreFork(); restoreFork = null;
    restoreIo(); restoreIo = null;

    const payload = path.join(run.recovery.checkpoint.file, "payload");
    expect(fs.readdirSync(payload)).toEqual(["openclaw.json"]);
    expect(fs.readFileSync(path.join(payload, "openclaw.json"), "utf8")).toBe("{}");
    let checkpointBytes = 0;
    const countCheckpoint = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) countCheckpoint(file);
        else checkpointBytes += fs.statSync(file).size;
      }
    };
    countCheckpoint(run.recovery.checkpoint.file);
    expect(checkpointBytes).toBeLessThan(16 * 1024);
    const databaseAfter = fs.statSync(databasePath);
    expect({ size: databaseAfter.size, ino: databaseAfter.ino, mtimeMs: databaseAfter.mtimeMs, blocks: databaseAfter.blocks }).toEqual({ size: databaseBefore.size, ino: databaseBefore.ino, mtimeMs: databaseBefore.mtimeMs, blocks: databaseBefore.blocks });
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    expect(verified.prepare("SELECT value FROM scale_sentinel").get().value).toBe("preserved logical content");
    verified.close();
    expect(countScratch()).toBe(scratchCount);
    expect(fs.readFileSync(path.join(stateDir, "credentials", "nested", "preserved"), "utf8")).toBe("omitted credential artifact");
    expect(fs.readFileSync(path.join(stateDir, ".env"), "utf8")).toBe("TEST_FIXTURE_ONLY=true\n");
    const boundedFingerprintBytes = audit.reduce((bytes, event) => bytes + (event.boundedFingerprint ? event.bytes : 0), 0);
    expect(boundedFingerprintBytes).toBeLessThanOrEqual(1000);
    console.log(JSON.stringify({ recoveryScale: { scratchEntries: scratchCount, databaseBytes, allocatedDatabaseBytes: databaseAfter.blocks * 512, checkpointBytes, payloadBytes: 2, enumerations: audit.filter((event) => event.enumeration).length, metadataProcesses: forks.length, boundedFingerprintBytes, forbiddenOperations: 0, fixtureMs, routeAndBootMs } }));
  });
});
