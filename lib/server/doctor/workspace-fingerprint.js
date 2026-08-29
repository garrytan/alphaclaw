const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("node:worker_threads");

const kIgnoredDirectoryNames = new Set([".git", "node_modules"]);

const kContentFileExtensions = new Set([
  ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".yaml", ".yml",
  ".txt", ".sh", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
]);

const isContentFile = (relativePath = "") => {
  const ext = path.extname(String(relativePath || "")).toLowerCase();
  return kContentFileExtensions.has(ext);
};

const hashFile = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
};

const normalizeRelativePath = (rootDir, filePath) =>
  path.relative(rootDir, filePath).split(path.sep).join("/");

const walkFiles = (rootDir, currentDir = rootDir) => {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of sortedEntries) {
    if (entry.isDirectory()) {
      if (kIgnoredDirectoryNames.has(entry.name)) continue;
      files.push(...walkFiles(rootDir, path.join(currentDir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path.join(currentDir, entry.name));
  }

  return files;
};

// Bounds (shared by the sync and worker scan paths): runaway workspaces must
// not turn a fingerprint pass into an unbounded walk. Files beyond the count
// cap are excluded, files over the byte cap are skipped, and the snapshot is
// flagged `limited` whenever ANY file was excluded from the fingerprint.
const kSnapshotMaxFiles = 50000;
const kSnapshotMaxFileBytes = 10 * 1024 * 1024;
const kSnapshotHashBatchSize = 200;
const kSnapshotBatchPauseMs = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const canReuseManifestEntry = (previousEntry, stat) =>
  typeof previousEntry === "object" &&
  previousEntry !== null &&
  !!previousEntry.hash &&
  Number.isFinite(previousEntry.mtimeMs) &&
  Number(previousEntry.mtimeMs) === stat.mtimeMs &&
  Number(previousEntry.size) === stat.size;

// Incremental: entries whose (mtimeMs, size) match the previous manifest reuse
// the previous hash instead of re-reading the file. Persisted manifests that
// predate mtimeMs tracking are always re-hashed. Bounded per the caps above.
const buildWorkspaceManifest = (
  rootDir,
  {
    previousManifest = null,
    maxFiles = kSnapshotMaxFiles,
    maxFileBytes = kSnapshotMaxFileBytes,
  } = {},
) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const files = walkFiles(normalizedRootDir);
  const cappedByFileCount = files.length > maxFiles;
  const scannableFiles = cappedByFileCount ? files.slice(0, maxFiles) : files;
  const previousEntries =
    previousManifest && typeof previousManifest === "object" ? previousManifest : {};
  const manifest = {};
  let hashedCount = 0;
  let reusedCount = 0;
  let skippedLargeCount = 0;

  for (const filePath of scannableFiles) {
    const relativePath = normalizeRelativePath(normalizedRootDir, filePath);
    // Files can vanish between the walk and the stat/hash (the agent deletes
    // and rewrites files constantly) — skip them instead of failing the scan.
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxFileBytes) {
        skippedLargeCount += 1;
        continue;
      }
      const previousEntry = previousEntries[relativePath];
      const canReusePreviousHash = canReuseManifestEntry(previousEntry, stat);
      if (canReusePreviousHash) reusedCount += 1;
      else hashedCount += 1;
      manifest[relativePath] = {
        hash: canReusePreviousHash ? String(previousEntry.hash) : hashFile(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      // skip vanished/unreadable file
    }
  }

  return {
    manifest,
    limited: cappedByFileCount || skippedLargeCount > 0,
    stats: {
      totalFiles: files.length,
      hashedCount,
      reusedCount,
      skippedLargeCount,
    },
  };
};

// Bounded, incremental, fault-tolerant snapshot builder. Reuses hashes from
// `previousManifest` for files whose size+mtime are unchanged, hashes in small
// batches with pauses so a throttled core is never monopolized, caps the
// manifest (files beyond the cap are excluded and `limited` is set), and skips
// files that vanish mid-scan. Runs inside the fingerprint worker; also
// callable directly (tests, parity checks).
const computeWorkspaceSnapshotBounded = async (
  rootDir,
  {
    previousManifest = null,
    maxFiles = kSnapshotMaxFiles,
    maxFileBytes = kSnapshotMaxFileBytes,
    batchSize = kSnapshotHashBatchSize,
    batchPauseMs = kSnapshotBatchPauseMs,
  } = {},
) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const files = walkFiles(normalizedRootDir);
  const limited = files.length > maxFiles;
  const scannableFiles = limited ? files.slice(0, maxFiles) : files;
  const manifest = {};
  let hashedCount = 0;
  let reusedCount = 0;
  let skippedLargeCount = 0;

  for (let index = 0; index < scannableFiles.length; index += 1) {
    const filePath = scannableFiles[index];
    const relativePath = normalizeRelativePath(normalizedRootDir, filePath);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > maxFileBytes) {
        skippedLargeCount += 1;
        continue;
      }
      const previousEntry = previousManifest?.[relativePath];
      if (
        previousEntry &&
        typeof previousEntry === "object" &&
        previousEntry.hash &&
        Number(previousEntry.size) === stat.size &&
        Number(previousEntry.mtimeMs) === stat.mtimeMs
      ) {
        manifest[relativePath] = {
          hash: String(previousEntry.hash),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        reusedCount += 1;
        continue;
      }
      manifest[relativePath] = {
        hash: hashFile(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      hashedCount += 1;
      if (batchPauseMs > 0 && hashedCount % batchSize === 0) {
        await sleep(batchPauseMs);
      }
    } catch {
      // skip vanished/unreadable file
    }
  }

  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(manifest),
    manifest,
    // Drift detection is "limited" whenever ANY file is excluded from the
    // fingerprint — by the file-count cap or by the per-file size cap.
    limited: limited || skippedLargeCount > 0,
    stats: {
      totalFiles: files.length,
      hashedCount,
      reusedCount,
      skippedLargeCount,
    },
  };
};

