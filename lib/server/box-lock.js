// Operator box lock (coexistence with other operators' services on one box).
//
// Operators on a shared box serialize disruptive work with one flock(2) lock
// file, taken by a small script (`box-lock.sh run <owner> <step> -- <cmd>`,
// exit 75 when someone else holds it). With ALPHACLAW_BOX_LOCK_PATH set
// (deployment env only), AlphaClaw takes the same lock around its own
// disruptive operations: gateway restarts a person or a channel/team change
// asked for, the watchdog's repair (Doctor + replace) and memory restarts,
// Envars saves, the snapshot-copy sweep and git sync. Unset, nothing changes.
//
// How the lock is held: AlphaClaw opens the lock file for append (O_WRONLY |
// O_APPEND | O_CREAT, like the script's `exec 9>>"$L"`; never truncated,
// never written, never renamed or removed) and hands that fd to a flock(1)
// child as fd 3. flock(2) locks the shared open file description, the child
// exits, and the lock stays with AlphaClaw's fd. Node opens fds close-on-exec,
// so nothing AlphaClaw spawns while it holds the lock (gateway, Doctor, git)
// inherits it, and the kernel drops it when AlphaClaw closes the fd or dies:
// no stale lock is possible. The same pattern backs the git writer lock
// (lib/cli/git-writer-lock.js). AlphaClaw never breaks, steals or waits out
// another holder: a busy lock is waited for up to a bounded time, or refused.
//
// The convention beside the lock (labels only; flock is the only truth):
//   <X>.owner  one JSON line, written to <X>.owner.tmp and renamed: on acquire
//              {"owner","step","started_at","pid","host","by"}, on release
//              {"owner","step","finished_at","rc","by"}
//   <X>.log    append-only: `<UTC> acquire <owner> <step> pid=<pid> by=<by>`
//              and `<UTC> release <owner> <step> rc=<rc> by=<by>`
// (<X> is the lock path without a trailing `.lock`.) Other holders' records
// are parsed tolerantly: unknown keys are ignored and `by` is optional.
//
// No flock binary (util-linux) means every locked operation is REFUSED with
// a clear sentence: the operator opted in to serialization, and running a
// restart or a Doctor under their heavy work without it is exactly what the
// setting exists to stop.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { AsyncLocalStorage } = require("async_hooks");

const kBoxLockBusyExitCode = 75;
const kBoxLockDefaultWaitSeconds = 120;
const kBoxLockMaxWaitSeconds = 900;
const kBoxLockDefaultOwner = "alphaclaw";
const kBoxLockEventType = "box_lock";
const kLogTailBytes = 16 * 1024;
const kRecentLogLines = 10;

const utcStamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// The operator script's sanitizer, applied to every owner, step and by tag
// AlphaClaw writes: any character outside A-Za-z0-9._:@/+- becomes _, cut
// to 80 characters.
const tag = (value, fallback) => String(value ?? "").trim().replace(/[^A-Za-z0-9._:@/+-]/g, "_").slice(0, 80) || fallback;
const siblingPath = (lockPath, suffix) =>
  lockPath.endsWith(".lock") ? `${lockPath.slice(0, -".lock".length)}${suffix}` : `${lockPath}${suffix}`;

