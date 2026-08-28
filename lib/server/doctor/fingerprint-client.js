const path = require("path");

const kDefaultRequestTimeoutMs = 10 * 60 * 1000;
const kMaxWorkerRespawns = 3;

// Main-thread client for the fingerprint worker. One reusable worker, one
// request in flight at a time (callers dedupe above this layer); if the worker
// dies it is lazily respawned up to kMaxWorkerRespawns times, after which
// requests reject and callers serve their stale snapshot.
const createFingerprintClient = ({
  workerPath = path.join(__dirname, "fingerprint-worker.js"),
  requestTimeoutMs = kDefaultRequestTimeoutMs,
} = {}) => {
  const state = {
    worker: null,
    respawnCount: 0,
    nextRequestId: 1,
    pending: new Map(),
    disposed: false,
  };

  const failAllPending = (error) => {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    state.pending.clear();
  };

  const disposeWorker = () => {
    if (!state.worker) return;
    try {
      state.worker.terminate();
    } catch {
      // ignore
    }
    state.worker = null;
  };

  const ensureWorker = () => {
    if (state.worker) return state.worker;
    if (state.respawnCount >= kMaxWorkerRespawns) {
      throw new Error("Fingerprint worker unavailable (respawn cap reached)");
    }
    // Lazy require so merely loading this module never spawns a thread.
    const { Worker } = require("worker_threads");
    const worker = new Worker(workerPath);
    worker.unref();
    worker.on("message", (message) => {
      const entry = state.pending.get(message?.id);
      if (!entry) return;
      state.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.snapshot);
      else entry.reject(new Error(message.error || "Fingerprint worker failed"));
    });
    worker.on("error", (error) => {
      if (state.worker !== worker) return;
      state.respawnCount += 1;
      failAllPending(error instanceof Error ? error : new Error(String(error)));
      disposeWorker();
    });
    worker.on("exit", (code) => {
      if (state.worker !== worker) return;
      state.respawnCount += 1;
      failAllPending(new Error(`Fingerprint worker exited (code ${code})`));
      state.worker = null;
    });
    state.worker = worker;
    return worker;
  };

  const computeSnapshot = (rootDir, { previousManifest = null, options = {} } = {}) =>
    new Promise((resolve, reject) => {
      if (state.disposed) {
        reject(new Error("Fingerprint client disposed"));
        return;
      }
      let worker;
      try {
        worker = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const id = state.nextRequestId;
      state.nextRequestId += 1;
      const timer = setTimeout(() => {
        state.pending.delete(id);
        // A timed-out scan keeps burning CPU in the worker — terminate it
        // (the next request lazily respawns, counted against the cap) and
        // fail ALL pending requests: they shared the terminated worker and
        // would otherwise strand until their own timers fired.
        state.respawnCount += 1;
        failAllPending(new Error("Fingerprint worker timed out"));
        disposeWorker();
        reject(new Error("Fingerprint worker timed out"));
      }, requestTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      state.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, rootDir, previousManifest, options });
      } catch (error) {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });

  const dispose = () => {
    state.disposed = true;
    failAllPending(new Error("Fingerprint client disposed"));
    disposeWorker();
  };

  return { computeSnapshot, dispose };
};

module.exports = { createFingerprintClient };
