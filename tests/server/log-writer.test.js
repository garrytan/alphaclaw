const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initLogWriter,
  getLogPath,
  readLogTail,
  __flushForTests,
  __flushSyncForTests,
} = require("../../lib/server/log-writer");

// Captured once, before any test replaces or init patches them.
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;

const waitFor = async (fn, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timeout");
};

describe("server/log-writer", () => {
  let rootDir;
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-log-writer-"));
    // Silence the passthrough so test output stays clean; initLogWriter wraps
    // whatever process.stdout.write is at init time.
    stdoutSpy = vi.fn(() => true);
    stderrSpy = vi.fn(() => true);
    process.stdout.write = stdoutSpy;
    process.stderr.write = stderrSpy;
  });

  afterEach(async () => {
    await __flushForTests().catch(() => {});
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("writes patched stdout/stderr lines with ISO prefix and readLogTail returns them", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    process.stdout.write("hello from stdout\n");
    process.stderr.write("hello from stderr\n");
    await __flushForTests();

    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z hello from stdout\n/m,
    );
    expect(content).toContain("hello from stderr");
    // Console passthrough preserved
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();

    const tail = readLogTail(65536);
    expect(tail).toContain("hello from stdout");
    expect(tail).toContain("hello from stderr");
  });

  it("readLogTail(smallN) returns only the tail", async () => {
    initLogWriter({ rootDir, maxBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < 100; i++) {
      process.stdout.write(`line-${String(i).padStart(4, "0")} ${"x".repeat(60)}\n`);
    }
    await __flushForTests();

    const tail = readLogTail(1024);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1024);
    expect(tail).toContain("line-0099");
    expect(tail).not.toContain("line-0000");
  });

  it("rotates past maxBytes: shrinks to ~half, line-aligned, keeps newest lines", async () => {
    const maxBytes = 4096;
    initLogWriter({ rootDir, maxBytes });
    // 30 lines x ~180 bytes ≈ 5.4KB > maxBytes; 30 ≥ 25 triggers the size check.
    for (let i = 0; i < 30; i++) {
      process.stdout.write(`rot-${String(i).padStart(3, "0")} ${"y".repeat(150)}\n`);
    }
    await __flushForTests();

    const stat = fs.statSync(getLogPath());
    expect(stat.size).toBeGreaterThan(0);
    expect(stat.size).toBeLessThanOrEqual(maxBytes / 2);
    const content = fs.readFileSync(getLogPath(), "utf8");
    // Starts at a line boundary (every line begins with the ISO prefix)
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(content).toContain("rot-029");
    expect(content).not.toContain("rot-000");
    expect(fs.existsSync(`${getLogPath()}.tmp`)).toBe(false);

    // readLogTail keeps working across rotation
    process.stdout.write("after-rotation line\n");
    await __flushForTests();
    expect(readLogTail(65536)).toContain("after-rotation line");
  });

  it("survives ENOSPC without throwing, keeps passthrough, emits marker on recovery", async () => {
    let failWrites = false;
    const fsShim = Object.create(fs);
    fsShim.write = (...args) => {
      if (failWrites) {
        const cb = args[args.length - 1];
        const err = Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
        process.nextTick(() => cb(err));
        return;
      }
      return fs.write(...args);
    };
    initLogWriter({
      rootDir,
      maxBytes: 1024 * 1024,
      _fs: fsShim,
      _retryIntervalMs: 0,
    });

    failWrites = true;
    expect(() => process.stdout.write("doomed line\n")).not.toThrow();
    await __flushForTests();
    // Broken state: further writes are dropped, still no throw
    expect(() => process.stdout.write("dropped while broken\n")).not.toThrow();
    expect(stdoutSpy).toHaveBeenCalledTimes(2);

    failWrites = false;
    process.stdout.write("recovery trigger\n");
    await waitFor(() =>
      fs.readFileSync(getLogPath(), "utf8").includes("log-writer dropped"),
    );
    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content).toMatch(/\[alphaclaw\] log-writer dropped \d+ lines \(write failure\)/);
    expect(content).not.toContain("doomed line");

    process.stdout.write("back alive\n");
    await __flushForTests();
    expect(fs.readFileSync(getLogPath(), "utf8")).toContain("back alive");
  });

  it("drops lines on queue overflow and emits exactly one marker", async () => {
    initLogWriter({ rootDir, maxBytes: 64 * 1024 * 1024 });
    // Queue cap is 4MB; 70 synchronous ~64KB lines overflow it before the
    // deferred drain can run.
    const big = "z".repeat(64 * 1024);
    for (let i = 0; i < 70; i++) {
      process.stdout.write(`ovf-${String(i).padStart(2, "0")} ${big}\n`);
    }
    await __flushForTests();

    const content = fs.readFileSync(getLogPath(), "utf8");
    const markers =
      content.match(/\[alphaclaw\] log-writer dropped \d+ lines \(queue overflow\)/g) || [];
    expect(markers).toHaveLength(1);
    expect(content).toContain("ovf-00");
    expect(content).not.toContain("ovf-69");
  });

  it("sync flush (exit path) writes queued lines synchronously", () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    process.stdout.write("exit line one\n");
    process.stdout.write("exit line two\n");
    // The drain is deferred via setImmediate, so nothing has hit disk yet;
    // the exit-path flush must persist the queue with blocking writes.
    __flushSyncForTests();
    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content).toContain("exit line one");
    expect(content).toContain("exit line two");
  });

  it("re-init does not double-patch streams or duplicate lines", async () => {
    const exitListenersBefore = process.listenerCount("exit");
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    expect(process.listenerCount("exit") - exitListenersBefore).toBeLessThanOrEqual(1);

    process.stdout.write("single line\n");
    await __flushForTests();
    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content.match(/single line/g)).toHaveLength(1);
  });
});
