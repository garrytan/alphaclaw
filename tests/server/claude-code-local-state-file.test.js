const {
  readStateFile,
  writeStateFile,
  clearStateFile,
} = require("../../lib/server/claude-code-local/state-file");

const kStateFilePath = "/data/claude-code-local/state.json";
const kTmpPath = `/data/claude-code-local/.state.json.${process.pid}.tmp`;
const kState = {
  sessionName: "alphaclaw-rescue",
  sessionId: "sess_0123456789",
  panePid: 4242,
};

const createFakeFs = () => {
  const files = new Map();
  const modes = new Map();
  return {
    files,
    modes,
    readFileSync: vi.fn((p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    }),
    writeFileSync: vi.fn((p, data, opts) => {
      files.set(p, String(data));
      modes.set(p, opts?.mode);
    }),
    renameSync: vi.fn((from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    }),
    rmSync: vi.fn((p) => {
      files.delete(p);
    }),
  };
};

const createFakeLogger = () => ({ warn: vi.fn() });

describe("claude-code-local state-file", () => {
  describe("readStateFile", () => {
    it("returns null silently on ENOENT (the normal cold case)", () => {
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      expect(readStateFile({ filePath: kStateFilePath, fsModule, logger })).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("returns the parsed object for a valid file", () => {
      const fsModule = createFakeFs();
      fsModule.files.set(kStateFilePath, JSON.stringify(kState));
      expect(readStateFile({ filePath: kStateFilePath, fsModule })).toEqual(kState);
    });

    it("returns null and warns on corrupt JSON", () => {
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      fsModule.files.set(kStateFilePath, "{ definitely not json");
      expect(readStateFile({ filePath: kStateFilePath, fsModule, logger })).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("corrupt");
    });

    it("returns null on valid-but-non-object JSON", () => {
      // JSON.parse succeeds here, so the corruption warning does not fire;
      // the value is simply unusable and collapses to the cold case.
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      fsModule.files.set(kStateFilePath, '"str"');
      expect(readStateFile({ filePath: kStateFilePath, fsModule, logger })).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("does not throw when the logger itself throws", () => {
      const fsModule = createFakeFs();
      fsModule.files.set(kStateFilePath, "{ corrupt");
      const logger = {
        warn: vi.fn(() => {
          throw new Error("logger down");
        }),
      };
      expect(readStateFile({ filePath: kStateFilePath, fsModule, logger })).toBeNull();
    });
  });

  describe("writeStateFile", () => {
    it("writes a 0600 temp file then renames it into place", () => {
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      const ok = writeStateFile({ filePath: kStateFilePath, state: kState, fsModule, logger });
      expect(ok).toBe(true);
      expect(fsModule.writeFileSync).toHaveBeenCalledWith(
        kTmpPath,
        `${JSON.stringify(kState, null, 2)}\n`,
        { mode: 0o600 },
      );
      expect(fsModule.modes.get(kTmpPath)).toBe(0o600);
      expect(fsModule.renameSync).toHaveBeenCalledWith(kTmpPath, kStateFilePath);
      expect(fsModule.files.has(kTmpPath)).toBe(false);
      expect(JSON.parse(fsModule.files.get(kStateFilePath))).toEqual(kState);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("returns false, cleans up the temp, and warns when the write fails", () => {
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      fsModule.writeFileSync.mockImplementation(() => {
        const err = new Error("ENOSPC: no space left on device");
        err.code = "ENOSPC";
        throw err;
      });
      const ok = writeStateFile({ filePath: kStateFilePath, state: kState, fsModule, logger });
      expect(ok).toBe(false);
      expect(fsModule.rmSync).toHaveBeenCalledWith(kTmpPath, { force: true });
      expect(fsModule.files.has(kTmpPath)).toBe(false);
      expect(fsModule.files.has(kStateFilePath)).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("ENOSPC");
    });

    it("returns false, cleans up the temp, and warns when the rename fails", () => {
      const fsModule = createFakeFs();
      const logger = createFakeLogger();
      fsModule.renameSync.mockImplementation(() => {
        const err = new Error("ENOSPC: rename failed");
        err.code = "ENOSPC";
        throw err;
      });
      const ok = writeStateFile({ filePath: kStateFilePath, state: kState, fsModule, logger });
      expect(ok).toBe(false);
      expect(fsModule.rmSync).toHaveBeenCalledWith(kTmpPath, { force: true });
      expect(fsModule.files.has(kTmpPath)).toBe(false);
      expect(fsModule.files.has(kStateFilePath)).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("write failed");
    });
  });

  describe("clearStateFile", () => {
    it("removes the file and is idempotent", () => {
      const fsModule = createFakeFs();
      fsModule.files.set(kStateFilePath, "{}");
      clearStateFile({ filePath: kStateFilePath, fsModule });
      expect(fsModule.files.has(kStateFilePath)).toBe(false);
      expect(() => clearStateFile({ filePath: kStateFilePath, fsModule })).not.toThrow();
      expect(fsModule.rmSync).toHaveBeenCalledTimes(2);
      expect(fsModule.rmSync).toHaveBeenCalledWith(kStateFilePath, { force: true });
    });

    it("swallows rmSync errors", () => {
      const fsModule = {
        rmSync: vi.fn(() => {
          throw new Error("EACCES");
        }),
      };
      expect(() => clearStateFile({ filePath: kStateFilePath, fsModule })).not.toThrow();
    });
  });
});
