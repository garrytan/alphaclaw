const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { runBootNativeMaintenance } = require("../../lib/server/boot-native-maintenance");
const { createCommands } = require("../../lib/server/commands");
const { processGroupHasWriters } = require("../../lib/server/process-group");
const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");
const { normalizeBootConfig } = require("../../lib/server/boot-config-normalization");
const { kUsageTrackerPluginPath } = require("../../lib/server/usage-tracker-config");

describe("admitted boot native maintenance", () => {
  let root;
  let env;
  let deps;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-native-"));
    const realState = path.join(root, "physical-state");
    const logicalState = path.join(root, "state-alias");
    fs.mkdirSync(realState);
    fs.symlinkSync(realState, logicalState);
    env = { ...process.env, OPENCLAW_STATE_DIR: logicalState, OPENCLAW_CONFIG_PATH: path.join(logicalState, "openclaw.json") };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, "{}");
    deps = {
      execFileCmd: vi.fn(async () => ""),
      gatewayEnv: vi.fn(() => env),
      hold: { isValid: vi.fn(() => true) },
      logger: { log: vi.fn(), warn: vi.fn() },
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs each original script once in order, retaining bounded timeouts and the logical state identity", async () => {
    await expect(runBootNativeMaintenance(deps)).resolves.toEqual({ status: "ok" });
    expect(deps.execFileCmd).toHaveBeenCalledTimes(2);
    for (const [index, script, timeoutMs] of [[0, "migrate-openclaw-codex.js", 60_000], [1, "reconcile-codex-plugin.js", 150_000]]) {
      const [file, args, options] = deps.execFileCmd.mock.calls[index];
      expect(file).toBe(process.execPath);
      expect(args).toEqual([path.resolve(__dirname, "../../lib/scripts", script)]);
      expect(options).toMatchObject({ env, timeoutMs, processGroup: true });
      expect(options.env).toBe(env);
      expect(options.env.OPENCLAW_STATE_DIR).not.toBe(fs.realpathSync(env.OPENCLAW_STATE_DIR));
      expect(options.signal).toBe(null);
    }
  });

  it("does not spawn without an existing config", async () => {
    fs.unlinkSync(env.OPENCLAW_CONFIG_PATH);
    await expect(runBootNativeMaintenance(deps)).resolves.toEqual({ status: "skipped", reason: "no-config" });
    expect(deps.execFileCmd).not.toHaveBeenCalled();
  });

  it.each([null, {}, { isValid: () => false }])("refuses absent, unverifiable, or expired ownership before spawning: %j", async (hold) => {
    await expect(runBootNativeMaintenance({ ...deps, hold })).rejects.toMatchObject({ code: "boot_lease_expired" });
    expect(deps.execFileCmd).not.toHaveBeenCalled();
  });

  it("does not spawn when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runBootNativeMaintenance({ ...deps, signal: controller.signal })).rejects.toMatchObject({ code: "boot_native_cancelled" });
    expect(deps.execFileCmd).not.toHaveBeenCalled();
  });

  it("does not run the second helper when the first returns after lease loss", async () => {
    deps.execFileCmd.mockImplementationOnce(async () => { deps.hold.isValid.mockReturnValue(false); });
    await expect(runBootNativeMaintenance(deps)).rejects.toMatchObject({ code: "boot_lease_expired" });
    expect(deps.execFileCmd).toHaveBeenCalledTimes(1);
  });

  it("logs ordinary helper failures without secrets and continues the admitted idempotent work", async () => {
    deps.execFileCmd.mockRejectedValueOnce(Object.assign(new Error("credential=do-not-log"), { code: 1, stdout: "do-not-log", stderr: "do-not-log" }));
    await expect(runBootNativeMaintenance(deps)).resolves.toEqual({ status: "ok" });
    expect(deps.execFileCmd).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledWith("[alphaclaw] Codex migration process failed (exit 1); continuing admitted boot");
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain("do-not-log");
  });

  it("reports child diagnostics without printing their contents", async () => {
    deps.execFileCmd.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput("access_token=do-not-log", "stderr");
    });
    await runBootNativeMaintenance(deps);
    expect(deps.logger.warn).toHaveBeenCalledWith("[alphaclaw] Codex migration emitted diagnostics; child output withheld");
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain("do-not-log");
  });

  it("cancels a timed-out helper and never starts the next helper", async () => {
    deps.execFileCmd.mockRejectedValueOnce(Object.assign(new Error("timed out"), { timedOut: true }));
    await expect(runBootNativeMaintenance(deps)).rejects.toMatchObject({ code: "boot_native_timeout" });
    expect(deps.execFileCmd).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP responsive and drains a real helper plus its synchronous child on cancellation", async () => {
    const controller = new AbortController();
    const pidFile = path.join(root, "child-ready");
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const fixture = `require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit'})`;
    const { execFileCmd } = createCommands({ gatewayEnv: deps.gatewayEnv });
    let pid;
    deps.execFileCmd = vi.fn((file, _args, options) => execFileCmd(file, ["-e", fixture], {
      ...options,
      onProcess: (child) => { if (child.pid) pid = child.pid; },
    }));
    const server = http.createServer((_req, res) => res.end("setup available"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const run = expect(runBootNativeMaintenance({ ...deps, signal: controller.signal })).rejects.toMatchObject({ code: "boot_native_cancelled" });
    try {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(processGroupHasWriters(pid)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${server.address().port}`);
      expect(await response.text()).toBe("setup available");
      controller.abort();
      await run;
      expect(processGroupHasWriters(pid)).toBe(false);
      expect(deps.execFileCmd).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await run;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("native boot maintenance composition", () => {
  it("never runs either native helper in bin before server admission", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../bin/alphaclaw.js"), "utf8");
    expect(source).not.toContain("migrate-openclaw-codex");
    expect(source).not.toContain("reconcile-codex-plugin");
  });

  it("wires server startup to the shared argv primitive and gateway logical environment", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../lib/server/init/register-server-routes.js"), "utf8");
    expect(source).toContain('require("../boot-native-maintenance")');
    expect(source).toMatch(/runBootNativeMaintenance: \(options\) => runBootNativeMaintenance\(\{\s*\.\.\.options,\s*execFileCmd,\s*gatewayEnv,\s*\}\)/);
    expect(source).toContain("signal: bootSignal,");
    expect(source).toMatch(/gatewayHoldActions: \{\s*signal: bootSignal,/);
    const server = fs.readFileSync(path.resolve(__dirname, "../../lib/server.js"), "utf8");
    expect(server.slice(server.indexOf("} = registerServerRoutes({"))).toContain("bootSignal: gatewayQuiesceAbort.signal,");
  });
});

describe("group-owned argv command mode", () => {
  const { execFileCmd } = createCommands({ gatewayEnv: () => ({}) });

  it("retains the trimmed stdout/stderr contract and only enables groups for the explicit caller", async () => {
    await expect(execFileCmd(process.execPath, ["-e", "process.stdout.write('  ready\\n')"], { processGroup: true })).resolves.toBe("ready");
    await expect(execFileCmd(process.execPath, ["-e", "process.stdout.write('  partial\\n'); process.stderr.write(' failed\\n'); process.exitCode=3"], { processGroup: true })).rejects.toMatchObject({ code: 3, stdout: "partial", stderr: "failed" });
  });

  it("bounds a real hung command and reports timeout only after the owned process group is drained", async () => {
    let pid;
    await expect(execFileCmd(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      processGroup: true,
      timeoutMs: 100,
      onProcess: (child) => { if (child.pid) pid = child.pid; },
    })).rejects.toMatchObject({ timedOut: true, killed: true });
    expect(processGroupHasWriters(pid)).toBe(false);
  });
});

describe("startup native maintenance admission", () => {
  let deps;
  let execFileCmd;
  let hold;
  beforeEach(() => {
    execFileCmd = vi.fn(async () => "");
    hold = Object.assign(vi.fn(), { isValid: vi.fn(() => true) });
    deps = {
      acquireLifecycleLock: vi.fn(async () => hold),
      reportLockContentionAtBoot: vi.fn(),
      assessLaunchCompatibilityAtBoot: vi.fn(async () => ({ compatible: true })),
      reconcileBootConfig: vi.fn(async () => ({ status: "ok" })),
      normalizeBootConfig: vi.fn(),
      runBootNativeMaintenance: vi.fn((options) => runBootNativeMaintenance({
        ...options,
        execFileCmd,
        gatewayEnv: () => ({ OPENCLAW_CONFIG_PATH: path.resolve(__dirname, "../../package.json") }),
      })),
      ensureManagedExecDefaults: vi.fn(),
      ensureUsageTrackerPluginConfig: vi.fn(),
      ensureWebhookMappingIds: vi.fn(),
      doSyncPromptFiles: vi.fn(),
      reloadEnv: vi.fn(),
      syncChannelConfig: vi.fn(),
      readEnvFile: vi.fn(() => []),
      ensureGatewayProxyConfig: vi.fn(),
      resolveSetupUrl: vi.fn(),
      finalizeBootReport: vi.fn(),
      startGateway: vi.fn(),
      watchdog: { start: vi.fn() },
      gmailWatchService: { start: vi.fn() },
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setBootPhase("initializing");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs helpers only after admission and completed reconciliation, before gateway launch under the same lease", async () => {
    let admit;
    deps.reconcileBootConfig.mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
    const boot = runOnboardedBootSequence(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    admit({ status: "ok" });
    await boot;
    expect(execFileCmd).toHaveBeenCalledTimes(2);
    expect(deps.runBootNativeMaintenance).toHaveBeenCalledWith({ hold, signal: expect.any(AbortSignal) });
    expect(deps.reconcileBootConfig.mock.invocationCallOrder[0]).toBeLessThan(execFileCmd.mock.invocationCallOrder[0]);
    expect(execFileCmd.mock.invocationCallOrder[1]).toBeLessThan(deps.startGateway.mock.invocationCallOrder[0]);
    expect(deps.startGateway.mock.invocationCallOrder[0]).toBeLessThan(hold.mock.invocationCallOrder[0]);
  });

  it("only hands normalization to the reconciler so it can validate fingerprints before any config writer", async () => {
    deps.reconcileBootConfig.mockImplementation(async ({ hold: current, normalizeBootConfig }) => {
      expect(current).toBe(hold);
      expect(deps.normalizeBootConfig).not.toHaveBeenCalled();
      normalizeBootConfig();
      return { status: "ok" };
    });
    await runOnboardedBootSequence(deps);
    expect(deps.normalizeBootConfig).toHaveBeenCalledWith({ hold });
    expect(deps.normalizeBootConfig.mock.invocationCallOrder[0]).toBeLessThan(execFileCmd.mock.invocationCallOrder[0]);
  });

  it("normalizes an existing pre-onboarding config only through admission without starting onboarded services", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-pre-onboarding-"));
    const configPath = path.join(root, "openclaw.json");
    const stalePath = "/app/node_modules/@chrysb/alphaclaw/lib/plugin/usage-tracker";
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { load: { paths: [stalePath, "/custom/plugin"] } } }));
    const env = { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: root };
    deps.onboarded = false;
    deps.normalizeBootConfig.mockImplementation((options) => normalizeBootConfig({ ...options, env }));
    deps.reconcileBootConfig.mockImplementation(async ({ normalizeBootConfig: normalize, operation }) => {
      expect(fs.readFileSync(configPath, "utf8")).toContain(stalePath);
      await normalize({ assertLease: operation.assertActive });
      return { status: "ok" };
    });
    try {
      await runOnboardedBootSequence(deps);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins.load.paths).toEqual(["/custom/plugin", kUsageTrackerPluginPath]);
      expect(deps.normalizeBootConfig).toHaveBeenCalledWith({ hold, assertLease: expect.any(Function) });
      expect(deps.assessLaunchCompatibilityAtBoot.mock.invocationCallOrder[0]).toBeLessThan(deps.normalizeBootConfig.mock.invocationCallOrder[0]);
      expect(deps.normalizeBootConfig.mock.invocationCallOrder[0]).toBeLessThan(hold.mock.invocationCallOrder[0]);
      for (const step of [deps.runBootNativeMaintenance, deps.ensureManagedExecDefaults, deps.ensureUsageTrackerPluginConfig,
        deps.ensureWebhookMappingIds, deps.doSyncPromptFiles, deps.reloadEnv, deps.syncChannelConfig,
        deps.ensureGatewayProxyConfig, deps.startGateway, deps.watchdog.start, deps.gmailWatchService.start]) {
        expect(step).not.toHaveBeenCalled();
      }
      expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ reconcile: { status: "ok" } }));
      expect(hold).toHaveBeenCalledOnce();
      expect(getBootPhase().phase).toBe("ready");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["compatibility", "recovery", "expired lease", "shutdown"])("keeps pre-onboarding normalization fenced by %s", async (blocker) => {
    deps.onboarded = false;
    const controller = new AbortController();
    deps.signal = controller.signal;
    if (blocker === "compatibility") deps.assessLaunchCompatibilityAtBoot.mockResolvedValue({ compatible: false });
    deps.reconcileBootConfig.mockImplementation(async ({ normalizeBootConfig: normalize, operation }) => {
      if (blocker === "recovery") return { status: "held", hold: { reason: "recovery_review" } };
      if (blocker === "expired lease") hold.isValid.mockReturnValue(false);
      if (blocker === "shutdown") controller.abort("shutdown");
      operation.assertActive();
      await normalize({ assertLease: operation.assertActive });
      return { status: "ok" };
    });
    await runOnboardedBootSequence(deps);
    expect(deps.normalizeBootConfig).not.toHaveBeenCalled();
    expect(deps.runBootNativeMaintenance).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).not.toHaveBeenCalled();
    expect(deps.gmailWatchService.start).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledOnce();
  });

  it.each([
    ["held compatibility", { compatible: true, hold: { reason: "state_db_unverified" } }],
    ["incompatible", { compatible: false }],
    ["unknown compatibility", { compatible: null }],
    ["empty compatibility", null],
    ["missing compatible flag", {}],
    ["throwing compatibility", "throw"],
  ])("spawns zero helpers for %s and skips config reconciliation", async (_label, verdict) => {
    deps.assessLaunchCompatibilityAtBoot.mockImplementation(async () => {
      if (verdict === "throw") throw new Error("probe failed");
      return verdict;
    });
    await runOnboardedBootSequence(deps);
    expect(deps.reconcileBootConfig).not.toHaveBeenCalled();
    expect(deps.normalizeBootConfig).not.toHaveBeenCalled();
    expect(deps.ensureManagedExecDefaults).not.toHaveBeenCalled();
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["held reconciliation", { status: "held", hold: { reason: "migration_required" } }],
    ["stale recovery intent", { status: "held", hold: { reason: "recovery_intent_stale" } }],
    ["empty reconciliation", null],
    ["skipped reconciliation", { status: "skipped", reason: "binary-unresolved" }],
    ["failed reconciliation", { status: "error" }],
    ["throwing reconciliation", "throw"],
  ])("spawns zero helpers for %s", async (_label, verdict) => {
    deps.reconcileBootConfig.mockImplementation(async () => {
      if (verdict === "throw") throw new Error("reconcile failed");
      return verdict;
    });
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.ensureManagedExecDefaults).not.toHaveBeenCalled();
    expect(deps.normalizeBootConfig).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: true }));
  });

  it("spawns zero helpers when reconciliation outlives the boot lease", async () => {
    deps.reconcileBootConfig.mockImplementation(async () => {
      hold.isValid.mockReturnValue(false);
      return { status: "ok" };
    });
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
  });

  it("the real lifecycle expiry cancels the active helper and forbids the second helper and gateway launch", async () => {
    vi.useFakeTimers();
    const lock = createGatewayLifecycleLock({ logger: { warn: vi.fn() } });
    deps.acquireLifecycleLock = (kind, options) => lock.acquire(kind, { ...options, leaseMs: 10 });
    execFileCmd.mockImplementation((_file, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }));
    const boot = runOnboardedBootSequence(deps);
    await vi.advanceTimersByTimeAsync(10);
    await boot;
    expect(execFileCmd).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(lock.getActiveOperation()).toBe(null);
  });

  it("a helper timeout holds the gateway rather than falling through to launch", async () => {
    execFileCmd.mockRejectedValueOnce(Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL" }));
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: true }));
  });

  it("production-style shutdown cancellation drains the active helper and forbids the next helper and launch", async () => {
    const controller = new AbortController();
    deps.signal = controller.signal;
    let spawned;
    const started = new Promise((resolve) => { spawned = resolve; });
    execFileCmd.mockImplementation((_file, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { cancelled: true })), { once: true });
      spawned();
    }));
    const boot = runOnboardedBootSequence(deps);
    await started;
    controller.abort("shutdown");
    await boot;
    expect(execFileCmd).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).not.toHaveBeenCalled();
    expect(deps.gmailWatchService.start).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["applyResourceAutotuneOnBoot", "shutdown"],
    ["applyResourceAutotuneOnBoot", "lease loss"],
    ["ensureManagedExecDefaults", "shutdown"],
    ["ensureManagedExecDefaults", "lease loss"],
    ["syncChannelConfig", "shutdown"],
    ["syncChannelConfig", "lease loss"],
  ])("stops subsequent writers when %s finishes after %s", async (step, loss) => {
    const controller = new AbortController();
    deps.signal = controller.signal;
    deps.applyResourceAutotuneOnBoot = vi.fn();
    let finish;
    deps[step] = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const boot = runOnboardedBootSequence(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toBeTypeOf("function");
    if (loss === "shutdown") controller.abort("shutdown");
    else hold.isValid.mockReturnValue(false);
    finish();
    await boot;
    const steps = ["applyResourceAutotuneOnBoot", "ensureManagedExecDefaults", "ensureUsageTrackerPluginConfig", "ensureWebhookMappingIds", "doSyncPromptFiles", "reloadEnv", "syncChannelConfig", "ensureGatewayProxyConfig"];
    for (const later of steps.slice(steps.indexOf(step) + 1)) expect(deps[later]).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: true }));
  });

  it.each(["applyResourceAutotuneOnBoot", "ensureManagedExecDefaults", "syncChannelConfig"])("continues after an ordinary %s error while ownership remains valid", async (step) => {
    deps.applyResourceAutotuneOnBoot = vi.fn();
    deps[step] = vi.fn(async () => { throw new Error("ordinary helper failure"); });
    await runOnboardedBootSequence(deps);
    expect(deps.ensureGatewayProxyConfig).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
  });

  it("checks authority between synchronous post-admission writers too", async () => {
    deps.ensureWebhookMappingIds.mockImplementation(() => { hold.isValid.mockReturnValue(false); return { changed: false }; });
    await runOnboardedBootSequence(deps);
    expect(deps.doSyncPromptFiles).not.toHaveBeenCalled();
    expect(deps.reloadEnv).not.toHaveBeenCalled();
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();
    expect(deps.ensureGatewayProxyConfig).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
  });

  it("checks ownership again after finalizing the report before starting the gateway", async () => {
    deps.finalizeBootReport.mockImplementation(async () => { hold.isValid.mockReturnValue(false); });
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).toHaveBeenCalledTimes(2);
    expect(deps.startGateway).not.toHaveBeenCalled();
  });
});
