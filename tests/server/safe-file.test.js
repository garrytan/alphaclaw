const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  writeFileAtomic,
  withFileLockSync,
  kDefaultLockTimeoutMs,
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

    it("fsyncs the temp file BEFORE the rename and the directory AFTER it", () => {
      const target = path.join(tempDir, "durable.json");
      const calls = [];
      const fsModule = {
        mkdirSync: fs.mkdirSync.bind(fs),
        writeFileSync: (p, c, o) => {
          calls.push(["write", p]);
          fs.writeFileSync(p, c, o);
        },
        openSync: (p, flags) => {
          calls.push(["open", p]);
          return fs.openSync(p, flags);
        },
        fsyncSync: (fd) => {
          calls.push(["fsync", fd]);
          fs.fsyncSync(fd);
        },
        closeSync: fs.closeSync.bind(fs),
        renameSync: (a, b) => {
          calls.push(["rename", a, b]);
          fs.renameSync(a, b);
        },
        unlinkSync: fs.unlinkSync.bind(fs),
      };
      writeFileAtomic(target, "durable", { fsModule });
      expect(fs.readFileSync(target, "utf8")).toBe("durable");
      const kinds = calls.map((c) => c[0]);
      expect(kinds).toEqual(["write", "open", "fsync", "rename", "open", "fsync"]);
      // First open is the temp file; the open after the rename is the directory.
      expect(calls[1][1]).toMatch(/\.tmp$/);
      expect(calls[4][1]).toBe(tempDir);
    });

    it("skips both fsyncs with durable:false", () => {
      const target = path.join(tempDir, "hot.json");
      const fsyncs = [];
      const fsModule = {
        ...fs,
        fsyncSync: (fd) => fsyncs.push(fd),
      };
      writeFileAtomic(target, "hot", { fsModule, durable: false });
      expect(fs.readFileSync(target, "utf8")).toBe("hot");
      expect(fsyncs).toEqual([]);
    });

    it("leaves the original intact when the temp write fails", () => {
      const target = path.join(tempDir, "config.json");
      fs.writeFileSync(target, "original");
      const fsModule = {
        ...fs,
        writeFileSync: () => {
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
      };
      expect(() => writeFileAtomic(target, "new", { fsModule })).toThrow("ENOSPC");
      expect(fs.readFileSync(target, "utf8")).toBe("original");
      expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
    });

    it("leaves the original intact and discards the temp when the file fsync fails", () => {
      const target = path.join(tempDir, "config.json");
      fs.writeFileSync(target, "original");
      const fsModule = {
        ...fs,
        fsyncSync: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      };
      expect(() => writeFileAtomic(target, "new", { fsModule })).toThrow("EIO");
      expect(fs.readFileSync(target, "utf8")).toBe("original");
      expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
    });

    it("installs the new content even when the directory fsync fails (best-effort)", () => {
      const target = path.join(tempDir, "config.json");
      fs.writeFileSync(target, "original");
      let fsyncCount = 0;
      const fsModule = {
        ...fs,
        fsyncSync: (fd) => {
          fsyncCount += 1;
          if (fsyncCount === 2) throw new Error("dir fsync unsupported");
          fs.fsyncSync(fd);
        },
      };
      expect(() => writeFileAtomic(target, "new", { fsModule })).not.toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("new");
      expect(fs.readdirSync(tempDir)).toEqual(["config.json"]);
    });

    it("leaves the original intact when the temp cleanup after a failed rename also fails", () => {
      const target = path.join(tempDir, "config.json");
      fs.writeFileSync(target, "original");
      const fsModule = {
        ...fs,
        renameSync: () => {
          throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        },
        unlinkSync: () => {
          throw new Error("unlink failed too");
        },
      };
      expect(() => writeFileAtomic(target, "new", { fsModule })).toThrow("EXDEV");
      expect(fs.readFileSync(target, "utf8")).toBe("original");
    });

    it("applies mode on a fresh inode (0600 survives an existing 0644 file)", () => {
      const target = path.join(tempDir, "secret.json");
      fs.writeFileSync(target, "old", { mode: 0o644 });
      writeFileAtomic(target, "new", { mode: 0o600 });
      expect(fs.readFileSync(target, "utf8")).toBe("new");
      if (process.platform !== "win32") {
        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      }
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

    it("times out with ELOCKTIMEOUT when another process holds the lock, naming the holder", () => {
      const target = path.join(tempDir, "registry.json");
      // A fresh lock (current mtime) simulates a live foreign holder.
      fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 99999 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let caught = null;
      try {
        withFileLockSync(target, () => "never", { timeoutMs: 120 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeTruthy();
      expect(caught.code).toBe("ELOCKTIMEOUT");
      expect(caught.holderPid).toBe(99999);
      expect(caught.message).toContain(target);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("pid 99999"));
      // The foreign lock is left alone.
      expect(fs.existsSync(`${target}.lock`)).toBe(true);
    });

    it("defaults the wait to 1000ms (was 5000ms) so a held lock fails fast", () => {
      const target = path.join(tempDir, "registry.json");
      fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 99999 }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(kDefaultLockTimeoutMs).toBe(1000);
      const started = Date.now();
      expect(() => withFileLockSync(target, () => "never")).toThrow(/Timed out/);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it("writes a JSON lock record with pid, token and start time", () => {
      const target = path.join(tempDir, "registry.json");
      withFileLockSync(target, () => {
        const record = JSON.parse(fs.readFileSync(`${target}.lock`, "utf8"));
        expect(record.pid).toBe(process.pid);
        expect(typeof record.token).toBe("string");
        expect(record.token.length).toBeGreaterThan(8);
        expect(typeof record.startedAt).toBe("number");
        expect("start" in record).toBe(true);
      });
    });

    it("keeps waiting on an OLD lock whose holder is still alive (never steals a live lock)", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      // Our own pid is provably alive; record the real start ticks so the
      // PID-reuse check passes too.
      withFileLockSync(target, () => {});
      const record = { pid: process.pid, token: "t", startedAt: Date.now() - 60_000 };
      const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      record.start = Number(rest[19]);
      fs.writeFileSync(lockPath, JSON.stringify(record));
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => withFileLockSync(target, () => "never", { timeoutMs: 150 })).toThrow(
        /Timed out/,
      );
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    it("breaks an old lock whose pid is alive but recycled (start time differs)", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      // Same pid as this process, but a start time that cannot match.
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token: "t", startedAt: 0, start: 1 }),
      );
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);
      const result = withFileLockSync(target, () => "ran", { timeoutMs: 500 });
      expect(result).toBe("ran");
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("breaks a stale lock via rename-claim so only one waiter wins", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);
      const renames = [];
      const unlinks = [];
      const fsModule = {
        ...fs,
        renameSync: (a, b) => {
          renames.push([a, b]);
          fs.renameSync(a, b);
        },
        unlinkSync: (p) => {
          unlinks.push(p);
          fs.unlinkSync(p);
        },
      };
      const result = withFileLockSync(target, () => "ran", { fsModule, timeoutMs: 500 });
      expect(result).toBe("ran");
      // The stale lock was renamed to a private claim path, then that claim
      // was unlinked — the shared lock path itself was never unlinked while
      // it could still belong to another waiter.
      expect(renames).toHaveLength(1);
      expect(renames[0][0]).toBe(lockPath);
      expect(renames[0][1]).toMatch(/\.lock\.stale\./);
      expect(unlinks[0]).toBe(renames[0][1]);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    });

    it("retries instead of failing when another waiter claims the stale lock first", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
      const staleSeconds = (Date.now() - 60_000) / 1000;
      fs.utimesSync(lockPath, staleSeconds, staleSeconds);
      let stolen = false;
      const fsModule = {
        ...fs,
        renameSync: (a, b) => {
          if (!stolen && a === lockPath) {
            stolen = true;
            // Simulate the other waiter winning the claim: the lock is gone.
            fs.unlinkSync(lockPath);
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          fs.renameSync(a, b);
        },
      };
      const result = withFileLockSync(target, () => "ran", { fsModule, timeoutMs: 500 });
      expect(result).toBe("ran");
      expect(stolen).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("breaks a stale legacy bare-pid lock older than 30s whose pid is dead", () => {
      const target = path.join(tempDir, "registry.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, "4194304"); // above pid_max on Linux — never alive
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
});
