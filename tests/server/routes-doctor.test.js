const express = require("express");
const request = require("supertest");

const { registerDoctorRoutes } = require("../../lib/server/routes/doctor");

const createDoctorService = () => ({
  buildStatus: vi.fn(() => ({
    runInProgress: false,
    stale: true,
    needsInitialRun: true,
    latestRun: null,
  })),
  // runDoctor/importDoctorResult are async on the real service (they await a
  // fresh workspace snapshot); the mocks resolve promises to match.
  runDoctor: vi.fn(async () => ({ ok: true, runId: 42, status: { runInProgress: true } })),
  importDoctorResult: vi.fn(async ({ rawOutput }) => ({
    ok: true,
    runId: 43,
    run: { id: 43, summary: rawOutput ? "Imported" : "" },
  })),
  listDoctorRuns: vi.fn(() => [{ id: 42, status: "running", cardCount: 0 }]),
  listDoctorCards: vi.fn(({ runId }) =>
    String(runId || "all") === "all"
      ? [
          { id: 7, runId: 42, title: "Fix drift", status: "open" },
          { id: 8, runId: 41, title: "Cleanup docs", status: "dismissed" },
        ]
      : [{ id: 7, runId: 42, title: "Fix drift", status: "open" }]),
  getDoctorRun: vi.fn((id) =>
    String(id) === "42"
      ? { id: 42, status: "completed", cardCount: 1 }
      : null),
  getDoctorCardsByRunId: vi.fn((id) =>
    String(id) === "42"
      ? [{ id: 7, runId: 42, title: "Fix drift", status: "open" }]
      : []),
  setCardStatus: vi.fn(({ cardId, status }) => ({
    id: Number(cardId),
    status,
  })),
  requestCardFix: vi.fn(
    async ({ cardId, sessionKey, replyChannel, replyTo }) => ({
      ok: true,
      queued: true,
      runId: "doctor-fix-7-test",
      stdout: "sent",
      card: { id: Number(cardId), sessionKey, replyChannel, replyTo },
    }),
  ),
});

const createApp = (doctorService) => {
  const app = express();
  app.use(express.json());
  registerDoctorRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    doctorService,
  });
  return app;
};

