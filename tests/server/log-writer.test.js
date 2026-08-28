const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initLogWriter,
  getLogPath,
  readLogTail,
  getLogGeneration,
  readLogDelta,
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

  it("readLogDelta advances the offset and returns only new bytes", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    process.stdout.write("delta line one\n");
    await __flushForTests();

    const gen = getLogGeneration();
    const first = readLogDelta({ gen, offset: 0 });
    expect(first.reset).toBe(false);
    expect(first.gen).toBe(gen);
    expect(first.data).toContain("delta line one");
    expect(first.offset).toBe(fs.statSync(getLogPath()).size);

    // No new bytes → empty delta at the same offset.
    const idle = readLogDelta({ gen: first.gen, offset: first.offset });
    expect(idle).toEqual({
      gen: first.gen,
      offset: first.offset,
      data: "",
      reset: false,
    });

    process.stdout.write("delta line two\n");
    await __flushForTests();
    const second = readLogDelta({ gen: first.gen, offset: first.offset });
    expect(second.reset).toBe(false);
    expect(second.data).toContain("delta line two");
    expect(second.data).not.toContain("delta line one");
    expect(second.offset).toBe(first.offset + Buffer.byteLength(second.data));
  });

  it("caps delta reads at maxBytes and resumes from the advanced offset", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    // ~40 x ~115 bytes ≈ 4.6KB — several 1KB (the minimum cap) chunks.
    for (let i = 0; i < 40; i++) {
      process.stdout.write(`cap-${String(i).padStart(2, "0")} ${"x".repeat(80)}\n`);
    }
    await __flushForTests();

    const gen = getLogGeneration();
    let cursor = { gen, offset: 0 };
    let collected = "";
    let chunks = 0;
    for (;;) {
      const delta = readLogDelta({ ...cursor, maxBytes: 1024 });
      expect(delta.reset).toBe(false);
      expect(Buffer.byteLength(delta.data)).toBeLessThanOrEqual(1024);
      if (!delta.data) break;
      collected += delta.data;
      cursor = { gen: delta.gen, offset: delta.offset };
      chunks += 1;
    }
    expect(chunks).toBeGreaterThan(2);
    expect(collected).toBe(fs.readFileSync(getLogPath(), "utf8"));
  });

  it("readLogDelta holds back a multibyte character split by the maxBytes cap", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    // A line already starting with an ISO timestamp is kept verbatim, so byte
    // positions are exact: the 4-byte 🚀 occupies bytes 1023-1026 and the
    // minimum 1024-byte cap cuts it one byte in.
    const head = "2026-01-01T00:00:00.000Z ";
    const line = `${head}${"a".repeat(1023 - head.length)}🚀XTAIL-MARKER 日本語\n`;
    process.stdout.write(line);
    await __flushForTests();
    expect(fs.readFileSync(getLogPath())[1023]).toBe(0xf0); // emoji lead byte at the cap

    const gen = getLogGeneration();
    const first = readLogDelta({ gen, offset: 0, maxBytes: 1024 });
    expect(first.reset).toBe(false);
    // Advances only to the last complete character boundary, never past it.
    expect(first.offset).toBe(1023);
    expect(first.data).toBe(line.slice(0, 1023));

    const second = readLogDelta({ gen: first.gen, offset: first.offset, maxBytes: 1024 });
    expect(second.reset).toBe(false);
    expect(second.offset).toBe(first.offset + Buffer.byteLength(second.data));
    const reassembled = first.data + second.data;
    expect(reassembled).toBe(line);
    expect(reassembled).toContain("🚀XTAIL-MARKER");
    expect(reassembled).not.toContain("�");
  });

  it("readLogDelta reassembles multibyte content byte-for-byte across capped reads", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    // 999 ASCII bytes then a long emoji+CJK body: the first 1024-byte cap
    // lands 25 bytes into the 4-byte-emoji run (25 % 4 !== 0), guaranteeing
    // at least one mid-character split.
    const head = "2026-01-01T00:00:00.000Z ";
    const line = `${head}${"x".repeat(999 - head.length)}${"🔴".repeat(600)}${"日本語ログ".repeat(40)}END\n`;
    process.stdout.write(line);
    await __flushForTests();
    const fileBytes = fs.readFileSync(getLogPath());

    const gen = getLogGeneration();
    let cursor = { gen, offset: 0 };
    let collected = "";
    let sawHoldBack = false;
    for (;;) {
      const delta = readLogDelta({ ...cursor, maxBytes: 1024 });
      expect(delta.reset).toBe(false);
      // The cursor advances by exactly the bytes consumed.
      expect(delta.offset - cursor.offset).toBe(Buffer.byteLength(delta.data));
      expect(delta.data).not.toContain("�");
      if (!delta.data) break;
      const window = Math.min(1024, fileBytes.length - cursor.offset);
      if (Buffer.byteLength(delta.data) < window) sawHoldBack = true;
      collected += delta.data;
      cursor = { gen: delta.gen, offset: delta.offset };
    }
    expect(sawHoldBack).toBe(true);
    expect(Buffer.from(collected, "utf8").equals(fileBytes)).toBe(true);
  });

  it("readLogDelta returns an empty delta without advancing on a partial trailing character", async () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    process.stdout.write("prefix line\n");
    await __flushForTests();
    const gen = getLogGeneration();
    const base = readLogDelta({ gen, offset: 0 });
    expect(base.reset).toBe(false);

    // Simulate an append caught mid-character: only 2 of the emoji's 4 bytes
    // are on disk when the poll lands.
    const emoji = Buffer.from("🚀");
    fs.appendFileSync(getLogPath(), emoji.subarray(0, 2));
    const torn = readLogDelta({ gen: base.gen, offset: base.offset });
    expect(torn).toEqual({ gen: base.gen, offset: base.offset, data: "", reset: false });

    fs.appendFileSync(getLogPath(), emoji.subarray(2));
    const whole = readLogDelta({ gen: torn.gen, offset: torn.offset });
    expect(whole.reset).toBe(false);
    expect(whole.data).toBe("🚀");
    expect(whole.offset).toBe(base.offset + emoji.length);
  });

  it("rotation bumps the generation and stale cursors reset with a fresh tail", async () => {
    const maxBytes = 4096;
    initLogWriter({ rootDir, maxBytes });
    process.stdout.write("pre-rotation line\n");
    await __flushForTests();
    const genBefore = getLogGeneration();
    const cursorBefore = readLogDelta({ gen: genBefore, offset: 0 });

    // Same recipe as the rotation test above: one oversized batch → one rotate.
    for (let i = 0; i < 30; i++) {
      process.stdout.write(`rotgen-${String(i).padStart(3, "0")} ${"y".repeat(150)}\n`);
    }
    await __flushForTests();

    expect(getLogGeneration()).toBe(genBefore + 1);
    const stale = readLogDelta({ gen: genBefore, offset: cursorBefore.offset });
    expect(stale.reset).toBe(true);
    expect(stale.gen).toBe(getLogGeneration());
    expect(stale.offset).toBe(fs.statSync(getLogPath()).size);
    expect(stale.data).toContain("rotgen-029");
    expect(stale.data).not.toContain("rotgen-000");

    // An offset beyond the file also resets, even with the current gen.
    const overshoot = readLogDelta({
      gen: getLogGeneration(),
      offset: fs.statSync(getLogPath()).size + 1,
    });
    expect(overshoot.reset).toBe(true);
    expect(overshoot.offset).toBe(fs.statSync(getLogPath()).size);
  });

  it("re-init advances the public log generation and epoch-seeds it", () => {
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    const gen = getLogGeneration();
    // Epoch seeding: a fresh process can never collide with a cursor issued
    // by a previous one (generations are wall-clock-scale, not small ints).
    expect(gen).toBeGreaterThanOrEqual(1_000_000_000_000);
    initLogWriter({ rootDir, maxBytes: 1024 * 1024 });
    expect(getLogGeneration()).toBeGreaterThan(gen);
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
