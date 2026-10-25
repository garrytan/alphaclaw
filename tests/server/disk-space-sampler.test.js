const path = require("path");
const { parseDiagnosticDirs, readDiskVolumes } = require("../../lib/server/disk-space/sampler");

const kGb = 1024 ** 3;

const fakeFs = (layout) => ({
  realpathSync: (p) => p,
  statSync: (p) => {
    for (let current = p; ; current = path.dirname(current)) {
      if (layout.missing?.includes(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (layout.devs[current] !== undefined) return { dev: layout.devs[current] };
      if (path.dirname(current) === current) return { dev: layout.devs["/"] ?? 1 };
    }
  },
  statfsSync: (p) => {
    if (layout.statfsFails?.includes(p)) throw new Error("EIO");
    return layout.statfs?.[p] ?? { bsize: 4096, blocks: (100 * kGb) / 4096, bavail: (40 * kGb) / 4096 };
  },
});

describe("disk-space sampler", () => {
  it("parses --diagnostic-dir and --report-directory in both forms and ignores the default", () => {
    expect(parseDiagnosticDirs("")).toEqual([]);
    expect(parseDiagnosticDirs("--max-old-space-size=4096 --heapsnapshot-near-heap-limit=2")).toEqual([]);
    expect(parseDiagnosticDirs("--diagnostic-dir=/data/diag --report-directory /data/reports")).toEqual([
      { id: "diagnostic", path: "/data/diag" },
      { id: "report", path: "/data/reports" },
    ]);
    expect(parseDiagnosticDirs('--diagnostic-dir "/data/my diag"')).toEqual([{ id: "diagnostic", path: "/data/my diag" }]);
    expect(parseDiagnosticDirs("--diagnostic-dir=rel", { cwd: "/srv" })).toEqual([{ id: "diagnostic", path: "/srv/rel" }]);
    expect(parseDiagnosticDirs("--diagnostic-dir --inspect")).toEqual([]);
    expect(parseDiagnosticDirs("--diagnostic-dir=/d --report-directory=/d")).toEqual([{ id: "diagnostic", path: "/d" }]);
  });

  it("reads free = bavail * bsize and size = blocks * bsize, with the mount point", () => {
    const fsImpl = fakeFs({
      devs: { "/": 1, "/data": 2 },
      statfs: { "/data/.openclaw": { bsize: 4096, blocks: 1000, bfree: 600, bavail: 500 } },
    });
    expect(readDiskVolumes({ stateDir: "/data/.openclaw", env: {}, fsImpl })).toEqual([{
      id: "state", path: "/data/.openclaw", mountPath: "/data", dev: 2, status: "fresh",
      freeBytes: 500 * 4096, sizeBytes: 1000 * 4096,
    }]);
  });

  it("adds the diagnostic volume only when it is a different device", () => {
    const env = { NODE_OPTIONS: "--diagnostic-dir=/scratch/diag" };
    const same = fakeFs({ devs: { "/": 1, "/data": 2, "/scratch": 2 } });
    expect(readDiskVolumes({ stateDir: "/data/.openclaw", env, fsImpl: same }).map((v) => v.id)).toEqual(["state"]);
    const other = fakeFs({ devs: { "/": 1, "/data": 2, "/scratch": 3 } });
    const volumes = readDiskVolumes({ stateDir: "/data/.openclaw", env, fsImpl: other });
    expect(volumes.map((v) => [v.id, v.mountPath, v.dev])).toEqual([["state", "/data", 2], ["diagnostic", "/scratch", 3]]);
  });

  it("reports missing or unreadable paths as unknown volumes", () => {
    const fsImpl = fakeFs({
      devs: { "/": 1, "/scratch": 3 },
      missing: ["/data/.openclaw"],
      statfsFails: ["/scratch/diag"],
    });
    expect(readDiskVolumes({ stateDir: "/data/.openclaw", env: { NODE_OPTIONS: "--diagnostic-dir=/scratch/diag" }, fsImpl })).toEqual([
      { id: "state", path: "/data/.openclaw", status: "unknown", reason: "missing" },
      { id: "diagnostic", path: "/scratch/diag", status: "unknown", reason: "statfs_failed" },
    ]);
    const zero = fakeFs({ devs: { "/": 1 }, statfs: { "/s": { bsize: 4096, blocks: 0, bavail: 0 } } });
    expect(readDiskVolumes({ stateDir: "/s", env: {}, fsImpl: zero })[0]).toMatchObject({ status: "unknown", reason: "statfs_invalid" });
  });

  it("reads a real directory", () => {
    const [volume] = readDiskVolumes({ stateDir: __dirname, env: {} });
    expect(volume.status).toBe("fresh");
    expect(volume.sizeBytes).toBeGreaterThan(0);
    expect(volume.freeBytes).toBeLessThanOrEqual(volume.sizeBytes);
  });
});
