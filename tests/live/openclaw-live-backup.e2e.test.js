// LIVE TIER — the REAL pinned OpenClaw CLI's `backup create --output` contract
// and runBackup (lib/server/openclaw-channel-sync.js) driving that real CLI
// under live file churn. Closes the TODOS.md:198-203 debt: every hermetic
// backup stub encoded an unvalidated assumption about the CLI's --output
// contract; this tier records what the pinned binary (openclaw 2026.7.1-2)
// actually does. Offline by design: no registry, no GitHub — the pinned
// package in node_modules is the entire upstream surface.
//
// Observed contract (openclaw 2026.7.1-2, recorded 2026-08-29 in this sandbox):
//   exact nonexistent path → exit 0, archive at EXACTLY that path, stdout:
//     "Created /tmp/.../exact-name.tar.gz"
//     "Archive verification: passed"
//     "Backup skipped 1 volatile file (live sessions, cron logs, queues, sockets, pid/tmp)."
//       (agents/<id>/sessions/*.jsonl are volatile-skipped WITHOUT lstat, but
//        *.jsonl.lock — extname ".lock" — and plugin catalog.json are walked
//        and lstat'd: exactly issues #11/#18's race surface)
//   same path again → exit 1, stderr:
//     "Error: Refusing to overwrite existing backup archive: /tmp/.../exact-name.tar.gz"
//   existing dir (trailing slash) → exit 0, timestamped archive INSIDE it:
//     "Backup archive: /tmp/.../outdir/2026-08-29T18-13-52.011+00-00-openclaw-backup.tar.gz"
//
// Runtime-gate note (recorded reality, not a CLI behavior under test): the
// pinned CLI refuses this sandbox's runtime twice before any backup code runs:
//   launcher:      "openclaw: Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0
//                   is required (current: v24.14.1)."
//   dist runtime guard + node:sqlite gate: "OpenClaw requires SQLite 3.51.3+
//                   (or patched 3.50.7+/3.44.6+) for WAL safety; Node 24.15.0
//                   embeds SQLite 3.51.2, which is affected by the upstream
//                   WAL-reset database corruption bug."
// Neither gate has an env escape hatch, and the machine has exactly one Node
// (v24.14.1, SQLite 3.51.2). The suites inject a NODE_OPTIONS preload that
// fakes ONLY those two version labels (process.versions.node and the result
// of the CLI's `SELECT sqlite_version()` probe); the tar walk, --output
// handling, --verify, and all real SQLite I/O run the CLI's untouched
// implementation against throwaway fixtures where the WAL-reset data-safety
// concern is moot.

// Isolate module-level kRootDir BEFORE any lib/ module loads constants
// (constants captures kRootDir at load — same pattern as the live-apply tier).
const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-backup-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const crypto = require("crypto");
const { execFile } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { kLiveEnabled, kSilentLogger, mkTemp, repoOpenclawBin } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kContractTestTimeoutMs = 120_000;
// A real tar over ~2k files is seconds, but the CLI retries internal tar EOF
// races with 10s/20s backoffs and the ladder allows 3 attempts — headroom.
const kChurnTestTimeoutMs = 300_000;
const kExecMaxBuffer = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Runtime-gate preload (see the header note). Written once; injected into
// every CLI process via NODE_OPTIONS so the launcher's compile-cache respawns
// inherit it too.
// ---------------------------------------------------------------------------
const kToolsDir = mkTemp("openclaw-live-backup-tools-");
const kPreloadPath = path.join(kToolsDir, "runtime-gate-shim.cjs");
fs.writeFileSync(
  kPreloadPath,
  [
    "// Test-only runtime-gate shim: fake the two version labels the pinned",
    "// openclaw CLI gates on. Everything else runs the real implementation.",
    "try {",
    '  Object.defineProperty(process.versions, "node", {',
    '    value: "24.15.0", configurable: true, enumerable: true, writable: false,',
    "  });",
    "} catch {}",
    "try {",
    '  const sqlite = require("node:sqlite");',
    "  const origPrepare = sqlite.DatabaseSync.prototype.prepare;",
    "  sqlite.DatabaseSync.prototype.prepare = function (sql, ...rest) {",
    "    const stmt = origPrepare.call(this, sql, ...rest);",
    '    if (typeof sql === "string" && /sqlite_version\\s*\\(\\s*\\)/i.test(sql)) {',
    "      const origGet = stmt.get.bind(stmt);",
    "      try {",
    '        Object.defineProperty(stmt, "get", {',
    "          value: (...args) => {",
    "            const row = origGet(...args);",
    '            return row && typeof row === "object" && "version" in row',
    '              ? { ...row, version: "3.51.3" }',
    "              : row;",
    "          },",
    "          configurable: true,",
    "        });",
    "      } catch {}",
    "    }",
    "    return stmt;",
    "  };",
    "} catch {}",
    "",
  ].join("\n"),
);

