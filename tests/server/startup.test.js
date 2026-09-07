const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");
const {
  kOpenclawReconcileLifecycleLeaseMs,
} = require("../../lib/server/constants");

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
      reconcileBootConfig: mkStep("reconcileBootConfig", { status: "ok" }),
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
      callOrder.indexOf("reconcileBootConfig"),
    );
    expect(callOrder.indexOf("reconcileBootConfig")).toBeLessThan(
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

    // The reconcile step can run a sized doctor migration (up to 30 min):
    // the boot hold must carry the sized lease, not the default 10-min one
    // whose force-release would hand the gateway to a queued operation
    // mid-migration.
    expect(acquireLifecycleLock).toHaveBeenCalledWith("boot", {
      leaseMs: kOpenclawReconcileLifecycleLeaseMs,
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
      leaseMs: kOpenclawReconcileLifecycleLeaseMs,
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

  it("skips the gateway launch but still starts supervision when the reconcile holds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = createBootDeps({
      reconcileBootConfig: vi.fn(async () => ({
        status: "held",
        hold: { reason: "settings migration failed" },
      })),
    });

    await runOnboardedBootSequence(deps);

    // Fail CLOSED: the gateway must not start on the rejected config, but
    // the full admin UI (watchdog, gmail, caches, ready phase) stays up so
    // the operator can reach the retry actions.
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(deps.gmailWatchService.start).toHaveBeenCalled();
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    expect(warnSpy).toHaveBeenCalledWith(
      "[alphaclaw] Gateway held: settings migration failed",
    );
  });

  it("holds the gateway when reconcileBootConfig itself rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = createBootDeps({
      reconcileBootConfig: vi.fn(async () => {
        throw new Error("reconcile machinery exploded");
      }),
    });

    await runOnboardedBootSequence(deps);

    // A reconcile machinery error must never start the gateway blind.
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[alphaclaw] Boot config reconciliation failed (gateway held): reconcile machinery exploded",
    );
  });

  it("starts the gateway strictly after a clean reconcile", async () => {
    const callOrder = [];
    const deps = createBootDeps({
      reconcileBootConfig: vi.fn(async () => {
        callOrder.push("reconcileBootConfig");
        return { status: "ok" };
      }),
      startGateway: vi.fn(async () => {
        callOrder.push("startGateway");
      }),
    });

    await runOnboardedBootSequence(deps);

    expect(callOrder).toEqual(["reconcileBootConfig", "startGateway"]);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("keeps the legacy start path when no reconcileBootConfig dep is provided", async () => {
    const deps = createBootDeps();

    await runOnboardedBootSequence(deps);

    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  // ── #76 boot order: closers → report → reconcileInstalled → compat gate →
  // ensure steps → reconcileBootConfig → finalizeBootReport → startGateway ──
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
      closeDanglingRecordsAtBoot: step("closeDanglingRecordsAtBoot", {
        closedRuns: [],
        closedLastUpdateRun: false,
      }),
      reconcileRestartOperationAtBoot: step("reconcileRestartOperationAtBoot"),
      recordBootReportServerPhase: step("recordBootReportServerPhase", { serverPhase: {} }),
      reconcileInstalledAtBoot: step("reconcileInstalledAtBoot", { ok: true }),
      assessLaunchCompatibilityAtBoot: step("assessLaunchCompatibilityAtBoot", {
        compatible: true,
        hold: null,
      }),
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
      reconcileBootConfig: step("reconcileBootConfig", { status: "ok", reason: "already-completed" }),
      finalizeBootReport: step("finalizeBootReport", null),
      startGateway: step("startGateway"),
      watchdog: { start: vi.fn(() => callOrder.push("watchdog.start")) },
      gmailWatchService: { start: vi.fn(() => callOrder.push("gmailWatchService.start")) },
      ...overrides,
    });
  };

  it("runs the #76 boot steps in the fixed order: closers → report → reconcileInstalled → compat gate → ensure steps → reconcileBootConfig → finalizeBootReport → startGateway", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder);

    await runOnboardedBootSequence(deps);

    // Strict: Stage 3 fills reconcileInstalled / the compat gate in; the
    // ORDER is the contract (no doctor --fix from a wrong binary, no launch
    // before the verdict, the report finalized on every reconcile outcome).
    expect(callOrder).toEqual([
      "reportLockContentionAtBoot",
      "closeDanglingRecordsAtBoot",
      "reconcileRestartOperationAtBoot",
      "recordBootReportServerPhase",
      "reconcileInstalledAtBoot",
      "assessLaunchCompatibilityAtBoot",
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "ensureWebhookMappingIds",
      "doSyncPromptFiles",
      "reloadEnv",
      "readEnvFile",
      "syncChannelConfig",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "reconcileBootConfig",
      "finalizeBootReport",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
  });

  it("threads the reconcile outcome (status + reason) and the compat verdict into finalizeBootReport", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder, {
      reconcileBootConfig: vi.fn(async () => ({
        status: "ok",
        reason: "round-trip-restore",
        warnings: ["w1"],
      })),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.finalizeBootReport).toHaveBeenCalledTimes(1);
    expect(deps.finalizeBootReport).toHaveBeenCalledWith({
      reconcile: { status: "ok", reason: "round-trip-restore", warnings: ["w1"] },
      compat: { compatible: true, hold: null },
      gatewayHeld: false,
    });
  });

  it("finalizes the boot report on a held reconcile AND on a throwing reconcile (the verdict must name what held the gateway)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const held = mkOrderedDeps([], {
      reconcileBootConfig: vi.fn(async () => ({
        status: "held",
        hold: { reason: "settings migration for 2026.9.2 failed" },
      })),
    });
    await runOnboardedBootSequence(held);
    expect(held.startGateway).not.toHaveBeenCalled();
    expect(held.finalizeBootReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reconcile: expect.objectContaining({ status: "held" }),
        gatewayHeld: true,
      }),
    );

    const threw = mkOrderedDeps([], {
      reconcileBootConfig: vi.fn(async () => {
        throw new Error("reconcile machinery exploded");
      }),
    });
    await runOnboardedBootSequence(threw);
    expect(threw.startGateway).not.toHaveBeenCalled();
    expect(threw.finalizeBootReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reconcile: { status: "error", reason: "reconcile machinery exploded" },
        gatewayHeld: true,
      }),
    );
  });

  it("a throw in ANY new step (closers, report, reconcileInstalled, compat gate, finalize) is logged and still launches the gateway (F008)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (label) =>
      vi.fn(async () => {
        throw new Error(`${label} exploded`);
      });
    const deps = mkOrderedDeps([], {
      closeDanglingRecordsAtBoot: boom("closers"),
      reconcileRestartOperationAtBoot: boom("restart-op"),
      recordBootReportServerPhase: boom("report"),
      reconcileInstalledAtBoot: boom("reconcileInstalled"),
      // The compat gate THROWING is not a verdict: fail open.
      assessLaunchCompatibilityAtBoot: boom("compat"),
      finalizeBootReport: boom("finalize"),
    });

    await runOnboardedBootSequence(deps);

    expect(deps.reconcileBootConfig).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(deps.watchdog.start).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    for (const label of [
      "Boot dangling-record close failed: closers exploded",
      "Boot restart-operation reconcile failed: restart-op exploded",
      "Boot report server phase failed: report exploded",
      "Boot installed-tree reconcile failed: reconcileInstalled exploded",
      "Boot launch compatibility gate failed: compat exploded",
      "Boot report finalize failed: finalize exploded",
    ]) {
      expect(errorSpy).toHaveBeenCalledWith(`[alphaclaw] ${label}`);
    }
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("Boot sequence failed"));
  });

  it("an explicit compat-gate verdict holds the gateway ({ hold }) or ({ compatible: false }) — supervision and the ready phase still come up", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withHold = mkOrderedDeps([], {
      assessLaunchCompatibilityAtBoot: vi.fn(async () => ({
        compatible: false,
        hold: { reason: "version_mismatch", installed: "2026.8.1", expected: "2026.9.2" },
      })),
    });
    await runOnboardedBootSequence(withHold);
    expect(withHold.startGateway).not.toHaveBeenCalled();
    // The config ensure steps and the reconciler still run: the admin UI
    // (retry actions) needs them, and Stage 3's reconciler returns `held`
    // before any doctor when the hold reason is structural.
    expect(withHold.reconcileBootConfig).toHaveBeenCalledTimes(1);
    expect(withHold.finalizeBootReport).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayHeld: true }),
    );
    expect(withHold.watchdog.start).toHaveBeenCalledTimes(1);
    expect(getBootPhase()).toEqual({ phase: "ready", error: null });
    expect(warnSpy).toHaveBeenCalledWith("[alphaclaw] Gateway held: version_mismatch");

    const incompatibleNoHold = mkOrderedDeps([], {
      assessLaunchCompatibilityAtBoot: vi.fn(async () => ({ compatible: false, hold: null })),
    });
    await runOnboardedBootSequence(incompatibleNoHold);
    expect(incompatibleNoHold.startGateway).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[alphaclaw] Gateway held: launch compatibility gate refused",
    );

    // null / undefined / compatible:null (no oracle) is NOT a hold: fail open.
    for (const verdict of [null, undefined, { compatible: null, hold: null }, { compatible: true }]) {
      const open = mkOrderedDeps([], {
        assessLaunchCompatibilityAtBoot: vi.fn(async () => verdict),
      });
      await runOnboardedBootSequence(open);
      expect(open.startGateway).toHaveBeenCalledTimes(1);
    }
  });

  it("hands the boot lifecycle lease to reconcileInstalledAtBoot and the compat gate as { hold } — the lock is not re-entrant, so neither step may acquire its own", async () => {
    const release = Object.assign(vi.fn(), { isValid: () => true });
    const acquireLifecycleLock = vi.fn(async () => release);
    const deps = mkOrderedDeps([], { acquireLifecycleLock });

    await runOnboardedBootSequence(deps);

    expect(deps.reconcileInstalledAtBoot).toHaveBeenCalledTimes(1);
    expect(deps.reconcileInstalledAtBoot).toHaveBeenCalledWith({ hold: release });
    expect(deps.assessLaunchCompatibilityAtBoot).toHaveBeenCalledTimes(1);
    expect(deps.assessLaunchCompatibilityAtBoot).toHaveBeenCalledWith({ hold: release });
    // Both ran INSIDE the lease: the boot's release comes after them.
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.reconcileInstalledAtBoot.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
    expect(deps.assessLaunchCompatibilityAtBoot.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
    // No lock wired (tests, legacy) → { hold: null }, never undefined args.
    const unlocked = mkOrderedDeps([]);
    await runOnboardedBootSequence(unlocked);
    expect(unlocked.reconcileInstalledAtBoot).toHaveBeenCalledWith({ hold: null });
    expect(unlocked.assessLaunchCompatibilityAtBoot).toHaveBeenCalledWith({ hold: null });
  });

  it("without the new steps injected, the legacy boot is byte-for-byte unchanged (null defaults)", async () => {
    const callOrder = [];
    const deps = mkOrderedDeps(callOrder, {
      closeDanglingRecordsAtBoot: null,
      reconcileRestartOperationAtBoot: null,
      recordBootReportServerPhase: null,
      reconcileInstalledAtBoot: null,
      assessLaunchCompatibilityAtBoot: null,
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
      "reconcileBootConfig",
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
