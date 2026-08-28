const fs = require("fs");
const path = require("path");
const { kTailAbsoluteMaxBytes } = require("./utils/tail-bytes");

// Async batched log writer. The patched stdout/stderr hot path only queues
// strings in memory; a single drain loop persists them with async writes on
// one long-lived append fd (raw fd, not a stream, so the exit flush below is
// exact — no hidden internal buffer).
const kLogWriterQueueMaxBytes = 4 * 1024 * 1024;
// Per-entry byte bound (upstream): one pathological multi-MB line must not
// monopolize the queue or bloat the log past the rotation churn.
const kMaxEntryBytes = 64 * 1024;
const kSizeCheckEveryLines = 25;
const kSizeCheckMinIntervalMs = 2000;
const kWriteRetryIntervalMs = 5000;
const kDefaultMaxBytes = 2 * 1024 * 1024;

let fsImpl = fs;
let logPath = "";
let maxBytesLimit = kDefaultMaxBytes;
let retryIntervalMs = kWriteRetryIntervalMs;

let fd = null;
let queue = [];
let queuedBytes = 0;
let droppedLines = 0;
let dropReason = "queue overflow";
let approxSize = 0;

let activeDrain = null;
let drainScheduled = false;
// Batch handed to an async write whose callback has not fired yet. The exit
// flush rewrites it if the process dies mid-write: for a forensic crash log a
// rare duplicated batch beats losing the final lines.
let inFlightBuffer = null;

let writesDisabled = false;
let lastFailureAtMs = 0;
let retryInFlight = false;

let sizeCheckDue = false;
let linesSinceSizeCheck = 0;
let lastSizeCheckAtMs = 0;

// Re-entrancy guard: the writer's own console.error calls flow through the
// patched stderr and must not recurse into appendLine.
let inInternalLog = false;

let exitHookRegistered = false;
// Bumped on every initLogWriter; stale async drains/rotations/retries from a
// previous init (tests re-init) check it and abandon their work.
let generation = 0;
// Public cursor generation for delta readers: bumps whenever byte offsets in
// the log file stop being comparable (rotation rewrite, re-init). Distinct
// from `generation`, which only guards internal async work.
let logGeneration = 0;

