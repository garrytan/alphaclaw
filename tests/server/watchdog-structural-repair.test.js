const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kCrashCauseLadderEnvKey,
  kAutoRepairPauseFileName,
  kStructuralRepairSource,
  kStructuralRelaunchSource,
  kStructuralRepairRungs,
  kAutoRepairPauseReasons,
  kAutoRepairPauseHealthHoldMs,
  crashCauseLadderDisabled,
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
  });

  it("the kill switch is deployment-only and follows the OPENCLAW_*=off naming", () => {
    expect(kCrashCauseLadderEnvKey).toBe("OPENCLAW_CRASH_CAUSE_LADDER");
    expect(kDeploymentOnlyEnvKeys).toContain(kCrashCauseLadderEnvKey);
    expect(crashCauseLadderDisabled()).toBe(false);
    process.env[kCrashCauseLadderEnvKey] = "OFF ";
    expect(crashCauseLadderDisabled()).toBe(true);
    process.env[kCrashCauseLadderEnvKey] = "false";
    expect(crashCauseLadderDisabled()).toBe(false);
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
    expect(kAutoRepairPauseHealthHoldMs).toBe(120 * 1000);
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
      renameStrayExecApprovals: vi.fn(() => ({ reaped: true, strayPath: "/x/exec-approvals.json.stray-1" })),
      logger: kSilentLogger,
      ...overrides,
    };
    return { seams, repair: createStructuralRepair(seams), logEvent: vi.fn() };
  };

  it("refuses a run without a relaunch primitive", async () => {
    const { repair } = build();
    await expect(
      repair.runStructuralRepair({ cause: "legacy_exec_approvals", hold: makeHold() }),
    ).rejects.toThrow(TypeError);
  });

  it.each(["state_schema_too_new", "agent_schema_too_new", "plugin_api_too_old", "cli_startup_crash"])(
    "%s has no remedy under the pin: paused structural_repair_failed, no rename, no relaunch, ONE failed row",
    async (cause) => {
      const { seams, repair, logEvent } = build();
      const hold = makeHold();
      const result = await repair.runStructuralRepair({
        cause,
        fingerprint: "fp1",
        corroboration: kCorroborated,
        hold,
        correlationId: "c1",
        relaunch: relaunchOk,
        logEvent,
      });
      expect(seams.renameStrayExecApprovals).not.toHaveBeenCalled();
      expect(relaunchOk).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED,
        verdict: null,
        activated: false,
        plan: [{ step: "ladder", outcome: "no_remedy", detail: cause }],
      });
      const rows = rowsOf(logEvent);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: "repair",
        source: kStructuralRepairSource,
        status: "failed",
        correlationId: "c1",
        details: { cause, fingerprint: "fp1", corroborated: true, by: "user_version", paused: "structural_repair_failed" },
      });
      // The hold is the caller's: never released here.
      expect(hold).not.toHaveBeenCalled();
    },
  );

  it("legacy_exec_approvals → rename → relaunch replace under the CALLER's hold; a missing file, a failed or throwing rename, or no seam pauses", async () => {
    const { seams, repair, logEvent } = build();
    const hold = makeHold();
    const ok = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      fingerprint: "fp2",
      corroboration: { corroborated: true, by: "legacy_exec_approvals_file" },
      hold,
      correlationId: "c2",
      relaunch: relaunchOk,
      logEvent,
    });
    expect(seams.renameStrayExecApprovals).toHaveBeenCalledTimes(1);
    expect(relaunchOk).toHaveBeenCalledWith({
      source: kStructuralRelaunchSource,
      intent: "replace",
      hold,
      correlationId: "c2",
    });
    expect(ok).toEqual({
      ok: true,
      paused: null,
      verdict: "replacement_pending",
      activated: true,
      plan: [
        {
          step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS,
          outcome: "renamed",
          detail: "/x/exec-approvals.json.stray-1",
        },
        { step: kStructuralRepairRungs.RELAUNCH, outcome: "replacement_pending" },
      ],
    });
    expect(rowsOf(logEvent)).toEqual([
      expect.objectContaining({ status: "ok", details: expect.objectContaining({ verdict: "replacement_pending" }) }),
    ]);
    expect(hold).not.toHaveBeenCalled();

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
    expect(failed.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);

    const throwing = build({
      renameStrayExecApprovals: vi.fn(() => {
        throw new Error("disk on fire");
      }),
    });
    const threw = await throwing.repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(threw.plan[0]).toEqual({
      step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS,
      outcome: "failed",
      detail: "disk on fire",
    });
    expect(threw.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);

    const unavailable = build({ renameStrayExecApprovals: null });
    const none = await unavailable.repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
    });
    expect(none.plan[0]).toEqual({ step: kStructuralRepairRungs.RENAME_EXEC_APPROVALS, outcome: "unavailable" });
    expect(none.paused).toBe(kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED);
    expect(relaunchOk).toHaveBeenCalledTimes(1);
  });

  it("a relaunch that fails after the rename is ok:false but NOT a pause (the legacy ladder escalates); a throwing relaunch is launch_failed", async () => {
    const { repair } = build();
    const failed = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: vi.fn(async () => ({ verdict: "launch_failed", error: new Error("no exec") })),
    });
    expect(failed).toMatchObject({ ok: false, paused: null, verdict: "launch_failed", activated: true });
    const threw = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      corroboration: kCorroborated,
      hold: makeHold(),
      relaunch: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect(threw).toMatchObject({ ok: false, verdict: "launch_failed", paused: null });
  });

  it("lock fence: a lapsed hold ends the plan with lease_expired before any rung runs", async () => {
    const { seams, repair } = build();
    const dead = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold({ valid: false }),
      relaunch: relaunchOk,
    });
    expect(dead).toMatchObject({ ok: false, skipped: "lease_expired", paused: null });
    expect(dead.plan).toEqual([{ step: "ladder", outcome: "lease_expired" }]);
    expect(seams.renameStrayExecApprovals).not.toHaveBeenCalled();
    expect(relaunchOk).not.toHaveBeenCalled();
  });

  it("kill switch OPENCLAW_CRASH_CAUSE_LADDER=off: skipped {disabled}, no rung runs, no relaunch; a non-structural cause is skipped {not_structural}", async () => {
    process.env[kCrashCauseLadderEnvKey] = "off";
    const { seams, repair, logEvent } = build();
    expect(repair.isEnabled()).toBe(false);
    const off = await repair.runStructuralRepair({
      cause: "legacy_exec_approvals",
      hold: makeHold(),
      relaunch: relaunchOk,
      logEvent,
    });
    expect(off).toMatchObject({ ok: false, skipped: "disabled", paused: null });
    expect(seams.renameStrayExecApprovals).not.toHaveBeenCalled();
    expect(relaunchOk).not.toHaveBeenCalled();
    expect(rowsOf(logEvent)[0]).toMatchObject({ status: "skipped", details: { reason: "disabled" } });
    delete process.env[kCrashCauseLadderEnvKey];
    expect(repair.isEnabled()).toBe(true);
    const oom = await repair.runStructuralRepair({ cause: "oom", hold: makeHold(), relaunch: relaunchOk });
    expect(oom).toMatchObject({ ok: false, skipped: "not_structural" });
    expect(relaunchOk).not.toHaveBeenCalled();
  });
});
