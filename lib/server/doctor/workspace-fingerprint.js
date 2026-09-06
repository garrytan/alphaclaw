const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("node:worker_threads");

// Tool-owned directories only: build outputs and caches that are never the
// agent's authoritative content. Deliberately NOT `build`/`out`/`target` —
// those generic names can hold real source. Changing this set changes
// fingerprints (one full re-analysis after upgrade, noted in CHANGELOG).
const kIgnoredDirectoryNames = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".turbo",
  "coverage",
]);

const kContentFileExtensions = new Set([
  ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".yaml", ".yml",
  ".txt", ".sh", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h",
]);

const isContentFile = (relativePath = "") => {
  const ext = path.extname(String(relativePath || "")).toLowerCase();
  return kContentFileExtensions.has(ext);
};

const kHashChunkBytes = 1024 * 1024;
// Module-scope scratch buffer: hashFile is synchronous and single-threaded
// within its worker, so one shared buffer is safe — a per-file allocUnsafe
// would be up to 200k transient 1MB allocations (bypassing the buffer pool)
// on a cold scan at the default cap.
const kHashChunkBuffer = Buffer.allocUnsafe(kHashChunkBytes);

// Constant-memory streaming hash: one reused chunk buffer regardless of file
// size (the per-file byte cap is operator-raisable to 100MB — a fully
// buffered read would spike a Buffer that large per changed file).
// `maxBytes` (the stat'd size) bounds the read: a file being APPENDED during
// the hash must not stream past EOF forever — an unbounded loop here rides
// the worker-timeout → sync-fallback chain onto the main event loop.
const hashFile = (filePath, fsModule = fs, maxBytes = Infinity) => {
  const hash = crypto.createHash("sha256");
  const fd = fsModule.openSync(filePath, "r");
  try {
    let remaining = maxBytes;
    let bytesRead = 0;
    do {
      const toRead = Math.min(kHashChunkBytes, remaining);
      if (toRead <= 0) break;
      bytesRead = fsModule.readSync(fd, kHashChunkBuffer, 0, toRead, null);
      if (bytesRead > 0) {
        hash.update(kHashChunkBuffer.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
    } while (bytesRead > 0);
  } finally {
    fsModule.closeSync(fd);
  }
  return hash.digest("hex");
};

const normalizeRelativePath = (rootDir, filePath) =>
  path.relative(rootDir, filePath).split(path.sep).join("/");

// Iterative DFS walk (explicit frame stack — recursion depth and
// spread-into-push both overflow around ~100k+ paths/frames). Per-directory
// read errors skip the subtree instead of killing the whole scan. Stores at
// most `maxStoredFiles` paths but keeps counting to `maxEntries` so
// `totalFiles` stays exact for capped workspaces (the saturating ceiling
// bounds even the counting). Traversal order (per-dir localeCompare, DFS
// in-order) is load-bearing: the capped subset must be stable across scans.
const kSnapshotWalkMaxEntries = 1000000;

const walkFiles = (
  rootDir,
  {
    fsModule = fs,
    maxStoredFiles = Infinity,
    maxEntries = kSnapshotWalkMaxEntries,
  } = {},
) => {
  const files = [];
  let totalFiles = 0;
  let skippedDirCount = 0;
  let saturated = false;

  const readSortedEntries = (dir) => {
    try {
      const entries = fsModule.readdirSync(dir, { withFileTypes: true });
      return [...entries].sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      skippedDirCount += 1;
      return null;
    }
  };

  const rootEntries = readSortedEntries(rootDir);
  if (rootEntries === null) {
    // An unreadable WORKSPACE ROOT is a scan failure, not a partial scan — a
    // silently-empty manifest would persist an empty baseline and report
    // "no drift" forever. Per-subdirectory tolerance stays.
    throw new Error(`Workspace root is not readable: ${rootDir}`);
  }
  const stack = [{ dir: rootDir, entries: rootEntries, index: 0 }];
  while (stack.length > 0 && !saturated) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.index];
    frame.index += 1;
    if (entry.isDirectory()) {
      if (kIgnoredDirectoryNames.has(entry.name)) continue;
      const childDir = path.join(frame.dir, entry.name);
      const childEntries = readSortedEntries(childDir);
      if (childEntries !== null) {
        stack.push({ dir: childDir, entries: childEntries, index: 0 });
      }
      continue;
    }
    if (!entry.isFile()) continue;
    totalFiles += 1;
    if (files.length < maxStoredFiles) {
      files.push(path.join(frame.dir, entry.name));
    }
    if (totalFiles >= maxEntries) saturated = true;
  }

  return { files, totalFiles, skippedDirCount, saturated };
};

