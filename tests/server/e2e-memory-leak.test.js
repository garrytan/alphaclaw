// Real-process memory-leak detection e2e: a REAL Node child that leaks
// HEAP-RESIDENT strings (Buffer.alloc(..).toString("base64") — raw Buffers
// are external memory outside V8 old-space and would prove nothing about a
// heap cap), launched through the REAL lib/server/gateway.js PATH-shim path,
// sampled through the REAL /proc reader (system-resources.getProcessUsage),
// detected by the REAL watchdog memory tick with a shrunk detector config.
// This is the whole chain — spawn → /proc → detector → event/notification →
// (opt-in) mitigation — with no fakes between the process and the verdict.
//
// Linux-only: the default RSS reader is /proc-backed (the macOS `ps`
// fallback is memoized at 5s — useless at this test's cadence). CI runs
// Linux; the detector math itself is covered cross-platform in
// gateway-memory-monitor.test.js.

const fs = require("fs");
const os = require("os");
const path = require("path");

const kTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-mem-e2e-"));
process.env.ALPHACLAW_ROOT_DIR = kTmpRoot;

const { OPENCLAW_DIR } = require("../../lib/server/constants");

if (!OPENCLAW_DIR.startsWith(kTmpRoot)) {
  throw new Error(
    `constants.js captured OPENCLAW_DIR=${OPENCLAW_DIR}; expected it under ${kTmpRoot}. ` +
      "ALPHACLAW_ROOT_DIR must be set before any lib/server require.",
  );
}

const { createWatchdog } = require("../../lib/server/watchdog");
const { getProcessUsage } = require("../../lib/server/system-resources");

