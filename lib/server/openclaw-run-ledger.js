const fs = require("fs");
const path = require("path");
const constants = require("./constants");

// Per-operation update run ledger + durable log sink.
//
//   <OPENCLAW_DIR>/.alphaclaw/runs/<operationId>.json   one record per apply
//   <OPENCLAW_DIR>/.alphaclaw/logs/openclaw-update-<operationId>.log
//
// Records are written by exactly one owner (the apply that created them, or
// the boot sync transitioning restart_expected), never merged: the channel
// state file's mutable lastUpdateRun stays as a compatibility pointer, but
// correlation (overseer, notifications, watchdog) goes through operationId.
//
//   RUN STATES
//   running ──▶ failed                 (apply returned an error)
//          ──▶ noop                    (idempotent re-apply)
//          ──▶ restart_expected ──▶ activated          (boot re-activated it)
//          │                     ──▶ activation_failed (boot fell back to pin)
//          └──▶ interrupted            (process died mid-apply)
const kRunsDirName = "runs";
const kLogsDirName = "logs";
const kManagedDirName = ".alphaclaw";
const kRunStates = [
  "running",
  "failed",
  "noop",
  "restart_expected",
  "activated",
  "activation_failed",
  "interrupted",
];

// operationIds come from crypto.randomUUID(); anything else shaped is refused
// before it can reach a filesystem path.
const kOperationIdPattern = /^[0-9a-fA-F-]{8,64}$/;

const isValidOperationId = (value) =>
  typeof value === "string" && kOperationIdPattern.test(value);

// --- redaction ---------------------------------------------------------------

const kSecretShapedKeyPattern = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE|CREDENTIAL)/i;
const kRedactedMarker = "[redacted]";
// Values shorter than this are too likely to collide with ordinary output
// (ports, "true", version numbers) to be safely scrubbed.
const kMinSecretLength = 6;

const collectSecretValues = ({ env = process.env, extraValues = [] } = {}) => {
  const values = new Set();
  for (const [key, value] of Object.entries(env || {})) {
    if (!kSecretShapedKeyPattern.test(key)) continue;
    const trimmed = String(value || "").trim();
    if (trimmed.length >= kMinSecretLength) values.add(trimmed);
  }
  for (const value of extraValues) {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= kMinSecretLength) values.add(trimmed);
  }
  return Array.from(values);
};

// Line-buffered redactor: complete lines are scrubbed and flushed; the
// trailing partial line is held so a secret split across two stream chunks
// still matches. The carry is capped so a pathological no-newline stream
// cannot grow memory without bound (the cap flush is the documented residual
// risk: a secret split exactly at a 64KB no-newline boundary).
const kMaxCarryBytes = 64 * 1024;

const createRedactor = (secretValues = []) => {
  const secrets = [...secretValues].sort((a, b) => b.length - a.length);
  let carry = "";
  const scrub = (text) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(kRedactedMarker);
    }
    return out;
  };
  const push = (chunk) => {
    carry += String(chunk);
    const lastNewline = carry.lastIndexOf("\n");
    let complete = "";
    if (lastNewline >= 0) {
      complete = carry.slice(0, lastNewline + 1);
      carry = carry.slice(lastNewline + 1);
    }
    if (carry.length > kMaxCarryBytes) {
      complete += carry;
      carry = "";
    }
    return complete ? scrub(complete) : "";
  };
  const flush = () => {
    const rest = carry;
    carry = "";
    return rest ? scrub(rest) : "";
  };
  return { push, flush, scrub };
};

// --- ledger ------------------------------------------------------------------

