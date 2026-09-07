// AlphaClaw self-version stamp (#76 / A8): the per-boot
// <managedDir>/alphaclaw-version.json record, its lenient reader, the git
// '#<ref>' spec parsing and the one-line boot banner bin/alphaclaw.js prints.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kSelfVersionFileName,
  parseCommitFromSpec,
  readSelfVersionStamp,
  stampSelfVersionAtBoot,
  formatBootBanner,
} = require("../../lib/server/alphaclaw-self-version");

const kGitSpec = "git+https://github.com/garrytan/alphaclaw.git#abc123";

const makeLogger = () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() });

describe("alphaclaw-self-version: parseCommitFromSpec", () => {
  it("returns the '#<ref>' fragment of a git dependency spec", () => {
    expect(parseCommitFromSpec(kGitSpec)).toBe("abc123");
    expect(parseCommitFromSpec("github:garrytan/alphaclaw#main")).toBe("main");
    expect(parseCommitFromSpec("git+ssh://git@github.com/o/r.git#v0.9.77")).toBe("v0.9.77");
    expect(parseCommitFromSpec("github:o/r#refs/heads/release-1.x")).toBe("refs/heads/release-1.x");
  });

  it("is null for npm installs — ranges, exact versions, tags, file paths have no fragment", () => {
    expect(parseCommitFromSpec("^0.9.76")).toBeNull();
    expect(parseCommitFromSpec("0.9.76")).toBeNull();
    expect(parseCommitFromSpec("latest")).toBeNull();
    expect(parseCommitFromSpec("file:../alphaclaw")).toBeNull();
    expect(parseCommitFromSpec("git+https://github.com/o/r.git")).toBeNull();
  });

  it("is null for a missing spec and for fragments that are not a ref", () => {
    expect(parseCommitFromSpec(null)).toBeNull();
    expect(parseCommitFromSpec(undefined)).toBeNull();
    expect(parseCommitFromSpec("")).toBeNull();
    expect(parseCommitFromSpec("github:o/r#")).toBeNull();
    // npm's semver-range fragment selects a tag by range; it is not a commit.
    expect(parseCommitFromSpec("github:o/r#semver:^1.0")).toBeNull();
    // Shell metacharacters never reach the banner verbatim.
    expect(parseCommitFromSpec("github:o/r#main; rm -rf /")).toBeNull();
  });
});

