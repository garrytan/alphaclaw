// LIVE TIER — a heap-snapshot signal flag in the operator's NODE_OPTIONS must
// not stop a gateway restart (ALPH-34), against the REAL pinned OpenClaw.
//
// OpenClaw delivers every restart as an in-process process.emit("SIGUSR2")
// and authorizes it for 5 s (RESTART_AUTH_GRACE_MS). Node installs
// --heapsnapshot-signal=SIGUSR2 as an earlier process.on("SIGUSR2") listener,
// so the heap snapshot is written first. When the dump takes longer than 5 s,
// OpenClaw's handler finds the authorization expired, treats its own restart
// as an unauthorized external SIGUSR2 and only re-schedules it (30 s cooldown).
// The gateway never restarts and dumps its heap about once a minute.
//
//   1. The env AlphaClaw builds (gatewayLaunchEnv/gatewayEnv) from that
//      NODE_OPTIONS: one `openclaw gateway restart --safe` completes (the
//      gateway logs "received SIGUSR2; restarting", takes the supervisor
//      restart and exits 0), and no *.heapsnapshot is written.
//   2. Control, the same env with the operator's NODE_OPTIONS unstripped:
//      the first emit writes a dump longer than 5 s and the gateway does NOT
//      restart, so this file catches drift in the pin's restart authorization.
//
// The heap is inflated by a test-only --import preload so the dump reliably
// takes longer than 5 s; OpenClaw itself is unmodified. Mock model only.
// Requires Node new enough for the pin FIRST on PATH. About 1-2 minutes.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-heapsig-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
delete process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { kLiveEnabled, waitFor, repoOpenclawBin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 5 * 60 * 1000;
const kBallastObjects = 2_000_000;
const kRestartAuthGraceMs = 5_000;
const kToken = "live-heapsig-token-00000000000000000000";

const kPreloadPath = path.join(kRootDir, "heap-ballast.mjs");
fs.writeFileSync(
  kPreloadPath,
  [
    "const argv = process.argv.slice(2);",
    'if (argv.includes("gateway") && argv.includes("run")) {',
    `  globalThis.__alphaclawLiveHeapBallast = Array.from({ length: ${kBallastObjects} }, (_, i) => ({ i, s: "x" + i }));`,
    "}",
    "",
  ].join("\n"),
);

const stamp = (line) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})/.exec(line);
  return match ? Date.parse(match[1]) : null;
};

const writeConfig = (configPath, stateDir, port) => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token: kToken } },
    agents: { defaults: { workspace: path.join(stateDir, "workspace"), model: { primary: "fixture/fixture" } } },
    models: { providers: { fixture: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "local-model-fixture",
      models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
    } } },
    channels: {},
  }));
};

