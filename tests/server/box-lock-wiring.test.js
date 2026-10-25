// Where AlphaClaw takes the operator box lock (box-lock.js): restarts by
// class, the watchdog's repair and memory restart, crash relaunches (never),
// the Browse Sync and repair routes, the box lock status route, the snapshot
// sweep, the scheduled git sync and the cron.d keys that carry it there.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const express = require("express");
const request = require("supertest");

const boxLockModule = require("../../lib/server/box-lock");
const { BoxLockError, createBoxLock, resolveBoxLockConfig, setBoxLockForTests } = boxLockModule;

const kScript = path.join(__dirname, "..", "fixtures", "box-lock.sh");
const hasFlock = spawnSync("flock", ["--version"]).status === 0;
if (!hasFlock) console.warn("[box-lock-wiring.test] flock (util-linux) is not installed: the real-lock cases are skipped");
const kQuiet = { log() {}, warn() {}, error() {} };

const kTempDirs = [];
const kChildren = [];
afterEach(() => {
  setBoxLockForTests(null);
  vi.useRealTimers();
  while (kChildren.length) {
    try {
      kChildren.pop().kill("SIGKILL");
    } catch {}
  }
  while (kTempDirs.length) fs.rmSync(kTempDirs.pop(), { recursive: true, force: true });
});

const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  kTempDirs.push(dir);
  return dir;
};

// A real box lock in a scratch dir, installed as the process's lock.
const installRealBoxLock = ({ waitSeconds = 1 } = {}) => {
  const lockPath = path.join(tempDir("alphaclaw-box-wiring-"), "box.lock");
  const events = [];
  const boxLock = createBoxLock({
    config: resolveBoxLockConfig({ ALPHACLAW_BOX_LOCK_PATH: lockPath, ALPHACLAW_BOX_LOCK_WAIT_SECONDS: String(waitSeconds) }),
    recordEvent: (row) => events.push(row),
    logger: kQuiet,
  });
  setBoxLockForTests(boxLock);
  const readLog = () => {
    const logPath = lockPath.replace(/\.lock$/, ".log");
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n") : [];
  };
  return { lockPath, boxLock, events, readLog };
};

const holdAsOperator = async (lockPath, { seconds = 30 } = {}) => {
  const child = spawn("bash", [kScript, "run", "OPS-7", "db-migrate", "--", "sleep", String(seconds)], {
    env: { ...process.env, BOX_LOCK: lockPath, BOX_LOCK_BY: "ops-session" },
    stdio: "ignore",
  });
  kChildren.push(child);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const ownerPath = lockPath.replace(/\.lock$/, ".owner");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(fs.readFileSync(ownerPath, "utf8")).started_at) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, exited };
};

const operatorProbe = (lockPath) =>
  spawnSync("bash", [kScript, "run", "OPS-9", "probe", "--", "true"], { env: { ...process.env, BOX_LOCK: lockPath }, encoding: "utf8" });

