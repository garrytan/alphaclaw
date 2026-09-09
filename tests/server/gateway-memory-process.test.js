const { createGatewayProcessCollector } = require("../../lib/server/gateway-memory/process-snapshot");
const { createProcessPssSampler, parseSmapsRollup } = require("../../lib/server/gateway-memory/process-pss");
const { getProcessIdentity, getLinuxBootId, parseProcessStat } = require("../../lib/server/gateway-memory/process-identity");

const kMb = 1024 * 1024;
const stat = (pid, parentPid, ticks = "100") => {
  const fields = ["S", String(parentPid), ...new Array(17).fill("0"), ticks, "0", "0"];
  return `${pid} (node (secret title)) ${fields.join(" ")}\n`;
};
const status = (parentPid, rssMb) =>
  `Name:\tsecret-name\nPPid:\t${parentPid}\n${rssMb === null ? "" : `VmRSS:\t${rssMb * 1024} kB\n`}`;
const rollup = (rssKb = 100, pssKb = 70, cleanKb = 10, dirtyKb = 40) =>
  `0000-ffff ---p 0 00:00 0 [rollup]\nRss: ${rssKb} kB\nPss: ${pssKb} kB\nPrivate_Clean: ${cleanKb} kB\nPrivate_Dirty: ${dirtyKb} kB\nPrivate_Hugetlb: 0 kB\n`;
const error = (code) => Object.assign(new Error(`private error context ${code}`), { code });

const createFs = (spec = {}) => {
  const files = {};
  for (const [pid, { parentPid = 1, rssMb = 10, ticks = "100" }] of Object.entries(spec)) {
    files[`/proc/${pid}/stat`] = stat(pid, parentPid, ticks);
    files[`/proc/${pid}/status`] = status(parentPid, rssMb);
    files[`/proc/${pid}/smaps_rollup`] = rollup();
  }
  const readContent = (filePath) => {
    const value = files[filePath];
    if (value instanceof Error) throw value;
    if (typeof value !== "string") throw error("ENOENT");
    return value;
  };
  const handles = new Map();
  let nextFd = 10;
  const fsModule = {
    readdirSync: vi.fn(() => Object.keys(spec)),
    openSync: vi.fn((filePath) => {
      const contents = readContent(filePath);
      const fd = nextFd++;
      handles.set(fd, contents);
      return fd;
    }),
    readSync: vi.fn((fd, buffer, offset, length, position) => {
      return Buffer.from(handles.get(fd)).copy(buffer, offset, position, position + length);
    }),
    closeSync: vi.fn((fd) => { handles.delete(fd); }),
    promises: {
      open: vi.fn(async (filePath) => {
        const text = readContent(filePath);
        let position = 0;
        return {
          read: async (buffer, offset, length) => {
            const bytesRead = Buffer.from(text).copy(buffer, offset, position, position + length);
            position += bytesRead;
            return { bytesRead };
          },
          close: async () => {},
        };
      }),
    },
  };
  return { files, fsModule };
};

const createCollector = (spec, options = {}) => {
  const fixture = createFs(spec);
  const pssSampler = { read: vi.fn(() => ({ status: "collecting" })), reset: vi.fn() };
  const collector = createGatewayProcessCollector({
    fsModule: fixture.fsModule, monotonicNowFn: () => 0, pssSampler, ...options,
  });
  return { ...fixture, pssSampler, ...collector };
};
const read = (collector, options = {}) => collector.getSnapshot({
  rootPid: 100, workerPid: 200, rootSource: "serving_root", nowMs: 10000, ...options,
});

describe("gateway memory process identities", () => {
  it("uses complete decimal start ticks and parses comm containing parentheses", () => {
    const { fsModule } = createFs({ 100: { ticks: "12345678901234567890" } });
    expect(getProcessIdentity(100, { fsModule })).toEqual({ pid: 100, startTicks: "12345678901234567890" });
    expect(parseProcessStat(stat(100, 1))).toEqual({ pid: 100, parentPid: 1, startTicks: "100" });
    expect(getProcessIdentity("100", { fsModule })).toBeNull();
    expect(getProcessIdentity(-1, { fsModule })).toBeNull();
    expect(getProcessIdentity(999, { fsModule })).toBeNull();
    expect(fsModule.closeSync).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed/oversized identities and validates the Linux boot id", () => {
    const { fsModule, files } = createFs({ 100: {} });
    files["/proc/100/stat"] = "x".repeat(4097);
    expect(getProcessIdentity(100, { fsModule })).toBeNull();
    files["/proc/sys/kernel/random/boot_id"] = "12345678-1234-1234-1234-123456789abc\n";
    expect(getLinuxBootId({ fsModule })).toBe("12345678-1234-1234-1234-123456789abc");
    files["/proc/sys/kernel/random/boot_id"] = "secret words";
    expect(getLinuxBootId({ fsModule })).toBeNull();
    expect(parseProcessStat("100 (x) bad")).toBeNull();
  });
});

