const { runOnboardedBootSequence } = require("../../lib/server/startup");

describe("server/startup", () => {
  it("syncs gateway proxy config with the resolved setup URL before startup", () => {
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

    runOnboardedBootSequence({
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

  it("logs and continues when the ensure steps fail", () => {
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

    runOnboardedBootSequence(deps);

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

  it("logs the updated webhook mapping ids when the mapping changed", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = createBootDeps({
      ensureWebhookMappingIds: vi.fn(() => ({
        changed: true,
        updatedIds: ["gmail", "stripe"],
      })),
    });

    runOnboardedBootSequence(deps);

    expect(logSpy).toHaveBeenCalledWith(
      "[alphaclaw] Added IDs to webhook mappings: gmail, stripe",
    );
  });

  const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

  it("logs a rejected channel sync without aborting the boot sequence", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      syncChannelConfig: vi.fn(() =>
        Promise.reject(new Error("channel sync exploded")),
      ),
    });

    runOnboardedBootSequence(deps);
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot channel sync failed: channel sync exploded",
    );
    // The rejection never blocked the rest of the boot tick.
    expect(deps.startGateway).toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });

  it("logs a rejected gateway start without aborting the boot sequence", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      startGateway: vi.fn(() => Promise.reject(new Error("gateway exploded"))),
    });

    runOnboardedBootSequence(deps);
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot gateway start failed: gateway exploded",
    );
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });

  it("logs a synchronous readEnvFile throw as a channel sync failure and keeps booting", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      readEnvFile: vi.fn(() => {
        throw new Error("env file unreadable");
      }),
    });

    runOnboardedBootSequence(deps);

    // readEnvFile throws during argument evaluation — synchronously, before
    // syncChannelConfig can even be invoked.
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot channel sync failed: env file unreadable",
    );
    expect(deps.ensureGatewayProxyConfig).toHaveBeenCalled();
    expect(deps.startGateway).toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });

  it("logs a primeStatusCaches throw after the watchdog has already started", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      primeStatusCaches: vi.fn(() => {
        throw new Error("caches broke");
      }),
    });

    runOnboardedBootSequence(deps);

    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Failed to prime status caches on boot: caches broke",
    );
    expect(deps.primeStatusCaches).toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });
});
