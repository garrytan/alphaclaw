const fs = require("fs");
const os = require("os");
const path = require("path");

const crypto = require("crypto");

const {
  calculateWorkspaceDelta,
  computeWorkspaceFingerprintFromManifest,
  computeWorkspaceSnapshot,
  computeWorkspaceSnapshotBounded,
  createWorkspaceSnapshotWorkerClient,
  isContentFile,
  walkFiles,
} = require("../../lib/server/doctor/workspace-fingerprint");

const makeDirent = (name, isDir) => ({
  name,
  isDirectory: () => isDir,
  isFile: () => !isDir,
});

// Disk-free fake fs for scale tests: `layout` maps absolute dir paths to
// entry lists; files stat as tiny and hash as empty.
const makeFakeFs = (layout, { failStatFor = new Set(), failDirs = new Set() } = {}) => ({
  readdirSync: (dir) => {
    if (failDirs.has(dir)) {
      const error = new Error(`EACCES: ${dir}`);
      error.code = "EACCES";
      throw error;
    }
    const entries = layout[dir];
    if (!entries) {
      const error = new Error(`ENOENT: ${dir}`);
      error.code = "ENOENT";
      throw error;
    }
    return entries;
  },
  statSync: (filePath) => {
    if (failStatFor.has(filePath)) {
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    }
    return { size: 1, mtimeMs: 1 };
  },
  openSync: () => 1,
  readSync: () => 0,
  closeSync: () => {},
});

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

    it("survives a ~150k-file directory without a stack overflow (spread-push regression)", async () => {
      // The pre-0.9.49 recursive walk did files.push(...walkFiles(...)) — a
      // single subtree beyond ~100k paths threw RangeError before any cap
      // applied, burning the worker respawn budget.
      const root = path.sep === "/" ? "/wide" : "C:\\wide";
      const sub = path.join(root, "sub");
      const wideEntries = [];
      for (let index = 0; index < 150000; index += 1) {
        wideEntries.push(makeDirent(`f${String(index).padStart(6, "0")}.md`, false));
      }
      const fakeFs = makeFakeFs({ [root]: [makeDirent("sub", true)], [sub]: wideEntries });

      const snapshot = await computeWorkspaceSnapshotBounded(root, {
        fsModule: fakeFs,
        maxFiles: 1000,
        batchPauseMs: 0,
      });

      expect(snapshot.stats.totalFiles).toBe(150000);
      expect(Object.keys(snapshot.manifest)).toHaveLength(1000);
      expect(snapshot.limited).toBe(true);
      expect(snapshot.capsUsed).toEqual({ maxFiles: 1000, maxFileBytes: expect.any(Number) });
    });

    it("survives a 10k-deep directory chain (recursion-depth regression)", () => {
      // Entries computed from path depth (a materialized 10k-key layout map
      // with quadratically growing keys makes this test take ~15s for
      // nothing). One subdir + one file per level, leaf level file-only.
      const kDepth = 10000;
      const fakeFs = {
        readdirSync: (dir) => {
          const depth = String(dir).split(path.sep).length - 2;
          return depth < kDepth - 1
            ? [makeDirent("d", true), makeDirent("leaf.md", false)]
            : [makeDirent("leaf.md", false)];
        },
        statSync: () => ({ size: 1, mtimeMs: 1 }),
      };
      // Store only a handful of paths: the assertion is about traversal
      // depth, not path accumulation.
      const walk = walkFiles(path.sep + "deep", { fsModule: fakeFs, maxStoredFiles: 5 });
      expect(walk.totalFiles).toBe(kDepth);
      expect(walk.skippedDirCount).toBe(0);
      expect(walk.files).toHaveLength(5);
    });

    it("saturates the walk ceiling instead of enumerating forever", () => {
      const root = "/huge";
      const entries = [];
      for (let index = 0; index < 5000; index += 1) {
        entries.push(makeDirent(`f${index}.md`, false));
      }
      const walk = walkFiles(root, {
        fsModule: makeFakeFs({ [root]: entries }),
        maxStoredFiles: 10,
        maxEntries: 2500,
      });
      expect(walk.saturated).toBe(true);
      expect(walk.totalFiles).toBe(2500);
      expect(walk.files).toHaveLength(10);
    });

    it("skips unreadable directories instead of killing the scan", async () => {
      const root = "/perm";
      const locked = `${root}/locked`;
      const fakeFs = makeFakeFs(
        {
          [root]: [
            makeDirent("a.md", false),
            makeDirent("locked", true),
            makeDirent("z.md", false),
          ],
        },
        { failDirs: new Set([locked]) },
      );
      const snapshot = await computeWorkspaceSnapshotBounded(root, {
        fsModule: fakeFs,
        batchPauseMs: 0,
      });
      expect(Object.keys(snapshot.manifest).sort()).toEqual(["a.md", "z.md"]);
      expect(snapshot.stats.skippedDirCount).toBe(1);
      // An unreadable subtree is genuinely unscanned content.
      expect(snapshot.limited).toBe(true);
    });

    it("tolerates files vanishing between the walk and the stat (agent churn)", async () => {
      const root = "/race";
      const fakeFs = makeFakeFs(
        { [root]: [makeDirent("gone.md", false), makeDirent("kept.md", false)] },
        { failStatFor: new Set([path.join(root, "gone.md")]) },
      );
      const snapshot = await computeWorkspaceSnapshotBounded(root, {
        fsModule: fakeFs,
        batchPauseMs: 0,
      });
      expect(Object.keys(snapshot.manifest)).toEqual(["kept.md"]);
      expect(snapshot.stats.erroredCount).toBe(1);
      // Transient churn is NOT "limited" — it would flip the banner hourly.
      expect(snapshot.limited).toBe(false);
    });

    it("hashes multi-chunk files correctly with the streaming reader", async () => {
      const content = Buffer.alloc(2.5 * 1024 * 1024, 7);
      const rootDir = createWorkspace({ "big.bin": content });
      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        batchPauseMs: 0,
      });
      expect(snapshot.manifest["big.bin"].hash).toBe(
        crypto.createHash("sha256").update(content).digest("hex"),
      );
    });

    it("skips whole-file hashing past the total hash-byte budget and counts it", async () => {
      const rootDir = createWorkspace({
        "a.bin": Buffer.alloc(600, 1),
        "b.bin": Buffer.alloc(600, 2),
      });
      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        maxTotalHashBytes: 1000,
        batchPauseMs: 0,
      });
      expect(snapshot.stats.hashBudgetSkippedCount).toBe(1);
      expect(snapshot.stats.hashBudgetExhausted).toBe(true);
      expect(snapshot.limited).toBe(true);
    });

    it("ignores tool-owned directories (dist, .venv, __pycache__, …)", async () => {
      const rootDir = createWorkspace({
        "src/a.md": "keep\n",
        "dist/bundle.js": "drop\n",
        ".venv/lib/x.py": "drop\n",
        "__pycache__/x.pyc": "drop\n",
        "coverage/lcov.info": "drop\n",
        "build/keep.md": "generic names can hold source — NOT ignored\n",
      });
      const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
        batchPauseMs: 0,
      });
      expect(Object.keys(snapshot.manifest).sort()).toEqual([
        "build/keep.md",
        "src/a.md",
      ]);
    });

    it("busts the fingerprint when the file count changes BEYOND the cap", async () => {
      // Stale-reuse guard: with identical manifests (first 2 files), a file
      // added past the cap must still change the fingerprint — otherwise
      // edits among excluded files serve stale "no change" doctor runs.
      const rootDir = createWorkspace({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
      const first = await computeWorkspaceSnapshotBounded(rootDir, {
        maxFiles: 2,
        batchPauseMs: 0,
      });
      fs.writeFileSync(path.join(rootDir, "d.md"), "d\n");
      const second = await computeWorkspaceSnapshotBounded(rootDir, {
        previousManifest: first.manifest,
        maxFiles: 2,
        batchPauseMs: 0,
      });
      expect(second.manifest).toEqual(first.manifest);
      expect(second.fingerprint).not.toBe(first.fingerprint);
    });

    it("keeps the capped subset deterministic across scans", async () => {
      const rootDir = createWorkspace({
        "b.md": "b\n",
        "a.md": "a\n",
        "sub/x.md": "x\n",
        "c.md": "c\n",
      });
      const first = await computeWorkspaceSnapshotBounded(rootDir, {
        maxFiles: 3,
        batchPauseMs: 0,
      });
      const second = await computeWorkspaceSnapshotBounded(rootDir, {
        maxFiles: 3,
        batchPauseMs: 0,
      });
      // Pin the ORDER SEMANTICS, not just scan-to-scan equality: per-dir
      // localeCompare, DFS in-order — the capped subset is the first N in
      // that exact order. A traversal-order change here silently swaps which
      // files a capped workspace fingerprints.
      expect(Object.keys(first.manifest)).toEqual(["a.md", "b.md", "c.md"]);
      expect(Object.keys(second.manifest)).toEqual(Object.keys(first.manifest));
      expect(second.fingerprint).toBe(first.fingerprint);
    });

    it("throws loudly on an unreadable workspace root (never an empty 'no drift' scan)", async () => {
      const missingRoot = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "bounded-missing-")),
        "does-not-exist",
      );
      await expect(
        computeWorkspaceSnapshotBounded(missingRoot, { batchPauseMs: 0 }),
      ).rejects.toThrow(/Workspace root is not readable/);
      expect(() => computeWorkspaceSnapshot(missingRoot)).toThrow(
        /Workspace root is not readable/,
      );
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

  describe("worker client protocol", () => {
    const makeFakeWorker = () => {
      const listeners = new Map();
      const worker = {
        posted: [],
        on: (event, handler) => listeners.set(event, handler),
        postMessage: (message) => worker.posted.push(message),
        emitMessage: (message) => listeners.get("message")?.(message),
        terminate: async () => {},
        unref: () => {},
      };
      return worker;
    };

    it("forwards caps and previousFingerprint through postMessage", async () => {
      const worker = makeFakeWorker();
      const client = createWorkspaceSnapshotWorkerClient({
        createWorker: () => worker,
      });
      const previousManifest = { "a.md": { hash: "h", size: 1, mtimeMs: 1 } };
      const pending = client.computeWorkspaceSnapshotAsync("/ws", {
        previousManifest,
        previousFingerprint: "fp-1",
        maxFiles: 123,
        maxFileBytes: 456,
      });
      expect(worker.posted).toEqual([
        {
          jobId: 1,
          workspaceRoot: "/ws",
          previousManifest,
          previousFingerprint: "fp-1",
          maxFiles: 123,
          maxFileBytes: 456,
        },
      ]);
      worker.emitMessage({ jobId: 1, ok: true, snapshot: { fingerprint: "fp-2", manifest: {} } });
      await expect(pending).resolves.toMatchObject({ fingerprint: "fp-2" });
      await client.terminate();
    });

    it("REAL worker: keeps fresh mtimes for touched-but-identical files (no perpetual re-hash)", async () => {
      // Regression for the adversarially-confirmed X12 defect: omitting the
      // manifest purely on fingerprint equality restored STALE mtimes, so a
      // file rewritten with identical content re-hashed on every refresh
      // forever (and bled the hash-byte budget). The worker must only omit
      // when NOTHING was re-hashed.
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mtime-"));
      fs.writeFileSync(path.join(rootDir, "a.md"), "same content\n");
      const client = createWorkspaceSnapshotWorkerClient();
      try {
        const first = await client.computeWorkspaceSnapshotAsync(rootDir, {});
        expect(first.stats.hashedCount).toBe(1);

        // Touch with IDENTICAL content but a bumped mtime (codegen churn).
        const bumped = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(rootDir, "a.md"), bumped, bumped);

        const second = await client.computeWorkspaceSnapshotAsync(rootDir, {
          previousManifest: first.manifest,
          previousFingerprint: first.fingerprint,
        });
        // Same fingerprint, but one file re-hashed — the fresh manifest
        // (with the NEW mtime) must come back, not manifestUnchanged.
        expect(second.fingerprint).toBe(first.fingerprint);
        expect(second.stats.hashedCount).toBe(1);
        expect(second.manifest["a.md"].mtimeMs).not.toBe(first.manifest["a.md"].mtimeMs);

        // Third scan with the fresh manifest: pure reuse, and NOW the worker
        // may omit (nothing re-hashed).
        const third = await client.computeWorkspaceSnapshotAsync(rootDir, {
          previousManifest: second.manifest,
          previousFingerprint: second.fingerprint,
        });
        expect(third.stats.hashedCount).toBe(0);
        expect(third.stats.reusedCount).toBe(1);
        expect(third.manifest).toEqual(second.manifest);
      } finally {
        await client.terminate();
      }
    }, 30000);

    it("restores the caller's manifest when the worker omits an unchanged one", async () => {
      const worker = makeFakeWorker();
      const client = createWorkspaceSnapshotWorkerClient({
        createWorker: () => worker,
      });
      const previousManifest = { "a.md": { hash: "h", size: 1, mtimeMs: 1 } };
      const pending = client.computeWorkspaceSnapshotAsync("/ws", {
        previousManifest,
        previousFingerprint: "fp-1",
      });
      // No-change refresh: the worker skips the multi-MB manifest clone.
      worker.emitMessage({
        jobId: 1,
        ok: true,
        snapshot: { fingerprint: "fp-1", manifest: null, manifestUnchanged: true },
      });
      const snapshot = await pending;
      expect(snapshot.manifest).toBe(previousManifest);
      expect(snapshot.fingerprint).toBe("fp-1");
      await client.terminate();
    });
  });
});

