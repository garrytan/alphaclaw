const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");
const { registerAuthRoutes } = require("../../lib/server/routes/auth");

const kDevSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const createChannelInfo = (overrides = {}) => ({
  releaseChannel: "stable",
  installedVersion: "1.0.0",
  pinVersion: "1.0.0",
  applied: null,
  appliedId: null,
  isPin: true,
  acceptedAt: null,
  inStabilizationWindow: false,
  lastKnownGood: { package: "0.9.0", dev: null },
  blocklist: [{ id: "0.8.0", reason: "crash_loop", exitCode: 1, at: 1 }],
  lastUpdateRun: null,
  lastBoot: null,
  ...overrides,
});

const createDeps = (overrides = {}) => ({
  fs,
  OPENCLAW_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-routes-channel-")),
  isOnboarded: () => true,
  openclawChannelService: {
    getChannelInfo: vi.fn(() => createChannelInfo()),
    applyUpdate: vi.fn(async () => ({
      status: 200,
      body: { ok: true, noop: true },
    })),
    requestChannelRollback: vi.fn(() => ({
      ok: true,
      target: { kind: "pin" },
      blockedId: "1.1.0",
    })),
    markGoodNow: vi.fn(() => ({ ok: true, acceptedAt: 123 })),
    runUpdateRepair: vi.fn(async () => ({
      status: 200,
      body: { ok: true, steps: [] },
    })),
    store: {
      clearBlocklist: vi.fn(),
      readState: vi.fn(() => ({ blocklist: [] })),
    },
  },
  openclawReleasesService: {
    getCatalog: vi.fn(async () => ({ ok: true, stable: [], beta: [], dev: {} })),
    annotateCatalog: vi.fn((catalog) => ({ ...catalog, annotated: true })),
    isKnownVersion: vi.fn(() => true),
    isKnownCommit: vi.fn(() => true),
  },
  operationEvents: {
    createOperation: vi.fn(() => ({ operationId: "op-1" })),
    complete: vi.fn(),
    fail: vi.fn(),
    publish: vi.fn(),
  },
  restartRequiredState: {
    markRequired: vi.fn(),
    getSnapshot: vi.fn(async () => ({ restartRequired: true })),
  },
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerOpenclawChannelRoutes({ app, ...deps });
  return app;
};

// These routes are mounted behind `app.use("/api", requireAuth)` in
// production server.js; this builds that slice with the REAL auth middleware.
const createAuthedApp = (deps) => {
  process.env.SETUP_PASSWORD = "channel-test-secret";
  const app = express();
  app.use(express.json());
  registerAuthRoutes({
    app,
    loginThrottle: {
      getClientKey: vi.fn(() => "client-key"),
      getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
      evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
      recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
      recordLoginSuccess: vi.fn(),
      cleanupLoginAttemptStates: vi.fn(),
    },
  });
  registerOpenclawChannelRoutes({ app, ...deps });
  return app;
};

const kRoutes = [
  {
    method: "put",
    path: "/api/alphaclaw/config/updates/openclaw-release-channel",
    body: { releaseChannel: "beta" },
  },
  { method: "get", path: "/api/openclaw/channel" },
  { method: "get", path: "/api/openclaw/catalog" },
  { method: "post", path: "/api/openclaw/apply", body: { channel: "beta", version: "1.1.0" } },
  { method: "post", path: "/api/openclaw/repair", body: {} },
  { method: "post", path: "/api/openclaw/rollback", body: {} },
  { method: "post", path: "/api/openclaw/mark-good", body: {} },
  { method: "post", path: "/api/openclaw/blocklist/clear", body: {} },
];

describe("server/routes/openclaw-channel", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("rejects every channel route without a session cookie, and allows them after login", async () => {
    const deps = createDeps();
    const app = createAuthedApp(deps);

    for (const route of kRoutes) {
      const res = await request(app)[route.method](route.path).send(route.body || {});
      expect(res.status, `${route.method.toUpperCase()} ${route.path}`).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    }
    expect(deps.openclawChannelService.applyUpdate).not.toHaveBeenCalled();
    expect(deps.openclawChannelService.markGoodNow).not.toHaveBeenCalled();

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: "channel-test-secret" });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]?.[0] || "").split(";")[0];
    expect(cookie).toContain("setup_token=");

    const channelRes = await request(app)
      .get("/api/openclaw/channel")
      .set("Cookie", cookie);
    expect(channelRes.status).toBe(200);
    expect(channelRes.body.ok).toBe(true);

    const markGood = await request(app)
      .post("/api/openclaw/mark-good")
      .set("Cookie", cookie)
      .send({});
    expect(markGood.status).toBe(200);
    expect(markGood.body).toEqual({ ok: true, acceptedAt: 123 });
  });

  it("PUT release-channel validates the enum and persists valid changes", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const invalid = await request(app)
      .put("/api/alphaclaw/config/updates/openclaw-release-channel")
      .send({ releaseChannel: "nightly" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_channel");

    const valid = await request(app)
      .put("/api/alphaclaw/config/updates/openclaw-release-channel")
      .send({ releaseChannel: "beta" });
    expect(valid.status).toBe(200);
    // Channel selection is a catalog preference: it installs nothing, so it
    // must NOT flag the app restart-required (the global banner would
    // contradict the Upgrade page's "still running stable — press Apply").
    expect(valid.body).toEqual(
      expect.objectContaining({ ok: true, changed: true, restartRequired: false }),
    );
    expect(deps.restartRequiredState.markRequired).not.toHaveBeenCalled();
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(deps.OPENCLAW_DIR, "alphaclaw.json"), "utf8"),
    );
    expect(onDisk.updates.openclaw.releaseChannel).toBe("beta");
  });

  it("rejects malformed and unknown apply targets before touching the service", async () => {
    const deps = createDeps();
    deps.openclawReleasesService.isKnownCommit.mockReturnValue(false);
    deps.openclawReleasesService.isKnownVersion.mockReturnValue(false);
    const app = createApp(deps);

    const badChannel = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "nightly", version: "1.1.0" });
    expect(badChannel.status).toBe(400);
    expect(badChannel.body.code).toBe("invalid_channel");

    const badSha = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "dev", sha: "XYZ" });
    expect(badSha.status).toBe(400);
    expect(badSha.body.code).toBe("invalid_target");

    const unknownSha = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "dev", sha: kDevSha });
    expect(unknownSha.status).toBe(400);
    expect(unknownSha.body.code).toBe("unknown_commit");

    const injections = [
      "1.1.0;rm -rf",
      "`touch /tmp/pwned`",
      "$(touch /tmp/pwned)",
      "1.1.0\n2.0.0",
    ];
    for (const version of injections) {
      const res = await request(app)
        .post("/api/openclaw/apply")
        .send({ channel: "stable", version });
      expect(res.status, `injection payload: ${JSON.stringify(version)}`).toBe(400);
      expect(res.body.code).toBe("invalid_target");
    }

    const unknownVersion = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "stable", version: "1.9.9" });
    expect(unknownVersion.status).toBe(400);
    expect(unknownVersion.body.code).toBe("unknown_version");

    expect(deps.openclawChannelService.applyUpdate).not.toHaveBeenCalled();
  });

  it("returns quick apply results inline and hands off long runs to the operation stream", async () => {
    const quickDeps = createDeps();
    quickDeps.openclawChannelService.applyUpdate.mockResolvedValue({
      status: 200,
      body: { ok: true, noop: true },
    });
    const quickApp = createApp(quickDeps);

    const quick = await request(quickApp)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(quick.status).toBe(200);
    expect(quick.body).toEqual({ ok: true, noop: true, operationId: "op-1" });
    expect(quickDeps.openclawChannelService.applyUpdate).toHaveBeenCalledWith({
      channel: "beta",
      version: "1.1.0",
      sha: null,
      devHead: false,
      operationId: "op-1",
    });

    const slowDeps = createDeps();
    slowDeps.openclawChannelService.applyUpdate.mockReturnValue(
      new Promise(() => {}),
    );
    const slowApp = createApp(slowDeps);

    const slow = await request(slowApp)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(slow.status).toBe(202);
    expect(slow.body).toEqual({
      ok: true,
      operationId: "op-1",
      events: "/api/operations/op-1/events",
      // Alias matching the field name pre-existing 202 endpoints use.
      streamUrl: "/api/operations/op-1/events",
    });
  });

  it("terminates the operation stream when the apply settles as an error", async () => {
    // Every response that advertised an operationId must reach a terminal
    // event, or an SSE subscriber hangs forever. An applyUpdate rejection goes
    // through the .catch -> apply_failed envelope AND the termination backstop.
    const deps = createDeps();
    deps.openclawChannelService.applyUpdate.mockRejectedValue(
      new Error("exploded mid-apply"),
    );
    deps.operationEvents.getOperation = vi.fn(() => ({ status: "pending" }));
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: false,
        code: "apply_failed",
        message: "exploded mid-apply",
        operationId: "op-1",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.operationEvents.fail).toHaveBeenCalledTimes(1);
    const [failedId, failedError] = deps.operationEvents.fail.mock.calls[0];
    expect(failedId).toBe("op-1");
    expect(failedError.message).toBe("exploded mid-apply");
    expect(failedError.code).toBe("apply_failed");

    // Operations that already reached a terminal state are left alone.
    const settledDeps = createDeps();
    settledDeps.openclawChannelService.applyUpdate.mockResolvedValue({
      status: 409,
      body: { ok: false, code: "operation_in_progress", message: "busy" },
    });
    settledDeps.operationEvents.getOperation = vi.fn(() => ({
      status: "failed",
    }));
    const settledApp = createApp(settledDeps);
    const settledRes = await request(settledApp)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(settledRes.status).toBe(409);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settledDeps.operationEvents.fail).not.toHaveBeenCalled();
  });

  it("drives a quick 409 self-update rejection to a terminal error on the real operation stream", async () => {
    // End-to-end with the REAL operation-events service: even a sub-400ms
    // gate rejection (applyUpdate returns its envelope without ever calling
    // operationEvents.fail itself) must leave the advertised operation in a
    // terminal state, or an SSE subscriber would hang forever.
    const { createOperationEventsService } = require("../../lib/server/operation-events");
    const deps = createDeps();
    deps.operationEvents = createOperationEventsService();
    deps.openclawChannelService.applyUpdate.mockResolvedValue({
      status: 409,
      body: {
        ok: false,
        code: "self_update_in_progress",
        message: "An AlphaClaw update is currently installing.",
        hint: "Wait for it to finish (AlphaClaw will restart), then change OpenClaw versions.",
      },
    });
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("self_update_in_progress");
    expect(res.body.hint).toBeTruthy();
    expect(res.body.operationId).toBeTruthy();

    // ensureOperationTerminated runs off the apply promise continuation.
    await new Promise((resolve) => setImmediate(resolve));
    const operation = deps.operationEvents.getOperation(res.body.operationId);
    expect(operation.status).toBe("failed");
    const terminal = operation.events[operation.events.length - 1];
    expect(terminal.event).toBe("error");
    expect(terminal.data).toEqual(
      expect.objectContaining({
        code: "self_update_in_progress",
        error: "An AlphaClaw update is currently installing.",
      }),
    );
  });

  it("returns quick repair results inline and hands off long runs to the stream (2.3)", async () => {
    // Quick gate rejection (not a dev checkout) is relayed inline with the
    // operation handle, mirroring apply's quick-result contract.
    const quickDeps = createDeps();
    quickDeps.openclawChannelService.runUpdateRepair.mockResolvedValue({
      status: 409,
      body: {
        ok: false,
        code: "repair_not_applicable",
        message: "Repair only applies to dev builds from source.",
        hint: "For stable or beta, re-apply the version from the catalog instead.",
      },
    });
    quickDeps.operationEvents.getOperation = vi.fn(() => ({ status: "pending" }));
    const quickApp = createApp(quickDeps);

    const quick = await request(quickApp).post("/api/openclaw/repair").send({});
    expect(quick.status).toBe(409);
    expect(quick.body).toEqual(
      expect.objectContaining({
        ok: false,
        code: "repair_not_applicable",
        operationId: "op-1",
      }),
    );
    expect(quickDeps.openclawChannelService.runUpdateRepair).toHaveBeenCalledWith(
      { operationId: "op-1" },
    );
    // The advertised operation must still reach a terminal state.
    await new Promise((resolve) => setImmediate(resolve));
    expect(quickDeps.operationEvents.fail).toHaveBeenCalledTimes(1);

    const slowDeps = createDeps();
    slowDeps.openclawChannelService.runUpdateRepair.mockReturnValue(
      new Promise(() => {}),
    );
    const slowApp = createApp(slowDeps);

    const slow = await request(slowApp).post("/api/openclaw/repair").send({});
    expect(slow.status).toBe(202);
    expect(slow.body).toEqual({
      ok: true,
      operationId: "op-1",
      events: "/api/operations/op-1/events",
      streamUrl: "/api/operations/op-1/events",
    });
  });

  it("terminates the repair stream when the service throws (2.3)", async () => {
    const deps = createDeps();
    deps.openclawChannelService.runUpdateRepair.mockRejectedValue(
      new Error("exploded mid-repair"),
    );
    deps.operationEvents.getOperation = vi.fn(() => ({ status: "pending" }));
    const app = createApp(deps);

    const res = await request(app).post("/api/openclaw/repair").send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: false,
        code: "repair_failed",
        message: "exploded mid-repair",
        operationId: "op-1",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.operationEvents.fail).toHaveBeenCalledTimes(1);
    const [failedId, failedError] = deps.operationEvents.fail.mock.calls[0];
    expect(failedId).toBe("op-1");
    expect(failedError.message).toBe("exploded mid-repair");
  });

  it("maps rollback and mark-good service failures to 409 and successes to 200", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    deps.openclawChannelService.requestChannelRollback.mockReturnValueOnce({
      ok: false,
      code: "nothing_to_roll_back",
      message: "Already running the built-in stable version.",
    });
    const rollbackFailure = await request(app).post("/api/openclaw/rollback").send({});
    expect(rollbackFailure.status).toBe(409);
    expect(rollbackFailure.body.code).toBe("nothing_to_roll_back");

    const rollbackSuccess = await request(app).post("/api/openclaw/rollback").send({});
    expect(rollbackSuccess.status).toBe(200);
    expect(rollbackSuccess.body).toEqual(
      expect.objectContaining({ ok: true, target: { kind: "pin" } }),
    );
    expect(deps.openclawChannelService.requestChannelRollback).toHaveBeenCalledWith({
      reason: "manual",
    });

    deps.openclawChannelService.markGoodNow.mockReturnValueOnce({
      ok: false,
      code: "nothing_to_accept",
      message: "No pending version.",
    });
    const markGoodFailure = await request(app).post("/api/openclaw/mark-good").send({});
    expect(markGoodFailure.status).toBe(409);
    expect(markGoodFailure.body.code).toBe("nothing_to_accept");

    const markGoodSuccess = await request(app).post("/api/openclaw/mark-good").send({});
    expect(markGoodSuccess.status).toBe(200);
    expect(markGoodSuccess.body).toEqual({ ok: true, acceptedAt: 123 });
    expect(deps.openclawChannelService.markGoodNow).toHaveBeenCalledWith({
      source: "manual",
    });
  });

  it("maps a rollback marker-write failure to 500, not 409", async () => {
    // A failed marker WRITE is a server/disk failure (ENOSPC class), not a
    // conflict — it must match the sibling routes' 500 semantics.
    const deps = createDeps();
    deps.openclawChannelService.requestChannelRollback.mockReturnValueOnce({
      ok: false,
      code: "rollback_marker_write_failed",
      message: "Could not write the rollback marker: ENOSPC",
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/openclaw/rollback").send({});

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("rollback_marker_write_failed");
  });

  it("clears one blocklist entry, or all, and validates the id", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const single = await request(app)
      .post("/api/openclaw/blocklist/clear")
      .send({ id: "x" });
    expect(single.status).toBe(200);
    expect(single.body).toEqual({ ok: true, blocklist: [] });
    expect(deps.openclawChannelService.store.clearBlocklist).toHaveBeenCalledWith("x");

    const all = await request(app).post("/api/openclaw/blocklist/clear").send({});
    expect(all.status).toBe(200);
    expect(deps.openclawChannelService.store.clearBlocklist).toHaveBeenLastCalledWith(
      undefined,
    );

    const invalid = await request(app)
      .post("/api/openclaw/blocklist/clear")
      .send({ id: 42 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_target");
    expect(deps.openclawChannelService.store.clearBlocklist).toHaveBeenCalledTimes(2);
  });

  it("passes catalog failures through as 503 and annotates successful catalogs", async () => {
    const deps = createDeps();
    deps.openclawReleasesService.getCatalog.mockResolvedValueOnce({
      ok: false,
      code: "catalog_unavailable",
      message: "npm registry unreachable",
    });
    const app = createApp(deps);

    const unavailable = await request(app).get("/api/openclaw/catalog");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      ok: false,
      code: "catalog_unavailable",
      message: "npm registry unreachable",
    });
    expect(deps.openclawReleasesService.annotateCatalog).not.toHaveBeenCalled();

    const okRes = await request(app).get("/api/openclaw/catalog");
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    expect(okRes.body.catalog.annotated).toBe(true);
    expect(okRes.body.channel).toEqual({
      releaseChannel: "stable",
      installedVersion: "1.0.0",
      pinVersion: "1.0.0",
      appliedId: null,
    });
    const info = createChannelInfo();
    expect(deps.openclawReleasesService.annotateCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
      {
        currentId: "1.0.0",
        lastKnownGood: info.lastKnownGood,
        blocklist: info.blocklist,
      },
    );
  });

  describe("notifications routes", () => {
    const kSupportedChannels = ["telegram", "slack", "discord", "whatsapp"];

    const createOperatorsStore = (overrides = {}) => {
      const state = {
        notifications: { preferredChannel: null, adminTargets: [] },
      };
      return {
        kSupportedChannels,
        read: vi.fn(() => state),
        setNotificationPrefs: vi.fn(({ preferredChannel, adminTargets }) => {
          state.notifications = { preferredChannel, adminTargets };
          return state;
        }),
        ...overrides,
      };
    };

    it("PUT rejects an unsupported preferredChannel with invalid_setting", async () => {
      const operatorsStore = createOperatorsStore();
      const app = createApp(createDeps({ operatorsStore }));

      const res = await request(app)
        .put("/api/openclaw/notifications")
        .send({ preferredChannel: "carrier-pigeon", adminTargets: [] });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe("invalid_setting");
      expect(operatorsStore.setNotificationPrefs).not.toHaveBeenCalled();
    });

    it("PUT rejects an adminTargets entry missing its target field", async () => {
      const operatorsStore = createOperatorsStore();
      const app = createApp(createDeps({ operatorsStore }));

      const res = await request(app)
        .put("/api/openclaw/notifications")
        .send({
          preferredChannel: "telegram",
          adminTargets: [{ channel: "telegram" }],
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_setting");
      expect(operatorsStore.setNotificationPrefs).not.toHaveBeenCalled();
    });

    it("PUT persists a valid notification preference", async () => {
      const operatorsStore = createOperatorsStore();
      const app = createApp(createDeps({ operatorsStore }));

      const res = await request(app)
        .put("/api/openclaw/notifications")
        .send({
          preferredChannel: "telegram",
          adminTargets: [{ channel: "telegram", target: "@ops-admin" }],
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.notifications).toEqual({
        preferredChannel: "telegram",
        adminTargets: [{ channel: "telegram", target: "@ops-admin" }],
      });
      expect(operatorsStore.setNotificationPrefs).toHaveBeenCalledWith({
        preferredChannel: "telegram",
        adminTargets: [{ channel: "telegram", target: "@ops-admin" }],
      });
    });

    it("GET returns the supportedChannels array alongside stored prefs", async () => {
      const operatorsStore = createOperatorsStore();
      const app = createApp(createDeps({ operatorsStore }));

      const res = await request(app).get("/api/openclaw/notifications");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.supportedChannels)).toBe(true);
      expect(res.body.supportedChannels).toEqual(kSupportedChannels);
      expect(res.body.notifications).toEqual({
        preferredChannel: null,
        adminTargets: [],
      });
    });
  });
});
