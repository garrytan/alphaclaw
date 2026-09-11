// #87 (decision 6.1) — the 2am-Friday test: the REAL incident tracker over a
// temp SQLite database, wrapping the watchdog's event sink exactly as
// server.js does, driven through the issue's timeline with fake timers.
//
//   0s   probe A: /health green, /readyz not ready (failing secrets) → the
//        gateway_readiness incident opens; the advisory Doctor starts (detached)
//   5s   degraded retry B: /readyz ready → recovery; the incident closes
//   13s  Doctor A settles with a real-shaped runtime finding → NOTHING may
//        reopen: the episode is closed (degradation_cleared)
//   120s the regular timer probes again → still exactly ONE persisted row
//
// Before this change the awaited Doctor deferred A's verdict past B, logged a
// second readiness_degraded/failed under A's correlationId (the tracker opened
// a NEW incident on it) and wrote readiness "not_ready" over B's recovery.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWatchdog } = require("../../lib/server/watchdog");
const { createWatchdogIncidentTracker } = require("../../lib/server/watchdog-incidents");
const { kGatewayRestartReadyTimeoutMs } = require("../../lib/server/constants");

const loadWatchdogDb = () => {
  const modulePath = require.resolve("../../lib/server/db/watchdog");
  delete require.cache[modulePath];
  return require(modulePath);
};

const kRuntimeFinding = {
  checkId: "gateway.probe_auth_secretref_unavailable",
  severity: "warn",
  title: "Gateway auth SecretRef unavailable",
  detail: "SecretRef env:GATEWAY_TOKEN could not be resolved at probe time",
  remediation: "Set the referenced environment variable.",
};
const doctorPayload = (findings) => JSON.stringify({ ok: false, findings });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalNotificationsQuiet = process.env.WATCHDOG_NOTIFICATIONS_QUIET;
const kOriginalFetch = global.fetch;

let db = null;
let rootDir = "";

// Gateway fake with the same knobs the unit suite uses: /health always
// green; /readyz reports control.readyzFailing, or hangs until the watchdog's
// own 5s abort fires when control.readyzHang is set.
const createGatewayControl = () => {
  const control = { readyzFailing: [], readyzHang: false };
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("readyz")) {
      if (control.readyzHang) {
        return new Promise((resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ready: control.readyzFailing.length === 0,
            failing: control.readyzFailing,
            eventLoop: { degraded: false },
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    };
  };
  return { control, fetchImpl };
};

const createHarness = ({ fetchImpl, collectAdvisoryDoctorJson }) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-readiness-fence-"));
  db = loadWatchdogDb();
  db.initWatchdogDb({ rootDir, pruneDays: 30 });
  let watchdog = null;
  const tracker = createWatchdogIncidentTracker({
    db,
    getStatus: () => watchdog?.getStatus?.() ?? null,
    getResourceSample: () => ({ memory: { percent: 10 } }),
    logger: { error: () => {}, info: () => {}, log: () => {} },
  });
  // server.js wiring: the tracker sees every watchdog-sourced event.
  const insertWatchdogEvent = tracker.wrapInsertEvent(db.insertWatchdogEvent);
  global.fetch = vi.fn(fetchImpl);
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true }) })),
    ...(collectAdvisoryDoctorJson ? { collectAdvisoryDoctorJson } : {}),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
  });
  return { watchdog, tracker, notifier };
};

const incidents = () => db.listIncidents();
// getIncidentEvents returns { events, total, ... } — the rows are what we want.
const incidentEvents = (incidentId) => db.getIncidentEvents(incidentId).events;
const eventsOfType = (eventType) =>
  db.getRecentEvents({ limit: 500, includeRoutine: true }).filter((event) => event.eventType === eventType);
const noticesIncluding = (notifier, text) =>
  notifier.notify.mock.calls.map((call) => String(call?.[0] || "")).filter((m) => m.includes(text));