describeLive("LIVE gateway restart with a heap-snapshot signal flag in NODE_OPTIONS", () => {
  let gatewayModule;
  const children = [];

  beforeAll(() => {
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    process.env.OPENCLAW_GATEWAY_TOKEN = kToken;
    gatewayModule = require("../../lib/server/gateway");
  });

  afterAll(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  });

  // The env AlphaClaw would hand the gateway daemon and the openclaw CLI when
  // the deployment's NODE_OPTIONS carries the operator's diagnostic flags.
  const buildEnvs = (operatorNodeOptions) => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = operatorNodeOptions;
    try {
      return { launchEnv: gatewayModule.gatewayLaunchEnv(), cliEnv: gatewayModule.gatewayEnv() };
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  };

  const bootGateway = async ({ label, launchEnv, cliEnv }) => {
    const root = liveHelpers.mkTemp(`alphaclaw-live-heapsig-${label}-`);
    const stateDir = path.join(root, ".openclaw");
    const diagDir = path.join(root, "diag");
    fs.mkdirSync(diagDir, { recursive: true });
    const port = 19500 + Math.floor(Math.random() * 400);
    const dirs = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    };
    writeConfig(dirs.OPENCLAW_CONFIG_PATH, stateDir, port);
    const withDirs = (env) => {
      const next = { ...env, ...dirs };
      next.NODE_OPTIONS = String(next.NODE_OPTIONS || "").split("__DIAG_DIR__").join(diagDir);
      for (const key of Object.keys(next)) if (key.startsWith("VITEST")) delete next[key];
      return next;
    };
    const env = withDirs(launchEnv);
    const lines = [];
    const child = spawn(repoOpenclawBin(), ["gateway", "run"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let pending = "";
    const onData = (chunk) => {
      pending += String(chunk);
      const parts = pending.split("\n");
      pending = parts.pop();
      lines.push(...parts);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const readyzOk = async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
      } catch {
        return false;
      }
    };
    await waitFor(readyzOk, 180_000, `${label} gateway /readyz 200`);
    const askSafeRestart = () => {
      const res = spawnSync(repoOpenclawBin(), ["gateway", "restart", "--safe", "--json"], {
        env: withDirs(cliEnv),
        encoding: "utf8",
        timeout: 60_000,
      });
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    };
    const snapshots = () => fs.readdirSync(diagDir).filter((name) => name.endsWith(".heapsnapshot"));
    return { child, env, exit, lines, askSafeRestart, snapshots };
  };

  it(
    "the env AlphaClaw builds drops the flag, so one safe restart completes and writes no heap snapshot",
    async () => {
      const operator = "--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=__DIAG_DIR__";
      const { launchEnv, cliEnv } = buildEnvs(`${operator} --import=${kPreloadPath}`);
      for (const env of [launchEnv, cliEnv]) {
        expect(env.NODE_OPTIONS).not.toMatch(/--heapsnapshot-signal/);
        expect(env.NODE_OPTIONS).toContain(`--import=${kPreloadPath}`);
      }
      const gw = await bootGateway({ label: "stripped", launchEnv, cliEnv });
      const ask = gw.askSafeRestart();
      expect(ask.status, `gateway restart --safe failed: ${ask.stderr}`).toBe(0);
      await waitFor(
        () => gw.lines.some((line) => /restart mode: full process restart \(supervisor restart\)/.test(line)),
        90_000,
        "supervisor restart line",
      );
      expect(gw.lines.some((line) => /received SIGUSR2; restarting/.test(line))).toBe(true);
      const exited = await Promise.race([gw.exit, new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
      expect(exited).toEqual({ code: 0, signal: null });
      expect(gw.snapshots()).toEqual([]);
      expect(gw.lines.some((line) => /received SIGUSR2 \d+ times in 5 min/.test(line))).toBe(false);
    },
    kTestTimeoutMs,
  );

  it(
    "control: with the flag left in, the first emit dumps the heap for longer than 5 s and the gateway does not restart",
    async () => {
      const { launchEnv, cliEnv } = buildEnvs(`--import=${kPreloadPath}`);
      const unstripped = {
        ...launchEnv,
        NODE_OPTIONS: [launchEnv.NODE_OPTIONS, "--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=__DIAG_DIR__"].filter(Boolean).join(" "),
      };
      const gw = await bootGateway({ label: "control", launchEnv: unstripped, cliEnv });
      expect(gw.env.NODE_OPTIONS).toMatch(/--heapsnapshot-signal=SIGUSR2/);
      const ask = gw.askSafeRestart();
      expect(ask.status, `gateway restart --safe failed: ${ask.stderr}`).toBe(0);
      const fence = (re) => gw.lines.find((line) => re.test(line));
      await waitFor(() => fence(/\[admission\] reopened: restart-signal fence/), 120_000, "first emit handled");
      const closedAt = stamp(fence(/\[admission\] closed: restart-signal fence/));
      const reopenedAt = stamp(fence(/\[admission\] reopened: restart-signal fence/));
      const dumpMs = reopenedAt - closedAt;
      expect(
        dumpMs,
        `the heap dump took ${dumpMs} ms; the control needs more than ${kRestartAuthGraceMs} ms, raise kBallastObjects`,
      ).toBeGreaterThan(kRestartAuthGraceMs);
      expect(gw.snapshots().length).toBeGreaterThanOrEqual(1);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      expect(gw.child.exitCode).toBe(null);
      expect(gw.lines.some((line) => /received SIGUSR2; restarting/.test(line))).toBe(false);
      process.kill(-gw.child.pid, "SIGKILL");
      await gw.exit;
    },
    kTestTimeoutMs,
  );
});
