const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { updateOpenclawBackupSettings } = require("../../lib/server/alphaclaw-config");
const { createCommands } = require("../../lib/server/commands");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { resetStateDbQuietForTests, isStateDbQuiet } = require("../../lib/server/state-db-quiet");
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
  db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture VALUES(1, 'retained fixture row')");
  db.close();
  return file;
};
const writeRelease = (directory, version) => {
  write(directory, "package.json", JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" } }));
  write(directory, "bin/entry.js", `const version = ${JSON.stringify(version)}; console.log(process.argv.includes("preflight") ? JSON.stringify({status:"exact",foundVersion:1,targetVersion:1}) : version);\n`);
  write(directory, "dist/thinking-levels.js", "exports.listThinkingLevelOptions = () => [];\n");
  write(directory, "dist/openclaw-state-db-contract-fixture.js", "const OPENCLAW_STATE_SCHEMA_VERSION = 1;\n");
  write(directory, "dist/openclaw-agent-db-contract-fixture.js", "const OPENCLAW_AGENT_SCHEMA_VERSION = 1;\n");
  fs.mkdirSync(path.join(directory, "dist", "extensions"), { recursive: true });
  return directory;
};
const createFixture = ({ symlinkRoot = false, backupTuning = {}, backupProbes = {}, releaseFixture = false } = {}) => {
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
      restartProcess: vi.fn(), acceptanceHoldMs: 0,
    } : {}),
    backupsDir: path.join(rootDir, "backups"),
    readReleaseChannel: () => "stable", isOnboarded: () => true,
    backupProbes: { readMountInfo: () => "", listProcesses: () => [], listFdHolders: () => [], ...backupProbes },
    backupTuning: { postQuiesceReadyTimeoutMs: 25, postQuiescePollMs: 5, postQuiesceSettleMs: 1,
      exclusivitySettleMs: 20, exclusivitySettlePollMs: 5, ...backupTuning },
  });
  return { rootDir, openclawDir, actualStateDir, installDir, env, sync, store, lock, gatewayQuiesce, runStream };
};
const upstreamCalls = (fixture) => fixture.runStream.runStreamed.mock.calls
  .map(([options]) => options).filter((options) => options.command === "openclaw" && options.args?.[0] === "backup");
