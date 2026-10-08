// Lane I integration wiring for the gateway seams lane C exported
// (setGatewayPrelaunchHookHandler,
// getLastGatewayStopEvidence) and the restart route's `notify` dep.
//
// lib/server.js boots the whole process on require, so its composition is
// pinned at the SOURCE level here (the same idiom notification-policy.test.js
// uses for the audit-flag wiring), while the behaviour behind each seam runs
// for real: the REAL gateway module drives the REAL watchdog through the
// handler lib/server.js installs. e2e-server-lifecycle.test.js proves the
// composed module still boots.
process.env.GATEWAY_RESTART_READY_TIMEOUT = "120";

const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const kRepoRoot = path.join(__dirname, "..", "..");
const readSource = (...segments) =>
  fs.readFileSync(path.join(kRepoRoot, ...segments), "utf8");

const gatewayModulePath = require.resolve("../../lib/server/gateway");
const lockContention = require("../../lib/server/openclaw-lock-contention");
const {
  createWatchdog,
  createGatewayPrelaunchHookHandler,
} = require("../../lib/server/watchdog");

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalExistsSync = fs.existsSync;
const originalFstatSync = fs.fstatSync;
const originalCreateConnection = net.createConnection;
const originalPrelaunchHookEnv = process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;

// gateway.test.js idioms: a live child, a TCP probe socket, the pin's
// `gateway stop --help` (no --force).
const createChild = () => ({
  pid: 1234,
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
  signalCode: null,
  killed: false,
});
const createSocket = (running) => ({
  setTimeout: vi.fn(),
  destroy: vi.fn(),
  on(event, handler) {
    if (running && event === "connect") setImmediate(handler);
    if (!running && event === "error") setImmediate(handler);
    return this;
  },
});

const createWatchdogHarness = () => {
  const insertWatchdogEvent = vi.fn();
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true })),
    launchGatewayProcess: vi.fn(async () => null),
    insertWatchdogEvent,
    notifier: { notify: vi.fn(async () => ({ ok: true })) },
    readEnvFile: vi.fn(() => ""),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost",
    resolveGatewayHealthUrl: () => "http://gateway/health",
    resolveGatewayReadyzUrl: () => "",
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
  });
  return { watchdog, insertWatchdogEvent };
};

describe("init/register-server-routes.js hands the notifier and the configured URL to the Codex and system routes", () => {
  const routesSource = readSource("lib", "server", "init", "register-server-routes.js");
  it("diagnosis uses the collector's bounded redaction reads rather than pre-reading .env", () => {
    const start = routesSource.indexOf("registerDiagnoseRoutes({");
    expect(start).toBeGreaterThan(-1);
    const block = routesSource.slice(start, routesSource.indexOf("});", start));
    expect(block).toContain("rootDir: constants.kRootDir");
    expect(block).not.toContain("readEnvFile");
  });
  it("registerSystemRoutes gets resolveSetupUrl (notification links prefer the configured public URL)", () => {
    const start = routesSource.indexOf("registerSystemRoutes({");
    const block = routesSource.slice(start, routesSource.indexOf("getChannelStatus,", start));
    expect(block).toContain("resolveSetupUrl,");
  });
});

