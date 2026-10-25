const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCensus, rankGrowers } = require("../../lib/server/disk-space/growers");

const kMiB = 1024 * 1024;
const kGb = 1024 ** 3;

const writeBytes = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
};

describe("disk-space growers census", () => {
  let root;
  let outside;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-census-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "disk-census-outside-"));
    writeBytes(path.join(root, "a", "one.bin"), kMiB);
    writeBytes(path.join(root, "a", "deep", "x", "y", "two.bin"), 2 * kMiB);
    writeBytes(path.join(root, "b", "small.txt"), 10);
    writeBytes(path.join(root, "top.heapsnapshot"), kMiB);
    writeBytes(path.join(outside, "huge.bin"), 8 * kMiB);
    fs.symlinkSync(outside, path.join(root, "link"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("sizes the root and directories at depth 1 and 2 without following symlinks", async () => {
    const census = await runCensus({ roots: [root, path.join(root, "missing")] });
    const byPath = Object.fromEntries(census.dirs.map((entry) => [path.relative(root, entry.path) || ".", entry]));
    expect(Object.keys(byPath).sort()).toEqual([".", "a", "a/deep", "b"]);
    expect(byPath["a/deep"].depth).toBe(2);
    expect(byPath["a/deep"].bytes).toBeGreaterThanOrEqual(2 * kMiB);
    expect(byPath.a.bytes).toBeGreaterThanOrEqual(3 * kMiB);
    expect(byPath["."].bytes).toBeGreaterThanOrEqual(4 * kMiB);
    expect(byPath["."].bytes).toBeLessThan(8 * kMiB);
    expect(census).toMatchObject({ truncated: false, truncatedReason: null });
    expect(census.roots.map((entry) => entry.status)).toEqual(["ok", "missing"]);
  });

  it("stops at the dirent budget and marks the census truncated", async () => {
    const census = await runCensus({ roots: [root], maxEntries: 2 });
    expect(census).toMatchObject({ truncated: true, truncatedReason: "entries" });
    expect(census.entryCount).toBeLessThanOrEqual(3);
  });

  it("stops at the wall-clock budget", async () => {
    let clock = 0;
    const census = await runCensus({ roots: [root], maxMs: 5_000, nowFn: () => (clock += 2_000) });
    expect(census).toMatchObject({ truncated: true, truncatedReason: "time" });
  });

  describe("ranking", () => {
    const census = (atMs, dirs, extra = {}) => ({
      atMs, truncated: false, ...extra,
      dirs: Object.entries(dirs).map(([p, gb]) => ({ path: p, bytes: gb * kGb, rootDev: p.startsWith("/tmp") ? 9 : 2 })),
    });
    const before = census(0, { "/r": 50, "/r/.openclaw": 40, "/r/.openclaw/agents": 10, "/r/.openclaw/.cache": 5, "/r/.cache": 8, "/tmp": 1 });
    const after = census(7_200_000, {
      "/r": 150, "/r/.openclaw": 138, "/r/.openclaw/agents": 12, "/r/.openclaw/.cache": 100, "/r/.cache": 11, "/r/new": 2, "/tmp": 30,
    });

    it("ranks by growth against the baseline and prefers the directory that explains it", () => {
      const report = rankGrowers({ latest: after, baseline: before, dev: 2 });
      expect(report).toMatchObject({ basis: "growth", windowMs: 7_200_000, truncated: false });
      expect(report.entries.map((entry) => [entry.path, entry.growthBytes / kGb])).toEqual([
        ["/r/.openclaw/.cache", 95],
        ["/r/.cache", 3],
        ["/r/.openclaw/agents", 2],
        ["/r/new", 2],
      ]);
    });

    it("limits to five, filters by volume and carries truncation", () => {
      const report = rankGrowers({ latest: { ...after, truncated: true }, baseline: before, dev: null });
      expect(report.truncated).toBe(true);
      expect(report.entries).toHaveLength(5);
      expect(report.entries.map((entry) => entry.path)).toContain("/tmp");
    });

    it("falls back to the largest directories without an earlier census", () => {
      const report = rankGrowers({ latest: after, baseline: null, dev: 2 });
      expect(report).toMatchObject({ basis: "largest", windowMs: null });
      expect(report.entries.slice(0, 2)).toEqual([
        { path: "/r/.openclaw", bytes: 138 * kGb },
        { path: "/r/.openclaw/.cache", bytes: 100 * kGb },
      ]);
      expect(rankGrowers({ latest: after, baseline: after, dev: 2 }).basis).toBe("largest");
      expect(rankGrowers({ latest: null })).toBeNull();
    });
  });
});
