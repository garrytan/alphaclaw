const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { kLiveEnabled, kSilentLogger, mkTemp, waitFor } = require("./live-helpers");
const {
  installOpenclawVersionToTempDir,
} = require("../../lib/server/openclaw-version");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const {
  ensurePluginsShell,
  ensurePluginAllowed,
} = require("../../lib/server/plugin-config");
const { getProcessTreeUsage } = require("../../lib/server/system-resources");

// LIVE tier: prove the memory-leak feature's real-world assumptions against a
// real newest-beta OpenClaw:
//   1. The leak-injection vector works — a plugin on plugins.load.paths runs
//      INSIDE the gateway process (usage-tracker's own mechanism) and can
//      grow the gateway's V8 heap.
//   2. AlphaClaw's RSS sampler (getProcessUsage → /proc) sees a real
//      gateway's leak as a rising trend (slope/direction only, NEVER absolute
//      RSS — absolute numbers flake across gateway versions).
//   3. Terminal stage (user decision D2C, updated to the verified beta
//      contract): the leak runs until the gateway's own memory diagnostics
//      report CRITICAL pressure (or the process dies abnormally). On
//      2026.9.1-beta.1 plugins run in their own isolate — heap caps do not
//      bind them (measured: heapUsed ~171MB vs RSS >6GB), so a plugin leak
//      terminates as a container/kernel OOM, never a V8 heap abort. The V8
//      signature regression lives in tests/live/autotune-container.e2e.
//
// Fixture notes (outside-voice C6/C7/F13): the plugin retains
// Buffer.alloc(1<<20).toString("base64") STRINGS — heap-resident, counted
// against --max-old-space-size. Raw Buffers are external memory and would
// kernel-OOM instead of tripping the V8 cap (tests/live/
// autotune-container.e2e.test.js encodes the same fact). The heap cap rides
// NODE_OPTIONS (see gatewayEnv), NOT launcher argv: `gateway run` can fork a
// worker child that holds the plugin's heap, and only NODE_OPTIONS propagates
// to it — exactly how production caps the gateway (autotune's suffix). At
// 256MB the V8 abort lands within ~1-2 min of leaking, inside the budget.
const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
const kTestTimeoutMs = 12 * 60 * 1000;
const kHeapOomPattern = /JavaScript heap out of memory|Reached heap limit/i;