describe("server/doctor/workspace-fingerprint adversarial regressions", () => {
  const createWorkspace = (files) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-snapshot-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(rootDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    return rootDir;
  };

  it("bounds the streaming hash at the stat'd size (a growing file cannot hang the scan)", async () => {
    const rootDir = createWorkspace({ "grow.log": "start" });
    const filePath = path.join(rootDir, "grow.log");
    const realStat = fs.statSync(filePath);
    // Fake fs where the file yields data FOREVER (an aggressively appended
    // file whose writer outpaces the reader): only the stat'd byte count may
    // be consumed.
    let totalRead = 0;
    const endlessFs = {
      ...fs,
      readdirSync: fs.readdirSync.bind(fs),
      statSync: () => realStat,
      openSync: () => 42,
      closeSync: () => {},
      readSync: (fd, buffer, offset, length) => {
        totalRead += length;
        if (totalRead > 10 * 1024 * 1024) {
          throw new Error("unbounded read: hash ignored the stat'd size");
        }
        buffer.fill(65, 0, length);
        return length; // never EOF
      },
    };
    const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
      fsModule: endlessFs,
      batchPauseMs: 0,
    });
    expect(snapshot.stats.hashedCount).toBe(1);
    expect(totalRead).toBe(realStat.size);
  });

  it("flags persistently unreadable files as limited (EACCES ≠ transient churn)", async () => {
    const rootDir = createWorkspace({ "ok.md": "fine\n", "secret.md": "locked\n" });
    const lockedPath = path.join(rootDir, "secret.md");
    const eaccesFs = {
      ...fs,
      readdirSync: fs.readdirSync.bind(fs),
      statSync: (p) => {
        if (p === lockedPath) {
          const error = new Error("EACCES: permission denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.statSync(p);
      },
    };
    const snapshot = await computeWorkspaceSnapshotBounded(rootDir, {
      fsModule: eaccesFs,
      batchPauseMs: 0,
    });
    expect(snapshot.stats.unreadableCount).toBe(1);
    expect(snapshot.stats.erroredCount).toBe(0);
    // Persistent permission failures are genuinely unscanned content.
    expect(snapshot.limited).toBe(true);
  });
});
