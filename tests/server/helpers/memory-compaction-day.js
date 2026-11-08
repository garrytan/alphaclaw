// Garry's Nov 8 2026 box (GST-1829, ALPH-74): AlphaClaw 0.10.210, OpenClaw
// 2026.10.9, 100 GiB container, configured heap 8192 MB (V8 limit 8,384 MB),
// watchdog.memory budgetMb 5500 with autoRestart on. The gateway worker
// started 12:48. OpenClaw's safeguard compactions of one 575 MB Telegram
// session ran at about 16:15, 17:08, 17:15 and 17:32 (each finished 2-3
// minutes later), and each one parses the whole transcript into the main
// heap until it ends.
// Worker RSS is the box's own record: its 10-minute RSS log (13:08-17:58,
// linear between samples) and, 17:25-17:47, the gateway's 30-second memory
// samples verbatim (the 17:32 compaction: 4,372 -> 5,740 MB in three
// minutes, back to 4,230 MB by 17:47). The 0.10.210 watchdog latched
// leak_suspected at 14:45, 16:40 and 17:44 and paged a warning for each.
const kMb = 1024 * 1024;
const kDay = "2026-11-08";
const at = (clock) => Date.parse(kDay + "T" + clock + ".000Z");
const kTickMs = 60_000;
const kStartMs = at("12:49:28");
const kEndMs = at("18:05:28");
const kHeapLimitMb = 8384;
const kBudgetMb = 5500;
const kLauncherMb = 60;
const kChildMb = 300;
const kRoot = { pid: 13014, startTicks: "200" };
const kWorker = { pid: 13022, startTicks: "201" };

// [clock, worker RSS MB]: the 10-minute log, then the 30-second samples.
const kRssLog = [
  ["12:49:28", 2700], ["13:03:31", 2759],
  ["13:08:14", 3005], ["13:18:14", 3034], ["13:28:14", 2975], ["13:38:14", 3104], ["13:48:14", 3048],
  ["13:58:14", 2988], ["14:08:14", 3247], ["14:18:14", 3398], ["14:28:14", 3282], ["14:38:14", 3476],
  ["14:48:14", 3407], ["14:58:14", 3262], ["15:08:14", 3296], ["15:18:14", 3519], ["15:28:14", 3397],
  ["15:38:14", 3521], ["15:48:14", 3361], ["15:58:14", 3504], ["16:08:14", 3978], ["16:18:14", 4901],
  ["16:28:14", 3861], ["16:38:14", 3871], ["16:48:14", 3923], ["16:58:14", 3965], ["17:08:14", 5029],
  ["17:18:14", 4467],
  ["17:25:29", 4324], ["17:26:29", 4358], ["17:27:29", 4366], ["17:29:29", 4447], ["17:30:29", 4314],
  ["17:31:29", 4372], ["17:31:59", 5087], ["17:32:29", 5416], ["17:32:59", 5608], ["17:33:29", 5658],
  ["17:33:59", 5670], ["17:34:29", 5740], ["17:34:59", 5111], ["17:35:29", 5061], ["17:35:59", 5021],
  ["17:36:29", 4964], ["17:37:29", 4942], ["17:38:29", 4921], ["17:39:29", 4791], ["17:40:29", 4792],
  ["17:41:29", 4669], ["17:42:29", 4567], ["17:43:29", 4424], ["17:44:29", 4417], ["17:45:29", 4381],
  ["17:46:29", 4272], ["17:47:29", 4230], ["17:58:14", 4223], ["18:05:28", 4223],
].map(([clock, mb]) => [at(clock), mb]);

