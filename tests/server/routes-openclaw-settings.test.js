const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerOpenclawSettingsRoutes } = require("../../lib/server/routes/openclaw-settings");
const { createOperatorsStore } = require("../../lib/server/operators-store");
const { readOpenclawMedicEnabled } = require("../../lib/server/alphaclaw-config");

describe("server/routes/openclaw-settings", () => {
  let openclawDir;
  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-settings-routes-"));
  });
  afterEach(() => fs.rmSync(openclawDir, { recursive: true, force: true }));

  const createApp = (overrides = {}) => {
    const openclawRuntime = {
      getBackupStatus: vi.fn(() => ({ running: false, last: null })),
      startBackup: vi.fn(() => ({ ok: true, started: true })),
    };
    const deps = {
      fs,
      OPENCLAW_DIR: openclawDir,
      openclawRuntime,
      ...overrides,
    };
    const app = express();
    app.use(express.json());
    registerOpenclawSettingsRoutes({ app, ...deps });
    return { app, deps };
  };

  describe("backup", () => {
    it("GET reports the runtime's backup status", async () => {
      const last = { ok: true, startedAt: 1, finishedAt: 2, archivePath: "/data/backups/a.tar.gz", bytes: 10, error: null };
      const { app, deps } = createApp();
      deps.openclawRuntime.getBackupStatus.mockReturnValue({ running: false, last });
      const res = await request(app).get("/api/openclaw/backup");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, running: false, last });
    });

    it("POST starts a backup with 202", async () => {
      const { app, deps } = createApp();
      const res = await request(app).post("/api/openclaw/backup");
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true, started: true });
      expect(deps.openclawRuntime.startBackup).toHaveBeenCalledTimes(1);
    });

    it("POST answers 409 backup_in_progress while one is running", async () => {
      const { app, deps } = createApp();
      deps.openclawRuntime.startBackup.mockReturnValue({ ok: false, code: "backup_in_progress", error: "A backup is already running." });
      const res = await request(app).post("/api/openclaw/backup");
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, code: "backup_in_progress", error: "A backup is already running.", message: "A backup is already running." });
    });

    it("POST answers 503 in the shared envelope when OpenClaw cannot run a backup", async () => {
      const { app, deps } = createApp();
      deps.openclawRuntime.startBackup.mockReturnValue({ ok: false, code: "openclaw_unavailable", error: "The installed OpenClaw could not be found." });
      const res = await request(app).post("/api/openclaw/backup");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        ok: false,
        code: "openclaw_unavailable",
        message: "The installed OpenClaw could not be found.",
        error: "The installed OpenClaw could not be found.",
        hint: null,
        docsUrl: null,
      });
    });
  });

  describe("medic", () => {
    it("GET reports the medic's availability", async () => {
      const gatewayMedic = { getAvailability: vi.fn(() => ({ enabled: true, ai: { available: true, provider: "anthropic", model: "m" } })) };
      const { app } = createApp({ gatewayMedic });
      const res = await request(app).get("/api/openclaw/medic");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, enabled: true, ai: { available: true, provider: "anthropic", model: "m" } });
    });

    it("GET falls back to the stored toggle when the medic is not wired", async () => {
      const { app } = createApp();
      const res = await request(app).get("/api/openclaw/medic");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, enabled: true, ai: { available: false, reason: "not_wired" } });
    });

    it("GET answers 500 in the shared envelope when availability throws", async () => {
      const gatewayMedic = { getAvailability: () => { throw new Error("broken"); } };
      const { app } = createApp({ gatewayMedic });
      const res = await request(app).get("/api/openclaw/medic");
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ ok: false, code: "medic_unavailable", message: "broken" });
    });

    it("PUT persists a strict boolean toggle", async () => {
      const { app } = createApp();
      const off = await request(app).put("/api/openclaw/medic").send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body).toEqual({ ok: true, enabled: false });
      expect(readOpenclawMedicEnabled({ openclawDir })).toBe(false);
      const on = await request(app).put("/api/openclaw/medic").send({ enabled: true });
      expect(on.body).toEqual({ ok: true, enabled: true });
      expect(readOpenclawMedicEnabled({ openclawDir })).toBe(true);
    });

    it.each([["string", "false"], ["number", 0], ["null", null], ["missing", undefined]])("PUT rejects a %s value without writing", async (_name, enabled) => {
      const { app } = createApp();
      const res = await request(app).put("/api/openclaw/medic").send(enabled === undefined ? {} : { enabled });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "invalid_setting", message: "enabled must be a boolean" });
      expect(fs.readdirSync(openclawDir)).toEqual([]);
    });
  });

  describe("notifications", () => {
    it("GET returns empty routing when no store is wired", async () => {
      const { app } = createApp();
      const res = await request(app).get("/api/openclaw/notifications");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, notifications: { preferredChannel: null, adminTargets: [] } });
    });

    it("PUT answers 503 when no store is wired", async () => {
      const { app } = createApp();
      const res = await request(app).put("/api/openclaw/notifications").send({ preferredChannel: null, adminTargets: [] });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, code: "notifications_unavailable" });
    });

    it("round-trips routing preferences through the real store with its supported channels", async () => {
      const operatorsStore = createOperatorsStore({ openclawDir });
      const { app } = createApp({ operatorsStore });
      const saved = await request(app).put("/api/openclaw/notifications").send({
        preferredChannel: "telegram",
        adminTargets: [{ channel: "telegram", target: "123" }, { channel: "slack", target: "U_ADMIN" }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body.notifications).toMatchObject({
        preferredChannel: "telegram",
        adminTargets: [{ channel: "telegram", target: "123" }, { channel: "slack", target: "U_ADMIN" }],
      });
      const read = await request(app).get("/api/openclaw/notifications");
      expect(read.status).toBe(200);
      expect(read.body.notifications).toEqual(saved.body.notifications);
      expect(read.body.supportedChannels).toEqual(operatorsStore.kSupportedChannels);
    });

    it.each([
      ["an unsupported preferred channel", { preferredChannel: "email", adminTargets: [] }],
      ["non-array targets", { preferredChannel: null, adminTargets: "telegram:123" }],
      ["an unsupported target channel", { adminTargets: [{ channel: "pager", target: "1" }] }],
      ["an empty target", { adminTargets: [{ channel: "telegram", target: "  " }] }],
    ])("PUT rejects %s without writing", async (_name, body) => {
      const operatorsStore = createOperatorsStore({ openclawDir });
      const setNotificationPrefs = vi.spyOn(operatorsStore, "setNotificationPrefs");
      const { app } = createApp({ operatorsStore });
      const res = await request(app).put("/api/openclaw/notifications").send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: "invalid_setting" });
      expect(setNotificationPrefs).not.toHaveBeenCalled();
    });

    it("PUT answers 500 with a disk hint when the store write fails", async () => {
      const operatorsStore = createOperatorsStore({ openclawDir });
      operatorsStore.setNotificationPrefs = () => { throw new Error("ENOSPC"); };
      const { app } = createApp({ operatorsStore });
      const res = await request(app).put("/api/openclaw/notifications").send({ preferredChannel: null, adminTargets: [] });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ ok: false, code: "notifications_write_failed", message: "ENOSPC", hint: "Check disk space on the data volume." });
    });
  });

  describe("features", () => {
    it("returns an empty, fail-closed map when no gate service is wired", async () => {
      const { app } = createApp();
      const res = await request(app).get("/api/openclaw/features");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, version: null, features: {} });
    });

    it("returns the gate service's version and features", async () => {
      const openclawFeatureGates = { features: () => ({ version: "2026.9.5", features: { chatV2: true } }) };
      const { app } = createApp({ openclawFeatureGates });
      const res = await request(app).get("/api/openclaw/features");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, version: "2026.9.5", features: { chatV2: true } });
    });

    it("answers 500 in the shared envelope when the gate service throws", async () => {
      const openclawFeatureGates = { features: () => { throw new Error("no version"); } };
      const { app } = createApp({ openclawFeatureGates });
      const res = await request(app).get("/api/openclaw/features");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, code: "features_unavailable", message: "no version", hint: null, docsUrl: null });
    });
  });
});
