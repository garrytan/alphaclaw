const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kCrashCauseLadderEnvKey,
  kLaunchCompatGateEnvKey,
  kAutoRepairPauseFileName,
  kStructuralRepairSource,
  kStructuralRelaunchSource,
  kStructuralRepairRungs,
  kAutoRepairPauseReasons,
  crashCauseLadderDisabled,
  launchCompatGateDisabled,
  isVersionFamilyCause,
  normalizeAutoRepairPause,
  serializeAutoRepairPause,
  createAutoRepairPauseStore,
  createStructuralRepair,
} = require("../../lib/server/watchdog-structural-repair");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A lifecycle-lock release double with the real contract (callable +
// isValid()/isExpired()).
const makeHold = ({ valid = true } = {}) => {
  let live = valid;
  return Object.assign(
    vi.fn(() => {
      live = false;
    }),
    { kind: "structural_repair", isValid: () => live, isExpired: () => !live, invalidate: () => { live = false; } },
  );
};
const activated = (to, extra = {}) => ({
  ok: true,
  action: "activated",
  from: "1.0.0",
  to,
  runId: "run-1",
  ...extra,
});
const refused = (code) => ({ ok: false, code, action: "none", message: code });
const relaunchOk = vi.fn(async () => ({ verdict: "replacement_pending", pid: 4242 }));

const rowsOf = (logEvent) => logEvent.mock.calls.map((call) => ({
  eventType: call[0],
  source: call[1],
  status: call[2],
  details: call[3],
  correlationId: call[4],
}));

describe("watchdog-structural-repair: constants + kill switches", () => {
  afterEach(() => {
    delete process.env[kCrashCauseLadderEnvKey];
    delete process.env[kLaunchCompatGateEnvKey];
  });

  it("the kill switch is deployment-only and follows the OPENCLAW_*=off naming; the compat-gate key mirrors channel-sync's export", () => {
    expect(kCrashCauseLadderEnvKey).toBe("OPENCLAW_CRASH_CAUSE_LADDER");
    expect(kDeploymentOnlyEnvKeys).toContain(kCrashCauseLadderEnvKey);
    const channelSync = require("../../lib/server/openclaw-channel-sync");
    expect(kLaunchCompatGateEnvKey).toBe(channelSync.kLaunchCompatGateEnvKey);
    expect(crashCauseLadderDisabled()).toBe(false);
    process.env[kCrashCauseLadderEnvKey] = "OFF ";
    expect(crashCauseLadderDisabled()).toBe(true);
    process.env[kCrashCauseLadderEnvKey] = "false";
    expect(crashCauseLadderDisabled()).toBe(false);
    process.env[kLaunchCompatGateEnvKey] = "off";
    expect(launchCompatGateDisabled()).toBe(true);
  });

  it("version-family predicate follows the classifier's list; the file name matches the C5 fixture directory", () => {
    for (const cause of [
      "state_schema_too_new",
      "agent_schema_too_new",
      "state_schema_migration_failed",
      "legacy_exec_approvals",
      "plugin_api_too_old",
      "cli_startup_crash",
    ]) {
      expect(isVersionFamilyCause(cause)).toBe(true);
    }
    for (const cause of ["oom", "port_in_use", "unknown", null, undefined, 42]) {
      expect(isVersionFamilyCause(cause)).toBe(false);
    }
    expect(kAutoRepairPauseFileName).toBe("auto-repair-pause.json");
    expect(fs.existsSync(path.join(__dirname, "fixtures", "persisted-formats", kAutoRepairPauseFileName))).toBe(true);
    expect(kStructuralRepairSource).toBe("structural");
    expect(kStructuralRelaunchSource).toBe("repair/structural");
  });
});

describe("watchdog-structural-repair: pause codec + store", () => {
  it("normalizes the persisted shape, refuses records without an identity, and serializes exactly the seven persisted keys", () => {
    expect(normalizeAutoRepairPause(null)).toBe(null);
    expect(normalizeAutoRepairPause([])).toBe(null);
    expect(normalizeAutoRepairPause({ cause: "state_schema_too_new" })).toBe(null); // no fingerprint
    expect(normalizeAutoRepairPause({ fingerprint: "abc" })).toBe(null); // no cause
    const pause = normalizeAutoRepairPause({
      at: "not-a-number",
      cause: "state_schema_too_new",
      fingerprint: "deadbeefcafe",
      installedVersion: "",
      attempts: -3,
      lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing", extra: true },
      reason: null,
      unknown: "dropped",
    });
    expect(pause).toEqual({
      at: 0,
      cause: "state_schema_too_new",
      fingerprint: "deadbeefcafe",
      installedVersion: null,
      attempts: 0,
      lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
      reason: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED,
    });
    const text = serializeAutoRepairPause({
      at: 1788681900000,
      cause: "state_schema_too_new",
      fingerprint: "deadbeefcafe",
      installedVersion: "2026.7.1-2",
      attempts: 3,
      lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
      reason: "structural_repair_failed",
      corroborated: true, // in-memory only, never persisted
    });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "at",
      "cause",
      "fingerprint",
      "installedVersion",
      "attempts",
      "lastPlan",
      "reason",
    ]);
    expect(text.endsWith("\n")).toBe(true);
    expect(serializeAutoRepairPause(null)).toBe(null);
  });

  it("store: read() is lenient (missing → null, torn JSON → null + one warning), write() is atomic and round-trips, clear()/write(null) unlink", () => {
    const dir = mkTemp("alphaclaw-pause-store-");
    const filePath = path.join(dir, "nested", kAutoRepairPauseFileName);
    const warn = vi.fn();
    const store = createAutoRepairPauseStore({ filePath, logger: { ...kSilentLogger, warn } });
    expect(store.read()).toBe(null);
    expect(warn).not.toHaveBeenCalled();
    const pause = {
      at: 1788681900000,
      cause: "state_schema_too_new",
      fingerprint: "deadbeefcafe",
      installedVersion: "2026.7.1-2",
      attempts: 1,
      lastPlan: { rung: "recover_bootable", outcome: "no_bootable_version" },
      reason: "structural_repair_failed",
    };
    expect(store.write(pause)).toBe(true);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([kAutoRepairPauseFileName]); // no .tmp left behind
    expect(store.read()).toEqual(pause);
    fs.writeFileSync(filePath, '{"at": 1, "cause": "state_schema_too_new", "fingerprint": "x", "atte', "utf8");
    expect(store.read()).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("not valid JSON");
    expect(store.write(pause)).toBe(true);
    expect(store.write(null)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.clear()).toBe(false); // already gone, no warning
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => createAutoRepairPauseStore({})).toThrow(TypeError);
  });
});

