const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const net = require("net");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-sweep-test-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const {
  kLegacySnapshotMinAgeMs,
  kSnapshotMinAgeMs,
  resolveSnapshotRoots,
  sweepAbandonedSnapshotCopies,
} = require("../../lib/server/openclaw-snapshot-sweep");

const kHour = 60 * 60 * 1000;
const kUuid = "0f1e2d3c-4b5a-4968-8778-a6b5c4d3e2f1";

const setAge = (target, ageMs) => {
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(target, at, at);
};

// A snapshot directory with a staged fs-safe copy, every entry aged.
const makeSnapshot = (root, name, { ageMs = 2 * kHour, bytes = 4096 } = {}) => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const staged = path.join(directory, `.fs-safe-${kUuid}.tmp`);
  fs.writeFileSync(staged, Buffer.alloc(bytes, 1));
  setAge(staged, ageMs);
  setAge(directory, ageMs);
  return { directory, staged };
};

// A fake /proc: <proc>/<pid>/fd/<n> are real symlinks, so readlink works.
const makeProc = (base, openFiles = []) => {
  const proc = path.join(base, "proc");
  fs.mkdirSync(path.join(proc, "4242", "fd"), { recursive: true });
  fs.mkdirSync(path.join(proc, "self"), { recursive: true });
  openFiles.forEach((target, index) => fs.symlinkSync(target, path.join(proc, "4242", "fd", String(index + 3))));
  return proc;
};

describe("server/openclaw-snapshot-sweep", () => {
  let base;
  let cacheRoot;
  let env;
  let logger;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-sweep-")));
    cacheRoot = path.join(base, ".cache", "openclaw");
    fs.mkdirSync(cacheRoot, { recursive: true });
    env = { HOME: base };
    logger = { log: vi.fn() };
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("resolves OpenClaw's staging roots from XDG_CACHE_HOME, else HOME/.cache, plus the per-uid fallback", () => {
    expect(resolveSnapshotRoots({ HOME: "/srv/root" }, 1000)).toEqual(["/srv/root/.cache/openclaw", "/srv/root/.cache/openclaw-1000"]);
    expect(resolveSnapshotRoots({ HOME: "/srv/root", XDG_CACHE_HOME: "/srv/cache" }, 1000)[0]).toBe("/srv/cache/openclaw");
    expect(resolveSnapshotRoots({ HOME: "/srv/root", XDG_CACHE_HOME: "relative" }, 1000)[0]).toBe("/srv/root/.cache/openclaw");
  });

  it("removes old, unheld snapshot directories (v2 and legacy) and logs the bytes freed", () => {
    const v2 = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-AbC123", { bytes: 1 << 20 });
    const uuid = makeSnapshot(cacheRoot, `openclaw-sqlite-readonly-v2-${kUuid}`);
    const legacy = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-917-xYz789", { ageMs: kLegacySnapshotMinAgeMs + kHour });
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: makeProc(base), logger });
    expect(result).toMatchObject({ removed: 3, held: 0, recent: 0, failed: 0 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(1 << 20);
    for (const { directory } of [v2, uuid, legacy]) expect(fs.existsSync(directory)).toBe(false);
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log.mock.calls[0][0]).toMatch(/^\[alphaclaw\] snapshot sweep: removed 3 abandoned OpenClaw SQLite snapshot copies, freed \d+ MB/);
  });

  it("keeps a directory any process holds a file open in", () => {
    const held = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-HeLd01");
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: makeProc(base, [held.staged]), logger });
    expect(result).toMatchObject({ removed: 0, held: 1 });
    expect(fs.existsSync(held.staged)).toBe(true);
  });

  it("keeps recent copies: under an hour for v2, under a day for the legacy layout, judged by the newest entry", () => {
    const fresh = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-FrEsh1", { ageMs: kSnapshotMinAgeMs - 60_000 });
    const legacy = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-917-LeGac1", { ageMs: 2 * kHour });
    const mixed = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-MiXed1");
    fs.writeFileSync(path.join(mixed.directory, "database.sqlite"), "x");
    setAge(mixed.directory, 2 * kHour);
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: makeProc(base), logger });
    expect(result).toMatchObject({ removed: 0, recent: 3 });
    for (const { directory } of [fresh, legacy, mixed]) expect(fs.existsSync(directory)).toBe(true);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("touches nothing else in the cache root: other names, plain files, symlinks", () => {
    const other = makeSnapshot(cacheRoot, "openclaw-backup-staging");
    const badId = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-tooLongId");
    const file = path.join(cacheRoot, "openclaw-sqlite-readonly-v2-FiLe01");
    fs.writeFileSync(file, "x");
    setAge(file, 2 * kHour);
    const target = makeSnapshot(base, "outside");
    fs.symlinkSync(target.directory, path.join(cacheRoot, "openclaw-sqlite-readonly-v2-LiNk01"));
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: makeProc(base), logger });
    expect(result.removed).toBe(0);
    for (const kept of [other.directory, badId.directory, file, target.staged]) expect(fs.existsSync(kept)).toBe(true);
  });

  it("removes nothing when /proc cannot be read", () => {
    const orphan = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-NoPrOc");
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: path.join(base, "missing-proc"), logger });
    expect(result.removed).toBe(0);
    expect(fs.existsSync(orphan.directory)).toBe(true);
  });

  it("skips a directory owned by another user", () => {
    const orphan = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-OtHer1");
    const result = sweepAbandonedSnapshotCopies({ env, procRoot: makeProc(base), uid: (process.getuid?.() ?? 0) + 1, logger });
    expect(result).toMatchObject({ removed: 0, failed: 1 });
    expect(fs.existsSync(orphan.directory)).toBe(true);
  });

  it("sweeps the per-uid fallback root and an XDG_CACHE_HOME root", () => {
    const xdg = path.join(base, "xdg");
    const uid = process.getuid?.();
    const fallback = makeSnapshot(path.join(xdg, `openclaw-${uid}`), "openclaw-sqlite-readonly-v2-FaLbk1");
    const result = sweepAbandonedSnapshotCopies({ env: { HOME: base, XDG_CACHE_HOME: xdg }, procRoot: makeProc(base), logger });
    expect(result.removed).toBe(1);
    expect(fs.existsSync(fallback.directory)).toBe(false);
  });
});

