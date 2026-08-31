// Worker-thread entry for workspace fingerprinting: runs the iterative
// stat/hash walk off the main event loop. One persistent worker serves
// computeWorkspaceSnapshotAsync jobs dispatched by workspace-fingerprint.js.
//
//   main thread                          worker thread (this file)
//   ───────────                          ─────────────────────────
//   postMessage({jobId, workspaceRoot, ─▶ computeWorkspaceSnapshotBounded(...)
//     previousManifest,                      │ (batched hashing with pauses)
//     previousFingerprint,               ◀───┘
//     maxFiles, maxFileBytes})
//   ◀─ postMessage({jobId, ok,
//        snapshot | error})
//
// When the fingerprint is unchanged from previousFingerprint, the result
// omits the multi-MB manifest (manifestUnchanged: true) — the client restores
// its own copy, so steady-state refreshes never pay the structured-clone
// cost on the main thread.
const { parentPort } = require("node:worker_threads");
const { computeWorkspaceSnapshotBounded } = require("./workspace-fingerprint");

if (parentPort) {
  parentPort.on(
    "message",
    async ({
      jobId,
      workspaceRoot,
      previousManifest,
      previousFingerprint,
      maxFiles,
      maxFileBytes,
    } = {}) => {
      try {
        const snapshot = await computeWorkspaceSnapshotBounded(workspaceRoot, {
          previousManifest: previousManifest || null,
          ...(maxFiles ? { maxFiles } : {}),
          ...(maxFileBytes ? { maxFileBytes } : {}),
        });
        // Omit ONLY when nothing was re-hashed: a touched-but-identical file
        // (mtime bumped, content same) keeps the fingerprint stable but the
        // fresh manifest carries the NEW mtime — restoring the stale-mtime
        // copy would make that file re-hash on every refresh forever (and
        // bleed the hash-byte budget).
        const manifestUnchanged =
          !!previousFingerprint &&
          snapshot.fingerprint === previousFingerprint &&
          Number(snapshot.stats?.hashedCount || 0) === 0;
        parentPort.postMessage({
          jobId,
          ok: true,
          snapshot: manifestUnchanged
            ? { ...snapshot, manifest: null, manifestUnchanged: true }
            : snapshot,
        });
      } catch (error) {
        parentPort.postMessage({
          jobId,
          ok: false,
          error: error?.message || String(error),
        });
      }
    },
  );
}
