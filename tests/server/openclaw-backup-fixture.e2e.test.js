const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
const { updateOpenclawBackupSettings } = require("../../lib/server/alphaclaw-config");
const { createCommands } = require("../../lib/server/commands");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { resetStateDbQuietForTests, isStateDbQuiet, onStateDbQuiet, enterStateDbHandle, exitStateDbHandle } = require("../../lib/server/state-db-quiet");
const { scrubTestRunnerEnv } = require("../live/live-helpers");

const logger = { log() {}, warn() {}, error() {} };
const roots = [];
const write = (root, name, value) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
};
const seedDb = (root, name) => {
  const file = write(root, name, "");
  const db = new DatabaseSync(file);
  const agent = name.startsWith("agents/");
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=${agent ? 21 : 17}; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture VALUES(1, 'retained fixture row')`);
  db.prepare("INSERT INTO schema_meta VALUES('primary',?,?,?)").run(agent ? "agent" : "global", agent ? 21 : 17, agent ? "main" : null);
  db.close();
  return file;
};
const writeRelease = (directory, version) => {
  write(directory, "package.json", JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" }, openclaw: { schemaVersions: { state: 17, agent: 21 } } }));
  write(directory, "bin/entry.js", `const version = ${JSON.stringify(version)}; if (process.argv.includes("preflight") || process.argv.includes("backup")) process.exit(99); console.log(process.argv.includes("--version") ? version : '{}');\n`);
  write(directory, "dist/thinking-levels.js", "exports.listThinkingLevelOptions = () => [];\n");
  fs.mkdirSync(path.join(directory, "dist", "extensions"), { recursive: true });
  return directory;
};
const createFixture = ({ symlinkRoot = false, releaseFixture = false, backupTuning = {} } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-backup-fixture-"));
  roots.push(rootDir);
  const actualStateDir = path.join(rootDir, "volume", ".openclaw");
  fs.mkdirSync(actualStateDir, { recursive: true });
  const openclawDir = symlinkRoot ? path.join(rootDir, ".openclaw") : actualStateDir;
  if (symlinkRoot) fs.symlinkSync(actualStateDir, openclawDir, "dir");
  write(openclawDir, "openclaw.json", JSON.stringify({ gateway: { mode: "local" } }));
  write(openclawDir, "credentials/fixture.json", '{"fixture":true}\n');
  write(openclawDir, "agents/main/agent/auth-profiles.json", '{"profiles":{}}\n');
  write(openclawDir, "workspace/notes.md", "# restore this workspace\n");
  seedDb(openclawDir, "state/openclaw.sqlite");
  seedDb(openclawDir, "agents/main/agent/openclaw-agent.sqlite");
  const packageRoot = path.join(rootDir, "package");
  write(packageRoot, "package.json", JSON.stringify({ dependencies: { openclaw: "2026.9.3" } }));
  const store = createOpenclawReleaseChannelStore({ rootDir, openclawDir, logger });
  const installDir = releaseFixture ? path.join(rootDir, "installed") : path.resolve(".");
  if (releaseFixture) {
    writeRelease(path.join(installDir, "node_modules", "openclaw"), "2026.9.3");
    store.writeSentinel({ installDir, version: "2026.9.3" });
  }
  const lock = createGatewayLifecycleLock({ logger });
  let running = true;
  const gatewayQuiesce = {
    acquireLock: vi.fn((options) => lock.acquire("backup_quiesce", options)),
    suppress: vi.fn(), unsuppress: vi.fn(),
    isRunning: vi.fn(async () => running),
    probeReadiness: vi.fn(async () => ({ ok: false, kind: "unsupported" })),
    stop: vi.fn(async () => { running = false; return true; }),
    start: vi.fn(async () => { running = true; }),
  };
  const env = scrubTestRunnerEnv({
    ...process.env,
    HOME: rootDir,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_STATE_DIR: openclawDir,
    OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
    XDG_CONFIG_HOME: openclawDir,
    NODE_COMPILE_CACHE: path.join(rootDir, "compile-cache"),
    PATH: `${path.resolve("node_modules/.bin")}${path.delimiter}${process.env.PATH}`,
  });
  const realRunner = createRunStream({});
  const runStream = { runStreamed: vi.fn((options) => realRunner.runStreamed({
    ...options, env: scrubTestRunnerEnv(options.env || env),
  })) };
  let sync;
  const gatewayMutationPolicy = createGatewayMutationPolicy({ lock,
    getChannelInfo: () => sync.getChannelInfo(), isApplyInProgress: () => sync.isApplyInProgress() });
  sync = createOpenclawChannelSync({
    rootDir, openclawDir, packageRoot, store, logger, runStream, gatewayQuiesce,
    gatewayMutationPolicy, acquireLifecycleLock: lock.acquire,
    openclawSpawnEnv: () => env,
    resolveInstallDir: () => installDir,
    ...(releaseFixture ? {
      installToTempDir: async ({ versionSpec }) => {
        const tmpDir = fs.mkdtempSync(path.join(rootDir, "release-"));
        const openclawPackageDir = writeRelease(path.join(tmpDir, "node_modules", "openclaw"), versionSpec);
        return { tmpDir, openclawPackageDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
      },
      acceptanceHoldMs: 0,
    } : {}),
    backupsDir: path.join(rootDir, "backups"),
    backupTuning,
    readReleaseChannel: () => "stable", isOnboarded: () => true,
  });
  return { rootDir, openclawDir, actualStateDir, installDir, env, sync, store, lock, gatewayQuiesce, runStream };
};
const upstreamCalls = (fixture) => fixture.runStream.runStreamed.mock.calls
  .map(([options]) => options).filter((options) => ["tar", "gzip"].includes(options.command) || options.args?.includes("backup") || options.args?.includes("preflight"));
const restoreCheckpoint = async (fixture, recovery) => {
  const verified = await readRecoveryCheckpoint(recovery.checkpoint.file, { operationId: recovery.checkpoint.operationId });
  const restored = path.join(fixture.rootDir, "restored");
  write(restored, "workspace/notes.md", "Keep post-checkpoint workspace data\n");
  write(restored, "credentials/fixture.json", '{"newerCredential":true}\n');
  for (const name of ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"]) {
    const file = seedDb(restored, name);
    const db = new DatabaseSync(file);
    try { db.exec("UPDATE fixture SET value='post-checkpoint database row'"); }
    finally { db.close(); }
  }
  fs.cpSync(path.join(recovery.checkpoint.file, "payload"), restored, { recursive: true });
  return { directory: restored, manifest: verified.manifest };
};
const assertRestored = (fixture, restored) => {
  for (const name of ["openclaw.json", "agents/main/agent/auth-profiles.json"]) {
    expect(fs.readFileSync(path.join(restored.directory, name))).toEqual(fs.readFileSync(path.join(fixture.openclawDir, name)));
  }
  expect(fs.readFileSync(path.join(restored.directory, "workspace/notes.md"), "utf8")).toBe("Keep post-checkpoint workspace data\n");
  expect(JSON.parse(fs.readFileSync(path.join(restored.directory, "credentials/fixture.json")))).toEqual({ newerCredential: true });
  for (const name of ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"]) {
    if (restored.manifest.kind === "config_only") {
      expect(restored.manifest.databases).toEqual([]);
      const db = new DatabaseSync(path.join(restored.directory, name), { readOnly: true });
      try { expect(db.prepare("SELECT value FROM fixture").get().value).toBe("post-checkpoint database row"); }
      finally { db.close(); }
      continue;
    }
    const source = new DatabaseSync(path.join(fixture.openclawDir, name), { readOnly: true });
    const copy = new DatabaseSync(path.join(restored.directory, name), { readOnly: true });
    try {
      expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(copy.prepare("PRAGMA user_version").get()).toEqual(source.prepare("PRAGMA user_version").get());
      expect(copy.prepare("SELECT * FROM fixture ORDER BY id").all()).toEqual(source.prepare("SELECT * FROM fixture ORDER BY id").all());
    } finally { source.close(); copy.close(); }
  }
};
const seedFiles = (root, directory, count) => {
  for (let batch = 0; batch < Math.ceil(count / 1000); batch += 1) {
    const parent = path.join(root, directory, `batch-${batch}`);
    fs.mkdirSync(parent, { recursive: true });
    for (let index = batch * 1000; index < Math.min(count, (batch + 1) * 1000); index += 1) {
      fs.writeFileSync(path.join(parent, `file-${index}.txt`), "fixture\n");
    }
  }
};

describe("issue #102 real backup fixtures", () => {
  beforeEach(() => resetStateDbQuietForTests({ listeners: true }));
  afterEach(() => {
    resetStateDbQuietForTests({ listeners: true });
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  }, 120_000);

  it("captures a large database only when explicitly requested and restores its verified snapshot", async () => {
    const fixture = createFixture();
    const source = path.join(fixture.openclawDir, "state/openclaw.sqlite");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE large_payload(value BLOB); INSERT INTO large_payload VALUES(zeroblob(33554432))");
    db.close();
    const initial = await fixture.sync.runStandaloneBackup({});
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body.recovery.kind).toBe("config_only");
    expect(initial.body.recovery.checkpoint.bytes).toBeLessThan(1024);
    expect(fs.existsSync(path.join(initial.body.recovery.checkpoint.file, "payload", "state/openclaw.sqlite"))).toBe(false);
    fixture.gatewayQuiesce.stop.mockClear();
    fixture.gatewayQuiesce.start.mockClear();
    const result = await fixture.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const record = fixture.sync.runLedger.readRun(result.body.operationId).recovery;
    expect(record).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
    expect(record.databases.entries.find((entry) => entry.dbKind === "state").bytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(fs.readdirSync(path.join(fixture.rootDir, "backups")).some((name) => name.endsWith(".staging"))).toBe(false);
    const restored = await restoreCheckpoint(fixture, record);
    assertRestored(fixture, restored);
    const snapshot = new DatabaseSync(path.join(restored.directory, "state/openclaw.sqlite"), { readOnly: true });
    try { expect(snapshot.prepare("SELECT length(value) AS bytes FROM large_payload").get().bytes).toBe(33554432); }
    finally { snapshot.close(); }
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(fixture.lock.getActiveOperation()).toBeNull();
  }, 45_000);

  it("shutdown cancels the owned SQLite snapshot before cleanup and never retries or relaunches", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.gatewayQuiesce.signal = controller.signal;
    const db = new DatabaseSync(path.join(fixture.openclawDir, "state/openclaw.sqlite"));
    db.exec("CREATE TABLE large_payload(value BLOB); INSERT INTO large_payload VALUES(zeroblob(33554432))");
    db.close();
    let stagingRoot;
    fixture.gatewayQuiesce.isCancelled = () => {
      const backups = path.join(fixture.rootDir, "backups");
      for (const entry of fs.existsSync(backups) ? fs.readdirSync(backups) : []) {
        if (!entry.endsWith(".staging")) continue;
        const candidate = path.join(backups, entry);
        if (fs.existsSync(path.join(candidate, "payload/state/openclaw.sqlite"))) {
          stagingRoot = candidate;
          controller.abort("shutdown");
        }
      }
      return controller.signal.aborted;
    };
    const response = await fixture.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(response.status, JSON.stringify(response.body)).not.toBe(200);
    expect(controller.signal.aborted).toBe(true);
    expect(stagingRoot).toEqual(expect.any(String));
    expect(fs.existsSync(stagingRoot)).toBe(false);
    expect(fixture.sync.runLedger.readRun(response.body.operationId).recovery).toBeUndefined();
    expect(fs.readdirSync(path.join(fixture.rootDir, "backups")).filter((name) => name.startsWith("recovery-"))).toEqual([]);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).not.toHaveBeenCalled();
    expect(isStateDbQuiet()).toBe(false);
    expect(fixture.lock.getActiveOperation()).toBeNull();
  });

  it("applies a stub release, activates and accepts it at boot, and restores only its checkpointed config", async () => {
    const fixture = createFixture({ symlinkRoot: true, releaseFixture: true });
    const result = await fixture.sync.applyUpdate({ channel: "stable", version: "2026.9.4", intent: "update" });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.backup).toBeNull();
    expect(record.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, restore: { databaseSetAvailable: false } });
    assertRestored(fixture, await restoreCheckpoint(fixture, record.recovery));
    expect(fixture.store.readInstalledVersion({ installDir: fixture.installDir })).toBe("2026.9.3");
    expect(fixture.sync.syncAtBoot().ok).toBe(true);
    await vi.waitFor(() => expect(fixture.store.readInstalledVersion({ installDir: fixture.installDir })).toBe("2026.9.4"));
    expect(["ok", "skipped"]).toContain((await fixture.sync.reconcileBootConfig()).status);
    expect(fixture.sync.runLedger.readRun(result.body.operationId).state).toBe("activated");
    fixture.sync.onGatewayHealthy();
    fixture.sync.onGatewayHealthy();
    expect(fixture.store.readState().applied).toMatchObject({ version: "2026.9.4", channel: "stable" });
    expect(fixture.store.readState().applied.acceptedAt).toEqual(expect.any(Number));
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fixture.lock.getActiveOperation()).toBeNull(), { timeout: 5000 });
  }, 60_000);

  it.each([false, true])("explicitly snapshots and restores real SQLite and config contents (symlink root: %s)", async (symlinkRoot) => {
    const fixture = createFixture({ symlinkRoot });
    const result = await fixture.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.archive).toBeUndefined();
    expect(result.body.recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
    assertRestored(fixture, await restoreCheckpoint(fixture, result.body.recovery));
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(fixture.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("resolves checkpoint sources locally without rewriting the configured symlink state path or invoking fallback producers", async () => {
    const fixture = createFixture({ symlinkRoot: true });
    fixture.runStream.runStreamed.mockRejectedValue(new Error("No checkpoint operation may invoke an upstream producer"));
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.recovery.kind).toBe("config_only");
    const restored = await restoreCheckpoint(fixture, record.recovery);
    expect(restored.manifest.stateDir).toBe(fixture.actualStateDir);
    expect(restored.manifest.requestedStateDir).toBe(fixture.openclawDir);
    assertRestored(fixture, restored);
    expect(fixture.env.OPENCLAW_STATE_DIR).toBe(fixture.openclawDir);
    expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(path.join(fixture.openclawDir, "openclaw.json"));
    expect(fixture.env.XDG_CONFIG_HOME).toBe(fixture.openclawDir);
    expect(fixture.runStream.runStreamed).not.toHaveBeenCalled();
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  });

  it("the pinned CLI writes config without changing the configured state path", async () => {
    const fixture = createFixture({ symlinkRoot: true });
    const runtimeEnv = withOpenclawStartupEnv(fixture.env);
    expect(runtimeEnv.OPENCLAW_STATE_DIR).toBe(fixture.openclawDir);
    expect(runtimeEnv.OPENCLAW_CONFIG_PATH).toBe(path.join(fixture.openclawDir, "openclaw.json"));
    expect(runtimeEnv.XDG_CONFIG_HOME).toBe(fixture.openclawDir);
    expect(fixture.env.OPENCLAW_STATE_DIR).toBe(fixture.openclawDir);
    const commands = createCommands({ gatewayEnv: () => fixture.env });
    const result = await commands.clawCmdWithBin(path.resolve("node_modules/openclaw/openclaw.mjs"),
      ["config", "set", "gateway.mode", "local"], { quiet: true, timeoutMs: 60_000 });
    expect(result.ok, result.stderr).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.actualStateDir, "openclaw.json"), "utf8")).gateway.mode).toBe("local");
    expect(fs.lstatSync(fixture.openclawDir).isSymbolicLink()).toBe(true);
  }, 90_000);

  it("drains a temporary state-database holder inside the original pause before copying", async () => {
    const fixture = createFixture();
    const holder = new DatabaseSync(path.join(fixture.openclawDir, "state/openclaw.sqlite"), { readOnly: true });
    enterStateDbHandle();
    let drained = false;
    const off = onStateDbQuiet({ name: "fixture-holder", begin: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      holder.close();
      exitStateDbHandle();
      drained = true;
    } });
    write(fixture.openclawDir, ".env", "FIXTURE_ONLY=excluded\n");
    const result = await fixture.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    off();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(drained).toBe(true);
    expect(result.body.recovery.kind).toBe("database_set");
    assertRestored(fixture, await restoreCheckpoint(fixture, result.body.recovery));
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  });

  it("does not report checkpoint success or fall through to a live CLI when the gateway never becomes ready", async () => {
    const fixture = createFixture({ backupTuning: { postQuiesceReadyTimeoutMs: 25, postQuiescePollMs: 5 } });
    fixture.gatewayQuiesce.start.mockImplementation(async () => {});
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.code).toBe("gateway_relaunch_failed");
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.state).toBe("failed");
    expect(record.ok).toBe(false);
    expect(record.recovery.checkpoint.verified).toBe(true);
    expect((await readRecoveryCheckpoint(record.recovery.checkpoint.file)).kind).toBe("config_only");
    expect(fixture.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it.each([false, true])("ignores 10,000 workspace symlinks in under five seconds and never captures .env or symlink targets (env link: %s)", async (envLink) => {
    const fixture = createFixture();
    const target = write(fixture.rootDir, "outside.txt", "outside fixture must not be archived\n");
    if (envLink) fs.symlinkSync(write(fixture.rootDir, ".env", "FIXTURE_ONLY=excluded\n"), path.join(fixture.openclawDir, ".env"));
    else write(fixture.openclawDir, ".env", "FIXTURE_ONLY=excluded\n");
    const links = path.join(fixture.openclawDir, "workspace", "links");
    fs.mkdirSync(links);
    for (let index = 0; index < 10_000; index += 1) fs.symlinkSync(target, path.join(links, `link-${index}`));
    updateOpenclawBackupSettings({ openclawDir: fixture.openclawDir, policy: { excludes: [], rootExcludes: [] } });
    const startedAt = performance.now();
    const preflight = await fixture.sync.getBackupPreflight();
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5000);
    expect(preflight).toMatchObject({ ok: true, blocked: false, profile: "config_only", checkpoint: { fileCount: 2 }, databaseCount: 2 });
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery.kind).toBe("config_only");
    const restored = await restoreCheckpoint(fixture, result.body.recovery);
    expect(fs.existsSync(path.join(restored.directory, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(restored.directory, "workspace", "links"))).toBe(false);
    expect(restored.manifest.files.some((asset) => asset.sourcePath === target)).toBe(false);
    expect(restored.manifest.databases).toEqual([]);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    assertRestored(fixture, restored);
  }, 60_000);

  it("completes bounded config inventory and checkpoint with 250,000 unrelated files", async () => {
    const fixture = createFixture();
    seedFiles(fixture.openclawDir, "worktrees/scratch", 100_000);
    seedFiles(fixture.openclawDir, "workspace/.openclaw", 100_000);
    seedFiles(fixture.openclawDir, "workspace/retained", 50_000);
    const preflight = await fixture.sync.getBackupPreflight();
    expect(preflight, JSON.stringify(preflight)).toMatchObject({ ok: true, blocked: false, profile: "config_only", checkpoint: { fileCount: 2 }, databaseCount: 2 });
    expect(preflight.checkpoint.bytes).toBeLessThan(1024);
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery.kind).toBe("config_only");
    const restored = await restoreCheckpoint(fixture, result.body.recovery);
    expect(restored.manifest.files.filter((asset) => asset.archivePath.startsWith("workspace/retained/"))).toHaveLength(0);
    expect(fs.existsSync(path.join(restored.directory, "workspace/retained"))).toBe(false);
    expect(fs.existsSync(path.join(restored.directory, "worktrees/scratch"))).toBe(false);
    expect(fs.existsSync(path.join(restored.directory, "workspace/.openclaw"))).toBe(false);
    assertRestored(fixture, restored);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  }, 180_000);

  it("an excessive workspace no longer blocks config-only recovery or triggers a database snapshot", async () => {
    const fixture = createFixture();
    seedFiles(fixture.openclawDir, "workspace/retained", 200_001);
    const preflight = await fixture.sync.getBackupPreflight();
    expect(preflight).toMatchObject({ ok: true, blocked: false, profile: "config_only", checkpoint: { fileCount: 2 }, databaseCount: 2 });
    expect(preflight.reason).toBeNull();
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery).toMatchObject({ kind: "config_only", databases: { complete: false, verified: false, entries: [] } });
    const restored = await restoreCheckpoint(fixture, result.body.recovery);
    assertRestored(fixture, restored);
    expect(fs.existsSync(path.join(restored.directory, "workspace/retained"))).toBe(false);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.lock.getActiveOperation()).toBeNull();
  }, 120_000);
});