describe("gateway process snapshot", () => {
  const tree = {
    100: { rssMb: 50 },
    200: { parentPid: 100, rssMb: 300 },
    300: { parentPid: 200, rssMb: 20 },
    400: { parentPid: 100, rssMb: 30 },
    500: { parentPid: 400, rssMb: 40 },
    999: { rssMb: 900 },
  };

  it("partitions worker descendants and launcher sibling branches without double counting", () => {
    const fixture = createCollector(tree);
    const sample = read(fixture);
    expect(sample).toMatchObject({ status: "fresh", reason: null,
      root: { pid: 100, startTicks: "100" }, worker: { pid: 200, startTicks: "100" },
      groupRssBytes: 440 * kMb, workerRssBytes: 300 * kMb,
      childRssBytes: 20 * kMb, childCount: 1,
      launcherRssBytes: 120 * kMb, launcherCount: 3, processCount: 5 });
    expect(sample.contributors).toEqual([
      { pid: 100, role: "launcher", rssBytes: 50 * kMb },
      { pid: 200, role: "gateway", rssBytes: 300 * kMb },
      { pid: 400, role: "launcher_child", rssBytes: 30 * kMb },
      { pid: 300, role: "gateway_child", rssBytes: 20 * kMb },
      { pid: 500, role: "launcher_child", rssBytes: 40 * kMb },
    ]);
    expect(JSON.stringify(sample)).not.toMatch(/secret|argv|\/proc|parentPid/);
    expect(fixture.fsModule.openSync.mock.calls.every(([file]) => !file.endsWith("cmdline"))).toBe(true);
  });

  it("handles worker-as-root and reports known-empty child groups as zero", () => {
    const fixture = createCollector({ 200: { rssMb: 300 } });
    expect(read(fixture, { rootPid: 200 })).toMatchObject({
      status: "fresh", groupRssBytes: 300 * kMb,
      launcherCount: 0, launcherRssBytes: 0, childCount: 0, childRssBytes: 0,
    });
  });

  it("memoizes topology, isolates returned data, and rejects identity reuse within TTL", () => {
    const fixture = createCollector(tree);
    const sample = read(fixture);
    sample.root.startTicks = "evil";
    sample.contributors[0].role = "evil";
    expect(read(fixture).root.startTicks).toBe("100");
    expect(read(fixture).contributors[0].role).toBe("launcher");
    expect(fixture.fsModule.readdirSync).toHaveBeenCalledTimes(1);
    fixture.files["/proc/200/stat"] = stat(200, 100, "101");
    expect(read(fixture).worker.startTicks).toBe("101");
    expect(fixture.fsModule.readdirSync).toHaveBeenCalledTimes(2);
    read(fixture, { nowMs: 16000 });
    expect(fixture.fsModule.readdirSync).toHaveBeenCalledTimes(3);
  });

  it("marks missing descendant RSS partial without turning unavailable child memory into zero", () => {
    const fixture = createCollector({ 100: {}, 200: { parentPid: 100 }, 300: { parentPid: 200, rssMb: null } });
    const sample = read(fixture);
    expect(sample).toMatchObject({ status: "partial", reason: "incomplete_tree", childCount: 1, childRssBytes: null });
    expect(sample.groupRssBytes).toBe(20 * kMb);
  });

  it("refuses unavailable identities and workers outside the root", () => {
    const fixture = createCollector({ 100: {}, 200: {} });
    expect(read(fixture)).toMatchObject({ status: "unavailable", reason: "worker_outside_tree", groupRssBytes: null });
    delete fixture.files["/proc/200/stat"];
    expect(read(fixture)).toMatchObject({ status: "partial", reason: "worker_unavailable", worker: null, groupRssBytes: 10 * kMb, workerRssBytes: null });
    expect(read(fixture, { rootPid: null, workerPid: null })).toMatchObject({ root: null, worker: null, groupRssBytes: null });
  });

  it("reports unreadable census, scan caps and time budgets without claiming a complete tree", () => {
    const capped = createCollector(tree, { maxProcScan: 2 });
    expect(read(capped)).toMatchObject({ status: "partial", reason: "scan_limit" });
    const timed = createCollector(tree, { scanBudgetMs: 0 });
    expect(read(timed)).toMatchObject({ status: "partial", reason: "scan_deadline" });
    const missing = createCollector(tree);
    missing.fsModule.readdirSync.mockImplementation(() => { throw error("ENOENT"); });
    expect(read(missing)).toMatchObject({ status: "unavailable", reason: "proc_unavailable" });
  });

  it("caps public contributor rows but retains counts and totals for the full known tree", () => {
    const spec = { 100: {}, 200: { parentPid: 100 } };
    for (let pid = 300; pid < 450; pid += 1) spec[pid] = { parentPid: 200, rssMb: 1 };
    const sample = read(createCollector(spec));
    expect(sample.status).toBe("fresh");
    expect(sample.processCount).toBe(152);
    expect(sample.childCount).toBe(150);
    expect(sample.groupRssBytes).toBe(170 * kMb);
    expect(sample.contributors).toHaveLength(128);
  });

  it("cycles cannot count a PID twice", () => {
    const sample = read(createCollector({ 100: { parentPid: 200 }, 200: { parentPid: 100 } }));
    expect(sample.processCount).toBe(2);
    expect(sample.groupRssBytes).toBe(20 * kMb);
  });
});