describe("lib/server.js composition pins (lane C / lane A hand-offs)", () => {
  const serverSource = readSource("lib", "server.js");

  it("imports the gateway seams and the handler factory", () => {
    const gatewayImport = serverSource.slice(
      serverSource.indexOf("const {\n  gatewayEnv,"),
      serverSource.indexOf('} = require("./server/gateway")'),
    );
    expect(gatewayImport).toContain("setGatewayPrelaunchHookHandler,");
    expect(gatewayImport).toContain("killManagedGatewayChildNow,");
    // The stop-force capability hand-off is gone with the CLI stop.
    expect(gatewayImport).not.toContain("setGatewayCapabilities");
    expect(serverSource).toMatch(
      /const \{\s*createWatchdog,\s*createGatewayPrelaunchHookHandler,\s*\} = require\("\.\/server\/watchdog"\)/,
    );
  });

  it("installs the prelaunch-hook handler next to the exit/launch handlers, composed from the watchdog and the outbox-backed upgradeNotifier", () => {
    const launchHandler = serverSource.indexOf(
      "setGatewayLaunchHandler((payload) => watchdog.onGatewayLaunch(payload));",
    );
    const hookHandler = serverSource.indexOf("setGatewayPrelaunchHookHandler(");
    expect(launchHandler).toBeGreaterThan(-1);
    expect(hookHandler).toBeGreaterThan(launchHandler);
    const block = serverSource.slice(hookHandler, hookHandler + 400);
    expect(block).toContain("createGatewayPrelaunchHookHandler({");
    expect(block).toContain("watchdog,");
    expect(block).toContain("notify: (message, opts) => upgradeNotifier.notify(message, opts),");
    // Both dependencies exist by then.
    expect(hookHandler).toBeGreaterThan(serverSource.indexOf("const watchdog = createWatchdog({"));
    expect(hookHandler).toBeGreaterThan(
      serverSource.indexOf("const upgradeNotifier = createUpgradeNotifier({"),
    );
  });

  it("no longer wires the retired backup-quiesce seam", () => {
    expect(serverSource).not.toContain("gatewayQuiesce");
    expect(serverSource).not.toContain("backup_quiesce");
    expect(serverSource).not.toContain("getLastGatewayStopEvidence");
  });

  it("createWatchdog receives the v0.9.75 relaunch/identity seams (requestGatewayLaunch, discoverServingIdentity, readProcStartTicks, classifyOwnershipConflict, getLaunchGeneration) and a cold-restart dep that forwards its options (the lease fence)", () => {
    const start = serverSource.indexOf("const watchdog = createWatchdog({");
    expect(start).toBeGreaterThan(-1);
    const block = serverSource.slice(start, serverSource.indexOf("\n});", start));
    for (const line of [
      "requestGatewayLaunch,",
      "discoverServingIdentity: resolveServingIdentity,",
      "readProcStartTicks: lockContention.readProcStartTicks,",
      "classifyOwnershipConflict: lockContention.classifyOwnershipConflict,",
      "pidAlive: lockContention.pidAlive,",
      "getLaunchGeneration,",
      // `(options) => restartGateway(options)`: the watchdog's { shouldAbort }
      // must reach runGatewayColdStart, so a bare `() => restartGateway()`
      // wrapper (the pre-0.9.75 shape) is a wiring regression.
      "restartGatewayColdStart: (options) => restartGateway(options),",
    ]) {
      expect(block).toContain(line);
    }
    expect(block).not.toContain("restartGatewayForMitigation");
    // The seams are pulled from the modules that own them.
    expect(serverSource).toMatch(
      /const \{[^}]*requestGatewayLaunch,[^}]*resolveServingIdentity,[^}]*getLaunchGeneration,[^}]*\} = require\("\.\/server\/gateway"\)/s,
    );
    expect(serverSource).toContain(
      'const lockContention = require("./server/openclaw-lock-contention");',
    );
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);
    for (const name of ["requestGatewayLaunch", "resolveServingIdentity", "getLaunchGeneration"]) {
      expect(typeof gateway[name]).toBe("function");
    }
    for (const name of ["readProcStartTicks", "classifyOwnershipConflict", "pidAlive"]) {
      expect(typeof lockContention[name]).toBe("function");
    }
  });

  it("createWatchdog receives the #76 A3 crash-cause seams (classifyGatewayCrash from gateway-crash-cause.js, readCrashFacts) and the restart-op record reads the watchdog's lastExit.cause", () => {
    const start = serverSource.indexOf("const watchdog = createWatchdog({");
    const block = serverSource.slice(start, serverSource.indexOf("\n});", start));
    expect(block).toContain("classifyGatewayCrash,");
    expect(block).toContain("readCrashFacts,");
    expect(serverSource).toContain(
      'const { classifyGatewayCrash } = require("./server/gateway-crash-cause");',
    );
    // The corroboration facts come from the runtime's tracked read-only DB
    // reader + the installed tree's schema, never from stderr.
    const factsStart = serverSource.indexOf("const readCrashFacts = async () => {");
    expect(factsStart).toBeGreaterThan(-1);
    const facts = serverSource.slice(factsStart, serverSource.indexOf("\n};", factsStart));
    expect(facts).toContain("openclawRuntime.describeStateDbSchema()");
    expect(facts).toContain("installedDiverged: openclawRuntime.getInfo().installedDiverged === true");
    expect(facts).toContain("resolveExecApprovalsConfigPath");
    const rrsStart = serverSource.indexOf("const restartRequiredState = createRestartRequiredState({");
    const rrs = serverSource.slice(rrsStart, serverSource.indexOf("\n});", rrsStart));
    expect(rrs).toContain("readLastExitCause:");
    // routes/system.js feeds the gateway-state tracker's annotations from the
    // same watchdog status snapshot the reducer reads (no extra I/O).
    const systemSource = readSource("lib", "server", "routes", "system.js");
    expect(systemSource).toContain("gatewayStateTracker.setCause?.(watchdogStatus?.lastExit?.cause ?? null);");
    expect(systemSource).toContain(
      "gatewayStateTracker.setVersionMismatch?.(watchdogStatus?.versionMismatch ?? null);",
    );
  });

  it("createWatchdog no longer receives the retired #76 C6 doctor-binary seams (runRepair runs the pinned doctor)", () => {
    const start = serverSource.indexOf("const watchdog = createWatchdog({");
    expect(start).toBeGreaterThan(-1);
    const block = serverSource.slice(start, serverSource.indexOf("\n});", start));
    expect(block).not.toContain("clawCmdWithBin");
    expect(block).not.toContain("compatibleBinForCurrentDb");
    expect(block).not.toContain("releaseChannelHooks");
    expect(serverSource).not.toContain("openclawChannelService");
  });

  it("register-server-routes passes the outbox-backed notify into registerSystemRoutes (the restart-failure notification's carrier)", () => {
    const source = readSource("lib", "server", "init", "register-server-routes.js");
    const start = source.indexOf("registerSystemRoutes({");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("});", start));
    expect(block).toContain(
      "notify: (message, opts) => upgradeNotifier?.notify?.(message, opts),",
    );
    // lib/server.js supplies upgradeNotifier to registerServerRoutes.
    const routesCall = serverSource.slice(
      serverSource.indexOf("} = registerServerRoutes({"),
      serverSource.indexOf("} = registerServerRoutes({") + 6000,
    );
    expect(routesCall).toMatch(/\n  upgradeNotifier,\n/);
    // ...and routes/system.js consumes it for the failed restart with the
    // id the operator-facing contract names.
    const systemSource = readSource("lib", "server", "routes", "system.js");
    expect(systemSource).toContain("notify = null,");
    expect(systemSource).toContain("id: `restart-failed-${operationId}`");
    expect(systemSource).toContain('eventType: "restart_failed"');
  });

  it("the stop failure is ONE class: GatewayStopError thrown by gateway.js's ladder with its user-facing code, classified by routes/system.js from `code`, read by the watchdog from `code` too (no incumbent flag, no instanceof fan-out)", () => {
    const systemSource = readSource("lib", "server", "routes", "system.js");
    expect(systemSource).toContain('const { GatewayRestartError } = require("../gateway");');
    expect(systemSource).not.toContain("GatewayIncumbentRestartError");
    expect(systemSource).not.toContain("incumbent_gateway_still_running");
    expect(systemSource).toContain("const classifyRestartFailure = (err) =>");
    const gatewaySource = readSource("lib", "server", "gateway.js");
    expect(gatewaySource).toContain("class GatewayStopError extends GatewayRestartError");
    expect(gatewaySource).toContain('throw new GatewayStopError(\n      "stop_refused"');
    expect(gatewaySource).toContain('throw new GatewayStopError(\n      "stop_failed"');
    expect(gatewaySource).not.toContain("GatewayIncumbentRestartError");
    const watchdogSource = readSource("lib", "server", "watchdog.js");
    expect(watchdogSource).not.toContain("err?.incumbent === true");
    expect(watchdogSource).toContain("err?.code || err?.evidence?.code");

    const gateway = require(gatewayModulePath);
    const error = new gateway.GatewayStopError("stop_failed", "the gateway did not exit after SIGKILL (pid 777 still alive)", { survivors: [777] });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error).toMatchObject({ name: "GatewayStopError", code: "stop_failed", evidence: { survivors: [777] } });
    const plain = new gateway.GatewayRestartError("never ready", { code: "ready_timeout" });
    expect(plain).not.toBeInstanceOf(gateway.GatewayStopError);
    expect(plain.code).toBeUndefined();
    expect(plain.evidence.code).toBe("ready_timeout");
  });
});

