// The gateway launch choke point (gateway.js prepareGatewayLaunch) for the
// OpenClaw 2026.11.10 follow-ups (v0.10.350): a launch is held while
// AlphaClaw's disk refusal of the pin's data upgrade stands, and the state
// dir's modes are fixed on every launch, not only before Doctor. gateway.js
// reads its state dir from ALPHACLAW_ROOT_DIR at load, so each launch runs in
// its own node process.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const kRepo = path.resolve(__dirname, "../..");

const mkRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-launch-hold-")));

// holds: what the hold check returns on each launch, in order.
const prepareLaunches = (rootDir, holds) => {
  const script = [
    `const gateway = require(${JSON.stringify(path.join(kRepo, "lib/server/gateway"))});`,
    "const outcomes = [];",
    "gateway.setGatewayPrelaunchHookHandler((outcome) => outcomes.push(outcome));",
    `const holds = ${JSON.stringify(holds)};`,
    "let index = 0;",
    "gateway.setGatewayLaunchHoldCheck(() => holds[index]);",
    "(async () => {",
    "  const results = [];",
    "  for (; index < holds.length; index += 1) {",
    "    try { results.push({ result: await gateway.prepareGatewayLaunch({ site: 'watchdog relaunch', skipUpgradeDiskHold: Boolean(holds[index] && holds[index].skip) }) }); }",
    "    catch (error) { results.push({ error: { name: error.name, step: error.step, code: error.code, message: error.message, isPrelaunch: error instanceof gateway.GatewayPrelaunchHookError } }); }",
    "  }",
    "  process.stdout.write('\\nRESULT ' + JSON.stringify({ results, outcomes }) + '\\n');",
    "  process.exit(0);",
    "})();",
  ].join("\n");
  const run = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, ALPHACLAW_ROOT_DIR: rootDir, HOME: rootDir, ALPHACLAW_GATEWAY_PRELAUNCH_HOOK: "", ALPHACLAW_OPENCLAW_PACKAGES: "" },
    encoding: "utf8",
    timeout: 120000,
  });
  const line = String(run.stdout || "").split("\n").find((text) => text.startsWith("RESULT "));
  if (!line) throw new Error(`launch process printed no result (exit ${run.status}): ${String(run.stderr || "").slice(-2000)}`);
  return { ...JSON.parse(line.slice("RESULT ".length)), stdout: run.stdout, stderr: run.stderr };
};

describe("the watchdog, handler and restart copy for a held launch (v0.10.350)", () => {
  const { createWatchdog, createGatewayPrelaunchHookHandler } = require("../../lib/server/watchdog");
  const heldOutcome = (overrides = {}) => ({
    step: "upgrade_disk",
    status: "refused",
    code: "upgrade_disk_held",
    hookPath: null,
    message: "OpenClaw's data upgrade is waiting for disk space: this volume has 3.0 GB free for 4.2 GB of OpenClaw state.",
    site: "watchdog relaunch",
    durationMs: 0,
    exitCode: null,
    signal: null,
    ...overrides,
  });

  it("the watchdog narrates the hold as upgrade_disk_held, and the first launch that passes clears it", () => {
    const insertWatchdogEvent = vi.fn();
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true })),
      launchGatewayProcess: vi.fn(async () => null),
      insertWatchdogEvent,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
    });
    watchdog.onPrelaunchHook(heldOutcome());
    expect(watchdog.getStatus()).toMatchObject({
      degradedReason: "upgrade_disk_held",
      prelaunchHook: { step: "upgrade_disk", status: "refused", code: "upgrade_disk_held", message: heldOutcome().message },
    });
    const rows = insertWatchdogEvent.mock.calls.map(([row]) => row).filter((row) => row.eventType === "health_check" && row.status === "failed");
    expect(rows.map((row) => row.source)).toEqual(["upgrade_disk"]);
    watchdog.onPrelaunchHook(heldOutcome({ status: "ran", code: null, message: null }));
    expect(watchdog.getStatus()).toMatchObject({ degradedReason: null, prelaunchHook: null });
  });

  it("the handler records the hold and sends no prelaunch-hook notice (the boot notice and the upgrade alert already say it)", () => {
    const watchdog = { recordOperationEvent: vi.fn(), onPrelaunchHook: vi.fn() };
    const notify = vi.fn(async () => ({ ok: true }));
    createGatewayPrelaunchHookHandler({ watchdog, notify })(heldOutcome());
    expect(watchdog.recordOperationEvent).toHaveBeenCalledWith({
      kind: "upgrade_disk",
      status: "refused",
      details: { code: "upgrade_disk_held", site: "watchdog relaunch", message: heldOutcome().message },
    });
    expect(watchdog.onPrelaunchHook).toHaveBeenCalledWith(heldOutcome());
    expect(notify).not.toHaveBeenCalled();
  });

  it("a restart refused by the hold says the upgrade is waiting for disk space", () => {
    const { classifyRestartFailure } = require("../../lib/server/restart-failure-copy");
    const { GatewayUpgradeDiskHoldError } = require("../../lib/server/gateway");
    expect(classifyRestartFailure(new GatewayUpgradeDiskHoldError("held"))).toMatchObject({
      code: "upgrade_disk_held",
      error: expect.stringContaining("waiting for disk space"),
      hint: expect.stringContaining("Retry upgrade"),
    });
  });
});

