// Routine restart grace (ALPH-17 PR 5): ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS,
// default 180, clamped 30..300, deployment env only, read at module load.
const { gatewayStopAskBudgetMs } = require("../../lib/server/gateway");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

const kConstantsPath = require.resolve("../../lib/server/constants");
const loadGrace = (value) => {
  delete require.cache[kConstantsPath];
  if (value === undefined) vi.stubEnv("ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS", undefined);
  else vi.stubEnv("ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS", value);
  return require("../../lib/server/constants").kGatewayRoutineRestartGraceMs;
};

describe("routine restart grace", () => {
  let warn;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete require.cache[kConstantsPath];
  });

  it("defaults to 180 s and honours a value inside 30..300", () => {
    expect(loadGrace(undefined)).toBe(180_000);
    expect(loadGrace("240")).toBe(240_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps to 30..300 (OpenClaw's own deferral cap) and warns; junk falls back to 180 s and warns", () => {
    expect(loadGrace("5")).toBe(30_000);
    expect(loadGrace("900")).toBe(300_000);
    expect(loadGrace("three")).toBe(180_000);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "[alphaclaw] ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS=5 clamped to 30s (valid range 30-300)",
      "[alphaclaw] ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS=900 clamped to 300s (valid range 30-300)",
      "[alphaclaw] ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS=three not a positive integer — falling back to 180s (valid range 30-300)",
    ]);
  });

  it("is deployment env only, and the restart operation budget covers its ceiling", () => {
    expect(kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS");
    const constants = require("../../lib/server/constants");
    expect(constants.kGatewayRestartOperationBudgetMs).toBeGreaterThanOrEqual(
      constants.kGatewayRestartReadyTimeoutMs + 240_000 + gatewayStopAskBudgetMs(300_000) +
        constants.kGatewayStopTermGraceMs + constants.kGatewayStopKillGraceMs,
    );
  });
});
