const fs = require("fs");
const os = require("os");
const path = require("path");

const express = require("express");
const request = require("supertest");

const { createWatchdog } = require("../../lib/server/watchdog");
const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");
const {
  createOperationEventsService,
} = require("../../lib/server/operation-events");

// End-to-end coverage for the watchdog x release-channel contract: the REAL
// watchdog wired (exactly like lib/server.js) to a REAL channel-sync service
// backed by real temp-dir state/overlay stores. Only the gateway itself is
// faked (fetch stub + spies), following watchdog-gateway-hardening.e2e.

const kSilentLogger = { log() {}, warn() {}, error() {} };

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled =
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const writePackageFixture = (
  packageDir,
  {
    version,
    bin = { openclaw: "bin/entry.js" },
    thinking = true,
    extensions = true,
  } = {},
) => {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, ...(bin ? { bin } : {}) }, null, 2)}\n`,
  );
  if (bin) {
    const relative = typeof bin === "string" ? bin : Object.values(bin)[0];
    const binPath = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok');\n");
  }
  if (thinking) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "thinking-levels.js"),
      "exports.listThinkingLevelOptions = () => [];\n",
    );
  }
  if (extensions) {
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
      recursive: true,
    });
  }
  return packageDir;
};

const writeInstallFixture = (installDir, options) =>
  writePackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    options,
  );

const saveOverlayFixture = (store, version) =>
  store.saveOverlayFromTempInstall({
    openclawPackageDir: writePackageFixture(
      path.join(mkTemp("alphaclaw-wg-overlay-src-"), "openclaw"),
      { version },
    ),
    version,
  });

const defaultRunnerImpl = async () => ({
  ok: true,
  code: 0,
  tail: "",
  timedOut: false,
});

// Real channel-sync service over real temp dirs. Overlay store carries the
// pin snapshot plus (optionally) a last-known-good build.
const createChannelHarness = ({
  pin = "1.0.0",
  channel = "beta",
  installedVersion = "1.1.0",
  sentinelVersion = "1.1.0",
  applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
  lastKnownGoodPackage = null,
  overlays = ["1.0.0"],
  stabilizationWindowMs = undefined,
  acceptanceHoldMs = undefined,
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-wg-channel-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-wg-channel-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-wg-channel-install-");
  if (installedVersion) {
    writeInstallFixture(installDir, { version: installedVersion });
  }

  const nowRef = { now: 1_000_000 };
  const nowFn = () => nowRef.now;
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    nowFn,
    logger: kSilentLogger,
  });
  if (sentinelVersion) {
    store.writeSentinel({ installDir, version: sentinelVersion });
  }
  store.updateState((s) => {
    s.pinVersion = pin;
    s.applied = applied;
    if (lastKnownGoodPackage) s.lastKnownGood.package = lastKnownGoodPackage;
    return s;
  });
  for (const version of overlays) {
    expect(saveOverlayFixture(store, version)).toEqual({ ok: true });
  }

  const notify = vi.fn(async () => {});
  const restartProcess = vi.fn();
  const watchdogRef = { current: null };

  const service = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store,
    runStream: { runStreamed: vi.fn(defaultRunnerImpl) },
    installToTempDir: vi.fn(() => {
      throw new Error("installToTempDir must not run in these scenarios");
    }),
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => channel,
    releases: null,
    isOnboarded: () => true,
    restartProcess,
    clearVersionCache: vi.fn(),
    notify,
    watchdogLatch: () => watchdogRef.current?.latchManualIntervention?.(),
    nowFn,
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
    ...(stabilizationWindowMs !== undefined ? { stabilizationWindowMs } : {}),
    ...(acceptanceHoldMs !== undefined ? { acceptanceHoldMs } : {}),
  });

  return {
    service,
    store,
    installDir,
    notify,
    restartProcess,
    nowRef,
    watchdogRef,
  };
};

const createFakeGateway = () => ({ healthy: true });

// Real watchdog wired to the real channel service, exactly like lib/server.js.
const createStack = ({ autoRepair = false, channel, fakeGateway } = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";

  const gateway = fakeGateway || createFakeGateway();

  global.fetch = vi.fn(async () => {
    if (!gateway.healthy) throw new Error("gateway unavailable");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    };
  });

  const clawCmd = vi.fn(async () => ({ ok: true, stdout: "" }));
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };

  const watchdog = createWatchdog({
    clawCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    releaseChannelHooks: {
      getInfo: () => channel.service.getChannelInfo(),
      requestRollback: (payload) =>
        channel.service.requestChannelRollback(payload),
      onHealthy: () => channel.service.onGatewayHealthy(),
      onUnhealthy: () => channel.service.onGatewayUnhealthy(),
    },
  });
  channel.watchdogRef.current = watchdog;

  return {
    watchdog,
    gateway,
    clawCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
  };
};

const mountChannelRoutes = (channel) => {
  const app = express();
  app.use(express.json());
  registerOpenclawChannelRoutes({
    app,
    fs,
    OPENCLAW_DIR: path.join(mkTemp("alphaclaw-wg-routes-"), ".openclaw"),
    isOnboarded: () => true,
    openclawChannelService: channel.service,
    openclawReleasesService: {
      isKnownVersion: () => true,
      isKnownCommit: () => true,
      getCatalog: async () => ({ ok: true, stable: [], beta: [] }),
      annotateCatalog: (catalog) => catalog,
    },
    operationEvents: createOperationEventsService(),
    restartRequiredState: {
      markRequired: vi.fn(),
      getSnapshot: async () => ({ restartRequired: false }),
    },
  });
  return app;
};

const notifierMessages = (notifier) =>
  notifier.notify.mock.calls.map((call) => String(call?.[0] || ""));

const channelNotifyMessages = (channel) =>
  channel.notify.mock.calls.map((call) => String(call?.[0] || ""));

const crashLoopNotices = (notifier) =>
  notifierMessages(notifier).filter((message) =>
    message.includes("Crash loop detected"),
  );

describe("server/watchdog gateway + release channel (e2e)", { retry: 1 }, () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) {
      delete process.env.WATCHDOG_AUTO_REPAIR;
    } else {
      process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    }
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED =
        kOriginalNotificationsDisabled;
    }
    if (kOriginalFetch == null) {
      delete global.fetch;
    } else {
      global.fetch = kOriginalFetch;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rolls back to last-known-good on exit 78 inside the stabilization window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const channel = createChannelHarness({
      applied: { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
      lastKnownGoodPackage: "1.0.5",
      overlays: ["1.0.0", "1.0.5"],
    });
    const stack = createStack({ autoRepair: false, channel });
    stack.gateway.healthy = false;

    stack.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    stack.watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["fatal configuration error"],
    });
    await flushMicrotasks();

    const marker = channel.store.readMarker();
    expect(marker).toEqual(
      expect.objectContaining({
        target: { kind: "package", channel: "beta", version: "1.0.5" },
        blockedId: "1.1.0",
        reason: "config_error",
        exitCode: 78,
      }),
    );
    expect(channel.store.isBlocklisted("1.1.0")).toBe(true);
    expect(
      channelNotifyMessages(channel).some(
        (message) =>
          message.includes("1.1.0") && message.includes("config_error"),
      ),
    ).toBe(true);
    // The restart is scheduled, not immediate.
    expect(channel.restartProcess).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(channel.restartProcess).toHaveBeenCalledTimes(1);
    // No configuration_error latch: rollback owns recovery in-window.
    expect(stack.watchdog.getStatus().lifecycle).toBe("crashed");
    expect(stack.watchdog.getStatus().lifecycle).not.toBe(
      "configuration_error",
    );
  });

  it("converts an in-window crash loop into a single rollback marker + blocklist entry", async () => {
    const channel = createChannelHarness({
      applied: { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
    });
    const stack = createStack({ autoRepair: false, channel });

    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(stack.watchdog.getStatus().lifecycle).toBe("crash_loop");
    const marker = channel.store.readMarker();
    expect(marker).toEqual(
      expect.objectContaining({
        target: { kind: "pin" }, // no LKG recorded yet
        blockedId: "1.1.0",
        reason: "crash_loop",
        exitCode: 1,
      }),
    );
    const blocklist = channel.store.readState().blocklist;
    expect(blocklist).toHaveLength(1);
    expect(blocklist[0]).toEqual(
      expect.objectContaining({ id: "1.1.0", reason: "crash_loop" }),
    );
    // Channel notify replaces the legacy crash-loop CTA.
    expect(crashLoopNotices(stack.notifier)).toHaveLength(0);
    expect(
      channelNotifyMessages(channel).some(
        (message) => /crash-looped/.test(message) && message.includes("1.1.0"),
      ),
    ).toBe(true);
  });

  it("keeps legacy crash-loop handling once the stabilization window has passed", async () => {
    const channel = createChannelHarness({
      applied: {
        channel: "beta",
        version: "1.1.0",
        at: 1_000_000,
        acceptedAt: 1_000_000,
      },
      stabilizationWindowMs: 5_000,
    });
    channel.nowRef.now += 60_000; // long past acceptedAt + window
    expect(channel.service.getChannelInfo().inStabilizationWindow).toBe(false);
    const stack = createStack({ autoRepair: false, channel });

    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(channel.store.readMarker()).toBeNull();
    expect(channel.store.readState().blocklist).toHaveLength(0);
    expect(channel.notify).not.toHaveBeenCalled();
    const notices = crashLoopNotices(stack.notifier);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Auto-restart paused; manual action required.");
    expect(stack.watchdog.getStatus().lifecycle).toBe("crash_loop");
  });

  it("mark-good-now over HTTP ends the window so later crash loops stay legacy", async () => {
    const channel = createChannelHarness({
      applied: { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
      stabilizationWindowMs: 10_000,
    });
    const stack = createStack({ autoRepair: false, channel });
    const app = mountChannelRoutes(channel);

    expect(channel.service.getChannelInfo().inStabilizationWindow).toBe(true);
    const res = await request(app).post("/api/openclaw/mark-good");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, acceptedAt: channel.nowRef.now });

    const state = channel.store.readState();
    expect(state.applied.acceptedAt).toBe(channel.nowRef.now);
    expect(state.lastKnownGood.package).toBe("1.1.0");

    // Step past the (tiny) window: crash loops go back to legacy handling.
    channel.nowRef.now += 10_001;
    expect(channel.service.getChannelInfo().inStabilizationWindow).toBe(false);

    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(channel.store.readMarker()).toBeNull();
    expect(channel.store.isBlocklisted("1.1.0")).toBe(false);
    expect(crashLoopNotices(stack.notifier)).toHaveLength(1);
  });

  it("rolls back when acceptance never completes, and accepts after the health hold", async () => {
    // Failure path: one healthy probe is NOT acceptance (default 120s hold).
    const channel = createChannelHarness({
      applied: { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
    });
    const stack = createStack({ autoRepair: false, channel });

    channel.service.onGatewayHealthy();
    expect(channel.store.readState().applied.acceptedAt).toBeNull();

    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    stack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(channel.store.readMarker()).toEqual(
      expect.objectContaining({ blockedId: "1.1.0", reason: "crash_loop" }),
    );
    expect(channel.store.isBlocklisted("1.1.0")).toBe(true);

    // Positive path: sustained health across the hold accepts the build.
    const accepting = createChannelHarness({
      applied: { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null },
      acceptanceHoldMs: 5_000,
    });
    createStack({ autoRepair: false, channel: accepting });

    accepting.service.onGatewayHealthy();
    expect(accepting.store.readState().applied.acceptedAt).toBeNull();
    accepting.nowRef.now += 5_000;
    accepting.service.onGatewayHealthy();
    await flushMicrotasks();

    const acceptedState = accepting.store.readState();
    expect(acceptedState.applied.acceptedAt).toBe(accepting.nowRef.now);
    expect(acceptedState.lastKnownGood.package).toBe("1.1.0");
    expect(
      channelNotifyMessages(accepting).some((message) =>
        /healthy/i.test(message),
      ),
    ).toBe(true);
  });

  it("[REG] preserves legacy latch and crash-loop behavior on the pin", async () => {
    // Exit 78 on the pin (state.applied null): the classic EX_CONFIG latch.
    const pinChannel = createChannelHarness({
      applied: null,
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    expect(pinChannel.service.getChannelInfo().isPin).toBe(true);
    const latchStack = createStack({ autoRepair: false, channel: pinChannel });
    latchStack.gateway.healthy = false;

    latchStack.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    latchStack.watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["fatal configuration error"],
    });
    await flushMicrotasks();

    expect(latchStack.watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
        crashCountInWindow: 0,
      }),
    );
    expect(latchStack.launchGatewayProcess).not.toHaveBeenCalled();
    expect(pinChannel.store.readMarker()).toBeNull();
    expect(
      notifierMessages(latchStack.notifier).some(
        (message) =>
          message.includes("Gateway configuration invalid") &&
          message.includes("automatic restart is paused"),
      ),
    ).toBe(true);

    // Crash loop on the pin with auto-repair off: legacy notification only.
    const loopChannel = createChannelHarness({
      applied: null,
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    const loopStack = createStack({ autoRepair: false, channel: loopChannel });

    loopStack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    loopStack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    loopStack.watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(loopStack.watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crash_loop",
        health: "unhealthy",
        crashCountInWindow: 3,
      }),
    );
    expect(loopChannel.store.readMarker()).toBeNull();
    expect(loopChannel.store.readState().blocklist).toHaveLength(0);
    expect(loopStack.clawCmd).not.toHaveBeenCalledWith("doctor --fix --yes", {
      quiet: true,
    });
    const notices = crashLoopNotices(loopStack.notifier);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Auto-restart paused; manual action required.");
  });
});
