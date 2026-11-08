const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDiskSpaceMonitor, estimateFill } = require("../../lib/server/disk-space/monitor");
const { createDiskSpaceTracker } = require("../../lib/server/disk-space");

const kGb = 1024 ** 3;
const kHour = 60 * 60 * 1000;
const kDay = 24 * kHour;
const kStartMs = Date.parse("2026-11-01T00:00:00.000Z");

const reading = (freeGb, sizeGb = 200) => ({
  id: "state", path: "/data/.openclaw", mountPath: "/data", dev: 2, status: "fresh",
  freeBytes: freeGb * kGb, sizeBytes: sizeGb * kGb,
});

const observeHourly = (monitor, freeAt, hours, { startMs = kStartMs, everyMs = 15 * 60 * 1000 } = {}) => {
  for (let atMs = startMs; atMs <= startMs + hours * kHour; atMs += everyMs) {
    monitor.observe([reading(freeAt((atMs - startMs) / kHour))], atMs);
  }
  return monitor.getSnapshot().volumes[0];
};

describe("disk-space days-to-full estimate", () => {
  it("estimates the days until a slowly filling disk is full once a day of samples shows the trend", () => {
    const monitor = createDiskSpaceMonitor();
    const volume = observeHourly(monitor, (hour) => 40 - (2.5 / 24) * hour, 48);
    expect(volume.fillEstimate.status).toBe("filling");
    expect(volume.fillEstimate.daysToFull).toBeCloseTo(35 / 2.5, 0);
    expect(volume.fillEstimate.growthBytesPerDay / kGb).toBeCloseTo(2.5, 1);
    expect(volume.trendSustained).toBe(false);
    expect(volume.etaMs).toBe(null);
    expect(volume.state).toBe("ok");
  });

  it("says not enough data before the samples span a day", () => {
    const monitor = createDiskSpaceMonitor();
    const volume = observeHourly(monitor, (hour) => 40 - hour, 20);
    expect(volume.fillEstimate).toMatchObject({ status: "not_enough_data", daysToFull: null });
    expect(createDiskSpaceMonitor().getSnapshot().volumes).toEqual([]);
  });

  it("reports not filling for a flat, shrinking or barely growing disk, never a negative or huge number", () => {
    const flat = observeHourly(createDiskSpaceMonitor(), () => 40, 48);
    expect(flat.fillEstimate).toMatchObject({ status: "not_filling", daysToFull: null });
    const shrinking = observeHourly(createDiskSpaceMonitor(), (hour) => 30 + hour * 0.2, 48);
    expect(shrinking.fillEstimate).toMatchObject({ status: "not_filling", daysToFull: null });
    expect(shrinking.fillEstimate.growthBytesPerDay).toBeLessThan(0);
    const glacial = observeHourly(createDiskSpaceMonitor(), (hour) => 190 - (1.2 / 168) * hour, 168);
    expect(glacial.fillEstimate).toMatchObject({ status: "not_filling", daysToFull: null });
  });

  it("uses one sample an hour over the last 7 days, and starts over when the disk is resized", () => {
    const monitor = createDiskSpaceMonitor();
    observeHourly(monitor, (hour) => 150 - hour * 0.05, 10 * 24);
    const history = monitor.getFillHistory().state;
    expect(history.sizeBytes).toBe(200 * kGb);
    expect(history.samples.length).toBe(7 * 24 + 1);
    expect(history.samples[history.samples.length - 1].atMs - history.samples[0].atMs).toBe(7 * kDay);

    monitor.observe([reading(150, 400)], kStartMs + 11 * kDay);
    expect(monitor.getFillHistory().state.samples).toHaveLength(1);
    expect(monitor.getSnapshot().volumes[0].fillEstimate.status).toBe("not_enough_data");
  });

  it("resumes from saved samples, dropping malformed ones", () => {
    const first = createDiskSpaceMonitor();
    observeHourly(first, (hour) => 40 - hour * 0.1, 30);
    const saved = JSON.parse(JSON.stringify(first.getFillHistory()));
    saved.state.samples.push({ atMs: "soon", usedBytes: 1 });
    const second = createDiskSpaceMonitor({ fillHistory: { ...saved, junk: { sizeBytes: -1, samples: [] } } });
    second.observe([reading(40 - 31 * 0.1)], kStartMs + 31 * kHour);
    const volume = second.getSnapshot().volumes[0];
    expect(volume.fillEstimate.status).toBe("filling");
    expect(volume.fillEstimate.daysToFull).toBeCloseTo((40 - 3.1) / 2.4, 0);
    expect(createDiskSpaceMonitor({ fillHistory: "nonsense" }).getFillHistory()).toEqual({});
  });

  it("estimateFill answers zero days for a disk that is already full while still filling", () => {
    const samples = [{ atMs: 0, usedBytes: 0 }, { atMs: kDay, usedBytes: 5 * kGb }];
    expect(estimateFill(samples, 0)).toMatchObject({ status: "filling", daysToFull: 0 });
  });

  it("the tracker saves the hourly samples and the next tracker reads them back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-fill-"));
    const fillHistoryPath = path.join(dir, ".alphaclaw", "disk-fill-history.json");
    try {
      let nowMs = kStartMs;
      let freeGb = 40;
      const make = () => createDiskSpaceTracker({
        stateDir: "/data/.openclaw",
        env: {},
        readVolumes: () => [reading(freeGb)],
        runCensus: async () => null,
        nowFn: () => nowMs,
        fillHistoryPath,
      });
      const first = make();
      for (let hour = 0; hour <= 30; hour += 1) {
        nowMs = kStartMs + hour * kHour;
        freeGb = 40 - hour * 0.1;
        await first.tick();
      }
      const saved = JSON.parse(fs.readFileSync(fillHistoryPath, "utf8"));
      expect(saved.state.samples).toHaveLength(31);
      const second = make();
      nowMs += kHour;
      freeGb -= 0.1;
      await second.tick();
      expect(second.getSnapshot().volumes[0].fillEstimate.status).toBe("filling");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
