const fs = require("fs");
const path = require("path");
const { tailBytes } = require("./utils/tail-bytes");

// Buffered, non-blocking process log.
//
//   stdout/stderr line ──▶ in-memory queue (capped, drop-oldest)
//                              │  ~250ms flush tick
//                              ▼
//                    persistent append stream ──▶ process.log
//                              │ size cap reached
//                              ▼
//              rotate: close ─▶ rename to .1 ─▶ reopen fresh
//
// The old writer did fs.appendFileSync PER LINE on the event loop (every
// gateway log line = a sync disk write) and truncated in place behind an open
// descriptor. Stream errors (ENOSPC/EIO) enter a `disabled` state — drop
// lines, warn once via the SAVED raw stderr (never re-enter the patched
// writer), retry a reopen every 30s. Logging degrades; serving never does.

const kFlushIntervalMs = 250;
const kMaxQueuedLines = 5000;
const kMaxQueuedBytes = 2 * 1024 * 1024;
const kMaxStreamBufferedBytes = 4 * 1024 * 1024;
const kReopenRetryMs = 30000;
const kSizeCheckMinIntervalMs = 2000;
const kExitFlushMaxLines = 1000;

const state = {
  logPath: "",
  rotatedPath: "",
  maxBytes: 2 * 1024 * 1024,
  queue: [],
  queuedBytes: 0,
  droppedLines: 0,
  stream: null,
  flushTimer: null,
  disabled: false,
  lastReopenAttemptAt: 0,
  lastSizeCheckAt: 0,
  lastErrorWarnAt: 0,
  rawStderrWrite: null,
  exitHookInstalled: false,
};

const warnRaw = (message) => {
  const now = Date.now();
  if (now - state.lastErrorWarnAt < kReopenRetryMs) return;
  state.lastErrorWarnAt = now;
  try {
    // Saved BEFORE the monkey-patch: writing through the patched
    // process.stderr would re-enter this module recursively.
    (state.rawStderrWrite || process.stderr.write.bind(process.stderr))(
      `[alphaclaw] log writer degraded: ${message}\n`,
    );
  } catch {}
};

const disableStream = (reason) => {
  state.disabled = true;
  state.queue = [];
  if (state.stream) {
    try {
      state.stream.destroy();
    } catch {}
    state.stream = null;
  }
  warnRaw(reason);
};

const openStream = () => {
  try {
    const stream = fs.createWriteStream(state.logPath, { flags: "a" });
    stream.on("error", (error) => {
      // A rotated-away or superseded stream can error later (lazy open
      // failing after re-init); it must not disable the CURRENT writer.
      if (state.stream !== stream) return;
      disableStream(error?.message || "stream error");
    });
    state.stream = stream;
    state.disabled = false;
    return true;
  } catch (error) {
    state.stream = null;
    state.disabled = true;
    warnRaw(error?.message || "open failed");
    return false;
  }
};

const maybeReopen = () => {
  const now = Date.now();
  if (now - state.lastReopenAttemptAt < kReopenRetryMs) return false;
  state.lastReopenAttemptAt = now;
  return openStream();
};

const rotateIfNeeded = () => {
  const now = Date.now();
  if (now - state.lastSizeCheckAt < kSizeCheckMinIntervalMs) return;
  state.lastSizeCheckAt = now;
  try {
    const stat = fs.statSync(state.logPath);
    if (stat.size <= state.maxBytes) return;
    // Never truncate behind an open descriptor (write loss / sparse files):
    // close, rename the full file aside, reopen fresh.
    if (state.stream) {
      try {
        state.stream.end();
      } catch {}
      state.stream = null;
    }
    fs.renameSync(state.logPath, state.rotatedPath);
    openStream();
  } catch (error) {
    warnRaw(`rotation failed: ${error?.message || error}`);
  }
};

const flushQueue = () => {
  if (state.queue.length === 0) return;
  if (state.disabled || !state.stream) {
    if (!maybeReopen()) {
      state.droppedLines += state.queue.length;
      state.queue = [];
      state.queuedBytes = 0;
      return;
    }
  }
  // Backpressure guard: if the stream's internal buffer is already deep
  // (disk stalled), drop this window's lines instead of growing the buffer
  // without bound. Logging degrades; memory does not.
  if (state.stream.writableLength > kMaxStreamBufferedBytes) {
    state.droppedLines += state.queue.length;
    state.queue = [];
    state.queuedBytes = 0;
    warnRaw("log stream backpressured — dropping buffered lines");
    return;
  }
  const chunk = state.queue.join("");
  state.queue = [];
  state.queuedBytes = 0;
  try {
    state.stream.write(chunk);
  } catch (error) {
    disableStream(error?.message || "write failed");
    return;
  }
  rotateIfNeeded();
};