describe("cold restart takes the box lock by restart class", () => {
  const gateway = require("../../lib/server/gateway");
  const holder = { owner: "OPS-7", step: "db-migrate", started_at: "2026-10-25T20:29:51Z", pid: 9, host: "box", by: "ops-session" };
  const refusingLock = () => {
    const boxLock = {
      enabled: true,
      config: { waitMs: 120_000 },
      withBoxLock: vi.fn(async (options) => {
        options.onWait?.({ holder, waitMs: options.waitMs });
        throw new BoxLockError("box_locked", "The box lock is held by OPS-7 (db-migrate), so AlphaClaw did not start the gateway restart after waiting 120s.", {
          holder, step: "gateway-restart", waitedMs: 120_000, hint: "Try again once the other operator's work is finished.",
        });
      }),
    };
    setBoxLockForTests(boxLock);
    return boxLock;
  };

  it("a routine restart waits (bounded by its deadline), streams a box_lock step naming the holder, and is refused before anything is stopped", async () => {
    const boxLock = refusingLock();
    const onStep = vi.fn();
    const reloadEnv = vi.fn();
    const error = await gateway.restartGateway(reloadEnv, { source: "api:restart", reason: "actor=human", opId: "op-routine", onStep, deadlineAt: Date.now() + 100_000 }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "box_locked", blocked: true, statusCode: 409, holder });
    const [options] = boxLock.withBoxLock.mock.calls[0];
    expect(options).toMatchObject({ step: "gateway-restart", by: "api:restart", opId: "op-routine", background: false });
    expect(options.waitMs).toBeGreaterThan(45_000);
    expect(options.waitMs).toBeLessThanOrEqual(50_000);
    expect(onStep.mock.calls.map(([step]) => step)).toEqual([
      { step: "box_lock", status: "running", detail: { owner: "OPS-7", holderStep: "db-migrate", since: "2026-10-25T20:29:51Z", waitSeconds: Math.round(options.waitMs / 1000) } },
      { step: "box_lock", status: "failed" },
    ]);
    // A channel or team change is routine too, and waits the configured time.
    await gateway.restartGateway(reloadEnv, { source: "channels:create" }).catch(() => {});
    expect(boxLock.withBoxLock.mock.calls[1][0]).toMatchObject({ waitMs: 120_000, background: false, by: "channels:create" });
  });

  it.each([["watchdog:memory_mitigation"], ["watchdog:repair_replace"], [null]])("a %s restart never waits for the box lock", async (source) => {
    const boxLock = refusingLock();
    await gateway.restartGateway(vi.fn(), { source }).catch(() => {});
    expect(boxLock.withBoxLock.mock.calls[0][0]).toMatchObject({ waitMs: 0, background: true, by: source || "alphaclaw" });
  });

  it("with the feature off the restart takes no lock and no wait", async () => {
    const boxLock = { enabled: false, config: null, withBoxLock: vi.fn(async (options, fn) => { throw new Error("stop here"); }) };
    setBoxLockForTests(boxLock);
    await gateway.restartGateway(vi.fn(), { source: "api:restart" }).catch(() => {});
    expect(boxLock.withBoxLock.mock.calls[0][0]).toMatchObject({ waitMs: 0 });
  });
});