// Bounds (shared by the sync and worker scan paths): runaway workspaces must
// not turn a fingerprint pass into an unbounded walk. Files beyond the count
// cap are excluded, files over the byte cap are skipped, and the snapshot is
// flagged `limited` whenever ANY file was excluded from the fingerprint.
// maxFiles/maxFileBytes are operator-configurable (doctor.scan in
// alphaclaw.json, bounds 1k-500k / 1-100MB); the hash-byte budget and the
// walk ceiling are fixed backstops.
const kSnapshotMaxFiles = 200000;
const kSnapshotMaxFileBytes = 50 * 1024 * 1024;
// Legacy pre-configurability caps: the sync worker-unavailable fallback runs
// clamped to these regardless of configured caps, so degraded-mode event-loop
// blocking is bounded to the old worst case.
const kSnapshotLegacyMaxFiles = 50000;
const kSnapshotLegacyMaxFileBytes = 10 * 1024 * 1024;
// Total bytes hashed per snapshot (reused hashes are free). Counts toward
// `limited` when exhausted — never an invisible partiality.
const kSnapshotMaxTotalHashBytes = 2 * 1024 * 1024 * 1024;
const kSnapshotHashBatchSize = 500;
const kSnapshotBatchPauseMs = 5;

// Single source of the "configured ?? built-in default" resolution rule —
// the settings route (MB units) and the doctor service (byte units) must
// never encode this fallback independently.
const resolveEffectiveScanCaps = ({ maxFiles = null, maxFileMb = null } = {}) => ({
  maxFiles: maxFiles ?? kSnapshotMaxFiles,
  maxFileBytes: maxFileMb ? maxFileMb * 1024 * 1024 : kSnapshotMaxFileBytes,
  maxFileMb: maxFileMb ?? Math.round(kSnapshotMaxFileBytes / (1024 * 1024)),
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const canReuseManifestEntry = (previousEntry, stat) =>
  typeof previousEntry === "object" &&
  previousEntry !== null &&
  !!previousEntry.hash &&
  Number.isFinite(previousEntry.mtimeMs) &&
  Number(previousEntry.mtimeMs) === stat.mtimeMs &&
  Number(previousEntry.size) === stat.size;

// Shared per-file scan step for BOTH the sync and worker paths — the two
// previously duplicated (and drifted on) the cap/reuse/stat logic, the same
// divergent-copy class that produced the delivery-target bug. Files can
// vanish between the walk and the stat/hash (the agent deletes and rewrites
// files constantly) — errors skip the file, never fail the scan.
// Returns "hashed" | "reused" | "skipped" | "errored".
const processManifestFile = ({
  fsModule,
  filePath,
  relativePath,
  previousEntries,
  maxFileBytes,
  maxTotalHashBytes,
  manifest,
  counters,
}) => {
  try {
    const stat = fsModule.statSync(filePath);
    if (stat.size > maxFileBytes) {
      counters.skippedLargeCount += 1;
      return "skipped";
    }
    const previousEntry = previousEntries[relativePath];
    if (canReuseManifestEntry(previousEntry, stat)) {
      manifest[relativePath] = {
        hash: String(previousEntry.hash),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      counters.reusedCount += 1;
      return "reused";
    }
    if (counters.hashedBytes + stat.size > maxTotalHashBytes) {
      counters.hashBudgetSkippedCount += 1;
      return "skipped";
    }
    manifest[relativePath] = {
      // Bounded at the stat'd size: content appended mid-hash lands in the
      // NEXT scan (the mtime/size change busts reuse), never an endless read.
      hash: hashFile(filePath, fsModule, stat.size),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    counters.hashedCount += 1;
    counters.hashedBytes += stat.size;
    return "hashed";
  } catch (error) {
    // Transient churn (the agent deleting/rewriting files) is expected and
    // must not flip the scan to "limited" every refresh; a PERSISTENT
    // permission failure is genuinely unscanned content and must be visible.
    if (error?.code === "ENOENT") {
      counters.erroredCount += 1;
    } else {
      counters.unreadableCount += 1;
    }
    return "errored";
  }
};

const createScanCounters = () => ({
  hashedCount: 0,
  reusedCount: 0,
  skippedLargeCount: 0,
  hashBudgetSkippedCount: 0,
  erroredCount: 0,
  unreadableCount: 0,
  hashedBytes: 0,
});

const buildScanResult = ({ walk, counters, maxFiles, maxFileBytes, manifest }) => ({
  manifest,
  capsUsed: { maxFiles, maxFileBytes },
  // Drift detection is "limited" whenever ANY file is excluded from the
  // fingerprint — count cap, size cap, hash-byte budget, walk ceiling, an
  // unreadable directory, or a persistently unreadable file (EACCES-class).
  // Transient per-file errors (ENOENT: vanished mid-scan) stay out: they
  // would flip the banner on normal agent churn.
  limited:
    walk.totalFiles > maxFiles ||
    walk.saturated ||
    walk.skippedDirCount > 0 ||
    counters.skippedLargeCount > 0 ||
    counters.hashBudgetSkippedCount > 0 ||
    counters.unreadableCount > 0,
  stats: {
    totalFiles: walk.totalFiles,
    totalFilesSaturated: walk.saturated,
    hashedCount: counters.hashedCount,
    reusedCount: counters.reusedCount,
    skippedLargeCount: counters.skippedLargeCount,
    hashBudgetSkippedCount: counters.hashBudgetSkippedCount,
    hashBudgetExhausted: counters.hashBudgetSkippedCount > 0,
    skippedDirCount: walk.skippedDirCount,
    erroredCount: counters.erroredCount,
    unreadableCount: counters.unreadableCount,
  },
});

// Incremental: entries whose (mtimeMs, size) match the previous manifest reuse
// the previous hash instead of re-reading the file. Persisted manifests that
// predate mtimeMs tracking are always re-hashed. Bounded per the caps above.
const buildWorkspaceManifest = (
  rootDir,
  {
    previousManifest = null,
    maxFiles = kSnapshotMaxFiles,
    maxFileBytes = kSnapshotMaxFileBytes,
    maxTotalHashBytes = kSnapshotMaxTotalHashBytes,
    fsModule = fs,
  } = {},
) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const walk = walkFiles(normalizedRootDir, { fsModule, maxStoredFiles: maxFiles });
  const previousEntries =
    previousManifest && typeof previousManifest === "object" ? previousManifest : {};
  const manifest = {};
  const counters = createScanCounters();

  for (const filePath of walk.files) {
    processManifestFile({
      fsModule,
      filePath,
      relativePath: normalizeRelativePath(normalizedRootDir, filePath),
      previousEntries,
      maxFileBytes,
      maxTotalHashBytes,
      manifest,
      counters,
    });
  }

  return buildScanResult({ walk, counters, maxFiles, maxFileBytes, manifest });
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
    maxTotalHashBytes = kSnapshotMaxTotalHashBytes,
    batchSize = kSnapshotHashBatchSize,
    batchPauseMs = kSnapshotBatchPauseMs,
    fsModule = fs,
  } = {},
) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const walk = walkFiles(normalizedRootDir, { fsModule, maxStoredFiles: maxFiles });
  const previousEntries =
    previousManifest && typeof previousManifest === "object" ? previousManifest : {};
  const manifest = {};
  const counters = createScanCounters();

  for (let index = 0; index < walk.files.length; index += 1) {
    const filePath = walk.files[index];
    const outcome = processManifestFile({
      fsModule,
      filePath,
      relativePath: normalizeRelativePath(normalizedRootDir, filePath),
      previousEntries,
      maxFileBytes,
      maxTotalHashBytes,
      manifest,
      counters,
    });
    if (
      outcome === "hashed" &&
      batchPauseMs > 0 &&
      counters.hashedCount % batchSize === 0
    ) {
      await sleep(batchPauseMs);
    }
  }

  const result = buildScanResult({ walk, counters, maxFiles, maxFileBytes, manifest });
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(
      manifest,
      result.limited ? result.stats : null,
    ),
    ...result,
  };
};

