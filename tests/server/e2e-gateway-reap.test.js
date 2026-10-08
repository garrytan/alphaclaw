// Real-process gateway reap e2e: the REAL lib/server/gateway.js module
// (required in-process, child_process NOT mocked) driving REAL child
// processes through a PATH-shimmed fake `openclaw` CLI. This is the
// real-process proof for three shutdown behaviors that unit tests only
// model:
//   1. stopGatewayChildAndWait SIGKILL escalation past Node's `.killed`
//      flag (set on SIGTERM SEND) against a child that really ignores
//      SIGTERM — the v0.9.36 escalation fix.
//   2. The stop ladder reaping a real launcher→worker tree as one process
//      group (the production shape under OpenClaw's compile-cache launcher):
//      a SIGKILL to the launcher alone would orphan the worker on the port.
//   3. stopGatewayForShutdown aborting an in-flight cold restart's ready
//      wait and reaping the spawned child inside the shutdown slice.
//   4. resolveServingIdentity against the REAL /proc: a launcher→worker tree
//      resolves to its root, worker and start ticks, and the ticks change
//      when the child is replaced (the watchdog's pid-reuse guard).
//
// gatewayEnv() spreads process.env at spawn/exec time, so prepending a tmp
// bin dir holding an executable `openclaw` script to process.env.PATH makes
// every real spawn/execFile resolve the shim. ALPHACLAW_ROOT_DIR must be set
// before ANY lib/server require — constants.js captures kRootDir at load.

const fs = require("fs");
const os = require("os");
const path = require("path");

const kTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gw-reap-"));
process.env.ALPHACLAW_ROOT_DIR = kTmpRoot;

const { OPENCLAW_DIR } = require("../../lib/server/constants");
const lockContention = require("../../lib/server/openclaw-lock-contention");
const gatewayIdentity = require("../../lib/server/gateway-identity");
const {
  readProcStartTicks,
  readProcParentPid,
} = lockContention;

if (!OPENCLAW_DIR.startsWith(kTmpRoot)) {
  // constants.js was already loaded with a different root — the tests below
  // would touch a real ~/.alphaclaw. Fail loudly instead of proceeding.
  throw new Error(
    `constants.js captured OPENCLAW_DIR=${OPENCLAW_DIR}; expected it under ${kTmpRoot}. ` +
      "ALPHACLAW_ROOT_DIR must be set before any lib/server require.",
  );
}

