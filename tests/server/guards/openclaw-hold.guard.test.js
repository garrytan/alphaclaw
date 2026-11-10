// A deliberate OpenClaw hold never goes critical (GST-2293). A deployment
// that keeps OpenClaw below AlphaClaw's pin on purpose (an exact
// `overrides.openclaw` in its own package.json, the Render template's way)
// boots consistent: no version_mismatch event, no incident, no notification.
// A version nobody declared, or a hold below the supported floor, still opens
// a critical version_mismatch incident and notifies. End to end over the real
// install-tree reader, runtime, boot report, watchdog and incident tracker;
// only the OpenClaw state DBs and the notifiers are stand-ins.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createOpenclawRuntime } = require("../../../lib/server/openclaw-runtime");
const { kOpenclawHoldFloor, readOpenclawHold, describeOpenclawPin } = require("../../../lib/server/openclaw-pin-state");
const { resolveSelfDependency } = require("../../../lib/server/self-dependency");
const { buildBinPhaseReport, createBootReportWriter } = require("../../../lib/server/boot-report");
const { createBootReportSteps } = require("../../../lib/server/boot-report-steps");
const { createWatchdog } = require("../../../lib/server/watchdog");
const { createWatchdogIncidentTracker } = require("../../../lib/server/watchdog-incidents");
const { compareVersionParts } = require("../../../lib/server/helpers");

const kPin = "2026.11.2";
const kBootId = "40:1700000000000";
const silent = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const loadWatchdogDb = () => {
  const modulePath = require.resolve("../../../lib/server/db/watchdog");
  delete require.cache[modulePath];
  return require(modulePath);
};

// /app the way the template builds it: the app package.json depends on
// AlphaClaw and may hold OpenClaw; node_modules has both packages.
const createBox = ({ hold, installed }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-hold-guard-"));
  const app = path.join(root, "app");
  const alphaclawDir = path.join(app, "node_modules", "alphaclaw");
  const openclawPackageDir = path.join(app, "node_modules", "openclaw");
  const openclawDir = path.join(root, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  for (const dir of [alphaclawDir, openclawPackageDir, managedDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({
      name: "openclaw-render",
      dependencies: { alphaclaw: "git+https://github.com/garrytan/alphaclaw.git#abc" },
      ...(hold ? { overrides: { openclaw: hold } } : {}),
    }),
  );
  fs.writeFileSync(path.join(alphaclawDir, "package.json"), JSON.stringify({ name: "alphaclaw", dependencies: { openclaw: kPin } }));
  fs.writeFileSync(
    path.join(openclawPackageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: installed, bin: { openclaw: "openclaw.mjs" } }),
  );
  fs.writeFileSync(path.join(openclawPackageDir, "openclaw.mjs"), "");
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  return { root, app, alphaclawDir, openclawDir, managedDir };
};

const bootBox = async ({ hold, installed }) => {
  const box = createBox({ hold, installed });
  const heldVersion = readOpenclawHold({ resolveDependency: () => resolveSelfDependency({ startDir: box.alphaclawDir }) });
  const runtime = createOpenclawRuntime({
    packageRoot: box.alphaclawDir,
    resolveInstallDir: () => box.app,
    readHeldVersion: () => heldVersion,
    openclawDir: box.openclawDir,
    managedDir: box.managedDir,
    logger: silent,
  });
  const info = runtime.getInfo();

  const db = loadWatchdogDb();
  db.initWatchdogDb({ rootDir: box.root, pruneDays: 30 });
  let watchdog = null;
  const tracker = createWatchdogIncidentTracker({ db, getStatus: () => watchdog?.getStatus() ?? null, logger: silent });
  const insertWatchdogEvent = tracker.wrapInsertEvent(db.insertWatchdogEvent);
  const watchdogNotifier = { notify: vi.fn(async () => ({ ok: true })) };
  watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    insertWatchdogEvent,
    notifier: watchdogNotifier,
    readEnvFile: () => [],
    writeEnvFile: () => {},
    reloadEnv: () => {},
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => "",
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
    resolvePidVerdict: () => "unknown",
    getOpenclawInfo: () => runtime.getInfo(),
  });

  const bootReport = createBootReportWriter({ managedDir: box.managedDir, bootId: kBootId, logger: silent });
  bootReport.writeBinPhase(
    buildBinPhaseReport({
      bootId: kBootId,
      at: Date.now(),
      openclaw: {
        declaredPin: kPin,
        installedAtBoot: installed,
        installedDiverged: installed !== kPin,
        heldVersion,
      },
      bootSync: { action: "none", reason: null, warnings: [] },
    }),
  );
  const bootNotify = vi.fn(async () => ({ ok: true }));
  const postBootWebhook = vi.fn();
  const steps = createBootReportSteps({
    bootReport,
    openclawRuntime: {
      getInfo: () => runtime.getInfo(),
      describeStateDbSchema: async () => ({ installedVersion: installed, stateDb: [], supportedSchema: { state: null, agent: null } }),
    },
    insertWatchdogEvent,
    getWatchdog: () => watchdog,
    notify: bootNotify,
    postBootWebhook,
    openclawDir: box.openclawDir,
    logger: silent,
  });
  await steps.recordBootReportServerPhase();
  const finalized = await steps.finalizeBootReport();
  watchdog.getStatus();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const status = watchdog.getStatus();
  const incident = db.getOpenIncident();
  watchdog.stop();
  fs.rmSync(box.root, { recursive: true, force: true });
  return {
    info,
    pin: describeOpenclawPin(info),
    finalized,
    status,
    incident,
    notified: bootNotify.mock.calls.length + postBootWebhook.mock.calls.length + watchdogNotifier.notify.mock.calls.length,
  };
};