const getManifestEntryHash = (entry) =>
  typeof entry === "object" && entry !== null ? String(entry.hash || "") : String(entry || "");

const getManifestEntrySize = (entry) =>
  typeof entry === "object" && entry !== null ? Number(entry.size || 0) : 0;

const computeWorkspaceFingerprintFromManifest = (manifest = {}, scanStats = null) => {
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
  // Limited scans: fold the exclusion counters into the fingerprint so a
  // file-count change BEYOND the cap still busts the deterministic-reuse
  // guard — otherwise edits among excluded files serve stale "no change"
  // runs forever. Callers pass scanStats only for `limited` snapshots (a
  // transient vanished-file error must not perturb unlimited fingerprints).
  if (scanStats) {
    hash.update(
      `\0stats-v1:${Number(scanStats.totalFiles || 0)}:${Number(scanStats.skippedLargeCount || 0)}:${Number(scanStats.hashBudgetSkippedCount || 0)}:${Number(scanStats.skippedDirCount || 0)}:${Number(scanStats.unreadableCount || 0)}`,
    );
  }

  return hash.digest("hex");
};

const computeWorkspaceSnapshot = (rootDir, options = {}) => {
  const result = buildWorkspaceManifest(rootDir, options);
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(
      result.manifest,
      result.limited ? result.stats : null,
    ),
    ...result,
  };
};

