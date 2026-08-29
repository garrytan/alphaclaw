const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createBootPlaceholderHandler,
  createProgressReader,
  escapeHtml,
  kMaxUpdatingWindowMs,
  kPlaceholderAbsoluteMaxMs,
} = require("../../lib/boot-placeholder");

// The placeholder handler is plain (req, res) — no Express, no sockets — so
// fake objects with writeHead/end spies cover the full behavior with an
// injected clock.
const createFakeReq = ({ url = "/", headers = {} } = {}) => ({ url, headers });

const createFakeRes = () => {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res;
};

const parseJsonBody = (res) => JSON.parse(String(res.end.mock.calls[0][0]));

describe("boot-placeholder", () => {
  it("exports a 15 minute stuck-window default", () => {
    expect(kMaxUpdatingWindowMs).toBe(15 * 60 * 1000);
  });

  it("answers /health 200 {status:updating} inside the updating window", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 30_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("flips /health to 503 with the same body once boot exceeds maxUpdatingWindowMs", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 60_001,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("matches /health with a query string", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/health?probe=1" }), res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
    expect(parseJsonBody(res)).toEqual({ status: "updating", gateway: "starting" });
  });

  it("serves browsers a 503 auto-refreshing HTML page with Retry-After", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(
      createFakeReq({
        url: "/",
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": "5",
    });
    const body = String(res.end.mock.calls[0][0]);
    expect(body).toContain('<meta http-equiv="refresh" content="5">');
    expect(body).toContain("AlphaClaw is updating");
  });

  it("serves non-browser clients a 503 JSON body with Retry-After", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => 1_000 + 5_000,
    });
    const res = createFakeRes();

    handler(createFakeReq({ url: "/api/watchdog/status", headers: {} }), res);

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "application/json",
      "Retry-After": "5",
    });
    expect(parseJsonBody(res)).toEqual({
      ok: false,
      error: "AlphaClaw is updating",
      status: "updating",
    });
  });
});

// ---------------------------------------------------------------------------
// Live update-progress rendering
// ---------------------------------------------------------------------------

const kNow = 10_000_000;
const kOpId = "0a1b2c3d-e4f5-6789-abcd-ef0123456789";

const makeRun = (overrides = {}) => ({
  operationId: kOpId,
  target: { channel: "stable", version: "2026.8.1" },
  state: "running",
  startedAt: kNow - 60_000,
  finishedAt: null,
  ok: null,
  steps: [
    { name: "preflight", status: "running", at: kNow - 58_000 },
    { name: "preflight", status: "completed", at: kNow - 55_000 },
    { name: "download", status: "completed", at: kNow - 40_000 },
    { name: "install", status: "running", at: kNow - 30_000 },
  ],
  ...overrides,
});

const makeProgress = (overrides = {}) => ({
  run: makeRun(),
  backup: null,
  gatewayHold: null,
  ...overrides,
});

const renderHtml = (progress, { nowMs = kNow, ...handlerOptions } = {}) => {
  const handler = createBootPlaceholderHandler({
    startedAtMs: nowMs - 1_000,
    maxUpdatingWindowMs: 60_000,
    now: () => nowMs,
    readProgress: () => progress,
    ...handlerOptions,
  });
  const res = createFakeRes();
  handler(createFakeReq({ url: "/", headers: { accept: "text/html" } }), res);
  return String(res.end.mock.calls[0][0]);
};

