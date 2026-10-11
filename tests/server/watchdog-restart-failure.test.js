const {
  createWatchdog,
  kRestartFailureRecheckDelaysMs,
  kRestartFailureNoteTtlMs,
} = require("../../lib/server/watchdog");

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
  pidAlive = null,
  readPersistedPause = null,
  getOpenclawInfo = null,
  supervisorModeActive = () => false,
  consumeRestartHandoffImpl = null,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
  // The port under test: `healthy` flips what /health answers.
  const control = { healthy: true };
  global.fetch = vi.fn(async () => {
    if (!control.healthy) throw new Error("connect ECONNREFUSED");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    };
  });
  const insertWatchdogEvent = vi.fn();
  const clawCmd = vi.fn(clawCmdImpl);
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const watchdog = createWatchdog({
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
    resolveGatewayReadyzUrl: () => "",
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive,
    ...(consumeRestartHandoffImpl ? { consumeRestartHandoffImpl } : {}),
    ...(degradedRepairThreshold != null ? { degradedRepairThreshold } : {}),
    ...(pidAlive ? { pidAlive } : {}),
    ...(readPersistedPause ? { readPersistedPause, writePersistedPause: vi.fn() } : {}),
    ...(getOpenclawInfo ? { getOpenclawInfo } : {}),
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
});
