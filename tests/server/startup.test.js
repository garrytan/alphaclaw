const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");

describe("server/startup", () => {
  // runOnboardedBootSequence mutates the boot-phase module singleton; leave
  // every test on a settled boot so nothing leaks across tests.
  afterEach(() => {
    setBootPhase("ready");
  });

  it("syncs gateway proxy config with the resolved setup URL before startup", async () => {
    const callOrder = [];
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const ensureWebhookMappingIds = vi.fn(() => {
      callOrder.push("ensureWebhookMappingIds");
      return { changed: false, updatedIds: [] };
    });
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const readEnvFile = vi.fn(() => {
      callOrder.push("readEnvFile");
      return [{ key: "OPENAI_API_KEY", value: "sk-test" }];
    });
    const syncChannelConfig = vi.fn(() => callOrder.push("syncChannelConfig"));
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const startGateway = vi.fn(() => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    await runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      ensureWebhookMappingIds,
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    expect(ensureGatewayProxyConfig).toHaveBeenCalledWith("https://setup.example.com");
    expect(callOrder).toEqual([
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "ensureWebhookMappingIds",
      "doSyncPromptFiles",
      "reloadEnv",
      "readEnvFile",
      "syncChannelConfig",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
  });

  const createBootDeps = (overrides = {}) => ({
    ensureManagedExecDefaults: vi.fn(),
    ensureUsageTrackerPluginConfig: vi.fn(),
    ensureWebhookMappingIds: vi.fn(() => ({ changed: false, updatedIds: [] })),
    doSyncPromptFiles: vi.fn(),
    reloadEnv: vi.fn(),
    syncChannelConfig: vi.fn(),
    readEnvFile: vi.fn(() => []),
    ensureGatewayProxyConfig: vi.fn(),
    resolveSetupUrl: vi.fn(() => "https://setup.example.com"),
    startGateway: vi.fn(),
    watchdog: { start: vi.fn() },
    gmailWatchService: { start: vi.fn() },
    ...overrides,
  });

  it("logs and continues when the ensure steps fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      ensureManagedExecDefaults: vi.fn(() => {
        throw new Error("exec defaults broke");
      }),
      ensureUsageTrackerPluginConfig: vi.fn(() => {
        throw new Error("usage tracker broke");
      }),
      ensureWebhookMappingIds: vi.fn(() => {
        throw new Error("webhook ids broke");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Failed to ensure managed exec defaults on boot: exec defaults broke",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Failed to ensure usage-tracker plugin config on boot: usage tracker broke",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Failed to ensure webhook mapping IDs on boot: webhook ids broke",
    );
    // Boot still proceeds through the remaining steps.
    expect(deps.startGateway).toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });

  it("logs the updated webhook mapping ids when the mapping changed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = createBootDeps({
      ensureWebhookMappingIds: vi.fn(() => ({
        changed: true,
        updatedIds: ["gmail", "stripe"],
      })),
    });

    await runOnboardedBootSequence(deps);

    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] Added IDs to webhook mappings: gmail, stripe",
    );
  });

  it("resolves with a failed boot phase and releases the lock when startGateway rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const release = vi.fn();
    const acquireLifecycleLock = vi.fn(async () => release);
    const deps = createBootDeps({
      acquireLifecycleLock,
      startGateway: vi.fn(async () => {
        throw new Error("gateway refused to launch");
      }),
    });

    // Boot failures are reported via boot-phase, never thrown at the caller
    // (callers fire-and-forget; a rejection here would be unhandled).
    await expect(runOnboardedBootSequence(deps)).resolves.toBeUndefined();

    expect(getBootPhase()).toEqual({
      phase: "failed",
      error: expect.stringContaining("gateway refused to launch"),
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot sequence failed: gateway refused to launch",
    );
    // The lifecycle lock must not stay held after a failed boot.
    expect(release).toHaveBeenCalledTimes(1);
    // Services downstream of the failure point never start.
    expect(deps.watchdog.start).not.toHaveBeenCalled();
    expect(deps.gmailWatchService.start).not.toHaveBeenCalled();
  });

  it("reaches the ready boot phase and releases the lock on a successful boot", async () => {
    const release = vi.fn();
    const acquireLifecycleLock = vi.fn(async () => release);
    const deps = createBootDeps({ acquireLifecycleLock });

    await runOnboardedBootSequence(deps);

    expect(acquireLifecycleLock).toHaveBeenCalledWith("boot");
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
  });

  it("awaits the lifecycle lock before running any gateway-mutating step", async () => {
    let resolveLock;
    const release = vi.fn();
    const acquireLifecycleLock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLock = () => resolve(release);
        }),
    );
    const deps = createBootDeps({ acquireLifecycleLock });

    const bootPromise = runOnboardedBootSequence(deps);
    await new Promise((resolve) => setImmediate(resolve));

    // Boot is parked on acquire("boot"): nothing that mutates gateway or
    // channel state may run while another operation holds the lock.
    expect(acquireLifecycleLock).toHaveBeenCalledWith("boot");
    expect(deps.ensureManagedExecDefaults).not.toHaveBeenCalled();
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    // The phase already reports "starting" while waiting, though.
    expect(getBootPhase()).toEqual({ phase: "starting_gateway", error: null });

    resolveLock();
    await bootPromise;

    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
