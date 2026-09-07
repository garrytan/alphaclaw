const {
  createBootLaunchSteps,
  kLaunchCompatGateEventSource,
  kBootRelaunchVerdict,
} = require("../../lib/server/boot-launch-steps");

// Boot steps (3)/(4) glue (#76 C1 belt / C2): the channel service owns the
// policy; this module passes the boot lease through, emits the gate's
// version_mismatch event through the WRAPPED sink, and books the boot's
// relaunch step on a reconcile run (Codex 7). Hermetic: every collaborator
// is a fake.
const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkService = (overrides = {}) => ({
  getChannelInfo: vi.fn(() => ({
    installedDiverged: true,
    installedVersion: "1.0.0",
    expectedVersion: "2.0.0",
  })),
  reconcileInstalled: vi.fn(async () => ({
    ok: true,
    action: "activated",
    from: "1.0.0",
    to: "2.0.0",
    runId: "run-1",
  })),
  assessLaunchCompatibilityAtBoot: vi.fn(async () => ({
    compatible: true,
    hold: null,
    reasons: [],
    installed: "2.0.0",
    expected: "2.0.0",
  })),
  completeReconcileRun: vi.fn(() => ({ state: "activated" })),
  ...overrides,
});

describe("server/boot-launch-steps", () => {
  describe("reconcileInstalledAtBoot", () => {
    it("does nothing when the tree is the recorded build (installedDiverged false)", async () => {
      const service = mkService({
        getChannelInfo: vi.fn(() => ({ installedDiverged: false, installedVersion: "1.0.0", expectedVersion: "1.0.0" })),
      });
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      const hold = Object.assign(() => {}, { isValid: () => true });
      await expect(steps.reconcileInstalledAtBoot({ hold })).resolves.toEqual({
        ok: true,
        action: "none",
        reason: "not_diverged",
      });
      expect(service.reconcileInstalled).not.toHaveBeenCalled();
    });

    it("a diverged tree is reconciled UNDER THE BOOT LEASE ({ hold, source: 'boot', relaunch: false }) and the activated run is booked for the boot's relaunch step", async () => {
      const service = mkService();
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      const hold = Object.assign(() => {}, { isValid: () => true });

      const result = await steps.reconcileInstalledAtBoot({ hold });

      // The lock is not re-entrant: the boot's own lease is what the reconcile
      // runs under — never an acquire of its own.
      expect(service.reconcileInstalled).toHaveBeenCalledTimes(1);
      expect(service.reconcileInstalled).toHaveBeenCalledWith({
        hold,
        source: "boot",
        relaunch: false,
      });
      expect(result).toEqual(expect.objectContaining({ ok: true, action: "activated", runId: "run-1" }));
      expect(steps.pendingReconcileRuns()).toEqual(["run-1"]);
    });

    it("never throws: a throwing reconcile is logged and returned as { ok: false, code: 'reconcile_threw' }", async () => {
      const warn = vi.fn();
      const service = mkService({
        reconcileInstalled: vi.fn(async () => {
          throw new Error("store exploded");
        }),
      });
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        logger: { ...kSilentLogger, warn },
      });
      await expect(steps.reconcileInstalledAtBoot({ hold: null })).resolves.toEqual({
        ok: false,
        action: "none",
        code: "reconcile_threw",
        error: "store exploded",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("store exploded"));
      expect(steps.pendingReconcileRuns()).toEqual([]);
    });

    it("a refused reconcile is logged (warn) and returned; nothing is booked", async () => {
      const warn = vi.fn();
      const service = mkService({
        reconcileInstalled: vi.fn(async () => ({
          ok: false,
          code: "incumbent_running",
          message: "A gateway process is still running",
          action: "none",
        })),
      });
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        logger: { ...kSilentLogger, warn },
      });
      const result = await steps.reconcileInstalledAtBoot({ hold: null });
      expect(result.code).toBe("incumbent_running");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("incumbent_running"));
      expect(steps.pendingReconcileRuns()).toEqual([]);
    });
  });

  describe("assessLaunchCompatibilityAtBoot", () => {
    it("passes the boot lease through and returns the service's verdict unchanged; a compatible tree emits nothing", async () => {
      const service = mkService();
      const insertWatchdogEvent = vi.fn();
      const latchVersionMismatch = vi.fn();
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        insertWatchdogEvent,
        getWatchdog: () => ({ latchVersionMismatch }),
        logger: kSilentLogger,
      });
      const hold = Object.assign(() => {}, { isValid: () => true });
      const result = await steps.assessLaunchCompatibilityAtBoot({ hold });
      expect(service.assessLaunchCompatibilityAtBoot).toHaveBeenCalledWith({ hold });
      expect(result).toEqual(expect.objectContaining({ compatible: true, hold: null }));
      expect(latchVersionMismatch).not.toHaveBeenCalled();
      expect(insertWatchdogEvent).not.toHaveBeenCalled();
    });

    it("a refusal latches the watchdog's version mismatch (ONE writer: status line + incident + event) with source launch_compat_gate and the hold's reason", async () => {
      const service = mkService({
        assessLaunchCompatibilityAtBoot: vi.fn(async () => ({
          compatible: false,
          hold: { reason: "version_mismatch", bootId: "boot-1", installed: "1.0.0", expected: "1.0.0" },
          reasons: ["state_schema_too_new"],
          installed: "1.0.0",
          expected: "1.0.0",
          supported: { state: 1, agent: null },
        })),
      });
      const insertWatchdogEvent = vi.fn();
      const latchVersionMismatch = vi.fn();
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        insertWatchdogEvent,
        getWatchdog: () => ({ latchVersionMismatch }),
        logger: kSilentLogger,
      });
      const result = await steps.assessLaunchCompatibilityAtBoot({ hold: null });
      expect(result.compatible).toBe(false);
      expect(latchVersionMismatch).toHaveBeenCalledWith({
        expected: "1.0.0",
        running: "1.0.0",
        source: kLaunchCompatGateEventSource,
        details: {
          reason: "version_mismatch",
          reasons: ["state_schema_too_new"],
          bootId: "boot-1",
          supported: { state: 1, agent: null },
        },
      });
      // The watchdog's latch writes the event itself — no second row here.
      expect(insertWatchdogEvent).not.toHaveBeenCalled();
    });

    it("without a watchdog latch the version_mismatch event goes straight through the wrapped sink", async () => {
      const service = mkService({
        assessLaunchCompatibilityAtBoot: vi.fn(async () => ({
          compatible: false,
          hold: { reason: "state_db_unreadable", bootId: "boot-1" },
          reasons: ["state_db_unreadable"],
          installed: "1.0.0",
          expected: "2.0.0",
        })),
      });
      const insertWatchdogEvent = vi.fn();
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        insertWatchdogEvent,
        getWatchdog: () => null,
        logger: kSilentLogger,
      });
      await steps.assessLaunchCompatibilityAtBoot({ hold: null });
      expect(insertWatchdogEvent).toHaveBeenCalledTimes(1);
      expect(insertWatchdogEvent).toHaveBeenCalledWith({
        eventType: "version_mismatch",
        source: kLaunchCompatGateEventSource,
        status: "failed",
        details: expect.objectContaining({
          expected: "2.0.0",
          running: "1.0.0",
          reason: "state_db_unreadable",
          reasons: ["state_db_unreadable"],
        }),
        correlationId: "",
      });
    });

    it("a reconcile the gate ran itself (null && diverged && overlay) is booked like step 3's", async () => {
      const service = mkService({
        assessLaunchCompatibilityAtBoot: vi.fn(async () => ({
          compatible: true,
          hold: null,
          reasons: [],
          reconcile: { ok: true, action: "activated", runId: "run-gate" },
        })),
      });
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      await steps.assessLaunchCompatibilityAtBoot({ hold: null });
      expect(steps.pendingReconcileRuns()).toEqual(["run-gate"]);
    });

    it("a THROW propagates — startup.js's runBootStep logs it and fails OPEN (F008); the glue must not turn it into a verdict", async () => {
      const service = mkService({
        assessLaunchCompatibilityAtBoot: vi.fn(async () => {
          throw new Error("gate exploded");
        }),
      });
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      await expect(steps.assessLaunchCompatibilityAtBoot({ hold: null })).rejects.toThrow("gate exploded");
    });

    it("a service without the gate method is a null verdict (legacy wiring)", async () => {
      const steps = createBootLaunchSteps({
        openclawChannelService: { getChannelInfo: () => ({}) },
        logger: kSilentLogger,
      });
      await expect(steps.assessLaunchCompatibilityAtBoot({ hold: null })).resolves.toBeNull();
    });
  });

  describe("reconcile run ownership (Codex 7: the boot books the relaunch step)", () => {
    it("startGateway resolving completes every booked run `activated` with verdict 'launched'", async () => {
      const service = mkService();
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      await steps.reconcileInstalledAtBoot({ hold: null });
      const startGateway = vi.fn(async () => {});
      await steps.wrapStartGateway(startGateway)();
      expect(startGateway).toHaveBeenCalledTimes(1);
      expect(service.completeReconcileRun).toHaveBeenCalledWith({
        runId: "run-1",
        relaunch: { ok: true, verdict: kBootRelaunchVerdict },
      });
      expect(steps.pendingReconcileRuns()).toEqual([]);
      // Idempotent: a second launch completes nothing twice.
      await steps.wrapStartGateway(startGateway)();
      expect(service.completeReconcileRun).toHaveBeenCalledTimes(1);
    });

    it("a startGateway throw completes the run `failed` with the error and rethrows (startup.js books boot_failed)", async () => {
      const service = mkService();
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      await steps.reconcileInstalledAtBoot({ hold: null });
      const wrapped = steps.wrapStartGateway(async () => {
        throw new Error("gateway refused to launch");
      });
      await expect(wrapped()).rejects.toThrow("gateway refused to launch");
      expect(service.completeReconcileRun).toHaveBeenCalledWith({
        runId: "run-1",
        relaunch: { ok: false, error: "gateway refused to launch" },
      });
    });

    it("a held boot (finalize with gatewayHeld) completes the run `failed` naming the hold — startGateway is never reached", () => {
      const service = mkService();
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      return steps.reconcileInstalledAtBoot({ hold: null }).then(() => {
        expect(
          steps.onBootReportFinalize({
            gatewayHeld: true,
            compat: { compatible: false, hold: { reason: "version_mismatch" } },
            reconcile: null,
          }),
        ).toEqual(["run-1"]);
        expect(service.completeReconcileRun).toHaveBeenCalledWith({
          runId: "run-1",
          relaunch: { ok: false, error: "gateway held (version_mismatch) — no relaunch this boot" },
        });
        // A config-migration hold names its own reason.
        service.completeReconcileRun.mockClear();
        return steps.reconcileInstalledAtBoot({ hold: null }).then(() => {
          steps.onBootReportFinalize({
            gatewayHeld: true,
            compat: { compatible: true, hold: null },
            reconcile: { status: "held", hold: { reason: "settings migration failed" } },
          });
          expect(service.completeReconcileRun).toHaveBeenCalledWith({
            runId: "run-1",
            relaunch: { ok: false, error: "gateway held (settings migration failed) — no relaunch this boot" },
          });
        });
      });
    });

    it("a boot that is not held settles nothing at finalize (the launch does)", async () => {
      const service = mkService();
      const steps = createBootLaunchSteps({ openclawChannelService: service, logger: kSilentLogger });
      await steps.reconcileInstalledAtBoot({ hold: null });
      expect(steps.onBootReportFinalize({ gatewayHeld: false, compat: { compatible: true } })).toEqual([]);
      expect(service.completeReconcileRun).not.toHaveBeenCalled();
      expect(steps.pendingReconcileRuns()).toEqual(["run-1"]);
    });

    it("a completeReconcileRun throw is logged, never thrown into the boot", async () => {
      const warn = vi.fn();
      const service = mkService({
        completeReconcileRun: vi.fn(() => {
          throw new Error("ledger unwritable");
        }),
      });
      const steps = createBootLaunchSteps({
        openclawChannelService: service,
        logger: { ...kSilentLogger, warn },
      });
      await steps.reconcileInstalledAtBoot({ hold: null });
      await expect(steps.wrapStartGateway(async () => {})()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ledger unwritable"));
    });
  });
});
