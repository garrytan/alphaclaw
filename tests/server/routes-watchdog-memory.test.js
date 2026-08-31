const express = require("express");
const request = require("supertest");
const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");

// GET/PUT /api/watchdog/memory (settings pair, overseer-route shape) plus the
// gatewayMemoryTrend extension on GET /api/watchdog/resources. The manifest
// tierResolver that guards agent-actor autoRestart writes has its own suite
// below (it is pure — no HTTP involved).
const kTrend = {
  state: "leak_suspected",
  rssMb: 812,
  slopeMbPerHour: 65,
  effectiveCapMb: 1024,
  capSource: "heap",
  pressureFraction: 0.79,
  projectedExhaustionAt: "2026-08-31T12:00:00.000Z",
  episodeId: "4242-1700000000000",
  lastEpisodeSummary: null,
};

const createDeps = (overrides = {}) => ({
  requireAuth: (req, res, next) => next(),
  watchdog: {
    getStatus: vi.fn(() => ({ gatewayPid: 4242 })),
    getMemoryTrend: vi.fn(() => ({ ...kTrend })),
  },
  watchdogNotifier: { notify: vi.fn() },
  getRecentEvents: vi.fn(() => []),
  readLogTail: vi.fn(() => ""),
  watchdogTerminal: {},
  readWatchdogMemorySettings: vi.fn(() => ({
    enabled: true,
    autoRestart: false,
    effectiveAutoRestart: false,
  })),
  updateWatchdogMemorySettings: vi.fn((patch) => ({
    changed: true,
    settings: {
      enabled: patch.enabled ?? true,
      autoRestart: patch.autoRestart ?? false,
      effectiveAutoRestart:
        (patch.enabled ?? true) && (patch.autoRestart ?? false),
    },
  })),
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({ app, ...deps });
  return app;
};

describe("GET /api/watchdog/memory", () => {
  it("returns the settings document", async () => {
    const res = await request(createApp(createDeps())).get(
      "/api/watchdog/memory",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false },
    });
  });

  it("degrades honestly when not wired", async () => {
    const res = await request(
      createApp(createDeps({ readWatchdogMemorySettings: null })),
    ).get("/api/watchdog/memory");
    expect(res.status).toBe(200);
    expect(res.body.wired).toBe(false);
    expect(res.body.settings.enabled).toBe(false);
  });
});

describe("PUT /api/watchdog/memory", () => {
  it("rejects non-boolean fields and empty patches with 400 invalid_setting", async () => {
    const app = createApp(createDeps());
    const badBodies = [
      {},
      { enabled: "true" },
      { enabled: 1 },
      { autoRestart: "yes" },
      { autoRestart: null },
      { unrelated: true },
    ];
    for (const body of badBodies) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/memory").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_setting");
    }
  });

  it("persists a per-field patch and returns the derived settings", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps))
      .put("/api/watchdog/memory")
      .send({ autoRestart: true });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      enabled: true,
      autoRestart: true,
      effectiveAutoRestart: true,
    });
    // Per-field narrow: the patch carried ONLY the field the caller sent.
    expect(deps.updateWatchdogMemorySettings).toHaveBeenCalledWith({
      autoRestart: true,
    });
  });

  it("409s config_unreadable instead of 500 when the updater refuses a corrupt config", async () => {
    const deps = createDeps({
      updateWatchdogMemorySettings: vi.fn(() => {
        const err = new Error("alphaclaw.json exists but cannot be parsed");
        err.code = "config_unreadable";
        throw err;
      }),
    });
    const res = await request(createApp(deps))
      .put("/api/watchdog/memory")
      .send({ enabled: false });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "config_unreadable" });
  });

  it("503s when the updater is not wired", async () => {
    const res = await request(
      createApp(createDeps({ updateWatchdogMemorySettings: null })),
    )
      .put("/api/watchdog/memory")
      .send({ enabled: false });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/watchdog/resources gatewayMemoryTrend", () => {
  it("carries the cached trend snapshot", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps)).get("/api/watchdog/resources");
    expect(res.status).toBe(200);
    expect(res.body.resources.gatewayMemoryTrend).toEqual(kTrend);
    expect(deps.watchdog.getMemoryTrend).toHaveBeenCalledTimes(1);
  });

  it("degrades to null when the watchdog has no trend getter (legacy shape)", async () => {
    const deps = createDeps({
      watchdog: { getStatus: vi.fn(() => ({ gatewayPid: null })) },
    });
    const res = await request(createApp(deps)).get("/api/watchdog/resources");
    expect(res.status).toBe(200);
    expect(res.body.resources.gatewayMemoryTrend).toBeNull();
  });
});