const resolveBoxLockConfig = (env = process.env, { logger = console } = {}) => {
  const lockPath = String(env.ALPHACLAW_BOX_LOCK_PATH || "").trim();
  if (!lockPath) return null;
  const rawWait = String(env.ALPHACLAW_BOX_LOCK_WAIT_SECONDS ?? "").trim();
  let waitSeconds = kBoxLockDefaultWaitSeconds;
  if (rawWait) {
    const parsed = /^\d+$/.test(rawWait) ? Number(rawWait) : NaN;
    waitSeconds = Number.isFinite(parsed) ? Math.min(parsed, kBoxLockMaxWaitSeconds) : kBoxLockDefaultWaitSeconds;
    if (waitSeconds !== parsed) {
      logger.warn?.(
        `[alphaclaw] ALPHACLAW_BOX_LOCK_WAIT_SECONDS=${rawWait} ${Number.isFinite(parsed) ? "clamped" : "is not a whole number of seconds — falling back"} to ${waitSeconds}s (valid range 0-${kBoxLockMaxWaitSeconds})`,
      );
    }
  }
  const pathOf = (key, suffix) => String(env[key] || "").trim() || siblingPath(lockPath, suffix);
  const config = {
    lockPath,
    ownerPath: pathOf("ALPHACLAW_BOX_LOCK_OWNER_PATH", ".owner"),
    logPath: pathOf("ALPHACLAW_BOX_LOCK_LOG_PATH", ".log"),
    owner: tag(env.ALPHACLAW_BOX_LOCK_OWNER, kBoxLockDefaultOwner),
    waitMs: waitSeconds * 1000,
    error: null,
  };
  const relative = [config.lockPath, config.ownerPath, config.logPath].filter((value) => !path.isAbsolute(value));
  if (relative.length) {
    config.error = `the box lock paths must be absolute (${relative.join(", ")})`;
    logger.error?.(`[alphaclaw] box lock misconfigured: ${config.error}; every locked operation is refused until it is fixed`);
  }
  return config;
};

// ---- Holder records: the one place that knows the operator's format. ----
const formatAcquireRecord = ({ owner, step, atMs, pid, host, by }) =>
  JSON.stringify({ owner, step, started_at: utcStamp(atMs), pid, host, by });
const formatReleaseRecord = ({ owner, step, atMs, rc, by }) =>
  JSON.stringify({ owner, step, finished_at: utcStamp(atMs), rc, by });
const formatLogLine = ({ event, owner, step, atMs, pid, rc, by }) =>
  `${utcStamp(atMs)} ${event} ${owner} ${step} ${event === "acquire" ? `pid=${pid}` : `rc=${rc}`} by=${by}`;

const parseOwnerRecord = (text) => {
  try {
    const record = JSON.parse(String(text || "").trim().split("\n")[0]);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const str = (value) => (value == null ? null : String(value).slice(0, 200));
    const int = (value) => (Number.isInteger(value) ? value : null);
    return {
      owner: str(record.owner),
      step: str(record.step),
      started_at: str(record.started_at),
      finished_at: str(record.finished_at),
      pid: int(record.pid),
      host: str(record.host),
      rc: int(record.rc),
      by: str(record.by),
    };
  } catch {
    return null;
  }
};

const parseLogLine = (line) => {
  const [at, event, owner, step, ...rest] = String(line || "").trim().split(/\s+/);
  if (!step) return null;
  const fields = {};
  for (const pair of rest) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return {
    at,
    event,
    owner,
    step,
    pid: /^\d+$/.test(fields.pid || "") ? Number(fields.pid) : null,
    rc: /^-?\d+$/.test(fields.rc || "") ? Number(fields.rc) : null,
    by: fields.by || null,
  };
};

// The holder's label for a 409 and the wait status: the owner file's acquire
// record, or null when it names no current holder (a release record, a
// missing or unreadable file, a holder that does not write one).
const holderLabel = (record) => {
  if (!record?.started_at || record.finished_at) return null;
  const { owner, step, started_at, pid, host, by } = record;
  return { owner, step, started_at, pid, host, by };
};

// What a refusal sentence calls each step AlphaClaw takes the lock for.
const kStepPhrases = Object.freeze({
  "gateway-restart": "the gateway restart",
  "doctor-fix": "the repair (Doctor)",
  "envars-write": "saving Envars",
  "sweep-delete": "the cleanup sweep",
  "git-sync": "the git sync",
});
const stepPhrase = (step) => kStepPhrases[step] || step;

const describeHolder = (holder) =>
  holder
    ? `${holder.owner || "another operator"}${holder.step ? ` (${holder.step})` : ""}${holder.started_at ? ` since ${holder.started_at}` : ""}`
    : "another process";

class BoxLockError extends Error {
  constructor(code, message, { holder = null, step = null, waitedMs = 0, hint = null } = {}) {
    super(message);
    this.name = "BoxLockError";
    this.code = code;
    this.statusCode = code === "box_lock_unavailable" ? 503 : 409;
    this.holder = holder;
    this.step = step;
    this.waitedMs = waitedMs;
    this.hint = hint;
  }
}

const isBoxLockError = (error) => error?.name === "BoxLockError";

