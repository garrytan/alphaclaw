const { createDiskSpaceTracker } = require("../../lib/server/disk-space");

const kGb = 1024 ** 3;
const kMin = 60_000;
const kStartMs = Date.parse("2026-10-24T07:00:00.000Z");

const reading = (freeGb, sizeGb = 100, extra = {}) => ({
  id: "state", path: "/data/.openclaw", mountPath: "/data", dev: 2, status: "fresh",
  freeBytes: freeGb * kGb, sizeBytes: sizeGb * kGb, ...extra,
});
const census = (atMs, dirs) => ({
  atMs, truncated: false,
  dirs: Object.entries(dirs).map(([p, gb]) => ({ path: p, bytes: gb * kGb, rootDev: 2 })),
});

const createHarness = ({ notifyResult = { ok: true }, runCensus } = {}) => {
  let nowMs = kStartMs;
  let volumes = [reading(50)];
  const logEvent = vi.fn();
  const notify = vi.fn(async () => notifyResult);
  const census$ = runCensus ?? vi.fn(async () => census(nowMs, { "/data/.openclaw": 40, "/data/.openclaw/.cache": 30 }));
  const tracker = createDiskSpaceTracker({
    stateDir: "/data/.openclaw",
    censusRoots: ["/data"],
    env: {},
    readVolumes: vi.fn(() => volumes),
    runCensus: census$,
    nowFn: () => nowMs,
    logEvent,
    notify,
    withViewLogsSuffix: (line) => `${line} - [View logs](http://x/#/watchdog)`,
    createCorrelationId: () => "corr",
  });
  const step = async (next, advanceMs = kMin) => {
    nowMs += advanceMs;
    volumes = Array.isArray(next) ? next : [reading(next)];
    await tracker.tick();
  };
  const messages = () => notify.mock.calls.map(([message]) => message);
  const events = () => logEvent.mock.calls.map(([eventType, source, status, details]) => ({ eventType, source, status, details }));
  return { tracker, step, notify, messages, events, runCensus: census$, setNow: (ms) => { nowMs = ms; } };
};

