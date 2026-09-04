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
      // Fast-leak profile bounds ride along so the UI can validate locally.
      bounds: {
        budgetMb: { min: 256, max: 1048576 },
        maxRestartsPerDay: { min: 1, max: 24 },
      },
    });
  });

  it("degrades honestly when not wired — and still ships the profile defaults + bounds", async () => {
    const res = await request(
      createApp(createDeps({ readWatchdogMemorySettings: null })),
    ).get("/api/watchdog/memory");
    expect(res.status).toBe(200);
    expect(res.body.wired).toBe(false);
    expect(res.body.settings).toEqual({
      enabled: false,
      autoRestart: false,
      effectiveAutoRestart: false,
      budgetMb: null,
      maxRestartsPerDay: 2,
    });
    expect(res.body.bounds).toEqual({
      budgetMb: { min: 256, max: 1048576 },
      maxRestartsPerDay: { min: 1, max: 24 },
    });
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

  it("rejects out-of-bounds or non-numeric fast-leak profile fields with 400 (issue #56)", async () => {
    const app = createApp(createDeps());
    const badBodies = [
      { budgetMb: "2800" },
      { budgetMb: 100 },
      { budgetMb: 2 ** 21 },
      { budgetMb: 2800.6 },
      { budgetMb: 255.6 },
      { maxRestartsPerDay: 0 },
      { maxRestartsPerDay: 25 },
      { maxRestartsPerDay: 2.5 },
      { maxRestartsPerDay: null },
      { maxRestartsPerDay: "4" },
    ];
    for (const body of badBodies) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/memory").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_setting");
      expect(res.body.field).toBe(Object.keys(body)[0]);
      expect(res.body.bounds).toBeTruthy();
    }
  });

  it("accepts in-bounds whole-number profile fields and passes null through to clear the budget", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    let res = await request(app)
      .put("/api/watchdog/memory")
      .send({ budgetMb: 2800, maxRestartsPerDay: 6 });
    expect(res.status).toBe(200);
    expect(deps.updateWatchdogMemorySettings).toHaveBeenLastCalledWith({
      budgetMb: 2800,
      maxRestartsPerDay: 6,
    });
    res = await request(app).put("/api/watchdog/memory").send({ budgetMb: null });
    expect(res.status).toBe(200);
    expect(deps.updateWatchdogMemorySettings).toHaveBeenLastCalledWith({
      budgetMb: null,
    });
  });

  it("accepts the inclusive bounds edges (256/1048576 MB, 1/24 per day)", async () => {
    // A tiny live RSS so the 256 MB floor is not shadowed by the current-usage guard.
    const deps = createDeps({
      watchdog: {
        getStatus: vi.fn(() => ({ gatewayPid: 4242 })),
        getMemoryTrend: vi.fn(() => ({ ...kTrend, rssMb: 100 })),
      },
    });
    const app = createApp(deps);
    for (const body of [
      { budgetMb: 256 },
      { budgetMb: 1048576 },
      { maxRestartsPerDay: 1 },
      { maxRestartsPerDay: 24 },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/memory").send(body);
      expect(res.status).toBe(200);
      expect(deps.updateWatchdogMemorySettings).toHaveBeenLastCalledWith(body);
    }
  });

  it("rejects a budget at or below the gateway's CURRENT RSS (a restart loop, not a leak guard)", async () => {
    // kTrend.rssMb is 812.
    const deps = createDeps();
    const app = createApp(deps);
    for (const budgetMb of [512, 812]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/memory").send({ budgetMb });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: "budget_below_current_rss",
        field: "budgetMb",
        currentRssMb: 812,
      });
    }
    expect(deps.updateWatchdogMemorySettings).not.toHaveBeenCalled();
    // Strictly above → accepted.
    const ok = await request(app).put("/api/watchdog/memory").send({ budgetMb: 813 });
    expect(ok.status).toBe(200);
    // No live trend (legacy watchdog shape / no gateway) → the bounds alone decide.
    const noTrend = createDeps({ watchdog: { getStatus: vi.fn(() => ({})) } });
    const res = await request(createApp(noTrend))
      .put("/api/watchdog/memory")
      .send({ budgetMb: 256 });
    expect(res.status).toBe(200);
  });

  it("an invalid profile field rejects the WHOLE patch — a valid sibling never persists", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    for (const body of [
      { enabled: true, budgetMb: 1 },
      { autoRestart: false, maxRestartsPerDay: 0 },
      { budgetMb: true },
      { maxRestartsPerDay: "6" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/memory").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_setting");
    }
    expect(deps.updateWatchdogMemorySettings).not.toHaveBeenCalled();
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

  it("escalates budgetMb / maxRestartsPerDay writes UNCONDITIONALLY (restart levers, issue #56)", () => {
    const armed = resolverFor({ enabled: true, autoRestart: true });
    expect(armed({ body: { budgetMb: 2800 } })).toBe("dangerous");
    expect(armed({ body: { budgetMb: null } })).toBe("dangerous");
    expect(armed({ body: { maxRestartsPerDay: 12 } })).toBe("dangerous");
    // Disarming in the same write does NOT launder the profile write.
    expect(armed({ body: { autoRestart: false, maxRestartsPerDay: 12 } })).toBe(
      "dangerous",
    );
    // Disarmed pre-staging is the bypass this closes: a stored aggressive
    // profile would go live on a later operator arm-confirm that names only
    // the op. So even report-only shaping needs the confirm.
    const disarmed = resolverFor({ enabled: true, autoRestart: false });
    expect(disarmed({ body: { budgetMb: 2800 } })).toBe("dangerous");
    expect(disarmed({ body: { maxRestartsPerDay: 12 } })).toBe("dangerous");
    expect(disarmed({ body: { autoRestart: true, budgetMb: 512 } })).toBe(
      "dangerous",
    );
    // Detection off with a stored autoRestart:true (the enabled-flip route).
    const parked = resolverFor({ enabled: false, autoRestart: true });
    expect(parked({ body: { budgetMb: 256 } })).toBe("dangerous");
    expect(parked({ body: { maxRestartsPerDay: 24 } })).toBe("dangerous");
    // The plain toggles keep their existing tiers.
    expect(disarmed({ body: { enabled: false } })).toBe("write");
    expect(armed({ body: { autoRestart: false } })).toBe("write");
  });

  it("the production op documents the fast-leak profile params for agent actors", () => {
    const domain = require("../../lib/server/admin-manifest/domains/watchdog");
    const op = domain.ops.find((o) => o.id === "watchdog.memory.update");
    const names = op.params.fields.map((f) => f.name);
    expect(names).toEqual(["enabled", "autoRestart", "budgetMb", "maxRestartsPerDay"]);
    expect(op.title).toContain("budgetMb");
    expect(op.notes).toContain("maxRestartsPerDay");
    expect(op.notes).toContain("null");
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
