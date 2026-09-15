// A repair owns mutation authority and the cleanup of every writer it starts.
// Cancellation invalidates authority immediately; cleanup still drains writers
// and their restore guards before the lifecycle lock can admit a successor.
const kRepairCleanupAllowanceMs = 15_000;
// A repair may already be timing out when shutdown begins. Reap its writers
// well inside the server's 10s drain even when the first abort was not shutdown.
const kRepairKillGraceMs = 1000;

const cancellationError = (signal) => {
  const error = new Error(signal?.reason === "deadline" ? "operation run budget exhausted" : "operation cancelled");
  error.name = "AbortError";
  error.code = signal?.reason === "deadline" ? "operation_timed_out" : "operation_cancelled";
  return error;
};

// Read-only work may ignore AbortSignal. Detach its result on cancellation;
// callers still check authority before each subsequent mutation.
const waitForSignal = (work, signal) => {
  if (signal?.aborted) return Promise.reject(cancellationError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancellationError(signal));
    signal?.addEventListener("abort", abort, { once: true });
    let result;
    try { result = work(); } catch (error) {
      signal?.removeEventListener("abort", abort);
      reject(error);
      return;
    }
    Promise.resolve(result).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
};

const createRepairOperation = ({ isCurrent = () => true, now = Date.now, signal = null } = {}) => {
  const controller = new AbortController();
  const writers = new Set();
  const processes = new Map();
  let deadlineAt = Infinity;
  let timer = null;
  let sealed = false;
  const cancel = (reason = "cancelled") => {
    clearTimeout(timer);
    controller.abort(reason);
  };
  const onAbort = () => cancel(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const assertActive = () => {
    if (!isCurrent() || sealed) cancel("superseded");
    if (now() >= deadlineAt) cancel("deadline");
    if (controller.signal.aborted) throw cancellationError(controller.signal);
  };
  const start = (budgetMs, absoluteDeadline = Infinity) => {
    clearTimeout(timer);
    deadlineAt = Math.min(now() + budgetMs, absoluteDeadline);
    if (deadlineAt <= now()) cancel("deadline");
    else if (Number.isFinite(deadlineAt)) {
      timer = setTimeout(() => cancel("deadline"), deadlineAt - now());
      timer.unref?.();
    }
  };
  const runWriter = (work) => {
    assertActive();
    // Register synchronously, before work can quarantine or write anything.
    let resolveWriter;
    const cleanup = new Promise((resolve) => { resolveWriter = resolve; });
    writers.add(cleanup);
    return Promise.resolve().then(() => {
      assertActive();
      return work();
    }).finally(() => {
      writers.delete(cleanup);
      resolveWriter();
    });
  };
  const wait = async () => {
    sealed = true;
    clearTimeout(timer);
    while (writers.size) await Promise.allSettled([...writers]);
    signal?.removeEventListener("abort", onAbort);
  };
  const finishWork = () => { sealed = true; clearTimeout(timer); };
  const noteProcess = (info) => {
    if (info?.pid == null) return;
    if (info.phase === "cleaned") processes.delete(info.pid);
    else processes.set(info.pid, { pid: info.pid, phase: info.phase });
  };
  return {
    signal: controller.signal,
    get deadlineAt() { return deadlineAt; },
    start, cancel, assertActive, runWriter, noteProcess, finishWork,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    read: (work) => { assertActive(); return waitForSignal(work, controller.signal); },
    cleanup: { cancel, wait, describe: () => ({ processes: [...processes.values()] }) },
  };
};

module.exports = { createRepairOperation, cancellationError, waitForSignal,
  kRepairCleanupAllowanceMs, kRepairKillGraceMs };
