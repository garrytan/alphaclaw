// Backup ladder (issues #11/#18/#54/#79): every apply that can pause the
// gateway does — soft and hard gates alike (decision D1a) — and the AlphaClaw
// offline copy of the paused state is the FIRST rung; the in-quiesce upstream
// `backup create` runs only after a failed copy, and only when
// chooseBackupRung predicts it fits what is left of the pause; the
// vanished-file retry ladder runs LIVE for everything that falls through.
// `hardGate` decides only whether a failure is fatal. The scripted
// gatewayQuiesce recorder pins the exact stop/start/lock ordering the design
// depends on — the watchdog relaunches an exited gateway 10s into a managed
// operation unless the lifecycle lock is held, so order here is correctness,
// not style.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { listLiveOpenclawProcesses } = require("../../lib/server/openclaw-lock-contention");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { kConsentTtlMs } = require("../../lib/server/backup-risk-consent");

const {
  createOpenclawChannelSync,
  kQuiescedOutcomePolicy,
  kLiveRetryPolicy,
  kReuseEligibleKinds,
  contentionRetryVerdict,
  chooseBackupRung,
  predictTransferMs,
  kDefaultBackupBudget,
  backupBudgetPins,
  parseMountInfoFsType,
  formatAge,
  describeBackupProgress,
} = require("../../lib/server/openclaw-channel-sync");
const backupLadder = require("../../lib/server/openclaw-backup-ladder");
const {
  kOfflineCopyTempDirPrefix,
  kWalkCheckpointEvery,
} = require("../../lib/server/openclaw-backup-offline-copy");
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
  kOpenclawBackupUpstreamInactivityMs,
  kOpenclawBackupLiveAttempts,
  kOpenclawBackupUpstreamMaxBytes,
  kOpenclawBackupPerFileOverheadMs,
  kOpenclawBackupDefaultCopyBytesPerSec,
  kOpenclawBackupDefaultUpstreamBytesPerSec,
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