describe("admin-manifest memoryUpdateTierResolver", () => {
  const {
    createMemoryUpdateTierResolver,
  } = require("../../lib/server/admin-manifest/domains/watchdog");
  const resolverFor = (current) =>
    createMemoryUpdateTierResolver(() => current);

  it("escalates an agent write that ARMS auto-restart (direct flag)", () => {
    const resolve = resolverFor({ enabled: true, autoRestart: false });
    expect(resolve({ body: { autoRestart: true } })).toBe("dangerous");
  });

  it("escalates autoRestart:true even while detection is off (split-write TOCTOU closure)", () => {
    // From {enabled:false, autoRestart:false}, concurrent {enabled:true} and
    // {autoRestart:true} writes each look non-arming against the pre-write
    // snapshot, then serialize into an armed switch. Every path to armed must
    // pass an operator confirm, so autoRestart:true is dangerous
    // UNCONDITIONALLY — not just when the resulting effective state arms.
    const resolve = resolverFor({ enabled: false, autoRestart: false });
    expect(resolve({ body: { autoRestart: true } })).toBe("dangerous");
    expect(
      resolve({ body: { enabled: false, autoRestart: true } }),
    ).toBe("dangerous");
  });

  it("escalates the enabled-flip bypass (re-enabling detection re-arms a stored autoRestart)", () => {
    const resolve = resolverFor({ enabled: false, autoRestart: true });
    expect(resolve({ body: { enabled: true } })).toBe("dangerous");
  });

  it("keeps disarming and plain detection toggles at the write tier", () => {
    const armed = resolverFor({ enabled: true, autoRestart: true });
    expect(armed({ body: { autoRestart: false } })).toBe("write");
    expect(armed({ body: { enabled: false } })).toBe("write");
    const disarmed = resolverFor({ enabled: true, autoRestart: false });
    expect(disarmed({ body: { enabled: false } })).toBe("write");
    expect(disarmed({ body: { enabled: true } })).toBe("write");
  });

  it("fails closed to the confirm tier when the current state is unreadable", () => {
    const resolve = createMemoryUpdateTierResolver(() => {
      throw new Error("unreadable");
    });
    expect(resolve({ body: { autoRestart: true } })).toBe("dangerous");
  });

  it("fails closed when the config read fell back to defaults (configUnreadable signal)", () => {
    // readWatchdogMemorySettings does not throw on a corrupt file — it
    // returns fail-closed DEFAULTS flagged configUnreadable. Without this
    // branch the resolver would judge {enabled:true} against autoRestart:false
    // defaults and hand an agent a plain write tier while the real stored
    // state is unknown.
    const resolve = resolverFor({
      enabled: false,
      autoRestart: false,
      effectiveAutoRestart: false,
      configUnreadable: true,
    });
    expect(resolve({ body: { enabled: true } })).toBe("dangerous");
    expect(resolve({ body: { autoRestart: false } })).toBe("dangerous");
    expect(resolve({ body: { enabled: false } })).toBe("dangerous");
  });

  it("the production op wires a resolver", () => {
    const domain = require("../../lib/server/admin-manifest/domains/watchdog");
    const op = domain.ops.find((o) => o.id === "watchdog.memory.update");
    expect(typeof op.tierResolver).toBe("function");
    expect(op.tier).toBe("write");
  });
});
