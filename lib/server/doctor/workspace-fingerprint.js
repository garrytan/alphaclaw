const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const buildWorkspaceManifest = (rootDir) => {
  const normalizedRootDir = path.resolve(String(rootDir || ""));
  const files = walkFiles(normalizedRootDir);
  return files.reduce((manifest, filePath) => {
    // Files can vanish between the walk and the stat/hash (the agent deletes
    // and rewrites files constantly) — skip them instead of failing the scan.
    try {
      const stat = fs.statSync(filePath);
      manifest[normalizeRelativePath(normalizedRootDir, filePath)] = {
        hash: hashFile(filePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      // skip vanished/unreadable file
    }
    return manifest;
  }, {});
};

const kSnapshotMaxFiles = 50000;
const kSnapshotMaxFileBytes = 10 * 1024 * 1024;
const kSnapshotHashBatchSize = 200;
const kSnapshotBatchPauseMs = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const computeWorkspaceSnapshot = (rootDir) => {
  const manifest = buildWorkspaceManifest(rootDir);
  return {
    fingerprint: computeWorkspaceFingerprintFromManifest(manifest),
    manifest,
  };
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
  computeWorkspaceSnapshotBounded,
  isContentFile,
};
