const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { createDeployAnnouncer, formatDuration, median } = require("../../lib/server/deploy-announce");
const { registerDeployRoutes } = require("../../lib/server/routes/deploy");
const { createServerLifecycle } = require("../../lib/server/init/server-lifecycle");
const { getManifest } = require("../../lib/server/admin-manifest");

const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-deploy-"));
let seq = 0;
const makeRoot = () => fs.mkdtempSync(path.join(kRoot, `case-${(seq += 1)}-`));
afterAll(() => fs.rmSync(kRoot, { recursive: true, force: true }));

const makeAnnouncer = ({ rootDir = makeRoot(), clock, processStartedAtMs = 0, sidecarResults = [] } = {}) => {
  const notices = [];
  const sidecarCalls = [];
  const events = [];
  let flushed = 0;
  const announcer = createDeployAnnouncer({
    rootDir,
    now: () => clock.now,
    processStartedAtMs,
    notify: async (message, opts) => {
      notices.push({ message, opts });
      return { ok: true };
    },
    flushNotifications: async () => {
      flushed += 1;
    },
    sidecarService: {
      announceAll: async (env, timeoutMs) => {
        sidecarCalls.push({ env, timeoutMs });
        return sidecarResults;
      },
    },
    insertEvent: (event) => events.push(event.details),
    logger: { log() {}, warn() {}, error() {} },
  });
  return { announcer, notices, sidecarCalls, events, rootDir, flushes: () => flushed };
};

const T0 = Date.parse("2026-10-25T18:00:00Z");

