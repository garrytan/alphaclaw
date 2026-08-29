const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const express = require("express");
const request = require("supertest");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");
const {
  createOperationEventsService,
} = require("../../lib/server/operation-events");
const {
  readOpenclawReleaseChannel,
} = require("../../lib/server/alphaclaw-config");

// End-to-end coverage for the OpenClaw release-channel apply flow: the real
// channel-sync service wired into the real routes and the real operation-
// events SSE service, exercised over actual HTTP sockets. Only the npm
// download (installToTempDir) and the process runner are faked.

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kDevSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

// Same fixture shape as tests/server/openclaw-channel-sync.test.js: a
// plausible openclaw npm-package tree with bin, thinking sentinel, extensions.
const writePackageFixture = (
  packageDir,
  {
    version,
    bin = { openclaw: "bin/entry.js" },
    thinking = true,
    extensions = true,
  } = {},
) => {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, ...(bin ? { bin } : {}) }, null, 2)}\n`,
  );
  if (bin) {
    const relative = typeof bin === "string" ? bin : Object.values(bin)[0];
    const binPath = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok');\n");
  }
  if (thinking) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "thinking-levels.js"),
      "exports.listThinkingLevelOptions = () => [];\n",
    );
  }
  if (extensions) {
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
      recursive: true,
    });
  }
  return packageDir;
};

const writeInstallFixture = (installDir, options) =>
  writePackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    options,
  );

const writeCheckoutFixture = (rootDir, { sha, bin = true } = {}) => {
  const checkoutDir = path.join(rootDir, "openclaw");
  fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(checkoutDir, ".git", "HEAD"), `${sha}\n`);
  fs.writeFileSync(
    path.join(checkoutDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "0.0.0-dev", bin: { openclaw: "./bin/entry.js" } }, null, 2)}\n`,
  );
  if (bin) {
    fs.mkdirSync(path.join(checkoutDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(checkoutDir, "bin", "entry.js"),
      "#!/usr/bin/env node\n",
    );
  }
  return checkoutDir;
};

const defaultRunnerImpl = async (opts) => {
  // Faithful model of the real CLI's --output contract (verified against the
  // pinned openclaw 2026.7.1-2 source, dist/backup-create resolveOutputPath):
  // an existing directory (or trailing separator) gets a timestamped archive
  // INSIDE it; any other path IS the archive file, refused if it already
  // exists; the parent is mkdir -p'd. The old stub only modeled the
  // directory branch — which is exactly why issues #7/#9 were invisible.
  if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
    const outIdx = opts.args.indexOf("--output");
    const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
    if (out) {
      try {
        const isDirTarget =
          out.endsWith(path.sep) ||
          (fs.existsSync(out) && fs.statSync(out).isDirectory());
        const outFile = isDirTarget
          ? path.join(out, `${crypto.randomUUID()}-openclaw-backup.tar.gz`)
          : out;
        if (fs.existsSync(outFile)) {
          return {
            ok: false,
            code: 1,
            tail: `Error: Refusing to overwrite existing backup archive: ${outFile}\n`,
            timedOut: false,
          };
        }
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, "stub backup archive\n");
        return {
          ok: true,
          code: 0,
          tail: `Backup archive: ${outFile}\nCreated ${outFile}\nArchive verification: passed\n`,
          timedOut: false,
        };
      } catch (error) {
        // e.g. ENOTDIR when a legacy archive file blocks the parent path.
        return {
          ok: false,
          code: 1,
          tail: `Error: ${error.message}\n`,
          timedOut: false,
        };
      }
    }
    return { ok: true, code: 0, tail: "backup verified\n", timedOut: false };
  }
  if (
    opts.command === "node" &&
    Array.isArray(opts.args) &&
    opts.args[1] === "--version"
  ) {
    let version = "";
    try {
      version =
        JSON.parse(
          fs.readFileSync(
            path.resolve(String(opts.args[0]), "..", "..", "package.json"),
            "utf8",
          ),
        ).version || "";
    } catch {}
    return { ok: true, code: 0, tail: `${version}\n`, timedOut: false };
  }
  return { ok: true, code: 0, tail: "", timedOut: false };
};

