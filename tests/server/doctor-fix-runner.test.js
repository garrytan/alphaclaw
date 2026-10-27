// Guard-wrapped `doctor --fix` runner (issue #20 bug 3) — the wiring
// lib/server.js hands to the watchdog's auto-repair and the startup medic:
// pre-doctor backup, restore-guard around the run, and the
// doctor_restored_stale_config short-circuit with the shared notification.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createDoctorFixRunner,
  createOutputLineTracker,
  kDoctorHeartbeatMs,
  kDoctorPartialLineCapBytes,
} = require("../../lib/server/doctor-fix-runner");
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
  const logger = overrides.logger ?? { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = createDoctorFixRunner({
    openclawDir,
    doctorGuard,
    runStream,
    gatewayEnv: () => kGatewayEnv,
    notifier,
    logger,
    ...(overrides.nowFn ? { nowFn: overrides.nowFn } : {}),
    ...(overrides.readProgress ? { readProgress: overrides.readProgress } : {}),
  });
  return { run, runStream, notifier, doctorGuard, logger };
};

const heartbeatLines = (logger) =>
  logger.log.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("[alphaclaw] doctor heartbeat "));

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
      env: { ...kGatewayEnv, OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
      timeoutMs: 10 * 60 * 1000,
      killGraceMs: 1000,
      onOutput: expect.any(Function),
    });
    // The trace is the Doctor child's only: the gateway env is not changed.
    expect(kGatewayEnv).not.toHaveProperty("OPENCLAW_GATEWAY_STARTUP_TRACE");
    // A succeeded run carries no hang diagnostics.
    expect(result).not.toHaveProperty("lastOutputAgeMs");
    expect(result).not.toHaveProperty("lastOutputLine");
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

