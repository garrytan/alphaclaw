// GET /api/diagnose (#76 A9): the `alphaclaw diagnose` collector composed
// with a running server's LIVE seams. Pins: the JSON envelope carries the
// collector's bundle unchanged (mode "server", every section present, live
// stamps where a seam was handed in, the redaction source wired through); a
// throwing seam degrades ITS section to unavailable while the request stays
// 200; `?format=text` renders the CLI's markdown as text/markdown; an
// unknown format is a 400; the auth gate runs before any collection; a
// collector that fails as a whole is one 500 like the neighbouring routes.
// Hermetic: express + supertest, real collector over a mkdtemp root with an
// injected store / installDir / env, no server, no network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  registerDiagnoseRoutes,
  kDiagnoseFormats,
  kDiagnoseTextContentType,
} = require("../../lib/server/routes/diagnose");
const {
  kDiagnoseSchema,
  kDiagnoseSectionNames,
} = require("../../lib/server/diagnose/collect");
const { kDiagnoseSectionTitles } = require("../../lib/server/diagnose/render");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");

const kNow = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const kEnvSecret = "tg-secret-value-7788";
const kAuthHeader = "x-test-auth";

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// The same 401 shape routes/auth.js's requireAuth answers for /api without
// a session or bearer; the header stands in for the session cookie.
const requireAuth = (req, res, next) => {
  if (req.get(kAuthHeader) === "ok") return next();
  res.status(401).json({ error: "Unauthorized" });
};

const createRoot = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-route-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const installDir = path.join(rootDir, "install");
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    nowFn: () => kNow,
    logger: { warn() {}, log() {}, error() {} },
  });
  fs.mkdirSync(store.managedDir, { recursive: true });
  store.writeState({ pinVersion: "2026.9.2", applied: null });
  writeJson(path.join(installDir, "node_modules", "openclaw", "package.json"), {
    name: "openclaw",
    version: "2026.9.2",
  });
  writeJson(path.join(store.managedDir, "alphaclaw-version.json"), {
    version: "0.9.77",
    commit: null,
    firstBootAt: kNow - 60_000,
    lastBootAt: kNow,
    bootCount: 2,
    previous: { version: "0.9.76", commit: null, lastBootAt: kNow - 120_000 },
  });
  return { rootDir, openclawDir, installDir, store };
};

