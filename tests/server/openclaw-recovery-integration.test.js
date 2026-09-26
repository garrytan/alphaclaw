const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { hasDatabaseRecoveryCoverage } = require("../../lib/server/openclaw-recovery-coverage");
const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { createDevCandidate } = require("../../lib/server/openclaw-dev-candidates");
const { createRepairOperation } = require("../../lib/server/repair-operation");

describe("config-first recovery at the channel service boundary", () => {
  let root;
  let sync;
  let store;
  let ledger;
  let order;
  let gateway;
  let targetSchema;
  let openclawDir;
  let runner;
  let stopHook;
  let quietHook;
  let leaseValid;
  let recoveryEnv;
  let serviceOptions;
  let gatewayRunning;
  const packageAt = (directory, version, schema) => {
    fs.mkdirSync(path.join(directory, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "openclaw", version, bin: "openclaw.mjs" }));
    fs.writeFileSync(path.join(directory, "openclaw.mjs"), `console.log(${JSON.stringify(version)});`);
    fs.writeFileSync(path.join(directory, "dist", "thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];");
    fs.writeFileSync(path.join(directory, "dist", "openclaw-state-db-schema-version-test.mjs"), `const OPENCLAW_STATE_SCHEMA_VERSION = ${schema};\nexport { OPENCLAW_STATE_SCHEMA_VERSION as O };`);
    return directory;
  };
  beforeEach(() => {
    sync = null;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-integration-"));
    openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}");
    recoveryEnv = { OPENCLAW_STATE_DIR: openclawDir };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.9.1" } }));
    packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 16);
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("PRAGMA user_version=16; CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','global',16,NULL)");
    db.close();
    targetSchema = 16;
    order = [];
    leaseValid = true;
    stopHook = null;
    quietHook = null;
    gatewayRunning = true;
    store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir, logger: { log() {}, warn() {} } });
    store.writeSentinel({ installDir: root, version: "2026.9.1" });
    ledger = createRunLedger({ openclawDir });
    gateway = {
      isRunning: async () => gatewayRunning,
      suppress: () => { order.push("suppress"); return "owner"; },
      unsuppress: () => order.push("unsuppress"),
      stop: async () => { order.push("stop"); await stopHook?.(); gatewayRunning = false; return true; },
      start: async () => { order.push("start"); gatewayRunning = true; },
    };
    runner = vi.fn(async ({ command, args }) => {
      if (command === "tar" || args?.includes("backup") || args?.includes("preflight")) throw new Error("Unexpected full backup or CLI database probe");
      if (args?.includes("--version")) {
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(args[0]), "package.json")));
        return { ok: true, tail: pkg.version };
      }
      return { ok: true, tail: "{}" };
    });
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => sync?.getChannelInfo() || {}, isApplyInProgress: () => sync?.isApplyInProgress() || false });
    serviceOptions = { rootDir: root, openclawDir, packageRoot: root, store,
      runStream: { runStreamed: runner }, resolveInstallDir: () => root, isOnboarded: () => true,
      openclawSpawnEnv: () => recoveryEnv,
      installToTempDir: async ({ versionSpec }) => {
        order.push("prepare");
        const tmpDir = fs.mkdtempSync(path.join(root, "prepared-"));
        return { tmpDir, openclawPackageDir: packageAt(path.join(tmpDir, "node_modules", "openclaw"), versionSpec, targetSchema), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
      },
      gatewayQuiesce: gateway,
      acquireLifecycleLock: async (kind, options) => { order.push("acquire"); return lock.acquire(kind, options); },
      tryAcquireLifecycleLock: (kind, options) => { order.push("try-acquire"); return lock.tryAcquire(kind, options); },
      getActiveGatewayOperation: () => lock.getActiveOperation(),
      gatewayMutationPolicy: policy,
      dbQuiet: async (options) => { order.push("quiet"); await quietHook?.(options); return { release() {} }; },
      dbResume: () => order.push("resume"),
      backupsDir: path.join(root, "backups"), diskSpace: () => ({ ok: true, free: 100e9 }),
      backupTuning: { postQuiesceReadyTimeoutMs: 30, postQuiescePollMs: 1 },
      logger: { log() {}, warn() {}, error() {} },
    };
    sync = createOpenclawChannelSync(serviceOptions);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const apply = (options = {}) => sync.applyUpdate({ channel: "stable", version: "2026.9.2", ...options });
  const holdReview = async () => {
    targetSchema = 17;
    const choice = await apply({ consentSessionId: "human" });
    const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
    stopHook = () => fs.writeFileSync(path.join(openclawDir, "openclaw.json"), '{"changed":true}');
    const held = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    stopHook = null;
    expect(held.body, JSON.stringify(held.body)).toMatchObject({ code: "recovery_choice_required", gatewayHeld: true });
    return held;
  };

  it("prepares first and captures config without walking scratch or copying a multi-GB database", async () => {
    fs.mkdirSync(path.join(openclawDir, "workspace", "scratch"), { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "workspace", "scratch", "untouched"), "not recovery payload");
    fs.truncateSync(path.join(openclawDir, "state", "openclaw.sqlite"), 3 * 1024 ** 3);
    const preview = await sync.getBackupPreflight();
    expect(preview).toMatchObject({ blocked: false, profile: "config_only", checkpoint: { bytes: 2, fileCount: 1 }, databaseBytes: 3 * 1024 ** 3 });
    const result = await apply();
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.recovery).toMatchObject({ kind: "config_only", restore: { configAvailable: true, databaseSetAvailable: false } });
    expect(order).toEqual(["prepare", "acquire", "suppress", "stop", "quiet"]);
    expect(ledger.readRun(result.body.operationId).recovery.kind).toBe("config_only");
    expect(fs.existsSync(path.join(result.body.recovery.checkpoint.file, "payload", "state", "openclaw.sqlite"))).toBe(false);
  });

  it("offers migration choices before acquiring or stopping", async () => {
    targetSchema = 17;
    const result = await apply({ consentSessionId: "human" });
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body).toMatchObject({ code: "recovery_choice_required", backupRiskEligible: true, choices: ["database_set", "forward_only", "cancel"] });
    expect(order).toEqual(["prepare"]);
    expect(store.readState().applied).toBeNull();
  });

  it("preserves the exact recovery retry contract across ledger reload", async () => {
    targetSchema = 17;
    const result = await apply({ consentSessionId: "human", intent: "update", expectLatest: true });
    expect(result.body.code).toBe("recovery_choice_required");
    expect(result.body.target).toEqual({ channel: "stable", version: "2026.9.2" });
    const reloaded = createRunLedger({ openclawDir }).readRun(result.body.operationId);
    expect(reloaded).toMatchObject({ intent: "update", expectLatest: true, recoveryMode: "config_only",
      target: result.body.target, result: { target: result.body.target, recoveryMode: "config_only" } });
  });

  it.each([true, false])("isolates native dev preparation and doctor before recovery choice (head: %s)", async (devHead) => {
    const sha = "a".repeat(40);
    const checkout = packageAt(path.join(root, "openclaw"), "0.0.0-dev", 17);
    fs.mkdirSync(path.join(checkout, ".git"));
    fs.writeFileSync(path.join(checkout, ".git", "HEAD"), sha);
    const configBefore = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    const databaseBefore = fs.readFileSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    const nativeEnvironments = [];
    const original = runner.getMockImplementation();
    runner.mockImplementation(async (options) => {
      if (options.env?.OPENCLAW_GIT_DIR && !options.args?.includes("--version")) {
        const env = options.env;
        nativeEnvironments.push(env);
        expect(env.OPENCLAW_GIT_DIR.startsWith(`${checkout}-candidates/`)).toBe(true);
        if (options.args[0] === "clone") {
          expect(options.args.at(-1)).toBe(env.OPENCLAW_GIT_DIR);
          packageAt(env.OPENCLAW_GIT_DIR, "0.0.0-dev", 17);
          fs.mkdirSync(path.join(env.OPENCLAW_GIT_DIR, ".git"));
          fs.writeFileSync(path.join(env.OPENCLAW_GIT_DIR, ".git", "HEAD"), sha);
        }
        expect(env.OPENCLAW_STATE_DIR.startsWith(openclawDir)).toBe(false);
        expect(env.OPENCLAW_CONFIG_PATH).not.toBe(path.join(openclawDir, "openclaw.json"));
        expect(env.OPENCLAW_AGENT_DIR.startsWith(env.OPENCLAW_STATE_DIR)).toBe(true);
        expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"))).toBe(false);
        fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"nativeDoctorWrote":true}');
        fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "candidate-snapshot"), "only isolated state");
        return { ok: true, tail: JSON.stringify({ status: "ok" }) };
      }
      return original(options);
    });
    const result = await sync.applyUpdate({ channel: "dev", ...(devHead ? { devHead: true } : { sha }) });
    expect(result.body.code, JSON.stringify(result.body)).toBe("recovery_choice_required");
    expect(result.body.target).toEqual({ channel: "dev", sha });
    expect(nativeEnvironments).toHaveLength(devHead ? 6 : 7);
    expect(fs.existsSync(nativeEnvironments[0].HOME)).toBe(false);
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(configBefore);
    expect(fs.readFileSync(path.join(openclawDir, "state", "openclaw.sqlite"))).toEqual(databaseBefore);
    expect(order).not.toContain("stop");
  });

  it("prepares active dev A to B without mutating A, reuses B for review, and activates only its shim at boot", async () => {
    const oldSha = "a".repeat(40);
    const nextSha = "b".repeat(40);
    const active = packageAt(path.join(root, "openclaw"), "2026.9.1", 16);
    fs.mkdirSync(path.join(active, ".git"));
    fs.writeFileSync(path.join(active, ".git", "HEAD"), oldSha);
    store.updateState((state) => ({ ...state, applied: { channel: "dev", sha: oldSha, checkoutDir: active } }));
    store.writeBinShim({ targetBin: path.join(active, "openclaw.mjs"), label: "dev A" });
    const original = runner.getMockImplementation();
    let builds = 0;
    runner.mockImplementation(async (options) => {
      if (options.command === "git" && options.args[0] === "clone") {
        builds++;
        const target = options.env.OPENCLAW_GIT_DIR;
        expect(target).not.toBe(active);
        packageAt(target, "2026.9.2", 17);
        fs.mkdirSync(path.join(target, ".git"));
        fs.writeFileSync(path.join(target, ".git", "HEAD"), nextSha);
        return { ok: true, tail: '{"status":"ok"}' };
      }
      return original(options);
    });
    const choice = await sync.applyUpdate({ channel: "dev", sha: nextSha, consentSessionId: "human" });
    expect(choice.body, JSON.stringify(choice.body)).toMatchObject({ code: "recovery_choice_required", target: { channel: "dev", sha: nextSha } });
    const candidate = ledger.readRun(choice.body.operationId).target.checkoutDir;
    expect(candidate.startsWith(`${active}-candidates/`)).toBe(true);
    expect(fs.readFileSync(path.join(active, ".git", "HEAD"), "utf8")).toBe(oldSha);
    expect((await sync.getExecutingBuild()).buildId).toBe(oldSha);
    expect(store.readState().applied.sha).toBe(oldSha);
    const repeated = await sync.applyUpdate({ channel: "dev", sha: nextSha, consentSessionId: "human" });
    expect(repeated.body.code).toBe("recovery_choice_required");
    expect(ledger.readRun(repeated.body.operationId).target.checkoutDir).toBe(candidate);
    expect(builds).toBe(1);
    expect(order).not.toContain("stop");
    const approved = await sync.requestBackupRiskConsent({ operationId: repeated.body.operationId, consentSessionId: "human" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const applied = await sync.applyUpdate({ channel: "dev", sha: nextSha, consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect(builds).toBe(1);
    expect((await sync.getExecutingBuild()).buildId).toBe(oldSha);
    expect(store.readState()).toMatchObject({ applied: { sha: nextSha, checkoutDir: candidate }, previousDev: { sha: oldSha, checkoutDir: active } });
    expect(sync.syncAtBoot()).toMatchObject({ action: "dev_shim" });
    expect((await sync.getExecutingBuild())).toMatchObject({ buildId: nextSha, packageDir: candidate });
    expect(fs.readFileSync(path.join(active, ".git", "HEAD"), "utf8")).toBe(oldSha);
    sync.markGoodNow();
    expect(store.readState().lastKnownGood).toMatchObject({ dev: nextSha, devCheckoutDir: candidate });
  });

  it("repairs the actual active dev candidate in place while isolating native state writes", async () => {
    const legacy = packageAt(path.join(root, "openclaw"), "2026.9.1", 16);
    const candidate = createDevCandidate({ checkoutDir: legacy }).checkoutDir;
    packageAt(candidate, "2026.9.2", 16);
    const sha = "b".repeat(40);
    fs.mkdirSync(path.join(candidate, ".git"));
    fs.writeFileSync(path.join(candidate, ".git", "HEAD"), sha);
    store.updateState((state) => ({ ...state, applied: { channel: "dev", sha, checkoutDir: candidate } }));
    store.writeBinShim({ targetBin: path.join(candidate, "openclaw.mjs"), label: "dev B" });
    const before = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    let repairEnv;
    runner.mockImplementation(async ({ args, env }) => {
      expect(args).toContain("repair");
      repairEnv = env;
      expect(env.OPENCLAW_GIT_DIR).toBe(candidate);
      expect(env.OPENCLAW_STATE_DIR.startsWith(openclawDir)).toBe(false);
      fs.writeFileSync(path.join(candidate, "repaired"), "explicit repair");
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"repairWrote":true}');
      return { ok: true, tail: '{"status":"ok"}' };
    });
    expect(await sync.runUpdateRepair()).toMatchObject({ status: 200, body: { ok: true } });
    expect(fs.existsSync(path.join(candidate, "repaired"))).toBe(true);
    expect(fs.existsSync(path.join(legacy, "repaired"))).toBe(false);
    expect(fs.existsSync(repairEnv.HOME)).toBe(false);
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(before);
  });

  it("bounds abandoned candidates while preserving active, previous, LKG, live approval and pending handoff paths", async () => {
    const legacy = path.join(root, "openclaw");
    const candidate = () => createDevCandidate({ checkoutDir: legacy }).checkoutDir;
    const active = packageAt(candidate(), "2026.9.1", 16);
    const oldSha = "a".repeat(40);
    fs.mkdirSync(path.join(active, ".git"));
    fs.writeFileSync(path.join(active, ".git", "HEAD"), oldSha);
    store.updateState((state) => ({ ...state, pinVersion: "2026.9.1", applied: { channel: "dev", sha: oldSha, checkoutDir: active } }));
    store.writeBinShim({ targetBin: path.join(active, "openclaw.mjs"), label: "active A" });
    const original = runner.getMockImplementation();
    runner.mockImplementation(async (options) => {
      if (options.command === "git" && options.args[0] === "clone") {
        const dir = options.args.at(-1);
        packageAt(dir, "2026.9.2", 17);
        fs.mkdirSync(path.join(dir, ".git"));
        fs.writeFileSync(path.join(dir, ".git", "HEAD"), "b".repeat(40));
      }
      return original(options);
    });
    const choice = await sync.applyUpdate({ channel: "dev", sha: "b".repeat(40), consentSessionId: "human" });
    expect(choice.body.code).toBe("recovery_choice_required");
    const offered = ledger.readRun(choice.body.operationId).target.checkoutDir;
    const previous = candidate();
    const knownGood = candidate();
    const pending = candidate();
    store.updateState((state) => ({ ...state, previousDev: { sha: "c".repeat(40), checkoutDir: previous },
      lastKnownGood: { ...state.lastKnownGood, dev: "d".repeat(40), devCheckoutDir: knownGood } }));
    const operationId = "00000000-0000-0000-0000-000000000071";
    ledger.createRun({ operationId, target: { channel: "dev", sha: "e".repeat(40), checkoutDir: pending } });
    ledger.completeRun(operationId, { state: "restart_expected", ok: true, result: { ok: true } });
    const abandoned = Array.from({ length: 6 }, (_, index) => {
      const directory = candidate();
      const at = new Date(Date.now() + (index + 1) * 1000);
      fs.utimesSync(directory, at, at);
      return directory;
    });
    targetSchema = 17;
    expect((await apply({ consentSessionId: "human" })).body.code).toBe("recovery_choice_required");
    for (const directory of [active, previous, knownGood, pending, offered]) expect(fs.existsSync(directory), directory).toBe(true);
    expect(abandoned.map((directory) => fs.existsSync(directory))).toEqual([false, false, false, true, true, true]);
    expect((await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" })).status).toBe(200);
    expect(order).not.toContain("stop");
  });

  it("captures the explicitly selected complete database set in a single pause", async () => {
    targetSchema = 17;
    const result = await apply({ recoveryMode: "database_set" });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(hasDatabaseRecoveryCoverage(result.body.recovery)).toBe(true);
    expect(order.filter((step) => step === "stop")).toHaveLength(1);
    expect(order).not.toContain("start");
  });

  it.each(["restart_failure", "foreign_hold", "lease_loss"])("keeps a committed handoff fenced after %s", async (failure) => {
    let successor;
    try {
      let ownedLease;
      const acquire = serviceOptions.acquireLifecycleLock;
      serviceOptions.acquireLifecycleLock = async (...args) => { ownedLease = await acquire(...args); return ownedLease; };
      serviceOptions.restartProcess = vi.fn(async () => { throw new Error("restart failed"); });
      sync = createOpenclawChannelSync(serviceOptions);
      const applied = await apply();
      expect(applied.status, JSON.stringify(applied.body)).toBe(202);
      if (failure === "foreign_hold") store.updateState((state) => ({ ...state, gatewayHold: { reason: "successor_hold" } }));
      if (failure === "lease_loss") { ownedLease(); successor = await acquire("operator_successor"); }
      const previousHold = store.readState().gatewayHold;
      await vi.waitFor(() => expect(ledger.readRun(applied.body.operationId).result.restartRequired).toBe(true), { timeout: 4000 });
      expect(sync.isApplyInProgress()).toBe(true);
      expect(order).not.toContain("start");
      expect(ledger.readRun(applied.body.operationId)).toMatchObject({ state: "restart_expected", result: { restartRequired: true } });
      if (failure === "restart_failure") expect(store.readState().gatewayHold).toMatchObject({ reason: "recovery_restart_required" });
      else expect(store.readState().gatewayHold).toEqual(previousHold);
      if (successor) expect(successor.isValid()).toBe(true);
    } finally { successor?.(); }
  });

  it("retains the original typed cause when the old gateway also fails to resume", async () => {
    stopHook = () => fs.writeFileSync(path.join(openclawDir, "openclaw.json"), '{"changed":true}');
    gateway.start = async () => { throw new Error("private startup failure"); };
    const failed = await apply();
    expect(failed).toMatchObject({ status: 409, body: { code: "gateway_relaunch_failed" } });
    expect(failed.body.hint).toContain("apply_facts_changed");
    expect(failed.body.message).not.toContain("private startup failure");
    expect(ledger.readRun(store.readState().lastUpdateRun.operationId).result).toMatchObject({ code: "gateway_relaunch_failed", hint: failed.body.hint });
    expect(store.readState().lastUpdateRun.result.hint).toBe(failed.body.hint);
  });

  it("records single-use human forward-only consent without inventing backup failures", async () => {
    targetSchema = 17;
    const choice = await apply({ consentSessionId: "human" });
    const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const result = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.recovery).toMatchObject({ kind: "forward_only", consent: { recorded: true, required: true } });
    const record = ledger.readRun(result.body.operationId);
    expect(record.backup).toBeNull();
    expect(record.recoveryIntent).toMatchObject({ approved: true, migrationRequired: true });
    expect(JSON.stringify(record)).not.toContain(approved.body.confirmNoBackupToken);
    const again = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(again.body.code).toBe("backup_consent_required");
  });

  it("parks stale post-stop approval and safely resumes only when the human cancels", async () => {
    targetSchema = 17;
    const choice = await apply({ consentSessionId: "human" });
    const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
    stopHook = () => fs.writeFileSync(path.join(openclawDir, "openclaw.json"), '{"changed":true}');
    const result = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(result.body).toMatchObject({ code: "recovery_choice_required", gatewayHeld: true, backupRiskEligible: true });
    expect(store.readState().applied).toBeNull();
    expect(order).not.toContain("start");
    const cancelled = await sync.cancelRecoveryReview({ operationId: result.body.operationId });
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ status: 200, body: { resumed: true } });
    expect(store.readState().gatewayHold).toBeNull();
    expect(ledger.readRun(result.body.operationId).recoveryReview).toMatchObject({ active: false, cancelled: true });
    expect(order.filter((step) => step === "start")).toHaveLength(1);
  });

  it("binds human approval to the selected config and logical state root", async () => {
    targetSchema = 17;
    const actualRoot = path.join(root, "actual-state");
    fs.renameSync(openclawDir, actualRoot);
    fs.symlinkSync(actualRoot, openclawDir);
    const configPath = path.join(openclawDir, "openclaw.json");
    recoveryEnv.OPENCLAW_CONFIG_PATH = configPath;
    const choice = await apply({ consentSessionId: "human" });
    expect(choice.body.code, JSON.stringify(choice.body)).toBe("recovery_choice_required");
    const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    fs.writeFileSync(configPath, '{"changed":true}');
    const result = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(result.body.code).toBe("backup_consent_required");
    expect(order).not.toContain("stop");
    expect(store.readState().applied).toBeNull();
  });

  it("refuses unsupported selected config paths before orchestration writers while preserving both files", async () => {
    const custom = path.join(openclawDir, "custom.json");
    fs.writeFileSync(custom, '{"selected":true}');
    recoveryEnv.OPENCLAW_CONFIG_PATH = custom;
    const normalizeBootConfig = vi.fn();
    expect(await sync.getBackupPreflight()).toMatchObject({ blocked: true, reason: "RECOVERY_INVENTORY_UNSUPPORTED" });
    const applied = await apply();
    expect(applied).toMatchObject({ status: 409, body: { code: "RECOVERY_INVENTORY_UNSUPPORTED" } });
    expect(await sync.reconcileBootConfig({ normalizeBootConfig })).toMatchObject({ status: "held", hold: { reason: "RECOVERY_INVENTORY_UNSUPPORTED" } });
    expect(normalizeBootConfig).not.toHaveBeenCalled();
    expect(runner.mock.calls.some(([call]) => call.args?.includes("doctor"))).toBe(false);
    expect(order).not.toContain("stop");
    expect(fs.readFileSync(custom, "utf8")).toBe('{"selected":true}');
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).toBe("{}");
    expect(recoveryEnv.OPENCLAW_CONFIG_PATH).toBe(custom);
  });

  it("refuses a CLI state root different from the writer root without changing either config or database", async () => {
    const selected = path.join(root, "separate-state");
    fs.mkdirSync(path.join(selected, "state"), { recursive: true });
    fs.writeFileSync(path.join(selected, "openclaw.json"), '{"selectedRoot":true}');
    const sourceDb = path.join(openclawDir, "state", "openclaw.sqlite");
    const selectedDb = path.join(selected, "state", "openclaw.sqlite");
    fs.copyFileSync(sourceDb, selectedDb);
    const originalBytes = fs.readFileSync(sourceDb);
    recoveryEnv.OPENCLAW_STATE_DIR = selected;
    const normalizeBootConfig = vi.fn();
    expect(sync.getBackupSourceContext().stateDir).toBe(selected);
    expect(await sync.getBackupPreflight()).toMatchObject({ blocked: true, reason: "RECOVERY_INVENTORY_UNSUPPORTED" });
    expect(await apply()).toMatchObject({ status: 409, body: { code: "RECOVERY_INVENTORY_UNSUPPORTED" } });
    expect(await sync.reconcileBootConfig({ normalizeBootConfig })).toMatchObject({ status: "held" });
    expect(normalizeBootConfig).not.toHaveBeenCalled();
    expect(runner.mock.calls.some(([call]) => call.args?.includes("doctor"))).toBe(false);
    expect(order).not.toContain("stop");
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8")).toBe("{}");
    expect(fs.readFileSync(path.join(selected, "openclaw.json"), "utf8")).toBe('{"selectedRoot":true}');
    expect(fs.readFileSync(sourceDb)).toEqual(originalBytes);
    expect(fs.readFileSync(selectedDb)).toEqual(originalBytes);
    expect(recoveryEnv.OPENCLAW_STATE_DIR).toBe(selected);
  });

  it("requires fresh post-stop approval after real WAL shutdown and commits without a second stop", async () => {
    targetSchema = 17;
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES ('committed before consent')");
    let closed = false;
    try {
      const choice = await apply({ consentSessionId: "human" });
      const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
      expect(approved.status).toBe(200);
      stopHook = () => { db.close(); closed = true; };
      const result = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
      expect(result.body, JSON.stringify(result.body)).toMatchObject({ code: "recovery_choice_required", gatewayHeld: true, backupRiskEligible: true });
      expect(store.readState().applied).toBeNull();
      expect(order).not.toContain("start");
      const stale = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
      expect(stale.status).toBe(409);
      const fresh = await sync.requestBackupRiskConsent({ operationId: result.body.operationId, consentSessionId: "human" });
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      const committed = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: fresh.body.confirmNoBackupToken });
      expect(committed.status, JSON.stringify(committed.body)).toBe(202);
      expect(order.filter((step) => step === "stop")).toHaveLength(1);
      expect(order).not.toContain("start");
      expect(store.readState().gatewayHold).toBeNull();
      expect(ledger.readRun(result.body.operationId).recoveryReview.active).toBe(false);
    } finally { if (!closed) db.close(); }
  });

  it("never rebinds the cancellation source to a build changed by shutdown", async () => {
    targetSchema = 17;
    const choice = await apply({ consentSessionId: "human" });
    const approved = await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" });
    stopHook = () => fs.appendFileSync(path.join(root, "node_modules", "openclaw", "openclaw.mjs"), "changed");
    const held = await apply({ consentSessionId: "human", confirmNoBackup: true, confirmNoBackupToken: approved.body.confirmNoBackupToken });
    expect(held.body).toMatchObject({ code: "recovery_source_changed", gatewayHeld: true });
    expect(held.body.backupRiskEligible).not.toBe(true);
    expect((await sync.cancelRecoveryReview({ operationId: held.body.operationId })).body.code).toBe("recovery_source_changed");
    expect((await sync.requestBackupRiskConsent({ operationId: choice.body.operationId, consentSessionId: "human" })).status).toBe(409);
    expect(order).not.toContain("start");
  });

  it("preserves the held review across boot and reoffers lost tokens without another stop", async () => {
    const held = await holdReview();
    const config = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    sync = createOpenclawChannelSync(serviceOptions);
    sync.syncAtBoot();
    const reconciled = await sync.reconcileBootConfig();
    expect(reconciled).toMatchObject({ status: "held", hold: { reason: "recovery_review" } });
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(config);
    expect(runner.mock.calls.some(([call]) => call.args?.includes("doctor"))).toBe(false);
    const refreshed = await apply({ consentSessionId: "human" });
    expect(refreshed.body, JSON.stringify(refreshed.body)).toMatchObject({ code: "recovery_choice_required", gatewayHeld: true, backupRiskEligible: true });
    expect(ledger.readRun(held.body.operationId).recoveryReview.active).toBe(false);
    expect(store.readState().gatewayHold.operationId).toBe(refreshed.body.operationId);
    expect((await sync.requestBackupRiskConsent({ operationId: refreshed.body.operationId, consentSessionId: "human" })).status).toBe(200);
    expect((await sync.cancelRecoveryReview({ operationId: refreshed.body.operationId })).status).toBe(200);
    expect(order.filter((step) => step === "stop")).toHaveLength(1);
    expect(order.filter((step) => step === "start")).toHaveLength(1);
  });

  it.each(["build", "root"])("refuses both held apply and cancellation when the original %s changes", async (changed) => {
    const held = await holdReview();
    if (changed === "build") fs.appendFileSync(path.join(root, "node_modules", "openclaw", "openclaw.mjs"), "changed");
    else {
      const replacement = path.join(root, "replacement-state");
      fs.mkdirSync(path.join(replacement, "state"), { recursive: true });
      fs.copyFileSync(path.join(openclawDir, "openclaw.json"), path.join(replacement, "openclaw.json"));
      fs.copyFileSync(path.join(openclawDir, "state", "openclaw.sqlite"), path.join(replacement, "state", "openclaw.sqlite"));
      recoveryEnv.OPENCLAW_STATE_DIR = replacement;
    }
    const before = store.readState().gatewayHold;
    expect((await apply({ recoveryMode: "database_set", consentSessionId: "human" })).body.code).toBe("recovery_source_changed");
    const cancelled = await sync.cancelRecoveryReview({ operationId: held.body.operationId });
    expect(cancelled.body.code).toBe("recovery_source_changed");
    expect(cancelled.body.hint).not.toMatch(/choose.*target/i);
    expect(store.readState().gatewayHold).toEqual(before);
    expect(order.filter((step) => step === "stop")).toHaveLength(1);
    expect(order).not.toContain("start");
  });

  it.each(["stale", "foreign", "source", "incompatible", "corrupt", "running", "lease", "shutdown"])("does not resume or clear a review after %s cancellation refusal", async (scenario) => {
    const held = await holdReview();
    let operationId = held.body.operationId;
    if (scenario === "stale") operationId = "wrong-operation";
    if (scenario === "foreign") store.updateState((state) => ({ ...state, gatewayHold: { ...state.gatewayHold, reason: "other_owner" } }));
    if (scenario === "source") fs.appendFileSync(path.join(root, "node_modules", "openclaw", "openclaw.mjs"), "changed");
    if (scenario === "incompatible") {
      const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
      db.exec("PRAGMA user_version=999; UPDATE schema_meta SET schema_version=999");
      db.close();
    }
    if (scenario === "corrupt") fs.writeFileSync(path.join(openclawDir, "state", "openclaw.sqlite"), "not a database");
    if (scenario === "running") gatewayRunning = true;
    if (scenario === "shutdown") gateway.isCancelled = () => true;
    if (scenario === "lease") {
      const acquire = serviceOptions.acquireLifecycleLock;
      serviceOptions.acquireLifecycleLock = async (...args) => { const release = await acquire(...args); release(); return release; };
      sync = createOpenclawChannelSync(serviceOptions);
    }
    const expectedHold = store.readState().gatewayHold;
    const cancelled = await sync.cancelRecoveryReview({ operationId });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(409);
    expect(store.readState().gatewayHold).toEqual(expectedHold);
    expect(order).not.toContain("start");
    expect(ledger.readRun(held.body.operationId).recoveryReview.active).toBe(true);
  });

  it.each(["throw", "not_ready"])("retains a recoverable review when cancellation relaunch is %s", async (failure) => {
    const held = await holdReview();
    const expectedHold = store.readState().gatewayHold;
    gateway.start = async () => { order.push("start"); if (failure === "throw") throw new Error("relaunch failed"); };
    const cancelled = await sync.cancelRecoveryReview({ operationId: held.body.operationId });
    expect(cancelled.status).toBe(409);
    if (failure === "not_ready") expect(cancelled.body.code).toBe("gateway_relaunch_failed");
    expect(store.readState().gatewayHold).toEqual(expectedHold);
    expect(ledger.readRun(held.body.operationId).recoveryReview.active).toBe(true);
    gateway.start = async () => { gatewayRunning = true; };
    expect((await sync.cancelRecoveryReview({ operationId: held.body.operationId })).status).toBe(200);
  });

  it.each([false, true])("does not rewrite lifecycle state after cancellation loses its lease (successor: %s)", async (successor) => {
    const held = await holdReview();
    const expectedReview = store.readState().recoveryReview;
    let successorState = null;
    let release;
    const acquire = serviceOptions.acquireLifecycleLock;
    serviceOptions.acquireLifecycleLock = async (...args) => { release = await acquire(...args); return release; };
    sync = createOpenclawChannelSync(serviceOptions);
    gateway.start = async () => {
      expect(store.readState().gatewayHold).toEqual(expectedReview.hold);
      expect(store.readState().recoveryReview).toEqual(expectedReview);
      release();
      if (successor) store.updateState((state) => ({ ...state, gatewayHold: { reason: "successor_hold" }, recoveryReview: null }));
      successorState = store.readState();
    };
    const cancelled = await sync.cancelRecoveryReview({ operationId: held.body.operationId });
    expect(cancelled.status).toBe(409);
    expect(store.readState()).toEqual(successorState);
    expect(order.filter((step) => step === "stop")).toHaveLength(1);
    if (!successor) {
      expect(store.readState().recoveryReview).toEqual(expectedReview);
      sync = createOpenclawChannelSync(serviceOptions);
      expect(sync.syncAtBoot()).toMatchObject({ action: "held" });
      expect(store.readState().gatewayHold).toEqual(expectedReview.hold);
      expect(await sync.reconcileBootConfig()).toMatchObject({ status: "held" });
      gateway.start = async () => { gatewayRunning = true; };
      expect((await sync.cancelRecoveryReview({ operationId: held.body.operationId })).status).toBe(200);
    }
  });

  it("holds a boot-initiated pin migration before doctor or config mutation", async () => {
    packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 17);
    const before = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    const normalizeBootConfig = vi.fn();
    const result = await sync.reconcileBootConfig({ normalizeBootConfig });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "held", hold: { reason: "recovery_choice_required" } });
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(before);
    expect(runner.mock.calls.some(([call]) => call.args?.includes("doctor"))).toBe(false);
    expect(normalizeBootConfig).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses unapproved runtime migration even when the installed tree matches (same tree: %s)", async (sameTree) => {
    if (sameTree) {
      packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 17);
      store.updateState((state) => ({ ...state, pinVersion: "2026.9.1" }));
    }
    else {
      const candidate = packageAt(path.join(root, "runtime-target"), "2026.9.2", 17);
      store.saveOverlayFromTempInstall({ openclawPackageDir: candidate, version: "2026.9.2" });
      store.updateState((state) => ({ ...state, pinVersion: "2026.9.2" }));
    }
    const result = await sync.reconcileInstalled({ source: "operator", relaunch: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, action: "none", code: "recovery_choice_required" });
    expect(order).not.toContain("stop");
    expect(order).not.toContain("start");
    expect(JSON.parse(fs.readFileSync(path.join(root, "node_modules", "openclaw", "package.json"))).version).toBe("2026.9.1");
  });

  it.each([false, true])("allows same-build database protection instead of a no-op (durable runtime hold: %s)", async (runtimeHold) => {
    packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 17);
    targetSchema = 17;
    store.updateState((state) => ({ ...state, pinVersion: "2026.9.1" }));
    if (runtimeHold) {
      const verdict = await sync.assessInstalledLaunchCompatibility();
      expect(await sync.holdRecoveryChoice({ verdict })).toMatchObject({ ok: true, hold: { reason: "recovery_choice_required", installed: "2026.9.1" } });
      expect(sync.getChannelInfo().gatewayHold.reason).toBe("recovery_choice_required");
      expect(order).not.toContain("stop");
    }
    const result = await apply({ version: "2026.9.1", intent: "switch", recoveryMode: "database_set" });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.noop).not.toBe(true);
    expect(hasDatabaseRecoveryCoverage(result.body.recovery)).toBe(true);
    expect(ledger.readRun(result.body.operationId).recoveryIntent).toMatchObject({ approved: true, migrationRequired: true });
  });

  it.each(["stale_build", "foreign_hold", "busy", "expired", "caller_owned"])("records runtime recovery holds only with current build and ownership (%s)", async (scenario) => {
    packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 17);
    const verdict = await sync.assessInstalledLaunchCompatibility();
    let hold;
    if (scenario === "stale_build") packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.2", 17);
    if (scenario === "foreign_hold") store.updateState((state) => ({ ...state, gatewayHold: { reason: "other_owner" } }));
    if (["busy", "expired", "caller_owned"].includes(scenario)) hold = await serviceOptions.acquireLifecycleLock("watchdog");
    if (scenario === "expired") hold();
    const before = store.readState();
    try {
      const result = await sync.holdRecoveryChoice({ verdict, hold: scenario === "busy" ? null : hold });
      if (scenario === "caller_owned") {
        expect(result).toMatchObject({ ok: true });
        expect(hold.isValid()).toBe(true);
        expect(order).not.toContain("try-acquire");
      } else {
        expect(result.ok).toBe(false);
        expect(store.readState()).toEqual(before);
      }
      expect(order).not.toContain("stop");
      expect(order).not.toContain("start");
    } finally { hold?.(); }
  });

  it("does not select a migration-requiring runtime fallback", async () => {
    for (const [version, schema] of [["2026.9.2", 15], ["2026.9.3", 17]]) {
      const candidate = packageAt(path.join(root, version), version, schema);
      store.saveOverlayFromTempInstall({ openclawPackageDir: candidate, version });
    }
    store.updateState((state) => ({ ...state, pinVersion: "2026.9.2", lastKnownGood: { ...state.lastKnownGood, package: "2026.9.3" } }));
    const result = await sync.reconcileInstalled({ source: "operator", relaunch: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, action: "none", code: "no_bootable_version" });
    expect(order).not.toContain("stop");
    expect(order).not.toContain("start");
  });

  it("selects a proven non-migrating doctor binary rather than a newer migration target", async () => {
    const candidate = packageAt(path.join(root, "doctor-target"), "2026.9.2", 17);
    store.saveOverlayFromTempInstall({ openclawPackageDir: candidate, version: "2026.9.2" });
    store.updateState((state) => ({ ...state, pinVersion: "2026.9.2" }));
    expect(await sync.compatibleBinForCurrentDb()).toMatchObject({ version: "2026.9.1", packageDir: path.join(root, "node_modules", "openclaw"),
      compatible: true, migrationRequired: false });
    packageAt(path.join(root, "node_modules", "openclaw"), "2026.9.1", 17);
    expect(await sync.compatibleBinForCurrentDb()).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses candidate execution and cleans staging when probe-home creation fails", async () => {
    const mkTemp = fs.mkdtempSync.bind(fs);
    const spy = vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix, ...args) => {
      if (String(prefix).includes("openclaw-probe-home-")) throw Object.assign(new Error("private disk detail"), { code: "ENOSPC" });
      return mkTemp(prefix, ...args);
    });
    try {
      const result = await apply();
      expect(result).toMatchObject({ status: 409, body: { code: "candidate_probe_isolation_failed" } });
      expect(runner.mock.calls.some(([call]) => call.args?.includes("--version"))).toBe(false);
      expect(fs.readdirSync(root).some((name) => name.startsWith("prepared-"))).toBe(false);
      expect(order).not.toContain("stop");
      expect(result.body.message).not.toContain("private disk detail");
    } finally { spy.mockRestore(); }
  });

  it("validates a migrating handoff before bin and server boot config normalizations", async () => {
    targetSchema = 17;
    const result = await apply({ recoveryMode: "database_set" });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const captured = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
    gateway.isRunning = async () => false;
    sync.syncAtBoot();
    expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(captured);
    const started = vi.fn();
    const mutateAfterGate = vi.fn(() => {
      order.push("normalize");
      const config = JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json")));
      config.gateway = { controlUi: { basePath: "/openclaw" } };
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(config));
    });
    const hold = () => {};
    hold.isValid = () => true;
    const normalizeBootConfig = vi.fn(({ assertLease }) => {
      assertLease();
      expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(captured);
      order.push("normalize-before-doctor");
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), '{"normalizedAfterApproval":true}');
    });
    await runOnboardedBootSequence({ acquireLifecycleLock: async () => hold,
      reportLockContentionAtBoot: () => {},
      reconcileBootConfig: async (options) => { order.push("reconcile"); return sync.reconcileBootConfig({ ...options, normalizeBootConfig }); },
      ensureManagedExecDefaults: () => {}, ensureUsageTrackerPluginConfig: () => {},
      ensureWebhookMappingIds: () => null, doSyncPromptFiles: () => {}, reloadEnv: () => {},
      syncChannelConfig: () => {}, readEnvFile: () => [], ensureGatewayProxyConfig: mutateAfterGate,
      resolveSetupUrl: () => "http://localhost", startGateway: started,
      watchdog: { start() {} }, gmailWatchService: { start() {} },
    });
    expect(started, JSON.stringify(store.readState().gatewayHold)).toHaveBeenCalledOnce();
    expect(order.indexOf("reconcile")).toBeLessThan(order.indexOf("normalize"));
    expect(normalizeBootConfig).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(result.body.recovery.checkpoint.file, "payload", "openclaw.json"))).toEqual(captured);
    expect(ledger.readRun(result.body.operationId).state).toBe("activated");
  });

  it("does not rewrite a successor hold when the boot normalization loses its lease", async () => {
    gatewayRunning = false;
    let valid = true;
    const hold = () => {};
    hold.isValid = () => valid;
    const operation = createRepairOperation({ isCurrent: () => valid });
    let successorState;
    const result = await sync.reconcileBootConfig({ hold, operation, normalizeBootConfig: async ({ assertLease }) => {
      assertLease();
      store.updateState((state) => ({ ...state, gatewayHold: { reason: "successor_owned" } }));
      successorState = store.readState();
      valid = false;
    } });
    expect(result).toMatchObject({ status: "held", hold: { reason: "successor_owned" } });
    expect(store.readState()).toEqual(successorState);
    expect(runner.mock.calls.some(([call]) => call.args?.includes("doctor"))).toBe(false);
    operation.finishWork();
    await operation.cleanup.wait();
  });

  it.each(["running_probe", "quiet"])("does not publish a boot checkpoint after %s cancels an operation with a still-valid lease", async (phase) => {
    gatewayRunning = false;
    let hold;
    const operation = createRepairOperation({ isCurrent: () => hold?.isValid() === true });
    hold = await serviceOptions.acquireLifecycleLock("boot", { cleanup: operation.cleanup });
    if (phase === "running_probe") gateway.isRunning = async () => { operation.cancel("shutdown"); return false; };
    else quietHook = () => operation.cancel("shutdown");
    try {
      const result = await sync.reconcileBootConfig({ hold, operation });
      expect(result).toMatchObject({ status: "held", hold: { reason: "operation_cancelled" } });
      expect(hold.isValid()).toBe(true);
      expect(operation.signal.aborted).toBe(true);
      expect(fs.existsSync(path.join(root, "backups"))).toBe(false);
      expect(ledger.listRuns().every((run) => run.state !== "completed" && run.recovery?.checkpoint?.verified !== true)).toBe(true);
      expect(runner).not.toHaveBeenCalled();
      expect(order).not.toContain("start");
      expect(store.readState().gatewayHold).toBeNull();
    } finally {
      operation.finishWork();
      await operation.cleanup.wait();
      await hold();
    }
  });

  it("rejects incompatible rollback launch metadata without target CLI or copies", async () => {
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','17')");
    db.close();
    const verdict = await sync.assessLaunchCompatibilityAtBoot();
    expect(verdict.compatible).toBe(false);
    expect(store.readState().gatewayHold).toBeTruthy();
    expect(runner.mock.calls.some(([call]) => call.args?.includes("preflight"))).toBe(false);
  });

  it("preserves the legacy exec approvals runtime block while boot explicitly ignores it", async () => {
    fs.writeFileSync(path.join(openclawDir, "exec-approvals.json"), "{}");
    const runtime = await sync.assessInstalledLaunchCompatibility({ legacyExecApprovals: "block" });
    expect(runtime).toMatchObject({ compatible: false, holdReason: "legacy_exec_approvals" });
    expect(runtime.reasons).toContain("legacy_exec_approvals_present");
    const boot = await sync.assessInstalledLaunchCompatibility({ legacyExecApprovals: "ignore" });
    expect(boot.compatible).toBe(true);
  });

  it("standalone config capture resumes the prior gateway without an archive claim", async () => {
    const result = await sync.runStandaloneBackup();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery.kind).toBe("config_only");
    expect(result.body.archive).toBeUndefined();
    expect(order).toEqual(["acquire", "suppress", "stop", "quiet", "resume", "start", "unsuppress"]);
  });

  it("retains checkpoint provenance, bounds config retention, and never hides orphan directories", async () => {
    const database = await sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(database.status).toBe(200);
    for (let index = 0; index < 5; index += 1) expect((await sync.runStandaloneBackup()).status).toBe(200);
    const directories = fs.readdirSync(path.join(root, "backups")).filter((name) => name.startsWith("recovery-"));
    expect(directories).toHaveLength(4);
    expect(fs.existsSync(database.body.recovery.checkpoint.file)).toBe(true);
    ledger.pruneRuns({ keep: 1, keepBackups: 1 });
    expect(ledger.readRun(database.body.operationId)).not.toBeNull();
    const orphan = "recovery-00000000-0000-0000-0000-000000000000";
    fs.mkdirSync(path.join(root, "backups", orphan));
    expect(sync.listBackupInventory().entries.find((entry) => entry.name === orphan)).toMatchObject({ verified: false, ineligibleReason: "no_provenance" });
    const staging = `.${orphan}.staging`;
    fs.mkdirSync(path.join(root, "backups", staging));
    await sync.sweepBackupDebris({ mode: "boot" });
    expect(fs.existsSync(path.join(root, "backups", staging))).toBe(false);
    expect(fs.existsSync(path.join(root, "backups", orphan))).toBe(true);
  });

  it.each(["tampered", "missing"])("does not advertise recovery availability for %s artifacts", async (mode) => {
    const result = await sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(200);
    const file = result.body.recovery.checkpoint.file;
    if (mode === "missing") fs.rmSync(file, { recursive: true });
    else fs.appendFileSync(path.join(file, "payload", "openclaw.json"), " ");
    const row = sync.listBackupInventory().entries.find((entry) => entry.file === file);
    expect(row).toMatchObject({ verified: false, recovery: { kind: "database_set", checkpoint: { verified: false },
      databases: { complete: false, verified: false }, restore: { configAvailable: false, databaseSetAvailable: false } } });
  });

  it("rejects newer database content before any stop or choice", async () => {
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','17')");
    db.close();
    const result = await apply({ consentSessionId: "human" });
    expect(result.body.code).toBe("db_preflight_failed");
    expect(result.body.backupRiskEligible).not.toBe(true);
    expect(order).toEqual(["prepare"]);
  });

  it("unwinds a lost quiet barrier without recording a target", async () => {
    quietHook = (options) => options.onEvent({ status: "expired" });
    const result = await apply();
    expect(result.status).not.toBe(202);
    expect(store.readState().applied).toBeNull();
    expect(order.slice(-3)).toEqual(["resume", "start", "unsuppress"]);
  });
});