describe("alphaclaw-self-version: stampSelfVersionAtBoot", () => {
  let tempDir = "";
  let managedDir = "";
  let logger;
  const stampFile = () => path.join(managedDir, kSelfVersionFileName);
  const readFile = () => JSON.parse(fs.readFileSync(stampFile(), "utf8"));

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-self-version-"));
    managedDir = path.join(tempDir, ".openclaw", ".alphaclaw");
    logger = makeLogger();
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("first boot: creates the managed dir and writes a bootCount-1 record with no previous", () => {
    expect(fs.existsSync(managedDir)).toBe(false);
    const result = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: kGitSpec,
      nowFn: () => 1_000,
      managedDir,
      logger,
    });
    expect(result).toEqual({
      changed: true,
      previousVersion: null,
      record: {
        version: "0.9.77",
        commit: "abc123",
        firstBootAt: 1_000,
        lastBootAt: 1_000,
        bootCount: 1,
        previous: null,
      },
    });
    expect(readFile()).toEqual(result.record);
    // Pretty-printed with a trailing newline, like the other managed records.
    expect(fs.readFileSync(stampFile(), "utf8")).toBe(`${JSON.stringify(result.record, null, 2)}\n`);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("first boot of an npm install records commit null", () => {
    const { record } = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: "^0.9.77",
      nowFn: () => 1_000,
      managedDir,
      logger,
    });
    expect(record.commit).toBeNull();
    expect(readFile().commit).toBeNull();
  });

  it("same version repeat: bootCount++ and lastBootAt move, firstBootAt and previous stay", () => {
    stampSelfVersionAtBoot({ version: "0.9.77", spec: kGitSpec, nowFn: () => 1_000, managedDir, logger });
    const second = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: kGitSpec,
      nowFn: () => 2_000,
      managedDir,
      logger,
    });
    expect(second.changed).toBe(false);
    expect(second.previousVersion).toBe("0.9.77");
    expect(second.record).toEqual({
      version: "0.9.77",
      commit: "abc123",
      firstBootAt: 1_000,
      lastBootAt: 2_000,
      bootCount: 2,
      previous: null,
    });
    const third = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: kGitSpec,
      nowFn: () => 3_000,
      managedDir,
      logger,
    });
    expect(third.record.bootCount).toBe(3);
    expect(third.record.firstBootAt).toBe(1_000);
    expect(readFile()).toEqual(third.record);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a re-pinned commit under the same version is recorded but is not a change", () => {
    stampSelfVersionAtBoot({ version: "0.9.77", spec: kGitSpec, nowFn: () => 1_000, managedDir, logger });
    const result = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: "git+https://github.com/garrytan/alphaclaw.git#def456",
      nowFn: () => 2_000,
      managedDir,
      logger,
    });
    expect(result.changed).toBe(false);
    expect(result.record.commit).toBe("def456");
    expect(result.record.bootCount).toBe(2);
  });

  it("version change: previous is populated from the outgoing record, counters reset, changed is true", () => {
    stampSelfVersionAtBoot({ version: "0.9.76", spec: kGitSpec, nowFn: () => 1_000, managedDir, logger });
    stampSelfVersionAtBoot({ version: "0.9.76", spec: kGitSpec, nowFn: () => 2_000, managedDir, logger });
    const upgraded = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: "git+https://github.com/garrytan/alphaclaw.git#def456",
      nowFn: () => 3_000,
      managedDir,
      logger,
    });
    expect(upgraded).toEqual({
      changed: true,
      previousVersion: "0.9.76",
      record: {
        version: "0.9.77",
        commit: "def456",
        firstBootAt: 3_000,
        lastBootAt: 3_000,
        bootCount: 1,
        previous: { version: "0.9.76", commit: "abc123", lastBootAt: 2_000 },
      },
    });
    expect(readFile()).toEqual(upgraded.record);

    // A repeat of the new version keeps pointing at the last DIFFERENT version.
    const repeat = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: "git+https://github.com/garrytan/alphaclaw.git#def456",
      nowFn: () => 4_000,
      managedDir,
      logger,
    });
    expect(repeat.changed).toBe(false);
    expect(repeat.record.bootCount).toBe(2);
    expect(repeat.record.previous).toEqual({ version: "0.9.76", commit: "abc123", lastBootAt: 2_000 });

    // A rollback is a change too: previous now names 0.9.77.
    const rolledBack = stampSelfVersionAtBoot({
      version: "0.9.76",
      spec: kGitSpec,
      nowFn: () => 5_000,
      managedDir,
      logger,
    });
    expect(rolledBack.changed).toBe(true);
    expect(rolledBack.previousVersion).toBe("0.9.77");
    expect(rolledBack.record.previous).toEqual({ version: "0.9.77", commit: "def456", lastBootAt: 4_000 });
    expect(rolledBack.record.bootCount).toBe(1);
  });

  it("corrupt file: one warning naming the path, then first-boot semantics and a fresh valid file", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(stampFile(), "{ not json");
    const result = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: kGitSpec,
      nowFn: () => 1_000,
      managedDir,
      logger,
    });
    expect(result.changed).toBe(true);
    expect(result.previousVersion).toBeNull();
    expect(result.record).toEqual({
      version: "0.9.77",
      commit: "abc123",
      firstBootAt: 1_000,
      lastBootAt: 1_000,
      bootCount: 1,
      previous: null,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(stampFile());
    expect(logger.warn.mock.calls[0][0]).toContain("first boot");
    expect(readFile()).toEqual(result.record);
  });

  it("a parseable file without a version is corrupt too (one warning, first boot)", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(stampFile(), JSON.stringify({ bootCount: 9 }));
    const result = stampSelfVersionAtBoot({ version: "0.9.77", nowFn: () => 1_000, managedDir, logger });
    expect(result.changed).toBe(true);
    expect(result.record.bootCount).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("normalizes a hand-edited record leniently: bad counters do not lose the version identity", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(
      stampFile(),
      JSON.stringify({ version: "0.9.77", commit: 42, firstBootAt: "yesterday", bootCount: "many", previous: [] }),
    );
    const result = stampSelfVersionAtBoot({ version: "0.9.77", spec: kGitSpec, nowFn: () => 5_000, managedDir, logger });
    expect(result.changed).toBe(false);
    expect(result.previousVersion).toBe("0.9.77");
    expect(result.record).toEqual({
      version: "0.9.77",
      commit: "abc123",
      firstBootAt: 5_000,
      lastBootAt: 5_000,
      bootCount: 1,
      previous: null,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("writes through writeFileAtomic: a same-directory temp file renamed over the target, nothing left behind", () => {
    const renames = [];
    const fsModule = {
      ...fs,
      renameSync: (from, to) => {
        renames.push({ from, to });
        return fs.renameSync(from, to);
      },
    };
    stampSelfVersionAtBoot({ version: "0.9.77", spec: kGitSpec, nowFn: () => 1_000, fsModule, managedDir, logger });
    expect(renames).toHaveLength(1);
    expect(renames[0].to).toBe(stampFile());
    expect(path.dirname(renames[0].from)).toBe(managedDir);
    expect(renames[0].from).toMatch(/\.tmp$/);
    expect(fs.readdirSync(managedDir)).toEqual([kSelfVersionFileName]);
  });

  it("a failed write warns once and never throws — the stamp is evidence, not a gate", () => {
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const fsModule = {
      ...fs,
      writeFileSync: () => {
        throw enospc;
      },
    };
    const result = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: kGitSpec,
      nowFn: () => 1_000,
      fsModule,
      managedDir,
      logger,
    });
    expect(result.changed).toBe(true);
    expect(result.record.version).toBe("0.9.77");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/could not write .*alphaclaw-version\.json.*no space left/);
    expect(fs.existsSync(stampFile())).toBe(false);
  });

  it("requires managedDir and version", () => {
    expect(() => stampSelfVersionAtBoot({ version: "0.9.77", logger })).toThrow(TypeError);
    expect(() => stampSelfVersionAtBoot({ version: "0.9.77", managedDir: "", logger })).toThrow(TypeError);
    expect(() => stampSelfVersionAtBoot({ managedDir, logger })).toThrow(TypeError);
    expect(() => stampSelfVersionAtBoot({ version: "  ", managedDir, logger })).toThrow(TypeError);
  });
});