const kGatewayModulePath = require.resolve("../../lib/server/gateway");
const loadGateway = () => {
  delete require.cache[kGatewayModulePath];
  return require(kGatewayModulePath);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Leaks ~10MB/s of V8 HEAP (base64 strings retained in a module array) and
// prints the "listening on" line the gateway launcher scans for. Markers via
// fs.writeSync(1, ...) — console.log to a pipe is async and can be lost.
const kLeakerSource = `
const fs = require("fs");
fs.writeSync(1, "gateway listening on 127.0.0.1\\n");
const leaked = [];
setInterval(() => {
  leaked.push(Buffer.alloc(1 << 20).toString("base64"));
}, 100);
`;

// Shrunk detector config: 4s window at ~200ms sampling. The REAL constants
// are pinned by gateway-memory-monitor.test.js; this run proves the chain,
// not the durations.
const kFastDetectorConfig = {
  windowMs: 4000,
  bucketCount: 4,
  minSamples: 6,
  minCoverageFraction: 0.5,
  minGrowthMb: 10,
  startupGraceMs: 0,
  confirmEvals: 2,
  clearEvals: 3,
  caplessSlopeMbPerHour: 1,
  fastPathConfirmEvals: 2,
};

describe.skipIf(process.platform !== "linux")(
  "memory-leak detection e2e (real leaking child, real /proc reads)",
  () => {
    let caseDir = null;
    let originalPath = null;
    let gateway = null;
    let trackedPids = null;

    const installOpenclawShim = () => {
      const binDir = path.join(caseDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const leakerPath = path.join(caseDir, "leaker.js");
      fs.writeFileSync(leakerPath, kLeakerSource);
      const shimPath = path.join(binDir, "openclaw");
      fs.writeFileSync(
        shimPath,
        `#!/bin/sh
if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then
  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(leakerPath)}
fi
exit 0
`,
        { mode: 0o755 },
      );
      process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
    };

    const createHarness = ({
      settings,
      restartGatewayForMitigation = null,
      readMemorySample,
    }) => {
      const insertWatchdogEvent = vi.fn();
      const notifier = { notify: vi.fn(async () => ({ ok: true })) };
      const watchdog = createWatchdog({
        clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
        launchGatewayProcess: vi.fn(),
        insertWatchdogEvent,
        notifier,
        readEnvFile: vi.fn(() => []),
        writeEnvFile: vi.fn(),
        reloadEnv: vi.fn(),
        resolveSetupUrl: () => "http://localhost:3000",
        sleepImpl: () => Promise.resolve(),
        readMemorySample,
        readMemorySettings: () => settings,
        memoryMonitorConfig: kFastDetectorConfig,
        restartGatewayForMitigation,
        memoryMitigationStatePath: path.join(caseDir, "mitigation-state.json"),
      });
      return { watchdog, insertWatchdogEvent, notifier };
    };

    const launchLeakingGateway = async () => {
      installOpenclawShim();
      gateway = loadGateway();
      const child = await gateway.launchGatewayProcess();
      expect(child?.pid).toBeGreaterThan(0);
      trackedPids.push(child.pid);
      return child;
    };

    // Drives the REAL memory tick at ~200ms until the predicate holds.
    const pollTicks = async (watchdog, predicate, { timeoutMs = 20000 } = {}) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await watchdog.checkMemoryTrend();
        if (predicate()) return;
        await sleep(200);
      }
      throw new Error("timed out waiting for the memory detector");
    };

    beforeEach(() => {
      originalPath = process.env.PATH;
      trackedPids = [];
      caseDir = fs.mkdtempSync(path.join(kTmpRoot, "case-"));
      fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(OPENCLAW_DIR, "openclaw.json"),
        JSON.stringify({
          gateway: { port: 41000 + Math.floor(Math.random() * 2000) },
          channels: {},
        }),
      );
    });

    afterEach(() => {
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

    it("detects a real heap leak end-to-end: /proc RSS climb → latched event + notification", async () => {
      const child = await launchLeakingGateway();
      const harness = createHarness({
        settings: {
          enabled: true,
          autoRestart: false,
          effectiveAutoRestart: false,
        },
        // Capless on purpose: the sandbox's own cgroup numbers include every
        // co-resident test process, so the deterministic path here is the
        // pure slope branch fed by REAL /proc reads of the leaking child.
        readMemorySample: (pid) => ({
          rssBytes: getProcessUsage(pid)?.rssBytes ?? null,
        }),
      });
      harness.watchdog.onGatewayLaunch({
        pid: child.pid,
        startedAt: Date.now(),
      });

      await pollTicks(
        harness.watchdog,
        () =>
          ["leak_suspected", "critical"].includes(
            harness.watchdog.getMemoryTrend().state,
          ),
      );

      const memoryEvents = harness.insertWatchdogEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.eventType === "memory");
      const latched = memoryEvents.find(
        (event) => event.details.kind === "leak_suspected",
      );
      expect(latched).toBeTruthy();
      expect(latched.details.episodeId).toMatch(/^\d+-\d+$/);
      expect(latched.details.slopeMbPerHour).toBeGreaterThan(0);
      const trend = harness.watchdog.getMemoryTrend();
      expect(trend.rssMb).toBeGreaterThan(0);
      expect(
        harness.notifier.notify.mock.calls.some(([message]) =>
          message.includes("memory rising"),
        ),
      ).toBe(true);
      expect(harness.watchdog.getStatus().memory.trendState).toBe(
        trend.state,
      );
    }, 30000);

    it("opt-in mitigation fires against a real leak crossing a real cap", async () => {
      const child = await launchLeakingGateway();
      const restart = vi.fn(async () => ({ ok: true }));
      // Cap pinned just above the child's launch RSS so the fast-pressure
      // path crosses 90% within a few real samples. RSS itself stays REAL.
      let capBytes = null;
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        readMemorySample: (pid) => {
          const rssBytes = getProcessUsage(pid)?.rssBytes ?? null;
          if (rssBytes && capBytes === null) {
            capBytes = rssBytes + 20 * 1024 * 1024;
          }
          return {
            rssBytes,
            cgroupUsedBytes: rssBytes,
            containerLimitBytes: capBytes,
          };
        },
      });
      harness.watchdog.onGatewayLaunch({
        pid: child.pid,
        startedAt: Date.now(),
      });

      await pollTicks(harness.watchdog, () => restart.mock.calls.length > 0);

      const memoryEvents = harness.insertWatchdogEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.eventType === "memory");
      expect(
        memoryEvents.some((event) => event.details.kind === "mitigation_restart"),
      ).toBe(true);
      expect(restart).toHaveBeenCalledTimes(1);
      // The persisted brake survives this "process" (fast-path re-latch
      // protection): the state file holds the restart timestamp.
      const persisted = JSON.parse(
        fs.readFileSync(path.join(caseDir, "mitigation-state.json"), "utf8"),
      );
      expect(persisted.restarts).toHaveLength(1);
      // Failure semantics (a FAILED restart settles the expected-restart
      // window immediately) are pinned hermetically in
      // watchdog-memory.test.js — no need to re-prove them at e2e cost.
    }, 30000);
  },
);