describe("server/routes/doctor", () => {
  it("returns Doctor status", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).get("/api/doctor/status");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(doctorService.buildStatus).toHaveBeenCalledTimes(1);
  });

  it("starts a Doctor run", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/run").send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      runId: 42,
      status: { runInProgress: true },
    });
  });

  it("returns 200 when a Doctor run reuses previous findings", async () => {
    const doctorService = createDoctorService();
    doctorService.runDoctor.mockResolvedValue({
      ok: true,
      runId: 44,
      reusedPreviousRun: true,
      sourceRunId: 42,
      status: { runInProgress: false },
    });
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/run").send({});

    expect(res.status).toBe(200);
    expect(res.body.reusedPreviousRun).toBe(true);
    expect(res.body.sourceRunId).toBe(42);
  });

  it("returns 409 when a Doctor run is already in progress", async () => {
    const doctorService = createDoctorService();
    doctorService.runDoctor.mockResolvedValue({
      ok: false,
      alreadyRunning: true,
      runId: 42,
      status: { runInProgress: true },
      error: "Doctor run already in progress",
    });
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/run").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Doctor run already in progress");
  });

  it("imports a Doctor result without rerunning analysis", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/import").send({
      rawOutput: '{"summary":"Imported","cards":[]}',
    });

    expect(res.status).toBe(201);
    expect(doctorService.importDoctorResult).toHaveBeenCalledWith({
      rawOutput: '{"summary":"Imported","cards":[]}',
    });
    expect(res.body.runId).toBe(43);
  });

  it("returns run cards for an existing run", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).get("/api/doctor/runs/42/cards");

    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([
      { id: 7, runId: 42, title: "Fix drift", status: "open" },
    ]);
  });

  it("returns aggregated Doctor cards with optional run filter", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const allCardsResponse = await request(app).get("/api/doctor/cards");
    const runCardsResponse = await request(app).get("/api/doctor/cards?runId=42");

    expect(allCardsResponse.status).toBe(200);
    expect(allCardsResponse.body.cards).toHaveLength(2);
    expect(doctorService.listDoctorCards).toHaveBeenNthCalledWith(1, { runId: "all" });
    expect(runCardsResponse.status).toBe(200);
    expect(doctorService.listDoctorCards).toHaveBeenNthCalledWith(2, { runId: "42" });
  });

  it("updates Doctor card status", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/cards/7/status").send({
      status: "fixed",
    });

    expect(res.status).toBe(200);
    expect(res.body.card).toEqual({ id: 7, status: "fixed" });
  });

  it("sends a Doctor fix request with delivery fields", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Use the safer prompt",
    });

    expect(res.status).toBe(202);
    expect(doctorService.requestCardFix).toHaveBeenCalledWith({
      cardId: "7",
      sessionKey: "agent:main:telegram:direct:1050",
      replyChannel: "telegram",
      replyTo: "1050",
      prompt: "Use the safer prompt",
    });
    expect(res.body.ok).toBe(true);
  });

  it("lists Doctor runs with a parsed limit", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).get("/api/doctor/runs?limit=5");

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([{ id: 42, status: "running", cardCount: 0 }]);
    expect(doctorService.listDoctorRuns).toHaveBeenCalledWith({ limit: 5 });
  });

  it("returns a single Doctor run and 404 for unknown runs", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const found = await request(app).get("/api/doctor/runs/42");
    const missing = await request(app).get("/api/doctor/runs/999");

    expect(found.status).toBe(200);
    expect(found.body.run).toEqual({ id: 42, status: "completed", cardCount: 1 });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Doctor run not found");
  });

  it("returns 404 for cards of an unknown run", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).get("/api/doctor/runs/999/cards");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Doctor run not found");
  });

  it("rejects invalid Doctor card statuses", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/cards/7/status").send({
      status: "working",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Doctor card status");
    expect(doctorService.setCardStatus).not.toHaveBeenCalled();
  });

  it("maps card status update errors to 404 or 400", async () => {
    const doctorService = createDoctorService();
    doctorService.setCardStatus.mockImplementationOnce(() => {
      throw new Error("Doctor card not found");
    });
    const app = createApp(doctorService);

    const missing = await request(app).post("/api/doctor/cards/7/status").send({
      status: "fixed",
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Doctor card not found");

    doctorService.setCardStatus.mockImplementationOnce(() => {
      throw new Error("Card storage exploded");
    });
    const failed = await request(app).post("/api/doctor/cards/7/status").send({
      status: "open",
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toBe("Card storage exploded");
  });

  it("maps Doctor fix request errors to 404 or 400", async () => {
    const doctorService = createDoctorService();
    doctorService.requestCardFix.mockRejectedValueOnce(
      new Error("Doctor card not found"),
    );
    const app = createApp(doctorService);

    const missing = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:doctor:42",
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("Doctor card not found");

    doctorService.requestCardFix.mockRejectedValueOnce(
      new Error("Could not send Doctor fix request"),
    );
    const failed = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:doctor:42",
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toBe("Could not send Doctor fix request");
  });

  it("returns error statuses when the Doctor service throws", async () => {
    const doctorService = createDoctorService();
    doctorService.buildStatus.mockImplementation(() => {
      throw new Error("status failed");
    });
    doctorService.runDoctor.mockRejectedValue(new Error("run failed"));
    doctorService.importDoctorResult.mockRejectedValue(
      new Error("Doctor import requires raw output"),
    );
    doctorService.listDoctorRuns.mockImplementation(() => {
      throw new Error("runs failed");
    });
    doctorService.listDoctorCards.mockImplementation(() => {
      throw new Error("cards failed");
    });
    doctorService.getDoctorRun.mockImplementation(() => {
      throw new Error("run lookup failed");
    });
    const app = createApp(doctorService);

    const statusRes = await request(app).get("/api/doctor/status");
    expect(statusRes.status).toBe(500);
    expect(statusRes.body.error).toBe("status failed");

    const runRes = await request(app).post("/api/doctor/run").send({});
    expect(runRes.status).toBe(500);
    expect(runRes.body.error).toBe("run failed");

    const importRes = await request(app).post("/api/doctor/import").send({});
    expect(importRes.status).toBe(400);
    expect(importRes.body.error).toBe("Doctor import requires raw output");

    const runsRes = await request(app).get("/api/doctor/runs");
    expect(runsRes.status).toBe(500);
    expect(runsRes.body.error).toBe("runs failed");

    const cardsRes = await request(app).get("/api/doctor/cards");
    expect(cardsRes.status).toBe(500);
    expect(cardsRes.body.error).toBe("cards failed");

    const singleRunRes = await request(app).get("/api/doctor/runs/42");
    expect(singleRunRes.status).toBe(500);
    expect(singleRunRes.body.error).toBe("run lookup failed");

    const runCardsRes = await request(app).get("/api/doctor/runs/42/cards");
    expect(runCardsRes.status).toBe(500);
    expect(runCardsRes.body.error).toBe("run lookup failed");
  });

  it("returns 409 when a Doctor fix is already in progress", async () => {
    const doctorService = createDoctorService();
    doctorService.requestCardFix.mockRejectedValue(
      new Error("Doctor fix already in progress"),
    );
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:doctor:42",
      prompt: "Try again",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Doctor fix already in progress");
  });

  it("returns 503 when the gateway is unavailable for a run", async () => {
    const doctorService = createDoctorService();
    doctorService.runDoctor.mockResolvedValue({
      ok: false,
      gatewayUnavailable: true,
      reason: "gateway lifecycle is crash_loop",
      status: {},
    });
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/run").send({});

    expect(res.status).toBe(503);
    expect(res.body.gatewayUnavailable).toBe(true);
    expect(res.body.reason).toBe("gateway lifecycle is crash_loop");
  });

  it("returns 503 when the gateway is unavailable for a fix", async () => {
    const doctorService = createDoctorService();
    const error = new Error("Gateway is not ready for a Doctor fix: safe mode");
    error.gatewayUnavailable = true;
    error.reason = "safe mode";
    doctorService.requestCardFix.mockRejectedValue(error);
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:doctor:42",
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: "Gateway is not ready for a Doctor fix: safe mode",
      gatewayUnavailable: true,
      reason: "safe mode",
    });
  });

  it("keeps the fix 503 envelope shape when the error carries no reason", async () => {
    const doctorService = createDoctorService();
    const error = new Error("Gateway is not ready for a Doctor fix");
    error.gatewayUnavailable = true;
    doctorService.requestCardFix.mockRejectedValue(error);
    const app = createApp(doctorService);

    const res = await request(app).post("/api/doctor/findings/7/fix").send({
      sessionKey: "agent:main:doctor:42",
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: "Gateway is not ready for a Doctor fix",
      gatewayUnavailable: true,
      reason: "",
    });
  });

  it("reads and updates doctor settings", async () => {
    const doctorService = createDoctorService();
    let enabled = false;
    const app = express();
    app.use(express.json());
    registerDoctorRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      doctorService,
      readDoctorAutoRunEnabled: () => enabled,
      updateDoctorAutoRunEnabled: (next) => {
        enabled = next === true;
        return enabled;
      },
    });

    const initial = await request(app).get("/api/doctor/settings");
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      ok: true,
      settings: {
        autoRunEnabled: false,
        // No scan accessor wired: configured null, effective = built-ins.
        scan: {
          maxFiles: { configured: null, effective: 200000 },
          maxFileMb: { configured: null, effective: 50 },
        },
      },
    });

    const updated = await request(app)
      .put("/api/doctor/settings")
      .send({ autoRunEnabled: true });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.autoRunEnabled).toBe(true);

    const invalid = await request(app)
      .put("/api/doctor/settings")
      .send({ autoRunEnabled: "yes" });
    expect(invalid.status).toBe(400);

    // Partial-body rule: an empty body is a client bug, not a no-op success.
    const empty = await request(app).put("/api/doctor/settings").send({});
    expect(empty.status).toBe(400);
  });

  it("validates and persists scan cap settings", async () => {
    const doctorService = createDoctorService();
    doctorService.invalidateSnapshotCache = vi.fn();
    let enabled = true;
    let scan = { maxFiles: null, maxFileMb: null };
    const app = express();
    app.use(express.json());
    registerDoctorRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      doctorService,
      readDoctorAutoRunEnabled: () => enabled,
      updateDoctorAutoRunEnabled: (next) => {
        enabled = next === true;
        return enabled;
      },
      readDoctorScanConfig: () => ({ ...scan }),
      updateDoctorScanConfig: ({ maxFiles, maxFileMb }) => {
        if (maxFiles !== undefined) scan.maxFiles = maxFiles;
        if (maxFileMb !== undefined) scan.maxFileMb = maxFileMb;
        return { ...scan };
      },
    });

    // Scan-only partial body: valid set within bounds.
    const set = await request(app)
      .put("/api/doctor/settings")
      .send({ scan: { maxFiles: 300000 } });
    expect(set.status).toBe(200);
    expect(set.body.settings.scan.maxFiles).toEqual({
      configured: 300000,
      effective: 300000,
    });
    // autoRunEnabled untouched by a scan-only body.
    expect(set.body.settings.autoRunEnabled).toBe(true);
    // Cache invalidated so the new caps apply without a restart.
    expect(doctorService.invalidateSnapshotCache).toHaveBeenCalledTimes(1);

    // Mixed body updates both.
    const mixed = await request(app)
      .put("/api/doctor/settings")
      .send({ autoRunEnabled: false, scan: { maxFileMb: 25 } });
    expect(mixed.status).toBe(200);
    expect(mixed.body.settings.autoRunEnabled).toBe(false);
    expect(mixed.body.settings.scan.maxFileMb).toEqual({
      configured: 25,
      effective: 25,
    });

    // null resets to the built-in default.
    const reset = await request(app)
      .put("/api/doctor/settings")
      .send({ scan: { maxFiles: null } });
    expect(reset.status).toBe(200);
    expect(reset.body.settings.scan.maxFiles).toEqual({
      configured: null,
      effective: 200000,
    });

    // Out-of-bounds, floats, wrong types, empty scan objects: loud 400s.
    for (const badScan of [
      { maxFiles: 999 },
      { maxFiles: 500001 },
      { maxFiles: 1.5 },
      { maxFiles: "many" },
      { maxFileMb: 0 },
      { maxFileMb: 101 },
      {},
    ]) {
      const bad = await request(app)
        .put("/api/doctor/settings")
        .send({ scan: badScan });
      expect(bad.status).toBe(400);
    }
    const badShape = await request(app)
      .put("/api/doctor/settings")
      .send({ scan: [1, 2] });
    expect(badShape.status).toBe(400);
  });

  it("reads settings as disabled when no accessor is wired", async () => {
    const app = createApp(createDoctorService());
    const res = await request(app).get("/api/doctor/settings");
    expect(res.status).toBe(200);
    expect(res.body.settings.autoRunEnabled).toBe(false);
  });
});

