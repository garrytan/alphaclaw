// Shared harness for the LIVE backup tiers: runBackup (lib/server/
// openclaw-channel-sync.js) driving a REAL OpenClaw CLI against a throwaway
// state dir. The CLI is selectable — the repo's pinned 2026.7.1-2, or any
// exact version staged with liveHelpers.stageOpenclawVersion — so the same
// harness pins the pin's contract (openclaw-live-backup.e2e.test.js) and
// reproduces issue #54 against the real 2026.9.1-beta.1
// (openclaw-live-backup-contention.e2e.test.js).
//
// Mirrors tests/server/openclaw-channel-backup-retry.e2e.test.js's
// createHarness, but the runner is the REAL createRunStream and
// openclawSpawnEnv points the PATH-resolved `openclaw` at the real CLI via a
// shim. Only installToTempDir is faked (the backup step is the one under
// test; the download is the hermetic tier's business).
//
// Runtime note (recorded 2026-09-02): this box runs Node 22.23.2 with SQLite
// 3.51.3, which passes both upstream runtime gates (engines and the
// WAL-safety SQLite floor) natively. The earlier NODE_OPTIONS preload that
// faked those two version labels on a Node 24.14.1 box is gone — the CLIs
// run untouched.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const liveHelpers = require("./live-helpers");
const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const {
  listLiveOpenclawProcesses,
} = require("../../lib/server/openclaw-lock-contention");
const { kSilentLogger, mkTemp, repoOpenclawBin, scrubTestRunnerEnv } = liveHelpers;

const kPin = "1.0.0";
const kHardGateTarget = Object.freeze({ channel: "beta", version: "1.1.0-beta.1" });

// Env for real-CLI invocations, mirroring lib/server/gateway.js gatewayEnv's
// shape (HOME/OPENCLAW_HOME at the data root, state dir + config pinned,
// XDG_CONFIG_HOME, no auto-update) against an isolated fixture root. Built
// from a scrubbed process.env: the beta CLI silences stdout when it inherits
// VITEST, and vitest's NODE_OPTIONS loader flags perturb child startup.
const buildCliEnv = ({ homeDir, stateDir, pathPrefix = null }) => {
  const scrubbed = scrubTestRunnerEnv();
  const env = {
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    XDG_CONFIG_HOME: stateDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
    PATH: pathPrefix
      ? `${pathPrefix}${path.delimiter}${scrubbed.PATH}`
      : scrubbed.PATH,
  };
  for (const key of ["TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]) {
    if (scrubbed[key] !== undefined) env[key] = scrubbed[key];
  }
  return env;
};

const createFixtureDb = (dbPath) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE fixture (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO fixture (note) VALUES ('live-backup-e2e');",
    );
  } finally {
    db.close();
  }
};

