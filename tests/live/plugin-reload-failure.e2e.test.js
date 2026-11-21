const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// A ready gateway is probed every WATCHDOG_CHECK_INTERVAL (120 s by default,
// read when constants.js loads), so the first failed /readyz can arrive up to
// two minutes after the reload fails. 30 s, the floor, keeps the run short.
process.env.WATCHDOG_CHECK_INTERVAL = "30";
const { startGatewayCapture, waitForGatewayReady, stopGatewayCapture } = require("./memory-gateway");
const { kLiveEnabled, mkTemp, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { ensurePluginsShell, ensurePluginAllowed } = require("../../lib/server/plugin-config");
const { probeGatewayReadiness } = require("../../lib/server/gateway-readiness");
const { createWatchdog } = require("../../lib/server/watchdog");

// LIVE tier (GST-3345): the pinned OpenClaw gives each plugin service start
// 5 s during a hot reload (PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS in
// dist/services-*.mjs) and no deadline at boot. A plugin whose service takes
// 8 s to start therefore boots fine, but any plugins.entries change makes the
// gateway hot-reload it, time out, fail to restore it, and keep /readyz at
// 503 failing:["plugin-reload"] with pluginReload.phase "failed" (phases
// reloading and recovering first) until a restart. This holds that contract
// and drives the real watchdog against it: one restart with source
// `watchdog` and reason `plugin_reload_failed`, after which the freshly
// booted gateway is ready. Wintermute hit the same shape with memory-core's
// dreaming service on 2026-11-21.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 8 * 60 * 1000;
const kPort = 19173;

const kSlowPluginManifest = {
  id: "slow-service",
  activation: { onStartup: true },
  configSchema: { type: "object", additionalProperties: false, properties: { nonce: { type: "number" } } },
};
const kSlowPluginSource = `
const plugin = {
  id: "slow-service",
  name: "Slow service probe (live e2e)",
  description: "A plugin service that takes 8 s to start.",
  register(api) {
    api.registerService({
      id: "slow",
      start: async () => { await new Promise((resolve) => setTimeout(resolve, 8000)); },
      stop: async () => {},
    });
  },
};
module.exports = plugin;
module.exports.default = plugin;
`;

describeLive("live: a failed plugin hot reload and the watchdog's one restart", () => {
  let rootDir;
  let openclawDir;
  let pinBin;
  let gateway = null;
  let watchdog = null;

  const gatewayEnv = () =>
    withOpenclawStartupEnv({
      ...scrubTestRunnerEnv(),
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    });
  const readyz = () => probeGatewayReadiness({ url: `http://127.0.0.1:${kPort}/readyz` });

  beforeAll(() => {
    rootDir = mkTemp("alphaclaw-live-plugin-reload-");
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
    expect(build?.version).toBe(require("../../package.json").dependencies.openclaw);
    pinBin = build.bin;
  });

  const kSavedEnv = {
    WATCHDOG_AUTO_REPAIR: process.env.WATCHDOG_AUTO_REPAIR,
    WATCHDOG_NOTIFICATIONS_DISABLED: process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
  };
  afterAll(async () => {
    watchdog?.stop();
    await stopGatewayCapture(gateway);
    for (const [key, value] of Object.entries(kSavedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(
    "a plugin service slower than 5 s fails its hot reload and leaves /readyz failed until the watchdog restarts the gateway once",
    { timeout: kTestTimeoutMs, retry: 0 },
    async () => {
      const pluginDir = mkTemp("slow-service-plugin-");
      fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(kSlowPluginManifest, null, 2));
      fs.writeFileSync(path.join(pluginDir, "index.js"), kSlowPluginSource);
      const cfg = {
        gateway: { mode: "local", bind: "loopback", port: kPort, auth: { token: "live-e2e-token-000000000000000000000000" } },
      };
      ensurePluginsShell(cfg);
      ensurePluginAllowed({ cfg, pluginKey: "slow-service" });
      cfg.plugins.load.paths.push(pluginDir);
      cfg.plugins.entries["slow-service"] = { enabled: true, config: { nonce: 1 } };
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

      const phases = [];
      let restarts = 0;
      const restartGatewayColdStart = vi.fn(async () => {
        await stopGatewayCapture(gateway);
        gateway = startGatewayCapture({ bin: pinBin, port: kPort, env: gatewayEnv() });
        await waitForGatewayReady(gateway, kPort);
        restarts += 1;
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: gateway.child.pid, rootPid: gateway.child.pid, generation: 1 + restarts });
        return { ok: true };
      });
      const notifier = { notify: vi.fn(async () => ({ ok: true })) };
      const insertWatchdogEvent = vi.fn();

      try {
        // 1. Boot: the 8 s service start has no deadline, so the gateway is ready.
        gateway = startGatewayCapture({ bin: pinBin, port: kPort, env: gatewayEnv() });
        await waitForGatewayReady(gateway, kPort);
        await waitFor(async () => (await readyz()).ready === true, 90_000, "first /readyz ready");

        process.env.WATCHDOG_AUTO_REPAIR = "true";
        process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
        watchdog = createWatchdog({
          clawCmd: vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true }) })),
          launchGatewayProcess: vi.fn(() => null),
          insertWatchdogEvent,
          notifier,
          readEnvFile: () => [],
          writeEnvFile: () => {},
          reloadEnv: () => {},
          resolveSetupUrl: () => "https://setup.example.com",
          resolveGatewayHealthUrl: () => `http://127.0.0.1:${kPort}/health`,
          resolveGatewayReadyzUrl: () => `http://127.0.0.1:${kPort}/readyz`,
          supervisorModeActive: () => false,
          restartGatewayColdStart,
          readOpenclawConfigFingerprint: () => crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex"),
        });
        watchdog.start();
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: gateway.child.pid, rootPid: gateway.child.pid, generation: 1 });
        await waitFor(() => watchdog.getStatus().readiness === "ready", 60_000, "watchdog reads ready");

        // 2. Any plugins.entries change hot-reloads the plugin; its service
        //    start times out after 5 s and the reload fails.
        cfg.plugins.entries["slow-service"].config.nonce = 2;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        await waitFor(async () => {
          const observation = await readyz();
          if (observation.pluginReload?.phase) phases.push(observation.pluginReload.phase);
          return observation.pluginReload?.phase === "failed";
        }, 90_000, "/readyz pluginReload.phase failed");
        expect(phases.some((phase) => phase === "reloading" || phase === "recovering")).toBe(true);
        const failed = await readyz();
        expect(failed).toMatchObject({
          kind: "not_ready",
          httpStatus: 503,
          failing: ["plugin-reload"],
          unreadyReason: "components",
          pluginReload: { phase: "failed", pluginIds: ["slow-service"] },
        });
        expect(restartGatewayColdStart).not.toHaveBeenCalled();

        // 3. The watchdog confirms the failure for 30 s, then restarts once.
        //    The fresh boot has no service deadline, so it comes up ready.
        await waitFor(() => restartGatewayColdStart.mock.calls.length === 1, 150_000, "the watchdog's restart");
        expect(restartGatewayColdStart).toHaveBeenCalledWith(
          expect.objectContaining({ source: "watchdog", reason: "plugin_reload_failed" }),
        );
        const started = insertWatchdogEvent.mock.calls
          .map(([event]) => event)
          .find((event) => event.eventType === "repair" && event.status === "started");
        expect(started.details.failedForMs).toBeGreaterThanOrEqual(30_000);
        await waitFor(async () => (await readyz()).ready === true, 90_000, "/readyz ready after the restart");
        await waitFor(() => watchdog.getStatus().readiness === "ready", 120_000, "watchdog reads ready after the restart");
        expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
      } catch (error) {
        const status = watchdog?.getStatus();
        error.message += `\nwatchdog: readiness=${status?.readiness} health=${status?.health} lifecycle=${status?.lifecycle} reason=${status?.readinessReason}`;
        error.message += `\nrepair rows: ${JSON.stringify(insertWatchdogEvent.mock.calls.map(([event]) => event).filter((event) => event.eventType === "repair"))}`;
        error.message += `\nphases seen: ${phases.join(",")}\ngateway log tail:\n${gateway?.output.slice(-6000) ?? ""}`;
        throw error;
      }
    },
  );
});
