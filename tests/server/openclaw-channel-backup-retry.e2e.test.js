const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { listLiveOpenclawProcesses } = require("../../lib/server/openclaw-lock-contention");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy, kGatewayMutationIntents } = require("../../lib/server/gateway-mutation-policy");
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
  verifyArchiveManifest,
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
  kOpenclawBackupQuiesceLeaseReserveMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
  kOpenclawBackupStaleTempDirSlackMs,
  kOpenclawStateDbQuietSlackMs,
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
const failCheckpointWrite = (error, onWrite = () => {}) => ({
  ...fs,
  openSync(file, flags, ...rest) {
    if (flags === "wx" && String(file).includes(".staging")) {
      onWrite(file);
      throw error;
    }
    return fs.openSync(file, flags, ...rest);
  },
});


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

// The harness clock starts at 1,000,000 ms (16 minutes after the epoch);
// age-based fixtures (reuse window, pin age) need a realistic "now".
const kRealisticNow = Date.parse("2026-09-02T12:00:00.000Z");

// A real state DB in the harness's state dir so the offline copy has
// something to snapshot (and the usable check something to require).
// `userVersion` stamps the schema line the db-preflight's own PRAGMA read
// reports beside the target CLI's verdict (a mismatch is one warning row).
const seedStateDb = (harness, { journalMode = "WAL", rows = 5, userVersion = 15 } = {}) => {
  const file = path.join(harness.openclawDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT)");
  for (let i = 0; i < rows; i += 1) db.exec(`INSERT INTO t VALUES (${i})`);
  if (Number.isInteger(userVersion)) db.exec(`PRAGMA user_version = ${userVersion}`);
  db.prepare("INSERT INTO schema_meta(meta_key, role, schema_version, agent_id) VALUES ('primary', 'global', ?, NULL)").run(Number.isInteger(userVersion) ? userVersion : 0);
  db.close();
  return file;
};
// An agent DB at an explicit schema line — judged by the db-preflight's agent
// arm (PRAGMA user_version vs the target's declared agent schema), never by
// the state-schema verb (#78).
const seedAgentDb = (harness, agentId, { userVersion = 17 } = {}) => {
  const file = path.join(harness.openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT)");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.prepare("INSERT INTO schema_meta(meta_key, role, schema_version, agent_id) VALUES ('primary', 'agent', ?, ?)").run(userVersion, agentId);
  db.close();
  return file;
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


const sha256Of = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");


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
  // v0.9.81: a REAL gateway lifecycle lock — the hold handed back is then the
  // lock's own (kind "backup_quiesce", as lib/server.js wires it), which a
  // mutation policy built over the same lock can judge (`owns`). The
  // recorder cannot log "release" for a real hold (identity is ownership);
  // assert lock.getActiveOperation() === null instead.
  lock = createGatewayLifecycleLock({ logger: kSilentLogger }),
} = {}) => {
  const releaseSpy = vi.fn(() => calls.push("release"));
  const recorder = {
    lock,
    calls,
    releaseSpy,
    acquireLock: vi.fn(async (options) => {
      calls.push("acquireLock");
      recorder.acquireOptions = options;
      if (acquireReject) throw new Error("lock unavailable");
      if (acquireNever) await new Promise(() => {});
      if (acquireDelayMs) await sleep(acquireDelayMs);
      if (lock) return lock.acquire(recorder.acquireKind || "backup_quiesce", options);
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
    probeReadiness: vi.fn(async () => ({ ok: false, kind: "unsupported" })),
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
  upstreamCleanupReserveMs: 10,
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
  gatewayQuiesce = makeQuiesceRecorder(),
  backupTuning = {},
  backupProbes = kQuietProbes,
  extraSyncOptions = {},
  // Declared schema constants written into every downloaded TARGET fixture
  // ({ state, agent }) — what the db-preflight judges agent DBs against.
  targetSchema = { state: 15, agent: 17 },
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-backup-retry-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "main" }] } }));
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
    ...(gatewayQuiesce ? {
      acquireLifecycleLock: (kind, options) => {
        gatewayQuiesce.acquireKind = kind;
        return gatewayQuiesce.acquireLock(options);
      },
      gatewayMutationPolicy: createGatewayMutationPolicy({ lock: gatewayQuiesce.lock,
        getChannelInfo: () => sync.getChannelInfo(), isApplyInProgress: () => sync.isApplyInProgress() }),
    } : {}),
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

