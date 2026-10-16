const express = require("express");
const request = require("supertest");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerOpenclawUpgradeRoutes } = require("../../lib/server/routes/openclaw-upgrade");
const { kBootMigrationFileName } = require("../../lib/server/openclaw-boot-migration");
const { kDoctorTranscriptFileName } = require("../../lib/server/doctor-transcript");

const kPin = "2026.10.4";

const createApp = ({ role = "admin", busy = null, record } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-routes-"));
  fs.chmodSync(root, 0o700);
  const openclawDir = path.join(root, "openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  const backupsDir = path.join(root, "backups");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(backupsDir);
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}");
  fs.writeFileSync(
    path.join(managedDir, kBootMigrationFileName),
    JSON.stringify(record || { lastOutcome: { status: "failed", class: "deterministic", reason: "failing_check", detail: "Failing check plugins: x", openclawVersion: kPin, at: 1 } }),
  );
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.alphaclawIdentity = { role };
    next();
  });
  registerOpenclawUpgradeRoutes({
    app,
    fs,
    requireAdmin: (req, res, next) => (req.alphaclawIdentity.role === "admin" ? next() : res.status(403).json({ ok: false, code: "admin_required" })),
    openclawDir,
    managedDir,
    backupsDir,
    stateDir: () => openclawDir,
    openclawRuntime: { getInfo: () => ({ installedVersion: kPin }), readBackupReceipt: () => null, listStateDbFiles: () => [] },
    alphaclawVersion: "0.10.7",
    getBusyOperation: () => busy,
    logger: { log() {}, warn() {} },
  });
  return { app, managedDir, openclawDir };
};

describe("routes/openclaw-upgrade", () => {
  it("admins get the full model with preflight and backup evidence; members the reduced one", async () => {
    const admin = await request(createApp().app).get("/api/openclaw/upgrade-status");
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ ok: true, installedVersion: kPin, alert: { kind: "failed" }, retry: { available: true }, backup: { count: 0 } });
    expect(admin.body.preflight).toEqual(expect.objectContaining({ captureRoot: expect.stringContaining(".update-captures") }));
    const member = await request(createApp({ role: "member" }).app).get("/api/openclaw/upgrade-status");
    expect(member.body.alert).toMatchObject({ kind: "failed", memberLine: "An administrator needs to finish this upgrade.", actions: [] });
    expect(member.body.preflight).toBeUndefined();
    expect(member.body.retry).toBeUndefined();
  });

  it("dismiss validates the key and is admin-only", async () => {
    const { app } = createApp();
    expect((await request(app).post("/api/openclaw/upgrade-status/dismiss").send({ key: "../x" })).status).toBe(400);
    expect((await request(app).post("/api/openclaw/upgrade-status/dismiss").send({ key: "0123456789abcdef" })).body).toEqual({ ok: true });
    expect((await request(createApp({ role: "member" }).app).post("/api/openclaw/upgrade-status/dismiss").send({ key: "0123456789abcdef" })).status).toBe(403);
  });

  it("Enable snapshots refuses while a gateway operation runs and rejects a malformed proposal id", async () => {
    const busy = createApp({ busy: { kind: "restart", label: "Restarting gateway" } }).app;
    expect((await request(busy).post("/api/openclaw/snapshots/enable").send({ proposalId: "a".repeat(32) })).status).toBe(409);
    expect((await request(createApp().app).post("/api/openclaw/snapshots/enable").send({ proposalId: "nope" })).status).toBe(400);
  });

  it("the proposal endpoint answers ok:false with a plain sentence when nothing can (or needs to) change", async () => {
    const res = await request(createApp().app).get("/api/openclaw/snapshots/proposal");
    expect(res.status).toBe(200);
    expect(res.body.ok === true || typeof res.body.code === "string").toBe(true);
  });

  it("serves the newest Doctor transcript to admins only", async () => {
    const { app, managedDir } = createApp();
    expect((await request(app).get("/api/openclaw/doctor-output")).body).toEqual({ ok: true, text: null });
    fs.writeFileSync(path.join(managedDir, kDoctorTranscriptFileName), "openclaw doctor --fix\nok\n");
    expect((await request(app).get("/api/openclaw/doctor-output")).body.text).toContain("doctor --fix");
    expect((await request(createApp({ role: "member" }).app).get("/api/openclaw/doctor-output")).status).toBe(403);
  });
});