describe("guard: a deliberate OpenClaw hold never raises a critical version_mismatch (GST-2293)", () => {
  it("the hold floor is a real version at or below the pin this release ships", () => {
    const pin = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")).dependencies.openclaw;
    expect(kOpenclawHoldFloor).toMatch(/^\d+\.\d+\.\d+/);
    expect(compareVersionParts(kOpenclawHoldFloor, pin)).toBeLessThanOrEqual(0);
  });

  it("held at the floor: consistent boot, no mismatch latch, no incident, nobody notified", async () => {
    const result = await bootBox({ hold: kOpenclawHoldFloor, installed: kOpenclawHoldFloor });
    expect(result.info).toMatchObject({ installedDiverged: true, installedHeld: true, heldVersion: kOpenclawHoldFloor });
    expect(result.pin).toMatchObject({ state: "held", held: kOpenclawHoldFloor, pinned: kPin });
    expect(result.finalized.verdict).toEqual([]);
    expect(result.status.versionMismatch).toBe(null);
    expect(result.incident).toBeFalsy();
    expect(result.notified).toBe(0);
  });

  it("an undeclared version stays critical and notifies", async () => {
    const result = await bootBox({ hold: null, installed: kOpenclawHoldFloor });
    expect(result.pin.state).toBe("diverged");
    expect(result.finalized.verdict).toContain("installed_not_expected");
    expect(result.status.versionMismatch).toMatchObject({ running: kOpenclawHoldFloor, expected: kPin });
    expect(result.incident).toMatchObject({ severity: "critical" });
    expect(result.notified).toBeGreaterThan(0);
  });

  it("a hold that names one version while another is installed stays critical", async () => {
    const result = await bootBox({ hold: kOpenclawHoldFloor, installed: "2026.10.10" });
    expect(result.pin).toMatchObject({ state: "diverged", reason: "not_held" });
    expect(result.incident).toMatchObject({ severity: "critical" });
    expect(result.notified).toBeGreaterThan(0);
  });

  it("a hold below the supported floor stays critical", async () => {
    const result = await bootBox({ hold: "2026.10.4", installed: "2026.10.4" });
    expect(result.pin).toMatchObject({ state: "diverged", reason: "below_floor", floor: kOpenclawHoldFloor });
    expect(result.finalized.verdict).toContain("installed_not_expected");
    expect(result.incident).toMatchObject({ severity: "critical" });
    expect(result.notified).toBeGreaterThan(0);
  });
});