// Bug #137 PR 2: the 30 s heartbeat that tells a hung doctor from a slow one.
describe("server/doctor-fix-runner heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // runStreamed stand-in driven by the fake clock: emits output at the given
  // offsets, settles (or rejects) at `settleAt`.
  const scriptedRunStream = ({ outputs = [], settleAt, result, error = null }) => ({
    runStreamed: vi.fn(({ onOutput }) => new Promise((resolve, reject) => {
      for (const { at, text, stream = "stdout" } of outputs) {
        if (at === 0) onOutput(text, stream);
        else setTimeout(() => onOutput(text, stream), at);
      }
      setTimeout(() => (error ? reject(error) : resolve(result)), settleAt);
    })),
  });

  it("logs one heartbeat every 30 s with elapsed, sinceOutput and the last line, none after settle", async () => {
    const openclawDir = mkOpenclawDir();
    const runStream = scriptedRunStream({
      outputs: [
        { at: 0, text: "Checking config\n" },
        { at: 45_000, text: "Repairing agents\n" },
      ],
      settleAt: 70_000,
      result: { ok: true, tail: "Doctor complete\n" },
    });
    const { run, logger } = createRunner(openclawDir, { runStream });
    const baseline = vi.getTimerCount();

    const pending = run();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(heartbeatLines(logger)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(heartbeatLines(logger)).toEqual([
      '[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="Checking config"',
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatLines(logger)).toEqual([
      '[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="Checking config"',
      '[alphaclaw] doctor heartbeat elapsed=60s sinceOutput=15s last="Repairing agents"',
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(baseline);
    // Long after settle: still exactly two.
    await vi.advanceTimersByTimeAsync(kDoctorHeartbeatMs * 10);
    expect(heartbeatLines(logger)).toHaveLength(2);
  });

  it("reads Doctor's phase on every heartbeat, logs it and hands it to onProgress (ALPH-23)", async () => {
    const openclawDir = mkOpenclawDir();
    const runStream = scriptedRunStream({
      outputs: [
        { at: 0, text: "┌  OpenClaw doctor\n" },
        { at: 40_000, text: "[gateway] startup trace: doctor.database-preflight 822.3ms total=412490.8ms\n" },
      ],
      settleAt: 70_000,
      result: { ok: true, tail: "" },
    });
    const readProgress = vi.fn(({ phase }) => ({ phase, words: phase === "capture" ? "Making a recovery copy: 4.1 of 16.0 GB" : "Backing up each database" }));
    const { run, logger } = createRunner(openclawDir, { runStream, readProgress });
    const onProgress = vi.fn();

    const pending = run({ onProgress });
    await vi.advanceTimersByTimeAsync(70_000);
    await pending;

    expect(readProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ phase: "capture", migrated: 0, startedAtMs: expect.any(Number) }));
    expect(heartbeatLines(logger)).toEqual([
      '[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="┌  OpenClaw doctor" progress="Making a recovery copy: 4.1 of 16.0 GB"',
      '[alphaclaw] doctor heartbeat elapsed=60s sinceOutput=20s last="[gateway] startup trace: doctor.database-preflight 822.3ms total=412490.8ms" progress="Backing up each database"',
    ]);
    expect(onProgress).toHaveBeenLastCalledWith({
      elapsedMs: 60_000,
      sinceOutputMs: 20_000,
      progress: { phase: "backup", words: "Backing up each database" },
    });
  });

  it("keeps the heartbeat when the progress reader throws", async () => {
    const openclawDir = mkOpenclawDir();
    const runStream = scriptedRunStream({ settleAt: 40_000, result: { ok: true, tail: "" } });
    const { run, logger } = createRunner(openclawDir, {
      runStream,
      readProgress: () => {
        throw new Error("EACCES");
      },
    });
    const pending = run();
    await vi.advanceTimersByTimeAsync(40_000);
    await pending;
    expect(heartbeatLines(logger)).toEqual(['[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="-"']);
  });

  it('reports last="-" and sinceOutput=elapsed before doctor has printed anything', async () => {
    const openclawDir = mkOpenclawDir();
    const runStream = scriptedRunStream({
      settleAt: 40_000,
      result: { ok: true, tail: "" },
    });
    const { run, logger } = createRunner(openclawDir, { runStream });

    const pending = run();
    await vi.advanceTimersByTimeAsync(40_000);
    await pending;

    expect(heartbeatLines(logger)).toEqual([
      '[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="-"',
    ]);
  });

  it("re-splits chunks on newlines and carries a trailing partial line into the next chunk", () => {
    let now = 1_000;
    const tracker = createOutputLineTracker({ nowFn: () => now, startedAt: 0 });

    tracker.onOutput("abc", "stdout");
    expect(tracker.lastLine()).toBeNull();
    expect(tracker.lastOutputAgeMs()).toBe(0);

    now = 6_000;
    tracker.onOutput("def\nghi", "stdout");
    expect(tracker.lastLine()).toBe("abcdef");

    now = 7_000;
    tracker.onOutput("\n", "stderr");
    expect(tracker.lastLine()).toBe("abcdef");
    expect(tracker.lastOutputAgeMs()).toBe(0);
    tracker.onOutput("\n", "stdout");
    expect(tracker.lastLine()).toBe("ghi");
    expect(tracker.lastOutputAgeMs()).toBe(0);
    now = 9_500;
    expect(tracker.lastOutputAgeMs()).toBe(2_500);

    // Blank lines never replace the last meaningful one.
    tracker.onOutput("\n   \n", "stdout");
    expect(tracker.lastLine()).toBe("ghi");
  });

  it("frames stdout and stderr separately, so interleaved chunks never splice two lines", () => {
    const tracker = createOutputLineTracker({ nowFn: () => 0, startedAt: 0 });

    tracker.onOutput("Doctor could not ", "stdout");
    tracker.onOutput("[gateway] startup trace: doctor.contributions 12.", "stderr");
    tracker.onOutput("enter maintenance.\n", "stdout");
    tracker.onOutput("5ms total=900.1ms\n", "stderr");

    expect(tracker.lastDetailLine()).toBe("Doctor could not enter maintenance.");
    expect(tracker.lastLine()).toBe("[gateway] startup trace: doctor.contributions 12.5ms total=900.1ms");
  });

  it("caps the partial-line buffer at 4 KB by dropping the head", () => {
    const tracker = createOutputLineTracker({ nowFn: () => 0, startedAt: 0 });

    // One unterminated 8 KB line: the head ("a"s) is dropped, the most recent
    // 4 KB ("b"s) survives into the next chunk.
    tracker.onOutput(`${"a".repeat(kDoctorPartialLineCapBytes)}${"b".repeat(kDoctorPartialLineCapBytes)}`, "stdout");
    expect(tracker.lastLine()).toBeNull();
    tracker.onOutput("\n", "stdout");

    expect(tracker.lastLine()).toBe("b".repeat(240));
  });

  it("redacts token-shaped secrets in the heartbeat line and in lastOutputLine", async () => {
    const openclawDir = mkOpenclawDir();
    const secretLine = "auth failed for Bearer abcdefghijklmnop0123 at https://hooks.slack.com/services/T000/B000/XXXX\n";
    const runStream = scriptedRunStream({
      outputs: [{ at: 0, text: secretLine, stream: "stderr" }],
      settleAt: 35_000,
      result: { ok: false, code: 1, tail: secretLine },
    });
    const { run, logger } = createRunner(openclawDir, { runStream });

    const pending = run();
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await pending;

    const [heartbeat] = heartbeatLines(logger);
    expect(heartbeat).toBe(
      '[alphaclaw] doctor heartbeat elapsed=30s sinceOutput=30s last="auth failed for *** at https://hooks.slack.com/services/***"',
    );
    expect(result).toMatchObject({
      ok: false,
      lastOutputAgeMs: 35_000,
      lastOutputLine: "auth failed for *** at https://hooks.slack.com/services/***",
    });
    expect(result.lastOutputLine).not.toContain("abcdefghijklmnop0123");
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("abcdefghijklmnop0123");
  });

  it("clears the heartbeat when runStreamed throws (no late beats, timer count back to baseline)", async () => {
    const openclawDir = mkOpenclawDir();
    const runStream = scriptedRunStream({
      outputs: [{ at: 0, text: "spawning\n" }],
      settleAt: 1_000,
      error: new Error("spawn ENOENT"),
    });
    const { run, logger } = createRunner(openclawDir, { runStream });
    const baseline = vi.getTimerCount();

    const pending = run();
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("spawn ENOENT");
    expect(vi.getTimerCount()).toBe(baseline);
    await vi.advanceTimersByTimeAsync(kDoctorHeartbeatMs * 3);
    expect(heartbeatLines(logger)).toEqual([]);
  });

  it("a timed-out run carries lastOutputAgeMs/lastOutputLine; a succeeded one does not", async () => {
    const openclawDir = mkOpenclawDir();
    const timedOut = scriptedRunStream({
      outputs: [{ at: 0, text: "Step 1\n" }, { at: 20_000, text: "Step 2 (slow)\n" }],
      settleAt: 50_000,
      result: { ok: false, code: null, tail: "Step 2 (slow)\n", timedOut: true },
    });
    const first = createRunner(openclawDir, { runStream: timedOut });
    const pendingTimeout = first.run({ timeoutMs: 50_000 });
    await vi.advanceTimersByTimeAsync(50_000);
    const timedOutResult = await pendingTimeout;
    expect(timedOutResult).toMatchObject({
      ok: false,
      timedOut: true,
      stderr: "doctor --fix timed out after 50s",
      lastOutputAgeMs: 30_000,
      lastOutputLine: "Step 2 (slow)",
    });

    const traced = scriptedRunStream({
      outputs: [
        { at: 0, text: "Failing check doctor:state-integrity: agent database is malformed\n" },
        { at: 1_000, text: "[gateway] startup trace: doctor.contributions 812.4ms total=9000.1ms start=8187.7ms\n" },
      ],
      settleAt: 2_000,
      result: { ok: false, code: 1, tail: "" },
    });
    const third = createRunner(openclawDir, { runStream: traced });
    const pendingTraced = third.run();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pendingTraced).lastOutputLine).toBe("Failing check doctor:state-integrity: agent database is malformed");

    const succeeded = scriptedRunStream({
      outputs: [{ at: 0, text: "Doctor complete\n" }],
      settleAt: 1_000,
      result: { ok: true, tail: "Doctor complete\n" },
    });
    const second = createRunner(openclawDir, { runStream: succeeded });
    const pendingOk = second.run();
    await vi.advanceTimersByTimeAsync(1_000);
    const okResult = await pendingOk;
    expect(okResult.ok).toBe(true);
    expect(okResult).not.toHaveProperty("lastOutputAgeMs");
    expect(okResult).not.toHaveProperty("lastOutputLine");
  });

  describe("Doctor outcome recorded for every caller", () => {
    const kCaptureLine =
      "Original state capture was unavailable: SQLite staging ancestor must not allow another user to replace its child: /data. Doctor will continue; inspect retained evidence manually before restoring state.\n";
    const makeRunner = ({ chunks, exit, managedDir, version = "2026.10.4", now = () => 5_000 }) => {
      const runStream = {
        runStreamed: vi.fn(async ({ onOutput }) => {
          let tail = "";
          for (const [text, stream] of chunks) {
            onOutput(text, stream);
            tail = `${tail}${text}`.slice(-64 * 1024);
          }
          return { ok: exit === 0, code: exit, tail };
        }),
      };
      return createDoctorFixRunner({
        openclawDir: mkOpenclawDir(),
        doctorGuard: passthroughGuard(),
        runStream,
        gatewayEnv: () => kGatewayEnv,
        notifier: { notify: vi.fn() },
        logger: kSilentLogger,
        managedDir,
        getOpenclawVersion: () => version,
        nowFn: now,
      });
    };
    const readRecord = (managedDir) => JSON.parse(fs.readFileSync(path.join(managedDir, "openclaw-boot-migration.json"), "utf8"));

    it("records OpenClaw's workspace-alias stop with both paths expanded from the gateway's OPENCLAW_HOME, and --force only when asked", async () => {
      const managedDir = mkOpenclawDir();
      const line =
        "Failing check workspace-state (step-threw): Workspace path $OPENCLAW_HOME/.openclaw/workspace now resolves to $OPENCLAW_HOME/repo/sub/workspace, but its saved setup records belong to $OPENCLAW_HOME/.openclaw/workspace. Incoming messages cann\n";
      const run = makeRunner({ managedDir, exit: 1, chunks: [[line, "stderr"]] });
      await run({ source: "boot" });
      expect(readRecord(managedDir).lastOutcome).toMatchObject({
        status: "failed",
        class: "deterministic",
        reason: "workspace_moved",
        workspaceMove: {
          aliasPath: "/data/.openclaw/.openclaw/workspace",
          from: "/data/.openclaw/.openclaw/workspace",
          to: "/data/.openclaw/repo/sub/workspace",
        },
      });
      const { run: plain, runStream } = createRunner(mkOpenclawDir());
      await plain();
      await plain({ force: true });
      expect(runStream.runStreamed.mock.calls.map(([options]) => options.args)).toEqual([
        ["doctor", "--fix", "--yes"],
        ["doctor", "--fix", "--force", "--yes"],
      ]);
    });

    it("latches capture and failure lines split across chunks on stderr, even after more than 64 KiB of later output", async () => {
      const managedDir = mkOpenclawDir();
      const later = `${"│  migrated row\n".repeat(6000)}`;
      expect(later.length).toBeGreaterThan(64 * 1024);
      const run = makeRunner({
        managedDir,
        exit: 1,
        chunks: [
          ["┌  OpenClaw doctor\n", "stdout"],
          [kCaptureLine.slice(0, 40), "stderr"],
          ["progress on the other stream\n", "stdout"],
          [kCaptureLine.slice(40), "stderr"],
          ["Atomic replace parent must be ", "stderr"],
          ["a real directory: /data/.openclaw\n", "stderr"],
          [later, "stdout"],
        ],
      });
      const result = await run({ source: "medic" });
      expect(result.stdout).not.toContain("Original state capture");
      expect(result.facts).toMatchObject({
        captureState: "unavailable",
        captureCause: "SQLite staging ancestor must not allow another user to replace its child: /data",
        atomicReplaceLine: "Atomic replace parent must be a real directory: /data/.openclaw",
      });
      expect(readRecord(managedDir).lastOutcome).toEqual({
        status: "failed",
        class: "deterministic",
        reason: "atomic_replace_refused",
        detail: "Atomic replace parent must be a real directory: /data/.openclaw",
        captureState: "unavailable",
        captureCause: "SQLite staging ancestor must not allow another user to replace its child: /data",
        openclawVersion: "2026.10.4",
        source: "medic",
        durationMs: 0,
        at: 5_000,
      });
    });

    it("a success from any caller records the pin as completed and clears the boot's remembered failure", async () => {
      const managedDir = mkOpenclawDir();
      writeJson(managedDir, "openclaw-boot-migration.json", {
        completedForVersion: "2026.10.2",
        at: 1,
        failed: { key: { openclawVersion: "2026.10.4" }, reason: "atomic_replace_refused", attempts: 1, at: 1 },
      });
      const run = makeRunner({
        managedDir,
        exit: 0,
        chunks: [["Pre-repair state retained for manual recovery at /data/x.update-captures/doctor-1/manifest.json.\nDoctor complete\n", "stdout"]],
      });
      await run();
      const record = readRecord(managedDir);
      expect(record.completedForVersion).toBe("2026.10.4");
      expect(record.failed).toBeUndefined();
      expect(record.lastOutcome).toMatchObject({ status: "ok", class: null, captureState: "available", source: "repair" });
    });

    it("an unknown capture stays unknown, and a failed run never marks the pin completed", async () => {
      const managedDir = mkOpenclawDir();
      const run = makeRunner({ managedDir, exit: 1, chunks: [["Something odd happened\n", "stdout"]] });
      await run({ source: "boot" });
      const record = readRecord(managedDir);
      expect(record.completedForVersion).toBeUndefined();
      expect(record.lastOutcome).toMatchObject({ status: "failed", class: "transient", reason: "exit_1", captureState: "unknown", detail: "Something odd happened" });
    });
  });
});

