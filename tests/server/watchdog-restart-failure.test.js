const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createWatchdog,
  kRestartFailureRecheckDelaysMs,
  kRestartFailureNoteTtlMs,
} = require("../../lib/server/watchdog");
const { createWatchdogIncidentTracker } = require("../../lib/server/watchdog-incidents");

// Bug #137 — the failed-restart handoff: the route files ONE note
// (noteRestartFailure) after a restart ends with the gateway actually down;
// the watchdog previews admission purely (peekRepairAdmission), runs the
// bounded recheck ladder with repair allowed, bypasses the sustained-failure
// gate while the note stands, and retires the note at the first
// identity-clear green probe / a new user restart / its 15 min expiry.

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

// Under fake timers setImmediate is faked too: drain through the clock.
const flushMicrotasks = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setImmediate(resolve));
  }
};

const doctorOk = async (command) =>
  command === "doctor --fix --yes"
    ? { ok: true, stdout: "fixed" }
    : { ok: true, stdout: JSON.stringify({ ok: true }) };

const createHarness = ({
  autoRepair = true,
  clawCmdImpl = doctorOk,
  gatewayLifecycleLock = null,
  degradedRepairThreshold = null,
  // Hermetic process table: the harness's pids are fake, never real processes.
  pidAlive = () => false,
  readPersistedPause = null,
  getOpenclawInfo = null,
  supervisorModeActive = () => false,
  consumeRestartHandoffImpl = null,
  onRestartFailureRecovered = null,
  onRestartFailureSettled = null,
  // Cause linkage (PR 2): route the sink through a real incident tracker on
  // a scratch watchdog db (server.js wiring) and answer /readyz too.
  trackIncidents = false,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
  // The port under test: `healthy` flips what /health answers; with
  // trackIncidents, `readyzFailing` names the components /readyz reports.
  const control = { healthy: true, readyzFailing: [] };
  global.fetch = vi.fn(async (url) => {
    if (!control.healthy) throw new Error("connect ECONNREFUSED");
    if (String(url).includes("readyz")) {
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
  });
  let db = null;
  let watchdog = null;
  if (trackIncidents) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-restart-failure-"));
    const modulePath = require.resolve("../../lib/server/db/watchdog");
    delete require.cache[modulePath];
    db = require(modulePath);
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
    openIncidentDbs.push({ db, rootDir });
  }
  const tracker = trackIncidents
    ? createWatchdogIncidentTracker({
        db,
        getStatus: () => watchdog?.getStatus?.() ?? null,
        getResourceSample: () => null,
        logger: { error: () => {}, info: () => {}, log: () => {} },
      })
    : null;
  const insertWatchdogEvent = vi.fn(tracker ? tracker.wrapInsertEvent(db.insertWatchdogEvent) : () => {});
  const clawCmd = vi.fn(clawCmdImpl);
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  watchdog = createWatchdog({
    clawCmd,
    launchGatewayProcess,
    gatewayLifecycleLock,
    insertWatchdogEvent,
    notifier: { notify: vi.fn(async () => ({ ok: true })) },
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => (trackIncidents ? "http://127.0.0.1:18789/readyz" : ""),
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive,
    ...(consumeRestartHandoffImpl ? { consumeRestartHandoffImpl } : {}),
    ...(degradedRepairThreshold != null ? { degradedRepairThreshold } : {}),
    pidAlive,
    readProcStartTicks: () => null,
    resolvePidVerdict: () => "gone",
    ...(readPersistedPause ? { readPersistedPause, writePersistedPause: vi.fn() } : {}),
    ...(getOpenclawInfo ? { getOpenclawInfo } : {}),
    ...(onRestartFailureRecovered ? { onRestartFailureRecovered } : {}),
    ...(onRestartFailureSettled ? { onRestartFailureSettled } : {}),
  });
  const rows = () => insertWatchdogEvent.mock.calls.map(([row]) => row);
  const rowsOf = (eventType, status = null, source = null) =>
    rows().filter(
      (row) =>
        row.eventType === eventType &&
        (status == null || row.status === status) &&
        (source == null || row.source === source),
    );
  const doctorFixCalls = () =>
    clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes").length;
  const probeCount = () => global.fetch.mock.calls.length;
  // The box's shape: a user restart that ended with the gateway down —
  // the route settled the window, operation_end probed once without repair
  // and lifecycle fell to "stopped" (not stopRequested: the watchdog runs).
  const failUserRestart = async () => {
    control.healthy = false;
    watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, supersedes: "user" });
    await flushMicrotasks();
    watchdog.onExpectedRestartSettled();
    await flushMicrotasks();
    expect(watchdog.getStatus()).toMatchObject({ lifecycle: "stopped", health: "degraded" });
    expect(
      rows().filter((row) => row.eventType === "repair" && row.details?.reason === "awaiting_sustained_failure"),
    ).toHaveLength(0);
  };
  return {
    watchdog,
    control,
    db,
    tracker,
    insertWatchdogEvent,
    clawCmd,
    launchGatewayProcess,
    rows,
    rowsOf,
    doctorFixCalls,
    probeCount,
    failUserRestart,
  };
};

const openIncidentDbs = [];

const kPersistedPause = {
  at: 1788681900000,
  cause: "state_schema_too_new",
  fingerprint: "abcdef0123456789",
  installedVersion: "2026.9.8",
  attempts: 3,
  lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
  reason: "structural_repair_failed",
};

