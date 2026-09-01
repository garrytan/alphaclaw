const express = require("express");
const request = require("supertest");

const { registerRescueLinkRoutes } = require("../../lib/server/routes/rescue-link");
const { createLoginThrottle } = require("../../lib/server/login-throttle");

const kToken = "ab".repeat(32);
const kTarget = "https://claude.ai/code/sess_route00001";
const kEnvTarget = "https://claude.ai/code?environment=env_01ROUTE";

// Mirrors auth.js:665-668 — proves the rescue route sits OUTSIDE every
// auth-gated prefix by mounting the same gates in the same app.
const mountAuthGates = (app) => {
  const reject401 = (req, res) => res.status(401).json({ error: "unauthorized" });
  app.use("/setup", reject401);
  app.use("/api", reject401);
  app.use("/auth", reject401);
};

const createApp = ({
  target = kTarget,
  resolver,
  service,
  recordOperationEvent,
  throttle,
  nowFn,
  logger,
} = {}) => {
  const app = express();
  app.set("trust proxy", true);
  mountAuthGates(app);
  const claudeCodeLocalService =
    service !== undefined
      ? service
      : {
          resolveRescueRedirect:
            resolver ||
            vi.fn((token) => (token === kToken ? target : null)),
          checkSessionLiveness: vi.fn(async () => {}),
        };
  registerRescueLinkRoutes({
    app,
    claudeCodeLocalService,
    recordOperationEvent,
    throttle,
    nowFn,
    logger: logger || { warn: vi.fn(), error: vi.fn() },
  });
  return { app, claudeCodeLocalService };
};

// Event-rate gates with the production windows, driven by a fake clock.
const createGates = () => ({
  probe: createLoginThrottle({
    scope: "rescue-probe",
    windowMs: 5 * 60 * 1000,
    maxAttempts: 1,
    baseLockMs: 5 * 60 * 1000,
    maxLockMs: 5 * 60 * 1000,
    globalWindowMs: 60 * 60 * 1000,
    globalMaxAttempts: 12,
    globalBaseLockMs: 60 * 60 * 1000,
    globalMaxLockMs: 60 * 60 * 1000,
  }),
  redeem: createLoginThrottle({
    scope: "rescue-redeem",
    windowMs: 60 * 1000,
    maxAttempts: 1,
    baseLockMs: 60 * 1000,
    maxLockMs: 60 * 1000,
    globalWindowMs: 60 * 60 * 1000,
    globalMaxAttempts: 600,
    globalBaseLockMs: 60 * 1000,
    globalMaxLockMs: 60 * 1000,
  }),
});