describe("server/gateway prepareGatewayLaunch (v0.10.350)", () => {
  it("holds every launch while the data upgrade's disk refusal stands, and lets the first one through once there is room", () => {
    const rootDir = mkRoot();
    fs.mkdirSync(path.join(rootDir, ".openclaw"), { mode: 0o700 });
    const sentence = "this volume has 3.0 GB free for 4.2 GB of OpenClaw state.";
    const { results, outcomes, stderr } = prepareLaunches(rootDir, [{ sentence }, { sentence }, null, null]);
    expect(results.slice(0, 2)).toEqual([0, 1].map(() => ({
      error: {
        name: "GatewayUpgradeDiskHoldError",
        step: "upgrade_disk",
        code: "upgrade_disk_held",
        message: `OpenClaw's data upgrade is waiting for disk space: ${sentence}`,
        isPrelaunch: true,
      },
    })));
    expect(results.slice(2)).toEqual([0, 1].map(() => ({ result: { hookRan: false, reapplyOpenclawPackageAfterStop: false } })));
    expect(outcomes.map(({ step, status, code, site }) => ({ step, status, code, site }))).toEqual([
      { step: "upgrade_disk", status: "refused", code: "upgrade_disk_held", site: "watchdog relaunch" },
      { step: "upgrade_disk", status: "refused", code: "upgrade_disk_held", site: "watchdog relaunch" },
      { step: "upgrade_disk", status: "ran", code: null, site: "watchdog relaunch" },
    ]);
    expect(stderr).toContain(`[alphaclaw] gateway watchdog relaunch held: OpenClaw's data upgrade is waiting for disk space: ${sentence}`);
  });

  it("Retry upgrade's restart skips the hold before its stop (its own Doctor measures the disk again)", () => {
    const rootDir = mkRoot();
    fs.mkdirSync(path.join(rootDir, ".openclaw"), { mode: 0o700 });
    const { results, outcomes } = prepareLaunches(rootDir, [{ sentence: "no room", skip: true }]);
    expect(results).toEqual([{ result: { hookRan: false, reapplyOpenclawPackageAfterStop: false } }]);
    expect(outcomes).toEqual([]);
  });

  it("fixes the state dir's modes on every launch: a 0775 state dir under a 2775 parent loses group write, the parent gets the sticky bit", () => {
    const rootDir = mkRoot();
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir);
    fs.chmodSync(openclawDir, 0o775);
    fs.chmodSync(rootDir, 0o2775);
    const { results, stdout } = prepareLaunches(rootDir, [null]);
    expect(results).toEqual([{ result: { hookRan: false, reapplyOpenclawPackageAfterStop: false } }]);
    expect(fs.statSync(openclawDir).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(rootDir).mode & 0o7777).toBe(0o3775);
    expect(stdout).toContain(`[alphaclaw] gateway watchdog relaunch: set the sticky bit on ${rootDir} (02775 → 03775)`);
    fs.chmodSync(rootDir, 0o755);
  });
});