// Drift weights derive from the active context profile: injected root files
// are the highest-signal paths on that version (retired files fall to the
// generic .md weight; daily memory/* churn is expected and weighted 1).
const { getProfilePathChangeWeight, kStableProfile } = require("./context-profiles");

const kFingerprintWorkerScriptPath = path.join(__dirname, "fingerprint-worker.js");
const kSnapshotWorkerRequestTimeoutMs = 10 * 60 * 1000;
const kMaxSnapshotWorkerRespawns = 3;
// After the cap trips, the budget re-opens once this long has passed since the
// last failure (fix wave F112): three timeouts from an environmental stall
// (backup barrier, disk contention) used to blind the drift trigger until an
// AlphaClaw restart. Explicit runs always had the sync fallback.
const kSnapshotWorkerRespawnCooldownMs = 10 * 60 * 1000;

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
  respawnCooldownMs = kSnapshotWorkerRespawnCooldownMs,
  now = Date.now,
} = {}) => {
  let worker = null;
  let nextJobId = 1;
  let respawnCount = 0;
  let lastFailureAt = 0;
  let terminated = false;
  const pendingJobs = new Map();
  const noteFailure = () => {
    respawnCount += 1;
    lastFailureAt = now();
  };

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
      if (now() - lastFailureAt < respawnCooldownMs) {
        throw new Error("Workspace snapshot worker unavailable (respawn cap reached)");
      }
      // Cooldown elapsed: one more budget of attempts (F112).
      respawnCount = 0;
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
        let snapshot = message.snapshot;
        // No-change refreshes omit the multi-MB manifest from the result
        // message (the structured clone is the main-thread cost) — restore
        // the caller's own previous manifest.
        if (snapshot?.manifestUnchanged && job.previousManifest) {
          snapshot = { ...snapshot, manifest: job.previousManifest };
        }
        job.resolve(snapshot);
      } else {
        job.reject(new Error(message.error || "Workspace snapshot worker failed"));
      }
    });
    spawned.on("error", (error) => {
      if (worker !== spawned) return;
      worker = null;
      noteFailure();
      spawned.terminate?.()?.catch?.(() => {});
      failPendingJobs(error instanceof Error ? error : new Error(String(error)));
    });
    spawned.on("exit", () => {
      if (worker !== spawned) return;
      worker = null;
      noteFailure();
      failPendingJobs(new Error("Workspace snapshot worker exited"));
    });
    // The worker must never keep the server process alive on its own.
    spawned.unref?.();
    return spawned;
  };

  const computeWorkspaceSnapshotAsync = (
    workspaceRoot,
    {
      previousManifest = null,
      previousFingerprint = "",
      maxFiles = undefined,
      maxFileBytes = undefined,
    } = {},
  ) =>
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
        noteFailure();
        disposeWorker();
        failPendingJobs(new Error("Workspace snapshot worker timed out"));
        reject(new Error("Workspace snapshot worker timed out"));
      }, requestTimeoutMs);
      timer.unref?.();
      pendingJobs.set(jobId, { resolve, reject, timer, previousManifest });
      try {
        spawned.postMessage({
          jobId,
          workspaceRoot,
          previousManifest,
          previousFingerprint,
          maxFiles,
          maxFileBytes,
        });
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
  kSnapshotWorkerRespawnCooldownMs,
  kMaxSnapshotWorkerRespawns,
  calculateWorkspaceDelta,
  computeWorkspaceFingerprintFromManifest,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotAsync,
  computeWorkspaceSnapshotBounded,
  createWorkspaceSnapshotWorkerClient,
  terminateSharedSnapshotWorkerClient,
  isContentFile,
  walkFiles,
  resolveEffectiveScanCaps,
  kSnapshotMaxFiles,
  kSnapshotMaxFileBytes,
  kSnapshotLegacyMaxFiles,
  kSnapshotLegacyMaxFileBytes,
  kSnapshotMaxTotalHashBytes,
  kSnapshotWalkMaxEntries,
};