describe("gateway seam contracts + behaviour through the installed handler", () => {
  let hookDir = null;

  beforeEach(() => {
    vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockReturnValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    fs.existsSync = originalExistsSync;
    fs.fstatSync = originalFstatSync;
    net.createConnection = originalCreateConnection;
    if (originalPrelaunchHookEnv === undefined) {
      delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    } else {
      process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK = originalPrelaunchHookEnv;
    }
    if (hookDir) {
      try {
        fs.rmSync(hookDir, { recursive: true, force: true });
      } catch {}
      hookDir = null;
    }
    delete require.cache[gatewayModulePath];
    vi.restoreAllMocks();
  });

  it("the gateway module exports every seam lib/server.js wires", () => {
    delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);
    for (const name of [
      "setGatewayPrelaunchHookHandler",
      "getLastGatewayPrelaunchHookOutcome",
      "killManagedGatewayChildNow",
      "stopGatewayForShutdown",
      "stopGatewayLadder",
      "resolveGatewayIdentity",
    ]) {
      expect(typeof gateway[name]).toBe("function");
    }
    expect(gateway.setGatewayCapabilities).toBeUndefined();
  });

  it("a REAL refused managed launch flows gateway → installed handler → watchdog narration + operator notification (id prelaunch-hook-<code>-<site>)", async () => {
    hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-wiring-hook-"));
    const hookFile = path.join(hookDir, "pre-gateway-launch");
    fs.writeFileSync(hookFile, "#!/bin/sh\necho hook-ran\n", { mode: 0o755 });
    process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK = hookFile;
    // Pin the owner uid to non-root so the verdict is "refused" regardless of
    // who runs the suite (gateway.test.js idiom).
    fs.fstatSync = vi.fn((fd) => Object.assign(originalFstatSync(fd), { uid: 1000 }));
    childProcess.spawn = vi.fn(() => createChild());
    childProcess.execFile = vi.fn((file, args, opts, cb) => cb(null, "", ""));
    fs.existsSync = vi.fn(() => false);
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);

    const { watchdog, insertWatchdogEvent } = createWatchdogHarness();
    const notify = vi.fn(async () => ({ ok: true }));
    // Exactly what lib/server.js installs.
    gateway.setGatewayPrelaunchHookHandler(
      createGatewayPrelaunchHookHandler({
        watchdog,
        notify: (message, opts) => notify(message, opts),
      }),
    );
    try {
      expect(await gateway.launchGatewayProcess()).toBeNull();
      expect(childProcess.spawn).not.toHaveBeenCalled();

      const outcome = gateway.getLastGatewayPrelaunchHookOutcome();
      expect(outcome).toMatchObject({
        status: "refused",
        code: "not_root_owned",
        hookPath: hookFile,
        site: "managed launch",
      });
      // Watchdog narration + ledger row + degraded row.
      expect(watchdog.getStatus()).toMatchObject({
        degradedReason: "prelaunch_hook_failed",
        prelaunchHook: expect.objectContaining({
          status: "refused",
          code: "not_root_owned",
          site: "managed launch",
          hookPath: hookFile,
        }),
      });
      const rows = insertWatchdogEvent.mock.calls.map(([row]) => row);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "operation",
            source: "prelaunch_hook",
            status: "refused",
          }),
          expect.objectContaining({
            eventType: "health_check",
            source: "prelaunch_hook",
            status: "failed",
          }),
        ]),
      );
      // Operator notification, important class, deduped id.
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("🔴 Gateway launch aborted by the prelaunch hook"),
        {
          eventType: "prelaunch_hook",
          // code + site + hour bucket (the real clock here).
          id: expect.stringMatching(/^prelaunch-hook-not_root_owned-managed-launch-\d+$/),
        },
      );
    } finally {
      gateway.setGatewayPrelaunchHookHandler(null);
    }
  });

  it("a REAL crash relaunch flows watchdog → gateway.requestGatewayLaunch → spawn → `restart requested {generation}`, and the child's 'listening on' sniff through the installed launch handler is what lets a green + ready probe book `ok {verified: true}`", async () => {
    const child = createChild();
    childProcess.spawn = vi.fn(() => child);
    childProcess.execFile = vi.fn((file, args, opts, cb) => cb(null, "", ""));
    fs.existsSync = vi.fn(() => false);
    // Nothing answers the port before the spawn (reconcile point) — the
    // relaunch must spawn, not adopt.
    net.createConnection = vi.fn(() => createSocket(false));
    delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        String(url).includes("readyz")
          ? JSON.stringify({ ready: true, failing: [], eventLoop: { degraded: false } })
          : JSON.stringify({ ok: true, status: "live" }),
    }));
    const insertWatchdogEvent = vi.fn();
    // Exactly the seams lib/server.js wires (pinned above), on a real watchdog.
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true })),
      launchGatewayProcess: gateway.launchGatewayProcess,
      requestGatewayLaunch: gateway.requestGatewayLaunch,
      discoverServingIdentity: gateway.resolveServingIdentity,
      getLaunchGeneration: gateway.getLaunchGeneration,
      readProcStartTicks: lockContention.readProcStartTicks,
      classifyOwnershipConflict: lockContention.classifyOwnershipConflict,
      insertWatchdogEvent,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "http://gateway/readyz",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
    });
    gateway.setGatewayLaunchHandler((payload) => watchdog.onGatewayLaunch(payload));
    const rows = () => insertWatchdogEvent.mock.calls.map(([row]) => row);
    const restartRows = (status) =>
      rows().filter((row) => row.eventType === "restart" && row.status === status);
    try {
      process.env.WATCHDOG_AUTO_REPAIR = "false";
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 0 });
      await new Promise((resolve) => setImmediate(resolve));
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 0 });
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));

      expect(childProcess.spawn).toHaveBeenCalledWith(
        "openclaw",
        ["gateway", "run"],
        expect.objectContaining({ env: expect.any(Object) }),
      );
      expect(gateway.getLaunchGeneration()).toBe(1);
      expect(restartRows("requested")).toHaveLength(1);
      expect(restartRows("requested")[0]).toMatchObject({
        source: "exit_event",
        details: { pid: 1234, generation: 1, intent: "relaunch_if_absent" },
      });
      // The relaunch's operation-end probe was green, but the child has not
      // reported in and no /proc scan can vouch for pid 1234 here: liveness
      // only, no ok row.
      expect(restartRows("ok")).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({
        pid: 1234,
        source: "exit_event",
      });

      // The child's "listening on" line → gateway launch handler → watchdog
      // identity (generation 1 > watermark 0 = observed).
      const onStdout = child.stdout.on.mock.calls.find((call) => call[0] === "data")[1];
      onStdout(Buffer.from("Gateway listening on ws://127.0.0.1:18789\n"));
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(watchdog.getStatus()).toMatchObject({
        gatewayPid: 1234,
        servingRootPid: 1234,
        supervisionMode: "managed",
        replacementPending: null,
      });
      expect(restartRows("ok")).toHaveLength(1);
      expect(restartRows("ok")[0]).toMatchObject({
        source: "exit_event",
        details: expect.objectContaining({ pid: 1234, generation: 1, verified: true }),
      });
    } finally {
      delete process.env.WATCHDOG_AUTO_REPAIR;
      gateway.setGatewayLaunchHandler(null);
      watchdog.stop();
      if (originalFetch == null) delete global.fetch;
      else global.fetch = originalFetch;
    }
  });
});