const getManifestEntryHash = (entry) =>
  typeof entry === "object" && entry !== null ? String(entry.hash || "") : String(entry || "");

const getManifestEntrySize = (entry) =>
  typeof entry === "object" && entry !== null ? Number(entry.size || 0) : 0;

const computeWorkspaceFingerprintFromManifest = (manifest = {}) => {
  const hash = crypto.createHash("sha256");
  const entries = Object.entries(manifest).sort(([leftPath], [rightPath]) =>
    leftPath.localeCompare(rightPath),
  );

  hash.update("workspace-fingerprint-v1");
  for (const [relativePath, entry] of entries) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(getManifestEntryHash(entry));
    hash.update("\0");
  }

  return hash.digest("hex");
};

const computeWorkspaceSnapshot = (rootDir, { previousManifest = null } = {}) => {
  const { manifest, limited, stats } = buildWorkspaceManifest(rootDir, { previousManifest });
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(manifest),
    manifest,
    limited,
    stats,
  };
};

// Drift weights derive from the active context profile: injected root files
// are the highest-signal paths on that version (retired files fall to the
// generic .md weight; daily memory/* churn is expected and weighted 1).
const { getProfilePathChangeWeight, kStableProfile } = require("./context-profiles");

const kFingerprintWorkerScriptPath = path.join(__dirname, "fingerprint-worker.js");
const kSnapshotWorkerRequestTimeoutMs = 10 * 60 * 1000;
const kMaxSnapshotWorkerRespawns = 3;

// Parent-side wrapper around one persistent fingerprint worker thread. The
// worker is spawned lazily, reused across jobs, and recycled on error/exit so
// a crashed walk never wedges later snapshot requests. Recycling is bounded:
// after kMaxSnapshotWorkerRespawns consecutive failures requests reject up
// front (callers serve their stale snapshot); a healthy round-trip resets the
// budget so sporadic failures spread over weeks can never brick the client.
// A request that outlives requestTimeoutMs terminates the worker (a hung scan
// keeps burning CPU otherwise) and fails all pending jobs, which shared it.
const createWorkspaceSnapshotWorkerClient = ({
  workerScriptPath = kFingerprintWorkerScriptPath,
  createWorker = (scriptPath) => new Worker(scriptPath),
  requestTimeoutMs = kSnapshotWorkerRequestTimeoutMs,
} = {}) => {
  let worker = null;
  let nextJobId = 1;
  let respawnCount = 0;
  let terminated = false;
  const pendingJobs = new Map();

  const failPendingJobs = (error) => {
    const jobs = [...pendingJobs.values()];
    pendingJobs.clear();
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.reject(error);
    }
  };

  const disposeWorker = () => {
    const current = worker;
    worker = null;
    if (current) current.terminate?.()?.catch?.(() => {});
  };

  const ensureWorker = () => {
    if (worker) return worker;
    if (respawnCount >= kMaxSnapshotWorkerRespawns) {
      throw new Error("Workspace snapshot worker unavailable (respawn cap reached)");
    }
    const spawned = createWorker(workerScriptPath);
    worker = spawned;
    spawned.on("message", (message) => {
      const job = pendingJobs.get(message?.jobId);
      if (!job) return;
      pendingJobs.delete(message.jobId);
      clearTimeout(job.timer);
      if (message.ok) {
        // A healthy round-trip proves the worker is sound — reset the respawn
        // budget so only an actively failing worker can exhaust it.
        respawnCount = 0;
        job.resolve(message.snapshot);
      } else {
        job.reject(new Error(message.error || "Workspace snapshot worker failed"));
      }
    });
    spawned.on("error", (error) => {
      if (worker !== spawned) return;
      worker = null;
      respawnCount += 1;
      spawned.terminate?.()?.catch?.(() => {});
      failPendingJobs(error instanceof Error ? error : new Error(String(error)));
    });
    spawned.on("exit", () => {
      if (worker !== spawned) return;
      worker = null;
      respawnCount += 1;
      failPendingJobs(new Error("Workspace snapshot worker exited"));
    });
    // The worker must never keep the server process alive on its own.
    spawned.unref?.();
    return spawned;
  };

  const computeWorkspaceSnapshotAsync = (workspaceRoot, { previousManifest = null } = {}) =>
    new Promise((resolve, reject) => {
      if (terminated) {
        reject(new Error("Workspace snapshot worker terminated"));
        return;
      }
      let spawned;
      try {
        spawned = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const jobId = nextJobId;
      nextJobId += 1;
      const timer = setTimeout(() => {
        // Timed out: terminate the hung worker (the next request lazily
        // respawns, counted against the cap) and fail every pending job —
        // they shared the terminated worker and would otherwise strand.
        pendingJobs.delete(jobId);
        respawnCount += 1;
        disposeWorker();
        failPendingJobs(new Error("Workspace snapshot worker timed out"));
        reject(new Error("Workspace snapshot worker timed out"));
      }, requestTimeoutMs);
      timer.unref?.();
      pendingJobs.set(jobId, { resolve, reject, timer });
      try {
        spawned.postMessage({ jobId, workspaceRoot, previousManifest });
      } catch (error) {
        pendingJobs.delete(jobId);
        clearTimeout(timer);
        reject(error);
      }
    });

  const terminate = async () => {
    terminated = true;
    failPendingJobs(new Error("Workspace snapshot worker terminated"));
    const current = worker;
    worker = null;
    if (current) await current.terminate().catch(() => {});
  };

  return {
    computeWorkspaceSnapshotAsync,
    terminate,
  };
};

