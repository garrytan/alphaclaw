const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  reduceGatewayState,
  createGatewayStateTracker,
  kGatewayStateCatalog,
  actionsForState,
  kLifecycleActionBlockReasons,
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

  it("offers a restart-class action (Restart or Retry) in every onboarded state except booting", () => {
    // Repair / Resume channels / Refresh are the recommended move in their
    // states, never the only one: an operator must be able to relaunch the
    // gateway from the card without running doctor first. Two exemptions,
    // both deliberate: not_onboarded has no gateway (the route 400s), and
    // booting IS the launch — a restart queued behind the boot hold would
    // only recycle a gateway that just came up (boot_failed carries Retry).
    for (const state of Object.keys(kGatewayStateCatalog)) {
      const actions = actionsForState(state, {
        operationActive: false,
        inStabilizationWindow: false,
        gatewayHeld: false,
      });
      const restartClass = actions.filter(
        (a) => a.id === "restart" || a.id === "retry",
      );
      if (state === "not_onboarded") {
        expect(restartClass, state).toHaveLength(0);
        continue;
      }
      if (state === "booting") {
        expect(actions, state).toEqual([]);
        continue;
      }
      expect(restartClass.length, state).toBeGreaterThanOrEqual(1);
      for (const a of restartClass) {
        expect(a.disabledReason, state).toBeUndefined();
      }
    }
  });

  it("a reconciler gateway hold disables Restart/Retry AND Repair with the Upgrade-page reason, leaving the rest enabled", () => {
    for (const state of ["running", "config_error", "down", "flapping", "boot_failed", "degraded", "safe_mode", "unknown", "starting"]) {
      const actions = actionsForState(state, {
        operationActive: false,
        inStabilizationWindow: false,
        gatewayHeld: true,
      });
      for (const a of actions) {
        if (["restart", "retry", "repair"].includes(a.id)) {
          expect(a.disabledReason, `${state}/${a.id}`).toBe(
            kLifecycleActionBlockReasons.gatewayHeld,
          );
        } else {
          expect(a.disabledReason, `${state}/${a.id}`).toBeUndefined();
        }
      }
    }
    // Copy is generic on purpose: the Upgrade page picks the remedy.
    expect(kLifecycleActionBlockReasons.gatewayHeld).toContain("Upgrade page");
    expect(kLifecycleActionBlockReasons.gatewayHeld).not.toContain("Retry migration");
  });

  it("a hold never blocks Roll back: flapping inside the stabilization window keeps the danger action enabled", () => {
    const actions = actionsForState("flapping", {
      operationActive: false,
      inStabilizationWindow: true,
      gatewayHeld: true,
    });
    const rollBack = actions.find((a) => a.id === "roll_back");
    expect(rollBack).toBeTruthy();
    expect(rollBack.kind).toBe("danger");
    expect(rollBack.disabledReason).toBeUndefined();
    expect(actions.find((a) => a.id === "repair").disabledReason).toBe(
      kLifecycleActionBlockReasons.gatewayHeld,
    );
  });

  it("unknown (Status unavailable): Refresh stays primary, Restart is offered and enabled", () => {
    const result = reduceGatewayState(
      inputs({ tcp: { running: true, observedAt: kNow - 10 * 60_000 } }),
    );
    expect(result.state).toBe("unknown");
    expect(result.actions.find((a) => a.kind === "primary")?.id).toBe("refresh");
    const restart = result.actions.find((a) => a.id === "restart");
    expect(restart?.kind).toBe("secondary");
    expect(restart?.disabledReason).toBeUndefined();
    expect(kGatewayStateCatalog.unknown.glossary).toContain("Restart is still available");
    expect(kGatewayStateCatalog.starting.glossary).toContain("if the launch stalls");
    expect(kGatewayStateCatalog.flapping.glossary).toContain("relaunches without diagnosis");
  });

  it("precedence: a live operation outranks a hold in the disabled reason", () => {
    const held = reduceGatewayState(
      inputs({
        gatewayHeld: true,
        operation: { kind: "repair", label: "Repairing", startedAt: kNow },
      }),
    );
    expect(held.actions.find((a) => a.id === "restart").disabledReason).toBe(
      kLifecycleActionBlockReasons.operation,
    );
    const heldIdle = reduceGatewayState(inputs({ gatewayHeld: true }));
    expect(heldIdle.actions.find((a) => a.id === "restart").disabledReason).toBe(
      kLifecycleActionBlockReasons.gatewayHeld,
    );
    const clear = reduceGatewayState(inputs({}));
    expect(clear.actions.find((a) => a.id === "restart").disabledReason).toBeUndefined();
  });

  it("safe_mode glossary tells the truth: Restart does not resume paused channels", () => {
    expect(kGatewayStateCatalog.safe_mode.glossary).toContain("does not resume");
    // And booting's glossary no longer advertises a restart it does not offer.
    expect(kGatewayStateCatalog.booting.glossary.toLowerCase()).not.toContain("restart");
  });

  it("flapping keeps Repair primary but no longer makes it the only remedy", () => {
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
    expect(result.state).toBe("flapping");
    const primary = result.actions.find((a) => a.kind === "primary");
    expect(primary?.id).toBe("repair");
    const restart = result.actions.find((a) => a.id === "restart");
    expect(restart).toBeTruthy();
    expect(restart.kind).toBe("secondary");
    expect(restart.disabledReason).toBeUndefined();
  });

  it("safe_mode offers Restart alongside Resume channels", () => {
    const result = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: true,
          suppressedChannels: ["telegram"],
          crashCountInWindow: 0,
        },
      }),
    );
    expect(result.state).toBe("safe_mode");
    expect(result.actions.find((a) => a.kind === "primary")?.id).toBe(
      "resume_channels",
    );
    expect(result.actions.some((a) => a.id === "restart")).toBe(true);
  });

  it("starting: Restart is disabled under a leased operation AND during a watchdog-owned relaunch, enabled once the launch is just waiting on health", () => {
    const leased = reduceGatewayState(
      inputs({
        tcp: { running: false, observedAt: kNow },
        operation: { kind: "gateway_repair", label: "Repairing", startedAt: kNow },
      }),
    );
    expect(leased.state).toBe("starting");
    expect(leased.actions.find((a) => a.id === "restart")?.disabledReason).toBe(
      kLifecycleActionBlockReasons.operation,
    );

    // Crash relaunch / exit-78 auto-retry release the lifecycle lock right
    // after spawn (or never take it): only the lifecycle says a relaunch is in
    // flight, and a user restart here would stop the child just spawned.
    for (const watchdog of [
      { lifecycle: "restarting", health: "unknown", safeMode: false, crashCountInWindow: 0 },
      { lifecycle: "crashed", health: "unknown", safeMode: false, crashCountInWindow: 1, backoff: { active: true, untilMs: kNow + 4000, attempt: 2 } },
    ]) {
      const relaunch = reduceGatewayState(
        inputs({ tcp: { running: false, observedAt: kNow }, watchdog }),
      );
      expect(relaunch.state, watchdog.lifecycle).toBe("starting");
      expect(relaunch.actions.find((a) => a.id === "restart")?.disabledReason, watchdog.lifecycle).toBe(
        kLifecycleActionBlockReasons.relaunch,
      );
    }
    // A bare "crashed" with no backoff and no operation means the relaunch
    // was SKIPPED (lock held by a non-relaunching op, or stop requested):
    // nothing is coming, so Restart stays live instead of a false "relaunch
    // in progress" dead end.
    const skipped = reduceGatewayState(
      inputs({
        tcp: { running: false, observedAt: kNow },
        watchdog: { lifecycle: "crashed", health: "unknown", safeMode: false, crashCountInWindow: 1, backoff: { active: false, untilMs: 0, attempt: 0 } },
      }),
    );
    expect(skipped.state).toBe("starting");
    expect(skipped.actions.find((a) => a.id === "restart")?.disabledReason).toBeUndefined();
    const opInProgress = reduceGatewayState(
      inputs({
        tcp: { running: false, observedAt: kNow },
        watchdog: { lifecycle: "running", health: "unknown", safeMode: false, crashCountInWindow: 0, operationInProgress: true },
      }),
    );
    expect(opInProgress.actions.find((a) => a.id === "restart")?.disabledReason).toBe(
      kLifecycleActionBlockReasons.relaunch,
    );

    // Launched, healthy-unknown, nothing else in flight: Restart is live.
    const waitingOnHealth = reduceGatewayState(
      inputs({
        tcp: { running: true, observedAt: kNow },
        watchdog: { lifecycle: "running", health: "unknown", safeMode: false, crashCountInWindow: 0 },
      }),
    );
    expect(waitingOnHealth.state).toBe("starting");
    expect(waitingOnHealth.actions.find((a) => a.id === "restart")?.disabledReason).toBeUndefined();
  });

  it("the relaunch guard is scoped to starting: a stale 'restarting' lifecycle with the port up never locks the degraded/Unstable card out of Restart", () => {
    // An externally driven restart past its expected window that never
    // reported a launch leaves lifecycle "restarting" while the port answers.
    const degraded = reduceGatewayState(
      inputs({
        watchdog: { lifecycle: "restarting", health: "degraded", safeMode: false, crashCountInWindow: 0 },
      }),
    );
    expect(degraded.state).toBe("degraded");
    expect(degraded.actions.find((a) => a.id === "restart").disabledReason).toBeUndefined();
    const flapping = reduceGatewayState(
      inputs({
        watchdog: { lifecycle: "restarting", health: "healthy", safeMode: false, crashCountInWindow: 2, operationInProgress: true },
      }),
    );
    expect(flapping.state).toBe("flapping");
    expect(flapping.actions.find((a) => a.id === "restart").disabledReason).toBeUndefined();
    expect(flapping.actions.find((a) => a.id === "repair").disabledReason).toBeUndefined();
  });

  it("an unreadable/corrupted hold state fails closed: Restart, Retry and Repair are disabled with the unreadable reason", () => {
    const result = reduceGatewayState(inputs({ gatewayHoldUnreadable: true }));
    expect(result.actions.find((a) => a.id === "restart").disabledReason).toBe(
      kLifecycleActionBlockReasons.gatewayHoldUnreadable,
    );
    const down = actionsForState("down", {
      operationActive: false,
      inStabilizationWindow: false,
      gatewayHoldUnreadable: true,
    });
    for (const id of ["retry", "repair"]) {
      expect(down.find((a) => a.id === id).disabledReason).toBe(
        kLifecycleActionBlockReasons.gatewayHoldUnreadable,
      );
    }
    // Precedence: operation > relaunch > unreadable > held.
    const both = actionsForState("running", {
      operationActive: false,
      inStabilizationWindow: false,
      gatewayHeld: true,
      gatewayHoldUnreadable: true,
    });
    expect(both[0].disabledReason).toBe(kLifecycleActionBlockReasons.gatewayHoldUnreadable);
    const relaunchWins = actionsForState("running", {
      operationActive: false,
      inStabilizationWindow: false,
      gatewayHeld: true,
      relaunchActive: true,
    });
    expect(relaunchWins[0].disabledReason).toBe(kLifecycleActionBlockReasons.relaunch);
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
  describe("three-valued supervision (managed / adopted / detached)", () => {
    const running = (watchdog) =>
      reduceGatewayState(
        inputs({
          watchdog: {
            lifecycle: "running",
            health: "healthy",
            safeMode: false,
            crashCountInWindow: 0,
            ...watchdog,
          },
        }),
      );

    it.each([
      ["launch pid, no mode field (older watchdog)", { gatewayPid: 123 }, "managed", "managed"],
      ["launch pid + managed mode", { gatewayPid: 123, supervisionMode: "managed" }, "managed", "managed"],
      ["no pid, no mode field", { gatewayPid: null }, "detached", "detached"],
      ["no pid, detached mode", { gatewayPid: null, supervisionMode: "detached" }, "detached", "detached"],
      ["adopted incumbent (no launch pid)", { gatewayPid: null, supervisionMode: "adopted", servingPid: 777 }, "adopted", "adopted"],
      // A retained launch pid never outranks the watchdog's adopted verdict.
      ["adopted after a relaunch retained gatewayPid", { gatewayPid: 123, supervisionMode: "adopted" }, "adopted", "adopted"],
      // Garbage mode strings degrade to the derived axis, never leak through.
      ["unknown mode string", { gatewayPid: 123, supervisionMode: "weird" }, "managed", "managed"],
    ])("%s → supervision %s / supervisionMode %s", (_name, watchdog, supervision, mode) => {
      const result = running(watchdog);
      expect(result.supervision).toBe(supervision);
      expect(result.supervisionMode).toBe(mode);
    });

    it("passes the serving pid through (null when the watchdog has none)", () => {
      expect(running({ gatewayPid: null, supervisionMode: "adopted", servingPid: 777 }).servingPid).toBe(777);
      expect(running({ gatewayPid: 123 }).servingPid).toBeNull();
    });

    it("no watchdog → null supervision axes", () => {
      const result = reduceGatewayState(inputs({ watchdog: null }));
      expect(result.supervision).toBeNull();
      expect(result.supervisionMode).toBeNull();
      expect(result.servingPid).toBeNull();
      expect(result.replacementPending).toBeNull();
    });

    it("adopted gateways carry the estimated hedge when flapping (no exit events reach the watchdog)", () => {
      const adopted = running({
        gatewayPid: null,
        supervisionMode: "adopted",
        servingPid: 777,
        crashCountInWindow: 2,
      });
      expect(adopted.state).toBe("flapping");
      expect(adopted.supervision).toBe("adopted");
      expect(adopted.detail).toContain("estimated");
      // Healthy adopted gateway: no hedge without crash evidence.
      expect(running({ gatewayPid: null, supervisionMode: "adopted" }).detail).toBeNull();
    });
  });

  it("degraded reason names the failing readiness components when /health is green but readiness is not", () => {
    const notReady = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "degraded",
          safeMode: false,
          crashCountInWindow: 0,
          gatewayPid: 123,
          readiness: "not_ready",
          readinessReason: "secrets, event loop",
        },
      }),
    );
    expect(notReady.state).toBe("degraded");
    expect(notReady.reason).toBe(
      "The port answers and /health is green, but readiness checks are failing (secrets, event loop).",
    );

    const noReason = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "degraded",
          safeMode: false,
          gatewayPid: 123,
          readiness: "not_ready",
          readinessReason: null,
        },
      }),
    );
    expect(noReason.reason).toBe(
      "The port answers and /health is green, but readiness checks are failing.",
    );

    // Liveness degradation (readiness ready or unknown) keeps the generic copy.
    for (const readiness of ["ready", "unknown", undefined]) {
      const liveness = reduceGatewayState(
        inputs({
          watchdog: {
            lifecycle: "running",
            health: "degraded",
            safeMode: false,
            gatewayPid: 123,
            readiness,
          },
        }),
      );
      expect(liveness.reason).toBe("The port answers but health checks are failing.");
    }
  });

  it("passes replacementPending through verbatim (stable values for the SSE dedupe) and drops non-objects", () => {
    const pending = {
      pid: 4242,
      source: "exit_event",
      intent: "relaunch_if_absent",
      since: "2027-01-15T00:00:00.000Z",
      deadline: "2027-01-15T00:02:00.000Z",
    };
    const result = reduceGatewayState(
      inputs({
        watchdog: {
          lifecycle: "running",
          health: "healthy",
          safeMode: false,
          gatewayPid: 4242,
          replacementPending: pending,
        },
      }),
    );
    expect(result.replacementPending).toEqual(pending);
    expect(
      reduceGatewayState(
        inputs({
          watchdog: { lifecycle: "running", health: "healthy", safeMode: false, gatewayPid: 1, replacementPending: "yes" },
        }),
      ).replacementPending,
    ).toBeNull();
    expect(reduceGatewayState(inputs()).replacementPending).toBeNull();
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

describe("server/gateway-state tracker annotations: cause + versionMismatch (#76 A3/A4)", () => {
  const makeTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gwstate-ann-"));
  const readDisk = (persistPath) => JSON.parse(fs.readFileSync(persistPath, "utf8"));
  const kMismatch = {
    expected: "2026.9.2",
    running: "2026.7.1-2",
    source: "boot",
    detectedAt: "2026-09-06T12:00:00.000Z",
  };

  it("persists a cause change with NO state change (same since), and clears it the same way", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    let now = kNow;
    const tracker = createGatewayStateTracker({ persistPath, now: () => now, bootId: "boot-1" });
    tracker.track(reduceGatewayState(inputs({ now })));
    expect(readDisk(persistPath)).toEqual({
      state: "running",
      since: kNow,
      cause: null,
      versionMismatch: null,
      bootId: "boot-1",
    });
    now += 2_000;
    expect(tracker.setCause("state_schema_too_new")).toBe("state_schema_too_new");
    expect(readDisk(persistPath)).toMatchObject({
      state: "running",
      since: kNow,
      cause: "state_schema_too_new",
    });
    // The reduced output shape is unchanged: annotations live on disk, not in
    // the public state object.
    const reduced = tracker.track(reduceGatewayState(inputs({ now })));
    expect(reduced.since).toBe(kNow);
    expect(reduced).not.toHaveProperty("cause");
    expect(reduced).not.toHaveProperty("versionMismatch");
    tracker.setCause(null);
    expect(readDisk(persistPath).cause).toBeNull();
    // Non-string junk normalizes to null.
    tracker.setCause(42);
    expect(readDisk(persistPath).cause).toBeNull();
  });

  it("does not rewrite the file when the annotation is unchanged (it rides the 2s tick)", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    const tracker = createGatewayStateTracker({ persistPath, now: () => kNow, bootId: "boot-1" });
    tracker.track(reduceGatewayState(inputs()));
    tracker.setVersionMismatch(kMismatch);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      tracker.setVersionMismatch({ ...kMismatch });
      tracker.setCause(null);
      tracker.setCause(undefined);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("round-trips both annotations through persist → restore and carries them through a state transition", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    let now = kNow;
    const a = createGatewayStateTracker({ persistPath, now: () => now, bootId: "boot-1" });
    a.track(reduceGatewayState(inputs({ now })));
    a.setCause("legacy_exec_approvals");
    a.setVersionMismatch(kMismatch);

    now += 60_000;
    const b = createGatewayStateTracker({ persistPath, now: () => now, bootId: "boot-2" });
    // An identical annotation after restore is a no-op (file still names boot-1).
    expect(b.setVersionMismatch(kMismatch)).toEqual(kMismatch);
    expect(b.setCause("legacy_exec_approvals")).toBe("legacy_exec_approvals");
    expect(readDisk(persistPath).bootId).toBe("boot-1");
    // Same state → since preserved; the first track of the process stamps bootId.
    const restored = b.track(reduceGatewayState(inputs({ now, tcp: { running: true, observedAt: now } })));
    expect(restored.since).toBe(kNow);
    expect(readDisk(persistPath)).toEqual({
      state: "running",
      since: kNow,
      cause: "legacy_exec_approvals",
      versionMismatch: kMismatch,
      bootId: "boot-2",
    });
    // A transition replaces state+since but carries the annotations.
    now += 5_000;
    const down = b.track(
      reduceGatewayState(inputs({ now, tcp: { running: false, observedAt: now } })),
    );
    expect(down.state).toBe("down");
    expect(readDisk(persistPath)).toMatchObject({
      state: "down",
      since: now,
      cause: "legacy_exec_approvals",
      versionMismatch: kMismatch,
    });
  });

  it("restores the pre-#76 {state, since, bootId} shape with null annotations and drops unknown/invalid keys", () => {
    const persistPath = path.join(makeTmp(), "state.json");
    fs.writeFileSync(
      persistPath,
      JSON.stringify({ state: "running", since: kNow, bootId: "old", extra: "dropped" }),
      "utf8",
    );
    const tracker = createGatewayStateTracker({ persistPath, now: () => kNow + 10, bootId: "boot-2" });
    const result = tracker.track(reduceGatewayState(inputs({ now: kNow + 10 })));
    expect(result.since).toBe(kNow);
    expect(readDisk(persistPath)).toEqual({
      state: "running",
      since: kNow,
      cause: null,
      versionMismatch: null,
      bootId: "boot-2",
    });

    // Invalid annotation shapes are normalized, never trusted verbatim.
    fs.writeFileSync(
      persistPath,
      JSON.stringify({
        state: "running",
        since: kNow,
        cause: { nested: true },
        versionMismatch: { expected: 5, running: "2026.7.1-2", source: null, junk: 1 },
      }),
      "utf8",
    );
    const trackerB = createGatewayStateTracker({ persistPath, now: () => kNow, bootId: "boot-3" });
    trackerB.track(reduceGatewayState(inputs()));
    expect(readDisk(persistPath)).toMatchObject({
      cause: null,
      versionMismatch: { expected: null, running: "2026.7.1-2", source: null, detectedAt: null },
    });
    expect(trackerB.setVersionMismatch("junk")).toBeNull();
    expect(readDisk(persistPath).versionMismatch).toBeNull();
  });

  it("annotation setters work without a persist path and before any track()", () => {
    const tracker = createGatewayStateTracker({ now: () => kNow, bootId: "boot-1" });
    expect(tracker.setCause("oom")).toBe("oom");
    expect(tracker.setVersionMismatch(kMismatch)).toEqual(kMismatch);
    expect(tracker.track(reduceGatewayState(inputs())).state).toBe("running");
  });
});

describe("Stage 3 (#76 B1.3 / F015): the `down` reason names a latched auto-repair pause or an exhausted Doctor budget", () => {
  const {
    reduceGatewayState: reduce,
    kAutoRepairPauseCopy,
    kRepairAttemptsExhaustedCopy,
  } = require("../../lib/server/gateway-state");
  const now = 1_788_681_900_000;
  const downInputs = (watchdog) => ({
    configExists: true,
    tcp: { running: false, observedAt: now },
    watchdog: {
      lifecycle: "crashed",
      health: "unhealthy",
      safeMode: false,
      suppressedChannels: [],
      crashCountInWindow: 1,
      crashLoopThreshold: 3,
      crashLoopWindowMs: 300000,
      gatewayPid: null,
      operationInProgress: false,
      backoff: { active: false, untilMs: null, attempt: 0 },
      repairAttempts: 0,
      repairAttemptLimit: 2,
      autoRepairPaused: null,
      ...watchdog,
    },
    operation: null,
    bootPhase: { phase: "ready", error: null },
    now,
  });

  it("a paused box reads `down` with the pause copy (cause + installed version, suspected wording when uncorroborated); Retry/Repair stay offered", () => {
    const pause = {
      at: "2026-09-06T08:05:00.000Z",
      cause: "state_schema_too_new",
      fingerprint: "63e47a67df1b",
      installedVersion: "2026.7.1-2",
      attempts: 1,
      lastPlan: { rung: "recover_bootable", outcome: "no_bootable_version" },
      reason: "structural_repair_failed",
      corroborated: true,
    };
    const paused = reduce(downInputs({ autoRepairPaused: pause }));
    expect(paused.state).toBe("down");
    expect(paused.reason).toBe(kAutoRepairPauseCopy.downReason(pause));
    expect(paused.reason).toContain("Automatic repair is paused — cause state_schema_too_new on OpenClaw 2026.7.1-2");
    expect(paused.reason).toContain("forced Repair");
    expect(paused.actions.map((a) => a.id)).toEqual(["retry", "repair", "view_logs"]);
    const suspected = reduce(downInputs({ autoRepairPaused: { ...pause, corroborated: false } }));
    expect(suspected.reason).toContain("suspected cause state_schema_too_new");
    // The route copy never renders an enum bare.
    expect(kAutoRepairPauseCopy.repairRefusal).toContain("force: true");
    expect(kAutoRepairPauseCopy.hint).toContain("alphaclaw diagnose");
  });

  it("an exhausted Doctor budget reads `down` with the F015 copy; the pause outranks it; below the cap the legacy copy stands", () => {
    const exhausted = reduce(downInputs({ lifecycle: "crash_loop", repairAttempts: 2, repairAttemptLimit: 2 }));
    expect(exhausted.state).toBe("down");
    expect(exhausted.reason).toBe(
      kRepairAttemptsExhaustedCopy.downReason({ repairAttempts: 2, repairAttemptLimit: 2 }),
    );
    expect(exhausted.reason).toContain("Doctor repair failed 2/2 times");
    expect(exhausted.reason).toContain("crash relaunches continue with backoff");
    const both = reduce(
      downInputs({
        repairAttempts: 2,
        repairAttemptLimit: 2,
        autoRepairPaused: { cause: "legacy_exec_approvals", installedVersion: "2026.9.2", corroborated: true },
      }),
    );
    expect(both.reason).toContain("Automatic repair is paused");
    expect(reduce(downInputs({ lifecycle: "crash_loop", repairAttempts: 1 })).reason).toBe(
      "Crashed repeatedly — automatic restarts are paused.",
    );
    expect(reduce(downInputs({ lifecycle: "stopped", repairAttempts: 1 })).reason).toBe(
      "The gateway is not running.",
    );
    // Without a pause a bare "crashed" is still the imminent relaunch (`starting`).
    expect(reduce(downInputs({ repairAttempts: 1 })).state).toBe("starting");
  });
});