const boxLockErrorBody = (error) => ({
  ok: false,
  code: error.code,
  error: error.message,
  ...(error.hint ? { hint: error.hint } : {}),
  boxLock: {
    step: error.step,
    waitedSeconds: Math.round((error.waitedMs || 0) / 1000),
    holder: error.holder,
    since: error.holder?.started_at || null,
  },
});

// Route helper: answers the box lock's own refusal and returns true, or
// returns false for any other error.
const sendIfBoxLocked = (res, error) => {
  if (!isBoxLockError(error)) return false;
  res.status(error.statusCode).json(boxLockErrorBody(error));
  return true;
};

// `?boxLockWait=0` asks a human-facing route not to wait for the lock.
const requestBoxLockWaitMs = (req) => (String(req?.query?.boxLockWait ?? "") === "0" ? 0 : undefined);

const createBoxLock = ({
  config = null,
  fsModule = fs,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  flockBin = "flock",
  nowFn = Date.now,
  pid = process.pid,
  hostname = () => os.hostname(),
  logger = console,
  recordEvent = null,
} = {}) => {
  const storage = new AsyncLocalStorage();
  const holds = new Set();
  const waits = new Set();
  const notedKeys = new Set();

  const emitEvent = ({ status, kind, step, by, opId = null, holder = null, dedupeKey = null, extra = {} }) => {
    if (dedupeKey) {
      if (notedKeys.has(dedupeKey)) return;
      notedKeys.add(dedupeKey);
    }
    try {
      const insert = recordEvent || require("./db/watchdog").insertWatchdogEvent;
      insert?.({
        eventType: kBoxLockEventType,
        source: step,
        status,
        details: { kind, step, by, ...(opId ? { opId } : {}), holder, lockPath: config.lockPath, ...extra },
      });
    } catch {}
  };

  const readOwnerRecord = () => {
    try {
      return parseOwnerRecord(fsModule.readFileSync(config.ownerPath, "utf8"));
    } catch {
      return null;
    }
  };

  const readRecentLog = () => {
    try {
      const { size } = fsModule.statSync(config.logPath);
      const length = Math.min(size, kLogTailBytes);
      const fd = fsModule.openSync(config.logPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        fsModule.readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString("utf8").split("\n").filter(Boolean);
        if (length < size) lines.shift();
        return lines.slice(-kRecentLogLines).map(parseLogLine).filter(Boolean);
      } finally {
        fsModule.closeSync(fd);
      }
    } catch {
      return [];
    }
  };

  const writeRecords = ({ ownerRecord, logLine }) => {
    try {
      const tmp = `${config.ownerPath}.tmp`;
      fsModule.writeFileSync(tmp, `${ownerRecord}\n`);
      fsModule.renameSync(tmp, config.ownerPath);
    } catch (error) {
      logger.warn?.(`[alphaclaw] box lock: could not write the owner record ${config.ownerPath}: ${error.code || error.message}`);
    }
    try {
      fsModule.appendFileSync(config.logPath, `${logLine}\n`);
    } catch (error) {
      logger.warn?.(`[alphaclaw] box lock: could not append to ${config.logPath}: ${error.code || error.message}`);
    }
  };

  const flockArgs = (waitMs) =>
    waitMs > 0
      ? ["-x", "-w", String(Math.round(waitMs) / 1000), "-E", String(kBoxLockBusyExitCode), "3"]
      : ["-x", "-n", "-E", String(kBoxLockBusyExitCode), "3"];
  const classifyExit = ({ error, status, stderr }) => {
    if (error) {
      return {
        status: "unavailable",
        detail: error.code === "ENOENT" ? "the flock binary (util-linux) is not installed" : String(error.code || error.message),
      };
    }
    if (status === 0) return { status: "acquired" };
    if (status === kBoxLockBusyExitCode) return { status: "busy" };
    return { status: "unavailable", detail: String(stderr || `flock exited ${status}`).trim().slice(0, 300) };
  };

  const runFlock = ({ fd, waitMs, signal = null }) =>
    new Promise((resolve) => {
      let child = null;
      let settled = false;
      const onAbort = () => {
        try {
          child?.kill("SIGTERM");
        } catch {}
      };
      const settle = (value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        resolve(value);
      };
      try {
        child = spawnImpl(flockBin, flockArgs(waitMs), { stdio: ["ignore", "ignore", "pipe", fd] });
      } catch (error) {
        settle(classifyExit({ error }));
        return;
      }
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk);
      });
      child.on("error", (error) => settle(classifyExit({ error })));
      child.on("close", (status) => {
        if (signal?.aborted && status !== 0) return settle({ status: "aborted" });
        settle(classifyExit({ status, stderr }));
      });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

  const runFlockSync = ({ fd, waitMs }) => {
    const result = spawnSyncImpl(flockBin, flockArgs(waitMs), { stdio: ["ignore", "ignore", "pipe", fd] });
    return classifyExit({ error: result.error, status: result.status, stderr: result.stderr });
  };

  const unavailableError = (step, detail) =>
    new BoxLockError("box_lock_unavailable", `AlphaClaw cannot take the box lock (${detail}), so it did not start ${stepPhrase(step)}.`, {
      step,
      hint: "Install util-linux (flock) and make the lock file openable, or unset ALPHACLAW_BOX_LOCK_PATH.",
    });

  const openLockFd = (step) => {
    if (config.error) throw unavailableError(step, config.error);
    try {
      return fsModule.openSync(config.lockPath, "a");
    } catch (error) {
      throw unavailableError(step, `cannot open ${config.lockPath}: ${error.code || error.message}`);
    }
  };
  const closeFd = (fd) => {
    try {
      fsModule.closeSync(fd);
    } catch {}
  };

  const makeHold = ({ fd, step, by, opId, acquiredAt }) => {
    let released = false;
    const hold = {
      step,
      by,
      opId,
      since: utcStamp(acquiredAt),
      get active() {
        return !released;
      },
      // Records first, then the close: the release record is written while
      // AlphaClaw still holds the lock, so it never overwrites the next
      // holder's acquire record.
      release: (rc = 0) => {
        if (released) return;
        released = true;
        holds.delete(hold);
        const atMs = nowFn();
        const code = Number.isInteger(rc) ? rc : 1;
        writeRecords({
          ownerRecord: formatReleaseRecord({ owner: config.owner, step, atMs, rc: code, by }),
          logLine: formatLogLine({ event: "release", owner: config.owner, step, atMs, rc: code, by }),
        });
        closeFd(fd);
        logger.log?.(`[alphaclaw] box lock released step=${step} rc=${code} heldMs=${atMs - acquiredAt}${opId ? ` op=${String(opId).slice(0, 8)}` : ""}`);
      },
      run: (fn) => storage.run(hold, fn),
    };
    holds.add(hold);
    writeRecords({
      ownerRecord: formatAcquireRecord({ owner: config.owner, step, atMs: acquiredAt, pid, host: hostname(), by }),
      logLine: formatLogLine({ event: "acquire", owner: config.owner, step, atMs: acquiredAt, pid, by }),
    });
    logger.log?.(`[alphaclaw] box lock acquired step=${step} by=${by}${opId ? ` op=${String(opId).slice(0, 8)}` : ""}`);
    return hold;
  };

  const failureError = ({ fd, result, step, by, opId, startedAt, background }) => {
    closeFd(fd);
    const waitedMs = nowFn() - startedAt;
    if (result.status === "aborted") {
      return new BoxLockError("box_lock_aborted", `The wait for the box lock was cancelled before ${stepPhrase(step)} started.`, { step, waitedMs });
    }
    if (result.status === "busy") {
      const holder = holderLabel(readOwnerRecord());
      const error = new BoxLockError(
        "box_locked",
        `The box lock is held by ${describeHolder(holder)}, so AlphaClaw did not start ${stepPhrase(step)}${waitedMs >= 1000 ? ` after waiting ${Math.round(waitedMs / 1000)}s` : ""}.`,
        { step, holder, waitedMs, hint: "Try again once the other operator's work is finished." },
      );
      logger.warn?.(`[alphaclaw] box lock busy step=${step} by=${by}: ${error.message}`);
      emitEvent({
        status: "warning",
        kind: background ? "deferred" : "refused",
        step,
        by,
        opId,
        holder,
        extra: { waitedSeconds: Math.round(waitedMs / 1000) },
        dedupeKey: background ? `deferred:${step}:${holder?.started_at || "unknown"}` : null,
      });
      return error;
    }
    logger.error?.(`[alphaclaw] box lock unavailable step=${step}: ${result.detail}`);
    emitEvent({ status: "failed", kind: "unavailable", step, by, opId, extra: { detail: result.detail }, dedupeKey: `unavailable:${result.detail}` });
    return unavailableError(step, result.detail);
  };

  // Takes the lock or throws a BoxLockError (box_locked | box_lock_unavailable
  // | box_lock_aborted). `waitMs` 0 never waits; `onWait({ holder, waitMs })`
  // fires once when the lock is busy and the wait begins. `background` marks
  // a caller that retries on its next run (its refusal events are deduped).
  const acquire = async ({ step: rawStep, by, waitMs = config.waitMs, onWait = null, signal = null, opId = null, background = false }) => {
    const step = tag(rawStep, "operation");
    const label = tag(by, config.owner);
    const startedAt = nowFn();
    const fd = openLockFd(step);
    let result = await runFlock({ fd, waitMs: 0 });
    if (result.status === "busy" && waitMs > 0 && !signal?.aborted) {
      const holder = holderLabel(readOwnerRecord());
      const wait = { step, by: label, opId, since: utcStamp(startedAt), waitSeconds: Math.round(waitMs / 1000), holder };
      waits.add(wait);
      logger.log?.(`[alphaclaw] box lock: ${step} waits up to ${wait.waitSeconds}s for ${describeHolder(holder)}`);
      emitEvent({ status: "warning", kind: "waiting", step, by: label, opId, holder, extra: { waitSeconds: wait.waitSeconds } });
      try {
        onWait?.({ holder, waitMs });
      } catch {}
      try {
        result = await runFlock({ fd, waitMs, signal });
      } finally {
        waits.delete(wait);
      }
      if (result.status === "acquired") {
        emitEvent({ status: "ok", kind: "acquired_after_wait", step, by: label, opId, holder, extra: { waitedSeconds: Math.round((nowFn() - startedAt) / 1000) } });
      }
    }
    if (result.status !== "acquired") throw failureError({ fd, result, step, by: label, opId, startedAt, background });
    return makeHold({ fd, step, by: label, opId, acquiredAt: nowFn() });
  };

  const acquireSync = ({ step: rawStep, by, waitMs = config.waitMs, opId = null, background = false }) => {
    const step = tag(rawStep, "operation");
    const label = tag(by, config.owner);
    const startedAt = nowFn();
    const fd = openLockFd(step);
    let result = runFlockSync({ fd, waitMs: 0 });
    if (result.status === "busy" && waitMs > 0) {
      const holder = holderLabel(readOwnerRecord());
      logger.log?.(`[alphaclaw] box lock: ${step} waits up to ${Math.round(waitMs / 1000)}s for ${describeHolder(holder)}`);
      emitEvent({ status: "warning", kind: "waiting", step, by: label, opId, holder, extra: { waitSeconds: Math.round(waitMs / 1000) } });
      result = runFlockSync({ fd, waitMs });
    }
    if (result.status !== "acquired") throw failureError({ fd, result, step, by: label, opId, startedAt, background });
    return makeHold({ fd, step, by: label, opId, acquiredAt: nowFn() });
  };

  const heldInContext = () => storage.getStore()?.active === true;

  // Runs fn under the lock: directly when the feature is off or the caller
  // already holds it (a Doctor inside a repair, a restart inside a Retry
  // upgrade); otherwise acquire, run, release with rc 1 when fn throws, else
  // `rcOf(value)` (default 0) for an operation that reports failure in its
  // result.
  const withBoxLock = async ({ rcOf = null, ...options }, fn) => {
    if (!config || heldInContext()) return fn();
    const hold = await acquire(options);
    let rc = 1;
    try {
      const value = await storage.run(hold, fn);
      rc = rcOf ? rcOf(value) : 0;
      return value;
    } finally {
      hold.release(rc);
    }
  };

  // Synchronous skip-if-busy run for short housekeeping (the snapshot sweep):
  // { ran: true, value } or { ran: false, error }, never a wait.
  const tryWithBoxLockSync = (options, fn) => {
    if (!config || heldInContext()) return { ran: true, value: fn() };
    let hold;
    try {
      hold = acquireSync({ ...options, waitMs: 0, background: true });
    } catch (error) {
      if (isBoxLockError(error)) return { ran: false, error };
      throw error;
    }
    let rc = 1;
    try {
      const value = storage.run(hold, fn);
      rc = 0;
      return { ran: true, value };
    } finally {
      hold.release(rc);
    }
  };

  // A caller that never waits asks first, so a deferral costs it nothing:
  // the holder's label (AlphaClaw's own hold, the owner record, or {} when
  // nobody is named) while the lock is busy, else null. A free lock is taken
  // and dropped at once by the probe, with no records.
  const readBusyHolder = async () => {
    if (!config || config.error) return null;
    const own = [...holds][0];
    if (own) return { owner: config.owner, step: own.step, started_at: own.since, pid, by: own.by };
    let fd = null;
    try {
      fd = fsModule.openSync(config.lockPath, "a");
      const probe = await runFlock({ fd, waitMs: 0 });
      return probe.status === "busy" ? holderLabel(readOwnerRecord()) || {} : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeFd(fd);
    }
  };

  // GET status: whether the lock is held (AlphaClaw's own holds and waits,
  // else a non-blocking flock probe, the same test the operator script's
  // `status` runs), the holder's label, AlphaClaw's waits and the log's tail.
  const readStatus = async () => {
    if (!config) return { enabled: false };
    const own = [...holds].map(({ step, by, opId, since }) => ({ step, by, opId, since }));
    let state = "free";
    let detail = null;
    if (own.length || waits.size) {
      state = "held";
    } else if (config.error) {
      state = "unavailable";
      detail = config.error;
    } else {
      let fd = null;
      try {
        fd = fsModule.openSync(config.lockPath, "a");
        const probe = await runFlock({ fd, waitMs: 0 });
        state = probe.status === "acquired" ? "free" : probe.status === "busy" ? "held" : "unavailable";
        detail = probe.detail || null;
      } catch (error) {
        state = "unavailable";
        detail = String(error.code || error.message);
      } finally {
        if (fd !== null) closeFd(fd);
      }
    }
    const last = readOwnerRecord();
    const holder =
      state !== "held"
        ? null
        : own.length
          ? { owner: config.owner, step: own[0].step, started_at: own[0].since, pid, host: hostname(), by: own[0].by }
          : holderLabel(last);
    return {
      enabled: true,
      lockPath: config.lockPath,
      ownerPath: config.ownerPath,
      logPath: config.logPath,
      owner: config.owner,
      waitSeconds: Math.round(config.waitMs / 1000),
      state,
      ...(detail ? { detail } : {}),
      holder,
      heldByAlphaclaw: own,
      waits: [...waits].map((wait) => ({ ...wait })),
      last,
      recent: readRecentLog(),
    };
  };

  return {
    enabled: !!config,
    config,
    acquire,
    acquireSync,
    withBoxLock,
    tryWithBoxLockSync,
    heldInContext,
    readBusyHolder,
    readStatus,
  };
};

// The process's box lock, configured once from the real deployment env
// (ALPHACLAW_BOX_LOCK_* are deployment-only: never honored from .env).
let processBoxLock = null;
const getBoxLock = () => {
  if (!processBoxLock) processBoxLock = createBoxLock({ config: resolveBoxLockConfig(process.env) });
  return processBoxLock;
};
const setBoxLockForTests = (boxLock) => {
  processBoxLock = boxLock;
};

module.exports = {
  kBoxLockBusyExitCode,
  kBoxLockDefaultWaitSeconds,
  kBoxLockMaxWaitSeconds,
  kBoxLockEventType,
  BoxLockError,
  isBoxLockError,
  boxLockErrorBody,
  sendIfBoxLocked,
  requestBoxLockWaitMs,
  describeHolder,
  resolveBoxLockConfig,
  formatAcquireRecord,
  formatReleaseRecord,
  formatLogLine,
  parseOwnerRecord,
  parseLogLine,
  createBoxLock,
  getBoxLock,
  setBoxLockForTests,
};
