const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { readRegularFileBounded } = require("../../lib/server/utils/bounded-file");

describe("bounded nonblocking regular-file reader", () => {
  let root;
  let file;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-file-"));
    file = path.join(root, "input");
    fs.writeFileSync(file, "content");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("uses descriptor flags, bounded partial reads and injected filesystem methods", () => {
    const fsModule = { ...fs,
      openSync: vi.fn((...args) => fs.openSync(...args)),
      closeSync: vi.fn((...args) => fs.closeSync(...args)),
      readSync: vi.fn((fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, Math.min(length, 2), position)),
    };
    expect(readRegularFileBounded(file, { fsModule, maxBytes: 7 })).toBe("content");
    expect(fsModule.openSync.mock.calls[0][1]).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    expect(fsModule.readSync.mock.calls.length).toBeGreaterThan(1);
    expect(fsModule.closeSync).toHaveBeenCalledTimes(1);
    expect(readRegularFileBounded(file, { encoding: null })).toEqual(Buffer.from("content"));
  });

  it("rejects oversize files before reading and closes the descriptor on refusal", () => {
    const fsModule = { ...fs, readSync: vi.fn(), closeSync: vi.fn((...args) => fs.closeSync(...args)) };
    expect(() => readRegularFileBounded(file, { fsModule, maxBytes: 6 })).toThrow(expect.objectContaining({ code: "FILE_READ_LIMIT" }));
    expect(fsModule.readSync).not.toHaveBeenCalled();
    expect(fsModule.closeSync).toHaveBeenCalledTimes(1);
    expect(() => readRegularFileBounded(file, { maxBytes: -1 })).toThrow(TypeError);
    fs.writeFileSync(file, "");
    expect(readRegularFileBounded(file, { maxBytes: 0 })).toBe("");
  });

  it.each(["replace", "grow", "symlink"])("rejects %s during the read", (mode) => {
    let changed = false;
    const fsModule = { ...fs, readSync: (...args) => {
      const count = fs.readSync(...args);
      if (!changed) {
        changed = true;
        if (mode === "grow") fs.appendFileSync(file, "more");
        else {
          fs.renameSync(file, `${file}.old`);
          if (mode === "replace") fs.writeFileSync(file, "content");
          else fs.symlinkSync(`${file}.old`, file);
        }
      }
      return count;
    } };
    expect(() => readRegularFileBounded(file, { fsModule })).toThrow(expect.objectContaining({ code: "FILE_IDENTITY_CHANGED" }));
  });

  it("preserves symlinked parent roots while refusing a leaf symlink", () => {
    fs.mkdirSync(path.join(root, "actual"));
    fs.writeFileSync(path.join(root, "actual/config"), "data");
    fs.symlinkSync(path.join(root, "actual"), path.join(root, "logical"));
    expect(readRegularFileBounded(path.join(root, "logical/config"))).toBe("data");
    fs.symlinkSync(file, path.join(root, "leaf"));
    expect(() => readRegularFileBounded(path.join(root, "leaf"))).toThrow(expect.objectContaining({ code: "ELOOP" }));
  });

  it("refuses a real FIFO promptly without a writer", () => {
    fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const script = `try { require(process.argv[1]).readRegularFileBounded(process.argv[2]); process.exitCode = 1; } catch (error) { process.stdout.write(error.code); }`;
    expect(execFileSync(process.execPath, ["-e", script, require.resolve("../../lib/server/utils/bounded-file"), file], { encoding: "utf8", timeout: 1500 })).toBe("REGULAR_FILE_REQUIRED");
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });

  it("closes descriptors on read errors and rejects nonregular directories", () => {
    const closeSync = vi.fn((...args) => fs.closeSync(...args));
    expect(() => readRegularFileBounded(file, { fsModule: { ...fs, closeSync, readSync: () => { throw Object.assign(new Error("I/O failed"), { code: "EIO" }); } } })).toThrow(expect.objectContaining({ code: "EIO" }));
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(() => readRegularFileBounded(root)).toThrow(expect.objectContaining({ code: "REGULAR_FILE_REQUIRED" }));
  });
});
