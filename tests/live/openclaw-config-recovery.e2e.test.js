const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const live = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = live.mkTemp("alphaclaw-live-config-recovery-root-");
delete process.env.OPENCLAW_GIT_DIR;

const { createSource, sourceJournal, bootAndStop, writeFile } = require("./minimal-restore-helpers");
const { buildCliEnv } = require("./live-backup-harness");
const { readDatabaseSchema } = require("./database-fixture");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
const { hasDatabaseRecoveryCoverage } = require("../../lib/server/openclaw-recovery-coverage");
const { buildRecoveryInventory, inspectRecoveryDatabases } = require("../../lib/server/openclaw-recovery-plan");
const { writeFileAtomic } = require("../../lib/server/utils/safe-file");

const describeLive = live.kLiveEnabled ? describe : describe.skip;
const sourceVersion = "2026.9.3";
const targetVersion = "2026.9.4";
const logger = { log() {}, warn() {}, error() {} };
const valueAt = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM alphaclaw_backup_fixture WHERE id=1").get().value; }
  finally { db.close(); }
};
const assertSchemas = (source, expected) => {
  for (const [kind, file] of Object.entries(source.paths)) {
    expect(readDatabaseSchema(file)).toMatchObject({ version: expected[kind], integrity: "ok" });
    expect(valueAt(file)).toBe("captured");
  }
};
const restoreOffline = async (recovery, source) => {
  const verified = await readRecoveryCheckpoint(recovery.checkpoint.file, {
    operationId: recovery.checkpoint.operationId,
    sourceBuild: recovery.checkpoint.sourceBuild,
    targetBuild: recovery.checkpoint.targetBuild,
  });
  expect(hasDatabaseRecoveryCoverage(verified)).toBe(true);
  const config = verified.manifest.files.find((entry) => entry.archivePath === verified.manifest.configArchivePath);
  const selected = [config, ...verified.manifest.databases];
  for (const entry of selected) {
    const database = verified.manifest.databases.includes(entry);
    const target = path.join(source.stateDir, entry.archivePath);
    const saved = path.join(source.homeDir, "saved-before-restore", entry.archivePath);
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    for (const suffix of database ? ["", "-wal", "-shm", "-journal"] : [""]) {
      if (fs.existsSync(`${target}${suffix}`)) fs.renameSync(`${target}${suffix}`, `${saved}${suffix}`);
    }
    const captured = path.join(recovery.checkpoint.file, "payload", entry.archivePath);
    if (!database) writeFileAtomic(target, fs.readFileSync(captured), { mode: 0o600 });
    else {
      fs.copyFileSync(captured, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  return verified;
};

describeLive("real config-first release recovery", () => {
  let sourcePackage;
  let targetPackage;
  let source;
  beforeAll(async () => {
    live.assertFreeDiskBytes();
    sourcePackage = await live.stageOpenclawVersion(sourceVersion);
    targetPackage = await live.stageOpenclawVersion(targetVersion);
  }, 12 * 60_000);
  afterEach(() => {
    if (source) fs.rmSync(source.homeDir, { recursive: true, force: true });
    source = null;
  }, 120_000);

  const harness = () => {
    source = createSource(sourcePackage.bin);
    for (const file of Object.values(source.paths)) sourceJournal(file, "delete");
    writeFile(path.join(source.stateDir, ".env"), "RECOVERY_FIXTURE_ONLY=unchanged\n");
    const configBefore = fs.readFileSync(path.join(source.stateDir, "openclaw.json"));
    const rootDir = source.homeDir;
    writeFile(path.join(rootDir, "package.json"), JSON.stringify({ dependencies: { openclaw: sourceVersion } }));
    const installedPackage = path.join(rootDir, "node_modules", "openclaw");
    fs.mkdirSync(path.dirname(installedPackage), { recursive: true });
    fs.cpSync(sourcePackage.packageDir, installedPackage, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    const calls = [];
    const order = [];
    let gatewayRunning = true;
    const actualRunner = createRunStream({});
    const auditPath = path.join(rootDir, "cli-sql-audit.jsonl");
    const preload = path.join(rootDir, "reject-vacuum.cjs");
    writeFile(preload, `const fs=require('node:fs');const sqlite=require('node:sqlite');for(const method of ['exec','prepare']){const original=sqlite.DatabaseSync.prototype[method];sqlite.DatabaseSync.prototype[method]=function(sql,...args){if(/\\bVACUUM\\b/i.test(sql)){fs.appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({forbidden:sql})+'\\n');throw Error('Live recovery forbids hidden VACUUM');}return original.call(this,sql,...args);};}\n`);
    const runner = {
      runStreamed: async (spec) => {
        const args = spec.args || [];
        calls.push({ command: spec.command, args });
        if (spec.command === "tar" || args.includes("backup") || args.includes("preflight")) throw new Error("Real recovery journey forbids legacy backup, tar and copied database preflight");
        return actualRunner.runStreamed({ ...spec, env: live.scrubTestRunnerEnv(spec.env || buildCliEnv(source)),
          args: spec.command === process.execPath ? ["--require", preload, ...args] : args });
      },
    };
    const makeInstance = () => {
      let sync;
      const store = createOpenclawReleaseChannelStore({ rootDir, openclawDir: source.stateDir, logger });
      const lock = createGatewayLifecycleLock();
      const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => sync?.getChannelInfo() || {}, isApplyInProgress: () => sync?.isApplyInProgress() || false });
      sync = createOpenclawChannelSync({ rootDir, openclawDir: source.stateDir, packageRoot: rootDir, store,
        runStream: runner, resolveInstallDir: () => rootDir, isOnboarded: () => true,
        openclawSpawnEnv: () => buildCliEnv(source),
        installToTempDir: async ({ versionSpec }) => {
          expect(versionSpec).toBe(targetVersion);
          order.push("prepare");
          return { openclawPackageDir: targetPackage.packageDir, cleanup() {} };
        },
        gatewayQuiesce: { isRunning: async () => gatewayRunning, suppress: () => { order.push("suppress"); return "owner"; }, unsuppress: () => order.push("unsuppress"), stop: async () => { order.push("stop"); gatewayRunning = false; return true; }, start: async () => { order.push("start"); gatewayRunning = true; } },
        acquireLifecycleLock: async (kind, options) => { order.push("acquire"); return lock.acquire(kind, options); },
        gatewayMutationPolicy: policy,
        dbQuiet: async () => { order.push("quiet"); return { release() {} }; }, dbResume: () => order.push("resume"),
        backupsDir: path.join(rootDir, "recovery-checkpoints"), logger,
      });
      return { sync, store };
    };
    const first = makeInstance();
    first.store.writeSentinel({ installDir: rootDir, version: sourceVersion });
    return { ...first, makeInstance, installedPackage, configBefore, calls, order, auditPath };
  };

  const migrateAndBoot = async (h, result) => {
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const recovery = result.body.recovery;
    expect(fs.readFileSync(path.join(recovery.checkpoint.file, "payload", "openclaw.json"))).toEqual(h.configBefore);
    expect(h.order.filter((event) => event === "stop")).toHaveLength(1);
    const next = h.makeInstance();
    expect(next.sync.syncAtBoot()).toMatchObject({ ok: true, action: "activated" });
    const reconciled = await next.sync.reconcileBootConfig();
    expect(reconciled, JSON.stringify(reconciled)).toMatchObject({ status: "ok" });
    expect(h.calls.some((call) => call.args.includes("doctor") && call.args.includes("--fix"))).toBe(true);
    const targetBin = path.join(h.installedPackage, path.relative(targetPackage.packageDir, targetPackage.bin));
    live.runCliJson(targetBin, ["approvals", "get", "--json"], { env: buildCliEnv(source) });
    await bootAndStop(targetBin, source);
    assertSchemas(source, { state: 17, agent: 19 });
    expect(fs.readFileSync(path.join(source.stateDir, "workspace", "omitted.txt"), "utf8")).toBe("older workspace");
    expect(fs.readFileSync(path.join(source.stateDir, "credentials", "restore-fixture.json"), "utf8")).toBe('{"fixture":"captured"}');
    expect(fs.readFileSync(path.join(source.stateDir, ".env"), "utf8")).toBe("RECOVERY_FIXTURE_ONLY=unchanged\n");
    expect(fs.existsSync(h.auditPath)).toBe(false);
    expect(next.sync.runLedger.readRun(result.body.operationId).state).toBe("activated");
    return recovery;
  };

  it("migrates with an explicit database set, restores source files offline, and boots the matching source build", { timeout: 15 * 60_000, retry: 0 }, async () => {
    const h = harness();
    assertSchemas(source, { state: 16, agent: 19 });
    const inventory = await buildRecoveryInventory({ stateDir: source.stateDir, spawnEnv: buildCliEnv(source) });
    expect(await inspectRecoveryDatabases({ inventory, supported: { state: 17, agent: 19 } })).toMatchObject({ ok: true, compatible: true, migrationRequired: true });
    const applied = await h.sync.applyUpdate({ channel: "stable", version: targetVersion, intent: "update", recoveryMode: "database_set" });
    expect(hasDatabaseRecoveryCoverage(applied.body.recovery), JSON.stringify(applied.body)).toBe(true);
    const recovery = await migrateAndBoot(h, applied);
    expect(recovery.databases.entries).toHaveLength(2);
    expect(recovery.checkpoint.bytes).toBeLessThan(1024);
    writeFile(path.join(source.stateDir, "workspace", "omitted.txt"), "newer workspace survives selective restore");
    writeFile(path.join(source.stateDir, "credentials", "restore-fixture.json"), '{"fixture":"newer"}');
    for (const file of Object.values(source.paths)) {
      const db = new DatabaseSync(file);
      try { db.prepare("UPDATE alphaclaw_backup_fixture SET value=? WHERE id=1").run("newer target write"); }
      finally { db.close(); }
      expect(valueAt(file)).toBe("newer target write");
    }
    await restoreOffline(recovery, source);
    expect(fs.readFileSync(path.join(source.stateDir, "openclaw.json"))).toEqual(h.configBefore);
    assertSchemas(source, { state: 16, agent: 19 });
    live.runCliJson(sourcePackage.bin, ["approvals", "get", "--json"], { env: buildCliEnv(source) });
    await bootAndStop(sourcePackage.bin, source);
    assertSchemas(source, { state: 16, agent: 19 });
    expect(fs.readFileSync(path.join(source.stateDir, "workspace", "omitted.txt"), "utf8")).toBe("newer workspace survives selective restore");
    expect(fs.readFileSync(path.join(source.stateDir, "credentials", "restore-fixture.json"), "utf8")).toBe('{"fixture":"newer"}');
    expect(fs.existsSync(path.join(source.homeDir, "saved-before-restore", "state", "openclaw.sqlite"))).toBe(true);
    console.log(JSON.stringify({ configRecoveryLive: { sourceVersion, targetVersion, mode: "database_set", capturedDatabases: recovery.databases.entries.length, configBytes: recovery.checkpoint.bytes, sourceSchemas: [16, 19], targetSchemas: [17, 19], targetGatewayReady: true, restoredSourceGatewayReady: true } }));
  });

  it("migrates after explicit forward-only consent with a small config-only checkpoint", { timeout: 15 * 60_000, retry: 0 }, async () => {
    const h = harness();
    const choice = await h.sync.applyUpdate({ channel: "stable", version: targetVersion, intent: "update", consentSessionId: "isolated-live-human" });
    expect(choice).toMatchObject({ status: 409, body: { code: "recovery_choice_required", backupRiskEligible: true } });
    expect(h.order).toEqual(["prepare"]);
    const approved = await h.sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "isolated-live-human" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const applied = await h.sync.applyUpdate({ channel: "stable", version: targetVersion, intent: "update", consentSessionId: "isolated-live-human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    const recovery = await migrateAndBoot(h, applied);
    expect(recovery).toMatchObject({ kind: "forward_only", databases: { complete: false, verified: false, entries: [] }, restore: { configAvailable: true, databaseSetAvailable: false } });
    expect(hasDatabaseRecoveryCoverage(recovery)).toBe(false);
    expect(recovery.checkpoint.bytes).toBeLessThan(1024);
    expect(fs.existsSync(path.join(recovery.checkpoint.file, "payload", "state"))).toBe(false);
    expect(JSON.stringify(h.sync.runLedger.readRun(applied.body.operationId))).not.toContain(approved.body.confirmNoBackupToken);
    console.log(JSON.stringify({ configRecoveryLive: { sourceVersion, targetVersion, mode: "forward_only", capturedDatabases: 0, configBytes: recovery.checkpoint.bytes, targetSchemas: [17, 19], targetGatewayReady: true } }));
  });
});
