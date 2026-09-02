// LIVE TIER — issue #54 reproduced against the REAL upstream CLIs.
//
// The incident: a downgrade's quiesced pre-update backup died when OpenClaw's
// legacy-audit migration lost its SQLite state lease to a concurrent writer
// ("SQLite transaction lock wait failed" → "…lease … was lost"), the failure
// classified `generic`, and the hard gate refused the downgrade after ONE
// attempt. This tier drives runBackup (lib/server/openclaw-channel-sync.js)
// through the real quiesced ladder while THIS process holds SQLite's RESERVED
// lock (BEGIN IMMEDIATE) on state/openclaw.sqlite — the exact shape of the
// writer that cost #54 its lease — and asserts the run record:
//   1. real 2026.9.1-beta.1, lock released when the RETRY spawns →
//      `lock_contention` classified, one in-quiesce retry, verified UPSTREAM
//      artifact that passes the usable check;
//   2. real beta, lock held for the whole step → retries exhausted (2), then
//      the AlphaClaw OFFLINE COPY stands in (producer alphaclaw-offline-copy,
//      exclusivity evidence, verified);
//   3. the pin 2026.7.1-2 under the same held lock → no lease, no contention:
//      it finishes on attempt 1 (the container tier's journey runs the pin's
//      backup, so its contention assertion is calibrated on this fact);
//   4. the offline-copy manifest's core field set matches upstream's (beta).
//
// Verified upstream facts these tests encode (dist read + live probes,
// 2026-09-02): the lease engages ONLY when a legacy audit source exists
// (logs/config-audit.jsonl | audit/system-agent.jsonl | audit/crestodian.jsonl);
// LEASE_DB_BUSY_TIMEOUT_MS = 0; the acquire waits 5 s then fails with
// "timed out waiting for legacy audit migration lease
// migration.legacy-audit/filesystem-sqlite-boundary" after ~11 s, with
// "[sqlite/transaction] SQLite transaction lock wait failed" lines above it;
// 2026.8.2 behaves identically (it carries the same lease); the pin has no
// lease and logs only "Config health-state write failed: database is locked".
//
// Requires: network (one real beta install, cached across live files) and a
// supported Node. Runtime: ~2-4 min.

const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-backup-contention-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync } = require("child_process");
const {
  kHardGateTarget,
  createQuiesceFake,
  createLiveBackupHarness,
  readRunBackupRecord,
  holdReservedLock,
} = require("./live-backup-harness");
const {
  kStateContentionPattern,
} = require("../../lib/server/openclaw-lock-contention");
const {
  kOfflineCopyProducer,
  kUpstreamProducer,
} = require("../../lib/server/openclaw-backup-offline-copy");
const { kLiveEnabled, kOpenclawLines, stageOpenclawVersion } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
const kSetupTimeoutMs = 12 * 60 * 1000;
// One beta attempt under contention is ~11 s; the ladder here runs up to
// three of them plus a shortened backoff and the offline copy.
const kContentionTestTimeoutMs = 6 * 60 * 1000;
// Shrunk from the production 15 s → 30 s so the tier stays minutes, not
// tens of minutes; the verdict logic (contentionRetryVerdict) is unchanged.
const kFastContentionBackoffMs = 2_000;

// The upstream lease-timeout line, verbatim from the real CLI (both 2026.8.2
// and the beta print it). Its LABEL has spaces — a regex that assumes one
// token before <scope>/<key> misses it.
const kLeaseTimeoutLinePattern =
  /timed out waiting for legacy audit migration lease migration\.legacy-audit\/filesystem-sqlite-boundary/;
const kLockWaitLinePattern = /SQLite transaction lock wait failed/;
const kPinLockedWarningPattern = /Config health-state write failed: database is locked/;

const readRunLog = (openclawDir) => {
  const logsDir = path.join(openclawDir, ".alphaclaw", "logs");
  const names = fs
    .readdirSync(logsDir)
    .filter((name) => /^openclaw-update-.*\.log$/.test(name));
  if (names.length === 0) throw new Error(`no update log under ${logsDir}`);
  return names
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
    .join("\n");
};

