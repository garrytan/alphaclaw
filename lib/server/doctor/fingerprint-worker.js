// Worker-thread entry for workspace fingerprinting: runs the recursive
// stat/hash walk off the main event loop. One persistent worker serves
// computeWorkspaceSnapshotAsync jobs dispatched by workspace-fingerprint.js.
//
//   main thread                          worker thread (this file)
//   ───────────                          ─────────────────────────
//   postMessage({jobId, workspaceRoot, ─▶ computeWorkspaceSnapshotBounded(...)
//     previousManifest})                      │ (batched hashing with pauses)
//   ◀─ postMessage({jobId, ok,          ◀────┘
//        snapshot | error})
const { parentPort } = require("node:worker_threads");
const { computeWorkspaceSnapshotBounded } = require("./workspace-fingerprint");

if (parentPort) {
  parentPort.on("message", async ({ jobId, workspaceRoot, previousManifest } = {}) => {
    try {
      const snapshot = await computeWorkspaceSnapshotBounded(workspaceRoot, {
        previousManifest: previousManifest || null,
      });
      parentPort.postMessage({ jobId, ok: true, snapshot });
    } catch (error) {
      parentPort.postMessage({
        jobId,
        ok: false,
        error: error?.message || String(error),
      });
    }
  });
}
