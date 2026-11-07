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

// LIVE tier: the pinned OpenClaw loads <state dir>/.env into the gateway's
// process.env (AlphaClaw links it to its own .env), and every worker it spawns
// inherits that. A SETUP_PASSWORD or platform token written in .env must still
// reach no OpenClaw process. Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/gateway-dotenv-secrets.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 6 * 60 * 1000;
const kPort = 18993;

const readProcEnviron = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
  } catch {
    return null;
  }
};

describeLive("live: secrets in .env never reach OpenClaw's processes", () => {
  it(
    "the gateway and its workers carry no setup password or platform token from .env",
    async () => {
      const rootDir = mkTemp("alphaclaw-live-dotenv-");
      const openclawDir = path.join(rootDir, ".openclaw");
      fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          gateway: {
            mode: "local",
            bind: "loopback",
            port: kPort,
            auth: { token: "live-e2e-token-000000000000000000000000" },
          },
        }),
      );
      const envFile = path.join(rootDir, ".env");
      fs.writeFileSync(envFile, "SETUP_PASSWORD=dotenv-sentinel-setup\nRAILWAY_TOKEN=dotenv-sentinel-railway\n");
      fs.symlinkSync(envFile, path.join(openclawDir, ".env"));

      const source = withOpenclawStartupEnv({
        ...scrubTestRunnerEnv(),
        HOME: rootDir,
        OPENCLAW_HOME: rootDir,
        OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: openclawDir,
        XDG_CONFIG_HOME: openclawDir,
        OPENCLAW_NO_AUTO_UPDATE: "1",
        OPENCLAW_GATEWAY_PORT: String(kPort),
      });
      const quiet = { log: () => {}, warn: () => {} };
      const env = blankDeniedGatewayEnvKeys(filterGatewayChildEnv(source, { logger: quiet }));

      const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
      const child = spawn(process.execPath, [build.bin, "gateway", "run", "--port", String(kPort)], {
        env,
        cwd: rootDir,
        stdio: "ignore",
        detached: true,
      });
      try {
        await waitFor(
          async () => {
            try {
              return (await fetch(`http://127.0.0.1:${kPort}/healthz`)).ok;
            } catch {
              return false;
            }
          },
          150000,
          "gateway /healthz",
        );
        const marker = `OPENCLAW_STATE_DIR=${openclawDir}`;
        const findProcesses = () =>
          fs
            .readdirSync("/proc")
            .filter((entry) => /^\d+$/.test(entry))
            .map((pid) => ({ pid, environ: readProcEnviron(pid) }))
            .filter(({ environ }) => environ && environ.includes(marker));
        await waitFor(async () => findProcesses().length >= 2, 60000, "gateway workers");

        const processes = findProcesses();
        expect(processes.length).toBeGreaterThanOrEqual(2);
        const leaking = processes.filter(({ environ }) => environ.join("\n").includes("dotenv-sentinel"));
        expect(leaking.map(({ pid }) => pid)).toEqual([]);
        for (const { environ } of processes) expect(environ).toContain("SETUP_PASSWORD=");
      } finally {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    },
    kTestTimeoutMs,
  );
});