// Module-level gateway state (gatewayChild, the lifecycle lock's cancelled
// latch) persists per require — every test gets a fresh module instance.
const kGatewayModulePath = require.resolve("../../lib/server/gateway");
const loadGateway = () => {
  delete require.cache[kGatewayModulePath];
  return require(kGatewayModulePath);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollUntil = async (
  predicate,
  { timeoutMs = 8000, intervalMs = 50, label = "condition" } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = (file) => {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

describe("gateway reap e2e (real child processes via PATH-shimmed openclaw)", () => {
  let caseDir = null;
  let originalPath = null;
  let gateway = null;
  let trackedPids = null;

  const trackPid = (pid) => {
    if (Number.isInteger(pid) && pid > 0) trackedPids.push(pid);
    return pid;
  };

  // Writes an executable fake `openclaw` into a per-test bin dir and
  // prepends it to process.env.PATH; gatewayEnv() reads process.env at call
  // time, so every subsequent spawn/execFile resolves this shim.
  const installOpenclawShim = (scriptBody) => {
    const binDir = path.join(caseDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shimPath = path.join(binDir, "openclaw");
    fs.writeFileSync(shimPath, scriptBody, { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    return shimPath;
  };

  beforeEach(() => {
    originalPath = process.env.PATH;
    trackedPids = [];
    caseDir = fs.mkdtempSync(path.join(kTmpRoot, "case-"));
    // Minimal openclaw.json: no enabled channels (plugin preflight — the
    // only other CLI traffic — is skipped) and a unique high gateway port
    // that nothing listens on, so isGatewayRunning()/waitForGatewayReady
    // poll a connection-refused loopback port instead of the shared 18789.
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OPENCLAW_DIR, "openclaw.json"),
      JSON.stringify({
        gateway: { port: 39000 + Math.floor(Math.random() * 2000) },
        channels: {},
      }),
    );
  });

  afterEach(async () => {
    // Belt and braces: reap the managed child through the module, then
    // SIGKILL every shim pid the test recorded. SIGKILL is the last resort —
    // a passing test has already observed each pid dead.
    if (gateway) {
      try {
        gateway.stopGatewayChild({ signal: "SIGKILL", force: true });
      } catch {}
      gateway = null;
    }
    for (const pid of trackedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    process.env.PATH = originalPath;
    delete require.cache[kGatewayModulePath];
  });

  afterAll(() => {
    fs.rmSync(kTmpRoot, { recursive: true, force: true });
  });

  it("SIGKILL-escalates a managed gateway child that ignores SIGTERM (stopGatewayChildAndWait)", async () => {
    // The fake `gateway run` execs (same PID) into a node process that
    // installs a SIGTERM no-op handler BEFORE writing its pidfile — pidfile
    // presence guarantees the trap is armed when the test sends SIGTERM.
    const pidFile = path.join(caseDir, "run.pid");
    const helperPath = path.join(caseDir, "ignore-sigterm.js");
    fs.writeFileSync(
      helperPath,
      [
        'process.on("SIGTERM", () => {});',
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then',
        `  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)}`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    gateway = loadGateway();
    const child = await gateway.launchGatewayProcess();
    expect(child).toBeTruthy();
    trackPid(child.pid);

    // The shim resolved via gatewayEnv()'s PATH and exec'd in place: the
    // pidfile the helper writes must carry the exact spawned pid.
    await pollUntil(() => readPid(pidFile) === child.pid, {
      label: "gateway-run shim pidfile with the spawned pid",
    });
    expect(isPidAlive(child.pid)).toBe(true);

    const startedAt = Date.now();
    const stopped = await gateway.stopGatewayChildAndWait({ graceMs: 300 });
    const elapsedMs = Date.now() - startedAt;

    // child.kill("SIGTERM") set `.killed` on SEND; the pre-fix guard would
    // have skipped the SIGKILL entirely and left the SIGTERM-ignoring child
    // alive. A dead real pid whose exit was BY SIGKILL is the proof the
    // escalation actually delivered — and exited() observes signal deaths
    // (signalCode, not just exitCode), so the reap reports success instead
    // of polling out its budget.
    expect(isPidAlive(child.pid)).toBe(false);
    await pollUntil(() => child.signalCode === "SIGKILL", {
      timeoutMs: 2000,
      label: "exit event with signalCode SIGKILL",
    });
    expect(child.signalCode).toBe("SIGKILL");
    expect(stopped).toBe(true);
    // SIGTERM alone cannot have done it: the grace window had to elapse
    // first (the helper ignores SIGTERM), and the whole stop stays bounded.
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("the stop ladder reaps a REAL launcher→worker tree that ignores SIGTERM as one process group (the detached spawn), SIGKILL after the grace, both pids dead", async () => {
    // The fake `gateway run` is a launcher that forks a SIGTERM-ignoring
    // worker and waits on it — the production shape (openclaw.mjs → worker).
    // A SIGKILL to the launcher alone would orphan the worker; the ladder
    // signals the launcher's process group instead.
    const launcherPidFile = path.join(caseDir, "launcher.pid");
    const workerPidFile = path.join(caseDir, "worker.pid");
    const workerPath = path.join(caseDir, "worker.js");
    fs.writeFileSync(
      workerPath,
      [
        'process.on("SIGTERM", () => {});',
        `require("fs").writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then',
        "  trap '' TERM",
        `  echo $$ > ${JSON.stringify(launcherPidFile)}`,
        `  ${JSON.stringify(process.execPath)} ${JSON.stringify(workerPath)} &`,
        "  wait",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    gateway = loadGateway();
    const child = await gateway.launchGatewayProcess();
    expect(child).toBeTruthy();
    trackPid(child.pid);
    await pollUntil(() => readPid(launcherPidFile) === child.pid && readPid(workerPidFile) !== null, {
      label: "launcher + worker pidfiles",
    });
    const workerPid = trackPid(readPid(workerPidFile));
    expect(readProcParentPid(workerPid)).toBe(child.pid);
    // detached: the launcher leads its own process group.
    expect(gatewayIdentity.readProcessGroupId(child.pid)).toBe(child.pid);
    expect(gatewayIdentity.readProcessGroupId(workerPid)).toBe(child.pid);

    const identity = gateway.resolveGatewayIdentity();
    expect(identity).toMatchObject({ owner: "managed", rootPid: child.pid, pgid: child.pid });
    expect(identity.pids).toEqual(expect.arrayContaining([child.pid, workerPid]));

    const startedAt = Date.now();
    const stop = await gateway.stopGatewayLadder({
      allowGracefulRestart: false,
      termGraceMs: 400,
      killGraceMs: 3000,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(stop.how).toBe("sigkill");
    expect(isPidAlive(child.pid)).toBe(false);
    expect(isPidAlive(workerPid)).toBe(false);
    // SIGTERM alone cannot have done it (both ignore it): the grace elapsed
    // first, and the whole stop stays bounded.
    expect(elapsedMs).toBeGreaterThanOrEqual(350);
    expect(elapsedMs).toBeLessThan(6000);
    await pollUntil(() => child.signalCode === "SIGKILL", {
      timeoutMs: 2000,
      label: "launcher exit event with signalCode SIGKILL",
    });
  });

  it("stopGatewayForShutdown aborts an in-flight cold restart's ready wait and reaps the spawned child inside its budget", async () => {
    // `gateway run` ignores SIGTERM and never listens, so the restart parks
    // in its ready wait; shutdown must end that wait within a poll tick and
    // reap the child by SIGKILL inside the shutdown slice — never wait out
    // the 120s ready budget.
    const pidFile = path.join(caseDir, "run.pid");
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then',
        "  trap '' TERM",
        `  echo $$ > ${JSON.stringify(pidFile)}`,
        "  exec sleep 60",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    gateway = loadGateway();
    // Nothing on the port: the ladder has nothing to stop (how: none) and the
    // restart goes straight to the spawn.
    // Settled handler attached up front: the rejection lands while the
    // shutdown await below is in flight.
    const restartOutcome = gateway.restartGateway(() => {}).then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    await pollUntil(() => readPid(pidFile) !== null, { label: "gateway-run shim pidfile" });
    const runPid = trackPid(readPid(pidFile));
    expect(isPidAlive(runPid)).toBe(true);

    const startedAt = Date.now();
    await gateway.stopGatewayForShutdown({ budgetMs: 3000 });
    const shutdownMs = Date.now() - startedAt;

    expect(shutdownMs).toBeLessThan(5000);
    // The cancelled restart settles deterministically — as an HONEST failure
    // carrying abort evidence, never a silent success over a dead gateway.
    const { error } = await restartOutcome;
    expect(error).toMatchObject({
      name: "GatewayRestartError",
      evidence: expect.objectContaining({ aborted: true }),
    });
    // SIGTERM was ignored (the trap held); the ladder's SIGKILL reaped it.
    expect(isPidAlive(runPid)).toBe(false);
  });

  it("resolveServingIdentity sees the real launcher→worker tree with start ticks, and the ticks change when the child is replaced", async () => {
    if (process.platform !== "linux") return;
    // Scope discovery to this fixture's real argv while retaining the real
    // /proc scan, ancestry and start-tick reads. A user's gateway or the live
    // memory suite may share the host: production correctly refuses their
    // multiple roots, but they are not part of this isolated tree fixture.
    const scanProcesses = lockContention.listLiveOpenclawProcesses;
    vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockImplementation((options = {}) =>
      scanProcesses({
        ...options,
        match: (argv) => argv.some((arg) => arg.startsWith(`${caseDir}${path.sep}`)) &&
          (!options.match || options.match(argv)),
      }),
    );
    // The fake `gateway run` mirrors the real launcher shape: the shim (sh,
    // argv "…/bin/openclaw gateway run" — a serving-pattern root) stays alive
    // as the process-tree root and forwards TERM to its worker, a second
    // shell script also NAMED `openclaw` (argv "…/worker/openclaw gateway
    // run"), so the worker satisfies both the serving-pattern scan and
    // resolveFirstChildPid's kernel-comm filter (`Name: openclaw` — a shebang
    // script's comm is its basename; a node worker would read `MainThread`).
    const workerDir = path.join(caseDir, "worker");
    fs.mkdirSync(workerDir, { recursive: true });
    const workerScript = path.join(workerDir, "openclaw");
    const pidFile = path.join(caseDir, "worker.pid");
    fs.writeFileSync(
      workerScript,
      [
        "#!/bin/sh",
        `echo $$ > ${JSON.stringify(pidFile)}`,
        "sleep 60 &",
        "trap 'kill $! 2>/dev/null; exit 0' TERM INT",
        "wait",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then',
        `  ${JSON.stringify(workerScript)} gateway run &`,
        "  worker=$!",
        "  trap 'kill $worker 2>/dev/null' TERM INT",
        "  wait $worker",
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    const launchAndResolve = async () => {
      fs.rmSync(pidFile, { force: true });
      const child = await gateway.launchGatewayProcess();
      expect(child).toBeTruthy();
      trackPid(child.pid);
      await pollUntil(() => readPid(pidFile) !== null, { label: "worker pidfile" });
      const workerPid = trackPid(readPid(pidFile));
      return { child, workerPid, identity: gateway.resolveServingIdentity() };
    };

    gateway = loadGateway();
    const first = await launchAndResolve();

    expect(first.identity).toEqual({
      rootPid: first.child.pid,
      workerPid: first.workerPid,
      startTicks: expect.any(Number),
      pids: expect.arrayContaining([first.child.pid, first.workerPid]),
    });
    expect(first.identity.pids).toHaveLength(2);
    // The root's ticks come from the real /proc/<pid>/stat; the worker's
    // parent really is the launcher.
    expect(readProcStartTicks(first.child.pid)).toBe(first.identity.startTicks);
    expect(readProcParentPid(first.workerPid)).toBe(first.child.pid);
    // A managed launch through the compat wrapper consumed generation 1.
    expect(gateway.getLaunchGeneration()).toBe(1);

    // Replace: SIGTERM the launcher (its trap takes the worker down), then
    // launch again. ≥ one 100 Hz clock tick apart so the successor's start
    // ticks are strictly greater — a reused pid number could never pass as
    // the same process.
    expect(await gateway.stopGatewayChildAndWait({ graceMs: 2000 })).toBe(true);
    await pollUntil(() => !isPidAlive(first.workerPid), {
      label: "worker reaped through the launcher's TERM trap",
    });
    expect(readProcStartTicks(first.child.pid)).toBeNull();
    await sleep(50);

    const second = await launchAndResolve();
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(second.identity).toMatchObject({
      rootPid: second.child.pid,
      workerPid: second.workerPid,
    });
    expect(second.identity.startTicks).toBeGreaterThan(first.identity.startTicks);
    expect(gateway.getLaunchGeneration()).toBe(2);
  });
});
