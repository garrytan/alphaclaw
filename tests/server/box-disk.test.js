const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { createDiskReader, parseOpenUnder } = require("../../lib/server/box-status/disk");
const { registerBoxRoutes } = require("../../lib/server/routes/box");

const write = (filePath, bytes) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
};

describe("box disk view", () => {
  let root;
  let stateDir;
  let backupsDir;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "box-disk-")));
    stateDir = path.join(root, "state");
    backupsDir = path.join(root, "backups", "openclaw");
    write(path.join(stateDir, "agents", "main", "sessions", "a.jsonl"), 300_000);
    write(path.join(stateDir, "workspace", "notes.md"), 40_000);
    write(path.join(stateDir, "openclaw.json"), 2_000);
    write(path.join(stateDir, "openclaw.json.pre-doctor-1700000000000.bak"), 2_000);
    write(path.join(stateDir, "openclaw.json.medic-20261025.bak"), 2_000);
    write(path.join(stateDir, "openclaw.json.backup-by-hand"), 2_000);
    write(path.join(stateDir + ".update-captures", "doctor-1", "state.sqlite"), 120_000);
    write(path.join(stateDir + ".update-captures", "update-2", "state.sqlite"), 80_000);
    write(path.join(root, ".openclaw.package-backup-1", "package.json"), 10_000);
    write(path.join(backupsDir, "2026-10-24.tar.gz"), 50_000);
    write(path.join(root, "cache", "openclaw", "openclaw-sqlite-readonly-v2-abc123", "db.sqlite"), 200_000);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const makeReader = (overrides = {}) => createDiskReader({
    resolveStateDir: () => stateDir,
    backupsDir,
    resolveEnv: () => ({}),
    listSnapshots: () => [{ directory: path.join(root, "cache", "openclaw", "openclaw-sqlite-readonly-v2-abc123") }],
    procRoot: path.join(root, "no-proc"),
    ...overrides,
  });

  it("sizes the state dir's top-level folders and groups each feature's copies", async () => {
    const body = await makeReader().read();
    expect(body.ok).toBe(true);
    expect(body.volumes[0]).toMatchObject({ id: "state", status: "fresh" });
    expect(body.volumes[0].dev).toBeUndefined();
    expect(body.census).toMatchObject({ status: "ok", reason: null });
    expect(body.stateDir.path).toBe(stateDir);
    expect(body.stateDir.entries.map((entry) => entry.name)).toEqual(["agents", "workspace"]);
    expect(body.stateDir.entries[0].bytes).toBeGreaterThanOrEqual(300_000);
    expect(body.stateDir.topLevelFilesBytes).toBeGreaterThanOrEqual(8_000);
    expect(body.openFiles).toBeNull();

    const groups = Object.fromEntries(body.temp.map((group) => [group.id, group]));
    expect(groups.openclaw_snapshot_copies).toMatchObject({ count: 1, unmeasured: 0 });
    expect(groups.openclaw_snapshot_copies.bytes).toBeGreaterThanOrEqual(200_000);
    expect(groups.openclaw_update_captures.count).toBe(2);
    expect(groups.openclaw_update_captures.bytes).toBeGreaterThanOrEqual(200_000);
    expect(groups.openclaw_update_captures.items.map((item) => item.name).sort()).toEqual(["doctor-1", "update-2"]);
    expect(groups.openclaw_package_backups.items.map((item) => item.name)).toEqual([".openclaw.package-backup-1"]);
    expect(groups.config_backups.items.map((item) => item.name).sort()).toEqual([
      "openclaw.json.medic-20261025.bak",
      "openclaw.json.pre-doctor-1700000000000.bak",
    ]);
    expect(groups.alphaclaw_backups).toMatchObject({ count: 1 });
    expect(groups.alphaclaw_backups.items[0]).toMatchObject({ name: "2026-10-24.tar.gz", directory: false });
    expect(groups.alphaclaw_backups.newestAt).toEqual(expect.any(String));
  });

  it("never follows a symlink out of the state dir", async () => {
    write(path.join(root, "outside", "big.bin"), 500_000);
    fs.symlinkSync(path.join(root, "outside"), path.join(stateDir, "linked"));
    const body = await makeReader().read();
    expect(body.stateDir.entries.map((entry) => entry.name)).not.toContain("linked");
    expect(body.stateDir.bytes).toBeLessThan(500_000);
  });

  it("caches the census for 5 minutes and marks a stopped census partial", async () => {
    let now = 1_000_000;
    const census = vi.fn(async () => ({ atMs: now, durationMs: 3000, truncated: true, truncatedReason: "time", entryCount: 9, roots: [{ path: stateDir, status: "ok" }], dirs: [] }));
    const reader = makeReader({ census, nowFn: () => now });
    expect((await reader.read()).census).toMatchObject({ status: "partial", reason: "time", entries: 9 });
    now += 4 * 60_000;
    await reader.read();
    expect(census).toHaveBeenCalledTimes(1);
    now += 61_000;
    await reader.read();
    expect(census).toHaveBeenCalledTimes(2);
  });

  it("answers with a failed census instead of throwing", async () => {
    const body = await makeReader({ census: async () => { throw new Error("EIO"); } }).read();
    expect(body.census.status).toBe("failed");
    expect(body.stateDir).toMatchObject({ bytes: null, entries: [] });
  });

  it("lists the processes holding files open under a path, deleted files and their bytes first", async () => {
    const proc = path.join(root, "proc");
    const holder = (pid, comm, links) => {
      fs.mkdirSync(path.join(proc, String(pid), "fd"), { recursive: true });
      fs.writeFileSync(path.join(proc, String(pid), "comm"), comm + "\n");
      links.forEach((target, index) => fs.symlinkSync(target, path.join(proc, String(pid), "fd", String(index))));
    };
    const live = path.join(stateDir, "workspace", "notes.md");
    holder(10, "node", [live, "/dev/null", "socket:[123]"]);
    holder(20, "sqlite-holder", [path.join(stateDir, "state.sqlite") + " (deleted)", live]);
    holder(30, "other", [path.join(root, "elsewhere.txt")]);
    fs.mkdirSync(path.join(proc, "40"));
    const fsModule = {
      ...fs,
      statSync: (target, ...rest) => (target === path.join(proc, "20", "fd", "0") ? { size: 7_000_000 } : fs.statSync(target, ...rest)),
    };
    const body = await makeReader({ procRoot: proc, fsModule }).read({ openUnder: stateDir });
    expect(body.openFiles).toMatchObject({ under: stateDir, status: "ok", deletedBytes: 7_000_000, total: 2, unreadableProcesses: 1 });
    expect(body.openFiles.processes[0]).toMatchObject({ pid: 20, comm: "sqlite-holder", files: 2, deleted: 1, deletedBytes: 7_000_000 });
    expect(body.openFiles.processes[0].paths[0]).toEqual({ path: path.join(stateDir, "state.sqlite"), deleted: true });
    expect(body.openFiles.processes[1]).toMatchObject({ pid: 10, files: 1, deleted: 0, paths: [{ path: live, deleted: false }] });
  });

  it("validates openUnder", () => {
    expect(parseOpenUnder(undefined)).toEqual({ value: null });
    expect(parseOpenUnder("/data/../data/x/")).toEqual({ value: "/data/x" });
    for (const bad of ["relative/path", "/a\0b", "/" + "a".repeat(600), ["/a", "/b"]]) expect(parseOpenUnder(bad).error).toEqual(expect.any(String));
  });

  it("serves GET /api/box/disk and rejects a bad openUnder", async () => {
    const app = express();
    const diskReader = { read: vi.fn(async () => ({ ok: true, temp: [] })) };
    registerBoxRoutes({ app, requireAuth: (req, res, next) => next(), processTable: null, readRestartStatus: () => null, scheduleReader: null, diskReader });
    const res = await request(app).get("/api/box/disk?openUnder=/data");
    expect(res.status).toBe(200);
    expect(diskReader.read).toHaveBeenCalledWith({ openUnder: "/data" });
    const bad = await request(app).get("/api/box/disk?openUnder=data");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_open_under");
  });
});
