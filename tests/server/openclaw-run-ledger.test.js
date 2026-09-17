const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRunLedger,
  createRedactor,
  collectSecretValues,
} = require("../../lib/server/openclaw-run-ledger");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const makeLedger = (overrides = {}) => {
  const openclawDir = mkTemp("run-ledger-test-");
  const nowRef = { now: 1_000_000 };
  const ledger = createRunLedger({
    openclawDir,
    nowFn: () => nowRef.now,
    logger: kSilentLogger,
    ...overrides,
  });
  return { ledger, openclawDir, nowRef };
};

const kOpA = "11111111-aaaa-4bbb-8ccc-111111111111";
const kOpB = "22222222-aaaa-4bbb-8ccc-222222222222";
const kOpC = "33333333-aaaa-4bbb-8ccc-333333333333";

describe("server/openclaw-run-ledger", () => {
  describe("records", () => {
    it("creates, reads, and completes a run with a validated operationId", () => {
      const { ledger, nowRef } = makeLedger();
      const record = ledger.createRun({
        operationId: kOpA,
        target: { channel: "beta", version: "1.1.0-beta.1" },
      });
      expect(record.state).toBe("running");
      expect(ledger.readRun(kOpA).target.version).toBe("1.1.0-beta.1");

      nowRef.now += 500;
      const done = ledger.completeRun(kOpA, {
        state: "restart_expected",
        ok: true,
        result: { ok: true },
      });
      expect(done.state).toBe("restart_expected");
      expect(done.finishedAt).toBe(1_000_500);
    });

    it("refuses malformed operationIds for create and read (path containment)", () => {
      const { ledger } = makeLedger();
      expect(() =>
        ledger.createRun({ operationId: "../../etc/passwd", target: {} }),
      ).toThrow(/invalid operationId/);
      expect(ledger.readRun("../escape")).toBeNull();
      expect(ledger.openLogStream("..%2F..")).toBeNull();
    });

    it("same-version retries stay distinct runs, listed newest first", () => {
      const { ledger, nowRef } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: { version: "1.1.0" } });
      ledger.completeRun(kOpA, { state: "failed", ok: false });
      nowRef.now += 1000;
      ledger.createRun({ operationId: kOpB, target: { version: "1.1.0" } });
      const runs = ledger.listRuns();
      expect(runs.map((r) => r.operationId)).toEqual([kOpB, kOpA]);
      expect(runs[1].state).toBe("failed");
      expect(runs[0].state).toBe("running");
    });
  });

  describe("boot step appends (issue #20)", () => {
    it("appends boot-phase steps through the atomic RMW, preserving apply-time steps", () => {
      const { ledger, nowRef } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: { version: "1.1.0" } });
      ledger.updateRun(kOpA, (record) => {
        record.steps = [{ name: "restarting", status: "running", at: 1 }];
        return record;
      });

      nowRef.now += 100;
      const next = ledger.appendStep(kOpA, {
        name: "config-migrate",
        status: "running",
        detail: "running doctor --fix (budget 10 min)",
      });

      expect(next.steps.map((s) => s.name)).toEqual([
        "restarting",
        "config-migrate",
      ]);
      expect(next.steps[1]).toEqual(
        expect.objectContaining({
          status: "running",
          at: 1_000_100,
          detail: "running doctor --fix (budget 10 min)",
        }),
      );
    });

    it("no-ops on a missing name, an unknown run, and an invalid operationId", () => {
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: {} });
      expect(ledger.appendStep(kOpA, { status: "running" }).steps).toEqual([]);
      expect(ledger.appendStep(kOpB, { name: "x" })).toBeNull();
      expect(ledger.appendStep("../escape", { name: "x" })).toBeNull();
      expect(ledger.appendStep(undefined, { name: "x" })).toBeNull();
    });

    it("round-trips the structured dbPreflight verdict", () => {
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: {} });
      ledger.updateRun(kOpA, (record) => {
        record.dbPreflight = {
          migrationRequired: true,
          foundVersion: 1,
          targetVersion: 12,
          dbSizesBytes: 767 * 1024 * 1024,
        };
        return record;
      });
      expect(ledger.readRun(kOpA).dbPreflight).toEqual({
        migrationRequired: true,
        foundVersion: 1,
        targetVersion: 12,
        dbSizesBytes: 767 * 1024 * 1024,
      });
    });
  });

  describe("boot transitions", () => {
    it("resolves restart_expected to activated / activation_failed", () => {
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: { version: "1.1.0" } });
      ledger.completeRun(kOpA, { state: "restart_expected", ok: true });

      const resolved = ledger.resolveRestartExpected({ activated: true });
      expect(resolved.state).toBe("activated");
      expect(resolved.ok).toBe(true);

      ledger.createRun({ operationId: kOpB, target: { version: "1.2.0" } });
      ledger.completeRun(kOpB, { state: "restart_expected", ok: true });
      const failed = ledger.resolveRestartExpected({
        activated: false,
        detail: "overlay missing",
      });
      expect(failed.state).toBe("activation_failed");
      expect(failed.result.message).toContain("overlay missing");
    });

    it("closes runs still 'running' as interrupted, leaving restart_expected alone", () => {
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: {} });
      ledger.createRun({ operationId: kOpB, target: {} });
      ledger.completeRun(kOpB, { state: "restart_expected", ok: true });

      const closed = ledger.closeInterruptedRuns();
      expect(closed.map((r) => r.operationId)).toEqual([kOpA]);
      expect(ledger.readRun(kOpA).state).toBe("interrupted");
      expect(ledger.readRun(kOpB).state).toBe("restart_expected");
    });
  });

  describe("log sink", () => {
    it("streams redacted output to the per-operation log and survives reads via openLogStream", async () => {
      process.env.RUN_LEDGER_TEST_TOKEN = "super-secret-value-123";
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: {} });
      const sink = ledger.createLogSink({ operationId: kOpA });
      sink.writeLine("hello world");
      sink.write("token is super-secret");
      sink.write("-value-123 done\n");
      await sink.close();
      delete process.env.RUN_LEDGER_TEST_TOKEN;

      const opened = ledger.openLogStream(kOpA);
      expect(opened).not.toBeNull();
      const content = fs.readFileSync(opened.filePath, "utf8");
      expect(content).toContain("hello world");
      // Chunk-boundary redaction: the secret was split across two writes.
      expect(content).not.toContain("super-secret-value-123");
      expect(content).toContain("[redacted]");
      expect(ledger.readRun(kOpA).hasLog).toBe(true);
    });

    it("scrubs extraSecretEnv secret-keyed values but keeps benign paths like HOME", async () => {
      const { ledger } = makeLedger();
      ledger.createRun({ operationId: kOpA, target: {} });
      const sink = ledger.createLogSink({
        operationId: kOpA,
        extraSecretEnv: { HOME: "/Users/x", MY_API_KEY: "longsecret1" },
      });
      sink.writeLine("npm cache at /Users/x/.npm using key longsecret1");
      await sink.close();

      const content = fs.readFileSync(
        ledger.openLogStream(kOpA).filePath,
        "utf8",
      );
      expect(content).not.toContain("longsecret1");
      expect(content).toContain("[redacted]");
      // Benign env values (HOME) must survive so npm output stays legible.
      expect(content).toContain("/Users/x/.npm");
    });

    it("caps the per-run log with a single truncation marker", async () => {
      const { ledger } = makeLedger({ maxLogBytesPerRun: 200 });
      ledger.createRun({ operationId: kOpA, target: {} });
      const sink = ledger.createLogSink({ operationId: kOpA });
      for (let i = 0; i < 50; i += 1) sink.writeLine("x".repeat(20));
      await sink.close();
      const content = fs.readFileSync(
        ledger.openLogStream(kOpA).filePath,
        "utf8",
      );
      expect(content.length).toBeLessThan(400);
      expect(content.match(/log truncated/g)).toHaveLength(1);
    });

    it("fails open when the log directory is unwritable (ENOSPC class)", async () => {
      const { ledger } = makeLedger({
        fsModule: {
          ...fs,
          mkdirSync: () => {
            throw new Error("ENOSPC");
          },
          readFileSync: fs.readFileSync,
        },
      });
      // createRun also mkdirs — so create against a working ledger first is
      // moot; the sink itself must degrade to a no-op, never throw.
      const sink = ledger.createLogSink({ operationId: kOpA });
      expect(() => {
        sink.write("data");
        sink.writeLine("line");
      }).not.toThrow();
      await expect(sink.close()).resolves.toBeUndefined();
      expect(sink.failed).toBe(true);
    });
  });

  describe("pruning", () => {
    it("keeps migration recovery provenance beyond both run rings until its archive pin expires", () => {
      const { ledger, nowRef } = makeLedger({ keepRuns: 2, keepBackupRuns: 1 });
      ledger.createRun({ operationId: kOpA, target: { channel: "stable", version: "2.0.0" } });
      ledger.updateRun(kOpA, (record) => ({ ...record,
        dbPreflight: { migrationRequired: true },
        backup: { verified: true, file: "/backups/openclaw-backup-migration.alphaclaw.tar.gz",
          profile: "migration-minimal", partial: true,
          coverage: { migration: "complete", core: "partial", workspace: "omitted" } },
      }));
      ledger.completeRun(kOpA, { state: "activated", ok: true });
      nowRef.now += 1_000;
      ledger.createRun({ operationId: kOpB, target: { channel: "stable", version: "2.0.1" } });
      ledger.updateRun(kOpB, (record) => ({ ...record, dbPreflight: { migrationRequired: true },
        backup: { verified: true, file: "/backups/openclaw-backup-failed-retry.alphaclaw.tar.gz" },
      }));
      ledger.completeRun(kOpB, { state: "failed", ok: false });
      nowRef.now += 1_000;
      ledger.createRun({ operationId: kOpC, target: { channel: "stable", version: "2.0.1" } });
      ledger.updateRun(kOpC, (record) => ({ ...record, dbPreflight: { migrationRequired: true } }));
      ledger.completeRun(kOpC, { state: "failed", ok: false });
      for (let index = 0; index < 12; index += 1) {
        nowRef.now += 1_000;
        const suffix = index.toString(16).padStart(12, "0");
        const update = `aaaaaaaa-aaaa-4bbb-8ccc-${suffix}`;
        const manual = `bbbbbbbb-aaaa-4bbb-8ccc-${suffix}`;
        ledger.createRun({ operationId: update, target: { channel: "stable", version: "2.0.1" } });
        ledger.completeRun(update, { state: "failed", ok: false });
        nowRef.now += 1;
        ledger.createRun({ operationId: manual, target: { kind: "backup" } });
        ledger.completeRun(manual, { state: "completed", ok: true });
        ledger.pruneRuns();
      }
      expect(ledger.listRuns()).toHaveLength(6);
      expect(ledger.readRun(kOpB).state).toBe("failed");
      expect(ledger.readRun(kOpC).state).toBe("failed");
      expect(ledger.readRun(kOpA).backup).toMatchObject({
        profile: "migration-minimal", verified: true, coverage: { migration: "complete" },
      });
      nowRef.now += require("../../lib/server/constants").kOpenclawBackupPinMaxAgeMs + 1;
      ledger.pruneRuns();
      expect(ledger.readRun(kOpA)).toBeNull();
      expect(ledger.readRun(kOpB)).toBeNull();
      expect(ledger.readRun(kOpC)).toBeNull();
      expect(ledger.listRuns()).toHaveLength(3);
    });

    it("keeps the newest N runs and enforces the total log byte cap", async () => {
      const { ledger, nowRef } = makeLedger({
        keepRuns: 2,
        maxLogBytesTotal: 150,
      });
      for (const [index, id] of [kOpA, kOpB, kOpC].entries()) {
        nowRef.now += 1000;
        ledger.createRun({ operationId: id, target: { index } });
        const sink = ledger.createLogSink({ operationId: id });
        sink.writeLine("y".repeat(100));
        await sink.close();
        ledger.completeRun(id, { state: "failed", ok: false });
      }
      ledger.pruneRuns();
      const runs = ledger.listRuns();
      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.operationId)).toEqual([kOpC, kOpB]);
      expect(ledger.readRun(kOpA)).toBeNull();
      // Total cap 150 < 2x100-byte logs: the older kept run's log is culled.
      expect(ledger.openLogStream(kOpB)).toBeNull();
      expect(ledger.openLogStream(kOpC)).not.toBeNull();
    });
  });

  describe("redactor primitives", () => {
    it("collects only secret-shaped env values above the length floor", () => {
      const values = collectSecretValues({
        env: {
          MY_API_KEY: "abcdefgh",
          SHORT_TOKEN: "abc",
          PLAIN_SETTING: "not-a-secret-shape",
        },
      });
      expect(values).toContain("abcdefgh");
      expect(values).not.toContain("abc");
      expect(values).not.toContain("not-a-secret-shape");
    });

    it("filters extraEnv by secret-shaped key, leaving benign keys unredacted", () => {
      const values = collectSecretValues({
        env: {},
        extraEnv: { HOME: "/Users/x", MY_API_KEY: "longsecret1" },
      });
      expect(values).toEqual(["longsecret1"]);
      expect(values).not.toContain("/Users/x");
    });

    it("push/flush round-trips partial lines", () => {
      const redactor = createRedactor(["hunter2secret"]);
      const out1 = redactor.push("prefix hunter2");
      const out2 = redactor.push("secret suffix");
      const out3 = redactor.flush();
      expect(out1 + out2 + out3).toBe("prefix [redacted] suffix");
    });
  });

  // v0.9.81 (C3): a standalone backup run's terminal success.
  it("keeps `completed` as a terminal state (never coerced to failed) and passes intentCheck through", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-completed-"));
    const ledger = createRunLedger({ openclawDir: dir, nowFn: () => 5_000, logger: { log() {}, warn() {} } });
    const operationId = "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d";
    ledger.createRun({ operationId, target: { kind: "backup" } });
    ledger.updateRun(operationId, (record) => {
      record.intentCheck = { direction: "not_applicable", latest: "not_applicable" };
      return record;
    });
    const done = ledger.completeRun(operationId, { state: "completed", ok: true, result: { ok: true, archive: { file: "/x" } } });
    expect(done.state).toBe("completed");
    expect(done.ok).toBe(true);
    expect(ledger.readRun(operationId)).toEqual(
      expect.objectContaining({
        state: "completed",
        target: { kind: "backup" },
        intentCheck: { direction: "not_applicable", latest: "not_applicable" },
      }),
    );
    expect(ledger.completeRun(operationId, { state: "bogus", ok: false }).state).toBe("failed");
  });

  // v0.9.81 (review): backup runs have their own ring and their own
  // interrupted copy.
  it("prunes backup runs on their own ring so manual backups never evict update records, and closes a dangling backup run with backup wording", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-ledger-backup-ring-"));
    let now = 10_000;
    const ledger = createRunLedger({ openclawDir: dir, nowFn: () => now, logger: { log() {}, warn() {} }, keepRuns: 2, keepBackupRuns: 1 });
    const ids = {
      applyOld: "aaaaaaaa-1111-4bbb-8ccc-000000000001",
      applyNew: "aaaaaaaa-1111-4bbb-8ccc-000000000002",
      backupOld: "bbbbbbbb-1111-4bbb-8ccc-000000000001",
      backupMid: "bbbbbbbb-1111-4bbb-8ccc-000000000002",
      backupNew: "bbbbbbbb-1111-4bbb-8ccc-000000000003",
      backupRunning: "bbbbbbbb-1111-4bbb-8ccc-000000000004",
    };
    const make = (operationId, target, state) => {
      now += 1000;
      ledger.createRun({ operationId, target });
      if (state) ledger.completeRun(operationId, { state, ok: state === "completed" });
    };
    make(ids.applyOld, { channel: "stable", version: "1.0.0" }, "failed");
    make(ids.backupOld, { kind: "backup" }, "completed");
    make(ids.backupMid, { kind: "backup" }, "failed");
    make(ids.applyNew, { channel: "stable", version: "1.1.0" }, "failed");
    make(ids.backupNew, { kind: "backup" }, "completed");
    make(ids.backupRunning, { kind: "backup" }, null);
    ledger.pruneRuns();
    const kept = ledger.listRuns().map((run) => run.operationId).sort();
    // Both apply records survive (keep 2) although four backup runs are newer;
    // the backup ring keeps only its newest (the running one).
    expect(kept).toEqual([ids.applyNew, ids.applyOld, ids.backupRunning].sort());
    const [closed] = ledger.closeInterruptedRuns();
    expect(closed.operationId).toBe(ids.backupRunning);
    expect(closed.state).toBe("interrupted");
    expect(closed.result.message).toBe("AlphaClaw restarted before the backup finished.");
    expect(closed.result.hint).toMatch(/Run Back up now again/);
  });

  // v0.9.84: two runs created inside the same millisecond (the CI Node 26 lane
  // hit it through upgrade-overseer.test.js: readdir listed the older run
  // first) must still list newest-first — the overseer picker, the Upgrade
  // page, both prune rings and diagnose read listRuns()[0] as "latest".
  describe("ordering (same-millisecond startedAt)", () => {
    const runsDir = (openclawDir) => path.join(openclawDir, ".alphaclaw", "runs");

    it("lists the newer run first when runs share a startedAt, in-process, after a completeRun rewrite and after re-opening the ledger", () => {
      const { ledger, openclawDir } = makeLedger(); // constant clock: 1_000_000
      ledger.createRun({ operationId: kOpA, target: { channel: "beta", version: "1.0.0" } });
      ledger.createRun({ operationId: kOpB, target: { kind: "backup" } });
      ledger.createRun({ operationId: kOpC, target: { channel: "beta", version: "1.1.0" } });
      expect(ledger.listRuns().map((run) => run.startedAt)).toEqual([1_000_000, 1_000_000, 1_000_000]);
      expect(ledger.listRuns().map((run) => run.operationId)).toEqual([kOpC, kOpB, kOpA]);
      // completeRun goes through normalizeRecord: the sequence survives the rewrite.
      ledger.completeRun(kOpB, { state: "failed", ok: false });
      ledger.completeRun(kOpC, { state: "failed", ok: false });
      expect(ledger.listRuns().map((run) => run.operationId)).toEqual([kOpC, kOpB, kOpA]);
      // A restarted server re-opens the same directory: the persisted sequence still orders.
      const reopened = createRunLedger({ openclawDir, nowFn: () => 1_000_000, logger: kSilentLogger });
      expect(reopened.listRuns().map((run) => run.operationId)).toEqual([kOpC, kOpB, kOpA]);
      // and its own new run (sequence restarts at 1) lands first only because its clock is later.
      const later = createRunLedger({ openclawDir, nowFn: () => 1_000_001, logger: kSilentLogger });
      later.createRun({ operationId: "44444444-aaaa-4bbb-8ccc-444444444444", target: { kind: "backup" } });
      expect(later.listRuns()[0].operationId).toBe("44444444-aaaa-4bbb-8ccc-444444444444");
    });

    it("a later startedAt beats a higher sequence; legacy records without a sequence sort behind a stamped one and among themselves by operationId", () => {
      const { ledger, nowRef, openclawDir } = makeLedger();
      ledger.createRun({ operationId: kOpC, target: { channel: "beta", version: "1.1.0" } }); // seq 1 @ t
      nowRef.now -= 5;
      ledger.createRun({ operationId: kOpA, target: { channel: "beta", version: "1.0.0" } }); // seq 2 @ t-5
      expect(ledger.listRuns().map((run) => run.operationId)).toEqual([kOpC, kOpA]);
      // Legacy (pre-v0.9.84) records: no seq, same millisecond as kOpC.
      const legacy = (operationId) =>
        fs.writeFileSync(
          path.join(runsDir(openclawDir), operationId + ".json"),
          JSON.stringify({ operationId, target: { kind: "backup" }, state: "failed", startedAt: 1_000_000, finishedAt: 1_000_000, ok: false }),
        );
      legacy(kOpB);
      legacy("00000000-aaaa-4bbb-8ccc-000000000000");
      expect(ledger.readRun(kOpB)).not.toHaveProperty("seq");
      expect(ledger.readRun(kOpC).seq).toBe(1);
      expect(ledger.listRuns().map((run) => run.operationId)).toEqual([
        kOpC, // stamped seq wins the tie
        kOpB, // legacy ties: operationId descending, deterministic
        "00000000-aaaa-4bbb-8ccc-000000000000",
        kOpA, // older clock last
      ]);
    });
  });
});