describe("deploy announcements", () => {
  it("formats durations and takes medians", () => {
    expect([formatDuration(42), formatDuration(110), formatDuration(120), formatDuration(3720)]).toEqual(["42 s", "1 min 50 s", "2 min", "1 h 2 min"]);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
    expect(median([])).toBeNull();
  });

  it("an announcement notifies the owner, tells the sidecars, and is not repeated at SIGTERM", async () => {
    const clock = { now: T0 };
    const { announcer, notices, sidecarCalls } = makeAnnouncer({ clock, sidecarResults: [{ name: "guard", ok: true, code: 0 }] });
    const result = await announcer.announce({ inSeconds: 60, etaSeconds: 120, reason: "AlphaClaw upgrade" });
    expect(result).toMatchObject({ ok: true, inSeconds: 60, etaSeconds: 120, etaSource: "caller", sidecars: [{ name: "guard", ok: true, code: 0 }] });
    expect(notices[0].message).toBe("🔄 AlphaClaw will restart for a deploy in about 1 min. Expected back about 2 min after it stops. Reason: AlphaClaw upgrade.");
    expect(notices[0].opts.expiresAt).toBe(T0 + 180 * 1000);
    expect(sidecarCalls[0].env).toEqual({
      ALPHACLAW_DEPLOY_PHASE: "announced",
      ALPHACLAW_DEPLOY_IN_SECONDS: "60",
      ALPHACLAW_DEPLOY_ETA_SECONDS: "120",
      ALPHACLAW_DEPLOY_REASON: "AlphaClaw upgrade",
    });

    clock.now = T0 + 70 * 1000;
    const shutdown = await announcer.onShutdown({ reason: "SIGTERM" });
    expect(shutdown).toEqual({ announced: true, notified: false });
    expect(notices).toHaveLength(1);
    expect(sidecarCalls[1].env).toMatchObject({ ALPHACLAW_DEPLOY_PHASE: "shutting_down", ALPHACLAW_DEPLOY_ETA_SECONDS: "120" });
  });

  it("rate-limits announcements", async () => {
    const clock = { now: T0 };
    const { announcer } = makeAnnouncer({ clock });
    await announcer.announce({ inSeconds: 10 });
    clock.now += 5000;
    expect(await announcer.announce({ inSeconds: 10 })).toEqual({ ok: false, error: "announce_rate_limited", retryAfterSeconds: 25 });
  });

  it("an unannounced SIGTERM sends its own expiring notice and flushes it", async () => {
    const clock = { now: T0 };
    const { announcer, notices, flushes, sidecarCalls } = makeAnnouncer({ clock });
    expect(await announcer.onShutdown({ reason: "SIGTERM" })).toEqual({ announced: false, notified: true });
    expect(notices[0].message).toBe("🔄 AlphaClaw got SIGTERM from the platform and is shutting down, usually for a deploy or a restart.");
    expect(notices[0].opts.expiresAt).toBe(T0 + 2 * 60 * 1000);
    expect(flushes()).toBe(1);
    expect(sidecarCalls[0].env).toMatchObject({ ALPHACLAW_DEPLOY_PHASE: "shutting_down", ALPHACLAW_DEPLOY_REASON: "SIGTERM" });
  });

  it("SIGINT and other exits record the shutdown without a notice", async () => {
    const clock = { now: T0 };
    const { announcer, notices } = makeAnnouncer({ clock });
    expect(await announcer.onShutdown({ reason: "uncaught exception" })).toEqual({ announced: false, notified: false });
    expect(notices).toEqual([]);
    expect(announcer.getStatus().lastShutdown).toEqual({ at: "2026-10-25T18:00:00Z", reason: "uncaught exception", announced: false });
  });

  it("the next boot measures the downtime, notifies it, and feeds the ETA of later announcements", async () => {
    const rootDir = makeRoot();
    const clock = { now: T0 };
    const first = makeAnnouncer({ rootDir, clock });
    await first.announcer.onShutdown({ reason: "SIGTERM" });

    clock.now = T0 + 120 * 1000;
    const second = makeAnnouncer({ rootDir, clock, processStartedAtMs: T0 + 20 * 1000 });
    const measured = await second.announcer.onGatewayReady({ readyAt: new Date(T0 + 110 * 1000).toISOString() });
    expect(measured).toMatchObject({ measured: true, seconds: 110, shutdownAt: "2026-10-25T18:00:00Z", readyAt: "2026-10-25T18:01:50Z", reason: "SIGTERM" });
    expect(second.notices[0].message).toBe("✅ AlphaClaw is back: down 1 min 50 s (stopped 2026-10-25T18:00:00Z, gateway ready 2026-10-25T18:01:50Z).");
    expect(second.announcer.getLastDowntimeSeconds()).toBe(110);
    expect(second.announcer.getStatus()).toMatchObject({ etaSeconds: 110, etaSource: "measured", lastShutdown: null, history: [expect.objectContaining({ seconds: 110 })] });

    clock.now = T0 + 600 * 1000;
    const third = makeAnnouncer({ rootDir, clock });
    const result = await third.announcer.announce({ inSeconds: 0 });
    expect(result).toMatchObject({ etaSeconds: 110, etaSource: "measured" });
    expect(third.notices[0].message).toBe("🔄 AlphaClaw will restart for a deploy now. Expected back about 1 min 50 s after it stops (typical of recent restarts).");
  });

  it("a boot without a clean shutdown record measures nothing and stays quiet", async () => {
    const clock = { now: T0 + 95 * 1000 };
    const { announcer, notices, events } = makeAnnouncer({ clock, processStartedAtMs: T0 });
    const result = await announcer.onGatewayReady({ readyAt: new Date(T0 + 95 * 1000).toISOString() });
    expect(result).toEqual({ measured: false, bootSeconds: 95, readyAt: "2026-10-25T18:01:35Z" });
    expect(notices).toEqual([]);
    expect(events[0]).toMatchObject({ phase: "back", measured: false });
  });

  it("the announced estimate is quoted after the restart", async () => {
    const rootDir = makeRoot();
    const clock = { now: T0 };
    const first = makeAnnouncer({ rootDir, clock });
    await first.announcer.announce({ inSeconds: 30, etaSeconds: 90 });
    clock.now = T0 + 30 * 1000;
    await first.announcer.onShutdown({ reason: "SIGTERM" });
    clock.now = T0 + 200 * 1000;
    const second = makeAnnouncer({ rootDir, clock, processStartedAtMs: T0 + 40 * 1000 });
    await second.announcer.onGatewayReady({ readyAt: new Date(T0 + 130 * 1000).toISOString() });
    expect(second.notices[0].message).toBe(
      "✅ AlphaClaw is back: down 1 min 40 s (stopped 2026-10-25T18:00:30Z, gateway ready 2026-10-25T18:02:10Z). The announced estimate was 1 min 30 s.",
    );
  });
});

