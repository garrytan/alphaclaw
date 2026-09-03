const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  writeFileAtomic,
  withFileLock,
  withFileLockSync,
} = require("../../lib/server/utils/safe-file");

describe("server/utils/safe-file", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-safe-file-"));
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("writeFileAtomic", () => {
    it("writes content and leaves no temp file behind", () => {
      const target = path.join(tempDir, "nested", "config.json");
      const result = writeFileAtomic(target, '{"a":1}');
      expect(result).toBe(target);
      expect(fs.readFileSync(target, "utf8")).toBe('{"a":1}');
      const leftovers = fs
        .readdirSync(path.dirname(target))
        .filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });

    it("overwrites an existing file atomically", () => {
      const target = path.join(tempDir, "config.json");
      fs.writeFileSync(target, "old");
      writeFileAtomic(target, "new");
      expect(fs.readFileSync(target, "utf8")).toBe("new");
    });

    it("cleans up the temp file when the rename fails", () => {
      const target = path.join(tempDir, "config.json");
      const unlinked = [];
      const fsModule = {
        mkdirSync: fs.mkdirSync.bind(fs),
        writeFileSync: fs.writeFileSync.bind(fs),
        renameSync: () => {
          throw new Error("rename exploded");
        },
        unlinkSync: (p) => {
          unlinked.push(p);
          fs.unlinkSync(p);
        },
      };
      expect(() => writeFileAtomic(target, "x", { fsModule })).toThrow(
        "rename exploded",
      );
      expect(unlinked).toHaveLength(1);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    });

    it("degrades to a plain write for mock fs without renameSync", () => {
      const writes = [];
      const fsModule = {
        mkdirSync: vi.fn(),
        writeFileSync: (p, content) => writes.push([p, content]),
      };
      const target = path.join(tempDir, "mocked.json");
      writeFileAtomic(target, "mock-content", { fsModule });
      // Exactly one write, straight to the final path — no .tmp indirection.
      expect(writes).toEqual([[target, "mock-content"]]);
    });
  });

  describe("withFileLockSync", () => {
    it("runs two sequential holders and cleans up the lockfile", () => {
      const target = path.join(tempDir, "registry.json");
      const order = [];
      const first = withFileLockSync(target, () => {
        order.push("first");
        expect(fs.existsSync(`${target}.lock`)).toBe(true);
        return "one";
      });
      const second = withFileLockSync(target, () => {
        order.push("second");
        return "two";
      });
      expect(first).toBe("one");
      expect(second).toBe("two");
      expect(order).toEqual(["first", "second"]);
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    });

    it("times out with ELOCKTIMEOUT when another process holds the lock", () => {
      const target = path.join(tempDir, "registry.json");
      // A fresh lock (current mtime) simulates a live foreign holder.
      fs.writeFileSync(`${target}.lock`, "99999");
      let caught = null;
      try {
        withFileLockSync(target, () => "never", { timeoutMs: 120 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(caught.code).toBe("ELOCKTIMEOUT");
      expect(caught.message).toContain(target);
      // The foreign lock is left alone.
      expect(fs.existsSync(`${target}.lock`)).toBe(true);
    });

    it("breaks a stale lock older than 30s", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, "12345");
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);

      const result = withFileLockSync(target, () => "ran", { timeoutMs: 500 });
      expect(result).toBe("ran");
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("runs unserialized for mock fs without openSync", () => {
      const fsModule = { mkdirSync: vi.fn(), writeFileSync: vi.fn() };
      const result = withFileLockSync(
        path.join(tempDir, "mock.json"),
        () => "unserialized",
        { fsModule },
      );
      expect(result).toBe("unserialized");
      expect(fsModule.mkdirSync).not.toHaveBeenCalled();
    });

    it("rethrows non-EEXIST lock errors", () => {
      const fsModule = {
        mkdirSync: vi.fn(),
        openSync: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      };
      expect(() =>
        withFileLockSync(path.join(tempDir, "f.json"), () => "x", { fsModule }),
      ).toThrow("EACCES");
    });
  });

  describe("withFileLock (async)", () => {
    it("acquires, runs, and releases the lock", async () => {
      const target = path.join(tempDir, "async.json");
      const result = await withFileLock(target, async () => {
        expect(fs.existsSync(`${target}.lock`)).toBe(true);
        return "async-ran";
      });
      expect(result).toBe("async-ran");
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    });

    it("times out with ELOCKTIMEOUT on a held lock", async () => {
      const target = path.join(tempDir, "async.json");
      fs.writeFileSync(`${target}.lock`, "held");
      await expect(
        withFileLock(target, async () => "never", { timeoutMs: 120 }),
      ).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
    });

    it("breaks a stale async lock older than 30s", async () => {
      const target = path.join(tempDir, "async.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, "stale");
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);

      const result = await withFileLock(target, async () => "ran", {
        timeoutMs: 500,
      });
      expect(result).toBe("ran");
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("excludes a sync holder's lock (shared protocol)", async () => {
      const target = path.join(tempDir, "cross.json");
      // Simulate a sync holder mid-write by creating the same lockfile shape.
      fs.writeFileSync(`${target}.lock`, String(process.pid));
      await expect(
        withFileLock(target, async () => "never", { timeoutMs: 120 }),
      ).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
    });
  });
});