const restoreArchive = (fixture, file) => {
  const restored = path.join(fixture.rootDir, "restored");
  fs.mkdirSync(restored);
  execFileSync("gzip", ["-t", file]);
  execFileSync("tar", ["-xzf", file, "-C", restored]);
  const [archiveRoot] = fs.readdirSync(restored);
  const directory = path.join(restored, archiveRoot);
  return { directory, manifest: JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")) };
};
const assertRestored = (fixture, restored) => {
  for (const name of ["openclaw.json", "credentials/fixture.json", "agents/main/agent/auth-profiles.json", "workspace/notes.md"]) {
    expect(fs.readFileSync(path.join(restored.directory, name))).toEqual(fs.readFileSync(path.join(fixture.openclawDir, name)));
  }
  for (const name of ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"]) {
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

  it("applies a stub release, activates and accepts it at boot, and restores that run's real archive", async () => {
    const fixture = createFixture({ symlinkRoot: true, releaseFixture: true });
    const result = await fixture.sync.applyUpdate({ channel: "stable", version: "2026.9.4", intent: "update" });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.backup).toMatchObject({ verified: true, profile: "full", noBackup: false });
    assertRestored(fixture, restoreArchive(fixture, record.backup.file));
    expect(fixture.store.readInstalledVersion({ installDir: fixture.installDir })).toBe("2026.9.3");
    expect(fixture.sync.syncAtBoot().ok).toBe(true);
    await vi.waitFor(() => expect(fixture.store.readInstalledVersion({ installDir: fixture.installDir })).toBe("2026.9.4"));
    fixture.sync.onGatewayHealthy();
    fixture.sync.onGatewayHealthy();
    expect(fixture.store.readState().applied).toMatchObject({ version: "2026.9.4", channel: "stable" });
    expect(fixture.store.readState().applied.acceptedAt).toEqual(expect.any(Number));
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fixture.lock.getActiveOperation()).toBeNull(), { timeout: 5000 });
  }, 60_000);

  it.each([false, true])("archives and restores real SQLite and asset contents (symlink root: %s)", async (symlinkRoot) => {
    const fixture = createFixture({ symlinkRoot });
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.archive).toMatchObject({ verified: true, profile: "full" });
    assertRestored(fixture, restoreArchive(fixture, result.body.archive.file));
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(fixture.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("uses the resolved root through all three rungs and restores the minimal archive within one pause", async () => {
    const fixture = createFixture({ symlinkRoot: true });
    const run = fixture.runStream.runStreamed.getMockImplementation();
    let fullArchiveFailed = false;
    fixture.runStream.runStreamed.mockImplementation((options) => {
      if (!fullArchiveFailed && options.command === "tar" && options.args[0] === "-I") {
        fullArchiveFailed = true;
        return Promise.resolve({ ok: false, code: 2, tail: "tar: fixture write error", timedOut: false });
      }
      if (options.command === "openclaw" && options.args[0] === "backup") {
        expect(options.env.OPENCLAW_STATE_DIR).toBe(fixture.actualStateDir);
        expect(options.env.OPENCLAW_CONFIG_PATH).toBe(path.join(fixture.actualStateDir, "openclaw.json"));
        return Promise.resolve({ ok: false, code: 1, tail: "fixture upstream backup failure", timedOut: false });
      }
      return run(options);
    });
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.backup.attemptsDetail.map(({ rung }) => rung)).toEqual(["offline_copy", "upstream", "migration_minimal"]);
    expect(record.backup).toMatchObject({ profile: "migration-minimal", verified: true,
      coverage: { migration: "complete", core: "partial", workspace: "omitted" } });
    const restored = restoreArchive(fixture, record.backup.file);
    expect(restored.manifest.paths.stateDir).toBe(fixture.actualStateDir);
    expect(fs.readFileSync(path.join(restored.directory, "credentials/fixture.json")))
      .toEqual(fs.readFileSync(path.join(fixture.actualStateDir, "credentials/fixture.json")));
    const db = new DatabaseSync(path.join(restored.directory, "state/openclaw.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT value FROM fixture").get()).toEqual({ value: "retained fixture row" }); }
    finally { db.close(); }
    expect(fs.existsSync(path.join(restored.directory, "workspace/notes.md"))).toBe(false);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  });

  it("the pinned CLI writes config through a symlinked state root using canonical runtime paths", async () => {
    const fixture = createFixture({ symlinkRoot: true });
    const runtimeEnv = withOpenclawStartupEnv(fixture.env);
    expect(runtimeEnv.OPENCLAW_STATE_DIR).toBe(fixture.actualStateDir);
    expect(runtimeEnv.OPENCLAW_CONFIG_PATH).toBe(path.join(fixture.actualStateDir, "openclaw.json"));
    expect(runtimeEnv.XDG_CONFIG_HOME).toBe(fixture.actualStateDir);
    expect(fixture.env.OPENCLAW_STATE_DIR).toBe(fixture.openclawDir);
    const commands = createCommands({ gatewayEnv: () => fixture.env });
    const result = await commands.clawCmdWithBin(path.resolve("node_modules/openclaw/openclaw.mjs"),
      ["config", "set", "gateway.mode", "local"], { quiet: true, timeoutMs: 60_000 });
    expect(result.ok, result.stderr).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.actualStateDir, "openclaw.json"), "utf8")).gateway.mode).toBe("local");
    expect(fs.lstatSync(fixture.openclawDir).isSymbolicLink()).toBe(true);
  }, 90_000);

  it("drains a temporary state-database holder inside the original pause before copying", async () => {
    const listFdHolders = vi.fn(({ dbPaths }) => listFdHolders.mock.calls.length <= 3
      ? [{ pid: 4242, path: dbPaths[0] }] : []);
    const fixture = createFixture({ backupProbes: { listFdHolders } });
    write(fixture.openclawDir, ".env", "FIXTURE_ONLY=excluded\n");
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.archive.profile).toBe("full");
    assertRestored(fixture, restoreArchive(fixture, result.body.archive.file));
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  });

  it("does not publish a real archive or fall through to a live CLI when the gateway never becomes ready", async () => {
    const fixture = createFixture();
    fixture.gatewayQuiesce.start.mockImplementation(async () => {});
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    const record = fixture.sync.runLedger.readRun(result.body.operationId);
    expect(record.backup.backupFailureKind).toBe("gateway_relaunch_failed");
    expect(record.backup.verified).not.toBe(true);
    expect(fixture.sync.listBackupInventory().entries.some((entry) => entry.verified)).toBe(false);
    expect(fixture.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it.each([false, true])("scans 10,000 absolute symlinks in under five seconds and never archives .env or symlink targets (env link: %s)", async (envLink) => {
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
    expect(preflight).toMatchObject({ ok: true, blocked: false, diagnosis: { walk: "complete" } });
    expect(preflight.diagnosis.directories.absoluteSymlinkCount).toBe(envLink ? 10_001 : 10_000);
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.archive.profile, JSON.stringify(fixture.sync.runLedger.readRun(result.body.operationId).backup)).toBe("full");
    const restored = restoreArchive(fixture, result.body.archive.file);
    expect(fs.existsSync(path.join(restored.directory, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(restored.directory, "workspace", "links"))).toBe(false);
    expect(restored.manifest.assets.some((asset) => asset.sourcePath === target)).toBe(false);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    assertRestored(fixture, restored);
  }, 60_000);

  it("completes diagnostics and a real archive for 250,000 files with 200,000 excluded scratch files", async () => {
    const fixture = createFixture();
    seedFiles(fixture.openclawDir, "worktrees/scratch", 100_000);
    seedFiles(fixture.openclawDir, "workspace/.openclaw", 100_000);
    seedFiles(fixture.openclawDir, "workspace/retained", 50_000);
    const preflight = await fixture.sync.getBackupPreflight();
    expect(preflight, JSON.stringify(preflight)).toMatchObject({ ok: true, blocked: false, diagnosis: { walk: "complete", directories: { complete: true } } });
    expect(preflight.diagnosis.fileCount).toBeGreaterThanOrEqual(50_006);
    expect(preflight.diagnosis.directories.entries).toBeGreaterThanOrEqual(250_000);
    expect(preflight.diagnosis.directories.selectedEntries).toBeLessThan(60_000);
    expect(preflight.diagnosis.directories.topEntries).toEqual(expect.arrayContaining([expect.objectContaining({ path: "workspace", entries: expect.any(Number) })]));
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.archive.profile, JSON.stringify(fixture.sync.runLedger.readRun(result.body.operationId).backup)).toBe("full");
    const restored = restoreArchive(fixture, result.body.archive.file);
    expect(restored.manifest.assets.filter((asset) => asset.archivePath.startsWith("workspace/retained/"))).toHaveLength(50_000);
    expect(fs.existsSync(path.join(restored.directory, "worktrees/scratch"))).toBe(false);
    expect(fs.existsSync(path.join(restored.directory, "workspace/.openclaw"))).toBe(false);
    assertRestored(fixture, restored);
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(fixture.gatewayQuiesce.start).toHaveBeenCalledTimes(1);
  }, 180_000);

  it("blocks a genuinely excessive selected tree before stopping or invoking upstream", async () => {
    const fixture = createFixture();
    seedFiles(fixture.openclawDir, "workspace/retained", 200_001);
    const preflight = await fixture.sync.getBackupPreflight();
    expect(preflight).toMatchObject({ ok: true, blocked: true });
    expect(preflight.reason).toBeTruthy();
    expect(preflight.diagnosis.directories.complete).toBe(true);
    expect(preflight.diagnosis.directories.selectedEntries).toBeGreaterThan(200_000);
    const result = await fixture.sync.runStandaloneBackup({});
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(fixture.gatewayQuiesce.stop).not.toHaveBeenCalled();
    expect(fixture.gatewayQuiesce.start).not.toHaveBeenCalled();
    expect(upstreamCalls(fixture)).toHaveLength(0);
    expect(fixture.lock.getActiveOperation()).toBeNull();
  }, 120_000);
});