// Issue #54's precondition: the 2026.9.1-beta.1 `backup create` takes its
// legacy-audit migration lease on the state DB ONLY when one of the legacy
// audit sources exists (verified in dist/state-migrations.audit-coordination:
// logs/config-audit.jsonl, audit/system-agent.jsonl, audit/crestodian.jsonl).
// A handful of JSONL records is enough to engage it.
const writeLegacyAuditLog = (stateDir, { records = 5 } = {}) => {
  const logPath = path.join(stateDir, "logs", "config-audit.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const lines = [];
  for (let i = 0; i < records; i += 1) {
    lines.push(
      JSON.stringify({
        ts: new Date(Date.now() - (records - i) * 60_000).toISOString(),
        event: "config.write",
        path: "gateway.port",
        seq: i,
      }),
    );
  }
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
  return logPath;
};

// Minimal state tree the CLI accepts (probed by running it): an empty-object
// openclaw.json, session transcripts, a plugin catalog, and real sqlite state
// DBs (both enumerateStateDbs shapes) so there is content to archive and the
// fresh-install carve-out cannot mask a missing artifact.
//
// agentDb: the per-agent openclaw-agent.sqlite. The pin archives any SQLite
// file; 2026.8.2+ refuses a fixture agent DB ("has no schema ownership
// metadata … a direct file copy was refused") while accepting a fixture
// GLOBAL state DB (it runs its own schema check on that one) — so the beta
// fixtures omit the agent DB.
const writeStateFixture = (
  homeDir,
  { jsonlFiles = 6, lockFiles = 2, legacyAuditLog = false, agentDb = true } = {},
) => {
  const stateDir = path.join(homeDir, ".openclaw");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const pluginDir = path.join(
    stateDir,
    "agents",
    "main",
    "agent",
    "plugins",
    "groq",
  );
  fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  const catalogPath = path.join(pluginDir, "catalog.json");
  fs.writeFileSync(catalogPath, `${JSON.stringify({ plugins: ["groq"] })}\n`);
  for (let i = 0; i < jsonlFiles; i += 1) {
    fs.writeFileSync(
      path.join(sessionsDir, `${String(i).padStart(4, "0")}-seed.jsonl`),
      `{"role":"user","seq":${i}}\n`,
    );
  }
  for (let i = 0; i < lockFiles; i += 1) {
    fs.writeFileSync(
      path.join(sessionsDir, `${String(i).padStart(4, "0")}-seed.jsonl.lock`),
      `${process.pid}\n`,
    );
  }
  const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
  createFixtureDb(stateDbPath);
  if (agentDb) {
    createFixtureDb(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
  }
  if (legacyAuditLog) writeLegacyAuditLog(stateDir);
  return { stateDir, sessionsDir, catalogPath, stateDbPath };
};

// Like the hermetic writePackageFixture, but the bin echoes ITS OWN version:
// with the real runner, verifyPackageArtifact genuinely executes
// `node <bin> --version` and demands an exact token match (and db-preflight
// runs `node <bin> database preflight ...`, where any exit-0 non-JSON output
// classifies as "pass").
const writeVersionedPackageFixture = (packageDir, { version }) => {
  fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" } }, null, 2)}\n`,
  );
  const binPath = path.join(packageDir, "bin", "entry.js");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
  );
  fs.writeFileSync(
    path.join(packageDir, "dist", "thinking-levels.js"),
    "exports.listThinkingLevelOptions = () => [];\n",
  );
  return packageDir;
};

// PATH shim: runBackup spawns command "openclaw" and lets PATH resolve it.
// The shim execs the SAME node this test runs on (process.execPath) so a
// stray older node on PATH can never fail the CLI's engines gate.
const writeOpenclawShim = (openclawBin) => {
  const shimDir = mkTemp("alphaclaw-live-backup-shim-");
  fs.writeFileSync(
    path.join(shimDir, "openclaw"),
    `#!/bin/sh\nexec "${process.execPath}" "${openclawBin}" "$@"\n`,
    { mode: 0o755 },
  );
  return shimDir;
};

// A gatewayQuiesce double for the REAL quiesced driver: records the call
// order, "stops" by calling onStop (the tests pause their writer there) and
// answers the stop-evidence probe the offline copy's exclusivity check reads.
const createQuiesceFake = ({ onStop = null, onStart = null } = {}) => {
  const calls = [];
  const fake = {
    calls,
    acquireLock: async () => {
      calls.push("acquireLock");
      return () => calls.push("release");
    },
    isRunning: async () => {
      calls.push("isRunning");
      return true;
    },
    suppress: () => calls.push("suppress"),
    unsuppress: () => calls.push("unsuppress"),
    stop: async () => {
      calls.push("stop");
      await onStop?.();
      return true;
    },
    start: async () => {
      calls.push("start");
      await onStart?.();
    },
    getStopEvidence: () => ({
      at: new Date().toISOString(),
      method: "managed_child",
      childExited: true,
      portReleased: true,
      cliRefused: false,
      cliExitCode: 0,
    }),
  };
  return fake;
};

// Replace the fixture's state DB with one the given CLI wrote itself:
// `approvals get --json` materializes that line's real schema (74 tables on
// the pin, 108/user_version 12 on the beta). Realistic for the #54 shape —
// the beta's lease heartbeat only logs "[sqlite/transaction] SQLite
// transaction lock wait failed" against a real-schema DB; a fixture DB takes
// its "schema migration pending" path and prints only the timeout line.
const materializeStateDb = ({ openclawBin, cliEnv, stateDir }) => {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  execFileSync(process.execPath, [openclawBin, "approvals", "get", "--json"], {
    env: cliEnv,
    stdio: "pipe",
    timeout: 120_000,
  });
  if (!fs.existsSync(dbPath)) {
    throw new Error(`${openclawBin} did not materialize ${dbPath}`);
  }
  return dbPath;
};

