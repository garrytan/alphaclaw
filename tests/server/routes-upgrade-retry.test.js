const express = require("express");
const request = require("supertest");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { registerSystemRoutes } = require("../../lib/server/routes/system");
const { GatewayRestartError, GatewayStopError } = require("../../lib/server/gateway");
const { kBootMigrationFileName, readMigrationRecord } = require("../../lib/server/openclaw-boot-migration");
const { kOpenclawBootMigrationLeaseMs } = require("../../lib/server/constants");

const kPin = "2026.10.4";

const makeDirs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-retry-"));
  const openclawDir = path.join(root, "openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
  return { root, openclawDir, managedDir };
};

const writeRecord = (managedDir, record) =>
  fs.writeFileSync(path.join(managedDir, kBootMigrationFileName), JSON.stringify(record));

const failedRecord = (extra = {}) => ({
  completedForVersion: "2026.10.2",
  lastOutcome: {
    status: "failed",
    class: "deterministic",
    reason: "failing_check",
    detail: "Failing check plugins: broken",
    captureState: "unavailable",
    openclawVersion: kPin,
    source: "boot",
    at: 1,
  },
  ...extra,
});

const kFailingDoctor = { ok: false, code: 1, stdout: "Failing check plugins: still broken\n", stderr: "" };

const createHarness = ({ record = failedRecord(), runDoctorFix, restartGateway, lockActive = null } = {}) => {
  const dirs = makeDirs();
  writeRecord(dirs.managedDir, record);
  const order = [];
  const events = [];
  const deps = {
    fs,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(() => true),
    kKnownVars: [],
    kKnownKeys: new Set(),
    kSystemVars: new Set(),
    syncChannelConfig: vi.fn(),
    isGatewayRunning: vi.fn(async () => true),
    isOnboarded: vi.fn(() => true),
    getChannelStatus: vi.fn(() => ({})),
    openclawVersionService: { readOpenclawVersion: vi.fn(() => kPin) },
    alphaclawVersionService: { readAlphaclawVersion: vi.fn(() => "0.10.7") },
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
    OPENCLAW_DIR: dirs.openclawDir,
    ensureGatewayProxyConfig: vi.fn(() => false),
    getBaseUrl: vi.fn(() => "https://setup.example.com"),
    kAlphaclawGithubReleasesBaseUrl: "https://example.invalid",
    topicRegistry: { getGroup: vi.fn(() => null) },
    authProfiles: {},
    restartRequiredState: {
      markRequired: vi.fn(),
      getSnapshot: vi.fn(async () => ({ restartRequired: false, restartInProgress: false, gatewayRunning: true })),
      markRestartInProgress: vi.fn(),
      clearRequired: vi.fn(),
      markRestartComplete: vi.fn(),
      beginRestart: vi.fn(() => ({ operationId: "op-up" })),
      completeRestart: vi.fn(),
      updateRestartOperation: vi.fn(),
      patchRestartOperation: vi.fn(),
      getActiveRestartOperation: vi.fn(() => null),
    },
    operationEvents: {
      createOperation: vi.fn(),
      publish: vi.fn((id, evt) => events.push(evt)),
      complete: vi.fn((id, data) => events.push({ event: "done", data })),
      fail: vi.fn((id, err) => events.push({ event: "error", data: { code: err.code, error: err.message, upgrade: err.upgrade, retryTarget: err.retryTarget } })),
    },
    watchdog: {
      getStatus: vi.fn(() => ({ lifecycle: "running" })),
      onExpectedRestart: vi.fn(),
      onExpectedRestartSettled: vi.fn(() => order.push("settled")),
      recordOperationEvent: vi.fn(),
      noteRestartFailure: vi.fn(() => {
        order.push("noted");
        return { admission: { ok: true } };
      }),
    },
    gatewayLifecycleLock: {
      tryAcquire: vi.fn(() => {
        const release = () => order.push("released");
        release.isValid = () => true;
        release.expiresAt = Date.now() + kOpenclawBootMigrationLeaseMs;
        return release;
      }),
      getActiveOperation: vi.fn(() => lockActive),
    },
    restartGateway:
      restartGateway ||
      vi.fn(async (options) => {
        options.onStep({ step: "stopping", status: "running" });
        options.onStep({ step: "stopping", status: "done" });
        const afterStop = await options.afterStop();
        order.push(`launch:${afterStop.reprepare ? "reprepared" : "stale"}`);
        return { durationMs: 1000, downtimeMs: 900, how: "graceful" };
      }),
    runDoctorFix: runDoctorFix || vi.fn(async () => {
      order.push("doctor");
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }),
    convergeAfterDoctor: vi.fn(async () => {
      order.push("converge");
      return { held: false };
    }),
    managedDir: dirs.managedDir,
    alphaclawVersion: "0.10.7",
    getInstalledOpenclawVersion: () => kPin,
    requireAdmin: (req, res, next) => next(),
  };
  const app = express();
  app.use(express.json());
  registerSystemRoutes({ app, agentSessionsCacheTtlMs: 0, ...deps });
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { app, deps, dirs, order, events, settle };
};

