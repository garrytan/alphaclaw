const { reduceGatewayState } = require("../../lib/server/gateway-state");

const kNow = 1_800_000_000_000;
const healthy = { lifecycle: "running", health: "healthy", safeMode: false, suppressedChannels: [], crashCountInWindow: 0, gatewayPid: 123 };
const inputs = (overrides = {}) => ({
  configExists: true,
  tcp: { running: true, observedAt: kNow },
  watchdog: healthy,
  operation: null,
  bootPhase: { phase: "ready", error: null },
  now: kNow,
  ...overrides,
});
const boot = (stage, stageLabel, headline = "Upgrading OpenClaw") => ({ active: true, kind: "upgrading_openclaw", headline, stage, stageLabel });

describe("gateway-state boot overlay (one rule)", () => {
  it("booting/starting: the boot kind is the headline and the stage is the reason; actions untouched", () => {
    const base = inputs({ bootPhase: { phase: "starting_gateway", error: null }, tcp: { running: false, observedAt: kNow } });
    const plain = reduceGatewayState(base);
    const covered = reduceGatewayState({ ...base, boot: boot("upgrading", "Upgrading OpenClaw data") });
    expect(plain.state).toBe("booting");
    expect(covered).toMatchObject({ state: "booting", label: "Upgrading OpenClaw", reason: "Upgrading OpenClaw data.", bootCovered: true });
    expect(covered.actions).toEqual(plain.actions);

    const starting = inputs({ watchdog: { ...healthy, health: "unknown" } });
    expect(reduceGatewayState({ ...starting, boot: boot("gateway", "Starting the gateway", "AlphaClaw is restarting") }))
      .toMatchObject({ state: "starting", label: "AlphaClaw is restarting", reason: "Starting the gateway." });
  });

  it("running while channels connect: headline stays Running, the reason is Connecting channels", () => {
    const base = inputs({ watchdog: { ...healthy, readiness: "not_ready", readinessStatus: "starting" } });
    expect(reduceGatewayState(base).reason).toBe("Up — channels still starting.");
    const covered = reduceGatewayState({ ...base, boot: boot("channels", "Connecting channels") });
    expect(covered).toMatchObject({ state: "running", label: "Running", reason: "Connecting channels.", bootCovered: true });
  });

  it.each([
    ["config_error", { watchdog: { ...healthy, lifecycle: "configuration_error", health: "unhealthy" } }],
    ["down", { tcp: { running: false, observedAt: kNow } }],
    ["degraded", { watchdog: { ...healthy, health: "degraded" } }],
    ["flapping", { watchdog: { ...healthy, crashCountInWindow: 2 } }],
    ["boot_failed", { bootPhase: { phase: "failed", error: "x" }, tcp: { running: false, observedAt: kNow } }],
  ])("leaves the authoritative %s state untouched", (state, overrides) => {
    const plain = reduceGatewayState(inputs(overrides));
    const covered = reduceGatewayState({ ...inputs(overrides), boot: boot("gateway", "Starting the gateway") });
    expect(plain.state).toBe(state);
    expect(covered).toEqual({ ...plain, bootCovered: false });
  });

  it("a user operation (restart, PR 2's upgrade retry) owns the card even in starting", () => {
    const base = inputs({ tcp: { running: false, observedAt: kNow }, operation: { kind: "gateway_restart", label: "Restarting gateway", startedAt: kNow - 1_000 } });
    const covered = reduceGatewayState({ ...base, boot: boot("gateway", "Starting the gateway") });
    expect(covered.state).toBe("starting");
    expect(covered.bootCovered).toBe(false);
    expect(covered.label).toBe(reduceGatewayState(base).label);
  });

  it("no overlay once the timeline is terminal (projectBootOverlay returns null)", () => {
    expect(reduceGatewayState({ ...inputs(), boot: null })).toMatchObject({ state: "running", bootCovered: false });
  });
});
