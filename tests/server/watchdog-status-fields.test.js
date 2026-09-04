const { createWatchdog } = require("../../lib/server/watchdog");
const {
  kOpenclawDegradedRollbackMs,
  kOpenclawStabilizationWindowMs,
} = require("../../lib/server/constants");

// U2 regression surface: the additive getStatus() fields (degradedReason,
// lastExit, window timestamps, backoff, stabilization/doctor-fix suppression,
// phase, serverNow). The escalation ladder itself is covered by watchdog.test.js
// and must be unaffected by these additions.

const createHarness = ({ releaseChannelHooks = null, fetchImpl } = {}) => {
  const insertWatchdogEvent = vi.fn();
  const launchGatewayProcess = vi.fn(async () => null);
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true })),
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier: { notify: vi.fn(async () => ({ ok: true })) },
    readEnvFile: vi.fn(() => ""),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost",
    resolveGatewayHealthUrl: () => "http://gateway/health",
    resolveGatewayReadyzUrl: () => "http://gateway/readyz",
    releaseChannelHooks,
    sleepImpl: () => Promise.resolve(),
  });
  if (fetchImpl) vi.stubGlobal("fetch", fetchImpl);
  return { watchdog, insertWatchdogEvent, launchGatewayProcess };
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("getStatus() additive fields", () => {
  it("exposes safe defaults on a fresh instance", () => {
    const { watchdog } = createHarness();
    const status = watchdog.getStatus();
    expect(status.phase).toBe("stopped");
    expect(status.degradedReason).toBe(null);
    expect(status.lastExit).toBe(null);
    expect(status.backoff).toEqual({ active: false, untilMs: null, attempt: 0 });
    expect(status.rollbackDeadlineAt).toBe(null);
    expect(status.stabilization).toEqual({ active: false, until: null });
    expect(status.doctorFixSuppressed).toBe(false);
    expect(status.doctorFixSuppressedReason).toBe(null);
    expect(status.expectedRestartUntil).toBe(null);
    expect(status.startupGraceUntil).toBe(null);
    expect(status.awaitingAutoRepairRecovery).toBe(false);
    expect(typeof status.serverNow).toBe("number");
    expect(status.repairAttemptLimit).toBeGreaterThan(0);
    // Memory monitor: latched enum + ISO + boolean only — the 2s SSE frame-
    // dedupe projection must never see an always-changing numeric here.
    expect(status.memory).toEqual({
      trendState: "no_gateway",
      trendSince: null,
      autoRestartEnabled: false,
    });
  });

  it("memory status stays frame-stable across repeated reads (SSE dedupe safety)", async () => {
    const { watchdog } = createHarness();
    const readMemorySample = vi.fn(() => ({ rssBytes: 100 * 1024 * 1024 }));
    // Re-create with an injected sampler + settings so a tick actually runs.
    const memWatchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true })),
      launchGatewayProcess: vi.fn(async () => null),
      insertWatchdogEvent: vi.fn(),
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      sleepImpl: () => Promise.resolve(),
      readMemorySample,
      readMemorySettings: () => ({
        enabled: true,
        autoRestart: false,
        effectiveAutoRestart: false,
      }),
    });
    memWatchdog.onGatewayLaunch({ pid: 777, startedAt: Date.now() });
    await memWatchdog.checkMemoryTrend();
    const first = memWatchdog.getStatus().memory;
    expect(first.trendState).toBe("warming_up");
    expect(first.trendSince).toBeTruthy();
    // Repeated getStatus reads with NO new tick are byte-identical — no
    // volatile numerics leak into the projection.
    const second = memWatchdog.getStatus().memory;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Another tick in the SAME state changes nothing either.
    await memWatchdog.checkMemoryTrend();
    const third = memWatchdog.getStatus().memory;
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    void watchdog;
  });

  it("records lastExit and crash phase on an unexpected gateway exit", async () => {
    const { watchdog } = createHarness();
    watchdog.start();
    watchdog.onGatewayExit({ code: 1, signal: null, stderrTail: [] });
    await flushMicrotasks();
    const status = watchdog.getStatus();
    expect(status.lastExit).toMatchObject({ code: 1, signal: null });
    expect(typeof status.lastExit.at).toBe("string");
  });

  it("does not record lastExit for expected restarts", () => {
    const { watchdog } = createHarness();
    watchdog.start();
    watchdog.onGatewayExit({ code: 0, expectedExit: true });
    expect(watchdog.getStatus().lastExit).toBe(null);
    expect(watchdog.getStatus().phase).toBe("expected_restart");
  });

  it("reports startup grace window after start()", () => {
    const { watchdog } = createHarness();
    watchdog.start();
    const status = watchdog.getStatus();
    expect(status.phase).toBe("startup_grace");
    expect(status.startupGraceUntil).not.toBe(null);
    expect(Date.parse(status.startupGraceUntil)).toBeGreaterThan(Date.now());
  });

  it("captures degradedReason on the degraded transition and clears it on recovery", async () => {
    vi.useFakeTimers();
    try {
      let mode = "healthy";
      const fetchImpl = vi.fn(async (url) => {
        if (String(url).includes("readyz")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ready: true, suppressed: [] }),
          };
        }
        if (mode === "healthy") {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true }),
          };
        }
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: "queue backlog" }),
        };
      });
      const { watchdog } = createHarness({ fetchImpl });
      // Launch with a start time past the 30s grace so failures degrade.
      watchdog.onGatewayLaunch({ pid: 111, startedAt: Date.now() - 60_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().phase).toBe("healthy");

      mode = "failing";
      // Next regular health check (120s cadence).
      await vi.advanceTimersByTimeAsync(120_000);
      const degraded = watchdog.getStatus();
      expect(degraded.health).toBe("degraded");
      expect(degraded.degradedReason).toBe("queue backlog");
      expect(degraded.phase).toBe("degraded_retrying");
      expect(degraded.rollbackDeadlineAt).toBe(null);

      mode = "healthy";
      // Degraded retry cadence is 5s.
      await vi.advanceTimersByTimeAsync(5_000);
      const recovered = watchdog.getStatus();
      expect(recovered.health).toBe("healthy");
      expect(recovered.degradedReason).toBe(null);
      expect(recovered.lastExit).toBe(null);
      expect(recovered.phase).toBe("healthy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives stabilization/doctor-fix suppression and rollback deadline from the ladder predicate", () => {
    const acceptedAt = Date.now() - 60 * 60 * 1000;
    const { watchdog } = createHarness({
      releaseChannelHooks: {
        getInfo: () => ({
          isPin: false,
          inStabilizationWindow: true,
          acceptedAt,
          applied: { acceptedSource: "auto" },
        }),
        requestRollback: () => null,
        onHealthy: () => {},
        onUnhealthy: () => {},
      },
    });
    watchdog.start();
    const status = watchdog.getStatus();
    expect(status.doctorFixSuppressed).toBe(true);
    expect(status.doctorFixSuppressedReason).toBe("stabilization_window");
    expect(status.stabilization.active).toBe(true);
    expect(Date.parse(status.stabilization.until)).toBe(
      acceptedAt + kOpenclawStabilizationWindowMs,
    );
    // Not degraded yet → no rollback deadline.
    expect(status.rollbackDeadlineAt).toBe(null);
  });

  it("suppression stays false for pinned builds", () => {
    const { watchdog } = createHarness({
      releaseChannelHooks: {
        getInfo: () => ({ isPin: true, inStabilizationWindow: false }),
        requestRollback: () => null,
      },
    });
    watchdog.start();
    const status = watchdog.getStatus();
    expect(status.doctorFixSuppressed).toBe(false);
    expect(status.stabilization).toEqual({ active: false, until: null });
  });

  it("reads the stabilization deadline from stabilization.endsAt for a pin window", () => {
    const acceptedAt = Date.now() - 60 * 60 * 1000;
    const endsAt = acceptedAt + kOpenclawStabilizationWindowMs;
    const { watchdog } = createHarness({
      releaseChannelHooks: {
        getInfo: () => ({
          isPin: true,
          applied: null,
          inStabilizationWindow: true,
          acceptedAt,
          stabilization: {
            source: "pin",
            inWindow: true,
            acceptedAt,
            acceptedSource: "acceptance",
            endsAt,
            blockedId: "2026.9.1",
            target: { kind: "package", channel: "stable", version: "2026.8.1" },
          },
        }),
        requestRollback: () => null,
        onHealthy: () => {},
        onUnhealthy: () => {},
      },
    });
    watchdog.start();
    const status = watchdog.getStatus();
    expect(status.doctorFixSuppressed).toBe(true);
    expect(status.doctorFixSuppressedReason).toBe("stabilization_window");
    expect(status.stabilization.active).toBe(true);
    expect(Date.parse(status.stabilization.until)).toBe(endsAt);
  });

  it("leaves the deadline null while a window is open but not yet armed", () => {
    const acceptedAt = Date.now() - 60 * 60 * 1000;
    const { watchdog } = createHarness({
      releaseChannelHooks: {
        getInfo: () => ({
          isPin: false,
          inStabilizationWindow: true,
          acceptedAt,
          applied: { acceptedSource: "manual" },
          stabilization: {
            source: "channel",
            inWindow: true,
            acceptedAt,
            acceptedSource: "manual",
            endsAt: null,
            blockedId: "beta:2026.9.1-beta.2",
            target: { kind: "pin" },
          },
        }),
        requestRollback: () => null,
        onHealthy: () => {},
        onUnhealthy: () => {},
      },
    });
    watchdog.start();
    const status = watchdog.getStatus();
    expect(status.stabilization).toEqual({ active: true, until: null });
  });
});
