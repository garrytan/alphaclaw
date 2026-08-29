const crypto = require("crypto");
const fs = require("fs");
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

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

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
    `${JSON.stringify({ name: "openclaw", version, bin: { openclaw: "bin/entry.js" } }, null, 2)}\n`,
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
  return { ok: true, code: 0, tail: "backup ok\n", timedOut: false };
};

const createJourney = ({ runnerImpl = null, installFixture = {} } = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-journey-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
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
  const restartProcess = vi.fn();

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
    return { sync, store, app, installToTempDir, runner };
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
    restartProcess,
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
      .send({ channel: "beta", version: kBetaVersion });
    expect([200, 202]).toContain(applied.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    const { operationId } = p1.sync.getChannelInfo().lastUpdateRun;
    expect(operationId).toBeTruthy();

    // Durable run record: restart_expected, with the backup artifact noted.
    const recordAfterApply = journey.readLedger().readRun(operationId);
    expect(recordAfterApply.state).toBe("restart_expected");
    expect(recordAfterApply.backup).toEqual(
      expect.objectContaining({
        verified: true,
        noBackup: false,
        // The exact per-run archive path is recorded (#7/#9 fix).
        file: expect.stringMatching(/openclaw-backup.*\.tar\.gz$/),
      }),
    );
    expect(fs.statSync(recordAfterApply.backup.file).size).toBeGreaterThan(0);

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
    // The run resolved to activated — not "interrupted".
    expect(journey.readLedger().readRun(operationId).state).toBe("activated");

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

  it("two consecutive hard-gated applies leave two distinct archives (issue #7 regression)", async () => {
    const journey = createJourney();
    const backupsDir = path.join(journey.rootDir, "backups", "openclaw");
    const archiveNames = () =>
      fs
        .readdirSync(backupsDir)
        .filter((name) => /openclaw-backup.*\.tar\.gz$/.test(name));

    // ── Process 1: first prerelease apply (hard backup gate). ───────────────
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);
    const first = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion });
    expect([200, 202]).toContain(first.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    expect(archiveNames()).toHaveLength(1);

    // ── Process 2: activation restart, then a SECOND prerelease apply over
    // the same disk. The pre-fix code reused one fixed archive path, so this
    // apply failed forever with "Refusing to overwrite existing backup
    // archive" (#7). Unique per-run paths make it just work. ─────────────────
    journey.nowRef.now += 5_000;
    const p2 = journey.bootInstance({ withHttp: true });
    expect(p2.sync.syncAtBoot().action).toBe("activated");
    const second = await request(p2.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: "1.1.0-beta.2" });
    expect([200, 202]).toContain(second.status);
    await waitFor(() => {
      const run = p2.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null && run.ok === true;
    });
    expect(archiveNames()).toHaveLength(2);
  });

  it("failure variant: a failed verify records a failed run, notifies, and keeps the log", async () => {
    const journey = createJourney({ installFixture: { thinking: false } });
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);

    const applied = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion });
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
      .send({ channel: "beta", version: kBetaVersion });
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
      .send({ channel: "beta", version: kBetaVersion });
    expect(reapply.status).toBe(409);
    expect(reapply.body.code).toBe("version_blocklisted");
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");
  });

  it("hard backup gate: a prerelease apply with a failing backup installs nothing", async () => {
    const journey = createJourney({
      runnerImpl: async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          return { ok: false, code: 1, tail: "backup exploded", timedOut: false };
        }
        return fallback(opts);
      },
    });
    const p1 = journey.bootInstance({ withHttp: true });
    expect(p1.sync.syncAtBoot().ok).toBe(true);

    const applied = await request(p1.app)
      .post("/api/openclaw/apply")
      .send({ channel: "beta", version: kBetaVersion });
    expect([202, 409]).toContain(applied.status);
    await waitFor(() => {
      const run = p1.sync.getChannelInfo().lastUpdateRun;
      return run && run.finishedAt != null;
    });

    const { operationId } = p1.sync.getChannelInfo().lastUpdateRun;
    const record = journey.readLedger().readRun(operationId);
    expect(record.state).toBe("failed");
    expect(record.result.code).toBe("backup_failed");
    // The download never ran: the gate fires before install.
    expect(p1.installToTempDir).not.toHaveBeenCalled();
    expect(installedVersionAt(journey.installDir)).toBe("1.0.0");
  });
});
