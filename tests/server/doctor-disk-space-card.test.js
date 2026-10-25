const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildDiskSpaceCards } = require("../../lib/server/doctor/disk-space-card");
const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");
const { analyzeBootstrapContext } = require("../../lib/server/doctor/bootstrap-context");
const { kCurrentContextProfile } = require("../../lib/server/doctor/context-profiles");
const { createDiskSpaceMonitor } = require("../../lib/server/disk-space/monitor");

const kGb = 1024 ** 3;

const volume = (extra = {}) => ({
  id: "state", path: "/data/.openclaw", mountPath: "/data", sampleStatus: "fresh",
  freeBytes: 8 * kGb, sizeBytes: 200 * kGb, growthBytesPerHour: 12 * kGb, etaMs: 40 * 60_000,
  state: "low", episodeId: "disk-state-1792911600000",
  growers: { basis: "growth", windowMs: 7_200_000, truncated: false, entries: [
    { path: "/data/.openclaw/.cache", bytes: 90 * kGb, growthBytes: 60 * kGb },
    { path: "/data/diag", bytes: 20 * kGb, growthBytes: 18 * kGb },
  ] },
  ...extra,
});

describe("doctor: disk-space card", () => {
  it("emits a P1 card while a low episode is open", () => {
    const [card, ...rest] = buildDiskSpaceCards({ volumes: [volume()] });
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      sourceKey: "det:disk-space-low:disk-state-1792911600000",
      priority: "P1",
      category: "workspace state",
      title: "Disk space is running low",
      targetPaths: [],
    });
    expect(card.summary).toContain("The volume at /data that holds OpenClaw's state has 8.0 GB free of 200 GB (4%).");
    expect(card.summary).toContain("growing at 12.0 GB/hour; at this rate the volume is full in about 40 minutes.");
    expect(card.evidence.map((entry) => entry.text)).toEqual([
      expect.stringContaining("/data: 8.0 GB free of 200 GB (4%)"),
      "Fastest-growing directories over 2 hours:",
      "/data/.openclaw/.cache: +60.0 GB in 2 hours (now 90.0 GB)",
      "/data/diag: +18.0 GB in 2 hours (now 20.0 GB)",
    ]);
    expect(card.fixPrompt).toContain("Never delete or truncate OpenClaw's state databases");
    expect(card.fixPrompt).toContain("*.heapsnapshot");
  });

  it("replaces the P1 card with a P0 card when the episode is critical", () => {
    const cards = buildDiskSpaceCards({ volumes: [volume({ state: "critical" })] });
    expect(cards.map((card) => [card.sourceKey, card.priority])).toEqual([
      ["det:disk-space-critical:disk-state-1792911600000", "P0"],
    ]);
    expect(cards[0].summary).toContain("the gateway stops working");
  });

  it("emits no card once the episode clears, and rejects malformed input", () => {
    const monitor = createDiskSpaceMonitor();
    const at = Date.parse("2026-10-24T07:00:00.000Z");
    const r = (free) => [{ id: "state", path: "/d", status: "fresh", freeBytes: free * kGb, sizeBytes: 100 * kGb }];
    monitor.observe(r(9), at);
    expect(buildDiskSpaceCards(monitor.getSnapshot())).toHaveLength(1);
    monitor.observe(r(13), at + 60_000);
    monitor.observe(r(13), at + 120_000);
    expect(buildDiskSpaceCards(monitor.getSnapshot())).toEqual([]);

    for (const extra of [{ state: "ok" }, { episodeId: "disk-state-1 /etc/passwd" }, { episodeId: null }, { freeBytes: "lots" }, { sizeBytes: 0 }]) {
      expect(buildDiskSpaceCards({ volumes: [volume(extra)] })).toEqual([]);
    }
    expect(buildDiskSpaceCards(null)).toEqual([]);
    expect(buildDiskSpaceCards({ volumes: "nope" })).toEqual([]);
  });

  it("says so when there is no earlier census or none ran", () => {
    const largest = buildDiskSpaceCards({ volumes: [volume({ etaMs: null, growers: { basis: "largest", truncated: true, entries: [{ path: "/data/.openclaw", bytes: 150 * kGb }] } })] })[0];
    expect(largest.summary).not.toContain("full in about");
    expect(largest.evidence.slice(1).map((entry) => entry.text)).toEqual([
      "No earlier size census to compare with; largest directories (estimates; the census stopped at its budget):",
      "/data/.openclaw: 150 GB",
    ]);
    const none = buildDiskSpaceCards({ volumes: [volume({ growers: null })] })[0];
    expect(none.evidence[1].text).toContain("has not run for this episode");
  });

  it("rides buildDeterministicCards with the sanitizer applied", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-disk-ws-"));
    const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-disk-managed-"));
    try {
      const cards = buildDeterministicCards({
        workspaceRoot,
        managedRoot,
        profile: kCurrentContextProfile,
        bootstrapContext: analyzeBootstrapContext({ workspaceRoot, profile: kCurrentContextProfile }),
        onboarded: true,
        diskSpace: { volumes: [volume({ state: "critical" }), volume({ id: "diagnostic", episodeId: "disk-diagnostic-1", mountPath: "/scratch" })] },
        sanitize: (text) => String(text).replace("/data/diag", "[path]"),
      });
      const disk = cards.filter((card) => card.sourceKey.startsWith("det:disk-space-"));
      expect(disk.map((card) => [card.sourceKey, card.priority, card.source])).toEqual([
        ["det:disk-space-critical:disk-state-1792911600000", "P0", "deterministic"],
        ["det:disk-space-low:disk-diagnostic-1", "P1", "deterministic"],
      ]);
      expect(disk[1].summary).toContain("Node's diagnostic reports and heap snapshots");
      expect(disk[0].evidence.map((entry) => entry.text)).toContain("[path]: +18.0 GB in 2 hours (now 20.0 GB)");
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(managedRoot, { recursive: true, force: true });
    }
  });
});
