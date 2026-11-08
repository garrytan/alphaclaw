const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const {
  blankDeniedGatewayEnvKeys,
  filterGatewayChildEnv,
} = require("../../lib/server/gateway-env-policy");

// LIVE tier: under a systemd hint, the pinned OpenClaw's gateway .env loader
// overrides (or deletes) every key OPENCLAW_SERVICE_MANAGED_ENV_KEYS names,
// and the agent can write both into <state dir>/.env (AlphaClaw links it to
// its own .env). A locked key's deployment value must survive that. Each
// gateway process records its own process.env through a preload, because
// /proc/<pid>/environ only shows the environment a process started with. Run:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/gateway-locked-env.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 8 * 60 * 1000;
const kLockedKeys = ["WM_GUARDS_DISABLE"];

const kScenarios = [
  {
    name: "an uppercase managed list and hint in .env, also loaded into AlphaClaw's process.env",
    port: 18994,
    dotenv: ["OPENCLAW_SYSTEMD_UNIT=x.service", "OPENCLAW_SERVICE_MANAGED_ENV_KEYS=WM_GUARDS_DISABLE", "WM_GUARDS_DISABLE=1"],
    overlay: { OPENCLAW_SYSTEMD_UNIT: "x.service", OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "WM_GUARDS_DISABLE" },
  },
  {
    name: "a lowercase managed list and hint in .env only",
    port: 18995,
    dotenv: ["OPENCLAW_SYSTEMD_UNIT=x.service", "openclaw_service_managed_env_keys=WM_GUARDS_DISABLE", "WM_GUARDS_DISABLE=1"],
    overlay: {},
  },
  {
    name: "a lowercase managed list and hint in .env with no value for the key (the delete path)",
    port: 18996,
    dotenv: ["OPENCLAW_SYSTEMD_UNIT=x.service", "openclaw_service_managed_env_keys=WM_GUARDS_DISABLE"],
    overlay: {},
  },
];

const bootAndRecord = async ({ port, dotenv, overlay }) => {
  const rootDir = mkTemp("alphaclaw-live-locked-env-");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { token: "live-e2e-token-000000000000000000000000" },
      },
    }),
  );
  const envFile = path.join(rootDir, ".env");
  fs.writeFileSync(envFile, dotenv.join("\n") + "\n");
  fs.symlinkSync(envFile, path.join(openclawDir, ".env"));

  const recordFile = path.join(rootDir, "env-record.jsonl");
  const probe = path.join(rootDir, "env-probe.mjs");
  fs.writeFileSync(
    probe,
    [
      'import fs from "node:fs";',
      "const record = () => {",
      "  try {",
      "    fs.appendFileSync(" + JSON.stringify(recordFile) + ", JSON.stringify({",
      "      pid: process.pid,",
      '      has: Object.prototype.hasOwnProperty.call(process.env, "WM_GUARDS_DISABLE"),',
      "      value: process.env.WM_GUARDS_DISABLE ?? null,",
      '    }) + "\\n");',
      "  } catch {}",
      "};",
      "setInterval(record, 1000).unref();",
      'process.on("exit", record);',
    ].join("\n"),
  );

  const source = withOpenclawStartupEnv({
    ...scrubTestRunnerEnv(),
    HOME: rootDir,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: openclawDir,
    XDG_CONFIG_HOME: openclawDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_GATEWAY_PORT: String(port),
    WM_GUARDS_DISABLE: "0",
    ...overlay,
  });
  const quiet = { log: () => {}, warn: () => {} };
  const env = blankDeniedGatewayEnvKeys(
    filterGatewayChildEnv(source, { logger: quiet, lockedKeys: kLockedKeys }),
    { lockedKeys: kLockedKeys },
  );
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--import " + probe].filter(Boolean).join(" ");

  const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
  const child = spawn(process.execPath, [build.bin, "gateway", "run", "--port", String(port)], {
    env,
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitFor(
      async () => {
        try {
          return (await fetch("http://127.0.0.1:" + port + "/healthz")).ok;
        } catch {
          return false;
        }
      },
      150000,
      "gateway /healthz",
    );
    const readSize = () => (fs.existsSync(recordFile) ? fs.readFileSync(recordFile, "utf8").length : 0);
    const readyAt = readSize();
    await waitFor(async () => readSize() > readyAt + 200, 30000, "env records after ready");
    return fs
      .readFileSync(recordFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
};

describeLive("live: a locked env key survives OpenClaw's service-managed .env override", () => {
  for (const scenario of kScenarios) {
    it(
      "keeps the deployment's WM_GUARDS_DISABLE=0 with " + scenario.name,
      async () => {
        const records = await bootAndRecord(scenario);
        expect(records.length).toBeGreaterThan(0);
        expect(records.filter((record) => record.value !== "0")).toEqual([]);
      },
      kTestTimeoutMs,
    );
  }
});
