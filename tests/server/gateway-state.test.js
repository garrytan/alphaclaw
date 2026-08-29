const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  reduceGatewayState,
  createGatewayStateTracker,
  kGatewayStateCatalog,
} = require("../../lib/server/gateway-state");

const kNow = 1_800_000_000_000;

// Baseline healthy inputs; individual cases override axes.
const inputs = (overrides = {}) => ({
  configExists: true,
  tcp: { running: true, observedAt: kNow },
  watchdog: {
    lifecycle: "running",
    health: "healthy",
    safeMode: false,
    suppressedChannels: [],
    crashCountInWindow: 0,
    crashLoopThreshold: 3,
    crashLoopWindowMs: 300000,
    gatewayPid: 123,
  },
  operation: null,
  bootPhase: { phase: "ready", error: null },
  now: kNow,
  ...overrides,
});

describe("server/gateway-state reducer", () => {
  // Table-driven precedence matrix: every row is (description, input overrides,
  // expected headline). Precedence: not_onboarded/booting gate first, then
  // config_error > down > flapping > degraded > safe_mode > running; the
  // operation never changes the headline (it rides as a structured badge).
  const kMatrix = [
    ["no config", { configExists: false }, "not_onboarded"],
    [
      "no config wins over everything",
      {
        configExists: false,
        tcp: { running: false, observedAt: kNow },
        watchdog: null,
        bootPhase: { phase: "starting_gateway", error: null },
      },
      "not_onboarded",
    ],
    [
      "boot in progress",
      { bootPhase: { phase: "starting_gateway", error: null }, tcp: { running: false, observedAt: kNow } },
      "booting",
    ],
    [
      "boot failed",
      { bootPhase: { phase: "failed", error: "sync exploded" }, tcp: { running: false, observedAt: kNow } },
      "boot_failed",
    ],
    [
      "stale tcp observation degrades to unknown",
      { tcp: { running: true, observedAt: kNow - 16_000 } },
      "unknown",
    ],
    [
      "no tcp observation yet",
      { tcp: { running: null, observedAt: 0 } },
      "unknown",
    ],
    [
      "config error beats everything after gates",
      {
        watchdog: {
          lifecycle: "configuration_error",
          health: "unhealthy",
          safeMode: false,
          crashCountInWindow: 0,
        },
        tcp: { running: false, observedAt: kNow },
      },
      "config_error",
    ],
    [
      "config error even while port is up",
      {
        watchdog: { lifecycle: "configuration_error", health: "unhealthy", safeMode: false, crashCountInWindow: 0 },
      },
      "config_error",
    ],
    [
      "down: tcp down, no launch in progress",
      { tcp: { running: false, observedAt: kNow } },
      "down",
    ],
    [
      // A crash immediately kicks the watchdog's relaunch — that IS a launch
      // in progress; "Down + Retry" would invite a competing route restart.
      "starting: crashed lifecycle (auto-relaunch imminent)",
      {
        tcp: { running: false, observedAt: kNow },
        watchdog: { lifecycle: "crashed", health: "unhealthy", safeMode: false, crashCountInWindow: 1 },
      },
      "starting",
    ],
    [
      "starting: watchdog repair in flight with gateway down",
      {
        tcp: { running: false, observedAt: kNow },
        watchdog: {
          lifecycle: "running",
          health: "unhealthy",
          safeMode: false,
          crashCountInWindow: 0,
          operationInProgress: true,
        },
      },
      "starting",
    ],
    [
      "down: crash loop with auto-restart paused",
      {
        tcp: { running: false, observedAt: kNow },
        watchdog: { lifecycle: "crash_loop", health: "unhealthy", safeMode: false, crashCountInWindow: 3 },
      },
      "down",
    ],
    [
      "starting: tcp down while a restart operation runs",
      {
        tcp: { running: false, observedAt: kNow },
        operation: { kind: "gateway_restart", label: "Restarting gateway", startedAt: kNow - 5_000 },
      },
      "starting",
    ],
    [
      "starting: watchdog says restarting",
      {
        tcp: { running: false, observedAt: kNow },
        watchdog: { lifecycle: "restarting", health: "unknown", safeMode: false, crashCountInWindow: 0 },
      },
      "starting",
    ],
    [
      "starting: port up but health not yet confirmed",
      {
        watchdog: { lifecycle: "running", health: "unknown", safeMode: false, crashCountInWindow: 0 },
      },
      "starting",
    ],
    [
      "flapping: up now but crashed recently (the screenshot case)",
      {
        watchdog: { lifecycle: "running", health: "healthy", safeMode: false, crashCountInWindow: 2 },
      },
      "flapping",
    ],
    [
      "flapping: crash_loop lifecycle while port is up",
      {
        watchdog: { lifecycle: "crash_loop", health: "unhealthy", safeMode: false, crashCountInWindow: 3 },
      },
      "flapping",
    ],
    [
      "degraded: health failing while up",
      {
        watchdog: { lifecycle: "running", health: "degraded", safeMode: false, crashCountInWindow: 0 },
      },
      "degraded",
    ],
    [
      "degraded: unhealthy",
      {
        watchdog: { lifecycle: "running", health: "unhealthy", safeMode: false, crashCountInWindow: 0 },
      },
      "degraded",
    ],
    [
      "safe mode: channels suppressed while healthy",
      {
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: true,
          suppressedChannels: ["telegram"],
          crashCountInWindow: 0,
        },
      },
      "safe_mode",
    ],
    ["running: everything healthy", {}, "running"],
    [
      "running without a watchdog (not started)",
      { watchdog: null },
      "running",
    ],
    [
      "flapping beats degraded",
      {
        watchdog: { lifecycle: "running", health: "degraded", safeMode: false, crashCountInWindow: 1 },
      },
      "flapping",
    ],
    [
      "degraded beats safe_mode",
      {
        watchdog: { lifecycle: "running", health: "degraded", safeMode: true, crashCountInWindow: 0 },
      },
      "degraded",
    ],
  ];

  for (const [name, overrides, expected] of kMatrix) {
    it(`headline: ${name} → ${expected}`, () => {
      expect(reduceGatewayState(inputs(overrides)).state).toBe(expected);
    });
  }

  it("every state resolves to a catalog entry with a public label, dot, glossary, and at most one primary action", () => {
    for (const [state, entry] of Object.entries(kGatewayStateCatalog)) {
      expect(entry.label, state).toBeTruthy();
      expect(entry.dot?.color, state).toBeTruthy();
      expect(["steady", "pulse", "hollow"]).toContain(entry.dot.motion);
      expect(entry.glossary, state).toBeTruthy();
      // Internal enum names must never be the public label.
      expect(entry.label).not.toBe(state);
    }
  });

  it("never leaks the internal enum as the label and binds exactly one primary action", () => {
    for (const [, overrides] of kMatrix) {
      const result = reduceGatewayState(inputs(overrides));
      expect(result.label).toBeTruthy();
      expect(result.label).not.toBe(result.state);
      const primaries = result.actions.filter((a) => a.kind === "primary");
      expect(primaries.length, result.state).toBeLessThanOrEqual(1);
      for (const action of result.actions) {
        expect(action.id, result.state).toBeTruthy();
        expect(action.label, result.state).toBeTruthy();
        expect(["primary", "secondary", "danger"]).toContain(action.kind);
      }
    }
  });

  it("pulse is reserved for operation-like states; running is steady", () => {
    expect(reduceGatewayState(inputs()).dot).toEqual({
      color: "green",
      motion: "steady",
    });
    const starting = reduceGatewayState(
      inputs({
        watchdog: { lifecycle: "running", health: "unknown", safeMode: false, crashCountInWindow: 0 },
      }),
    );
    expect(starting.dot.motion).toBe("pulse");
    const down = reduceGatewayState(
      inputs({ tcp: { running: false, observedAt: kNow } }),
    );
    expect(down.dot).toEqual({ color: "red", motion: "steady" });
  });

  it("carries the operation through as a structured badge without changing the headline", () => {
    const operation = {
      kind: "gateway_restart",
      label: "Restarting gateway",
      startedAt: kNow - 1000,
    };
    const result = reduceGatewayState(inputs({ operation }));
    expect(result.state).toBe("running");
    expect(result.operation).toEqual(operation);
  });

  it("disables the restart action with a reason while an operation is active", () => {
    const result = reduceGatewayState(
      inputs({
        operation: { kind: "channel_apply", label: "Applying update", startedAt: kNow },
      }),
    );
    const restart = result.actions.find((a) => a.id === "restart");
    expect(restart?.disabledReason).toBeTruthy();
  });

  it("includes crash evidence in the flapping reason", () => {
    const result = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: false,
          crashCountInWindow: 2,
          crashLoopWindowMs: 300000,
        },
      }),
    );
    expect(result.reason).toContain("2");
    expect(result.reason.toLowerCase()).toContain("restart");
  });

  it("marks probe-inferred evidence when the gateway runs detached", () => {
    const result = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: false,
          crashCountInWindow: 1,
          gatewayPid: null,
        },
      }),
    );
    expect(result.supervision).toBe("detached");
    expect(result.detail).toContain("estimated");
  });

  it("offers roll_back only while flapping inside the stabilization window", () => {
    const flapping = {
      watchdog: {
        lifecycle: "running",
        health: "healthy",
        safeMode: false,
        crashCountInWindow: 2,
        gatewayPid: 123,
      },
    };
    const inWindow = reduceGatewayState(
      inputs({ ...flapping, inStabilizationWindow: true }),
    );
    expect(inWindow.state).toBe("flapping");
    expect(inWindow.actions).toContainEqual(
      expect.objectContaining({
        id: "roll_back",
        label: "Roll back",
        kind: "danger",
        needsConfirm: true,
      }),
    );

    const outsideWindow = reduceGatewayState(inputs(flapping));
    expect(outsideWindow.state).toBe("flapping");
    expect(outsideWindow.actions.some((a) => a.id === "roll_back")).toBe(false);
  });

  it("keeps evidence honest: no estimate under managed supervision, estimate when detached and down", () => {
    // Managed (gatewayPid set): crash counts come from real exit events, so
    // flapping must NOT carry the "estimated" hedge.
    const managed = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: false,
          crashCountInWindow: 2,
          gatewayPid: 123,
        },
      }),
    );
    expect(managed.state).toBe("flapping");
    expect(managed.supervision).toBe("managed");
    expect(managed.detail).toBeNull();

    // Detached and down with probe-inferred crashes: the hedge is required.
    const detachedDown = reduceGatewayState(
      inputs({
        tcp: { running: false, observedAt: kNow },
        watchdog: {
          lifecycle: "crash_loop",
          health: "unhealthy",
          safeMode: false,
          crashCountInWindow: 3,
          gatewayPid: null,
        },
      }),
    );
    expect(detachedDown.state).toBe("down");
    expect(detachedDown.supervision).toBe("detached");
    expect(detachedDown.detail).toContain("estimated");
  });
});

