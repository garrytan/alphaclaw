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

describe("boot native maintenance runs once per OpenClaw build", () => {
  let root;
  let stateDir;
  let managedDir;
  let packageDir;
  let env;
  let deps;
  let profiles;
  const writeBuild = (buildId) => fs.writeFileSync(path.join(packageDir, "dist", "build-info.json"), JSON.stringify({ version: "2026.10.7", buildId }));
  const stampFile = () => path.join(managedDir, "codex-maintenance.json");
  const boot = () => runBootNativeMaintenance(deps);
  const ranHelpers = () => deps.execFileCmd.mock.calls.length;
  const logged = () => deps.logger.log.mock.calls.map(([text]) => text);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-native-stamp-"));
    stateDir = path.join(root, ".openclaw");
    managedDir = path.join(stateDir, ".alphaclaw");
    packageDir = path.join(root, "node_modules", "openclaw");
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    writeBuild("2026.10.7-release-aaaa");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-6-astra" } } } }));
    profiles = { "openai:default": { provider: "openai", type: "oauth", access: "synthetic-access-one", refresh: "synthetic-refresh-one" } };
    deps = {
      execFileCmd: vi.fn(async () => ""),
      gatewayEnv: () => env,
      hold: { isValid: () => true },
      logger: { log: vi.fn(), warn: vi.fn() },
      managedDir,
      resolvePackageDir: () => packageDir,
      loadAuthStore: vi.fn(() => ({ profiles })),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("runs on the first boot, records it, and skips a same-build boot with an unchanged state", async () => {
    await expect(boot()).resolves.toEqual({ status: "ok" });
    expect(ranHelpers()).toBe(2);
    expect(logged()).toContain("[alphaclaw] Codex migration and plugin reconciliation running: no record of a completed run");
    const stamp = JSON.parse(fs.readFileSync(stampFile(), "utf8"));
    expect(stamp).toMatchObject({ schema: "alphaclaw.codex-maintenance.v1", inputs: { openclawBuild: "2026.10.7-release-aaaa" } });
    expect(fs.readFileSync(stampFile(), "utf8")).not.toMatch(/synthetic-/);

    await expect(boot()).resolves.toEqual({ status: "skipped", reason: "current" });
    expect(ranHelpers()).toBe(2);
    expect(logged().at(-1)).toMatch(/^\[alphaclaw\] Codex migration and plugin reconciliation skipped: already done for OpenClaw 2026\.10\.7-release-aaaa with this config \(/);
  });

  it("a token refresh alone does not run it again", async () => {
    await boot();
    profiles["openai:default"] = { ...profiles["openai:default"], access: "synthetic-access-two", refresh: "synthetic-refresh-two" };
    await expect(boot()).resolves.toEqual({ status: "skipped", reason: "current" });
  });

  it.each([
    ["OpenClaw build changed", () => writeBuild("2026.10.8-release-bbbb")],
    ["openclaw.json changed", () => fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ auth: { profiles: { "openai:codex-cli": { provider: "openai", mode: "oauth" } } } }))],
    ["auth profiles changed", () => { profiles["openai:codex-cli"] = { provider: "openai", type: "oauth" }; }],
    ["legacy auth store changed", () => fs.writeFileSync(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}")],
    ["Codex plugin install changed", () => {
      const pkg = path.join(stateDir, "npm", "projects", "openclaw-codex-1234", "node_modules", "@openclaw", "codex");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "2026.10.1" }));
    }],
  ])("runs again when the %s", async (reason, change) => {
    await boot();
    change();
    await expect(boot()).resolves.toEqual({ status: "ok" });
    expect(ranHelpers()).toBe(4);
    expect(logged()).toContain(`[alphaclaw] Codex migration and plugin reconciliation running: ${reason}`);
    await expect(boot()).resolves.toEqual({ status: "skipped", reason: "current" });
  });

  it("records the config the migration left, so its own write does not run it again", async () => {
    deps.execFileCmd.mockImplementationOnce(async () => {
      fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify({ migrated: true }));
    });
    await boot();
    await expect(boot()).resolves.toEqual({ status: "skipped", reason: "current" });
  });

  it("never records a run in which a helper failed, so the next boot retries", async () => {
    deps.execFileCmd.mockRejectedValueOnce(Object.assign(new Error("exit"), { code: 1 }));
    await expect(boot()).resolves.toEqual({ status: "ok" });
    expect(fs.existsSync(stampFile())).toBe(false);
    await expect(boot()).resolves.toEqual({ status: "ok" });
    expect(ranHelpers()).toBe(4);
    expect(fs.existsSync(stampFile())).toBe(true);
  });

  it("drops the record before running, so an interrupted run is retried", async () => {
    await boot();
    writeBuild("2026.10.8-release-bbbb");
    deps.execFileCmd.mockRejectedValueOnce(Object.assign(new Error("timed out"), { timedOut: true }));
    await expect(boot()).rejects.toMatchObject({ code: "boot_native_timeout" });
    expect(fs.existsSync(stampFile())).toBe(false);
  });

  it.each([
    ["no build metadata", () => { fs.rmSync(packageDir, { recursive: true }); }],
    ["an unreadable auth store", () => { deps.loadAuthStore.mockReturnValue({ profiles: {}, unavailable: true }); }],
    ["a throwing auth store", () => { deps.loadAuthStore.mockImplementation(() => { throw new Error("locked"); }); }],
  ])("runs every time with %s, and records nothing", async (_label, setup) => {
    setup();
    await boot();
    await boot();
    expect(ranHelpers()).toBe(4);
    expect(fs.existsSync(stampFile())).toBe(false);
    expect(logged()).toContain("[alphaclaw] Codex migration and plugin reconciliation running: inputs unreadable");
  });

  it("runs when the maintenance sources changed since the record", () => {
    const { decideCodexMaintenance } = require("../../lib/server/boot-native-maintenance-stamp");
    const inputs = { openclawBuild: "b", scripts: "s2", config: "c", authProfiles: "a", legacyAuthFiles: "l", codexPlugin: "p" };
    expect(decideCodexMaintenance({ stamp: { inputs: { ...inputs, scripts: "s1" } }, inputs })).toBe("maintenance scripts changed");
    expect(decideCodexMaintenance({ stamp: { inputs }, inputs })).toBe(null);
  });

  it("ignores a stamp with another schema", async () => {
    await boot();
    const stamp = JSON.parse(fs.readFileSync(stampFile(), "utf8"));
    fs.writeFileSync(stampFile(), JSON.stringify({ ...stamp, schema: "alphaclaw.codex-maintenance.v0" }));
    await expect(boot()).resolves.toEqual({ status: "ok" });
  });

  it("reads every agent's auth store by a valid agent id only", async () => {
    fs.mkdirSync(path.join(stateDir, "agents", "ops", "agent"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents", ".hidden"), { recursive: true });
    await boot();
    expect(deps.loadAuthStore.mock.calls.map(([id]) => id).sort()).toEqual(["main", "main", "ops", "ops"]);
  });
});

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

  it("logs a short redacted summary of child diagnostics", async () => {
    env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-do-not-log";
    deps.execFileCmd.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput("[alphaclaw] Codex migration warning: access_token=do-not-log\n", "stderr");
      options.onOutput("Authorization: Bearer do-not-log-bearer-1234\nechoed gateway-token-do-not-log\nline four\nline four\nline five\n", "stderr");
    });
    await runBootNativeMaintenance(deps);
    const line = deps.logger.warn.mock.calls.map(([text]) => text).find((text) => text.startsWith("[alphaclaw] Codex migration completed with diagnostics"));
    expect(line).toBe("[alphaclaw] Codex migration completed with diagnostics, 5 lines: [alphaclaw] Codex migration warning: access_token=*** | Authorization: *** | echoed *** (+2 more)");
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain("do-not-log");
  });

  it("adds the diagnostics summary to a failed helper's line", async () => {
    deps.execFileCmd.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput("[alphaclaw] Codex migration failed: refresh=do-not-log\n", "stderr");
      throw Object.assign(new Error("exit"), { code: 1 });
    });
    await runBootNativeMaintenance(deps);
    expect(deps.logger.warn).toHaveBeenCalledWith("[alphaclaw] Codex migration process failed (exit 1); continuing admitted boot; diagnostics, 1 line: [alphaclaw] Codex migration failed: refresh=***");
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
    expect(source).toMatch(/runBootNativeMaintenance: \(options\) => runBootNativeMaintenance\(\{\s*\.\.\.options,\s*execFileCmd,\s*gatewayEnv,\s*managedDir: constants\.kOpenclawManagedDir,\s*\}\)/);
    expect(source).toContain("signal: bootSignal,");
    const server = fs.readFileSync(path.resolve(__dirname, "../../lib/server.js"), "utf8");
    expect(server.slice(server.indexOf("} = registerServerRoutes({"))).toContain("bootSignal: shutdownAbort.signal,");
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
      runBootMigration: vi.fn(async () => ({ status: "ok", ran: false })),
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

  it("runs helpers only after the doctor migration, before gateway launch under the same lease", async () => {
    let admit;
    deps.runBootMigration.mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
    const boot = runOnboardedBootSequence(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    admit({ status: "ok", ran: true });
    await boot;
    expect(execFileCmd).toHaveBeenCalledTimes(2);
    expect(deps.runBootNativeMaintenance).toHaveBeenCalledWith({ hold, signal: expect.any(AbortSignal) });
    expect(deps.runBootMigration.mock.invocationCallOrder[0]).toBeLessThan(execFileCmd.mock.invocationCallOrder[0]);
    expect(execFileCmd.mock.invocationCallOrder[1]).toBeLessThan(deps.startGateway.mock.invocationCallOrder[0]);
    expect(deps.startGateway.mock.invocationCallOrder[0]).toBeLessThan(hold.mock.invocationCallOrder[0]);
  });

  it("normalizes the config under the boot lease before the doctor migration and any native helper", async () => {
    await runOnboardedBootSequence(deps);
    expect(deps.normalizeBootConfig).toHaveBeenCalledWith({ hold, assertLease: expect.any(Function) });
    expect(deps.normalizeBootConfig.mock.invocationCallOrder[0]).toBeLessThan(deps.runBootMigration.mock.invocationCallOrder[0]);
    expect(deps.normalizeBootConfig.mock.invocationCallOrder[0]).toBeLessThan(execFileCmd.mock.invocationCallOrder[0]);
  });

  it("normalizes an existing pre-onboarding config under the lease without starting onboarded services", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-pre-onboarding-"));
    const configPath = path.join(root, "openclaw.json");
    const stalePath = "/app/node_modules/@chrysb/alphaclaw/lib/plugin/usage-tracker";
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { load: { paths: [stalePath, "/custom/plugin"] } } }));
    const env = { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: root };
    deps.onboarded = false;
    deps.normalizeBootConfig.mockImplementation((options) => normalizeBootConfig({ ...options, env }));
    try {
      await runOnboardedBootSequence(deps);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins.load.paths).toEqual(["/custom/plugin", kUsageTrackerPluginPath]);
      expect(deps.normalizeBootConfig).toHaveBeenCalledWith({ hold, assertLease: expect.any(Function) });
      expect(deps.normalizeBootConfig.mock.invocationCallOrder[0]).toBeLessThan(hold.mock.invocationCallOrder[0]);
      for (const step of [deps.runBootMigration, deps.runBootNativeMaintenance, deps.ensureManagedExecDefaults, deps.ensureUsageTrackerPluginConfig,
        deps.ensureWebhookMappingIds, deps.doSyncPromptFiles, deps.reloadEnv, deps.syncChannelConfig,
        deps.ensureGatewayProxyConfig, deps.startGateway, deps.watchdog.start, deps.gmailWatchService.start]) {
        expect(step).not.toHaveBeenCalled();
      }
      expect(deps.finalizeBootReport).toHaveBeenCalledWith({ migration: null, gatewayHeld: false });
      expect(hold).toHaveBeenCalledOnce();
      expect(getBootPhase().phase).toBe("ready");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["expired lease", "shutdown"])("keeps pre-onboarding normalization fenced by %s", async (blocker) => {
    deps.onboarded = false;
    const controller = new AbortController();
    deps.signal = controller.signal;
    if (blocker === "expired lease") hold.isValid.mockReturnValue(false);
    if (blocker === "shutdown") controller.abort("shutdown");
    await runOnboardedBootSequence(deps);
    expect(deps.normalizeBootConfig).not.toHaveBeenCalled();
    expect(deps.runBootMigration).not.toHaveBeenCalled();
    expect(deps.runBootNativeMaintenance).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).not.toHaveBeenCalled();
    expect(deps.gmailWatchService.start).not.toHaveBeenCalled();
    expect(hold).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed doctor migration", { status: "failed", ran: true, reason: "timed out" }],
    ["skipped doctor migration", { status: "skipped", reason: "no_config" }],
    ["empty doctor migration", null],
    ["throwing doctor migration", "throw"],
  ])("still runs the native helpers and launches the gateway after a %s", async (_label, outcome) => {
    deps.runBootMigration.mockImplementation(async () => {
      if (outcome === "throw") throw new Error("doctor exploded");
      return outcome;
    });
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).toHaveBeenCalledTimes(2);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: false }));
  });

  it("spawns zero helpers when the doctor migration outlives the boot lease", async () => {
    deps.runBootMigration.mockImplementation(async () => {
      hold.isValid.mockReturnValue(false);
      return { status: "ok", ran: true };
    });
    await runOnboardedBootSequence(deps);
    expect(execFileCmd).not.toHaveBeenCalled();
    expect(deps.ensureManagedExecDefaults).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: true }));
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
