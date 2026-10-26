const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { createLastRestartStore, readRestartStatus, kLastRestartFileName } = require("../../lib/server/box-status/last-restart");
const { registerBoxRoutes } = require("../../lib/server/routes/box");

describe("last gateway restart record", () => {
  let dir;
  let now;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-restart-"));
    now = Date.parse("2026-10-25T18:00:00Z");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = (bootId = "boot-a") => createLastRestartStore({ managedDir: dir, bootId, nowFn: () => now, logger: { warn: vi.fn() } });

  it("records who asked, why, how it ended and the downtime, and persists it", () => {
    const first = store();
    first.recorder.requested({ opId: "op-1", source: "watchdog:memory_mitigation", reason: "rss 9 GB", restartClass: "memory" });
    expect(first.read()).toMatchObject({ opId: "op-1", outcome: "running", requestedAt: "2026-10-25T18:00:00.000Z" });
    now += 95_000;
    first.recorder.finished({ opId: "op-1", outcome: "ready", durationMs: 95_000.4, downtimeMs: 61_000, how: "graceful" });
    const expected = {
      opId: "op-1", source: "watchdog:memory_mitigation", reason: "rss 9 GB", restartClass: "memory",
      requestedAt: "2026-10-25T18:00:00.000Z", finishedAt: "2026-10-25T18:01:35.000Z",
      outcome: "ready", durationMs: 95_000, downtimeMs: 61_000, how: "graceful",
    };
    expect(first.read()).toEqual(expected);
    expect(store("boot-b").read()).toEqual(expected);
  });

  it("ignores a finish for another operation", () => {
    const s = store();
    s.recorder.requested({ opId: "op-1", source: "api:restart" });
    s.recorder.finished({ opId: "op-2", outcome: "ready" });
    expect(s.read().outcome).toBe("running");
  });

  it("reads a running record an earlier AlphaClaw process left as interrupted", () => {
    store("boot-a").recorder.requested({ opId: "op-1", source: "api:restart" });
    expect(store("boot-b").read().outcome).toBe("interrupted");
  });

  it("redacts the reason", () => {
    const s = store();
    s.recorder.requested({ opId: "op-1", source: "api:restart", reason: "token=sk-abcdefghijklmnopqrstuv" });
    expect(JSON.stringify(s.read())).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(fs.readFileSync(path.join(dir, kLastRestartFileName), "utf8")).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("is null before any restart and for an unreadable file", () => {
    expect(store().read()).toBeNull();
    fs.writeFileSync(path.join(dir, kLastRestartFileName), "{nope");
    expect(store().read()).toBeNull();
  });
});

describe("GET /api/box/restart", () => {
  it("combines the gateway restart, the boot history with its causes and the last unexpected exit", async () => {
    const app = express();
    const s = { read: () => ({ opId: "op-1", outcome: "ready", downtimeMs: 5000 }) };
    registerBoxRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      processTable: { read: vi.fn() },
      readRestartStatus: () => readRestartStatus({
        store: s,
        readBootHistory: () => ({ entries: [
          { kind: "fresh", outcome: "ready", startedAt: 1000, endedAt: 2000, totalMs: 1000 },
          { kind: "restarting", outcome: "aborted", reason: "shutdown", startedAt: Date.parse("2026-10-25T16:00:00Z"), endedAt: Date.parse("2026-10-25T16:00:10Z"),
            totalMs: 10_000, bootId: "aaaaaaaaaaaa", cause: { kind: "shutdown", label: "Clean shutdown (SIGTERM)", reason: "SIGTERM", shutdownAt: "2026-10-25T15:59:50.000Z", gapMs: 15_000 } },
          { kind: "restarting", outcome: "ready", reason: null, startedAt: Date.parse("2026-10-25T18:00:00Z"),
            endedAt: Date.parse("2026-10-25T18:01:32Z"), totalMs: 92_000, alphaclawVersion: "0.10.120", openclawVersion: "2026.10.7", stageMs: { x: 1 },
            bootId: "bbbbbbbbbbbb", cause: { kind: "unclean_exit", label: "Platform or crash", reason: null, shutdownAt: null, gapMs: 6_000_000.4, extra: "x" } },
        ] }),
        getWatchdogStatus: () => ({ lastExit: { at: "2026-10-25T17:59:00.000Z", code: 1, signal: null, cause: "oom", corroborated: true } }),
      }),
    });
    const res = await request(app).get("/api/box/restart");
    expect(res.status).toBe(200);
    const newest = {
      bootId: "bbbbbbbbbbbb", kind: "restarting", outcome: "ready", reason: null, startedAt: "2026-10-25T18:00:00.000Z", endedAt: "2026-10-25T18:01:32.000Z",
      totalMs: 92_000, alphaclawVersion: "0.10.120", openclawVersion: "2026.10.7",
      cause: { kind: "unclean_exit", label: "Platform or crash", reason: null, shutdownAt: null, gapMs: 6_000_000 },
    };
    const middle = {
      bootId: "aaaaaaaaaaaa", kind: "restarting", outcome: "aborted", reason: "shutdown", startedAt: "2026-10-25T16:00:00.000Z", endedAt: "2026-10-25T16:00:10.000Z",
      totalMs: 10_000, alphaclawVersion: null, openclawVersion: null,
      cause: { kind: "shutdown", label: "Clean shutdown (SIGTERM)", reason: "SIGTERM", shutdownAt: "2026-10-25T15:59:50.000Z", gapMs: 15_000 },
    };
    const oldest = {
      bootId: null, kind: "fresh", outcome: "ready", reason: null, startedAt: "1970-01-01T00:00:01.000Z", endedAt: "1970-01-01T00:00:02.000Z",
      totalMs: 1000, alphaclawVersion: null, openclawVersion: null, cause: null,
    };
    expect(res.body).toEqual({
      ok: true,
      gateway: { opId: "op-1", outcome: "ready", downtimeMs: 5000 },
      lastBoot: newest,
      previousBoot: middle,
      boots: [newest, middle, oldest],
      lastGatewayExit: { at: "2026-10-25T17:59:00.000Z", code: 1, signal: null, cause: "oom" },
    });
  });

  it("answers with nulls when nothing is known, and survives throwing readers", () => {
    expect(readRestartStatus({
      store: { read: () => null },
      readBootHistory: () => { throw new Error("x"); },
      getWatchdogStatus: () => { throw new Error("x"); },
    })).toEqual({ ok: true, gateway: null, lastBoot: null, previousBoot: null, boots: [], lastGatewayExit: null });
  });
});
