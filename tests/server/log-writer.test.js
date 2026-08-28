const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initLogWriter,
  getLogPath,
  readLogTail,
  flushLogWriter,
  __resetLogWriterForTests,
} = require("../../lib/server/log-writer");

// initLogWriter monkey-patches process.stdout/stderr.write and keeps
// module-level state. Every test resets that state AND restores the original
// write functions, or patch layers would stack across tests. Tests write via
// process.stdout.write directly (vitest intercepts console.*, which would
// bypass the patch).
describe("server/log-writer", () => {
  let tmpDir;
  let savedStdoutWrite;
  let savedStderrWrite;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-log-writer-"));
    savedStdoutWrite = process.stdout.write;
    savedStderrWrite = process.stderr.write;
  });

  afterEach(async () => {
    __resetLogWriterForTests();
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    vi.useRealTimers();
    // The append stream opens lazily. Removing the temp dir before a pending
    // open completes makes that open fail LATER — inside the next test — and
    // its error handler would trip the (module-shared) degraded state. Let
    // pending opens settle before deleting the directory.
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures stdout and stderr lines with timestamps into the process log", () => {
    initLogWriter({ rootDir: tmpDir, maxBytes: 1024 * 1024 });

    expect(getLogPath()).toBe(path.join(tmpDir, "logs", "process.log"));
    process.stdout.write("hello from stdout\n");
    process.stderr.write("hello from stderr\n");
    flushLogWriter();

    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content).toContain("hello from stdout");
    expect(content).toContain("hello from stderr");
    // Lines get ISO-timestamp prefixes.
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[^\n]*hello from stdout\n/m);
  });

  it("readLogTail flushes queued lines before reading", async () => {
    initLogWriter({ rootDir: tmpDir, maxBytes: 1024 * 1024 });

    process.stdout.write("queued-line-alpha\n");
    // No manual flush: the first readLogTail drains the queue itself (through
    // the async write stream, so poll until the bytes land).
    await vi.waitFor(() => {
      expect(readLogTail(65536)).toContain("queued-line-alpha");
    });
  });

  it("returns an empty tail before init", () => {
    expect(readLogTail(65536)).toBe("");
  });

  it("rotates to .1 past maxBytes and stitches tails across the rotation", async () => {
    // Only Date is faked (to hop the 2s size-check interval and the 30s
    // reopen window); streams and timers stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    initLogWriter({ rootDir: tmpDir, maxBytes: 512 });
    const logPath = getLogPath();

    process.stdout.write(`OLD-GENERATION ${"x".repeat(700)}\n`);
    flushLogWriter();
    expect(fs.statSync(logPath).size).toBeGreaterThan(512);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);

    // Size checks are rate-limited to every 2s: hop past the window, then
    // trigger a flush-with-content so rotateIfNeeded actually runs.
    vi.setSystemTime(Date.now() + 5000);
    process.stdout.write("rotation-trigger-line\n");
    readLogTail(65536);

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toContain("OLD-GENERATION");

    process.stdout.write("NEW-GENERATION line\n");
    flushLogWriter();

    // A tail request larger than the fresh current file spans the rotation:
    // rotated content is stitched BEFORE current content.
    const stitched = readLogTail(1024 * 1024);
    expect(stitched).toContain("OLD-GENERATION");
    expect(stitched).toContain("NEW-GENERATION");
    expect(stitched.indexOf("OLD-GENERATION")).toBeLessThan(
      stitched.indexOf("NEW-GENERATION"),
    );
  });

  it("clamps readLogTail to the 4MB absolute maximum", () => {
    initLogWriter({ rootDir: tmpDir, maxBytes: 32 * 1024 * 1024 });
    const logPath = getLogPath();
    fs.writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024, 0x61));

    const text = readLogTail(999_999_999_999);

    expect(text.length).toBe(4 * 1024 * 1024);
  });

  it("flushLogWriter appends synchronously, bounded to the last 1000 lines", () => {
    initLogWriter({ rootDir: tmpDir, maxBytes: 32 * 1024 * 1024 });

    for (let i = 0; i < 1005; i += 1) {
      process.stdout.write(`exit-line-${i}\n`);
    }
    // The exit-path flush: synchronous, no timers involved.
    flushLogWriter();

    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content).toContain("exit-line-1004\n");
    expect(content).toContain("exit-line-5\n");
    // The first 5 lines fell outside the bounded exit flush.
    expect(content).not.toContain("exit-line-0\n");
    expect(content).not.toContain("exit-line-4\n");
  });

  it("degrades on stream errors (drop + one raw-stderr warning), then recovers on reopen", async () => {
    const realCreateWriteStream = fs.createWriteStream;
    const streams = [];
    const createStreamSpy = vi
      .spyOn(fs, "createWriteStream")
      .mockImplementation((...args) => {
        const stream = realCreateWriteStream(...args);
        streams.push(stream);
        return stream;
      });
    // Spy on raw stderr BEFORE init so the writer's saved rawStderrWrite is
    // this spy; degradation warnings must arrive here, not in the log.
    const stderrChunks = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    initLogWriter({ rootDir: tmpDir, maxBytes: 1024 * 1024 });
    const logPath = getLogPath();
    expect(streams).toHaveLength(1);

    // ENOSPC-style stream failure → disabled state + rate-limited warning.
    streams[0].destroy(new Error("ENOSPC: no space left on device"));
    await vi.waitFor(() => {
      expect(stderrChunks.join("")).toContain(
        "log writer degraded: ENOSPC: no space left on device",
      );
    });

    // While the reopen also fails, queued lines are DROPPED (never block) and
    // the repeat warning is rate-limited to one within the window.
    createStreamSpy.mockImplementationOnce(() => {
      throw new Error("EACCES: reopen denied");
    });
    process.stdout.write("dropped-while-degraded\n");
    const degradedTail = readLogTail(65536);
    expect(degradedTail).not.toContain("dropped-while-degraded");
    const degradedWarnings = stderrChunks.filter((chunk) =>
      chunk.includes("log writer degraded"),
    );
    expect(degradedWarnings).toHaveLength(1);

    // Past the 30s retry window the reopen succeeds and logging resumes.
    vi.setSystemTime(Date.now() + 31_000);
    process.stdout.write("post-recovery-line\n");
    readLogTail(65536);
    await vi.waitFor(() => {
      expect(fs.readFileSync(logPath, "utf8")).toContain("post-recovery-line");
    });

    // No recursion: the degradation warning went through the SAVED raw stderr
    // and never re-entered the patched writer / the log file.
    expect(fs.readFileSync(logPath, "utf8")).not.toContain(
      "log writer degraded",
    );
  });

  it("truncates a single pathological ~100KB line to the 64KB per-entry cap", () => {
    initLogWriter({ rootDir: tmpDir, maxBytes: 32 * 1024 * 1024 });

    // One 100KB line: the per-entry byte bound (64KB + "[truncated]\n")
    // must apply — a multi-MB line cannot bypass the line-count caps.
    process.stdout.write(`${"B".repeat(100 * 1024)}\n`);
    flushLogWriter();

    const content = fs.readFileSync(getLogPath(), "utf8");
    expect(content.endsWith("[truncated]\n")).toBe(true);
    // Entry = 24-char ISO timestamp + " " + line, sliced to 64KB, plus marker.
    expect(content.length).toBe(64 * 1024 + "[truncated]\n".length);
    expect(content).toContain("B".repeat(1000));
  });

  it("drops the queued window with a warning when the stream is backpressured", () => {
    // A stream whose internal buffer already reports past the 4MB cap (disk
    // stalled): the flush must DROP the window — never write, never grow the
    // buffer without bound.
    const fakeStream = {
      writableLength: 4 * 1024 * 1024 + 1,
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    vi.spyOn(fs, "createWriteStream").mockReturnValue(fakeStream);
    // Spy on raw stderr BEFORE init so the writer's saved rawStderrWrite is
    // this spy — the backpressure warning must arrive here, not in the log.
    const stderrChunks = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    initLogWriter({ rootDir: tmpDir, maxBytes: 32 * 1024 * 1024 });

    process.stdout.write("dropped-under-backpressure\n");
    // readLogTail flushes the queue first — that flush hits the guard.
    const tail = readLogTail(65536);

    expect(fakeStream.write).not.toHaveBeenCalled();
    expect(stderrChunks.join("")).toContain(
      "log stream backpressured — dropping buffered lines",
    );
    expect(tail).not.toContain("dropped-under-backpressure");
    // The window is gone, not deferred: a later sync flush has nothing left.
    flushLogWriter();
    expect(fs.readFileSync(getLogPath(), "utf8")).not.toContain(
      "dropped-under-backpressure",
    );
  });
});