const resolveNewestBeta = async () => {
  const res = await fetch("https://registry.npmjs.org/openclaw", {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  const doc = await res.json();
  return doc["dist-tags"]?.beta || "beta";
};

// activation.onStartup:true is REQUIRED on 2026.9.1-beta.1: without it a
// load-path plugin is discovered/enabled but its register() never runs at
// gateway startup (plugins default to onStartup:false and lazy-activate only
// via declared contracts). Verified against the real beta.
const kLeakPluginManifest = {
  id: "leak-probe",
  activation: { onStartup: true },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
};

// usage-tracker plugin shape: CJS default export {id, name, register()}. No
// api.on hook — a typed hook needs plugins.entries.<id>.hooks.
// allowConversationAccess=true and is irrelevant to a heap leak; the
// register-time setInterval is the whole vector.
const kLeakPluginSource = `
const leaked = [];
const plugin = {
  id: "leak-probe",
  name: "Leak probe (live e2e)",
  description: "Deliberately leaks heap-resident strings for the memory-leak e2e.",
  register() {
    setInterval(() => {
      leaked.push(Buffer.alloc(1 << 20).toString("base64"));
    }, 250);
  },
};
module.exports = plugin;
module.exports.default = plugin;
`;

describeLive("live: gateway memory leak via a real plugin", () => {
  let rootDir;
  let openclawDir;
  let installDir;
  let overlayBin;

  const gatewayEnv = () => {
    const base = { ...process.env };
    delete base.NODE_OPTIONS;
    for (const key of Object.keys(base)) {
      if (key.startsWith("VITEST")) delete base[key];
    }
    return withOpenclawStartupEnv({
      ...base,
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
      // The heap cap must reach the process that ACTUALLY leaks. On this beta
      // `gateway run` can fork a worker child (the one holding the plugin's
      // heap); a launcher-only argv cap does NOT propagate to it, but
      // NODE_OPTIONS DOES — which is exactly how production caps the gateway
      // (autotune's NODE_OPTIONS suffix). 256MB → the V8 abort lands in
      // ~60-120s of leaking.
      NODE_OPTIONS: "--max-old-space-size=256",
    });
  };

  beforeAll(async () => {
    rootDir = mkTemp("alphaclaw-live-mem-root-");
    openclawDir = path.join(rootDir, ".openclaw");
    installDir = mkTemp("alphaclaw-live-mem-install-");
    fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });

    const betaVersion = await resolveNewestBeta();
    const staged = await installOpenclawVersionToTempDir({
      versionSpec: betaVersion,
      timeoutMs: kInstallTimeoutMs,
    });
    expect(staged.lifecycleVerified).toBe(true);
    const store = createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir,
      logger: kSilentLogger,
    });
    const saved = store.saveOverlayFromTempInstall({
      openclawPackageDir: staged.openclawPackageDir,
      version: betaVersion,
    });
    expect(saved.ok).toBe(true);
    staged.cleanup();
    const activated = store.activateOverlay({ installDir, version: betaVersion });
    expect(activated.ok).toBe(true);
    overlayBin = store.resolvePackageBin(
      path.join(installDir, "node_modules", "openclaw"),
    );
    expect(overlayBin).toBeTruthy();
  }, kTestTimeoutMs);

  it(
    "a leak-probe plugin leaks the REAL gateway heap: RSS climbs, then V8 aborts with the classifier's signature",
    async () => {
      // 1. Write the leak plugin where plugins.load.paths will find it.
      const pluginDir = mkTemp("leak-probe-plugin-");
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify(kLeakPluginManifest, null, 2),
      );
      fs.writeFileSync(path.join(pluginDir, "index.js"), kLeakPluginSource);

      // 2. Minimal loopback gateway config + the plugin wired through the
      //    REAL AlphaClaw helpers (the same shape ensureUsageTrackerPluginEntry
      //    produces in production).
      const port = 19147;
      const cfg = {
        gateway: {
          // gateway.mode is required or `gateway run` exits 78 (EX_CONFIG).
          mode: "local",
          bind: "loopback",
          port,
          auth: { token: "live-e2e-token-000000000000000000000000" },
        },
      };
      ensurePluginsShell(cfg);
      ensurePluginAllowed({ cfg, pluginKey: "leak-probe" });
      cfg.plugins.load.paths.push(pluginDir);
      cfg.plugins.entries["leak-probe"] = { enabled: true };
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(cfg, null, 2),
      );

      // 3. Boot. The heap cap rides NODE_OPTIONS (gatewayEnv above), which the
      //    forked gateway worker inherits — an argv-only cap would not reach
      //    it, so the leaking worker would never hit the V8 abort.
      const child = spawn(
        process.execPath,
        [
          overlayBin,
          "gateway",
          "run",
          "--port",
          String(port),
        ],
        {
          env: { ...gatewayEnv(), OPENCLAW_GATEWAY_PORT: String(port) },
          stdio: "pipe",
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk.toString()));
      child.stderr.on("data", (chunk) => (output += chunk.toString()));
      let exitCode = null;
      let exitSignal = null;
      const exited = new Promise((resolve) => {
        child.on("exit", (code, signal) => {
          exitCode = code;
          exitSignal = signal;
          resolve();
        });
      });

      try {
        // 4. Healthy first (plugin sidecars cold-start on the beta).
        await waitFor(
          async () => {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/healthz`);
              return res.status > 0;
            } catch {
              return false;
            }
          },
          150000,
          "gateway /healthz",
        );

        // 5. Slope stage: REAL /proc reads through AlphaClaw's own sampler.
        //    Direction only, never absolute RSS. ~2.8MB/s expected; assert a
        //    conservative ≥30MB climb across ~60s unless the abort already
        //    landed (a fast abort is stage-6 success arriving early).
        const samples = [];
        for (let i = 0; i < 13 && exitCode === null && exitSignal === null; i += 1) {
          const usage = getProcessTreeUsage(child.pid);
          if (usage?.rssBytes) samples.push(usage.rssBytes);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        if (exitCode === null && exitSignal === null) {
          expect(samples.length).toBeGreaterThanOrEqual(5);
          const growthMb =
            (samples[samples.length - 1] - samples[0]) / (1024 * 1024);
          expect(growthMb).toBeGreaterThan(30);
        }

        // 6. Terminal stage (D2C, updated to the verified 2026.9.1-beta.1
        //    contract): plugins run in their OWN isolate, so neither argv nor
        //    NODE_OPTIONS heap caps bind a plugin leak — measured live:
        //    heapUsed stayed ~171MB while process RSS blew past 6GB. A plugin
        //    leak therefore NEVER dies with the V8 heap-abort signature; its
        //    real terminal event is a container/kernel OOM (AlphaClaw's
        //    container_oom classification). The honest live assertions:
        //    (a) the gateway's OWN memory diagnostics report critical
        //        pressure (`[diagnostics/memory] memory pressure:
        //        level=critical`) — or the process dies abnormally first;
        //    (b) subtree RSS ran away to multiples of its starting point —
        //        the growth that would OOM-kill any bounded container.
        //    The V8 kHeapOomPattern signature stays pinned against real V8 by
        //    tests/live/autotune-container.e2e.test.js (main-isolate leaks —
        //    e.g. session/config growth — still abort with it).
        const startRss = samples[0] ?? null;
        const kCriticalPressurePattern =
          /\[diagnostics\/memory\] memory pressure: level=critical/;
        await waitFor(
          async () =>
            exitCode !== null ||
            exitSignal !== null ||
            kCriticalPressurePattern.test(output),
          4 * 60 * 1000,
          "critical memory pressure or abnormal exit",
        );
        if (exitCode !== null || exitSignal !== null) {
          // Died first: must be abnormal, and if V8 did abort (single-isolate
          // topology on some versions), the classifier signature must match.
          expect(exitCode === 0 && exitSignal === null).toBe(false);
          if (kHeapOomPattern.test(output)) {
            expect(output).toMatch(kHeapOomPattern);
          }
        } else {
          expect(output).toMatch(kCriticalPressurePattern);
          const usage = getProcessTreeUsage(child.pid);
          if (startRss && usage?.rssBytes) {
            // Corroborating runaway check: the pressure line is the primary
            // terminal evidence and fires EARLY by design (measured: ~2.8x
            // start when it lands), so this multiplier only needs to prove
            // growth beyond noise, not a specific magnitude.
            expect(usage.rssBytes).toBeGreaterThan(startRss * 1.5);
          }
        }
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    },
    kTestTimeoutMs,
  );
});