const createPss = (options = {}) => {
  const fixture = createFs({ 100: {}, 200: { parentPid: 100 } });
  let now = 10000;
  const sampler = createProcessPssSampler({ fsModule: fixture.fsModule,
    nowFn: () => now, monotonicNowFn: () => 0, ...options });
  const members = [
    { pid: 100, parentPid: 1, startTicks: "100", role: "launcher" },
    { pid: 200, parentPid: 100, startTicks: "100", role: "gateway" },
  ];
  const snapshot = { root: { pid: 100, startTicks: "100" }, worker: { pid: 200, startTicks: "100" }, atMs: now, status: "fresh" };
  return { ...fixture, sampler, members, snapshot, setNow: (value) => { now = value; } };
};

describe("bounded process PSS sampling", () => {
  it("parses shared-page-aware counters and does not substitute missing data with zero", () => {
    expect(parseSmapsRollup(rollup())).toEqual({ rssBytes: 102400, pssBytes: 71680, privateBytes: 51200, privateHugetlbBytes: 0 });
    expect(parseSmapsRollup(rollup().replace(/^Pss:.*\n/m, ""))).toBeNull();
    expect(parseSmapsRollup(`${rollup()}Pss: 1 kB\n`)).toBeNull();
    expect(parseSmapsRollup(rollup(100, 200))).toBeNull();
    expect(parseSmapsRollup("x".repeat(16385))).toBeNull();
    expect(parseSmapsRollup(rollup(0, 0, 0, 0)).pssBytes).toBe(0);
  });

  it("starts asynchronously, deduplicates callers, pairs RSS/PSS, and throttles refresh", async () => {
    const { sampler, snapshot, members, fsModule, setNow } = createPss();
    expect(sampler.read(snapshot, members).status).toBe("collecting");
    sampler.read(snapshot, members);
    expect(fsModule.promises.open).not.toHaveBeenCalled();
    await sampler.settleForTests();
    expect(sampler.read(snapshot, members)).toMatchObject({ status: "fresh", reason: null,
      atMs: 10000, rssBytes: 204800, pssBytes: 143360, privateBytes: 102400, readCount: 2, processCount: 2 });
    expect(fsModule.promises.open).toHaveBeenCalledTimes(6);
    setNow(309999);
    sampler.read(snapshot, members);
    await sampler.settleForTests();
    expect(fsModule.promises.open).toHaveBeenCalledTimes(6);
    setNow(310000);
    sampler.read(snapshot, members);
    await sampler.settleForTests();
    expect(fsModule.promises.open).toHaveBeenCalledTimes(12);
  });

  it("unavailable platforms stay null and never open proc files", () => {
    const { sampler, snapshot, members, fsModule } = createPss({ platform: "darwin" });
    expect(sampler.read(snapshot, members)).toMatchObject({ status: "unavailable", reason: "unsupported", pssBytes: null });
    expect(fsModule.promises.open).not.toHaveBeenCalled();
  });

  it("publishes only a labeled subtotal for unreadable, capped or incomplete membership", async () => {
    for (const kind of ["permission", "cap", "topology"]) {
      const fixture = createPss(kind === "cap" ? { maxMembers: 1 } : {});
      if (kind === "permission") fixture.files["/proc/200/smaps_rollup"] = error("EACCES");
      if (kind === "topology") fixture.snapshot.status = "partial";
      fixture.sampler.read(fixture.snapshot, fixture.members);
      await fixture.sampler.settleForTests();
      const sample = fixture.sampler.read(fixture.snapshot, fixture.members);
      expect(sample.status).toBe("partial");
      expect(sample.pssBytes).toBeNull();
      expect(sample.rssBytes).toBeNull();
      expect(sample.privateBytes).toBeNull();
      expect(sample.sampledPssBytes).toBeGreaterThan(0);
      expect(JSON.stringify(sample)).not.toContain("private error context");
    }
  });

  it("invalidates reused member identities and missing counters", async () => {
    const fixture = createPss();
    fixture.files["/proc/200/stat"] = stat(200, 100, "200");
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject({ status: "partial", reason: "process_changed", readCount: 1, pssBytes: null });
    const invalid = createPss();
    invalid.files["/proc/200/smaps_rollup"] = "empty";
    invalid.sampler.read(invalid.snapshot, invalid.members);
    await invalid.sampler.settleForTests();
    expect(invalid.sampler.read(invalid.snapshot, invalid.members).reason).toBe("invalid_sample");
  });

  it("rejects identity reuse during the rollup read and oversized kernel results", async () => {
    for (const kind of ["reused", "oversized"]) {
      const fixture = createPss();
      const originalOpen = fixture.fsModule.promises.open.getMockImplementation();
      if (kind === "oversized") fixture.files["/proc/200/smaps_rollup"] = "x".repeat(16385);
      else fixture.fsModule.promises.open.mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === "/proc/200/smaps_rollup") fixture.files["/proc/200/stat"] = stat(200, 100, "201");
        return handle;
      });
      fixture.sampler.read(fixture.snapshot, fixture.members);
      await fixture.sampler.settleForTests();
      expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject({
        status: "partial", reason: kind === "reused" ? "process_changed" : "invalid_sample", readCount: 1, pssBytes: null,
      });
    }
  });

  it.each([16383, 16384, 16385])("caps requested and consumed bytes for a %i-byte rollup", async (size) => {
    const fixture = createPss();
    const filePath = "/proc/200/smaps_rollup";
    fixture.files[filePath] = rollup().padEnd(size, " ");
    const originalOpen = fixture.fsModule.promises.open.getMockImplementation();
    const reads = [];
    let close;
    fixture.fsModule.promises.open.mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== filePath) return handle;
      close = vi.fn(() => handle.close());
      return {
        close,
        read: async (buffer, offset, length, position) => {
          // Short reads must share the same per-file byte allowance.
          const result = await handle.read(buffer, offset, Math.min(length, 1024), position);
          reads.push({ requested: length, consumed: result.bytesRead });
          return result;
        },
      };
    });
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await fixture.sampler.settleForTests();
    expect(Math.max(...reads.map(({ requested }) => requested))).toBeLessThanOrEqual(16384);
    expect(reads.reduce((total, { consumed }) => total + consumed, 0)).toBe(Math.min(size, 16384));
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject(size < 16384
      ? { status: "fresh", pssBytes: 143360, readCount: 2 }
      : { status: "partial", reason: "invalid_sample", pssBytes: null, readCount: 1 });
  });

  it("preserves labeled stale values after a failed refresh and membership changes", async () => {
    const fixture = createPss();
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members.slice(0, 1))).toMatchObject({ status: "stale", reason: "membership_changed" });
    fixture.setNow(310000);
    fixture.files["/proc/200/smaps_rollup"] = error("EACCES");
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject({ status: "stale", reason: "permission_denied", pssBytes: 143360, atMs: 10000 });
    fixture.setNow(370001);
    expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject({ status: "stale", reason: "sample_stale" });
  });

  it("keeps the operation owned across deadlines, invalidation and process replacement", async () => {
    let elapsed = 0;
    const fixture = createPss({ monotonicNowFn: () => elapsed });
    const originalOpen = fixture.fsModule.promises.open.getMockImplementation();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    fixture.fsModule.promises.open.mockImplementation(async (...args) => {
      await blocked;
      return originalOpen(...args);
    });
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await Promise.resolve();
    elapsed = 2000;
    const replacement = { ...fixture.snapshot, root: { pid: 300, startTicks: "101" }, worker: { pid: 300, startTicks: "101" } };
    fixture.sampler.read(replacement, [{ pid: 300, startTicks: "101", parentPid: 1 }]);
    expect(fixture.fsModule.promises.open).toHaveBeenCalledTimes(1);
    fixture.sampler.reset();
    fixture.sampler.read(fixture.snapshot, fixture.members);
    expect(fixture.fsModule.promises.open).toHaveBeenCalledTimes(1);
    release();
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members).status).toBe("collecting");
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members).status).toBe("fresh");
  });

  it("a read finishing past the deadline cannot publish a complete sample", async () => {
    let elapsed = 0;
    const fixture = createPss({ monotonicNowFn: () => elapsed });
    const originalOpen = fixture.fsModule.promises.open.getMockImplementation();
    fixture.fsModule.promises.open.mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0].endsWith("smaps_rollup")) elapsed = 1001;
      return handle;
    });
    fixture.sampler.read(fixture.snapshot, fixture.members);
    await fixture.sampler.settleForTests();
    expect(fixture.sampler.read(fixture.snapshot, fixture.members)).toMatchObject({ status: "unavailable", reason: "deadline", pssBytes: null });
    expect(fixture.fsModule.promises.open).toHaveBeenCalledTimes(2);
  });
});
