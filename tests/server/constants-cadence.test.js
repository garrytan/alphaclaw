const fs = require("fs");
const os = require("os");
const path = require("path");

const numberModulePath = "../../lib/server/utils/number";
const constantsModulePath = "../../lib/server/constants";
const envModulePath = "../../lib/server/env";
const deploymentOnlyModulePath = "../../lib/server/deployment-only-env";

const kCadenceKeys = [
  "WATCHDOG_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL",
];

// Constants are read at module load, so every case re-requires a fresh copy
// against the process.env it just arranged (same pattern as env.test.js:
// vi.resetModules() alone leaves Node's own require.cache in place).
const purgeModuleCache = () => {
  vi.resetModules();
  for (const modulePath of [constantsModulePath, envModulePath]) {
    delete require.cache[require.resolve(modulePath)];
  }
};

const loadConstants = () => {
  purgeModuleCache();
  return require(constantsModulePath);
};

const watchdogWarnLines = (warnSpy) =>
  warnSpy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("WATCHDOG_"));

// Save the cadence knobs, clear them for the case, and hand back a restore.
const snapshotCadenceEnv = () => {
  const saved = Object.fromEntries(kCadenceKeys.map((k) => [k, process.env[k]]));
  for (const key of kCadenceKeys) delete process.env[key];
  return () => {
    for (const key of kCadenceKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
};

describe("readClampedEnvSeconds", () => {
  const kName = "ALPHACLAW_TEST_CLAMPED_SECONDS";
  const kOpts = { fallback: 30, min: 5, max: 120 };
  let readClampedEnvSeconds;
  let warnSpy;

  beforeEach(() => {
    ({ readClampedEnvSeconds } = require(numberModulePath));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env[kName];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[kName];
  });

  it("returns the fallback without warning when unset", () => {
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats an empty string as unset (fallback, no warning)", () => {
    process.env[kName] = "";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only value as unset (fallback, no warning)", () => {
    process.env[kName] = "   ";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(30);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns an in-range value in SECONDS without warning", () => {
    process.env[kName] = "45";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(45);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("clamps a value below the floor and warns once", () => {
    process.env[kName] = "1";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=1 clamped to 5s (valid range 5-120)`,
    );
  });

  it("clamps a value above the ceiling and warns once", () => {
    process.env[kName] = "999";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(120);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=999 clamped to 120s (valid range 5-120)`,
    );
  });

  it.each(["abc", "0", "-5"])(
    "falls back on junk %j and warns with the junk message",
    (raw) => {
      process.env[kName] = raw;
      expect(readClampedEnvSeconds(kName, kOpts)).toBe(30);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        `[alphaclaw] ${kName}=${raw} not a positive integer — falling back to 30s (valid range 5-120)`,
      );
    },
  );

  it("normalizes a float to its integer part and says so (not 'falling back')", () => {
    process.env[kName] = "7.5";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(7);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=7.5 normalized to 7s (valid range 5-120)`,
    );
  });

  it("does not call surrounding whitespace a normalization", () => {
    process.env[kName] = " 12 ";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(12);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("reports a clamp over a normalization when both apply", () => {
    process.env[kName] = "500.9";
    expect(readClampedEnvSeconds(kName, kOpts)).toBe(120);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=500.9 clamped to 120s (valid range 5-120)`,
    );
  });
});

describe("watchdog cadence constants", () => {
  let restoreCadenceEnv;
  let warnSpy;

  beforeEach(() => {
    restoreCadenceEnv = snapshotCadenceEnv();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreCadenceEnv();
    purgeModuleCache();
  });

  it("defaults to 120s / 5s / 30s (stored as ms) with no warnings", () => {
    const constants = loadConstants();
    expect(constants.kWatchdogCheckIntervalMs).toBe(120_000);
    expect(constants.kWatchdogDegradedCheckIntervalMs).toBe(5_000);
    expect(constants.kWatchdogDegradedCheckMaxIntervalMs).toBe(30_000);
    expect(watchdogWarnLines(warnSpy)).toEqual([]);
  });

  it("applies in-range env overrides multiplied to ms", () => {
    process.env.WATCHDOG_CHECK_INTERVAL = "300";
    process.env.WATCHDOG_DEGRADED_CHECK_INTERVAL = "10";
    process.env.WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL = "90";
    const constants = loadConstants();
    expect(constants.kWatchdogCheckIntervalMs).toBe(300_000);
    expect(constants.kWatchdogDegradedCheckIntervalMs).toBe(10_000);
    expect(constants.kWatchdogDegradedCheckMaxIntervalMs).toBe(90_000);
    expect(watchdogWarnLines(warnSpy)).toEqual([]);
  });

  it("clamps each knob to its documented range", () => {
    process.env.WATCHDOG_CHECK_INTERVAL = "1";
    process.env.WATCHDOG_DEGRADED_CHECK_INTERVAL = "999";
    process.env.WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL = "1";
    const constants = loadConstants();
    expect(constants.kWatchdogCheckIntervalMs).toBe(30_000);
    expect(constants.kWatchdogDegradedCheckIntervalMs).toBe(120_000);
    // The cap floor (5s) is then raised to the clamped initial (120s).
    expect(constants.kWatchdogDegradedCheckMaxIntervalMs).toBe(120_000);
    // Order-independent: the four warnings are emitted by separate reads and
    // the test cares that each is present, not the module's evaluation order.
    const warnLines = watchdogWarnLines(warnSpy);
    expect(warnLines).toHaveLength(4);
    expect(warnLines).toEqual(
      expect.arrayContaining([
        "[alphaclaw] WATCHDOG_CHECK_INTERVAL=1 clamped to 30s (valid range 30-3600)",
        "[alphaclaw] WATCHDOG_DEGRADED_CHECK_INTERVAL=999 clamped to 120s (valid range 2-120)",
        "[alphaclaw] WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=1 clamped to 5s (valid range 5-120)",
        // The operator set the cap explicitly, so no "(default)" marker.
        "[alphaclaw] WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=5 raised to 120s to stay >= WATCHDOG_DEGRADED_CHECK_INTERVAL=120",
      ]),
    );
  });

  it("raises the cap to the initial interval when the initial is larger (flat loop)", () => {
    process.env.WATCHDOG_DEGRADED_CHECK_INTERVAL = "60";
    const constants = loadConstants();
    expect(constants.kWatchdogDegradedCheckIntervalMs).toBe(60_000);
    expect(constants.kWatchdogDegradedCheckMaxIntervalMs).toBe(60_000);
    // Only the initial was set: the warning must not read as if the operator
    // chose the cap being raised.
    expect(watchdogWarnLines(warnSpy)).toEqual([
      "[alphaclaw] WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=30 (default) raised to 60s to stay >= WATCHDOG_DEGRADED_CHECK_INTERVAL=60",
    ]);
  });

  it("treats a whitespace-only cap as unset in the '(default)' marker too", () => {
    process.env.WATCHDOG_DEGRADED_CHECK_INTERVAL = "60";
    process.env.WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL = "   ";
    const constants = loadConstants();
    expect(constants.kWatchdogDegradedCheckIntervalMs).toBe(60_000);
    expect(constants.kWatchdogDegradedCheckMaxIntervalMs).toBe(60_000);
    // readClampedEnvSeconds already reads "   " as unset (fallback 30, no
    // clamp warning); the raise line must agree and mark the cap "(default)".
    const warnLines = watchdogWarnLines(warnSpy);
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain(" (default)");
    expect(warnLines[0]).toBe(
      "[alphaclaw] WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=30 (default) raised to 60s to stay >= WATCHDOG_DEGRADED_CHECK_INTERVAL=60",
    );
  });
});

describe("watchdog cadence knobs are deployment-only", () => {
  let tmpDir;
  let previousRootDir;
  let restoreCadenceEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cadence-"));
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
    restoreCadenceEnv = snapshotCadenceEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    purgeModuleCache();
    if (previousRootDir === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
    else process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    restoreCadenceEnv();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists all three keys in kDeploymentOnlyEnvKeys", () => {
    const { kDeploymentOnlyEnvKeys } = require(deploymentOnlyModulePath);
    for (const key of kCadenceKeys) {
      expect(kDeploymentOnlyEnvKeys).toContain(key);
    }
  });

  it("reloadEnv never applies them from the agent-writable .env", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      [
        "OPENAI_API_KEY=ok",
        "WATCHDOG_CHECK_INTERVAL=30",
        "WATCHDOG_DEGRADED_CHECK_INTERVAL=2",
        "WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=5",
      ].join("\n"),
    );
    purgeModuleCache();
    process.env.ALPHACLAW_ROOT_DIR = tmpDir;
    const env = require(envModulePath);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    try {
      env.reloadEnv();
      expect(process.env.OPENAI_API_KEY).toBe("ok");
      for (const key of kCadenceKeys) {
        expect(process.env[key]).toBeUndefined();
      }
    } finally {
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  });
});
