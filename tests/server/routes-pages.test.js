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

describe("server/routes/pages boot progress", () => {
  const { createBootTimeline } = require("../../lib/server/boot-progress/timeline");
  const snapshotOf = () => {
    const timeline = createBootTimeline({
      bootId: "777:3",
      startedAtMs: Date.now() - 5_000,
      readVersions: () => ({ alphaclaw: "0.10.8", openclaw: "2026.10.4" }),
      logger: { log: () => {}, warn: () => {} },
    });
    timeline.noteDoctorStart({ fromVersion: "2026.10.2", toVersion: "2026.10.4" });
    timeline.noteGatewayOutput("[gateway] startup phase: config.auth starting total=1ms /data/.openclaw/openclaw.json\n");
    return timeline.snapshot();
  };
  const build = ({ snapshot = snapshotOf(), phase = "running_doctor", requireAuth = (req, res, next) => next() } = {}) => {
    const app = express();
    registerPageRoutes({
      app,
      requireAuth,
      isGatewayRunning: async () => false,
      isOnboarded: () => true,
      getWatchdogStatus: () => null,
      getBootSnapshot: () => snapshot,
      getBootPhase: () => ({ phase }),
    });
    return app;
  };

  it("serves the public frame without auth, uncached, with nothing but the whitelist", async () => {
    const denyAll = (req, res) => res.status(401).end();
    const app = build({ requireAuth: denyAll });
    app.use(denyAll);
    const res = await request(app).get("/boot-progress.json");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ v: 1, source: "server", kind: "upgrading_openclaw", label: "Upgrading OpenClaw", stage: "upgrading", outcome: null, stuck: false });
    expect(res.body.bootId).toMatch(/^[0-9a-f]{12}$/);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/\d+\.\d+\.\d+|2026\.10|777/);
    expect(text).not.toMatch(/\/data|openclaw\.json|Loading configuration|doctor|steps|trace|versions/i);
  });

  it("answers an empty server frame before the timeline exists", async () => {
    const res = await request(build({ snapshot: null })).get("/boot-progress.json");
    expect(res.body).toMatchObject({ v: 1, source: "server", bootId: null, stage: null, stuck: false });
  });

  it("names the stage on /health while the boot sequence runs, and only then", async () => {
    const booting = await request(build()).get("/health");
    expect(booting.status).toBe(200);
    expect(booting.body.boot).toEqual({ stage: "upgrading", since: expect.any(String) });
    const ready = await request(build({ phase: "ready" })).get("/health");
    expect(ready.body.boot).toBeUndefined();
  });

  it("is not an /api route, so it never appears in the agent-admin unmanifested list", () => {
    const { kUnmanifestedRoutes } = require("../../lib/server/admin-manifest");
    expect([...kUnmanifestedRoutes].some((entry) => String(entry).includes("boot-progress"))).toBe(false);
  });
});

