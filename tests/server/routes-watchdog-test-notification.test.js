const express = require("express");
const request = require("supertest");

const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");

// Notifier results in the real createWatchdogNotifier shape
// ({ ok, sent, failed, channels, failures, reason? }).
const kChannelsNone = {
  telegram: { sent: 0, failed: 0, skipped: true, targets: 0, formatFallback: 0 },
  discord: { sent: 0, failed: 0, skipped: true, targets: 0 },
  slack: { sent: 0, failed: 0, skipped: true, targets: 0 },
  whatsapp: { sent: 0, failed: 0, skipped: true, targets: 0 },
  webhook: { sent: 0, failed: 0, skipped: true, targets: 0 },
};

const deliveredResult = () => ({
  ok: true,
  sent: 1,
  failed: 0,
  channels: {
    ...kChannelsNone,
    telegram: { sent: 1, failed: 0, skipped: false, targets: 1, formatFallback: 0 },
  },
  failures: [],
});

const createDeps = (overrides = {}) => {
  const requireAuth = (req, res, next) => next();
  const watchdog = {
    getStatus: vi.fn(() => ({ lifecycle: "running", health: "healthy" })),
    triggerRepair: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(() => ({ autoRepair: true, notificationsEnabled: true })),
    updateSettings: vi.fn(({ autoRepair }) => ({ autoRepair, notificationsEnabled: true })),
  };
  const watchdogNotifier = {
    notify: vi.fn(async () => deliveredResult()),
  };
  const getRecentEvents = vi.fn(() => []);
  const readLogTail = vi.fn(() => "");
  return {
    requireAuth,
    watchdog,
    watchdogNotifier,
    getRecentEvents,
    readLogTail,
    ...overrides,
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({ app, ...deps });
  return app;
};

describe("POST /api/watchdog/test-notification", () => {
  // C32: while the state-DB quiet period holds, the raw notifier resolves zero
  // sqlite-era pairing targets and would answer "nothing is configured or
  // paired" — false. The route answers the repo-wide 409 and never sends.
  it("answers 409 backup_in_progress (Retry-After 120) while the state-DB quiet period holds, without calling the notifier", async () => {
    const {
      beginStateDbQuiet,
      resetStateDbQuietForTests,
    } = require("../../lib/server/state-db-quiet");
    resetStateDbQuietForTests();
    const deps = createDeps();
    const app = createApp(deps);
    const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
    try {
      const res = await request(app).post("/api/watchdog/test-notification");
      expect(res.status).toBe(409);
      expect(res.headers["retry-after"]).toBe("120");
      expect(res.body).toEqual({
        ok: false,
        code: "backup_in_progress",
        error: "A backup is in progress; retry in about two minutes.",
      });
      expect(deps.watchdogNotifier.notify).not.toHaveBeenCalled();
    } finally {
      token.release();
      resetStateDbQuietForTests();
    }
    // Released: the same request reaches the notifier.
    const after = await request(app).post("/api/watchdog/test-notification");
    expect(after.status).toBe(200);
    expect(deps.watchdogNotifier.notify).toHaveBeenCalledTimes(1);
  });

  it("sends a test notification and returns the notifier's per-channel result", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.channels.telegram.sent).toBe(1);
    expect(res.body.result.channels.discord.skipped).toBe(true);
    expect(deps.watchdogNotifier.notify).toHaveBeenCalledTimes(1);
    // House format (the transport renders it) — never hand-written HTML.
    expect(deps.watchdogNotifier.notify).toHaveBeenCalledWith(
      "*AlphaClaw test notification* — your watchdog alerts are working.",
    );
  });

  // WI-3.5: the route used to answer ok:true unconditionally — the #54 box
  // "tested fine" while every Telegram send died. ok now mirrors the notifier.
  it("returns 502 ok:false with per-channel evidence when every channel failed", async () => {
    const deps = createDeps({
      watchdogNotifier: {
        notify: vi.fn(async () => ({
          ok: false,
          sent: 0,
          failed: 2,
          reason: "no_channels_delivered",
          channels: {
            ...kChannelsNone,
            telegram: { sent: 0, failed: 1, skipped: false, targets: 1, formatFallback: 0 },
            slack: { sent: 0, failed: 1, skipped: false, targets: 1 },
          },
          failures: [
            {
              channel: "telegram",
              target: "100",
              reason: "Bad Request: chat not found",
              errorCode: 400,
              deterministic: true,
            },
            {
              channel: "slack",
              target: "U1",
              reason: "missing SLACK_BOT_TOKEN",
              errorCode: null,
              deterministic: false,
            },
          ],
        })),
      },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    // The UI toasts `error` on a non-2xx: a readable line, not raw JSON.
    expect(res.body.error).toBe(
      "Test notification failed on every channel — telegram: Bad Request: chat not found (400); slack: missing SLACK_BOT_TOKEN",
    );
    expect(res.body.result.failures).toHaveLength(2);
    expect(res.body.result.channels.telegram.failed).toBe(1);
  });

  it("returns 502 with a nothing-configured message when no channel was even tried", async () => {
    const deps = createDeps({
      watchdogNotifier: {
        notify: vi.fn(async () => ({
          ok: false,
          sent: 0,
          failed: 0,
          reason: "no_channels_delivered",
          channels: kChannelsNone,
          failures: [],
        })),
      },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe(
      "No notification channel delivered the test message — nothing is configured or paired.",
    );
    expect(res.body.result.reason).toBe("no_channels_delivered");
  });

  it("a notifier result without an explicit ok:true is never reported as success", async () => {
    const deps = createDeps({
      watchdogNotifier: { notify: vi.fn(async () => undefined) },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe(
      "No notification channel delivered the test message — nothing is configured or paired.",
    );
  });

  it("returns 503 when notifier is not available", async () => {
    const deps = createDeps({ watchdogNotifier: null });
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("Notifier not available");
  });

  it("returns 500 when notify throws", async () => {
    const deps = createDeps({
      watchdogNotifier: {
        notify: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/watchdog/test-notification");

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("connection refused");
  });
});
