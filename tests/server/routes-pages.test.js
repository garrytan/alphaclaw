const express = require("express");
const request = require("supertest");
const { registerPageRoutes } = require("../../lib/server/routes/pages");

const buildApp = ({
  running = false,
  onboarded = true,
  watchdogStatus = null,
} = {}) => {
  const app = express();
  registerPageRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    isGatewayRunning: async () => running,
    isOnboarded: () => onboarded,
    getWatchdogStatus: () => watchdogStatus,
  });
  return app;
};

describe("server/routes/pages health endpoints", () => {
  it("reports healthy with 200 when the gateway is running", async () => {
    const res = await request(buildApp({ running: true })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "healthy", gateway: "running" });
  });

  it("reports starting with 200 before onboarding", async () => {
    const res = await request(buildApp({ running: false, onboarded: false })).get(
      "/health",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "starting", gateway: "starting" });
  });

  it("reports degraded with 200 (never 503) when the gateway is down post-onboarding", async () => {
    const res = await request(
      buildApp({
        running: false,
        onboarded: true,
        watchdogStatus: { degradedSince: "2026-08-27T20:00:00.000Z" },
      }),
    ).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "degraded",
      gateway: "down",
      gatewayDownSince: "2026-08-27T20:00:00.000Z",
    });
  });

  it("keeps the unauthenticated health body coarse (no version strings)", async () => {
    const res = await request(buildApp({ running: true })).get("/health");
    expect(JSON.stringify(res.body)).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("survives a throwing watchdog status getter", async () => {
    const app = express();
    registerPageRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      isGatewayRunning: async () => false,
      isOnboarded: () => true,
      getWatchdogStatus: () => {
        throw new Error("boom");
      },
    });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.gatewayDownSince).toBeNull();
  });

  describe("/health/ready (opt-in strict readiness)", () => {
    it("returns 200 when healthy", async () => {
      const res = await request(buildApp({ running: true })).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
    });

    it("returns 503 while degraded", async () => {
      const res = await request(buildApp({ running: false, onboarded: true })).get(
        "/health/ready",
      );
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("degraded");
    });

    it("returns 503 while starting", async () => {
      const res = await request(
        buildApp({ running: false, onboarded: false }),
      ).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("starting");
    });
  });
});
