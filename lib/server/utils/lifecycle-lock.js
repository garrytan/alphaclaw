// Single-flight lock for gateway lifecycle operations.
//
//   caller A ── run("restart", fn) ──▶ fn() executing
//   caller B ── run("restart", fn) ──▶ JOINS A's promise (same op → no dup)
//   caller C ── run("channel-sync", fn) ─▶ QUEUES (different op → FIFO)
//   shutdown ── cancel() ──▶ aborts current signal, drops the queue
//
// Why: execSync used to serialize concurrent restarts/env-saves by accident
// (it froze the whole event loop). Going async removes that guarantee — this
// lock restores it explicitly. State transitions happen only while an op
// holds the lock; child-exit events set flags consumed by the next op.
const createLifecycleLock = () => {
  const state = {
    current: null, // { name, promise, controller }
    queue: [], // [{ name, fn, resolve, reject }]
    cancelled: false,
  };

  const startNext = () => {
    if (state.current || state.queue.length === 0) return;
    const next = state.queue.shift();
    const controller = new AbortController();
    // ORDER MATTERS: clear `current` BEFORE resolving this op's callers — a
    // same-named run() issued right after `await lock.run(...)` must start a
    // fresh execution, not JOIN the already-completed op. startNext() runs
    // after resolve() so awaiting callers (microtask queued first) resume
    // before the next queued op's fn begins.
    const promise = Promise.resolve()
      .then(() => next.fn({ signal: controller.signal }))
      .then(
        (value) => {
          state.current = null;
          next.resolve(value);
          startNext();
          return value;
        },
        (error) => {
          state.current = null;
          next.reject(error);
          startNext();
          throw error;
        },
      );
    // In-flight joiners consume `promise` too — swallow its rejection here so
    // an op that fails with zero joiners doesn't surface as unhandled.
    promise.catch(() => {});
    state.current = { name: next.name, promise, controller };
  };

  const run = (name, fn) => {
    if (state.cancelled) {
      return Promise.reject(
        new Error("Lifecycle operation rejected (shutting down)"),
      );
    }
    // JOIN: a request for the op already in flight gets the same promise —
    // NOTE: relative resume order of joiners vs the next queued op's start is
    // unspecified (ops themselves never interleave; only awaiter wake order
    // differs between in-flight and queued joins).
    // double-clicking "Restart gateway" coalesces into one restart. Joiners
    // receive the op's RESULT (e.g. the launched child), same as queued
    // joiners — callers must not be able to tell which kind of join they got.
    if (state.current && state.current.name === name) {
      return state.current.promise;
    }
    const queued = state.queue.find((entry) => entry.name === name);
    if (queued) return queued.promiseForJoin;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    state.queue.push({ name, fn, resolve, reject, promiseForJoin: promise });
    startNext();
    return promise;
  };

  // Shutdown: abort the in-flight op's signal (ops kill their CLI child on
  // abort) and drop everything queued. Returns the in-flight promise so the
  // caller can await its termination, bounded by its own deadline.
  const cancel = () => {
    state.cancelled = true;
    for (const entry of state.queue) {
      entry.reject(new Error("Lifecycle operation cancelled (shutdown)"));
    }
    state.queue = [];
    if (state.current) {
      try {
        state.current.controller.abort();
      } catch {}
      return state.current.promise.catch(() => {});
    }
    return Promise.resolve();
  };

  const isBusy = () => !!state.current || state.queue.length > 0;
  const currentOpName = () => state.current?.name || null;

  return { run, cancel, isBusy, currentOpName };
};

module.exports = { createLifecycleLock };