describe("server/routes/doctor review-batch regressions", () => {
  it("returns 500 for a scan body when the scan updater is not wired (no partial write)", async () => {
    const doctorService = createDoctorService();
    let enabled = false;
    const updateAutoRun = vi.fn((next) => {
      enabled = next === true;
      return enabled;
    });
    const app = express();
    app.use(express.json());
    registerDoctorRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      doctorService,
      readDoctorAutoRunEnabled: () => enabled,
      updateDoctorAutoRunEnabled: updateAutoRun,
      readDoctorScanConfig: () => ({ maxFiles: null, maxFileMb: null }),
      // updateDoctorScanConfig deliberately NOT wired.
    });

    const res = await request(app)
      .put("/api/doctor/settings")
      .send({ autoRunEnabled: true, scan: { maxFiles: 2000 } });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Doctor scan settings unavailable");
    // The mixed body must not half-apply the autoRun flag before failing.
    expect(updateAutoRun).not.toHaveBeenCalled();
  });

  it("rejects oversized fix prompts with a 400 before any dispatch", async () => {
    const doctorService = createDoctorService();
    const app = createApp(doctorService);
    const res = await request(app)
      .post("/api/doctor/findings/7/fix")
      .send({ sessionKey: "agent:main:main", prompt: "A".repeat(100001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100000 characters or fewer/);
    expect(doctorService.requestCardFix).not.toHaveBeenCalled();
  });
});

