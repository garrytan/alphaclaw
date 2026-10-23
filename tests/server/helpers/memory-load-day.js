// Garry's Oct 23 2026 box, as his deployed agent's critique recorded it
// (handoffs/memory-redesign/critique.md, ALPH-22): 100 GB host, no container
// limit, configured heap 8192 MB (V8 limit 8.8 GB), gateway restarted at
// 11:15. Three episodes the 0.10.7 watchdog called "critical" all cleared on
// their own:
//   E1 12:47        group peak 3,984 MB
//   E2 12:55-13:13  latched at 3,400 MB (855 MB/h), group peak 4,347 MB
//   E3 14:20-14:23  group peak 6,135 MB: worker 3.5 GB, 23 tool children
//                   1.7 GB, V8 heap 789 MB of 8.8 GB
// The critique does not itemize the remaining ~935 MB at E3; it is modelled
// as a launcher-branch process so every recorded number holds. Between the
// episodes the worker's working set grows ~486 MB/h (2.0 GB at 11:15 to
// 3.5 GB at 14:20) and post-GC heap floors stay flat.
const kMb = 1024 * 1024;
const kDay = "2026-10-23";
const at = (clock) => Date.parse(kDay + "T" + clock + ":00.000Z");
const kRestartMs = at("11:15");
const kHeapLimitMb = 9011;
const kLauncherMb = 60;
const kRoot = { pid: 100, startTicks: "200" };
const kWorker = { pid: 101, startTicks: "201" };

const minutesSince = (fromMs, nowMs) => (nowMs - fromMs) / 60_000;
const triangle = (nowMs, startClock, peakClock, endClock, height) => {
  const [start, peak, end] = [at(startClock), at(peakClock), at(endClock)];
  if (nowMs <= start || nowMs >= end) return 0;
  return nowMs <= peak ? height * (nowMs - start) / (peak - start) : height * (end - nowMs) / (end - peak);
};
const jitter = (tick) => [0, 3, -2, 1, -3, 2][tick % 6];

const loadDayAt = (nowMs, tick) => {
  const workerMb = 2000 + minutesSince(kRestartMs, nowMs) * (1500 / 185) + jitter(tick);
  const baseChildMb = 300 + minutesSince(kRestartMs, nowMs) * (400 / 180);
  const childBurstMb = triangle(nowMs, "12:38", "12:47", "12:51", 675) +
    triangle(nowMs, "12:55", "13:05", "13:13", 852) +
    triangle(nowMs, "14:17", "14:20", "14:23", 1700 - (300 + 185 * (400 / 180)));
  const launcherChildMb = triangle(nowMs, "14:17", "14:20", "14:23", 6135 - 3500 - 1700 - kLauncherMb);
  const childCount = 6 + Math.round(triangle(nowMs, "12:38", "12:47", "12:51", 8) +
    triangle(nowMs, "12:55", "13:05", "13:13", 10) + triangle(nowMs, "14:17", "14:20", "14:23", 17));
  const heapUsedMb = 600 + [0, 40, 80, 120, 160, 189][tick % 6];
  return { workerMb, childMb: baseChildMb + childBurstMb, childCount, launcherChildMb, heapUsedMb, gcFloorMb: 450 + jitter(tick) };
};

// A real V8 heap leak on the same box: worker and heap both climb 40 MB/min
// from 11:15 and post-GC floors rise with them; the tool children stay flat.
const heapLeakAt = (nowMs, tick) => {
  const grownMb = minutesSince(kRestartMs, nowMs) * 40;
  return { workerMb: 2000 + grownMb + jitter(tick), childMb: 300, childCount: 6, launcherChildMb: 0,
    heapUsedMb: 1200 + grownMb, gcFloorMb: 1050 + grownMb };
};

const processSnapshotFor = (nowMs, day, { workerPrivate = "fresh" } = {}) => {
  const groupMb = kLauncherMb + day.launcherChildMb + day.workerMb + day.childMb;
  const contributors = [
    { pid: kRoot.pid, role: "launcher", rssBytes: kLauncherMb * kMb },
    { pid: kWorker.pid, role: "gateway", rssBytes: Math.round(day.workerMb * kMb) },
    ...Array.from({ length: day.childCount }, (_, i) => ({ pid: 4000 + i, role: "gateway_child",
      rssBytes: Math.round((day.childMb / day.childCount) * kMb) })),
    ...(day.launcherChildMb > 0 ? [{ pid: 3900, role: "launcher_child", rssBytes: Math.round(day.launcherChildMb * kMb) }] : []),
  ];
  return {
    status: "fresh", reason: null, atMs: nowMs, root: kRoot, worker: kWorker, rootSource: "serving_root",
    groupRssBytes: Math.round(groupMb * kMb), workerRssBytes: Math.round(day.workerMb * kMb),
    childRssBytes: Math.round(day.childMb * kMb), childCount: day.childCount,
    launcherRssBytes: Math.round((kLauncherMb + day.launcherChildMb) * kMb),
    launcherCount: day.launcherChildMb > 0 ? 2 : 1, processCount: contributors.length,
    sampledProcessCount: contributors.length, contributors,
    pss: {
      status: "stale", reason: "membership_changed",
      workerStatus: workerPrivate, workerAtMs: nowMs - 60_000,
      workerPrivateBytes: workerPrivate === "unavailable" ? null : Math.round((day.workerMb - 260) * kMb),
    },
  };
};

const telemetryFor = (nowMs, tick, day) => ({
  status: "fresh", reason: null, atMs: nowMs,
  records: [{
    seq: tick + 1, atMs: nowMs, rssBytes: Math.round(day.workerMb * kMb),
    heapUsedBytes: Math.round(day.heapUsedMb * kMb), heapTotalBytes: Math.round((day.heapUsedMb + 100) * kMb),
    heapLimitBytes: kHeapLimitMb * kMb, externalBytes: 120 * kMb, arrayBuffersBytes: 20 * kMb,
    gc: { atMs: nowMs - 1000, heapUsedBytes: Math.round(day.gcFloorMb * kMb), count: tick + 1 },
  }],
});

module.exports = { kMb, at, kRestartMs, kHeapLimitMb, kRoot, kWorker, loadDayAt, heapLeakAt,
  processSnapshotFor, telemetryFor };
