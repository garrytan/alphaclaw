const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const loadTmpWatch = () => require("../../lib/server/disk-space/temp-dir-watch");

const kMiB = 1024 * 1024;
const kHourMs = 60 * 60_000;

// Allocated bytes under root, the way statfs counts a dedicated /tmp mount.
const duSync = (target) => {
  const stat = fs.lstatSync(target);
  let bytes = stat.blocks * 512;
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) bytes += duSync(path.join(target, name));
  return bytes;
};

const writeFile = (file, mib, ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(Math.round(mib * kMiB), 7));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
};

const waitFor = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const createHarness = ({ env = { RENDER: "true" }, alertMiB = 3, evictMiB = 5, overrides = {} } = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-root-")));
  const dataTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-data-")));
  const logEvent = vi.fn();
  const notify = vi.fn(async () => ({ ok: true }));
  const { createTmpWatch, scanTmpHolders } = loadTmpWatch();
  const watch = createTmpWatch({
    env,
    tmpPath: root,
    alertBytes: alertMiB * kMiB,
    evictBytes: evictMiB * kMiB,
    evictRoot: dataTmp,
    protectedPaths: [],
    readStatfs: () => ({ ownMount: true, sizeBytes: 6 * kMiB, usedBytes: duSync(root) }),
    // The test runner cannot read other users' /proc/<pid>/fd; the processes
    // this file spawns are its own, so the scan is complete for them.
    scanHolders: (target) => ({ ...scanTmpHolders(target), complete: true }),
    logEvent,
    notify,
    withViewLogsSuffix: (line) => line + " - [View logs](http://x/#/watchdog)",
    createCorrelationId: () => "corr",
    ...overrides,
  });
  const events = () => logEvent.mock.calls
    .filter(([, source]) => source === "tmp-watch")
    .map(([eventType, source, status, details]) => ({ eventType, status, details }));
  const kinds = () => events().map((event) => event.details.kind);
  const messages = () => notify.mock.calls.map(([message]) => message);
  const cleanup = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataTmp, { recursive: true, force: true });
  };
  return { root, dataTmp, watch, events, kinds, messages, notify, cleanup };
};