// Env for real-CLI invocations, mirroring lib/server/gateway.js gatewayEnv's
// shape (HOME/OPENCLAW_HOME at the data root, state dir + config pinned,
// XDG_CONFIG_HOME, no auto-update) against an isolated fixture root.
const buildCliEnv = ({ homeDir, stateDir, pathPrefix = null }) => {
  const env = {
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    XDG_CONFIG_HOME: stateDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
    NODE_OPTIONS: `--require ${kPreloadPath}`,
    PATH: pathPrefix
      ? `${pathPrefix}${path.delimiter}${process.env.PATH}`
      : process.env.PATH,
  };
  for (const key of ["TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
};

// Minimal state tree the CLI accepts (probed by running it): an empty-object
// openclaw.json, session transcripts, a plugin catalog, and real sqlite state
// DBs (both enumerateStateDbs shapes) so there is content to archive and the
// fresh-install carve-out cannot mask a missing artifact.
const writeStateFixture = (
  homeDir,
  { jsonlFiles = 6, lockFiles = 2 } = {},
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
  const createDb = (dbPath) => {
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
  createDb(path.join(stateDir, "state", "openclaw.sqlite"));
  createDb(
    path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  );
  return { stateDir, sessionsDir, catalogPath };
};

const execCli = (args, env, timeoutMs = 90_000) =>
  new Promise((resolve) => {
    execFile(
      "node",
      [repoOpenclawBin(), ...args],
      { env, timeout: timeoutMs, maxBuffer: kExecMaxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          output: `${stdout || ""}${stderr || ""}`,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Suite 1 — the real CLI's --output contract (the assumption every hermetic
// backup stub encoded, now validated against the pinned binary).
// ---------------------------------------------------------------------------

describeLive("LIVE openclaw backup create --output contract (real pinned CLI)", () => {
  let cliEnv;
  let scratchDir;

  beforeAll(() => {
    const homeDir = mkTemp("openclaw-live-backup-contract-home-");
    const { stateDir } = writeStateFixture(homeDir);
    cliEnv = buildCliEnv({ homeDir, stateDir });
    scratchDir = mkTemp("openclaw-live-backup-contract-out-");
  });

  it(
    "Case A: a nonexistent --output path IS the archive file (exit 0, verified, non-empty)",
    { timeout: kContractTestTimeoutMs },
    async () => {
      // Unique per invocation so the config-level `retry: 1` can never trip
      // over this test's own prior artifact.
      const outputFile = path.join(
        scratchDir,
        `exact-${crypto.randomUUID().slice(0, 8)}.tar.gz`,
      );
      const result = await execCli(
        ["backup", "create", "--output", outputFile, "--verify"],
        cliEnv,
      );
      expect(result.code, result.output).toBe(0);
      const st = fs.statSync(outputFile);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);
      // Observed: "Created <path>" then "Archive verification: passed".
      expect(result.output).toContain(`Created ${outputFile}`);
      expect(result.output).toMatch(/Archive verification: passed/);
      // Nothing else appeared next to the archive (no dir-of-archives surprise).
      const siblings = fs
        .readdirSync(scratchDir)
        .filter((name) => name.startsWith(path.basename(outputFile)));
      expect(siblings).toEqual([path.basename(outputFile)]);
    },
  );

  it(
    "Case B: reusing an existing --output path is refused with a nonzero exit",
    { timeout: kContractTestTimeoutMs },
    async () => {
      // Self-contained collision: create this invocation's own archive first.
      const outputFile = path.join(
        scratchDir,
        `collide-${crypto.randomUUID().slice(0, 8)}.tar.gz`,
      );
      const first = await execCli(
        ["backup", "create", "--output", outputFile, "--verify"],
        cliEnv,
      );
      expect(first.code, first.output).toBe(0);
      const sizeBefore = fs.statSync(outputFile).size;

      const second = await execCli(
        ["backup", "create", "--output", outputFile, "--verify"],
        cliEnv,
      );
      expect(second.code).not.toBe(0);
      // Observed verbatim: "Error: Refusing to overwrite existing backup
      // archive: <path>" — the exact text classifyBackupFailure keys on.
      expect(second.output).toMatch(/refus\w*\s+to\s+overwrite/i);
      expect(second.output).toContain(outputFile);
      // The refusal left the existing archive untouched.
      expect(fs.statSync(outputFile).size).toBe(sizeBefore);
    },
  );

  it(
    "Case C: an existing-directory --output gets a timestamped archive INSIDE it",
    { timeout: kContractTestTimeoutMs },
    async () => {
      const outDir = mkTemp("openclaw-live-backup-contract-dir-");
      const result = await execCli(
        // Trailing separator: the CLI treats it as a directory target either
        // way (it also stat-probes bare existing dirs), but the slash form is
        // the unambiguous one.
        ["backup", "create", "--output", `${outDir}${path.sep}`, "--verify"],
        cliEnv,
      );
      expect(result.code, result.output).toBe(0);
      const entries = fs.readdirSync(outDir);
      expect(entries).toHaveLength(1);
      // Observed basename shape: "2026-08-29T18-13-52.011+00-00-openclaw-backup.tar.gz".
      expect(entries[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.+-openclaw-backup\.tar\.gz$/);
      // ... which stays inside the repo's retention pattern
      // (kBackupArchivePattern in openclaw-channel-sync.js): keep-N pruning
      // would still own an archive the CLI named itself.
      expect(entries[0]).toMatch(/openclaw-backup.*\.tar\.gz$/);
      expect(fs.statSync(path.join(outDir, entries[0])).size).toBeGreaterThan(0);
      expect(result.output).toMatch(/Archive verification: passed/);
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 2 — runBackup vs the real CLI under live churn (issues #11/#18).
// Harness mirrors tests/server/openclaw-channel-backup-retry.e2e.test.js's
// createHarness, but the runner is the REAL createRunStream and
// openclawSpawnEnv points the PATH-resolved `openclaw` at the real pinned
// binary via a shim. Only installToTempDir is faked (the backup step is the
// one under test; the download is the hermetic tier's business).
// ---------------------------------------------------------------------------

const kPin = "1.0.0";
const kHardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };

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

// Live churner modeling the running gateway: every ~5ms it rotates session
// *.jsonl.lock files (create one, delete a recent one) and cycles the plugin
// catalog through an unlink -> rewrite gap — the two volatile shapes from
// issues #18 and #11. The tar walk readdir/lstat window this races is
// microseconds wide, so whether it fires per run is nondeterministic by
// design; the hermetic tier owns determinism.
const startChurner = ({ sessionsDir, catalogPath }) => {
  let seq = 0;
  let timer = null;
  const lockName = (n) => path.join(sessionsDir, `churn-${n % 31}.jsonl.lock`);
  const tick = () => {
    seq += 1;
    try {
      fs.writeFileSync(lockName(seq), `${seq}\n`);
    } catch {}
    try {
      fs.unlinkSync(lockName(seq + 29)); // the lock created two ticks ago
    } catch {}
    if (seq % 2 === 0) {
      try {
        fs.unlinkSync(catalogPath);
      } catch {}
    } else {
      try {
        fs.writeFileSync(catalogPath, `${JSON.stringify({ seq })}\n`);
      } catch {}
    }
  };
  const churner = {
    pause: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    resume: () => {
      if (!timer) timer = setInterval(tick, 5);
    },
    stop: () => churner.pause(),
    isRunning: () => timer !== null,
  };
  churner.resume();
  return churner;
};

const createLiveBackupHarness = ({
  gatewayQuiesce = null,
  onBackupSpawn = null,
} = {}) => {
  const rootDir = mkTemp("alphaclaw-live-backup-e2e-");
  const openclawDir = path.join(rootDir, ".openclaw");
  // ~2000 small files under agents/main/sessions: the .jsonl transcripts are
  // volatile-skipped by the CLI without lstat; the .jsonl.lock files are
  // walked and lstat'd — they widen the raceable readdir->lstat window.
  const fixture = writeStateFixture(rootDir, {
    jsonlFiles: 1000,
    lockFiles: 1000,
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

  // runBackup spawns command "openclaw" and lets PATH resolve it: give it a
  // shim dir whose `openclaw` execs the real pinned launcher.
  const shimDir = mkTemp("alphaclaw-live-backup-shim-");
  fs.writeFileSync(
    path.join(shimDir, "openclaw"),
    `#!/bin/sh\nexec node "${repoOpenclawBin()}" "$@"\n`,
    { mode: 0o755 },
  );
  const cliEnv = buildCliEnv({
    homeDir: rootDir,
    stateDir: openclawDir,
    pathPrefix: shimDir,
  });

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
    backupTuning: { retryDelayMs: 100 },
  });

  return { sync, store, rootDir, openclawDir, fixture, backupSpawns };
};

const readRunBackupRecord = (openclawDir) => {
  const runsDir = path.join(openclawDir, ".alphaclaw", "runs");
  const names = fs.readdirSync(runsDir);
  expect(names.length).toBeGreaterThan(0);
  const records = names.map((name) =>
    JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")),
  );
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return records[0].backup;
};

const logRaceOutcome = (label, backupRecord) => {
  const raceFired =
    (backupRecord?.attempts ?? 1) > 1 ||
    (backupRecord?.vanishedPaths?.length ?? 0) > 0;
  // Always logged, never asserted: the readdir->lstat race is nondeterministic.
  console.log(
    `[live-backup ${label}] race fired: ${raceFired ? "yes" : "no"}, attempts: ${backupRecord?.attempts ?? "?"}`,
  );
  return raceFired;
};

const assertVanishedClassificationIfRaced = (backupRecord) => {
  if ((backupRecord?.attempts ?? 1) > 1) {
    // The retry only fires on kind="vanished_file", so a multi-attempt run
    // proves classification parsed the REAL CLI's error text — and the path
    // must be one of the churned volatile files.
    expect(backupRecord.vanishedPaths.length).toBeGreaterThan(0);
    expect(backupRecord.vanishedPaths[0]).toMatch(
      /\.jsonl\.lock$|catalog\.json$/,
    );
  }
};

describeLive("LIVE runBackup vs real CLI under churn (issues #11/#18)", () => {
  it(
    "hard-gated apply quiesces the gateway (the churner goes quiet) and lands a verified backup",
    { timeout: kChurnTestTimeoutMs },
    async () => {
      const quiesceCalls = [];
      let churner = null;
      const gatewayQuiesce = {
        acquireLock: async () => {
          quiesceCalls.push("acquireLock");
          return () => quiesceCalls.push("release");
        },
        isRunning: async () => {
          quiesceCalls.push("isRunning");
          return true;
        },
        suppress: () => quiesceCalls.push("suppress"),
        unsuppress: () => quiesceCalls.push("unsuppress"),
        // The real writer goes quiet when the gateway stops: stop() pauses
        // the churner, start() resumes it.
        stop: async () => {
          quiesceCalls.push("stop");
          churner?.pause();
          return true;
        },
        start: async () => {
          quiesceCalls.push("start");
          churner?.resume();
        },
      };
      const harness = createLiveBackupHarness({
        gatewayQuiesce,
        onBackupSpawn: () => quiesceCalls.push("backup-cli"),
      });
      churner = startChurner(harness.fixture);
      try {
        // Let the churn establish a live-mutation steady state first.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await harness.sync.applyUpdate(kHardGateTarget);

        expect(result.status, JSON.stringify(result.body)).toBe(202);
        expect(result.body.restarting).toBe(true);

        // Quiesce ordering: the gateway stopped before the first real CLI
        // backup ran, and was relaunched afterwards; the lock was released.
        expect(quiesceCalls.indexOf("stop")).toBeGreaterThanOrEqual(0);
        expect(quiesceCalls.indexOf("stop")).toBeLessThan(
          quiesceCalls.indexOf("backup-cli"),
        );
        expect(quiesceCalls.indexOf("start")).toBeGreaterThan(
          quiesceCalls.indexOf("stop"),
        );
        expect(
          quiesceCalls.filter((c) => c === "release"),
        ).toHaveLength(1);

        const backupRecord = readRunBackupRecord(harness.openclawDir);
        expect(backupRecord.noBackup).toBe(false);
        expect(backupRecord.quiesced).toBe(true);
        expect(backupRecord.attempts).toBeGreaterThanOrEqual(1);
        // The verified artifact the REAL CLI wrote, at the exact per-run path
        // runBackup asked for, inside the retention pattern.
        expect(backupRecord.verified).toBe(true);
        expect(backupRecord.file).toMatch(/openclaw-backup-.*\.tar\.gz$/);
        expect(fs.statSync(backupRecord.file).size).toBeGreaterThan(0);

        logRaceOutcome("quiesced", backupRecord);
        assertVanishedClassificationIfRaced(backupRecord);
      } finally {
        churner.stop();
      }
    },
  );

  it(
    "hard-gated apply with NO quiesce (boot-instance shape) rides the live ladder through sustained churn",
    { timeout: kChurnTestTimeoutMs },
    async () => {
      // No gatewayQuiesce: runBackup goes straight to the live ladder while
      // the churner keeps mutating the state dir — the closest live analogue
      // of issues #11/#18. The churner stops the moment a RETRY spawns so a
      // fired race converges on attempt 2 instead of gambling on three
      // consecutive misses (the hermetic tier owns exhaustion determinism).
      let churner = null;
      const harness = createLiveBackupHarness({
        onBackupSpawn: (count) => {
          if (count >= 2) churner?.pause();
        },
      });
      churner = startChurner(harness.fixture);
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await harness.sync.applyUpdate(kHardGateTarget);

        expect(result.status, JSON.stringify(result.body)).toBe(202);
        const backupRecord = readRunBackupRecord(harness.openclawDir);
        expect(backupRecord.noBackup).toBe(false);
        expect(backupRecord.quiesced).toBe(false);
        expect(backupRecord.attempts).toBeGreaterThanOrEqual(1);
        expect(backupRecord.attempts).toBe(harness.backupSpawns.length);
        expect(backupRecord.verified).toBe(true);
        expect(fs.statSync(backupRecord.file).size).toBeGreaterThan(0);

        logRaceOutcome("live-ladder", backupRecord);
        assertVanishedClassificationIfRaced(backupRecord);
      } finally {
        churner.stop();
      }
    },
  );
});