describe.runIf(hasFlock)("watchdog repair and crash relaunch under an operator's hold", () => {
  const { classifyGatewayCrash } = require("../../lib/server/gateway-crash-cause");
  const { createWatchdog } = require("../../lib/server/watchdog");
  const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
  const kOriginalFetch = global.fetch;
  afterEach(() => {
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    global.fetch = kOriginalFetch;
  });

  const createHarness = ({ lockPath }) => {
    process.env.WATCHDOG_AUTO_REPAIR = "true";
    global.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const insertWatchdogEvent = vi.fn();
    const notifier = { notify: vi.fn(async () => ({ ok: true })) };
    let heldDuringDoctor = null;
    const clawCmd = vi.fn(async (command) => {
      if (command === "doctor --fix --yes") {
        heldDuringDoctor = operatorProbe(lockPath).status;
        return { ok: false, code: 1, stdout: "doctor failed\n" };
      }
      return { ok: true, stdout: JSON.stringify({ ok: true }) };
    });
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
      measureDiskFree: () => ({ dir: "/data/.openclaw", freeBytes: 50 * 1024 * 1024 * 1024 }),
    });
    const doctorRuns = () => clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes").length;
    const rows = () => insertWatchdogEvent.mock.calls.map(([row]) => row);
    return { watchdog, doctorRuns, rows, notifier, launchGatewayProcess, heldDuringDoctor: () => heldDuringDoctor };
  };

  it("an automatic repair is skipped without waiting or spending an attempt; the Repair button waits, then refuses naming the holder; once free, Doctor runs holding the lock", async () => {
    const lock = installRealBoxLock({ waitSeconds: 1 });
    const h = createHarness(lock);
    const operator = await holdAsOperator(lock.lockPath, { seconds: 3 });
    const startedAt = Date.now();
    const automatic = await h.watchdog.runRepair({ source: "health_timer", correlationId: "c-1" });
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(automatic).toMatchObject({ ok: false, skipped: true, reason: "box_locked", boxLock: { holder: { owner: "OPS-7", step: "db-migrate" } } });
    await h.watchdog.runRepair({ source: "health_timer", correlationId: "c-2" });
    expect(h.rows().filter((row) => row.eventType === "repair" && row.details?.reason === "box_locked")).toHaveLength(1);
    const manual = await h.watchdog.triggerRepair();
    expect(manual).toMatchObject({ skipped: true, reason: "box_locked", statusCode: 409, message: expect.stringContaining("did not start the repair (Doctor) after waiting 1s") });
    expect(h.doctorRuns()).toBe(0);
    expect(h.watchdog.getStatus()).toMatchObject({ repairAttempts: 0, operationInProgress: false });
    expect(operator.child.signalCode).toBeNull();
    expect(await operator.exited).toEqual({ code: 0, signal: null });

    const ran = await h.watchdog.runRepair({ source: "health_timer", correlationId: "c-3" });
    expect(ran).toMatchObject({ ok: false });
    expect(h.doctorRuns()).toBe(1);
    expect(h.heldDuringDoctor()).toBe(75);
    expect(lock.readLog().slice(-2)).toEqual([
      expect.stringMatching(/ acquire alphaclaw doctor-fix pid=\d+ by=watchdog:repair_health_timer$/),
      expect.stringMatching(/ release alphaclaw doctor-fix rc=1 by=watchdog:repair_health_timer$/),
    ]);
    h.watchdog.stop();
  });

  it("a crash relaunch never waits for (or is blocked by) the box lock", async () => {
    const lock = installRealBoxLock({ waitSeconds: 60 });
    const operator = await holdAsOperator(lock.lockPath, { seconds: 30 });
    vi.useFakeTimers();
    const h = createHarness(lock);
    h.watchdog.onGatewayExit({ code: 1, stderrTail: [] });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.launchGatewayProcess).toHaveBeenCalled();
    expect(lock.readLog().some((line) => line.includes(" alphaclaw "))).toBe(false);
    expect(operator.child.exitCode).toBeNull();
    h.watchdog.stop();
  });
});

