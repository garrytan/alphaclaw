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

// Incremental: entries whose (mtimeMs, size) match the previous manifest reuse
// the previous hash instead of re-reading the file. Persisted manifests that
// predate mtimeMs tracking are always re-hashed.
const buildWorkspaceManifest = (rootDir, { previousManifest = null } = {}) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const files = walkFiles(normalizedRootDir);
  const previousEntries =
    previousManifest && typeof previousManifest === "object" ? previousManifest : {};
  return files.reduce((manifest, filePath) => {
    const relativePath = normalizeRelativePath(normalizedRootDir, filePath);
    const stat = fs.statSync(filePath);
    const previousEntry = previousEntries[relativePath];
    const canReusePreviousHash =
      typeof previousEntry === "object" &&
      previousEntry !== null &&
      !!previousEntry.hash &&
      Number.isFinite(previousEntry.mtimeMs) &&
      previousEntry.mtimeMs === stat.mtimeMs &&
      previousEntry.size === stat.size;
    manifest[relativePath] = {
      hash: canReusePreviousHash ? previousEntry.hash : hashFile(filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    return manifest;
  }, {});
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
  const manifest = buildWorkspaceManifest(rootDir, { previousManifest });
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(manifest),
    manifest,
  };
};

const kFingerprintWorkerScriptPath = path.join(__dirname, "fingerprint-worker.js");

// Parent-side wrapper around one persistent fingerprint worker thread. The
// worker is spawned lazily, reused across jobs, and recycled on error/exit so
// a crashed walk never wedges later snapshot requests.
const createWorkspaceSnapshotWorkerClient = ({
  workerScriptPath = kFingerprintWorkerScriptPath,
  createWorker = (scriptPath) => new Worker(scriptPath),
} = {}) => {
  let worker = null;
  let nextJobId = 1;
  const pendingJobs = new Map();

  const failPendingJobs = (error) => {
    const jobs = [...pendingJobs.values()];
    pendingJobs.clear();
    for (const job of jobs) job.reject(error);
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const spawned = createWorker(workerScriptPath);
    worker = spawned;
    spawned.on("message", (message) => {
      const job = pendingJobs.get(message?.jobId);
      if (!job) return;
      pendingJobs.delete(message.jobId);
      if (message.ok) job.resolve(message.snapshot);
      else job.reject(new Error(message.error || "Workspace snapshot worker failed"));
    });
    spawned.on("error", (error) => {
      if (worker === spawned) worker = null;
      spawned.terminate?.()?.catch?.(() => {});
      failPendingJobs(error instanceof Error ? error : new Error(String(error)));
    });
    spawned.on("exit", () => {
      if (worker === spawned) worker = null;
      failPendingJobs(new Error("Workspace snapshot worker exited"));
    });
    // The worker must never keep the server process alive on its own.
    spawned.unref?.();
    return spawned;
  };

  const computeWorkspaceSnapshotAsync = (workspaceRoot, { previousManifest = null } = {}) =>
    new Promise((resolve, reject) => {
      const jobId = nextJobId;
      nextJobId += 1;
      pendingJobs.set(jobId, { resolve, reject });
      try {
        ensureWorker().postMessage({ jobId, workspaceRoot, previousManifest });
      } catch (error) {
        pendingJobs.delete(jobId);
        reject(error);
      }
    });

  const terminate = async () => {
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

const getPathChangeWeight = (relativePath = "") => {
  const normalizedPath = String(relativePath || "").trim().toLowerCase();
  if (!normalizedPath) return 1;
  if (
    normalizedPath === "agents.md" ||
    normalizedPath === "tools.md" ||
    normalizedPath === "readme.md" ||
    normalizedPath === "bootstrap.md" ||
    normalizedPath === "memory.md" ||
    normalizedPath === "user.md" ||
    normalizedPath === "identity.md"
  ) {
    return 4;
  }
  if (normalizedPath.startsWith("hooks/bootstrap/")) return 4;
  if (normalizedPath.startsWith("skills/")) return 3;
  if (normalizedPath.endsWith(".md")) return 2;
  return 1;
};

const kByteDeltaSmallThreshold = 100;
const kByteDeltaSignificantThreshold = 500;

const getModifiedFileScore = (relativePath, previousEntry, currentEntry) => {
  if (!isContentFile(relativePath)) return 1;
  const previousSize = getManifestEntrySize(previousEntry);
  const currentSize = getManifestEntrySize(currentEntry);
  if (!previousSize && !currentSize) return getPathChangeWeight(relativePath);
  const byteDelta = Math.abs(currentSize - previousSize);
  if (byteDelta < kByteDeltaSmallThreshold) return 1;
  if (byteDelta < kByteDeltaSignificantThreshold) return 2;
  return getPathChangeWeight(relativePath);
};

const calculateWorkspaceDelta = ({ previousManifest = {}, currentManifest = {} } = {}) => {
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
      changeSummary.deltaScore += getPathChangeWeight(relativePath);
    } else if (previousHash && !currentHash) {
      changeSummary.removedFilesCount += 1;
      changeSummary.deltaScore += getPathChangeWeight(relativePath);
    } else if (previousHash !== currentHash) {
      changeSummary.modifiedFilesCount += 1;
      changeSummary.deltaScore += getModifiedFileScore(relativePath, previousEntry, currentEntry);
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
  createWorkspaceSnapshotWorkerClient,
  isContentFile,
};