describe("requestGatewayLaunch sweeps abandoned snapshot copies before it spawns", () => {
  const modulePath = require.resolve("../../lib/server/gateway");
  const originalSpawn = childProcess.spawn;
  const originalCreateConnection = net.createConnection;
  const cacheRoot = path.join(kTempRoot, ".cache", "openclaw");
  const socket = (running) => ({
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    on(event, handler) {
      if ((running && event === "connect") || (!running && event === "error")) setImmediate(handler);
      return this;
    },
  });
  const child = () => ({
    pid: 1234,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { on: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    killed: false,
    unref: vi.fn(),
  });
  let quiet = [];
  beforeEach(() => {
    quiet = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
    fs.mkdirSync(cacheRoot, { recursive: true });
  });
  afterEach(() => {
    for (const spy of quiet) spy.mockRestore();
    childProcess.spawn = originalSpawn;
    net.createConnection = originalCreateConnection;
    delete require.cache[modulePath];
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("removes the orphan before spawning the gateway", async () => {
    const orphan = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-LaUnch");
    let existedAtSpawn = null;
    childProcess.spawn = vi.fn(() => {
      existedAtSpawn = fs.existsSync(orphan.directory);
      return child();
    });
    net.createConnection = vi.fn(() => socket(false));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const launch = await gateway.requestGatewayLaunch({ prepared: true, deferAutotuneStamp: true });
    expect(launch.outcome).toBe("launch_requested");
    expect(existedAtSpawn).toBe(false);
  });

  it("leaves it alone while a gateway already serves the port", async () => {
    const orphan = makeSnapshot(cacheRoot, "openclaw-sqlite-readonly-v2-InCumb");
    childProcess.spawn = vi.fn(() => child());
    net.createConnection = vi.fn(() => socket(true));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    await gateway.requestGatewayLaunch({ prepared: true, deferAutotuneStamp: true, reconcileIncumbent: false });
    expect(fs.existsSync(orphan.directory)).toBe(true);
  });
});