const fsCall = (method, ...args) =>
  new Promise((resolve, reject) => {
    fsImpl[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });

const writeAll = async (targetFd, buf) => {
  let offset = 0;
  while (offset < buf.length) {
    const written = await fsCall("write", targetFd, buf, offset, buf.length - offset, null);
    offset += written;
  }
};

const internalLog = (msg) => {
  if (inInternalLog) return;
  inInternalLog = true;
  try {
    console.error(msg);
  } finally {
    inInternalLog = false;
  }
};

const handleWriteFailure = (err) => {
  writesDisabled = true;
  lastFailureAtMs = Date.now();
  dropReason = "write failure";
  droppedLines += queue.length;
  queue = [];
  queuedBytes = 0;
  const oldFd = fd;
  fd = null;
  if (oldFd !== null) {
    try {
      fsImpl.closeSync(oldFd);
    } catch {
      /* fd already dead */
    }
  }
  internalLog(`[alphaclaw] log-writer error, file logging paused: ${err.message}`);
};

const enqueueDroppedMarker = () => {
  const n = droppedLines;
  droppedLines = 0;
  const line = `${new Date().toISOString()} [alphaclaw] log-writer dropped ${n} lines (${dropReason})\n`;
  queue.unshift(line);
  queuedBytes += Buffer.byteLength(line);
};

const maybeRetryAfterFailure = () => {
  if (retryInFlight) return;
  if (Date.now() - lastFailureAtMs < retryIntervalMs) return;
  lastFailureAtMs = Date.now();
  retryInFlight = true;
  const gen = generation;
  fsImpl.open(logPath, "a", (err, newFd) => {
    retryInFlight = false;
    if (generation !== gen) {
      if (!err) {
        try {
          fsImpl.closeSync(newFd);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (err) {
      lastFailureAtMs = Date.now();
      return;
    }
    fd = newFd;
    writesDisabled = false;
    try {
      approxSize = fsImpl.fstatSync(newFd).size;
    } catch {
      approxSize = 0;
    }
    if (droppedLines > 0) enqueueDroppedMarker();
    scheduleDrain();
  });
};

// Rotation: flush is implicit (called between drain batches), then close the
// fd and rebuild the file via tmp+rename so readLogTail always sees either
// the old or the new complete file, never a torn one.
const rotate = async (gen) => {
  const oldFd = fd;
  fd = null;
  await fsCall("close", oldFd);
  const stat = await fsCall("stat", logPath);
  const keepBytes = Math.floor(maxBytesLimit / 2);
  if (stat.size > maxBytesLimit) {
    const startPos = Math.max(0, stat.size - keepBytes);
    const len = stat.size - startPos;
    const readFd = await fsCall("open", logPath, "r");
    let chunk;
    try {
      const buffer = Buffer.alloc(len);
      const bytesRead = await fsCall("read", readFd, buffer, 0, len, startPos);
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fsCall("close", readFd).catch(() => {});
    }
    if (startPos > 0) {
      const firstNewLine = chunk.indexOf("\n");
      if (firstNewLine !== -1) chunk = chunk.slice(firstNewLine + 1);
    }
    const tmpPath = `${logPath}.tmp`;
    await fsCall("writeFile", tmpPath, chunk, "utf8");
    await fsCall("rename", tmpPath, logPath);
    approxSize = Buffer.byteLength(chunk);
    // The rewrite invalidated every byte offset delta readers may hold.
    logGeneration += 1;
  } else {
    // approxSize drifted (e.g. external truncation); just resync.
    approxSize = stat.size;
  }
  const newFd = await fsCall("open", logPath, "a");
  if (generation !== gen) {
    await fsCall("close", newFd).catch(() => {});
    return;
  }
  fd = newFd;
  linesSinceSizeCheck = 0;
  lastSizeCheckAtMs = Date.now();
};

const drainLoop = async (gen) => {
  while (generation === gen && queue.length > 0 && fd !== null && !writesDisabled) {
    const batch = queue;
    queue = [];
    queuedBytes = 0;
    const buf = Buffer.from(batch.join(""), "utf8");
    inFlightBuffer = buf;
    try {
      await writeAll(fd, buf);
    } catch (err) {
      if (generation === gen) {
        droppedLines += batch.length;
        handleWriteFailure(err);
      }
      return;
    } finally {
      inFlightBuffer = null;
    }
    if (generation !== gen) return;
    approxSize += buf.length;
    if (droppedLines > 0) enqueueDroppedMarker();
    if (sizeCheckDue) {
      sizeCheckDue = false;
      if (approxSize > maxBytesLimit) {
        try {
          await rotate(gen);
        } catch (err) {
          // Keep the rotation-failure cause identifiable in the degradation
          // warning (upstream logged rotation failures explicitly).
          if (generation === gen) {
            handleWriteFailure(
              new Error(`rotation failed: ${err?.message || err}`),
            );
          }
          return;
        }
      }
    }
  }
};

// Deferred start so a synchronous burst of writes lands in one batch, and so
// the exit-path sync flush can run before any async write dequeues the lines.
const scheduleDrain = () => {
  if (drainScheduled || activeDrain || writesDisabled || fd === null) return;
  drainScheduled = true;
  const gen = generation;
  setImmediate(() => {
    drainScheduled = false;
    if (generation !== gen || activeDrain || writesDisabled || fd === null) return;
    activeDrain = drainLoop(gen)
      .catch((err) => {
        if (generation === gen) handleWriteFailure(err);
      })
      .finally(() => {
        if (generation !== gen) return;
        activeDrain = null;
        if (queue.length > 0 && !writesDisabled && fd !== null) scheduleDrain();
      });
  });
};

const appendLine = (line) => {
  if (!logPath || inInternalLog) return;
  const prefixed = /^\d{4}-\d{2}-\d{2}T/.test(line)
    ? line
    : `${new Date().toISOString()} ${line}`;
  const rawLine = prefixed.endsWith("\n") ? prefixed : `${prefixed}\n`;
  const finalLine =
    rawLine.length > kMaxEntryBytes
      ? `${rawLine.slice(0, kMaxEntryBytes)}[truncated]\n`
      : rawLine;
  linesSinceSizeCheck += 1;
  const now = Date.now();
  if (
    linesSinceSizeCheck >= kSizeCheckEveryLines ||
    now - lastSizeCheckAtMs >= kSizeCheckMinIntervalMs
  ) {
    linesSinceSizeCheck = 0;
    lastSizeCheckAtMs = now;
    sizeCheckDue = true;
  }
  if (writesDisabled) {
    droppedLines += 1;
    dropReason = "write failure";
    maybeRetryAfterFailure();
    return;
  }
  const lineBytes = Buffer.byteLength(finalLine);
  if (queuedBytes + lineBytes > kLogWriterQueueMaxBytes) {
    droppedLines += 1;
    dropReason = "queue overflow";
    return;
  }
  queue.push(finalLine);
  queuedBytes += lineBytes;
  scheduleDrain();
};

const captureChunk = (chunk) => {
  // The console passthrough must always keep flowing: never throw from here.
  try {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      appendLine(line);
    }
  } catch {
    /* swallow: file logging must never break console output */
  }
};

const patchStream = (stream) => {
  // Marker property so a second initLogWriter never double-wraps (tests
  // restore the original write between inits, prod calls init once).
  if (stream.write.__alphaclawLogWriter) return;
  const originalWrite = stream.write.bind(stream);
  const patched = (chunk, encoding, cb) => {
    captureChunk(chunk);
    return originalWrite(chunk, encoding, cb);
  };
  patched.__alphaclawLogWriter = true;
  stream.write = patched;
};

// Exit handlers must be synchronous; this log is the watchdog's forensic
// record, so flush everything still queued with blocking writes.
const flushSync = () => {
  try {
    if (!logPath || writesDisabled) return;
    if (fd === null) {
      if (queue.length === 0 && inFlightBuffer === null) return;
      fd = fsImpl.openSync(logPath, "a");
    }
    if (inFlightBuffer !== null) {
      fsImpl.writeSync(fd, inFlightBuffer);
      inFlightBuffer = null;
    }
    if (queue.length > 0) {
      const buf = Buffer.from(queue.join(""), "utf8");
      queue = [];
      queuedBytes = 0;
      fsImpl.writeSync(fd, buf);
      approxSize += buf.length;
    }
  } catch {
    /* never throw on the exit path */
  }
};

const initLogWriter = ({ rootDir, maxBytes, _fs, _retryIntervalMs } = {}) => {
  generation += 1;
  // Seed the public cursor generation from wall-clock on (re)init: a browser
  // tab surviving a server restart must never hold a cursor whose generation
  // coincidentally matches the new process's counter — a fresh epoch always
  // invalidates cross-process cursors, while still growing on every re-init.
  logGeneration = Math.max(logGeneration + 1, Date.now());
  const prevFs = fsImpl;
  if (fd !== null) {
    try {
      prevFs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fd = null;
  }
  fsImpl = _fs || fs;
  maxBytesLimit = maxBytes || kDefaultMaxBytes;
  retryIntervalMs = _retryIntervalMs ?? kWriteRetryIntervalMs;

  queue = [];
  queuedBytes = 0;
  droppedLines = 0;
  dropReason = "queue overflow";
  approxSize = 0;
  activeDrain = null;
  drainScheduled = false;
  inFlightBuffer = null;
  writesDisabled = false;
  lastFailureAtMs = 0;
  retryInFlight = false;
  sizeCheckDue = false;
  linesSinceSizeCheck = 0;
  lastSizeCheckAtMs = Date.now();

  const logsDir = path.join(rootDir, "logs");
  logPath = path.join(logsDir, "process.log");
  try {
    fsImpl.mkdirSync(logsDir, { recursive: true });
    fd = fsImpl.openSync(logPath, "a");
    approxSize = fsImpl.fstatSync(fd).size;
  } catch (err) {
    handleWriteFailure(err);
  }

  patchStream(process.stdout);
  patchStream(process.stderr);

  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", flushSync);
  }
};

const getLogPath = () => logPath;

// One clamp policy for every log read (shared with utils/tail-bytes): an
// unbounded `tail`/`maxBytes` query param can never force a giant
// synchronous read.
const clampReadBytes = (requested, fallback = 65536) =>
  Math.min(
    kTailAbsoluteMaxBytes,
    Math.max(1024, Number.parseInt(String(requested || fallback), 10) || fallback),
  );

const readLogTail = (tailBytes = 65536) => {
  if (!logPath || !fsImpl.existsSync(logPath)) return "";
  const stat = fsImpl.statSync(logPath);
  const readBytes = clampReadBytes(tailBytes);
  const startPos = Math.max(0, stat.size - readBytes);
  const len = stat.size - startPos;
  const readFd = fsImpl.openSync(logPath, "r");
  const buffer = Buffer.alloc(len);
  fsImpl.readSync(readFd, buffer, 0, len, startPos);
  fsImpl.closeSync(readFd);
  return buffer.toString("utf8");
};

const getLogGeneration = () => logGeneration;

// Raw byte-range read; decoding is the caller's job so byte counts stay exact.
const readRangeBytes = (startPos, len) => {
  if (len <= 0) return Buffer.alloc(0);
  const readFd = fsImpl.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(len);
    const bytesRead = fsImpl.readSync(readFd, buffer, 0, len, startPos);
    return buffer.subarray(0, bytesRead);
  } finally {
    fsImpl.closeSync(readFd);
  }
};

// Count of bytes at the end of buf forming the prefix of an unfinished
// multibyte UTF-8 character (a lead byte with too few continuation bytes).
// 0 when the buffer ends on a character boundary — or on bytes no suffix
// could ever complete, which must not be held back forever.
const incompleteTrailingUtf8 = (buf) => {
  const end = buf.length;
  // A character is at most 4 bytes, so an incomplete one has its lead byte
  // within the last 3 bytes (a lead 4 bytes back would already be complete).
  for (let i = end - 1; i >= 0 && i >= end - 3; i--) {
    const byte = buf[i];
    if ((byte & 0xc0) === 0x80) continue; // continuation — keep seeking the lead
    let seqLen = 0;
    if ((byte & 0xe0) === 0xc0) seqLen = 2;
    else if ((byte & 0xf0) === 0xe0) seqLen = 3;
    else if ((byte & 0xf8) === 0xf0) seqLen = 4;
    // ASCII (seqLen 0 via the checks above) or an invalid lead: nothing to wait for.
    return i + seqLen > end ? end - i : 0;
  }
  return 0;
};

// Delta reads for log polling: a valid { gen, offset } cursor returns only the
// bytes appended since offset (capped at maxBytes — callers poll again for the
// rest); a stale cursor (rotation bumped gen, or the offset outran the file)
// returns reset:true with a fresh tail, mirroring readLogTail.
const readLogDelta = ({ gen, offset, maxBytes = 65536 } = {}) => {
  const safeMax = clampReadBytes(maxBytes);
  if (!logPath || !fsImpl.existsSync(logPath)) {
    return { gen: logGeneration, offset: 0, data: "", reset: true };
  }
  const size = fsImpl.statSync(logPath).size;
  const callerGen = Number.parseInt(String(gen), 10);
  const callerOffset = Number.parseInt(String(offset), 10);
  const validCursor =
    callerGen === logGeneration &&
    Number.isInteger(callerOffset) &&
    callerOffset >= 0 &&
    callerOffset <= size;
  if (!validCursor) {
    const startPos = Math.max(0, size - safeMax);
    return {
      gen: logGeneration,
      offset: size,
      data: readRangeBytes(startPos, size - startPos).toString("utf8"),
      reset: true,
    };
  }
  // Offsets are raw byte positions and must advance by exactly the bytes
  // consumed. When the window (maxBytes cap, or EOF landing mid-append) ends
  // partway through a multibyte character, hold the torn tail bytes back for
  // the next poll: decoding them now would emit U+FFFD (3 bytes), drifting
  // the cursor and corrupting the reassembled stream. If the whole window is
  // one incomplete prefix, this returns an empty delta without advancing.
  const raw = readRangeBytes(callerOffset, Math.min(size - callerOffset, safeMax));
  const consumed = raw.length - incompleteTrailingUtf8(raw);
  return {
    gen: logGeneration,
    offset: callerOffset + consumed,
    data: raw.toString("utf8", 0, consumed),
    reset: false,
  };
};

// Test hook: settle the async drain (and any rotation running inside it).
const __flushForTests = async () => {
  for (let i = 0; i < 10000; i++) {
    if (activeDrain) {
      await activeDrain;
      continue;
    }
    if (drainScheduled) {
      await new Promise((resolve) => setImmediate(resolve));
      continue;
    }
    if (queue.length > 0 && !writesDisabled && fd !== null) {
      scheduleDrain();
      continue;
    }
    break;
  }
};

module.exports = {
  initLogWriter,
  getLogPath,
  readLogTail,
  getLogGeneration,
  readLogDelta,
  // Bounded synchronous final flush — upstream's shutdown orchestrator and
  // the process exit hook call this name so clean exits do not lose the last
  // buffered lines. Same function the exit hook uses.
  flushLogWriter: flushSync,
  __flushForTests,
  __flushSyncForTests: flushSync,
};
