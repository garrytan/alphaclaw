// Guard-wrapped `doctor --fix` runner (issue #20 bug 3) — the wiring
// lib/server.js hands to the watchdog's auto-repair and the startup medic:
// pre-doctor backup, restore-guard around the run, and the
// doctor_restored_stale_config short-circuit with the shared notification.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createDoctorFixRunner } = require("../../lib/server/doctor-fix-runner");
const {
  createDoctorGuard,
  buildDoctorRestoreBlockedNotification,
} = require("../../lib/server/doctor-guard");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kGatewayEnv = { OPENCLAW_HOME: "/data/.openclaw" };

const mkOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-doctor-fix-"));

const writeJson = (dir, name, obj) =>
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(obj, null, 2)}\n`);
const readJson = (dir, name) =>
  JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

// Pass-through guard: exercises the runner's own wiring without the real
// quarantine machinery (the real guard gets its own integration case below).
const passthroughGuard = () => ({
  withDoctorRestoreGuard: vi.fn(async ({ run }) => ({
    ...(await run()),
    guard: { quarantined: false },
  })),
});

const createRunner = (openclawDir, overrides = {}) => {
  const runStream = overrides.runStream ?? {
    runStreamed: vi.fn(async () => ({ ok: true, tail: "Doctor complete\n" })),
  };
  const notifier = overrides.notifier ?? { notify: vi.fn() };
  const doctorGuard = overrides.doctorGuard ?? passthroughGuard();
  const run = createDoctorFixRunner({
    openclawDir,
    doctorGuard,
    runStream,
    gatewayEnv: () => kGatewayEnv,
    notifier,
    ...(overrides.nowFn ? { nowFn: overrides.nowFn } : {}),
  });
  return { run, runStream, notifier, doctorGuard };
};

describe("server/doctor-fix-runner", () => {
  it("writes the rolling pre-doctor backup, then runs doctor inside the guard", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", { keep: 1 });
    let backupAtRunTime = null;
    const runStream = {
      runStreamed: vi.fn(async () => {
        // The backup must already exist when doctor starts mutating.
        backupAtRunTime = readJson(openclawDir, "openclaw.json.pre-doctor.bak");
        return { ok: true, tail: "Doctor complete\n" };
      }),
    };
    const { run, doctorGuard } = createRunner(openclawDir, { runStream });

    const result = await run();

    expect(result).toMatchObject({ ok: true, stdout: "Doctor complete\n", stderr: "" });
    expect(backupAtRunTime).toEqual({ keep: 1 });
    expect(doctorGuard.withDoctorRestoreGuard).toHaveBeenCalledTimes(1);
    expect(runStream.runStreamed).toHaveBeenCalledWith({
      command: "openclaw",
      args: ["doctor", "--fix", "--yes"],
      env: kGatewayEnv,
      timeoutMs: 10 * 60 * 1000,
    });
  });

  it("forwards a caller timeout and never aborts on a missing config (backup is best-effort)", async () => {
    const openclawDir = mkOpenclawDir(); // no openclaw.json written
    const { run, runStream } = createRunner(openclawDir);

    const result = await run({ timeoutMs: 120_000 });

    expect(result.ok).toBe(true);
    expect(runStream.runStreamed.mock.calls[0][0].timeoutMs).toBe(120_000);
    expect(
      fs.existsSync(path.join(openclawDir, "openclaw.json.pre-doctor.bak")),
    ).toBe(false);
  });

  it("short-circuits a blocked stale restore with the shared notification (counts only)", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", { keep: 1 });
    const doctorGuard = {
      withDoctorRestoreGuard: vi.fn(async () => ({
        ok: false,
        code: "doctor_restored_stale_config",
        signals: ["mcpServers_shrank", "env_ref_became_literal"],
        droppedKeyPaths: ["mcp.servers.nessie", "models.providers.together"],
        reverted: true,
        guard: { quarantined: true },
      })),
    };
    const { run, notifier } = createRunner(openclawDir, {
      doctorGuard,
      nowFn: () => 1_756_400_000_000,
    });

    const result = await run();

    // Never reports success; the restore verdict rides the code field.
    expect(result).toEqual({
      ok: false,
      stdout: "",
      stderr:
        "doctor --fix attempted a stale last-known-good restore (mcpServers_shrank, env_ref_became_literal); AlphaClaw reverted it",
      code: "doctor_restored_stale_config",
    });
    // Exactly the shared copy (non-held variant), key-path COUNT only.
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notifier.notify.mock.calls[0];
    expect(message).toBe(buildDoctorRestoreBlockedNotification(2));
    expect(message).not.toContain("nessie");
    expect(opts).toEqual({
      eventType: "health",
      id: "doctor-restore-blocked-1756400000000",
    });
  });

  it("maps a timed-out doctor to the 10m stderr message without notifying", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", { keep: 1 });
    const runStream = {
      runStreamed: vi.fn(async () => ({
        ok: false,
        code: null,
        tail: "partial output",
        timedOut: true,
      })),
    };
    const { run, notifier } = createRunner(openclawDir, { runStream });

    const result = await run();

    expect(result).toMatchObject({
      ok: false,
      stdout: "partial output",
      stderr: "doctor --fix timed out after 10m",
    });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("integration: the REAL guard quarantines last-good for the run and blocks a swap", async () => {
    const openclawDir = mkOpenclawDir();
    const liveConfig = {
      meta: { lastTouchedAt: "2026-08-29T05:12:17Z" },
      mcp: { servers: { nessie: { url: "https://example.com/mcp" } } },
    };
    const staleConfig = {
      meta: { lastTouchedAt: "2026-06-11T00:00:00Z" },
      mcp: { servers: {} },
    };
    writeJson(openclawDir, "openclaw.json", liveConfig);
    writeJson(openclawDir, "openclaw.json.last-good", staleConfig);
    let lastGoodDuringRun = "present";
    const runStream = {
      runStreamed: vi.fn(async () => {
        lastGoodDuringRun = fs.existsSync(
          path.join(openclawDir, "openclaw.json.last-good"),
        )
          ? "present"
          : "absent";
        // A restore path the quarantine did not reach swaps the config.
        writeJson(openclawDir, "openclaw.json", staleConfig);
        return { ok: true, tail: "Doctor complete\n" };
      }),
    };
    const notifier = { notify: vi.fn() };
    const { run } = createRunner(openclawDir, {
      doctorGuard: createDoctorGuard({ openclawDir, logger: kSilentLogger }),
      runStream,
      notifier,
    });

    const result = await run();

    // Doctor could not have restored what was not there.
    expect(lastGoodDuringRun).toBe("absent");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("doctor_restored_stale_config");
    // Tripwires put the live config back and the operator was told.
    expect(readJson(openclawDir, "openclaw.json")).toEqual(liveConfig);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    // The pre-doctor backup survives as the manual-recovery artifact.
    expect(readJson(openclawDir, "openclaw.json.pre-doctor.bak")).toEqual(
      liveConfig,
    );
  });
});
