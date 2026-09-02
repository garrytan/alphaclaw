// Backup live-race handling (issues #11/#18): quiesce-first for hard gates,
// vanished-file retry ladder for everything else. The scripted gatewayQuiesce
// recorder pins the exact stop/start/lock ordering the design depends on —
// the watchdog relaunches an exited gateway 10s into a managed operation
// unless the lifecycle lock is held, so order here is correctness, not style.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const {
  createOpenclawChannelSync,
  kQuiescedOutcomePolicy,
  kLiveRetryPolicy,
  kReuseEligibleKinds,
  contentionRetryVerdict,
  parseMountInfoFsType,
  formatAge,
} = require("../../lib/server/openclaw-channel-sync");
const { kOfflineCopyTempDirPrefix } = require("../../lib/server/openclaw-backup-offline-copy");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const {
  beginStateDbQuiet,
  isStateDbQuiet,
  StateDbQuietError,
  resetStateDbQuietForTests,
} = require("../../lib/server/state-db-quiet");
const {
  kOpenclawBackupQuiesceTimeoutMs,
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupQuiesceSuppressSlackMs,
  kOpenclawBackupQuiesceLeaseReserveMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
  kOpenclawBackupStaleTempDirSlackMs,
  kOpenclawStateDbQuietSlackMs,
  kOpenclawStateDbQuietMaxMs,
  kOpenclawBackupTimeoutMs,
} = require("../../lib/server/constants");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const flushAsync = () => new Promise((resolve) => process.nextTick(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The verbatim error shape from issue #18 (openclaw 2026.7.1-2
// dist/backup-create, writeTarArchiveWithRetry's failure suffix).
const kVanishedLockTail =
  "Backup archive write failed: ENOENT: no such file or directory, lstat " +
  "'/data/.openclaw/agents/main/sessions/56d1821e-9b48-4c93-a35a-4ada38240911.jsonl.lock' " +
  "(last offending path: /data/.openclaw/agents/main/sessions/56d1821e-9b48-4c93-a35a-4ada38240911.jsonl.lock, after 3 attempts)\n";
// Issue #11's variant: same bug class, different volatile file.
const kVanishedCatalogTail =
  "Backup archive write failed: ENOENT: no such file or directory, lstat " +
  "'/data/.openclaw/agents/main/agent/plugins/groq/catalog.json' (last offending path: " +
  "/data/.openclaw/agents/main/agent/plugins/groq/catalog.json, after 3 attempts)\n";

const writePackageFixture = (packageDir, { version } = {}) => {
  fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" } }, null, 2)}\n`,
  );
  const binPath = path.join(packageDir, "bin", "entry.js");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok');\n");
  fs.writeFileSync(
    path.join(packageDir, "dist", "thinking-levels.js"),
    "exports.listThinkingLevelOptions = () => [];\n",
  );
  return packageDir;
};

// The usable-backup check (WI-6.1) runs `gzip -t` + manifest extraction
// through the runner seam; a real `backup create` archive carries this shape.
const kStubManifest = {
  schemaVersion: 1,
  assets: [
    {
      kind: "sqlite",
      sourcePath: "/data/.openclaw/state/openclaw.sqlite",
      archivePath: "state/openclaw.sqlite",
    },
  ],
};
const answerArchiveTool = (opts, { manifestTail = `${JSON.stringify(kStubManifest)}\n` } = {}) => {
  if (opts.command === "gzip" && opts.args?.[0] === "-t") {
    return { ok: true, code: 0, tail: "", timedOut: false };
  }
  if (opts.command === "tar" && opts.args?.[0] === "-xzOf") {
    return { ok: true, code: 0, tail: manifestTail, timedOut: false };
  }
  return null;
};

// Faithful backup CLI stub (see openclaw-channel-sync.test.js — the --output
// contract was verified against the pinned 2026.7.1-2 source). Failure
// scripts run per-call so a test can fail N times, then succeed; a step may
// also carry the run-stream flags the classifier reads (signal, killed,
// error, timedOut).
const makeBackupRunner = ({
  script = [],
  onBackupCall = null,
  onArchiveTool = null,
  manifestTail = undefined,
} = {}) => {
  const backupCalls = [];
  const archiveToolCalls = [];
  const runnerImpl = async (opts) => {
    const archiveTool = answerArchiveTool(opts, manifestTail === undefined ? {} : { manifestTail });
    if (archiveTool) {
      archiveToolCalls.push({
        command: opts.command,
        args: opts.args,
        timeoutMs: opts.timeoutMs,
        tailBytes: opts.tailBytes,
      });
      return onArchiveTool?.(opts) ?? archiveTool;
    }
    if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
      const outIdx = opts.args.indexOf("--output");
      const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
      backupCalls.push({ out, timeoutMs: opts.timeoutMs });
      onBackupCall?.(backupCalls.length);
      const step = script[backupCalls.length - 1] ?? { ok: true };
      if (!step.ok) {
        return {
          ok: false,
          code: step.code ?? 1,
          tail: step.tail ?? "boom\n",
          timedOut: Boolean(step.timedOut),
          signal: step.signal ?? null,
          killed: Boolean(step.killed),
          ...(step.error ? { error: step.error } : {}),
        };
      }
      if (out && !step.noArtifact) {
        if (fs.existsSync(out)) {
          return {
            ok: false,
            code: 1,
            tail: `Error: Refusing to overwrite existing backup archive: ${out}\n`,
            timedOut: false,
          };
        }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, "stub backup archive\n");
      }
      return {
        ok: true,
        code: 0,
        tail: "Archive verification: passed\n",
        timedOut: false,
      };
    }
    if (
      opts.command === "node" &&
      Array.isArray(opts.args) &&
      opts.args[1] === "--version"
    ) {
      let version = "";
      try {
        version =
          JSON.parse(
            fs.readFileSync(
              path.resolve(String(opts.args[0]), "..", "..", "package.json"),
              "utf8",
            ),
          ).version || "";
      } catch {}
      return { ok: true, code: 0, tail: `${version}\n`, timedOut: false };
    }
    return { ok: true, code: 0, tail: "", timedOut: false };
  };
  return { runnerImpl, backupCalls, archiveToolCalls };
};

// Offline-copy e2e: the archive tools (tar/gzip/sh) run for REAL so the
// .alphaclaw.tar.gz that lands in backupsDir is a genuine archive; only the
// upstream `openclaw backup` CLI stays scripted.
const realRunStream = createRunStream({});
const makeOfflineCopyRunner = ({ script = [], onBackupCall = null, onArchiveTool = null } = {}) => {
  const scripted = makeBackupRunner({ script, onBackupCall });
  const runnerImpl = async (opts) => {
    if (["tar", "gzip", "sh"].includes(opts.command)) {
      const override = onArchiveTool?.(opts);
      if (override) return override;
      // Only the offline copy's own files are real archives; the scripted
      // upstream stub still writes "stub backup archive", so its usable check
      // keeps the stubbed answers.
      const touchesOfflineCopy = (opts.args || []).some((arg) => String(arg).includes(".alphaclaw."));
      if (touchesOfflineCopy) return realRunStream.runStreamed({ ...opts, env: process.env });
    }
    return scripted.runnerImpl(opts);
  };
  return { runnerImpl, backupCalls: scripted.backupCalls };
};

// The harness clock starts at 1,000,000 ms (16 minutes after the epoch);
// age-based fixtures (reuse window, pin age) need a realistic "now".
const kRealisticNow = Date.parse("2026-09-02T12:00:00.000Z");

// A real state DB in the harness's state dir so the offline copy has
// something to snapshot (and the usable check something to require).
const seedStateDb = (harness, { journalMode = "WAL", rows = 5 } = {}) => {
  const file = path.join(harness.openclawDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE t(x INTEGER)");
  for (let i = 0; i < rows; i += 1) db.exec(`INSERT INTO t VALUES (${i})`);
  db.close();
  return file;
};

// The verbatim #54 failure tail: the lease-loss cause sits above a final
// ENOENT line from the lease's own cleanup — a last-line-only classifier
// read this as a live-file race.
const kLeaseLostTail = [
  "[state] SQLite transaction lock wait failed",
  "Error: lease migration.legacy-audit/filesystem-sqlite-boundary was lost",
  "    at renew (file:///app/node_modules/openclaw/dist/state-lease-abc.js:88:15)",
  "Backup failed: ENOENT: no such file or directory, unlink '/data/.openclaw/state/.lease-tmp'",
  "",
].join("\n");

const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// The reuse gate hands the archive tools /proc/<pid>/fd/<fd> — the inode it
// will hash — never the candidate's pathname. Pins that tell candidates apart
// by name resolve the link back (same process, so readlink works).
const kProcFdPrefix = `/proc/${process.pid}/fd/`;
const archiveToolFile = (arg) =>
  String(arg).startsWith(kProcFdPrefix) ? fs.readlinkSync(arg) : String(arg);

const lastStepDetail = (harness, name, status) =>
  harness.store
    .readState()
    .lastUpdateRun.steps.filter((s) => s.name === name && s.status === status)
    .pop();

// Scripted quiesce recorder. Every call appends to `calls` so tests assert
// the exact transaction order — including the state-DB quiet barrier seams
// (dbQuiet after stop, dbResume before start), which wrap the REAL module so
// isStateDbQuiet() reflects the barrier during the offline-copy tests.
const makeQuiesceRecorder = ({
  calls = [],
  acquireDelayMs = 0,
  acquireNever = false,
  acquireReject = false,
  isRunning = true,
  stopResult = true,
  stopThrows = false,
  startThrows = false,
  stopEvidence = null,
  dbQuietThrows = false,
} = {}) => {
  const releaseSpy = vi.fn(() => calls.push("release"));
  const recorder = {
    calls,
    releaseSpy,
    acquireLock: vi.fn(async (options) => {
      calls.push("acquireLock");
      recorder.acquireOptions = options;
      if (acquireReject) throw new Error("lock unavailable");
      if (acquireNever) await new Promise(() => {});
      if (acquireDelayMs) await sleep(acquireDelayMs);
      return releaseSpy;
    }),
    getStopEvidence: vi.fn(() => stopEvidence),
    dbQuiet: vi.fn(async (opts) => {
      calls.push("dbQuiet");
      recorder.dbQuietOptions = opts;
      if (dbQuietThrows) throw new StateDbQuietError("already quiet (held by other-backup)");
      return beginStateDbQuiet(opts);
    }),
    dbResume: vi.fn((quiet) => {
      calls.push("dbResume");
      quiet?.release?.();
    }),
    isRunning: vi.fn(async () => {
      calls.push("isRunning");
      return isRunning;
    }),
    suppress: vi.fn((durationMs) => {
      calls.push("suppress");
      recorder.suppressDurationMs = durationMs;
    }),
    unsuppress: vi.fn(() => calls.push("unsuppress")),
    stop: vi.fn(async () => {
      calls.push("stop");
      if (stopThrows) throw new Error("stop exploded");
      return stopResult;
    }),
    start: vi.fn(async () => {
      calls.push("start");
      if (startThrows) throw new Error("relaunch exploded");
    }),
  };
  return recorder;
};

const kFastTuning = {
  retryDelayMs: 1,
  quiesceLockTimeoutMs: 40,
  contentionBackoffBaseMs: 1,
  postQuiesceReadyTimeoutMs: 10,
  postQuiescePollMs: 5,
  postQuiesceSettleMs: 1,
  // The usable-check reserve the ladder keeps back from every attempt budget.
  // Scaled down with the 1 s envelopes the exhaustion tests use; the floor
  // tests set their own explicit value.
  usableCheckReserveMs: 100,
  // The offline copy's live-process settle loop (real sleeps): 4 polls.
  exclusivitySettleMs: 20,
  exclusivitySettlePollMs: 5,
};

// Hermetic diagnosis probes: no /proc reads, no live-process listing.
const kQuietProbes = {
  readMountInfo: () => "",
  listProcesses: () => [],
  listFdHolders: () => [],
};

const createHarness = ({
  pin = "1.0.0",
  channel = "stable",
  installedVersion = "1.0.0",
  sentinelVersion = "1.0.0",
  runnerImpl,
  gatewayQuiesce = null,
  backupTuning = {},
  backupProbes = kQuietProbes,
  extraSyncOptions = {},
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-backup-retry-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-backup-retry-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-backup-retry-install-");
  if (installedVersion) {
    writePackageFixture(path.join(installDir, "node_modules", "openclaw"), {
      version: installedVersion,
    });
  }
  const nowRef = { now: 1_000_000 };
  const nowFn = () => nowRef.now;
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    nowFn,
    logger: kSilentLogger,
  });
  if (sentinelVersion) {
    store.writeSentinel({ installDir, version: sentinelVersion });
  }
  const runner = { runStreamed: vi.fn(runnerImpl) };
  const installToTempDir = vi.fn(async ({ versionSpec }) => {
    const tmpDir = mkTemp("openclaw-fake-prepare-");
    const openclawPackageDir = writePackageFixture(
      path.join(tmpDir, "node_modules", "openclaw"),
      { version: versionSpec },
    );
    return { tmpDir, openclawPackageDir, cleanup: vi.fn() };
  });
  const notify = vi.fn(async () => {});
  const restartProcess = vi.fn();
  const insertEvent = vi.fn();
  const sync = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store,
    runStream: runner,
    installToTempDir,
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => channel,
    isOnboarded: () => true,
    restartProcess,
    clearVersionCache: vi.fn(),
    notify,
    nowFn,
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
    gatewayQuiesce,
    backupTuning: { ...kFastTuning, ...backupTuning },
    backupProbes,
    insertEvent,
    ...(gatewayQuiesce?.dbQuiet ? { dbQuiet: gatewayQuiesce.dbQuiet } : {}),
    ...(gatewayQuiesce?.dbResume ? { dbResume: gatewayQuiesce.dbResume } : {}),
    ...extraSyncOptions,
  });
  const ledger = sync.runLedger ?? null;
  return {
    sync,
    store,
    rootDir,
    openclawDir,
    runner,
    notify,
    restartProcess,
    nowRef,
    ledger,
    insertEvent,
  };
};

