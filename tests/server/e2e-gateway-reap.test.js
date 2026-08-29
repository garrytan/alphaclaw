// Real-process gateway reap e2e: the REAL lib/server/gateway.js module
// (required in-process, child_process NOT mocked) driving REAL child
// processes through a PATH-shimmed fake `openclaw` CLI. This is the
// real-process proof for three shutdown behaviors that unit tests only
// model:
//   1. stopGatewayChildAndWait SIGKILL escalation past Node's `.killed`
//      flag (set on SIGTERM SEND) against a child that really ignores
//      SIGTERM — the v0.9.36 escalation fix.
//   2. stopGatewayForShutdown cancelling an in-flight execOpenclaw CLI
//      call: the lifecycle-lock abort must SIGTERM the real execFile child
//      and complete well inside the 10s shutdown deadline.
//   3. runGatewayRestartCmd abort wiring: a SIGTERM-trapping restart
//      supervisor spawn must be reaped by the 3s SIGKILL escalation timer
//      after shutdown aborts the lifecycle signal.
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

  it("stopGatewayForShutdown aborts an in-flight CLI call and the real execFile child dies", async () => {
    // First `gateway stop` records its pid and sleeps 60s (exec keeps the
    // pid). Any later `gateway stop` — stopGatewayForShutdown's best-effort
    // trailing exec — sees the pidfile and exits 0 immediately, so the
    // measured shutdown time is the abort path, not a second hang.
    const pidFile = path.join(caseDir, "stop.pid");
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "stop" ]; then',
        `  if [ -f ${JSON.stringify(pidFile)} ]; then exit 0; fi`,
        `  echo $$ > ${JSON.stringify(pidFile)}`,
        "  exec sleep 60",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    gateway = loadGateway();
    const cmdPromise = gateway.runGatewayCmd("stop");

    await pollUntil(() => readPid(pidFile) !== null, {
      label: "in-flight gateway-stop shim pidfile",
    });
    const cliPid = trackPid(readPid(pidFile));
    expect(isPidAlive(cliPid)).toBe(true);

    const startedAt = Date.now();
    await gateway.stopGatewayForShutdown();
    const elapsedMs = Date.now() - startedAt;

    // The lock cancel aborted the op's signal; Node's native execFile abort
    // SIGTERMed the shim, and the callback (and therefore the cancel await)
    // only fires after the child closed — the 60s sleep never ran out.
    expect(elapsedMs).toBeLessThan(5000);
    expect(isPidAlive(cliPid)).toBe(false);
    // The op promise settles cleanly (execOpenclaw resolves ok:false on
    // abort — never rejects into an unhandled rejection).
    await expect(cmdPromise).resolves.toBeUndefined();
  });

  it("reaps a SIGTERM-trapping restart supervisor via the 3s SIGKILL escalation timer", async () => {
    // `gateway --force` (the cold-start supervisor spawn) ignores SIGTERM:
    // `trap '' TERM` sets SIG_IGN, which survives exec into sleep. The
    // abort's immediate child.kill("SIGTERM") is therefore a no-op and only
    // the 3s unref'd killTimer's SIGKILL can reap it. `gateway stop` (issued
    // by runGatewayColdStart before the spawn and by the best-effort
    // shutdown exec after) exits 0 immediately.
    const pidFile = path.join(caseDir, "supervisor.pid");
    installOpenclawShim(
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "--force" ]; then',
        "  trap '' TERM",
        `  echo $$ > ${JSON.stringify(pidFile)}`,
        "  exec sleep 60",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    gateway = loadGateway();
    const restartPromise = gateway.restartGateway(() => {});

    await pollUntil(() => readPid(pidFile) !== null, {
      label: "restart supervisor shim pidfile",
    });
    const supervisorPid = trackPid(readPid(pidFile));
    expect(isPidAlive(supervisorPid)).toBe(true);

    const startedAt = Date.now();
    await gateway.stopGatewayForShutdown();
    const shutdownMs = Date.now() - startedAt;

    // Shutdown must not wait for the supervisor: the abort check inside
    // waitForGatewayReady ends the 120s ready poll within one 500ms tick.
    expect(shutdownMs).toBeLessThan(5000);
    // The cancelled restart settles deterministically — as an HONEST failure
    // carrying abort evidence, never a silent success over a dead gateway
    // (this branch's restart contract: outcomes are never fabricated).
    await expect(restartPromise).rejects.toMatchObject({
      name: "GatewayRestartError",
      evidence: expect.objectContaining({ aborted: true }),
    });

    // The killTimer fires 3s after abort — the supervisor survived SIGTERM
    // (proving the trap held) and must then die to the real SIGKILL.
    if (shutdownMs < 2500) {
      expect(isPidAlive(supervisorPid)).toBe(true);
    }
    await pollUntil(() => !isPidAlive(supervisorPid), {
      timeoutMs: 6000,
      intervalMs: 100,
      label: "supervisor reaped by SIGKILL escalation",
    });
  });
});
