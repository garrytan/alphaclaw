import { describe, expect, it } from "vitest";
import { createStatusIngestion } from "../../lib/public/js/lib/status-ingestion.js";
const sample = (overrides = {}) => ({
  status: { gateway: "running" }, snapshotEpoch: "boot-a", snapshotRevision: 1,
  snapshotStale: false, timestamp: "2026-09-08T00:00:00.000Z", ...overrides,
});
const initialTime = Date.parse("2026-09-08T00:00:00.000Z");

describe("shared status observation ordering", () => {
  it("normalizes REST and SSE, rejecting a delayed older REST observation", () => {
    const state = createStatusIngestion({ now: () => initialTime });
    const stream = state.beginStream();
    const request = state.beginRequest();
    expect(state.accept(sample({ snapshotRevision: 3 }), { stream })).toBe(true);
    const { status, ...meta } = sample({ snapshotRevision: 2 });
    expect(state.accept({ ...status, ...meta }, { request })).toBe(false);
    const newer = { ...meta, snapshotRevision: 4, gateway: "starting" };
    expect(state.accept(newer, { request })).toBe(true);
    expect(state.get().status.gateway).toBe("starting");
  });

  it("repeated stale heartbeats never renew the successful observation", () => {
    let now = initialTime;
    const state = createStatusIngestion({ now: () => now });
    const stream = state.beginStream();
    expect(state.getFreshness().mode).toBe("unknown");
    state.accept(sample(), { stream });
    now += 20_000;
    expect(state.getFreshness().mode).toBe("stale");
    state.accept(sample({ snapshotRevision: 2, snapshotStale: true }), { stream });
    const observation = state.getFreshness().observedAtMs;
    for (let index = 0; index < 3; index++) {
      now += 10_000;
      expect(state.accept(sample({ snapshotRevision: 2, snapshotStale: true }), { stream })).toBe(false);
      expect(state.getFreshness()).toMatchObject({ mode: "stale", observedAtMs: observation, receivedAtMs: now });
    }
    // Clearing the server's failure flag cannot refresh an old observation.
    expect(state.accept(sample({ snapshotRevision: 3 }), { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("stale");
    expect(state.accept(sample({ snapshotRevision: 4, timestamp: now }), { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("fresh");
  });

  it("accepts a new boot with an earlier clock and fences old requests and streams", () => {
    let now = initialTime;
    const state = createStatusIngestion({ now: () => now });
    const oldStream = state.beginStream();
    const oldRequest = state.beginRequest();
    state.accept(sample({ snapshotRevision: 99 }), { stream: oldStream });
    const stream = state.beginStream();
    const newerBoot = sample({ snapshotEpoch: "boot-b", timestamp: "2026-09-07T23:00:00Z" });
    expect(state.accept(newerBoot, { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("fresh");
    expect(state.accept(sample({ snapshotRevision: 100 }), { request: oldRequest })).toBe(false);
    expect(state.accept(sample({ snapshotEpoch: "unseen-old-boot" }), { request: oldRequest })).toBe(false);
    expect(state.accept(sample({ snapshotEpoch: "stale-socket" }), { stream: oldStream })).toBe(false);
    expect(state.get().epoch).toBe("boot-b");
    now += 20_000;
    expect(state.accept({ ...newerBoot, snapshotRevision: 2 }, { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("stale");
  });

  it("cache hydration uses observation age and unversioned data cannot replace modern evidence", () => {
    const state = createStatusIngestion({ now: () => initialTime + 100_000 });
    state.accept(sample());
    expect(state.getFreshness().mode).toBe("stale");
    expect(state.accept({ gateway: "running" })).toBe(false);
    expect(state.accept(sample({ snapshotRevision: undefined }))).toBe(false);
    const request = state.beginRequest();
    state.accept(sample({ snapshotRevision: 2 }), { request });
    expect(state.getFreshness().mode).toBe("stale");
  });

  it("an unfamiliar cached epoch cannot replace an existing live observation", () => {
    const state = createStatusIngestion({ now: () => initialTime });
    const stream = state.beginStream();
    state.accept(sample({ snapshotEpoch: "boot-b", snapshotRevision: 5 }), { stream });
    expect(state.accept(sample({ snapshotEpoch: "boot-a", timestamp: initialTime - 60_000,
      status: { gateway: "stopped" } }))).toBe(false);
    expect(state.get()).toMatchObject({ epoch: "boot-b", revision: 5, status: { gateway: "running" } });
    expect(state.getFreshness().mode).toBe("fresh");
    // A higher cached revision is still cache data, even within this epoch.
    expect(state.accept(sample({ snapshotEpoch: "boot-b", snapshotRevision: 100 }))).toBe(false);
  });

  it("a forward-clock epoch clears the previous boot's rollback adjustment", () => {
    let now = initialTime;
    const state = createStatusIngestion({ now: () => now });
    const stream = state.beginStream();
    state.accept(sample(), { stream });
    state.accept(sample({ snapshotEpoch: "boot-b", timestamp: initialTime - 3_600_000 }), { stream });
    expect(state.getFreshness().mode).toBe("fresh");
    now += 20_000;
    // Boot C restored the clock, but this snapshot spent 20 seconds in transit.
    expect(state.accept(sample({ snapshotEpoch: "boot-c" }), { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("stale");
    state.accept(sample({ snapshotEpoch: "boot-c", snapshotRevision: 2, timestamp: now }), { stream });
    expect(state.getFreshness().mode).toBe("fresh");
  });

  it.each(["REST", "SSE"])("ages a delayed fresh %s observation from its timestamp", (transport) => {
    let now = initialTime;
    const state = createStatusIngestion({ now: () => now });
    const stream = state.beginStream();
    const request = state.beginRequest();
    const context = transport === "REST" ? { request } : { stream };
    now += 20_000;
    expect(state.accept(sample(), context)).toBe(true);
    expect(state.getFreshness()).toMatchObject({ mode: "stale", observedAtMs: initialTime, receivedAtMs: now });
  });

  it("a recent same-timestamp fresh transition clears the server failure warning", () => {
    const state = createStatusIngestion({ now: () => initialTime + 1_000 });
    const stream = state.beginStream();
    state.accept(sample({ snapshotStale: true }), { stream });
    expect(state.getFreshness().mode).toBe("stale");
    expect(state.accept(sample({ snapshotRevision: 2 }), { stream })).toBe(true);
    expect(state.getFreshness().mode).toBe("fresh");
  });

  it("fences an old REST request when its stream was replaced before any new frame arrived", () => {
    const state = createStatusIngestion({ now: () => initialTime });
    const oldStream = state.beginStream();
    state.accept(sample(), { stream: oldStream });
    const request = state.beginRequest();
    state.endStream(oldStream);
    state.beginStream();
    expect(state.accept(sample({ snapshotEpoch: "unseen-old-boot" }), { request })).toBe(false);
    expect(state.accept(sample({ snapshotRevision: 100 }), { request })).toBe(false);
    expect(state.get().epoch).toBe("boot-a");
  });
});
