const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const net = require("net");
const { setTimeout: realSetTimeout } = require("timers");

// Keep gateway.js's constants-derived reads inside this test's scratch root.
const originalRoot = process.env.ALPHACLAW_ROOT_DIR;
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-crash-cleanup-"));
process.env.ALPHACLAW_ROOT_DIR = rootDir;
const { createOpenclawUpdateRepair } = require("../../lib/server/openclaw-update-repair");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { processGroupHasWriters } = require("../../lib/server/process-group");
const originalSpawn = childProcess.spawn;
const sleepReal = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const waitForProcess = async (predicate) => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("process fixture did not reach its expected state");
    await sleepReal(5);
  }
};
const logger = { log() {}, warn() {}, error() {} };

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
  else process.env.ALPHACLAW_ROOT_DIR = originalRoot;
});

it("retains a crashed gateway through an expired Upgrade repair lease, then actually launches once after writer cleanup", async () => {
  // Fake only the ownership/backoff clock. Child processes and their writes
  // are real, and the test waits for OS-confirmed termination before advancing.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubEnv("WATCHDOG_AUTO_REPAIR", "false");
  vi.stubEnv("WATCHDOG_NOTIFICATIONS_DISABLED", "true");
  vi.stubEnv("ALPHACLAW_GATEWAY_PRELAUNCH_HOOK", "");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("gateway down"); }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  const ready = path.join(rootDir, "writer-ready");
  const writes = path.join(rootDir, "writer-output");
  const grandchild = [
    'const fs=require("fs"); process.on("SIGTERM",()=>{});',
    `fs.writeFileSync(${JSON.stringify(ready)},"ready");`,
    `setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},"x"),5);`,
  ].join("\n");
  const leader = [
    'const {spawn}=require("child_process");',
    `spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});`,
    'setInterval(()=>{},1000);',
  ].join("\n");
  const lock = createGatewayLifecycleLock({ logger });
  const ledger = createRunLedger({ openclawDir, logger });
  let applying = false;
  const getChannelInfo = () => ({ releaseChannel: "dev", gatewayHold: null });
  const mutationPolicy = createGatewayMutationPolicy({ lock, getChannelInfo,
    isApplyInProgress: () => applying });
  let writerPid;
  let writerSignal;
  let writerDone = false;
  let gatewayChild;
  let watchdog;
  let repair;
  let repairSettled = false;
  let gateway;
  const gatewaySpawn = vi.spyOn(childProcess, "spawn").mockImplementation((command, args, options) => {
    if (command !== "openclaw" || args.join(" ") !== "gateway run") {
      throw new Error(`unexpected gateway command: ${command} ${args.join(" ")}`);
    }
    // The real gateway primitive still owns spawn, generation and the verdict.
    // Substitute its executable with a small real child, not a made-up verdict.
    gatewayChild = originalSpawn(process.execPath, ["-e", 'setInterval(()=>{},1000);'], options);
    return gatewayChild;
  });
  vi.spyOn(net, "createConnection").mockImplementation(() => ({
    setTimeout() {}, destroy() {},
    on(event, handler) { if (event === "error") handler(); return this; },
  }));
  const gatewayModulePath = require.resolve("../../lib/server/gateway");
  delete require.cache[gatewayModulePath];
  gateway = require(gatewayModulePath);
  const { createWatchdog } = require("../../lib/server/watchdog");
  const requestLaunch = vi.fn((options) => gateway.requestGatewayLaunch(options));
  const events = vi.fn();
  watchdog = createWatchdog({
    gatewayLifecycleLock: lock, requestGatewayLaunch: requestLaunch,
    getLaunchGeneration: gateway.getLaunchGeneration,
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    insertWatchdogEvent: events, notifier: { notify: vi.fn(async () => ({ ok: true })) },
    readEnvFile: () => [], writeEnvFile: () => {}, reloadEnv: () => {},
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => "", supervisorModeActive: () => false,
  });
  watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, generation: 0 });
  const base = createRunStream({ spawnImpl: originalSpawn });
  const runUpdateRepair = createOpenclawUpdateRepair({
    getChannelInfo, isOnboarded: () => true, isSelfUpdateInProgress: () => false,
    isApplyInProgress: () => applying, setApplyInProgress: (value) => { applying = value; },
    getActiveGatewayOperation: lock.getActiveOperation,
    acquireLifecycleLock: async (kind, options) => {
      // Force expiry before the work budget. The crash lands after admission
      // but before the managed-operation marker, retaining the ordinary retry.
      const hold = await lock.acquire(kind, { ...options, leaseMs: 200 });
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 0 });
      return hold;
    },
    mutationPolicy, ledger, devUpdateEnv: () => process.env,
    runner: { runStreamed: async (options) => {
      expect(options.args).toEqual(["update", "repair"]);
      writerSignal = options.signal;
      const result = await base.runStreamed({ ...options, command: process.execPath, args: ["-e", leader],
        onProcess: (info) => { writerPid ||= info.pid; options.onProcess(info); } });
      writerDone = true;
      return result;
    } },
    stepRecorder: (id) => ({ steps: [], emit: (name, status) => ledger.appendStep(id, { name, status }) }),
    makeOutputPublisher: () => Object.assign(() => {}, { flush() {} }),
    setActiveSink() {}, operationEvents: { fail() {}, complete() {} },
    watchdogManagedOperation: { begin: watchdog.beginManagedOperation, end: watchdog.endManagedOperation },
    channelError: (code, message, hint) => ({ ok: false, code, message, hint }),
    rootDir, log() {}, budgetMs: 60_000,
  });
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    repair = runUpdateRepair({ operationId }).then((result) => { repairSettled = true; return result; });
    await waitForProcess(() => fs.existsSync(ready));
    expect(ledger.readRun(operationId)).toMatchObject({ operationId, target: { repair: true } });
    expect(watchdog.getStatus().recoveryPending).toMatchObject({ reason: "lifecycle_operation_in_progress" });

    await vi.advanceTimersByTimeAsync(200);
    expect(writerSignal.aborted).toBe(true);
    expect(writerSignal.reason).toBe("lease_expired");
    expect(lock.getActiveOperation()).toMatchObject({ kind: "update_repair", phase: "cleanup" });
    const before = fs.existsSync(writes) ? fs.statSync(writes).size : 0;
    await sleepReal(60);
    expect(fs.statSync(writes).size).toBeGreaterThan(before);

    // The first actual crash retry falls BETWEEN TERM and KILL. It must
    // retain responsibility without even entering the gateway launch seam.
    await vi.advanceTimersByTimeAsync(800);
    expect(writerDone).toBe(false);
    expect(repairSettled).toBe(false);
    expect(applying).toBe(true);
    expect(requestLaunch).not.toHaveBeenCalled();
    expect(gatewaySpawn).not.toHaveBeenCalled();
    expect(lock.tryAcquire("manual_restart")).toBeNull();
    expect(watchdog.getStatus().recoveryPending).toMatchObject({ reason: "lifecycle_operation_in_progress", retryCount: 2 });

    await vi.advanceTimersByTimeAsync(200);
    await waitForProcess(() => !processGroupHasWriters(writerPid));
    await vi.advanceTimersByTimeAsync(100);
    expect(await repair).toMatchObject({ status: 500, body: { code: "operation_cancelled" } });
    expect(ledger.readRun(operationId)).toMatchObject({ state: "failed", result: { code: "operation_cancelled" } });
    expect(applying).toBe(false);
    expect(lock.getActiveOperation()).toBeNull();
    const finalSize = fs.statSync(writes).size;
    await sleepReal(30);
    expect(fs.statSync(writes).size).toBe(finalSize);

    await vi.advanceTimersByTimeAsync(1700);
    expect(requestLaunch).toHaveBeenCalledTimes(1);
    expect(await requestLaunch.mock.results[0].value).toMatchObject({
      outcome: gateway.kGatewayLaunchOutcomes.LAUNCH_REQUESTED, pid: gatewayChild.pid,
    });
    expect(gatewaySpawn).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().recoveryPending).toBeNull();
    expect(events.mock.calls.filter(([event]) => event.eventType === "restart" && event.status === "requested"))
      .toEqual([[expect.objectContaining({ details: expect.objectContaining({ pid: gatewayChild.pid }) })]]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(requestLaunch).toHaveBeenCalledTimes(1);
  } finally {
    await watchdog?.stop();
    gateway?.setGatewayExitHandler(null);
    gateway?.setGatewayLaunchHandler(null);
    if (writerPid) { try { process.kill(-writerPid, "SIGKILL"); } catch {} }
    if (gatewayChild) {
      gatewayChild.kill("SIGKILL");
      await waitForProcess(() => gatewayChild.exitCode !== null || gatewayChild.signalCode !== null);
    }
    if (writerPid) {
      await waitForProcess(() => !processGroupHasWriters(writerPid));
      await vi.advanceTimersByTimeAsync(100);
    }
    await repair;
    await lock.cancelActiveCleanup("shutdown");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete require.cache[gatewayModulePath];
  }
}, 15_000);