describe("POST /api/openclaw/boot-migration/retry", () => {
  it("runs Doctor with the gateway stopped, converges, re-prepares and relaunches", async () => {
    const h = createHarness();
    const res = await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, operationId: "op-up", kind: "openclaw_upgrade" });
    await h.settle();
    expect(h.deps.restartRequiredState.beginRestart).toHaveBeenCalledWith({ kind: "openclaw_upgrade", budgetMs: kOpenclawBootMigrationLeaseMs });
    expect(h.deps.operationEvents.createOperation).toHaveBeenCalledWith({ type: "openclaw_upgrade", operationId: "op-up" });
    // F4: the lease is sized for the whole Doctor, once.
    expect(h.deps.gatewayLifecycleLock.tryAcquire).toHaveBeenCalledWith("openclaw_upgrade", expect.objectContaining({ leaseMs: kOpenclawBootMigrationLeaseMs, cleanup: expect.any(Object) }));
    expect(h.deps.runDoctorFix).toHaveBeenCalledWith(expect.objectContaining({ source: "retry", operation: expect.any(Object) }));
    expect(h.order).toEqual(["doctor", "converge", "launch:reprepared", "released", "settled"]);
    expect(h.deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, upgrade: expect.objectContaining({ doctor: "ok" }), retryTarget: null }),
    );
    const done = h.events.find((evt) => evt.event === "done");
    expect(done.data.upgrade.doctor).toBe("ok");
    expect(h.deps.watchdog.recordOperationEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "openclaw_upgrade", status: "ok" }));
  });

  it("a failed Doctor still relaunches doctor-free and books the upgrade as unfinished (Try again → Retry upgrade)", async () => {
    const h = createHarness({ runDoctorFix: vi.fn(async () => kFailingDoctor) });
    await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    await h.settle();
    expect(h.deps.restartGateway).toHaveBeenCalledTimes(1);
    expect(h.deps.convergeAfterDoctor).toHaveBeenCalledTimes(1);
    expect(h.deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, upgrade: expect.objectContaining({ doctor: "failed", reason: "failing_check" }), retryTarget: "upgrade" }),
    );
    // The deterministic failure is remembered under the retry's key, so the
    // next retry on the same state asks for "Retry anyway".
    expect(readMigrationRecord({ managedDir: h.dirs.managedDir }).failed).toMatchObject({ reason: "failing_check", attempts: 1 });
    const again = await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "unchanged_since_failure", unchanged: true });
    const anyway = await request(h.app).post("/api/openclaw/boot-migration/retry").send({ confirmUnchanged: true });
    expect(anyway.status).toBe(202);
  });

  it("Doctor ok then a launch failure: 'Data upgraded, but OpenClaw didn't start', Try again → Restart, recovery before the terminal event", async () => {
    const restartGateway = vi.fn(async (options) => {
      options.onStep({ step: "stopping", status: "done" });
      await options.afterStop();
      throw new GatewayRestartError("openclaw gateway exited before ready", { code: "launch_failed", signalled: true });
    });
    const h = createHarness({ restartGateway });
    await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    await h.settle();
    expect(h.deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: "launch_failed", retryTarget: "restart", upgrade: expect.objectContaining({ doctor: "ok" }) }),
    );
    const names = h.events.map((evt) => evt.event);
    expect(names.indexOf("recovery")).toBeGreaterThan(-1);
    expect(names.indexOf("recovery")).toBeLessThan(names.indexOf("error"));
    const error = h.events.find((evt) => evt.event === "error");
    expect(error.data.error).toMatch(/^Data upgraded, but OpenClaw didn't start\./);
    expect(error.data.retryTarget).toBe("restart");
    expect(h.order).toEqual(expect.arrayContaining(["released", "settled", "noted"]));
    expect(h.order.indexOf("settled")).toBeLessThan(h.order.indexOf("noted"));
  });

  it("Doctor failed and the relaunch failed: one combined sentence, Try again → Retry upgrade", async () => {
    const restartGateway = vi.fn(async (options) => {
      await options.afterStop();
      throw new GatewayRestartError("not ready", { code: "ready_timeout", signalled: true, budgetMs: 60_000 });
    });
    const h = createHarness({ runDoctorFix: vi.fn(async () => kFailingDoctor), restartGateway });
    await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    await h.settle();
    const error = h.events.find((evt) => evt.event === "error");
    expect(error.data.error).toBe("The data upgrade didn't finish, and OpenClaw didn't start again: one of OpenClaw's upgrade checks failed: plugins.");
    expect(error.data.retryTarget).toBe("upgrade");
  });

  it("a stop failure never runs Doctor and says the upgrade didn't run", async () => {
    const restartGateway = vi.fn(async () => {
      throw new GatewayStopError("1 gateway process did not exit", { code: "stop_failed", signalled: true, survivors: [] });
    });
    const h = createHarness({ restartGateway });
    await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    await h.settle();
    expect(h.deps.runDoctorFix).not.toHaveBeenCalled();
    expect(h.deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, upgrade: { doctor: "not_run" }, retryTarget: "upgrade" }),
    );
    expect(h.deps.watchdog.onExpectedRestartSettled).toHaveBeenCalledTimes(1);
  });

  it("refuses with 409 when busy (never queued), when the pin already completed, and for a window refusal", async () => {
    const busy = createHarness({ lockActive: { kind: "repair" } });
    const res = await request(busy.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "operation_in_progress", error: "Repairing is in progress." });
    expect(busy.deps.restartGateway).not.toHaveBeenCalled();

    const done = createHarness({ record: { completedForVersion: kPin } });
    const doneRes = await request(done.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(doneRes.status).toBe(409);
    expect(doneRes.body.code).toBe("upgrade_complete");

    const windowed = createHarness({
      record: failedRecord({ lastOutcome: { ...failedRecord().lastOutcome, reason: "upgrade_window_refused" } }),
    });
    const windowRes = await request(windowed.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(windowRes.status).toBe(409);
    expect(windowRes.body.code).toBe("upgrade_window_refused");
  });

  it("a second retry or a Restart while the upgrade runs is a 409", async () => {
    let finish;
    const restartGateway = vi.fn(() => new Promise((resolve) => { finish = () => resolve({ durationMs: 1 }); }));
    const h = createHarness({ restartGateway });
    expect((await request(h.app).post("/api/openclaw/boot-migration/retry").send({})).status).toBe(202);
    const second = await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
    expect(second.status).toBe(409);
    expect(second.body.activeOperation).toEqual({ operationId: "op-up", kind: "openclaw_upgrade" });
    const restart = await request(h.app).post("/api/gateway/restart?async=1");
    expect(restart.status).toBe(409);
    expect(restart.body.code).toBe("operation_in_progress");
    finish();
    await h.settle();
  });

  it("keeps the record alive past 10.5 min of Doctor (heartbeat refreshes it with the upgrade budget)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const runDoctorFix = vi.fn(async ({ onProgress }) => {
        vi.setSystemTime(1_000_000 + 11 * 60_000);
        onProgress({ elapsedMs: 11 * 60_000, sinceOutputMs: 3 * 60_000 });
        return { ok: true, code: 0, stdout: "" };
      });
      const h = createHarness({ runDoctorFix });
      await request(h.app).post("/api/openclaw/boot-migration/retry").send({});
      await h.settle();
      const keepalive = h.deps.restartRequiredState.updateRestartOperation.mock.calls
        .map(([patch]) => patch)
        .filter((patch) => patch.lastStep === "upgrading_data" && patch.expiresAt);
      expect(keepalive.length).toBeGreaterThan(0);
      expect(keepalive.at(-1).expiresAt).toBe(1_000_000 + 11 * 60_000 + kOpenclawBootMigrationLeaseMs);
      const progress = h.events.find((evt) => evt.event === "step" && evt.data.detail?.sinceOutputMs === 3 * 60_000);
      expect(progress.data).toMatchObject({ name: "upgrading_data", label: "Upgrading OpenClaw data" });
    } finally {
      vi.useRealTimers();
    }
  });
});