describe("watchdog failed-restart handoff (bug #137)", () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    if (kOriginalNotificationsDisabled == null) delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    else process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    if (kOriginalFetch == null) delete global.fetch;
    else global.fetch = kOriginalFetch;
    for (const { db, rootDir } of openIncidentDbs.splice(0)) {
      db.closeWatchdogDb?.();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("peekRepairAdmission — the pure preview", () => {
    // Same verdict as readRepairAdmission (runRepair's first read, returned
    // verbatim on refusal) and not one write: no ledger row, no pause clear.
    const expectPureParity = async (h, expected) => {
      const eventsBefore = h.insertWatchdogEvent.mock.calls.length;
      const pauseBefore = JSON.stringify(h.watchdog.getStatus().autoRepairPaused);
      const statusBefore = JSON.stringify({ ...h.watchdog.getStatus(), serverNow: 0 });
      const peeked = h.watchdog.peekRepairAdmission();
      const peekedAgain = h.watchdog.peekRepairAdmission();
      expect(peeked).toEqual(expected);
      expect(peekedAgain).toEqual(expected);
      expect(h.insertWatchdogEvent.mock.calls.length).toBe(eventsBefore);
      expect(JSON.stringify(h.watchdog.getStatus().autoRepairPaused)).toBe(pauseBefore);
      expect(JSON.stringify({ ...h.watchdog.getStatus(), serverNow: 0 })).toBe(statusBefore);
      const actual = await h.watchdog.runRepair({ source: "health_timer", correlationId: "c-1" });
      expect(actual).toMatchObject({ ok: expected.ok, ...(expected.reason ? { reason: expected.reason } : {}) });
      return actual;
    };

    it("ok on a fresh instance with auto-repair armed", () => {
      const h = createHarness();
      const eventsBefore = h.insertWatchdogEvent.mock.calls.length;
      expect(h.watchdog.peekRepairAdmission()).toEqual({ ok: true });
      expect(h.insertWatchdogEvent.mock.calls.length).toBe(eventsBefore);
    });

    it("auto_repair_disabled", async () => {
      const h = createHarness({ autoRepair: false });
      await expectPureParity(h, { ok: false, reason: "auto_repair_disabled" });
    });

    it("auto_repair_paused: carries the pause, writes no row and clears nothing — runRepair's read books the row", async () => {
      const h = createHarness({
        readPersistedPause: () => ({ ...kPersistedPause }),
        getOpenclawInfo: () => ({ installedVersion: "2026.9.8", pinnedVersion: "2026.9.8" }),
      });
      const pause = h.watchdog.getStatus().autoRepairPaused;
      expect(pause).toMatchObject({ fingerprint: kPersistedPause.fingerprint });
      const pausedRowsBefore = h.rowsOf("repair", "skipped").length;
      await expectPureParity(h, {
        ok: false,
        reason: "auto_repair_paused",
        pause: expect.objectContaining({ fingerprint: kPersistedPause.fingerprint }),
      });
      // The settling reader logged its deduped row; the peek never did.
      expect(h.rowsOf("repair", "skipped").length).toBe(pausedRowsBefore + 1);
      expect(h.rowsOf("repair", "skipped").at(-1)).toMatchObject({
        source: "health_timer",
        details: expect.objectContaining({ reason: "auto_repair_paused" }),
      });
      expect(h.watchdog.getStatus().autoRepairPaused).toEqual(pause);
    });

    it("configuration_error", async () => {
      const h = createHarness();
      h.watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: ["Invalid config"] });
      await flushMicrotasks();
      expect(h.watchdog.getStatus().lifecycle).toBe("configuration_error");
      await expectPureParity(h, { ok: false, reason: "configuration_error" });
    });

    it("repair_attempts_exhausted: attempts and limit ride along", async () => {
      vi.useFakeTimers();
      const h = createHarness({
        clawCmdImpl: async (command) =>
          command === "doctor --fix --yes"
            ? { ok: false, stdout: "", stderr: "doctor failed" }
            : { ok: true, stdout: JSON.stringify({ ok: true }) },
      });
      h.control.healthy = false;
      const limit = h.watchdog.getStatus().repairAttemptLimit;
      for (let i = 0; i < limit; i += 1) {
        await h.watchdog.triggerRepair();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(h.watchdog.getStatus().repairAttempts).toBe(limit);
      await expectPureParity(h, {
        ok: false,
        reason: "repair_attempts_exhausted",
        attempts: limit,
        limit,
      });
    });

    it("operation_in_progress while a repair holds the lifecycle", async () => {
      let resolveDoctor;
      const h = createHarness({
        clawCmdImpl: async (command) =>
          command === "doctor --fix --yes"
            ? new Promise((resolve) => {
                resolveDoctor = resolve;
              })
            : { ok: true, stdout: "" },
      });
      h.control.healthy = false;
      const repair = h.watchdog.triggerRepair();
      await flushMicrotasks();
      expect(h.watchdog.getStatus().operationInProgress).toBe(true);
      await expectPureParity(h, { ok: false, reason: "operation_in_progress" });
      resolveDoctor({ ok: true, stdout: "fixed" });
      await repair;
    });

    it("replacement_pending after a repair relaunched a child still inside its ready budget", async () => {
      const h = createHarness();
      h.control.healthy = false;
      const result = await h.watchdog.triggerRepair();
      await flushMicrotasks();
      expect(result.ok).toBe(true);
      expect(h.watchdog.getStatus().replacementPending).toBeTruthy();
      await expectPureParity(h, { ok: false, reason: "replacement_pending" });
    });

    it("a transient state-writer conflict answers with its kind", async () => {
      const h = createHarness();
      h.control.healthy = false;
      h.watchdog.onGatewayExit({
        code: 1,
        expectedExit: false,
        stderrTail: ["Gateway failed to start: state directory is locked by agent-embedded (pid 4321)"],
        launchedAt: Date.now() - 2_000,
      });
      await flushMicrotasks();
      expect(h.watchdog.getStatus().incumbentConflict).toMatchObject({ kind: "state_writer_conflict" });
      await expectPureParity(h, { ok: false, reason: "state_writer_conflict" });
    });

    it("incumbent_startup_grace while an unhealthy external holder keeps its cold-boot budget", async () => {
      vi.useFakeTimers();
      const h = createHarness({ pidAlive: () => true });
      h.control.healthy = false;
      h.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      h.watchdog.onGatewayExit({
        code: 1,
        expectedExit: false,
        pid: 100,
        generation: 1,
        stderrTail: ["gateway already running (pid 4321); lock timeout after 5000ms"],
        launchedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(h.watchdog.getStatus().incumbentGraceUntil).toEqual(expect.any(String));
      await expectPureParity(h, { ok: false, reason: "incumbent_startup_grace" });
    });
  });

  describe("noteRestartFailure — the recheck ladder", () => {
    it("exports the ladder and TTL constants", () => {
      expect([...kRestartFailureRecheckDelaysMs]).toEqual([0, 5_000, 15_000, 30_000, 60_000]);
      expect(kRestartFailureNoteTtlMs).toBe(15 * 60 * 1000);
    });

    it("a stop_failed note on a dead port reaches Doctor on the first rung — lifecycle stopped, one failure, no 120s timer", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      await h.failUserRestart();
      const filedAt = Date.now();
      const result = h.watchdog.noteRestartFailure({
        operationId: "op-1",
        code: "stop_failed",
        phase: "sigkill",
        signalled: true,
        gatewayDown: true,
      });
      expect(result).toEqual({
        admission: { ok: true },
        recheck: { scheduled: true, delaysMs: [0, 5_000, 15_000, 30_000, 60_000] },
        note: {
          version: 1,
          operationId: "op-1",
          code: "stop_failed",
          phase: "sigkill",
          signalled: true,
          gatewayDown: true,
          at: new Date(filedAt).toISOString(),
          expiresAt: new Date(filedAt + kRestartFailureNoteTtlMs).toISOString(),
          transferredToGeneration: null,
        },
      });
      expect(h.watchdog.getStatus().restartFailureNote).toEqual(result.note);
      expect(h.doctorFixCalls()).toBe(0);

      await vi.advanceTimersByTimeAsync(0);
      // One recheck probe, the gate bypassed (consecutive failures 2 < 3),
      // Doctor ran and relaunched: well inside 60 s of the note.
      expect(h.doctorFixCalls()).toBe(1);
      expect(h.launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(h.rowsOf("health_check", "failed", "restart_failure_recheck")).toHaveLength(1);
      expect(h.rowsOf("repair", "skipped").filter((row) => row.details?.reason === "awaiting_sustained_failure")).toHaveLength(0);
      expect(h.rowsOf("repair", "ok", "restart_failure_recheck")).toHaveLength(1);

      // The decision ended the ladder: no later rung probes.
      const recheckRows = () => h.rows().filter((row) => row.source === "restart_failure_recheck");
      const afterDecision = recheckRows().length;
      await vi.advanceTimersByTimeAsync(200_000);
      expect(recheckRows().length).toBe(afterDecision);
      h.watchdog.stop();
    });

    it("the bypass applies to any probe source while the note stands, and the threshold applies again once it is cleared", async () => {
      const h = createHarness();
      h.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await flushMicrotasks();
      expect(h.watchdog.getStatus().health).toBe("healthy");

      // Note standing (filed while the probe path is dead): the first
      // health_timer miss repairs at once.
      h.control.healthy = false;
      h.watchdog.noteRestartFailure({ operationId: "op-a", code: "stop_failed", gatewayDown: true });
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h.doctorFixCalls()).toBe(1);
      expect(h.rowsOf("repair", "skipped").filter((row) => row.details?.reason === "awaiting_sustained_failure")).toHaveLength(0);
      h.watchdog.stop();

      // Cleared (a new user restart supersedes it): one miss is skipped
      // awaiting_sustained_failure again.
      const h2 = createHarness();
      h2.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await flushMicrotasks();
      h2.watchdog.noteRestartFailure({ operationId: "op-b", code: "stop_failed", gatewayDown: true });
      h2.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, supersedes: "user" });
      h2.watchdog.onExpectedRestartSettled();
      await flushMicrotasks();
      expect(h2.watchdog.getRestartFailureNote()).toBe(null);
      h2.control.healthy = false;
      await h2.watchdog.runHealthCheck({ source: "health_timer" });
      await h2.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h2.doctorFixCalls()).toBe(0);
      expect(
        h2.rowsOf("repair", "skipped").filter((row) => row.details?.reason === "awaiting_sustained_failure").map((row) => row.details.failures),
      ).toEqual([1, 2]);
      await h2.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h2.doctorFixCalls()).toBe(1);
      h2.watchdog.stop();
    });

    it("pendingExitClassification blocks a rung without probing; the ladder keeps its later rungs", async () => {
      vi.useFakeTimers();
      let resolveConsume;
      const h = createHarness({
        supervisorModeActive: () => true,
        consumeRestartHandoffImpl: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveConsume = resolve;
            }),
        ),
      });
      h.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242 });
      await vi.advanceTimersByTimeAsync(0);
      h.control.healthy = false;
      h.watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });
      expect(h.watchdog.getStatus().pendingExitClassification).toBe(true);
      const probesBefore = h.probeCount();
      const result = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      expect(result.recheck.scheduled).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.probeCount()).toBe(probesBefore);
      expect(h.doctorFixCalls()).toBe(0);
      resolveConsume({ status: "rejected", reason: "no_handoff" });
      await vi.advanceTimersByTimeAsync(0);
      h.watchdog.stop();
    });

    it("operation_in_progress: admission not ok, nothing scheduled", async () => {
      let resolveDoctor;
      const h = createHarness({
        clawCmdImpl: async (command) =>
          command === "doctor --fix --yes"
            ? new Promise((resolve) => {
                resolveDoctor = resolve;
              })
            : { ok: true, stdout: "" },
      });
      h.control.healthy = false;
      const repair = h.watchdog.triggerRepair();
      await flushMicrotasks();
      const result = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      expect(result.admission).toEqual({ ok: false, reason: "operation_in_progress" });
      expect(result.recheck).toEqual({ scheduled: false, delaysMs: [] });
      expect(h.watchdog.getRestartFailureNote()).toMatchObject({ operationId: "op-1", gatewayDown: true });
      resolveDoctor({ ok: true, stdout: "fixed" });
      await repair;
    });

    it("ready_timeout (gatewayDown false): the note is stored, no rechecks run", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      h.control.healthy = false;
      const probesBefore = h.probeCount();
      const result = h.watchdog.noteRestartFailure({ operationId: "op-rt", code: "ready_timeout", gatewayDown: false });
      expect(result.admission).toEqual({ ok: true });
      expect(result.recheck).toEqual({ scheduled: false, delaysMs: [] });
      expect(result.note).toMatchObject({ code: "ready_timeout", gatewayDown: false });
      await vi.advanceTimersByTimeAsync(200_000);
      expect(h.probeCount()).toBe(probesBefore);
      expect(h.doctorFixCalls()).toBe(0);
      expect(h.watchdog.getRestartFailureNote()).toMatchObject({ operationId: "op-rt" });
    });

    // Inside a planned restart's window every miss is a skipped row, never a
    // decision, so the ladder runs to its end. The window's own 5 s bootstrap
    // cadence probes too; filing the note mid-grid (t = 2.5 s) keeps the
    // ladder's rungs (2.5 s, 7.5 s, 22.5 s, 52.5 s, 112.5 s) clear of it, so
    // the probe count moves by exactly one inside a 100 ms window around a
    // rung and by none where no rung is due.
    const kLadderOffsetMs = 2_500;
    const armLadderOffGrid = async (h, operationId = "op-1") => {
      h.control.healthy = false;
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 20 * 60_000 });
      await vi.advanceTimersByTimeAsync(kLadderOffsetMs);
      const filedAt = Date.now();
      const result = h.watchdog.noteRestartFailure({ operationId, code: "stop_failed", gatewayDown: true });
      return { ...result, filedAt };
    };
    const expectLadderProbeAround = async (h, dueAtMs, { fires }) => {
      const leadMs = dueAtMs - 50 - Date.now();
      if (leadMs > 0) await vi.advanceTimersByTimeAsync(leadMs);
      const before = h.probeCount();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.probeCount() - before).toBe(fires ? 1 : 0);
    };
    const rungDueTimes = (filedAt) => {
      let elapsed = 0;
      return kRestartFailureRecheckDelaysMs.map((delayMs) => {
        elapsed += delayMs;
        return filedAt + elapsed;
      });
    };

    it("walks every rung at its delay when no rung decides, then ends", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      const { filedAt } = await armLadderOffGrid(h);
      const dueTimes = rungDueTimes(filedAt);
      expect(dueTimes.map((t) => t - filedAt)).toEqual([0, 5_000, 20_000, 50_000, 110_000]);
      for (const dueAt of dueTimes) await expectLadderProbeAround(h, dueAt, { fires: true });
      // Past the last rung nothing of the ladder fires again.
      for (const laterMs of [5_000, 60_000, 300_000]) {
        await expectLadderProbeAround(h, dueTimes.at(-1) + laterMs, { fires: false });
      }
      expect(h.doctorFixCalls()).toBe(0);
      h.watchdog.stop();
    });

    it("idempotent per operationId; a different operationId replaces the note, bumps the version and silences the old ladder", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      const first = await armLadderOffGrid(h, "op-1");
      expect(first.note.version).toBe(1);
      await expectLadderProbeAround(h, first.filedAt, { fires: true });

      const again = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "aborted", gatewayDown: true });
      expect(again.note).toEqual(first.note);
      expect(again.recheck).toEqual({ scheduled: true, delaysMs: [5_000, 15_000, 30_000, 60_000] });
      expect(h.watchdog.getRestartFailureNote()).toEqual(first.note);

      // 1 s later a different operation replaces it: rung 1 of version 2
      // fires now, op-1's rung 2 (due at filedAt + 5 s) never does, op-2's
      // rung 2 fires 5 s after ITS filing.
      await vi.advanceTimersByTimeAsync(1_000);
      const secondFiledAt = Date.now();
      const second = h.watchdog.noteRestartFailure({ operationId: "op-2", code: "launch_failed", gatewayDown: true });
      expect(second.note.version).toBe(2);
      expect(second.recheck.scheduled).toBe(true);
      expect(h.watchdog.getRestartFailureNote()).toMatchObject({ version: 2, operationId: "op-2" });
      await expectLadderProbeAround(h, secondFiledAt, { fires: true });
      await expectLadderProbeAround(h, first.filedAt + 5_000, { fires: false });
      await expectLadderProbeAround(h, secondFiledAt + 5_000, { fires: true });
      h.watchdog.stop();
    });

    it("stop() cancels the ladder", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      h.control.healthy = false;
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 600_000 });
      const probesBefore = h.probeCount();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.probeCount() - probesBefore).toBe(1);
      h.watchdog.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(h.probeCount() - probesBefore).toBe(1);
    });
  });

  describe("note lifecycle", () => {
    it("onExpectedRestart({ supersedes: 'user' }) clears the note; the watchdog's own planned restart keeps it and stamps transferredToGeneration", () => {
      const h = createHarness();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: false });
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, supersedes: "user" });
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      expect(h.watchdog.getStatus().restartFailureNote).toBe(null);

      h.watchdog.noteRestartFailure({ operationId: "op-2", code: "stop_failed", gatewayDown: false });
      // The repair's cold restart / memory mitigation call it exactly so.
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000 });
      expect(h.watchdog.getRestartFailureNote()).toMatchObject({
        operationId: "op-2",
        transferredToGeneration: 1,
      });
    });

    it("the first identity-clear green probe clears the note: recoveredBy watchdog_repair when the note rode our launch, unknown otherwise", async () => {
      vi.useFakeTimers();
      // Transferred: planned restart of ours → launch → green.
      const h = createHarness();
      await h.failUserRestart();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000 });
      expect(h.watchdog.getRestartFailureNote().transferredToGeneration).toBe(1);
      h.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 500, rootPid: 500, generation: 7 });
      h.control.healthy = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.watchdog.getStatus()).toMatchObject({ health: "healthy", restartFailureNote: null });
      expect(h.rowsOf("restart", "ok", "restart_failure_note")).toEqual([
        expect.objectContaining({
          details: { operationId: "op-1", code: "stop_failed", recoveredBy: "watchdog_repair" },
        }),
      ]);
      // Later green probes do not log it again.
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      expect(h.rowsOf("restart", "ok", "restart_failure_note")).toHaveLength(1);
      h.watchdog.stop();

      // Not transferred: the port came back on its own.
      const h2 = createHarness();
      await h2.failUserRestart();
      h2.watchdog.noteRestartFailure({ operationId: "op-9", code: "launch_failed", gatewayDown: false });
      h2.control.healthy = true;
      await h2.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h2.watchdog.getRestartFailureNote()).toBe(null);
      expect(h2.rowsOf("restart", "ok", "restart_failure_note")).toEqual([
        expect.objectContaining({
          details: { operationId: "op-9", code: "launch_failed", recoveredBy: "unknown" },
        }),
      ]);
      h2.watchdog.stop();
    });

    it("the recovery hook (PR 2) receives the verdict once per note: watchdog_repair with the relaunch time, restart_child for a ready_timeout whose own child came up, unknown otherwise; a throwing hook is contained", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ onRestartFailureRecovered: hook });
      await h.failUserRestart();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000 });
      const launchedAt = Date.now() + 1_000;
      h.watchdog.onGatewayLaunch({ startedAt: launchedAt, pid: 500, rootPid: 500, generation: 7 });
      h.control.healthy = true;
      await vi.advanceTimersByTimeAsync(0);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith({ operationId: "op-1", code: "stop_failed", by: "watchdog_repair", launchedAt, at: expect.any(Number) });
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      expect(hook).toHaveBeenCalledTimes(1);
      h.watchdog.stop();

      const hook2 = vi.fn(() => { throw new Error("boom"); });
      const h2 = createHarness({ onRestartFailureRecovered: hook2 });
      await h2.failUserRestart();
      h2.watchdog.noteRestartFailure({ operationId: "op-2", code: "ready_timeout", gatewayDown: false });
      h2.control.healthy = true;
      await h2.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(hook2).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op-2", code: "ready_timeout", by: "restart_child" }));
      expect(h2.watchdog.getStatus()).toMatchObject({ health: "healthy", restartFailureNote: null });
      expect(h2.rowsOf("restart", "ok", "restart_failure_note")[0].details.recoveredBy).toBe("restart_child");
      h2.watchdog.stop();

      const hook3 = vi.fn();
      const h3 = createHarness({ onRestartFailureRecovered: hook3 });
      await h3.failUserRestart();
      h3.watchdog.noteRestartFailure({ operationId: "op-3", code: "launch_failed", gatewayDown: false });
      h3.control.healthy = true;
      await h3.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(hook3).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op-3", by: "unknown" }));
      h3.watchdog.stop();
    });

    it("expires after 15 minutes: the note reads null, and a note filed again is a fresh one", async () => {
      vi.useFakeTimers();
      const h = createHarness();
      h.control.healthy = false;
      const first = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: false });
      expect(first.note.version).toBe(1);
      await vi.advanceTimersByTimeAsync(kRestartFailureNoteTtlMs - 1);
      expect(h.watchdog.getRestartFailureNote()).toMatchObject({ operationId: "op-1", version: 1 });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      expect(h.watchdog.getStatus().restartFailureNote).toBe(null);
      // The same operationId after expiry is not the idempotent return.
      const next = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: false });
      expect(next.note.version).toBe(2);
      expect(h.probeCount()).toBe(0);
    });

    it("getStatus().restartFailureNote is scalars + ISO only and frame-stable across reads", () => {
      const h = createHarness();
      expect(h.watchdog.getStatus().restartFailureNote).toBe(null);
      const at = Date.now();
      h.watchdog.noteRestartFailure({
        operationId: "op-1",
        code: "aborted",
        phase: "sigterm",
        signalled: true,
        gatewayDown: false,
      });
      const first = h.watchdog.getStatus().restartFailureNote;
      expect(first).toEqual({
        version: 1,
        operationId: "op-1",
        code: "aborted",
        phase: "sigterm",
        signalled: true,
        gatewayDown: false,
        at: expect.any(String),
        expiresAt: expect.any(String),
        transferredToGeneration: null,
      });
      expect(Date.parse(first.at)).toBeGreaterThanOrEqual(at);
      expect(Date.parse(first.expiresAt) - Date.parse(first.at)).toBe(kRestartFailureNoteTtlMs);
      expect(JSON.stringify(h.watchdog.getStatus().restartFailureNote)).toBe(JSON.stringify(first));
      // An unknown code collapses to restart_failed.
      expect(
        h.watchdog.noteRestartFailure({ operationId: "op-2", code: "something_else", gatewayDown: false }).note.code,
      ).toBe("restart_failed");
    });
  });

  // Bug C — the record's `recovery` said will_check long after the watchdog
  // gave up: every way the note ends now settles it once, first ending wins.
  describe("settled recovery (Bug C)", () => {
    const settledWith = (hook) => hook.mock.calls.map(([call]) => ({ operationId: call.operationId, status: call.status, reason: call.reason }));
    const doctorFails = async (command) =>
      command === "doctor --fix --yes"
        ? { ok: false, stdout: "", stderr: "ENOSPC: no space left on device" }
        : { ok: true, stdout: JSON.stringify({ ok: true }) };

    it("the ladder ends with no decision and the port still down: still_down, once", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ onRestartFailureSettled: hook });
      h.control.healthy = false;
      // Inside a planned restart's window every miss is skipped, never a decision.
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 20 * 60_000 });
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      await vi.advanceTimersByTimeAsync(100_000);
      expect(hook).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settledWith(hook)).toEqual([{ operationId: "op-1", status: "still_down", reason: null }]);
      expect(hook.mock.calls[0][0]).toMatchObject({ code: "stop_failed", at: expect.any(Number) });
      // The first ending wins: the later expiry and stop() add nothing.
      await vi.advanceTimersByTimeAsync(kRestartFailureNoteTtlMs);
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      h.watchdog.stop();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("the rung's repair ran and failed (Doctor ENOSPC): repair_failed", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ clawCmdImpl: doctorFails, onRestartFailureSettled: hook });
      await h.failUserRestart();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "launch_failed", gatewayDown: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.doctorFixCalls()).toBe(1);
      expect(settledWith(hook)).toEqual([{ operationId: "op-1", status: "repair_failed", reason: null }]);
      h.watchdog.stop();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("the rung's repair was refused: settles as the refusal (repair_attempts_exhausted)", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ clawCmdImpl: doctorFails, onRestartFailureSettled: hook });
      await h.failUserRestart();
      const filed = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "launch_failed", gatewayDown: true });
      expect(filed.recheck.scheduled).toBe(true);
      // Both attempts are spent before the first rung fires.
      const limit = h.watchdog.getStatus().repairAttemptLimit;
      for (let i = 0; i < limit; i += 1) await h.watchdog.triggerRepair();
      expect(h.watchdog.getStatus().repairAttempts).toBe(limit);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.doctorFixCalls()).toBe(limit);
      expect(settledWith(hook)).toEqual([
        { operationId: "op-1", status: "repair_attempts_exhausted", reason: "repair_attempts_exhausted" },
      ]);
      h.watchdog.stop();
    });

    it("an admitted repair that brings the port back reports recovered through the recovery hook, never a settle", async () => {
      vi.useFakeTimers();
      const settled = vi.fn();
      const recovered = vi.fn();
      const h = createHarness({ onRestartFailureSettled: settled, onRestartFailureRecovered: recovered });
      await h.failUserRestart();
      h.watchdog.noteRestartFailure({ operationId: "op-1", code: "stop_failed", gatewayDown: true });
      h.control.healthy = true;
      await vi.advanceTimersByTimeAsync(0);
      h.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242, rootPid: 4242, generation: 1 });
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      expect(recovered).toHaveBeenCalledTimes(1);
      h.watchdog.stop();
      expect(settled).not.toHaveBeenCalled();
    });

    it("a newer user restart, a newer note, expiry and stop() each settle the note they end", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ onRestartFailureSettled: hook });
      // The port never answers, so no green probe ends a note first.
      h.control.healthy = false;
      h.watchdog.noteRestartFailure({ operationId: "op-user", code: "ready_timeout", gatewayDown: false });
      h.watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, supersedes: "user" });
      h.watchdog.noteRestartFailure({ operationId: "op-old", code: "ready_timeout", gatewayDown: false });
      h.watchdog.noteRestartFailure({ operationId: "op-new", code: "ready_timeout", gatewayDown: false });
      // The idempotent re-report of the standing note settles nothing.
      h.watchdog.noteRestartFailure({ operationId: "op-new", code: "ready_timeout", gatewayDown: false });
      await vi.advanceTimersByTimeAsync(kRestartFailureNoteTtlMs);
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      h.watchdog.noteRestartFailure({ operationId: "op-stop", code: "stop_failed", gatewayDown: false });
      h.watchdog.stop();
      expect(settledWith(hook)).toEqual([
        { operationId: "op-user", status: "superseded", reason: null },
        { operationId: "op-old", status: "superseded", reason: null },
        { operationId: "op-new", status: "expired", reason: null },
        { operationId: "op-stop", status: "stopped", reason: null },
      ]);
    });

    it("a note whose repair is refused at filing settles as that refusal at once, and its later expiry does not rewrite it", async () => {
      vi.useFakeTimers();
      const hook = vi.fn();
      const h = createHarness({ autoRepair: false, onRestartFailureSettled: hook });
      h.control.healthy = false;
      const result = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "launch_failed", gatewayDown: true });
      expect(result.recheck.scheduled).toBe(false);
      expect(result.settled).toEqual({ status: "auto_repair_disabled", reason: "auto_repair_disabled" });
      await vi.advanceTimersByTimeAsync(kRestartFailureNoteTtlMs);
      expect(h.watchdog.getRestartFailureNote()).toBe(null);
      h.watchdog.stop();
      expect(settledWith(hook)).toEqual([{ operationId: "op-1", status: "auto_repair_disabled", reason: "auto_repair_disabled" }]);
    });

    it("a note filed while the watchdog is stopping settles stopped at once and says so; a throwing hook is contained", async () => {
      const hook = vi.fn(() => {
        throw new Error("boom");
      });
      const h = createHarness({ onRestartFailureSettled: hook });
      h.watchdog.stop();
      const result = h.watchdog.noteRestartFailure({ operationId: "op-1", code: "aborted", signalled: true, gatewayDown: true });
      expect(result.recheck.scheduled).toBe(false);
      expect(result.settled).toEqual({ status: "stopped", reason: null });
      expect(settledWith(hook)).toEqual([{ operationId: "op-1", status: "stopped", reason: null }]);
      expect(h.watchdog.noteRestartFailure({ operationId: "op-1", code: "aborted", gatewayDown: true }).settled).toEqual({
        status: "stopped",
        reason: null,
      });
    });
  });

  // PR 2 — cause linkage. Incident #2213 on the #137 box read "none recorded"
  // although the outage WAS the failed restart op: while the note stands,
  // the rows that open a degraded/readiness incident carry the restart as a
  // SUSPECTED cause, and filing a note while one is already open stamps it
  // through one `restart / restart_failed / failed` row.
  describe("incident cause linkage while the note stands (PR 2)", () => {
    const openCause = (h) => h.db.getOpenIncident()?.cause ?? null;
    const restartCause = (code, operationId) => ({
      cause: code,
      fingerprint: null,
      corroborated: false,
      by: `restart:${operationId}`,
      suspectedCause: null,
      at: expect.any(String),
    });
    const greenGateway = async (h) => {
      h.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await flushMicrotasks();
      expect(h.watchdog.getStatus().health).toBe("healthy");
      expect(h.db.getOpenIncident()).toBeNull();
    };

    it("(a) note filed with nothing open: the failed health_check that opens the incident carries restart_stop_failed / by restart:<op> / corroborated false", async () => {
      const h = createHarness({ autoRepair: false, trackIncidents: true });
      await greenGateway(h);
      h.watchdog.noteRestartFailure({ operationId: "op-a", code: "stop_failed", gatewayDown: true });
      // The note's own row is history, not an incident: nothing is open.
      expect(h.rowsOf("restart", "failed", "restart_failed")).toEqual([
        expect.objectContaining({
          details: {
            operationId: "op-a",
            code: "stop_failed",
            phase: null,
            signalled: false,
            gatewayDown: true,
            cause: "restart_stop_failed",
            by: "restart:op-a",
            corroborated: false,
          },
        }),
      ]);
      expect(h.db.getOpenIncident()).toBeNull();

      h.control.healthy = false;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      const opened = h.db.getOpenIncident();
      expect(opened).toMatchObject({ incidentKey: "gateway_degraded" });
      expect(opened.cause).toEqual(restartCause("restart_stop_failed", "op-a"));
      const [failedRow] = h.rowsOf("health_check", "failed");
      expect(failedRow.details).toMatchObject({
        reason: expect.any(String),
        cause: "restart_stop_failed",
        by: "restart:op-a",
        corroborated: false,
      });
      expect(h.db.getIncidentEvents(opened.id).events.map((e) => e.eventType)).toContain("health_check");
    });

    it("(b) incident already open when the note is filed: the restart/restart_failed/failed row sets its cause", async () => {
      vi.useFakeTimers();
      const h = createHarness({ trackIncidents: true });
      // The box's shape: operation_end's probe already opened the incident
      // with no cause before the route filed the note.
      await h.failUserRestart();
      const opened = h.db.getOpenIncident();
      expect(opened).toMatchObject({ incidentKey: "gateway_degraded", cause: null });

      h.watchdog.noteRestartFailure({
        operationId: "9e1e29ab-0000-4000-8000-000000000000",
        code: "stop_failed",
        phase: "sigkill",
        signalled: true,
        gatewayDown: true,
      });
      expect(h.db.getOpenIncident().id).toBe(opened.id);
      expect(openCause(h)).toEqual(
        restartCause("restart_stop_failed", "9e1e29ab-0000-4000-8000-000000000000"),
      );
      const [noteRow] = h.db
        .getIncidentEvents(opened.id)
        .events.filter((e) => e.eventType === "restart" && e.source === "restart_failed");
      expect(noteRow).toMatchObject({
        status: "failed",
        details: {
          operationId: "9e1e29ab-0000-4000-8000-000000000000",
          code: "stop_failed",
          phase: "sigkill",
          signalled: true,
          gatewayDown: true,
          cause: "restart_stop_failed",
          by: "restart:9e1e29ab-0000-4000-8000-000000000000",
          corroborated: false,
        },
      });
      // The same operation reported twice files no second row.
      h.watchdog.noteRestartFailure({ operationId: "9e1e29ab-0000-4000-8000-000000000000", code: "stop_failed", gatewayDown: true });
      expect(h.rowsOf("restart", "failed", "restart_failed")).toHaveLength(1);
      h.watchdog.stop();
    });

    it("(c) a corroborated crash cause set earlier survives the note row and the later failed probes", async () => {
      const h = createHarness({ autoRepair: false, trackIncidents: true });
      await greenGateway(h);
      h.control.healthy = false;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      const opened = h.db.getOpenIncident();
      expect(opened).toMatchObject({ cause: null });
      // The crash classifier's corroborated verdict lands on the open incident.
      h.insertWatchdogEvent({
        eventType: "crash_cause",
        source: "crash_classifier",
        status: "failed",
        details: {
          cause: "state_schema_too_new",
          fingerprint: "0123456789ab",
          corroborated: true,
          by: "user_version",
          suspectedCause: null,
        },
        correlationId: "cc-1",
      });
      expect(openCause(h)).toMatchObject({ cause: "state_schema_too_new", corroborated: true });

      h.watchdog.noteRestartFailure({ operationId: "op-c", code: "launch_failed", gatewayDown: true });
      expect(h.rowsOf("restart", "failed", "restart_failed").at(-1).details).toMatchObject({
        cause: "restart_launch_failed",
        by: "restart:op-c",
      });
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      expect(h.rowsOf("health_check", "failed").at(-1).details).toMatchObject({ cause: "restart_launch_failed" });
      expect(h.db.getOpenIncident().id).toBe(opened.id);
      expect(openCause(h)).toMatchObject({
        cause: "state_schema_too_new",
        corroborated: true,
        by: "user_version",
      });
    });

    it("(d) after the green probe clears the note, a NEW incident carries no restart cause", async () => {
      const h = createHarness({ autoRepair: false, trackIncidents: true });
      await greenGateway(h);
      h.watchdog.noteRestartFailure({ operationId: "op-d", code: "stop_failed", gatewayDown: true });
      h.control.healthy = false;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      const first = h.db.getOpenIncident();
      expect(first.cause).toMatchObject({ cause: "restart_stop_failed", by: "restart:op-d" });

      h.control.healthy = true;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(h.watchdog.getRestartFailureNote()).toBeNull();
      expect(h.rowsOf("restart", "ok", "restart_failure_note")).toHaveLength(1);
      expect(h.db.getOpenIncident()).toBeNull();
      expect(h.db.getIncidentById(first.id)).toMatchObject({ status: "resolved" });
      expect(h.db.getIncidentById(first.id).cause).toMatchObject({ cause: "restart_stop_failed" });

      h.control.healthy = false;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      const second = h.db.getOpenIncident();
      expect(second.id).not.toBe(first.id);
      expect(second.cause).toBeNull();
      const lastFailed = h.rowsOf("health_check", "failed").at(-1).details;
      expect(lastFailed).not.toHaveProperty("cause");
      expect(lastFailed).not.toHaveProperty("by");
    });

    it("(e) the code → cause map: ready_timeout → restart_ready_timeout (on the readiness row too), aborted, launch_failed, and the restart_failed fallback", async () => {
      const h = createHarness({ autoRepair: false, trackIncidents: true });
      await greenGateway(h);
      // ready_timeout: the port answers /health but /readyz never came ready
      // — the readiness_degraded row opens the incident with the cause.
      h.watchdog.noteRestartFailure({ operationId: "op-rt", code: "ready_timeout", gatewayDown: false });
      h.control.readyzFailing = ["secrets"];
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      const opened = h.db.getOpenIncident();
      expect(opened).toMatchObject({ incidentKey: "gateway_readiness" });
      expect(opened.cause).toEqual(restartCause("restart_ready_timeout", "op-rt"));
      expect(h.rowsOf("readiness_degraded", "failed").at(-1).details).toMatchObject({
        failing: ["secrets"],
        cause: "restart_ready_timeout",
        by: "restart:op-rt",
        corroborated: false,
      });
      // Each later note replaces the previous (different operationId) and
      // names its own code; an unknown code collapses to restart_failed.
      const causesByCode = [
        ["aborted", "restart_aborted"],
        ["launch_failed", "restart_launch_failed"],
        ["stop_failed", "restart_stop_failed"],
        ["something_else", "restart_failed"],
      ];
      for (const [code, cause] of causesByCode) {
        h.watchdog.noteRestartFailure({ operationId: `op-${code}`, code, gatewayDown: false });
        expect(h.rowsOf("restart", "failed", "restart_failed").at(-1).details).toMatchObject({
          cause,
          by: `restart:op-${code}`,
          corroborated: false,
        });
        // Suspected tier: within it the latest wins.
        expect(openCause(h)).toMatchObject({ cause, by: `restart:op-${code}` });
      }
    });

    it("a note without an operationId still names the cause, with no `by`", async () => {
      const h = createHarness({ autoRepair: false, trackIncidents: true });
      await greenGateway(h);
      h.watchdog.noteRestartFailure({ code: "stop_failed", gatewayDown: true });
      expect(h.rowsOf("restart", "failed", "restart_failed").at(-1).details).toMatchObject({
        operationId: null,
        cause: "restart_stop_failed",
        by: null,
      });
      h.control.healthy = false;
      await h.watchdog.runHealthCheck({ source: "health_timer" });
      expect(openCause(h)).toMatchObject({ cause: "restart_stop_failed", by: null, corroborated: false });
    });
  });
});
