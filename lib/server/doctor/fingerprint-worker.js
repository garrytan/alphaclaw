// Worker-thread entry for workspace fingerprinting. Keeps the full-workspace
// walk + SHA-256 pass off the main event loop, which serves the admin UI.
//
//   main thread                    worker thread (this file)
//   ───────────                    ─────────────────────────
//   postMessage({id, rootDir,  ─▶  computeWorkspaceSnapshotBounded(...)
//     previousManifest, options})       │ (batched hashing with pauses)
//   ◀─ postMessage({id, ok,     ◀──────┘
//        snapshot | error})
const { parentPort } = require("worker_threads");
const { computeWorkspaceSnapshotBounded } = require("./workspace-fingerprint");

if (parentPort) {
  parentPort.on("message", async (message) => {
    const { id, rootDir, previousManifest, options } = message || {};
    try {
      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        ...(options || {}),
        previousManifest: previousManifest || null,
      });
      parentPort.postMessage({ id, ok: true, snapshot });
    } catch (error) {
      parentPort.postMessage({
        id,
        ok: false,
        error: error?.message || "Fingerprint worker failed",
      });
    }
  });
}