const eventsOfType = (insertEvent, eventType) =>
  insertEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event?.eventType === eventType);

const kHardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };
const kSoftGateTarget = { channel: "stable", version: "1.1.0" };

const notifyMessages = (notify) =>
  notify.mock.calls.map(([message]) => String(message));

const readNewestRunRecord = (harness) => {
  const runsDir = path.join(harness.openclawDir, ".alphaclaw", "runs");
  const names = fs.readdirSync(runsDir);
  expect(names.length).toBeGreaterThan(0);
  const records = names.map((name) =>
    JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")),
  );
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return records[0];
};
const readRunBackupRecord = (harness) => readNewestRunRecord(harness).backup;

describe("server/openclaw-channel-backup-retry", () => {
  beforeEach(() => {
    resetStateDbQuietForTests({ listeners: true });
    delete process.env.OPENCLAW_STATE_DB_QUIET;
  });

  describe("quiesce-first (hard gate + gatewayQuiesce injected)", () => {
    it("pauses the gateway, quiets the state DB, backs up once, resumes, relaunches, releases — in that exact order", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => {
          quiesce.calls.push("backup-cli");
          // The barrier is HELD while the upstream CLI runs (issue #54).
          quiesce.calls.push(isStateDbQuiet() ? "quiet:on" : "quiet:off");
        },
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(result.body.restarting).toBe(true);
      expect(backupCalls).toHaveLength(1);
      // dbQuiet strictly after the confirmed stop, dbResume strictly before
      // the relaunch: the gateway's first writes never land while readers
      // are still told to stand down.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "quiet:on",
        "dbResume",
        "start",
        "unsuppress",
        "release",
      ]);
      expect(isStateDbQuiet()).toBe(false);
      // The barrier's expiry is derived from the effective budgets + slack —
      // and at default budgets it IS the documented constant (pins the
      // driver's derivation against constants.js so the two cannot drift).
      expect(kOpenclawStateDbQuietMaxMs).toBe(
        kOpenclawBackupQuiesceTimeoutMs +
          kOpenclawBackupOfflineCopyBudgetMs +
          kOpenclawStateDbQuietSlackMs,
      );
      expect(quiesce.dbQuietOptions).toEqual(
        expect.objectContaining({
          owner: "quiesced-backup",
          maxMs: kOpenclawStateDbQuietMaxMs,
        }),
      );
      // The lifecycle lease and the watchdog suppression both span the
      // quiesced attempts AND the offline copy that may follow them, PLUS a
      // reserve for what else runs under the lock (stop, barrier begin,
      // usable check, relaunch ready budget — the prune and sha256 run after
      // the unlock) — without it the lease force-releases mid-copy.
      const holdMs =
        kOpenclawBackupQuiesceTimeoutMs +
        kOpenclawBackupOfflineCopyBudgetMs +
        kOpenclawBackupQuiesceLeaseReserveMs;
      expect(quiesce.acquireOptions).toEqual({ leaseMs: holdMs });
      expect(quiesce.suppressDurationMs).toBe(holdMs + kOpenclawBackupQuiesceSuppressSlackMs);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({
          quiesced: true,
          attempts: 1,
          quiescedAttempts: 1,
          noBackup: false,
          producer: "openclaw",
          usableCheck: "manifest_ok",
        }),
      );
      // WI-1.9: exactly ONE initial "backup: running", detail naming the path.
      const runningSteps = harness.store
        .readState()
        .lastUpdateRun.steps.filter((s) => s.name === "backup" && s.status === "running");
      expect(runningSteps).toHaveLength(1);
      expect(runningSteps[0].detail).toBe("pausing the gateway for a consistent backup");
      // WI-1.0: the diagnosis rode into the record and the events tab.
      expect(backupRecord.diagnosis).toEqual(
        expect.objectContaining({ journalMode: "unknown", fsType: "unknown", stateBytes: 0 }),
      );
      expect(eventsOfType(harness.insertEvent, "backup_diagnosis")).toHaveLength(1);
      expect(eventsOfType(harness.insertEvent, "state_db_quiet").map((e) => e.status)).toEqual(
        expect.arrayContaining(["begin", "quiet", "released"]),
      );
    });

    it("derives the quiet barrier's maxMs from the EFFECTIVE quiesce/offline budgets (tuned budgets raise it; an explicit override wins)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { quiesceTimeoutMs: 20 * 60 * 1000, offlineCopyBudgetMs: 12 * 60 * 1000 },
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(quiesce.dbQuietOptions.maxMs).toBe(32 * 60 * 1000 + kOpenclawStateDbQuietSlackMs);

      const explicit = makeQuiesceRecorder({});
      const second = createHarness({
        runnerImpl: makeBackupRunner({}).runnerImpl,
        gatewayQuiesce: explicit,
        backupTuning: { quiesceTimeoutMs: 20 * 60 * 1000, stateDbQuietMaxMs: 60_000 },
      });
      expect((await second.sync.applyUpdate(kHardGateTarget)).status).toBe(202);
      expect(explicit.dbQuietOptions.maxMs).toBe(60_000);
    });

    it("reserves the usable-check floor: no live attempt starts when the envelope cannot hold attempt + reserve (window_exhausted, frozen clock)", async () => {
      // The quiesced attempt times out having eaten 6 s of a 10 s envelope;
      // 4 s remain — less than an attempt plus the 5 s reserve. Without the
      // floor a live attempt would run, succeed, and then be quarantined by
      // a 1 ms usable check.
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, timedOut: true, tail: "" }, { ok: true }],
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 10_000, usableCheckReserveMs: 5_000 },
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 6_000;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/backup window was exhausted/);
      expect(backupCalls).toHaveLength(1);
      // The quiesced attempt's own deadline already kept the reserve back.
      expect(backupCalls[0].timeoutMs).toBe(5_000);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
    });

    it("the usable check always gets at least the reserve, even when the succeeding attempt spent the envelope", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, archiveToolCalls } = makeBackupRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 10_000, usableCheckReserveMs: 5_000 },
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 9_999;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(archiveToolCalls.map((c) => c.command)).toEqual(["gzip", "tar"]);
      // 1 ms was left in the envelope; the check got the 5 s reserve instead.
      expect(archiveToolCalls[0].timeoutMs).toBe(5_000);
      expect(readRunBackupRecord(harness).usableCheck).toBe("manifest_ok");
    });

    it("does not stop or relaunch a gateway that was not running (wasRunning sampled under the lock)", async () => {
      const quiesce = makeQuiesceRecorder({ isRunning: false });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      expect(readRunBackupRecord(harness).quiesced).toBe(true);
    });

    it("falls back to live attempts when the gateway will not release the port, relaunching it first", async () => {
      const quiesce = makeQuiesceRecorder({ stopResult: false });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      // The half-stopped gateway (its child already got SIGTERM) is brought
      // back before the ladder runs.
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      expect(readRunBackupRecord(harness).quiesced).toBe(false);
    });

    it("treats a throwing stop() like a failed stop — fallback, not crash", async () => {
      const quiesce = makeQuiesceRecorder({ stopThrows: true });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("fails honestly with gateway_busy when the lifecycle lock never frees — and self-releases a late acquire", async () => {
      const quiesce = makeQuiesceRecorder({ acquireDelayMs: 120 });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { quiesceLockTimeoutMs: 15 },
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/another gateway operation/i);
      expect(backupCalls).toHaveLength(0);
      expect(quiesce.stop).not.toHaveBeenCalled();
      // The acquire resolves after the race gave up — its release must fire
      // or the lease blocks every gateway operation for 10 minutes.
      await sleep(200);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to live attempts when acquireLock rejects", async () => {
      const quiesce = makeQuiesceRecorder({ acquireReject: true });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.stop).not.toHaveBeenCalled();
    });

    it("a vanished file during the quiesced attempt falls through to the ladder (exogenous writer)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kVanishedLockTail }, { ok: true }],
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      // Gateway came back BEFORE the live attempt ran.
      expect(quiesce.calls.indexOf("start")).toBeLessThan(
        quiesce.calls.length,
      );
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({ quiesced: true, attempts: 2 }),
      );
      expect(backupRecord.vanishedPaths).toEqual([
        "/data/.openclaw/agents/main/sessions/56d1821e-9b48-4c93-a35a-4ada38240911.jsonl.lock",
      ]);
    });

    it("reports the honest window-exhausted failure when the quiesced attempt burns the whole envelope", async () => {
      // The quiesced attempt consumes the entire phase envelope AND fails
      // with a vanished file — the ladder gets its turn but has no time for
      // a single live attempt. The 409 must say the window ran out, not
      // fabricate a live-attempt failure.
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kVanishedLockTail }],
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 1000 },
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          harness.nowRef.now += 2000;
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/backup window was exhausted/);
      // WI-1.8 wording: one attempt, and it was the paused one.
      expect(result.body.message).toMatch(/\(single attempt, with the gateway paused\)/);
      expect(result.body.message).not.toMatch(/including one/);
      // WI-1.10: the refusal names what the operator does have.
      expect(result.body.hint).toMatch(/No earlier backup archive exists in/);
      // No live-ladder attempt ran after the envelope was gone.
      expect(backupCalls).toHaveLength(1);
      // The gateway still came back before the failure surfaced.
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("a non-race failure during the quiesced attempt fails hard immediately — gateway restarted before the 409", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: "Error: ENOSPC no space left on device\n" }],
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/disk space/i);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("runs the workspace-discovery retry LIVE: gateway relaunched and lock released BEFORE the retry CLI call", async () => {
      // adv-2: the retry's budget is min(cliTimeoutMs = 10 min, envelope) —
      // run in-quiesce it would blow the lock+stop+backup+start ≤ 10-min
      // lease invariant and outlive the 9-min watchdog suppression, letting
      // the force-released lease relaunch the gateway MID-TAR. The quiesce
      // transaction must fully unwind first; the retry then runs live.
      const kWorkspaceTail =
        "Error: Config invalid at $OPENCLAW_HOME/.openclaw/openclaw.json.\n" +
        "OpenClaw cannot reliably discover custom workspaces for backup.\n" +
        "Fix the config or rerun with --no-include-workspace for a partial backup.\n";
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kWorkspaceTail }, { ok: true }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      // The retry CLI call comes strictly AFTER dbResume + start + unsuppress
      // + release, and after the post-relaunch settle (one isRunning poll).
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      // The retry still succeeds as an honestly-marked partial backup.
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({
          quiesced: true,
          attempts: 2,
          partial: true,
          noBackup: false,
        }),
      );
      expect(
        notifyMessages(harness.notify).some((m) =>
          /WITHOUT workspace files/.test(m),
        ),
      ).toBe(true);
    });

    it("a quiesced-attempt timeout falls back to the live ladder (10-min ceiling) instead of failing terminally", async () => {
      // adv-7: a box whose backup takes 7-10 minutes fails the 7-min quiesce
      // budget but fits the live CLI ceiling — with ~18 min of envelope left,
      // a terminal failure would lock it out of every hard gate forever.
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, timedOut: true, tail: "" }, { ok: true }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      // The gateway relaunched (and the lock released) before the live
      // attempt, which waits for the settle (isRunning poll) first.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      // The live attempt gets the full CLI ceiling, not the quiesce budget.
      expect(backupCalls[1].timeoutMs).toBe(kOpenclawBackupTimeoutMs);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({
          quiesced: true,
          attempts: 2,
          quiescedAttempts: 1,
          noBackup: false,
        }),
      );
      // WI-1.5: the retry detail names the ACTUAL prior kind, not a race.
      const steps = harness.store.readState().lastUpdateRun.steps;
      const retryDetail = steps.find(
        (s) => s.name === "backup" && /attempt 2/.test(s.detail || ""),
      );
      expect(retryDetail.detail).toMatch(/retrying after a timed-out attempt with the gateway paused/);
      expect(retryDetail.detail).not.toMatch(/live-file race/);
    });

    it("swallows a POST-timeout acquire rejection (no unhandledRejection) while still failing gateway_busy", async () => {
      const unhandled = [];
      const onUnhandled = (error) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      try {
        const calls = [];
        const quiesce = {
          acquireLock: vi.fn(async () => {
            calls.push("acquireLock");
            await sleep(80);
            throw new Error("late acquire rejection");
          }),
          isRunning: vi.fn(async () => true),
          suppress: vi.fn(),
          unsuppress: vi.fn(),
          stop: vi.fn(async () => true),
          start: vi.fn(async () => {}),
        };
        const { runnerImpl, backupCalls } = makeBackupRunner({});
        const harness = createHarness({
          runnerImpl,
          gatewayQuiesce: quiesce,
          backupTuning: { quiesceLockTimeoutMs: 15 },
        });

        const result = await harness.sync.applyUpdate(kHardGateTarget);

        // The race already gave up honestly…
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
        expect(result.body.message).toMatch(/another gateway operation/i);
        expect(backupCalls).toHaveLength(0);
        // …and the late rejection lands in the chain's .catch, never as an
        // unhandledRejection.
        await sleep(200);
        await flushAsync();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("a failed gateway relaunch after the backup warns on its OWN step and notifies instead of failing the apply", async () => {
      const quiesce = makeQuiesceRecorder({ startThrows: true });
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(
        notifyMessages(harness.notify).some((m) =>
          /did not relaunch cleanly/i.test(m),
        ),
      ).toBe(true);
      // unsuppress still ran so the watchdog takes recovery over.
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      // WI-1.9: the backup step's outcome stays "completed"; the relaunch
      // failure is its own gateway-relaunch step.
      const steps = harness.store.readState().lastUpdateRun.steps;
      const backupStatuses = steps.filter((s) => s.name === "backup").map((s) => s.status);
      expect(backupStatuses[backupStatuses.length - 1]).toBe("completed");
      expect(backupStatuses).not.toContain("warning");
      expect(steps).toContainEqual(
        expect.objectContaining({
          name: "gateway-relaunch",
          status: "warning",
          error: expect.stringMatching(/relaunch exploded/),
        }),
      );
      // dbResume still ran BEFORE the failed start.
      expect(quiesce.calls.indexOf("dbResume")).toBeLessThan(quiesce.calls.indexOf("start"));
    });
  });

  describe("live-retry ladder", () => {
    it("retries a vanished-file race and succeeds — fresh pattern-conforming file per attempt", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedCatalogTail },
          { ok: true },
        ],
      });
      // No gatewayQuiesce (the bin/boot instance shape): retries only.
      const harness = createHarness({ runnerImpl });

      // nowFn is frozen; advance it per attempt so filenames stay unique the
      // way real time does.
      let call = 0;
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          harness.nowRef.now += 1000;
        }
        call += 1;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(3);
      const outputs = backupCalls.map((c) => path.basename(c.out));
      // Every attempt's name must stay inside the retention pattern — a
      // bespoke suffix would escape keep-N pruning (issue #9's disk refill).
      for (const name of outputs) {
        expect(name).toMatch(/^openclaw-backup-.*\.tar\.gz$/);
      }
      expect(new Set(outputs).size).toBe(3);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({ quiesced: false, attempts: 3 }),
      );
      expect(backupRecord.vanishedPaths).toHaveLength(2);
    });

    it("exhausts the ladder on persistent races and reports the honest attempt count with the full path", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      // The untruncated offending path — issue #18's notification cut it at
      // 200 chars mid-path.
      expect(result.body.message).toContain(
        "/data/.openclaw/agents/main/sessions/56d1821e-9b48-4c93-a35a-4ada38240911.jsonl.lock",
      );
      expect(result.body.message).toMatch(/after 3 attempts/);
      expect(result.body.hint).toMatch(/live-state race/i);
      expect(backupCalls).toHaveLength(3);
    });

    it("does not retry non-race failures (ENOSPC = one attempt)", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: "Error: ENOSPC no space left on device\n" }],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(backupCalls).toHaveLength(1);
    });

    it("soft gate: retries races but never quiesces, then warns and continues", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(3);
      expect(quiesce.acquireLock).not.toHaveBeenCalled();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(
        notifyMessages(harness.notify).some(
          (m) => /backup failed/i.test(m) && /live-file race/i.test(m),
        ),
      ).toBe(true);
    });

    it("stops when the phase envelope is exhausted even on retryable failures", async () => {
      const harness = createHarness({
        runnerImpl: async () => ({ ok: true, code: 0, tail: "", timedOut: false }),
        backupTuning: { phaseEnvelopeMs: 1000 },
      });
      // Each backup call burns 2s of frozen clock, then fails with a race.
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          harness.nowRef.now += 2000;
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(backupCalls).toHaveLength(1);
    });

    it("cleans up each failed attempt's own artifact (quarantine, never delete a non-empty archive)", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          harness.nowRef.now += 1000;
          const outIdx = opts.args.indexOf("--output");
          const out = opts.args[outIdx + 1];
          backupCalls.push({ out });
          if (backupCalls.length === 1) {
            // The CLI wrote a partial archive, then hit the race.
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, "partial archive bytes");
            return {
              ok: false,
              code: 1,
              tail: kVanishedLockTail,
              timedOut: false,
            };
          }
          fs.writeFileSync(out, "stub backup archive\n");
          return { ok: true, code: 0, tail: "ok\n", timedOut: false };
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const names = fs.readdirSync(backupsDir);
      expect(names.some((n) => n.endsWith(".unverified"))).toBe(true);
      expect(
        names.filter((n) => /openclaw-backup.*\.tar\.gz$/.test(n)),
      ).toHaveLength(1);
    });
  });

  describe("classification details", () => {
    it("extracts the offending path from a plugin-catalog race (issue #11's shape)", async () => {
      const { runnerImpl } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedCatalogTail },
          { ok: false, tail: kVanishedCatalogTail },
          { ok: false, tail: kVanishedCatalogTail },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toContain(
        "/data/.openclaw/agents/main/agent/plugins/groq/catalog.json",
      );
    });

    it("classifies an ENOENT without a parseable path as a race against an unknown file", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: "ENOENT: no such file or directory\n" },
          { ok: true },
        ],
      });
      const harness = createHarness({ runnerImpl });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          harness.nowRef.now += 1000;
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      // Still classified as retryable — the retry proves it.
      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
    });

    it("sanitizes control characters and markdown out of surfaced failure text", async () => {
      const nasty =
        "Backup archive write failed: ENOENT: no such file or directory, lstat " +
        "'/data/.openclaw/agents/main/sessions/x`rm -rf`\u001b[31m\u0007.jsonl.lock'\n";
      const { runnerImpl } = makeBackupRunner({
        script: [
          { ok: false, tail: nasty },
          { ok: false, tail: nasty },
          { ok: false, tail: nasty },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).not.toContain("`");
      expect(result.body.message).not.toContain("\u001b");
      expect(result.body.message).not.toContain("\u0007");
    });
  });
  // ── Issue #54: policy tables are data ────────────────────────────────────
  describe("policy tables (plan §6)", () => {
    it("pins the quiesced outcome policy, the live retry policy, and the reuse-eligible kinds", () => {
      expect(kQuiescedOutcomePolicy).toEqual({
        lock_contention: "retry",
        killed: "offline_copy",
        timeout: "fallback",
        vanished_file: "fallback",
        workspace_discovery: "workspace_retry",
        default: "terminal",
      });
      expect(Object.isFrozen(kQuiescedOutcomePolicy)).toBe(true);
      expect(kLiveRetryPolicy).toEqual({
        vanished_file: { retries: 2, delayMs: 750 },
        lock_contention: { retries: 1, delayMs: 15000 },
        killed: { retries: 1, delayMs: 15000 },
      });
      expect([...kReuseEligibleKinds].sort()).toEqual(
        ["killed", "lock_contention", "offline_copy_refused", "timeout", "vanished_file", "window_exhausted"].sort(),
      );
      for (const terminal of ["no_command", "refuse_overwrite", "enospc", "verify", "generic", "spawn_error", "no_artifact"]) {
        expect(kReuseEligibleKinds).not.toContain(terminal);
      }
    });

    it("parseMountInfoFsType: longest containing mount wins, optional fields are skipped, \\040 is decoded, / is the fallback", () => {
      const fx = [
        "22 1 254:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw",
        "40 22 0:35 / /data rw,relatime shared:20 master:2 - virtiofs data rw",
        "41 22 0:36 / /mnt/with\\040space rw - nfs4 host:/x rw,vers=4.2",
        "42 40 0:37 / /data/.openclaw/backups rw - tmpfs tmpfs rw",
      ].join("\n");
      // Longest containing prefix; the optional `shared:… master:…` fields
      // before " - " do not shift the fstype column.
      expect(parseMountInfoFsType(fx, "/data/.openclaw")).toBe("virtiofs");
      expect(parseMountInfoFsType(fx, "/data")).toBe("virtiofs");
      // A deeper mount under /data wins over /data.
      expect(parseMountInfoFsType(fx, "/data/.openclaw/backups/x")).toBe("tmpfs");
      // A sibling that merely shares the prefix string is NOT under /data.
      expect(parseMountInfoFsType(fx, "/datastore")).toBe("ext4");
      expect(parseMountInfoFsType(fx, "/mnt/with space/y")).toBe("nfs4");
      expect(parseMountInfoFsType("", "/data")).toBe("unknown");
      expect(parseMountInfoFsType(fx, "")).toBe("unknown");
      expect(parseMountInfoFsType("40 22 0:35 / /data rw - virtiofs d rw", "/home")).toBe("unknown");
      // A line without the " - " separator is ignored, not mis-parsed.
      expect(parseMountInfoFsType("garbage line\n" + fx, "/data")).toBe("virtiofs");
    });

    it("formatAge: the ONE operator-facing age helper the driver and the rollback route share", () => {
      expect(formatAge(0)).toBe("0 minutes");
      expect(formatAge(60_000)).toBe("1 minute");
      expect(formatAge(59 * 60_000)).toBe("59 minutes");
      expect(formatAge(3 * 3_600_000)).toBe("3 hours");
      expect(formatAge(47 * 3_600_000)).toBe("47 hours");
      expect(formatAge(3 * 86_400_000)).toBe("3 days");
      expect(formatAge(-5)).toBe("0 minutes");
    });

    it("contentionRetryVerdict: budget-aware math with a frozen clock", () => {
      const budgetMs = 7 * 60_000;
      // Attempt 1 failed fast; 15s backoff fits with the 30s reserve → retry.
      expect(
        contentionRetryVerdict({ failedMs: 20_000, backoffMs: 15_000, remainingMs: budgetMs - 20_000, budgetMs, retries: 0 }),
      ).toEqual({ retry: true, reason: null });
      // Second retry doubles the backoff and still fits.
      expect(
        contentionRetryVerdict({ failedMs: 20_000, backoffMs: 30_000, remainingMs: budgetMs - 75_000, budgetMs, retries: 1 }),
      ).toEqual({ retry: true, reason: null });
      // Cap: two retries max.
      expect(
        contentionRetryVerdict({ failedMs: 1, backoffMs: 60_000, remainingMs: budgetMs, budgetMs, retries: 2 }),
      ).toEqual({ retry: false, reason: "retries_exhausted" });
      // The failed attempt burned ≥ 50% of the budget → the retry could not fit.
      expect(
        contentionRetryVerdict({ failedMs: budgetMs / 2, backoffMs: 15_000, remainingMs: budgetMs / 2, budgetMs, retries: 0 }),
      ).toEqual({ retry: false, reason: "attempt_too_long" });
      // remaining < failed + backoff + 30s reserve.
      expect(
        contentionRetryVerdict({ failedMs: 60_000, backoffMs: 15_000, remainingMs: 104_999, budgetMs, retries: 0 }),
      ).toEqual({ retry: false, reason: "insufficient_budget" });
      expect(
        contentionRetryVerdict({ failedMs: 60_000, backoffMs: 15_000, remainingMs: 105_000, budgetMs, retries: 0 }),
      ).toEqual({ retry: true, reason: null });
      // maxRetries is tunable.
      expect(
        contentionRetryVerdict({ failedMs: 1, backoffMs: 1, remainingMs: budgetMs, budgetMs, retries: 2, maxRetries: 5 }),
      ).toEqual({ retry: true, reason: null });
    });
  });

  // ── Issue #54: classifier order fixtures ─────────────────────────────────
  describe("classifier order (plan §6)", () => {
    it("ENOENT + lease-lost tail → lock_contention (not vanished_file): the live ladder retries ONCE after contention", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/lost its state-database lease.*lock contention/);
      expect(result.body.message).toMatch(/\(after 2 attempts\)/);
      expect(result.body.hint).toMatch(/No earlier backup archive exists/);
      // kLiveRetryPolicy.lock_contention.retries === 1 → exactly two attempts.
      expect(backupCalls).toHaveLength(2);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(expect.objectContaining({ attempts: 2, quiesced: false, noBackup: true }));
      expect(record.vanishedPaths).toEqual([]);
      // The retry detail names contention, not a race.
      expect(lastStepDetail(harness, "backup", "running").detail).toMatch(
        /attempt 2 — retrying after state-database lock contention/,
      );
    });

    it("signal + 'verif' tail → killed (flag beats regex): one live retry, then success", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, signal: "SIGKILL", killed: true, tail: "Archive verification: interrupted\n" },
          { ok: true },
        ],
      });
      const harness = createHarness({ runnerImpl });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 1000;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ attempts: 2, noBackup: false }),
      );
      expect(lastStepDetail(harness, "backup", "running").detail).toMatch(
        /retrying after a killed backup \(SIGKILL\)/,
      );
    });

    it("result.error → spawn_error: TERMINAL, names the error, never regex-classified", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          // The tail even carries an ENOENT — the flag wins.
          { ok: false, error: "spawn openclaw ENOENT", tail: "ENOENT: no such file or directory\n" },
          { ok: true },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toBe("The pre-update backup could not start: spawn openclaw ENOENT.");
      expect(result.body.hint).toMatch(/never ran/);
      expect(backupCalls).toHaveLength(1);
      // Not reuse-eligible: no offer even though nothing else blocks one.
      expect(result.body.reusableBackup).toBeUndefined();
    });

    it("timedOut beats the killed flag; the killed flag beats the ENOSPC regex", async () => {
      const timedOut = makeBackupRunner({
        script: [{ ok: false, timedOut: true, signal: "SIGTERM", killed: true, tail: "" }],
      });
      const first = createHarness({ runnerImpl: timedOut.runnerImpl });
      const timeoutResult = await first.sync.applyUpdate(kHardGateTarget);
      expect(timeoutResult.status).toBe(409);
      expect(timeoutResult.body.message).toMatch(/timed out after/);

      const killed = makeBackupRunner({
        script: [
          { ok: false, signal: "SIGKILL", killed: true, tail: "Error: ENOSPC no space left on device\n" },
          { ok: false, signal: "SIGKILL", killed: true, tail: "Error: ENOSPC no space left on device\n" },
        ],
      });
      const second = createHarness({ runnerImpl: killed.runnerImpl });
      const killedResult = await second.sync.applyUpdate(kHardGateTarget);
      expect(killedResult.status).toBe(409);
      expect(killedResult.body.message).toMatch(/killed \(SIGKILL\)/);
      expect(killedResult.body.message).not.toMatch(/disk space/);
      expect(killed.backupCalls).toHaveLength(2);
    });

    it("reads the last 20 non-empty lines: a cause 15 lines up classifies, 25 lines up does not", async () => {
      const filler = (n) => Array.from({ length: n }, (_, i) => `progress line ${i}`).join("\n");
      const within = `SQLite transaction lock wait failed\n${filler(15)}\nBackup failed\n`;
      const beyond = `SQLite transaction lock wait failed\n${filler(25)}\nBackup failed\n`;
      const near = makeBackupRunner({ script: [{ ok: false, tail: within }, { ok: false, tail: within }] });
      const nearHarness = createHarness({ runnerImpl: near.runnerImpl });
      const nearResult = await nearHarness.sync.applyUpdate(kHardGateTarget);
      expect(nearResult.body.message).toMatch(/lock contention/);
      expect(near.backupCalls).toHaveLength(2);

      const far = makeBackupRunner({ script: [{ ok: false, tail: beyond }] });
      const farHarness = createHarness({ runnerImpl: far.runnerImpl });
      const farResult = await farHarness.sync.applyUpdate(kHardGateTarget);
      expect(farResult.body.message).toMatch(/^The pre-update backup failed — Backup failed/);
      expect(far.backupCalls).toHaveLength(1);
    });
  });

  // ── Issue #54: quiesced driver — contention retries, offline copy ────────
  describe("quiesced driver: lock contention → retry → offline copy (issue #54)", () => {
    it("retries lease loss in-quiesce with doubling backoff (≤2) and succeeds on the third attempt", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
          { ok: true },
        ],
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce, backupTuning: { contentionBackoffBaseMs: 4 } });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(3);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli(quiet)",
        "backup-cli(quiet)",
        "backup-cli(quiet)",
        "dbResume",
        "start",
        "unsuppress",
        "release",
      ]);
      // Every in-quiesce attempt gets what is LEFT of the fixed deadline.
      expect(backupCalls.every((c) => c.timeoutMs <= kOpenclawBackupQuiesceTimeoutMs)).toBe(true);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          attempts: 3,
          quiescedAttempts: 3,
          quiesced: true,
          contentionRetries: 2,
          noBackup: false,
          producer: "openclaw",
        }),
      );
      const contention = eventsOfType(harness.insertEvent, "backup_contention");
      expect(contention.map((e) => e.status)).toEqual(["retrying", "retrying"]);
      // Doubling: base, then 2× base.
      expect(contention.map((e) => e.details.backoffMs)).toEqual([4, 8]);
      expect(lastStepDetail(harness, "backup", "completed").detail).toBe(
        "succeeded on attempt 3 (gateway paused briefly)",
      );
    });

    it("does not retry when the quiesce budget cannot fit attempt + backoff + reserve (insufficient_budget)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, tail: kLeaseLostTail }, { ok: true }],
      });
      // 20 s envelope → the fixed quiesce deadline is 20 s: 0 + 1 + 30 s reserve
      // does not fit, so the very first contention goes straight to the copy.
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 20_000 },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      const [event] = eventsOfType(harness.insertEvent, "backup_contention");
      expect(event.status).toBe("exhausted");
      expect(event.details.reason).toBe("insufficient_budget");
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          producer: "alphaclaw-offline-copy",
          contentionRetries: 0,
          offlineCopy: expect.objectContaining({ ok: true, reason: "lock_contention" }),
        }),
      );
    });

    it("after exhausted retries takes the AlphaClaw offline copy while still quiesced (real tar/gzip, evidence recorded, usable)", async () => {
      const quiesce = makeQuiesceRecorder({ stopEvidence: { confirmed: true, via: "port_released" } });
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
        ],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      const dbFile = seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(3);
      // The copy happened BEFORE dbResume/start — still quiesced.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "backup-cli",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
      ]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          verified: true,
          producer: "alphaclaw-offline-copy",
          usableCheck: "manifest_ok",
          attempts: 3,
          quiescedAttempts: 3,
          contentionRetries: 2,
          offlineCopy: expect.objectContaining({ ok: true, reason: "lock_contention", partial: false }),
        }),
      );
      expect(record.file).toMatch(/openclaw-backup-\d+-[0-9a-f]{8}\.alphaclaw\.tar\.gz$/);
      expect(fs.statSync(record.file).size).toBeGreaterThan(0);
      expect(record.offlineCopyBytes).toBe(fs.statSync(record.file).size);
      expect(record.exclusivityEvidence).toEqual(
        expect.objectContaining({
          stopConfirmed: true,
          stopEvidence: { confirmed: true, via: "port_released" },
          quiet: "held",
          quietOwner: "quiesced-backup",
          liveProcesses: 0,
          handleCount: 0,
        }),
      );
      // The real archive lists the copied state DB under the archive root.
      const { execFileSync } = require("child_process");
      const listed = execFileSync("tar", ["-tzf", record.file], { encoding: "utf8" });
      expect(listed).toMatch(/\/state\/openclaw\.sqlite\n/);
      expect(listed).toMatch(/\/manifest\.json\n/);
      expect(fs.existsSync(dbFile)).toBe(true);
      // Events + step detail tell the operator what happened.
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "completed",
      ]);
      expect(lastStepDetail(harness, "backup", "completed").detail).toMatch(
        /succeeded via AlphaClaw offline copy after 3 upstream attempts \(gateway paused\)/,
      );
      // The offline copy's own tmp debris is gone; the failed upstream
      // attempts left nothing either (the stub wrote no file).
      const names = fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"));
      expect(names).toEqual([path.basename(record.file)]);
      // state.backups records the producer so the inventory can label it.
      expect(harness.store.readState().backups[0]).toEqual(
        expect.objectContaining({ producer: "alphaclaw-offline-copy", file: record.file }),
      );
    });

    it("a killed upstream CLI goes straight to the offline copy (no in-quiesce retry)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(eventsOfType(harness.insertEvent, "backup_contention")).toHaveLength(0);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          producer: "alphaclaw-offline-copy",
          offlineCopy: expect.objectContaining({ ok: true, reason: "killed" }),
        }),
      );
      expect(lastStepDetail(harness, "backup", "running").detail).toMatch(
        /the upstream backup failed \(killed\) — taking an AlphaClaw offline copy of the paused state/,
      );
    });

    it("short-circuits to the offline copy on a rollback-journal DB over the self-deadlock size (no upstream attempt)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { rollbackJournalSelfDeadlockBytes: 1 },
      });
      seedStateDb(harness, { journalMode: "DELETE" });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          attempts: 0,
          quiesced: true,
          producer: "alphaclaw-offline-copy",
          offlineCopy: expect.objectContaining({ ok: true, reason: "rollback_journal_self_deadlock" }),
        }),
      );
      expect(record.diagnosis).toEqual(
        expect.objectContaining({ journalMode: "delete", dbCount: 1 }),
      );
      expect(record.diagnosis.stateBytes).toBeGreaterThan(1);
      expect(lastStepDetail(harness, "backup", "completed").detail).toMatch(
        /offline copy after 0 upstream attempts/,
      );
    });

    it("short-circuit + refused copy: the 409 names the holder's argv and never says '(after 0 attempts)'", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const listProcesses = vi.fn(() => [{ pid: 4242, cmdline: "openclaw gateway run" }]);
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { rollbackJournalSelfDeadlockBytes: 1 },
        backupProbes: { ...kQuietProbes, listProcesses },
      });
      seedStateDb(harness, { journalMode: "DELETE" });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(backupCalls).toHaveLength(0);
      expect(result.body.message).toMatch(
        /rollback journal too large for the upstream snapshot, and the offline copy was refused because/,
      );
      // No CLI attempt ran — the message must not end in a dangling
      // "(after 0 attempts)" that misreads as "nothing was attempted".
      expect(result.body.message).not.toMatch(/after 0 attempts/);
      expect(result.body.message).toMatch(/\.$/);
      // The refusal names pid AND argv, so an operator can tell a foreign
      // holder from AlphaClaw's own CLI shell-out.
      expect(result.body.message).toMatch(/1 live openclaw process\(es\): 4242 \(openclaw gateway run\)/);
      // The driver re-sampled (settle loop) before refusing a holder that stayed.
      expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          attempts: 0,
          quiesced: true,
          noBackup: true,
          offlineCopy: expect.objectContaining({ ok: false, stage: "exclusivity" }),
        }),
      );
    });

    it("a transient openclaw child (our own CLI shell-out) that exits during the settle window does not refuse the offline copy", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
      });
      // The diagnosis samples once (before the quiesce); the first TWO
      // exclusivity samples still see the child, the third does not.
      let samples = 0;
      const listProcesses = vi.fn(() => {
        samples += 1;
        return samples <= 3 ? [{ pid: 777, cmdline: "openclaw sessions list --json" }] : [];
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: { ...kQuietProbes, listProcesses },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(4);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "alphaclaw-offline-copy",
          verified: true,
          offlineCopy: expect.objectContaining({ ok: true, reason: "killed" }),
        }),
      );
      // The exclusivity evidence records the settled (empty) sample.
      expect(record.exclusivityEvidence).toEqual(expect.objectContaining({ liveProcesses: 0 }));
    });

    it("short-circuits when the prior run's throughput predicts the upstream backup cannot fit the pause", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      // Prior run: the upstream CLI's OWN attempt took the whole quiesce
      // budget for 1 byte → today's DB predicts far longer than what remains.
      const priorId = crypto.randomUUID();
      harness.ledger.createRun({ operationId: priorId, target: { channel: "beta" } });
      harness.ledger.updateRun(priorId, (record) => {
        record.startedAt = 1;
        record.backup = {
          noBackup: false,
          producer: "openclaw",
          attemptMs: kOpenclawBackupQuiesceTimeoutMs,
          durationMs: kOpenclawBackupQuiesceTimeoutMs + 60_000,
          stateBytes: 1,
          file: "/x",
          verified: true,
        };
        return record;
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      const record = readRunBackupRecord(harness);
      expect(record.offlineCopy).toEqual(expect.objectContaining({ ok: true, reason: "predicted_too_slow" }));
      expect(record.diagnosis.predictedUpstreamMs).toBeGreaterThan(kOpenclawBackupQuiesceTimeoutMs);
      expect(record.diagnosis.priorRun).toEqual({
        operationId: priorId,
        attemptMs: kOpenclawBackupQuiesceTimeoutMs,
        stateBytes: 1,
      });
    });

    it("calibrates predictedUpstreamMs from the prior UPSTREAM attempt's own wall time only — never a whole-step duration, never an offline-copy run", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      // Newest prior run: an offline copy whose step took forever (lock wait,
      // stop, copy, prune) — it says nothing about the upstream CLI's speed,
      // and predicting from it would send every later run to the offline copy.
      const offlineId = crypto.randomUUID();
      harness.ledger.createRun({ operationId: offlineId, target: { channel: "beta" } });
      harness.ledger.updateRun(offlineId, (record) => {
        record.startedAt = 2;
        record.backup = {
          noBackup: false,
          producer: "alphaclaw-offline-copy",
          durationMs: kOpenclawBackupQuiesceTimeoutMs * 4,
          attemptMs: kOpenclawBackupQuiesceTimeoutMs * 4,
          stateBytes: 1,
          file: "/y",
          verified: true,
        };
        return record;
      });
      // Older prior run: a legacy (pre-attemptMs) upstream record whose
      // durationMs is the whole step — not calibration input either.
      const legacyId = crypto.randomUUID();
      harness.ledger.createRun({ operationId: legacyId, target: { channel: "beta" } });
      harness.ledger.updateRun(legacyId, (record) => {
        record.startedAt = 1;
        record.backup = { noBackup: false, durationMs: kOpenclawBackupQuiesceTimeoutMs * 4, stateBytes: 1, file: "/x", verified: true };
        return record;
      });
      // The upstream CLI takes 1234 ms of frozen clock.
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 1234;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      // No short-circuit: the upstream attempt ran and succeeded.
      expect(backupCalls).toHaveLength(1);
      const record = readRunBackupRecord(harness);
      expect(record.producer).toBe("openclaw");
      expect(record.offlineCopy).toBeNull();
      expect(record.diagnosis.predictedUpstreamMs).toBeNull();
      expect(record.diagnosis.priorRun).toBeNull();
      // This run records the CLI's own wall time for the NEXT calibration.
      expect(record.attemptMs).toBe(1234);
      expect(record.durationMs).toBeGreaterThanOrEqual(1234);
    });

    it("refuses the offline copy (honest 409) when the state dir is not exclusively ours — a live openclaw process", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: {
          ...kQuietProbes,
          listProcesses: () => [{ pid: 4242, cmdline: "openclaw gateway run" }],
        },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/upstream backup failed \(killed\), and the offline copy was refused because/);
      expect(result.body.message).toMatch(/1 live openclaw process\(es\): 4242/);
      expect(result.body.hint).toMatch(/Stop whatever else is using the OpenClaw state directory/);
      expect(backupCalls).toHaveLength(1);
      // Gateway relaunched, barrier released, nothing left in the backups dir.
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(isStateDbQuiet()).toBe(false);
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: true,
          offlineCopy: expect.objectContaining({ ok: false, stage: "exclusivity", reason: "killed" }),
        }),
      );
      expect(record.diagnosis.otherProcesses).toEqual([{ pid: 4242, cmdline: "openclaw gateway run" }]);
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "failed",
      ]);
    });

    it("hands over to the live ladder when the offline copy fails at a later stage (archive), naming the prior kind", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }, { ok: true }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: (opts) =>
          opts.command === "tar" && opts.args[0] === "-I"
            ? { ok: false, code: 2, tail: "tar: write error: Input/output error\n", timedOut: false }
            : null,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          attempts: 2,
          quiescedAttempts: 1,
          offlineCopy: expect.objectContaining({ ok: false, stage: "archive", reason: "killed" }),
        }),
      );
      expect(lastStepDetail(harness, "backup", "running").detail).toMatch(
        /attempt 2 — retrying after a killed backup \(SIGKILL\)/,
      );
      // Success detail claims no pause: the succeeding attempt ran live.
      expect(lastStepDetail(harness, "backup", "completed").detail).toBe("succeeded on attempt 2");
    });

    it("an expired quiet barrier is never copied over: the copy is refused (barrier lost) and the expiry is on the events tab", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { stateDbQuietMaxMs: 1 },
      });
      seedStateDb(harness);
      // Let the 1 ms expiry fire before the loop reaches the offline copy.
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") await sleep(15);
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/offline copy was refused because state dir is not exclusively ours: state-db quiet barrier lost/);
      expect(eventsOfType(harness.insertEvent, "state_db_quiet").map((e) => e.status)).toContain("expired");
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([]);
    });

    it("an already-held barrier (StateDbQuietError) fails honestly: no CLI attempt, gateway relaunched, lock released", async () => {
      const quiesce = makeQuiesceRecorder({ dbQuietThrows: true });
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/could not pause state-database access: already quiet \(held by other-backup\)/);
      expect(result.body.hint).toMatch(/Wait for the other backup to finish/);
      expect(backupCalls).toHaveLength(0);
      // No dbResume for a barrier we never got; the relaunch + release still run.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "start",
        "unsuppress",
        "release",
      ]);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ noBackup: true, attempts: 0, quiesced: false }),
      );
    });

    it("kill switch OPENCLAW_STATE_DB_QUIET=off: the backup proceeds with a no-op token, and the offline copy still runs — recording quiet:\"disabled\" as evidence, not a refusal", async () => {
      // Orchestrator decision (lane I): the operator deliberately disabled
      // the barrier, so the copy is gated by the remaining proofs (confirmed
      // stop, no live processes/handles/fd holders) and the manifest records
      // the disabled barrier honestly. A MISSING or EXPIRED token still
      // refuses (openclaw-backup-offline-copy.test.js).
      process.env.OPENCLAW_STATE_DB_QUIET = "off";
      try {
        const quiesce = makeQuiesceRecorder({ stopEvidence: { confirmed: true, via: "port_released" } });
        const { runnerImpl } = makeOfflineCopyRunner({
          script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
          onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "quiet:on" : "quiet:off"),
        });
        const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
        seedStateDb(harness);

        const result = await harness.sync.applyUpdate(kHardGateTarget);

        expect(quiesce.calls).toContain("quiet:off");
        expect(eventsOfType(harness.insertEvent, "state_db_quiet").map((e) => e.status)).toEqual(["disabled"]);
        expect(result.status).toBe(202);
        const record = readRunBackupRecord(harness);
        expect(record).toEqual(
          expect.objectContaining({
            noBackup: false,
            producer: "alphaclaw-offline-copy",
            offlineCopy: expect.objectContaining({ ok: true, reason: "killed" }),
          }),
        );
        expect(record.exclusivityEvidence).toEqual(
          expect.objectContaining({
            stopConfirmed: true,
            quiet: "disabled",
            quietOwner: "quiesced-backup",
            liveProcesses: 0,
            handleCount: 0,
          }),
        );
        expect(fs.statSync(record.file).size).toBeGreaterThan(0);
      } finally {
        delete process.env.OPENCLAW_STATE_DB_QUIET;
      }
    });
  });

  // ── Issue #54: honesty — attempts, wording, single running emission ──────
  describe("attempt honesty (WI-1.8/1.9)", () => {
    it("records attempts:0 (never a fabricated 1) when the backups path refuses before any CLI run", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
      fs.symlinkSync(os.tmpdir(), backupsDir);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/is a symlink/);
      expect(result.body.hint).toMatch(/No earlier backup archive exists/);
      expect(backupCalls).toHaveLength(0);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ noBackup: true, attempts: 0, quiesced: false, vanishedPaths: [] }),
      );
    });

    it("says '(after N attempts, M with the gateway paused)' when the ladder mixed both drivers", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, timedOut: true, tail: "" },
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 1000;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(backupCalls).toHaveLength(4);
      expect(result.body.message).toMatch(/\(after 4 attempts, 1 with the gateway paused\)/);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ attempts: 4, quiescedAttempts: 1, quiesced: true }),
      );
    });

    it("emits ONE initial backup:running without a pause detail on the soft-gate/live path", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result.status).toBe(202);
      const running = harness.store
        .readState()
        .lastUpdateRun.steps.filter((s) => s.name === "backup" && s.status === "running");
      expect(running).toHaveLength(1);
      expect(running[0].detail).toBeUndefined();
    });
  });

  // ── WI-6.1: usable check after every verified artifact ───────────────────
  describe("usable check (WI-6.1)", () => {
    it("treats an archive whose manifest covers no state DB as a verify failure (terminal, quarantined)", async () => {
      // A config-only manifest: its single asset is the config file, so no
      // directory-level asset covers state/openclaw.sqlite (the real upstream
      // shape is one kind:"state" asset at the state dir — see the module tests).
      const { runnerImpl, backupCalls } = makeBackupRunner({
        manifestTail: `${JSON.stringify({ schemaVersion: 1, assets: [{ archivePath: "openclaw.json" }] })}\n`,
      });
      const harness = createHarness({ runnerImpl });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/failed to verify — the archive's manifest could not be read \(manifest covers no state\/openclaw\.sqlite\)/);
      expect(backupCalls).toHaveLength(1);
      const names = fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"));
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/\.unverified$/);
      // verify is terminal: no reuse offer either.
      expect(result.body.reusableBackup).toBeUndefined();
    });

    it("treats a failing gzip -t as a verify failure and records the stage", async () => {
      const { runnerImpl } = makeBackupRunner({
        onArchiveTool: (opts) =>
          opts.command === "gzip" ? { ok: false, code: 1, tail: "gzip: crc error\n", timedOut: false } : null,
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/gzip -t: gzip: crc error/);
      expect(lastStepDetail(harness, "backup", "failed").error).toBe("usable check failed: gzip");
    });

    it("runs gzip -t and the manifest extraction against the artifact and records usableCheck on success", async () => {
      const { runnerImpl, archiveToolCalls } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record.usableCheck).toBe("manifest_ok");
      // The digest a later consented reuse binds to is recorded with the
      // artifact, streamed over the file the usable check just passed.
      expect(record.sha256).toBe(sha256Of(record.file));
      expect(archiveToolCalls.map((c) => c.command)).toEqual(["gzip", "tar"]);
      expect(archiveToolCalls[0].args).toEqual(["-t", record.file]);
      expect(archiveToolCalls[1].args).toEqual([
        "-xzOf",
        record.file,
        "--wildcards",
        "--no-wildcards-match-slash",
        "--occurrence=1",
        "*/manifest.json",
      ]);
      expect(archiveToolCalls[1].tailBytes).toBe(16 * 1024 * 1024);
    });
  });

  // ── WI-4.5: consented, sha256-bound reuse of an earlier verified backup ──
  describe("backup reuse gate (WI-4.5)", () => {
    const kHour = 60 * 60 * 1000;
    // Seeds a verified archive with ledger provenance from an earlier,
    // activated run whose apply finished before the backup was taken.
    const seedReusableArchive = (
      harness,
      {
        ageMs = kHour,
        verified = true,
        partial = false,
        name = null,
        producer = "openclaw",
        withRecord = true,
        deleteFile = false,
        // A run that activated counts as "state written since" for every
        // OLDER archive; a failed run does not.
        activated = true,
        // The run's activation time relative to its archive: null = a legacy
        // record without finishedAt (the window floors on startedAt); a
        // positive offset = the run activated AFTER taking this archive.
        finishedAtOffsetMs = null,
      } = {},
    ) => {
      harness.nowRef.now = kRealisticNow;
      const at = harness.nowRef.now - ageMs;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      const file = path.join(backupsDir, name || `openclaw-backup-${at}-prev0000.tar.gz`);
      fs.writeFileSync(file, `earlier archive bytes ${at}\n`);
      const sha256 = sha256Of(file);
      if (withRecord) {
        const operationId = crypto.randomUUID();
        harness.ledger.createRun({ operationId, target: { channel: "stable", version: "1.0.0" } });
        harness.ledger.updateRun(operationId, (record) => {
          record.startedAt = at - 1000;
          if (finishedAtOffsetMs !== null) record.finishedAt = at + finishedAtOffsetMs;
          record.state = activated ? "activated" : "failed";
          record.ok = activated;
          record.backup = { noBackup: false, file, verified, partial, at, producer, usableCheck: "manifest_ok" };
          return record;
        });
      }
      if (deleteFile) fs.unlinkSync(file);
      return { file, at, sha256 };
    };
    const contentionScript = [{ ok: false, tail: kLeaseLostTail }, { ok: false, tail: kLeaseLostTail }];

    it("never offers a run's OWN pre-update backup once that run activated — the window floors on activation (finishedAt), not on the start", async () => {
      // The archive was taken 1 s after the run started and the run switched
      // builds 30 s later: everything the new build rewrote postdates it.
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      seedReusableArchive(harness, { ageMs: 3 * kHour, finishedAtOffsetMs: 30_000 });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.reusableBackup).toBeUndefined();
      // The inventory publishes the same floor the gate used.
      const inventory = harness.sync.listBackupInventory();
      expect(inventory.reuseWindowStartMs).toBe(harness.nowRef.now - 3 * kHour + 30_000);
    });

    it("offers the verified earlier backup on the 409 (reusableBackup) and does NOT reuse it without consent", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: 3 * kHour });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(backupCalls).toHaveLength(2);
      const offer = {
        file: seeded.file,
        at: seeded.at,
        ageMs: 3 * kHour,
        sha256: seeded.sha256,
        producer: "openclaw",
      };
      expect(result.body.reusableBackup).toEqual(offer);
      // A real backup outlives the quick-result window, so the offer must also
      // reach the resume poll (lastUpdateRun.result) and the run ledger.
      expect(harness.store.readState().lastUpdateRun.result).toEqual(
        expect.objectContaining({ ok: false, code: "backup_failed", reusableBackup: offer }),
      );
      const run = readNewestRunRecord(harness);
      expect(run.result).toEqual(
        expect.objectContaining({ ok: false, code: "backup_failed", reusableBackup: offer }),
      );
      expect(run.backup).toEqual(expect.objectContaining({ noBackup: true }));
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
      // The archive is untouched (fd-based verification never mutates it).
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
    });

    it("with matching consent: re-runs the full ladder, then proceeds on the earlier backup — recorded, announced, evented, never pruned", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });
      // Four unrelated older archives (no provenance): a prune would evict
      // the oldest — reuse must never prune.
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      for (let i = 1; i <= 4; i += 1) {
        fs.writeFileSync(path.join(backupsDir, `openclaw-backup-${i}-oldold00.tar.gz`), "old\n");
      }
      const before = fs.readdirSync(backupsDir).sort();

      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        allowBackupReuse: { sha256: seeded.sha256 },
      });
      await flushAsync();

      expect(result.status).toBe(202);
      expect(result.body.restarting).toBe(true);
      // The fresh ladder ran FIRST (both live attempts), then reuse.
      expect(backupCalls).toHaveLength(2);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          verified: true,
          reused: true,
          reusedAgeMs: 2 * kHour,
          sha256: seeded.sha256,
          producer: "openclaw",
          file: seeded.file,
          at: seeded.at,
          usableCheck: "manifest_ok",
          attempts: 2,
          freshAttemptFailure: expect.objectContaining({ kind: "lock_contention" }),
        }),
      );
      expect(record.freshAttemptFailure.message).toMatch(/lock contention.*\(after 2 attempts\)/);
      // Step warning + IMPORTANT notification (no verbose flag) + event.
      expect(lastStepDetail(harness, "backup", "warning").detail).toBe(
        "fresh backup failed (lock_contention) — proceeding with the verified backup from 2 hours ago; state written since is not in it",
      );
      const reuseNotify = harness.notify.mock.calls.find(([, opts]) => opts?.id?.startsWith("backup-reused-"));
      expect(reuseNotify).toBeTruthy();
      expect(String(reuseNotify[0])).toMatch(/Proceeding with the verified backup from 2 hours ago/);
      expect(reuseNotify[1].verbose).toBeUndefined();
      expect(reuseNotify[1].operationId).toBe(result.body.operationId);
      const [reused] = eventsOfType(harness.insertEvent, "backup_reused");
      expect(reused.details).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256, failedKind: "lock_contention" }),
      );
      // Never prunes: every archive that was there is still there.
      expect(fs.readdirSync(backupsDir).sort()).toEqual(before);
    });

    it("a fresh success with consent present is a normal fresh backup (consent unused)", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, allowBackupReuse: { sha256: seeded.sha256 } });
      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record.reused).toBeUndefined();
      expect(record.file).not.toBe(seeded.file);
    });

    it("a consent sha256 that matches no candidate is not honored — the 409 still carries the offer", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, allowBackupReuse: { sha256: "f".repeat(64) } });
      expect(result.status).toBe(409);
      expect(result.body.reusableBackup.sha256).toBe(seeded.sha256);
      expect(readRunBackupRecord(harness).noBackup).toBe(true);
    });

    it.each([
      ["older than 24h", { ageMs: 25 * kHour }],
      ["partial", { partial: true }],
      ["unverified", { verified: false }],
      ["recorded but pruned from disk", { deleteFile: true }],
      ["on disk without provenance", { withRecord: false }],
    ])("never offers a candidate that is %s", async (_label, seedOptions) => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      seedReusableArchive(harness, seedOptions);
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toBeUndefined();
    });

    it("never offers a candidate taken before a later apply/activation (state written since)", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      seedReusableArchive(harness, { ageMs: 5 * kHour });
      harness.store.updateState((s) => {
        s.applied = { channel: "beta", version: "1.0.5", at: harness.nowRef.now - 2 * kHour, acceptedAt: null };
        return s;
      });
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toBeUndefined();
    });

    it("a later ACTIVATED run fences out every older archive, a later FAILED run does not", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const older = seedReusableArchive(harness, { ageMs: 6 * kHour, name: "openclaw-backup-1-older000.tar.gz" });
      // Newer archive from a run that activated → the older one is stale.
      seedReusableArchive(harness, { ageMs: 3 * kHour, name: "openclaw-backup-2-newer0000.tar.gz", partial: true });
      const fenced = await harness.sync.applyUpdate(kHardGateTarget);
      expect(fenced.status).toBe(409);
      // The newer one is partial (ineligible) and the older one predates its
      // activation → nothing to offer.
      expect(fenced.body.reusableBackup).toBeUndefined();
      expect(older.file).toBeTruthy();
    });

    it("skips a candidate whose re-verification times out and moves to the next one", async () => {
      const seenFiles = [];
      const { runnerImpl } = makeBackupRunner({
        script: contentionScript,
        onArchiveTool: (opts) => {
          if (opts.command !== "gzip") return null;
          seenFiles.push(archiveToolFile(opts.args[1]));
          return archiveToolFile(opts.args[1]).includes("newer0000")
            ? { ok: false, code: null, tail: "", timedOut: true }
            : null;
        },
      });
      const harness = createHarness({ runnerImpl });
      const older = seedReusableArchive(harness, { ageMs: 4 * kHour, name: "openclaw-backup-1-older000.tar.gz" });
      // The newer archive came from a run that then FAILED (no activation
      // since the older one), so both are in the window.
      seedReusableArchive(harness, { ageMs: 1 * kHour, name: "openclaw-backup-2-newer0000.tar.gz", activated: false });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(seenFiles.map((f) => path.basename(f))).toEqual([
        "openclaw-backup-2-newer0000.tar.gz",
        "openclaw-backup-1-older000.tar.gz",
      ]);
      expect(result.body.reusableBackup.file).toBe(older.file);
    });

    // ── The re-verification binds to the OPENED inode, never the pathname ──
    it("re-verifies a candidate through /proc/<pid>/fd/<fd> — the inode it hashes — never through the pathname (Linux)", async () => {
      const reuseToolCalls = [];
      const { runnerImpl } = makeBackupRunner({
        script: contentionScript,
        onArchiveTool: (opts) => {
          // Resolved HERE, while the gate still holds the fd open — it is
          // closed (and the /proc entry gone) by the time the apply returns.
          reuseToolCalls.push({
            command: opts.command,
            file: opts.args[1],
            resolved: fs.readlinkSync(opts.args[1]),
          });
          return null;
        },
      });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256 }),
      );
      expect(reuseToolCalls.map((c) => c.command)).toEqual(["gzip", "tar"]);
      for (const call of reuseToolCalls) {
        expect(call.file).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
        expect(call.resolved).toBe(seeded.file);
      }
    });

    it("refuses a candidate swapped under its pathname between the usable check and the hash — consent never binds to an unchecked inode", async () => {
      let swapped = false;
      const { runnerImpl } = makeBackupRunner({
        script: contentionScript,
        onArchiveTool: (opts) => {
          if (opts.command !== "tar" || swapped) return null;
          swapped = true;
          // A local writer renames a different archive onto the candidate's
          // path while the manifest extraction is still running.
          const target = archiveToolFile(opts.args[1]);
          fs.writeFileSync(`${target}.decoy`, "a different archive\n");
          fs.renameSync(`${target}.decoy`, target);
          return null;
        },
      });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });

      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        allowBackupReuse: { sha256: seeded.sha256 },
      });

      expect(swapped).toBe(true);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.reusableBackup).toBeUndefined();
      expect(readRunBackupRecord(harness).noBackup).toBe(true);
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
    });

    it("off Linux (platform seam): the tools read the pathname and a swap during the usable check is refused by the re-stat against the opened inode", async () => {
      const toolFiles = [];
      const { runnerImpl } = makeBackupRunner({
        script: contentionScript,
        onArchiveTool: (opts) => {
          toolFiles.push(opts.args[1]);
          if (opts.command !== "gzip") return null;
          fs.writeFileSync(`${opts.args[1]}.decoy`, "a different archive\n");
          fs.renameSync(`${opts.args[1]}.decoy`, opts.args[1]);
          return null;
        },
      });
      const harness = createHarness({ runnerImpl, extraSyncOptions: { platform: "darwin" } });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });

      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        allowBackupReuse: { sha256: seeded.sha256 },
      });

      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toBeUndefined();
      // No /proc path off Linux: gzip and tar both read the pathname.
      expect(toolFiles).toEqual([seeded.file, seeded.file]);
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
    });

    // ── The 24 h window is bounded on BOTH sides ──
    it("never offers a future-dated candidate (clock jump or forged record) — the inventory says future_dated", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: -(2 * kHour) });
      const [entry] = harness.sync.listBackupInventory().entries;
      expect(entry).toEqual(
        expect.objectContaining({ file: seeded.file, eligible: false, ineligibleReason: "future_dated" }),
      );

      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        allowBackupReuse: { sha256: seeded.sha256 },
      });

      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toBeUndefined();
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
      // The only ledger run with a real backup is the seed itself — the
      // current run recorded none (the seed sorts as the "newest" record, so
      // readRunBackupRecord cannot be used here).
      expect(harness.ledger.listRuns().filter((run) => run.backup?.noBackup === false)).toHaveLength(1);
    });

    it("a record inside the clock-skew tolerance still counts as recent", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, {
        ageMs: -(kOpenclawBackupClockSkewToleranceMs - 1000),
      });
      expect(harness.sync.listBackupInventory().entries[0].eligible).toBe(true);
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.reusableBackup).toEqual(expect.objectContaining({ file: seeded.file }));
    });

    it("offline copy refused in-quiesce: the reuse gate re-verifies candidates only AFTER dbResume + start + release (gateway up, barrier released)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: (opts) => {
          quiesce.calls.push(`${opts.command}:${isStateDbQuiet() ? "quiet" : "resumed"}`);
          return null;
        },
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: {
          ...kQuietProbes,
          listProcesses: () => [{ pid: 4242, cmdline: "openclaw gateway run" }],
        },
      });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/offline copy was refused/);
      expect(result.body.reusableBackup).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256 }),
      );
      expect(backupCalls).toHaveLength(1);
      // gzip -t / tar (the candidate re-verification) come strictly after the
      // quiesce unwound — never with the gateway down and the barrier held.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "gzip:resumed",
        "tar:resumed",
      ]);
    });

    it("in-quiesce upstream success whose usable check TIMES OUT: the check runs quiesced, the reuse gate re-verifies candidates only AFTER dbResume + start + unsuppress + release", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: (opts) => {
          quiesce.calls.push(`${opts.command}:${isStateDbQuiet() ? "quiet" : "resumed"}`);
          // The fresh archive's gzip -t hits OUR timeout; the seeded
          // candidate's re-verification answers normally.
          if (opts.command === "gzip" && !archiveToolFile(opts.args[1]).includes("prev0000")) {
            return { ok: false, code: null, tail: "", timedOut: true };
          }
          return null;
        },
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/ran out of time — the archive was written but could not be checked/);
      expect(result.body.reusableBackup).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256 }),
      );
      expect(backupCalls).toHaveLength(1);
      // The usable check of the fresh archive is the ONE verification that
      // stays inside the pause (it decides whether the transaction produced a
      // backup and is budgeted by the lease reserve); the window_exhausted
      // finalization — and with it the reuse gate's gzip -t / tar over the
      // candidate — waits for the unwind, never runs with the gateway down.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "gzip:quiet",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "gzip:resumed",
        "tar:resumed",
      ]);
      expect(isStateDbQuiet()).toBe(false);
    });

    it("in-quiesce upstream success: the usable check runs paused, the record (after prune + sha256) is published only after the relaunch", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: (opts) => {
          quiesce.calls.push(`${opts.command}:${isStateDbQuiet() ? "quiet" : "resumed"}`);
          return null;
        },
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      quiesce.start.mockImplementation(async () => {
        quiesce.calls.push("start");
        const recorded = harness.store.readState().backups?.length > 0;
        quiesce.calls.push(recorded ? "record:before-relaunch" : "record:pending");
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "backup-cli",
        "gzip:quiet",
        "tar:quiet",
        "dbResume",
        "start",
        "record:pending",
        "unsuppress",
        "release",
      ]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({ verified: true, quiesced: true, usableCheck: "manifest_ok" }),
      );
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(harness.store.readState().backups).toHaveLength(1);
    });

    it("window_exhausted is reachable for reuse: the candidate re-verification gets its OWN budget, not the spent envelope", async () => {
      const quiesce = makeQuiesceRecorder({});
      const gzipTimeouts = [];
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kVanishedLockTail }],
        onArchiveTool: (opts) => {
          if (opts.command !== "gzip") return null;
          gzipTimeouts.push(opts.timeoutMs);
          // A real gzip -t of a multi-GB archive cannot finish in a few ms.
          return opts.timeoutMs < 1000 ? { ok: false, code: null, tail: "", timedOut: true } : null;
        },
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 1000 },
      });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 2000;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/backup window was exhausted/);
      expect(backupCalls).toHaveLength(1);
      expect(gzipTimeouts).toEqual([kOpenclawBackupReuseVerifyTimeoutMs]);
      expect(result.body.reusableBackup).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256 }),
      );
    });

    it("a usable check that hits OUR timeout is window_exhausted: honest message, the CLI-verified archive stays in place (no .unverified), reuse offered", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onArchiveTool: (opts) =>
          opts.command === "gzip" && !archiveToolFile(opts.args[1]).includes("prev0000")
            ? { ok: false, code: null, tail: "", timedOut: true }
            : null,
      });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness, { ageMs: 2 * kHour });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/ran out of time — the archive was written but could not be checked/);
      expect(result.body.message).not.toMatch(/failed to verify/);
      expect(lastStepDetail(harness, "backup", "failed").error).toBe("usable check timed out: gzip");
      expect(backupCalls).toHaveLength(1);
      // The archive keeps its real name — no quarantine — and is a survivor
      // the hint can name.
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const names = fs.readdirSync(backupsDir);
      expect(names.some((n) => n.endsWith(".unverified"))).toBe(false);
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(2);
      expect(result.body.hint).toMatch(/The newest surviving backup is/);
      expect(result.body.reusableBackup).toEqual(expect.objectContaining({ file: seeded.file }));
      expect(readRunBackupRecord(harness)).toEqual(expect.objectContaining({ noBackup: true }));
    });

    it("never runs the reuse check for a non-retryable class (ENOSPC), even with a perfect candidate", async () => {
      const { runnerImpl, archiveToolCalls } = makeBackupRunner({
        script: [{ ok: false, tail: "Error: ENOSPC no space left on device\n" }],
      });
      const harness = createHarness({ runnerImpl });
      seedReusableArchive(harness);
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.message).toMatch(/disk space/);
      expect(result.body.reusableBackup).toBeUndefined();
      expect(archiveToolCalls).toHaveLength(0);
    });

    it("soft gates never reuse (the warning path continues without a backup)", async () => {
      const { runnerImpl } = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({ runnerImpl });
      const seeded = seedReusableArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, allowBackupReuse: { sha256: seeded.sha256 } });
      await flushAsync();
      expect(result.status).toBe(202);
      expect(readRunBackupRecord(harness)).toEqual(expect.objectContaining({ noBackup: true }));
    });
  });

  // ── WI-4.3: inventory ────────────────────────────────────────────────────
  describe("listBackupInventory (WI-4.3)", () => {
    it("classifies symlinks, provenance, partial/unverified, missing records, and caps at 50 newest", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true });
      const now = harness.nowRef.now;
      const recordRun = (backup) => {
        const operationId = crypto.randomUUID();
        harness.ledger.createRun({ operationId, target: {} });
        harness.ledger.updateRun(operationId, (r) => {
          r.backup = { noBackup: false, ...backup };
          return r;
        });
        return operationId;
      };
      const verifiedFile = path.join(backupsDir, "openclaw-backup-100-verified.tar.gz");
      fs.writeFileSync(verifiedFile, "v\n");
      const verifiedOp = recordRun({ file: verifiedFile, verified: true, at: now - 100 });
      const partialFile = path.join(backupsDir, "openclaw-backup-101-partial0.alphaclaw.tar.gz");
      fs.writeFileSync(partialFile, "p\n");
      const kPartialReasons = [
        "workspace files excluded (900 MB > 512 MB inline limit)",
        "credentials/oauth.json: symlink skipped",
      ];
      recordRun({
        file: partialFile,
        verified: true,
        partial: true,
        // Non-string debris on the record never reaches the UI.
        partialReasons: [...kPartialReasons, 42, "  "],
        at: now - 101,
        producer: "alphaclaw-offline-copy",
      });
      const unverifiedFile = path.join(backupsDir, "openclaw-backup-102-unverif0.tar.gz");
      fs.writeFileSync(unverifiedFile, "u\n");
      recordRun({ file: unverifiedFile, verified: false, at: now - 102 });
      fs.writeFileSync(path.join(backupsDir, "openclaw-backup-103-noprov00.tar.gz"), "n\n");
      fs.symlinkSync(verifiedFile, path.join(backupsDir, "openclaw-backup-104-symlink0.tar.gz"));
      const missingFile = path.join(backupsDir, "openclaw-backup-105-missing0.tar.gz");
      recordRun({ file: missingFile, verified: true, at: now - 105 });
      // Debris and stray operator files are not archive-class.
      fs.writeFileSync(path.join(backupsDir, "openclaw-backup-106-x.tar.gz.unverified"), "q\n");
      fs.writeFileSync(path.join(backupsDir, "notes.txt"), "keep\n");
      // state.backups provenance (no ledger record) counts too.
      const stateFile = path.join(backupsDir, "openclaw-backup-107-statebk0.tar.gz");
      fs.writeFileSync(stateFile, "s\n");
      harness.store.updateState((s) => {
        s.backups = [
          { file: stateFile, verified: true, at: now - 107, producer: "openclaw", sha256: "ab".repeat(32) },
        ];
        return s;
      });

      const inventory = harness.sync.listBackupInventory();

      expect(inventory.backupsDir).toBe(backupsDir);
      expect(inventory.readable).toBe(true);
      expect(inventory.truncated).toBe(false);
      const byName = Object.fromEntries(inventory.entries.map((e) => [e.name, e]));
      expect(Object.keys(byName).sort()).toEqual([
        "openclaw-backup-100-verified.tar.gz",
        "openclaw-backup-101-partial0.alphaclaw.tar.gz",
        "openclaw-backup-102-unverif0.tar.gz",
        "openclaw-backup-103-noprov00.tar.gz",
        "openclaw-backup-104-symlink0.tar.gz",
        "openclaw-backup-105-missing0.tar.gz",
        "openclaw-backup-107-statebk0.tar.gz",
      ]);
      expect(byName["openclaw-backup-100-verified.tar.gz"]).toEqual(
        expect.objectContaining({
          eligible: true,
          ineligibleReason: null,
          verified: true,
          partial: false,
          exists: true,
          producer: "openclaw",
          operationId: verifiedOp,
          sizeBytes: 2,
          at: now - 100,
          // No digest on the record → null, never undefined (the UI keys on it
          // to pre-fill consent).
          sha256: null,
          // Old records carry no reasons → null, so the UI falls back to its
          // generic partial label instead of rendering "undefined".
          partialReasons: null,
        }),
      );
      expect(byName["openclaw-backup-107-statebk0.tar.gz"].sha256).toBe("ab".repeat(32));
      expect(byName["openclaw-backup-101-partial0.alphaclaw.tar.gz"]).toEqual(
        expect.objectContaining({
          eligible: false,
          ineligibleReason: "partial",
          producer: "alphaclaw-offline-copy",
          // The record's reasons ride the inventory verbatim (strings only).
          partialReasons: kPartialReasons,
        }),
      );
      expect(byName["openclaw-backup-102-unverif0.tar.gz"].ineligibleReason).toBe("unverified");
      expect(byName["openclaw-backup-103-noprov00.tar.gz"].ineligibleReason).toBe("no_provenance");
      expect(byName["openclaw-backup-104-symlink0.tar.gz"]).toEqual(
        expect.objectContaining({ eligible: false, ineligibleReason: "symlink", exists: true }),
      );
      expect(byName["openclaw-backup-105-missing0.tar.gz"]).toEqual(
        expect.objectContaining({ eligible: false, ineligibleReason: "missing", exists: false, sizeBytes: null }),
      );
      expect(byName["openclaw-backup-107-statebk0.tar.gz"]).toEqual(
        expect.objectContaining({ eligible: true, operationId: null }),
      );
      // newestArchive is the newest REGULAR file by mtime (the last one written).
      expect(inventory.newestArchive).toEqual({ file: stateFile, sizeBytes: 2 });

      // Cap: 60 more provenance-less archives → 50 entries, truncated.
      for (let i = 0; i < 60; i += 1) {
        fs.writeFileSync(path.join(backupsDir, `openclaw-backup-${200 + i}-cap${String(i).padStart(5, "0")}.tar.gz`), "c\n");
      }
      const capped = harness.sync.listBackupInventory();
      expect(capped.entries).toHaveLength(50);
      expect(capped.truncated).toBe(true);
    });

    it("reports an unreadable backups directory honestly", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const inventory = harness.sync.listBackupInventory();
      expect(inventory.readable).toBe(false);
      expect(inventory.entries).toEqual([]);
      expect(inventory.newestArchive).toBeNull();
    });

    it("publishes the reuse gate's window (ledger activations included) and its max age — the UI's consent model binds to the same bounds", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      // The harness clock starts near epoch; hours-ago timestamps need a
      // realistic "now" (the window is clamped at 0).
      harness.nowRef.now = Date.parse("2026-09-02T12:00:00.000Z");
      const now = harness.nowRef.now;
      const kHour = 60 * 60 * 1000;

      // Nothing recorded: unbounded below, 24 h cap from the shared constant.
      let inventory = harness.sync.listBackupInventory();
      expect(inventory.reuseWindowStartMs).toBe(0);
      expect(inventory.reuseMaxAgeMs).toBe(kOpenclawBackupReuseMaxAgeMs);
      expect(inventory.reuseMaxAgeMs).toBe(24 * kHour);

      // An ACTIVATED run the channel payload no longer points at (lastUpdateRun
      // cleared) still fences the window — this is exactly what the UI's
      // channel-payload mirror cannot see. A FAILED run never moves it.
      const seedRun = ({ state, ok, startedAt }) => {
        const operationId = crypto.randomUUID();
        harness.ledger.createRun({ operationId, target: {} });
        harness.ledger.updateRun(operationId, (r) => {
          r.state = state;
          r.ok = ok;
          r.startedAt = startedAt;
          return r;
        });
        return operationId;
      };
      seedRun({ state: "activated", ok: true, startedAt: now - 2 * kHour });
      seedRun({ state: "failed", ok: false, startedAt: now - 1 * kHour });
      harness.store.updateState((s) => {
        s.applied = { channel: "stable", version: "1.0.5", at: now - 5 * kHour, acceptedAt: null };
        s.lastUpdateRun = null;
        return s;
      });
      inventory = harness.sync.listBackupInventory();
      expect(inventory.reuseWindowStartMs).toBe(now - 2 * kHour);

      // The newest record wins, whichever store carries it.
      harness.store.updateState((s) => {
        s.configMigration = { lastAttempt: { ok: true, at: now - 90 * 60 * 1000 } };
        return s;
      });
      expect(harness.sync.listBackupInventory().reuseWindowStartMs).toBe(now - 90 * 60 * 1000);

      // The value is the gate's own verdict: an archive taken just before the
      // window start is refused by the reuse gate, one taken at/after it is
      // offered — pinned end-to-end elsewhere in this file (WI-4.5 "later
      // ACTIVATED run fences out every older archive").
    });

    it("does not live on getChannelInfo() (status hot path)", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const keys = Object.keys(harness.sync.getChannelInfo());
      expect(keys).not.toContain("backups");
      expect(keys).not.toContain("inventory");
    });
  });

  // ── WI-4.2: bounded prune pin ────────────────────────────────────────────
  describe("pruneBackups pin (WI-4.2)", () => {
    const seedMigratedRun = (harness, { file, ageMs }) => {
      const operationId = crypto.randomUUID();
      harness.ledger.createRun({ operationId, target: {} });
      harness.ledger.updateRun(operationId, (r) => {
        r.startedAt = harness.nowRef.now - ageMs;
        r.state = "activated";
        r.dbPreflight = { migrationRequired: true, foundVersion: 1, targetVersion: 12 };
        r.backup = { noBackup: false, file, verified: true, at: harness.nowRef.now - ageMs };
        return r;
      });
    };
    const seedOldArchives = (harness) => {
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      const pinned = path.join(backupsDir, "openclaw-backup-1-pinned00.tar.gz");
      fs.writeFileSync(pinned, "pinned\n");
      fs.utimesSync(pinned, new Date(1_000), new Date(1_000));
      for (let i = 2; i <= 4; i += 1) {
        const f = path.join(backupsDir, `openclaw-backup-${i}-newer000.tar.gz`);
        fs.writeFileSync(f, "newer\n");
        fs.utimesSync(f, new Date(i * 1_000), new Date(i * 1_000));
      }
      return { backupsDir, pinned };
    };

    it("exempts the fenced migrating run's archive from keep-3 eviction while it is ≤ 7 days old", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const { backupsDir, pinned } = seedOldArchives(harness);
      seedMigratedRun(harness, { file: pinned, ageMs: 2 * 24 * 60 * 60 * 1000 });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const names = fs.readdirSync(backupsDir).sort();
      // 3 newest (the fresh one + two of the "newer" seeds) + the pinned one.
      expect(names).toContain("openclaw-backup-1-pinned00.tar.gz");
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(4);
      expect(names).not.toContain("openclaw-backup-2-newer000.tar.gz");
    });

    it("prunes it normally once the migrating run is older than the pin age", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const { backupsDir, pinned } = seedOldArchives(harness);
      seedMigratedRun(harness, { file: pinned, ageMs: 8 * 24 * 60 * 60 * 1000 });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const names = fs.readdirSync(backupsDir);
      expect(names).not.toContain("openclaw-backup-1-pinned00.tar.gz");
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(3);
    });
  });

  // ── Stale offline-copy temp dirs (crash/SIGTERM debris) ──────────────────
  describe("stale .offline-copy-* temp dirs", () => {
    it("sweeps a temp dir older than the offline-copy budget + slack; a fresh one (and a same-named plain file) survive", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      // Names built from the PRODUCER's exported prefix — the coupling the
      // sweep depends on is pinned here, not re-spelled.
      expect(kOfflineCopyTempDirPrefix).toBe(".offline-copy-");
      const stale = path.join(backupsDir, `${kOfflineCopyTempDirPrefix}4242-deadbeef`);
      const fresh = path.join(backupsDir, `${kOfflineCopyTempDirPrefix}4243-cafef00d`);
      const notADir = path.join(backupsDir, `${kOfflineCopyTempDirPrefix}note`);
      fs.mkdirSync(path.join(stale, "openclaw-backup-1-deadbeef", "state"), { recursive: true });
      fs.writeFileSync(
        path.join(stale, "openclaw-backup-1-deadbeef", "state", "openclaw.sqlite"),
        "copied db\n",
      );
      fs.mkdirSync(fresh, { recursive: true });
      fs.writeFileSync(notADir, "operator note\n");
      const staleAt = new Date(
        kRealisticNow - kOpenclawBackupOfflineCopyBudgetMs - kOpenclawBackupStaleTempDirSlackMs - 60_000,
      );
      fs.utimesSync(stale, staleAt, staleAt);
      fs.utimesSync(notADir, staleAt, staleAt);
      const freshAt = new Date(kRealisticNow - 1000);
      fs.utimesSync(fresh, freshAt, freshAt);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const names = fs.readdirSync(backupsDir).sort();
      expect(names).not.toContain(path.basename(stale));
      expect(names).toContain(path.basename(fresh));
      expect(names).toContain(path.basename(notADir));
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(1);
    });
  });

  // ── Archives carry credentials: 0700 directory, 0600 files ───────────────
  describe("archive and directory permissions", () => {
    it("repairs an existing world-readable backups dir to 0700 and tightens the upstream archive to 0600 once it verifies", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      // An operator (or an older release under umask 022) created it 0755.
      fs.mkdirSync(backupsDir, { recursive: true });
      fs.chmodSync(backupsDir, 0o755);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700);
      const record = readRunBackupRecord(harness);
      expect(record.verified).toBe(true);
      // The stub CLI wrote the archive under the umask (0644).
      expect(fs.statSync(record.file).mode & 0o777).toBe(0o600);
    });
  });

  // ── State-file compat: new-shape records under the normalizers ───────────
  describe("state-file compat", () => {
    it("new-shape backup records round-trip through the run ledger and the channel state untouched", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const operationId = crypto.randomUUID();
      const backup = {
        noBackup: false,
        file: "/data/backups/openclaw/openclaw-backup-1-abcd1234.alphaclaw.tar.gz",
        verified: true,
        producer: "alphaclaw-offline-copy",
        usableCheck: "manifest_ok",
        reused: false,
        sha256: "a".repeat(64),
        attempts: 3,
        quiescedAttempts: 3,
        contentionRetries: 2,
        offlineCopy: { ok: true, reason: "lock_contention", durationMs: 1200, bytes: 4096, partial: false },
        diagnosis: { journalMode: "wal", fsType: "ext4", stateBytes: 1024, otherProcesses: [], predictedUpstreamMs: null },
        exclusivityEvidence: { quiet: "held", completeness: "full" },
        durationMs: 5000,
        stateBytes: 1024,
      };
      harness.ledger.createRun({ operationId, target: {} });
      harness.ledger.updateRun(operationId, (r) => {
        r.backup = backup;
        return r;
      });
      expect(harness.ledger.readRun(operationId).backup).toEqual(backup);
      harness.store.updateState((s) => {
        s.backups = [{ ...backup, at: 5, dir: "/data/backups/openclaw" }];
        return s;
      });
      expect(harness.store.readState().backups[0]).toEqual({ ...backup, at: 5, dir: "/data/backups/openclaw" });
    });

    it("old-shape records (no producer/usableCheck/reused) still load and read as upstream-produced", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true });
      const file = path.join(backupsDir, "openclaw-backup-1-legacy00.tar.gz");
      fs.writeFileSync(file, "legacy\n");
      const operationId = crypto.randomUUID();
      harness.ledger.createRun({ operationId, target: {} });
      harness.ledger.updateRun(operationId, (r) => {
        // Exactly what a v0.9.6x run wrote.
        r.backup = { at: 1, dir: backupsDir, file, verified: true, noBackup: false, attempts: 1, quiesced: true, vanishedPaths: [] };
        return r;
      });
      const [entry] = harness.sync.listBackupInventory().entries;
      expect(entry).toEqual(
        expect.objectContaining({ file, producer: "openclaw", verified: true, partial: false, reused: false, eligible: true }),
      );
    });
  });
});
