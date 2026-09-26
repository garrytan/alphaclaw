const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createWatchdog, kRestartVerdicts } = require("../../lib/server/watchdog");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");

const logger = { log() {}, warn() {}, error() {} };
const roots = [];
const watchdogs = [];
const fixture = ({ corrupt = false, sourceSchema = 17, owner = true, lifecycleLock = null } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-recovery-compat-"));
  roots.push(root);
  const state = path.join(root, ".openclaw");
  const packageDir = path.join(root, "node_modules/openclaw");
  fs.mkdirSync(path.join(state, "state"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "dist/extensions"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.9.5" } }));
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.5",
    bin: "openclaw.mjs", openclaw: { schemaVersions: { state: 17, agent: 21 } } }));
  fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), 'console.log("2026.9.5");');
  fs.writeFileSync(path.join(packageDir, "dist/thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];\n");
  fs.writeFileSync(path.join(state, "openclaw.json"), "{}");
  const databasePath = path.join(state, "state/openclaw.sqlite");
  if (corrupt) fs.writeFileSync(databasePath, "not SQLite");
  else {
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version=${sourceSchema}; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('operator-data');`);
    if (owner) {
      database.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)");
      database.prepare("INSERT INTO schema_meta VALUES('primary','global',?,NULL)").run(sourceSchema);
    }
    database.close();
  }
  const store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir: state, logger });
  store.writeSentinel({ installDir: root, version: "2026.9.5" });
  const sync = createOpenclawChannelSync({ rootDir: root, openclawDir: state, packageRoot: root,
    store, resolveInstallDir: () => root, isOnboarded: () => true,
    openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: state }), logger,
    ...(lifecycleLock ? { acquireLifecycleLock: lifecycleLock.acquire,
      tryAcquireLifecycleLock: lifecycleLock.tryAcquire, getActiveGatewayOperation: lifecycleLock.getActiveOperation,
      gatewayMutationPolicy: createGatewayMutationPolicy({ lock: lifecycleLock,
        getChannelInfo: () => sync.getChannelInfo(), isApplyInProgress: () => sync.isApplyInProgress() }) } : {}),
  });
  return { root, state, sync, databasePath };
};

const harness = ({ sync = null, checker, noChecker = false,
  gatewayLifecycleLock = createGatewayLifecycleLock({ logger }), holdRecoveryChoice = null } = {}) => {
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const events = [];
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const writePersistedPause = vi.fn();
  const clawCmd = vi.fn(async () => ({ ok: true, stdout: "{}" }));
  const assessLaunchCompatibility = checker !== undefined ? checker
    : vi.fn(() => sync.assessInstalledLaunchCompatibility({ legacyExecApprovals: "block" }));
  const watchdog = createWatchdog({
    clawCmd, launchGatewayProcess, gatewayLifecycleLock,
    probeGatewayTcp: async () => false, insertWatchdogEvent: (event) => events.push(event),
    notifier, writePersistedPause, readEnvFile: () => [], writeEnvFile() {}, reloadEnv() {},
    resolveSetupUrl: () => "http://localhost", resolveGatewayHealthUrl: () => "http://127.0.0.1:1/health",
    resolveGatewayReadyzUrl: () => "", sleepImpl: () => Promise.resolve(), supervisorModeActive: () => false,
    ...((sync || holdRecoveryChoice) ? { releaseChannelHooks: {
      ...(sync ? { getInfo: () => sync.getChannelInfo() } : {}),
      ...(holdRecoveryChoice ? { holdRecoveryChoice } : {}),
    } } : {}),
    ...(!noChecker ? { assessLaunchCompatibility } : {}),
  });
  watchdogs.push(watchdog);
  return { watchdog, launchGatewayProcess, events, notifier, writePersistedPause,
    assessLaunchCompatibility, clawCmd, gatewayLifecycleLock };
};

beforeEach(() => {
  vi.stubEnv("WATCHDOG_AUTO_REPAIR", "false");
  vi.stubEnv("WATCHDOG_NOTIFICATIONS_DISABLED", "false");
  vi.stubEnv("OPENCLAW_LAUNCH_COMPAT_GATE", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture gateway is offline"); }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const watchdog of watchdogs.splice(0)) watchdog.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("watchdog runtime recovery compatibility", () => {
  it("wires the production watchdog migration refusal to the channel service's durable hold hook", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../lib/server.js"), "utf8");
    const start = source.indexOf("const watchdog = createWatchdog({");
    expect(start).toBeGreaterThan(-1);
    const composition = source.slice(start, source.indexOf("\n});", start));
    expect(composition).toContain("holdRecoveryChoice: (payload) => openclawChannelService.holdRecoveryChoice(payload)");
    expect(composition).toContain("gatewayLifecycleLock,");
  });

  it("publishes an explicit recovery-required verdict rather than an undefined launch outcome", () => {
    expect(kRestartVerdicts.RECOVERY_REQUIRED).toBe("recovery_required");
  });

  it.each(["on", "off"])("refuses corrupt SQLite through the real adapter even with compatibility gate %s", async (gate) => {
    vi.stubEnv("OPENCLAW_LAUNCH_COMPAT_GATE", gate);
    const { sync, databasePath } = fixture({ corrupt: true });
    const original = fs.readFileSync(databasePath);
    const verdict = await sync.assessInstalledLaunchCompatibility();
    expect(verdict).toMatchObject({ compatible: null, holdReason: "state_db_unreadable" });
    const cell = harness({ sync });

    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false, stderrTail: [] });

    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({
      reason: "state_db_unreadable", cause: "state_db_unreadable",
    }));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.assessLaunchCompatibility).toHaveBeenCalledOnce();
    expect(cell.events).toContainEqual(expect.objectContaining({ eventType: "restart", status: "skipped",
      details: expect.objectContaining({ reason: "state_db_unreadable", compatible: null,
        hint: expect.stringContaining("unknown compatibility cannot be waived") }) }));
    expect(cell.events.some((event) => event.eventType === "restart" && event.status === "requested")).toBe(false);
    expect(cell.writePersistedPause).toHaveBeenCalledWith(expect.objectContaining({ reason: "state_db_unreadable" }));
    expect(cell.watchdog.getStatus().replacementPending).toBeNull();
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it.each(["on", "off"])("refuses a real state16 to17 migration until the operator chooses protection, gate %s", async (gate) => {
    vi.stubEnv("OPENCLAW_LAUNCH_COMPAT_GATE", gate);
    const { sync, databasePath } = fixture({ sourceSchema: 16 });
    const original = fs.readFileSync(databasePath);
    expect(await sync.assessInstalledLaunchCompatibility()).toMatchObject({ compatible: true, migrationRequired: true });
    const cell = harness({ sync });

    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false, stderrTail: [] });

    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "recovery_choice_required" }));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.events).toContainEqual(expect.objectContaining({ eventType: "restart", status: "skipped",
      details: expect.objectContaining({ reason: "recovery_choice_required", compatible: true,
        migrationRequired: true, hint: expect.stringContaining("Upgrade page") }) }));
    await vi.waitFor(() => expect(cell.notifier.notify.mock.calls.some(([message]) =>
      message.includes("choose database-set protection") && message.includes("forward-only"))).toBe(true));
    expect(cell.watchdog.getStatus().versionMismatch).toBeNull();
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it("refuses unknown ownership metadata from the real adapter without mislabeling a version mismatch", async () => {
    const { sync } = fixture({ owner: false });
    expect(await sync.assessInstalledLaunchCompatibility()).toMatchObject({ compatible: null });
    const cell = harness({ sync });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "state_db_unverified" }));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus().versionMismatch).toBeNull();
    expect(cell.writePersistedPause).toHaveBeenCalledOnce();
  });

  it("launches the real installed build only after known same-schema compatibility", async () => {
    const { sync, databasePath } = fixture();
    const original = fs.readFileSync(databasePath);
    expect(await sync.assessInstalledLaunchCompatibility()).toMatchObject({ compatible: true, migrationRequired: false });
    const cell = harness({ sync });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.launchGatewayProcess).toHaveBeenCalledOnce());
    expect(cell.assessLaunchCompatibility).toHaveBeenCalledOnce();
    expect(cell.watchdog.getStatus().autoRepairPaused).toBeNull();
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it.each([null, undefined, {}, [], "compatible", { compatible: true },
    { compatible: true, migrationRequired: null }, { compatible: null, migrationRequired: false }].map((value) => [value]))(
    "fails closed when an injected production checker returns %j", async (verdict) => {
      vi.stubEnv("OPENCLAW_LAUNCH_COMPAT_GATE", "off");
      const checker = vi.fn(async () => verdict);
      const cell = harness({ checker });
      cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "state_db_unverified" }));
      expect(checker).toHaveBeenCalledOnce();
      expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
      expect(cell.watchdog.getStatus().replacementPending).toBeNull();
    },
  );

  it("persists a refusal when the injected checker throws instead of bypassing it", async () => {
    const checker = vi.fn(async () => { throw new Error("unreadable production state"); });
    const cell = harness({ checker });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "state_db_unverified" }));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.writePersistedPause).toHaveBeenCalledOnce();
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
  });

  it.each([false, "disabled", {}])("refuses a malformed configured compatibility dependency %j", async (checker) => {
    const cell = harness({ checker });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "state_db_unverified" }));
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.writePersistedPause).toHaveBeenCalledOnce();
  });

  it("pauses on a timed-out compatibility read without accepting its late success", async () => {
    vi.useFakeTimers();
    let resolveCompatibility;
    const checker = vi.fn(() => new Promise((resolve) => { resolveCompatibility = resolve; }));
    const cell = harness({ checker });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "state_db_unverified" });
    expect(cell.events).toContainEqual(expect.objectContaining({ eventType: "restart", status: "skipped",
      details: expect.objectContaining({ reasons: ["launch_discovery_timeout"] }) }));
    resolveCompatibility({ compatible: true, migrationRequired: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus().replacementPending).toBeNull();
  });

  it.each([
    [{ corrupt: true }, "state_db_unreadable"],
    [{ sourceSchema: 16 }, "recovery_choice_required"],
    [{ owner: false }, "state_db_unverified"],
  ])("does not let forced Doctor repair clear a recovery gate for %j", async (options, reason) => {
    const { sync, databasePath } = fixture(options);
    const original = fs.readFileSync(databasePath);
    const cell = harness({ sync });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason }));
    cell.clawCmd.mockClear();

    const repair = await cell.watchdog.triggerRepair({ force: true });

    expect(repair).toMatchObject({ ok: false, skipped: true, reason: "auto_repair_paused", pause: { reason } });
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason });
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it.each([
    [{ corrupt: true }, "state_db_unreadable"],
    [{ sourceSchema: 16 }, "recovery_choice_required"],
    [{ owner: false }, "state_db_unverified"],
  ].flatMap(([options, reason]) => [false, true].map((force) => [options, reason, force])))(
    "refuses fresh Doctor entry on %j under its repair lease: %s, force=%s", async (options, reason, force) => {
      vi.stubEnv("OPENCLAW_LAUNCH_COMPAT_GATE", "off");
      const { sync, databasePath } = fixture(options);
      const original = fs.readFileSync(databasePath);
      const lock = createGatewayLifecycleLock({ logger });
      const checker = vi.fn(() => {
        expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });
        return sync.assessInstalledLaunchCompatibility();
      });
      const cell = harness({ sync, checker, gatewayLifecycleLock: lock });
      expect(cell.watchdog.getStatus().autoRepairPaused).toBeNull();
      expect(cell.watchdog.getStatus().versionMismatch).toBeNull();
      expect(sync.getChannelInfo().installedDiverged).toBe(false);

      const result = await cell.watchdog.triggerRepair({ force });

      expect(result).toMatchObject({ ok: false, skipped: true, reason,
        verdict: "recovery_required", launchedGateway: false });
      expect(checker).toHaveBeenCalledOnce();
      expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
      expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
      expect(cell.watchdog.getStatus()).toMatchObject({ repairAttempts: 0,
        lastRepairVerdict: "recovery_required", operationInProgress: false,
        autoRepairPaused: { reason } });
      expect(cell.events).toContainEqual(expect.objectContaining({ eventType: "repair", status: "skipped",
        details: expect.objectContaining({ reason, intent: "doctor_repair" }) }));
      expect(cell.events.some((event) => event.eventType === "repair_attempt")).toBe(false);
      expect(lock.getActiveOperation()).toBeNull();
      expect(fs.readFileSync(databasePath)).toEqual(original);
    },
  );

  it("runs Doctor for a fresh same-schema build after verification under the owned lease", async () => {
    const { sync } = fixture();
    const lock = createGatewayLifecycleLock({ logger });
    const checker = vi.fn(() => {
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });
      return sync.assessInstalledLaunchCompatibility();
    });
    const cell = harness({ sync, checker, gatewayLifecycleLock: lock });

    const result = await cell.watchdog.triggerRepair({ force: true });

    expect(cell.clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes")).toHaveLength(1);
    expect(checker).toHaveBeenCalledTimes(2);
    expect(checker.mock.invocationCallOrder[0]).toBeLessThan(cell.clawCmd.mock.invocationCallOrder[0]);
    expect(cell.launchGatewayProcess).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, launchedGateway: true });
    expect(cell.watchdog.getStatus()).toMatchObject({ repairAttempts: 1, autoRepairPaused: null });
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("refuses fresh Doctor entry for a known incompatible installed build", async () => {
    const { sync, databasePath } = fixture({ sourceSchema: 18 });
    const original = fs.readFileSync(databasePath);
    const cell = harness({ sync });

    const result = await cell.watchdog.triggerRepair({ force: true });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: "version_mismatch", verdict: "version_mismatch" });
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus().versionMismatch).toMatchObject({ source: "repair" });
    expect(cell.watchdog.getStatus().repairAttempts).toBe(0);
    expect(cell.gatewayLifecycleLock.getActiveOperation()).toBeNull();
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it.each(["throw", "null", "migration-unknown"])("a fresh forced Doctor cannot bypass a %s compatibility failure", async (failure) => {
    const checker = vi.fn(async () => {
      if (failure === "throw") throw new Error("unreadable production metadata");
      return failure === "null" ? null : { compatible: true, migrationRequired: null };
    });
    const cell = harness({ checker });

    const result = await cell.watchdog.triggerRepair({ force: true });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: "state_db_unverified" });
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus()).toMatchObject({ repairAttempts: 0, autoRepairPaused: { reason: "state_db_unverified" } });
    expect(cell.gatewayLifecycleLock.getActiveOperation()).toBeNull();
  });

  it("a timed-out pre-writer compatibility read cannot later start Doctor when it resolves safe", async () => {
    vi.useFakeTimers();
    let finishCompatibility;
    const checker = vi.fn(() => new Promise((resolve) => { finishCompatibility = resolve; }));
    const cell = harness({ checker });
    const repairing = cell.watchdog.triggerRepair({ force: true });
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await repairing;
    expect(result).toMatchObject({ ok: false, skipped: true, reason: "state_db_unverified" });
    expect(cell.gatewayLifecycleLock.getActiveOperation()).toBeNull();
    finishCompatibility({ compatible: true, migrationRequired: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.watchdog.getStatus().repairAttempts).toBe(0);
  });

  it("a gateway hold raised during compatibility discovery blocks the pre-writer admission", async () => {
    const { sync } = fixture();
    const checker = vi.fn(async () => {
      const result = await sync.assessInstalledLaunchCompatibility();
      sync.store.updateState((state) => ({ ...state, gatewayHold: { reason: "config_migration_failed", at: Date.now() } }));
      return result;
    });
    const cell = harness({ sync, checker });

    const result = await cell.watchdog.triggerRepair({ force: true });

    expect(result).toMatchObject({ ok: false, skipped: true, reason: "gateway_held" });
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.gatewayLifecycleLock.getActiveOperation()).toBeNull();
    expect(cell.watchdog.getStatus().repairAttempts).toBe(0);
  });

  it("lease loss during a pre-writer compatibility read cannot mutate or release its successor", async () => {
    const lock = createGatewayLifecycleLock({ logger });
    let repairHold;
    let successor;
    let replacement;
    const tryAcquire = lock.tryAcquire;
    vi.spyOn(lock, "tryAcquire").mockImplementation((...args) => {
      repairHold = tryAcquire(...args);
      return repairHold;
    });
    const checker = vi.fn(async () => {
      replacement = repairHold().then(() => lock.acquire("operator_successor")).then((hold) => { successor = hold; });
      await replacement;
      return { compatible: true, migrationRequired: false };
    });
    const cell = harness({ checker, gatewayLifecycleLock: lock });
    try {
      const result = await cell.watchdog.triggerRepair({ force: true });
      await replacement;
      expect(result.ok).toBe(false);
      expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
      expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
      expect(cell.watchdog.getStatus().repairAttempts).toBe(0);
      expect(lock.owns(successor)).toBe(true);
    } finally { await successor?.(); }
  });

  it.each(["crash", "doctor"])("records a durable migration choice through the real service hook on %s refusal", async (entry) => {
    const lock = createGatewayLifecycleLock({ logger });
    const { sync, databasePath } = fixture({ sourceSchema: 16, lifecycleLock: lock });
    const original = fs.readFileSync(databasePath);
    expect(typeof sync.holdRecoveryChoice).toBe("function");
    const holdRecoveryChoice = vi.fn((options) => {
      expect(lock.owns(options.hold)).toBe(true);
      expect(options.hold.kind).toBe(entry === "crash" ? "crash_restart" : "repair");
      expect(options.verdict).toMatchObject({ compatible: true, migrationRequired: true,
        executingBuild: { version: "2026.9.5" } });
      return sync.holdRecoveryChoice(options);
    });
    const cell = harness({ sync, gatewayLifecycleLock: lock, holdRecoveryChoice });
    if (entry === "crash") cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    else expect(await cell.watchdog.triggerRepair({ force: true })).toMatchObject({ ok: false, reason: "recovery_choice_required" });

    await vi.waitFor(() => expect(holdRecoveryChoice).toHaveBeenCalledOnce());
    expect(await holdRecoveryChoice.mock.results[0].value).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(sync.getChannelInfo().gatewayHold).toMatchObject({ reason: "recovery_choice_required" }));
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "recovery_choice_required" }));
    expect(sync.store.readState().gatewayHold).toMatchObject({ reason: "recovery_choice_required" });
    expect(cell.watchdog.getGatewayHold()).toMatchObject({ reason: "recovery_choice_required" });
    expect(holdRecoveryChoice).toHaveBeenCalledOnce();
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(databasePath)).toEqual(original);
  });

  it("does not replace a foreign channel hold while persisting a runtime migration refusal", async () => {
    const lock = createGatewayLifecycleLock({ logger });
    const { sync } = fixture({ sourceSchema: 16, lifecycleLock: lock });
    expect(typeof sync.holdRecoveryChoice).toBe("function");
    const foreign = { reason: "config_migration_failed", message: "another operation owns recovery", at: 123 };
    let storedForeign;
    const checker = vi.fn(async () => {
      const verdict = await sync.assessInstalledLaunchCompatibility();
      sync.store.updateState((state) => ({ ...state, gatewayHold: foreign }));
      storedForeign = sync.store.readState().gatewayHold;
      return verdict;
    });
    const holdRecoveryChoice = vi.fn((options) => sync.holdRecoveryChoice(options));
    const cell = harness({ sync, checker, holdRecoveryChoice, gatewayLifecycleLock: lock });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "recovery_choice_required" }));
    expect(holdRecoveryChoice).toHaveBeenCalledOnce();
    expect(await holdRecoveryChoice.mock.results[0].value).toMatchObject({ ok: false, code: "gateway_held" });
    expect(sync.store.readState().gatewayHold).toEqual(storedForeign);
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
  });

  it("does not call the durable hold hook after the compatibility read loses its repair authority", async () => {
    const lock = createGatewayLifecycleLock({ logger });
    let hold;
    const tryAcquire = lock.tryAcquire;
    vi.spyOn(lock, "tryAcquire").mockImplementation((...args) => { hold = tryAcquire(...args); return hold; });
    const checker = vi.fn(async () => {
      await hold();
      return { compatible: true, migrationRequired: true, executingBuild: { version: "2026.9.5" } };
    });
    const holdRecoveryChoice = vi.fn();
    const cell = harness({ checker, holdRecoveryChoice, gatewayLifecycleLock: lock });

    const result = await cell.watchdog.triggerRepair({ force: true });

    expect(result.ok).toBe(false);
    expect(holdRecoveryChoice).not.toHaveBeenCalled();
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.clawCmd.mock.calls.some(([command]) => command === "doctor --fix --yes")).toBe(false);
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("bounds a slow durable-hold hook and leaves the local refusal active without authorizing a late write", async () => {
    vi.useFakeTimers();
    let completeHold;
    let hookHold;
    const write = vi.fn();
    const holdRecoveryChoice = vi.fn(({ hold }) => {
      hookHold = hold;
      return new Promise((resolve) => { completeHold = () => { if (hold.isValid()) write(); resolve(); }; });
    });
    const cell = harness({ checker: vi.fn(async () => ({ compatible: true, migrationRequired: true })), holdRecoveryChoice });
    const repair = cell.watchdog.triggerRepair({ force: true });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await repair).toMatchObject({ ok: false, reason: "recovery_choice_required" });
    expect(cell.watchdog.getStatus().autoRepairPaused).toMatchObject({ reason: "recovery_choice_required" });
    expect(hookHold.isValid()).toBe(false);
    completeHold();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled();
    expect(cell.launchGatewayProcess).not.toHaveBeenCalled();
    expect(cell.gatewayLifecycleLock.getActiveOperation()).toBeNull();
  });

  it("retains the legacy isolated embedding without an injected compatibility service", async () => {
    const cell = harness({ noChecker: true });
    cell.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.waitFor(() => expect(cell.launchGatewayProcess).toHaveBeenCalledOnce());
    expect(cell.watchdog.getStatus().autoRepairPaused).toBeNull();
  });
});
