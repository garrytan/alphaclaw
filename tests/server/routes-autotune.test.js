const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

// Point constants at a temp root BEFORE any lib require so the routes' config
// reads/writes never touch the real machine. The global test kill-switch
// (ALPHACLAW_AUTOTUNE_DISABLED=1) stays ON here: these tests cover route
// plumbing and validation — derivation itself is covered by autotune.test.js.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autotune-routes-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const { registerAutotuneRoutes, validateOverrides } = require("../../lib/server/routes/autotune");
const { resetAutotuneForTests } = require("../../lib/server/autotune");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");

const makeApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const calls = { events: [], notifications: [], restartReasons: [] };
  registerAutotuneRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    gatewayLifecycleLock: {
      acquire: async () => () => {},
    },
    restartRequiredState: {
      markRequired: (reason) => calls.restartReasons.push(reason),
    },
    watchdogNotifier: {
      notify: async (message) => {
        calls.notifications.push(message);
        return { ok: true };
      },
    },
    insertWatchdogEvent: (event) => calls.events.push(event),
    doSyncPromptFiles: null,
    ...overrides,
  });
  return { app, calls };
};

describe("server/routes/autotune", () => {
  afterEach(() => {
    resetAutotuneForTests();
    fs.rmSync(path.join(kTempRoot, ".openclaw", "alphaclaw.json"), { force: true });
    // The persisted ledger also carries cross-test state (lastResize,
    // ownership) — strict assertions must not be order-dependent.
    fs.rmSync(
      path.join(kTempRoot, ".openclaw", ".alphaclaw", "autotune-ledger.json"),
      { force: true },
    );
  });

  afterAll(() => {
    fs.rmSync(kTempRoot, { recursive: true, force: true });
  });

  it("GET /api/autotune returns the ledger", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/api/autotune");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ledger).toHaveProperty("rows");
    expect(res.body.ledger).toHaveProperty("overrides");
    expect(res.body.ledger).toHaveProperty("lastResize");
  });

  it("PUT /api/autotune/settings rejects bad input with field-level 400s", async () => {
    const { app } = makeApp();

    let res = await request(app)
      .put("/api/autotune/settings")
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("enabled");

    res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { notAKnob: 5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("notAKnob");

    res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { gatewayHeapMb: 64 } }); // below min 128
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("gatewayHeapMb");

    res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { uvThreadpoolSize: 2.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("uvThreadpoolSize");
  });

  it("PUT /api/autotune/settings persists, merges per key, clears with null", async () => {
    const { app } = makeApp();

    let res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { gatewayHeapMb: 2048, sqliteCacheMb: 8 } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.changed).toBe(true);
    expect(res.body.settings.overrides).toEqual({
      gatewayHeapMb: 2048,
      sqliteCacheMb: 8,
    });
    expect(typeof res.body.restartRequired).toBe("boolean");
    expect(res.body.ledger).toHaveProperty("rows");

    // Sibling keys survive a single-key save; null clears exactly one.
    res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { gatewayHeapMb: null } });
    expect(res.status).toBe(200);
    expect(res.body.settings.overrides).toEqual({ sqliteCacheMb: 8 });

    res = await request(app)
      .put("/api/autotune/settings")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.enabled).toBe(false);
  });

  it("POST /api/autotune/reapply is idempotent and returns the ledger", async () => {
    const { app } = makeApp();
    const first = await request(app).post("/api/autotune/reapply");
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.ledger).toHaveProperty("rows");
    const second = await request(app).post("/api/autotune/reapply");
    expect(second.status).toBe(200);
  });

  it("PUT /api/autotune/resize-ack acknowledges (false when nothing pending)", async () => {
    const { app } = makeApp();
    const res = await request(app).put("/api/autotune/resize-ack");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, acknowledged: false });
  });

  it("rejects unknown top-level body fields with the same 400 strictness", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/autotune/settings")
      .send({ override: { gatewayHeapMb: 2048 } }); // typo'd field
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("override");
  });

  it("marks restart-required when the apply leaves a pending gateway row", async () => {
    // Enable autotune for this app's apply path (deps env is process.env in
    // routes) by clearing the kill-switch and mocking the cgroup files.
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      const key = String(filePath);
      if (key === "/sys/fs/cgroup/memory.max") return `${2048 * 1024 * 1024}\n`;
      if (key === "/sys/fs/cgroup/cpu.max") return "100000 100000";
      if (key.startsWith("/sys/fs/cgroup")) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
      }
      return realReadFileSync(filePath, ...args);
    });
    resetMachineProfileForTests({
      fsModule: {
        existsSync: (p2) => String(p2) === "/.dockerenv",
        readFileSync: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    });
    try {
      const { app, calls } = makeApp();
      // No spawn has stamped anything: gateway-env rows are pending_restart.
      const res = await request(app).post("/api/autotune/reapply");
      expect(res.status).toBe(200);
      expect(res.body.restartRequired).toBe(true);
      expect(calls.restartReasons).toContain("autotune_changed");
    } finally {
      vi.restoreAllMocks();
      resetMachineProfileForTests();
      process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
    }
  });

  it("rejects prototype-chain override keys (__proto__, toString, constructor)", async () => {
    // A plain-object bounds lookup would resolve these to truthy inherited
    // values and skip the unknown-key 400 with undefined bounds.
    for (const key of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      const result = validateOverrides(JSON.parse(`{"${key}": 5}`));
      expect(result.ok, key).toBe(false);
    }
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/autotune/settings")
      .send({ overrides: { toString: 5 } });
    expect(res.status).toBe(400);
  });

  it("validateOverrides accepts in-range values and null clears", () => {
    expect(
      validateOverrides({ gatewayHeapMb: 1024, backupMaxTotalGb: null }),
    ).toEqual({ ok: true, value: { gatewayHeapMb: 1024, backupMaxTotalGb: null } });
    expect(validateOverrides(undefined)).toEqual({ ok: true, value: undefined });
    expect(validateOverrides([1]).ok).toBe(false);
  });
});
