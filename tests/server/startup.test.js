const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");
const { kOpenclawBootMigrationLeaseMs } = require("../../lib/server/constants");

describe("server/startup", () => {
  // runOnboardedBootSequence mutates the boot-phase module singleton; leave
  // every test on a settled boot so nothing leaks across tests.
  afterEach(() => {
    setBootPhase("ready");
    vi.restoreAllMocks();
  });

  it("reports lock contention FIRST inside the boot lock — before any step that can spawn the openclaw CLI", async () => {
    const callOrder = [];
    const mkStep = (name, ret) =>
      vi.fn(() => {
        callOrder.push(name);
        return ret;
      });
    await runOnboardedBootSequence({
      reportLockContentionAtBoot: mkStep("reportLockContentionAtBoot", {
        live: [],
        lockDirs: [],
        lines: [],
      }),
      ensureManagedExecDefaults: mkStep("ensureManagedExecDefaults"),
      ensureUsageTrackerPluginConfig: mkStep("ensureUsageTrackerPluginConfig"),
      ensureWebhookMappingIds: mkStep("ensureWebhookMappingIds", {
        changed: false,
        updatedIds: [],
      }),
      doSyncPromptFiles: mkStep("doSyncPromptFiles"),
      reloadEnv: mkStep("reloadEnv"),
      syncChannelConfig: mkStep("syncChannelConfig"),
      readEnvFile: mkStep("readEnvFile", []),
      ensureGatewayProxyConfig: mkStep("ensureGatewayProxyConfig"),
      resolveSetupUrl: mkStep("resolveSetupUrl", "https://setup.example.com"),
      runBootMigration: mkStep("runBootMigration", { status: "ok", ran: false }),
      startGateway: mkStep("startGateway"),
      watchdog: { start: mkStep("watchdog.start") },
      gmailWatchService: { start: mkStep("gmailWatchService.start") },
    });
    // The report must beat every CLI-spawning step: on openclaw >= 2026.9.1
    // all CLI work serializes on the state-lifecycle coordinator held by a
    // LIVE process — an orphan from a killed previous boot is what a later
    // "owns state-lifecycle" refusal points at; name it before anything can
    // contend with it.
    expect(callOrder[0]).toBe("reportLockContentionAtBoot");
    expect(callOrder.indexOf("reportLockContentionAtBoot")).toBeLessThan(
      callOrder.indexOf("ensureManagedExecDefaults"),
    );
    expect(callOrder.indexOf("reportLockContentionAtBoot")).toBeLessThan(
      callOrder.indexOf("syncChannelConfig"),
    );
    expect(callOrder.indexOf("reportLockContentionAtBoot")).toBeLessThan(
      callOrder.indexOf("runBootMigration"),
    );
    expect(callOrder.indexOf("runBootMigration")).toBeLessThan(
      callOrder.indexOf("startGateway"),
    );
  });

  it("a throwing boot contention report never aborts the boot sequence", async () => {
    const startGateway = vi.fn();
    await runOnboardedBootSequence({
      reportLockContentionAtBoot: vi.fn(() => {
        throw new Error("report exploded");
      }),
      ensureManagedExecDefaults: vi.fn(),
      ensureUsageTrackerPluginConfig: vi.fn(),
      ensureWebhookMappingIds: vi.fn(() => ({ changed: false, updatedIds: [] })),
      doSyncPromptFiles: vi.fn(),
      reloadEnv: vi.fn(),
      syncChannelConfig: vi.fn(),
      readEnvFile: vi.fn(() => []),
      ensureGatewayProxyConfig: vi.fn(),
      resolveSetupUrl: vi.fn(() => "https://setup.example.com"),
      startGateway,
      watchdog: { start: vi.fn() },
      gmailWatchService: { start: vi.fn() },
    });
    expect(startGateway).toHaveBeenCalled();
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

  it("a throwing prompt-file sync, env reload, or proxy-config step never skips the gateway launch (F008)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      doSyncPromptFiles: vi.fn(() => {
        throw new Error("EACCES: mkdir gogcli");
      }),
      reloadEnv: vi.fn(() => {
        throw new Error("env reload broke");
      }),
      ensureGatewayProxyConfig: vi.fn(() => {
        throw new Error("proxy config broke");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.syncChannelConfig).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot prompt-file sync failed: EACCES: mkdir gogcli",
    );
    expect(errorSpy).toHaveBeenCalledWith("[alphaclaw] Boot env reload failed: env reload broke");
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot gateway proxy config failed: proxy config broke",
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Boot sequence failed"));
    errorSpy.mockRestore();
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
      "[alphaclaw] Boot gateway start failed: gateway refused to launch",
    );
    // The lifecycle lock must not stay held after a failed boot.
    expect(release).toHaveBeenCalledTimes(1);
    // Supervision still starts: recovering a down gateway is the watchdog's
    // job, and the boot_failed phase (above) carries the remediation UI.
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });

  it("reaches the ready boot phase and releases the lock on a successful boot", async () => {
    const release = vi.fn();
    const acquireLifecycleLock = vi.fn(async () => release);
    const deps = createBootDeps({ acquireLifecycleLock });

    await runOnboardedBootSequence(deps);

    // The migration step can run doctor --fix (up to 30 min):
    // the boot hold must carry the sized lease, not the default 10-min one
    // whose force-release would hand the gateway to a queued operation
    // mid-migration.
    expect(acquireLifecycleLock).toHaveBeenCalledWith("boot", {
      leaseMs: kOpenclawBootMigrationLeaseMs,
      cleanup: expect.objectContaining({ wait: expect.any(Function) }),
    });
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
    expect(acquireLifecycleLock).toHaveBeenCalledWith("boot", {
      leaseMs: kOpenclawBootMigrationLeaseMs,
      cleanup: expect.objectContaining({ wait: expect.any(Function) }),
    });
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

  it("logs a synchronous readEnvFile throw as a channel sync failure and keeps booting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      readEnvFile: vi.fn(() => {
        throw new Error("env file unreadable");
      }),
    });

    await runOnboardedBootSequence(deps);

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

  it("starts the gateway strictly after the doctor migration and only when onboarded", async () => {
    const callOrder = [];
    const deps = createBootDeps({
      runBootMigration: vi.fn(async () => {
        callOrder.push("runBootMigration");
        return { status: "ok", ran: true };
      }),
      startGateway: vi.fn(async () => {
        callOrder.push("startGateway");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(callOrder).toEqual(["runBootMigration", "startGateway"]);
    expect(deps.runBootMigration).toHaveBeenCalledWith({ operation: expect.objectContaining({ signal: expect.anything() }) });
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("a failed doctor migration is reported and the gateway starts anyway", async () => {
    const deps = createBootDeps({
      runBootMigration: vi.fn(async () => ({ status: "failed", ran: true, reason: "timed out" })),
      finalizeBootReport: vi.fn(),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.finalizeBootReport).toHaveBeenCalledWith({
      migration: { status: "failed", ran: true, reason: "timed out" },
      gatewayHeld: false,
    });
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("a throwing doctor migration is logged, recorded as an error, and never holds the gateway", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      runBootMigration: vi.fn(async () => {
        throw new Error("doctor exploded");
      }),
      finalizeBootReport: vi.fn(),
    });

    await runOnboardedBootSequence(deps);

    expect(errorSpy).toHaveBeenCalledWith("[alphaclaw] Boot doctor migration failed: doctor exploded");
    expect(deps.finalizeBootReport).toHaveBeenCalledWith({
      migration: { status: "error", reason: "doctor exploded" },
      gatewayHeld: false,
    });
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
  });

  it("holds the gateway when the boot lease is lost — another owner now runs the lifecycle", async () => {
    let valid = true;
    const release = Object.assign(vi.fn(), { isValid: () => valid });
    const deps = createBootDeps({
      acquireLifecycleLock: vi.fn(async () => release),
      runBootMigration: vi.fn(async () => {
        valid = false;
        return { status: "ok", ran: true };
      }),
      finalizeBootReport: vi.fn(),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.ensureManagedExecDefaults).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith(expect.objectContaining({ gatewayHeld: true }));
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain start path when no runBootMigration dep is provided", async () => {
    const deps = createBootDeps();

    await runOnboardedBootSequence(deps);

    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  // ── boot order: restart-op closer → report → normalization → doctor
  // migration → ensure steps → finalizeBootReport → startGateway ──
  const mkOrderedDeps = (callOrder, overrides = {}) => {
    const step = (name, ret) =>
      vi.fn(async () => {
        callOrder.push(name);
        return ret;
      });
    return createBootDeps({
      reportLockContentionAtBoot: vi.fn(() => {
        callOrder.push("reportLockContentionAtBoot");
        return { live: [], lockDirs: [], lines: [] };
      }),
      reconcileRestartOperationAtBoot: step("reconcileRestartOperationAtBoot"),
      recordBootReportServerPhase: step("recordBootReportServerPhase", { serverPhase: {} }),
      normalizeBootConfig: step("normalizeBootConfig", { changed: false }),
      runBootMigration: step("runBootMigration", { status: "ok", ran: false }),
      ensureManagedExecDefaults: step("ensureManagedExecDefaults"),
      ensureUsageTrackerPluginConfig: vi.fn(() => callOrder.push("ensureUsageTrackerPluginConfig")),
      ensureWebhookMappingIds: vi.fn(() => {
        callOrder.push("ensureWebhookMappingIds");
        return { changed: false, updatedIds: [] };
      }),
      doSyncPromptFiles: vi.fn(() => callOrder.push("doSyncPromptFiles")),
      reloadEnv: vi.fn(() => callOrder.push("reloadEnv")),
      readEnvFile: vi.fn(() => {
        callOrder.push("readEnvFile");
        return [];
      }),
      syncChannelConfig: step("syncChannelConfig"),
      resolveSetupUrl: vi.fn(() => {
        callOrder.push("resolveSetupUrl");
        return "https://setup.example.com";
      }),
      ensureGatewayProxyConfig: vi.fn(() => callOrder.push("ensureGatewayProxyConfig")),
      finalizeBootReport: step("finalizeBootReport", null),
      startGateway: step("startGateway"),
      watchdog: { start: vi.fn(() => callOrder.push("watchdog.start")) },
      gmailWatchService: { start: vi.fn(() => callOrder.push("gmailWatchService.start")) },
      ...overrides,
    });
  };

  it("runs the boot steps in the fixed order: restart-op closer → report → normalization → doctor migration → ensure steps → finalizeBootReport → startGateway", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder);

    await runOnboardedBootSequence(deps);

    expect(callOrder).toEqual([
      "reportLockContentionAtBoot",
      "reconcileRestartOperationAtBoot",
      "recordBootReportServerPhase",
      "normalizeBootConfig",
      "runBootMigration",
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "ensureWebhookMappingIds",
      "doSyncPromptFiles",
      "reloadEnv",
      "readEnvFile",
      "syncChannelConfig",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "finalizeBootReport",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("runs normalization and the doctor migration under the boot lease, before startGateway", async () => {
    const callOrder = [];
    const release = Object.assign(vi.fn(() => callOrder.push("release")), { isValid: () => true });
    const deps = mkOrderedDeps(callOrder, {
      acquireLifecycleLock: vi.fn(async () => {
        callOrder.push("acquireLock");
        return release;
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.normalizeBootConfig).toHaveBeenCalledWith({ hold: release, assertLease: expect.any(Function) });
    expect(callOrder.indexOf("acquireLock")).toBeLessThan(callOrder.indexOf("normalizeBootConfig"));
    expect(callOrder.indexOf("runBootMigration")).toBeLessThan(callOrder.indexOf("startGateway"));
    expect(callOrder.indexOf("startGateway")).toBeLessThan(callOrder.indexOf("release"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("pre-onboarding: normalizes the config, never runs the doctor migration, finalizes and never launches", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder, { onboarded: false });

    await runOnboardedBootSequence(deps);

    expect(callOrder).toEqual([
      "reportLockContentionAtBoot",
      "reconcileRestartOperationAtBoot",
      "recordBootReportServerPhase",
      "normalizeBootConfig",
      "finalizeBootReport",
    ]);
    expect(deps.runBootMigration).not.toHaveBeenCalled();
    expect(deps.finalizeBootReport).toHaveBeenCalledWith({ migration: null, gatewayHeld: false });
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).not.toHaveBeenCalled();
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("a throwing normalization is logged and the boot continues", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = mkOrderedDeps([], {
      normalizeBootConfig: vi.fn(async () => {
        throw new Error("normalize exploded");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(errorSpy).toHaveBeenCalledWith("[alphaclaw] Boot config normalization failed: normalize exploded");
    expect(deps.runBootMigration).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
  });

  it("boot step failures are logged and still launch the gateway (F008)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (label) =>
      vi.fn(async () => {
        throw new Error(`${label} exploded`);
      });
    const deps = mkOrderedDeps([], {
      reconcileRestartOperationAtBoot: boom("restart-op"),
      recordBootReportServerPhase: boom("report"),
      finalizeBootReport: boom("finalize"),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.runBootMigration).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    for (const label of [
      "Boot restart-operation reconcile failed: restart-op exploded",
      "Boot report server phase failed: report exploded",
      "Boot report finalize failed: finalize exploded",
    ]) {
      expect(errorSpy).toHaveBeenCalledWith(`[alphaclaw] ${label}`);
    }
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Boot sequence failed"));
  });

  it("without the optional steps injected, the boot runs only the ensure steps and the launch (null defaults)", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder, {
      reconcileRestartOperationAtBoot: null,
      recordBootReportServerPhase: null,
      normalizeBootConfig: null,
      runBootMigration: null,
      finalizeBootReport: null,
    });

    await runOnboardedBootSequence(deps);

    expect(callOrder).toEqual([
      "reportLockContentionAtBoot",
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

  it("logs a primeStatusCaches throw after the watchdog has already started", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      primeStatusCaches: vi.fn(() => {
        throw new Error("caches broke");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Failed to prime status caches on boot: caches broke",
    );
    expect(deps.primeStatusCaches).toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalled();
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
  });
});