const createHarness = ({
  pin = "1.0.0",
  installedVersion = "1.0.0",
  sentinelVersion = "1.0.0",
  runnerImpl = null,
  installFixture = {},
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-apply-e2e-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-apply-e2e-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-apply-e2e-install-");
  if (installedVersion) {
    writeInstallFixture(installDir, { version: installedVersion });
  }

  const nowRef = { now: 1_000_000 };
  const nowFn = () => nowRef.now;
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    nowFn,
    logger: kSilentLogger,
  });
  if (sentinelVersion) {
    store.writeSentinel({ installDir, version: sentinelVersion });
  }

  const runner = {
    runStreamed: vi.fn(
      runnerImpl
        ? (opts) => runnerImpl(opts, defaultRunnerImpl)
        : defaultRunnerImpl,
    ),
  };
  const installToTempDir = vi.fn(async ({ versionSpec }) => {
    const tmpDir = mkTemp("openclaw-fake-prepare-");
    const openclawPackageDir = writePackageFixture(
      path.join(tmpDir, "node_modules", "openclaw"),
      { version: versionSpec, ...installFixture },
    );
    return {
      tmpDir,
      openclawPackageDir,
      cleanup: () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      },
    };
  });

  const notify = vi.fn(async () => {});
  const restartProcess = vi.fn();
  const operationEvents = createOperationEventsService();
  const releases = {
    isKnownVersion: vi.fn(() => true),
    isKnownCommit: vi.fn(() => true),
    getCatalog: vi.fn(async () => ({ ok: true, stable: [], beta: [] })),
    annotateCatalog: vi.fn((catalog) => catalog),
  };

  const sync = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store,
    runStream: runner,
    installToTempDir,
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => readOpenclawReleaseChannel({ openclawDir }),
    releases,
    isOnboarded: () => true,
    restartProcess,
    clearVersionCache: vi.fn(),
    notify,
    operationEvents,
    nowFn,
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
  });

  const app = express();
  app.use(express.json());
  registerOpenclawChannelRoutes({
    app,
    fs,
    OPENCLAW_DIR: openclawDir,
    isOnboarded: () => true,
    openclawChannelService: sync,
    openclawReleasesService: releases,
    operationEvents,
    restartRequiredState: {
      markRequired: vi.fn(),
      getSnapshot: async () => ({ restartRequired: true }),
    },
  });
  // The real operations SSE route from lib/server/routes/agents.js, wired to
  // the SAME operationEvents instance the channel service publishes into.
  app.get("/api/operations/:operationId/events", (req, res) => {
    if (!operationEvents?.subscribe) {
      return res
        .status(503)
        .json({ ok: false, error: "Operation events unavailable" });
    }
    const subscribed = operationEvents.subscribe({
      operationId: req.params.operationId,
      req,
      res,
    });
    if (!subscribed) {
      return res.status(404).json({ ok: false, error: "Operation not found" });
    }
  });

  return {
    app,
    sync,
    store,
    rootDir,
    openclawDir,
    installDir,
    runner,
    installToTempDir,
    notify,
    restartProcess,
    operationEvents,
    releases,
    nowRef,
  };
};

// --- SSE plumbing over a real socket ---------------------------------------

const parseSseFrame = (frame) => {
  let id = null;
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (id == null && dataLines.length === 0) return null;
  let data = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {}
  return { id, event, data };
};

const kServers = [];

const listenApp = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    kServers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });

// Waits until the SSE subscriber is actually registered (the ": connected"
// comment arrives) so no live event can race past between the HTTP 202 and
// the subscription; `done` then resolves with every parsed event once a
// terminal `done`/`error` event arrives.
const openSseCollector = async ({ port, eventsPath }) =>
  new Promise((resolve, reject) => {
    const events = [];
    const done = new Promise((resolveDone) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: eventsPath },
        (res) => {
          let buffer = "";
          let connected = false;
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            if (!connected && buffer.includes(": connected\n\n")) {
              connected = true;
              resolve({ events, done });
            }
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const parsed = parseSseFrame(frame);
              if (!parsed) continue;
              events.push(parsed);
              if (parsed.event === "done" || parsed.event === "error") {
                res.destroy();
                resolveDone(events);
                return;
              }
            }
          });
          res.on("end", () => resolveDone(events));
        },
      );
      req.on("error", reject);
    });
  });

const firstIndexOfStep = (events, name) =>
  events.findIndex(
    (entry) => entry.event === "step" && entry.data?.name === name,
  );

