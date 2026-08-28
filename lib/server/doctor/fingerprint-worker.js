// Worker-thread entry for workspace fingerprinting: runs the recursive
// stat/hash walk off the main event loop. One persistent worker serves
// computeWorkspaceSnapshotAsync jobs dispatched by workspace-fingerprint.js.
const { parentPort } = require("node:worker_threads");
const { computeWorkspaceSnapshot } = require("./workspace-fingerprint");

parentPort.on("message", ({ jobId, workspaceRoot, previousManifest } = {}) => {
  try {
    const snapshot = computeWorkspaceSnapshot(workspaceRoot, { previousManifest });
    parentPort.postMessage({ jobId, ok: true, snapshot });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: error?.message || String(error),
    });
  }
});