describe("rescue-link route", () => {
  it("302s a valid token with an exact Location, hardening headers, and no target echo", async () => {
    const { app } = createApp({});
    const res = await request(app).get(`/rescue/${kToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(kTarget);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.text || "").not.toContain(kTarget);
  });

  it("redirects the environment-form URL too", async () => {
    const { app } = createApp({ target: kEnvTarget });
    const res = await request(app).get(`/rescue/${kToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(kEnvTarget);
  });

  it("serves byte-identical friendly 404s for bad token, unwired service, and a throwing resolver", async () => {
    const miss = await request(createApp({}).app).get(`/rescue/${"ff".repeat(32)}`);
    const unwired = await request(createApp({ service: null }).app).get(
      `/rescue/${kToken}`,
    );
    const throwing = await request(
      createApp({
        resolver: vi.fn(() => {
          throw new Error("boom");
        }),
      }).app,
    ).get(`/rescue/${kToken}`);
    for (const res of [miss, unwired, throwing]) {
      expect(res.status).toBe(404);
      expect(res.text).toContain("no longer active");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    // No oracle: all miss causes are indistinguishable on the wire.
    expect(miss.text).toBe(unwired.text);
    expect(unwired.text).toBe(throwing.text);
  });

  it("is reachable with no auth cookie while the auth gates are demonstrably live", async () => {
    const { app } = createApp({});
    const gated = await request(app).get("/api/anything");
    expect(gated.status).toBe(401);
    const open = await request(app).get(`/rescue/${kToken}`);
    expect(open.status).toBe(302);
  });

  it("forwards the token verbatim to the resolver", async () => {
    const resolver = vi.fn(() => null);
    const { app } = createApp({ resolver });
    await request(app).get(`/rescue/${kToken}`);
    expect(resolver).toHaveBeenCalledWith(kToken);
  });

  it("refuses a non-claude.ai target with the uniform 404 and an error log", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const cases = [
      "https://evil.example/x",
      "https://claude.ai.evil.example/code/sess_x",
      "https://claude.ai/evil/path",
      "https://claude.ai/code", // environment form without the environment param
      "not-a-url",
    ];
    for (const target of cases) {
      const { app } = createApp({ target, logger });
      const res = await request(app).get(`/rescue/${kToken}`);
      expect(res.status).toBe(404);
      expect(res.text).toContain("no longer active");
      expect(res.headers.location).toBeUndefined();
    }
    expect(logger.error).toHaveBeenCalledTimes(cases.length);
    // The log carries a hash prefix, never the raw token.
    for (const [line] of logger.error.mock.calls) {
      expect(line).not.toContain(kToken);
    }
  });

  it("records a redeemed audit event with ip, truncated user-agent, and token hash id", async () => {
    const recordOperationEvent = vi.fn();
    const { app } = createApp({ recordOperationEvent });
    await request(app)
      .get(`/rescue/${kToken}`)
      .set("X-Forwarded-For", "203.0.113.9")
      .set("User-Agent", "z".repeat(400));
    expect(recordOperationEvent).toHaveBeenCalledTimes(1);
    const event = recordOperationEvent.mock.calls[0][0];
    expect(event.kind).toBe("rescue_link_redeemed");
    expect(event.details.ip).toBe("203.0.113.9");
    expect(event.details.userAgent).toHaveLength(120);
    expect(event.details.tokenId).toMatch(/^[0-9a-f]{8}$/);
    expect(event.details.tokenId).not.toBe(kToken.slice(0, 8));
    expect(JSON.stringify(event)).not.toContain(kToken);
  });

  it("records probe events for misses, capped per IP and globally, without changing responses", async () => {
    let now = 1_000_000;
    const recordOperationEvent = vi.fn();
    const { app } = createApp({
      recordOperationEvent,
      throttle: createGates(),
      nowFn: () => now,
    });
    const probeEvents = () =>
      recordOperationEvent.mock.calls.filter(
        ([e]) => e.kind === "rescue_link_probe_failed",
      ).length;
    // Same IP, hammering: exactly one event per 5-minute window.
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get(`/rescue/${"11".repeat(32)}`);
      expect(res.status).toBe(404);
    }
    expect(probeEvents()).toBe(1);
    now += 5 * 60 * 1000 + 1;
    await request(app).get(`/rescue/${"11".repeat(32)}`);
    expect(probeEvents()).toBe(2);
    // Distinct IPs: bounded by the global cap (12/hour) no matter how many.
    for (let i = 0; i < 40; i += 1) {
      const res = await request(app)
        .get(`/rescue/${"22".repeat(32)}`)
        .set("X-Forwarded-For", `198.51.100.${i}`);
      expect(res.status).toBe(404);
    }
    expect(probeEvents()).toBeLessThanOrEqual(12);
  });

  it("caps redemption event writes while every 302 keeps flowing", async () => {
    let now = 2_000_000;
    const recordOperationEvent = vi.fn();
    const { app } = createApp({
      recordOperationEvent,
      throttle: createGates(),
      nowFn: () => now,
    });
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).get(`/rescue/${kToken}`);
      expect(res.status).toBe(302);
    }
    expect(recordOperationEvent).toHaveBeenCalledTimes(1);
    now += 60 * 1000 + 1;
    await request(app).get(`/rescue/${kToken}`);
    expect(recordOperationEvent).toHaveBeenCalledTimes(2);
  });

  it("fails open: a throwing recordOperationEvent never affects the response", async () => {
    const recordOperationEvent = vi.fn(() => {
      throw new Error("db locked");
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const { app } = createApp({ recordOperationEvent, logger });
    const hit = await request(app).get(`/rescue/${kToken}`);
    expect(hit.status).toBe(302);
    const miss = await request(app).get(`/rescue/${"33".repeat(32)}`);
    expect(miss.status).toBe(404);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("kicks the liveness check asynchronously on redemption and swallows its rejection", async () => {
    const checkSessionLiveness = vi.fn(async () => {
      throw new Error("tmux gone");
    });
    const { app } = createApp({
      service: {
        resolveRescueRedirect: () => kTarget,
        checkSessionLiveness,
      },
    });
    const res = await request(app).get(`/rescue/${kToken}`);
    expect(res.status).toBe(302);
    expect(checkSessionLiveness).toHaveBeenCalledTimes(1);
    // Give the rejected promise a tick — an unhandled rejection would fail
    // the suite via vitest's unhandled-rejection tracking.
    await new Promise((r) => setImmediate(r));
  });

  it("HEAD gets the redirect but records no audit event and kicks no liveness check", async () => {
    const recordOperationEvent = vi.fn();
    const checkSessionLiveness = vi.fn(async () => {});
    const { app } = createApp({
      service: {
        resolveRescueRedirect: (token) => (token === kToken ? kTarget : null),
        checkSessionLiveness,
      },
      recordOperationEvent,
    });
    const hit = await request(app).head(`/rescue/${kToken}`);
    expect(hit.status).toBe(302);
    expect(hit.headers.location).toBe(kTarget);
    const miss = await request(app).head(`/rescue/${"44".repeat(32)}`);
    expect(miss.status).toBe(404);
    expect(recordOperationEvent).not.toHaveBeenCalled();
    expect(checkSessionLiveness).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding as a 400 that echoes no path or token", async () => {
    const { app } = createApp({});
    const res = await request(app).get("/rescue/%zz");
    expect(res.status).toBe(400);
    expect(res.text || "").not.toContain("%zz");
    expect(res.text || "").not.toContain("/rescue");
  });

  it("never logs the raw token across hits and misses", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const recordOperationEvent = vi.fn(() => {
      throw new Error("forces the warn path");
    });
    const { app } = createApp({ recordOperationEvent, logger, target: "https://evil.example/x" });
    await request(app).get(`/rescue/${kToken}`); // guard-refusal error log
    const { app: app2 } = createApp({ recordOperationEvent, logger });
    await request(app2).get(`/rescue/${kToken}`); // warn path on redeem
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls]
      .map((call) => call.join(" "))
      .join("\n");
    expect(logged).not.toContain(kToken);
  });
});
