const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  registerOpenclawChannelRoutes,
  createSqliteBackupRunner,
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
  runBackupSqlite: vi.fn(async () => ({
    ok: true,
    snapshotPath: "/data/backups/openclaw-sqlite/snap-1",
    tail: "verified ok",
  })),
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
    expect(res.body).toEqual({
      ok: true,
      snapshotPath: "/data/backups/openclaw-sqlite/snap-1",
      tail: "verified ok",
    });
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

describe("server/routes/openclaw-channel createSqliteBackupRunner", () => {
  const kRepoDir = "/data/backups/openclaw-sqlite";
  const kOpenclawDir = "/data/.openclaw";
  const kSnapshotPath = `${kRepoDir}/global-2026-08-29T00-00-00`;
  // Real beta create --json report shape: pretty-printed, no envelope.
  const makeCreateReportTail = (snapshotPath) =>
    JSON.stringify(
      { ok: true, snapshotPath, manifest: { artifact: {} } },
      null,
      2,
    );
  const kCreateReportTail = makeCreateReportTail(kSnapshotPath);
  // Explicit empty roster: the runner targets ONLY the global DB — the
  // single-database scenarios below use it to stay single-database.
  const kGlobalOnlyConfig = { agents: { entries: {} } };

  // `config` is the on-disk openclaw.json the runner's DEFAULT reader (the
  // shared readOpenclawConfig, including its keyed-roster normalization)
  // parses through the mocked fsModule for the agent roster; leaving it
  // undefined simulates a missing/unreadable config (→ global + implicit
  // "main"). Pass `readConfig` to bypass the default reader entirely.
  const makeRunner = ({ results, timeoutMs = 10_000, config, readConfig }) => {
    const calls = [];
    const runStreamed = vi.fn(async (opts) => {
      calls.push(opts);
      return results[calls.length - 1];
    });
    const fsModule = {
      mkdirSync: vi.fn(),
      readFileSync: vi.fn((filePath) => {
        expect(filePath).toBe(path.join(kOpenclawDir, "openclaw.json"));
        if (config === undefined) throw new Error("ENOENT");
        return JSON.stringify(config);
      }),
    };
    const getEnv = vi.fn(() => ({ OPENCLAW_TEST: "1" }));
    const run = createSqliteBackupRunner({
      runStreamed,
      getEnv,
      fsModule,
      openclawDir: kOpenclawDir,
      ...(readConfig ? { readConfig } : {}),
      repositoryDir: kRepoDir,
      timeoutMs,
    });
    return { run, calls, runStreamed, fsModule, getEnv };
  };

  // One passing create+verify result pair for the given create report tail.
  const okPair = (createTail) => [
    { ok: true, code: 0, timedOut: false, tail: createTail },
    { ok: true, code: 0, timedOut: false, tail: '{\n  "ok": true\n}' },
  ];

  it("creates+verifies every database: global first, then each entries-map agent", async () => {
    const snapMain = `${kRepoDir}/agent-main-2026-08-29T00-00-01`;
    const snapResearch = `${kRepoDir}/agent-research-2026-08-29T00-00-02`;
    const { run, calls, fsModule, getEnv } = makeRunner({
      config: { agents: { entries: { main: {}, research: {} } } },
      timeoutMs: 30_000,
      results: [
        ...okPair(kCreateReportTail),
        ...okPair(makeCreateReportTail(snapMain)),
        ...okPair(makeCreateReportTail(snapResearch)),
      ],
    });
    const result = await run();

    expect(fsModule.mkdirSync).toHaveBeenCalledWith(kRepoDir, {
      recursive: true,
    });
    expect(calls).toHaveLength(6);
    for (const call of calls) expect(call.command).toBe("openclaw");
    const createArgs = (scopeArgs) => [
      "backup",
      "sqlite",
      "create",
      ...scopeArgs,
      "--repository",
      kRepoDir,
      "--json",
    ];
    const verifyArgs = (snapshotPath) => [
      "backup",
      "sqlite",
      "verify",
      snapshotPath,
      "--json",
    ];
    expect(calls.map((call) => call.args)).toEqual([
      createArgs(["--global"]),
      verifyArgs(kSnapshotPath),
      createArgs(["--agent", "main"]),
      verifyArgs(snapMain),
      createArgs(["--agent", "research"]),
      verifyArgs(snapResearch),
    ]);
    // The single backup budget is split fairly across the 3 databases
    // (30s / 3 = 10s each), then 80% create / remainder verify within each.
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      8000, 2000, 8000, 2000, 8000, 2000,
    ]);
    expect(getEnv).toHaveBeenCalledTimes(6);
    expect(result.ok).toBe(true);
    // Top-level snapshotPath keeps the pre-existing shape: the last success.
    expect(result.snapshotPath).toBe(snapResearch);
    expect(result.databases).toEqual([
      { target: "global", ok: true, step: "verify", snapshotPath: kSnapshotPath, code: 0, timedOut: false },
      { target: "agent:main", ok: true, step: "verify", snapshotPath: snapMain, code: 0, timedOut: false },
      { target: "agent:research", ok: true, step: "verify", snapshotPath: snapResearch, code: 0, timedOut: false },
    ]);
    expect(result.tail).toContain(
      "Verified 3/3 databases: global, agent:main, agent:research.",
    );
  });

  it("an agent verify failure fails the whole backup, naming the agent and the unattempted targets", async () => {
    const snapMain = `${kRepoDir}/agent-main-2026-08-29T00-00-01`;
    const { run, calls } = makeRunner({
      config: { agents: { entries: { main: {}, aux: {} } } },
      results: [
        ...okPair(kCreateReportTail),
        { ok: true, code: 0, timedOut: false, tail: makeCreateReportTail(snapMain) },
        { ok: false, code: 1, timedOut: false, tail: "artifact hash mismatch" },
      ],
    });
    const result = await run();

    // Stops at the first failure: agent:aux is never attempted.
    expect(calls).toHaveLength(4);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("verify");
    expect(result.snapshotPath).toBe(snapMain);
    expect(result.tail).toContain("database agent:main");
    expect(result.tail).toContain("verify FAILED");
    expect(result.tail).toContain("artifact hash mismatch");
    expect(result.tail).toContain(
      "Databases not attempted after this failure: agent:aux.",
    );
    expect(result.databases).toEqual([
      { target: "global", ok: true, step: "verify", snapshotPath: kSnapshotPath, code: 0, timedOut: false },
      { target: "agent:main", ok: false, step: "verify", snapshotPath: snapMain, code: 1, timedOut: false },
      { target: "agent:aux", ok: false, step: "skipped", snapshotPath: null, code: null, timedOut: false },
    ]);
  });

  it("a roster-less config backs up global + the implicit sole agent 'main'", async () => {
    const snapMain = `${kRepoDir}/agent-main-2026-08-29T00-00-01`;
    const { run, calls } = makeRunner({
      config: {},
      results: [...okPair(kCreateReportTail), ...okPair(makeCreateReportTail(snapMain))],
    });
    const result = await run();

    expect(calls).toHaveLength(4);
    expect(calls[2].args).toContain("--agent");
    expect(calls[2].args).toContain("main");
    // 10s budget over 2 databases: 5s each, 80/20 within each.
    expect(calls.map((call) => call.timeoutMs)).toEqual([4000, 1000, 4000, 1000]);
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual([
      "global",
      "agent:main",
    ]);
  });

  it("an unreadable openclaw.json falls back to global + 'main'", async () => {
    const snapMain = `${kRepoDir}/agent-main-2026-08-29T00-00-01`;
    const { run, calls } = makeRunner({
      // config undefined → readFileSync throws.
      results: [...okPair(kCreateReportTail), ...okPair(makeCreateReportTail(snapMain))],
    });
    const result = await run();

    expect(calls).toHaveLength(4);
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual([
      "global",
      "agent:main",
    ]);
  });

  it("reads agent ids from an agents.list roster, trimming and dropping blanks", async () => {
    const snapAlpha = `${kRepoDir}/agent-alpha-2026-08-29T00-00-01`;
    const { run, calls } = makeRunner({
      config: { agents: { list: [{ id: " alpha " }, { id: "" }, null] } },
      results: [...okPair(kCreateReportTail), ...okPair(makeCreateReportTail(snapAlpha))],
    });
    const result = await run();

    expect(calls).toHaveLength(4);
    expect(calls[2].args).toContain("alpha");
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual([
      "global",
      "agent:alpha",
    ]);
  });

  it("resolves a keyed entry's explicit inner id like the shared config reader", async () => {
    const snapRenamed = `${kRepoDir}/agent-renamed-2026-08-29T00-00-01`;
    const { run, calls } = makeRunner({
      // readOpenclawConfig's normalizeAgentsShapeForRead injects the entry
      // key as the id but lets an explicit inner `id` win — the roster must
      // match that interpretation, not a hand-parsed Object.keys() read.
      config: { agents: { entries: { alpha: { id: "renamed" } } } },
      results: [...okPair(kCreateReportTail), ...okPair(makeCreateReportTail(snapRenamed))],
    });
    const result = await run();

    expect(calls).toHaveLength(4);
    expect(calls[2].args).toContain("renamed");
    expect(calls[2].args).not.toContain("alpha");
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual([
      "global",
      "agent:renamed",
    ]);
  });

  it("treats a present-but-malformed roster property as an empty roster (global only)", async () => {
    // Property presence short-circuits (dist readAgentRosterProperty): a
    // malformed roster is "no entries", NOT the implicit sole agent "main".
    const { run, calls } = makeRunner({
      config: { agents: { entries: "bogus" } },
      results: okPair(kCreateReportTail),
    });
    const result = await run();

    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual(["global"]);
  });

  it("routes the roster read through an injected readConfig without touching the filesystem", async () => {
    const snapCustom = `${kRepoDir}/agent-custom-2026-08-29T00-00-01`;
    const readConfig = vi.fn(() => ({ agents: { list: [{ id: "custom" }] } }));
    const { run, fsModule } = makeRunner({
      readConfig,
      results: [...okPair(kCreateReportTail), ...okPair(makeCreateReportTail(snapCustom))],
    });
    const result = await run();

    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(fsModule.readFileSync).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.databases.map((db) => db.target)).toEqual([
      "global",
      "agent:custom",
    ]);
  });

  it("parses the snapshotPath out of interleaved CLI log noise", async () => {
    const { run, calls } = makeRunner({
      config: kGlobalOnlyConfig,
      results: [
        {
          ok: true,
          code: 0,
          timedOut: false,
          tail: `plugin chatter\n${kCreateReportTail}\ndeprecation warning`,
        },
        { ok: true, code: 0, timedOut: false, tail: "{}" },
      ],
    });
    const result = await run();

    expect(calls[1].args[3]).toBe(kSnapshotPath);
    expect(result.ok).toBe(true);
  });

  it("reports a create failure without running verify, naming the database and skipped targets", async () => {
    const { run, runStreamed } = makeRunner({
      // Unreadable config → global + main; the global create fails first.
      results: [
        { ok: false, code: 1, timedOut: false, tail: "disk full" },
      ],
    });
    const result = await run();

    expect(runStreamed).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.step).toBe("create");
    expect(result.tail).toContain("Create FAILED for database global");
    expect(result.tail).toContain("disk full");
    expect(result.tail).toContain(
      "Databases not attempted after this failure: agent:main.",
    );
    expect(result.databases).toEqual([
      { target: "global", ok: false, step: "create", snapshotPath: null, code: 1, timedOut: false },
      { target: "agent:main", ok: false, step: "skipped", snapshotPath: null, code: null, timedOut: false },
    ]);
  });

  it("reports unparseable create output as a failure and does not verify", async () => {
    const { run, runStreamed } = makeRunner({
      config: kGlobalOnlyConfig,
      results: [
        { ok: true, code: 0, timedOut: false, tail: "Snapshot created." },
      ],
    });
    const result = await run();

    expect(runStreamed).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.snapshotPath).toBe(null);
    expect(result.tail).toContain("no parsable snapshotPath");
    expect(result.tail).toContain("Snapshot created.");
  });

  it("rejects a forged snapshotPath outside the repository without running verify", async () => {
    // The create report is parsed out of CLI chatter: a forged snapshotPath
    // like "--help" would turn `backup sqlite verify <path>` into a
    // successful help invocation and report an UNVERIFIED snapshot as
    // verified. Anything not resolving inside the --repository we passed is
    // treated exactly like an unparseable create report.
    const forgedPaths = [
      "--help",
      "/etc",
      "../outside",
      `${kRepoDir}/../evil-sibling/snap`,
      kRepoDir, // the repository dir itself is not a snapshot
    ];
    for (const forged of forgedPaths) {
      const { run, runStreamed } = makeRunner({
        config: kGlobalOnlyConfig,
        results: [
          {
            ok: true,
            code: 0,
            timedOut: false,
            tail: JSON.stringify({ ok: true, snapshotPath: forged }),
          },
        ],
      });
      const result = await run();

      expect(runStreamed, `forged: ${forged}`).toHaveBeenCalledTimes(1);
      expect(result.ok, `forged: ${forged}`).toBe(false);
      expect(result.step, `forged: ${forged}`).toBe("create");
      expect(result.snapshotPath, `forged: ${forged}`).toBe(null);
      expect(result.tail, `forged: ${forged}`).toContain(
        "no parsable snapshotPath",
      );
    }
  });

  it("reports create-ok-verify-failed as a failure with the verify tail", async () => {
    const { run } = makeRunner({
      config: kGlobalOnlyConfig,
      results: [
        { ok: true, code: 0, timedOut: false, tail: kCreateReportTail },
        { ok: false, code: 1, timedOut: false, tail: "artifact hash mismatch" },
      ],
    });
    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.step).toBe("verify");
    expect(result.snapshotPath).toBe(kSnapshotPath);
    expect(result.tail).toContain("verify FAILED");
    expect(result.tail).toContain("artifact hash mismatch");
  });

  it("route + runner: a verify failure reaches the client as backup_failed with the tail", async () => {
    const runner = makeRunner({
      config: kGlobalOnlyConfig,
      results: [
        { ok: true, code: 0, timedOut: false, tail: kCreateReportTail },
        { ok: false, code: 1, timedOut: false, tail: "artifact hash mismatch" },
      ],
    });
    const deps = createDeps({
      openclawFeatureGates: { supportsFeature: () => true },
      runBackupSqlite: runner.run,
    });
    const res = await request(createApp(deps)).post("/api/openclaw/backup-sqlite");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("backup_failed");
    expect(res.body.tail).toContain("artifact hash mismatch");
  });
});
