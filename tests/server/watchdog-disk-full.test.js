const { createDiskFullHold } = require("../../lib/server/watchdog-disk-full");
const { describeDiskFull, measureFullestDisk } = require("../../lib/server/disk-full");
const { classifyGatewayCrash } = require("../../lib/server/gateway-crash-cause");
const { summarizeDoctorResult } = require("../../lib/server/doctor-outcome");
const { describeDoctorFailure } = require("../../lib/server/doctor-plain-language");
const { describeRecovery } = require("../../lib/server/restart-failure-copy");
const { createWatchdog } = require("../../lib/server/watchdog");

const kMb = 1024 * 1024;
const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

describe("disk-full classification", () => {
  it.each([
    ["Error: ENOSPC: no space left on device, write", "the disk ran out of space (ENOSPC)"],
    ["SqliteError: database or disk is full (no space left on device)", "the disk ran out of space (ENOSPC)"],
    ["Error: EDQUOT: disk quota exceeded, open '/data/.openclaw/state/snapshot.tmp'", "a disk quota was exceeded (EDQUOT)"],
  ])("gateway output %j is a disk_full exit", (line, detail) => {
    expect(classifyGatewayCrash({ code: 1, stderrTail: ["[gateway] writing state snapshot", line] })).toMatchObject({
      cause: "disk_full",
      detail,
      matchedLine: line,
    });
  });

  it("a version-family refusal still outranks a full disk", () => {
    expect(
      classifyGatewayCrash({
        code: 1,
        stderrTail: [
          "Error: ENOSPC: no space left on device, write",
          "OpenClaw state database /data/.openclaw/state/openclaw.sqlite uses newer schema version 30; this build supports 25.",
        ],
      }).cause,
    ).toBe("state_schema_too_new");
  });

  it.each([
    ["Error: ENOSPC: no space left on device, write"],
    ["Error: EDQUOT: disk quota exceeded, write"],
  ])("a Doctor run that printed %j failed with disk_full", (stdout) => {
    const summary = summarizeDoctorResult({ ok: false, code: 1, stdout: stdout + "\n" });
    expect(summary).toMatchObject({ status: "failed", class: "transient", reason: "disk_full" });
    expect(describeDoctorFailure(summary)).toBe("The data volume ran out of space during the upgrade.");
  });
});

describe("disk-full measurement and copy", () => {
  it("names the fullest disk the gateway writes to, measured at the nearest existing directory", () => {
    const statfs = vi.fn((target) =>
      target === "/data/.openclaw" ? { bavail: 5, bsize: kMb } : { bavail: 900, bsize: kMb },
    );
    const fsModule = { statSync: (target) => ({ isDirectory: () => target !== "/tmp/missing" }) };
    expect(measureFullestDisk(["/data/.openclaw", "/tmp/missing/child"], { statfs, fsModule })).toEqual({
      dir: "/data/.openclaw",
      freeBytes: 5 * kMb,
    });
    expect(statfs).toHaveBeenCalledWith("/tmp/missing/child");
  });

  it("is null when nothing can be measured", () => {
    expect(
      measureFullestDisk(["/data"], {
        statfs: () => {
          throw new Error("ENOSYS");
        },
        fsModule: { statSync: () => ({ isDirectory: () => true }) },
      }),
    ).toBeNull();
  });

  it("speaks one sentence for the incident, the notices and the restart card", () => {
    const sentence = "The disk holding /data/.openclaw is full (12 MB free); the gateway can't start until space is freed.";
    expect(describeDiskFull({ dir: "/data/.openclaw", freeBytes: 12.7 * kMb })).toBe(sentence);
    expect(
      describeRecovery({ ok: false, reason: "disk_full", diskFull: { dir: "/data/.openclaw", freeBytes: 12 * kMb } }),
    ).toEqual({
      status: "disk_full",
      reason: "disk_full",
      text: sentence + " AlphaClaw starts it again on its own once space is freed.",
    });
    expect(describeRecovery({ ok: false, reason: "disk_full" }).text).toBe(
      "The disk is full; AlphaClaw starts the gateway again on its own once space is freed.",
    );
  });
});