describe("server/doctor-fix-runner disk refusal (ALPH-23)", () => {
  const refusal = {
    verdict: "refuse",
    sentences: ["this volume has 32.0 GB free for 30.0 GB of OpenClaw state. Make at least 60.0 GB free, then use Retry upgrade."],
  };
  const build = ({ completedForVersion = null, check = () => refusal } = {}) => {
    const openclawDir = mkOpenclawDir();
    const managedDir = path.join(openclawDir, ".alphaclaw");
    fs.mkdirSync(managedDir, { recursive: true });
    if (completedForVersion) writeJson(managedDir, "openclaw-boot-migration.json", { completedForVersion });
    const runStream = { runStreamed: vi.fn(async () => ({ ok: true, tail: "Doctor complete\n" })) };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = createDoctorFixRunner({
      openclawDir,
      doctorGuard: passthroughGuard(),
      runStream,
      gatewayEnv: () => kGatewayEnv,
      notifier: { notify: vi.fn() },
      managedDir,
      getOpenclawVersion: () => "2026.10.6",
      checkUpgradeDisk: vi.fn(check),
      logger,
    });
    return { run, runStream, logger, managedDir };
  };

  it("does not start Doctor while the pin's upgrade is pending and the backups cannot fit, and records why", async () => {
    const { run, runStream, logger, managedDir } = build();
    const result = await run({ source: "repair" });
    expect(runStream.runStreamed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "insufficient_disk", stderr: refusal.sentences[0] });
    expect(logger.warn).toHaveBeenCalledWith(`[alphaclaw] doctor --fix (repair): ${refusal.sentences[0]}`);
    expect(readJson(managedDir, "openclaw-boot-migration.json").lastOutcome).toMatchObject({
      status: "failed",
      class: "transient",
      reason: "insufficient_disk",
      detail: refusal.sentences[0],
      openclawVersion: "2026.10.6",
      source: "repair",
    });
  });

  it("runs Doctor as before once the pin's upgrade completed (no backups are taken then)", async () => {
    const { run, runStream } = build({ completedForVersion: "2026.10.6" });
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(runStream.runStreamed).toHaveBeenCalledTimes(1);
  });

  it("runs Doctor and logs the warning when the disk is only short of the recovery copy", async () => {
    const warning = "Only 45.0 GB is free for 30.0 GB of OpenClaw state.";
    const { run, runStream, logger } = build({ check: () => ({ verdict: "warn", sentences: [warning] }) });
    await expect(run({ source: "boot" })).resolves.toMatchObject({ ok: true });
    expect(runStream.runStreamed).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(`[alphaclaw] doctor --fix (boot): ${warning}`);
  });
});