describe("alphaclaw-self-version: readSelfVersionStamp", () => {
  let tempDir = "";
  let managedDir = "";
  let logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-self-version-read-"));
    managedDir = path.join(tempDir, ".alphaclaw");
    logger = makeLogger();
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("missing file → null without a warning", () => {
    expect(readSelfVersionStamp({ managedDir, logger })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("corrupt file → null with exactly one warning, never throwing", () => {
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, kSelfVersionFileName), " garbage");
    expect(readSelfVersionStamp({ managedDir, logger })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(path.join(managedDir, kSelfVersionFileName));
  });

  it("an unreadable file (not ENOENT) → null with one warning", () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fsModule = {
      readFileSync: () => {
        throw eacces;
      },
    };
    expect(readSelfVersionStamp({ fsModule, managedDir, logger })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("permission denied");
  });

  it("round-trips the record stampSelfVersionAtBoot wrote", () => {
    stampSelfVersionAtBoot({ version: "0.9.76", spec: kGitSpec, nowFn: () => 1_000, managedDir, logger });
    const { record } = stampSelfVersionAtBoot({
      version: "0.9.77",
      spec: "^0.9.77",
      nowFn: () => 2_000,
      managedDir,
      logger,
    });
    expect(readSelfVersionStamp({ managedDir, logger })).toEqual(record);
    expect(readSelfVersionStamp({ managedDir, logger }).previous).toEqual({
      version: "0.9.76",
      commit: "abc123",
      lastBootAt: 1_000,
    });
  });

  it("requires managedDir", () => {
    expect(() => readSelfVersionStamp({ logger })).toThrow(TypeError);
  });
});

describe("alphaclaw-self-version: formatBootBanner", () => {
  const record = {
    version: "0.9.77",
    commit: "abc123",
    firstBootAt: 1_000,
    lastBootAt: 2_000,
    bootCount: 2,
    previous: { version: "0.9.76", commit: "000aaa", lastBootAt: 500 },
  };

  it("renders the single boot line with commit, previous, root and node", () => {
    expect(formatBootBanner(record, { rootDir: "/data", nodeVersion: "v22.23.2" })).toBe(
      "[alphaclaw] AlphaClaw 0.9.77 (commit abc123; previous 0.9.76) root=/data node=v22.23.2",
    );
  });

  it("says commit n/a for npm installs and previous none on a box's first boot", () => {
    expect(
      formatBootBanner(
        { ...record, commit: null, previous: null },
        { rootDir: "/data", nodeVersion: "v22.23.2" },
      ),
    ).toBe("[alphaclaw] AlphaClaw 0.9.77 (commit n/a; previous none) root=/data node=v22.23.2");
  });

  it("defaults node to the running process and is always one line", () => {
    const line = formatBootBanner(record, { rootDir: "/data" });
    expect(line).toContain(`node=${process.version}`);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.startsWith("[alphaclaw] AlphaClaw 0.9.77 ")).toBe(true);
  });
});