describe("server/openclaw-channel apply flow (e2e)", { retry: 1 }, () => {
  afterEach(async () => {
    vi.useRealTimers();
    for (const server of kServers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("runs the full stable→beta happy path over HTTP with live SSE progress", async () => {
    const backupGate = deferred();
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          await backupGate.promise;
          return { ok: true, code: 0, tail: "", timedOut: false };
        }
        return fallback(opts);
      },
    });
    const { app, sync, store, restartProcess } = harness;
    expect(sync.syncAtBoot().ok).toBe(true);

    // Channel selection first, like the Upgrade page does.
    const channelRes = await request(app)
      .put("/api/alphaclaw/config/updates/openclaw-release-channel")
      .send({ releaseChannel: "beta" });
    expect(channelRes.status).toBe(200);
    expect(channelRes.body.ok).toBe(true);
    expect(channelRes.body.changed).toBe(true);
    expect(sync.getChannelInfo().releaseChannel).toBe("beta");

    const { port } = await listenApp(app);
    const applyRes = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(applyRes.status).toBe(202);
    expect(applyRes.body.ok).toBe(true);
    expect(typeof applyRes.body.operationId).toBe("string");
    expect(applyRes.body.events).toBe(
      `/api/operations/${applyRes.body.operationId}/events`,
    );
    expect(sync.isApplyInProgress()).toBe(true);

    // Subscribe over a real socket, then unblock the backup step. Fake ONLY
    // setTimeout so the 1.5s restart timer becomes controllable while socket
    // I/O keeps flowing.
    const collector = await openSseCollector({
      port,
      eventsPath: applyRes.body.events,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    backupGate.resolve();
    const events = await collector.done;

    const doneEvent = events[events.length - 1];
    expect(doneEvent.event).toBe("done");
    expect(doneEvent.data).toEqual(
      expect.objectContaining({
        ok: true,
        restarting: true,
        target: expect.objectContaining({ channel: "beta", version: "1.1.0" }),
      }),
    );
    const stepOrder = [
      "preflight",
      "backup",
      "download",
      "verify",
      "record",
      "restarting",
    ].map((name) => firstIndexOfStep(events, name));
    for (const index of stepOrder) expect(index).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < stepOrder.length; i += 1) {
      expect(stepOrder[i]).toBeGreaterThan(stepOrder[i - 1]);
    }

    // On-disk contract: overlay + completion file, pin snapshot, applied state.
    expect(store.hasOverlay("1.1.0")).toBe(true);
    expect(
      fs.existsSync(path.join(store.overlayDir("1.1.0"), ".overlay-complete.json")),
    ).toBe(true);
    expect(store.hasOverlay("1.0.0")).toBe(true);
    const state = store.readState();
    expect(state.applied).toEqual(
      expect.objectContaining({
        channel: "beta",
        version: "1.1.0",
        acceptedAt: null,
      }),
    );
    // Held until the process restart lands — see the latch-window fix.
    expect(sync.isApplyInProgress()).toBe(true);

    expect(restartProcess).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(restartProcess).toHaveBeenCalledTimes(1);
  });

  it("blocks a downgrade when the backup fails, with the full error envelope", async () => {
    const harness = createHarness({
      pin: "1.2.0",
      installedVersion: "1.2.0",
      sentinelVersion: "1.2.0",
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          return { ok: false, code: 1, tail: "disk full", timedOut: false };
        }
        return fallback(opts);
      },
    });

    const res = await request(harness.app)
      .post("/api/openclaw/apply")
      .send({ channel: "stable", version: "1.1.0" });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("backup_failed");
    expect(res.body.message).toMatch(/backup/i);
    expect(typeof res.body.hint).toBe("string");
    expect(res.body.hint.length).toBeGreaterThan(0);
    expect(harness.store.readState().applied).toBeNull();
    expect(harness.store.hasOverlay("1.1.0")).toBe(false);
    expect(harness.installToTempDir).not.toHaveBeenCalled();
  });

  it("rejects artifacts that fail verification and records the failed operation", async () => {
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      installFixture: { thinking: false },
    });

    const res = await request(harness.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("verify_failed");
    expect(harness.store.hasOverlay("1.1.0")).toBe(false);
    expect(harness.store.readState().applied).toBeNull();
    const operation = harness.operationEvents.getOperation(
      res.body.operationId,
    );
    expect(operation).not.toBeNull();
    expect(operation.status).toBe("failed");
    expect(
      operation.events.some(
        (entry) =>
          entry.event === "error" && /verify|missing internals/i.test(String(entry.data?.error)),
      ),
    ).toBe(true);
  });

  it("rejects concurrent applies and gates the legacy self-update route", async () => {
    const backupGate = deferred();
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          await backupGate.promise;
          return { ok: true, code: 0, tail: "", timedOut: false };
        }
        return fallback(opts);
      },
    });
    const { app, sync } = harness;

    // The system-route guard from lib/server/routes/system.js
    // POST /api/alphaclaw/update, replicated over the same live service.
    const guardApp = express();
    guardApp.use(express.json());
    guardApp.post("/api/alphaclaw/update", (req, res) => {
      if (sync?.isApplyInProgress?.()) {
        return res.status(409).json({
          ok: false,
          error:
            "An OpenClaw version change is in progress — retry after it finishes.",
        });
      }
      res.json({ ok: true });
    });

    const firstRes = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(firstRes.status).toBe(202);
    expect(sync.isApplyInProgress()).toBe(true);

    const secondRes = await request(app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0" });
    expect(secondRes.status).toBe(409);
    expect(secondRes.body.code).toBe("operation_in_progress");

    const guardedRes = await request(guardApp).post("/api/alphaclaw/update");
    expect(guardedRes.status).toBe(409);
    expect(guardedRes.body.error).toMatch(/version change is in progress/);

    backupGate.resolve();
    await waitFor(
      () => harness.store.readState().lastUpdateRun?.finishedAt != null,
    );
    expect(harness.store.readState().applied).toEqual(
      expect.objectContaining({ channel: "beta", version: "1.1.0" }),
    );
    expect(harness.store.readState().lastUpdateRun.ok).toBe(true);

    // The latch stays HELD after a restarting success — the process restart
    // is imminent, so the legacy self-update route stays gated too instead of
    // starting an install the restart would kill.
    expect(sync.isApplyInProgress()).toBe(true);
    const releasedRes = await request(guardApp).post("/api/alphaclaw/update");
    expect(releasedRes.status).toBe(409);
  });

  it("streams multi-MB dev-build output over SSE and records the checkout sha", async () => {
    const updateGate = deferred();
    const bigChunk = "x".repeat(64 * 1024);
    const chunkCount = 50; // 3.2MB total, > 3MB
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "update") {
          await updateGate.promise;
          for (let i = 0; i < chunkCount; i += 1) {
            opts.onOutput?.(bigChunk, "stdout");
          }
          return {
            ok: true,
            code: 0,
            tail: 'noise before\n{"status":"ok"}\nnoise after',
            timedOut: false,
          };
        }
        return fallback(opts);
      },
    });
    writeCheckoutFixture(harness.rootDir, { sha: kDevSha });

    const { port } = await listenApp(harness.app);
    const applyRes = await request(harness.app)
      .post("/api/openclaw/apply")
      .send({ channel: "dev", devHead: true });
    expect(applyRes.status).toBe(202);
    expect(typeof applyRes.body.operationId).toBe("string");

    const collector = await openSseCollector({
      port,
      eventsPath: `/api/operations/${applyRes.body.operationId}/events`,
    });
    updateGate.resolve();
    const events = await collector.done;

    const outputs = events.filter((entry) => entry.event === "output");
    // Output is coalesced server-side (~250ms flushes, rolling tail) so the
    // event COUNT is small, but streamed content must reach the client and
    // land before the terminal event.
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    for (const entry of outputs) {
      expect(typeof entry.data.chunk).toBe("string");
      expect(entry.data.chunk.length).toBeLessThanOrEqual(4000);
      expect(entry.data.chunk).toContain("x");
    }
    expect(events[events.length - 1].event).toBe("done");
    expect(harness.store.readState().applied).toEqual(
      expect.objectContaining({ channel: "dev", sha: kDevSha }),
    );

    // Updater-reported failure: 409, nothing recorded, no restart.
    const failing = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "update") {
          return { ok: true, code: 0, tail: '{"status":"error"}', timedOut: false };
        }
        return fallback(opts);
      },
    });
    writeCheckoutFixture(failing.rootDir, { sha: kDevSha });

    const failureRes = await request(failing.app)
      .post("/api/openclaw/apply")
      .send({ channel: "dev", devHead: true });
    expect(failureRes.status).toBe(409);
    expect(failureRes.body.code).toBe("dev_build_failed");
    expect(failing.store.readState().applied).toBeNull();
    expect(failing.restartProcess).not.toHaveBeenCalled();
  });
});
