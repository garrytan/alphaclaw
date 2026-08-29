const {
  deriveWatchdogPhase,
  kWatchdogPhases,
} = require("../../lib/server/watchdog-phase");

const kNow = 1_000_000_000_000;

const base = {
  lifecycle: "running",
  health: "healthy",
  configurationErrorActive: false,
  managedOperationActive: false,
  expectedRestartInProgress: false,
  expectedRestartUntilMs: 0,
  safeMode: false,
  channelRollbackRequested: false,
  crashRecoveryActive: false,
  gatewayStartedAt: kNow - 120_000,
  startupGraceMs: 30_000,
  awaitingAutoRepairRecovery: false,
  operationInProgress: false,
  rollbackEligible: false,
};

describe("deriveWatchdogPhase precedence table", () => {
  // One row per phase, each also proving it beats the next-lower-precedence
  // condition (the second column mixes in a lower-priority trigger).
  const rows = [
    [
      "config_error_latched",
      { configurationErrorActive: true, managedOperationActive: true },
    ],
    ["managed_operation", { managedOperationActive: true, lifecycle: "stopped" }],
    [
      "stopped",
      {
        lifecycle: "stopped",
        expectedRestartInProgress: true,
        expectedRestartUntilMs: kNow + 10_000,
      },
    ],
    [
      "expected_restart",
      {
        lifecycle: "restarting",
        health: "unknown",
        safeMode: true,
      },
    ],
    ["safe_mode", { safeMode: true, lifecycle: "crash_loop" }],
    [
      "crash_loop_rollback",
      { lifecycle: "crash_loop", health: "unhealthy", channelRollbackRequested: true },
    ],
    [
      "crash_loop_repair_ladder",
      { lifecycle: "crash_loop", health: "unhealthy" },
    ],
    ["crash_backoff", { lifecycle: "crashed", health: "unhealthy" }],
    [
      "startup_grace",
      {
        health: "unknown",
        gatewayStartedAt: kNow - 5_000,
        awaitingAutoRepairRecovery: true,
      },
    ],
    [
      "awaiting_repair_recovery",
      { health: "degraded", awaitingAutoRepairRecovery: true, operationInProgress: true },
    ],
    [
      "degraded_repairing",
      { health: "degraded", operationInProgress: true, rollbackEligible: true },
    ],
    ["degraded_pre_rollback", { health: "degraded", rollbackEligible: true }],
    ["degraded_retrying", { health: "degraded" }],
    ["healthy", {}],
    ["unknown_bootstrap", { health: "unknown", gatewayStartedAt: kNow - 120_000 }],
  ];

  for (const [expected, overrides] of rows) {
    it(`derives ${expected}`, () => {
      expect(deriveWatchdogPhase({ ...base, ...overrides }, kNow)).toBe(expected);
    });
  }

  it("covers every documented phase exactly once", () => {
    const derived = rows.map(([expected]) => expected);
    expect([...derived].sort()).toEqual([...kWatchdogPhases].sort());
  });
});

describe("deriveWatchdogPhase totality", () => {
  it("never returns a phase outside the documented enum (the narrator can never say Unknown)", () => {
    const lifecycles = [
      "stopped",
      "running",
      "restarting",
      "crashed",
      "crash_loop",
      "configuration_error",
      "garbage",
    ];
    const healths = ["unknown", "healthy", "degraded", "unhealthy", "garbage"];
    const bools = [true, false];
    for (const lifecycle of lifecycles) {
      for (const health of healths) {
        for (const safeMode of bools) {
          for (const awaitingAutoRepairRecovery of bools) {
            for (const operationInProgress of bools) {
              for (const rollbackEligible of bools) {
                const phase = deriveWatchdogPhase(
                  {
                    ...base,
                    lifecycle,
                    health,
                    safeMode,
                    awaitingAutoRepairRecovery,
                    operationInProgress,
                    rollbackEligible,
                  },
                  kNow,
                );
                expect(kWatchdogPhases).toContain(phase);
              }
            }
          }
        }
      }
    }
  });

  it("handles an empty snapshot", () => {
    expect(deriveWatchdogPhase()).toBe("stopped");
    expect(deriveWatchdogPhase({}, kNow)).toBe("stopped");
  });

  it("expected restart window expires by timestamp", () => {
    const snapshot = {
      ...base,
      expectedRestartInProgress: true,
      expectedRestartUntilMs: kNow - 1,
    };
    expect(deriveWatchdogPhase(snapshot, kNow)).toBe("healthy");
    snapshot.expectedRestartUntilMs = kNow + 1;
    expect(deriveWatchdogPhase(snapshot, kNow)).toBe("expected_restart");
  });

  it("startup grace expires by timestamp and is skipped during crash recovery", () => {
    const graceSnapshot = {
      ...base,
      health: "unknown",
      gatewayStartedAt: kNow - 5_000,
    };
    expect(deriveWatchdogPhase(graceSnapshot, kNow)).toBe("startup_grace");
    expect(
      deriveWatchdogPhase({ ...graceSnapshot, crashRecoveryActive: true }, kNow),
    ).toBe("unknown_bootstrap");
    expect(
      deriveWatchdogPhase(
        { ...graceSnapshot, gatewayStartedAt: kNow - 31_000 },
        kNow,
      ),
    ).toBe("unknown_bootstrap");
  });

  it("unhealthy-but-running falls back to degraded_retrying (between repair attempts)", () => {
    expect(
      deriveWatchdogPhase({ ...base, health: "unhealthy" }, kNow),
    ).toBe("degraded_retrying");
  });
});