describe("server/openclaw-channel-backup-retry", () => {
  beforeEach(() => {
    resetStateDbQuietForTests({ listeners: true });
    delete process.env.OPENCLAW_STATE_DB_QUIET;
  });

  describe("quiesce-first (gatewayQuiesce injected — bounded recovery checkpoints)", () => {
  const writingFs = (onPayload) => ({ ...fs, openSync(file, flags, ...args) {
    if (flags === "wx" && String(file).includes(`${path.sep}payload${path.sep}`)) onPayload(file);
    return fs.openSync(file, flags, ...args);
  } });

  it("owns one pause, copies selected configuration while quiet, then resumes before relaunch and releases", async () => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: writingFs(() => {
        expect(isStateDbQuiet()).toBe(true);
        expect(quiesce.lock.getActiveOperation().kind).toBe("backup_quiesce");
        quiesce.calls.push("checkpoint");
      }) } });
    seedStateDb(harness);
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(quiesce.calls).toEqual(["acquireLock", "isRunning", "suppress", "stop", "dbQuiet", "checkpoint", "dbResume", "start", "isRunning", "unsuppress"]);
    expect(result.body.recovery).toMatchObject({ kind: "config_only", databases: { complete: false, entries: [] } });
    expect(fs.readFileSync(path.join(result.body.recovery.file, "payload/openclaw.json"), "utf8"))
      .toBe(fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"));
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    expect(quiesce.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("bounds the quiet token and watchdog suppression to the owned checkpoint lease, not retired full-copy budgets", async () => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      backupTuning: { quiesceTimeoutMs: 20 * 60_000, offlineCopyBudgetMs: 12 * 60_000 } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(200);
    expect(quiesce.acquireOptions).toEqual({ leaseMs: 15 * 60_000 });
    expect(quiesce.dbQuietOptions).toMatchObject({ owner: "recovery-checkpoint", maxMs: 15 * 60_000 });
    expect(quiesce.suppressDurationMs).toBe(15 * 60_000 + 30_000);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("refuses an expired configuration capture budget before publication and cleans only its own staging", async () => {
    let harness;
    const quiesce = makeQuiesceRecorder();
    harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: writingFs(() => { harness.nowRef.now += 10_000; }) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_BUDGET");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(fs.readdirSync(path.join(harness.rootDir, "backups/openclaw"))).toEqual([]);
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("verifies a completed config payload even near the bounded deadline rather than fabricating success", async () => {
    let harness;
    harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: writingFs(() => { harness.nowRef.now += 9_999; }) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const { readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
    const verified = await readRecoveryCheckpoint(result.body.recovery.file);
    expect(verified.checkpoint.manifestSha256).toBe(result.body.recovery.checkpoint.manifestSha256);
    expect(verified.databases.entries).toEqual([]);
  });

  it("does not stop or relaunch a gateway that was not running when ownership was acquired", async () => {
    const quiesce = makeQuiesceRecorder({ isRunning: false });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    seedStateDb(harness);
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(200);
    expect(result.body.recovery.databases.complete).toBe(true);
    expect(quiesce.stop).not.toHaveBeenCalled();
    expect(quiesce.start).not.toHaveBeenCalled();
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("refuses capture when the gateway will not release the port and restores its previous serving state", async () => {
    const quiesce = makeQuiesceRecorder({ stopResult: false });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("gateway_stop_unconfirmed");
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(quiesce.dbQuiet).not.toHaveBeenCalled();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("unwinds a throwing stop without running a live backup or leaving the apply latch held", async () => {
    const quiesce = makeQuiesceRecorder({ stopThrows: true });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("stop exploded");
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(quiesce.dbQuiet).not.toHaveBeenCalled();
    expect(harness.sync.isApplyInProgress()).toBe(false);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("bounds lifecycle-lock waiting and self-releases an acquisition that arrives after refusal", async () => {
    const quiesce = makeQuiesceRecorder({ acquireDelayMs: 120 });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      backupTuning: { quiesceLockTimeoutMs: 15 } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(quiesce.stop).not.toHaveBeenCalled();
    await sleep(150);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
    expect(harness.sync.isApplyInProgress()).toBe(false);
  });

  it("refuses a rejected lifecycle acquisition without pausing or silently degrading protection", async () => {
    const quiesce = makeQuiesceRecorder({ acquireReject: true });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("lock unavailable");
    expect(quiesce.stop).not.toHaveBeenCalled();
    expect(readNewestRunRecord(harness).state).toBe("failed");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });

  it("detects an exogenous writer replacing a captured config file and refuses mixed-time recovery", async () => {
    let harness;
    harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: writingFs(() => fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), '{"changed":true}')) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_SOURCE_CHANGED");
    expect(fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8")).toBe('{"changed":true}');
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(isStateDbQuiet()).toBe(false);
  });

  it("exhausts the explicit database-set deadline without a second pause or fallback archive", async () => {
    let harness;
    const quiesce = makeQuiesceRecorder();
    harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: writingFs(() => { harness.nowRef.now += 8 * 60_000; }) } });
    seedStateDb(harness);
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_BUDGET");
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("terminates an actual checkpoint ENOSPC failure and resumes before reporting failure", async () => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("ENOSPC");
    expect(quiesce.calls.indexOf("dbResume")).toBeLessThan(quiesce.calls.indexOf("start"));
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(result.body.backupRiskEligible).not.toBe(true);
  });

  it("does not discover workspace contents or retry them when capturing supported configuration", async () => {
    const fsModule = { ...fs, opendirSync(directory, ...args) {
      if (String(directory).endsWith("workspace")) throw new Error("workspace discovery is forbidden");
      return fs.opendirSync(directory, ...args);
    } };
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, extraSyncOptions: { fsModule } });
    fs.mkdirSync(path.join(harness.openclawDir, "workspace"));
    fs.writeFileSync(path.join(harness.openclawDir, "workspace", "large-history"), "not captured");
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(200);
    expect(result.body.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
    expect(result.body.recovery.checkpoint.bytes).toBe(fs.statSync(path.join(harness.openclawDir, "openclaw.json")).size);
    expect(fs.readFileSync(path.join(harness.openclawDir, "workspace", "large-history"), "utf8")).toBe("not captured");
  });

  it("never doubles a failed checkpoint pause to retry an expired operation", async () => {
    const writes = vi.fn();
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("expired capture"), { code: "CHECKPOINT_BUDGET" }), writes) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(writes).toHaveBeenCalledOnce();
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(harness.ledger.readRun(result.body.operationId).result.code).toBe("CHECKPOINT_BUDGET");
  });

  it("bounds the configuration phase even when the operator explicitly selects a database-set snapshot", async () => {
    for (const recoveryMode of ["config_only", "database_set"]) {
      let harness;
      harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
        extraSyncOptions: { fsModule: writingFs(() => { harness.nowRef.now += 10_001; }) } });
      seedStateDb(harness);
      const result = await harness.sync.runStandaloneBackup({ recoveryMode });
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe("CHECKPOINT_BUDGET");
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(isStateDbQuiet()).toBe(false);
    }
  });

  it("contains a late lock-acquisition rejection without leaking an unhandled rejection", async () => {
    const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const quiesce = makeQuiesceRecorder();
      quiesce.acquireLock.mockImplementation(async () => { await sleep(80); throw new Error("late acquire rejection"); });
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
        backupTuning: { quiesceLockTimeoutMs: 15 } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.body.ok).toBe(false);
      await sleep(100);
      expect(unhandled).toEqual([]);
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(harness.sync.isApplyInProgress()).toBe(false);
    } finally { process.off("unhandledRejection", listener); }
  });

  it("surfaces a failed gateway relaunch separately from a completed checkpoint and releases only its resources", async () => {
    const quiesce = makeQuiesceRecorder({ startThrows: true });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("relaunch exploded");
    expect(quiesce.calls.indexOf("dbResume")).toBeLessThan(quiesce.calls.indexOf("start"));
    expect(quiesce.unsuppress).toHaveBeenCalledOnce();
    expect(quiesce.lock.getActiveOperation()).toBeNull();
    expect(harness.sync.isApplyInProgress()).toBe(false);
    expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
  });
});

  describe("live-retry ladder retired: checkpoint retry safety", () => {
  it("a user retry after a vanished payload creates a fresh checkpoint without reusing failed staging", async () => {
    let fail = true;
    const files = [];
    const fsModule = { ...fs, openSync(file, flags, ...args) {
      if (flags === "wx" && String(file).includes(".staging")) {
        files.push(file);
        if (fail) throw Object.assign(new Error("ENOENT: selected config vanished"), { code: "ENOENT" });
      }
      return fs.openSync(file, flags, ...args);
    } };
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, extraSyncOptions: { fsModule } });
    const failed = await harness.sync.runStandaloneBackup();
    fail = false;
    harness.nowRef.now++;
    const retried = await harness.sync.runStandaloneBackup();
    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(failed.body.operationId).not.toBe(retried.body.operationId);
    expect(files[0].split(".staging")[0]).not.toBe(files[1].split(".staging")[0]);
    expect(harness.sync.listBackupInventory().entries).toHaveLength(1);
    expect(harness.ledger.readRun(failed.body.operationId).state).toBe("failed");
  });

  it("persistent source races fail each explicit attempt without silently rerunning the capture", async () => {
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("ENOENT: openclaw.json"), { code: "ENOENT" }), writes) } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(500);
      expect(result.body.message).toContain("openclaw.json");
      expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
    }
    expect(writes).toHaveBeenCalledTimes(2);
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });

  it("ENOSPC is terminal for the current capture and leaves original configuration untouched", async () => {
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }), writes) } });
    const original = fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"));
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(writes).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"))).toEqual(original);
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(result.body.backupRiskEligible).not.toBe(true);
  });

  it("an instance without a quiesce owner refuses recovery instead of copying live state", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: null });
    seedStateDb(harness);
    const before = fs.readFileSync(path.join(harness.openclawDir, "state/openclaw.sqlite"));
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("recovery_ownership_unavailable");
    expect(fs.readFileSync(path.join(harness.openclawDir, "state/openclaw.sqlite"))).toEqual(before);
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("an exhausted checkpoint deadline cannot be extended by retrying the former live path", async () => {
    const writes = vi.fn();
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("capture deadline"), { code: "CHECKPOINT_BUDGET" }), writes) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_BUDGET");
    expect(writes).toHaveBeenCalledOnce();
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(harness.ledger.readRun(result.body.operationId).recovery).toBeUndefined();
  });

  it("failed capture cleanup preserves historical archives and unrelated staging directories", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(new Error("write interrupted")) } });
    const directory = path.join(harness.rootDir, "backups/openclaw");
    fs.mkdirSync(path.join(directory, ".operator-staging"), { recursive: true });
    const legacy = path.join(directory, "openclaw-backup-1-legacy00.tar.gz");
    fs.writeFileSync(legacy, "historical archive");
    fs.writeFileSync(path.join(directory, ".operator-staging/partial"), "another operation");
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(fs.readFileSync(legacy, "utf8")).toBe("historical archive");
    expect(fs.readFileSync(path.join(directory, ".operator-staging/partial"), "utf8")).toBe("another operation");
    expect(fs.readdirSync(directory).sort()).toEqual([".operator-staging", path.basename(legacy)].sort());
  });
});

  // ── Issue #79 (c), decision D1a: soft gates quiesce too ──────────────────
  describe("same-channel recovery keeps the ownership and quiet gates", () => {
  it("same-channel apply checkpoints config under one owned pause and leaves database contents untouched", async () => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const database = seedStateDb(harness);
    const original = fs.readFileSync(database);
    const result = await harness.sync.applyUpdate(kSoftGateTarget);
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(harness.ledger.readRun(result.body.operationId).recovery.kind).toBe("config_only");
    expect(harness.ledger.readRun(result.body.operationId).recovery.databases.entries).toEqual([]);
    expect(fs.readFileSync(database)).toEqual(original);
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).not.toHaveBeenCalled();
    expect(quiesce.lock.getActiveOperation().kind).toBe("apply_commit");
  });

  it("a failed same-channel checkpoint never softens to an unprotected activation", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("capture failed"), { code: "CHECKPOINT_SOURCE_CHANGED" })) } });
    const result = await harness.sync.applyUpdate(kSoftGateTarget);
    expect(result.status).toBe(409);
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.restartProcess).not.toHaveBeenCalled();
    expect(readNewestRunRecord(harness).state).toBe("failed");
    expect(result.body.backupRiskEligible).not.toBe(true);
  });

  it("a competing lifecycle owner prevents same-channel apply before preparation or pause", async () => {
    const quiesce = makeQuiesceRecorder();
    const owner = await quiesce.lock.acquire("boot");
    try {
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
        extraSyncOptions: { getActiveGatewayOperation: quiesce.lock.getActiveOperation } });
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("gateway_busy");
      expect(harness.installToTempDir).not.toHaveBeenCalled();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.lock.owns(owner)).toBe(true);
    } finally { owner(); }
  });

  it("an existing quiet owner is preserved when same-channel apply cannot obtain the barrier", async () => {
    const owner = await beginStateDbQuiet({ owner: "other-backup", maxMs: 60_000 });
    const quiesce = makeQuiesceRecorder({ dbQuietThrows: true });
    try {
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result.status).toBe(409);
      expect(harness.store.readState().applied).toBeNull();
      expect(quiesce.dbResume).not.toHaveBeenCalled();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(isStateDbQuiet()).toBe(true);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    } finally { owner.release(); }
  });

  it("a foreign operation taking the lease during stop cannot authorize the old apply to capture or relaunch", async () => {
    const quiesce = makeQuiesceRecorder();
    let held, successor;
    const acquire = quiesce.acquireLock.getMockImplementation();
    quiesce.acquireLock.mockImplementation(async (options) => { held = await acquire(options); return held; });
    quiesce.stop.mockImplementation(async () => { held(); successor = await quiesce.lock.acquire("operator_successor"); return true; });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    try {
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result.status).toBe(409);
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(quiesce.dbQuiet).not.toHaveBeenCalled();
      expect(quiesce.lock.owns(successor)).toBe(true);
      expect(harness.store.readState().applied).toBeNull();
    } finally { successor?.(); }
  });

  it("persistent ownership refusal cannot be waived by a same-channel warning or an earlier verified archive", async () => {
    const quiesce = makeQuiesceRecorder({ stopResult: false });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const file = path.join(harness.rootDir, "backups/openclaw/openclaw-backup-1-old00000.tar.gz");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "legacy");
    harness.store.updateState((state) => ({ ...state, backups: [{ file, verified: true, at: harness.nowRef.now }] }));
    const result = await harness.sync.applyUpdate(kSoftGateTarget);
    expect(result.status).toBe(409);
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.restartProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("legacy");
    expect(result.body.reusableBackup).toBeUndefined();
  });

  it("a beta apply respects the same competing lifecycle owner instead of using a different backup gate", async () => {
    const quiesce = makeQuiesceRecorder();
    const owner = await quiesce.lock.acquire("restart");
    try {
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
        extraSyncOptions: { getActiveGatewayOperation: quiesce.lock.getActiveOperation } });
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("gateway_operation_in_progress");
      expect(harness.installToTempDir).not.toHaveBeenCalled();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.lock.owns(owner)).toBe(true);
    } finally { owner(); }
  });
});

  // ── #79 (a): the gate predicate is the SHARED crossesChannelBoundary ──────
  describe("gate predicate: shared crossesChannelBoundary over the PERSISTED applied channel (#79 (a), Codex 19)", () => {
    const { crossesChannelBoundary } = require("../../lib/channel-boundary");
    const boundaryFor = (harness, target) => crossesChannelBoundary({
      installedVersion: harness.sync.getChannelInfo().installedVersion,
      currentChannel: harness.store.readState().applied?.channel ?? "stable",
      targetChannel: target.channel,
      targetVersion: target.version,
    });
    const createBetaBox = (channel) => {
      const harness = createHarness({ channel, installedVersion: "1.0.0-beta.1", sentinelVersion: "1.0.0-beta.1" });
      harness.store.updateState((state) => {
        state.applied = { channel: "beta", version: "1.0.0-beta.1", at: 1, acceptedAt: 1 };
        return state;
      });
      return harness;
    };

    it("beta→stable crosses the persisted channel boundary even after the catalog selection changes to stable", () => {
      const harness = createBetaBox("stable");
      expect(boundaryFor(harness, kSoftGateTarget)).toBe(true);
      expect(harness.store.readState().applied.channel).toBe("beta");
    });

    it("the selection alone never creates a boundary for a stable-pin box applying stable", () => {
      const harness = createHarness({ channel: "beta" });
      expect(boundaryFor(harness, kSoftGateTarget)).toBe(false);
      expect(harness.store.readState().applied).toBeNull();
    });

    it("prerelease→base on the same beta channel crosses the version boundary", () => {
      expect(boundaryFor(createBetaBox("beta"), { channel: "beta", version: "1.1.0" })).toBe(true);
    });

    it("prerelease→prerelease on beta is not a channel boundary", () => {
      expect(boundaryFor(createBetaBox("beta"), kHardGateTarget)).toBe(false);
    });
  });

  // ── #79 (b): post-preflight checkpoint + confirmNoBackup ─────────────────
  describe("post-preflight backup checkpoint + confirmNoBackup (#79 (b), Eng 2D, Codex 20)", () => {
    const kConsentSession = "human-test-session";
    const createMigratingBox = ({
      sameSchema = false,
      agentUserVersion = 17,
      gatewayQuiesce = makeQuiesceRecorder(),
      extraSyncOptions = {},
    } = {}) => {
      const scripted = makeBackupRunner();
      const harness = createHarness({
        runnerImpl: scripted.runnerImpl,
        targetSchema: sameSchema ? { state: 15, agent: 17 } : { state: 16, agent: 19 },
        gatewayQuiesce,
        extraSyncOptions,
      });
      seedStateDb(harness, { userVersion: 15 });
      if (agentUserVersion !== null) seedAgentDb(harness, "main", { userVersion: agentUserVersion });
      return { harness, quiesce: gatewayQuiesce, backupCalls: scripted.backupCalls };
    };
    const approveFailedApply = async (harness, target = kSoftGateTarget) => {
      const failed = await harness.sync.applyUpdate({ ...target, consentSessionId: kConsentSession });
      expect(failed).toMatchObject({ status: 409, body: { code: "recovery_choice_required", backupRiskEligible: true } });
      const issued = await harness.sync.requestBackupRiskConsent({ operationId: failed.body.operationId, consentSessionId: kConsentSession });
      expect(issued.status).toBe(200);
      harness.nowRef.now += 1;
      return { ...target, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession };
    };
    const readRecovery = (harness, result) => harness.ledger.readRun(result.body.operationId).recovery;

    it("migration requires an explicit recovery choice before pause or activation and records both schema lines", async () => {
      const { harness, quiesce, backupCalls } = createMigratingBox();
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result).toMatchObject({ status: 409, body: {
        code: "recovery_choice_required", choices: ["database_set", "cancel"],
        coverage: { config: "complete", databases: "omitted" },
        preflight: { migrationRequired: true, byKind: {
          state: { foundVersion: 15, targetVersion: 16 },
          agent: { foundVersion: 17, targetVersion: 19 },
        } },
      } });
      expect(result.body.hint).toContain("does not restore database contents");
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record).toMatchObject({ state: "failed", result: { code: "recovery_choice_required" }, dbPreflight: { migrationRequired: true } });
      expect(record.recovery?.checkpoint).toBeUndefined();
      expect(harness.store.readState().applied).toBeNull();
      expect(quiesce.acquireLock).not.toHaveBeenCalled();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(backupCalls).toHaveLength(0);
      await flushAsync();
      expect(notifyMessages(harness.notify).some((message) => /update to 1\.1\.0 failed/.test(message) && /recovery/.test(message))).toBe(true);
    });

    it("bound human consent records forward-only coverage and its approval, then names the migration risk in acceptance", async () => {
      const { harness, quiesce, backupCalls } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record.recovery).toMatchObject({ kind: "forward_only", checkpoint: { verified: true },
        databases: { complete: false, verified: false, entries: [] },
        consent: { required: true, recorded: true, approvalId: expect.any(String) },
        restore: { configAvailable: true, databaseSetAvailable: false } });
      expect(record.recoveryIntent).toMatchObject({ approved: true, migrationRequired: true });
      expect(record.dbPreflight.migrationRequired).toBe(true);
      expect(fs.existsSync(path.join(record.recovery.file, "payload/openclaw.json"))).toBe(true);
      expect(fs.existsSync(path.join(record.recovery.file, "payload/state/openclaw.sqlite"))).toBe(false);
      expect(quiesce.lock.getActiveOperation().kind).toBe("apply_commit");
      expect(isStateDbQuiet()).toBe(true);
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(backupCalls).toHaveLength(0);
      expect(harness.store.readState().applied.version).toBe("1.1.0");
      harness.sync.markGoodNow({ source: "acceptance" });
      await flushAsync();
      expect(notifyMessages(harness.notify).find((message) => /is healthy — activation verified/.test(message))).toContain("the database was migrated and there is no rollback path to the previous build");
    });

    it("a bare consent flag is rejected before preparation while ordinary applies capture only config unless database_set is explicit", async () => {
      const exact = createMigratingBox({ sameSchema: true });
      const refused = await exact.harness.sync.applyUpdate({ ...kSoftGateTarget, confirmNoBackup: true });
      expect(refused).toMatchObject({ status: 409, body: { code: "backup_consent_required" } });
      expect(exact.harness.installToTempDir).not.toHaveBeenCalled();
      const ordinary = await exact.harness.sync.applyUpdate(kSoftGateTarget);
      expect(ordinary.status).toBe(202);
      expect(readRecovery(exact.harness, ordinary)).toMatchObject({ kind: "config_only", checkpoint: { verified: true },
        databases: { complete: false, entries: [] }, consent: { required: false, recorded: false } });
      resetStateDbQuietForTests({ listeners: true });
      const explicit = createMigratingBox({ agentUserVersion: null });
      const protectedApply = await explicit.harness.sync.applyUpdate({ ...kSoftGateTarget, recoveryMode: "database_set" });
      expect(protectedApply.status).toBe(202);
      expect(readRecovery(explicit.harness, protectedApply)).toMatchObject({ kind: "database_set", checkpoint: { verified: true },
        databases: { complete: true, verified: true, entries: [expect.objectContaining({ dbKind: "state", userVersion: 15 })] },
        consent: { required: false, recorded: false } });
    });

    it.each(["backed-up write", "schema change", "consented write"])("rechecks queued %s with the appropriate admission facts", async (scenario) => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness, writer, lease;
      const quiesce = makeQuiesceRecorder({ lock });
      const acquire = async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        writer.exec(scenario === "schema change"
          ? "PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16"
          : "INSERT INTO admission_writes VALUES (1)");
        predecessor();
        lease = await queued;
        return lease;
      };
      ({ harness } = createMigratingBox({ agentUserVersion: null, gatewayQuiesce: quiesce,
        extraSyncOptions: { acquireLifecycleLock: acquire } }));
      writer = new DatabaseSync(path.join(harness.openclawDir, "state/openclaw.sqlite"));
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE admission_writes (id INTEGER)");
      try {
        const target = scenario === "consented write" ? await approveFailedApply(harness) : { ...kSoftGateTarget, recoveryMode: "database_set" };
        const result = await harness.sync.applyUpdate(target);
        if (scenario === "backed-up write") {
          expect(result.status, JSON.stringify(result.body)).toBe(202);
          const recovery = readRecovery(harness, result);
          expect(recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
          const captured = new DatabaseSync(path.join(recovery.file, "payload/state/openclaw.sqlite"));
          try { expect(captured.prepare("SELECT count(*) AS n FROM admission_writes").get().n).toBe(1); }
          finally { captured.close(); }
          expect(harness.store.readState().applied.version).toBe("1.1.0");
        } else {
          expect(result).toMatchObject({ status: 409, body: { code: scenario === "consented write" ? "recovery_choice_required" : "apply_facts_changed" } });
          if (scenario === "consented write") {
            expect(result.body).toMatchObject({ gatewayHeld: true, backupRiskEligible: true });
            expect(harness.store.readState().gatewayHold).toMatchObject({ reason: "recovery_review", operationId: result.body.operationId });
            expect(quiesce.start).not.toHaveBeenCalled();
            expect((await harness.sync.applyUpdate(target)).body.code).toBe("backup_consent_required");
          }
          expect(harness.store.readState().applied).toBeNull();
          expect(harness.restartProcess).not.toHaveBeenCalled();
          expect(lock.getActiveOperation()).toBeNull();
          expect(isStateDbQuiet()).toBe(false);
        }
      } finally { lease?.(); writer.close(); }
    });

    it.each(["version_mismatch", "config_migration_failed"])("an explicit database-set apply can recover the existing %s hold through its owned commit and restart", async (reason) => {
      const { harness, quiesce } = createMigratingBox({ agentUserVersion: null });
      harness.store.updateState((state) => {
        state.gatewayHold = { reason, at: harness.nowRef.now, installed: "1.0.0", expected: "1.0.0" };
        return state;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, recoveryMode: "database_set" });
        expect(result.status, JSON.stringify(result.body)).toBe(202);
        expect(readRecovery(harness, result)).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
        expect(harness.store.readState().gatewayHold.reason).toBe(reason);
        expect(quiesce.lock.getActiveOperation().kind).toBe("apply_commit");
        expect(isStateDbQuiet()).toBe(true);
        await vi.advanceTimersByTimeAsync(1500);
        expect(harness.restartProcess).toHaveBeenCalledTimes(1);
        expect(quiesce.lock.getActiveOperation()).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it("a database-set recovery refuses a replacement hold established while waiting for ownership", async () => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness;
      const quiesce = makeQuiesceRecorder({ lock });
      const acquire = async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        harness.store.updateState((state) => { state.gatewayHold.at += 1; return state; });
        predecessor();
        return queued;
      };
      ({ harness } = createMigratingBox({ agentUserVersion: null, gatewayQuiesce: quiesce,
        extraSyncOptions: { acquireLifecycleLock: acquire } }));
      harness.store.updateState((state) => { state.gatewayHold = { reason: "version_mismatch", at: harness.nowRef.now }; return state; });
      const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, recoveryMode: "database_set" });
      expect(result).toMatchObject({ status: 409, body: { code: "gateway_held" } });
      expect(harness.ledger.readRun(result.body.operationId)?.recovery?.checkpoint).toBeUndefined();
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(lock.getActiveOperation()).toBeNull();
    });

    it("config-only protection grants no authority to cross an existing recovery hold", async () => {
      const { harness, quiesce } = createMigratingBox({ sameSchema: true, agentUserVersion: null });
      harness.store.updateState((state) => { state.gatewayHold = { reason: "version_mismatch", at: harness.nowRef.now }; return state; });
      const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
      expect(result).toMatchObject({ status: 409, body: { code: "gateway_held" } });
      expect(result.body.backupRiskEligible).toBeUndefined();
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });

    it("a verified human approval allows forward-only migration across channels without repeating preparation", async () => {
      const { harness, backupCalls } = createMigratingBox();
      const approved = await approveFailedApply(harness, kHardGateTarget);
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(202);
      expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
      expect(readRecovery(harness, result)).toMatchObject({ kind: "forward_only", consent: { recorded: true }, databases: { complete: false } });
      expect(harness.store.readState().applied.channel).toBe("beta");
      expect(backupCalls).toHaveLength(0);
    });

    it("binds issuance to the failed operation and human session, propagates the offer, and never persists the bearer", async () => {
      const fail = vi.fn();
      const { harness, backupCalls } = createMigratingBox({ extraSyncOptions: { operationEvents: { fail } } });
      const failed = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
      const { operationId } = failed.body;
      expect(failed.body.backupRiskEligible).toBe(true);
      expect(harness.ledger.readRun(operationId).result).toMatchObject({ backupRiskEligible: true, operationId });
      expect(harness.sync.getChannelInfo().lastUpdateRun.result).toMatchObject({ backupRiskEligible: true, operationId });
      expect(fail).toHaveBeenCalledWith(operationId, expect.objectContaining({ backupRiskEligible: true, operationId }));
      expect((await harness.sync.requestBackupRiskConsent({ operationId, consentSessionId: "different-human" })).status).toBe(409);
      expect((await harness.sync.requestBackupRiskConsent({ operationId: crypto.randomUUID(), consentSessionId: kConsentSession })).status).toBe(409);
      const issued = await harness.sync.requestBackupRiskConsent({ operationId, consentSessionId: kConsentSession });
      expect(issued.body.target).toEqual(kSoftGateTarget);
      const request = { ...kSoftGateTarget, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession };
      expect((await harness.sync.applyUpdate({ ...request, consentSessionId: "different-human" })).body.code).toBe("backup_consent_required");
      harness.nowRef.now += 1;
      const result = await harness.sync.applyUpdate(request);
      expect(result.status).toBe(202);
      expect(readRecovery(harness, result).consent.approvalId).toBe(operationId);
      expect((await harness.sync.applyUpdate(request)).body.code).toBe("backup_consent_required");
      expect(backupCalls).toHaveLength(0);
      const persisted = JSON.stringify([harness.store.readState(), harness.ledger.listRuns(), harness.insertEvent.mock.calls, fail.mock.calls, notifyMessages(harness.notify)]);
      expect(persisted).not.toContain(issued.body.confirmNoBackupToken);
      expect(persisted).not.toContain(kConsentSession);
    });

    it.each(["source", "target", "schema", "database", "wal"])("invalidates approved facts after a %s change without rerunning protection or install", async (changed) => {
      const { harness, backupCalls } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      let writer;
      if (changed === "source") fs.appendFileSync(path.join(harness.installDir, "node_modules/openclaw/bin/entry.js"), "// changed\n");
      else if (changed === "target") fs.appendFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "bin/entry.js"), "// changed\n");
      else if (changed === "schema") fs.writeFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "dist/openclaw-agent-db-contract-test.js"), "const OPENCLAW_AGENT_SCHEMA_VERSION = 20;\n");
      else {
        writer = new DatabaseSync(path.join(harness.openclawDir, "state/openclaw.sqlite"));
        if (changed === "database") writer.exec("PRAGMA journal_mode=DELETE");
        writer.exec("CREATE TABLE consent_change (id INTEGER); INSERT INTO consent_change VALUES (1)");
        if (changed === "database") { writer.close(); writer = null; }
      }
      try {
        const result = await harness.sync.applyUpdate(approved);
        expect(result).toMatchObject({ status: 409, body: { code: "backup_consent_required" } });
        expect(result.body.backupRiskEligible).toBeUndefined();
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupCalls).toHaveLength(0);
        expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
      } finally { writer?.close(); }
    });

    it.each(["expired", "changed", "lost lease", "gateway hold", "config", "torn config"])("rechecks %s after waiting for the actual lifecycle lock", async (race) => {
      const lock = createGatewayLifecycleLock({ logger: kSilentLogger });
      let harness;
      const quiesce = makeQuiesceRecorder({ lock });
      const acquire = vi.fn(async (kind, options) => {
        const predecessor = lock.tryAcquire("restart");
        const queued = lock.acquire(kind, options);
        expect(lock.getActiveOperation().kind).toBe("restart");
        if (race === "expired") harness.nowRef.now += kConsentTtlMs;
        if (race === "changed") fs.appendFileSync(path.join(harness.store.overlayPackageDir("1.1.0"), "bin/entry.js"), "// queued change\n");
        if (race === "gateway hold") harness.store.updateState((state) => { state.gatewayHold = { reason: "config_migration_failed", version: "1.0.0", at: harness.nowRef.now }; return state; });
        if (race === "config" || race === "torn config") fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), race === "config" ? '{"agents":{"list":[{"id":"main"}]},"gateway":{"mode":"local"}}' : '{"gateway":');
        predecessor();
        const hold = await queued;
        if (race === "lost lease") hold();
        return hold;
      });
      ({ harness } = createMigratingBox({ gatewayQuiesce: quiesce, extraSyncOptions: { acquireLifecycleLock: acquire } }));
      const approved = await approveFailedApply(harness);
      const result = await harness.sync.applyUpdate(approved);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe({ expired: "backup_consent_required", changed: "recovery_choice_required", "lost lease": "lease_expired", "gateway hold": "gateway_held", config: "recovery_choice_required", "torn config": "config_unreadable" }[race]);
      if (["changed", "config"].includes(race)) {
        expect(result.body).toMatchObject({ gatewayHeld: true, backupRiskEligible: true });
        expect(harness.store.readState().gatewayHold).toMatchObject({ reason: "recovery_review", operationId: result.body.operationId });
        expect(quiesce.start).not.toHaveBeenCalled();
        expect((await harness.sync.applyUpdate(approved)).body.code).toBe("backup_consent_required");
      }
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
    });

    it.each(["openclaw.json", "alphaclaw.json"])("binds %s content and identity between the offer, issuance, and consume", async (file) => {
      for (const phase of ["issuance", "consume", "replacement"]) {
        const { harness, backupCalls } = createMigratingBox();
        const configPath = path.join(harness.openclawDir, file);
        const content = (value) => JSON.stringify({ agents: { list: [{ id: "main" }] }, privateConsentFixture: value });
        fs.writeFileSync(configPath, content("first"));
        const failed = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
        expect(failed.body.backupRiskEligible).toBe(true);
        const approvalRequest = { operationId: failed.body.operationId, consentSessionId: kConsentSession };
        const issued = phase !== "issuance" ? await harness.sync.requestBackupRiskConsent(approvalRequest) : null;
        if (issued) expect(issued.status).toBe(200);
        if (phase === "replacement") {
          fs.writeFileSync(`${configPath}.replacement`, content("first"));
          fs.renameSync(`${configPath}.replacement`, configPath);
        } else fs.writeFileSync(configPath, content("other"));
        const result = phase === "issuance"
          ? await harness.sync.requestBackupRiskConsent(approvalRequest)
          : await harness.sync.applyUpdate({ ...kSoftGateTarget, confirmNoBackup: true, confirmNoBackupToken: issued.body.confirmNoBackupToken, consentSessionId: kConsentSession });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe(phase === "issuance" ? "backup_consent_stale" : "backup_consent_required");
        expect(result.body.backupRiskEligible).toBeUndefined();
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupCalls).toHaveLength(0);
        expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(harness.ledger.listRuns())).not.toContain("privateConsentFixture");
      }
    });

    it.each(["openclaw.json", "alphaclaw.json"])("refuses torn %s with the shared config-unreadable envelope at every approval boundary", async (file) => {
      for (const phase of ["offer", "issuance", "consume"]) {
        const { harness } = createMigratingBox();
        const configPath = path.join(harness.openclawDir, file);
        let failed, issued;
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

    it.each(['{ gateway: { mode: "local" } }', '{"$include":"outside-snapshot.json"}'])("refuses unverifiable upstream config for both a waiver and an ordinary config checkpoint: %s", async (raw) => {
      for (const sameSchema of [false, true]) {
        const { harness } = createMigratingBox({ sameSchema });
        const configPath = path.join(harness.openclawDir, "openclaw.json");
        fs.writeFileSync(configPath, raw);
        const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, consentSessionId: kConsentSession });
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject(raw.includes("$include")
          ? { code: "RECOVERY_INVENTORY_UNSUPPORTED" }
          : { code: "config_unreadable", sourceCode: "OPENCLAW_CONFIG_UNREADABLE" });
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
      }
    });

    it("refuses an approval when the agent database is unreadable", async () => {
      const { harness } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      fs.writeFileSync(path.join(harness.openclawDir, "agents/main/agent/openclaw-agent.sqlite"), "corrupt");
      const result = await harness.sync.applyUpdate(approved);
      expect(result).toMatchObject({ status: 409, body: { code: "db_preflight_failed" } });
      expect(harness.store.readState().applied).toBeNull();
    });

    it("cannot waive an unreadable self-update ownership probe", async () => {
      const probe = vi.fn(() => false);
      const { harness } = createMigratingBox({ extraSyncOptions: { isSelfUpdateInProgress: probe } });
      const approved = await approveFailedApply(harness);
      probe.mockImplementation(() => { throw new Error("probe unavailable"); });
      const result = await harness.sync.applyUpdate(approved);
      expect(result).toMatchObject({ status: 409, body: { code: "self_update_unverified" } });
      expect(harness.store.readState().applied).toBeNull();
    });

    it("does not create or rebuild a dev checkout when local preparation disk space is unavailable", async () => {
      const { harness } = createMigratingBox({ extraSyncOptions: { fsModule: { ...fs, statfsSync: () => ({ bsize: 4096, bavail: 0 }) } } });
      const result = await harness.sync.applyUpdate({ channel: "dev", sha: "a".repeat(40), consentSessionId: kConsentSession });
      expect(result).toMatchObject({ status: 507, body: { code: "insufficient_disk" } });
      expect(result.body.backupRiskEligible).toBeUndefined();
      expect(fs.existsSync(path.join(harness.rootDir, "openclaw"))).toBe(false);
      expect(fs.existsSync(path.join(harness.rootDir, "openclaw-candidates"))).toBe(false);
      expect(harness.runner.runStreamed.mock.calls.some(([call]) => call.args?.some((arg) => ["clone", "fetch", "checkout", "build", "ui:build", "install", "update"].includes(arg)))).toBe(false);
      expect(harness.installToTempDir).not.toHaveBeenCalled();
    });

    it("never records an activation when the durable consent audit write fails, and consumes the token only once", async () => {
      const { harness } = createMigratingBox();
      const approved = await approveFailedApply(harness);
      const update = harness.ledger.updateRun;
      vi.spyOn(harness.ledger, "updateRun").mockImplementation((id, mutate) => update(id, (record) => {
        const result = mutate(record);
        if (result.recovery?.consent?.recorded === true) throw new Error("audit write refused");
        return result;
      }));
      expect((await harness.sync.applyUpdate(approved)).status).toBeGreaterThanOrEqual(400);
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect((await harness.sync.applyUpdate(approved)).body.code).toBe("backup_consent_required");
    });

    it("same-schema cross-channel updates need no waiver and report config-only coverage without claiming database recovery", async () => {
      const { harness } = createMigratingBox({ sameSchema: true });
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, consentSessionId: kConsentSession });
      expect(result.status).toBe(202);
      expect(harness.ledger.readRun(result.body.operationId).dbPreflight.migrationRequired).toBe(false);
      expect(readRecovery(harness, result)).toMatchObject({ kind: "config_only", consent: { required: false, recorded: false },
        databases: { complete: false, verified: false }, restore: { configAvailable: true, databaseSetAvailable: false } });
      expect(lastStepDetail(harness, "backup", "completed").detail).toContain("databases omitted");
      expect((await harness.sync.requestBackupRiskConsent({ operationId: result.body.operationId, consentSessionId: kConsentSession })).status).toBe(409);
      harness.sync.markGoodNow({ source: "acceptance" });
      await flushAsync();
      expect(notifyMessages(harness.notify).find((value) => value.includes("activation verified"))).not.toContain("was migrated");
    });

    it("fences a committed handoff until restart while preserving a successor hold and releasing owned quiet, lease, and watchdog state", async () => {
      const managed = { begin: vi.fn(), end: vi.fn() };
      const { harness, quiesce } = createMigratingBox({ extraSyncOptions: { watchdogManagedOperation: managed } });
      const approved = await approveFailedApply(harness);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const result = await harness.sync.applyUpdate(approved);
        expect(result.status).toBe(202);
        expect(harness.sync.isApplyInProgress()).toBe(true);
        const committed = harness.ledger.readRun(result.body.operationId);
        harness.store.updateState((state) => { state.gatewayHold = { reason: "config_migration_failed", version: "1.0.0", at: harness.nowRef.now }; return state; });
        const foreignHold = harness.store.readState().gatewayHold;
        await vi.advanceTimersByTimeAsync(1500);
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(harness.sync.isApplyInProgress()).toBe(true);
        expect(managed.end).toHaveBeenCalledTimes(2);
        const record = harness.ledger.readRun(result.body.operationId);
        expect(record.state).toBe("restart_expected");
        expect(record.result).toMatchObject({ code: "gateway_held", restartDeferred: true, restartRequired: true });
        expect(record.recoveryIntent).toMatchObject({ approved: true, migrationRequired: true });
        expect(record.recovery).toMatchObject({ kind: "forward_only", checkpoint: { verified: true }, consent: { recorded: true } });
        expect(record.recoveryIntent).toEqual(committed.recoveryIntent);
        expect(record.recovery).toEqual(committed.recovery);
        expect(harness.store.readState().gatewayHold).toEqual(foreignHold);
        expect(harness.sync.getChannelInfo().lastUpdateRun.result.restartDeferred).toBe(true);
        expect(harness.store.readState().lastTransition.ok).toBe(false);
        expect(isStateDbQuiet()).toBe(false);
        expect(quiesce.lock.getActiveOperation()).toBeNull();
        expect(quiesce.start).not.toHaveBeenCalled();
        expect(await harness.sync.applyUpdate(kHardGateTarget)).toMatchObject({ status: 409, body: { code: "operation_in_progress" } });
        expect(await harness.sync.runStandaloneBackup()).toMatchObject({ status: 409, body: { code: "operation_in_progress" } });
        expect(harness.store.readState().gatewayHold).toEqual(foreignHold);
        expect(harness.ledger.readRun(result.body.operationId).recoveryIntent).toEqual(committed.recoveryIntent);
        expect(quiesce.start).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
  });

  describe("classification details", () => {
  it("identifies a missing checkpoint payload path without claiming a completed recovery", async () => {
    const error = Object.assign(new Error("ENOENT: checkpoint payload openclaw.json disappeared"), { code: "ENOENT" });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(error) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.code).toBe("backup_failed");
    expect(result.body.message).toContain("openclaw.json disappeared");
    expect(harness.ledger.readRun(result.body.operationId).recovery).toBeUndefined();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(harness.sync.isApplyInProgress()).toBe(false);
  });

  it("fails an ENOENT without a parseable path without inventing source coverage or retrying a broader backup", async () => {
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), writes) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.code).toBe("backup_failed");
    expect(writes).toHaveBeenCalledOnce();
    expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("sanitizes control characters and markdown out of surfaced failure text", async () => {
    const quiesce = makeQuiesceRecorder();
    quiesce.stop.mockRejectedValue(new Error("checkpoint `rm -rf`\u001b[31m\u0007 could not be read"));
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("could not be read");
    expect(result.body.message).not.toMatch(/[`\u001b\u0007]/);
    expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });
});
  // ── v0.9.81 (D15/D19): bounded, self-describing upstream rung ────────────
  describe("upstream inactivity policy + output ring (v0.9.81, cross-model D15/D19)", () => {
    const { waitForBackupReadiness } = require("../../lib/server/openclaw-backup-readiness");
    const { createBackupProgress } = require("../../lib/server/openclaw-backup-progress");
    const { createOutputLineRing } = require("../../lib/server/output-line-ring");
    const { redactSecrets } = require("../../lib/server/utils/redact");

    const streamFixture = () => {
      const { EventEmitter } = require("node:events");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn((signal) => queueMicrotask(() => child.emit("close", null, signal)));
      const runner = createRunStream({ spawnImpl: () => child, processGroupAlive: () => false });
      return { child, runner };
    };

    it("allows an admitted historical live attempt beyond ten minutes without spending verification and cleanup reserves", () => {
      const budget = { ...kDefaultBackupBudget, ...kFastTuning };
      const timeoutMs = backupLadder.liveBackupAttemptBudget(budget.phaseEnvelopeMs, budget);
      expect(timeoutMs).toBeGreaterThan(10 * 60_000);
      expect(timeoutMs + budget.usableCheckReserveMs + budget.upstreamCleanupReserveMs).toBe(budget.phaseEnvelopeMs);
      expect(backupLadder.liveBackupAttemptBudget(budget.usableCheckReserveMs, budget)).toBe(0);
    });

    it("refuses a listening gateway whose native readiness never succeeds after the standalone pause", async () => {
      const quiesce = makeQuiesceRecorder();
      quiesce.probeReadiness.mockResolvedValue({ ok: true, kind: "not_ready", ready: false });
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("gateway_relaunch_failed");
      expect(quiesce.probeReadiness).toHaveBeenCalled();
      expect(quiesce.start).toHaveBeenCalledOnce();
      expect(quiesce.unsuppress).toHaveBeenCalledOnce();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
      expect(readNewestRunRecord(harness)).toMatchObject({ state: "failed", ok: false });
    });

    it("holds only the pause transition through slow native readiness, with DB readers resumed before every probe", async () => {
      const quiesce = makeQuiesceRecorder();
      const managed = { begin: vi.fn(), end: vi.fn() };
      let probes = 0;
      quiesce.probeReadiness.mockImplementation(async () => {
        probes++;
        expect(isStateDbQuiet()).toBe(false);
        expect(quiesce.lock.getActiveOperation().kind).toBe("backup_quiesce");
        expect(quiesce.unsuppress).not.toHaveBeenCalled();
        expect(managed.begin).not.toHaveBeenCalled();
        return { ok: true, kind: probes < 3 ? "not_ready" : "ready", ready: probes >= 3 };
      });
      const harness = createHarness({ gatewayQuiesce: quiesce,
        backupTuning: { postQuiesceReadyTimeoutMs: 100 },
        extraSyncOptions: { watchdogManagedOperation: managed } });
      seedStateDb(harness);
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      expect(probes).toBe(3);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true } });
      expect(quiesce.unsuppress).toHaveBeenCalledOnce();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(managed.begin).not.toHaveBeenCalled();
      expect(managed.end).not.toHaveBeenCalled();
    });

    it.each([
      ["allows readiness after the old twenty-second threshold and a full settle", 2000, true],
      ["refuses when the phase envelope cannot cover late readiness and settling", 30, false],
      ["refuses readiness continuation when the phase envelope is already exhausted", 0, false],
    ])("retained readiness helper %s", async (_, remainingPhaseMs, expectedReady) => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        const readyObservations = [];
        const gateway = {
          isRunning: vi.fn(async () => true),
          probeReadiness: vi.fn(async () => {
            const ready = Date.now() - startedAt >= 25;
            if (ready) readyObservations.push(Date.now());
            return { ok: true, kind: ready ? "ready" : "not_ready", ready };
          }),
        };
        const pending = waitForBackupReadiness({ gateway, timeoutMs: remainingPhaseMs,
          pollMs: 2, settleMs: 10, shouldAbort: () => false });
        await vi.runAllTimersAsync();
        expect(await pending).toBe(expectedReady);
        if (expectedReady) {
          expect(readyObservations).toHaveLength(2);
          expect(readyObservations[0] - startedAt).toBeGreaterThanOrEqual(25);
          expect(readyObservations[1] - readyObservations[0]).toBeGreaterThanOrEqual(10);
        } else if (remainingPhaseMs === 0) {
          expect(gateway.probeReadiness).not.toHaveBeenCalled();
        } else {
          expect(readyObservations).toHaveLength(1);
        }
      } finally { vi.useRealTimers(); }
    });

    it.each(["shutdown", "lease loss"])("cleans up its quiet/lease tokens after %s during standalone readiness without reporting success", async (reason) => {
      const quiesce = makeQuiesceRecorder();
      const owner = {};
      quiesce.suppress.mockReturnValue(owner);
      let cancelled = false;
      let hold;
      const acquire = quiesce.acquireLock.getMockImplementation();
      quiesce.acquireLock.mockImplementation(async (options) => {
        hold = await acquire(options);
        return hold;
      });
      quiesce.isCancelled = () => cancelled;
      quiesce.probeReadiness.mockImplementation(async () => {
        expect(isStateDbQuiet()).toBe(false);
        if (reason === "shutdown") cancelled = true;
        else hold();
        return { ok: true, kind: "ready", ready: true };
      });
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const result = await harness.sync.runStandaloneBackup();
      expect(quiesce.probeReadiness).toHaveBeenCalledOnce();
      expect(readNewestRunRecord(harness)).toMatchObject({ state: "failed", ok: false });
      expect(isStateDbQuiet()).toBe(false);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(quiesce.unsuppress).toHaveBeenCalledExactlyOnceWith(owner);
      expect(harness.installToTempDir).not.toHaveBeenCalled();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe("lease_expired");
    });

    it("extracts the preceding historical failed attempt without treating it as a successful throughput sample", () => {
      const failed = { operationId: crypto.randomUUID(), backup: { noBackup: true,
        attemptsDetail: [{ rung: "upstream", ok: false, kind: "stalled", elapsedMs: 1000,
          timeoutMs: 2000, progress: { doneBytes: 8, stage: "write" } }] } };
      const completed = { operationId: crypto.randomUUID(), backup: { noBackup: false,
        attemptsDetail: [{ rung: "upstream", ok: true, elapsedMs: 2000 }] } };
      expect(backupLadder.priorBackupFailure([completed, failed])).toEqual({ operationId: failed.operationId,
        kind: "stalled", elapsedMs: 1000, timeoutMs: 2000, progress: { doneBytes: 8, stage: "write" } });
      expect(backupLadder.priorBackupFailure([completed])).toBeNull();
      const newerFailure = { operationId: crypto.randomUUID(), backup: { attemptsDetail: [
        ...failed.backup.attemptsDetail,
        { rung: "upstream", ok: false, kind: "timeout", elapsedMs: 3000 },
      ] } };
      expect(backupLadder.priorBackupFailure([newerFailure, completed, failed])).toEqual({
        operationId: newerFailure.operationId, kind: "timeout", elapsedMs: 3000, progress: null, timeoutMs: null,
      });
    });

    it.each([
      ["timeout", "CHECKPOINT_BUDGET"],
      ["cancellation", "CHECKPOINT_LEASE_LOST"],
      ["verify failure", "CHECKPOINT_PAYLOAD_INVALID"],
    ])("quarantines a checkpoint %s without publishing staging paths or removing another attempt's directory", async (reason, code) => {
      let stagingRoot;
      let payloadFd;
      let cancelled = false;
      const quiesce = makeQuiesceRecorder();
      quiesce.isCancelled = () => cancelled;
      let harness;
      const fsModule = { ...fs,
        openSync: (file, ...args) => {
          const fd = fs.openSync(file, ...args);
          if (String(file).includes(".staging/payload/") && args[0] === "wx") {
            stagingRoot = String(file).split("/payload/")[0];
            payloadFd = fd;
          }
          return fd;
        },
        writeFileSync: (file, data, ...args) => {
          const payload = file === payloadFd;
          const result = fs.writeFileSync(file, payload && reason === "verify failure" ? "tampered" : data, ...args);
          if (payload) {
            expect(isStateDbQuiet()).toBe(true);
            expect(harness.sync.listBackupInventory().entries).toEqual([]);
            if (reason === "timeout") harness.nowRef.now += 10_001;
            if (reason === "cancellation") cancelled = true;
            payloadFd = undefined;
          }
          return result;
        },
      };
      harness = createHarness({ gatewayQuiesce: quiesce, extraSyncOptions: { fsModule } });
      const unrelated = path.join(harness.rootDir, "backups", "openclaw", ".recovery-unrelated.staging");
      fs.mkdirSync(unrelated, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(unrelated, "owned-by-another-run"), "another writer");
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe(code);
      expect(stagingRoot).toBeTruthy();
      expect(fs.existsSync(stagingRoot)).toBe(false);
      expect(fs.readFileSync(path.join(unrelated, "owned-by-another-run"), "utf8")).toBe("another writer");
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(JSON.stringify(readNewestRunRecord(harness))).not.toContain(stagingRoot);
      expect(JSON.stringify(result.body)).not.toContain(stagingRoot);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
    });

    it("detects a stalled retained stream from staging bytes despite output, and redacts split lines before retaining the ring", async () => {
      const root = mkTemp("alphaclaw-retained-progress-");
      const outputFile = path.join(root, "archive.tar.gz");
      const progress = createBackupProgress({ root, outputFile });
      const ring = createOutputLineRing({ redact: (text) => redactSecrets(text, { secrets: ["hunter2-secret-value"] }) });
      expect(progress.probe()).toEqual({ bytes: 0, phase: "write" });
      const publishDir = path.join(root, ".openclaw-backup-publish-owned");
      fs.mkdirSync(publishDir);
      const temporary = path.join(publishDir, "archive.tar.gz.tmp");
      fs.writeFileSync(temporary, "s".repeat(2048));
      expect(progress.probe()).toEqual({ bytes: 2048, phase: "write" });
      fs.appendFileSync(temporary, "s".repeat(1000));
      expect(progress.probe()).toEqual({ bytes: 3048, phase: "write" });
      vi.useFakeTimers();
      try {
        const { child, runner } = streamFixture();
        const pending = runner.runStreamed({ command: "retained-stream-fixture", timeoutMs: 1000,
          inactivityTimeoutMs: 100, outputCountsAsProgress: false,
          progressProbe: progress.probe, onOutput: (chunk) => ring.push(chunk) });
        child.stdout.emit("data", "Preparing backup…\nauth token=hunter2-secret-");
        await vi.advanceTimersByTimeAsync(60);
        child.stdout.emit("data", "value ok\nwaiting for coord");
        child.stdout.emit("data", "inator lock\n");
        await vi.advanceTimersByTimeAsync(41);
        const result = await pending;
        expect(result).toMatchObject({ ok: false, stalled: true, timedOut: false, killed: true });
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(ring.lines()).toEqual(["Preparing backup…", "auth token=*** ok", "waiting for coordinator lock"]);
        expect(ring.last()).toBe("waiting for coordinator lock");
        expect(JSON.stringify(ring.lines())).not.toContain("hunter2");
      } finally { vi.useRealTimers(); }
      fs.writeFileSync(outputFile, "archive");
      expect(progress.probe()).toEqual({ bytes: 3055, phase: "verify" });
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("distinguishes a silent retained stream timeout from success and keeps each output ring isolated", async () => {
      vi.useFakeTimers();
      try {
        const silent = streamFixture();
        const ring = createOutputLineRing();
        const pending = silent.runner.runStreamed({ command: "silent-fixture", timeoutMs: 50,
          onOutput: (chunk) => ring.push(chunk) });
        await vi.advanceTimersByTimeAsync(51);
        expect(await pending).toMatchObject({ ok: false, timedOut: true, stalled: false, tail: "" });
        expect(ring.lines()).toEqual([]);
        const success = streamFixture();
        const succeeded = success.runner.runStreamed({ command: "successful-fixture", timeoutMs: 50 });
        success.child.emit("close", 0, null);
        expect(await succeeded).toMatchObject({ ok: true, timedOut: false, stalled: false, tail: "" });
        expect(createOutputLineRing().lines()).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

    it("retains historical stalled/timeout policy equivalence without allowing a checkpoint quiet-loss failure to enter that ladder", async () => {
      expect(backupLadder.kQuiescedOutcomePolicy.stalled).toBe(backupLadder.kQuiescedOutcomePolicy.timeout);
      expect(backupLadder.kLiveRetryPolicy.stalled).toBeUndefined();
      const quiesce = makeQuiesceRecorder();
      const quiet = quiesce.dbQuiet.getMockImplementation();
      quiesce.dbQuiet.mockImplementation(async (options) => {
        const token = await quiet(options);
        token.release();
        return token;
      });
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("state_db_quiet_lost");
      expect(quiesce.stop).toHaveBeenCalledOnce();
      expect(quiesce.start).toHaveBeenCalledOnce();
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });
  });

  // ── v0.9.81 (C3): "Back up now" — the ladder as a standalone run ─────────
  describe("runStandaloneBackup (Back up now, v0.9.81)", () => {
    const readRuns = (harness) => harness.ledger.listRuns();
    const withSharedLockPolicy = () => {
      const lock = createGatewayLifecycleLock();
      const ref = { sync: null };
      const policy = createGatewayMutationPolicy({ lock,
        getChannelInfo: () => ref.sync.getChannelInfo(),
        isApplyInProgress: () => ref.sync.isApplyInProgress() });
      const policyAssert = vi.fn((options) => policy.assert(options));
      return { lock, ref, policyAssert, gatewayMutationPolicy: { assert: policyAssert } };
    };

    it("pauses, checkpoints, relaunches and records a kind: backup run without installation, process restart, or lastUpdateRun mutation", async () => {
      const { lock, ref, policyAssert, gatewayMutationPolicy } = withSharedLockPolicy();
      const quiesce = makeQuiesceRecorder({ lock });
      const harness = createHarness({ gatewayQuiesce: quiesce, extraSyncOptions: { gatewayMutationPolicy } });
      ref.sync = harness.sync;
      seedStateDb(harness);
      harness.store.updateState((state) => {
        state.lastUpdateRun = { operationId: "0f76b007-e2e0-4c0d-9a1e-000000000099",
          target: { channel: "stable", version: "1.0.0" }, startedAt: 500_000,
          finishedAt: 500_500, ok: true, steps: [{ name: "activate", status: "completed", at: 500_400 }] };
        return state;
      });
      const before = JSON.stringify(harness.store.readState().lastUpdateRun);
      expect(before).toContain('"activate"');
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true },
        databases: { complete: false, verified: false, entries: [] },
        restore: { configAvailable: true, databaseSetAvailable: false } });
      const file = result.body.recovery.checkpoint.file;
      expect(fs.readFileSync(path.join(file, "payload", "openclaw.json"), "utf8")).toBe(fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"));
      expect(fs.existsSync(path.join(file, "payload", "state", "openclaw.sqlite"))).toBe(false);
      expect(quiesce.calls).toEqual(["acquireLock", "isRunning", "suppress", "stop", "dbQuiet", "dbResume", "start", "isRunning", "unsuppress"]);
      expect(lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
      expect(harness.installToTempDir).not.toHaveBeenCalled();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      expect(harness.sync.isApplyInProgress()).toBe(false);
      expect(JSON.stringify(harness.store.readState().lastUpdateRun)).toBe(before);
      expect(harness.store.readState().lastBackupRun).toBeUndefined();
      const [run] = readRuns(harness);
      expect(run).toMatchObject({ operationId: result.body.operationId, target: { kind: "backup" },
        state: "completed", ok: true, result: { ok: true, recovery: { checkpoint: { file } } },
        recovery: { kind: "config_only", checkpoint: { file, verified: true } } });
      expect(run.finishedAt).not.toBeNull();
      expect(policyAssert.mock.calls.length).toBeGreaterThan(2);
      expect(policyAssert.mock.calls[0][0]).toEqual({ intent: kGatewayMutationIntents.backup });
      expect(policyAssert.mock.calls[1][0].hold.kind).toBe("backup_quiesce");
      expect(policyAssert.mock.calls.slice(1).every(([args]) =>
        args.hold === policyAssert.mock.calls[1][0].hold && args.intent === kGatewayMutationIntents.backup)).toBe(true);
      expect(notifyMessages(harness.notify).some((message) => /checkpoint.*(verified|written)|backup written/i.test(message))).toBe(true);
    });

    it("a completed manual checkpoint activates nothing and cannot waive a later update's failed fresh checkpoint", async () => {
      const quiesce = makeQuiesceRecorder();
      const harness = createHarness({ gatewayQuiesce: quiesce, runnerImpl: makeBackupRunner().runnerImpl });
      harness.nowRef.now = kRealisticNow;
      seedStateDb(harness);
      const before = harness.store.readState();
      const backup = await harness.sync.runStandaloneBackup();
      expect(backup.status).toBe(200);
      expect(harness.store.readState().applied).toEqual(before.applied);
      expect(harness.store.readState().lastUpdateRun).toEqual(before.lastUpdateRun);
      const file = backup.body.recovery.checkpoint.file;
      const manifest = fs.readFileSync(path.join(file, "manifest.json"), "utf8");
      quiesce.dbQuiet.mockResolvedValue(null);
      harness.nowRef.now += 60_000;
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, intent: "update" });
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe("state_db_quiet_unavailable");
      expect(result.body.reusableBackup).toBeUndefined();
      expect(fs.readFileSync(path.join(file, "manifest.json"), "utf8")).toBe(manifest);
      expect(harness.store.readState().applied).toEqual(before.applied);
      expect(harness.restartProcess).not.toHaveBeenCalled();
    });

    it("a failed manual checkpoint never offers an older verified archive for reuse", async () => {
      const quiesce = makeQuiesceRecorder();
      quiesce.dbQuiet.mockResolvedValue(null);
      const harness = createHarness({ gatewayQuiesce: quiesce });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      const at = harness.nowRef.now - 60 * 60 * 1000;
      const file = path.join(backupsDir, `openclaw-backup-${at}-prev0000.tar.gz`);
      fs.writeFileSync(file, "earlier archive\n");
      const priorId = crypto.randomUUID();
      harness.ledger.createRun({ operationId: priorId, target: { channel: "stable", version: "1.0.0" } });
      harness.ledger.updateRun(priorId, (record) => ({ ...record, startedAt: at - 1000,
        finishedAt: at - 500, state: "failed", ok: false,
        backup: { noBackup: false, file, verified: true, partial: false, at, producer: "openclaw", usableCheck: "manifest_ok" } }));
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("state_db_quiet_unavailable");
      expect(result.body.reusableBackup).toBeUndefined();
      expect(fs.readFileSync(file, "utf8")).toBe("earlier archive\n");
      expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "failed", ok: false });
      expect(quiesce.start).toHaveBeenCalledOnce();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });

    it("insufficient checkpoint disk space ends the manual run failed with a typed condition and retry hint", async () => {
      const quiesce = makeQuiesceRecorder();
      const harness = createHarness({ gatewayQuiesce: quiesce,
        extraSyncOptions: { fsModule: { ...fs, statfsSync: () => ({ bavail: 0, bsize: 4096 }) } } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(507);
      expect(result.body.code).toBe("insufficient_disk");
      expect(result.body.hint).toContain("retry");
      expect(result.body.hint).toContain("no broader backup was attempted");
      expect(result.body.message).not.toContain("pre-update");
      expect(result.body.hint).not.toMatch(/same-channel version/);
      expect(readRuns(harness)).toEqual([expect.objectContaining({ target: { kind: "backup" }, state: "failed",
        ok: false, result: expect.objectContaining({ code: "insufficient_disk" }) })]);
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(harness.sync.isApplyInProgress()).toBe(false);
      expect(notifyMessages(harness.notify).some((message) => /OpenClaw backup failed/.test(message))).toBe(true);
    });

    it("an apply and a backup never overlap while a standalone checkpoint owns the pause", async () => {
      let release;
      let entered;
      const gate = new Promise((resolve) => { release = resolve; });
      const paused = new Promise((resolve) => { entered = resolve; });
      const quiesce = makeQuiesceRecorder();
      const quiet = quiesce.dbQuiet.getMockImplementation();
      quiesce.dbQuiet.mockImplementation(async (options) => {
        const token = await quiet(options);
        entered();
        await gate;
        return token;
      });
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const pending = harness.sync.runStandaloneBackup();
      await paused;
      try {
        expect(isStateDbQuiet()).toBe(true);
        expect(harness.sync.isApplyInProgress()).toBe(true);
        expect(quiesce.lock.getActiveOperation().kind).toBe("backup_quiesce");
        const apply = await harness.sync.applyUpdate({ ...kHardGateTarget, intent: "update" });
        expect(apply.status).toBe(409);
        expect(apply.body.code).toBe("operation_in_progress");
        const second = await harness.sync.runStandaloneBackup();
        expect(second.status).toBe(409);
        expect(second.body.code).toBe("operation_in_progress");
        expect(second.body.message).toMatch(/update or backup/);
      } finally { release(); }
      const first = await pending;
      expect(first.status).toBe(200);
      expect(first.body.recovery.checkpoint.verified).toBe(true);
      expect(harness.sync.isApplyInProgress()).toBe(false);
      expect(readRuns(harness)).toHaveLength(1);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });

    it("entry gates: a running gateway operation, a migration holder, not onboarded, and a gateway hold all refuse before anything is paused", async () => {
      const cases = [
        [{ getActiveGatewayOperation: () => ({ kind: "restart" }) }, "gateway_operation_in_progress"],
        [{ getActiveGatewayOperation: () => ({ kind: "boot" }) }, "gateway_busy"],
        [{ isOnboarded: () => false }, "not_onboarded"],
        [{ gatewayMutationPolicy: { assert: () => {
          throw Object.assign(new Error("held"), { blocked: true, statusCode: 409, code: "gateway_held",
            error: "The gateway is held after a failed settings migration.", hint: "Use Retry migration first.", hold: "config_migration_failed" });
        } } }, "gateway_held"],
      ];
      for (const [extraSyncOptions, code] of cases) {
        const quiesce = makeQuiesceRecorder();
        const harness = createHarness({ gatewayQuiesce: quiesce, extraSyncOptions });
        const result = await harness.sync.runStandaloneBackup();
        expect(result.status, code).toBe(409);
        expect(result.body.code).toBe(code);
        expect(quiesce.calls).toEqual([]);
        expect(readRuns(harness)).toEqual([]);
        expect(harness.sync.isApplyInProgress()).toBe(false);
        if (code === "gateway_held") {
          expect(result.body.message).toContain("held");
          expect(result.body.hint).toBe("Use Retry migration first.");
          expect(result.body.hold).toBe("config_migration_failed");
        }
      }
    });

    it("a hold that appears while the lease was queued refuses under that lease, releases ownership, and records the hold's code", async () => {
      const quiesce = makeQuiesceRecorder();
      const policyAssert = vi.fn(({ hold }) => {
        if (!hold) return;
        throw Object.assign(new Error("held"), { blocked: true, statusCode: 409, code: "gateway_held",
          error: "The gateway is held after a failed settings migration.", hint: "Use Retry migration first." });
      });
      const harness = createHarness({ gatewayQuiesce: quiesce,
        extraSyncOptions: { gatewayMutationPolicy: { assert: policyAssert } } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("gateway_held");
      expect(policyAssert).toHaveBeenCalledTimes(2);
      expect(policyAssert.mock.calls[1][0].hold.kind).toBe("backup_quiesce");
      expect(quiesce.calls).toEqual(["acquireLock"]);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(quiesce.dbQuiet).not.toHaveBeenCalled();
      expect(harness.sync.isApplyInProgress()).toBe(false);
      expect(readRuns(harness)).toEqual([expect.objectContaining({ target: { kind: "backup" }, state: "failed",
        result: expect.objectContaining({ code: "gateway_held" }) })]);
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
  it("quiet-barrier loss remains a typed ownership failure rather than an ENOENT retry", async () => {
    const quiesce = makeQuiesceRecorder();
    quiesce.dbQuiet.mockImplementation(async (options) => {
      const token = await beginStateDbQuiet(options);
      options.onEvent({ status: "expired", message: "ENOENT from stale cleanup" });
      return token;
    });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("state_db_quiet_lost");
    expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("checkpoint cancellation is not misclassified by verification text and never publishes staging", async () => {
    const error = Object.assign(new Error("Archive verification interrupted"), { code: "CHECKPOINT_CANCELLED", signal: "SIGKILL" });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(error) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_CANCELLED");
    expect(harness.ledger.readRun(result.body.operationId).recovery).toBeUndefined();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(isStateDbQuiet()).toBe(false);
  });

  it("an unavailable checkpoint writer is terminal and cannot be replaced by a legacy archive", async () => {
    const error = Object.assign(new Error("checkpoint writer EACCES; ENOENT was only secondary context"), { code: "EACCES" });
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(error, writes) } });
    const directory = path.join(harness.rootDir, "backups", "openclaw");
    fs.mkdirSync(directory, { recursive: true });
    const legacy = path.join(directory, "openclaw-backup-1-old00000.tar.gz");
    fs.writeFileSync(legacy, "historical archive");
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("EACCES");
    expect(writes).toHaveBeenCalledOnce();
    expect(result.body.reusableBackup).toBeUndefined();
    expect(fs.readFileSync(legacy, "utf8")).toBe("historical archive");
    expect(harness.ledger.readRun(result.body.operationId).recovery).toBeUndefined();
  });

  it("a disk-space refusal remains fatal before stop even when a would-be writer reports cancellation", async () => {
    const quiesce = makeQuiesceRecorder();
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { diskSpace: () => ({ ok: false, free: 0 }),
        fsModule: failCheckpointWrite(Object.assign(new Error("killed"), { code: "CHECKPOINT_CANCELLED" }), writes) } });
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(507);
    expect(result.body.code).toBe("insufficient_disk");
    expect(quiesce.stop).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(harness.ledger.readRun(result.body.operationId).state).toBe("failed");
    expect(result.body.backupRiskEligible).not.toBe(true);
  });

  it("bounded error prose cannot override the typed checkpoint failure code", async () => {
    const prose = Array.from({ length: 30 }, (_, i) => `progress ${i}: ENOENT`).join("\n");
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error(prose), { code: "CHECKPOINT_BUDGET" })) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_BUDGET");
    expect(result.body.message).not.toContain("ENOENT");
    expect(result.body.message.length).toBeLessThan(300);
    expect(harness.ledger.readRun(result.body.operationId).result.code).toBe("CHECKPOINT_BUDGET");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });
});

  // ── Issue #54: quiesced driver — contention retries, offline copy ────────
  describe("quiesced recovery safety and retained archive helpers", () => {
  const { assessExclusivity, createOfflineCopy } = require("../../lib/server/openclaw-backup-offline-copy");
  const evidence = (overrides = {}) => assessExclusivity({ stopConfirmed: true,
    quietToken: { owner: "fixture" }, isQuiet: () => true, platform: "linux", listFdHolders: () => [], ...overrides });
  const legacyCopy = async (harness, extra = {}) => {
    const backupsDir = path.join(harness.rootDir, "legacy-backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    return createOfflineCopy({ stateDir: harness.openclawDir, backupsDir,
      outputFile: path.join(backupsDir, "openclaw-backup-fixture.alphaclaw.tar.gz"),
      exclusivity: { stopConfirmed: true, quietToken: { owner: "fixture" }, liveProcesses: [], handleCount: 0 },
      isQuiet: () => true, listFdHolders: () => [], runtimeVersion: "1.0.0",
      runCommand: (options) => realRunStream.runStreamed(options), ...extra });
  };

  it("retained contention policy doubles bounded backoff and refuses another attempt after the retry cap", () => {
    const budgetMs = 100_000;
    for (let retries = 0; retries < 2; retries++) {
      const backoffMs = 4 * 2 ** retries;
      expect(contentionRetryVerdict({ failedMs: 1, backoffMs, remainingMs: budgetMs, budgetMs, retries })).toEqual({ retry: true, reason: null });
    }
    expect(contentionRetryVerdict({ failedMs: 1, backoffMs: 16, remainingMs: budgetMs, budgetMs, retries: 2 })).toMatchObject({ retry: false });
  });

  it("retained contention policy refuses an attempt when cleanup reserve no longer fits", () => {
    expect(contentionRetryVerdict({ failedMs: 60_000, backoffMs: 15_000, remainingMs: 104_999, budgetMs: 600_000, retries: 0 }))
      .toEqual({ retry: false, reason: "insufficient_budget" });
    expect(contentionRetryVerdict({ failedMs: 60_000, backoffMs: 15_000, remainingMs: 105_000, budgetMs: 600_000, retries: 0 })).toEqual({ retry: true, reason: null });
  });

  it("an explicit database recovery set contains a verified SQLite snapshot with its original rows", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl });
    seedStateDb(harness, { rows: 11 });
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(200);
    const file = path.join(result.body.recovery.file, "payload/state/openclaw.sqlite");
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM t").get().count).toBe(11);
      expect(database.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    } finally { database.close(); }
    expect(result.body.recovery.databases).toMatchObject({ complete: true, verified: true });
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("64MiB of workspace junk never enters the config checkpoint or its measured byte count", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl });
    seedStateDb(harness, { rows: 500 });
    const junk = path.join(harness.openclawDir, "workspace/node_modules/cache");
    fs.mkdirSync(path.dirname(junk), { recursive: true });
    const fd = fs.openSync(junk, "w"); fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(200);
    expect(result.body.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
    expect(result.body.recovery.checkpoint.bytes).toBeLessThan(1024);
    expect(result.body.recovery.databases.entries).toEqual([]);
    expect(fs.statSync(junk).size).toBe(64 * 1024 * 1024);
  });

  it("a cancelled capture never retries live or publishes a second checkpoint", async () => {
    const quiesce = makeQuiesceRecorder();
    const writes = vi.fn();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("worker cancelled"), { code: "CHECKPOINT_CANCELLED" }), writes) } });
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_CANCELLED");
    expect(writes).toHaveBeenCalledOnce();
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });

  it("explicitly snapshots a rollback-journal database through SQLite without spawning upstream backup", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl });
    seedStateDb(harness, { journalMode: "DELETE", rows: 20 });
    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
    expect(result.status).toBe(200);
    expect(result.body.recovery.databases.entries).toMatchObject([{ integrity: "ok", userVersion: 15 }]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("a locked rollback-journal database cannot produce a falsely verified database-set snapshot", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl });
    const file = seedStateDb(harness, { journalMode: "DELETE" });
    const writer = new DatabaseSync(file); writer.exec("BEGIN EXCLUSIVE");
    try {
      const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
      expect(result.body.ok).toBe(false);
      expect(harness.sync.listBackupInventory().entries.some((entry) => entry.verified)).toBe(false);
      expect(result.body.backupRiskEligible).not.toBe(true);
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  });

  it("legacy exclusivity evidence names a persistent foreign OpenClaw process rather than granting ownership", () => {
    const result = evidence({ liveProcesses: [{ pid: 4242, cmdline: "openclaw gateway run" }] });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("4242 (openclaw gateway run)"));
    expect(result.evidence.liveProcesses).toBe(1);
  });

  it("legacy exclusivity accepts a clean final sample after a transient CLI child exited", () => {
    expect(evidence({ liveProcesses: [{ pid: 12, cmdline: "openclaw status" }] }).ok).toBe(false);
    const settled = evidence({ liveProcesses: [] });
    expect(settled).toMatchObject({ ok: true, failures: [], evidence: { liveProcesses: 0, fdScan: "clean" } });
  });

  it("retained legacy copy resamples process ownership after its inventory walk", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl });
    seedStateDb(harness);
    const sample = vi.fn(async () => [{ pid: 99, cmdline: "openclaw gateway run" }]);
    await expect(legacyCopy(harness, { sampleLiveProcesses: sample })).rejects.toMatchObject({ stage: "exclusivity" });
    expect(sample).toHaveBeenCalled();
    expect(fs.readdirSync(path.join(harness.rootDir, "legacy-backups"))).toEqual([]);
  });

  it("retained rung selection refuses a prior throughput prediction too slow for the owned pause", () => {
    const result = chooseBackupRung({ diagnosis: { predictedUpstreamMs: 120_000, copySetBytes: 1024 }, remainingMs: 60_000 });
    expect(result).toEqual({ rung: "offline_copy", reason: "predicted_too_slow" });
    expect(chooseBackupRung({ diagnosis: { predictedUpstreamMs: 1, copySetBytes: 1024 }, remainingMs: 60_000 })).toEqual({ rung: "upstream", reason: "predicted_fits" });
  });

  it("retained rate calculation uses supplied producer throughput rather than unrelated duration fields", () => {
    const upstream = { attemptMs: 1000, stateBytes: 20_000_000, durationMs: 500_000 };
    const copy = { offlineCopyMs: 2000, offlineCopyBytes: 20_000_000, durationMs: 1 };
    expect(predictTransferMs({ bytes: 40_000_000, bytesPerSec: upstream.stateBytes / (upstream.attemptMs / 1000) })).toBe(2000);
    expect(predictTransferMs({ bytes: 40_000_000, bytesPerSec: copy.offlineCopyBytes / (copy.offlineCopyMs / 1000) })).toBe(4000);
    expect(predictTransferMs({ bytes: 40_000_000, bytesPerSec: 0 })).toBeNull();
  });

  it("the real process matcher excludes log followers but retains gateway executables for ownership checks", () => {
    const processes = fakeProcScan({ 41: "tail\0-F\0/tmp/openclaw/openclaw.log\0", 42: "node\0/app/openclaw/openclaw.mjs\0gateway\0run\0" })();
    expect(processes.map((entry) => entry.pid)).toEqual([42]);
    expect(evidence({ liveProcesses: processes }).ok).toBe(false);
  });

  it("a foreign file-descriptor holder refuses legacy exclusivity even after gateway stop", () => {
    const result = evidence({ dbPaths: ["/state/openclaw.sqlite"], listFdHolders: () => [{ pid: 123, path: "/state/openclaw.sqlite" }] });
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("pid 123 (openclaw.sqlite)"));
    expect(result.evidence.fdScan).toBe("holders");
  });

  it("checkpoint I/O failure is recorded as a failed capture without switching producer", async () => {
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
      extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("Input/output error"), { code: "EIO" })) } });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(500);
    expect(result.body.message).toContain("Input/output error");
    expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "failed", result: { ok: false } });
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("an expired quiet token is refused before any checkpoint payload is published", async () => {
    const quiesce = makeQuiesceRecorder();
    quiesce.dbQuiet.mockImplementation(async (options) => {
      const token = await beginStateDbQuiet({ ...options, maxMs: 5 });
      await sleep(12); return token;
    });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("state_db_quiet_lost");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(quiesce.start).toHaveBeenCalledOnce();
  });

  it("an already-owned quiet barrier is never released by a refused recovery capture", async () => {
    const owner = await beginStateDbQuiet({ owner: "other", maxMs: 60_000 });
    const quiesce = makeQuiesceRecorder({ dbQuietThrows: true });
    try {
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(quiesce.dbResume).not.toHaveBeenCalled();
      expect(isStateDbQuiet()).toBe(true);
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
    } finally { owner.release(); }
  });

  it("a disabled quiet token cannot claim checkpoint ownership despite the legacy helper's recorded opt-out", async () => {
    const legacy = evidence({ quietToken: { disabled: true } });
    expect(legacy).toMatchObject({ ok: true, evidence: { quiet: "disabled" } });
    const quiesce = makeQuiesceRecorder();
    quiesce.dbQuiet.mockResolvedValue({ token: { disabled: true }, release: vi.fn() });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    const result = await harness.sync.runStandaloneBackup();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("state_db_quiet_lost");
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });
});

  // ── Issue #54: honesty — attempts, wording, single running emission ──────
  // ── #79 (d) / Codex 16: predict before starting ─────────────────────────
  describe("pre-backup diagnosis: sized tree, two prediction series, envelope stamped after (#79 (d), Codex 16)", () => {
    const seedWorkspace = (harness) => {
      const ws = path.join(harness.openclawDir, "workspace");
      fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(ws, "notes.md"), "x".repeat(1000));
      fs.writeFileSync(path.join(ws, "src.js"), "y".repeat(500));
      fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "z".repeat(4000));
      fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "package.json"), "{}");
      return ws;
    };

    it("first-run preflight measures only the bounded configuration checkpoint, reports databases separately, and matches the captured manifest", async () => {
      const harness = createHarness();
      const dbFile = seedStateDb(harness);
      seedWorkspace(harness);
      const auth = path.join(harness.openclawDir, "agents", "main", "agent", "auth-profiles.json");
      const identity = path.join(harness.openclawDir, "identity", "device.json");
      for (const file of [auth, identity]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{}\n");
      }
      const bytes = [path.join(harness.openclawDir, "openclaw.json"), auth, identity]
        .reduce((sum, file) => sum + fs.statSync(file).size, 0);
      const preflight = await harness.sync.getBackupPreflight();
      expect(preflight).toEqual({ ok: true, blocked: false, profile: "config_only",
        checkpoint: { bytes, fileCount: 3, maxBytes: 16 * 1024 * 1024 },
        databaseCount: 1, databaseBytes: fs.statSync(dbFile).size,
        coverage: { config: "complete", databases: "omitted" }, reason: null });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const recovery = harness.ledger.readRun(result.body.operationId).recovery;
      expect(recovery).toMatchObject({ kind: "config_only", checkpoint: { bytes, fileCount: 3, verified: true },
        databases: { complete: false, entries: [], requiredPaths: ["state/openclaw.sqlite"] } });
      const manifest = JSON.parse(fs.readFileSync(path.join(recovery.checkpoint.file, "manifest.json"), "utf8"));
      expect(manifest.files.map((entry) => entry.archivePath).sort()).toEqual([
        "agents/main/agent/auth-profiles.json", "identity/device.json", "openclaw.json",
      ]);
      expect(manifest.files.reduce((sum, file) => sum + file.bytes, 0)).toBe(bytes);
      expect(fs.existsSync(path.join(recovery.checkpoint.file, "payload", "workspace"))).toBe(false);
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    });

    it("an incomplete bounded inventory reports unverified coverage and refuses before acquiring a gateway pause", async () => {
      const { kRecoveryLimits } = require("../../lib/server/openclaw-recovery-plan");
      const quiesce = makeQuiesceRecorder();
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const owner = path.join(harness.openclawDir, "agents", "main", "agent");
      fs.mkdirSync(owner, { recursive: true });
      for (let index = 0; index <= kRecoveryLimits.entries; index++) {
        fs.writeFileSync(path.join(owner, `entry-${index}.txt`), "x");
      }
      seedPriorUpstreamRun(harness, { attemptMs: 1, stateBytes: 1e9 });
      const priorInventory = harness.sync.listBackupInventory().entries;
      const preflight = await harness.sync.getBackupPreflight();
      expect(preflight).toMatchObject({ blocked: true, reason: "RECOVERY_INVENTORY_UNSUPPORTED",
        checkpoint: { bytes: 0, fileCount: 0 }, coverage: { config: "unverified", databases: "omitted" } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("RECOVERY_INVENTORY_UNSUPPORTED");
      expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "failed", ok: false,
        result: { code: "RECOVERY_INVENTORY_UNSUPPORTED" } });
      expect(quiesce.acquireLock).not.toHaveBeenCalled();
      expect(quiesce.stop).not.toHaveBeenCalled();
      expect(harness.sync.listBackupInventory().entries).toEqual(priorInventory);
    });

    it("historical copy and upstream calibration fields never contaminate the current measured checkpoint bytes", async () => {
      const harness = createHarness();
      seedStateDb(harness);
      const before = await harness.sync.getBackupPreflight();
      const copyId = seedPriorOfflineCopyRun(harness, { offlineCopyMs: 1000, offlineCopyBytes: 1_000_000,
        startedAt: 3, extra: { attemptMs: 1, stateBytes: 1e9 } });
      const upstreamId = seedPriorUpstreamRun(harness, { attemptMs: 4000, stateBytes: 2_000_000, startedAt: 2 });
      harness.ledger.updateRun(upstreamId, (record) => {
        record.backup.offlineCopyMs = 1;
        record.backup.offlineCopyBytes = 1e9;
        return record;
      });
      expect(await harness.sync.getBackupPreflight()).toEqual(before);
      const config = path.join(harness.openclawDir, "openclaw.json");
      fs.appendFileSync(config, "\n   ");
      const measured = await harness.sync.getBackupPreflight();
      expect(measured.checkpoint.bytes).toBe(before.checkpoint.bytes + 4);
      expect(measured.databaseBytes).toBe(before.databaseBytes);
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      expect(result.body.recovery.checkpoint.bytes).toBe(measured.checkpoint.bytes);
      expect(harness.ledger.readRun(copyId).backup).toMatchObject({ offlineCopyBytes: 1_000_000, attemptMs: 1 });
      expect(harness.ledger.readRun(upstreamId).backup).toMatchObject({ stateBytes: 2_000_000, offlineCopyBytes: 1e9 });
    });

    it("time spent in inventory counts toward the run duration but does not consume the subsequent checkpoint capture budget", async () => {
      let harness;
      let inventoryReads = 0;
      let captureStartedAt;
      const fsModule = { ...fs, openSync: (file, flags, ...args) => {
        if (harness && String(file) === path.join(harness.openclawDir, "openclaw.json") && inventoryReads++ === 0) {
          expect(isStateDbQuiet()).toBe(false);
          harness.nowRef.now += 60_000;
        }
        if (flags === "wx" && String(file).includes(".staging/payload/")) {
          expect(isStateDbQuiet()).toBe(true);
          captureStartedAt = harness.nowRef.now;
          harness.nowRef.now += 9000;
        }
        return fs.openSync(file, flags, ...args);
      } };
      harness = createHarness({ extraSyncOptions: { fsModule } });
      const startedAt = harness.nowRef.now;
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(captureStartedAt - startedAt).toBe(60_000);
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record.finishedAt - record.startedAt).toBe(69_000);
      expect(record.recovery.checkpoint.verified).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(path.join(record.recovery.checkpoint.file, "manifest.json"), "utf8"));
      expect(Date.parse(manifest.createdAt) - captureStartedAt).toBe(9000);
    });

    it("a rollback-journal database cannot trigger a live retry or broad fallback after its config checkpoint fails", async () => {
      const quiesce = makeQuiesceRecorder();
      const writes = vi.fn(() => {
        expect(isStateDbQuiet()).toBe(true);
        expect(quiesce.lock.getActiveOperation().kind).toBe("backup_quiesce");
      });
      const harness = createHarness({ gatewayQuiesce: quiesce,
        backupTuning: { rollbackJournalSelfDeadlockBytes: 1 },
        extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("checkpoint timed out"), { code: "CHECKPOINT_BUDGET" }), writes) } });
      const dbFile = seedStateDb(harness, { journalMode: "DELETE" });
      const before = sha256Of(dbFile);
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("CHECKPOINT_BUDGET");
      expect(writes).toHaveBeenCalledOnce();
      expect(sha256Of(dbFile)).toBe(before);
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "failed", ok: false });
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(quiesce.stop).toHaveBeenCalledOnce();
      expect(quiesce.start).toHaveBeenCalledOnce();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });

    it("a bin/boot instance without a quiesce seam refuses a rollback-journal checkpoint instead of falling back to a live backup", async () => {
      const harness = createHarness({ gatewayQuiesce: null });
      const dbFile = seedStateDb(harness, { journalMode: "DELETE" });
      const before = sha256Of(dbFile);
      expect(await harness.sync.getBackupPreflight()).toMatchObject({ blocked: false, databaseCount: 1 });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("recovery_ownership_unavailable");
      expect(sha256Of(dbFile)).toBe(before);
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record).toMatchObject({ state: "failed", ok: false, result: { code: "recovery_ownership_unavailable" } });
      expect(record.steps).toEqual([]);
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    });

    it("a rollback-journal database remains eligible for an explicitly chosen complete SQLite recovery set", async () => {
      const quiesce = makeQuiesceRecorder();
      const harness = createHarness({ gatewayQuiesce: quiesce });
      const dbFile = seedStateDb(harness, { journalMode: "DELETE", rows: 3 });
      const before = sha256Of(dbFile);
      const implicit = await harness.sync.runStandaloneBackup();
      expect(implicit.status).toBe(200);
      expect(implicit.body.recovery.databases).toMatchObject({ complete: false, entries: [] });
      const explicit = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });
      expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);
      expect(explicit.body.recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
      const snapshot = new DatabaseSync(path.join(explicit.body.recovery.checkpoint.file, "payload", "state", "openclaw.sqlite"), { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT COUNT(*) AS count FROM t").get().count).toBe(3);
        expect(snapshot.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
        expect(snapshot.prepare("PRAGMA user_version").get().user_version).toBe(15);
      } finally { snapshot.close(); }
      expect(sha256Of(dbFile)).toBe(before);
      expect(quiesce.stop).toHaveBeenCalledTimes(2);
      expect(quiesce.start).toHaveBeenCalledTimes(2);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
    });
  });

  describe("attempt honesty (WI-1.8/1.9)", () => {
    it("a refused backup destination records failure without inventing any captured artifact or CLI attempt", async () => {
      const writes = vi.fn();
      const harness = createHarness({ extraSyncOptions: { fsModule: failCheckpointWrite(new Error("must not reach payload"), writes) } });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const foreign = mkTemp("alphaclaw-foreign-checkpoint-destination-");
      fs.writeFileSync(path.join(foreign, "owned"), "untouched");
      fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
      fs.symlinkSync(foreign, backupsDir);
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("CHECKPOINT_DESTINATION_ALIAS");
      expect(writes).not.toHaveBeenCalled();
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record).toMatchObject({ state: "failed", ok: false, backup: null, result: { code: "CHECKPOINT_DESTINATION_ALIAS" } });
      expect(record.recovery).toBeUndefined();
      expect(record.steps.some((step) => step.name === "backup" && step.status === "completed")).toBe(false);
      expect(result.body.message).not.toMatch(/after \d+ attempts/);
      expect(fs.readdirSync(foreign)).toEqual(["owned"]);
      expect(fs.readFileSync(path.join(foreign, "owned"), "utf8")).toBe("untouched");
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    });

    it("a failed single checkpoint records one paused capture and a failed backup step, never fictitious mixed-driver attempt counts", async () => {
      const quiesce = makeQuiesceRecorder();
      const writes = vi.fn(() => {
        expect(isStateDbQuiet()).toBe(true);
        expect(quiesce.lock.getActiveOperation().kind).toBe("backup_quiesce");
      });
      const harness = createHarness({ gatewayQuiesce: quiesce,
        extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("capture deadline"), { code: "CHECKPOINT_BUDGET" }), writes) } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("CHECKPOINT_BUDGET");
      expect(writes).toHaveBeenCalledOnce();
      expect(result.body.message).not.toMatch(/after \d+ attempts/);
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record).toMatchObject({ state: "failed", ok: false, backup: null });
      expect(record.recovery).toBeUndefined();
      expect(record.steps.filter((step) => step.name === "backup" && step.status === "running")).toHaveLength(1);
      expect(record.steps.filter((step) => step.name === "backup" && step.status === "completed")).toEqual([]);
      expect(quiesce.start).toHaveBeenCalledOnce();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(record.steps.filter((step) => step.name === "backup").at(-1)).toMatchObject({ status: "failed", error: "CHECKPOINT_BUDGET" });
    });

    it("emits one honest config-only backup running row and updates its progress in place before completion", async () => {
      const published = [];
      const operationEvents = { publish: vi.fn((_, event) => published.push(structuredClone(event))), complete: vi.fn(), fail: vi.fn() };
      const harness = createHarness({ extraSyncOptions: { operationEvents } });
      const authDir = path.join(harness.openclawDir, "agents", "main", "agent");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "auth-profiles.json"), "{}\n");
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      const record = harness.ledger.readRun(result.body.operationId);
      const running = record.steps.filter((step) => step.name === "backup" && step.status === "running");
      expect(running).toHaveLength(1);
      expect(running[0].detail).toBe("Configuration checkpoint: 2 files");
      const liveRows = published.filter((event) => event.event === "step" && event.data.name === "backup" && event.data.status === "running");
      expect(liveRows.map((event) => event.data.detail)).toEqual([
        "Capturing configuration; databases are not copied",
        "Configuration checkpoint: 1 files",
        "Configuration checkpoint: 2 files",
      ]);
      expect(liveRows.every((event) => event.data.at === running[0].at)).toBe(true);
      expect(record.steps.filter((step) => step.name === "backup" && step.status === "completed")).toEqual([
        expect.objectContaining({ detail: "Configuration checkpoint verified; databases omitted" }),
      ]);
      expect(record.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true, fileCount: 2 }, databases: { complete: false } });
      expect(operationEvents.complete).toHaveBeenCalledWith(result.body.operationId, expect.objectContaining({ ok: true }));
      expect(operationEvents.fail).not.toHaveBeenCalled();
    });
  });

  // ── WI-6.1: usable check after every verified artifact ───────────────────
  describe("usable check (WI-6.1)", () => {
    it("rejects a legacy archive whose manifest covers no state DB during direct restore verification", async () => {
      // A config-only manifest: its single asset is the config file, so no
      // directory-level asset covers state/openclaw.sqlite (the real upstream
      // shape is one kind:"state" asset at the state dir — see the module tests).
      const { runnerImpl, backupCalls } = makeBackupRunner({
        manifestTail: `${JSON.stringify({ schemaVersion: 1, assets: [{ archivePath: "openclaw.json" }] })}\n`,
      });
      const result = await verifyArchiveManifest({ file: "/legacy/backup.tar.gz", runCommand: runnerImpl,
        requiredArchivePaths: ["state/openclaw.sqlite"] });

      expect(result).toMatchObject({ ok: false, stage: "assets", reason: "manifest covers no state/openclaw.sqlite" });
      expect(backupCalls).toHaveLength(0);
    });

    it("treats a failing gzip -t as a verify failure and records the stage", async () => {
      const { runnerImpl } = makeBackupRunner({
        onArchiveTool: (opts) =>
          opts.command === "gzip" ? { ok: false, code: 1, tail: "gzip: crc error\n", timedOut: false } : null,
      });
      const result = await verifyArchiveManifest({ file: "/legacy/backup.tar.gz", runCommand: runnerImpl });

      expect(result).toMatchObject({ ok: false, stage: "gzip", reason: expect.stringContaining("gzip -t: gzip: crc error") });
    });

    it("runs gzip -t and bounded manifest extraction against a legacy artifact before declaring restore coverage", async () => {
      const { runnerImpl, archiveToolCalls } = makeBackupRunner({});
      const file = "/legacy/backup.tar.gz";
      const result = await verifyArchiveManifest({ file, runCommand: runnerImpl,
        requiredArchivePaths: ["state/openclaw.sqlite"] });

      expect(result.ok).toBe(true);
      expect(result.manifest).toEqual(kStubManifest);
      expect(archiveToolCalls.map((c) => c.command)).toEqual(["gzip", "tar"]);
      expect(archiveToolCalls[0].args).toEqual(["-t", file]);
      expect(archiveToolCalls[1].args).toEqual([
        "-xzOf",
        file,
        "--wildcards",
        "--no-wildcards-match-slash",
        "--occurrence=1",
        "*/manifest.json",
      ]);
      expect(archiveToolCalls[1].tailBytes).toBe(32 * 1024 * 1024);
    });
  });

  // ── WI-4.5: consented, sha256-bound reuse of an earlier verified backup ──
  describe("backup reuse gate (WI-4.5)", () => {
    const { verifyArchiveManifest } = require("../../lib/server/openclaw-backup-offline-copy");
    const { inspectRecoveryCheckpoint, readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
    const kHour = 60 * 60 * 1000;
    const seedLegacyArchive = (harness, {
      ageMs = kHour, verified = true, partial = false, name = null,
      withRecord = true, deleteFile = false, activated = true, finishedAtOffsetMs = null,
    } = {}) => {
      harness.nowRef.now = kRealisticNow;
      const at = harness.nowRef.now - ageMs;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      const file = path.join(backupsDir, name || `openclaw-backup-${at}-prev0000.tar.gz`);
      fs.writeFileSync(file, `earlier archive bytes ${at}\n`);
      const sha256 = sha256Of(file);
      const operationId = withRecord ? crypto.randomUUID() : null;
      if (withRecord) {
        harness.ledger.createRun({ operationId, target: { channel: "stable", version: "1.0.0" } });
        harness.ledger.updateRun(operationId, (record) => {
          record.startedAt = at - 1000;
          if (finishedAtOffsetMs !== null) record.finishedAt = at + finishedAtOffsetMs;
          record.state = activated ? "activated" : "failed";
          record.ok = activated;
          record.backup = { noBackup: false, file, verified, partial, at, sha256, producer: "openclaw", usableCheck: "manifest_ok" };
          return record;
        });
      }
      if (deleteFile) fs.unlinkSync(file);
      return { file, at, sha256, operationId };
    };
    const createBox = ({ migrating = true, quiesce = makeQuiesceRecorder(), extraSyncOptions = {} } = {}) => {
      const scripted = makeBackupRunner();
      const harness = createHarness({ runnerImpl: scripted.runnerImpl, gatewayQuiesce: quiesce,
        targetSchema: migrating ? { state: 16, agent: 19 } : { state: 15, agent: 17 }, extraSyncOptions });
      seedStateDb(harness);
      seedAgentDb(harness, "main");
      return { harness, quiesce, ...scripted };
    };
    const entryFor = (harness, file) => harness.sync.listBackupInventory().entries.find((entry) => entry.file === file);
    const requireFreshChoice = async (harness, target = kHardGateTarget) => {
      const before = harness.store.readState().applied;
      const result = await harness.sync.applyUpdate(target);
      expect(result).toMatchObject({ status: 409, body: { code: "recovery_choice_required",
        choices: ["database_set", "cancel"], preflight: { migrationRequired: true },
        coverage: { config: "complete", databases: "omitted" } } });
      expect(result.body.reusableBackup).toBeUndefined();
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record.result.code).toBe("recovery_choice_required");
      expect(record.recovery?.checkpoint).toBeUndefined();
      expect(harness.store.readState().applied).toEqual(before);
      expect(harness.restartProcess).not.toHaveBeenCalled();
      return result;
    };
    const captureStandalone = async (options = {}) => {
      const box = createBox({ migrating: false, ...options });
      const result = await box.harness.sync.runStandaloneBackup();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return { ...box, recovery: result.body.recovery };
    };
    const inspect = (harness, recovery, fsModule = fs) => inspectRecoveryCheckpoint(recovery.file, {
      record: recovery, backupsDir: path.join(harness.rootDir, "backups/openclaw"), fsModule,
    });

    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      resetStateDbQuietForTests({ listeners: true });
      vi.useRealTimers();
    });

    it("retains the activation-time floor for a run's own pre-update archive without letting that archive authorize migration", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: 3 * kHour, finishedAtOffsetMs: 30_000 });
      const inventory = harness.sync.listBackupInventory();
      expect(inventory.reuseWindowStartMs).toBe(seeded.at + 30_000);
      expect(entryFor(harness, seeded.file)).toMatchObject({ verified: true, operationId: seeded.operationId });
      expect(seeded.at).toBeLessThan(inventory.reuseWindowStartMs);
      await requireFreshChoice(harness);
    });

    it("lists a verified historical archive but propagates a fresh recovery choice rather than a reuse offer", async () => {
      const { harness, backupCalls } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: 3 * kHour });
      expect(entryFor(harness, seeded.file)).toMatchObject({ eligible: true, verified: true, producer: "openclaw", sha256: seeded.sha256 });
      const result = await requireFreshChoice(harness);
      expect(harness.sync.getChannelInfo().lastUpdateRun.result).toMatchObject({ code: "recovery_choice_required", operationId: result.body.operationId });
      expect(harness.ledger.readRun(result.body.operationId).result.reusableBackup).toBeUndefined();
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
      expect(backupCalls).toHaveLength(0);
    });

    it("rejects matching retired reuse consent without rewriting provenance, pruning history, or preparing a build", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: 2 * kHour });
      const backupsDir = path.dirname(seeded.file);
      for (let i = 1; i <= 4; i += 1) fs.writeFileSync(path.join(backupsDir, `openclaw-backup-${i}-oldold00.tar.gz`), "old\n");
      const before = fs.readdirSync(backupsDir).sort();
      const priorRecord = harness.ledger.readRun(seeded.operationId);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, allowBackupReuse: { sha256: seeded.sha256 } });
      expect(result).toMatchObject({ status: 400, body: { code: "recovery_option_retired" } });
      expect(entryFor(harness, seeded.file)).toMatchObject({ eligible: true, sha256: seeded.sha256 });
      expect(fs.readdirSync(backupsDir).sort()).toEqual(before);
      expect(harness.ledger.readRun(seeded.operationId)).toEqual(priorRecord);
      expect(harness.installToTempDir).not.toHaveBeenCalled();
      expect(harness.store.readState().applied).toBeNull();
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
    });

    it("requires stale clients to remove reuse consent even when a fresh config-only apply can succeed", async () => {
      const { harness } = createBox({ migrating: false });
      const seeded = seedLegacyArchive(harness);
      expect((await harness.sync.applyUpdate({ ...kHardGateTarget, allowBackupReuse: { sha256: seeded.sha256 } })).body.code).toBe("recovery_option_retired");
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result.status).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false } });
      expect(result.body.recovery.file).not.toBe(seeded.file);
      expect(inspect(harness, result.body.recovery).ok).toBe(true);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
    });

    it("a mismatched archive digest cannot become either reuse or forward-only consent", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, allowBackupReuse: { sha256: "f".repeat(64) } });
      expect(result).toMatchObject({ status: 400, body: { code: "recovery_option_retired" } });
      expect(entryFor(harness, seeded.file).sha256).toBe(seeded.sha256);
      expect((await harness.sync.applyUpdate({ ...kHardGateTarget, confirmNoBackup: true, confirmNoBackupToken: seeded.sha256, consentSessionId: "human" })).body.code).toBe("backup_consent_required");
      await requireFreshChoice(harness);
    });

    it.each([
      ["older than 24h", { ageMs: 25 * kHour }, null],
      ["partial", { partial: true }, "partial"],
      ["unverified", { verified: false }, "unverified"],
      ["recorded but pruned from disk", { deleteFile: true }, "missing"],
      ["on disk without provenance", { withRecord: false }, "no_provenance"],
    ])("preserves the inventory verdict for an archive %s but requires fresh migration protection", async (label, seedOptions, reason) => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, seedOptions);
      const inventory = harness.sync.listBackupInventory();
      expect(entryFor(harness, seeded.file)).toMatchObject({ eligible: reason === null, ineligibleReason: reason, exists: !seedOptions.deleteFile });
      if (label === "older than 24h") expect(harness.nowRef.now - seeded.at).toBeGreaterThan(inventory.reuseMaxAgeMs);
      if (seedOptions.withRecord === false) {
        const alias = path.join(path.dirname(seeded.file), "openclaw-backup-1-symlink0.tar.gz");
        fs.symlinkSync(seeded.file, alias);
        expect(entryFor(harness, alias)).toMatchObject({ eligible: false, ineligibleReason: "symlink" });
      }
      await requireFreshChoice(harness);
    });

    it("publishes the later applied-build floor while retaining the older archive as history only", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: 5 * kHour });
      const at = harness.nowRef.now - 2 * kHour;
      harness.store.updateState((state) => { state.applied = { channel: "beta", version: "1.0.5", at, acceptedAt: null }; return state; });
      expect(harness.sync.listBackupInventory().reuseWindowStartMs).toBe(at);
      expect(entryFor(harness, seeded.file).at).toBeLessThan(at);
      await requireFreshChoice(harness);
    });

    it("a later activated run raises the historical floor while a later failed run does not", async () => {
      const { harness } = createBox();
      const older = seedLegacyArchive(harness, { ageMs: 6 * kHour, name: "openclaw-backup-1-older000.tar.gz" });
      const failed = seedLegacyArchive(harness, { ageMs: kHour, name: "openclaw-backup-2-failed00.tar.gz", activated: false });
      expect(harness.sync.listBackupInventory().reuseWindowStartMs).toBe(older.at - 1000);
      const activated = seedLegacyArchive(harness, { ageMs: 3 * kHour, name: "openclaw-backup-3-newer000.tar.gz", partial: true });
      expect(harness.sync.listBackupInventory().reuseWindowStartMs).toBe(activated.at - 1000);
      expect(entryFor(harness, activated.file).ineligibleReason).toBe("partial");
      expect(entryFor(harness, failed.file).operationId).toBe(failed.operationId);
      await requireFreshChoice(harness);
    });

    it("legacy restore verification can time out for one archive without poisoning another archive's independent verification", async () => {
      const { harness } = createBox();
      const older = seedLegacyArchive(harness, { ageMs: 4 * kHour, name: "openclaw-backup-1-older000.tar.gz" });
      const newer = seedLegacyArchive(harness, { ageMs: kHour, name: "openclaw-backup-2-newer000.tar.gz", activated: false });
      const calls = [];
      const runCommand = async (opts) => {
        calls.push([opts.command, opts.args[1]]);
        return opts.args[1] === newer.file ? { ok: false, timedOut: true, tail: "" } : answerArchiveTool(opts);
      };
      expect(await verifyArchiveManifest({ file: newer.file, runCommand, requiredArchivePaths: ["state/openclaw.sqlite"] })).toMatchObject({ ok: false, stage: "gzip" });
      expect(await verifyArchiveManifest({ file: older.file, runCommand, requiredArchivePaths: ["state/openclaw.sqlite"] })).toMatchObject({ ok: true, producer: "openclaw" });
      expect(calls).toEqual([["gzip", newer.file], ["gzip", older.file], ["tar", older.file]]);
      await requireFreshChoice(harness);
    });

    it("checkpoint verification binds bounded metadata reads to an opened no-follow inode instead of delegating pathname trust to archive tools", async () => {
      const { harness, recovery } = await captureStandalone();
      const metadata = path.join(recovery.file, "manifest.json");
      const observed = [];
      const fsModule = { ...fs, openSync(file, flags, ...args) {
        const fd = fs.openSync(file, flags, ...args);
        if (file === metadata) observed.push({ flags, inode: fs.fstatSync(fd).ino, named: fs.lstatSync(file).ino });
        return fd;
      } };
      expect(inspect(harness, recovery, fsModule).ok).toBe(true);
      expect(observed).toHaveLength(1);
      expect(observed[0].flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      expect(observed[0].inode).toBe(observed[0].named);
      expect(harness.runner.runStreamed.mock.calls.some(([opts]) => ["gzip", "tar"].includes(opts.command))).toBe(false);
    });

    it("refuses a checkpoint metadata pathname swapped after opening and before the bounded hash read finishes", async () => {
      const { harness, recovery } = await captureStandalone();
      const metadata = path.join(recovery.file, "manifest.json");
      let watchedFd, swapped = false;
      const fsModule = { ...fs,
        openSync(file, flags, ...args) { const fd = fs.openSync(file, flags, ...args); if (file === metadata) watchedFd = fd; return fd; },
        readSync(fd, ...args) {
          if (fd === watchedFd && !swapped) {
            swapped = true;
            fs.writeFileSync(`${metadata}.replacement`, fs.readFileSync(metadata), { mode: 0o600 });
            fs.renameSync(`${metadata}.replacement`, metadata);
          }
          return fs.readSync(fd, ...args);
        },
      };
      expect(inspect(harness, recovery, fsModule)).toMatchObject({ ok: false, reason: "CHECKPOINT_SOURCE_CHANGED" });
      expect(swapped).toBe(true);
    });

    it("checkpoint payload identity rejects same-byte inode replacement without depending on Linux /proc paths", async () => {
      const { harness, recovery } = await captureStandalone({ extraSyncOptions: { platform: "darwin" } });
      const payload = path.join(recovery.file, "payload/openclaw.json");
      const before = fs.statSync(payload).ino;
      const bytes = fs.readFileSync(payload);
      fs.writeFileSync(`${payload}.replacement`, bytes, { mode: 0o600 });
      fs.renameSync(`${payload}.replacement`, payload);
      expect(fs.statSync(payload).ino).not.toBe(before);
      expect(fs.readFileSync(payload)).toEqual(bytes);
      expect(inspect(harness, recovery)).toMatchObject({ ok: false, reason: "CHECKPOINT_PAYLOAD_CHANGED" });
      expect(entryFor(harness, recovery.file)).toMatchObject({ verified: false, recovery: { restore: { configAvailable: false, databaseSetAvailable: false } } });
    });

    it("marks a future-dated archive ineligible and never accepts it as migration protection", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: -2 * kHour });
      expect(entryFor(harness, seeded.file)).toMatchObject({ eligible: false, ineligibleReason: "future_dated" });
      await requireFreshChoice(harness);
      expect(harness.ledger.listRuns().filter((run) => run.backup?.noBackup === false)).toHaveLength(1);
    });

    it("preserves clock-skew tolerance in legacy history without reviving reuse authorization", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness, { ageMs: -(kOpenclawBackupClockSkewToleranceMs - 1000) });
      expect(entryFor(harness, seeded.file)).toMatchObject({ eligible: true, ineligibleReason: null });
      expect(entryFor(harness, seeded.file).at).toBeGreaterThan(harness.nowRef.now);
      await requireFreshChoice(harness);
    });

    it("an unconfirmed gateway stop blocks database capture even with a verified historical archive", async () => {
      const quiesce = makeQuiesceRecorder({ stopResult: false });
      const { harness, backupCalls } = createBox({ quiesce });
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, recoveryMode: "database_set" });
      expect(result).toMatchObject({ status: 409, body: { code: "gateway_stop_unconfirmed" } });
      expect(quiesce.stop).toHaveBeenCalledTimes(1);
      expect(quiesce.dbQuiet).not.toHaveBeenCalled();
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(harness.store.readState().applied).toBeNull();
      expect(entryFor(harness, seeded.file).verified).toBe(true);
      expect(result.body.reusableBackup).toBeUndefined();
      expect(backupCalls).toHaveLength(0);
    });

    it("a bounded checkpoint failure unwinds its single pause before an independent legacy restore verification", async () => {
      const quiesce = makeQuiesceRecorder();
      const error = Object.assign(new Error("capture deadline"), { code: "CHECKPOINT_BUDGET" });
      const { harness } = createBox({ migrating: false, quiesce,
        extraSyncOptions: { fsModule: failCheckpointWrite(error, () => quiesce.calls.push(`capture:${isStateDbQuiet()}`)) } });
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result).toMatchObject({ status: 409, body: { code: "CHECKPOINT_BUDGET" } });
      expect(quiesce.calls.indexOf("capture:true")).toBeLessThan(quiesce.calls.indexOf("dbResume"));
      expect(quiesce.calls.indexOf("dbResume")).toBeLessThan(quiesce.calls.indexOf("start"));
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      const verified = await verifyArchiveManifest({ file: seeded.file, requiredArchivePaths: ["state/openclaw.sqlite"], runCommand: async (opts) => {
        expect(isStateDbQuiet()).toBe(false);
        expect(quiesce.start).toHaveBeenCalledTimes(1);
        return answerArchiveTool(opts);
      } });
      expect(verified.ok).toBe(true);
      expect(harness.store.readState().applied).toBeNull();
    });

    it("standalone checkpoints verify while paused and publish terminal success only after the old gateway relaunches", async () => {
      const captureStates = [];
      const { harness, quiesce } = createBox({ migrating: false, extraSyncOptions: { fsModule: { ...fs,
        openSync(file, flags, ...args) {
          if (flags === "wx" && String(file).endsWith("/manifest.json") && String(file).includes(".staging")) captureStates.push(isStateDbQuiet());
          return fs.openSync(file, flags, ...args);
        },
      } } });
      const seeded = seedLegacyArchive(harness);
      quiesce.start.mockImplementation(async () => {
        quiesce.calls.push("start");
        expect(isStateDbQuiet()).toBe(false);
        const record = harness.ledger.listRuns().find((run) => run.target.kind === "backup");
        expect(record.state).toBe("running");
        expect(record.recovery.checkpoint.verified).toBe(true);
        expect(inspect(harness, record.recovery).ok).toBe(true);
      });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      expect(captureStates).toEqual([true]);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
      expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "completed", ok: true });
      expect(result.body.recovery.file).not.toBe(seeded.file);
      expect(result.body.recovery.checkpoint.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("legacy restore verification retains its own bounded budget after a fresh checkpoint budget expires", async () => {
      const error = Object.assign(new Error("capture deadline"), { code: "CHECKPOINT_BUDGET" });
      const { harness } = createBox({ migrating: false, extraSyncOptions: { fsModule: failCheckpointWrite(error) } });
      const seeded = seedLegacyArchive(harness);
      expect((await harness.sync.applyUpdate(kHardGateTarget)).body.code).toBe("CHECKPOINT_BUDGET");
      const timeouts = [];
      let now = 0;
      const verified = await verifyArchiveManifest({ file: seeded.file, requiredArchivePaths: ["state/openclaw.sqlite"], nowFn: () => now,
        runCommand: async (opts) => { timeouts.push(opts.timeoutMs); now += 10; return answerArchiveTool(opts); } });
      expect(verified.ok).toBe(true);
      expect(timeouts).toEqual([kOpenclawBackupReuseVerifyTimeoutMs, kOpenclawBackupReuseVerifyTimeoutMs - 10]);
      expect(harness.store.readState().applied).toBeNull();
    });

    it("losing lifecycle ownership inside the single pause refuses publication rather than substituting a legacy archive", async () => {
      const quiesce = makeQuiesceRecorder();
      let lease;
      const quiet = quiesce.dbQuiet.getMockImplementation();
      quiesce.dbQuiet.mockImplementation(async (opts) => { const token = await quiet(opts); lease(); return token; });
      const { harness } = createBox({ quiesce, extraSyncOptions: { acquireLifecycleLock: async (kind, options) => {
        lease = await quiesce.lock.acquire(kind, options);
        return lease;
      } } });
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, recoveryMode: "database_set" });
      expect(result).toMatchObject({ status: 409, body: { code: "lease_expired" } });
      expect(quiesce.stop).toHaveBeenCalledTimes(1);
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(isStateDbQuiet()).toBe(false);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(harness.store.readState().applied).toBeNull();
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
      expect(harness.sync.listBackupInventory().entries.filter((entry) => entry.producer === "alphaclaw-checkpoint")).toHaveLength(0);
    });

    it("legacy verifier timeout preserves the archive without quarantine or false corruption and cannot authorize a new apply", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness);
      const result = await verifyArchiveManifest({ file: seeded.file, requiredArchivePaths: ["state/openclaw.sqlite"],
        runCommand: async () => ({ ok: false, code: null, tail: "", timedOut: true }) });
      expect(result).toMatchObject({ ok: false, stage: "gzip" });
      expect(result.reason).toMatch(/timed? ?out/i);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
      expect(fs.existsSync(`${seeded.file}.unverified`)).toBe(false);
      expect(entryFor(harness, seeded.file)).toMatchObject({ exists: true, verified: true });
      await requireFreshChoice(harness);
    });

    it("ENOSPC during fresh checkpoint capture cannot fall back to a perfect historical candidate", async () => {
      const writes = vi.fn();
      const { harness, quiesce, backupCalls } = createBox({ migrating: false,
        extraSyncOptions: { fsModule: failCheckpointWrite(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), writes) } });
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate(kHardGateTarget);
      expect(result).toMatchObject({ status: 500, body: { code: "apply_failed" } });
      expect(result.body.message).toContain("ENOSPC");
      expect(writes).toHaveBeenCalledTimes(1);
      expect(result.body.reusableBackup).toBeUndefined();
      expect(harness.store.readState().applied).toBeNull();
      expect(quiesce.stop).toHaveBeenCalledTimes(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(backupCalls).toHaveLength(0);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
    });

    it("same-schema stable applies use fresh config-only protection rather than a legacy reuse warning", async () => {
      const { harness } = createBox({ migrating: false });
      const seeded = seedLegacyArchive(harness);
      const result = await harness.sync.applyUpdate(kSoftGateTarget);
      expect(result.status).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", consent: { required: false, recorded: false }, databases: { complete: false, entries: [] } });
      expect(result.body.recovery.file).not.toBe(seeded.file);
      expect(harness.ledger.readRun(result.body.operationId).backup?.reused).not.toBe(true);
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
    });

    it("a verified historical archive never satisfies migration protection; explicit database_set captures and verifies new database bytes", async () => {
      const { harness } = createBox();
      const seeded = seedLegacyArchive(harness);
      await requireFreshChoice(harness);
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, recoveryMode: "database_set" });
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true }, consent: { recorded: false } });
      expect(result.body.recovery.file).not.toBe(seeded.file);
      const verified = await readRecoveryCheckpoint(result.body.recovery.file, { operationId: result.body.operationId });
      expect(verified.databases.entries.map((entry) => entry.dbKind).sort()).toEqual(["agent", "state"]);
      const db = new DatabaseSync(path.join(verified.file, "payload/state/openclaw.sqlite"), { readOnly: true });
      try { expect(db.prepare("SELECT count(*) AS n FROM t").get().n).toBe(5); } finally { db.close(); }
      expect(harness.ledger.readRun(result.body.operationId).dbPreflight.migrationRequired).toBe(true);
      expect(eventsOfType(harness.insertEvent, "backup_reused")).toHaveLength(0);
      expect(sha256Of(seeded.file)).toBe(seeded.sha256);
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
      return operationId;
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
      const failed = crypto.randomUUID();
      harness.ledger.createRun({ operationId: failed, target: {} });
      harness.ledger.updateRun(failed, (run) => ({ ...run, startedAt: harness.nowRef.now - 1000,
        state: "failed", dbPreflight: { migrationRequired: true }, backup: null }));

      const result = await harness.sync.runStandaloneBackup();

      expect(result.status).toBe(200);
      const names = fs.readdirSync(backupsDir).sort();
      expect(names).toContain("openclaw-backup-1-pinned00.tar.gz");
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(4);
      expect(names).toContain("openclaw-backup-2-newer000.tar.gz");
      expect(result.body.recovery.kind).toBe("config_only");
    });

    it("expires an old migration pin without removing its rollback fence or historical archive", async () => {
      const { selectMigrationBackupProtection } = require("../../lib/server/openclaw-backup-retention");
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const { backupsDir, pinned } = seedOldArchives(harness);
      const operationId = seedMigratedRun(harness, { file: pinned, ageMs: 8 * 24 * 60 * 60 * 1000 });
      const historicalBytes = fs.readFileSync(pinned);
      const before = selectMigrationBackupProtection(harness.ledger.listRuns(), { nowMs: harness.nowRef.now });
      expect(before).toMatchObject({ run: { operationId, dbPreflight: { migrationRequired: true } },
        pinnedOperationId: null, pinnedOperationIds: [], pinnedArchiveFile: null, pinnedArchiveFiles: [] });

      const result = await harness.sync.runStandaloneBackup();

      expect(result.status).toBe(200);
      const names = fs.readdirSync(backupsDir);
      expect(names).toContain("openclaw-backup-1-pinned00.tar.gz");
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(4);
      expect(fs.readFileSync(pinned)).toEqual(historicalBytes);
      const after = selectMigrationBackupProtection(harness.ledger.listRuns(), { nowMs: harness.nowRef.now });
      expect(after.run.operationId).toBe(operationId);
      expect(after.pinnedArchiveFiles).toEqual([]);
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

      const result = await harness.sync.sweepBackupDebris({ mode: "boot" });
      expect(result.removed.map((entry) => entry.name)).toContain(path.basename(stale));
      const names = fs.readdirSync(backupsDir).sort();
      expect(names).not.toContain(path.basename(stale));
      expect(names).toContain(path.basename(fresh));
      expect(names).toContain(path.basename(notADir));
      expect(names.filter((n) => /^openclaw-backup-.*\.tar\.gz$/.test(n))).toHaveLength(0);
    });
  });

  // ── Issue #79 (g) `.tmp` hygiene + (h) progress ──────────────────────────
  describe("backup debris sweep: the 2026.9.x CLI's publish staging dir (v0.9.81)", () => {
    it("boot mode removes every `.openclaw-backup-publish-*` dir; in-run mode only one older than the CLI ceiling + slack; a failed attempt's cleanup removes the one it left", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      // The age rule compares real mtimes against the logical clock: give the
      // clock a realistic epoch so "older than the ceiling" is representable.
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      const stale = path.join(backupsDir, ".openclaw-backup-publish-aaaa-stale0");
      const young = path.join(backupsDir, ".openclaw-backup-publish-bbbb-young0");
      fs.mkdirSync(stale, { recursive: true });
      fs.mkdirSync(young, { recursive: true });
      fs.writeFileSync(path.join(stale, "archive.tar.gz.tmp"), "x".repeat(500));
      fs.writeFileSync(path.join(young, "archive.tar.gz.tmp"), "y".repeat(300));
      const oldMs = (harness.nowRef.now - kDefaultBackupBudget.phaseEnvelopeMs - kOpenclawBackupStaleTempDirSlackMs - 60_000) / 1000;
      fs.utimesSync(stale, oldMs, oldMs);

      const inRun = await harness.sync.sweepBackupDebris({ mode: "in-run" });
      expect(inRun.removed.map((r) => r.name)).toEqual([".openclaw-backup-publish-aaaa-stale0"]);
      expect(inRun.removed[0]).toEqual(expect.objectContaining({ bytes: 500, why: "stale" }));
      expect(inRun.kept).toContain(".openclaw-backup-publish-bbbb-young0");
      expect(fs.existsSync(young)).toBe(true);

      const boot = await harness.sync.sweepBackupDebris({ mode: "boot" });
      expect(boot.removed.map((r) => r.name)).toContain(".openclaw-backup-publish-bbbb-young0");
      expect(fs.existsSync(young)).toBe(false);
    });
  });

  describe("backup debris sweep (#79 (g), Codex 18) and the progress ticker (#79 (h))", () => {
    const kMinute = 60_000;
    const kStaleTmpAgeMs = kDefaultBackupBudget.phaseEnvelopeMs + kOpenclawBackupStaleTempDirSlackMs + kMinute;
    const kBetweenAgeMs = kOpenclawBackupOfflineCopyBudgetMs + kOpenclawBackupStaleTempDirSlackMs + kMinute;
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
        betweenTmp: put("openclaw-backup-850-between.alphaclaw.tar.gz.aaaaaaaa-0000-4000-8000-000000000003.tmp", "b".repeat(1024), kBetweenAgeMs),
        staleTmp: put("openclaw-backup-800-stale.alphaclaw.tar.gz.aaaaaaaa-0000-4000-8000-000000000002.tmp", "y".repeat(8192), kStaleTmpAgeMs),
        newerUnverified: put("openclaw-backup-700-newer.tar.gz.unverified", "n".repeat(100), 2 * kMinute),
        olderUnverified: put("openclaw-backup-600-older.tar.gz.unverified", "o".repeat(200), 3 * kMinute),
        archive: put("openclaw-backup-500-keep.tar.gz", "archive\n", 4 * kMinute),
        note: put("operator-note.txt", "keep me\n", kStaleTmpAgeMs),
        staleDir: mkdir(`${kOfflineCopyTempDirPrefix}4242-deadbeef`, kBetweenAgeMs),
        freshDir: mkdir(`${kOfflineCopyTempDirPrefix}4243-cafef00d`, kMinute),
      };
      fs.symlinkSync(path.join(backupsDir, names.archive), path.join(backupsDir, "link.tmp"));
      names.link = "link.tmp";
      return names;
    };
    const logLines = (logger) => logger.log.mock.calls.map(([line]) => String(line));
    const mkLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
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
        mode: "boot", removed: [], removedBytes: 0, kept: [], errors: [],
      });
      expect(fs.existsSync(backupsDir)).toBe(false);
      await expect(harness.sync.sweepBackupDebris({ mode: "later" })).rejects.toThrow(/unknown mode "later"/);
      await expect(harness.sync.sweepBackupDebris()).rejects.toThrow(/unknown mode/);
    });

    it("checkpoint failure removes its owned staging only; a subsequent in-run sweep removes stale legacy temps and preserves younger files", async () => {
      const writes = vi.fn();
      const { runnerImpl, backupCalls } = makeBackupRunner();
      const harness = createHarness({ runnerImpl, extraSyncOptions: {
        fsModule: failCheckpointWrite(Object.assign(new Error("capture cancelled"), { code: "CHECKPOINT_CANCELLED" }), writes),
      } });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups/openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);
      const operationId = crypto.randomUUID();
      const result = await harness.sync.applyUpdate({ ...kHardGateTarget, operationId });
      expect(result).toMatchObject({ status: 409, body: { code: "CHECKPOINT_CANCELLED" } });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(backupsDir).sort()).toEqual(Object.values(d).sort());
      expect(harness.ledger.readRun(operationId)).toMatchObject({ state: "failed", ok: false });
      expect(harness.store.readState().applied).toBeNull();
      expect(backupCalls).toHaveLength(0);
      const summary = await harness.sync.sweepBackupDebris({ mode: "in-run" });
      expect(summary.removed).toEqual([{ name: d.staleTmp, bytes: 8192, why: "stale" }]);
      expect(fs.readdirSync(backupsDir).sort()).toEqual(Object.values(d).filter((name) => name !== d.staleTmp).sort());
    });

    it("a checkpoint that disappears during relaunch never publishes success, and unrelated debris remains through pause unwind", async () => {
      const quiesce = makeQuiesceRecorder();
      const operationEvents = mkOperationEvents();
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce, extraSyncOptions: { operationEvents } });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups/openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);
      const presence = [];
      let vanished;
      quiesce.dbResume.mockImplementation((quiet) => {
        presence.push(["resume", fs.existsSync(path.join(backupsDir, d.staleTmp))]);
        quiet?.release?.();
      });
      quiesce.start.mockImplementation(async () => {
        presence.push(["start", fs.existsSync(path.join(backupsDir, d.staleTmp))]);
        expect(isStateDbQuiet()).toBe(false);
        const record = harness.ledger.listRuns().find((run) => run.target.kind === "backup");
        vanished = record.recovery.file;
        expect(fs.existsSync(path.join(vanished, "ready.json"))).toBe(true);
        fs.rmSync(vanished, { recursive: true });
      });
      quiesce.unsuppress.mockImplementation(() => presence.push(["unsuppress", fs.existsSync(path.join(backupsDir, d.staleTmp))]));
      const result = await harness.sync.runStandaloneBackup();
      expect(result).toMatchObject({ status: 409, body: { code: "CHECKPOINT_PAYLOAD_CHANGED" } });
      expect(presence).toEqual([["resume", true], ["start", true], ["unsuppress", true]]);
      expect(quiesce.stop).toHaveBeenCalledTimes(1);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(isStateDbQuiet()).toBe(false);
      expect(operationEvents.complete).not.toHaveBeenCalled();
      expect(operationEvents.fail).toHaveBeenCalledTimes(1);
      expect(harness.ledger.readRun(result.body.operationId)).toMatchObject({ state: "failed", ok: false });
      expect(harness.sync.listBackupInventory().entries.find((entry) => entry.file === vanished)).toMatchObject({ exists: false, verified: false });
      const summary = await harness.sync.sweepBackupDebris({ mode: "in-run" });
      expect(summary.removed.map((entry) => entry.name)).toEqual([d.staleTmp]);
      expect(fs.existsSync(path.join(backupsDir, d.note))).toBe(true);
      expect(fs.lstatSync(path.join(backupsDir, d.link)).isSymbolicLink()).toBe(true);
    });

    it("config checkpoint progress rewrites one running row in place and reaches SSE and the ledger before completion", async () => {
      const events = [];
      const operationEvents = mkOperationEvents();
      operationEvents.publish.mockImplementation((id, event) => events.push({ id, ...structuredClone(event) }));
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, extraSyncOptions: { operationEvents } });
      const authDir = path.join(harness.openclawDir, "agents/main/agent");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "auth-profiles.json"), "{}");
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      const running = events.filter((event) => event.event === "step" && event.data.name === "backup" && event.data.status === "running");
      expect(running.map((event) => event.data.detail)).toEqual([
        "Capturing configuration; databases are not copied", "Configuration checkpoint: 1 files", "Configuration checkpoint: 2 files",
      ]);
      expect(new Set(running.map((event) => event.data.at)).size).toBe(1);
      const lastProgress = events.findIndex((event) => event.data.detail === "Configuration checkpoint: 2 files");
      const completed = events.findIndex((event) => event.event === "step" && event.data.name === "backup" && event.data.status === "completed");
      expect(lastProgress).toBeGreaterThan(-1);
      expect(lastProgress).toBeLessThan(completed);
      const record = harness.ledger.readRun(result.body.operationId);
      expect(record.steps.filter((step) => step.name === "backup")).toEqual([
        expect.objectContaining({ status: "running", detail: "Configuration checkpoint: 2 files" }),
        expect.objectContaining({ status: "completed", detail: "Configuration checkpoint verified; databases omitted" }),
      ]);
      expect(record.recovery.checkpoint.fileCount).toBe(2);
      expect(harness.sync.getChannelInfo().lastUpdateRun).toBeNull();
      expect(operationEvents.complete).toHaveBeenCalledWith(result.body.operationId, expect.objectContaining({ ok: true }));
    });

    it("retained archive progress samples staging bytes, follows same-inode publication without double counting, and stops trusting a replaced root", () => {
      const { createBackupProgress } = require("../../lib/server/openclaw-backup-progress");
      const root = mkTemp("alphaclaw-debris-progress-");
      const outputFile = path.join(root, "openclaw-backup-1-progress.tar.gz");
      const staging = `${outputFile}.11111111-2222-4333-8444-555555555555.tmp`;
      const progress = createBackupProgress({ root, outputFile });
      fs.writeFileSync(staging, "s".repeat(3_000_000));
      expect(progress.sample()).toEqual({ doneBytes: 3_000_000, stage: "write" });
      fs.renameSync(staging, outputFile);
      expect(progress.sample()).toEqual({ doneBytes: 3_000_000, stage: "verify" });
      expect(progress.probe()).toEqual({ bytes: 3_000_000, phase: "verify" });
      fs.renameSync(root, `${root}-old`);
      fs.mkdirSync(root);
      fs.writeFileSync(outputFile, "n".repeat(4_000_000));
      expect(progress.ownsRoot()).toBe(false);
      expect(progress.sample()).toEqual({ doneBytes: 3_000_000, stage: "verify" });
    });

    it("new progress updates never overwrite a failed predecessor's terminal result or a completed backup outcome", async () => {
      let failManifest = true;
      const events = [];
      const operationEvents = mkOperationEvents();
      operationEvents.publish.mockImplementation((id, event) => events.push({ id, ...structuredClone(event) }));
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, extraSyncOptions: { operationEvents, fsModule: { ...fs,
        openSync(file, flags, ...args) {
          if (failManifest && flags === "wx" && String(file).endsWith("/manifest.json") && String(file).includes(".staging")) throw Object.assign(new Error("checkpoint limit"), { code: "CHECKPOINT_LIMIT" });
          return fs.openSync(file, flags, ...args);
        },
      } } });
      const failed = await harness.sync.runStandaloneBackup();
      expect(failed).toMatchObject({ status: 409, body: { code: "CHECKPOINT_LIMIT" } });
      const before = harness.ledger.readRun(failed.body.operationId);
      expect(before).toMatchObject({ state: "failed", result: { code: "CHECKPOINT_LIMIT" } });
      expect(before.steps.some((step) => step.detail === "Configuration checkpoint: 1 files")).toBe(true);
      expect(before.steps.some((step) => step.status === "completed")).toBe(false);
      failManifest = false;
      harness.nowRef.now += 1;
      const succeeded = await harness.sync.runStandaloneBackup();
      expect(succeeded.status).toBe(200);
      expect(harness.ledger.readRun(failed.body.operationId)).toEqual(before);
      const secondEvents = events.filter((event) => event.id === succeeded.body.operationId);
      const completed = secondEvents.findIndex((event) => event.data.status === "completed");
      expect(completed).toBeGreaterThan(0);
      expect(secondEvents.slice(completed + 1).filter((event) => event.data.status === "running")).toEqual([]);
      expect(harness.ledger.readRun(succeeded.body.operationId).steps.at(-1)).toMatchObject({ status: "completed", detail: "Configuration checkpoint verified; databases omitted" });
      expect(operationEvents.fail).toHaveBeenCalledTimes(1);
      expect(operationEvents.complete).toHaveBeenCalledTimes(1);
    });

    it("standalone success prunes legacy temp debris only after relaunch, keeps the newest quarantine and preserves unrelated files", async () => {
      const logger = mkLogger();
      const quiesce = makeQuiesceRecorder();
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
        extraSyncOptions: { logger, readBackupBudgetBytes: () => 1024 } });
      harness.nowRef.now = kRealisticNow;
      const backupsDir = path.join(harness.rootDir, "backups/openclaw");
      const d = seedDebris(backupsDir, kRealisticNow);
      quiesce.start.mockImplementation(async () => {
        expect(fs.existsSync(path.join(backupsDir, d.staleTmp))).toBe(true);
        expect(fs.existsSync(path.join(backupsDir, d.olderUnverified))).toBe(true);
        expect(isStateDbQuiet()).toBe(false);
      });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      expect(quiesce.start).toHaveBeenCalledTimes(1);
      expect(quiesce.lock.getActiveOperation()).toBeNull();
      expect(fs.readdirSync(backupsDir).sort()).toEqual([path.basename(result.body.recovery.file), d.archive, d.newerUnverified, d.freshDir, d.link, d.note].sort());
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false } });
      expect(fs.readFileSync(path.join(backupsDir, d.note), "utf8")).toBe("keep me\n");
      expect(fs.lstatSync(path.join(backupsDir, d.link)).isSymbolicLink()).toBe(true);
    });

    it("clean standalone checkpoint retention keeps the verified artifact without inventing a legacy archive-budget warning", async () => {
      const logger = mkLogger();
      const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl,
        extraSyncOptions: { logger, readBackupBudgetBytes: () => 1024 } });
      const result = await harness.sync.runStandaloneBackup();
      expect(result.status).toBe(200);
      expect(logLines(logger).filter((line) => /backup retention warning/.test(line))).toEqual([]);
      expect(fs.readdirSync(path.join(harness.rootDir, "backups/openclaw"))).toEqual([path.basename(result.body.recovery.file)]);
      expect(harness.sync.listBackupInventory().entries).toEqual([expect.objectContaining({ file: result.body.recovery.file, verified: true, producer: "alphaclaw-checkpoint" })]);
    });

    it("describeBackupProgress: the one line every surface carries — rung label, pause marker, bytes-of-total with percent or bytes-so-far, stage, elapsed (never over 100%)", () => {
      expect(describeBackupProgress({ rung: "offline_copy", quiesced: true, elapsedMs: 65_000, doneBytes: 120e6, totalBytes: 900e6, stage: "sqlite_backup" })).toBe("AlphaClaw offline copy in progress (gateway paused): 120 MB of 900 MB (13%), sqlite backup — 1m 5s elapsed");
      expect(describeBackupProgress({ rung: "upstream", elapsedMs: 45_000, doneBytes: 1.2e9 })).toBe("upstream backup create in progress: 1.2 GB written so far — 45s elapsed");
      expect(describeBackupProgress({ rung: "upstream", quiesced: true, elapsedMs: 0 })).toBe("upstream backup create in progress (gateway paused): nothing written yet — 0s elapsed");
      expect(describeBackupProgress({ rung: "offline_copy", quiesced: true, elapsedMs: 3000 })).toBe("AlphaClaw offline copy in progress (gateway paused): sizing the copy set — 3s elapsed");
      expect(describeBackupProgress({ rung: "offline_copy", doneBytes: 10, totalBytes: 5 })).toMatch(/\(100%\)/);
      expect(describeBackupProgress({ rung: "offline_copy", doneBytes: 512, totalBytes: 0 })).toMatch(/1 KB written so far/);
      expect(kDefaultBackupBudget.progressIntervalMs).toBe(15_000);
    });
  });

  // ── Archives carry credentials: 0700 directory, 0600 files ───────────────
  describe("archive and directory permissions", () => {
    it("repairs an existing world-readable backups dir and publishes private checkpoint directories and payloads", async () => {
      const { runnerImpl } = makeBackupRunner({});
      const harness = createHarness({ runnerImpl });
      const backupsDir = path.join(harness.rootDir, "backups", "openclaw");
      // An operator (or an older release under umask 022) created it 0755.
      fs.mkdirSync(backupsDir, { recursive: true });
      fs.chmodSync(backupsDir, 0o755);

      const result = await harness.sync.runStandaloneBackup();

      expect(result.status).toBe(200);
      expect(fs.statSync(backupsDir).mode & 0o777).toBe(0o700);
      const recovery = harness.ledger.readRun(result.body.operationId).recovery;
      expect(recovery.checkpoint.verified).toBe(true);
      expect(fs.statSync(recovery.file).mode & 0o777).toBe(0o700);
      for (const name of ["manifest.json", "ready.json", "payload/openclaw.json"]) {
        expect(fs.statSync(path.join(recovery.file, name)).mode & 0o777).toBe(0o600);
      }
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

describe("issue #99 cumulative fatal backup evidence", () => {
  beforeEach(() => resetStateDbQuietForTests({ listeners: true }));
  afterEach(() => resetStateDbQuietForTests({ listeners: true }));

  const { backupSafetyFailure } = require("../../lib/server/openclaw-backup-fallback");
  const fatalTails = [
    ["disk_full", "ENOSPC: no space left on device", "ENOSPC"],
    ["source_corrupt", "database disk image is malformed", "SQLITE_CORRUPT"],
  ];

  it.each(fatalTails.flatMap(([kind, message]) => [
    [kind, "killed", message, { signal: "SIGKILL" }],
    [kind, "timeout", message, { timedOut: true }],
  ]))("retains legacy %s classification when transport reports %s", (kind, _transport, message, transport) => {
    expect(backupSafetyFailure({ message, ...transport })).toBe(kind);
    expect(backupSafetyFailure(transport)).toBeNull();
  });

  it.each(fatalTails.flatMap(([kind, message, code]) => [
    [kind, "killed", message, code, { signal: "SIGKILL" }],
    [kind, "timeout", message, code, { timedOut: true }],
  ]))("unwinds paused capture after %s evidence despite a %s transport flag", async (kind, _transport, message, code, transport) => {
    const quiesce = makeQuiesceRecorder();
    const error = Object.assign(new Error(message), { code, ...transport });
    const writes = vi.fn(() => {
      expect(isStateDbQuiet()).toBe(true);
      expect(quiesce.lock.getActiveOperation()).toMatchObject({ kind: "apply_commit" });
    });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      extraSyncOptions: { fsModule: failCheckpointWrite(error, writes) } });
    seedStateDb(harness);

    const result = await harness.sync.applyUpdate(kHardGateTarget);

    expect(backupSafetyFailure(error)).toBe(kind);
    expect(result.status, JSON.stringify(result.body)).toBe(kind === "source_corrupt" ? 409 : 500);
    expect(result.body.code).toBe(kind === "source_corrupt" ? "db_preflight_failed" : "apply_failed");
    if (kind === "source_corrupt") expect(result.body.preflight).toMatchObject({ compatible: false,
      perDb: [{ status: "corrupt", reasons: ["SQLITE_CORRUPT"] }] });
    expect(result.body.backupRiskEligible).not.toBe(true);
    expect(writes).toHaveBeenCalledOnce();
    const run = harness.ledger.readRun(result.body.operationId || harness.store.readState().lastUpdateRun.operationId);
    expect(run.state).toBe("failed");
    expect(run.recovery?.checkpoint?.verified).not.toBe(true);
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(quiesce.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it.each([false, true])("legacy corruption wins over a workspace retry hint (nested cause: %s)", (nested) => {
    const hint = "Cannot reliably discover configured workspaces; retry with --no-include-workspace";
    const error = nested ? { message: hint, cause: { code: "SQLITE_CORRUPT" } }
      : { message: `database disk image is malformed\n${hint}` };
    expect(backupSafetyFailure(error)).toBe("source_corrupt");
    expect(backupSafetyFailure({ message: hint })).toBeNull();
  });

  it.each(fatalTails.flatMap(([kind, message]) => [
    [kind, true, message],
    [kind, false, message],
  ]))("legacy exit-zero metadata cannot erase %s evidence (artifact present: %s)", (kind, artifactPresent, message) => {
    const result = { ok: true, code: 0, artifactPresent };
    expect(backupSafetyFailure({ ...result, message })).toBe(kind);
    expect(backupSafetyFailure(result)).toBeNull();
  });
});

describe("issue #99 migration-minimal dispatcher", () => {
  beforeEach(() => resetStateDbQuietForTests({ listeners: true }));
  afterEach(() => resetStateDbQuietForTests({ listeners: true }));

  const checkpointHarness = ({ targetSchema, extraSyncOptions = {} } = {}) => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce,
      ...(targetSchema ? { targetSchema } : {}), extraSyncOptions });
    seedStateDb(harness);
    return { harness, quiesce, lock: quiesce.lock };
  };
  const interceptPayload = (onPayload) => ({ ...fs, openSync(file, flags, ...rest) {
    if (flags === "wx" && String(file).includes(`${path.sep}payload${path.sep}`)) onPayload(file);
    return fs.openSync(file, flags, ...rest);
  } });

  it("issue #102 captures an explicitly chosen database set and config inside one pause", async () => {
    const { harness, quiesce, lock } = checkpointHarness();
    seedAgentDb(harness, "main");

    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery).toMatchObject({ kind: "database_set", checkpoint: { verified: true },
      databases: { complete: true, verified: true, requiredPaths: ["agents/main/agent/openclaw-agent.sqlite", "state/openclaw.sqlite"] } });
    const snapshot = new DatabaseSync(path.join(result.body.recovery.file, "payload/state/openclaw.sqlite"), { readOnly: true });
    try { expect(snapshot.prepare("SELECT count(*) AS count FROM t").get().count).toBe(5); }
    finally { snapshot.close(); }
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    expect(lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it.each([
    ["timeout", "CHECKPOINT_BUDGET", 409],
    ["missing artifact", "CHECKPOINT_PAYLOAD_INVALID", 409],
    ["missing local file", "ENOENT", 500],
    ["generic I/O failure", "EIO", 500],
  ])("refuses a checkpoint %s once without fallback, reuse, or consent", async (failure, code, status) => {
    let harness;
    const writes = vi.fn();
    const injected = failure === "timeout" ? interceptPayload(() => {
      writes();
      harness.nowRef.now += 10_000;
    }) : failure === "missing artifact" ? {
      ...fs,
      openSync(file, flags, ...rest) {
        const fd = fs.openSync(file, flags, ...rest);
        if (flags === "wx" && String(file).includes(`${path.sep}payload${path.sep}`)) {
          writes();
          this.payloadFd = fd;
        }
        return fd;
      },
      writeFileSync(file, ...args) {
        if (file === this.payloadFd) return;
        return fs.writeFileSync(file, ...args);
      },
    } : failCheckpointWrite(Object.assign(new Error(code), { code }), writes);
    const cell = checkpointHarness({ extraSyncOptions: { fsModule: injected } });
    harness = cell.harness;

    const result = await harness.sync.applyUpdate(kHardGateTarget);

    expect(result.status, JSON.stringify(result.body)).toBe(status);
    expect(result.body.code).toBe(status === 409 ? code : "apply_failed");
    expect(result.body.backupRiskEligible).not.toBe(true);
    expect(writes).toHaveBeenCalledOnce();
    const run = harness.ledger.readRun(result.body.operationId || harness.store.readState().lastUpdateRun.operationId);
    expect(run.state).toBe("failed");
    expect(run.recovery?.checkpoint?.verified).not.toBe(true);
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(fs.readdirSync(path.join(harness.rootDir, "backups/openclaw"))).toEqual([]);
    expect(cell.quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(cell.quiesce.stop).toHaveBeenCalledOnce();
    expect(cell.quiesce.start).toHaveBeenCalledOnce();
    expect(cell.lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("a stable-channel schema migration requires a recovery choice and a verified explicit database set", async () => {
    const { harness, quiesce, lock } = checkpointHarness({ targetSchema: { state: 16, agent: 17 } });
    const choice = await harness.sync.applyUpdate(kSoftGateTarget);
    expect(choice.status, JSON.stringify(choice.body)).toBe(409);
    expect(choice.body).toMatchObject({ code: "recovery_choice_required", preflight: { migrationRequired: true },
      choices: ["database_set", "cancel"] });
    expect(quiesce.stop).not.toHaveBeenCalled();

    const result = await harness.sync.applyUpdate({ ...kSoftGateTarget, recoveryMode: "database_set" });

    expect(result.status, JSON.stringify(result.body)).toBe(202);
    const run = harness.ledger.readRun(result.body.operationId);
    expect(run.dbPreflight.migrationRequired).toBe(true);
    expect(run.recovery).toMatchObject({ kind: "database_set", checkpoint: { verified: true },
      databases: { complete: true, verified: true }, consent: { required: false, recorded: false } });
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).not.toHaveBeenCalled();
    expect(lock.getActiveOperation()).toMatchObject({ kind: "apply_commit" });
    expect(isStateDbQuiet()).toBe(true);
    await vi.waitFor(() => expect(harness.restartProcess).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("Back up now defaults to config-only with honest omitted-database coverage", async () => {
    const { harness, quiesce } = checkpointHarness();
    const result = await harness.sync.runStandaloneBackup();

    expect(result.status).toBe(200);
    expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true, fileCount: 1 },
      databases: { complete: false, verified: false, entries: [], requiredPaths: ["state/openclaw.sqlite"] },
      restore: { configAvailable: true, databaseSetAvailable: false } });
    expect(result.body.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
    expect(result.body.recovery.manifest.databases).toEqual([]);
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(harness.installToTempDir).not.toHaveBeenCalled();
    expect(harness.restartProcess).not.toHaveBeenCalled();
  });

  it("actual ENOSPC terminates fresh capture without a recovery artifact or risk consent", async () => {
    const writes = vi.fn();
    const { harness, quiesce, lock } = checkpointHarness({ extraSyncOptions: {
      fsModule: failCheckpointWrite(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), writes),
    } });
    const result = await harness.sync.applyUpdate(kSoftGateTarget);

    expect(result.status, JSON.stringify(result.body)).toBe(500);
    expect(result.body.code).toBe("apply_failed");
    expect(result.body.message).toContain("ENOSPC");
    expect(result.body.backupRiskEligible).not.toBe(true);
    expect(writes).toHaveBeenCalledOnce();
    expect(harness.ledger.readRun(result.body.operationId || harness.store.readState().lastUpdateRun.operationId).recovery).toBeUndefined();
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("does not grant a second pause after the bounded capture deadline is exhausted", async () => {
    let harness;
    const writes = vi.fn(() => { harness.nowRef.now += 25 * 60_000; });
    const cell = checkpointHarness({ extraSyncOptions: { fsModule: interceptPayload(writes) } });
    harness = cell.harness;
    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_BUDGET");
    expect(writes).toHaveBeenCalledOnce();
    expect(cell.quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(cell.quiesce.stop).toHaveBeenCalledOnce();
    expect(cell.quiesce.start).toHaveBeenCalledOnce();
    expect(cell.lock.getActiveOperation()).toBeNull();
    expect(harness.sync.listBackupInventory().entries).toEqual([]);
  });

  it.each(["excluded debris", "protected database"])("a config checkpoint stays bounded beside 513 MiB of %s", async (kind) => {
    const { harness } = checkpointHarness();
    const debris = path.join(harness.openclawDir, "workspace", "node_modules", kind === "protected database" ? "agent.sqlite" : "large-cache");
    fs.mkdirSync(path.dirname(debris), { recursive: true });
    if (kind === "protected database") {
      fs.renameSync(seedAgentDb(harness, "main"), debris);
      fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), JSON.stringify({ agents: { list: [
        { id: "main", agentDir: path.dirname(debris) },
      ] } }));
    }
    const fd = fs.openSync(debris, kind === "protected database" ? "r+" : "w");
    fs.ftruncateSync(fd, 513 * 1024 * 1024);
    fs.closeSync(fd);

    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.recovery.kind).toBe("config_only");
    expect(result.body.recovery.checkpoint.bytes).toBeLessThan(1024);
    expect(result.body.recovery.databases).toMatchObject({ complete: false, verified: false, entries: [] });
    expect(result.body.recovery.databases.requiredPaths).toEqual(kind === "protected database"
      ? ["state/openclaw.sqlite", "workspace/node_modules/agent.sqlite"] : ["state/openclaw.sqlite"]);
    expect(fs.existsSync(path.join(result.body.recovery.file, "payload/workspace"))).toBe(false);
    expect(fs.statSync(debris).size).toBe(513 * 1024 * 1024);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("a thrown missing-file capture error cleans its staging and releases ownership exactly once", async () => {
    const writes = vi.fn();
    const { harness, quiesce, lock } = checkpointHarness({ extraSyncOptions: {
      fsModule: failCheckpointWrite(Object.assign(new Error("open checkpoint payload ENOENT"), { code: "ENOENT" }), writes),
    } });
    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(500);
    expect(result.body.code).toBe("backup_failed");
    expect(writes).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(harness.rootDir, "backups/openclaw"))).toEqual([]);
    expect(quiesce.acquireLock).toHaveBeenCalledOnce();
    expect(quiesce.dbResume).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("rejects replacement of a verified checkpoint payload during gateway relaunch", async () => {
    const { harness, quiesce } = checkpointHarness();
    quiesce.start.mockImplementation(async () => {
      const recovery = harness.ledger.listRuns()[0].recovery;
      expect(recovery.checkpoint.verified).toBe(true);
      const payload = path.join(recovery.file, "payload/openclaw.json");
      fs.unlinkSync(payload);
      fs.writeFileSync(payload, "unchecked replacement after verification\n", { mode: 0o600 });
    });

    const result = await harness.sync.runStandaloneBackup();

    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.code).toBe("CHECKPOINT_PAYLOAD_CHANGED");
    const run = harness.ledger.readRun(result.body.operationId);
    expect(run.recovery.checkpoint.verified).toBe(false);
    expect(run.recovery.restore).toEqual({ configAvailable: false, databaseSetAvailable: false });
    expect(harness.sync.listBackupInventory().entries.some((entry) => entry.operationId === result.body.operationId && entry.verified)).toBe(false);
    expect(notifyMessages(harness.notify).some((message) => message.startsWith("Migration backup verified"))).toBe(false);
  });

  it("uses mandatory bounded payload hashes rather than an advisory streaming-hash timeout", async () => {
    const { Readable } = require("node:stream");
    const { harness, lock } = checkpointHarness({ extraSyncOptions: {
      fsModule: { ...fs, createReadStream: () => new Readable({ read() {} }) },
    } });
    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const recovery = harness.ledger.readRun(result.body.operationId).recovery;
    expect(recovery.checkpoint.verified).toBe(true);
    expect(recovery.checkpoint.manifestSha256).toBe(sha256Of(path.join(recovery.file, "manifest.json")));
    expect(recovery.manifest.files[0].sha256).toBe(sha256Of(path.join(recovery.file, "payload/openclaw.json")));
    expect(lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("a capture that loses its lease never restarts or releases its successor", async () => {
    let currentLease;
    let successor;
    let theft;
    let lock;
    const writes = vi.fn(() => {
      currentLease();
      theft = lock.acquire("operator_successor").then((hold) => { successor = hold; });
    });
    const cell = checkpointHarness({ extraSyncOptions: { fsModule: interceptPayload(writes) } });
    const { harness, quiesce } = cell;
    lock = cell.lock;
    const acquire = quiesce.acquireLock.getMockImplementation();
    quiesce.acquireLock.mockImplementation(async (options) => {
      currentLease = await acquire(options);
      return currentLease;
    });
    try {
      const result = await harness.sync.runStandaloneBackup();
      await theft;
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe("CHECKPOINT_LEASE_LOST");
      expect(writes).toHaveBeenCalledOnce();
      expect(quiesce.start).not.toHaveBeenCalled();
      expect(quiesce.unsuppress).not.toHaveBeenCalled();
      expect(lock.owns(successor)).toBe(true);
      expect(harness.sync.listBackupInventory().entries).toEqual([]);
      expect(isStateDbQuiet()).toBe(false);
    } finally { successor?.(); }
  });

  it("passes live ownership predicates through every checkpoint stop/start callback", async () => {
    const { harness, quiesce, lock } = checkpointHarness();
    const observations = [];
    for (const method of ["stop", "start"]) {
      quiesce[method].mockImplementation(async (options) => {
        const observation = { method, predicate: options?.shouldAbort, beforeAwait: options?.shouldAbort?.() };
        observations.push(observation);
        await Promise.resolve();
        observation.afterAwait = options?.shouldAbort?.();
        return true;
      });
    }
    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(observations).toEqual(["stop", "start"].map((method) => ({
      method, predicate: expect.any(Function), beforeAwait: false, afterAwait: false,
    })));
    expect(lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it.each([["stop", true], ["start", true], ["start", false]])("losing the checkpoint lease during async %s fails the operation without overstating artifact availability (helper checks after loss: %s)", async (method, checksAfterLoss) => {
    const { inspectRecoveryCheckpoint, readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
    const { harness, quiesce, lock } = checkpointHarness();
    const acquire = quiesce.acquireLock.getMockImplementation();
    let currentLease;
    let successor;
    const observations = [];
    quiesce.acquireLock.mockImplementation(async (options) => {
      currentLease = await acquire(options);
      return currentLease;
    });
    quiesce[method].mockImplementation(async (options) => {
      observations.push(options?.shouldAbort, options?.shouldAbort?.());
      await Promise.resolve();
      currentLease();
      successor = await lock.acquire("operator_successor");
      if (checksAfterLoss) observations.push(options?.shouldAbort?.());
      return false;
    });
    try {
      const result = await harness.sync.runStandaloneBackup();
      expect(observations).toEqual(checksAfterLoss
        ? [expect.any(Function), false, true] : [expect.any(Function), false]);
      const run = harness.ledger.readRun(result.body.operationId);
      const recovery = run.recovery;
      const expectedCode = method === "stop" ? "gateway_stop_unconfirmed" : "lease_expired";
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe(expectedCode);
      expect(run).toMatchObject({ state: "failed", result: { ok: false, code: expectedCode } });
      if (method === "stop") {
        expect(recovery?.checkpoint?.verified).not.toBe(true);
        expect(harness.sync.listBackupInventory().entries).toEqual([]);
      } else {
        expect(recovery.checkpoint.verified).toBe(true);
        expect(inspectRecoveryCheckpoint(recovery.file, { record: recovery,
          backupsDir: path.join(harness.rootDir, "backups/openclaw") }).ok).toBe(true);
        const verified = await readRecoveryCheckpoint(recovery.file, {
          operationId: result.body.operationId, sourceBuild: recovery.checkpoint.sourceBuild,
          targetBuild: recovery.checkpoint.targetBuild,
        });
        expect(verified.checkpoint).toEqual(recovery.checkpoint);
        expect(harness.sync.listBackupInventory().entries).toContainEqual(expect.objectContaining({
          operationId: result.body.operationId, file: recovery.file, verified: true,
        }));
      }
      expect(result.body.backupRiskEligible).not.toBe(true);
      expect(quiesce.acquireLock).toHaveBeenCalledOnce();
      expect(quiesce.start).toHaveBeenCalledTimes(method === "stop" ? 0 : 1);
      expect(quiesce.unsuppress).not.toHaveBeenCalled();
      expect(lock.owns(successor)).toBe(true);
      expect(isStateDbQuiet()).toBe(false);
      await flushAsync();
      expect(harness.notify.mock.calls.some(([, options]) => options?.id === `backup-done-${result.body.operationId}`)).toBe(false);
      expect(lock.owns(successor)).toBe(true);
    } finally { successor?.(); }
  });

  it("a hold established during the single pause cleanup prevents apply commitment", async () => {
    const { harness, quiesce, lock } = checkpointHarness({ extraSyncOptions: {
      fsModule: failCheckpointWrite(Object.assign(new Error("capture expired"), { code: "CHECKPOINT_BUDGET" })),
    } });
    quiesce.start.mockImplementation(async () => {
      harness.store.updateState((state) => {
        state.gatewayHold = { reason: "config_migration_failed", message: "new hold during checkpoint unwind", at: 1_000_001 };
        return state;
      });
    });
    const result = await harness.sync.applyUpdate(kHardGateTarget);

    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.code).toBe("gateway_held");
    expect(harness.store.readState()).toMatchObject({ applied: null, gatewayHold: { reason: "config_migration_failed" } });
    expect(quiesce.stop).toHaveBeenCalledOnce();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(lock.getActiveOperation()).toBeNull();
    expect(isStateDbQuiet()).toBe(false);
  });

  it("keeps captured state and bounded auth roots when the gateway environment changes during capture", async () => {
    let environment = {};
    let harness;
    const writes = vi.fn(() => {
      environment = { OPENCLAW_STATE_DIR: path.join(harness.rootDir, "successor-state"), HOME: harness.rootDir };
    });
    ({ harness } = checkpointHarness({ extraSyncOptions: {
      openclawSpawnEnv: () => ({ ...environment }), fsModule: interceptPayload(writes),
    } }));
    environment = { OPENCLAW_STATE_DIR: harness.openclawDir, OPENCLAW_HOME: harness.openclawDir,
      HOME: harness.rootDir, OPENCLAW_OAUTH_DIR: "~/credentials" };
    const auth = path.join(harness.openclawDir, "agents/main/agent/auth-profiles.json");
    fs.mkdirSync(path.dirname(auth), { recursive: true });
    fs.writeFileSync(auth, '{"captured":true}');
    fs.mkdirSync(path.join(harness.openclawDir, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(harness.openclawDir, "credentials/omitted.json"), '{"notInCoverage":true}');

    const result = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(writes).toHaveBeenCalledTimes(2);
    const { manifest } = result.body.recovery;
    expect(manifest.stateDir).toBe(harness.openclawDir);
    expect(manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json", "agents/main/agent/auth-profiles.json"]);
    expect(manifest.files.find((entry) => entry.kind === "auth").sourcePath).toBe(auth);
    expect(fs.readFileSync(path.join(result.body.recovery.file, "payload/agents/main/agent/auth-profiles.json"), "utf8")).toBe('{"captured":true}');
    expect(manifest.databases.map((entry) => entry.archivePath)).toEqual(["state/openclaw.sqlite"]);
    expect(result.body.recovery.databases.complete).toBe(true);
    expect(fs.existsSync(path.join(result.body.recovery.file, "payload/credentials"))).toBe(false);
  });
});

describe("config-first recovery contract", () => {
  beforeEach(() => resetStateDbQuietForTests({ listeners: true }));

  it("Back up now defaults to a bounded config_only checkpoint and never invokes an archive CLI", async () => {
    const { runnerImpl } = makeBackupRunner();
    const harness = createHarness({ runnerImpl });
    seedStateDb(harness);

    const result = await harness.sync.runStandaloneBackup();

    expect(result.status).toBe(200);
    expect(result.body.recovery.kind).toBe("config_only");
    expect(result.body.recovery.checkpoint).toMatchObject({ verified: true, fileCount: expect.any(Number) });
    expect(result.body.recovery.databases).toMatchObject({ complete: false, verified: false, entries: [] });
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    expect(harness.sync.listBackupInventory().entries.filter((entry) => entry.producer === "alphaclaw-checkpoint")).toHaveLength(1);
    expect(harness.sync.listBackupInventory().entries.some((entry) => entry.name.endsWith(".tar.gz"))).toBe(false);
  });

  it("requires an explicit database_set request for a complete SQLite checkpoint", async () => {
    const { runnerImpl } = makeBackupRunner();
    const harness = createHarness({ runnerImpl });
    seedStateDb(harness);

    const implicit = await harness.sync.runStandaloneBackup();
    const explicit = await harness.sync.runStandaloneBackup({ recoveryMode: "database_set" });

    expect(implicit.status, JSON.stringify(implicit.body)).toBe(200);
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(200);
    expect(implicit.body.recovery.kind).toBe("config_only");
    expect(explicit.body.recovery.kind).toBe("database_set");
    expect(explicit.body.recovery.databases).toMatchObject({ complete: true, verified: true, requiredPaths: ["state/openclaw.sqlite"] });
    expect(explicit.body.recovery.databases.entries.map((entry) => entry.path)).toEqual(["state/openclaw.sqlite"]);
    expect(harness.runner.runStreamed).not.toHaveBeenCalled();
    expect(harness.sync.listBackupInventory().entries.some((entry) => entry.name.endsWith(".tar.gz"))).toBe(false);
  });

  it("does not publish standalone recovery success when the gateway never becomes ready after relaunch", async () => {
    const quiesce = makeQuiesceRecorder();
    quiesce.probeReadiness.mockResolvedValue({ ok: true, kind: "not_ready", ready: false });
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });

    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(quiesce.probeReadiness).toHaveBeenCalled();
    expect(quiesce.start).toHaveBeenCalledOnce();
    expect(isStateDbQuiet()).toBe(false);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });

  it("refuses a standalone checkpoint whose payload changes during gateway relaunch", async () => {
    const quiesce = makeQuiesceRecorder();
    const harness = createHarness({ runnerImpl: makeBackupRunner().runnerImpl, gatewayQuiesce: quiesce });
    quiesce.start.mockImplementation(async () => {
      const recovery = harness.ledger.listRuns()[0].recovery;
      expect(recovery.checkpoint.verified).toBe(true);
      fs.writeFileSync(path.join(recovery.checkpoint.file, "payload", "openclaw.json"), '{"tampered":true}');
    });

    const result = await harness.sync.runStandaloneBackup();

    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.recovery?.checkpoint?.verified).not.toBe(true);
    expect(harness.sync.listBackupInventory().entries.some((entry) => entry.operationId === result.body.operationId && entry.verified)).toBe(false);
    expect(isStateDbQuiet()).toBe(false);
    expect(quiesce.lock.getActiveOperation()).toBeNull();
  });
});
