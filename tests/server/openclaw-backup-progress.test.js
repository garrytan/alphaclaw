const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createBackupProgress } = require("../../lib/server/openclaw-backup-progress");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { kDefaultBackupBudget, priorBackupFailure } = require("../../lib/server/openclaw-backup-ladder");

describe("attempt-owned backup progress", () => {
  let dir;
  let root;
  let output;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-progress-"));
    root = path.join(dir, "attempt");
    fs.mkdirSync(root);
    output = path.join(root, "archive.tar.gz");
  });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  const makeRunner = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn((signal) => child.emit("close", null, signal));
    const runner = createRunStream({ spawnImpl: () => child, processGroupAlive: () => false });
    return { runner, child };
  };

  it("counts only forward growth of the first file identity, not truncation, regrowth, replacement, or old sibling staging", () => {
    const progress = createBackupProgress({ root, outputFile: output });
    const file = path.join(root, "archive.tmp");
    fs.writeFileSync(file, "x".repeat(100));
    expect(progress.probe()).toEqual({ bytes: 100, phase: "write" });
    fs.truncateSync(file, 10);
    expect(progress.probe().bytes).toBe(100);
    fs.appendFileSync(file, "x".repeat(90));
    expect(progress.probe().bytes).toBe(100);
    fs.renameSync(file, path.join(dir, "old-inode"));
    fs.writeFileSync(file, "x".repeat(1000));
    expect(progress.probe().bytes).toBe(100);
    const old = path.join(dir, ".openclaw-backup-publish-old");
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, "archive.tmp"), "x".repeat(9000));
    expect(progress.probe().bytes).toBe(100);
  });

  it("counts one inode only once across renames, hardlinks and final publication", () => {
    const progress = createBackupProgress({ root, outputFile: output });
    let file = path.join(root, "first.tmp");
    fs.writeFileSync(file, Buffer.alloc(1024));
    const samples = [progress.probe().bytes];
    for (let index = 0; index < 4; index++) {
      const next = path.join(root, `renamed-${index}.tmp`);
      fs.renameSync(file, next);
      file = next;
      samples.push(progress.probe().bytes);
    }
    expect(samples).toEqual([1024, 1024, 1024, 1024, 1024]);
    fs.linkSync(file, path.join(root, "alias.tmp"));
    expect(progress.probe()).toEqual({ bytes: 1024, phase: "write" });
    fs.renameSync(file, output);
    expect(progress.probe()).toEqual({ bytes: 1024, phase: "verify" });
    fs.appendFileSync(path.join(root, "alias.tmp"), Buffer.alloc(512));
    expect(progress.probe()).toEqual({ bytes: 1536, phase: "verify" });
  });

  it("bounds directory inspection and retained identities and never follows symlinks", () => {
    fs.symlinkSync(dir, path.join(root, "cycle"));
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, String(i)), "xx");
    const real = fs.opendirSync.bind(fs);
    let reads = 0;
    const progress = createBackupProgress({ root, outputFile: output, maxEntries: 8,
      fsModule: { ...fs, opendirSync: (name) => {
        const handle = real(name);
        return { readSync: () => { reads++; return handle.readSync(); }, closeSync: () => handle.closeSync() };
      } } });
    expect(progress.probe().bytes).toBeLessThanOrEqual(16);
    expect(reads).toBeLessThanOrEqual(8);
  });

  it("still sees publication and final verification after assembly exhausts the bounded sample", () => {
    const assembly = path.join(root, "openclaw-backup-assembly");
    fs.mkdirSync(assembly);
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(assembly, String(i)), "x");
    const progress = createBackupProgress({ root, outputFile: output, maxEntries: 10 });
    const before = progress.probe().bytes;
    const publish = path.join(root, ".openclaw-backup-publish-attempt");
    fs.mkdirSync(publish);
    fs.writeFileSync(path.join(publish, "archive.tar.gz.tmp"), "x".repeat(100));
    expect(progress.probe().bytes).toBe(before + 100);
    fs.renameSync(path.join(publish, "archive.tar.gz.tmp"), output);
    expect(progress.probe()).toEqual({ bytes: before + 100, phase: "verify" });
  });

  it.each([false, true])("does not follow a replaced staging root (symlink: %s)", (symlink) => {
    const progress = createBackupProgress({ root, outputFile: output });
    fs.writeFileSync(path.join(root, "old.tmp"), "x");
    expect(progress.probe().bytes).toBe(1);
    fs.renameSync(root, `${root}-original`);
    if (symlink) fs.symlinkSync(`${root}-original`, root);
    else fs.mkdirSync(root);
    fs.writeFileSync(output, "replacement archive");
    expect(progress.probe()).toEqual({ bytes: 1, phase: "write" });
  });

  it("lets a silent, growing admitted writer finish after twelve virtual minutes", async () => {
    vi.useFakeTimers();
    const progress = createBackupProgress({ root, outputFile: output });
    const { runner, child } = makeRunner();
    const result = runner.runStreamed({ command: "writer", timeoutMs: kDefaultBackupBudget.phaseEnvelopeMs -
      kDefaultBackupBudget.usableCheckReserveMs - kDefaultBackupBudget.upstreamCleanupReserveMs,
    inactivityTimeoutMs: kDefaultBackupBudget.upstreamInactivityMs, outputCountsAsProgress: false, progressProbe: progress.probe });
    const file = path.join(root, "archive.tmp");
    for (let minute = 0; minute < 12; minute++) {
      fs.appendFileSync(file, Buffer.alloc(1024));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.kill).not.toHaveBeenCalled();
    }
    child.emit("close", 0, null);
    expect(await result).toMatchObject({ ok: true, durationMs: 12 * 60_000 });
  });

  it("stops nonmonotonic log-spamming work at the idle deadline", async () => {
    vi.useFakeTimers();
    const file = path.join(root, "archive.tmp");
    fs.writeFileSync(file, "x".repeat(100));
    const progress = createBackupProgress({ root, outputFile: output });
    const { runner, child } = makeRunner();
    const result = runner.runStreamed({ command: "writer", timeoutMs: 25 * 60_000,
      inactivityTimeoutMs: 3 * 60_000, outputCountsAsProgress: false, progressProbe: progress.probe });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(file, "x".repeat(i % 2 ? 100 : 10));
      child.stdout.emit("data", "still waiting\n");
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(await result).toMatchObject({ ok: false, stalled: true, timedOut: false, durationMs: 3 * 60_000 });
  });

  it("rename and hardlink churn cannot renew the inactivity window", async () => {
    vi.useFakeTimers();
    let file = path.join(root, "archive.tmp");
    fs.writeFileSync(file, Buffer.alloc(1024));
    const progress = createBackupProgress({ root, outputFile: output });
    const { runner, child } = makeRunner();
    const result = runner.runStreamed({ command: "writer", timeoutMs: 25 * 60_000,
      inactivityTimeoutMs: 3 * 60_000, outputCountsAsProgress: false, progressProbe: progress.probe });
    for (let index = 0; index < 6; index++) {
      const next = path.join(root, `renamed-${index}.tmp`);
      fs.renameSync(file, next);
      fs.linkSync(next, path.join(root, `alias-${index}.tmp`));
      file = next;
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ stalled: true, timedOut: false, durationMs: 3 * 60_000 });
    expect(progress.probe()).toEqual({ bytes: 1024, phase: "write" });
  });

  it("grants silent verification one finite allowance that output and phase oscillations cannot renew", async () => {
    vi.useFakeTimers();
    const { runner, child } = makeRunner();
    let phase = "verify";
    const result = runner.runStreamed({ command: "verify", timeoutMs: 20 * 60_000,
      inactivityTimeoutMs: 60_000, verificationTimeoutMs: 5 * 60_000,
      outputCountsAsProgress: false, progressProbe: () => ({ bytes: 100, phase }) });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
    phase = "write";
    await vi.advanceTimersByTimeAsync(60_000);
    phase = "verify";
    child.stdout.emit("data", "still verifying\n");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await result).toMatchObject({ timedOut: true, verificationTimedOut: true, durationMs: 5 * 60_000 });
  });

  it("preserves the phase reserve even while bytes keep increasing", async () => {
    vi.useFakeTimers();
    const { runner } = makeRunner();
    let bytes = 0;
    const timeoutMs = kDefaultBackupBudget.phaseEnvelopeMs - kDefaultBackupBudget.usableCheckReserveMs -
      kDefaultBackupBudget.upstreamCleanupReserveMs;
    const result = runner.runStreamed({ command: "writer", timeoutMs, inactivityTimeoutMs: 180_000,
      outputCountsAsProgress: false, progressProbe: () => ++bytes });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(await result).toMatchObject({ timedOut: true, durationMs: timeoutMs });
    expect(kDefaultBackupBudget.phaseEnvelopeMs - timeoutMs).toBe(70_000);
  });

  it("keeps an honest failure receipt separate from successful throughput calibration", () => {
    const failure = { rung: "upstream", ok: false, kind: "stalled", elapsedMs: 180_000,
      progress: { doneBytes: 100, stage: "write" }, timeoutMs: 1_430_000 };
    expect(priorBackupFailure([{ operationId: "second", backup: {} },
      { operationId: "first", backup: { noBackup: true, attemptsDetail: [failure] } }])).toEqual({
      operationId: "first", kind: "stalled", elapsedMs: 180_000, progress: failure.progress, timeoutMs: 1_430_000,
    });
  });
});
