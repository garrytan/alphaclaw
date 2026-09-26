const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");

const express = require("express");
const request = require("supertest");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");
const {
  createOperationEventsService,
} = require("../../lib/server/operation-events");
const {
  readOpenclawReleaseChannel,
} = require("../../lib/server/alphaclaw-config");

// FULL-JOURNEY e2e: the exact operator story, end to end, with no mocked
// seams between the stages —
//
//   boot on stable pin ─▶ switch channel to beta (HTTP) ─▶ apply a beta
//   (HTTP) ─▶ durable run record + log exist ─▶ RESTART (fresh process
//   simulated by fresh service instances over the same disk) ─▶ boot
//   re-activates the beta ─▶ status reports beta ─▶ SECOND restart stays on
//   beta (already_active) ─▶ notification envelopes were emitted ─▶ the run
//   log is still readable over HTTP after both restarts.
//
// Only the npm download and child-process runner are faked (same policy as
// the apply e2e); every state transition runs the real code over real files.

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kBetaVersion = "1.1.0-beta.1";

const roots = [];
const mkTemp = (prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const writePackageFixture = (
  packageDir,
  { version, thinking = true, extensions = true } = {},
) => {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" }, openclaw: { schemaVersions: { state: 17, agent: 21 } } }, null, 2)}\n`,
  );
  const binPath = path.join(packageDir, "bin", "entry.js");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok');\n");
  if (thinking) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "thinking-levels.js"),
      "exports.listThinkingLevelOptions = () => [];\n",
    );
  }
  if (extensions) {
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"), { recursive: true });
  }
  return packageDir;
};

const defaultRunnerImpl = async (opts) => {
  if (["gzip", "tar"].includes(opts.command) || opts.args?.includes("backup") || opts.args?.includes("preflight")) throw new Error("Unexpected archive producer or copying CLI probe");
  if (opts.command === "node" && opts.args?.[1] === "--version") {
    let version = "";
    try {
      version = JSON.parse(
        fs.readFileSync(
          path.resolve(String(opts.args[0]), "..", "..", "package.json"),
          "utf8",
        ),
      ).version;
    } catch {}
    return { ok: true, code: 0, tail: `${version}\n`, timedOut: false };
  }
  return { ok: true, code: 0, tail: "{}\n", timedOut: false };
};

const createJourney = ({ runnerImpl = null, installFixture = {} } = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-journey-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}");
  const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
  db.exec("PRAGMA user_version=17; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES('primary','global',17,NULL)");
  db.close();
  const packageRoot = mkTemp("alphaclaw-journey-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: "1.0.0" } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-journey-install-");
  writePackageFixture(path.join(installDir, "node_modules", "openclaw"), {
    version: "1.0.0",
  });

  const nowRef = { now: 1_000_000 };
  const notifications = [];
  const notify = vi.fn(async (message, opts) => {
    notifications.push({ message, opts });
    return { ok: true };
  });

  // Each "process instance" gets a fresh store + sync over the SAME disk —
  // exactly what a container restart does.
  const bootInstance = ({ withHttp = false } = {}) => {
    const store = createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir,
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
    });
    const runner = {
      runStreamed: vi.fn(
        runnerImpl ? (opts) => runnerImpl(opts, defaultRunnerImpl) : defaultRunnerImpl,
      ),
    };
    const installToTempDir = vi.fn(async ({ versionSpec, onOutput }) => {
      // The streamed npm output must land in the durable log.
      onOutput?.(`npm install output for ${versionSpec}\n`);
      const tmpDir = mkTemp("openclaw-journey-prepare-");
      return {
        tmpDir,
        openclawPackageDir: writePackageFixture(
          path.join(tmpDir, "node_modules", "openclaw"),
          { version: versionSpec, ...installFixture },
        ),
        cleanup: () => {},
      };
    });
    const operationEvents = createOperationEventsService();
    const releases = {
      isKnownVersion: () => true,
      isKnownCommit: () => true,
      getCatalog: async () => ({ ok: true, stable: [], beta: [] }),
      annotateCatalog: (catalog) => catalog,
    };
    const lock = createGatewayLifecycleLock();
    let sync;
    let running = true;
    const gatewayQuiesce = {
      isRunning: vi.fn(async () => running), suppress: vi.fn(), unsuppress: vi.fn(),
      stop: vi.fn(async () => { running = false; return true; }),
      start: vi.fn(async () => { running = true; }),
    };
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => sync.getChannelInfo(), isApplyInProgress: () => sync.isApplyInProgress() });
    sync = createOpenclawChannelSync({
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
      gatewayQuiesce,
      acquireLifecycleLock: lock.acquire,
      gatewayMutationPolicy: policy,
      dbQuiet: async () => ({ release() {} }),
      dbResume: (quiet) => quiet.release(),
      openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: openclawDir }),
      diskSpace: () => ({ ok: true, free: 100e9 }),
      clearVersionCache: () => {},
      notify,
      operationEvents,
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
      backupsDir: path.join(rootDir, "backups", "openclaw"),
    });
    let app = null;
    if (withHttp) {
      app = express();
      app.use(express.json());
      registerOpenclawChannelRoutes({
        app,
        fs,
        OPENCLAW_DIR: openclawDir,
        isOnboarded: () => true,
        openclawChannelService: sync,
        openclawReleasesService: releases,
        operationEvents,
        restartRequiredState: { markRequired: vi.fn(), getSnapshot: async () => ({}) },
      });
    }
    return { sync, store, app, installToTempDir, runner, gatewayQuiesce, lock };
  };

  const readLedger = () =>
    createRunLedger({
      openclawDir,
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
    });

  return {
    rootDir,
    openclawDir,
    installDir,
    nowRef,
    notify,
    notifications,
    bootInstance,
    readLedger,
  };
};