describe("server/gateway-state tracker (temporal truth)", () => {
  const makeTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gwstate-"));

  it("stamps since on transition and keeps it while the state holds", () => {
    let now = kNow;
    const tracker = createGatewayStateTracker({
      persistPath: path.join(makeTmp(), "state.json"),
      now: () => now,
      bootId: "boot-1",
    });
    const first = tracker.track(reduceGatewayState(inputs({ now })));
    expect(first.since).toBe(kNow);
    now += 5_000;
    const second = tracker.track(reduceGatewayState(inputs({ now })));
    expect(second.since).toBe(kNow);
    now += 5_000;
    const third = tracker.track(
      reduceGatewayState(inputs({ now, tcp: { running: false, observedAt: now } })),
    );
    expect(third.state).toBe("down");
    expect(third.since).toBe(now);
  });

  it("persists {state, since, bootId} and restores continuity for a matching state", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    let now = kNow;
    const a = createGatewayStateTracker({
      persistPath,
      now: () => now,
      bootId: "boot-1",
    });
    a.track(reduceGatewayState(inputs({ now })));

    now += 60_000;
    const b = createGatewayStateTracker({
      persistPath,
      now: () => now,
      bootId: "boot-2",
    });
    const restored = b.track(
      reduceGatewayState(inputs({ now, tcp: { running: true, observedAt: now } })),
    );
    // Same state across a process restart: since is preserved.
    expect(restored.since).toBe(kNow);
    const onDisk = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    expect(onDisk.bootId).toBe("boot-2");
  });

  it("starts a fresh since when the restored state differs", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    let now = kNow;
    const a = createGatewayStateTracker({
      persistPath,
      now: () => now,
      bootId: "boot-1",
    });
    a.track(reduceGatewayState(inputs({ now })));

    now += 60_000;
    const b = createGatewayStateTracker({
      persistPath,
      now: () => now,
      bootId: "boot-2",
    });
    const changed = b.track(
      reduceGatewayState(inputs({ now, tcp: { running: false, observedAt: now } })),
    );
    expect(changed.state).toBe("down");
    expect(changed.since).toBe(now);
  });

  it("tolerates an unreadable persist file", () => {
    const persistPath = path.join(makeTmp(), "nested", "state.json");
    const tracker = createGatewayStateTracker({
      persistPath,
      now: () => kNow,
      bootId: "boot-1",
    });
    expect(tracker.track(reduceGatewayState(inputs())).state).toBe("running");
  });

  it("starts a fresh since when the persisted JSON has the wrong shape", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    // Valid JSON, wrong types: state must be a string and since a finite number.
    fs.writeFileSync(persistPath, JSON.stringify({ state: 5, since: "x" }), "utf8");
    const tracker = createGatewayStateTracker({
      persistPath,
      now: () => kNow,
      bootId: "boot-1",
    });

    const result = tracker.track(reduceGatewayState(inputs()));

    expect(result.state).toBe("running");
    expect(result.since).toBe(kNow);
  });

  it("still returns the reduced state when persisting fails", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const tracker = createGatewayStateTracker({
      persistPath,
      now: () => kNow,
      bootId: "boot-1",
    });

    const result = tracker.track(reduceGatewayState(inputs()));
    expect(result.state).toBe("running");
    expect(result.since).toBe(kNow);
    expect(writeSpy).toHaveBeenCalled();
    expect(fs.existsSync(persistPath)).toBe(false);
    writeSpy.mockRestore();

    // Atomic-rename failure is swallowed the same way.
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted");
    });
    const trackerB = createGatewayStateTracker({
      persistPath,
      now: () => kNow,
      bootId: "boot-2",
    });
    const resultB = trackerB.track(reduceGatewayState(inputs()));
    expect(resultB.state).toBe("running");
    expect(resultB.since).toBe(kNow);
    expect(fs.existsSync(persistPath)).toBe(false);
  });
});
