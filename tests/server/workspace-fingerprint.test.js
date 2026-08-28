const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  calculateWorkspaceDelta,
  computeWorkspaceFingerprintFromManifest,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotBounded,
  isContentFile,
} = require("../../lib/server/doctor/workspace-fingerprint");

describe("server/doctor/workspace-fingerprint", () => {
  it("classifies content files by extension", () => {
    expect(isContentFile("docs/notes.md")).toBe(true);
    expect(isContentFile("data.bin")).toBe(false);
    expect(isContentFile("")).toBe(false);
  });

  it("computes a stable fingerprint regardless of manifest key order", () => {
    const first = computeWorkspaceFingerprintFromManifest({
      "a.md": { hash: "h1", size: 10 },
      "b.md": { hash: "h2", size: 20 },
    });
    const second = computeWorkspaceFingerprintFromManifest({
      "b.md": { hash: "h2", size: 20 },
      "a.md": { hash: "h1", size: 10 },
    });
    expect(first).toBe(second);
  });

  it("scores added, removed, and modified files with path and byte-delta weights", () => {
    const previousManifest = {
      "docs/notes.md": { hash: "a", size: 1000 },
      "docs/big.md": { hash: "c", size: 100 },
      "gone.md": { hash: "g", size: 5 },
      "same.md": { hash: "s", size: 3 },
    };
    const currentManifest = {
      "docs/notes.md": { hash: "b", size: 1200 },
      "docs/big.md": { hash: "d", size: 700 },
      "data.bin": { hash: "x", size: 10 },
      "same.md": { hash: "s", size: 3 },
    };

    const delta = calculateWorkspaceDelta({ previousManifest, currentManifest });

    expect(delta.addedFilesCount).toBe(1);
    expect(delta.removedFilesCount).toBe(1);
    expect(delta.modifiedFilesCount).toBe(2);
    expect(delta.changedFilesCount).toBe(4);
    // notes.md: byte delta 200 => 2; big.md: byte delta 600 => weight 2 (plain .md);
    // gone.md removed => weight 2; data.bin added => weight 1
    expect(delta.deltaScore).toBe(7);
    expect(delta.changedPaths).toEqual([
      "data.bin",
      "docs/big.md",
      "docs/notes.md",
      "gone.md",
    ]);
  });

  it("scores small modifications and non-content files with minimal weight", () => {
    const delta = calculateWorkspaceDelta({
      previousManifest: {
        "docs/notes.md": { hash: "a", size: 1000 },
        "blob.bin": { hash: "p", size: 100 },
      },
      currentManifest: {
        "docs/notes.md": { hash: "b", size: 1050 },
        "blob.bin": { hash: "q", size: 100000 },
      },
    });

    // notes.md byte delta 50 (<100) => 1; blob.bin not a content file => 1
    expect(delta.modifiedFilesCount).toBe(2);
    expect(delta.deltaScore).toBe(2);
  });

  it("uses the path weight when modified content sizes are unavailable", () => {
    const delta = calculateWorkspaceDelta({
      previousManifest: { "AGENTS.md": "hash-a" },
      currentManifest: { "AGENTS.md": "hash-b" },
    });

    expect(delta.modifiedFilesCount).toBe(1);
    expect(delta.deltaScore).toBe(4);
  });

  it("weights special guidance paths higher for additions", () => {
    const delta = calculateWorkspaceDelta({
      previousManifest: {},
      currentManifest: {
        "hooks/bootstrap/AGENTS.md": { hash: "a", size: 1 },
        "skills/foo.md": { hash: "b", size: 1 },
      },
    });

    expect(delta.addedFilesCount).toBe(2);
    expect(delta.deltaScore).toBe(7);
  });

  describe("computeWorkspaceSnapshotBounded", () => {
    const createWorkspace = (files) => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-snapshot-"));
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(rootDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      }
      return rootDir;
    };

    it("reuses previous hashes for files with unchanged size and mtime", async () => {
      const rootDir = createWorkspace({
        "a.md": "alpha content\n",
        "b.md": "beta content\n",
        "c.md": "gamma content\n",
      });

      const first = await computeWorkspaceSnapshotBounded(rootDir, {
        batchPauseMs: 0,
      });
      expect(first.stats.hashedCount).toBe(3);
      expect(first.stats.reusedCount).toBe(0);

      // Touch ONE file with new content of a different size: only that file
      // is rehashed, the rest reuse their previous manifest hashes.
      fs.writeFileSync(path.join(rootDir, "b.md"), "beta content grew significantly\n");
      const second = await computeWorkspaceSnapshotBounded(rootDir, {
        previousManifest: first.manifest,
        batchPauseMs: 0,
      });

      expect(second.stats.hashedCount).toBe(1);
      expect(second.stats.reusedCount).toBe(2);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(second.manifest["a.md"].hash).toBe(first.manifest["a.md"].hash);
      expect(second.manifest["c.md"].hash).toBe(first.manifest["c.md"].hash);
      expect(second.manifest["b.md"].hash).not.toBe(first.manifest["b.md"].hash);
    });

    it("caps the scanned files at maxFiles and flags the snapshot as limited", async () => {
      const rootDir = createWorkspace({
        "a.md": "a\n",
        "b.md": "b\n",
        "c.md": "c\n",
        "d.md": "d\n",
        "e.md": "e\n",
      });

      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        maxFiles: 3,
        batchPauseMs: 0,
      });

      expect(snapshot.limited).toBe(true);
      expect(Object.keys(snapshot.manifest)).toHaveLength(3);
      expect(snapshot.stats.totalFiles).toBe(5);
    });

    it("skips files above maxFileBytes and counts them", async () => {
      const rootDir = createWorkspace({
        "small.md": "small file\n",
        "big.md": "B".repeat(2048),
      });

      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        maxFileBytes: 1024,
        batchPauseMs: 0,
      });

      expect(snapshot.manifest["big.md"]).toBeUndefined();
      expect(snapshot.manifest["small.md"]).toBeDefined();
      expect(snapshot.stats.skippedLargeCount).toBe(1);
      expect(snapshot.stats.hashedCount).toBe(1);
      // A skipped-for-size file is EXCLUDED from the fingerprint, so drift
      // detection is limited — the doctor must say so.
      expect(snapshot.limited).toBe(true);
    });

    it("matches the sync fingerprint when no bounds are hit", async () => {
      const rootDir = createWorkspace({
        "AGENTS.md": "# Guidance\n",
        "docs/notes.md": "notes\n",
        "data.bin": Buffer.from([9, 8, 7]),
      });

      const bounded = await computeWorkspaceSnapshotBounded(rootDir, {
        batchPauseMs: 0,
      });
      const sync = computeWorkspaceSnapshot(rootDir);

      expect(bounded.limited).toBe(false);
      expect(bounded.fingerprint).toBe(sync.fingerprint);
      expect(bounded.manifest).toEqual(sync.manifest);
    });
  });
});
