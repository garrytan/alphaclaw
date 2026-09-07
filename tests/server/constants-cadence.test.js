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
// The sustained-failure gate is a count, not a cadence, but it is read the
// same way (module load, clamped, deployment-only) and guards the same loop.
const kRepairGateKey = "WATCHDOG_DEGRADED_REPAIR_THRESHOLD";
const kDeploymentOnlyWatchdogKeys = [...kCadenceKeys, kRepairGateKey];

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
  const saved = Object.fromEntries(
    kDeploymentOnlyWatchdogKeys.map((k) => [k, process.env[k]]),
  );
  for (const key of kDeploymentOnlyWatchdogKeys) delete process.env[key];
  return () => {
    for (const key of kDeploymentOnlyWatchdogKeys) {
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

describe("readClampedEnvCount", () => {
  const kName = "ALPHACLAW_TEST_CLAMPED_COUNT";
  const kOpts = { fallback: 3, min: 1, max: 20 };
  let readClampedEnvCount;
  let warnSpy;

  beforeEach(() => {
    ({ readClampedEnvCount } = require(numberModulePath));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env[kName];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[kName];
  });

  it("returns the fallback without warning when unset, empty, or whitespace-only", () => {
    expect(readClampedEnvCount(kName, kOpts)).toBe(3);
    process.env[kName] = "";
    expect(readClampedEnvCount(kName, kOpts)).toBe(3);
    process.env[kName] = "   ";
    expect(readClampedEnvCount(kName, kOpts)).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns an in-range count without warning", () => {
    process.env[kName] = "5";
    expect(readClampedEnvCount(kName, kOpts)).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("clamps to the ceiling and warns WITHOUT a unit suffix", () => {
    process.env[kName] = "25";
    expect(readClampedEnvCount(kName, kOpts)).toBe(20);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // A bare count: "20", never "20s".
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=25 clamped to 20 (valid range 1-20)`,
    );
  });

  it.each(["abc", "0", "-5"])(
    "falls back on junk %j with the unit-less junk message",
    (raw) => {
      process.env[kName] = raw;
      expect(readClampedEnvCount(kName, kOpts)).toBe(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        `[alphaclaw] ${kName}=${raw} not a positive integer — falling back to 3 (valid range 1-20)`,
      );
    },
  );

  it("normalizes a float to its integer part with the unit-less message", () => {
    process.env[kName] = "2.9";
    expect(readClampedEnvCount(kName, kOpts)).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `[alphaclaw] ${kName}=2.9 normalized to 2 (valid range 1-20)`,
    );
  });

  it("does not call surrounding whitespace a normalization", () => {
    process.env[kName] = " 4 ";
    expect(readClampedEnvCount(kName, kOpts)).toBe(4);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is the same reader as readClampedEnvSeconds apart from the unit suffix", () => {
    const { readClampedEnvNumber, readClampedEnvSeconds } = require(numberModulePath);
    process.env[kName] = "25";
    readClampedEnvSeconds(kName, kOpts);
    readClampedEnvNumber(kName, { ...kOpts, unit: "" });
    expect(warnSpy.mock.calls.map(([line]) => line)).toEqual([
      `[alphaclaw] ${kName}=25 clamped to 20s (valid range 1-20)`,
      `[alphaclaw] ${kName}=25 clamped to 20 (valid range 1-20)`,
    ]);
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

describe("kWatchdogDegradedRepairThreshold", () => {
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

  it("defaults to 3 consecutive failures with no warning", () => {
    const constants = loadConstants();
    expect(constants.kWatchdogDegradedRepairThreshold).toBe(3);
    expect(watchdogWarnLines(warnSpy)).toEqual([]);
  });

  it("honors an in-range override as a bare count (no seconds multiply)", () => {
    process.env[kRepairGateKey] = "5";
    expect(loadConstants().kWatchdogDegradedRepairThreshold).toBe(5);
    expect(watchdogWarnLines(warnSpy)).toEqual([]);
  });

  it("=1 is the kill switch: repair on the first steady-state failure, silently", () => {
    process.env[kRepairGateKey] = "1";
    expect(loadConstants().kWatchdogDegradedRepairThreshold).toBe(1);
    expect(watchdogWarnLines(warnSpy)).toEqual([]);
  });

  it("clamps to 1..20 and warns without a unit suffix", () => {
    process.env[kRepairGateKey] = "0";
    expect(loadConstants().kWatchdogDegradedRepairThreshold).toBe(3);
    expect(watchdogWarnLines(warnSpy)).toEqual([
      "[alphaclaw] WATCHDOG_DEGRADED_REPAIR_THRESHOLD=0 not a positive integer — falling back to 3 (valid range 1-20)",
    ]);
    warnSpy.mockClear();
    process.env[kRepairGateKey] = "99";
    expect(loadConstants().kWatchdogDegradedRepairThreshold).toBe(20);
    expect(watchdogWarnLines(warnSpy)).toEqual([
      "[alphaclaw] WATCHDOG_DEGRADED_REPAIR_THRESHOLD=99 clamped to 20 (valid range 1-20)",
    ]);
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

  it("lists the three cadence keys AND the repair-threshold key in kDeploymentOnlyEnvKeys", () => {
    const { kDeploymentOnlyEnvKeys } = require(deploymentOnlyModulePath);
    for (const key of kDeploymentOnlyWatchdogKeys) {
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
        // An agent raising the repair gate to the ceiling would keep its own
        // wedged gateway from ever being repaired.
        "WATCHDOG_DEGRADED_REPAIR_THRESHOLD=20",
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
      for (const key of kDeploymentOnlyWatchdogKeys) {
        expect(process.env[key]).toBeUndefined();
      }
    } finally {
      if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  });
});

// Issue #79 (f) / Codex 16: the pre-update backup step runs on ONE clock (the
// phase envelope), so each path through the step must fit it in the worst
// case. These are relations between constants, not values — a future change
// to any term must keep both true or lower the term it raised.
describe("backup envelope relations (issue #79 (f), Codex 16)", () => {
  const ladderModulePath = "../../lib/server/openclaw-backup-ladder";
  let constants;
  let ladder;

  beforeEach(() => {
    // Fresh copies: other suites purge the constants cache, and the ladder
    // module must read the same constants instance this suite asserts on.
    constants = loadConstants();
    delete require.cache[require.resolve(ladderModulePath)];
    ladder = require(ladderModulePath);
  });

  afterEach(() => {
    delete require.cache[require.resolve(ladderModulePath)];
    purgeModuleCache();
  });

  it("quiesced path: diagnosis + lock wait + quiesce + offline copy + usable check + relaunch ready + settle ≤ the phase envelope", () => {
    const {
      kOpenclawBackupDiagnosisBudgetMs,
      kOpenclawBackupQuiesceLockTimeoutMs,
      kOpenclawBackupQuiesceTimeoutMs,
      kOpenclawBackupOfflineCopyBudgetMs,
      kOpenclawBackupUsableCheckReserveMs,
      kOpenclawBackupPostQuiesceReadyTimeoutMs,
      kOpenclawBackupPostQuiesceSettleMs,
      kOpenclawBackupPhaseEnvelopeMs,
    } = constants;
    const totalMs =
      kOpenclawBackupDiagnosisBudgetMs +
      kOpenclawBackupQuiesceLockTimeoutMs +
      kOpenclawBackupQuiesceTimeoutMs +
      kOpenclawBackupOfflineCopyBudgetMs +
      kOpenclawBackupUsableCheckReserveMs +
      kOpenclawBackupPostQuiesceReadyTimeoutMs +
      kOpenclawBackupPostQuiesceSettleMs;
    expect(totalMs).toBeLessThanOrEqual(kOpenclawBackupPhaseEnvelopeMs);
    // Documented values: 2 + 1.5 + 7 + 8 + 1 + 1/3 + 1/6 minutes = 20 ≤ 25.
    expect(kOpenclawBackupDiagnosisBudgetMs).toBe(2 * 60_000);
    expect(totalMs).toBe(20 * 60_000);
    expect(kOpenclawBackupPhaseEnvelopeMs).toBe(25 * 60_000);
  });

  it("live ladder: liveAttempts × the CLI ceiling + the usable-check reserve ≤ the phase envelope — which is why the cap is 2, not 3", () => {
    const {
      kOpenclawBackupLiveAttempts,
      kOpenclawBackupTimeoutMs,
      kOpenclawBackupUsableCheckReserveMs,
      kOpenclawBackupPhaseEnvelopeMs,
    } = constants;
    expect(kOpenclawBackupLiveAttempts).toBe(2);
    expect(
      kOpenclawBackupLiveAttempts * kOpenclawBackupTimeoutMs + kOpenclawBackupUsableCheckReserveMs,
    ).toBeLessThanOrEqual(kOpenclawBackupPhaseEnvelopeMs);
    // The former cap of 3 never fit (31 min > 25): its third attempt existed
    // only on paper — the envelope refused it as window_exhausted.
    expect(3 * kOpenclawBackupTimeoutMs + kOpenclawBackupUsableCheckReserveMs).toBeGreaterThan(
      kOpenclawBackupPhaseEnvelopeMs,
    );
  });

  it("backupBudgetPins evaluates both relations over the default budget table and names every term", () => {
    const pins = ladder.backupBudgetPins();
    expect(Object.isFrozen(pins)).toBe(true);
    expect(pins.map((pin) => pin.name)).toEqual([
      "quiesced_path_fits_envelope",
      "live_ladder_fits_envelope",
    ]);
    for (const pin of pins) {
      expect(pin.ok).toBe(true);
      expect(pin.missing).toEqual([]);
      expect(pin.envelopeMs).toBe(constants.kOpenclawBackupPhaseEnvelopeMs);
      expect(pin.totalMs).toBeLessThanOrEqual(pin.envelopeMs);
      expect(pin.relation).toContain("≤ phaseEnvelopeMs");
    }
    const [quiesced, live] = pins;
    expect(quiesced.totalMs).toBe(20 * 60_000);
    expect(quiesced.terms).toEqual({
      diagnosisBudgetMs: constants.kOpenclawBackupDiagnosisBudgetMs,
      quiesceLockTimeoutMs: constants.kOpenclawBackupQuiesceLockTimeoutMs,
      quiesceTimeoutMs: constants.kOpenclawBackupQuiesceTimeoutMs,
      offlineCopyBudgetMs: constants.kOpenclawBackupOfflineCopyBudgetMs,
      usableCheckReserveMs: constants.kOpenclawBackupUsableCheckReserveMs,
      postQuiesceReadyTimeoutMs: constants.kOpenclawBackupPostQuiesceReadyTimeoutMs,
      postQuiesceSettleMs: constants.kOpenclawBackupPostQuiesceSettleMs,
    });
    expect(live.totalMs).toBe(21 * 60_000);
    expect(live.terms).toEqual({
      liveAttempts: 2,
      cliTimeoutMs: constants.kOpenclawBackupTimeoutMs,
      usableCheckReserveMs: constants.kOpenclawBackupUsableCheckReserveMs,
    });
    // The default argument IS the shared default table.
    expect(ladder.backupBudgetPins(ladder.kDefaultBackupBudget)).toEqual(pins);
  });

  it("backupBudgetPins fails closed on a tuning override that breaks a relation or drops a term", () => {
    const base = ladder.kDefaultBackupBudget;
    const [, liveThree] = ladder.backupBudgetPins({ ...base, liveAttempts: 3 });
    expect(liveThree.ok).toBe(false);
    expect(liveThree.totalMs).toBe(31 * 60_000);
    const [quiescedFat] = ladder.backupBudgetPins({ ...base, offlineCopyBudgetMs: 14 * 60_000 });
    expect(quiescedFat.ok).toBe(false);
    expect(quiescedFat.totalMs).toBe(26 * 60_000);
    // A raised envelope makes the same override fit again — the relation is
    // between the terms, not a fixed value.
    const [, liveThreeRoomy] = ladder.backupBudgetPins({
      ...base,
      liveAttempts: 3,
      phaseEnvelopeMs: 31 * 60_000,
    });
    expect(liveThreeRoomy.ok).toBe(true);
    // Missing terms cannot be shown to fit and are named.
    const [missingQuiesced, missingLive] = ladder.backupBudgetPins({ phaseEnvelopeMs: 1 });
    expect(missingQuiesced.ok).toBe(false);
    expect(missingQuiesced.totalMs).toBeNull();
    expect(missingQuiesced.missing).toEqual([
      "diagnosisBudgetMs",
      "quiesceLockTimeoutMs",
      "quiesceTimeoutMs",
      "offlineCopyBudgetMs",
      "usableCheckReserveMs",
      "postQuiesceReadyTimeoutMs",
      "postQuiesceSettleMs",
    ]);
    expect(missingLive.ok).toBe(false);
    expect(missingLive.missing).toEqual(["liveAttempts", "cliTimeoutMs", "usableCheckReserveMs"]);
    const [noEnvelope] = ladder.backupBudgetPins({ ...base, phaseEnvelopeMs: undefined });
    expect(noEnvelope.ok).toBe(false);
    expect(noEnvelope.envelopeMs).toBeNull();
    expect(noEnvelope.missing).toEqual(["phaseEnvelopeMs"]);
    for (const junk of [null, "budget", 42]) {
      expect(ladder.backupBudgetPins(junk).every((pin) => pin.ok === false)).toBe(true);
    }
    // `undefined` is "no table given" — the defaults, not junk.
    expect(ladder.backupBudgetPins(undefined)).toEqual(ladder.backupBudgetPins());
  });
});