describe("deploy routes", () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  registerDeployRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    deployAnnouncer: {
      getStatus: () => ({ pending: null, history: [] }),
      announce: async (args) => {
        calls.push(args);
        return args.inSeconds === 7 ? { ok: false, error: "announce_rate_limited", retryAfterSeconds: 12 } : { ok: true, ...args };
      },
    },
  });

  it("validates the body and passes a one-line reason", async () => {
    expect((await request(app).post("/api/deploy/announce").send({})).status).toBe(400);
    expect((await request(app).post("/api/deploy/announce").send({ inSeconds: 4000 })).status).toBe(400);
    expect((await request(app).post("/api/deploy/announce").send({ inSeconds: 5, etaSeconds: 0 })).status).toBe(400);
    expect((await request(app).post("/api/deploy/announce").send({ inSeconds: 5, reason: 3 })).status).toBe(400);
    const res = await request(app).post("/api/deploy/announce").send({ inSeconds: 30, reason: "deploy\nnow" });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toEqual({ inSeconds: 30, etaSeconds: null, reason: "deploy now", source: "api" });
  });

  it("answers 429 with Retry-After when rate-limited, and serves the status", async () => {
    const limited = await request(app).post("/api/deploy/announce").send({ inSeconds: 7 });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("12");
    expect((await request(app).get("/api/deploy/status")).body).toEqual({ ok: true, pending: null, history: [] });
  });

  it("the agent can read and announce (it restarts nothing)", () => {
    const ops = getManifest().ops.filter((op) => op.domain === "deploy");
    expect(ops.map((op) => [op.method, op.path, op.tier])).toEqual([
      ["GET", "/api/deploy/status", "safe"],
      ["POST", "/api/deploy/announce", "write"],
    ]);
  });
});

describe("server lifecycle shutdown notice", () => {
  const makeLifecycle = ({ onShutdownStart, drainMs = 0, shutdownNoticeWaitMs = 200 }) => {
    const order = [];
    let exitCode = null;
    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const lifecycle = createServerLifecycle({
      server: null,
      PORT: 0,
      stopGateway: async () => {
        order.push("gateway stop");
        await new Promise((resolve) => setTimeout(resolve, drainMs));
      },
      onShutdownStart,
      shutdownNoticeWaitMs,
      exitImpl: (code) => {
        exitCode = code;
        order.push("exit");
        resolveExit();
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    return { lifecycle, order, exited, code: () => exitCode };
  };

  it("starts the notice beside the drain and waits for it before exiting", async () => {
    const seen = [];
    const { lifecycle, order, exited, code } = makeLifecycle({
      drainMs: 20,
      onShutdownStart: async (args) => {
        seen.push(args);
        order.push("notice start");
        await new Promise((resolve) => setTimeout(resolve, 60));
        order.push("notice done");
      },
    });
    await lifecycle.gracefulExit(0, "SIGTERM");
    await exited;
    expect(seen).toEqual([{ code: 0, reason: "SIGTERM" }]);
    expect(order.indexOf("notice start")).toBeLessThan(order.indexOf("gateway stop") + 1);
    expect(order.slice(-2)).toEqual(["notice done", "exit"]);
    expect(code()).toBe(0);
  });

  it("never waits more than the cap for a slow notice, and survives one that throws", async () => {
    const slow = makeLifecycle({ onShutdownStart: () => new Promise(() => {}), shutdownNoticeWaitMs: 100 });
    const started = Date.now();
    await slow.lifecycle.gracefulExit(0, "SIGTERM");
    await slow.exited;
    expect(Date.now() - started).toBeLessThan(1000);

    const broken = makeLifecycle({ onShutdownStart: () => {
      throw new Error("boom");
    } });
    await broken.lifecycle.gracefulExit(0, "SIGTERM");
    await broken.exited;
    expect(broken.code()).toBe(0);
  });
});
