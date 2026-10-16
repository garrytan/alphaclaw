const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  appendBootHistory,
  readBootHistory,
  estimateBootDuration,
  kBootHistoryMax,
} = require("../../lib/server/boot-progress/history");
const bootProgress = require("../../lib/server/boot-progress");

const row = (overrides = {}) => ({ v: 1, kind: "restarting", outcome: "ready", complete: true, totalMs: 60_000, openclawVersion: "2026.10.4", ...overrides });
const quietLogger = { log: () => {}, warn: () => {} };

describe("boot history", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-history-"));
  });
  afterEach(() => {
    bootProgress.resetBootTimelineForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty when the file is missing and keeps the last 20 rows", () => {
    expect(readBootHistory({ managedDir: dir })).toEqual({ status: "missing", entries: [] });
    for (let i = 0; i < kBootHistoryMax + 5; i += 1) appendBootHistory({ managedDir: dir, entry: row({ totalMs: i + 1 }) });
    const { status, entries } = readBootHistory({ managedDir: dir });
    expect(status).toBe("ok");
    expect(entries).toHaveLength(kBootHistoryMax);
    expect(entries[0].totalMs).toBe(6);
  });

  it("survives a corrupt file: reads empty, the next append starts over", () => {
    fs.writeFileSync(path.join(dir, "boot-history.json"), "{not json");
    expect(readBootHistory({ managedDir: dir }).status).toBe("unreadable");
    const warn = vi.fn();
    expect(appendBootHistory({ managedDir: dir, entry: row(), logger: { warn } })).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable"));
    expect(readBootHistory({ managedDir: dir }).entries).toHaveLength(1);
  });

  it("needs three comparable successful boots before it estimates", () => {
    expect(estimateBootDuration({ entries: [row(), row()], kind: "restarting" })).toBeNull();
    expect(estimateBootDuration({ entries: [row({ totalMs: 50_000 }), row({ totalMs: 90_000 }), row({ totalMs: 60_000 })], kind: "restarting" }))
      .toEqual({ estimateMs: 60_000, samples: 3, basis: "same_kind" });
  });

  it("never trains on failed, aborted, superseded, unverified or incomplete boots, even when they dominate", () => {
    const entries = [
      row({ totalMs: 120_000 }),
      row({ outcome: "failed", totalMs: 3_000 }),
      row({ outcome: "failed", totalMs: 2_000 }),
      row({ totalMs: 110_000 }),
      row({ outcome: "aborted", totalMs: 1_000 }),
      row({ outcome: "superseded", totalMs: 1_000 }),
      row({ outcome: "unverified", totalMs: 1_000 }),
      row({ complete: false, totalMs: 1_000 }),
      row({ outcome: "failed", reason: "ready_timeout", totalMs: 1_800_000 }),
    ];
    expect(estimateBootDuration({ entries, kind: "restarting" })).toBeNull();
    entries.push(row({ totalMs: 100_000 }));
    expect(estimateBootDuration({ entries, kind: "restarting" }).estimateMs).toBe(110_000);
  });

  it("keeps kinds apart and lets an OpenClaw upgrade fall back to upgrades of any version (still three samples)", () => {
    const upgrades = [
      row({ kind: "upgrading_openclaw", openclawVersion: "2026.10.2", totalMs: 300_000 }),
      row({ kind: "upgrading_openclaw", openclawVersion: "2026.10.3", totalMs: 330_000 }),
    ];
    const restarts = [row(), row(), row()];
    expect(estimateBootDuration({ entries: [...upgrades, ...restarts], kind: "upgrading_openclaw", openclawVersion: "2026.10.4" })).toBeNull();
    const more = [...upgrades, row({ kind: "upgrading_openclaw", openclawVersion: "2026.9.33", totalMs: 360_000 }), ...restarts];
    expect(estimateBootDuration({ entries: more, kind: "upgrading_openclaw", openclawVersion: "2026.10.4" }))
      .toEqual({ estimateMs: 330_000, samples: 3, basis: "any_version" });
    const same = [...more, ...[1, 2, 3].map((i) => row({ kind: "upgrading_openclaw", openclawVersion: "2026.10.4", totalMs: 400_000 + i }))];
    expect(estimateBootDuration({ entries: same, kind: "upgrading_openclaw", openclawVersion: "2026.10.4" }).basis).toBe("same_version");
  });

  it("is written by the process's one timeline at its terminal outcome, never before", () => {
    const timeline = bootProgress.beginBootTimeline({ bootId: "1:1", startedAtMs: Date.now(), managedDir: dir, logger: quietLogger, readSources: () => ({}) });
    expect(bootProgress.beginBootTimeline({ bootId: "other", managedDir: dir, logger: quietLogger })).toBe(timeline);
    expect(readBootHistory({ managedDir: dir }).entries).toHaveLength(0);
    timeline.abort("shutdown");
    expect(readBootHistory({ managedDir: dir }).entries).toEqual([expect.objectContaining({ outcome: "aborted" })]);
  });

  it("a not-onboarded listen leaves the history unchanged", () => {
    bootProgress.beginBootTimeline({ bootId: "1:2", managedDir: dir, onboarded: false, logger: quietLogger });
    expect(fs.existsSync(path.join(dir, "boot-history.json"))).toBe(false);
  });
});