const installedVersionAt = (installDir) =>
  JSON.parse(
    fs.readFileSync(
      path.join(installDir, "node_modules", "openclaw", "package.json"),
      "utf8",
    ),
  ).version;

describe("FULL JOURNEY: stable → beta → restart → stays beta", () => {
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });
  it("switches, applies, logs durably, re-activates at boot, and survives a second restart", async () => {
    const journey = createJourney();

    // ── Process 1: normal server boot on the stable pin ────────────────────
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);
    expect(p1.sync.getChannelInfo().releaseChannel).toBe("stable");

    // Switch the channel over HTTP — a pure preference, no restart flag.
    const switched = await request(p1.app)
      .put("/api/alphaclaw/config/updates/openclaw-release-channel")
      .send({ releaseChannel: "beta" });
    expect(switched.status).toBe(200);
    expect(switched.body.restartRequired).toBe(false);
    expect(p1.sync.getChannelInfo().releaseChannel).toBe("beta");

    // Apply the beta over HTTP.
    const applied = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    expect([200, 202]).toContain(applied.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    const { operationId } = p1.sync.getChannelInfo().lastUpdateRun;
    expect(operationId).toBeTruthy();

    const recordAfterApply = journey.readLedger().readRun(operationId);
    expect(recordAfterApply.state).toBe("restart_expected");
    expect(recordAfterApply.backup).toBeNull();
    expect(recordAfterApply.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, restore: { configAvailable: true, databaseSetAvailable: false } });
    expect(fs.statSync(recordAfterApply.recovery.checkpoint.file).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(recordAfterApply.recovery.checkpoint.file, "payload", "state", "openclaw.sqlite"))).toBe(false);
    expect(p1.gatewayQuiesce.stop).toHaveBeenCalledTimes(1);
    expect(p1.gatewayQuiesce.start).not.toHaveBeenCalled();

    // Durable log: step transitions AND the streamed npm output, readable
    // over HTTP by validated operationId.
    const logRes = await request(p1.app).get(
      `/api/openclaw/runs/${operationId}/log`,
    );
    expect(logRes.status).toBe(200);
    expect(logRes.text).toContain("step preflight: completed");
    expect(logRes.text).toContain(`npm install output for ${kBetaVersion}`);
    expect(logRes.text).toContain("step restarting: running");

    // Runs API lists it.
    const runsRes = await request(p1.app).get("/api/openclaw/runs");
    expect(runsRes.body.runs[0]).toEqual(
      expect.objectContaining({ operationId, state: "restart_expected" }),
    );

    // ── Process 2: the activation restart ──────────────────────────────────
    journey.nowRef.now += 5_000;
    const p2 = journey.bootInstance();
    const boot2 = p2.sync.syncAtBoot();
    expect(boot2.ok).toBe(true);
    expect(boot2.action).toBe("activated");
    expect(installedVersionAt(journey.installDir)).toBe(kBetaVersion);
    expect(p2.sync.getChannelInfo()).toEqual(
      expect.objectContaining({
        releaseChannel: "beta",
        installedVersion: kBetaVersion,
      }),
    );
    // Issue #20 ordering fix: syncAtBoot no longer stamps the run activated —
    // the server-phase reconciler resolves it AFTER the settings migration,
    // so a failed migration can never hide behind a clean-looking activation.
    expect(journey.readLedger().readRun(operationId).state).toBe(
      "restart_expected",
    );
    const reconcile = await p2.sync.reconcileBootConfig();
    expect(["ok", "skipped"]).toContain(reconcile.status);
    // The run resolved to activated — not "interrupted" — and carries the
    // boot-phase step the placeholder/Upgrade page render.
    const resolvedRun = journey.readLedger().readRun(operationId);
    expect(resolvedRun.state).toBe("activated");
    expect(resolvedRun.steps.map((step) => step.name)).toContain("activate");

    // ── Process 3: a second restart must STAY on beta ───────────────────────
    journey.nowRef.now += 5_000;
    const p3 = journey.bootInstance();
    const boot3 = p3.sync.syncAtBoot();
    expect(boot3.ok).toBe(true);
    expect(boot3.action).toBe("already_active");
    expect(installedVersionAt(journey.installDir)).toBe(kBetaVersion);
    expect(journey.readLedger().readRun(operationId).state).toBe("activated");

    // The log is STILL readable after both restarts (process 1's app reads
    // the same durable files a fresh instance would).
    const logAfterRestarts = await request(p1.app).get(
      `/api/openclaw/runs/${operationId}/log`,
    );
    expect(logAfterRestarts.status).toBe(200);
    expect(logAfterRestarts.text).toContain("apply " + operationId);

    // ── Notification envelopes across the lifecycle ─────────────────────────
    const ids = journey.notifications.map((n) => n.opts?.id).filter(Boolean);
    expect(ids).toContain(`apply-start-${operationId}`);
    expect(ids).toContain(`apply-restarting-${operationId}`);
    expect(
      journey.notifications.every(
        (n) => !n.opts?.id || !n.opts.id.startsWith("apply-failed-"),
      ),
    ).toBe(true);
  });

  it("two consecutive applies leave two distinct verified checkpoints (issue #7 regression)", async () => {
    const journey = createJourney();
    const backupsDir = path.join(journey.rootDir, "backups", "openclaw");
    const checkpointNames = () =>
      fs
        .readdirSync(backupsDir)
        .filter((name) => /^recovery-/.test(name));

    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);
    const first = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    expect([200, 202]).toContain(first.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    expect(checkpointNames()).toHaveLength(1);

    journey.nowRef.now += 5_000;
    const p2 = journey.bootInstance({ withHttp: true });
    expect(p2.sync.syncAtBoot().action).toBe("activated");
    expect(["ok", "skipped"]).toContain((await p2.sync.reconcileBootConfig()).status);
    const second = await request(p2.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0-beta.2", intent: "update" });
    expect([200, 202]).toContain(second.status);
    await waitFor(() => {
      const run = p2.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    expect(checkpointNames()).toHaveLength(2);
    for (const name of checkpointNames()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(backupsDir, name, "manifest.json")));
      expect(manifest.kind).toBe("config_only");
      expect(manifest.databases).toEqual([]);
    }
  });

  it("failure variant: a failed verify records a failed run, notifies, and keeps the log", async () => {
    const journey = createJourney({ installFixture: { thinking: false } });
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);

    const applied = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    expect([202, 409]).toContain(applied.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null;
    });
    const { operationId } = p1.sync.getChannelInfo().lastUpdateRun;

    const record = journey.readLedger().readRun(operationId);
    expect(record.state).toBe("failed");
    expect(record.ok).toBe(false);
    expect(record.result.code).toBeTruthy();

    // The one message the admin most needs: the failure envelope.
    const failure = journey.notifications.find(
      (n) => n.opts?.id === `apply-failed-${operationId}`,
    );
    expect(failure).toBeTruthy();
    expect(failure.opts.eventType).toBe("upgrade_failed");
    expect(failure.message).toContain("failed");

    // Nothing activated: still stable at the next boot.
    const p2 = journey.bootInstance();
    expect(p2.sync.syncAtBoot().ok).toBe(true);
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");

    const logRes = await request(p1.app).get(
      `/api/openclaw/runs/${operationId}/log`,
    );
    expect(logRes.status).toBe(200);
    expect(logRes.text).toContain("ok=false");
  });

  it("rollback journey: activated beta crash-loops → marker → boot rolls back → blocklisted → notified", async () => {
    const journey = createJourney();

    // Apply + activate the beta (condensed from the happy path above).
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);
    await request(p1.app)
      .put("/api/alphaclaw/config/updates/openclaw-release-channel")
      .send({ releaseChannel: "beta" });
    await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    journey.nowRef.now += 5_000;
    const p2 = journey.bootInstance();
    expect(p2.sync.syncAtBoot().action).toBe("activated");
    expect(installedVersionAt(journey.installDir)).toBe(kBetaVersion);

    // The watchdog detects a crash loop on the fresh build and requests a
    // channel rollback — marker written, build blocklisted immediately.
    const rollback = p2.sync.requestChannelRollback({
      reason: "crash_loop",
      exitCode: 1,
    });
    expect(rollback.ok).toBe(true);
    expect(
      p2.sync
        .getChannelInfo()
        .blocklist.some((entry) => entry.id === kBetaVersion),
    ).toBe(true);

    // The rollback restart: boot consumes the marker and lands on a safe
    // version (the pin — no last-known-good beta overlay exists yet).
    journey.nowRef.now += 5_000;
    const p3 = journey.bootInstance();
    const boot3 = p3.sync.syncAtBoot();
    expect(boot3.ok).toBe(true);
    expect(boot3.action).toBe("rollback");
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");
    const info = p3.sync.getChannelInfo();
    expect(info.installedVersion).toBe("1.0.0");
    expect(info.blocklist.some((entry) => entry.id === kBetaVersion)).toBe(true);

    // A FOURTH boot stays put: marker consumed, no rollback loop.
    journey.nowRef.now += 5_000;
    const p4 = journey.bootInstance();
    expect(["already_active", "none"]).toContain(p4.sync.syncAtBoot().action);
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");

    // The admin heard about it: a rollback notification was emitted.
    // (queueNotify delivers on a microtask — yield once before asserting.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      journey.notifications.some((n) => /rolled back/i.test(n.message)),
    ).toBe(true);

    // The blocklisted beta cannot be re-applied without an explicit clear.
    // (A fresh instance: p1's apply latch is intentionally still held after
    // its restarting success — the real process would have died.)
    journey.nowRef.now += 5_000;
    const p5 = journey.bootInstance({ withHttp: true });
    expect(p5.sync.syncAtBoot().ok).toBe(true);
    const reapply = await request(p5.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    expect(reapply.status).toBe(409);
    expect(reapply.body.code).toBe("version_blocklisted");
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");
  });

  it("checkpoint safety gate: a prerelease apply with an unsupported config activates nothing", async () => {
    const journey = createJourney();
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);
    fs.writeFileSync(path.join(journey.openclawDir, "openclaw.json"), '{"$include":"outside.json"}');

    const applied = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion, intent: "update" });
    expect([202, 409]).toContain(applied.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null;
    });

    const { operationId } = p1.sync.getChannelInfo().lastUpdateRun;
    const record = journey.readLedger().readRun(operationId);
    expect(record.state).toBe("failed");
    expect(record.result.code).toBe("RECOVERY_INVENTORY_UNSUPPORTED");
    expect(record.recovery).toBeUndefined();
    expect(p1.gatewayQuiesce.stop).not.toHaveBeenCalled();
    expect(p1.store.readState().applied).toBeNull();
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");
  });
});
