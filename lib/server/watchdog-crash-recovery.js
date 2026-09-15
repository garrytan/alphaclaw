// A crash remains a recovery obligation while another lifecycle owner is busy.
// This coordinator never queues on the lifecycle lock: one cancellable delay
// retries admission, and every continuation belongs to the current record.
const { waitForSignal } = require("./repair-operation");
const kRecoveryDiscoveryTimeoutMs = 30_000;

// Discovery can ignore abort, but it cannot keep a crashed gateway's dispatch
// slot forever. Only read-only seams use this detached-result boundary.
const readRecoveryDiscovery = async (work, { signal = null, deadlineAt = Infinity } = {}) => {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const remainingMs = Math.min(kRecoveryDiscoveryTimeoutMs, deadlineAt - Date.now());
  let timer;
  if (remainingMs <= 0) controller.abort("deadline");
  else {
    timer = setTimeout(() => controller.abort("deadline"), remainingMs);
    timer.unref?.();
  }
  try { return await waitForSignal(work, controller.signal); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

const waitForRecovery = (ms, { signal } = {}) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  timer.unref?.();
  signal?.addEventListener("abort", finish, { once: true });
});

const createCrashRecovery = ({
  getServingSeq,
  readAdmission,
  attempt,
  initialWait = waitForRecovery,
  onChange = () => {},
  now = Date.now,
}) => {
  let current = null;
  let inFlight = null;
  const isCurrent = (record) => current === record &&
    getServingSeq() === record.servingSeq;
  const cancel = (reason = "superseded") => {
    const record = current;
    if (!record) return;
    current = null;
    record.delay?.abort();
    record.controller.abort(reason);
    onChange(null, { record, reason });
  };
  const describe = () => current ? {
    source: current.source,
    correlationId: current.correlationId,
    createdAt: new Date(current.createdAt).toISOString(),
    retryCount: current.retryCount,
    reason: current.reason,
    nextAttemptAt: current.dueAt == null ? null : new Date(current.dueAt).toISOString(),
    managed: current.managed,
  } : null;
  const publish = (record) => {
    if (isCurrent(record)) onChange(describe(), { record });
  };
  const schedule = (record, delayMs, reason, initial = false) => {
    if (!isCurrent(record)) return Promise.resolve();
    record.delay?.abort();
    const controller = new AbortController();
    record.delay = controller;
    record.dueAt = now() + delayMs;
    record.reason = reason;
    publish(record);
    return (initial ? initialWait : waitForRecovery)(delayMs, {
      signal: controller.signal, managed: record.managed,
    })
      .then(() => {
        if (controller.signal.aborted || !isCurrent(record)) return;
        record.delay = null;
        record.dueAt = null;
        return run(record);
      });
  };
  const retry = (record, reason) => {
    if (!isCurrent(record)) return;
    record.retryCount += 1;
    const delayMs = record.managed ? 10_000 : Math.min(30_000, 1000 * 2 ** Math.min(record.retryCount - 1, 5));
    // Do not join the retry promise: callers finish once admission has been
    // tried, while this record retains responsibility for a later attempt.
    void schedule(record, delayMs, reason);
  };
  const run = async (record) => {
    if (!isCurrent(record)) return;
    const admission = readAdmission(record);
    if (admission?.cancel) return cancel(admission.cancel);
    if (inFlight || admission?.defer) {
      retry(record, admission?.defer || "operation_in_progress");
      return;
    }
    inFlight = record;
    record.reason = "dispatching";
    publish(record);
    try {
      const result = await attempt(record, () => isCurrent(record));
      if (!isCurrent(record)) return;
      if (result?.retry) retry(record, result.retry);
      else cancel(result?.reason || "dispatched");
    } catch {
      // Unexpected admission/dispatch failures retain bounded recovery too.
      retry(record, "dispatch_failed");
    } finally {
      if (inFlight === record) inFlight = null;
    }
  };
  const request = ({ source, correlationId, managed = false, delayMs = 0,
    recentCrashes = 0, handoff = false }) => {
    const servingSeq = getServingSeq();
    if (current && current.servingSeq === servingSeq && current.source === source &&
      (current.correlationId === correlationId || source === "state_writer_conflict")) {
      return Promise.resolve();
    }
    cancel("superseded");
    const controller = new AbortController();
    const record = { source, correlationId, managed, handoff, recentCrashes,
      controller, signal: controller.signal,
      servingSeq, createdAt: now(), retryCount: 0, reason: "pending",
      dueAt: null, delay: null };
    current = record;
    return delayMs > 0
      ? schedule(record, delayMs, "crash_backoff", true)
      : run(record);
  };
  return { request, cancel, describe };
};

module.exports = { createCrashRecovery, waitForRecovery, readRecoveryDiscovery };
