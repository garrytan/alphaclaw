const fs = require("fs");
const os = require("os");
const path = require("path");

const { relocateOpenclawArchiveReadCache, resolveOpenclawTmpRoot } = require("../../lib/server/openclaw-archive-read-cache");

const kNowMs = Date.parse("2026-11-09T09:00:00Z");

const makeRoots = () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archive-read-cache-")));
  return {
    base,
    tmpRoot: path.join(base, "tmp", "openclaw"),
    targetDir: path.join(base, "data", "tmp", "openclaw-archive-read-cache"),
  };
};

const logger = () => ({ log: vi.fn(), warn: vi.fn() });
const lines = (log) => [...log.log.mock.calls, ...log.warn.mock.calls].map((call) => call[0]);
const run = (roots, extra = {}) => relocateOpenclawArchiveReadCache({ tmpRoot: roots.tmpRoot, targetDir: roots.targetDir, nowMs: kNowMs, ...extra });

describe("relocateOpenclawArchiveReadCache", () => {
  it("creates a private OpenClaw temp root and links the read cache to the data volume", () => {
    const roots = makeRoots();
    fs.mkdirSync(path.dirname(roots.tmpRoot), { recursive: true });
    const log = logger();
    const result = run(roots, { logger: log });
    expect(result).toMatchObject({ status: "linked", changed: true });
    const link = path.join(roots.tmpRoot, "session-archive-read-cache");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(roots.targetDir);
    expect(fs.statSync(roots.tmpRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(roots.targetDir).mode & 0o777).toBe(0o700);
    expect(lines(log)).toEqual([`[alphaclaw] OpenClaw archive read cache now on the data volume: ${link} -> ${roots.targetDir}`]);
    fs.writeFileSync(path.join(link, "copy.jsonl"), "x");
    expect(fs.existsSync(path.join(roots.targetDir, "copy.jsonl"))).toBe(true);
  });

  it("does nothing and logs nothing when the link is already in place", () => {
    const roots = makeRoots();
    fs.mkdirSync(path.dirname(roots.tmpRoot), { recursive: true });
    run(roots, { logger: logger() });
    const log = logger();
    expect(run(roots, { logger: log })).toMatchObject({ status: "linked", changed: false });
    expect(lines(log)).toEqual([]);
  });

  it("removes a real cache directory left in /tmp and says how much it freed", () => {
    const roots = makeRoots();
    const cache = path.join(roots.tmpRoot, "session-archive-read-cache");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.chmodSync(roots.tmpRoot, 0o700);
    fs.writeFileSync(path.join(cache, `${"a".repeat(32)}-100-1.jsonl`), Buffer.alloc(3 * 1024 * 1024, 1));
    const log = logger();
    const result = run(roots, { logger: log });
    expect(result.status).toBe("linked");
    expect(result.clearedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(fs.lstatSync(cache).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(roots.tmpRoot)).toEqual(["session-archive-read-cache"]);
    expect(lines(log)[0]).toMatch(/removed 3 MB of copies from/);
  });

  it("removes an old cache directory a failed removal left behind on an earlier launch", () => {
    const roots = makeRoots();
    const leftover = path.join(roots.tmpRoot, ".session-archive-read-cache-removing-1731142200000");
    fs.mkdirSync(leftover, { recursive: true });
    fs.chmodSync(roots.tmpRoot, 0o700);
    fs.writeFileSync(path.join(leftover, "copy.jsonl"), "x");
    fs.mkdirSync(path.join(roots.tmpRoot, "keep-me"));
    expect(run(roots, { logger: logger() }).status).toBe("linked");
    expect(fs.readdirSync(roots.tmpRoot).sort()).toEqual(["keep-me", "session-archive-read-cache"]);
  });

  it("still links the cache when an old copy directory cannot be removed, with one warning", () => {
    const roots = makeRoots();
    const leftover = path.join(roots.tmpRoot, ".session-archive-read-cache-removing-1731142200000");
    fs.mkdirSync(leftover, { recursive: true });
    fs.chmodSync(roots.tmpRoot, 0o700);
    const log = logger();
    const fsImpl = {
      ...fs,
      rmSync: (target, options) => {
        if (target === leftover) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fs.rmSync(target, options);
      },
    };
    expect(run(roots, { logger: log, fsImpl })).toMatchObject({ status: "linked", changed: true });
    expect(fs.readlinkSync(path.join(roots.tmpRoot, "session-archive-read-cache"))).toBe(roots.targetDir);
    expect(log.warn.mock.calls.map((call) => call[0])).toEqual([
      `[alphaclaw] OpenClaw archive read cache: could not remove an old copy directory in ${roots.tmpRoot}: EACCES`,
    ]);
  });

  it("still links the cache when the old cache directory it set aside cannot be removed, and claims nothing freed", () => {
    const roots = makeRoots();
    const cache = path.join(roots.tmpRoot, "session-archive-read-cache");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.chmodSync(roots.tmpRoot, 0o700);
    fs.writeFileSync(path.join(cache, "copy.jsonl"), Buffer.alloc(1024 * 1024, 1));
    const fsImpl = { ...fs, rmSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    const log = logger();
    expect(run(roots, { logger: log, fsImpl })).toMatchObject({ status: "linked", changed: true, clearedBytes: 0 });
    expect(fs.lstatSync(cache).isSymbolicLink()).toBe(true);
    expect(lines(log)).toEqual([`[alphaclaw] OpenClaw archive read cache now on the data volume: ${cache} -> ${roots.targetDir}`]);
  });

  it("never deletes anything outside its own cache directories, through symlinks or a link to the data volume itself", () => {
    const roots = makeRoots();
    fs.mkdirSync(roots.tmpRoot, { recursive: true, mode: 0o700 });
    const outside = path.join(roots.base, "data", "keep");
    fs.mkdirSync(outside, { recursive: true });
    const sentinels = ["a.txt", "b.jsonl"].map((name) => path.join(outside, name));
    for (const file of sentinels) fs.writeFileSync(file, "keep");
    const tmpName = `${"d".repeat(32)}-1-1.jsonl.4242.0d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.tmp`;
    const tmpTarget = path.join(outside, tmpName);
    fs.writeFileSync(tmpTarget, "keep");
    const oldAt = new Date(kNowMs - 60 * 60_000);
    fs.utimesSync(tmpTarget, oldAt, oldAt);
    fs.mkdirSync(roots.targetDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(tmpTarget, path.join(roots.targetDir, tmpName.replace("4242", "4243")));
    fs.symlinkSync(outside, path.join(roots.tmpRoot, ".session-archive-read-cache-removing-1731142200000"));
    fs.symlinkSync(path.join(roots.base, "data"), path.join(roots.tmpRoot, "session-archive-read-cache"));
    fs.symlinkSync(path.join(roots.base, "missing"), path.join(roots.tmpRoot, ".session-archive-read-cache-removing-1731142200001"));
    expect(run(roots, { logger: logger() })).toMatchObject({ status: "linked", changed: true, replacedLink: path.join(roots.base, "data"), orphansRemoved: 0 });
    for (const file of [...sentinels, tmpTarget]) expect(fs.readFileSync(file, "utf8")).toBe("keep");
    expect(fs.readdirSync(outside).sort()).toEqual(["a.txt", "b.jsonl", tmpName].sort());
  });

  it("re-points a hand-made link to another directory and names the old target", () => {
    const roots = makeRoots();
    fs.mkdirSync(roots.tmpRoot, { recursive: true, mode: 0o700 });
    const manual = path.join(roots.base, "data", "tmp", "manual-cache");
    fs.mkdirSync(manual, { recursive: true });
    fs.symlinkSync(manual, path.join(roots.tmpRoot, "session-archive-read-cache"));
    const log = logger();
    expect(run(roots, { logger: log })).toMatchObject({ status: "linked", replacedLink: manual });
    expect(fs.readlinkSync(path.join(roots.tmpRoot, "session-archive-read-cache"))).toBe(roots.targetDir);
    expect(fs.existsSync(manual)).toBe(true);
    expect(lines(log)[0]).toContain(`(it pointed at ${manual})`);
  });

  it("removes only unfinished copies older than ten minutes from the data-volume cache", () => {
    const roots = makeRoots();
    fs.mkdirSync(path.dirname(roots.tmpRoot), { recursive: true });
    fs.mkdirSync(roots.targetDir, { recursive: true, mode: 0o700 });
    const name = `${"b".repeat(32)}-100-1.jsonl`;
    const old = path.join(roots.targetDir, `${name}.4242.0d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.tmp`);
    const young = path.join(roots.targetDir, `${name}.4243.1d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.tmp`);
    const finished = path.join(roots.targetDir, name);
    for (const file of [old, young, finished]) fs.writeFileSync(file, "x");
    const oldAt = new Date(kNowMs - 11 * 60_000);
    fs.utimesSync(old, oldAt, oldAt);
    fs.utimesSync(finished, oldAt, oldAt);
    const youngAt = new Date(kNowMs - 60_000);
    fs.utimesSync(young, youngAt, youngAt);
    const log = logger();
    expect(run(roots, { logger: log })).toMatchObject({ status: "linked", orphansRemoved: 1 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(finished)).toBe(true);
    expect(lines(log)[0]).toMatch(/removed 1 unfinished copy file/);
  });

  it("leaves a temp root it does not own privately alone, so OpenClaw's own fallback applies", () => {
    const roots = makeRoots();
    fs.mkdirSync(roots.tmpRoot, { recursive: true });
    fs.chmodSync(roots.tmpRoot, 0o777);
    expect(run(roots, { logger: logger() })).toEqual({ status: "skipped", reason: "tmp_root_not_private" });
    expect(fs.existsSync(path.join(roots.tmpRoot, "session-archive-read-cache"))).toBe(false);
    const other = makeRoots();
    fs.mkdirSync(other.tmpRoot, { recursive: true, mode: 0o700 });
    expect(run(other, { logger: logger(), uid: process.getuid() + 1 })).toEqual({ status: "skipped", reason: "tmp_root_not_private" });
  });

  it("never throws: a failure is one warning and the launch goes on", () => {
    const roots = makeRoots();
    fs.mkdirSync(path.dirname(roots.tmpRoot), { recursive: true });
    const log = logger();
    const fsImpl = { ...fs, symlinkSync: () => { throw Object.assign(new Error("nope"), { code: "EPERM" }); } };
    expect(run(roots, { logger: log, fsImpl })).toEqual({ status: "failed", error: "EPERM" });
    expect(lines(log)).toEqual([`[alphaclaw] OpenClaw archive read cache could not be moved off ${roots.tmpRoot}: EPERM`]);
  });

  it("resolves /tmp/openclaw unless the test seam names another root", () => {
    expect(resolveOpenclawTmpRoot({})).toBe("/tmp/openclaw");
    expect(resolveOpenclawTmpRoot({ ALPHACLAW_OPENCLAW_TMP_ROOT: "/x/openclaw" })).toBe("/x/openclaw");
  });
});