describe("disk-space tracker", () => {
  it("sends one notice per tier per episode and a cleared follow-up", async () => {
    const h = createHarness();
    await h.step(50);
    await h.step(9);
    await h.step(9.5);
    await h.step(8);
    await h.step(4);
    await h.step(4.5);
    await h.step(3);
    await h.step(13);
    await h.step(13);
    const messages = h.messages();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain("🐺 *AlphaClaw Watchdog*\n🟡 Disk space low on /data - [View logs](http://x/#/watchdog)");
    expect(messages[0]).toContain("9.0 GB free of 100 GB (9% free) on the volume that holds OpenClaw's state (`/data/.openclaw`).");
    expect(messages[0]).toContain("Never delete OpenClaw's state databases.");
    expect(messages[1]).toContain("🔴 Disk almost full on /data");
    expect(messages[1]).toContain("OpenClaw can no longer write its state");
    expect(messages[2]).toContain("✅ Disk space back to normal on /data");
    expect(messages[2]).toContain("The episode lasted 7 minutes and reached critical.");
    expect(h.events().map((e) => [e.eventType, e.source, e.details.kind])).toEqual([
      ["disk", "disk-monitor", "disk_low"],
      ["disk", "disk-monitor", "disk_critical"],
      ["disk", "disk-monitor", "disk_recovered"],
    ]);
    expect(h.events()[0].details).toMatchObject({ volume: "state", mountPath: "/data", freeBytes: 9 * kGb, sizeBytes: 100 * kGb, trigger: "level" });
  });

  it("opens directly as critical with a single notice", async () => {
    const h = createHarness();
    await h.step(3);
    await h.step(2.5);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain("🔴 Disk almost full");
    expect(h.messages()[0]).not.toContain("🟡");
  });

  it("sends no cleared follow-up for an episode that never notified", async () => {
    const h = createHarness({ notifyResult: { ok: false, reason: "failed" } });
    await h.step(9);
    await h.step(13);
    await h.step(13);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.events().map((e) => e.details.kind)).toEqual(["disk_low", "disk_recovered"]);
  });

  it("never alerts on an unknown volume", async () => {
    const h = createHarness();
    await h.step([{ id: "state", path: "/data/.openclaw", status: "unknown", reason: "missing" }]);
    await h.step([{ id: "diagnostic", path: "/scratch", status: "unknown", reason: "statfs_failed" }]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
    expect(h.tracker.getSnapshot().volumes.map((v) => [v.id, v.sampleStatus, v.state])).toEqual([
      ["state", "unknown", "ok"], ["diagnostic", "unknown", "ok"],
    ]);
  });

  it("reports the fastest growers against the oldest census in the ring", async () => {
    let calls = 0;
    const sizes = [{ "/data/.openclaw": 40, "/data/.openclaw/.cache": 5, "/data/.openclaw/agents": 30 },
      { "/data/.openclaw": 80, "/data/.openclaw/.cache": 45, "/data/.openclaw/agents": 31 }];
    let now = kStartMs;
    const runCensus = vi.fn(async () => census(now, sizes[Math.min(calls++, 1)]));
    const h = createHarness({ runCensus });
    await h.step(50);
    expect(runCensus).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    now = kStartMs + 20 * kMin;
    await h.step(9, 19 * kMin);
    expect(runCensus).toHaveBeenCalledTimes(2);
    expect(h.messages()[0]).toContain("Fastest-growing directories over the last 20 minutes:\n• `/data/.openclaw/.cache` +40.0 GB (now 45.0 GB)");
    const [volume] = h.tracker.getSnapshot().volumes;
    expect(volume.growers).toMatchObject({ basis: "growth", windowMs: 20 * kMin });
    expect(volume.growers.entries.map((entry) => entry.path)).toEqual(["/data/.openclaw/.cache", "/data/.openclaw/agents"]);
  });

  it("lists the largest directories when there is no earlier census", async () => {
    const h = createHarness();
    await h.step(9);
    expect(h.messages()[0]).toContain("There is no earlier size census to compare with yet, so these are the largest directories:");
    expect(h.messages()[0]).toContain("• `/data/.openclaw` 40.0 GB");
  });

  it("keeps one census in flight and shares it with an opening episode", async () => {
    let release;
    const runCensus = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const h = createHarness({ runCensus });
    await h.step(50);
    expect(runCensus).toHaveBeenCalledTimes(1);
    const opening = h.step(9);
    await Promise.resolve();
    expect(runCensus).toHaveBeenCalledTimes(1);
    release(census(kStartMs, { "/data/.openclaw": 40 }));
    await opening;
    expect(runCensus).toHaveBeenCalledTimes(1);
    expect(h.messages()[0]).toContain("• `/data/.openclaw` 40.0 GB");
  });

  it("survives a throwing census and a throwing sampler", async () => {
    const h = createHarness({ runCensus: vi.fn(async () => { throw new Error("EACCES"); }) });
    await h.step(9);
    expect(h.messages()[0]).toContain("The size census of AlphaClaw's directories did not run");
    const broken = createDiskSpaceTracker({ stateDir: "/x", readVolumes: () => { throw new Error("boom"); }, runCensus: async () => null });
    await expect(broken.tick()).resolves.toBeUndefined();
    expect(broken.getSnapshot().volumes).toEqual([]);
  });

  it("censuses real root paths, the diagnostic dir, and a state dir that lives outside the roots", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "disk-roots-")));
    try {
      fs.mkdirSync(path.join(base, "root", ".openclaw"), { recursive: true });
      fs.mkdirSync(path.join(base, "data", "state"), { recursive: true });
      fs.symlinkSync(path.join(base, "root"), path.join(base, "root-link"));
      const rootsFor = async (stateDir) => {
        const runCensus = vi.fn(async () => null);
        const tracker = createDiskSpaceTracker({
          stateDir,
          censusRoots: [path.join(base, "root-link")],
          env: { NODE_OPTIONS: `--diagnostic-dir=${path.join(base, "diag")}` },
          readVolumes: () => [],
          runCensus,
        });
        await tracker.tick();
        return runCensus.mock.calls[0][0].roots;
      };
      expect(await rootsFor(path.join(base, "root", ".openclaw"))).toEqual([path.join(base, "root"), path.join(base, "diag")]);
      fs.rmSync(path.join(base, "root", ".openclaw"), { recursive: true });
      fs.symlinkSync(path.join(base, "data", "state"), path.join(base, "root", ".openclaw"));
      expect(await rootsFor(path.join(base, "root", ".openclaw"))).toEqual([
        path.join(base, "root"), path.join(base, "diag"), path.join(base, "data", "state"),
      ]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("samples on start and every interval, takes the first background census one interval later, and stops", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(kStartMs);
      const readVolumes = vi.fn(() => [reading(50)]);
      const runCensus = vi.fn(async () => census(Date.now(), {}));
      const tracker = createDiskSpaceTracker({ stateDir: "/data/.openclaw", env: {}, readVolumes, runCensus });
      tracker.start();
      tracker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readVolumes).toHaveBeenCalledTimes(1);
      expect(runCensus).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(kMin);
      expect(readVolumes).toHaveBeenCalledTimes(2);
      expect(runCensus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(14 * kMin);
      expect(runCensus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(kMin);
      expect(runCensus).toHaveBeenCalledTimes(2);
      expect(tracker.getSnapshot().census).toMatchObject({ ringSize: 2, inFlight: false });
      tracker.stop();
      const calls = readVolumes.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * kMin);
      expect(readVolumes).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