describe("server/routes/doctor combined atomic settings write (adversarial C-ADV6)", () => {
  it("routes a mixed body through ONE combined write (no half-applied 500s)", async () => {
    const doctorService = createDoctorService();
    doctorService.invalidateSnapshotCache = vi.fn();
    const legacyAutoRun = vi.fn();
    const legacyScan = vi.fn();
    const combined = vi.fn(({ autoRunEnabled, maxFiles, maxFileMb }) => ({
      autoRunEnabled: autoRunEnabled === true,
      scan: { maxFiles: maxFiles ?? null, maxFileMb: maxFileMb ?? null },
    }));
    const app = express();
    app.use(express.json());
    registerDoctorRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      doctorService,
      readDoctorAutoRunEnabled: () => false,
      updateDoctorAutoRunEnabled: legacyAutoRun,
      readDoctorScanConfig: () => ({ maxFiles: 300000, maxFileMb: null }),
      updateDoctorScanConfig: legacyScan,
      updateDoctorSettingsCombined: combined,
    });

    const res = await request(app)
      .put("/api/doctor/settings")
      .send({ autoRunEnabled: true, scan: { maxFiles: 300000 } });
    expect(res.status).toBe(200);
    expect(combined).toHaveBeenCalledTimes(1);
    expect(combined).toHaveBeenCalledWith({
      autoRunEnabled: true,
      maxFiles: 300000,
      maxFileMb: undefined,
    });
    // The split writers must NOT run when the combined writer is wired.
    expect(legacyAutoRun).not.toHaveBeenCalled();
    expect(legacyScan).not.toHaveBeenCalled();
    expect(doctorService.invalidateSnapshotCache).toHaveBeenCalledTimes(1);
  });
});