const createLiveBackupHarness = ({
  openclawBin = repoOpenclawBin(),
  gatewayQuiesce = null,
  onBackupSpawn = null,
  backupTuning = null,
  fixture: fixtureOptions = {},
  // "fixture" = node:sqlite table (what the churn tiers always used);
  // "materialize" = the selected CLI writes its real schema (see above).
  stateDb = "fixture",
} = {}) => {
  const rootDir = mkTemp("alphaclaw-live-backup-e2e-");
  const openclawDir = path.join(rootDir, ".openclaw");
  // ~2000 small files under agents/main/sessions by default: the .jsonl
  // transcripts are volatile-skipped by the CLI without lstat; the
  // .jsonl.lock files are walked and lstat'd — they widen the raceable
  // readdir->lstat window the churn tests exercise.
  const fixture = writeStateFixture(rootDir, {
    jsonlFiles: 1000,
    lockFiles: 1000,
    ...fixtureOptions,
  });
  const packageRoot = mkTemp("alphaclaw-live-backup-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@live/alphaclaw", dependencies: { openclaw: kPin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-live-backup-install-");
  writeVersionedPackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    { version: kPin },
  );
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    logger: kSilentLogger,
  });
  store.writeSentinel({ installDir, version: kPin });

  const shimDir = writeOpenclawShim(openclawBin);
  const cliEnv = buildCliEnv({
    homeDir: rootDir,
    stateDir: openclawDir,
    pathPrefix: shimDir,
  });
  if (stateDb === "materialize") {
    materializeStateDb({ openclawBin, cliEnv, stateDir: openclawDir });
  } else if (stateDb !== "fixture") {
    throw new Error(`createLiveBackupHarness: unknown stateDb "${stateDb}"`);
  }

  const baseRunner = createRunStream({});
  const backupSpawns = [];
  const runner = {
    runStreamed: (opts) => {
      if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
        backupSpawns.push(opts.args.slice());
        try {
          onBackupSpawn?.(backupSpawns.length);
        } catch {}
      }
      return baseRunner.runStreamed(opts);
    },
  };

  const installToTempDir = async ({ versionSpec }) => {
    const tmpDir = mkTemp("openclaw-live-fake-prepare-");
    const openclawPackageDir = writeVersionedPackageFixture(
      path.join(tmpDir, "node_modules", "openclaw"),
      { version: versionSpec },
    );
    return { tmpDir, openclawPackageDir, cleanup: () => {} };
  };

  const sync = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store,
    runStream: runner,
    installToTempDir,
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => "beta",
    openclawSpawnEnv: () => cliEnv,
    isOnboarded: () => true,
    restartProcess: () => {},
    clearVersionCache: () => {},
    notify: async () => {},
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
    gatewayQuiesce,
    backupTuning: { retryDelayMs: 100, ...(backupTuning || {}) },
    // The REAL /proc probes, scoped to this harness: the offline copy's
    // exclusivity check refuses when ANY live openclaw-ish process exists,
    // and this box runs other suites' CLIs against their own fixtures in
    // parallel. Only processes that reference THIS harness's root are ours
    // to judge; the fd-holder scan stays fully real (it keys on our DB paths).
    backupProbes: {
      listProcesses: () =>
        listLiveOpenclawProcesses().filter((entry) => entry.cmdline.includes(rootDir)),
    },
  });

  return {
    sync,
    store,
    rootDir,
    openclawDir,
    fixture,
    backupSpawns,
    cliEnv,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
  };
};

// Newest run record's backup field (the durable authority for what the
// backup step did). Throws when no run was recorded.
const readRunBackupRecord = (openclawDir) => {
  const runsDir = path.join(openclawDir, ".alphaclaw", "runs");
  const names = fs.readdirSync(runsDir);
  if (names.length === 0) throw new Error(`no run records under ${runsDir}`);
  const records = names.map((name) =>
    JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")),
  );
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return records[0].backup;
};

// Hold SQLite's RESERVED lock on a database from THIS process — the exact
// shape of the concurrent writer that cost issue #54 its lease. Readers
// still read; any other writer's first write hits SQLITE_BUSY.
const holdReservedLock = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } catch {}
      try {
        db.close();
      } catch {}
    },
    isHeld: () => !released,
  };
};

module.exports = {
  kPin,
  kHardGateTarget,
  buildCliEnv,
  createFixtureDb,
  writeLegacyAuditLog,
  writeStateFixture,
  writeVersionedPackageFixture,
  writeOpenclawShim,
  createQuiesceFake,
  materializeStateDb,
  createLiveBackupHarness,
  readRunBackupRecord,
  holdReservedLock,
};
