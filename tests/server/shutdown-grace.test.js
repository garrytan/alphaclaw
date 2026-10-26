// Shutdown budget (ALPH-45): ALPHACLAW_SHUTDOWN_GRACE_SECONDS, read at
// module load, default 25 s, clamped 10..300, deployment env only.
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

const kConstantsPath = require.resolve("../../lib/server/constants");
const loadWith = (value) => {
  delete require.cache[kConstantsPath];
  if (value === undefined) vi.stubEnv("ALPHACLAW_SHUTDOWN_GRACE_SECONDS", undefined);
  else vi.stubEnv("ALPHACLAW_SHUTDOWN_GRACE_SECONDS", value);
  return require("../../lib/server/constants");
};

describe("shutdown budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete require.cache[kConstantsPath];
  });

  it("defaults to 25 s, a few seconds inside Render's default 30 s shutdown delay", () => {
    expect(loadWith(undefined).kShutdownGraceMs).toBe(25_000);
  });

  it("takes whole seconds inside 10..300 as given", () => {
    expect(loadWith("10").kShutdownGraceMs).toBe(10_000);
    expect(loadWith("115").kShutdownGraceMs).toBe(115_000);
    expect(loadWith("300").kShutdownGraceMs).toBe(300_000);
  });

  it("clamps out-of-range values and falls back on junk, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadWith("3").kShutdownGraceMs).toBe(10_000);
    expect(loadWith("900").kShutdownGraceMs).toBe(300_000);
    expect(loadWith("thirty").kShutdownGraceMs).toBe(25_000);
    const lines = warn.mock.calls.map(([line]) => line).filter((line) => line.includes("ALPHACLAW_SHUTDOWN_GRACE_SECONDS"));
    expect(lines).toEqual([
      "[alphaclaw] ALPHACLAW_SHUTDOWN_GRACE_SECONDS=3 clamped to 10s (valid range 10-300)",
      "[alphaclaw] ALPHACLAW_SHUTDOWN_GRACE_SECONDS=900 clamped to 300s (valid range 10-300)",
      "[alphaclaw] ALPHACLAW_SHUTDOWN_GRACE_SECONDS=thirty not a positive integer — falling back to 25s (valid range 10-300)",
    ]);
  });

  it("is honored from the deployment environment only, never from .env", () => {
    expect(kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_SHUTDOWN_GRACE_SECONDS");
  });
});