describe.runIf(hasFlock)("routes refuse with 409 box_locked while an operator holds the lock", () => {
  it("Browse Sync waits, then refuses without running the sync; ?boxLockWait=0 refuses at once; free, the sync runs under the lock with its rc", async () => {
    const { registerBrowseRoutes } = require("../../lib/server/routes/browse");
    const rootDir = tempDir("alphaclaw-box-browse-");
    fs.mkdirSync(path.join(rootDir, ".git"));
    const lock = installRealBoxLock({ waitSeconds: 1 });
    let heldDuringSync = null;
    const runGitSync = vi.fn(async () => {
      heldDuringSync = operatorProbe(lock.lockPath).status;
      return { outcome: "failed", code: "push_failed", message: "Git sync could not push to GitHub" };
    });
    const app = express();
    app.use(express.json());
    registerBrowseRoutes({ app, fs, kRootDir: rootDir, runGitSync });
    const operator = await holdAsOperator(lock.lockPath, { seconds: 30 });

    const waited = await request(app).post("/api/browse/git-sync").send({ message: "sync" });
    expect(waited.status).toBe(409);
    expect(waited.body).toMatchObject({
      ok: false,
      code: "box_locked",
      error: expect.stringMatching(/^The box lock is held by OPS-7 \(db-migrate\) since \S+Z, so AlphaClaw did not start the git sync after waiting 1s\.$/),
      boxLock: { step: "git-sync", waitedSeconds: 1, holder: { owner: "OPS-7", step: "db-migrate", started_at: expect.any(String) }, since: expect.any(String) },
    });
    const startedAt = Date.now();
    const quick = await request(app).post("/api/browse/git-sync?boxLockWait=0").send({ message: "sync" });
    expect(quick.status).toBe(409);
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(runGitSync).not.toHaveBeenCalled();
    operator.child.kill("SIGKILL");
    await operator.exited;

    const synced = await request(app).post("/api/browse/git-sync").send({ message: "sync" });
    expect(synced.status).toBe(500);
    expect(heldDuringSync).toBe(75);
    expect(lock.readLog().slice(-1)[0]).toMatch(/ release alphaclaw git-sync rc=1 by=api:git-sync$/);
  });

  it("the Repair route answers the box lock refusal as 409 with the holder, and GET /api/watchdog/box-lock reports held/free", async () => {
    const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");
    const lock = installRealBoxLock({ waitSeconds: 1 });
    const watchdog = {
      getStatus: vi.fn(() => ({})),
      triggerRepair: vi.fn(async () => ({
        ok: false, skipped: true, reason: "box_locked", statusCode: 409,
        message: "The box lock is held by OPS-7 (db-migrate), so AlphaClaw did not start the repair (Doctor) after waiting 1s.",
        hint: "Try again once the other operator's work is finished.",
        boxLock: { step: "doctor-fix", waitedSeconds: 1, holder: { owner: "OPS-7", step: "db-migrate" }, since: null },
      })),
    };
    const app = express();
    app.use(express.json());
    registerWatchdogRoutes({ app, requireAuth: (req, res, next) => next(), watchdog, getRecentEvents: vi.fn(), readLogTail: vi.fn() });
    const repair = await request(app).post("/api/watchdog/repair?boxLockWait=0");
    expect(watchdog.triggerRepair).toHaveBeenCalledWith({ force: false, boxLockWaitMs: 0 });
    expect(repair.status).toBe(409);
    expect(repair.body).toMatchObject({ ok: false, code: "box_locked", error: expect.stringContaining("OPS-7"), boxLock: { holder: { owner: "OPS-7" } } });

    expect((await request(app).get("/api/watchdog/box-lock")).body).toMatchObject({ ok: true, boxLock: { enabled: true, state: "free", holder: null } });
    await holdAsOperator(lock.lockPath, { seconds: 30 });
    const held = await request(app).get("/api/watchdog/box-lock");
    expect(held.body.boxLock).toMatchObject({ state: "held", holder: { owner: "OPS-7", step: "db-migrate", by: "ops-session" }, lockPath: lock.lockPath });
    setBoxLockForTests(createBoxLock({ config: null }));
    expect((await request(app).get("/api/watchdog/box-lock")).body).toEqual({ ok: true, boxLock: { enabled: false } });
  });
});

describe.runIf(hasFlock)("snapshot sweep", () => {
  it("is skipped while an operator holds the box lock and runs (holding it) otherwise", async () => {
    const { sweepAbandonedSnapshotCopies } = require("../../lib/server/openclaw-snapshot-sweep");
    const lock = installRealBoxLock();
    const home = tempDir("alphaclaw-box-sweep-");
    const logger = { log: vi.fn() };
    const swept = sweepAbandonedSnapshotCopies({ env: { HOME: home }, trigger: "periodic", logger });
    expect(swept).toMatchObject({ candidates: 0, removed: 0 });
    expect(lock.readLog()).toEqual([
      expect.stringMatching(/ acquire alphaclaw sweep-delete pid=\d+ by=snapshot-sweep:periodic$/),
      expect.stringMatching(/ release alphaclaw sweep-delete rc=0 by=snapshot-sweep:periodic$/),
    ]);
    await holdAsOperator(lock.lockPath, { seconds: 30 });
    expect(sweepAbandonedSnapshotCopies({ env: { HOME: home }, trigger: "periodic", logger })).toEqual({ skipped: "box_locked" });
    expect(logger.log.mock.calls.at(-1)[0]).toMatch(/^\[alphaclaw\] snapshot sweep \(periodic\): skipped: The box lock is held by OPS-7/);
  });
});

