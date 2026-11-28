// The gateway launch choke point (gateway.js prepareGatewayLaunch) fixes the
// state dir's modes OpenClaw 2026.11.10 needs on every launch, not only
// before Doctor (v0.10.350). gateway.js reads its state dir from
// ALPHACLAW_ROOT_DIR at load, so each launch runs in its own node process.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const kRepo = path.resolve(__dirname, "../..");

const mkRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-launch-modes-")));

const prepareLaunches = (rootDir, count) => {
  const script = [
    `const gateway = require(${JSON.stringify(path.join(kRepo, "lib/server/gateway"))});`,
    "const outcomes = [];",
    "gateway.setGatewayPrelaunchHookHandler((outcome) => outcomes.push(outcome));",
    "(async () => {",
    "  const results = [];",
    `  for (let index = 0; index < ${count}; index += 1) {`,
    "    try { results.push({ result: await gateway.prepareGatewayLaunch({ site: 'watchdog relaunch' }) }); }",
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

describe("gateway launch: the state dir's modes (v0.10.350)", () => {
  it("fixes the state dir's modes on every launch: a 0775 state dir under a 2775 parent loses group write, the parent gets the sticky bit", () => {
    const rootDir = mkRoot();
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir);
    fs.chmodSync(openclawDir, 0o775);
    fs.chmodSync(rootDir, 0o2775);
    const { results, stdout } = prepareLaunches(rootDir, 1);
    expect(results).toEqual([{ result: { hookRan: false, reapplyOpenclawPackageAfterStop: false } }]);
    expect(fs.statSync(openclawDir).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(rootDir).mode & 0o7777).toBe(0o3775);
    expect(stdout).toContain(`[alphaclaw] gateway watchdog relaunch: set the sticky bit on ${rootDir} (02775 → 03775)`);
    fs.chmodSync(rootDir, 0o755);
  });
});