const createDeps = (root) => {
  const getWatchdogStatus = vi.fn(() => ({
    lifecycle: "running",
    health: "degraded",
    // A secret echoed by a live seam must never reach the paste.
    degradedReason: `probe said ${kEnvSecret}`,
    lastExit: { code: 1, signal: null, at: kNow - 5000, cause: "state_migration_refused", corroborated: true },
    versionMismatch: null,
    history: [{ should: "be dropped — not a whitelisted status field" }],
  }));
  const incidentsDb = {
    listIncidents: vi.fn(() => [
      {
        id: 7,
        incidentKey: "crash_loop",
        status: "open",
        openedAt: kNow - 9000,
        resolvedAt: null,
        eventCount: 4,
        cause: { cause: "state_migration_refused", corroborated: true },
        summary: null,
      },
    ]),
  };
  const getChannelInfo = vi.fn(() => ({
    releaseChannel: "stable",
    installedVersion: "2026.9.2",
    expectedVersion: "2026.9.2",
    installedDiverged: false,
    stateCorrupted: false,
  }));
  const readLogTail = vi.fn(() => "[watchdog] gateway exited code=1\nunrelated line\n[alphaclaw] AlphaClaw 0.9.77\n");
  const readEnvFile = vi.fn(() => [{ key: "TELEGRAM_BOT_TOKEN", value: kEnvSecret }]);
  return {
    requireAuth,
    fsModule: fs,
    // rootDir deliberately omitted: the route derives it from the openclaw dir.
    openclawDir: root.openclawDir,
    installDir: root.installDir,
    env: {},
    nowFn: () => kNow,
    channelStore: root.store,
    readEnvFile,
    readLogTail,
    incidentsDb,
    getWatchdogStatus,
    getChannelInfo,
    logger: { warn: vi.fn(), log() {}, error() {} },
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerDiagnoseRoutes({ app, ...deps });
  return app;
};

const authed = (app, url) => request(app).get(url).set(kAuthHeader, "ok");

describe("server/routes/diagnose", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const newRoot = () => {
    const root = createRoot();
    roots.push(root.rootDir);
    return root;
  };

  it("answers { ok, bundle } with the collector composed over the live seams (mode server)", async () => {
    const root = newRoot();
    const deps = createDeps(root);
    const res = await authed(createApp(deps), "/api/diagnose");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.ok).toBe(true);
    const { bundle } = res.body;
    expect(bundle.schema).toBe(kDiagnoseSchema);
    expect(bundle.redacted).toBe(true);
    expect(bundle.mode).toBe("server");
    expect(bundle.generatedAtMs).toBe(kNow);
    // rootDir derived from the openclaw dir; the store's managed dir is used.
    expect(bundle.paths.rootDir).toBe(root.rootDir);
    expect(bundle.paths.openclawDir).toBe(root.openclawDir);
    expect(bundle.paths.managedDir).toBe(root.store.managedDir);
    expect(bundle.paths.installDir).toBe(root.installDir);
    expect(Object.keys(bundle.sections)).toEqual([...kDiagnoseSectionNames]);

    // Live seams stamp `live` and carry their data.
    expect(deps.getWatchdogStatus).toHaveBeenCalledTimes(1);
    expect(bundle.sections.watchdog.source).toBe("live");
    expect(bundle.sections.watchdog.data.lifecycle).toBe("running");
    expect(bundle.sections.watchdog.data.lastExit.cause).toBe("state_migration_refused");
    expect(bundle.sections.watchdog.data.history).toBeUndefined();

    expect(deps.incidentsDb.listIncidents).toHaveBeenCalledWith({ limit: 3 });
    expect(bundle.sections.incidents.source).toBe("live");
    expect(bundle.sections.incidents.data.incidents.map((row) => row.id)).toEqual([7]);
    expect(bundle.sections.incidents.data.incidents[0].cause).toEqual({
      cause: "state_migration_refused",
      corroborated: true,
    });

    expect(deps.getChannelInfo).toHaveBeenCalledTimes(1);
    expect(bundle.sections.channelState.source).toBe("live");
    expect(bundle.sections.channelState.data.info.installedVersion).toBe("2026.9.2");
    expect(bundle.sections.channelState.data.pinVersion).toBe("2026.9.2");

    expect(bundle.sections.pidfile.source).toBe("live");

    // Disk sections read the store's managed dir (the same files the boot
    // spine writes) — the self-version stamp planted there is visible.
    expect(bundle.sections.selfVersion.source).toBe("disk");
    expect(bundle.sections.selfVersion.data.record.version).toBe("0.9.77");

    // The process log comes from the injected readLogTail, boot-spine lines only.
    expect(deps.readLogTail).toHaveBeenCalledTimes(1);
    expect(bundle.sections.logTail.data.path).toBe("readLogTail");
    expect(bundle.sections.logTail.data.lines).toEqual([
      "[watchdog] gateway exited code=1",
      "[alphaclaw] AlphaClaw 0.9.77",
    ]);

    // Redaction source wired: readEnvFile() fed the scrubber, so the secret a
    // live seam echoed is gone from the whole payload.
    expect(deps.readEnvFile).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(kEnvSecret);
    expect(bundle.sections.watchdog.data.degradedReason).toMatch(/probe said/);
    expect(bundle.sections.watchdog.data.degradedReason).not.toContain(kEnvSecret);
  });

  it("a throwing live seam degrades only its own section and the request stays 200", async () => {
    const root = newRoot();
    const deps = createDeps(root);
    deps.incidentsDb.listIncidents.mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    });
    const res = await authed(createApp(deps), "/api/diagnose");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const { bundle } = res.body;
    expect(bundle.sections.incidents.source).toBe("unavailable");
    expect(bundle.sections.incidents.data).toBeNull();
    expect(bundle.sections.incidents.reason).toContain("incidents failed");
    expect(bundle.sections.incidents.reason).toContain("SQLITE_CORRUPT");
    expect(bundle.summary.unavailable).toEqual(["incidents"]);
    // Nothing else moved.
    expect(bundle.sections.watchdog.source).toBe("live");
    expect(bundle.sections.channelState.source).toBe("live");
    expect(bundle.mode).toBe("server");
    // Calls per request, not per registration: a second request re-reads.
    expect(deps.getWatchdogStatus).toHaveBeenCalledTimes(1);
  });

  it("?format=text renders the CLI's markdown as text/markdown", async () => {
    const root = newRoot();
    const deps = createDeps(root);
    const res = await authed(createApp(deps), "/api/diagnose?format=text");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(kDiagnoseTextContentType);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text.startsWith("# AlphaClaw diagnose\n")).toBe(true);
    expect(res.text).toContain("- mode: server (live sections from the running server)");
    for (const name of kDiagnoseSectionNames) {
      expect(res.text).toContain(`## ${kDiagnoseSectionTitles[name]}`);
    }
    expect(res.text).toContain("state_migration_refused");
    expect(res.text).not.toContain(kEnvSecret);
  });

  it("format is case/whitespace tolerant and anything else is a 400 invalid_format", async () => {
    const root = newRoot();
    const deps = createDeps(root);
    const app = createApp(deps);

    const upper = await authed(app, "/api/diagnose?format=%20TEXT%20");
    expect(upper.status).toBe(200);
    expect(upper.headers["content-type"]).toContain("text/markdown");

    const bad = await authed(app, "/api/diagnose?format=yaml");
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      ok: false,
      error: "invalid_format",
      hint: `format must be one of ${kDiagnoseFormats.join(", ")}`,
    });
    // The 400 short-circuits before any collection.
    expect(deps.getWatchdogStatus).toHaveBeenCalledTimes(1);
  });

  it("an unauthenticated request is a 401 and the collector never runs", async () => {
    const root = newRoot();
    const collect = vi.fn(async () => ({ schema: kDiagnoseSchema, sections: {} }));
    const deps = { ...createDeps(root), collect };
    const app = createApp(deps);

    const res = await request(app).get("/api/diagnose");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(collect).not.toHaveBeenCalled();
    expect(deps.readEnvFile).not.toHaveBeenCalled();

    const text = await request(app).get("/api/diagnose?format=text");
    expect(text.status).toBe(401);
    expect(collect).not.toHaveBeenCalled();
  });

  it("a collector that fails as a whole is one 500 { ok: false, error } (never a hung request)", async () => {
    const root = newRoot();
    const deps = {
      ...createDeps(root),
      collect: vi.fn(async () => {
        throw new Error("release-channel store unavailable");
      }),
    };
    const res = await authed(createApp(deps), "/api/diagnose");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "release-channel store unavailable" });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "[diagnose] bundle failed: release-channel store unavailable",
    );
  });

  it("passes the seams through to the collector by name (the wiring contract register-server-routes relies on)", async () => {
    const root = newRoot();
    const collect = vi.fn(async () => ({ schema: kDiagnoseSchema, sections: {} }));
    const bootReports = { readBootReports: () => ({ current: null, previous: [], incident: null, unreadable: [] }) };
    const selfVersion = () => ({ version: "0.9.77" });
    const schemaTable = { read: () => ({ byVersion: {} }), supportedFor: () => null, filePath: "x" };
    const deps = { ...createDeps(root), rootDir: "/explicit/root", collect, bootReports, selfVersion, schemaTable };
    const res = await authed(createApp(deps), "/api/diagnose");

    expect(res.status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
    const options = collect.mock.calls[0][0];
    expect(options.rootDir).toBe("/explicit/root"); // explicit rootDir wins over the derived one
    expect(options.openclawDir).toBe(root.openclawDir);
    expect(options.installDir).toBe(root.installDir);
    expect(options.channelStore).toBe(root.store);
    expect(options.envFileVars).toEqual([{ key: "TELEGRAM_BOT_TOKEN", value: kEnvSecret }]);
    expect(options.readLogTail).toBe(deps.readLogTail);
    expect(options.incidentsDb).toBe(deps.incidentsDb);
    expect(options.getWatchdogStatus).toBe(deps.getWatchdogStatus);
    expect(options.getChannelInfo).toBe(deps.getChannelInfo);
    expect(options.bootReports).toBe(bootReports);
    expect(options.selfVersion).toBe(selfVersion);
    expect(options.schemaTable).toBe(schemaTable);
    expect(options.fsModule).toBe(fs);
    expect(options.env).toEqual({});
    expect(typeof options.nowFn).toBe("function");
  });

  it("lets the collector's own defaults apply for inputs the caller did not supply", async () => {
    const collect = vi.fn(async () => ({ schema: kDiagnoseSchema, sections: {} }));
    const app = express();
    registerDiagnoseRoutes({ app, requireAuth, collect });
    const res = await authed(app, "/api/diagnose");

    expect(res.status).toBe(200);
    const options = collect.mock.calls[0][0];
    // undefined (not null) so `= default` parameters kick in inside collectDiagnose.
    for (const key of ["fsModule", "rootDir", "openclawDir", "env", "nowFn"]) {
      expect(options).toHaveProperty(key);
      expect(options[key]).toBeUndefined();
    }
    expect(options.envFileVars).toBeNull();
    expect(options.incidentsDb).toBeNull();
    expect(options.getWatchdogStatus).toBeNull();
  });
});
