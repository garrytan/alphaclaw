const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runOnboardedBootSequence } = require("../../lib/server/startup");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { createDoctorGuard } = require("../../lib/server/doctor-guard");
const { processGroupHasWriters } = require("../../lib/server/process-group");
const { setBootPhase } = require("../../lib/server/boot-phase");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const bootDeps = (overrides) => ({
  reportLockContentionAtBoot: vi.fn(),
  assessLaunchCompatibilityAtBoot: vi.fn(async () => ({ compatible: true })),
  ensureManagedExecDefaults: vi.fn(),
  ensureUsageTrackerPluginConfig: vi.fn(),
  ensureWebhookMappingIds: vi.fn(),
  doSyncPromptFiles: vi.fn(),
  reloadEnv: vi.fn(),
  syncChannelConfig: vi.fn(),
  readEnvFile: vi.fn(() => []),
  ensureGatewayProxyConfig: vi.fn(),
  resolveSetupUrl: vi.fn(),
  startGateway: vi.fn(),
  watchdog: { start: vi.fn() },
  gmailWatchService: { start: vi.fn() },
  ...overrides,
});

describe("boot reconciliation cleanup ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setBootPhase("ready");
  });

  it.each([
    ["shutdown", false],
    ["lease expiry", true],
  ])("keeps the lease until a real child and restore guard drain on %s (native maintenance configured: %s)", async (cause, nativeConfigured) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-reconcile-cleanup-"));
    const lastGood = path.join(root, "openclaw.json.last-good");
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}");
    fs.writeFileSync(lastGood, '{"original":true}');
    const logger = { log: vi.fn(), warn: vi.fn() };
    const guard = createDoctorGuard({ openclawDir: root, logger });
    const runner = createRunStream();
    const lock = createGatewayLifecycleLock({ logger });
    const shutdown = new AbortController();
    const childStarted = deferred();
    const childDrained = deferred();
    const permitRestore = deferred();
    let pid;
    let observedOperation;
    let observedHold;
    let successorHold;
    let successorSawRestored = false;
    const deps = bootDeps({
      signal: shutdown.signal,
      acquireLifecycleLock: (kind, options) => lock.acquire(kind, { ...options, leaseMs: cause === "lease expiry" ? 1500 : 10_000 }),
      runBootNativeMaintenance: nativeConfigured ? vi.fn(async () => {}) : null,
      reconcileBootConfig: async ({ hold, operation }) => {
        observedOperation = operation;
        observedHold = hold;
        await guard.withDoctorRestoreGuard({
          operationId: "boot-cleanup-test",
          run: async () => {
            const result = await runner.runStreamed({
              command: process.execPath,
              args: ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
              signal: operation.signal,
              deadlineAt: operation.deadlineAt,
              timeoutMs: 10_000,
              killGraceMs: 20,
              onProcess: (event) => { if (event.pid) pid = event.pid; operation.noteProcess(event); },
              onOutput: () => childStarted.resolve(),
            });
            childDrained.resolve();
            await permitRestore.promise;
            return result;
          },
        });
        return { status: "ok" };
      },
    });
    const boot = runOnboardedBootSequence(deps);
    let successor;
    try {
      await childStarted.promise;
      expect(observedOperation.signal.aborted).toBe(false);
      expect(observedOperation.deadlineAt).toBe(observedHold.expiresAt);
      expect(processGroupHasWriters(pid)).toBe(true);
      expect(fs.existsSync(lastGood)).toBe(false);
      successor = lock.acquire("successor").then((release) => {
        successorHold = release;
        successorSawRestored = fs.existsSync(lastGood);
      });
      let cancellation;
      if (cause === "shutdown") {
        shutdown.abort("shutdown");
        cancellation = lock.cancelActiveCleanup("shutdown");
      }
      await childDrained.promise;
      expect(processGroupHasWriters(pid)).toBe(false);
      expect(observedOperation.signal.aborted).toBe(true);
      expect(observedHold.isValid()).toBe(false);
      expect(lock.getActiveOperation()).toMatchObject({ kind: "boot", phase: "cleanup" });
      expect(successorHold).toBeUndefined();
      expect(lock.tryAcquire("must-not-pass-restore")).toBe(null);
      expect(fs.existsSync(lastGood)).toBe(false);
      permitRestore.resolve();
      await boot;
      await cancellation;
      await successor;
      expect(successorSawRestored).toBe(true);
      expect(fs.readFileSync(lastGood, "utf8")).toBe('{"original":true}');
      expect(fs.readdirSync(root).some((name) => name.includes("quarantined"))).toBe(false);
      if (nativeConfigured) expect(deps.runBootNativeMaintenance).not.toHaveBeenCalled();
      for (const step of ["ensureManagedExecDefaults", "ensureUsageTrackerPluginConfig", "ensureWebhookMappingIds", "doSyncPromptFiles", "reloadEnv", "syncChannelConfig", "ensureGatewayProxyConfig", "startGateway"]) {
        expect(deps[step]).not.toHaveBeenCalled();
      }
    } finally {
      shutdown.abort("shutdown");
      permitRestore.resolve();
      if (pid && processGroupHasWriters(pid)) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      await boot;
      await successor;
      await successorHold?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shares the operation and finite boot deadline across reconciliation and native maintenance", async () => {
    const lock = createGatewayLifecycleLock();
    let reconciliationOperation;
    const deps = bootDeps({
      acquireLifecycleLock: lock.acquire,
      reconcileBootConfig: async ({ operation, hold }) => {
        reconciliationOperation = operation;
        expect(operation.deadlineAt).toBe(hold.expiresAt);
        return { status: "ok" };
      },
      runBootNativeMaintenance: vi.fn(async ({ signal }) => {
        expect(signal).toBe(reconciliationOperation.signal);
        expect(Number.isFinite(reconciliationOperation.deadlineAt)).toBe(true);
      }),
    });
    await runOnboardedBootSequence(deps);
    expect(deps.startGateway).toHaveBeenCalledTimes(1);
    expect(lock.getActiveOperation()).toBe(null);
  });
});