describe("createDiskFullHold", () => {
  afterEach(() => vi.useRealTimers());

  const createHold = (disk) => {
    const onRecovered = vi.fn();
    const onRetry = vi.fn();
    const hold = createDiskFullHold({
      measure: () => (disk.freeBytes == null ? null : { dir: "/data", freeBytes: disk.freeBytes }),
      entryFloorBytes: 1024 * kMb,
      resumeMarginBytes: 256 * kMb,
      pollMs: 15_000,
      retryDelaysMs: [60_000, 120_000, 300_000],
      onRecovered,
      onRetry,
    });
    return { hold, onRecovered, onRetry };
  };

  it("does not hold when free space cannot be measured or is above the floor", () => {
    const disk = { freeBytes: null };
    const { hold } = createHold(disk);
    expect(hold.enter()).toBeNull();
    disk.freeBytes = 2048 * kMb;
    expect(hold.enter()).toBeNull();
    expect(hold.active()).toBe(false);
  });

  it("retries on a growing backoff while the disk stays full, then resumes once the margin is free", async () => {
    vi.useFakeTimers();
    const disk = { freeBytes: 10 * kMb };
    const { hold, onRecovered, onRetry } = createHold(disk);
    expect(hold.enter()).toMatchObject({ entered: true, resumeAtFreeBytes: 266 * kMb, retries: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The retry died of the same full disk: the next delay is longer.
    expect(hold.enter()).toMatchObject({ entered: false, retries: 1 });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    // Freed, but not past the margin: still held.
    disk.freeBytes = 200 * kMb;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(hold.describe()).toMatchObject({ freeBytes: 200 * kMb });
    disk.freeBytes = 300 * kMb;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ dir: "/data", freeBytes: 300 * kMb }));
    expect(hold.active()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("clear() ends the hold and its timers", async () => {
    vi.useFakeTimers();
    const { hold, onRecovered, onRetry } = createHold({ freeBytes: 0 });
    hold.enter();
    expect(hold.clear()).toMatchObject({ dir: "/data" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(hold.describe()).toBeNull();
  });
});

// The box's sequence: the gateway is down, the automatic repair runs Doctor,
// and Doctor fails on ENOSPC. Before the hold, two such runs spent the budget
// and every later check logged repair_attempts_exhausted for good.
describe("watchdog disk-full hold", () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    if (kOriginalNotificationsDisabled == null) delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    else process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    if (kOriginalFetch == null) delete global.fetch;
    else global.fetch = kOriginalFetch;
    vi.useRealTimers();
  });

  const createHarness = ({ disk, autoRepair = true }) => {
    process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    global.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const insertWatchdogEvent = vi.fn();
    const notifier = { notify: vi.fn(async () => ({ ok: true })) };
    const clawCmd = vi.fn(async (command) =>
      command === "doctor --fix --yes"
        ? { ok: false, code: 1, stdout: "Error: ENOSPC: no space left on device, write\n" }
        : { ok: true, stdout: JSON.stringify({ ok: true }) },
    );
    const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
    const watchdog = createWatchdog({
      clawCmd,
      launchGatewayProcess,
      insertWatchdogEvent,
      notifier,
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "https://setup.example.com",
      resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
      pidAlive: () => false,
      readProcStartTicks: () => null,
      resolvePidVerdict: () => "gone",
      classifyGatewayCrash,
      measureDiskFree: () => ({ dir: "/data/.openclaw", freeBytes: disk.freeBytes }),
    });
    const rows = () => insertWatchdogEvent.mock.calls.map(([row]) => row);
    const notices = () => notifier.notify.mock.calls.map(([message]) => String(message));
    return { watchdog, clawCmd, launchGatewayProcess, rows, notices };
  };

  it("a Doctor run that fails on ENOSPC holds instead of spending the budget, and space freed resumes with a fresh one", async () => {
    vi.useFakeTimers();
    const disk = { freeBytes: 3 * kMb };
    const h = createHarness({ disk });
    const first = await h.watchdog.runRepair({ source: "restart_failure_recheck", correlationId: "c-1" });
    expect(first).toMatchObject({ ok: false, reason: "disk_full" });
    expect(h.watchdog.getStatus()).toMatchObject({
      repairAttempts: 1,
      diskFull: { dir: "/data/.openclaw", freeBytes: 3 * kMb, resumeAtFreeBytes: 259 * kMb },
    });
    expect(h.notices().filter((text) => text.includes("The disk holding /data/.openclaw is full (3 MB free)"))).toHaveLength(1);

    // Every later automatic repair waits for the disk; none reaches Doctor.
    const second = await h.watchdog.runRepair({ source: "health_timer", correlationId: "c-2" });
    expect(second).toMatchObject({ ok: false, skipped: true, reason: "disk_full" });
    expect(h.watchdog.peekRepairAdmission()).toMatchObject({ ok: false, reason: "disk_full" });
    expect(h.clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes")).toHaveLength(1);
    expect(h.notices().some((text) => text.includes("Auto-repair attempts exhausted"))).toBe(false);

    disk.freeBytes = 600 * kMb;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.watchdog.getStatus()).toMatchObject({ diskFull: null, repairAttempts: 0 });
    expect(h.rows()).toContainEqual(
      expect.objectContaining({ eventType: "disk_full", source: "disk_space_recovered", status: "ok" }),
    );
    expect(h.launchGatewayProcess).toHaveBeenCalled();
    expect(h.watchdog.peekRepairAdmission()).not.toMatchObject({ reason: "disk_full" });
    h.watchdog.stop();
  });

  it("a crash with another recognised cause ends the hold and takes the ordinary crash ladder", async () => {
    vi.useFakeTimers();
    const h = createHarness({ disk: { freeBytes: 0 } });
    h.watchdog.onGatewayExit({ code: 1, stderrTail: ["Error: ENOSPC: no space left on device, write"] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.watchdog.getStatus().diskFull).not.toBeNull();
    // An exit that names nothing is the same outage.
    h.watchdog.onGatewayExit({ code: 1, stderrTail: [] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.watchdog.getStatus().diskFull).not.toBeNull();
    h.watchdog.onGatewayExit({ code: 1, stderrTail: ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.rows()).toContainEqual(expect.objectContaining({ eventType: "disk_full", source: "other_cause", status: "ok" }));
    // Three crashes in the window: the ordinary crash-loop protection runs.
    expect(h.rows()).toContainEqual(expect.objectContaining({ eventType: "crash_loop", details: expect.objectContaining({ cause: "oom" }) }));
    h.watchdog.stop();
  });

  it("with auto-repair off the hold still relaunches on freed space, and the refusal names the disk", async () => {
    vi.useFakeTimers();
    const disk = { freeBytes: 0 };
    const h = createHarness({ disk, autoRepair: false });
    h.watchdog.onGatewayExit({ code: 1, stderrTail: ["Error: ENOSPC: no space left on device, mkdtemp"] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.watchdog.peekRepairAdmission()).toMatchObject({ ok: false, reason: "disk_full", diskFull: { dir: "/data/.openclaw" } });
    const launches = h.launchGatewayProcess.mock.calls.length;
    disk.freeBytes = 600 * kMb;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.watchdog.getStatus().diskFull).toBeNull();
    expect(h.launchGatewayProcess.mock.calls.length).toBeGreaterThan(launches);
    expect(h.watchdog.peekRepairAdmission()).toMatchObject({ ok: false, reason: "auto_repair_disabled" });
    h.watchdog.stop();
  });

  it("an ENOSPC line with plenty of measured free space is an ordinary crash", async () => {
    vi.useFakeTimers();
    const h = createHarness({ disk: { freeBytes: 50 * 1024 * kMb } });
    h.watchdog.onGatewayExit({ code: 1, stderrTail: ["Error: ENOSPC: no space left on device, write"] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.watchdog.getStatus().diskFull).toBeNull();
    expect(h.rows().some((row) => row.eventType === "disk_full")).toBe(false);
    h.watchdog.stop();
  });
});