describe("scheduled git sync", () => {
  const { buildSystemCronFile } = require("../../lib/cli/system-cron");
  const cronArgs = { schedule: "7 * * * *", scriptPath: "/app/.alphaclaw/hourly-git-sync.sh", rootDir: "/app", openclawDir: "/app/.openclaw" };

  it("cron.d carries the deployment's box lock keys, and leaves them all out (with an error) when one cannot be carried safely", () => {
    const logger = { error: vi.fn() };
    expect(buildSystemCronFile({ ...cronArgs, env: {}, logger })).not.toContain("BOX_LOCK");
    const file = buildSystemCronFile({
      ...cronArgs,
      env: { ALPHACLAW_BOX_LOCK_PATH: "/srv/ops/box.lock", ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "300", ALPHACLAW_BOX_LOCK_OWNER: "alphaclaw" },
      logger,
    });
    expect(file.split("\n")).toEqual(expect.arrayContaining([
      "ALPHACLAW_BOX_LOCK_PATH=/srv/ops/box.lock",
      "ALPHACLAW_BOX_LOCK_OWNER=alphaclaw",
      "ALPHACLAW_BOX_LOCK_WAIT_SECONDS=300",
    ]));
    const unsafe = buildSystemCronFile({ ...cronArgs, env: { ALPHACLAW_BOX_LOCK_PATH: "/srv/ops/box lock" }, logger });
    expect(unsafe).not.toContain("BOX_LOCK");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("leaves out the box lock: ALPHACLAW_BOX_LOCK_PATH"));
  });

  it("the hourly script never exports box lock keys from .env, and they are deployment-only", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "setup", "hourly-git-sync.sh"), "utf8");
    expect(script).toMatch(/ALPHACLAW_BOX_LOCK_\*\) continue ;;/);
    const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
    expect(kDeploymentOnlyEnvKeys).toEqual(expect.arrayContaining([
      "ALPHACLAW_BOX_LOCK_PATH",
      "ALPHACLAW_BOX_LOCK_WAIT_SECONDS",
      "ALPHACLAW_BOX_LOCK_OWNER",
      "ALPHACLAW_BOX_LOCK_OWNER_PATH",
      "ALPHACLAW_BOX_LOCK_LOG_PATH",
    ]));
  });

  it.runIf(hasFlock)("the scheduled CLI run waits, then exits 75 box_locked and records it, touching nothing", async () => {
    const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
    const rootDir = tempDir("alphaclaw-box-gitsync-");
    const homeDir = tempDir("alphaclaw-box-gitsync-home-");
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", openclawDir]);
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
    const lockPath = path.join(tempDir("alphaclaw-box-gitsync-lock-"), "box.lock");
    const operator = await holdAsOperator(lockPath, { seconds: 30 });
    const baseEnv = { ...process.env };
    delete baseEnv.ALPHACLAW_GIT_SYNC_PATHS;
    const env = {
      ...baseEnv,
      ALPHACLAW_ROOT_DIR: rootDir,
      HOME: homeDir,
      GITHUB_TOKEN: "ghp_test",
      GITHUB_WORKSPACE_REPO: "owner/repo",
      ALPHACLAW_BOX_LOCK_PATH: lockPath,
      ALPHACLAW_BOX_LOCK_WAIT_SECONDS: "1",
    };
    const result = spawnSync(process.execPath, [binPath, "git-sync", "--trigger", "scheduled", "-m", "sync"], { encoding: "utf8", env });
    expect(result.status).toBe(75);
    expect(result.stderr).toMatch(/git-sync refused \(box_locked\): The box lock is held by OPS-7 \(db-migrate\) since \S+Z, so AlphaClaw did not start the git sync after waiting 1s\./);
    const status = JSON.parse(fs.readFileSync(path.join(openclawDir, ".alphaclaw", "git-sync-status.json"), "utf8"));
    expect(status).toMatchObject({ code: "box_locked", outcome: "refused", trigger: "scheduled" });
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: openclawDir }).status).not.toBe(0);
    expect(operator.child.exitCode).toBeNull();
    expect(fs.readFileSync(lockPath.replace(/\.lock$/, ".log"), "utf8")).not.toContain(" alphaclaw ");
  });
});