describe("watchdog-structural-repair: runStructuralRepair rungs", () => {
  const kCorroborated = { corroborated: true, by: "user_version" };
  afterEach(() => {
    delete process.env[kCrashCauseLadderEnvKey];
    relaunchOk.mockClear();
  });

  const build = (overrides = {}) => {
    const seams = {
      reconcileInstalled: vi.fn(async () => activated("2.0.0")),
      recoverBootable: vi.fn(async () => activated("1.5.0", { schemaRecovery: true })),
      renameStrayExecApprovals: vi.fn(() => ({ reaped: true, strayPath: "/x/exec-approvals.json.stray-1" })),
      undoLastConfigRestore: vi.fn(() => ({ ok: false, code: "no_restore" })),
      completeReconcileRun: vi.fn(),
      getChannelInfo: vi.fn(() => ({ installedDiverged: true, installedVersion: "1.0.0", expectedVersion: "2.0.0" })),
      logger: kSilentLogger,
      ...overrides,
    };
    return { seams, repair: createStructuralRepair(seams), logEvent: vi.fn() };
  };

  it("requires reconcileInstalled; refuses a run without a relaunch primitive", async () => {
    expect(() => createStructuralRepair({})).toThrow(TypeError);
    const { repair } = build();
    await expect(
      repair.runStructuralRepair({ cause: "state_schema_too_new", hold: makeHold() }),
    ).rejects.toThrow(TypeError);
  });

  it("(1) installedDiverged → reconcileInstalled under the CALLER's hold → undoLastConfigRestore → relaunch replace → completeReconcileRun books the relaunch; ONE repair/structural/ok row carries the plan", async () => {
    const { seams, repair, logEvent } = build();
    const hold = makeHold();
    const result = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      fingerprint: "fp1",
      corroboration: kCorroborated,
      hold,
      correlationId: "c1",
      relaunch: relaunchOk,
      logEvent,
    });
    expect(seams.reconcileInstalled).toHaveBeenCalledWith({ hold, source: "structural_repair", relaunch: true });
    expect(seams.recoverBootable).not.toHaveBeenCalled();
    expect(seams.renameStrayExecApprovals).not.toHaveBeenCalled();
    expect(seams.undoLastConfigRestore).toHaveBeenCalledTimes(1);
    expect(relaunchOk).toHaveBeenCalledWith({
      source: kStructuralRelaunchSource,
      intent: "replace",
      hold,
      correlationId: "c1",
    });
    expect(seams.completeReconcileRun).toHaveBeenCalledWith({
      runId: "run-1",
      relaunch: { ok: true, verdict: "replacement_pending" },
    });
    expect(result).toEqual({
      ok: true,
      paused: null,
      verdict: "replacement_pending",
      runId: "run-1",
      activated: true,
      plan: [
        { step: kStructuralRepairRungs.RECONCILE_INSTALLED, outcome: "activated", detail: "1.0.0 → 2.0.0" },
        { step: kStructuralRepairRungs.UNDO_CONFIG_RESTORE, outcome: "no_restore" },
        { step: kStructuralRepairRungs.RELAUNCH, outcome: "replacement_pending", detail: "on 2.0.0" },
      ],
    });
    const rows = rowsOf(logEvent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "repair",
      source: kStructuralRepairSource,
      status: "ok",
      correlationId: "c1",
      details: {
        cause: "state_schema_too_new",
        fingerprint: "fp1",
        corroborated: true,
        by: "user_version",
        paused: null,
        verdict: "replacement_pending",
        runId: "run-1",
      },
    });
    expect(rows[0].details.plan).toHaveLength(3);
    // The hold is the caller's: never released here.
    expect(hold).not.toHaveBeenCalled();
  });

  it("(1) refused (overlay_missing) → (3) recoverBootable in schema-recovery mode → relaunch; the undo rung runs only after an activation", async () => {
    const { seams, repair, logEvent } = build({
      reconcileInstalled: vi.fn(async () => refused("overlay_missing")),
    });
    const hold = makeHold();
    const result = await repair.runStructuralRepair({
      cause: "agent_schema_too_new",
      fingerprint: "fp2",
      corroboration: kCorroborated,
      hold,
      relaunch: relaunchOk,
      logEvent,
    });
    expect(seams.recoverBootable).toHaveBeenCalledWith({ hold, source: "structural_repair", relaunch: true });
    expect(seams.undoLastConfigRestore).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.plan).toEqual([
      { step: kStructuralRepairRungs.RECONCILE_INSTALLED, outcome: "overlay_missing" },
      { step: kStructuralRepairRungs.RECOVER_BOOTABLE, outcome: "activated", detail: "1.0.0 → 1.5.0" },
      { step: kStructuralRepairRungs.RELAUNCH, outcome: "replacement_pending", detail: "on 1.5.0" },
    ]);
  });

  it("not diverged → (3) directly; nothing bootable → paused structural_repair_failed with the last plan naming the refusal, no relaunch", async () => {
    const { seams, repair, logEvent } = build({
      getChannelInfo: () => ({ installedDiverged: false, installedVersion: "2.0.0", expectedVersion: "2.0.0" }),
      recoverBootable: vi.fn(async () => refused("no_bootable_version")),
    });
    const result = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      fingerprint: "fp3",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: relaunchOk,
      logEvent,
    });
    expect(seams.reconcileInstalled).not.toHaveBeenCalled();
    expect(relaunchOk).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED,
      verdict: null,
      plan: [
        { step: kStructuralRepairRungs.RECONCILE_INSTALLED, outcome: "not_diverged" },
        { step: kStructuralRepairRungs.RECOVER_BOOTABLE, outcome: "no_bootable_version" },
      ],
    });
    expect(rowsOf(logEvent)[0]).toMatchObject({ status: "failed", details: { paused: "structural_repair_failed" } });
  });

  it("(3) `none` (target compatible after a recovery preflight) is not an activation: the plan records the reason and the ladder pauses rather than relaunching a guess", async () => {
    const { repair } = build({
      getChannelInfo: () => ({ installedDiverged: false }),
      recoverBootable: vi.fn(async () => ({ ok: true, action: "none", reason: "target_compatible", runId: null })),
    });
    const result = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(relaunchOk).not.toHaveBeenCalled();
    expect(result.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);
    expect(result.plan[1]).toEqual({ step: kStructuralRepairRungs.RECOVER_BOOTABLE, outcome: "target_compatible" });
  });

  it("(2) legacy_exec_approvals → rename → relaunch, never the reconcile rungs; a missing file or a failed rename pauses", async () => {
    const { seams, repair } = build();
    const ok = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      corroboration: { corroborated: true, by: "legacy_exec_approvals_file" },
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(seams.renameStrayExecApprovals).toHaveBeenCalledTimes(1);
    expect(seams.reconcileInstalled).not.toHaveBeenCalled();
    expect(seams.recoverBootable).not.toHaveBeenCalled();
    expect(ok.ok).toBe(true);
    expect(ok.plan).toEqual([
      {
        step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS,
        outcome: "renamed",
        detail: "/x/exec-approvals.json.stray-1",
      },
      { step: kStructuralRepairRungs.RELAUNCH, outcome: "replacement_pending" },
    ]);

    const gone = build({ renameStrayExecApprovals: vi.fn(() => ({ reaped: false })) });
    const missing = await gone.repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(missing.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);
    expect(missing.plan[0]).toEqual({ step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS, outcome: "not_found" });

    const failing = build({ renameStrayExecApprovals: vi.fn(() => ({ reaped: false, error: "EACCES" })) });
    const failed = await failing.repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(failed.plan[0]).toEqual({
      step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS,
      outcome: "failed",
      detail: "EACCES",
    });
    const unavailable = build({ renameStrayExecApprovals: null });
    const none = await unavailable.repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(none.plan[0]).toEqual({ step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS, outcome: "unavailable" });
    expect(none.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);
  });

  it("a relaunch that fails after an activation is ok:false but NOT a pause (the legacy ladder escalates); a version_mismatch verdict from the relaunch's compat step IS a failed structural repair", async () => {
    const { seams, repair } = build();
    const failed = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: vi.fn(async () => ({ verdict: "launch_failed", error: new Error("no exec") })),
    });
    expect(failed).toMatchObject({ ok: false, paused: null, verdict: "launch_failed", activated: true, runId: "run-1" });
    expect(seams.completeReconcileRun).toHaveBeenCalledWith({
      runId: "run-1",
      relaunch: { ok: false, verdict: "launch_failed", error: "no exec" },
    });
    const mismatch = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: vi.fn(async () => ({ verdict: "version_mismatch" })),
    });
    expect(mismatch).toMatchObject({ ok: false, paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED, verdict: "version_mismatch" });
    // A throwing relaunch is a launch_failed, never an exception into the watchdog.
    const threw = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(threw).toMatchObject({ ok: false, verdict: "launch_failed", paused: null });
  });

  it("lock re-entrancy fence: a hold that lapses after a rung ends the plan with lease_expired and never relaunches", async () => {
    const hold = makeHold();
    const { repair } = build({
      reconcileInstalled: vi.fn(async () => {
        hold.invalidate();
        return activated("2.0.0");
      }),
    });
    const result = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      corroboration: kCorroborated,
      hold,
      relaunch: relaunchOk,
    });
    expect(relaunchOk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: "lease_expired", paused: null });
    expect(result.plan).toEqual([{ step: kStructuralRepairRungs.RECONCILE_INSTALLED, outcome: "lease_expired" }]);
    const dead = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      hold: makeHold({ valid: false }),
      relaunch: relaunchOk,
    });
    expect(dead.skipped).toBe("lease_expired");
  });

  it("kill switch OPENCLAW_CRASH_CAUSE_LADDER=off: skipped {disabled}, no rung runs, no relaunch; a non-structural cause is skipped {not_structural}", async () => {
    process.env[kCrashCauseLadderEnvKey] = "off";
    const { seams, repair, logEvent } = build();
    expect(repair.isEnabled()).toBe(false);
    const off = await repair.runStructuralRepair({
      cause: "state_schema_too_new",
      hold: makeHold(),
      relaunch: relaunchOk,
      logEvent,
    });
    expect(off).toMatchObject({ ok: false, skipped: "disabled", paused: null });
    expect(seams.reconcileInstalled).not.toHaveBeenCalled();
    expect(relaunchOk).not.toHaveBeenCalled();
    expect(rowsOf(logEvent)[0]).toMatchObject({ status: "skipped", details: { reason: "disabled" } });
    delete process.env[kCrashCauseLadderEnvKey];
    expect(repair.isEnabled()).toBe(true);
    const oom = await repair.runStructuralRepair({ cause: "oom", hold: makeHold(), relaunch: relaunchOk });
    expect(oom).toMatchObject({ ok: false, skipped: "not_structural" });
    expect(relaunchOk).not.toHaveBeenCalled();
  });

  it("a throwing seam is a refusal, not an exception: reconcile_threw falls through to (3), a throwing recover pauses", async () => {
    const { repair } = build({
      reconcileInstalled: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
      recoverBootable: vi.fn(async () => {
        throw new Error("also on fire");
      }),
    });
    const result = await repair.runStructuralRepair({
      cause: "plugin_api_too_old",
      corroboration: { corroborated: true, by: "installed_diverged" },
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(result.plan).toEqual([
      { step: kStructuralRepairRungs.RECONCILE_INSTALLED, outcome: "reconcile_threw" },
      { step: kStructuralRepairRungs.RECOVER_BOOTABLE, outcome: "recover_threw" },
    ]);
    expect(result.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);
  });
});
