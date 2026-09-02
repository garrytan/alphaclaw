// Lane I integration wiring for the gateway seams lane C exported
// (setGatewayCapabilities, setGatewayPrelaunchHookHandler,
// getLastGatewayStopEvidence) and the restart route's `notify` dep.
//
// lib/server.js boots the whole process on require, so its composition is
// pinned at the SOURCE level here (the same idiom notification-policy.test.js
// uses for the audit-flag wiring), while the behaviour behind each seam runs
// for real: the REAL gateway module drives the REAL watchdog through the
// handler lib/server.js installs, and the REAL quiesce stop produces the
// evidence the offline copy records. e2e-server-lifecycle.test.js proves the
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
const { assessExclusivity } = require("../../lib/server/openclaw-backup-offline-copy");

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
const kStopHelpWithoutForce =
  "Usage: openclaw gateway stop [options]\n\nOptions:\n  -h, --help  display help for command\n";
const isStopHelpProbe = (args) =>
  Array.isArray(args) && args[0] === "gateway" && args.includes("--help");

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

describe("lib/server.js composition pins (lane C / lane A hand-offs)", () => {
  const serverSource = readSource("lib", "server.js");

  it("imports the three gateway seams and the handler factory", () => {
    const gatewayImport = serverSource.slice(
      serverSource.indexOf("const {\n  gatewayEnv,"),
      serverSource.indexOf('} = require("./server/gateway")'),
    );
    expect(gatewayImport).toContain("setGatewayPrelaunchHookHandler,");
    expect(gatewayImport).toContain("setGatewayCapabilities,");
    expect(gatewayImport).toContain("getLastGatewayStopEvidence,");
    expect(serverSource).toMatch(
      /const \{\s*createWatchdog,\s*createGatewayPrelaunchHookHandler,\s*\} = require\("\.\/server\/watchdog"\)/,
    );
  });

  it("hands the SHARED capabilities instance to the gateway module right after it is created (one gatewayStopForce probe cache)", () => {
    const created = serverSource.indexOf(
      "const openclawCapabilities = createOpenclawCapabilities({",
    );
    const handed = serverSource.indexOf("setGatewayCapabilities(openclawCapabilities);");
    expect(created).toBeGreaterThan(-1);
    expect(handed).toBeGreaterThan(created);
    // Before any consumer that could trigger a lazy private instance.
    expect(handed).toBeLessThan(serverSource.indexOf("const watchdog = createWatchdog({"));
    expect(serverSource.match(/setGatewayCapabilities\(/g)).toHaveLength(1);
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

  it("the backup quiesce seam's getStopEvidence reaches gateway.getLastGatewayStopEvidence", () => {
    const start = serverSource.indexOf("gatewayQuiesce: {");
    expect(start).toBeGreaterThan(-1);
    const block = serverSource.slice(start, serverSource.indexOf("},", start));
    expect(block).toContain("getStopEvidence: () => getLastGatewayStopEvidence?.() ?? null");
    expect(block).toContain("stopGatewayForBackup({");
  });

  it("register-server-routes passes the outbox-backed notify into registerSystemRoutes (the incumbent-restart notification's carrier)", () => {
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
    // ...and routes/system.js consumes it for the incumbent verdict with the
    // id the operator-facing contract names.
    const systemSource = readSource("lib", "server", "routes", "system.js");
    expect(systemSource).toContain("notify = null,");
    expect(systemSource).toContain("id: `restart-incumbent-${operationId}`");
    expect(systemSource).toContain('eventType: "restart_incumbent"');
  });

  it("the incumbent verdict is ONE class: thrown by gateway.js, caught by routes/system.js by instanceof, read by the watchdog mitigation via its incumbent flag (P1 review fix)", () => {
    // routes/system.js imports the class from gateway.js instead of defining
    // a private one, and no longer converts a returned { ok:false, incumbent }.
    const systemSource = readSource("lib", "server", "routes", "system.js");
    const importStart = systemSource.indexOf("const {\n  GatewayRestartError,");
    expect(importStart).toBeGreaterThan(-1);
    const importBlock = systemSource.slice(
      importStart,
      systemSource.indexOf('} = require("../gateway");', importStart),
    );
    expect(importBlock).toContain("GatewayIncumbentRestartError,");
    expect(importBlock).toContain("kGatewayIncumbentRestartReason,");
    expect(systemSource).not.toMatch(/class GatewayIncumbentRestartError/);
    expect(systemSource).not.toContain("result?.incumbent");
    expect(systemSource).toContain("err instanceof GatewayIncumbentRestartError");
    // gateway.js THROWS it from the cold restart and no longer returns it.
    const gatewaySource = readSource("lib", "server", "gateway.js");
    expect(gatewaySource).toContain("throw new GatewayIncumbentRestartError(");
    expect(gatewaySource).not.toMatch(/return \{\s*ok: false,\s*incumbent: true/);
    // The watchdog mitigation reads the flag the class carries.
    const watchdogSource = readSource("lib", "server", "watchdog.js");
    expect(watchdogSource).toContain("const incumbent = err?.incumbent === true;");

    // The exported class's contract.
    const gateway = require(gatewayModulePath);
    expect(typeof gateway.GatewayIncumbentRestartError).toBe("function");
    expect(gateway.kGatewayIncumbentRestartReason).toBe("incumbent_gateway_still_running");
    const error = new gateway.GatewayIncumbentRestartError(
      "the previous gateway is still running: the gateway port never released after stop",
      { cliRefused: true, survivingPids: [777] },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(gateway.GatewayRestartError);
    expect(error).toBeInstanceOf(gateway.GatewayIncumbentRestartError);
    expect(error).toMatchObject({
      name: "GatewayIncumbentRestartError",
      code: "restart_incumbent",
      reason: "incumbent_gateway_still_running",
      incumbent: true,
      detail: "the previous gateway is still running: the gateway port never released after stop",
      evidence: { cliRefused: true, survivingPids: [777] },
    });
    expect(error.message).toBe(
      "Gateway restart did not take effect — the previous gateway is still running: the gateway port never released after stop",
    );
    // A plain GatewayRestartError is NOT an incumbent verdict.
    const plain = new gateway.GatewayRestartError("never ready", {});
    expect(plain).not.toBeInstanceOf(gateway.GatewayIncumbentRestartError);
    expect(plain.incumbent).toBeUndefined();
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

  it("the gateway module exports every seam lib/server.js wires, and the evidence seam starts null", () => {
    delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);
    for (const name of [
      "setGatewayCapabilities",
      "setGatewayPrelaunchHookHandler",
      "getLastGatewayPrelaunchHookOutcome",
      "getLastGatewayStopEvidence",
      "stopGatewayForBackup",
    ]) {
      expect(typeof gateway[name]).toBe("function");
    }
    // Mirrors lib/server.js: gatewayQuiesce.getStopEvidence.
    const seam = () => gateway.getLastGatewayStopEvidence?.() ?? null;
    expect(seam()).toBeNull();
    // A capabilities object without get() is rejected (falls back to lazy).
    expect(() => gateway.setGatewayCapabilities({ get: () => null })).not.toThrow();
    expect(() => gateway.setGatewayCapabilities(null)).not.toThrow();
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
        { eventType: "prelaunch_hook", id: "prelaunch-hook-not_root_owned-managed-launch" },
      );
    } finally {
      gateway.setGatewayPrelaunchHookHandler(null);
    }
  });

  it("the quiesce stop's evidence reaches the seam in lane C's shape and rides into the offline copy's exclusivity evidence", async () => {
    delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    const child = createChild();
    child.kill = vi.fn((sig) => {
      child.killed = true;
      child.signalCode = sig;
      return true;
    });
    childProcess.spawn = vi.fn(() => child);
    childProcess.execFile = vi.fn((file, args, opts, cb) => {
      if (isStopHelpProbe(args)) return cb(null, kStopHelpWithoutForce, "");
      if (args?.[0] === "gateway" && args?.[1] === "stop") {
        return cb(Object.assign(new Error("stop timed out"), { code: 1 }), "", "");
      }
      return cb(null, "", "");
    });
    fs.existsSync = vi.fn(() => false);
    net.createConnection = vi.fn(() => createSocket(false));
    delete require.cache[gatewayModulePath];
    const gateway = require(gatewayModulePath);
    gateway.setGatewayExitHandler(vi.fn());

    // The seam exactly as lib/server.js binds it into gatewayQuiesce.
    const gatewayQuiesce = {
      stop: () => gateway.stopGatewayForBackup({ timeoutMs: 50 }),
      getStopEvidence: () => gateway.getLastGatewayStopEvidence?.() ?? null,
    };

    await gateway.launchGatewayProcess();
    expect(gatewayQuiesce.getStopEvidence()).toBeNull();
    const stopped = Boolean(await gatewayQuiesce.stop());
    expect(stopped).toBe(true);

    const evidence = gatewayQuiesce.getStopEvidence();
    expect(evidence).toEqual({
      at: expect.any(String),
      method: "managed_child",
      childExited: true,
      portReleased: true,
      cliRefused: false,
      cliExitCode: 1,
    });
    expect(Date.parse(evidence.at)).not.toBeNaN();

    // channel-sync hands `stopEvidence` + `stopConfirmed` to the offline copy
    // untouched; the manifest records it verbatim.
    const report = assessExclusivity({
      stopConfirmed: stopped,
      stopEvidence: evidence,
      quietToken: { id: "quiet-1", owner: "quiesced-backup", disabled: false },
      isQuiet: () => true,
      liveProcesses: [],
      handleCount: 0,
      dbPaths: [],
      platform: "linux",
      listFdHolders: () => [],
    });
    expect(report.ok).toBe(true);
    expect(report.evidence.stopEvidence).toEqual(evidence);
    gateway.setGatewayExitHandler(null);
  });
});