const scheduleFlush = () => {
  if (state.flushTimer) return;
  state.flushTimer = setInterval(flushQueue, kFlushIntervalMs);
  if (typeof state.flushTimer.unref === "function") state.flushTimer.unref();
};

const appendLine = (line) => {
  if (!state.logPath) return;
  const prefixed = /^\d{4}-\d{2}-\d{2}T/.test(line)
    ? line
    : `${new Date().toISOString()} ${line}`;
  // Byte-bound each entry (one pathological multi-MB line must not bypass
  // the line cap) and cap the queue by line count.
  const rawEntry = prefixed.endsWith("\n") ? prefixed : `${prefixed}\n`;
  const entry =
    rawEntry.length > 64 * 1024 ? `${rawEntry.slice(0, 64 * 1024)}[truncated]\n` : rawEntry;
  state.queue.push(entry);
  state.queuedBytes += entry.length;
  // Aggregate cap (chars ≈ bytes for log text): drop-oldest keeps memory
  // bounded even under a pathological line storm.
  while (
    (state.queue.length > kMaxQueuedLines || state.queuedBytes > kMaxQueuedBytes) &&
    state.queue.length > 1
  ) {
    const removed = state.queue.shift();
    state.queuedBytes -= removed.length;
    state.droppedLines += 1;
  }
  scheduleFlush();
};

// Bounded synchronous final flush — used by the shutdown orchestrator and the
// process exit hook so clean exits do not lose the last buffered lines.
const flushLogWriter = () => {
  if (!state.logPath || state.queue.length === 0) return;
  const lines = state.queue.slice(-kExitFlushMaxLines);
  state.queue = [];
  state.queuedBytes = 0;
  try {
    fs.appendFileSync(state.logPath, lines.join(""));
  } catch {}
};

const initLogWriter = ({ rootDir, maxBytes }) => {
  // Re-init (tests, hot reload): close the previous stream instead of
  // leaking it; never double-wrap stdout/stderr (duplicate capture).
  if (state.stream) {
    try {
      state.stream.destroy();
    } catch {}
    state.stream = null;
  }
  const logsDir = path.join(rootDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  state.logPath = path.join(logsDir, "process.log");
  state.rotatedPath = `${state.logPath}.1`;
  state.maxBytes = Number(maxBytes) > 0 ? Number(maxBytes) : state.maxBytes;
  if (!fs.existsSync(state.logPath)) fs.writeFileSync(state.logPath, "", "utf8");
  state.lastSizeCheckAt = Date.now();

  openStream();
  // Never double-wrap (duplicate capture on re-init) — but DO re-wrap when
  // someone restored the original writers (tests do).
  if (process.stdout.write === state.wrappedStdoutWrite) return;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  state.rawStderrWrite = stderrWrite;

  process.stdout.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      appendLine(line);
    }
    return stdoutWrite(chunk, encoding, cb);
  };
  state.wrappedStdoutWrite = process.stdout.write;

  process.stderr.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      appendLine(line);
    }
    return stderrWrite(chunk, encoding, cb);
  };

  if (!state.exitHookInstalled) {
    state.exitHookInstalled = true;
    process.on("exit", () => {
      try {
        flushLogWriter();
      } catch {}
    });
  }
};

const getLogPath = () => state.logPath;

// Tail across the live file and (when the request spans it) the rotated
// predecessor. Bounded by tailBytes' absolute clamp — an unbounded `tail`
// query param can no longer force a giant synchronous read.
const readLogTail = (requestedBytes = 65536) => {
  if (!state.logPath) return "";
  flushQueue();
  const current = tailBytes(state.logPath, requestedBytes);
  let currentSize = 0;
  try {
    currentSize = fs.statSync(state.logPath).size;
  } catch {}
  const requested = Number.parseInt(String(requestedBytes || 65536), 10) || 65536;
  const remaining = requested - currentSize;
  if (remaining <= 0 || !fs.existsSync(state.rotatedPath)) return current.text;
  const rotated = tailBytes(state.rotatedPath, remaining);
  return rotated.text + current.text;
};

// Test hook: reset module state between tests.
const __resetLogWriterForTests = () => {
  if (state.flushTimer) clearInterval(state.flushTimer);
  if (state.stream) {
    try {
      state.stream.destroy();
    } catch {}
  }
  Object.assign(state, {
    logPath: "",
    rotatedPath: "",
    queue: [],
    droppedLines: 0,
    stream: null,
    flushTimer: null,
    disabled: false,
    lastReopenAttemptAt: 0,
    lastSizeCheckAt: 0,
    lastErrorWarnAt: 0,
  });
};

module.exports = {
  initLogWriter,
  getLogPath,
  readLogTail,
  flushLogWriter,
  __resetLogWriterForTests,
};