const createRunLedger = ({
  fsModule = fs,
  openclawDir = constants.OPENCLAW_DIR,
  nowFn = Date.now,
  logger = console,
  maxLogBytesPerRun = constants.kOpenclawUpdateLogMaxBytes,
  maxLogBytesTotal = constants.kOpenclawUpdateLogsMaxTotalBytes,
  keepRuns = constants.kOpenclawRunKeepCount,
} = {}) => {
  const managedDir = path.join(openclawDir, kManagedDirName);
  const runsDir = path.join(managedDir, kRunsDirName);
  const logsDir = path.join(managedDir, kLogsDirName);

  const log = (message) => {
    try {
      logger.log?.(`[run-ledger] ${message}`);
    } catch {}
  };

  const runPath = (operationId) => path.join(runsDir, `${operationId}.json`);
  const logPathFor = (operationId) =>
    path.join(logsDir, `openclaw-update-${operationId}.log`);

  const writeJsonAtomic = (filePath, value) => {
    const dir = path.dirname(filePath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.tmp`,
    );
    fsModule.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    try {
      fsModule.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  };

  const normalizeRecord = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!isValidOperationId(raw.operationId)) return null;
    return {
      operationId: raw.operationId,
      target:
        raw.target && typeof raw.target === "object" ? raw.target : null,
      state: kRunStates.includes(raw.state) ? raw.state : "running",
      startedAt: raw.startedAt ?? null,
      finishedAt: raw.finishedAt ?? null,
      ok: typeof raw.ok === "boolean" ? raw.ok : null,
      result:
        raw.result && typeof raw.result === "object" ? raw.result : null,
      steps: Array.isArray(raw.steps) ? raw.steps : [],
      backup:
        raw.backup && typeof raw.backup === "object" ? raw.backup : null,
      overseer:
        raw.overseer && typeof raw.overseer === "object" ? raw.overseer : null,
      hasLog: Boolean(raw.hasLog),
    };
  };

  const readRun = (operationId) => {
    if (!isValidOperationId(operationId)) return null;
    try {
      const raw = JSON.parse(
        fsModule.readFileSync(runPath(operationId), "utf8"),
      );
      return normalizeRecord(raw);
    } catch {
      return null;
    }
  };

  const listRuns = () => {
    let files = [];
    try {
      files = fsModule
        .readdirSync(runsDir)
        .filter((name) => name.endsWith(".json") && !name.startsWith("."));
    } catch {
      return [];
    }
    const runs = [];
    for (const name of files) {
      const record = readRun(name.slice(0, -".json".length));
      if (record) runs.push(record);
    }
    runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return runs;
  };

  const createRun = ({ operationId, target }) => {
    if (!isValidOperationId(operationId)) {
      throw new Error(`invalid operationId: ${operationId}`);
    }
    const record = normalizeRecord({
      operationId,
      target,
      state: "running",
      startedAt: nowFn(),
      finishedAt: null,
      ok: null,
      steps: [],
    });
    writeJsonAtomic(runPath(operationId), record);
    return record;
  };

  const updateRun = (operationId, mutatorFn) => {
    const record = readRun(operationId);
    if (!record) return null;
    const next = normalizeRecord(mutatorFn(record) || record);
    if (!next) return null;
    writeJsonAtomic(runPath(operationId), next);
    return next;
  };

  const completeRun = (operationId, { state, ok, result = null } = {}) =>
    updateRun(operationId, (record) => {
      record.state = kRunStates.includes(state) ? state : "failed";
      record.finishedAt = nowFn();
      record.ok = Boolean(ok);
      record.result = result;
      return record;
    });

  // Boot transition: a run left in restart_expected resolves by whether the
  // boot sync actually activated its target.
  const resolveRestartExpected = ({ activated, detail = null } = {}) => {
    const pending = listRuns().find((run) => run.state === "restart_expected");
    if (!pending) return null;
    return updateRun(pending.operationId, (record) => {
      record.state = activated ? "activated" : "activation_failed";
      record.ok = Boolean(activated);
      record.result = activated
        ? { ok: true }
        : {
            ok: false,
            code: "activation_failed",
            message:
              detail ||
              "The update recorded successfully but did not activate at boot.",
            hint: "AlphaClaw fell back to a safe version. Open the Upgrade page to retry.",
            docsUrl: null,
          };
      return record;
    });
  };

  // Boot transition: any run still "running" when a boot sync executes was
  // interrupted by a process death — boot is single-process, nothing can
  // still be running it.
  const closeInterruptedRuns = () => {
    const closed = [];
    for (const run of listRuns()) {
      if (run.state !== "running") continue;
      const next = completeRun(run.operationId, {
        state: "interrupted",
        ok: false,
        result: {
          ok: false,
          code: "interrupted",
          message: "AlphaClaw restarted before the update finished.",
          hint: "Nothing was activated. Start the update again from the Upgrade page.",
          docsUrl: null,
        },
      });
      if (next) closed.push(next);
    }
    return closed;
  };

  const totalLogBytes = () => {
    let total = 0;
    try {
      for (const name of fsModule.readdirSync(logsDir)) {
        try {
          total += fsModule.statSync(path.join(logsDir, name)).size;
        } catch {}
      }
    } catch {}
    return total;
  };

  const pruneRuns = ({ keep = keepRuns } = {}) => {
    const runs = listRuns();
    const stale = runs.slice(Math.max(1, keep));
    for (const run of stale) {
      try {
        fsModule.rmSync(runPath(run.operationId), { force: true });
      } catch {}
      try {
        fsModule.rmSync(logPathFor(run.operationId), { force: true });
      } catch {}
    }
    // Total-bytes backstop: even inside the keep window, logs must never
    // grow past the cap (dev builds can emit hundreds of MB). Oldest first.
    let total = totalLogBytes();
    if (total > maxLogBytesTotal) {
      const oldestFirst = listRuns().slice().reverse();
      for (const run of oldestFirst) {
        if (total <= maxLogBytesTotal) break;
        try {
          const size = fsModule.statSync(logPathFor(run.operationId)).size;
          fsModule.rmSync(logPathFor(run.operationId), { force: true });
          total -= size;
        } catch {}
      }
    }
    return stale.length;
  };

  // Operation-owned bounded sink: one open append stream for the whole apply
  // (steps + child stdout/stderr share it), line-buffered redaction, hard
  // per-run byte cap with a single truncation marker. Every write is
  // fail-open — a log failure must never fail the apply.
  const createLogSink = ({ operationId, extraSecretValues = [] } = {}) => {
    if (!isValidOperationId(operationId)) {
      return {
        write() {},
        writeLine() {},
        close: async () => {},
        filePath: null,
        failed: true,
      };
    }
    const filePath = logPathFor(operationId);
    const redactor = createRedactor(
      collectSecretValues({ extraValues: extraSecretValues }),
    );
    let stream = null;
    let failed = false;
    let bytesWritten = 0;
    let truncated = false;
    try {
      fsModule.mkdirSync(logsDir, { recursive: true });
      stream = fsModule.createWriteStream(filePath, { flags: "a" });
      stream.on("error", () => {
        failed = true;
      });
      updateRun(operationId, (record) => {
        record.hasLog = true;
        return record;
      });
    } catch (error) {
      failed = true;
      log(`log sink unavailable for ${operationId}: ${error.message}`);
    }
    const rawWrite = (text) => {
      if (!stream || failed || !text) return;
      if (truncated) return;
      if (bytesWritten + Buffer.byteLength(text) > maxLogBytesPerRun) {
        truncated = true;
        try {
          stream.write(
            `\n[log truncated: exceeded ${Math.round(maxLogBytesPerRun / 1e6)}MB cap]\n`,
          );
        } catch {}
        return;
      }
      bytesWritten += Buffer.byteLength(text);
      try {
        stream.write(text);
      } catch {
        failed = true;
      }
    };
    return {
      filePath,
      get failed() {
        return failed;
      },
      get truncated() {
        return truncated;
      },
      write(chunk) {
        rawWrite(redactor.push(chunk));
      },
      writeLine(line) {
        rawWrite(redactor.scrub(`${String(line)}\n`));
      },
      close: () =>
        new Promise((resolve) => {
          rawWrite(redactor.flush());
          if (!stream) return resolve();
          try {
            stream.end(() => resolve());
          } catch {
            resolve();
          }
        }),
    };
  };

  // Containment: log reads resolve ONLY through a validated operationId and
  // must remain regular files inside logsDir (no symlink following).
  const openLogStream = (operationId) => {
    if (!isValidOperationId(operationId)) return null;
    const filePath = logPathFor(operationId);
    try {
      const stat = fsModule.lstatSync(filePath);
      if (!stat.isFile()) return null;
      return {
        stream: fsModule.createReadStream(filePath),
        size: stat.size,
        filePath,
      };
    } catch {
      return null;
    }
  };

  return {
    runsDir,
    logsDir,
    isValidOperationId,
    createRun,
    readRun,
    updateRun,
    completeRun,
    resolveRestartExpected,
    closeInterruptedRuns,
    listRuns,
    pruneRuns,
    createLogSink,
    openLogStream,
  };
};

module.exports = {
  createRunLedger,
  createRedactor,
  collectSecretValues,
  isValidOperationId,
};