describe("boot-placeholder progress page", () => {
  it("renders the target line, labeled steps with glyphs, elapsed on the current step, and honest copy", () => {
    const body = renderHtml(makeProgress());

    expect(body).toContain("AlphaClaw is updating");
    expect(body).toContain("Updating to OpenClaw 2026.8.1 (stable)");
    expect(body).toContain("✓ Preflight checks");
    expect(body).toContain("✓ Download");
    expect(body).toContain("▸ Install dependencies");
    // formatElapsed(kNow - 30_000, kNow) on the current (last running) step.
    expect(body).toContain("30s elapsed");
    expect(body).toContain("Large updates can take several minutes");
    expect(body).toContain('<meta http-equiv="refresh" content="5">');
    expect(body).not.toContain("couple of minutes");
  });

  it("labels the boot-time steps and falls back to the raw name for unknown steps", () => {
    const body = renderHtml(
      makeProgress({
        run: makeRun({
          steps: [
            { name: "activate", status: "completed", at: kNow - 20_000 },
            { name: "config-migrate", status: "completed", at: kNow - 15_000 },
            { name: "db-migrate", status: "running", at: kNow - 10_000 },
            { name: "mystery-step", status: "warning", at: kNow - 5_000 },
          ],
        }),
      }),
    );

    expect(body).toContain("Activating new version");
    expect(body).toContain("Migrating settings");
    expect(body).toContain("▸ Migrating databases");
    expect(body).toContain("⚠ mystery-step");
  });

  it("HTML-escapes every interpolated value and never renders step detail/error", () => {
    const body = renderHtml(
      makeProgress({
        run: makeRun({
          target: { channel: "stable", version: "1.0.0<script>alert(1)</script>" },
          steps: [
            {
              name: "<img src=x onerror=alert(1)>",
              status: "running",
              at: kNow - 5_000,
              detail: "SECRET_DETAIL /var/lib/secret/path",
              error: "SECRET_ERROR_TAIL",
            },
          ],
        }),
      }),
    );

    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("SECRET_DETAIL");
    expect(body).not.toContain("/var/lib/secret/path");
    expect(body).not.toContain("SECRET_ERROR_TAIL");
  });

  it("caps interpolated values at 128 characters", () => {
    const body = renderHtml(
      makeProgress({
        run: makeRun({ target: { channel: "stable", version: "x".repeat(300) } }),
      }),
    );

    expect(body).toContain("x".repeat(128));
    expect(body).not.toContain("x".repeat(129));
  });

  it("renders the explicit failure copy for a fresh terminal failure", () => {
    for (const state of ["failed", "activation_failed", "interrupted"]) {
      const body = renderHtml(
        makeProgress({ run: makeRun({ state, finishedAt: kNow - 60_000 }) }),
      );
      expect(body).toContain("The update did not complete");
      expect(body).not.toContain("Install dependencies");
    }
  });

  it("renders the static copy for a terminal run finished over 30 minutes ago", () => {
    const body = renderHtml(
      makeProgress({
        run: makeRun({ state: "activated", finishedAt: kNow - 31 * 60_000 }),
      }),
    );

    expect(body).toContain("couple of minutes");
    expect(body).not.toContain("Install dependencies");
  });

  it("keeps rendering progress for a fresh non-failure terminal run (boot steps still appending)", () => {
    const body = renderHtml(
      makeProgress({
        run: makeRun({ state: "restart_expected", finishedAt: kNow - 60_000 }),
      }),
    );

    expect(body).toContain("Install dependencies");
    expect(body).toContain("Large updates can take several minutes");
  });

  it("renders only the fixed gatewayHold copy — never its reason or blamedKeys", () => {
    const body = renderHtml(
      makeProgress({
        gatewayHold: {
          reason: "config-explosion-secret",
          at: kNow - 10_000,
          operationId: kOpId,
          blamedKeys: ["SECRET_ENV_KEY"],
        },
      }),
    );

    expect(body).toContain("Settings migration needs attention");
    expect(body).not.toContain("config-explosion-secret");
    expect(body).not.toContain("SECRET_ENV_KEY");
    expect(body).not.toContain("Install dependencies");
  });

  it("shows the verified-backup line only when the newest backup is verified", () => {
    const at = Date.UTC(2026, 0, 2, 14, 3, 0);
    const verified = renderHtml(makeProgress({ backup: { at, verified: true, file: "b.tgz" } }));
    expect(verified).toContain("Verified backup taken at 14:03 UTC");
    expect(verified).not.toContain("b.tgz");

    const unverified = renderHtml(makeProgress({ backup: { at, verified: false } }));
    expect(unverified).not.toContain("Verified backup");
  });

  it("adds the stall note when the newest step is older than 5 minutes and the run is not terminal", () => {
    const stalled = renderHtml(
      makeProgress({
        run: makeRun({
          steps: [{ name: "install", status: "running", at: kNow - 6 * 60_000 }],
        }),
      }),
    );
    expect(stalled).toContain("Still working");

    const fresh = renderHtml(makeProgress());
    expect(fresh).not.toContain("Still working");

    const terminal = renderHtml(
      makeProgress({
        run: makeRun({
          state: "restart_expected",
          finishedAt: kNow - 60_000,
          steps: [{ name: "restarting", status: "completed", at: kNow - 10 * 60_000 }],
        }),
      }),
    );
    expect(terminal).not.toContain("Still working");
  });

  it("falls open to the static page when readProgress throws or returns null/garbage", () => {
    const throwing = renderHtml(null, {
      readProgress: () => {
        throw new Error("disk exploded");
      },
    });
    expect(throwing).toContain("couple of minutes");

    expect(renderHtml(null)).toContain("couple of minutes");
    expect(renderHtml({ run: "bogus" })).toContain("couple of minutes");
  });

  it("keeps non-HTML responses pure JSON regardless of progress", () => {
    const handler = createBootPlaceholderHandler({
      startedAtMs: kNow - 1_000,
      maxUpdatingWindowMs: 60_000,
      now: () => kNow,
      readProgress: () => makeProgress(),
    });
    const res = createFakeRes();
    handler(createFakeReq({ url: "/api/status" }), res);

    expect(parseJsonBody(res)).toEqual({
      ok: false,
      error: "AlphaClaw is updating",
      status: "updating",
    });
  });

  it("escapeHtml neutralizes markup metacharacters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

// ---------------------------------------------------------------------------
// Stuck-window semantics with observed progress
// ---------------------------------------------------------------------------

describe("boot-placeholder stuck window with progress", () => {
  it("exports a 60 minute absolute cap default", () => {
    expect(kPlaceholderAbsoluteMaxMs).toBe(60 * 60 * 1000);
  });

  const healthStatus = (handler, req = createFakeReq({ url: "/health" })) => {
    const res = createFakeRes();
    handler(req, res);
    return res.writeHead.mock.calls[0][0];
  };

  it("re-arms the baseline whenever step progress is observed", () => {
    let t = 0;
    let progress = makeProgress();
    const handler = createBootPlaceholderHandler({
      startedAtMs: 0,
      maxUpdatingWindowMs: 60_000,
      absoluteMaxMs: 10_000_000,
      now: () => t,
      readProgress: () => progress,
    });

    t = 30_000;
    expect(healthStatus(handler)).toBe(200);

    // New step event between polls → baseline resets to 70s, so a poll that
    // would otherwise be past the 60s window stays 200.
    progress = makeProgress({
      run: makeRun({
        steps: [...makeRun().steps, { name: "build", status: "running", at: 69_000 }],
      }),
    });
    t = 70_000;
    expect(healthStatus(handler)).toBe(200);

    // No further progress: still inside the re-armed window at 125s...
    t = 125_000;
    expect(healthStatus(handler)).toBe(200);
    // ...and stuck once 60s pass without another observed change.
    t = 131_000;
    expect(healthStatus(handler)).toBe(503);
  });

  it("flips at the baseline window when no progress is observed", () => {
    let t = 0;
    const progress = makeProgress();
    const handler = createBootPlaceholderHandler({
      startedAtMs: 0,
      maxUpdatingWindowMs: 60_000,
      absoluteMaxMs: 10_000_000,
      now: () => t,
      readProgress: () => progress,
    });

    t = 30_000;
    expect(healthStatus(handler)).toBe(200);
    t = 61_000;
    expect(healthStatus(handler)).toBe(503);
  });

  it("flips at the absolute cap even while progress keeps arriving", () => {
    let t = 0;
    let counter = 0;
    const handler = createBootPlaceholderHandler({
      startedAtMs: 0,
      maxUpdatingWindowMs: 60_000,
      absoluteMaxMs: 100_000,
      now: () => t,
      // Every poll observes a brand-new step → the baseline re-arms forever.
      readProgress: () =>
        makeProgress({
          run: makeRun({
            steps: [{ name: `step-${(counter += 1)}`, status: "running", at: t }],
          }),
        }),
    });

    t = 50_000;
    expect(healthStatus(handler)).toBe(200);
    t = 99_000;
    expect(healthStatus(handler)).toBe(200);
    t = 101_000;
    expect(healthStatus(handler)).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Real on-disk progress reader
// ---------------------------------------------------------------------------

describe("createProgressReader", () => {
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-placeholder-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch {}
  });

  const alphaclawDir = () => path.join(rootDir, ".openclaw", ".alphaclaw");
  const statePath = () => path.join(alphaclawDir(), "openclaw-channel-state.json");
  const runPath = (opId) => path.join(alphaclawDir(), "runs", `${opId}.json`);

  const writeFixture = ({ state, runs = {} } = {}) => {
    fs.mkdirSync(path.join(alphaclawDir(), "runs"), { recursive: true });
    if (state !== undefined) {
      fs.writeFileSync(
        statePath(),
        typeof state === "string" ? state : JSON.stringify(state),
      );
    }
    for (const [opId, run] of Object.entries(runs)) {
      fs.writeFileSync(
        runPath(opId),
        typeof run === "string" ? run : JSON.stringify(run),
      );
    }
  };

  const makeState = (overrides = {}) => ({
    lastUpdateRun: { operationId: kOpId, target: { channel: "stable", version: "2026.8.1" } },
    backups: [{ at: kNow - 120_000, file: "backup.tgz", verified: true }],
    gatewayHold: null,
    ...overrides,
  });

  it("resolves the pointed run plus newest backup and gatewayHold", () => {
    writeFixture({ state: makeState(), runs: { [kOpId]: makeRun() } });
    const reader = createProgressReader({ rootDir, now: () => kNow });

    const progress = reader();
    expect(progress.run.operationId).toBe(kOpId);
    expect(progress.run.steps).toHaveLength(4);
    expect(progress.backup.verified).toBe(true);
    expect(progress.gatewayHold).toBeNull();
  });

  it("returns null when either file is garbage JSON (fail-open)", () => {
    writeFixture({ state: "{not json", runs: { [kOpId]: makeRun() } });
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();

    writeFixture({ state: makeState(), runs: { [kOpId]: "]]garbage[[" } });
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();
  });

  it("returns null when the root dir is unset or the files are missing", () => {
    expect(createProgressReader({ rootDir: "" })()).toBeNull();
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();
  });

  it("rejects malformed operation ids before touching the filesystem path", () => {
    writeFixture({
      state: makeState({ lastUpdateRun: { operationId: "../../../etc/passwd" } }),
      runs: { [kOpId]: makeRun() },
    });
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();

    writeFixture({ state: makeState({ lastUpdateRun: { operationId: "abc" } }) });
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();
  });

  it("treats run files over 512KB as unreadable", () => {
    writeFixture({ state: makeState() });
    fs.writeFileSync(runPath(kOpId), `{"pad":"${"x".repeat(513 * 1024)}"}`);
    expect(createProgressReader({ rootDir, now: () => kNow })()).toBeNull();
  });

  it("falls back to the newest runs/*.json by startedAt when there is no pointer", () => {
    const oldId = "aaaaaaaa-0000-0000-0000-000000000000";
    const newId = "bbbbbbbb-0000-0000-0000-000000000000";
    writeFixture({
      state: makeState({ lastUpdateRun: null }),
      runs: {
        [oldId]: makeRun({ operationId: oldId, startedAt: kNow - 500_000 }),
        [newId]: makeRun({ operationId: newId, startedAt: kNow - 60_000 }),
      },
    });

    const progress = createProgressReader({ rootDir, now: () => kNow })();
    expect(progress.run.operationId).toBe(newId);
  });

  it("serves cached data inside the 2s floor and re-reads after it", () => {
    writeFixture({ state: makeState(), runs: { [kOpId]: makeRun() } });
    let t = kNow;
    const reader = createProgressReader({ rootDir, now: () => t });

    const first = reader();
    expect(first.run.steps).toHaveLength(4);

    // New step lands on disk, but within 2s the cached snapshot is served.
    fs.writeFileSync(
      runPath(kOpId),
      JSON.stringify(
        makeRun({ steps: [...makeRun().steps, { name: "build", status: "running", at: t }] }),
      ),
    );
    // Force a distinct mtime even on coarse-grained filesystems.
    fs.utimesSync(runPath(kOpId), new Date(t + 5_000), new Date(t + 5_000));
    t += 1_000;
    expect(reader().run.steps).toHaveLength(4);

    t += 1_001;
    expect(reader().run.steps).toHaveLength(5);
  });
});