// `schema` = declared schema constants the way upstream's dist chunks carry
// them (openclaw-{agent,state}-db-contract-<hash>.js, issue #78) — the
// TARGET's supported schema line for the db-preflight's agent arm.
const writePackageFixture = (packageDir, { version, schema = null } = {}) => {
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
  if (Number.isInteger(schema?.state)) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "openclaw-state-db-contract-test.js"),
      `const OPENCLAW_STATE_SCHEMA_VERSION = ${schema.state};\nexport { OPENCLAW_STATE_SCHEMA_VERSION as O };\n`,
    );
  }
  if (Number.isInteger(schema?.agent)) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "openclaw-agent-db-contract-test.js"),
      `const OPENCLAW_AGENT_SCHEMA_VERSION = ${schema.agent};\nexport { OPENCLAW_AGENT_SCHEMA_VERSION as O };\n`,
    );
  }
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
    // Every archive-tool call — the usable check's `gzip -t` / `tar -xzOf`
    // AND the offline copy's `tar -I 'gzip -1'` (copy-first runs it in every
    // quiesce) — offers the hook first; only the answered checks are recorded
    // in archiveToolCalls (the copy's tar is not a usable check).
    if (["tar", "gzip", "sh"].includes(opts.command)) {
      const override = onArchiveTool?.(opts);
      if (override) return override;
    }
    const archiveTool = answerArchiveTool(opts, manifestTail === undefined ? {} : { manifestTail });
    if (archiveTool) {
      archiveToolCalls.push({
        command: opts.command,
        args: opts.args,
        timeoutMs: opts.timeoutMs,
        tailBytes: opts.tailBytes,
      });
      return archiveTool;
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
// `userVersion` stamps the schema line the db-preflight's own PRAGMA read
// reports beside the target CLI's verdict (a mismatch is one warning row).
const seedStateDb = (harness, { journalMode = "WAL", rows = 5, userVersion = null } = {}) => {
  const file = path.join(harness.openclawDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE t(x INTEGER)");
  for (let i = 0; i < rows; i += 1) db.exec(`INSERT INTO t VALUES (${i})`);
  if (Number.isInteger(userVersion)) db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return file;
};
// An agent DB at an explicit schema line — judged by the db-preflight's agent
// arm (PRAGMA user_version vs the target's declared agent schema), never by
// the state-schema verb (#78).
const seedAgentDb = (harness, agentId, { userVersion = 0 } = {}) => {
  const file = path.join(harness.openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  return file;
};
// The target CLI's state-schema verb (`node <bin> database preflight
// <snapshot> --json`) answered with a fixed verdict; every other command
// falls through to the scripted runner.
const withPreflightVerdict = (runnerImpl, verdict) => async (opts) =>
  opts.command === "node" &&
  Array.isArray(opts.args) &&
  opts.args[1] === "database" &&
  opts.args[2] === "preflight"
    ? { ok: true, code: 0, tail: `${JSON.stringify(verdict)}\n`, timedOut: false }
    : runnerImpl(opts);

// Copy-first (#79 (c)): the offline copy runs in EVERY quiesce, so a test that
// wants to exercise the in-quiesce UPSTREAM attempt (or the live fallback)
// must fail the copy at a non-exclusivity stage. `tar -I 'gzip -1'` is the
// copy's archive step; an I/O error there is the "archive" stage failure the
// driver hands to chooseBackupRung.
const failCopyArchive = (opts) =>
  opts.command === "tar" && opts.args[0] === "-I"
    ? { ok: false, code: 2, tail: "tar: write error: Input/output error\n", timedOut: false }
    : null;
// Records the copy's archive step on the quiesce recorder's call log, with
// the barrier state at that instant (the copy must run with the barrier HELD).
const markOfflineCopy =
  (quiesce, label = "offline-copy") =>
  (opts) => {
    if (opts.command === "tar" && opts.args[0] === "-I") {
      quiesce.calls.push(`${label}(${isStateDbQuiet() ? "quiet" : "resumed"})`);
    }
    return null;
  };
const composeHooks =
  (...hooks) =>
  (opts) => {
    for (const hook of hooks) {
      const answer = hook?.(opts);
      if (answer) return answer;
    }
    return null;
  };
// A prior UPSTREAM run record — the upstream series' only calibration input
// (attemptMs × today's DB bytes / prior DB bytes; #79 (d) expresses the same
// ratio as a rate through predictTransferMs). The defaults predict ~0 ms for
// any small DB, so chooseBackupRung answers `predicted_fits` and the
// post-copy upstream attempt runs in-quiesce; slow overrides make it refuse.
const seedPriorUpstreamRun = (harness, { attemptMs = 1, stateBytes = 1e9, startedAt = 1 } = {}) => {
  const operationId = crypto.randomUUID();
  harness.ledger.createRun({ operationId, target: { channel: "beta" } });
  harness.ledger.updateRun(operationId, (record) => {
    record.startedAt = startedAt;
    record.backup = {
      noBackup: false,
      producer: "openclaw",
      attemptMs,
      durationMs: attemptMs + 60_000,
      stateBytes,
      file: "/x",
      verified: true,
    };
    return record;
  });
  return operationId;
};
// #79 (d): with no prior upstream run the diagnosis predicts the upstream
// from the DEFAULT rate over the sized tree, and a fixture-sized DB always
// predicts a fit — so a test that wants the FAILED copy to hand over to the
// LIVE ladder must rule the in-quiesce upstream out. A prior upstream run
// whose CLI took the whole quiesce budget for 1 byte predicts hours
// (`predicted_too_slow`). Needs a seeded DB (the ratio is over state bytes).
const ruleOutInQuiesceUpstream = (harness) =>
  seedPriorUpstreamRun(harness, { attemptMs: kOpenclawBackupQuiesceTimeoutMs, stateBytes: 1 });
// A prior OFFLINE-COPY run record — the copy series' only calibration input
// (offlineCopyBytes / offlineCopyMs); never read by the upstream series.
// `extra` lets a test plant junk upstream fields on it to prove that.
const seedPriorOfflineCopyRun = (
  harness,
  { offlineCopyMs = 1000, offlineCopyBytes = 1_000_000, startedAt = 1, extra = {} } = {},
) => {
  const operationId = crypto.randomUUID();
  harness.ledger.createRun({ operationId, target: { channel: "beta" } });
  harness.ledger.updateRun(operationId, (record) => {
    record.startedAt = startedAt;
    record.backup = {
      noBackup: false,
      producer: "alphaclaw-offline-copy",
      offlineCopyMs,
      offlineCopyBytes,
      durationMs: offlineCopyMs + 60_000,
      file: "/y",
      verified: true,
      ...extra,
    };
    return record;
  });
  return operationId;
};
// The in-quiesce upstream attempt needs BOTH a state DB (the copy set the
// walks measure) and a fitting prediction; together with failCopyArchive
// this is the shape that reaches the upstream loop paused. Since #79 (d) the
// default-rate prediction already fits for a fixture DB; the seeded prior
// pins the CALIBRATED path and keeps the fit independent of the constants.
const armInQuiesceUpstream = (harness, priorOverrides = {}) => {
  const dbFile = seedStateDb(harness);
  const priorId = seedPriorUpstreamRun(harness, priorOverrides);
  return { dbFile, priorId };
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
  // Real sleep AFTER the barrier begins, before the token is handed back —
  // lets a tuned-down barrier expire before the copy's exclusivity check.
  dbQuietDelayMs = 0,
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
      const token = await beginStateDbQuiet(opts);
      if (dbQuietDelayMs) await sleep(dbQuietDelayMs);
      return token;
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
// A fake /proc for the REAL process matcher: { pid: "NUL-joined cmdline" }.
const fakeProcScan = (table) => () =>
  listLiveOpenclawProcesses({
    fsModule: { readdirSync: (p) => (p === "/proc" ? [...Object.keys(table), "self"] : []) },
    readCmdline: (pid) => table[String(pid)] ?? null,
    isZombie: () => false,
    selfPid: 1,
  });

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
  // Declared schema constants written into every downloaded TARGET fixture
  // ({ state, agent }) — what the db-preflight judges agent DBs against.
  targetSchema = null,
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
      { version: versionSpec, schema: targetSchema },
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
    installDir,
    installToTempDir,
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

  describe("quiesce-first (gatewayQuiesce injected — every gate pauses, offline copy first)", () => {
    it("pauses the gateway, quiets the state DB, takes the offline copy FIRST, resumes, relaunches, releases — in that exact order, no upstream attempt", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: markOfflineCopy(quiesce),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(result.body.restarting).toBe(true);
      // D1a: the copy is the first rung — the upstream CLI never ran.
      expect(backupCalls).toHaveLength(0);
      // dbQuiet strictly after the confirmed stop, the copy with the barrier
      // HELD, dbResume strictly before the relaunch: the gateway's first
      // writes never land while readers are still told to stand down.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
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
      // offline copy AND the upstream attempts that may follow it, PLUS a
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
          attempts: 0,
          quiescedAttempts: 0,
          noBackup: false,
          producer: "alphaclaw-offline-copy",
          usableCheck: "manifest_ok",
          offlineCopy: expect.objectContaining({
            ok: true,
            reason: "primary",
            partial: false,
            // Codex 17: honest coverage rides the record.
            coverage: { core: "complete", workspace: "complete" },
            excludedBytes: 0,
          }),
        }),
      );
      // #79: the per-rung detail — ONE entry, the copy, chosen as the primary
      // rung, with what it wrote; and ONE backup_rung event for the decision.
      expect(backupRecord.attemptsDetail).toEqual([
        expect.objectContaining({
          rung: "offline_copy",
          reason: "primary",
          quiesced: true,
          ok: true,
          kind: null,
          startedAt: 1_000_000,
          elapsedMs: 0,
          bytes: fs.statSync(backupRecord.file).size,
        }),
      ]);
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [
          e.status,
          e.details.rung,
          e.details.reason,
          e.details.quiesced,
        ]),
      ).toEqual([["chosen", "offline_copy", "primary", true]]);
      // WI-1.9: exactly ONE initial "backup: running", detail naming the path.
      const runningSteps = harness.store
        .readState()
        .lastUpdateRun.steps.filter((s) => s.name === "backup" && s.status === "running");
      expect(runningSteps).toHaveLength(1);
      expect(runningSteps[0].detail).toBe(
        "pausing the gateway for a consistent backup (AlphaClaw offline copy first)",
      );
      // Never "after 0 upstream attempts".
      expect(lastStepDetail(harness, "backup", "completed").detail).toBe(
        "succeeded via AlphaClaw offline copy (gateway paused)",
      );
      // WI-1.0: the diagnosis rode into the record and the events tab.
      expect(backupRecord.diagnosis).toEqual(
        expect.objectContaining({ journalMode: "wal", fsType: "unknown", dbCount: 1 }),
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

    it("reserves the usable-check floor: the quiesce deadline bounds the copy, and no live attempt starts when the envelope cannot hold attempt + reserve (window_exhausted, frozen clock)", async () => {
      // 10 s envelope, 5 s reserve → the quiesce deadline is 5 s, and so is
      // the copy's budget (quiesceRemaining, never the phase clock alone).
      // The copy burns 6 s of frozen clock at its archive step → its budget
      // checkpoint fails (a non-refusal stage); 4 s remain — less than an
      // attempt plus the 5 s reserve — so the live ladder never starts and
      // the 409 is the honest window_exhausted, not a fabricated attempt.
      // Without the floor a live attempt would run, succeed, and then be
      // quarantined by a 1 ms usable check.
      const quiesce = makeQuiesceRecorder({});
      let harness;
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onArchiveTool: (opts) => {
          if (opts.command === "tar" && opts.args[0] === "-I") harness.nowRef.now += 6_000;
          return null;
        },
      });
      harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 10_000, usableCheckReserveMs: 5_000 },
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/backup window was exhausted/);
      // No CLI attempt ran (none would fit); the wording never says "after 0".
      expect(result.body.message).not.toMatch(/after 0/);
      expect(backupCalls).toHaveLength(0);
      const [started, failed] = eventsOfType(harness.insertEvent, "backup_offline_copy");
      expect(started.details.budgetMs).toBe(5_000);
      expect(failed.status).toBe("failed");
      expect(failed.details.stage).toBe("budget");
      // Nothing is left of the pause: even the empty tree's ~0 ms default
      // prediction cannot fit a 0 ms remainder (× 1.5 ≥ 0), so the post-copy
      // decision hands over honestly — and the live ladder finds no room.
      expect(readRunBackupRecord(harness).offlineCopy).toEqual(
        expect.objectContaining({
          ok: false,
          stage: "budget",
          next: { rung: "live", reason: "predicted_too_slow" },
        }),
      );
      expect(quiesce.start).toHaveBeenCalledTimes(1);
    });

    it("the usable check always gets at least the reserve, even when the succeeding attempt spent the envelope", async () => {
      const quiesce = makeQuiesceRecorder({});
      // The copy fails at its archive step and the in-quiesce upstream is
      // ruled out (a slow prior run) → live fallback; the live attempt then
      // spends what is left of the envelope.
      const { runnerImpl, archiveToolCalls } = makeBackupRunner({ onArchiveTool: failCopyArchive });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 10_000, usableCheckReserveMs: 5_000 },
      });
      seedStateDb(harness);
      ruleOutInQuiesceUpstream(harness);
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 9_999;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      // The only checks run were the live archive's (the failed copy never
      // reached its own verify).
      expect(archiveToolCalls.map((c) => c.command)).toEqual(["gzip", "tar"]);
      // 1 ms was left in the envelope; the check got the 5 s reserve instead.
      expect(archiveToolCalls[0].timeoutMs).toBe(5_000);
      expect(readRunBackupRecord(harness).usableCheck).toBe("manifest_ok");
    });

    it("does not stop or relaunch a gateway that was not running (wasRunning sampled under the lock)", async () => {
      const quiesce = makeQuiesceRecorder({ isRunning: false });
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      // Copy-first: the paused-state copy is the backup; no upstream attempt.
      expect(backupCalls).toHaveLength(0);
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ quiesced: true, producer: "alphaclaw-offline-copy" }),
      );
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

    it("a vanished file during the post-copy quiesced upstream attempt falls through to the ladder (exogenous writer)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kVanishedLockTail }, { ok: true }],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);

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
        expect.objectContaining({ quiesced: true, attempts: 2, quiescedAttempts: 1 }),
      );
      expect(backupRecord.vanishedPaths).toEqual([
        "/data/.openclaw/agents/main/sessions/56d1821e-9b48-4c93-a35a-4ada38240911.jsonl.lock",
      ]);
      // The rungs in order: copy (failed) → paused upstream (raced) → live.
      expect(backupRecord.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.ok, a.kind])).toEqual([
        ["offline_copy", "primary", true, false, "offline_copy_failed"],
        ["upstream", "predicted_fits", true, false, "vanished_file"],
        ["upstream", "live_fallback", false, true, null],
      ]);
    });

    it("reports the honest window-exhausted failure when the quiesced attempt burns the whole envelope", async () => {
      // The copy fails at its archive step; the predicted-to-fit upstream
      // attempt then consumes the entire phase envelope AND fails with a
      // vanished file — the ladder gets its turn but has no time for a single
      // live attempt. The 409 must say the window ran out, not fabricate a
      // live-attempt failure.
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kVanishedLockTail }],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 1000 },
      });
      armInQuiesceUpstream(harness);
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
      // The quiesced attempt's own deadline already kept the reserve back.
      expect(backupCalls[0].timeoutMs).toBe(900);
      // The gateway still came back before the failure surfaced.
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("a non-race failure during the post-copy quiesced attempt fails hard immediately — gateway restarted before the 409", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: "Error: ENOSPC no space left on device\n" }],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/disk space/i);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
      expect(readRunBackupRecord(harness).quiescedAttempts).toBe(1);
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
        onArchiveTool: composeHooks(markOfflineCopy(quiesce), failCopyArchive),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);

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
        "offline-copy(quiet)",
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
      expect(backupRecord.attemptsDetail.map((a) => a.reason)).toEqual([
        "primary",
        "predicted_fits",
        "workspace_retry",
      ]);
      expect(
        notifyMessages(harness.notify).some((m) =>
          /WITHOUT workspace files/.test(m),
        ),
      ).toBe(true);
    });

    it("a post-copy upstream timeout hands over to the live ladder with the full CLI ceiling — the copy already ran this pause, so kQuiescedOutcomePolicy.timeout never runs it twice (issue #79)", async () => {
      // Copy-first: the copy failed at its archive step, the upstream was
      // predicted to fit and timed out anyway. The policy's "offline_copy"
      // verdict names the rung that ALREADY ran; a second copy would meet the
      // same failure, so the pause ends and the live ladder gets the full
      // ceiling (adv-7: a 7-10-minute backup box is never locked out of every
      // hard gate by a terminal 409 with ~18 min of envelope left).
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, timedOut: true, tail: "" }, { ok: true }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: composeHooks(markOfflineCopy(quiesce), failCopyArchive),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      // ONE copy, ONE paused upstream attempt, then the relaunch (lock
      // released) BEFORE the live attempt, which waits for the settle first.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
        "backup-cli",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      expect(eventsOfType(harness.insertEvent, "backup_contention")).toHaveLength(0);
      // The copy ran exactly once.
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "failed",
      ]);
      // The live attempt gets the full CLI ceiling, not the quiesce budget.
      expect(backupCalls[1].timeoutMs).toBe(kOpenclawBackupTimeoutMs);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          quiesced: true,
          attempts: 2,
          quiescedAttempts: 1,
          noBackup: false,
          producer: "openclaw",
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            reason: "primary",
            next: { rung: "upstream", reason: "predicted_fits" },
          }),
        }),
      );
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.kind])).toEqual([
        ["offline_copy", "primary", true, "offline_copy_failed"],
        ["upstream", "predicted_fits", true, "timeout"],
        ["upstream", "live_fallback", false, null],
      ]);
      // WI-1.5: the retry detail names the ACTUAL prior kind, not a race.
      const steps = harness.store.readState().lastUpdateRun.steps;
      const retryDetail = steps.find(
        (s) => s.name === "backup" && /attempt 2/.test(s.detail || ""),
      );
      expect(retryDetail.detail).toMatch(/retrying after a timed-out attempt with the gateway paused/);
      expect(retryDetail.detail).not.toMatch(/live-file race/);
    });

    it("bounds the offline copy by min(offlineCopyBudgetMs, quiesceRemaining) — the deadline is sized quiesce + copy up front, never the phase clock alone", async () => {
      // Default envelope (25 min): the deadline (15 min, ≤ envelope − reserve)
      // is wider than the copy's own 8-min budget → the copy runs on its own
      // budget. A 2-min envelope: the deadline shrinks to 2 min − reserve, and
      // so does the copy — the phase clock alone would have granted 8 min to
      // a copy whose lease and barrier could not outlive it.
      const copyBudgetOf = (harness) =>
        eventsOfType(harness.insertEvent, "backup_offline_copy")[0].details.budgetMs;
      const wide = createHarness({
        runnerImpl: makeOfflineCopyRunner({}).runnerImpl,
        gatewayQuiesce: makeQuiesceRecorder({}),
      });
      seedStateDb(wide);
      expect((await wide.sync.applyUpdate(kHardGateTarget)).status).toBe(202);
      expect(copyBudgetOf(wide)).toBe(kOpenclawBackupOfflineCopyBudgetMs);

      const narrow = createHarness({
        runnerImpl: makeOfflineCopyRunner({}).runnerImpl,
        gatewayQuiesce: makeQuiesceRecorder({}),
        backupTuning: { phaseEnvelopeMs: 2 * 60_000, usableCheckReserveMs: 5_000 },
      });
      seedStateDb(narrow);
      expect((await narrow.sync.applyUpdate(kHardGateTarget)).status).toBe(202);
      expect(copyBudgetOf(narrow)).toBe(2 * 60_000 - 5_000);
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
          { ok: true },
        ],
      });
      // No gatewayQuiesce (the bin/boot instance shape): retries only. The
      // ladder holds kOpenclawBackupLiveAttempts = 2 attempts (#79 (f): the
      // honest envelope, pinned in constants-cadence.test.js), so a race gets
      // exactly one retry.
      expect(kOpenclawBackupLiveAttempts).toBe(2);
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
      expect(backupCalls).toHaveLength(2);
      const outputs = backupCalls.map((c) => path.basename(c.out));
      // Every attempt's name must stay inside the retention pattern — a
      // bespoke suffix would escape keep-N pruning (issue #9's disk refill).
      for (const name of outputs) {
        expect(name).toMatch(/^openclaw-backup-.*\.tar\.gz$/);
      }
      expect(new Set(outputs).size).toBe(2);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({ quiesced: false, attempts: 2 }),
      );
      expect(backupRecord.vanishedPaths).toHaveLength(1);
    });

    it("exhausts the ladder on persistent races and reports the honest attempt count with the full path", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
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
      // Two attempts: the cap is the honest envelope's (#79 (f)), and the
      // message counts what actually ran.
      expect(result.body.message).toMatch(/after 2 attempts/);
      expect(result.body.hint).toMatch(/live-state race/i);
      expect(backupCalls).toHaveLength(2);
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

    it("soft gate without a quiesce seam (the bin/boot instance): retries races live, then warns and continues", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
      });
      const harness = createHarness({ runnerImpl });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      expect(
        notifyMessages(harness.notify).some(
          (m) => /backup failed/i.test(m) && /live-file race/i.test(m),
        ),
      ).toBe(true);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ noBackup: true, quiesced: false, attempts: 2 }),
      );
      expect(readRunBackupRecord(harness).attemptsDetail.map((a) => a.reason)).toEqual([
        "live_ladder",
        "live_retry",
      ]);
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

  // ── Issue #79 (c), decision D1a: soft gates quiesce too ──────────────────
  describe("soft gates quiesce copy-first (D1a); hardGate decides only fatality", () => {
    it("soft gate: pauses the gateway and takes the offline copy FIRST, exactly like a hard gate — no upstream attempt, no 409 path involved", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: markOfflineCopy(quiesce),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
        "dbResume",
        "start",
        "unsuppress",
        "release",
      ]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          quiesced: true,
          attempts: 0,
          noBackup: false,
          verified: true,
          producer: "alphaclaw-offline-copy",
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
        }),
      );
      expect(record.attemptsDetail).toEqual([
        expect.objectContaining({ rung: "offline_copy", reason: "primary", ok: true }),
      ]);
      // A soft gate's success is silent — no "backup failed" health notice.
      expect(notifyMessages(harness.notify).some((m) => /backup failed|backup skipped/i.test(m))).toBe(false);
    });

    it("soft gate: a failed copy and a live ladder that races out still soften to noBackup — warning step + health notification, the apply continues", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      ruleOutInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      // The copy failed (the upstream ruled out of the pause → live), both
      // live attempts raced.
      expect(backupCalls).toHaveLength(2);
      expect(quiesce.stop).toHaveBeenCalledTimes(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(
        notifyMessages(harness.notify).some(
          (m) => /backup failed/i.test(m) && /live-file race/i.test(m),
        ),
      ).toBe(true);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: true,
          quiesced: true,
          attempts: 2,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            next: { rung: "live", reason: "predicted_too_slow" },
          }),
        }),
      );
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.ok])).toEqual([
        ["offline_copy", "primary", false],
        ["upstream", "live_fallback", false],
        ["upstream", "live_retry", false],
      ]);
      expect(lastStepDetail(harness, "backup", "warning")).toBeTruthy();
    });

    it("soft gate + busy lifecycle lock: a `backup: warning` step and the live ladder — never the 409 a hard gate gets", async () => {
      const quiesce = makeQuiesceRecorder({ acquireDelayMs: 120 });
      const { runnerImpl, backupCalls } = makeBackupRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { quiesceLockTimeoutMs: 15 },
      });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      // Only the RUNG degraded: the live attempt ran and succeeded.
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(lastStepDetail(harness, "backup", "warning").detail).toMatch(
        /could not pause the gateway \(another gateway operation is in progress\) — live backup attempts instead/,
      );
      expect(lastStepDetail(harness, "backup", "failed")).toBeUndefined();
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          quiesced: false,
          attempts: 1,
          quiescedAttempts: 0,
          producer: "openclaw",
          offlineCopy: null,
        }),
      );
      expect(record.attemptsDetail).toEqual([
        expect.objectContaining({ rung: "upstream", reason: "live_fallback", quiesced: false, ok: true }),
      ]);
      // The late acquire still self-releases (never a stranded 10-min lease).
      await sleep(200);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });

    it("soft gate + quiet barrier already held elsewhere: relaunch, `backup: warning`, live ladder — never a 409", async () => {
      const quiesce = makeQuiesceRecorder({ dbQuietThrows: true });
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      // The stopped gateway is relaunched and the lock released BEFORE the
      // live attempt, which waits for the settle (one isRunning poll) first;
      // no dbResume for a barrier we never got.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      expect(lastStepDetail(harness, "backup", "warning").detail).toMatch(
        /could not pause state-database access \(already quiet \(held by other-backup\)\) — live backup attempts instead/,
      );
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ noBackup: false, quiesced: false, attempts: 1, producer: "openclaw" }),
      );
    });

    it("soft gate + refused copy (foreign holder): the refusal HANDS OVER to the live ladder — the live upstream needs no exclusivity, so a stray openclaw argv costs the copy, never the backup", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli(live)"),
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

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      // ONE live upstream attempt, strictly after the unwind (barrier
      // released, gateway relaunched, lock released) and the settle poll.
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli(live)",
      ]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          verified: true,
          producer: "openclaw",
          quiesced: true,
          attempts: 1,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "exclusivity",
            reason: "primary",
            next: { rung: "live", reason: "offline_copy_refused" },
          }),
        }),
      );
      // The refusal names pid AND argv on the record, so an operator can tell
      // a foreign holder from AlphaClaw's own CLI shell-out.
      expect(record.offlineCopy.error).toMatch(/1 live openclaw process\(es\): 4242 \(openclaw gateway run\)/);
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.ok, a.kind])).toEqual([
        ["offline_copy", "primary", true, false, "offline_copy_refused"],
        ["upstream", "live_fallback", false, true, null],
      ]);
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [e.status, e.details.rung, e.details.reason]),
      ).toEqual([
        ["chosen", "offline_copy", "primary"],
        ["handed_over", "upstream", "offline_copy_refused"],
        ["chosen", "upstream", "live_fallback"],
      ]);
      // The first live row names what it follows.
      expect(lastStepDetail(harness, "backup", "running").detail).toBe(
        "live upstream attempt after a refused offline copy (the paused state dir was not exclusively ours)",
      );
      // The ladder succeeded: no warning row, no "backup failed" notification.
      expect(lastStepDetail(harness, "backup", "warning")).toBeUndefined();
      expect(notifyMessages(harness.notify).some((m) => /Pre-update backup failed/.test(m))).toBe(false);
      // Only the upstream archive is on disk — the refused copy wrote nothing.
      expect(record.file).not.toMatch(/\.alphaclaw\.tar\.gz$/);
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([
        path.basename(record.file),
      ]);
    });

    it("soft gate + refused copy + failed live ladder: finalized AFTER the unwind as ONE noBackup warning that names the live failure AND the refusal — never a 409", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, tail: "boom\n" }],
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
      // The warning is the finalization; it must not exist yet when the
      // relaunch runs (the reuse-gate precedent: nothing finalizes paused).
      quiesce.start.mockImplementation(async () => {
        quiesce.calls.push("start");
        const warned = harness.store
          .readState()
          .lastUpdateRun.steps.some((s) => s.name === "backup" && s.status === "warning");
        quiesce.calls.push(warned ? "warning:before-relaunch" : "warning:pending");
      });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      // generic has no live retry: exactly one live attempt after the unwind.
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "dbResume",
        "start",
        "warning:pending",
        "unsuppress",
        "release",
        "isRunning",
      ]);
      expect(lastStepDetail(harness, "backup", "warning").error).toBe("boom");
      expect(
        notifyMessages(harness.notify).some(
          (m) =>
            /Pre-update backup failed — continuing/.test(m) &&
            /The pre-update backup failed — boom \(after 1 attempt\)\. The AlphaClaw offline copy of the paused state was refused first because/.test(m) &&
            /4242 \(openclaw gateway run\) — argv names an OpenClaw executable or entry script\./.test(m),
        ),
      ).toBe(true);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          noBackup: true,
          quiesced: true,
          attempts: 1,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "exclusivity",
            reason: "primary",
            next: { rung: "live", reason: "offline_copy_refused" },
          }),
        }),
      );
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([]);
    });

    it("hard gate + busy lifecycle lock is unchanged: honest 409, no live attempt (the rung never degrades under a hard gate)", async () => {
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
      expect(backupCalls).toHaveLength(0);
      expect(lastStepDetail(harness, "backup", "failed").error).toBe("gateway busy");
      await sleep(200);
      expect(quiesce.releaseSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── #79 (a): the gate predicate is the SHARED crossesChannelBoundary ──────
  describe("gate predicate: shared crossesChannelBoundary over the PERSISTED applied channel (#79 (a), Codex 19)", () => {
    const kContention = [
      { ok: false, tail: kLeaseLostTail },
      { ok: false, tail: kLeaseLostTail },
    ];
    // A box running a beta build: the persisted applied record says so and
    // the installed tree is that prerelease. `channel` — alphaclaw.json's
    // releaseChannel SELECTION (the harness's readReleaseChannel) — is what
    // each test varies to prove the gate never reads it.
    const createBetaBox = (options = {}) => {
      const harness = createHarness({
        installedVersion: "1.0.0-beta.1",
        sentinelVersion: "1.0.0-beta.1",
        ...options,
      });
      harness.store.updateState((s) => {
        s.applied = { channel: "beta", version: "1.0.0-beta.1", at: 1, acceptedAt: 1 };
        return s;
      });
      return harness;
    };

    it("beta→stable is hard-gated by the PERSISTED applied channel while the releaseChannel selection already says stable: a failed backup is an honest 409 backup_failed, never a soft warning", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({ script: kContention });
      const harness = createBetaBox({ runnerImpl, channel: "stable" });

      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      // The classified cause leads; the gate sentence names the gate tripped.
      expect(result.body.hint).toContain("Cross-channel updates are blocked without a backup");
      expect(result.body.hint).toContain("choose a same-channel version");
      expect(backupCalls).toHaveLength(2);
      expect(readRunBackupRecord(harness)).toEqual(expect.objectContaining({ noBackup: true }));
      // Nothing recorded, nothing restarted.
      expect(harness.store.readState().applied).toEqual(
        expect.objectContaining({ channel: "beta", version: "1.0.0-beta.1" }),
      );
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(lastStepDetail(harness, "backup", "warning")).toBeUndefined();
    });

    it("the selection alone never gates: a stable-pin box whose releaseChannel selection was flipped to beta still applies a stable version soft-gated", async () => {
      const { runnerImpl } = makeBackupRunner({ script: kContention });
      const harness = createHarness({ runnerImpl, channel: "beta" });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(readRunBackupRecord(harness)).toEqual(expect.objectContaining({ noBackup: true }));
      expect(lastStepDetail(harness, "backup", "warning")).toBeTruthy();
    });

    it("prerelease→base on the SAME channel (beta 1.0.0-beta.1 → beta 1.1.0) crosses the boundary — the 'either direction' rule hard-gates what used to be soft", async () => {
      const { runnerImpl } = makeBackupRunner({ script: kContention });
      const harness = createBetaBox({ runnerImpl, channel: "beta" });

      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.hint).toContain("Cross-channel updates are blocked without a backup");
      expect(harness.restartProcess).not.toHaveBeenCalled();
    });

    it("prerelease→prerelease on the beta channel is no boundary: the prerelease-target gate speaks, and its hint says 'stable version', never 'same-channel version'", async () => {
      const { runnerImpl } = makeBackupRunner({ script: kContention });
      const harness = createBetaBox({ runnerImpl, channel: "beta" });

      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0-beta.1" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.hint).toContain("Prerelease updates are blocked without a backup");
      expect(result.body.hint).toContain("choose a stable version");
      expect(result.body.hint).not.toContain("same-channel");
    });
  });

  // ── #79 (b): post-preflight checkpoint + confirmNoBackup ─────────────────
  describe("post-preflight backup checkpoint + confirmNoBackup (#79 (b), Eng 2D, Codex 20)", () => {
    const kMigrationVerdict = { status: "migration-required", foundVersion: 12, targetVersion: 15 };
    const kExactVerdict = { status: "exact", foundVersion: 15, targetVersion: 15 };
    // The live ladder races out twice: a SOFT gate softens that to noBackup.
    const kRacedOut = [
      { ok: false, tail: kVanishedLockTail },
      { ok: false, tail: kVanishedLockTail },
    ];
    // A box at {state 12, agent N} updating to a target that declares
    // {state 15, agent 19}; the state verb answers `verdict`.
    // `agentUserVersion: null` seeds no agent DB (the stub upstream manifest
    // covers the state DB only — a box with an agent DB fails the usable check
    // on the stubbed archive, which is the soft gate's noBackup, not a success).
    const createMigratingBox = ({
      verdict = kMigrationVerdict,
      script = kRacedOut,
      agentUserVersion = 17,
      extraSyncOptions = {},
    } = {}) => {
      const scripted = makeBackupRunner({ script });
      const harness = createHarness({
        runnerImpl: withPreflightVerdict(scripted.runnerImpl, verdict),
        targetSchema: { state: 15, agent: 19 },
        extraSyncOptions,
      });
      seedStateDb(harness, { userVersion: 12 });
      if (agentUserVersion !== null) {
        seedAgentDb(harness, "main", { userVersion: agentUserVersion });
      }
      return { harness, backupCalls: scripted.backupCalls };
    };
    const kConsentSession = "human-test-session";
    const approveFailedApply = async (harness, target = kSoftGateTarget) => {
      const failed = await harness.sync.applyUpdate({ ...target, consentSessionId: kConsentSession });
      expect(failed.status).toBe(409);
      expect(failed.body.backupRiskEligible).toBe(true);
      const issued = await harness.sync.requestBackupRiskConsent({ operationId: failed.body.operationId, consentSessionId: kConsentSession });
      expect(issued.status).toBe(200);
      harness.nowRef.now += 1;
      return { ...target, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession };
    };

    it("migrationRequired + noBackup without consent: 409 backup_required_for_migration BEFORE the record step — the message names both schema lines and the running version, the hint names confirmNoBackup, the run record says why", async () => {
      const { harness, backupCalls } = createMigratingBox();

      const result = await harness.sync.applyUpdate(kSoftGateTarget);

      // The soft gate let the raced-out ladder through as noBackup…
      expect(backupCalls).toHaveLength(2);
      // …and the checkpoint after the db-preflight stopped the apply.
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_required_for_migration");
      expect(result.body.message).toBe(
        "OpenClaw 1.1.0 will migrate your database (state 12→15, agent 17→19) and no backup exists — the running 1.0.0 cannot read the migrated database, so there would be no rollback path.",
      );
      expect(result.body.hint).toContain("review this failed update's backup risk");
      expect(result.body.migration).toEqual({
        state: { from: 12, to: 15 },
        agent: { from: 17, to: 19 },
        installedVersion: "1.0.0",
      });
      // Nothing recorded, nothing restarted: the checkpoint sits before `record`.
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      const record = readNewestRunRecord(harness);
      expect(record.state).toBe("failed");
      expect(record.result.code).toBe("backup_required_for_migration");
      expect(record.backup).toEqual(expect.objectContaining({ noBackup: true }));
      expect(record.backup.noBackupConfirmed).toBeUndefined();
      expect(record.dbPreflight).toEqual(expect.objectContaining({ migrationRequired: true }));
      expect(lastStepDetail(harness, "backup", "failed").error).toBe("backup_required_for_migration");
      // The failure notification carries the consent path.
      expect(
        notifyMessages(harness.notify).some(
          (m) => /update to 1\.1\.0 failed/.test(m) && /review this failed update's backup risk/.test(m),
        ),
      ).toBe(true);
    });

    it("with confirmNoBackup: true the same apply continues: noBackupConfirmed: true on the record, a backup warning row, the consent announced (health notification + event) and named in the acceptance outcome", async () => {
      const { harness, backupCalls } = createMigratingBox();

      const approved = await approveFailedApply(harness);
      const result = await harness.sync.applyUpdate(approved);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      const record = readNewestRunRecord(harness);
      expect(record.backup).toEqual(expect.objectContaining({ noBackup: true, noBackupConfirmed: true }));
      expect(record.dbPreflight.migrationRequired).toBe(true);
      expect(lastStepDetail(harness, "backup", "warning").detail).toBe(
        "continuing without a backup by operator consent (confirmNoBackup) — the state 12→15, agent 17→19 migration has no rollback path to 1.0.0",
      );
      expect(
        notifyMessages(harness.notify).some(
          (m) =>
            /continues WITHOUT a backup by operator consent \(confirmNoBackup\)/.test(m) &&
            /state 12→15, agent 17→19/.test(m) &&
            /the running 1\.0\.0 cannot read the migrated database/.test(m),
        ),
      ).toBe(true);
      const events = eventsOfType(harness.insertEvent, "backup_no_backup_consented");
      expect(events).toHaveLength(1);
      expect(events[0].details).toEqual(
        expect.objectContaining({
          state: { from: 12, to: 15 },
          agent: { from: 17, to: 19 },
          installedVersion: "1.0.0",
          version: "1.1.0",
          channel: "stable",
        }),
      );
      // The apply OUTCOME (acceptance) names it too — the run record is the memory.
      expect(harness.store.readState().applied).toEqual(expect.objectContaining({ version: "1.1.0" }));
      harness.sync.markGoodNow({ source: "acceptance" });
      await flushAsync();
      const accepted = notifyMessages(harness.notify).find((m) => /is healthy — activation verified/.test(m));
      expect(accepted).toContain(
        "It was applied WITHOUT a backup by operator consent (confirmNoBackup) — the database was migrated and there is no rollback path to the previous build.",
      );
    });

    it('a bare consent flag never dispatches backup commands; ordinary applies keep their prior record shape', async () => {
      const exact = createMigratingBox({ verdict: kExactVerdict, agentUserVersion: 19 });
      const a = await exact.harness.sync.applyUpdate({ ...kSoftGateTarget, confirmNoBackup: true });
      expect(a.status).toBe(409);
      expect(a.body.code).toBe("backup_consent_required");
      expect(exact.backupCalls).toHaveLength(0);
      expect(exact.harness.installToTempDir).not.toHaveBeenCalled();
      expect(eventsOfType(exact.harness.insertEvent, "backup_no_backup_consented")).toHaveLength(0);
      const fresh = createMigratingBox({ script: [], agentUserVersion: null });
      const b = await fresh.harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();
      expect(b.status).toBe(202);
      expect(readRunBackupRecord(fresh.harness)).toEqual(
        expect.objectContaining({ noBackup: false, verified: true }),
      );
      expect(readRunBackupRecord(fresh.harness).noBackupConfirmed).toBeUndefined();
      const plain = createMigratingBox({ verdict: kExactVerdict, agentUserVersion: 19 });
      await plain.harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();
      expect(readRunBackupRecord(plain.harness).noBackupConfirmed).toBeUndefined();
    });

    it.each(["backed-up write", "schema change", "consented write"])("rechecks queued %s with the appropriate admission facts", async (scenario) => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness, writer, lease;
      const policy = createGatewayMutationPolicy({ lock,
        getChannelInfo: () => harness.sync.getChannelInfo(),
        isApplyInProgress: () => harness.sync.isApplyInProgress() });
      const acquire = async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        writer.exec(scenario === "schema change"
          ? "PRAGMA user_version = 16" : "INSERT INTO admission_writes VALUES (1)");
        predecessor();
        lease = await queued;
        return lease;
      };
      ({ harness } = createMigratingBox({
        script: scenario === "consented write" ? kRacedOut : [], agentUserVersion: null,
        extraSyncOptions: { acquireLifecycleLock: acquire, gatewayMutationPolicy: policy },
      }));
      writer = new DatabaseSync(path.join(harness.openclawDir, "state/openclaw.sqlite"));
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE admission_writes (id INTEGER)");
      try {
        const target = scenario === "consented write" ? await approveFailedApply(harness) : kSoftGateTarget;
        const result = await harness.sync.applyUpdate(target);
        if (scenario === "backed-up write") {
          expect(result.status).toBe(202);
          expect(readRunBackupRecord(harness)).toMatchObject({ verified: true, noBackup: false });
          expect(harness.store.readState().applied.version).toBe("1.1.0");
        } else {
          expect(result).toMatchObject({ status: 409, body: { code: scenario === "schema change" ? "db_preflight_failed" : "apply_facts_changed" } });
          expect(harness.store.readState().applied).toBeNull();
          expect(harness.restartProcess).not.toHaveBeenCalled();
        }
      } finally { lease?.(); writer.close(); }
    });

    it.each(["version_mismatch", "config_migration_failed"])("a verified backed-up apply can recover the existing %s hold through its owned commit and restart", async (reason) => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness;
      const policy = createGatewayMutationPolicy({ lock,
        getChannelInfo: () => harness.sync.getChannelInfo(),
        isApplyInProgress: () => harness.sync.isApplyInProgress() });
      ({ harness } = createMigratingBox({ script: [], agentUserVersion: null,
        extraSyncOptions: { acquireLifecycleLock: lock.acquire, gatewayMutationPolicy: policy } }));
      harness.store.updateState((state) => {
        state.gatewayHold = { reason, at: harness.nowRef.now, installed: "1.0.0", expected: "1.0.0" };
        return state;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = await harness.sync.applyUpdate(kSoftGateTarget);
        expect(result.status).toBe(202);
        expect(readRunBackupRecord(harness)).toMatchObject({ noBackup: false, verified: true });
        expect(readRunBackupRecord(harness).noBackupConfirmed).toBeUndefined();
        expect(harness.store.readState().applied.version).toBe("1.1.0");
        // Only boot may clear the original hold after activating/reconciling.
        expect(harness.store.readState().gatewayHold.reason).toBe(reason);
        expect(lock.getActiveOperation().kind).toBe("apply_commit");
        await vi.advanceTimersByTimeAsync(1500);
        expect(harness.restartProcess).toHaveBeenCalledTimes(1);
        expect(lock.getActiveOperation()).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("a backed-up recovery refuses a replacement hold established while waiting for ownership", async () => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness;
      const policy = createGatewayMutationPolicy({ lock,
        getChannelInfo: () => harness.sync.getChannelInfo(),
        isApplyInProgress: () => harness.sync.isApplyInProgress() });
      const acquire = async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        harness.store.updateState((state) => { state.gatewayHold.at += 1; return state; });
        predecessor();
        return queued;
      };
      ({ harness } = createMigratingBox({ script: [], agentUserVersion: null,
        extraSyncOptions: { acquireLifecycleLock: acquire, gatewayMutationPolicy: policy } }));
      harness.store.updateState((state) => {
        state.gatewayHold = { reason: "version_mismatch", at: harness.nowRef.now };
        return state;
      });
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result).toMatchObject({ status: 409, body: { code: "gateway_held" } });
      expect(readRunBackupRecord(harness).verified).toBe(true);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(lock.getActiveOperation()).toBeNull();
    });

    it("a soft backup failure grants no authority to cross an existing hold", async () => {
      const { harness } = createMigratingBox({ verdict: kExactVerdict, agentUserVersion: null });
      harness.store.updateState((state) => {
        state.gatewayHold = { reason: "version_mismatch", at: harness.nowRef.now };
        return state;
      });
      const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
      expect(result).toMatchObject({ status: 409, body: { code: "gateway_held" } });
      expect(result.body.backupRiskEligible).toBeUndefined();
      expect(readRunBackupRecord(harness).noBackup).toBe(true);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
    });

    it("a verified human approval can waive a hard-gate availability failure without repeating the ladder or preparation", async () => {
      const scripted = makeBackupRunner({ script: kRacedOut });
      const harness = createHarness({
        runnerImpl: withPreflightVerdict(scripted.runnerImpl, kMigrationVerdict),
        targetSchema: { state: 15, agent: 19 },
      });
      seedStateDb(harness, { userVersion: 12 });

      const approved = await approveFailedApply(harness, kHardGateTarget);
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(202);
      expect(scripted.backupCalls).toHaveLength(2);
      expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
      expect(readRunBackupRecord(harness).noBackupConfirmed).toBe(true);
      expect(eventsOfType(harness.insertEvent, "backup_no_backup_consented")).toHaveLength(1);
    });

    it("binds issuance to the failed operation and human session, propagates the offer, and never persists the bearer", async () => {
      const fail = vi.fn();
      const { harness, backupCalls } = createMigratingBox({ extraSyncOptions: { operationEvents: { fail } } });
      const failed = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
      const { operationId } = failed.body;
      expect(failed.body.backupRiskEligible).toBe(true);
      expect(readNewestRunRecord(harness).result).toMatchObject({ backupRiskEligible: true, operationId });
      expect(harness.sync.getChannelInfo().lastUpdateRun.result).toMatchObject({ backupRiskEligible: true, operationId });
      expect(fail).toHaveBeenCalledWith(operationId, expect.objectContaining({ backupRiskEligible: true, operationId }));
      expect((await harness.sync.requestBackupRiskConsent({ operationId, consentSessionId: "different-human" })).status).toBe(409);
      expect((await harness.sync.requestBackupRiskConsent({ operationId: crypto.randomUUID(), consentSessionId: kConsentSession })).status).toBe(409);
      const issued = await harness.sync.requestBackupRiskConsent({ operationId, consentSessionId: kConsentSession });
      expect(issued.body.target).toEqual(kSoftGateTarget);
      const request = { ...kSoftGateTarget, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession };
      expect((await harness.sync.applyUpdate({ ...request, consentSessionId: "different-human" })).body.code).toBe("backup_consent_required");
      harness.nowRef.now += 1;
      expect((await harness.sync.applyUpdate(request)).status).toBe(202);
      expect((await harness.sync.applyUpdate(request)).body.code).toBe("backup_consent_required");
      expect(backupCalls).toHaveLength(2);
      const persisted = JSON.stringify([harness.store.readState(), harness.ledger.listRuns(), harness.insertEvent.mock.calls, fail.mock.calls, notifyMessages(harness.notify)]);
      expect(persisted).not.toContain(issued.body.confirmNoBackupToken);
      expect(persisted).not.toContain(kConsentSession);
    });

    it.each(["source", "target", "schema", "database", "wal"])("invalidates approved facts after a %s change without rerunning backup or install", async (changed) => {
      const { harness, backupCalls } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      let writer;
      if (changed === "source") {
        fs.appendFileSync(path.join(harness.installDir, "node_modules/openclaw/bin/entry.js"), "// changed\n");
      } else if (changed === "target") {
        fs.appendFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "bin/entry.js"), "// changed\n");
      } else if (changed === "schema") {
        fs.writeFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "dist/openclaw-agent-db-contract-test.js"), "const OPENCLAW_AGENT_SCHEMA_VERSION = 20;\n");
      } else {
        writer = new DatabaseSync(path.join(harness.openclawDir, "state/openclaw.sqlite"));
        if (changed === "database") writer.exec("PRAGMA journal_mode=DELETE");
        writer.exec("CREATE TABLE consent_change (id INTEGER); INSERT INTO consent_change VALUES (1)");
        if (changed === "database") { writer.close(); writer = null; }
      }
      try {
        const result = await harness.sync.applyUpdate(approved);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_consent_required");
        expect(result.body.backupRiskEligible).toBeUndefined();
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupCalls).toHaveLength(2);
        expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
      } finally { writer?.close(); }
    });

    it.each(["expired", "changed", "lost lease", "gateway hold", "config", "torn config"])("rechecks %s after waiting for the actual lifecycle lock", async (race) => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness;
      const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => harness.sync.getChannelInfo(), isApplyInProgress: () => harness.sync.isApplyInProgress() });
      const acquire = vi.fn(async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        expect(lock.getActiveOperation().kind).toBe("restart");
        if (race === "expired") harness.nowRef.now += kConsentTtlMs;
        if (race === "changed") fs.appendFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "bin/entry.js"), "// queued change\n");
        if (race === "gateway hold") harness.store.updateState((state) => { state.gatewayHold = { reason: "config_migration_failed", version: "1.0.0", at: harness.nowRef.now }; return state; });
        if (race === "config" || race === "torn config") fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), race === "config" ? '{"gateway":{"mode":"local"}}' : '{"gateway":');
        predecessor();
        const hold = await queued;
        if (race === "lost lease") hold();
        return hold;
      });
      ({ harness } = createMigratingBox({ extraSyncOptions: { acquireLifecycleLock: acquire, gatewayMutationPolicy: policy } }));
      const approved = await approveFailedApply(harness);
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe({ expired: "backup_consent_required", changed: "apply_facts_changed", "lost lease": "lease_expired", "gateway hold": "gateway_held", config: "apply_facts_changed", "torn config": "config_unreadable" }[race]);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(lock.getActiveOperation()).toBeNull();
    });

    it.each(["openclaw.json", "alphaclaw.json"])("binds %s content and identity between the offer, issuance, and consume", async (file) => {
      for (const phase of ["issuance", "consume", "replacement"]) {
        const { harness, backupCalls } = createMigratingBox();
        const configPath = path.join(harness.openclawDir, file);
        fs.writeFileSync(configPath, '{"privateConsentFixture":"first"}');
        const failed = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
        expect(failed.body.backupRiskEligible).toBe(true);
        const approvalRequest = { operationId: failed.body.operationId, consentSessionId: kConsentSession };
        const issued = phase !== "issuance" ? await harness.sync.requestBackupRiskConsent(approvalRequest) : null;
        if (issued) expect(issued.status).toBe(200);
        if (phase === "replacement") {
          fs.writeFileSync(`${configPath}.replacement`, '{"privateConsentFixture":"first"}');
          fs.renameSync(`${configPath}.replacement`, configPath);
        } else fs.writeFileSync(configPath, '{"privateConsentFixture":"other"}');
        const result = phase === "issuance"
          ? await harness.sync.requestBackupRiskConsent(approvalRequest)
          : await harness.sync.applyUpdate({ ...kSoftGateTarget, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe(phase === "issuance" ? "backup_consent_stale" : "backup_consent_required");
        expect(result.body.backupRiskEligible).toBeUndefined();
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupCalls).toHaveLength(2);
        expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(harness.ledger.listRuns())).not.toContain("privateConsentFixture");
      }
    });

    it.each(["openclaw.json", "alphaclaw.json"])("refuses torn %s with the shared config-unreadable envelope at every approval boundary", async (file) => {
      for (const phase of ["offer", "issuance", "consume"]) {
        const { harness } = createMigratingBox();
        const configPath = path.join(harness.openclawDir, file);
        let failed;
        let issued;
        if (phase !== "offer") {
          failed = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
          expect(failed.body.backupRiskEligible).toBe(true);
          if (phase === "consume") issued = await harness.sync.requestBackupRiskConsent({ operationId: failed.body.operationId, consentSessionId: kConsentSession });
        }
        fs.writeFileSync(configPath, '{"privateConsentFixture":"do-not-log",');
        const result = phase === "offer"
          ? await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession })
          : phase === "issuance"
            ? await harness.sync.requestBackupRiskConsent({ operationId: failed.body.operationId, consentSessionId: kConsentSession })
            : await harness.sync.applyUpdate({ ...kSoftGateTarget, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession });
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({ code: "config_unreadable", file, sourceCode: file === "openclaw.json" ? "OPENCLAW_CONFIG_UNREADABLE" : "ALPHACLAW_CONFIG_UNREADABLE" });
        expect(result.body.message).toContain("Backup-risk confirmation is refused");
        expect(result.body.backupRiskEligible).toBeUndefined();
        expect(JSON.stringify([result, harness.ledger.listRuns(), harness.insertEvent.mock.calls])).not.toContain("do-not-log");
        expect(fs.readFileSync(configPath, "utf8")).toBe('{"privateConsentFixture":"do-not-log",');
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
      }
    });

    it.each(['{ gateway: { mode: "local" } }', '{"$include":"outside-snapshot.json"}'])("refuses an unverifiable upstream config for a waiver while preserving ordinary apply behavior: %s", async (raw) => {
      const { harness } = createMigratingBox();
      fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), raw);
      const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
      expect(result.body).toMatchObject({ code: "config_unreadable", sourceCode: "OPENCLAW_CONFIG_UNREADABLE" });
      const ordinary = createMigratingBox({ verdict: kExactVerdict, agentUserVersion: 19 });
      fs.writeFileSync(path.join(ordinary.harness.openclawDir, "openclaw.json"), raw);
      expect((await ordinary.harness.sync.applyUpdate(kSoftGateTarget)).status).toBe(202);
    });

    it("refuses an approval when the agent database is unreadable", async () => {
      const { harness } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      fs.writeFileSync(path.join(harness.openclawDir, "agents/main/agent/openclaw-agent.sqlite"), "corrupt");
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(409);
      expect(["state_db_unreadable", "state_db_unverified"]).toContain(result.body.code);
      expect(harness.store.readState().applied).toBeNull();
    });

    it("cannot waive an unreadable self-update ownership probe", async () => {
      const probe = vi.fn(() => false);
      const { harness } = createMigratingBox({ extraSyncOptions: { isSelfUpdateInProgress: probe } });
      const approved = await approveFailedApply(harness);
      probe.mockImplementation(() => { throw new Error("probe unavailable"); });
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("self_update_unverified");
      expect(harness.store.readState().applied).toBeNull();
    });

    it("does not create or rebuild a dev checkout after an availability failure", async () => {
      const { harness, backupCalls } = createMigratingBox();
      const result = await harness.sync.applyUpdate({ channel: "dev", sha: "a".repeat(40), consentSessionId: kConsentSession });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.backupRiskEligible).toBeUndefined();
      expect(backupCalls).toHaveLength(2);
      expect(fs.existsSync(path.join(harness.rootDir, "openclaw"))).toBe(false);
      expect(harness.runner.runStreamed.mock.calls.some(([call]) => call.args?.some((arg) => ["fetch", "checkout", "build", "install"].includes(arg)))).toBe(false);
      expect(harness.installToTempDir).not.toHaveBeenCalled();
    });

    it("never records an activation when the durable consent audit write fails", async () => {
      const { harness } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      const update = harness.ledger.updateRun;
      vi.spyOn(harness.ledger, "updateRun").mockImplementation((id, mutate) => update(id, (record) => {
        const result = mutate(record);
        if (result.backup?.noBackupConfirmed === true) throw new Error("audit write refused");
        return result;
      }));
      expect((await harness.sync.applyUpdate(approved)).status).toBeGreaterThanOrEqual(400);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect((await harness.sync.applyUpdate(approved)).body.code).toBe("backup_consent_required");
    });

    it("records an honest availability warning for a same-schema hard-gate waiver", async () => {
      const { harness } = createMigratingBox({ verdict: kExactVerdict, agentUserVersion: 19 });
      const approved = await approveFailedApply(harness, kHardGateTarget);
      expect((await harness.sync.applyUpdate(approved)).status).toBe(202);
      expect(readNewestRunRecord(harness).dbPreflight.migrationRequired).toBe(false);
      expect(lastStepDetail(harness, "backup", "warning").detail).toContain("no verified archive is available");
      const notice = notifyMessages(harness.notify).find((value) => value.includes("continues WITHOUT a backup"));
      expect(notice).not.toContain("migrates");
      harness.sync.markGoodNow({ source: "acceptance" });
      await flushAsync();
      expect(notifyMessages(harness.notify).find((value) => value.includes("activation verified"))).not.toContain("was migrated");
    });

    it("clears the apply and watchdog latches and records deferred activation when a hold appears before the restart timer", async () => {
      const managed = { begin: vi.fn(), end: vi.fn() };
      const { harness } = createMigratingBox({ extraSyncOptions: { watchdogManagedOperation: managed } });
      const approved = await approveFailedApply(harness);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = await harness.sync.applyUpdate(approved);
        expect(result.status).toBe(202);
        expect(harness.sync.isApplyInProgress()).toBe(true);
        harness.store.updateState((state) => { state.gatewayHold = { reason: "config_migration_failed", version: "1.0.0", at: harness.nowRef.now }; return state; });
        await vi.advanceTimersByTimeAsync(1500);
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(harness.sync.isApplyInProgress()).toBe(false);
        expect(managed.end).toHaveBeenCalledTimes(2); // failed offer + deferred activation
        const record = harness.ledger.readRun(result.body.operationId);
        expect(record.state).toBe("activation_failed");
        expect(record.result).toMatchObject({ code: "gateway_held", restartDeferred: true, restartRequired: true });
        expect(harness.sync.getChannelInfo().lastUpdateRun.result.restartDeferred).toBe(true);
        expect(harness.store.readState().lastTransition.ok).toBe(false);
      } finally { vi.useRealTimers(); }
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
  // ── v0.9.81 (D15/D19): bounded, self-describing upstream rung ────────────
  describe("upstream inactivity policy + output ring (v0.9.81, cross-model D15/D19)", () => {
    const logLines = (logger) => logger.log.mock.calls.map(([line]) => String(line));
    const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // The live ladder with no quiesce seam: the upstream CLI is the only rung,
    // so what the runner returns is what the ladder must classify.
    const stallRunner = ({ lines = [], stalled = true, tuning = {} } = {}) => {
      const seen = { opts: null };
      const { runnerImpl } = makeBackupRunner({});
      const impl = async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          seen.opts = opts;
          for (const chunk of lines) opts.onOutput?.(chunk, "stdout");
          await sleep(40);
          return {
            ok: false,
            code: null,
            signal: "SIGTERM",
            killed: true,
            timedOut: false,
            stalled,
            tail: lines.join(""),
          };
        }
        return runnerImpl(opts);
      };
      return { impl, seen, tuning };
    };

    it("passes the inactivity window, a staging-bytes probe and an output observer to the runner; a `stalled` result is classified stalled, quotes the CLI's last lines, records them redacted and is offered the backup-risk consent", async () => {
      const { impl, seen } = stallRunner({
        // Two complete lines, one split across chunks, one secret from the
        // spawn env (a secret-NAMED key is what collectSecretValues masks).
        lines: ["Preparing backup…\n", "auth token=hunter2-secret-value ok\nwaiting for coord", "inator lock\n"],
      });
      const logger = mkLogger();
      const harness = createHarness({
        runnerImpl: impl,
        backupTuning: { progressIntervalMs: 5, upstreamInactivityMs: 1234 },
        extraSyncOptions: {
          logger,
          openclawSpawnEnv: () => ({ ...process.env, OPENCLAW_GATEWAY_TOKEN: "hunter2-secret-value" }),
        },
      });

      // A human session on the request is what lets the v0.9.79 waiver be
      // offered; the kind's eligibility is what this test pins.
      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        consentSessionId: "human-test-session",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(seen.opts).toEqual(
        expect.objectContaining({
          inactivityTimeoutMs: 1234,
          progressProbe: expect.any(Function),
          onOutput: expect.any(Function),
        }),
      );
      // The probe reads the CLI's staging bytes: nothing written → null.
      expect(seen.opts.progressProbe()).toBe(null);
      // The verdict names the window and quotes the ring — redacted.
      expect(result.body.message).toMatch(
        /^The pre-update backup CLI made no progress for 1 seconds? \(no output, nothing written\) and was stopped\. The CLI's last output was: "Preparing backup…" \/ "auth token=\*\*\* ok" \/ "waiting for coordinator lock"\./,
      );
      expect(result.body.message).not.toContain("hunter2");
      expect(result.body.backupFailureKind).toBe("stalled");
      // A stall is consent-eligible exactly like a timeout (v0.9.79 waiver).
      expect(result.body.backupRiskEligible).toBe(true);
      const record = readRunBackupRecord(harness);
      expect(record.backupFailureKind).toBe("stalled");
      expect(record.lastOutput).toEqual([
        "Preparing backup…",
        "auth token=*** ok",
        "waiting for coordinator lock",
      ]);
      expect(JSON.stringify(record)).not.toContain("hunter2");
      // Not retried: one live attempt (kLiveRetryPolicy has no stalled row).
      expect(record.attempts).toBe(1);
      expect(record.attemptsDetail.map((a) => a.kind)).toEqual(["stalled"]);
      // The ticker line carried the newest line while the CLI ran.
      const progress = logLines(logger).filter((line) => /upstream backup create in progress/.test(line));
      expect(progress.length).toBeGreaterThanOrEqual(1);
      expect(progress[progress.length - 1]).toMatch(
        /nothing written yet — last output: waiting for coordinator lock — /,
      );
      expect(progress.join("\n")).not.toContain("hunter2");
      // The step row's failure detail names the stall too.
      expect(lastStepDetail(harness, "backup", "failed").error).toBe("stalled: no progress for 1 seconds");
    });

    it("a timeout verdict quotes the ring as well; with no output the message says so; a SUCCESS leaves no lastOutput on the record", async () => {
      const { runnerImpl } = makeBackupRunner({
        script: [{ ok: false, timedOut: true, tail: "" }],
      });
      const harness = createHarness({ runnerImpl });
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.backupFailureKind).toBe("timeout");
      expect(result.body.message).toMatch(/timed out after \d+ minutes\. The CLI printed nothing\./);
      expect(readRunBackupRecord(harness).lastOutput).toBeUndefined();

      const ok = createHarness({ runnerImpl: makeBackupRunner({}).runnerImpl });
      const okResult = await ok.sync.applyUpdate(kHardGateTarget);
      expect(okResult.status).toBe(202);
      expect(readRunBackupRecord(ok).lastOutput).toBeUndefined();
    });

    it("the upstream rung's stall inside the quiesce hands over like a timeout: kQuiescedOutcomePolicy.stalled → offline_copy (already ran) → live ladder", async () => {
      // Force the copy to fail at a non-exclusivity stage so the in-quiesce
      // upstream attempt runs, and make THAT attempt stall.
      const quiesce = makeQuiesceRecorder({});
      let backupCalls = 0;
      const { runnerImpl } = makeOfflineCopyRunner({ onArchiveTool: failCopyArchive });
      const impl = async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          backupCalls += 1;
          if (backupCalls === 1) {
            return { ok: false, code: null, signal: "SIGTERM", killed: true, timedOut: false, stalled: true, tail: "" };
          }
        }
        return runnerImpl(opts);
      };
      const harness = createHarness({
        runnerImpl: impl,
        gatewayQuiesce: quiesce,
        backupProbes: kQuietProbes,
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record.producer).toBe("openclaw");
      expect(record.attemptsDetail.map((a) => [a.rung, a.quiesced, a.kind ?? "ok"])).toEqual([
        ["offline_copy", true, "offline_copy_failed"],
        ["upstream", true, "stalled"],
        ["upstream", false, "ok"],
      ]);
    });
  });

  // ── Issue #54: policy tables are data ────────────────────────────────────
  describe("policy tables (plan §6)", () => {
    it("pins the quiesced outcome policy, the live retry policy, and the reuse-eligible kinds", () => {
      expect(kQuiescedOutcomePolicy).toEqual({
        lock_contention: "retry",
        killed: "offline_copy",
        // #79: a timeout is a speed verdict — the copy is the rung that fits.
        timeout: "offline_copy",
        // v0.9.81 (D15): a stall (no output, no staging bytes for the
        // inactivity window) is a hung CLI — same rung as a timeout, never a
        // replay of the hang.
        stalled: "offline_copy",
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
        ["killed", "lock_contention", "stalled", "timeout", "vanished_file", "window_exhausted"].sort(),
      );
      // Neither a timeout nor a stall is ever retried live: a second attempt
      // would replay the same hang for another ceiling.
      expect(kLiveRetryPolicy).not.toHaveProperty("timeout");
      expect(kLiveRetryPolicy).not.toHaveProperty("stalled");
      for (const terminal of ["no_command", "refuse_overwrite", "enospc", "verify", "generic", "spawn_error", "no_artifact"]) {
        expect(kReuseEligibleKinds).not.toContain(terminal);
      }
      // A refused first-rung copy hands over to the live ladder (never a
      // terminal on its own), so it can never be the kind a reuse offer
      // follows — invariant (5): reuse only after the FULL fresh ladder failed.
      expect(kReuseEligibleKinds).not.toContain("offline_copy_refused");
    });

    it("re-exports the ladder policy module's own objects (ONE copy — the driver, the routes and this pin cannot drift)", () => {
      expect(kQuiescedOutcomePolicy).toBe(backupLadder.kQuiescedOutcomePolicy);
      expect(kLiveRetryPolicy).toBe(backupLadder.kLiveRetryPolicy);
      expect(kReuseEligibleKinds).toBe(backupLadder.kReuseEligibleKinds);
      expect(contentionRetryVerdict).toBe(backupLadder.contentionRetryVerdict);
      expect(chooseBackupRung).toBe(backupLadder.chooseBackupRung);
      expect(predictTransferMs).toBe(backupLadder.predictTransferMs);
      expect(kDefaultBackupBudget).toBe(backupLadder.kDefaultBackupBudget);
      expect(backupBudgetPins).toBe(backupLadder.backupBudgetPins);
    });

    it("kDefaultBackupBudget: the constants under the driver's field names, frozen, including the #79 prediction knobs", () => {
      expect(Object.isFrozen(kDefaultBackupBudget)).toBe(true);
      expect(kDefaultBackupBudget).toEqual(
        expect.objectContaining({
          phaseEnvelopeMs: 25 * 60_000,
          liveAttempts: kOpenclawBackupLiveAttempts,
          cliTimeoutMs: kOpenclawBackupTimeoutMs,
          quiesceTimeoutMs: kOpenclawBackupQuiesceTimeoutMs,
          offlineCopyBudgetMs: kOpenclawBackupOfflineCopyBudgetMs,
          quiesceLeaseReserveMs: kOpenclawBackupQuiesceLeaseReserveMs,
          reuseVerifyTimeoutMs: kOpenclawBackupReuseVerifyTimeoutMs,
          staleTempDirSlackMs: kOpenclawBackupStaleTempDirSlackMs,
          stateDbQuietSlackMs: kOpenclawStateDbQuietSlackMs,
          diagnosisBudgetMs: 2 * 60_000,
          upstreamMaxBytes: kOpenclawBackupUpstreamMaxBytes,
          defaultCopyBytesPerSec: 20_000_000,
          defaultUpstreamBytesPerSec: 15_000_000,
          perFileOverheadMs: kOpenclawBackupPerFileOverheadMs,
          // #79 (h): the progress ticker's cadence, harness-tunable like the rest.
          progressIntervalMs: 15_000,
          // v0.9.81 (D15): the upstream rung's inactivity window.
          upstreamInactivityMs: kOpenclawBackupUpstreamInactivityMs,
        }),
      );
      // The driver spreads it under the tuning override: the harness's
      // kFastTuning values must be what the run actually used (the barrier
      // maxMs pin above proves the derivation reads the EFFECTIVE table).
      expect(kFastTuning.quiesceLockTimeoutMs).not.toBe(kDefaultBackupBudget.quiesceLockTimeoutMs);
    });

    it("chooseBackupRung: the post-copy fallback is the in-quiesce upstream only when prediction, byte cap and remaining pause all agree — every unknown answers offline_copy", () => {
      const fits = { predictedUpstreamMs: 60_000, copySetBytes: 512 * 1024 * 1024 };
      expect(chooseBackupRung({ diagnosis: fits, remainingMs: 120_000 })).toEqual({
        rung: "upstream",
        reason: "predicted_fits",
      });
      // 1.5× headroom: 60 s × 1.5 = 90 s must be strictly under what remains.
      expect(backupLadder.kUpstreamPredictionSafetyFactor).toBe(1.5);
      expect(chooseBackupRung({ diagnosis: fits, remainingMs: 90_000 })).toEqual({
        rung: "offline_copy",
        reason: "predicted_too_slow",
      });
      expect(chooseBackupRung({ diagnosis: fits, remainingMs: 90_001 })).toEqual({
        rung: "upstream",
        reason: "predicted_fits",
      });
      // Unknown prediction (the diagnosis walk hit its budget, no prior
      // calibration — Codex 16 predicts "unknown") → copy-first, fail-closed.
      for (const diagnosis of [
        { predictedUpstreamMs: null, copySetBytes: 1 },
        { predictedUpstreamMs: NaN, copySetBytes: 1 },
        { predictedUpstreamMs: -1, copySetBytes: 1 },
        { copySetBytes: 1 },
        null,
        undefined,
      ]) {
        expect(chooseBackupRung({ diagnosis, remainingMs: 1e9 })).toEqual({
          rung: "offline_copy",
          reason: "prediction_unknown",
        });
      }
      expect(chooseBackupRung({})).toEqual({ rung: "offline_copy", reason: "prediction_unknown" });
      expect(chooseBackupRung()).toEqual({ rung: "offline_copy", reason: "prediction_unknown" });
      // Unknown copy-set size (a pre-#79 diagnosis carries stateBytes only) → copy-first.
      expect(chooseBackupRung({ diagnosis: { predictedUpstreamMs: 1, stateBytes: 1 }, remainingMs: 1e9 })).toEqual({
        rung: "offline_copy",
        reason: "copy_set_unknown",
      });
      // Byte cap: upstream tars everything (no excludes); 2 GiB inclusive.
      expect(kOpenclawBackupUpstreamMaxBytes).toBe(2 * 1024 ** 3);
      expect(
        chooseBackupRung({
          diagnosis: { predictedUpstreamMs: 1, copySetBytes: kOpenclawBackupUpstreamMaxBytes },
          remainingMs: 1e9,
        }),
      ).toEqual({ rung: "upstream", reason: "predicted_fits" });
      expect(
        chooseBackupRung({
          diagnosis: { predictedUpstreamMs: 1, copySetBytes: kOpenclawBackupUpstreamMaxBytes + 1 },
          remainingMs: 1e9,
        }),
      ).toEqual({ rung: "offline_copy", reason: "copy_set_too_large" });
      // The cap is a budget knob (backupTuning.upstreamMaxBytes).
      expect(
        chooseBackupRung({ diagnosis: { predictedUpstreamMs: 1, copySetBytes: 10 }, remainingMs: 1e9, upstreamMaxBytes: 5 }),
      ).toEqual({ rung: "offline_copy", reason: "copy_set_too_large" });
      // The size cap is judged before the clock: an oversized set is named as
      // such even when time would have fit.
      expect(
        chooseBackupRung({
          diagnosis: { predictedUpstreamMs: 1e9, copySetBytes: kOpenclawBackupUpstreamMaxBytes + 1 },
          remainingMs: 1,
        }),
      ).toEqual({ rung: "offline_copy", reason: "copy_set_too_large" });
      // No remaining budget known, or none left → does not fit.
      for (const remainingMs of [NaN, undefined, 0, -1]) {
        expect(chooseBackupRung({ diagnosis: fits, remainingMs })).toEqual({
          rung: "offline_copy",
          reason: "predicted_too_slow",
        });
      }
      // Both answers belong to the rung vocabulary.
      expect(backupLadder.kBackupRungs).toEqual(["offline_copy", "upstream"]);
    });

    it("predictTransferMs: bytes / rate + files × per-file overhead (Codex 16); null when there is nothing honest to say", () => {
      expect(predictTransferMs({ bytes: 20_000_000, bytesPerSec: 20_000_000 })).toBe(1000);
      expect(
        predictTransferMs({ bytes: 20_000_000, files: 1000, bytesPerSec: 20_000_000, perFileOverheadMs: 2 }),
      ).toBe(3000);
      // Default per-file overhead is the constant.
      expect(predictTransferMs({ bytes: 0, files: 10, bytesPerSec: 1 })).toBe(10 * kOpenclawBackupPerFileOverheadMs);
      // The default rates: 1.5 GB upstream at 15 MB/s = 100 s; 1 GB copy at 20 MB/s = 50 s.
      expect(predictTransferMs({ bytes: 1_500_000_000, bytesPerSec: kOpenclawBackupDefaultUpstreamBytesPerSec })).toBe(100_000);
      expect(predictTransferMs({ bytes: 1_000_000_000, bytesPerSec: kOpenclawBackupDefaultCopyBytesPerSec })).toBe(50_000);
      // Unknown → null, never 0 (a caller must treat null as "unknown").
      expect(predictTransferMs({ bytes: null, bytesPerSec: 1 })).toBeNull();
      expect(predictTransferMs({ bytes: -1, bytesPerSec: 1 })).toBeNull();
      expect(predictTransferMs({ bytes: 1, bytesPerSec: 0 })).toBeNull();
      expect(predictTransferMs({ bytes: 1, bytesPerSec: -5 })).toBeNull();
      expect(predictTransferMs({ bytes: 1 })).toBeNull();
      expect(predictTransferMs()).toBeNull();
      // A junk file count / overhead counts as zero, never NaN.
      expect(predictTransferMs({ bytes: 1000, files: NaN, bytesPerSec: 1000, perFileOverheadMs: -1 })).toBe(1000);
      expect(predictTransferMs({ bytes: 1000, files: -3, bytesPerSec: 1000 })).toBe(1000);
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
  describe("quiesced driver: offline copy first, then the predicted-to-fit upstream with contention retries (issues #54 / #79)", () => {
    it("after a failed copy, retries lease loss in-quiesce with doubling backoff (≤2) and succeeds on the third upstream attempt", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
          { ok: true },
        ],
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli"),
        onArchiveTool: composeHooks(markOfflineCopy(quiesce), failCopyArchive),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce, backupTuning: { contentionBackoffBaseMs: 4 } });
      armInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(3);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
        "backup-cli(quiet)",
        "backup-cli(quiet)",
        "backup-cli(quiet)",
        "dbResume",
        "start",
        "unsuppress",
        "release",
      ]);
      // Every in-quiesce attempt gets what is LEFT of the fixed deadline,
      // which is sized for both quiesced rungs up front (#79 (c)).
      const deadlineMs = kOpenclawBackupQuiesceTimeoutMs + kOpenclawBackupOfflineCopyBudgetMs;
      expect(backupCalls.every((c) => c.timeoutMs <= deadlineMs)).toBe(true);
      expect(backupCalls.some((c) => c.timeoutMs > kOpenclawBackupQuiesceTimeoutMs)).toBe(true);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          attempts: 3,
          quiescedAttempts: 3,
          quiesced: true,
          contentionRetries: 2,
          noBackup: false,
          producer: "openclaw",
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            next: { rung: "upstream", reason: "predicted_fits" },
          }),
        }),
      );
      expect(record.attemptsDetail.map((a) => a.reason)).toEqual([
        "primary",
        "predicted_fits",
        "contention_retry",
        "contention_retry",
      ]);
      const contention = eventsOfType(harness.insertEvent, "backup_contention");
      expect(contention.map((e) => e.status)).toEqual(["retrying", "retrying"]);
      // Doubling: base, then 2× base.
      expect(contention.map((e) => e.details.backoffMs)).toEqual([4, 8]);
      expect(lastStepDetail(harness, "backup", "completed").detail).toBe(
        "succeeded on attempt 3 (gateway paused briefly)",
      );
    });

    it("does not retry in-quiesce when the budget cannot fit attempt + backoff + reserve (insufficient_budget) — hands over to the live ladder, never a second copy", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kLeaseLostTail }, { ok: true }],
        onArchiveTool: failCopyArchive,
      });
      // 20 s envelope → the fixed quiesce deadline is ~20 s: 0 + 1 + 30 s
      // reserve does not fit, so the very first contention ends the pause.
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 20_000 },
      });
      armInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      const [event] = eventsOfType(harness.insertEvent, "backup_contention");
      expect(event.status).toBe("exhausted");
      expect(event.details.reason).toBe("insufficient_budget");
      // Exactly one copy this pause.
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "failed",
      ]);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          contentionRetries: 0,
          quiescedAttempts: 1,
          attempts: 2,
          offlineCopy: expect.objectContaining({ ok: false, stage: "archive", reason: "primary" }),
        }),
      );
      expect(quiesce.start).toHaveBeenCalledTimes(1);
    });

    it("the offline copy is the FIRST rung: real tar/gzip, exclusivity evidence recorded, usable — no upstream attempt runs while paused", async () => {
      const quiesce = makeQuiesceRecorder({ stopEvidence: { confirmed: true, via: "port_released" } });
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: markOfflineCopy(quiesce),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      const dbFile = seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      // The copy happened BEFORE dbResume/start — still quiesced.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
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
          attempts: 0,
          quiescedAttempts: 0,
          contentionRetries: 0,
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary", partial: false }),
        }),
      );
      // Nothing followed the copy.
      expect(record.offlineCopy.next).toBeUndefined();
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
      expect(lastStepDetail(harness, "backup", "completed").detail).toBe(
        "succeeded via AlphaClaw offline copy (gateway paused)",
      );
      // The offline copy's own tmp debris is gone; nothing else was written.
      const names = fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"));
      expect(names).toEqual([path.basename(record.file)]);
      // state.backups records the producer so the inventory can label it.
      expect(harness.store.readState().backups[0]).toEqual(
        expect.objectContaining({ producer: "alphaclaw-offline-copy", file: record.file }),
      );
    });

    it(
      "hermetic acceptance (#79): 64 MB of workspace junk beside a 5 MB state DB → the copy rung ALONE, the DB in the archive, the junk measured and absent, inside 30 s",
      async () => {
        const quiesce = makeQuiesceRecorder({});
        const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
        const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
        // ~5 MB of incompressible rows — what sqlite backup() + `gzip -1` must
        // actually move (a zero-filled blob would gzip to nothing and prove
        // no budget). The WAL is checkpointed into the file on close.
        const dbFile = seedStateDb(harness, { rows: 1 });
        const db = new DatabaseSync(dbFile);
        db.exec("CREATE TABLE payload(b BLOB)");
        const insert = db.prepare("INSERT INTO payload VALUES (randomblob(1024))");
        db.exec("BEGIN");
        for (let i = 0; i < 5 * 1024; i += 1) insert.run();
        db.exec("COMMIT");
        db.close();
        const dbBytes = fs.statSync(dbFile).size;
        expect(dbBytes).toBeGreaterThan(5 * 1024 * 1024);
        // 64 MiB of debris the default policy drops — one entry per default
        // pattern that can hold bytes — beside a file the copy must keep.
        const ws = path.join(harness.openclawDir, "workspace");
        const junk = {
          node_modules: 60 * 1024 * 1024,
          heapsnapshot: 3 * 1024 * 1024,
          tmp: 1 * 1024 * 1024,
        };
        const junkBytes = junk.node_modules + junk.heapsnapshot + junk.tmp;
        expect(junkBytes).toBe(64 * 1024 * 1024);
        fs.mkdirSync(path.join(ws, "node_modules", "heavy"), { recursive: true });
        // Random too: had the junk leaked into the archive, its size proves it.
        fs.writeFileSync(path.join(ws, "node_modules", "heavy", "blob.bin"), crypto.randomBytes(junk.node_modules));
        fs.writeFileSync(path.join(ws, "Heap-20260907.heapsnapshot"), crypto.randomBytes(junk.heapsnapshot));
        fs.writeFileSync(path.join(ws, "scratch.tmp"), crypto.randomBytes(junk.tmp));
        const keep = "keep me\n";
        fs.writeFileSync(path.join(ws, "notes.md"), keep);

        const result = await harness.sync.applyUpdate(kHardGateTarget);

        expect(result.status).toBe(202);
        // (a) exactly the offline_copy rung: no upstream attempt, paused or live.
        expect(backupCalls).toHaveLength(0);
        const record = readRunBackupRecord(harness);
        expect(record.attemptsDetail).toEqual([
          expect.objectContaining({ rung: "offline_copy", reason: "primary", quiesced: true, ok: true }),
        ]);
        expect(record).toEqual(
          expect.objectContaining({
            producer: "alphaclaw-offline-copy",
            verified: true,
            usableCheck: "manifest_ok",
            attempts: 0,
            quiescedAttempts: 0,
          }),
        );
        // (c) the junk was MEASURED, not copied: 64 MiB excluded, coverage honest.
        expect(record.offlineCopy).toEqual(
          expect.objectContaining({
            ok: true,
            reason: "primary",
            partial: false,
            excludedBytes: junkBytes,
            coverage: { core: "complete", workspace: "policy_excluded" },
          }),
        );
        // The pre-pause diagnosis sized the same tree the same way.
        expect(record.diagnosis).toEqual(
          expect.objectContaining({
            walk: "complete",
            excludedBytes: junkBytes,
            copySetBytes: dbBytes + keep.length,
            tarSetBytes: dbBytes + keep.length + junkBytes,
          }),
        );
        // (b) the archive lists the DB and the kept file, no excluded path.
        const { execFileSync } = require("child_process");
        const listed = execFileSync("tar", ["-tzf", record.file], { encoding: "utf8" });
        expect(listed).toMatch(/\/state\/openclaw\.sqlite\n/);
        expect(listed).toMatch(/\/workspace\/notes\.md\n/);
        expect(listed).toMatch(/\/manifest\.json\n/);
        expect(listed).not.toMatch(/node_modules/);
        expect(listed).not.toMatch(/\.heapsnapshot/);
        expect(listed).not.toMatch(/\.tmp/);
        // Size says the same: the 5 MB of random rows, never the 64 MB of junk.
        const archiveBytes = fs.statSync(record.file).size;
        expect(archiveBytes).toBeGreaterThan(4 * 1024 * 1024);
        expect(archiveBytes).toBeLessThan(16 * 1024 * 1024);
        expect(record.offlineCopyBytes).toBe(archiveBytes);
        // The manifest (format 2) tallies the policy per pattern.
        const manifest = JSON.parse(
          execFileSync("tar", ["-xzOf", record.file, "--wildcards", "--no-wildcards-match-slash", "*/manifest.json"], {
            encoding: "utf8",
          }),
        );
        expect(manifest.alphaclawFormatVersion).toBe(2);
        expect(manifest.coverage).toEqual({ core: "complete", workspace: "policy_excluded" });
        expect(manifest.excludes).toEqual([
          { pattern: "node_modules", files: 1, bytes: junk.node_modules },
          { pattern: "*.heapsnapshot", files: 1, bytes: junk.heapsnapshot },
          { pattern: "*.tmp", files: 1, bytes: junk.tmp },
          { pattern: "logs/**/*.gz", files: 0, bytes: 0 },
        ]);
        expect(manifest.partialReasons).toEqual([]);
      },
      // (d) the plan's budget: a copy-set regression (junk copied, walk
      // unbounded) fails loudly here instead of hanging the suite.
      30_000,
    );

    it("a killed post-copy upstream CLI hands over to the live ladder (no in-quiesce retry, never a second copy)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, signal: "SIGKILL", killed: true, tail: "" }, { ok: true }],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      expect(eventsOfType(harness.insertEvent, "backup_contention")).toHaveLength(0);
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "failed",
      ]);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          attempts: 2,
          quiescedAttempts: 1,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            reason: "primary",
            next: { rung: "upstream", reason: "predicted_fits" },
          }),
        }),
      );
      expect(lastStepDetail(harness, "backup", "running").detail).toMatch(
        /attempt 2 — retrying after a killed backup \(SIGKILL\)/,
      );
    });

    it("a rollback-journal DB over the self-deadlock size: the copy is first anyway (no upstream attempt), the diagnosis records the journal mode", async () => {
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
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
        }),
      );
      expect(record.diagnosis).toEqual(
        expect.objectContaining({ journalMode: "delete", dbCount: 1 }),
      );
      expect(record.diagnosis.stateBytes).toBeGreaterThan(1);
      const completed = lastStepDetail(harness, "backup", "completed").detail;
      expect(completed).toBe("succeeded via AlphaClaw offline copy (gateway paused)");
      expect(completed).not.toMatch(/after 0 upstream attempts/);
    });

    it("a rollback-journal DB over the self-deadlock size VETOES the post-copy in-quiesce upstream attempt even when the prediction fits — live fallback, veto on the record", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli(live)"),
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { rollbackJournalSelfDeadlockBytes: 1 },
      });
      seedStateDb(harness, { journalMode: "DELETE" });
      seedPriorUpstreamRun(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      // The upstream ran ONCE, live — never against the paused rollback-journal DB.
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toContain("backup-cli(live)");
      expect(quiesce.calls).not.toContain("backup-cli(quiet)");
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          quiesced: true,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            next: { rung: "live", reason: "rollback_journal_self_deadlock" },
          }),
        }),
      );
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [e.status, e.details.rung, e.details.reason]),
      ).toEqual([
        ["chosen", "offline_copy", "primary"],
        ["handed_over", "upstream", "rollback_journal_self_deadlock"],
        ["chosen", "upstream", "live_fallback"],
      ]);
    });

    it("a refused copy (primary rung) hands over to the live ladder; when that fails too, the 409 names the live failure AND the holder's argv — never '(after 0 attempts)', never a reuse offer on a terminal live kind", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        script: [{ ok: false, tail: "boom\n" }],
      });
      const listProcesses = vi.fn(() => [{ pid: 4242, cmdline: "openclaw gateway run" }]);
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: { ...kQuietProbes, listProcesses },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      // The refusal alone is never terminal: the live upstream ran (once —
      // generic has no live retry) before the gate refused.
      expect(backupCalls).toHaveLength(1);
      expect(result.body.message).toBe(
        "The pre-update backup failed — boom (after 1 attempt). The AlphaClaw offline copy of the paused state was refused first because state dir is not exclusively ours: 1 live openclaw process(es): 4242 (openclaw gateway run) — argv names an OpenClaw executable or entry script.",
      );
      expect(result.body.message).not.toMatch(/after 0 attempts/);
      // The driver re-sampled (settle loop) before refusing a holder that stayed.
      expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(3);
      // generic is not a reuse-eligible class, and the refusal is not one on
      // its own: no offer rides this 409.
      expect(result.body.reusableBackup).toBeUndefined();
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          attempts: 1,
          quiescedAttempts: 0,
          quiesced: true,
          noBackup: true,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "exclusivity",
            reason: "primary",
            next: { rung: "live", reason: "offline_copy_refused" },
          }),
        }),
      );
      expect(record.attemptsDetail).toEqual([
        expect.objectContaining({ rung: "offline_copy", reason: "primary", quiesced: true, ok: false, kind: "offline_copy_refused" }),
        expect.objectContaining({ rung: "upstream", reason: "live_fallback", quiesced: false, ok: false, kind: "generic" }),
      ]);
    });

    it("a transient openclaw child (our own CLI shell-out) that exits during the settle window does not refuse the offline copy", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({});
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
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
        }),
      );
      // The exclusivity evidence records the settled (empty) sample.
      expect(record.exclusivityEvidence).toEqual(expect.objectContaining({ liveProcesses: 0 }));
    });

    // D13: the pre-copy argv sample and the /proc fd scan used to describe
    // different instants (the state walk between them yields for seconds):
    // our own `sessions list` child spawned during the walk was invisible to
    // the sample and refused by the fd scan as a foreign holder — a terminal
    // 409 whose hint told the operator to stop AlphaClaw's own process.
    it("a transient openclaw child that spawns AFTER the pre-walk sample and exits during the post-walk re-settle does not refuse the offline copy", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({});
      // Sample 1 is the diagnosis, sample 2 the driver's pre-walk sample:
      // both empty, and the child spawns right after sample 2. The post-walk
      // settle loop (samples 3 and 4) still sees it; it has exited by 5.
      // The fd scan sees the child's handle exactly while it is alive.
      let samples = 0;
      let childAlive = false;
      const listProcesses = vi.fn(() => {
        samples += 1;
        if (samples === 2) {
          childAlive = true;
          return [];
        }
        if (samples >= 5) childAlive = false;
        return childAlive ? [{ pid: 777, cmdline: "openclaw sessions list --json" }] : [];
      });
      const listFdHolders = vi.fn(() =>
        childAlive ? [{ pid: 777, path: "/state/openclaw.sqlite" }] : [],
      );
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: { ...kQuietProbes, listProcesses, listFdHolders },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(samples).toBeGreaterThanOrEqual(5);
      // The fd scan ran once the re-settle had drained the child, so it was clean.
      expect(listFdHolders).toHaveBeenCalledTimes(1);
      expect(listFdHolders.mock.results[0].value).toEqual([]);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "alphaclaw-offline-copy",
          verified: true,
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
        }),
      );
      expect(record.exclusivityEvidence).toEqual(
        expect.objectContaining({ liveProcesses: 0, fdScan: "clean" }),
      );
    });

    it("chooseBackupRung: a prior run predicting the upstream cannot fit the pause rules out the post-copy in-quiesce attempt (predicted_too_slow) — live fallback", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli(live)"),
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      // Prior run: the upstream CLI's OWN attempt took the whole quiesce
      // budget for 1 byte → today's DB predicts far longer than what remains.
      const priorId = seedPriorUpstreamRun(harness, {
        attemptMs: kOpenclawBackupQuiesceTimeoutMs,
        stateBytes: 1,
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toContain("backup-cli(live)");
      expect(quiesce.calls).not.toContain("backup-cli(quiet)");
      // The live attempt gets the full CLI ceiling.
      expect(backupCalls[0].timeoutMs).toBe(kOpenclawBackupTimeoutMs);
      const record = readRunBackupRecord(harness);
      expect(record.offlineCopy).toEqual(
        expect.objectContaining({
          ok: false,
          stage: "archive",
          next: { rung: "live", reason: "predicted_too_slow" },
        }),
      );
      expect(record.diagnosis.predictedUpstreamMs).toBeGreaterThan(kOpenclawBackupQuiesceTimeoutMs);
      expect(record.diagnosis.priorRun).toEqual({
        operationId: priorId,
        attemptMs: kOpenclawBackupQuiesceTimeoutMs,
        stateBytes: 1,
      });
    });

    it("calibrates predictedUpstreamMs from the prior UPSTREAM attempt's own wall time only — a whole-step duration or an offline-copy run is never calibration input; with neither, the DEFAULT rate predicts (and a fixture DB fits)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({ onArchiveTool: failCopyArchive });
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
      // Neither record calibrates (priorRun null): the DEFAULT 15 MB/s rate
      // over the tar set predicts instead (#79 (d)), a fixture DB fits the
      // pause, and the failed copy hands over to the in-quiesce upstream,
      // which ran ONCE, paused, and succeeded.
      expect(backupCalls).toHaveLength(1);
      const record = readRunBackupRecord(harness);
      expect(record.producer).toBe("openclaw");
      expect(record.quiescedAttempts).toBe(1);
      expect(record.offlineCopy).toEqual(
        expect.objectContaining({ ok: false, next: { rung: "upstream", reason: "predicted_fits" } }),
      );
      const diagnosis = record.diagnosis;
      expect(diagnosis.priorRun).toBeNull();
      expect(diagnosis.predictionSource.upstream).toBe("default");
      expect(diagnosis.predictedUpstreamMs).toBe(
        predictTransferMs({
          bytes: diagnosis.tarSetBytes,
          files: diagnosis.tarFileCount,
          bytesPerSec: kOpenclawBackupDefaultUpstreamBytesPerSec,
          perFileOverheadMs: kOpenclawBackupPerFileOverheadMs,
        }),
      );
      // Had either junk record been read as calibration, the prediction would
      // have been hours (4 quiesce budgets per byte) — never a fit.
      expect(diagnosis.predictedUpstreamMs).toBeLessThan(kOpenclawBackupQuiesceTimeoutMs);
      // This run records the CLI's own wall time for the NEXT calibration.
      expect(record.attemptMs).toBe(1234);
      expect(record.durationMs).toBeGreaterThanOrEqual(1234);
    });

    it("v0.9.81 (RC3a): a `tail -F` on OpenClaw's log file beside the paused gateway is NOT a live openclaw process — the REAL matcher over a fake /proc lets the copy run (attempts: 0); a real `gateway run` in the same table still refuses", async () => {
      const table = {
        348161: "tail\0-c\0+1\0-F\0/tmp/openclaw/openclaw-2026-09-08.log\0",
        348170: "less\0/data/openclaw/x.log\0",
        348180: "node\0/app/bin/alphaclaw.js\0start\0",
      };
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupProbes: { ...kQuietProbes, listProcesses: fakeProcScan(table) },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "alphaclaw-offline-copy",
          attempts: 0,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
        }),
      );
      expect(record.diagnosis.otherProcesses).toEqual([]);

      // Same table plus a real gateway: refused, holder named with the reason
      // the operator can act on.
      const withGateway = { ...table, 348300: "openclaw\0gateway\0run\0" };
      const refusedRunner = makeOfflineCopyRunner({});
      const refused = createHarness({
        runnerImpl: refusedRunner.runnerImpl,
        gatewayQuiesce: makeQuiesceRecorder({}),
        backupProbes: { ...kQuietProbes, listProcesses: fakeProcScan(withGateway) },
      });
      seedStateDb(refused);
      const refusedResult = await refused.sync.applyUpdate(kHardGateTarget);
      expect(refusedResult.status).toBe(202);
      expect(refusedRunner.backupCalls).toHaveLength(1);
      const refusedRecord = readRunBackupRecord(refused);
      expect(refusedRecord.offlineCopy).toEqual(
        expect.objectContaining({ ok: false, stage: "exclusivity" }),
      );
      expect(refusedRecord.offlineCopy.error).toMatch(
        /1 live openclaw process\(es\): 348300 \(openclaw gateway run\) — argv names an OpenClaw executable or entry script/,
      );
      expect(refusedRecord.offlineCopy.error).not.toMatch(/tail/);
    });

    it("refuses the offline copy when the state dir is not exclusively ours (a live openclaw process) — and the hard gate is then satisfied by the LIVE upstream, which needs no exclusivity", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
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

      expect(result.status).toBe(202);
      // A refusal is terminal for the PAUSE, never for the ladder: the live
      // upstream ran once, after the unwind, and its archive is the backup.
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(isStateDbQuiet()).toBe(false);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          verified: true,
          producer: "openclaw",
          attempts: 1,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "exclusivity",
            reason: "primary",
            next: { rung: "live", reason: "offline_copy_refused" },
          }),
        }),
      );
      expect(record.offlineCopy.error).toMatch(/state dir is not exclusively ours: 1 live openclaw process\(es\): 4242/);
      // The refused copy left nothing behind: only the upstream archive is on disk.
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([
        path.basename(record.file),
      ]);
      expect(record.diagnosis.otherProcesses).toEqual([{ pid: 4242, cmdline: "openclaw gateway run" }]);
      expect(eventsOfType(harness.insertEvent, "backup_offline_copy").map((e) => e.status)).toEqual([
        "started",
        "failed",
      ]);
    });

    it("hands over to the live ladder when the offline copy fails at a later stage (archive) and the prediction rules the upstream out of the pause — the first live row names the copy, the hand-over reason is on the record and the events tab", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: composeHooks(markOfflineCopy(quiesce), failCopyArchive),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      ruleOutInQuiesceUpstream(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli",
      ]);
      // The live attempt gets the full CLI ceiling.
      expect(backupCalls[0].timeoutMs).toBe(kOpenclawBackupTimeoutMs);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          attempts: 1,
          quiescedAttempts: 0,
          quiesced: true,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            reason: "primary",
            next: { rung: "live", reason: "predicted_too_slow" },
          }),
        }),
      );
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.ok, a.kind])).toEqual([
        ["offline_copy", "primary", true, false, "offline_copy_failed"],
        ["upstream", "live_fallback", false, true, null],
      ]);
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [e.status, e.details.rung, e.details.reason]),
      ).toEqual([
        ["chosen", "offline_copy", "primary"],
        ["handed_over", "upstream", "predicted_too_slow"],
        ["chosen", "upstream", "live_fallback"],
      ]);
      // WI-1.5: the first live row names what it follows — the copy and its
      // stage — never "attempt 1 — retrying".
      expect(lastStepDetail(harness, "backup", "running").detail).toBe(
        "live upstream attempt after a failed offline copy (archive)",
      );
      // Success detail claims no pause: the succeeding attempt ran live.
      expect(lastStepDetail(harness, "backup", "completed").detail).toBeUndefined();
    });

    it("an expired quiet barrier is never copied over: the copy is refused (barrier lost), the expiry is on the events tab, and the live ladder takes over", async () => {
      // The barrier is tuned to expire after 1 ms; the recorder hands the
      // token back 15 ms after the barrier began, so by the time the FIRST
      // rung (the copy) proves exclusivity the proof is gone.
      const quiesce = makeQuiesceRecorder({ dbQuietDelayMs: 15 });
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { stateDbQuietMaxMs: 1 },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record.offlineCopy).toEqual(
        expect.objectContaining({
          ok: false,
          stage: "exclusivity",
          next: { rung: "live", reason: "offline_copy_refused" },
        }),
      );
      expect(record.offlineCopy.error).toMatch(
        /^state dir is not exclusively ours: state-db quiet barrier lost/,
      );
      // The live upstream (no barrier needed) is the backup that satisfied the gate.
      expect(backupCalls).toHaveLength(1);
      expect(record.producer).toBe("openclaw");
      expect(eventsOfType(harness.insertEvent, "state_db_quiet").map((e) => e.status)).toContain("expired");
      // Nothing of the refused copy is on disk — only the upstream archive.
      expect(record.file).not.toMatch(/\.alphaclaw\./);
      expect(fs.readdirSync(path.join(harness.rootDir, "backups", "openclaw"))).toEqual([
        path.basename(record.file),
      ]);
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
          // The copy's archive step observes the (disabled) barrier state.
          onArchiveTool: (opts) => {
            if (opts.command === "tar" && opts.args[0] === "-I") {
              quiesce.calls.push(isStateDbQuiet() ? "quiet:on" : "quiet:off");
            }
            return null;
          },
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
            offlineCopy: expect.objectContaining({ ok: true, reason: "primary" }),
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
  // ── #79 (d) / Codex 16: predict before starting ─────────────────────────
  describe("pre-backup diagnosis: sized tree, two prediction series, envelope stamped after (#79 (d), Codex 16)", () => {
    // A workspace with two payload files and a node_modules tree the default
    // policy excludes: the copy set is DB + payload, the tar set adds the junk.
    const seedWorkspace = (harness) => {
      const ws = path.join(harness.openclawDir, "workspace");
      fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(ws, "notes.md"), "x".repeat(1000));
      fs.writeFileSync(path.join(ws, "src.js"), "y".repeat(500));
      fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "z".repeat(4000));
      fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "package.json"), "{}");
      return { payloadBytes: 1500, payloadFiles: 2, excludedBytes: 4002, excludedFiles: 2 };
    };

    it("first run (no prior runs): both rungs are predicted from the DEFAULT rates over the sized tree — copy set without the policy excludes, tar set with them — and the sizes, sources and predictions ride the record, the event and the log", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({});
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce, extraSyncOptions: { logger } });
      const dbFile = seedStateDb(harness);
      const ws = seedWorkspace(harness);
      const dbBytes = fs.statSync(dbFile).size;

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(0);
      const record = readRunBackupRecord(harness);
      const diagnosis = record.diagnosis;
      const copySetBytes = dbBytes + ws.payloadBytes;
      const tarSetBytes = copySetBytes + ws.excludedBytes;
      expect(diagnosis).toEqual(
        expect.objectContaining({
          walk: "complete",
          walkError: null,
          copySetBytes,
          workspaceBytes: ws.payloadBytes,
          excludedBytes: ws.excludedBytes,
          tarSetBytes,
          fileCount: 1 + ws.payloadFiles,
          tarFileCount: 1 + ws.payloadFiles + ws.excludedFiles,
          priorRun: null,
          priorCopyRun: null,
          predictionSource: { offlineCopy: "default", upstream: "default" },
        }),
      );
      expect(diagnosis.walkMs).toBe(0);
      // Codex 16: bytes / rate + files × per-file overhead, each over ITS set.
      expect(diagnosis.predictedOfflineCopyMs).toBe(
        predictTransferMs({
          bytes: copySetBytes,
          files: 1 + ws.payloadFiles,
          bytesPerSec: kOpenclawBackupDefaultCopyBytesPerSec,
          perFileOverheadMs: kOpenclawBackupPerFileOverheadMs,
        }),
      );
      expect(diagnosis.predictedUpstreamMs).toBe(
        predictTransferMs({
          bytes: tarSetBytes,
          files: 1 + ws.payloadFiles + ws.excludedFiles,
          bytesPerSec: kOpenclawBackupDefaultUpstreamBytesPerSec,
          perFileOverheadMs: kOpenclawBackupPerFileOverheadMs,
        }),
      );
      // Upstream takes no excludes: its set (and its per-file cost) is larger.
      expect(diagnosis.predictedUpstreamMs).toBeGreaterThan(diagnosis.predictedOfflineCopyMs);
      // stateBytes (DBs + WAL, the veto's measure) is not the copy set.
      expect(diagnosis.stateBytes).toBeGreaterThanOrEqual(dbBytes);
      // The events tab carries the same figures.
      const [event] = eventsOfType(harness.insertEvent, "backup_diagnosis");
      expect(event.details).toEqual(
        expect.objectContaining({
          walk: "complete",
          copySetBytes,
          tarSetBytes,
          excludedBytes: ws.excludedBytes,
          fileCount: 1 + ws.payloadFiles,
          tarFileCount: 1 + ws.payloadFiles + ws.excludedFiles,
          predictedUpstreamMs: diagnosis.predictedUpstreamMs,
          predictedOfflineCopyMs: diagnosis.predictedOfflineCopyMs,
          predictionSource: { offlineCopy: "default", upstream: "default" },
        }),
      );
      // The log line names both predictions and the tar set / excluded / files.
      const line = logger.log.mock.calls.map(([m]) => String(m)).find((m) => /backup: diagnosis/.test(m));
      expect(line).toMatch(
        /walk=complete \(0s\) predicted upstream=\d+s copy=\d+s \(tar set \d+ MB, excluded \d+ MB, 5 files\)/,
      );
      // The copy's own coverage agrees with what the diagnosis sized.
      expect(record.offlineCopy).toEqual(
        expect.objectContaining({
          ok: true,
          excludedBytes: ws.excludedBytes,
          coverage: { core: "complete", workspace: "policy_excluded" },
        }),
      );
      // No upstream rung was considered: no veto recorded.
      expect(record.upstreamVeto).toBeNull();
    });

    it("an incomplete diagnosis walk (budget hit) predicts unknown — every size null, both predictions null, the prior run NOT consulted — and the failed copy hands over fail-closed (prediction_unknown), never to the in-quiesce upstream", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({ onArchiveTool: failCopyArchive });
      let harness;
      // Every stat of a workspace file costs 10 ms of the frozen clock: the
      // walk's first checkpoint (kWalkCheckpointEvery entries in) finds the
      // 1 s diagnosis budget spent. The copy's own walk pays the same, well
      // inside its budget.
      const slowFs = {
        ...fs,
        statSync: (target, ...rest) => {
          if (String(target).includes(`${path.sep}workspace${path.sep}`)) harness.nowRef.now += 10;
          return fs.statSync(target, ...rest);
        },
      };
      harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { diagnosisBudgetMs: 1000 },
        extraSyncOptions: { fsModule: slowFs },
      });
      // A DB plus a prior upstream run that WOULD predict a fit (≈0 ms).
      armInQuiesceUpstream(harness);
      const ws = path.join(harness.openclawDir, "workspace");
      fs.mkdirSync(ws, { recursive: true });
      for (let i = 0; i < kWalkCheckpointEvery + 100; i += 1) {
        fs.writeFileSync(path.join(ws, `f${i}.txt`), "x");
      }

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record.diagnosis).toEqual(
        expect.objectContaining({
          walk: "incomplete",
          copySetBytes: null,
          tarSetBytes: null,
          workspaceBytes: null,
          excludedBytes: null,
          fileCount: null,
          tarFileCount: null,
          predictedUpstreamMs: null,
          predictedOfflineCopyMs: null,
          predictionSource: { offlineCopy: null, upstream: null },
          priorRun: null,
          priorCopyRun: null,
        }),
      );
      expect(record.diagnosis.walkError).toMatch(/diagnosis budget \(1 s\) exhausted during the state walk/);
      expect(record.diagnosis.walkMs).toBeGreaterThanOrEqual(1000);
      // The DB-level facts still came through: the walk is the only casualty.
      expect(record.diagnosis).toEqual(expect.objectContaining({ journalMode: "wal", dbCount: 1 }));
      expect(record.diagnosis.stateBytes).toBeGreaterThan(0);
      // Fail-closed: the copy failed (archive) and the upstream ran ONCE, live.
      expect(backupCalls).toHaveLength(1);
      expect(record).toEqual(
        expect.objectContaining({
          producer: "openclaw",
          quiesced: true,
          quiescedAttempts: 0,
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            next: { rung: "live", reason: "prediction_unknown" },
          }),
        }),
      );
      expect(eventsOfType(harness.insertEvent, "backup_diagnosis")[0].details).toEqual(
        expect.objectContaining({ walk: "incomplete", predictedUpstreamMs: null, predictedOfflineCopyMs: null }),
      );
    });

    it("two calibration series, never mixed: the copy rate comes from the newest offline-copy run's offlineCopyBytes / offlineCopyMs, the upstream rate from the newest upstream run's attemptMs over its state bytes — junk cross-fields on either record are ignored", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({});
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      seedStateDb(harness);
      // Newest: an offline-copy run — 1 MB archive in 1 s (1 MB/s) — carrying
      // junk UPSTREAM fields that would predict ~0 ms if the upstream series
      // read them.
      const copyId = seedPriorOfflineCopyRun(harness, {
        offlineCopyMs: 1000,
        offlineCopyBytes: 1_000_000,
        startedAt: 3,
        extra: { attemptMs: 1, stateBytes: 1e9 },
      });
      // Older: an upstream run — 4 s for 2 MB of state — carrying junk COPY
      // fields that would predict ~0 ms if the copy series read them.
      const upstreamId = seedPriorUpstreamRun(harness, { attemptMs: 4000, stateBytes: 2_000_000, startedAt: 2 });
      harness.ledger.updateRun(upstreamId, (record) => {
        record.backup.offlineCopyMs = 1;
        record.backup.offlineCopyBytes = 1e9;
        return record;
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const diagnosis = readRunBackupRecord(harness).diagnosis;
      expect(diagnosis.walk).toBe("complete");
      expect(diagnosis.priorCopyRun).toEqual({ operationId: copyId, offlineCopyMs: 1000, offlineCopyBytes: 1_000_000 });
      expect(diagnosis.priorRun).toEqual({ operationId: upstreamId, attemptMs: 4000, stateBytes: 2_000_000 });
      expect(diagnosis.predictionSource).toEqual({ offlineCopy: "calibrated", upstream: "calibrated" });
      // Copy: the copy set at 1 MB/s, no per-file term (the calibration
      // carries this box's per-file cost).
      expect(diagnosis.predictedOfflineCopyMs).toBe(Math.round((diagnosis.copySetBytes / 1_000_000) * 1000));
      // Upstream: the prior CLI's rate over the state bytes it snapshotted,
      // applied to today's — attemptMs × (bytes / prior bytes).
      expect(diagnosis.predictedUpstreamMs).toBe(Math.round((4000 * diagnosis.stateBytes) / 2_000_000));
      // Neither read the other's junk (which would have predicted 0).
      expect(diagnosis.predictedOfflineCopyMs).toBeGreaterThan(0);
      expect(diagnosis.predictedUpstreamMs).toBeGreaterThan(0);
    });

    it("the phase envelope is stamped AFTER the diagnosis: a slow diagnosis costs the step's wall time, never the ladder's budgets", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({});
      let harness;
      // The diagnosis's ONE process sample costs a minute of the frozen clock —
      // a two-minute-budget walk of a big tree, in miniature.
      let samples = 0;
      const listProcesses = vi.fn(() => {
        samples += 1;
        if (samples === 1) harness.nowRef.now += 60_000;
        return [];
      });
      harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { phaseEnvelopeMs: 10_000, usableCheckReserveMs: 5_000 },
        backupProbes: { ...kQuietProbes, listProcesses },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      // The quiesce deadline (envelope − reserve) was sized from a clock that
      // started AFTER the diagnosis: the copy got its full 5 s, not the 1 ms
      // a pre-diagnosis stamp would have left it.
      const [started] = eventsOfType(harness.insertEvent, "backup_offline_copy");
      expect(started.details.budgetMs).toBe(5_000);
      const record = readRunBackupRecord(harness);
      expect(record.producer).toBe("alphaclaw-offline-copy");
      expect(record.verified).toBe(true);
      // The step's own wall time still counts the diagnosis — honest, not a budget.
      expect(record.durationMs).toBeGreaterThanOrEqual(60_000);
    });

    it("the live ladder consults the veto too: a rollback-journal DB over the self-deadlock size gets ONE live attempt and no retry after a retryable failure — the veto on the record, `backup_rung: skipped` on the events tab", async () => {
      const quiesce = makeQuiesceRecorder({});
      // Lease loss is lock_contention: retryable on the live ladder (1 retry)
      // — and the second scripted step WOULD succeed.
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kLeaseLostTail }, { ok: true }],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { rollbackJournalSelfDeadlockBytes: 1 },
      });
      seedStateDb(harness, { journalMode: "DELETE" });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(backupCalls).toHaveLength(1);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: true,
          attempts: 1,
          quiescedAttempts: 0,
          quiesced: true,
          upstreamVeto: "rollback_journal_self_deadlock",
          offlineCopy: expect.objectContaining({
            ok: false,
            stage: "archive",
            next: { rung: "live", reason: "rollback_journal_self_deadlock" },
          }),
        }),
      );
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.ok, a.kind])).toEqual([
        ["offline_copy", "primary", true, false, "offline_copy_failed"],
        ["upstream", "live_fallback", false, false, "lock_contention"],
      ]);
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [e.status, e.details.rung, e.details.reason]),
      ).toEqual([
        ["chosen", "offline_copy", "primary"],
        ["handed_over", "upstream", "rollback_journal_self_deadlock"],
        ["chosen", "upstream", "live_fallback"],
        ["skipped", "upstream", "rollback_journal_self_deadlock"],
      ]);
      // The live row says why there will be no retry.
      expect(lastStepDetail(harness, "backup", "running").detail).toBe(
        "live upstream attempt after a failed offline copy (archive) — last rung, no retry: the upstream snapshot is predicted to self-deadlock on this rollback-journal database",
      );
    });

    it("the plain live ladder (no quiesce seam — the bin/boot instance) honours the same veto: one attempt, no retry, upstreamVeto recorded", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kLeaseLostTail }, { ok: true }],
      });
      const harness = createHarness({ runnerImpl, backupTuning: { rollbackJournalSelfDeadlockBytes: 1 } });
      seedStateDb(harness, { journalMode: "DELETE" });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      await flushAsync();

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(1);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: true,
          quiesced: false,
          attempts: 1,
          upstreamVeto: "rollback_journal_self_deadlock",
        }),
      );
      expect(record.attemptsDetail.map((a) => a.reason)).toEqual(["live_ladder"]);
      expect(
        eventsOfType(harness.insertEvent, "backup_rung").map((e) => [e.status, e.details.reason]),
      ).toEqual([
        ["chosen", "live_ladder"],
        ["skipped", "rollback_journal_self_deadlock"],
      ]);
    });

    it("a DB that does not trip the veto is retried live as before (the veto, not the journal mode, gates the retry)", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: kLeaseLostTail }, { ok: true }],
      });
      const harness = createHarness({ runnerImpl });
      seedStateDb(harness, { journalMode: "DELETE" });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);

      expect(result.status).toBe(202);
      expect(backupCalls).toHaveLength(2);
      const record = readRunBackupRecord(harness);
      expect(record.upstreamVeto).toBeNull();
      expect(record.attemptsDetail.map((a) => a.reason)).toEqual(["live_ladder", "live_retry"]);
    });
  });

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
      // Copy fails at its archive step → the predicted-to-fit upstream times
      // out paused (#79: kQuiescedOutcomePolicy.timeout names the rung that
      // already ran → live ladder, capped at kOpenclawBackupLiveAttempts = 2
      // (#79 (f))): 3 CLI attempts, 1 paused.
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [
          { ok: false, timedOut: true, tail: "" },
          { ok: false, tail: kVanishedLockTail },
          { ok: false, tail: kVanishedLockTail },
        ],
        onArchiveTool: failCopyArchive,
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") harness.nowRef.now += 1000;
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(backupCalls).toHaveLength(3);
      expect(result.body.message).toMatch(/\(after 3 attempts, 1 with the gateway paused\)/);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({
          attempts: 3,
          quiescedAttempts: 1,
          quiesced: true,
          offlineCopy: expect.objectContaining({ ok: false, stage: "archive", reason: "primary" }),
        }),
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
          // The verified inode's content facts, same as a fresh publish
          // records — the rollback fence compares the disk against these
          // (a reused record without them was `unverifiable_content`).
          bytes: fs.statSync(seeded.file).size,
          mtimeMs: fs.statSync(seeded.file).mtimeMs,
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

    it("offline copy refused in-quiesce: the live ladder runs FIRST (it needs no exclusivity) and only its retryable failure opens the reuse gate — which re-verifies candidates strictly AFTER dbResume + start + release (gateway up, barrier released)", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeOfflineCopyRunner({
        // Both live attempts (attempt + the one lock_contention retry) lose
        // the lease: a retryable class, so the reuse gate may offer.
        script: [
          { ok: false, tail: kLeaseLostTail },
          { ok: false, tail: kLeaseLostTail },
        ],
        onBackupCall: () => quiesce.calls.push(isStateDbQuiet() ? "backup-cli(quiet)" : "backup-cli(live)"),
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
      // The 409 names the live failure it ended on AND the refusal that
      // preceded it.
      expect(result.body.message).toMatch(/lock/i);
      expect(result.body.message).toMatch(
        /The AlphaClaw offline copy of the paused state was refused first because state dir is not exclusively ours: 1 live openclaw process\(es\): 4242 \(openclaw gateway run\) — argv names an OpenClaw executable or entry script\.$/,
      );
      expect(result.body.reusableBackup).toEqual(
        expect.objectContaining({ file: seeded.file, sha256: seeded.sha256 }),
      );
      // The full fresh ladder ran before reuse was offered: the copy was
      // refused before any archive tool, then BOTH live attempts.
      expect(backupCalls).toHaveLength(2);
      const record = readRunBackupRecord(harness);
      expect(record.attemptsDetail.map((a) => [a.rung, a.reason, a.quiesced, a.kind])).toEqual([
        ["offline_copy", "primary", true, "offline_copy_refused"],
        ["upstream", "live_fallback", false, "lock_contention"],
        ["upstream", "live_retry", false, "lock_contention"],
      ]);
      // gzip -t / tar (the candidate re-verification) come strictly after the
      // quiesce unwound AND after the live attempts — never with the gateway
      // down and the barrier held.
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "dbResume",
        "start",
        "unsuppress",
        "release",
        "isRunning",
        "backup-cli(live)",
        "backup-cli(live)",
        "gzip:resumed",
        "tar:resumed",
      ]);
    });

    it("in-quiesce upstream success whose usable check TIMES OUT: the check runs quiesced, the reuse gate re-verifies candidates only AFTER dbResume + start + unsuppress + release", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: (opts) => {
          // The copy's archive step fails (so the predicted-to-fit upstream
          // runs paused); every other tool call is logged with the barrier state.
          if (opts.command === "tar" && opts.args[0] === "-I") {
            quiesce.calls.push(`offline-copy:${isStateDbQuiet() ? "quiet" : "resumed"}`);
            return failCopyArchive(opts);
          }
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
      armInQuiesceUpstream(harness);

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
        "offline-copy:quiet",
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
          if (opts.command === "tar" && opts.args[0] === "-I") {
            quiesce.calls.push(`offline-copy:${isStateDbQuiet() ? "quiet" : "resumed"}`);
            return failCopyArchive(opts);
          }
          quiesce.calls.push(`${opts.command}:${isStateDbQuiet() ? "quiet" : "resumed"}`);
          return null;
        },
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      armInQuiesceUpstream(harness);
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
        "offline-copy:quiet",
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
        expect.objectContaining({ verified: true, quiesced: true, usableCheck: "manifest_ok", producer: "openclaw" }),
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
          const copyFailure = failCopyArchive(opts);
          if (copyFailure) return copyFailure;
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
      // The paused upstream attempt (predicted to fit) burns the envelope.
      armInQuiesceUpstream(harness);
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

    it('a verified reusable backup satisfies the migrating hard gate without a no-backup waiver', async () => {
      const scripted = makeBackupRunner({ script: contentionScript });
      const harness = createHarness({
        runnerImpl: withPreflightVerdict(scripted.runnerImpl, {
          status: "migration-required",
          foundVersion: 12,
          targetVersion: 15,
        }),
      });
      seedStateDb(harness, { userVersion: 12 });
      const seeded = seedReusableArchive(harness);

      const result = await harness.sync.applyUpdate({
        ...kHardGateTarget,
        allowBackupReuse: { sha256: seeded.sha256 },
      });
      await flushAsync();

      expect(result.status).toBe(202);
      const record = readRunBackupRecord(harness);
      expect(record).toEqual(
        expect.objectContaining({
          noBackup: false,
          reused: true,
          file: seeded.file,
        }),
      );
      expect(record.noBackupConfirmed).toBeUndefined();
      expect(readNewestRunRecord(harness).dbPreflight.migrationRequired).toBe(true);
      expect(eventsOfType(harness.insertEvent, "backup_no_backup_consented")).toHaveLength(0);
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(1);
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

    it("reports an unreadable backups directory honestly (ENOTDIR: a file where the directory should be — a MISSING directory is the empty fresh-box state, see below)", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
      fs.writeFileSync(backupsDir, "not a directory\n");
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

  // ── Issue #79 (g) `.tmp` hygiene + (h) progress ──────────────────────────
  describe("backup debris sweep (#79 (g), Codex 18) and the progress ticker (#79 (h))", () => {
    const kMinute = 60_000;
    // The in-run age rule: the CLI ceiling plus slack — a `.tmp` younger than
    // that may belong to a run still writing. NOT the offline-copy budget.
    const kStaleTmpAgeMs = kOpenclawBackupTimeoutMs + kOpenclawBackupStaleTempDirSlackMs + kMinute;
    // Older than the offline-copy budget + slack (18 min) but younger than the
    // CLI ceiling + slack (20 min): a dir this old is stale, a `.tmp` is not.
    const kBetweenAgeMs = kOpenclawBackupOfflineCopyBudgetMs + kOpenclawBackupStaleTempDirSlackMs + kMinute;
    const staleTmpName = (tag) =>
      `openclaw-backup-${tag}.tar.gz.aaaaaaaa-0000-4000-8000-00000000000${tag.length % 10}.tmp`;
    // Every debris class at once, aged against `now`. Returns the basenames.
    const seedDebris = (backupsDir, now) => {
      fs.mkdirSync(backupsDir, { recursive: true });
      const at = (ageMs) => new Date(now - ageMs);
      const put = (name, content, ageMs) => {
        const full = path.join(backupsDir, name);
        fs.writeFileSync(full, content);
        fs.utimesSync(full, at(ageMs), at(ageMs));
        return name;
      };
      const mkdir = (name, ageMs) => {
        const full = path.join(backupsDir, name);
        fs.mkdirSync(full, { recursive: true });
        fs.utimesSync(full, at(ageMs), at(ageMs));
        return name;
      };
      const names = {
        freshTmp: put("openclaw-backup-900-fresh.tar.gz.aaaaaaaa-0000-4000-8000-000000000001.tmp", "x".repeat(4096), kMinute),
        betweenTmp: put(
          "openclaw-backup-850-between.alphaclaw.tar.gz.aaaaaaaa-0000-4000-8000-000000000003.tmp",
          "b".repeat(1024),
          kBetweenAgeMs,
        ),
        staleTmp: put(
          "openclaw-backup-800-stale.alphaclaw.tar.gz.aaaaaaaa-0000-4000-8000-000000000002.tmp",
          "y".repeat(8192),
          kStaleTmpAgeMs,
        ),
        newerUnverified: put("openclaw-backup-700-newer.tar.gz.unverified", "n".repeat(100), 2 * kMinute),
        olderUnverified: put("openclaw-backup-600-older.tar.gz.unverified", "o".repeat(200), 3 * kMinute),
        archive: put("openclaw-backup-500-keep.tar.gz", "archive\n", 4 * kMinute),
        note: put("operator-note.txt", "keep me\n", kStaleTmpAgeMs),
        staleDir: mkdir(`${kOfflineCopyTempDirPrefix}4242-deadbeef`, kBetweenAgeMs),
        freshDir: mkdir(`${kOfflineCopyTempDirPrefix}4243-cafef00d`, kMinute),
      };
      // A symlink whose NAME ends in .tmp: lstat only — never followed, never
      // removed, whatever it points at.
      fs.symlinkSync(path.join(backupsDir, names.archive), path.join(backupsDir, "link.tmp"));
      names.link = "link.tmp";
      return names;
    };
    const logLines = (logger) => logger.log.mock.calls.map(([line]) => String(line));
    const progressText = (line) => line.replace(/^.*? backup: /, "");
    const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // applyUpdate's finish() also calls complete/fail on the seam.
    const mkOperationEvents = () => ({ publish: vi.fn(), complete: vi.fn(), fail: vi.fn() });

    it("boot mode: EVERY .tmp regardless of age, every .unverified but the newest and the stale offline-copy dir go; the archive, the operator's file, the fresh dir and a .tmp-named symlink survive — the summary and ONE log line say what went", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const logger = mkLogger();
      const harness = createHarness({ runnerImpl, extraSyncOptions: { logger } });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);

      const summary = await harness.sync.sweepBackupDebris({ mode: "boot" });

      expect(fs.readdirSync(backupsDir).sort()).toEqual(
        [d.archive, d.link, d.freshDir, d.newerUnverified, d.note].sort(),
      );
      expect(summary.mode).toBe("boot");
      expect(summary.removed.map((entry) => [entry.name, entry.why]).sort()).toEqual(
        [
          [d.freshTmp, "boot"],
          [d.betweenTmp, "boot"],
          [d.staleTmp, "boot"],
          [d.olderUnverified, "unverified_superseded"],
          [d.staleDir, "stale_offline_copy_dir"],
        ].sort(),
      );
      expect(summary.removedBytes).toBe(4096 + 1024 + 8192 + 200);
      expect(summary.kept).toEqual([]);
      expect(summary.errors).toEqual([]);
      expect(logLines(logger).filter((line) => /backup debris sweep \(boot\): removed 5 items/.test(line))).toHaveLength(1);
      // Idempotent: nothing left to sweep, nothing logged.
      const again = await harness.sync.sweepBackupDebris({ mode: "boot" });
      expect(again.removed).toEqual([]);
      expect(logLines(logger).filter((line) => /backup debris sweep/.test(line))).toHaveLength(1);
    });

    it("in-run mode: only a .tmp older than the CLI ceiling + slack goes — a younger .tmp (even one older than the offline-copy budget + slack), every .unverified and the offline-copy dirs are untouched", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);

      const summary = await harness.sync.sweepBackupDebris({ mode: "in-run" });

      const survivors = fs.readdirSync(backupsDir).sort();
      expect(survivors).not.toContain(d.staleTmp);
      expect(survivors).toEqual(
        [d.freshTmp, d.betweenTmp, d.newerUnverified, d.olderUnverified, d.archive, d.note, d.staleDir, d.freshDir, d.link].sort(),
      );
      expect(summary).toEqual({
        mode: "in-run",
        removed: [{ name: d.staleTmp, bytes: 8192, why: "stale" }],
        removedBytes: 8192,
        kept: expect.arrayContaining([d.freshTmp, d.betweenTmp]),
        errors: [],
      });
      expect(summary.kept).toHaveLength(2);
    });

    it("a missing backups dir is the fresh-box state (empty summary, no error); an unknown mode is a programming error and throws", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      expect(fs.existsSync(backupsDir)).toBe(false);
      expect(await harness.sync.sweepBackupDebris({ mode: "boot" })).toEqual({
        mode: "boot",
        removed: [],
        removedBytes: 0,
        kept: [],
        errors: [],
      });
      expect(fs.existsSync(backupsDir)).toBe(false);
      await expect(harness.sync.sweepBackupDebris({ mode: "later" })).rejects.toThrow(/unknown mode "later"/);
      await expect(harness.sync.sweepBackupDebris()).rejects.toThrow(/unknown mode/);
    });

    it("the live ladder's failure finisher sweeps in-run: after a terminal 409 the stale .tmp is gone and the younger one is kept", async () => {
      const { runnerImpl, backupCalls } = makeBackupRunner({
        script: [{ ok: false, tail: "Error: ENOSPC no space left on device\n" }],
      });
      const harness = createHarness({ runnerImpl });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(backupCalls).toHaveLength(1);
      const survivors = fs.readdirSync(backupsDir);
      expect(survivors).not.toContain(d.staleTmp);
      expect(survivors).toContain(d.freshTmp);
      expect(survivors).toContain(d.betweenTmp);
      // In-run never touches the quarantines; the archive is still the
      // "newest surviving" one the 409 names.
      expect(survivors).toContain(d.olderUnverified);
      expect(survivors).toContain(d.newerUnverified);
      expect(result.body.hint).toMatch(new RegExp(d.archive.replace(/\./g, "\\.")));
    });

    it("a phantom artifact INSIDE the quiesce defers the sweep: the stale .tmp is still there at dbResume, start and release, and gone once the pause has unwound — the sweep never runs with the gateway paused", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        // Copy fails at its archive step → in-quiesce upstream (predicted to
        // fit) → exit 0 with NO artifact on a non-fresh tree → finishNoArtifact
        // runs paused.
        script: [{ ok: true, noArtifact: true }],
        onBackupCall: () => quiesce.calls.push("backup-cli"),
        onArchiveTool: composeHooks(markOfflineCopy(quiesce), failCopyArchive),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });
      harness.nowRef.now = kRealisticNow;
      armInQuiesceUpstream(harness);
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true });
      const staleTmp = path.join(backupsDir, staleTmpName("stale"));
      fs.writeFileSync(staleTmp, "z".repeat(2048));
      const staleAt = new Date(kRealisticNow - kStaleTmpAgeMs);
      fs.utimesSync(staleTmp, staleAt, staleAt);
      const presence = () => (fs.existsSync(staleTmp) ? "tmp-present" : "tmp-gone");
      quiesce.dbResume.mockImplementation((quiet) => {
        quiesce.calls.push(`dbResume(${presence()})`);
        quiet?.release?.();
      });
      quiesce.start.mockImplementation(async () => {
        quiesce.calls.push(`start(${presence()})`);
      });
      quiesce.releaseSpy.mockImplementation(() => quiesce.calls.push(`release(${presence()})`));

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/reported success but produced no backup file/);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "dbQuiet",
        "offline-copy(quiet)",
        "backup-cli",
        "dbResume(tmp-present)",
        "start(tmp-present)",
        "unsuppress",
        "release(tmp-present)",
      ]);
      expect(fs.existsSync(staleTmp)).toBe(false);
      expect(readRunBackupRecord(harness)).toEqual(
        expect.objectContaining({ noBackup: true, quiesced: true, quiescedAttempts: 1 }),
      );
    });

    it("progress (offline copy): one line per interval on the backup log and the SSE output stream, the live running row rewritten IN PLACE — steps[] does not grow, the output lands before the completed step", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl } = makeOfflineCopyRunner({});
      // Hold the copy's archive step long enough for several ticks.
      const slowRunner = async (opts) => {
        if (opts.command === "tar" && opts.args?.[0] === "-I") await sleep(80);
        return runnerImpl(opts);
      };
      const logger = mkLogger();
      const operationEvents = mkOperationEvents();
      const harness = createHarness({
        runnerImpl: slowRunner,
        gatewayQuiesce: quiesce,
        backupTuning: { progressIntervalMs: 5 },
        extraSyncOptions: { logger, operationEvents },
      });
      seedStateDb(harness);

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const progressLines = logLines(logger)
        .filter((line) => /AlphaClaw offline copy in progress \(gateway paused\)/.test(line))
        .map(progressText);
      expect(progressLines.length).toBeGreaterThanOrEqual(2);
      // Once the walk sized the copy set the line carries the copy's own
      // figures (bytes of total, percent, the copy's current stage — the
      // ticker outlives the slow archive step into the verify); the clock is
      // frozen.
      expect(progressLines[progressLines.length - 1]).toMatch(
        /^AlphaClaw offline copy in progress \(gateway paused\): \d+ KB of \d+ KB \(\d+%\), (archive|verify) — 0s elapsed$/,
      );
      expect(progressLines.some((line) => /\(\d+%\), archive — 0s elapsed$/.test(line))).toBe(true);
      // The SSE output pane carried the same text — flushed BEFORE the
      // completed step event that follows the rung.
      const events = operationEvents.publish.mock.calls.map(([, event]) => event);
      const outputText = events
        .filter((event) => event.event === "output")
        .map((event) => event.data.chunk)
        .join("");
      expect(outputText).toContain(progressLines[progressLines.length - 1]);
      const firstOutputIdx = events.findIndex((event) => event.event === "output");
      const completedIdx = events.findIndex(
        (event) => event.event === "step" && event.data.name === "backup" && event.data.status === "completed",
      );
      expect(firstOutputIdx).toBeGreaterThan(-1);
      expect(firstOutputIdx).toBeLessThan(completedIdx);
      // steps[]: still exactly [running, completed] — the running row's detail
      // IS the newest progress line, the completed row keeps its own wording.
      const steps = harness.store.readState().lastUpdateRun.steps.filter((s) => s.name === "backup");
      expect(steps.map((s) => s.status)).toEqual(["running", "completed"]);
      expect(steps[0].detail).toBe(progressLines[progressLines.length - 1]);
      expect(steps[1].detail).toBe("succeeded via AlphaClaw offline copy (gateway paused)");
      expect(readNewestRunRecord(harness).steps.filter((s) => s.name === "backup")).toHaveLength(2);
      // The rewritten row is republished as a `step` with the SAME `at` (the
      // client's collapsed model takes the latest detail per name).
      const runningEvents = events.filter(
        (event) => event.event === "step" && event.data.name === "backup" && event.data.status === "running",
      );
      expect(runningEvents.length).toBeGreaterThanOrEqual(2);
      expect(new Set(runningEvents.map((event) => event.data.at)).size).toBe(1);
    });

    it("progress (upstream CLI): the ticker reads the CLI's <output>.<uuid>.tmp staging file, the live row is rewritten in place, and the ticker stops with the attempt", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const logger = mkLogger();
      const harness = createHarness({
        runnerImpl,
        backupTuning: { progressIntervalMs: 5 },
        extraSyncOptions: { logger },
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          const out = opts.args[opts.args.indexOf("--output") + 1];
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const staging = `${out}.11111111-2222-4333-8444-555555555555.tmp`;
          fs.writeFileSync(staging, "s".repeat(3_000_000));
          await sleep(60);
          fs.renameSync(staging, out);
          return { ok: true, code: 0, tail: "Archive verification: passed\n", timedOut: false };
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      const progressLines = logLines(logger)
        .filter((line) => /upstream backup create in progress/.test(line))
        .map(progressText);
      expect(progressLines.length).toBeGreaterThanOrEqual(2);
      // Live (no pause marker), sized from the staging file, frozen clock.
      expect(progressLines[0]).toBe("upstream backup create in progress: 3 MB written so far — no output yet — 0s elapsed");
      const steps = harness.store.readState().lastUpdateRun.steps.filter((s) => s.name === "backup");
      expect(steps.map((s) => s.status)).toEqual(["running", "completed"]);
      expect(steps[0].detail).toMatch(/^upstream backup create in progress: 3 MB written so far/);
      // Stopped with the attempt: no line is added after the apply settled.
      const count = progressLines.length;
      await sleep(30);
      expect(logLines(logger).filter((line) => /in progress/.test(line))).toHaveLength(count);
    });

    it("updateDetail rewrites only a RUNNING row of the same name: a soft gate's busy-lock warning row keeps its wording while the live attempt's progress still logs", async () => {
      const quiesce = makeQuiesceRecorder({ acquireNever: true });
      const { runnerImpl } = makeBackupRunner({});
      const logger = mkLogger();
      const harness = createHarness({
        runnerImpl,
        gatewayQuiesce: quiesce,
        backupTuning: { progressIntervalMs: 5 },
        extraSyncOptions: { logger },
      });
      harness.runner.runStreamed.mockImplementation(async (opts) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          await sleep(40);
        }
        return runnerImpl(opts);
      });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);

      expect(result.status).toBe(202);
      expect(logLines(logger).filter((line) => /upstream backup create in progress/.test(line)).length).toBeGreaterThanOrEqual(1);
      const steps = harness.store.readState().lastUpdateRun.steps.filter((s) => s.name === "backup");
      expect(steps.map((s) => s.status)).toEqual(["running", "warning", "completed"]);
      // The warning is an OUTCOME row: never a canvas for a progress line.
      expect(steps[1].detail).toBe(
        "could not pause the gateway (another gateway operation is in progress) — live backup attempts instead",
      );
      // And the initial running row (D1a: a soft gate announces the pause too)
      // was not reached over the warning either.
      expect(steps[0].detail).toBe(
        "pausing the gateway for a consistent backup (AlphaClaw offline copy first)",
      );
    });

    it("pruneBackups folds the .tmp/.unverified debris into the advisory budget warning (the kept archives alone read within budget), sweeps the temps and keeps the newest quarantine", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const logger = mkLogger();
      const harness = createHarness({
        runnerImpl,
        extraSyncOptions: { logger, readBackupBudgetBytes: () => 1024 },
      });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);

      const result = await harness.sync.applyUpdate(kSoftGateTarget);

      expect(result.status).toBe(202);
      const warnings = logLines(logger).filter((line) => /backup retention warning/.test(line));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /kept archives use 0GB plus 0GB of \.tmp\/\.unverified debris \(temps swept now; the newest \.unverified is kept for diagnosis\) of the 0GB disk budget/,
      );
      const survivors = fs.readdirSync(backupsDir);
      expect(survivors.filter((name) => name.endsWith(".tmp") && !name.startsWith("link"))).toEqual([]);
      expect(survivors).toContain(d.newerUnverified);
      expect(survivors).not.toContain(d.olderUnverified);
    });

    it("pruneBackups: no debris and kept archives inside the budget → no warning (the fold never invents one)", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const logger = mkLogger();
      const harness = createHarness({
        runnerImpl,
        extraSyncOptions: { logger, readBackupBudgetBytes: () => 1024 },
      });

      const result = await harness.sync.applyUpdate(kSoftGateTarget);

      expect(result.status).toBe(202);
      expect(logLines(logger).filter((line) => /backup retention warning/.test(line))).toEqual([]);
    });

    it("describeBackupProgress: the one line every surface carries — rung label, pause marker, bytes-of-total with percent or bytes-so-far, stage, elapsed (never over 100%)", () => {
      expect(
        describeBackupProgress({
          rung: "offline_copy",
          quiesced: true,
          elapsedMs: 65_000,
          doneBytes: 120e6,
          totalBytes: 900e6,
          stage: "sqlite_backup",
        }),
      ).toBe("AlphaClaw offline copy in progress (gateway paused): 120 MB of 900 MB (13%), sqlite backup — 1m 5s elapsed");
      expect(describeBackupProgress({ rung: "upstream", elapsedMs: 45_000, doneBytes: 1.2e9 })).toBe(
        "upstream backup create in progress: 1.2 GB written so far — 45s elapsed",
      );
      expect(describeBackupProgress({ rung: "upstream", quiesced: true, elapsedMs: 0 })).toBe(
        "upstream backup create in progress (gateway paused): nothing written yet — 0s elapsed",
      );
      expect(describeBackupProgress({ rung: "offline_copy", quiesced: true, elapsedMs: 3000 })).toBe(
        "AlphaClaw offline copy in progress (gateway paused): sizing the copy set — 3s elapsed",
      );
      expect(describeBackupProgress({ rung: "offline_copy", doneBytes: 10, totalBytes: 5 })).toMatch(/\(100%\)/);
      expect(describeBackupProgress({ rung: "offline_copy", doneBytes: 512, totalBytes: 0 })).toMatch(
        /1 KB written so far/,
      );
      expect(kDefaultBackupBudget.progressIntervalMs).toBe(15_000);
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

    it("a backups directory that does not exist yet is an EMPTY inventory (readable) — a fresh box says 'No backups yet', never 'Couldn't read backups'", () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.rmSync(backupsDir, { recursive: true, force: true });
      expect(fs.existsSync(backupsDir)).toBe(false);

      const inventory = harness.sync.listBackupInventory();

      expect(inventory).toEqual(
        expect.objectContaining({ readable: true, entries: [], truncated: false, newestArchive: null }),
      );
      // A path that exists but cannot be read as a directory stays unreadable.
      fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
      fs.writeFileSync(backupsDir, "not a directory\n");
      expect(harness.sync.listBackupInventory().readable).toBe(false);
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
