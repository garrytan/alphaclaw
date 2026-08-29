const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");

const createDeps = (overrides = {}) => ({
  fs,
  OPENCLAW_DIR: fs.mkdtempSync(
    path.join(os.tmpdir(), "alphaclaw-routes-overseer-"),
  ),
  isOnboarded: () => true,
  openclawChannelService: {
    getChannelInfo: vi.fn(() => ({})),
    applyUpdate: vi.fn(),
    requestChannelRollback: vi.fn(),
    markGoodNow: vi.fn(),
    runLedger: null,
    store: { clearBlocklist: vi.fn(), readState: vi.fn(() => ({ blocklist: [] })) },
  },
  openclawReleasesService: {
    getCatalog: vi.fn(async () => ({ ok: true })),
    annotateCatalog: vi.fn((catalog) => catalog),
    isKnownVersion: vi.fn(() => true),
    isKnownCommit: vi.fn(() => true),
  },
  operationEvents: {
    createOperation: vi.fn(() => ({ operationId: "op-1" })),
    complete: vi.fn(),
    fail: vi.fn(),
    getOperation: vi.fn(() => null),
  },
  restartRequiredState: { markRequired: vi.fn() },
  upgradeOverseer: {
    getAvailability: vi.fn(async () => ({
      available: true,
      reason: null,
      message: "claude 1.2.3",
    })),
  },
  openclawFeatureGates: { supportsFeature: vi.fn(() => false) },
  runBackupSqlite: vi.fn(async () => ({ ok: true, tail: "verified ok" })),
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerOpenclawChannelRoutes({ app, ...deps });
  return app;
};

describe("server/routes/openclaw-channel overseer + sqlite backup", () => {
  it("GET /api/openclaw/overseer returns the (default off) setting and availability", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps)).get("/api/openclaw/overseer");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      enabled: false,
      availability: { available: true, reason: null, message: "claude 1.2.3" },
    });
  });

  it("PUT /api/openclaw/overseer persists the toggle and GET reads it back", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const put = await request(app)
      .put("/api/openclaw/overseer")
      .send({ enabled: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, enabled: true });

    const get = await request(app).get("/api/openclaw/overseer");
    expect(get.body.enabled).toBe(true);

    // Persisted into alphaclaw.json under updates.openclaw.overseer.
    const raw = JSON.parse(
      fs.readFileSync(path.join(deps.OPENCLAW_DIR, "alphaclaw.json"), "utf8"),
    );
    expect(raw.updates.openclaw.overseer.enabled).toBe(true);
  });

  it("PUT /api/openclaw/overseer rejects non-boolean input", async () => {
    const res = await request(createApp(createDeps()))
      .put("/api/openclaw/overseer")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_setting");
  });

  it("GET /api/openclaw/overseer surfaces unavailability instead of degrading silently", async () => {
    const deps = createDeps({
      upgradeOverseer: {
        getAvailability: vi.fn(async () => ({
          available: false,
          reason: "no_anthropic_credential",
          message: "ANTHROPIC_API_KEY is not set",
        })),
      },
    });
    const res = await request(createApp(deps)).get("/api/openclaw/overseer");
    expect(res.status).toBe(200);
    expect(res.body.availability.available).toBe(false);
    expect(res.body.availability.reason).toBe("no_anthropic_credential");
  });

  it("POST /api/openclaw/backup-sqlite is 503 (feature_unsupported) when the gate is closed", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps)).post("/api/openclaw/backup-sqlite");

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("feature_unsupported");
    expect(res.body.hint).toContain("2026.8.1-beta.1");
    expect(deps.runBackupSqlite).not.toHaveBeenCalled();
  });

  it("POST /api/openclaw/backup-sqlite runs the verified backup when the gate is open", async () => {
    const deps = createDeps({
      openclawFeatureGates: {
        supportsFeature: vi.fn((name) => name === "sqliteBackup"),
      },
    });
    const res = await request(createApp(deps)).post("/api/openclaw/backup-sqlite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tail: "verified ok" });
    expect(deps.runBackupSqlite).toHaveBeenCalledTimes(1);
  });

  it("POST /api/openclaw/backup-sqlite reports a failed backup with its tail", async () => {
    const deps = createDeps({
      openclawFeatureGates: { supportsFeature: () => true },
      runBackupSqlite: vi.fn(async () => ({ ok: false, tail: "disk full" })),
    });
    const res = await request(createApp(deps)).post("/api/openclaw/backup-sqlite");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("backup_failed");
    expect(res.body.tail).toBe("disk full");
  });

  it("GET /api/openclaw/medic returns the (default on) setting and AI availability", async () => {
    const deps = createDeps({
      gatewayMedic: {
        getAvailability: vi.fn(() => ({
          enabled: true,
          ai: { available: true, provider: "anthropic", model: "claude-fable-5" },
        })),
      },
    });
    const res = await request(createApp(deps)).get("/api/openclaw/medic");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      enabled: true,
      ai: { available: true, provider: "anthropic", model: "claude-fable-5" },
    });
  });

  it("PUT /api/openclaw/medic persists the opt-out and GET reads it back", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const put = await request(app)
      .put("/api/openclaw/medic")
      .send({ enabled: false });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, enabled: false });

    const get = await request(app).get("/api/openclaw/medic");
    expect(get.body.enabled).toBe(false);

    const raw = JSON.parse(
      fs.readFileSync(path.join(deps.OPENCLAW_DIR, "alphaclaw.json"), "utf8"),
    );
    expect(raw.updates.openclaw.medic.enabled).toBe(false);
  });

  it("PUT /api/openclaw/medic rejects non-boolean input", async () => {
    const res = await request(createApp(createDeps()))
      .put("/api/openclaw/medic")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_setting");
  });

  it("GET /api/openclaw/medic returns 500 medic_unavailable when availability throws", async () => {
    const deps = createDeps({
      gatewayMedic: {
        getAvailability: vi.fn(() => {
          throw new Error("state torn");
        }),
      },
    });
    const res = await request(createApp(deps)).get("/api/openclaw/medic");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("medic_unavailable");
  });

  it("PUT /api/openclaw/medic returns 500 medic_write_failed with the disk hint", async () => {
    const deps = createDeps();
    // A read-only fs: the settings write must surface as medic_write_failed.
    deps.fs = new Proxy(fs, {
      get(target, prop) {
        if (prop === "writeFileSync") {
          return () => {
            throw new Error("ENOSPC: no space left on device");
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await request(createApp(deps))
      .put("/api/openclaw/medic")
      .send({ enabled: false });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("medic_write_failed");
    expect(res.body.hint).toMatch(/disk space/);
  });
});
