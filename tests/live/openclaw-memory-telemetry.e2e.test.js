const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { kLiveEnabled, mkTemp, scrubTestRunnerEnv } = require("./live-helpers");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { getProcessIdentity } = require("../../lib/server/gateway-memory/process-identity");
const { readGatewayTelemetry } = require("../../lib/server/gateway-memory/telemetry");

// Uses the installed/pinned package, never a moving dist-tag or network install.
// Kept in the opt-in tier because it starts a real OpenClaw gateway.
const describeLive = kLiveEnabled ? describe : describe.skip;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describeLive("live: pinned gateway memory instrumentation", () => {
  it("reports the actual compile-cache worker's heap and allows normal shutdown", async () => {
    const rootDir = mkTemp("alphaclaw-live-memory-telemetry-");
    const stateDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local", port, bind: "loopback", auth: { mode: "none" } },
      plugins: { enabled: false },
    }));
    const packageDir = path.dirname(path.dirname(require.resolve("openclaw")));
    const child = spawn(process.execPath, [path.join(packageDir, "openclaw.mjs"), "gateway", "run"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: withOpenclawStartupEnv({ ...scrubTestRunnerEnv(),
        HOME: rootDir, OPENCLAW_HOME: rootDir, OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"), XDG_CONFIG_HOME: stateDir,
        NODE_COMPILE_CACHE: path.join(rootDir, "compile-cache"),
        OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_NO_AUTO_UPDATE: "1",
        DO_NOT_TRACK: "1",
      }),
    });
    let tail = "";
    child.stdout.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-4000); });
    child.stderr.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-4000); });
    let exited = false;
    const exit = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
    try {
      let telemetry = null;
      let workerPid;
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !exited) {
        const directory = path.join(stateDir, ".alphaclaw", "gateway-memory");
        const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
        for (const filename of files) {
          const match = /^(\d+)-\d+\.json$/.exec(filename);
          if (!match) continue;
          workerPid = Number(match[1]);
          const identity = getProcessIdentity(workerPid);
          telemetry = readGatewayTelemetry({ identity, stateDir });
          if (telemetry.status === "fresh") break;
        }
        if (telemetry?.status === "fresh") break;
        await delay(100);
      }
      expect(telemetry?.status, tail).toBe("fresh");
      expect(workerPid).not.toBe(child.pid);
      expect(telemetry.records.at(-1).heapUsedBytes).toBeGreaterThan(0);
      expect(telemetry.records.at(-1).heapLimitBytes).toBeGreaterThan(telemetry.records.at(-1).heapUsedBytes);
      const launcherIdentity = getProcessIdentity(child.pid);
      expect(readGatewayTelemetry({ identity: launcherIdentity, stateDir }).status).toBe("unavailable");
    } finally {
      try { child.kill("SIGTERM"); } catch {}
      await Promise.race([exit, delay(5000)]);
      if (!exited) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        await Promise.race([exit, delay(1000)]);
      }
    }
    expect(exited).toBe(true);
  }, 55000);
});
