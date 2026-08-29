// Backup live-race handling (issues #11/#18): quiesce-first for hard gates,
// vanished-file retry ladder for everything else. The scripted gatewayQuiesce
// recorder pins the exact stop/start/lock ordering the design depends on —
// the watchdog relaunches an exited gateway 10s into a managed operation
// unless the lifecycle lock is held, so order here is correctness, not style.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");

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

// Faithful backup CLI stub (see openclaw-channel-sync.test.js — the --output
// contract was verified against the pinned 2026.7.1-2 source). Failure
// scripts run per-call so a test can fail N times, then succeed.
const makeBackupRunner = ({ script = [], onBackupCall = null } = {}) => {
  const backupCalls = [];
  const runnerImpl = async (opts) => {
    if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
      const outIdx = opts.args.indexOf("--output");
      const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
      backupCalls.push({ out, timeoutMs: opts.timeoutMs });
      onBackupCall?.(backupCalls.length);
      const step = script[backupCalls.length - 1] ?? { ok: true };
      if (!step.ok) {
        return {
          ok: false,
          code: 1,
          tail: step.tail ?? "boom\n",
          timedOut: Boolean(step.timedOut),
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
  return { runnerImpl, backupCalls };
};

// Scripted quiesce recorder. Every call appends to `calls` so tests assert
// the exact transaction order.
const makeQuiesceRecorder = ({
  calls = [],
  acquireDelayMs = 0,
  acquireNever = false,
  acquireReject = false,
  isRunning = true,
  stopResult = true,
  stopThrows = false,
  startThrows = false,
} = {}) => {
  const releaseSpy = vi.fn(() => calls.push("release"));
  const recorder = {
    calls,
    releaseSpy,
    acquireLock: vi.fn(async () => {
      calls.push("acquireLock");
      if (acquireReject) throw new Error("lock unavailable");
      if (acquireNever) await new Promise(() => {});
      if (acquireDelayMs) await sleep(acquireDelayMs);
      return releaseSpy;
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
};

const createHarness = ({
  pin = "1.0.0",
  channel = "stable",
  installedVersion = "1.0.0",
  sentinelVersion = "1.0.0",
  runnerImpl,
  gatewayQuiesce = null,
  backupTuning = {},
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
  });
  const ledger = sync.testing?.ledger ?? null;
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
  };
};

const kHardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };
const kSoftGateTarget = { channel: "stable", version: "1.1.0" };

const notifyMessages = (notify) =>
  notify.mock.calls.map(([message]) => String(message));

const readRunBackupRecord = (harness) => {
  const runsDir = path.join(harness.openclawDir, ".alphaclaw", "runs");
  const names = fs.readdirSync(runsDir);
  expect(names.length).toBeGreaterThan(0);
  const records = names.map((name) =>
    JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")),
  );
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return records[0].backup;
};

describe("server/openclaw-channel-backup-retry", () => {
  describe("quiesce-first (hard gate + gatewayQuiesce injected)", () => {
    it("pauses the gateway, backs up once, relaunches, releases — in that exact order", async () => {
      const quiesce = makeQuiesceRecorder({});
      const { runnerImpl, backupCalls } = makeBackupRunner({
        onBackupCall: () => quiesce.calls.push("backup-cli"),
      });
      const harness = createHarness({ runnerImpl, gatewayQuiesce: quiesce });

      const result = await harness.sync.applyUpdate(kHardGateTarget);

      expect(result.status).toBe(202);
      expect(result.body.restarting).toBe(true);
      expect(backupCalls).toHaveLength(1);
      expect(quiesce.calls).toEqual([
        "acquireLock",
        "isRunning",
        "suppress",
        "stop",
        "backup-cli",
        "start",
        "unsuppress",
        "release",
      ]);
      expect(quiesce.suppressDurationMs).toBeGreaterThan(0);
      const backupRecord = readRunBackupRecord(harness);
      expect(backupRecord).toEqual(
        expect.objectContaining({ quiesced: true, attempts: 1, noBackup: false }),
      );
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

    it("a failed gateway relaunch after the backup warns and notifies instead of failing the apply", async () => {
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
});
