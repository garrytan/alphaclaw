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
// Runtime note: the runtime-gate preload this file once injected (faking the
// Node/SQLite version labels on a Node 24.14.1 box) is gone — the tier runs
// on Node 22.23.2 / SQLite 3.51.3, which both upstream gates accept. The
// harness lives in live-backup-harness.js and is shared with the #54
// contention tier, which runs the same shape against the real beta.

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
const {
  kHardGateTarget,
  buildCliEnv,
  writeStateFixture,
  createQuiesceFake,
  createLiveBackupHarness,
  readRunBackupRecord,
} = require("./live-backup-harness");
const { kLiveEnabled, mkTemp, repoOpenclawBin } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kContractTestTimeoutMs = 120_000;
// A real tar over ~2k files is seconds, but the CLI retries internal tar EOF
// races with 10s/20s backoffs and the ladder allows 3 attempts — headroom.
const kChurnTestTimeoutMs = 300_000;
const kExecMaxBuffer = 16 * 1024 * 1024;

const execCli = (args, env, timeoutMs = 90_000) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
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
// ---------------------------------------------------------------------------

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
      let churner = null;
      // The real writer goes quiet when the gateway stops: stop() pauses the
      // churner, start() resumes it.
      const gatewayQuiesce = createQuiesceFake({
        onStop: () => churner?.pause(),
        onStart: () => churner?.resume(),
      });
      const quiesceCalls = gatewayQuiesce.calls;
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
        // runBackup asked for, inside the retention pattern — and it passed
        // the WI-6.1 usable check (gzip -t + manifest lists the state DBs).
        expect(backupRecord.verified).toBe(true);
        expect(backupRecord.usableCheck).toBe("manifest_ok");
        expect(backupRecord.producer).toBe("openclaw");
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
        expect(backupRecord.usableCheck).toBe("manifest_ok");
        expect(fs.statSync(backupRecord.file).size).toBeGreaterThan(0);

        logRaceOutcome("live-ladder", backupRecord);
        assertVanishedClassificationIfRaced(backupRecord);
      } finally {
        churner.stop();
      }
    },
  );
});