let sharedSnapshotWorkerClient = null;

const computeWorkspaceSnapshotAsync = (workspaceRoot, options = {}) => {
  if (!sharedSnapshotWorkerClient) {
    sharedSnapshotWorkerClient = createWorkspaceSnapshotWorkerClient();
  }
  return sharedSnapshotWorkerClient.computeWorkspaceSnapshotAsync(workspaceRoot, options);
};

// Shutdown hook: tears down the shared worker thread. The next
// computeWorkspaceSnapshotAsync call lazily creates a fresh client.
const terminateSharedSnapshotWorkerClient = async () => {
  const client = sharedSnapshotWorkerClient;
  sharedSnapshotWorkerClient = null;
  if (client) await client.terminate();
};

const kByteDeltaSmallThreshold = 100;
const kByteDeltaSignificantThreshold = 500;

const getModifiedFileScore = (relativePath, previousEntry, currentEntry, profile) => {
  if (!isContentFile(relativePath)) return 1;
  const previousSize = getManifestEntrySize(previousEntry);
  const currentSize = getManifestEntrySize(currentEntry);
  if (!previousSize && !currentSize) {
    return getProfilePathChangeWeight(profile, relativePath);
  }
  const byteDelta = Math.abs(currentSize - previousSize);
  if (byteDelta < kByteDeltaSmallThreshold) return 1;
  if (byteDelta < kByteDeltaSignificantThreshold) return 2;
  return getProfilePathChangeWeight(profile, relativePath);
};

const calculateWorkspaceDelta = ({
  previousManifest = {},
  currentManifest = {},
  profile = kStableProfile,
} = {}) => {
  const previousPaths = Object.keys(previousManifest);
  const currentPaths = Object.keys(currentManifest);
  const allPaths = Array.from(new Set([...previousPaths, ...currentPaths])).sort((left, right) =>
    left.localeCompare(right),
  );
  const changeSummary = {
    addedFilesCount: 0,
    removedFilesCount: 0,
    modifiedFilesCount: 0,
    changedFilesCount: 0,
    deltaScore: 0,
    changedPaths: [],
  };

  for (const relativePath of allPaths) {
    const previousEntry = previousManifest[relativePath];
    const currentEntry = currentManifest[relativePath];
    const previousHash = getManifestEntryHash(previousEntry);
    const currentHash = getManifestEntryHash(currentEntry);
    if (!previousHash && currentHash) {
      changeSummary.addedFilesCount += 1;
      changeSummary.deltaScore += getProfilePathChangeWeight(profile, relativePath);
    } else if (previousHash && !currentHash) {
      changeSummary.removedFilesCount += 1;
      changeSummary.deltaScore += getProfilePathChangeWeight(profile, relativePath);
    } else if (previousHash !== currentHash) {
      changeSummary.modifiedFilesCount += 1;
      changeSummary.deltaScore += getModifiedFileScore(
        relativePath,
        previousEntry,
        currentEntry,
        profile,
      );
    } else {
      continue;
    }
    changeSummary.changedFilesCount += 1;
    changeSummary.changedPaths.push(relativePath);
  }

  return changeSummary;
};

module.exports = {
  calculateWorkspaceDelta,
  computeWorkspaceFingerprintFromManifest,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotAsync,
  computeWorkspaceSnapshotBounded,
  createWorkspaceSnapshotWorkerClient,
  terminateSharedSnapshotWorkerClient,
  isContentFile,
};