const readArchiveManifest = (file) =>
  JSON.parse(
    String(
      execFileSync("tar", ["-xzOf", file, "--wildcards", "*/manifest.json"], {
        encoding: "utf8",
        timeout: 60_000,
      }),
    ),
  );

const backupStepDetails = (harness) =>
  (harness.store.readState().lastUpdateRun?.steps || [])
    .filter((step) => step.name === "backup")
    .map((step) => `${step.status}: ${step.detail || step.error || ""}`);

// Artifacts handed from the ladder tests to the manifest-contract test; a
// missing one FAILS that test with the cause instead of skipping it.
const produced = { upstream: null, offlineCopy: null, offlineCopyLog: null };

describeLive("LIVE #54 reproduction: runBackup vs real CLIs under SQLite lock contention", () => {
  let beta;

  beforeAll(async () => {
    beta = await stageOpenclawVersion(kOpenclawLines.beta, {
      timeoutMs: kInstallTimeoutMs,
    });
  }, kSetupTimeoutMs);

  const betaHarness = (options = {}) =>
    createLiveBackupHarness({
      openclawBin: beta.bin,
      // legacyAuditLog engages the lease (the #54 precondition); no fixture
      // agent DB — see writeStateFixture. Few files: the churn suites own
      // the readdir/lstat race, this tier owns the lock. The state DB is the
      // beta's REAL schema (materialized by the beta CLI), as on the #54 box.
      fixture: { jsonlFiles: 20, lockFiles: 0, legacyAuditLog: true, agentDb: false },
      stateDb: "materialize",
      backupTuning: { contentionBackoffBaseMs: kFastContentionBackoffMs },
      ...options,
    });

  it(
    "real beta: a held RESERVED lock costs attempt 1 its lease; the in-quiesce retry lands a verified upstream archive once the lock is released",
    { timeout: kContentionTestTimeoutMs },
    async () => {
      let lock = null;
      const gatewayQuiesce = createQuiesceFake();
      const harness = betaHarness({
        gatewayQuiesce,
        // Release the lock the moment the RETRY spawns: attempt 1 fails on
        // the lease, attempt 2 must succeed. Never released before that.
        onBackupSpawn: (count) => {
          if (count >= 2) lock?.release();
        },
      });
      lock = holdReservedLock(harness.fixture.stateDbPath);
      try {
        const startedAt = Date.now();
        const result = await harness.sync.applyUpdate(kHardGateTarget);
        const elapsedMs = Date.now() - startedAt;
        expect(result.status, JSON.stringify(result.body)).toBe(202);
        expect(result.body.restarting).toBe(true);

        const record = readRunBackupRecord(harness.openclawDir);
        console.log(
          `[live-contention beta/retry] ${elapsedMs} ms; attempts=${record.attempts} quiescedAttempts=${record.quiescedAttempts} contentionRetries=${record.contentionRetries} producer=${record.producer}`,
        );
        // Hand the artifact to the manifest-contract test first: a later
        // assertion failing here must not turn that test into a false miss.
        if (record.file) produced.upstream = record.file;
        expect(record.noBackup).toBe(false);
        expect(record.quiesced).toBe(true);
        expect(record.attempts).toBe(2);
        expect(record.quiescedAttempts).toBe(2);
        expect(record.contentionRetries).toBe(1);
        expect(record.offlineCopy).toBeNull();
        expect(record.verified).toBe(true);
        expect(record.usableCheck).toBe("manifest_ok");
        expect(record.producer).toBe(kUpstreamProducer);
        expect(record.file).toMatch(/openclaw-backup-.*\.tar\.gz$/);
        expect(record.file).not.toMatch(/\.alphaclaw\.tar\.gz$/);
        expect(fs.statSync(record.file).size).toBeGreaterThan(0);
        // The diagnosis ran and saw the real DB (the beta writes WAL).
        expect(record.diagnosis.dbCount).toBe(1);
        expect(record.diagnosis.journalMode).toBe("wal");

        // The step stream told the operator WHY it retried, in the wording
        // WI-1.8/1.9 fixed, and the retry ran with the gateway still paused.
        const details = backupStepDetails(harness);
        expect(details.join("\n")).toMatch(
          /retrying after state-database lock contention \(gateway still paused\)/,
        );
        expect(details.join("\n")).toMatch(/succeeded on attempt 2 \(gateway paused briefly\)/);
        // Quiesce transaction: stop before the first CLI, start after, one release.
        const calls = gatewayQuiesce.calls;
        expect(calls.indexOf("stop")).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf("start")).toBeGreaterThan(calls.indexOf("stop"));
        expect(calls.filter((c) => c === "release")).toHaveLength(1);
        expect(harness.backupSpawns).toHaveLength(2);

        // The durable log carries the REAL CLI's contention text — the
        // classifier parsed upstream output, not a stub: the lease heartbeat's
        // lock-wait lines, the outcome-write warning, and the lease timeout.
        const log = readRunLog(harness.openclawDir);
        expect(log).toMatch(kLockWaitLinePattern);
        expect(log).toMatch(/Warning: the backup outcome could not be recorded: database is locked/);
        expect(log).toMatch(kLeaseTimeoutLinePattern);
      } finally {
        lock.release();
      }
    },
  );

  it(
    "real beta: a lock held for the whole step exhausts both in-quiesce retries and the AlphaClaw offline copy stands in (verified, exclusivity evidence)",
    { timeout: kContentionTestTimeoutMs },
    async () => {
      const gatewayQuiesce = createQuiesceFake();
      const harness = betaHarness({ gatewayQuiesce });
      const lock = holdReservedLock(harness.fixture.stateDbPath);
      try {
        const startedAt = Date.now();
        const result = await harness.sync.applyUpdate(kHardGateTarget);
        const elapsedMs = Date.now() - startedAt;
        expect(result.status, JSON.stringify(result.body)).toBe(202);

        const record = readRunBackupRecord(harness.openclawDir);
        console.log(
          `[live-contention beta/offline-copy] ${elapsedMs} ms; attempts=${record.attempts} contentionRetries=${record.contentionRetries} offlineCopy=${JSON.stringify(record.offlineCopy)} bytes=${record.bytes}`,
        );
        if (record.file) produced.offlineCopy = record.file;
        produced.offlineCopyLog = readRunLog(harness.openclawDir);
        expect(record.noBackup).toBe(false);
        expect(record.quiesced).toBe(true);
        // 1 attempt + kOpenclawBackupContentionRetries (2) retries, all paused.
        expect(record.attempts).toBe(3);
        expect(record.quiescedAttempts).toBe(3);
        expect(record.contentionRetries).toBe(2);
        expect(harness.backupSpawns).toHaveLength(3);
        // Then the offline copy — still quiesced, on the still-locked DB:
        // SQLite's online backup() reads under a held RESERVED lock.
        expect(record.offlineCopy).toEqual(
          expect.objectContaining({ ok: true, reason: "lock_contention", partial: false }),
        );
        expect(record.producer).toBe(kOfflineCopyProducer);
        expect(record.file).toMatch(/openclaw-backup-.*\.alphaclaw\.tar\.gz$/);
        expect(record.verified).toBe(true);
        expect(record.usableCheck).toBe("manifest_ok");
        expect(record.offlineCopyBytes).toBeGreaterThan(0);
        expect(record.offlineCopyMs).toBeGreaterThan(0);
        expect(fs.statSync(record.file).size).toBe(record.offlineCopyBytes);
        // Exclusivity evidence: the stop was confirmed, the quiet barrier
        // held, and the Linux /proc fd scan ran clean (the lock holder is
        // THIS process, which the scan rightly excludes as self).
        expect(record.exclusivityEvidence).toEqual(
          expect.objectContaining({
            stopConfirmed: true,
            quiet: "held",
            quietOwner: "quiesced-backup",
            liveProcesses: 0,
            handleCount: 0,
            fdScan: "clean",
            completeness: "full",
            platform: "linux",
          }),
        );
        const details = backupStepDetails(harness).join("\n");
        expect(details).toMatch(/taking an AlphaClaw offline copy of the paused state/);
        expect(details).toMatch(
          /succeeded via AlphaClaw offline copy after 3 upstream attempts \(gateway paused\)/,
        );
        // The archive is the documented format: manifest with producer +
        // format version, the state DB listed as a sqlite asset, the
        // evidence embedded.
        const manifest = readArchiveManifest(record.file);
        expect(manifest.producer).toBe(kOfflineCopyProducer);
        expect(manifest.alphaclawFormatVersion).toBe(1);
        expect(manifest.schemaVersion).toBe(1);
        expect(
          manifest.assets.some(
            (asset) => asset.kind === "sqlite" && asset.archivePath === "state/openclaw.sqlite",
          ),
        ).toBe(true);
        expect(manifest.exclusivityEvidence.fdScan).toBe("clean");
        expect(manifest.diagnosis.dbCount).toBe(1);
        // Every failed attempt printed the real lease text (three attempts,
        // three timeouts, lock-wait heartbeats above each).
        const timeoutLines = produced.offlineCopyLog
          .split(/\r?\n/)
          .filter((line) => kLeaseTimeoutLinePattern.test(line));
        expect(timeoutLines).toHaveLength(3);
        expect(produced.offlineCopyLog).toMatch(kLockWaitLinePattern);
      } finally {
        lock.release();
      }
    },
  );

  it(
    "the upstream lease-TIMEOUT line classifies as contention ON ITS OWN (its label has spaces)",
    () => {
      // Attempts 1-3 above fail with the same three shapes: N×"SQLite
      // transaction lock wait failed", "Warning: the backup outcome could
      // not be recorded: database is locked", and the lease-timeout line.
      // The 20-line classifier window catches the first two today, so the
      // ladder retried — but a run whose lock clears between the lease wait
      // and the outcome write leaves ONLY the timeout line, and that must
      // classify too, or #54's class (terminal `generic`) comes back.
      expect(produced.offlineCopyLog, "the offline-copy test did not record a log").toBeTruthy();
      const lines = produced.offlineCopyLog.split(/\r?\n/);
      const timeoutLine = lines.find((line) => kLeaseTimeoutLinePattern.test(line));
      expect(timeoutLine, "the real CLI did not print the lease-timeout line").toBeTruthy();
      expect(kStateContentionPattern.test(timeoutLine)).toBe(true);
      // The companions must keep matching too (they are what saved the run).
      expect(kStateContentionPattern.test("SQLite transaction lock wait failed")).toBe(true);
      expect(
        kStateContentionPattern.test(
          "legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary was lost",
        ),
      ).toBe(true);
    },
  );

  it(
    `the pin ${kOpenclawLines.pin} under the same held lock takes no lease: attempt 1 succeeds, no contention retry`,
    { timeout: kContentionTestTimeoutMs },
    async () => {
      const gatewayQuiesce = createQuiesceFake();
      // Pin fixture: both DBs (the pin archives any SQLite file) and the
      // legacy audit log (which the pin ignores — no lease code).
      const harness = createLiveBackupHarness({
        gatewayQuiesce,
        fixture: { jsonlFiles: 20, lockFiles: 0, legacyAuditLog: true },
        backupTuning: { contentionBackoffBaseMs: kFastContentionBackoffMs },
      });
      const lock = holdReservedLock(harness.fixture.stateDbPath);
      try {
        const result = await harness.sync.applyUpdate(kHardGateTarget);
        expect(result.status, JSON.stringify(result.body)).toBe(202);
        const record = readRunBackupRecord(harness.openclawDir);
        console.log(
          `[live-contention pin] attempts=${record.attempts} contentionRetries=${record.contentionRetries} producer=${record.producer} durationMs=${record.durationMs}`,
        );
        expect(record.noBackup).toBe(false);
        expect(record.quiesced).toBe(true);
        expect(record.attempts).toBe(1);
        expect(record.quiescedAttempts).toBe(1);
        expect(record.contentionRetries).toBe(0);
        expect(record.offlineCopy).toBeNull();
        expect(record.producer).toBe(kUpstreamProducer);
        expect(record.verified).toBe(true);
        expect(record.usableCheck).toBe("manifest_ok");
        expect(harness.backupSpawns).toHaveLength(1);
        // The pin noticed the lock only when writing its config health
        // state — a warning, not a failure: exactly why the container tier's
        // pin→beta journey expects a verified backup with zero retries.
        expect(readRunLog(harness.openclawDir)).toMatch(kPinLockedWarningPattern);
      } finally {
        lock.release();
      }
    },
  );

  it(
    "offline-copy manifest: the core field set matches the real beta's backup manifest (plus the AlphaClaw additions only)",
    () => {
      expect(produced.upstream, "the retry test did not produce an upstream archive").toBeTruthy();
      expect(produced.offlineCopy, "the offline-copy test did not produce an archive").toBeTruthy();
      const upstream = readArchiveManifest(produced.upstream);
      const offline = readArchiveManifest(produced.offlineCopy);

      // Upstream (2026.9.1-beta.1) schemaVersion-1 core: every key it writes
      // is present in ours; ours adds exactly the documented four
      // (docs/designs/backup-offline-copy.md §3).
      expect(upstream.schemaVersion).toBe(1);
      expect(offline.schemaVersion).toBe(1);
      const upstreamKeys = Object.keys(upstream).sort();
      const offlineKeys = Object.keys(offline).sort();
      const missingInOffline = upstreamKeys.filter((key) => !offlineKeys.includes(key));
      expect(missingInOffline, `upstream manifest keys missing from the offline copy: ${missingInOffline}`).toEqual([]);
      const alphaclawOnly = offlineKeys.filter((key) => !upstreamKeys.includes(key)).sort();
      expect(alphaclawOnly).toEqual(
        ["alphaclawFormatVersion", "diagnosis", "exclusivityEvidence", "producer"].sort(),
      );
      // paths.* and options.* core keys.
      const upstreamPathKeys = Object.keys(upstream.paths).sort();
      const offlinePathKeys = Object.keys(offline.paths).sort();
      expect(upstreamPathKeys.filter((key) => !offlinePathKeys.includes(key))).toEqual([]);
      expect(Object.keys(upstream.options).sort()).toEqual(Object.keys(offline.options).sort());
      // Asset / skipped entry field names.
      const fieldNames = (entries) =>
        [...new Set(entries.flatMap((entry) => Object.keys(entry)))].sort();
      expect(fieldNames(upstream.assets)).toEqual(["archivePath", "kind", "sourcePath"]);
      expect(fieldNames(offline.assets)).toEqual(["archivePath", "kind", "sourcePath"]);
      for (const field of fieldNames(upstream.skipped)) {
        expect(fieldNames(offline.skipped)).toContain(field);
      }
      // Runtime facts both record identically.
      expect(upstream.runtimeVersion).toBe(kOpenclawLines.beta);
      expect(upstream.platform).toBe(process.platform);
      expect(offline.platform).toBe(process.platform);
      expect(typeof offline.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(offline.createdAt))).toBe(false);

      // Recorded upstream FACT the usable check must honor: upstream lists
      // ONE asset of kind "state" whose sourcePath IS the state dir (the
      // state DB is inside it, never a per-file asset) — archivePath is
      // "<archiveRoot>/payload/posix<stateDir>".
      expect(upstream.assets).toHaveLength(1);
      expect(upstream.assets[0].kind).toBe("state");
      expect(upstream.assets[0].sourcePath).toBe(upstream.paths.stateDir);
      expect(upstream.assets[0].archivePath).toBe(
        `${upstream.archiveRoot}/payload/posix${upstream.paths.stateDir}`,
      );
      // Ours lists the DB itself, so a per-file consumer works either way.
      expect(
        offline.assets.some((asset) => asset.kind === "sqlite" && /state\/openclaw\.sqlite$/.test(asset.sourcePath)),
      ).toBe(true);
    },
  );
});