// V8 heap used, MB: the 13:03 report, the three latch events, the 30-second
// samples around the 17:32 compaction, then flat.
const kHeapLog = [
  ["12:49:28", 480], ["13:03:31", 524], ["14:45:28", 744], ["16:40:28", 1004], ["17:25:29", 1314],
  ["17:31:29", 1267], ["17:31:59", 2010], ["17:32:29", 2426], ["17:32:59", 2361], ["17:33:29", 2486],
  ["17:33:59", 2334], ["17:34:29", 2493], ["17:34:59", 1234], ["17:35:29", 1220], ["17:44:28", 1224],
  ["18:05:28", 1260],
].map(([clock, mb]) => [at(clock), mb]);

const interpolate = (log, nowMs) => {
  if (nowMs <= log[0][0]) return log[0][1];
  for (let i = 1; i < log.length; i += 1) {
    const [t1, v1] = log[i];
    if (nowMs <= t1) {
      const [t0, v0] = log[i - 1];
      return v0 + (v1 - v0) * (nowMs - t0) / (t1 - t0);
    }
  }
  return log[log.length - 1][1];
};

const compactionDayAt = (nowMs) => {
  const workerMb = interpolate(kRssLog, nowMs);
  const heapUsedMb = interpolate(kHeapLog, nowMs);
  return { workerMb, heapUsedMb, gcFloorMb: heapUsedMb - 120 };
};

// The same box with a real leak on top: from 16:00 the worker grows 30 MB a
// minute and keeps it, compactions included, and post-GC heap floors rise
// with it.
const leakOnCompactionDayAt = (nowMs) => {
  const day = compactionDayAt(nowMs);
  const grownMb = Math.max(0, (nowMs - at("16:00:28")) / 60_000) * 30;
  return { workerMb: day.workerMb + grownMb, heapUsedMb: day.heapUsedMb + grownMb,
    gcFloorMb: day.gcFloorMb + grownMb };
};

const processSnapshotFor = (nowMs, day) => {
  const contributors = [
    { pid: kRoot.pid, role: "launcher", rssBytes: kLauncherMb * kMb },
    { pid: kWorker.pid, role: "gateway", rssBytes: Math.round(day.workerMb * kMb) },
    { pid: 14000, role: "gateway_child", rssBytes: kChildMb * kMb },
  ];
  return {
    status: "fresh", reason: null, atMs: nowMs, root: kRoot, worker: kWorker, rootSource: "serving_root",
    groupRssBytes: Math.round((kLauncherMb + day.workerMb + kChildMb) * kMb),
    workerRssBytes: Math.round(day.workerMb * kMb), childRssBytes: kChildMb * kMb, childCount: 1,
    launcherRssBytes: kLauncherMb * kMb, launcherCount: 1, processCount: 3, sampledProcessCount: 3, contributors,
    pss: { status: "fresh", reason: null, atMs: nowMs, workerStatus: "fresh", workerAtMs: nowMs,
      workerPssBytes: Math.round((day.workerMb - 40) * kMb), workerPrivateBytes: Math.round((day.workerMb - 70) * kMb) },
  };
};

const telemetryFor = (nowMs, tick, day, { status = "fresh" } = {}) => (status !== "fresh"
  ? { status, reason: "stale_file", atMs: nowMs - 10 * 60_000, records: [] }
  : {
    status: "fresh", reason: null, atMs: nowMs,
    records: [{
      seq: tick + 1, atMs: nowMs, rssBytes: Math.round(day.workerMb * kMb),
      heapUsedBytes: Math.round(day.heapUsedMb * kMb), heapTotalBytes: Math.round((day.heapUsedMb + 200) * kMb),
      heapLimitBytes: kHeapLimitMb * kMb, externalBytes: 50 * kMb, arrayBuffersBytes: 10 * kMb,
      gc: { atMs: nowMs - 1000, heapUsedBytes: Math.round(day.gcFloorMb * kMb), count: tick + 1 },
    }],
  });

module.exports = { kMb, at, kTickMs, kStartMs, kEndMs, kBudgetMb, kHeapLimitMb, kRoot, kWorker,
  compactionDayAt, leakOnCompactionDayAt, processSnapshotFor, telemetryFor };