let consoleLog = null;
beforeEach(() => {
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLog?.mockRestore();
  if (db?.closeWatchdogDb) db.closeWatchdogDb();
  db = null;
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = "";
  if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
  else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
  if (kOriginalNotificationsDisabled == null) delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  else process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
  if (kOriginalNotificationsQuiet == null) delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
  else process.env.WATCHDOG_NOTIFICATIONS_QUIET = kOriginalNotificationsQuiet;
  if (kOriginalFetch == null) delete global.fetch;
  else global.fetch = kOriginalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#87 readiness fence end-to-end (real incident tracker over SQLite)", () => {
  it("#87 the issue's 0s→5s→13s→120s sequence persists exactly ONE gateway_readiness incident (resolved, recovered, no actions, ~5s) and no readiness_advisory", async () => {
    vi.useFakeTimers();
    let resolveDoctor = null;
    const collector = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDoctor = resolve;
        }),
    );
    const { control, fetchImpl } = createGatewayControl();
    control.readyzFailing = ["secrets"];
    const { watchdog, tracker, notifier } = createHarness({
      fetchImpl,
      collectAdvisoryDoctorJson: collector,
    });
    // 0s: A opens the incident.
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ incidentKey: "gateway_readiness", status: "open" });
    const openId = tracker.getActiveIncidentId();
    expect(openId).toBe(incidents()[0].id);
    expect(collector).toHaveBeenCalledTimes(1);
    expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
    // 5s: retry B recovers and closes it.
    control.readyzFailing = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
    expect(tracker.getActiveIncidentId()).toBe(null);
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0].status).toBe("resolved");
    const noticesAfterB = notifier.notify.mock.calls.length;
    expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
    // 13s: Doctor A settles with a matching finding — the episode is closed.
    await vi.advanceTimersByTimeAsync(8_000);
    resolveDoctor(doctorPayload([kRuntimeFinding]));
    await vi.advanceTimersByTimeAsync(0);
    // 120s: the regular timer probes again.
    await vi.advanceTimersByTimeAsync(107_000);
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ incidentKey: "gateway_readiness", status: "resolved" });
    expect(rows[0].summary).toMatchObject({
      trigger: "gateway_readiness",
      outcome: "recovered",
      actions: [],
      severity: "warning",
    });
    expect(rows[0].summary.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(rows[0].summary.durationMs).toBeLessThanOrEqual(6_000);
    expect(tracker.getActiveIncidentId()).toBe(null);
    expect(eventsOfType("readiness_advisory")).toHaveLength(0);
    expect(eventsOfType("readiness_degraded").filter((e) => e.status === "failed")).toHaveLength(1);
    expect(eventsOfType("recovery")).toHaveLength(1);
    expect(notifier.notify.mock.calls.length).toBe(noticesAfterB);
    expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
    expect(
      consoleLog.mock.calls.some(([line]) =>
        String(line).includes("readiness advisory dropped (degradation_cleared)"),
      ),
    ).toBe(true);
    watchdog.stop();
  });

  it("#87 same-degradation variant: the Doctor settles while the incident is still open → ONE incident carrying ONE readiness_advisory row; recovery later resolves that same incident", async () => {
    vi.useFakeTimers();
    let resolveDoctor = null;
    const collector = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDoctor = resolve;
        }),
    );
    const { control, fetchImpl } = createGatewayControl();
    control.readyzFailing = ["secrets"];
    const { watchdog, tracker } = createHarness({
      fetchImpl,
      collectAdvisoryDoctorJson: collector,
    });
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const openId = tracker.getActiveIncidentId();
    expect(openId).toBeGreaterThan(0);
    // Two retries later the same degradation still holds; Doctor settles.
    await vi.advanceTimersByTimeAsync(15_000);
    resolveDoctor({ stdout: doctorPayload([kRuntimeFinding]), spawnStartedAtMs: Date.now() - 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(incidents()).toHaveLength(1);
    expect(tracker.getActiveIncidentId()).toBe(openId);
    const advisories = incidentEvents(openId).filter((e) => e.eventType === "readiness_advisory");
    expect(advisories).toHaveLength(1);
    expect(advisories[0].status).toBe("warn");
    expect(advisories[0].details.finding).toMatchObject({
      checkId: "gateway.probe_auth_secretref_unavailable",
      severity: "warning",
      kind: "runtime",
      component: "secrets",
    });
    expect(advisories[0].details.episode).toBe(1);
    // The advisory is evidence, never a trigger: still open, still one row.
    expect(incidents()[0].status).toBe("open");
    control.readyzFailing = [];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ id: openId, status: "resolved" });
    expect(incidents()[0].summary).toMatchObject({ outcome: "recovered", actions: [] });
    expect(eventsOfType("readiness_advisory")).toHaveLength(1);
    watchdog.stop();
  });

  it("#87 X1 variant: /readyz times out while the readiness incident is open → still one row, still open (held rows stamped onto it) until /readyz answers ready", async () => {
    vi.useFakeTimers();
    const { control, fetchImpl } = createGatewayControl();
    control.readyzFailing = ["secrets"];
    const { watchdog, tracker, notifier } = createHarness({ fetchImpl });
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const openId = tracker.getActiveIncidentId();
    expect(openId).toBeGreaterThan(0);
    // The retries' /readyz probes time out for the next ~40s.
    control.readyzHang = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ id: openId, status: "open" });
    expect(tracker.getActiveIncidentId()).toBe(openId);
    expect(eventsOfType("recovery")).toHaveLength(0);
    expect(noticesIncluding(notifier, "running again")).toHaveLength(0);
    // Two held retries so far (f(0)=5s → timed out at 10s; f(1)=10s → timed
    // out at 25s): ONE full row, the repeat counted in memory.
    const heldRows = () =>
      incidentEvents(openId).filter(
        (e) => e.eventType === "health_check" && e.details?.readinessProbe === "timeout",
      );
    expect(heldRows()).toHaveLength(1);
    expect(heldRows()[0].details).toMatchObject({ readinessPending: true, readinessReason: "readiness probe timeout" });
    expect(watchdog.getStatus()).toMatchObject({
      health: "degraded",
      degradedReason: "readiness_failing",
      readiness: "not_ready",
      readinessProbe: "timeout",
    });
    // /readyz answers ready: the next retry resolves THIS incident.
    control.readyzHang = false;
    control.readyzFailing = [];
    await vi.advanceTimersByTimeAsync(35_000);
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ id: openId, status: "resolved" });
    expect(incidents()[0].summary).toMatchObject({ outcome: "recovered", actions: [] });
    expect(tracker.getActiveIncidentId()).toBe(null);
    expect(eventsOfType("recovery")).toHaveLength(1);
    expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
    expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
    // The recovery flushed the held run onto the SAME incident: the summary
    // row names the one repeat beyond the first full row.
    expect(heldRows()).toHaveLength(2);
    expect(heldRows()[1].details).toMatchObject({
      readinessPending: true,
      readinessProbe: "timeout",
      repeatedProbes: 1,
    });
    watchdog.stop();
  });

  it("#87 R2 fail-open variant: the hold outlives the ready budget → {recoveryAssumed} fail-open closes the FIRST incident with readiness_degraded ok {assumed}; the SAME failing components afterwards open a SECOND persisted gateway_readiness incident", async () => {
    vi.useFakeTimers();
    const { control, fetchImpl } = createGatewayControl();
    control.readyzFailing = ["secrets"];
    const { watchdog, tracker, notifier } = createHarness({ fetchImpl });
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const firstId = tracker.getActiveIncidentId();
    expect(firstId).toBeGreaterThan(0);
    expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
    // Every retry's /readyz times out through the whole budget (5/10/20/30s
    // cap, each held probe timing out at +5s); the first probe to complete
    // past the budget fails open.
    control.readyzHang = true;
    await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 45_000);
    expect(
      eventsOfType("readiness_probe_error").filter((e) => e.details?.recoveryAssumed === true),
    ).toHaveLength(1);
    const closings = eventsOfType("readiness_degraded").filter((e) => e.status === "ok");
    expect(closings).toHaveLength(1);
    expect(closings[0].details).toMatchObject({ recovered: true, assumed: true, kind: "timeout" });
    expect(incidents()).toHaveLength(1);
    expect(incidents()[0]).toMatchObject({ id: firstId, status: "resolved" });
    expect(incidents()[0].summary).toMatchObject({ outcome: "recovered", actions: [] });
    expect(tracker.getActiveIncidentId()).toBe(null);
    expect(eventsOfType("recovery")).toHaveLength(1);
    expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown" });
    // The SAME components fail again in this generation: a new episode and a
    // NEW persisted incident (the closed one is never re-used).
    control.readyzHang = false;
    await watchdog.runHealthCheck({ source: "health_timer" });
    expect(eventsOfType("readiness_degraded").filter((e) => e.status === "failed")).toHaveLength(2);
    const rows = incidents();
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => row.id !== firstId);
    expect(second).toMatchObject({ incidentKey: "gateway_readiness", status: "open" });
    expect(tracker.getActiveIncidentId()).toBe(second.id);
    expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(2);
    expect(watchdog.getStatus()).toMatchObject({
      health: "degraded",
      degradedReason: "readiness_failing",
      readiness: "not_ready",
      readinessReason: "secrets",
    });
    watchdog.stop();
  });
});
