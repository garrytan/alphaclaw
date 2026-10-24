const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

// A budgetMb PUT reaches the cap the watchdog enforces: the route, the
// alphaclaw.json writer, the watchdog's settings read and the memory monitor
// all wired as lib/server.js wires them, on one temp OPENCLAW_DIR.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-budget-write-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");
const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");
const { readWatchdogMemorySettings, updateWatchdogMemorySettings } = require("../../lib/server/alphaclaw-config");

const kMb = 1024 * 1024;
const kStartMs = 1_700_000_000_000;
const kTickMs = 60_000;
const kContainerLimitMb = 5120;

const createStack = () => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
  const openclawDir = fs.mkdtempSync(path.join(kTempRoot, "openclaw-"));
  const readSettings = () => readWatchdogMemorySettings({ openclawDir });
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    probeGatewayTcp: async () => ({ running: true }),
    insertWatchdogEvent: vi.fn(),
    notifier: { notify: vi.fn(async () => ({ ok: true })) },
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readMemorySample: () => ({
      rssBasis: "worker", rssBytes: 1000 * kMb, groupRssBytes: 1000 * kMb,
      cgroupUsedBytes: 1500 * kMb, containerLimitBytes: kContainerLimitMb * kMb, hostTotalBytes: 16384 * kMb,
    }),
    readMemorySettings: readSettings,
    memoryMitigationStatePath: path.join(openclawDir, "memory-mitigation-state.json"),
  });
  watchdog.onGatewayLaunch({ pid: 4242, startedAt: Date.now() });
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    watchdog,
    watchdogNotifier: { notify: vi.fn() },
    getRecentEvents: vi.fn(() => []),
    readLogTail: vi.fn(() => ""),
    watchdogTerminal: {},
    readWatchdogMemorySettings: readSettings,
    updateWatchdogMemorySettings: ({ enabled, autoRestart, budgetMb, maxRestartsPerDay }) =>
      updateWatchdogMemorySettings({ openclawDir, enabled, autoRestart, budgetMb, maxRestartsPerDay }),
  });
  return { watchdog, app, openclawDir };
};

let tick = 0;
const runTick = async (watchdog) => {
  tick += 1;
  vi.setSystemTime(kStartMs + tick * kTickMs);
  await watchdog.checkMemoryTrend();
};

describe("watchdog.memory.budgetMb write → enforced cap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kStartMs);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("a budget above the derived share is stored, reported and used by the next evaluation", async () => {
    const { watchdog, app, openclawDir } = createStack();
    await runTick(watchdog);
    expect(watchdog.getMemoryTrend()).toMatchObject({ effectiveCapMb: 3840, capSource: "container_share" });

    const put = await request(app).put("/api/watchdog/memory").send({ budgetMb: 4500, maxRestartsPerDay: 5 });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({ budgetMb: 4500, maxRestartsPerDay: 5 });
    expect(put.body.effectiveCap).toMatchObject({
      effectiveCapMb: 4500, capSource: "budget", appliesFrom: "next_evaluation", reason: null,
      lastEvaluated: { effectiveCapMb: 3840, capSource: "container_share" },
    });
    const stored = JSON.parse(fs.readFileSync(path.join(openclawDir, "alphaclaw.json"), "utf8"));
    expect(stored.watchdog.memory).toMatchObject({ budgetMb: 4500, maxRestartsPerDay: 5 });

    await runTick(watchdog);
    expect(watchdog.getMemoryTrend()).toMatchObject({ effectiveCapMb: 4500, capSource: "budget" });
    const get = await request(app).get("/api/watchdog/memory");
    expect(get.body.settings.budgetMb).toBe(4500);
    expect(get.body.effectiveCap).toMatchObject({
      effectiveCapMb: 4500, capSource: "budget", lastEvaluated: { effectiveCapMb: 4500, capSource: "budget" },
    });

    const cleared = await request(app).put("/api/watchdog/memory").send({ budgetMb: null });
    expect(cleared.body.settings.budgetMb).toBeNull();
    expect(cleared.body.effectiveCap).toMatchObject({ effectiveCapMb: 3840, capSource: "container_share", capPhysicalMb: kContainerLimitMb, capFraction: 0.75 });
    await runTick(watchdog);
    expect(watchdog.getMemoryTrend()).toMatchObject({ effectiveCapMb: 3840, capSource: "container_share" });
  });

  it("a stored budget with detection off says the watchdog is not enforcing it", async () => {
    const { app } = createStack();
    const res = await request(app).put("/api/watchdog/memory").send({ enabled: false, budgetMb: 4500 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ enabled: false, budgetMb: 4500 });
    expect(res.body.effectiveCap).toMatchObject({ effectiveCapMb: 4500, capSource: "budget", reason: "detection_disabled" });
  });
});