describe("/tmp watch", () => {
  const children = [];
  const harnesses = [];
  const harness = (options) => {
    const h = createHarness(options);
    harnesses.push(h);
    return h;
  };
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const h of harnesses.splice(0)) h.cleanup();
  });

  // A real process that opens each file, optionally unlinks it, and keeps it open.
  const holdOpen = async (h, files, { unlink = false } = {}) => {
    const child = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      const [files, unlink] = [JSON.parse(process.argv[1]), process.argv[2] === "unlink"];
      for (const file of files) {
        fs.openSync(file, "r");
        if (unlink) fs.unlinkSync(file);
      }
      process.stdout.write("held");
      setInterval(() => {}, 1000);
    `, JSON.stringify(files), unlink ? "unlink" : "keep"], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const { scanTmpHolders } = loadTmpWatch();
    expect(await waitFor(() => scanTmpHolders(h.root).holders.some((holder) => holder.pid === child.pid))).toBe(true);
    return child;
  };

  it("fills past both lines: alerts once at the first, evicts oldest-first at the second until under the first, and logs each eviction", async () => {
    const h = harness();
    writeFile(path.join(h.root, "a.bin"), 2, 3 * kHourMs);
    await h.watch.tick();
    expect(h.notify).not.toHaveBeenCalled();
    writeFile(path.join(h.root, "b.bin"), 1.5, 2 * kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toEqual(["tmp_high"]);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain("🟡 /tmp is filling up: 4 MB used of 6 MB - [View logs](http://x/#/watchdog)");
    expect(h.messages()[0]).toContain("Render replaces the whole instance");
    expect(h.messages()[0]).toContain("• `" + path.join(h.root, "a.bin") + "` 2 MB, no process has it open");
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(true);

    writeFile(path.join(h.root, "xrs", "copy-2", "blob"), 2);
    await h.watch.tick();
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "b.bin"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, "xrs"))).toBe(true);
    const evicted = h.events().filter((event) => event.details.kind === "tmp_evicted");
    expect(evicted.map((event) => [path.basename(event.details.entry), event.details.action])).toEqual([["a.bin", "moved"], ["b.bin", "moved"]]);
    expect(evicted[0].details).toMatchObject({ bytes: 2 * kMiB, ageMs: expect.any(Number) });
    expect(evicted[0].details.ageMs).toBeGreaterThanOrEqual(3 * kHourMs - 60_000);
    expect(fs.existsSync(evicted[0].details.movedTo)).toBe(true);
    expect(evicted[0].details.movedTo.startsWith(path.join(h.dataTmp, "evicted-"))).toBe(true);
    expect(h.messages()).toHaveLength(2);
    expect(h.messages()[1]).toContain("🧹 Freed 4 MB in /tmp before it reached the limit");
    expect(duSync(h.root)).toBeLessThan(3 * kMiB);

    await h.watch.tick();
    await h.watch.tick();
    expect(h.kinds()).toContain("tmp_recovered");
    expect(h.messages()).toHaveLength(2);
  });

  it("evicts at the eviction line even when the alert line is set above it, and keeps the alert line where eviction is off", async () => {
    const h = harness({ alertMiB: 5, evictMiB: 3 });
    writeFile(path.join(h.root, "a.bin"), 2, 3 * kHourMs);
    writeFile(path.join(h.root, "b.bin"), 1.5, 2 * kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toContain("tmp_high");
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(false);
    expect(h.events().filter((event) => event.details.kind === "tmp_evicted").map((event) => path.basename(event.details.entry))).toEqual(["a.bin"]);
    expect(duSync(h.root)).toBeLessThan(3 * kMiB);
    expect(h.watch.getSnapshot()).toMatchObject({ alertBytes: 3 * kMiB, evictBytes: 3 * kMiB });

    const off = harness({ env: {}, alertMiB: 5, evictMiB: 3 });
    writeFile(path.join(off.root, "a.bin"), 2, 3 * kHourMs);
    writeFile(path.join(off.root, "b.bin"), 1.5, 2 * kHourMs);
    await off.watch.tick();
    expect(off.kinds()).toEqual([]);
    expect(off.watch.getSnapshot()).toMatchObject({ alertBytes: 5 * kMiB, evictEnabled: false });
  });

  it("never evicts a file a running process holds open, and names it and a deleted-but-open file in the alert", async () => {
    const h = harness();
    const held = writeFile(path.join(h.root, "held.bin"), 3, 5 * kHourMs);
    const ghost = writeFile(path.join(h.root, "ghost.bin"), 1, 4 * kHourMs);
    const holder = await holdOpen(h, [held]);
    const ghostHolder = await holdOpen(h, [ghost], { unlink: true });
    writeFile(path.join(h.root, "victim.bin"), 2, kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(held)).toBe(true);
    expect(fs.existsSync(path.join(h.root, "victim.bin"))).toBe(false);
    const alert = h.messages()[0];
    expect(alert).toContain("• `" + held + "` 3 MB, in use by pid " + holder.pid);
    expect(alert).toContain("• `" + ghost + "` 1 MB, deleted but still held open by pid " + ghostHolder.pid);
    expect(h.events().find((event) => event.details.kind === "tmp_high").details.top).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: held, holders: [expect.objectContaining({ pid: holder.pid })] }),
      expect.objectContaining({ path: ghost, deleted: true }),
    ]));
    expect(h.events().filter((event) => event.details.kind === "tmp_evicted").map((event) => event.details.entry)).toEqual([path.join(h.root, "victim.bin")]);
  });

  it("evicts a finished copy inside a directory whose other copy is still being written", async () => {
    const h = harness();
    writeFile(path.join(h.root, "xrs", "copy-1", "repo.tar"), 3, 20 * 60_000);
    const writing = writeFile(path.join(h.root, "xrs", "copy-2", "repo.tar"), 2.5);
    const writer = await holdOpen(h, [writing]);
    await h.watch.tick();
    expect(fs.existsSync(path.join(h.root, "xrs", "copy-1"))).toBe(false);
    expect(fs.existsSync(writing)).toBe(true);
    const evicted = h.events().filter((event) => event.details.kind === "tmp_evicted");
    expect(evicted.map((event) => event.details.entry)).toEqual([path.join(h.root, "xrs", "copy-1")]);
    expect(evicted[0].details.movedTo).toMatch(/\/evicted-[^/]+\/xrs\/copy-1$/);
    expect(h.messages()[0]).toContain("in use by pid " + writer.pid);
  });

  it("never evicts AlphaClaw's or OpenClaw's own entries, the compile cache, pid, lock or socket files", async () => {
    const h = harness({ evictMiB: 4, overrides: {} });
    const old = 10 * kHourMs;
    writeFile(path.join(h.root, "alphaclaw-askpass-x1", "askpass"), 1, old);
    writeFile(path.join(h.root, "openclaw", "session-archive-read-cache", "a.jsonl"), 1, old);
    writeFile(path.join(h.root, "build-cache", "node-compile", "blob"), 1, old);
    writeFile(path.join(h.root, "gateway.pid"), 1, old);
    writeFile(path.join(h.root, "job.lock"), 1, old);
    writeFile(path.join(h.root, "svc", "data.bin"), 1, old);
    const server = net.createServer();
    await new Promise((resolve) => server.listen(path.join(h.root, "svc", "control.sock"), resolve));
    try {
      writeFile(path.join(h.root, "victim.bin"), 1, kHourMs);
      const { createTmpWatch, scanTmpHolders } = loadTmpWatch();
      const watch = createTmpWatch({
        env: { RENDER: "true" },
        tmpPath: h.root,
        alertBytes: 3 * kMiB,
        evictBytes: 4 * kMiB,
        evictRoot: h.dataTmp,
        protectedPaths: [path.join(h.root, "build-cache", "node-compile")],
        readStatfs: () => ({ ownMount: true, sizeBytes: 8 * kMiB, usedBytes: duSync(h.root) }),
        scanHolders: (target) => ({ ...scanTmpHolders(target), complete: true }),
        notify: async () => ({ ok: true }),
      });
      await watch.tick();
      expect(fs.existsSync(path.join(h.root, "victim.bin"))).toBe(false);
      for (const kept of ["alphaclaw-askpass-x1", "openclaw", "build-cache", "gateway.pid", "job.lock", "svc"]) {
        expect(fs.existsSync(path.join(h.root, kept))).toBe(true);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("never evicts an entry its size walk did not finish, because a lock or socket file could sit in the part it never read", async () => {
    const { measureTmpEntries } = loadTmpWatch();
    const h = harness({ overrides: { measure: (target) => measureTmpEntries(target, { maxEntries: 4 }) } });
    for (let i = 0; i < 8; i += 1) writeFile(path.join(h.root, "xrs", `part-${i}`), 0.75, kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(path.join(h.root, "xrs"))).toBe(true);
    expect(h.kinds()).not.toContain("tmp_evicted");
  });

  it("evicts nothing inside a directory its size walk did not finish, even when a later walk could size its parts", async () => {
    const { measureTmpEntries } = loadTmpWatch();
    let walks = 0;
    const h = harness({ overrides: { measure: (target) => measureTmpEntries(target, { maxEntries: walks++ === 0 ? 4 : 200_000 }) } });
    for (let i = 0; i < 8; i += 1) writeFile(path.join(h.root, "xrs", `copy-${i % 4}`, `part-${i}`), 0.75, kHourMs);
    await h.watch.tick();
    for (let i = 0; i < 8; i += 1) expect(fs.existsSync(path.join(h.root, "xrs", `copy-${i % 4}`, `part-${i}`))).toBe(true);
    expect(h.kinds()).not.toContain("tmp_evicted");
  });

  it.skipIf(process.getuid?.() === 0)("never evicts a directory holding a subdirectory the walk cannot read", async () => {
    const h = harness({ overrides: { readStatfs: () => ({ ownMount: true, sizeBytes: 6 * kMiB, usedBytes: 5.5 * kMiB }) } });
    for (let i = 0; i < 8; i += 1) writeFile(path.join(h.root, "job", `part-${i}`), 0.75, kHourMs);
    writeFile(path.join(h.root, "job", "locked", "job.lock"), 0, kHourMs);
    fs.chmodSync(path.join(h.root, "job", "locked"), 0o000);
    try {
      await h.watch.tick();
      expect(fs.existsSync(path.join(h.root, "job", "locked"))).toBe(true);
      expect(h.events().filter((event) => event.details.kind === "tmp_evicted").map((event) => event.details.entry)).not.toContain(path.join(h.root, "job"));
    } finally {
      fs.chmodSync(path.join(h.root, "job", "locked"), 0o700);
    }
  });

  it("evicts in the same sample while the owner alert is still being delivered", async () => {
    let release;
    const notify = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue({ ok: true });
    const h = harness({ overrides: { notify } });
    writeFile(path.join(h.root, "old.bin"), 5.5, kHourMs);
    const ticked = h.watch.tick();
    expect(await waitFor(() => !fs.existsSync(path.join(h.root, "old.bin")), 2_000)).toBe(true);
    release({ ok: true });
    await ticked;
    expect(h.kinds()).toContain("tmp_evicted");
  });

  it("refuses to evict through a parent directory swapped for a symlink after the scan", async () => {
    const { scanTmpHolders } = loadTmpWatch();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-outside-")));
    let scans = 0;
    const h = harness({
      overrides: {
        scanHolders: (target) => {
          scans += 1;
          if (scans === 2) {
            fs.renameSync(path.join(h.root, "job"), path.join(h.root, "job-real"));
            fs.symlinkSync(outside, path.join(h.root, "job"));
          }
          const active = { pid: 1, command: "job", path: path.join(h.root, "job", "active.log"), kind: "open", bytes: null };
          return { holders: [...scanTmpHolders(target).holders, active], complete: true };
        },
      },
    });
    try {
      writeFile(path.join(h.root, "job", "active.log"), 0.1);
      writeFile(path.join(h.root, "job", "old-copy"), 5.5, kHourMs);
      writeFile(path.join(outside, "old-copy"), 0.1, kHourMs);
      await h.watch.tick();
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(outside, "old-copy"))).toBe(true);
      expect(h.kinds()).not.toContain("tmp_evicted");
      expect(h.kinds()).toContain("tmp_evict_refused");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("masks credentials in the command line of a process holding a /tmp file", async () => {
    const { scanTmpHolders } = loadTmpWatch();
    const h = harness();
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-proc-"));
    try {
      const held = writeFile(path.join(h.root, "dump.sql"), 0.5);
      fs.mkdirSync(path.join(procRoot, "4242", "fd"), { recursive: true });
      fs.symlinkSync(held, path.join(procRoot, "4242", "fd", "3"));
      fs.writeFileSync(path.join(procRoot, "4242", "cmdline"), ["mysqldump", "--password=hunter2xyz", "-phunter3xyz", "--api-key=k3y-value", "DB_TOKEN=t0ken-value", "--dsn", "mysql://root:PASSWORD@db/app"].join("\0") + "\0");
      const scan = scanTmpHolders(h.root, { procRoot });
      expect(scan.holders.map((holder) => holder.path)).toEqual([held]);
      const command = scan.holders[0].command;
      for (const secret of ["hunter2xyz", "hunter3xyz", "k3y-value", "t0ken-value", "root:PASSWORD"]) expect(command).not.toContain(secret);
      expect(command).toContain("mysqldump");
    } finally {
      fs.rmSync(procRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)("counts the holder scan incomplete when a process's maps or fd links cannot be read", () => {
    const { scanTmpHolders } = loadTmpWatch();
    const h = harness();
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-proc-"));
    try {
      fs.mkdirSync(path.join(procRoot, "4242", "fd"), { recursive: true });
      fs.writeFileSync(path.join(procRoot, "4242", "maps"), "");
      fs.chmodSync(path.join(procRoot, "4242", "maps"), 0o000);
      expect(scanTmpHolders(h.root, { procRoot }).complete).toBe(false);
      fs.chmodSync(path.join(procRoot, "4242", "maps"), 0o600);
      fs.symlinkSync(path.join(h.root, "x"), path.join(procRoot, "4242", "fd", "3"));
      fs.chmodSync(path.join(procRoot, "4242", "fd"), 0o444);
      expect(scanTmpHolders(h.root, { procRoot }).complete).toBe(false);
    } finally {
      fs.chmodSync(path.join(procRoot, "4242", "fd"), 0o700);
      fs.rmSync(procRoot, { recursive: true, force: true });
    }
  });

  it("backs off the size walk and /proc scan after a pass that cannot get under the alert line, and says so once", async () => {
    let atMs = 1_000_000;
    let usedBytes = 5.5 * kMiB;
    const measure = vi.fn(async (target) => ({
      entries: [{ name: "a.bin", path: path.join(target, "a.bin"), type: "file", bytes: 1.5 * kMiB, newestMtimeMs: atMs - kHourMs, sensitive: false, partial: false }],
      totalBytes: usedBytes,
      truncated: false,
    }));
    const scanHolders = vi.fn(() => ({ holders: [], complete: true }));
    const renameEntry = vi.fn();
    const h = harness({ overrides: { measure, scanHolders, renameEntry, nowFn: () => atMs, readStatfs: () => ({ ownMount: true, sizeBytes: 6 * kMiB, usedBytes }) } });
    writeFile(path.join(h.root, "a.bin"), 0.1);
    await h.watch.tick();
    expect(renameEntry).toHaveBeenCalledTimes(1);
    expect(h.messages()).toHaveLength(2);
    const measured = measure.mock.calls.length;
    const scanned = scanHolders.mock.calls.length;
    for (let i = 0; i < 5; i += 1) {
      atMs += 2_000;
      await h.watch.tick();
    }
    expect(measure.mock.calls.length).toBe(measured);
    expect(scanHolders.mock.calls.length).toBe(scanned);
    atMs += 30_000;
    await h.watch.tick();
    expect(measure.mock.calls.length).toBeGreaterThan(measured);
    expect(renameEntry).toHaveBeenCalledTimes(2);
    expect(h.messages()).toHaveLength(2);
  });

  it("deletes OpenClaw's decompressed archive copies first, never moves them, and keeps one a process has open", async () => {
    const h = harness();
    const cache = path.join(h.root, "openclaw", "session-archive-read-cache");
    const older = writeFile(path.join(cache, `${"a".repeat(32)}-1-1.jsonl`), 1.5, kHourMs);
    const newer = writeFile(path.join(cache, `${"b".repeat(32)}-1-1.jsonl`), 1.5, 60_000);
    const reading = writeFile(path.join(cache, `${"c".repeat(32)}-1-1.jsonl`), 1, 30_000);
    const job = writeFile(path.join(h.root, "job.bin"), 1, 5 * kHourMs);
    writeFile(path.join(h.root, "openclaw", "openclaw.json.bak"), 0.2, 5 * kHourMs);
    await holdOpen(h, [reading]);
    await h.watch.tick();
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(false);
    expect(fs.existsSync(reading)).toBe(true);
    expect(fs.existsSync(job)).toBe(true);
    expect(fs.existsSync(path.join(h.root, "openclaw", "openclaw.json.bak"))).toBe(true);
    expect(fs.readdirSync(h.dataTmp)).toEqual([]);
    const cleared = h.events().find((event) => event.details.kind === "tmp_cache_cleared");
    expect(cleared.details).toMatchObject({ entry: cache, files: 2, bytes: 3 * kMiB });
    expect(h.kinds()).not.toContain("tmp_evicted");
    expect(h.messages()[1]).toContain("🧹 Freed 3 MB in /tmp before it reached the limit");
    expect(h.messages()[1]).toContain("• deleted 2 decompressed session-archive copies (3 MB) from `" + cache + "`; OpenClaw remakes any it reads again");
  });

  it("keeps an archive copy a process opened while the watch was still walking the rest of /tmp", async () => {
    let hook = null;
    const h = harness({
      overrides: {
        measure: async (root) => {
          const { measureTmpEntries } = loadTmpWatch();
          const measured = await measureTmpEntries(root);
          await hook?.(root);
          return measured;
        },
      },
    });
    const cache = path.join(h.root, "openclaw", "session-archive-read-cache");
    const opened = writeFile(path.join(cache, `${"a".repeat(32)}-1-1.jsonl`), 1.5, kHourMs);
    const idle = writeFile(path.join(cache, `${"b".repeat(32)}-1-1.jsonl`), 1.5, kHourMs);
    const busyDir = path.join(h.root, "busy");
    const busy = writeFile(path.join(busyDir, "in-use.bin"), 1, kHourMs);
    writeFile(path.join(busyDir, "loose.bin"), 1, 5 * kHourMs);
    await holdOpen(h, [busy]);
    let reader = null;
    hook = async (root) => {
      if (root !== busyDir || reader) return;
      reader = await holdOpen(h, [opened]);
    };
    await h.watch.tick();
    expect(reader).not.toBeNull();
    expect(fs.existsSync(opened)).toBe(true);
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.existsSync(busy)).toBe(true);
  });

  it("keeps an archive copy OpenClaw is still writing or wrote seconds ago", async () => {
    const h = harness();
    const cache = path.join(h.root, "openclaw", "session-archive-read-cache");
    const old = writeFile(path.join(cache, `${"a".repeat(32)}-1-1.jsonl`), 1.5, kHourMs);
    const writing = writeFile(path.join(cache, `${"b".repeat(32)}-1-1.jsonl.4242.0d5a1f3c-9a1b-4c2d-8e3f-1234567890ab.tmp`), 1.5, kHourMs);
    const fresh = writeFile(path.join(cache, `${"c".repeat(32)}-1-1.jsonl`), 1.5, 1_000);
    writeFile(path.join(h.root, "job.bin"), 1, 5 * kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(writing)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("leaves the archive read cache alone once it is a symlink to the data volume", async () => {
    const h = harness();
    const elsewhere = path.join(h.dataTmp, "openclaw-archive-read-cache");
    writeFile(path.join(elsewhere, "copy.jsonl"), 1, kHourMs);
    fs.mkdirSync(path.join(h.root, "openclaw"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(h.root, "openclaw", "session-archive-read-cache"));
    writeFile(path.join(h.root, "victim.bin"), 5.5, kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(path.join(elsewhere, "copy.jsonl"))).toBe(true);
    expect(h.kinds()).not.toContain("tmp_cache_cleared");
    expect(fs.existsSync(path.join(h.root, "victim.bin"))).toBe(false);
  });

  it("acts on growth before the eviction line and samples a du-sized /tmp every 2 s while growth would cross the alert line", async () => {
    let nowMs = Date.parse("2026-11-09T08:50:00Z");
    const h = harness({
      overrides: {
        readStatfs: () => ({ ownMount: false, sizeBytes: 0, usedBytes: 0 }),
        nowFn: () => nowMs,
      },
    });
    writeFile(path.join(h.root, "a.bin"), 1, 3 * kHourMs);
    await h.watch.tick();
    expect(h.watch.getSnapshot()).toMatchObject({ source: "du", fastSampling: false });

    nowMs += 30_000;
    writeFile(path.join(h.root, "b.bin"), 1.5, 2 * kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toEqual([]);
    expect(h.watch.getSnapshot()).toMatchObject({ fastSampling: true });

    nowMs += 2_000;
    const writing = writeFile(path.join(h.root, "c.bin"), 1.4);
    await holdOpen(h, [writing]);
    await h.watch.tick();
    const snapshot = h.watch.getSnapshot();
    expect(snapshot.usedBytes).toBeLessThan(5 * kMiB);
    expect(snapshot.projectedBytes).toBeGreaterThanOrEqual(5 * kMiB);
    expect(h.kinds()[0]).toBe("tmp_high");
    expect(h.events()[0].details.projectedBytes).toBe(snapshot.projectedBytes);
    expect(h.events().filter((event) => event.details.kind === "tmp_evicted").map((event) => path.basename(event.details.entry))).toEqual(["a.bin", "b.bin"]);
    expect(fs.existsSync(writing)).toBe(true);
  });

  it("projects nothing from two samples taken moments apart", async () => {
    const h = harness();
    writeFile(path.join(h.root, "a.bin"), 1, kHourMs);
    await h.watch.tick();
    writeFile(path.join(h.root, "b.bin"), 1.8, kHourMs);
    await h.watch.tick();
    expect(h.watch.getSnapshot().projectedBytes).toBe(h.watch.getSnapshot().usedBytes);
    expect(h.kinds()).toEqual([]);
  });

  it("goes back to 30 s sampling once an eviction pass leaves a du-sized /tmp over the alert line, so a /tmp stuck full is not walked every 2 s", async () => {
    let nowMs = Date.parse("2026-11-09T08:50:00Z");
    const h = harness({
      overrides: {
        readStatfs: () => ({ ownMount: false, sizeBytes: 0, usedBytes: 0 }),
        nowFn: () => nowMs,
      },
    });
    writeFile(path.join(h.root, "openclaw", "stuck.bin"), 5.5, kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toEqual(["tmp_high", "tmp_evict_skipped"]);
    expect(h.watch.getSnapshot()).toMatchObject({ source: "du", fastSampling: false });
    nowMs += 30_000;
    await h.watch.tick();
    expect(h.watch.getSnapshot().fastSampling).toBe(false);
  });

  it("keeps 2 s sampling while the projection is over the alert line but under the eviction line, and evicts once it crosses", async () => {
    let nowMs = Date.parse("2026-11-09T08:50:00Z");
    const h = harness({
      overrides: {
        readStatfs: () => ({ ownMount: false, sizeBytes: 0, usedBytes: 0 }),
        nowFn: () => nowMs,
      },
    });
    writeFile(path.join(h.root, "a.bin"), 1, 3 * kHourMs);
    await h.watch.tick();
    nowMs += 30_000;
    writeFile(path.join(h.root, "b.bin"), 2.5, 2 * kHourMs);
    await h.watch.tick();
    const between = h.watch.getSnapshot();
    expect(between.projectedBytes).toBeGreaterThanOrEqual(3 * kMiB);
    expect(between.projectedBytes).toBeLessThan(5 * kMiB);
    expect(between.fastSampling).toBe(true);
    nowMs += 2_000;
    writeFile(path.join(h.root, "c.bin"), 1.6, kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toContain("tmp_evicted");
  });

  it("projects nothing from a du walk its budget cut short", async () => {
    const { measureTmpEntries } = loadTmpWatch();
    let nowMs = Date.parse("2026-11-09T08:50:00Z");
    let walks = 0;
    const h = harness({
      overrides: {
        readStatfs: () => ({ ownMount: false, sizeBytes: 0, usedBytes: 0 }),
        nowFn: () => nowMs,
        measure: (target) => measureTmpEntries(target, { maxEntries: walks++ === 0 ? 1 : 200_000 }),
      },
    });
    writeFile(path.join(h.root, "a.bin"), 1, kHourMs);
    writeFile(path.join(h.root, "b.bin"), 1.5, kHourMs);
    await h.watch.tick();
    nowMs += 30_000;
    await h.watch.tick();
    const snapshot = h.watch.getSnapshot();
    expect(snapshot.projectedBytes).toBe(snapshot.usedBytes);
    expect(snapshot.fastSampling).toBe(false);
  });

  it.skipIf(!process.getuid)("deletes archive copies from OpenClaw's fallback root /tmp/openclaw-<uid> first too", async () => {
    const h = harness();
    const cache = path.join(h.root, `openclaw-${process.getuid()}`, "session-archive-read-cache");
    const copy = writeFile(path.join(cache, `${"d".repeat(32)}-1-1.jsonl`), 3, kHourMs);
    const job = writeFile(path.join(h.root, "job.bin"), 2.5, 5 * kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(job)).toBe(true);
    expect(h.events().find((event) => event.details.kind === "tmp_cache_cleared").details).toMatchObject({ entry: cache, files: 1 });
  });

  it("off Render it alerts but evicts nothing", async () => {
    const h = harness({ env: {} });
    writeFile(path.join(h.root, "a.bin"), 3, 3 * kHourMs);
    writeFile(path.join(h.root, "b.bin"), 3, 2 * kHourMs);
    await h.watch.tick();
    expect(h.kinds()).toEqual(["tmp_high"]);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain("The watchdog deletes nothing in /tmp on this box.");
    expect(h.messages()[0]).not.toContain("Render");
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(h.root, "b.bin"))).toBe(true);
  });

  it("deletes instead of moving when a cross-mount copy would not fit on the data volume", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const h = harness({ overrides: { renameEntry: () => { throw exdev; }, readFreeBytes: () => 0 } });
    writeFile(path.join(h.root, "a.bin"), 3, 3 * kHourMs);
    writeFile(path.join(h.root, "b.bin"), 2.5, 2 * kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(false);
    const evicted = h.events().find((event) => event.details.kind === "tmp_evicted");
    expect(evicted.details).toMatchObject({ action: "deleted", movedTo: null, bytes: 3 * kMiB });
    expect(h.messages()[1]).toContain("• deleted `" + path.join(h.root, "a.bin") + "` (3 MB");
    expect(fs.readdirSync(h.dataTmp)).toEqual([]);
  });

  it("evicts nothing when some process's open files cannot be read", async () => {
    const h = harness({ overrides: { scanHolders: () => ({ holders: [], complete: false }) } });
    writeFile(path.join(h.root, "a.bin"), 3, 3 * kHourMs);
    writeFile(path.join(h.root, "b.bin"), 2.5, 2 * kHourMs);
    await h.watch.tick();
    expect(fs.existsSync(path.join(h.root, "a.bin"))).toBe(true);
    expect(h.kinds()).toEqual(["tmp_high", "tmp_evict_skipped"]);
    expect(h.events()[1].details.reason).toBe("open_files_unreadable");
  });

  it("stays idle off Render when /tmp is not its own small mount", async () => {
    const measure = vi.fn();
    const h = harness({ env: {}, overrides: { measure, readStatfs: () => ({ ownMount: false, sizeBytes: 500 * 1024 * kMiB, usedBytes: 400 * 1024 * kMiB }) } });
    await h.watch.tick();
    expect(measure).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.watch.getSnapshot()).toMatchObject({ source: "none", state: "ok" });
  });

  it("starts and stops with the disk-space tracker when the watchdog passes tmpWatch options", async () => {
    const { createDiskSpaceTracker } = require("../../lib/server/disk-space");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmp-watch-tracker-")));
    const readStatfs = vi.fn(() => ({ ownMount: true, sizeBytes: 6 * kMiB, usedBytes: kMiB }));
    try {
      const tracker = createDiskSpaceTracker({
        stateDir: root, censusRoots: [], env: {}, readVolumes: () => [], runCensus: async () => null,
        tmpWatch: { tmpPath: root, readStatfs },
      });
      tracker.start();
      expect(await waitFor(() => readStatfs.mock.calls.length > 0)).toBe(true);
      tracker.stop();
      expect(tracker.getSnapshot().tmp).toMatchObject({ path: root, source: "statfs", usedBytes: kMiB, state: "ok" });
      expect(createDiskSpaceTracker({ stateDir: root, readVolumes: () => [] }).getSnapshot()).not.toHaveProperty("tmp");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts on Render by default and elsewhere only when ALPHACLAW_TMP_EVICT says so", () => {
    const { resolveTmpEvictEnabled } = loadTmpWatch();
    expect(resolveTmpEvictEnabled({ RENDER: "true" }, "")).toBe(true);
    expect(resolveTmpEvictEnabled({ RENDER_SERVICE_ID: "srv-1" }, "")).toBe(true);
    expect(resolveTmpEvictEnabled({}, "")).toBe(false);
    expect(resolveTmpEvictEnabled({ RENDER: "true" }, "off")).toBe(false);
    expect(resolveTmpEvictEnabled({}, "on")).toBe(true);
  });

  it("defaults leave the eviction line well under a decimal 2 GB limit", () => {
    const saved = { alert: process.env.ALPHACLAW_TMP_ALERT_MB, evict: process.env.ALPHACLAW_TMP_EVICT_MB };
    delete process.env.ALPHACLAW_TMP_ALERT_MB;
    delete process.env.ALPHACLAW_TMP_EVICT_MB;
    try {
      vi.resetModules();
      const { kTmpAlertBytes, kTmpEvictBytes } = require("../../lib/server/constants");
      expect(kTmpAlertBytes).toBe(1400 * kMiB);
      expect(kTmpEvictBytes).toBe(1650 * kMiB);
      expect(2_000_000_000 - kTmpEvictBytes).toBeGreaterThan(250_000_000);
    } finally {
      if (saved.alert !== undefined) process.env.ALPHACLAW_TMP_ALERT_MB = saved.alert;
      if (saved.evict !== undefined) process.env.ALPHACLAW_TMP_EVICT_MB = saved.evict;
      vi.resetModules();
    }
  });
});
