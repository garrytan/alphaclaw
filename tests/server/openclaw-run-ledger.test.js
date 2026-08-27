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

    it("push/flush round-trips partial lines", () => {
      const redactor = createRedactor(["hunter2secret"]);
      const out1 = redactor.push("prefix hunter2");
      const out2 = redactor.push("secret suffix");
      const out3 = redactor.flush();
      expect(out1 + out2 + out3).toBe("prefix [redacted] suffix");
    });
  });
});
