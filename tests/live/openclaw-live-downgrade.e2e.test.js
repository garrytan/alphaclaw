// LIVE TIER — the issue #54 downgrade itself, for real: 2026.9.1-beta.1
// (installed, its state DB written by that beta, the legacy-audit lease
// engaged) → 2026.8.2 through the live apply harness with the HARD GATE:
//   backup step: the REAL beta CLI's `backup create --verify` with the gateway
//     paused (quiesce double) → verified artifact, usableCheck manifest_ok
//   db-preflight: the REAL 2026.8.2 binary's `database preflight` against a
//     VACUUM INTO snapshot of the beta-written DB → "migration-required"
//     (the beta's schema 12 is OLDER than 2026.8.2's 15 — verified live)
//   download/verify/record → restart requested → the next boot ACTIVATES
//     2026.8.2 with zero network → the activated binary runs → and the
//     activated 2026.8.2 gateway boots the beta-written state to /healthz.
// Plus the reverse direction's fail-closed gate: a 2026.8.2-written DB is
// `incompatible` for the beta, so applying the beta stops at db-preflight
// with 409 db_preflight_failed AFTER a verified backup and BEFORE anything
// changed.
//
// Not faked: the backup, the preflight, the download (real npm install of
// 2026.8.2), the activation, the gateway. Faked: restartProcess (spied) and
// the gateway quiesce (a recorder; production stops the managed child).
//
// Requires: network, a supported Node. Runtime: ~3-6 min.

const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-downgrade-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const request = require("supertest");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const {
  createOpenclawReleasesService,
} = require("../../lib/server/openclaw-releases");
const {
  registerOpenclawChannelRoutes,
} = require("../../lib/server/routes/openclaw-channel");
const {
  createOperationEventsService,
} = require("../../lib/server/operation-events");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const {
  readOpenclawReleaseChannel,
} = require("../../lib/server/alphaclaw-config");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const {
  buildCliEnv,
  writeLegacyAuditLog,
  writeOpenclawShim,
  createQuiesceFake,
  readRunBackupRecord,
} = require("./live-backup-harness");
const {
  assertFreeDiskBytes,
  kLiveEnabled,
  kOpenclawLines,
  kSilentLogger,
  mkTemp,
  resolvePackageBin,
  stageOpenclawVersion,
  stageTempInstall,
  waitFor,
} = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

// Disk footprint per harness: the installed line's overlay + activated copy
// (~0.7 GB each) plus the real `npm install` of the target and ITS overlay —
// two harnesses per file. Every root is a tracked temp dir (swept in
// afterAll, see live-helpers); the version cache outlives the run on purpose.
const kInstallTimeoutMs = 8 * 60 * 1000;
const kApplySettleTimeoutMs = kInstallTimeoutMs + 2 * 60 * 1000;
const kTestTimeoutMs = 14 * 60 * 1000;
const kGatewayHealthTimeoutMs = 120_000;

// The state DB the INSTALLED CLI actually wrote: `approvals get --json`
// materializes the real schema for that line (74 tables/user_version 1 on
// the pin, 104/15 on 2026.8.2, 108/12 on the beta — probed live).
const materializeStateDir = ({ bin, homeDir, stateDir }) => {
  fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  fs.writeFileSync(
    path.join(stateDir, "agents", "main", "sessions", "0001-seed.jsonl"),
    '{"role":"user","seq":1}\n',
  );
  execFileSync(process.execPath, [bin, "approvals", "get", "--json"], {
    env: buildCliEnv({ homeDir, stateDir }),
    stdio: "pipe",
    timeout: 120_000,
  });
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error(`${bin} did not materialize ${dbPath}`);
  writeLegacyAuditLog(stateDir);
  return dbPath;
};

const readUserVersion = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version);
  } finally {
    db.close();
  }
};

// A box whose INSTALLED OpenClaw is a real staged version (activated through
// the overlay store exactly as boot does) with a state dir that version
// wrote, wired like tests/live/openclaw-live-apply.e2e.test.js but with the
// real backup CLI on PATH and a quiesce double.
const createDowngradeHarness = ({ installed }) => {
  const rootDir = mkTemp("alphaclaw-live-downgrade-e2e-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-live-downgrade-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@live/alphaclaw", dependencies: { openclaw: kOpenclawLines.pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-live-downgrade-install-");
  fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true });

  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    logger: kSilentLogger,
  });
  const saved = store.saveOverlayFromTempInstall({
    openclawPackageDir: installed.packageDir,
    version: installed.version,
  });
  if (!saved.ok) throw new Error(`overlay save failed: ${saved.error}`);
  const activated = store.activateOverlay({ installDir, version: installed.version });
  if (!activated.ok) throw new Error(`activation failed: ${activated.error}`);
  store.updateState((s) => {
    s.pinVersion = kOpenclawLines.pin;
    // The box is ON this version (applied earlier, accepted): the shape the
    // #54 box had before the downgrade was requested.
    s.applied = {
      channel: installed.channel,
      version: installed.version,
      at: Date.now() - 60 * 60 * 1000,
      acceptedAt: Date.now() - 30 * 60 * 1000,
    };
    return s;
  });
  const installedBin = store.resolvePackageBin(
    path.join(installDir, "node_modules", "openclaw"),
  );
  expect(installedBin).toBeTruthy();
  const stateDbPath = materializeStateDir({ bin: installedBin, homeDir: rootDir, stateDir: openclawDir });

  // The backup CLI IS the installed one, resolved through PATH like production.
  const shimDir = writeOpenclawShim(installedBin);
  const cliEnv = buildCliEnv({ homeDir: rootDir, stateDir: openclawDir, pathPrefix: shimDir });

  const releases = createOpenclawReleasesService({
    cacheDir: path.join(rootDir, "cache", "openclaw-catalog"),
    getGithubToken: () => process.env.GITHUB_TOKEN || null,
    logger: kSilentLogger,
  });
  const restartProcess = vi.fn();
  const notifications = [];
  const operationEvents = createOperationEventsService();
  const gatewayQuiesce = createQuiesceFake();

  const buildSync = ({ releasesOverride } = {}) =>
    createOpenclawChannelSync({
      rootDir,
      openclawDir,
      packageRoot,
      store,
      runStream: createRunStream({}),
      // Tracked real install: the prepare dir joins the sweep the moment npm
      // starts, so a run killed mid-download leaves nothing behind.
      installToTempDir: (opts) =>
        stageTempInstall({ ...opts, timeoutMs: kInstallTimeoutMs }),
      resolveInstallDir: () => installDir,
      readReleaseChannel: () => readOpenclawReleaseChannel({ openclawDir }),
      releases: releasesOverride !== undefined ? releasesOverride : releases,
      openclawSpawnEnv: () => cliEnv,
      gatewayQuiesce,
      isOnboarded: () => true,
      restartProcess,
      clearVersionCache: () => {},
      notify: async (message) => {
        notifications.push(message);
      },
      operationEvents,
      logger: kSilentLogger,
      backupsDir: path.join(rootDir, "backups", "openclaw"),
      // Real /proc probes scoped to this harness (see live-backup-harness).
      backupProbes: {
        listProcesses: () =>
          require("../../lib/server/openclaw-lock-contention")
            .listLiveOpenclawProcesses()
            .filter((entry) => entry.cmdline.includes(rootDir)),
      },
    });

  const sync = buildSync();
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
      markRequired: () => {},
      getSnapshot: async () => ({ restartRequired: true }),
    },
  });

  return {
    app,
    sync,
    buildSync,
    store,
    releases,
    rootDir,
    openclawDir,
    installDir,
    stateDbPath,
    installedBin,
    restartProcess,
    notifications,
    operationEvents,
    gatewayQuiesce,
    cliEnv,
  };
};

// The apply ROUTE gates on catalog membership (`isKnownVersion`), which reads
// the fetched catalog — warm it first, like the Upgrade tab does before an
// operator can click anything, and prove the target is a published version.
const postApply = async (harness, body) => {
  const catalog = await harness.releases.getCatalog({});
  expect(catalog.ok).toBe(true);
  expect(
    harness.releases.isKnownVersion(body.version, body.channel),
    `${body.version} is not in the ${body.channel} catalog window: ${JSON.stringify(catalog[body.channel]?.map((r) => r.version))}`,
  ).toBe(true);
  const res = await request(harness.app).post("/api/openclaw/apply").send(body);
  return res;
};

const waitForRunToFinish = async (harness, label) => {
  await waitFor(
    () => {
      const run = harness.store.readState().lastUpdateRun;
      return run && run.finishedAt !== null;
    },
    kApplySettleTimeoutMs,
    label,
  );
  return harness.store.readState().lastUpdateRun;
};

const readLedgerRun = (harness, operationId) =>
  JSON.parse(
    fs.readFileSync(
      path.join(harness.openclawDir, ".alphaclaw", "runs", `${operationId}.json`),
      "utf8",
    ),
  );

// Boot the ACTIVATED binary's gateway on the harness state dir with the
// live-gateway tier's loopback config; resolve on /healthz.
const bootActivatedGateway = async (harness, { port }) => {
  const configPath = path.join(harness.openclawDir, "openclaw.json");
  const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...current,
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { token: "live-e2e-token-000000000000000000000000" },
        },
      },
      null,
      2,
    ),
  );
  const bin = harness.store.resolvePackageBin(
    path.join(harness.installDir, "node_modules", "openclaw"),
  );
  const env = withOpenclawStartupEnv({
    ...buildCliEnv({ homeDir: harness.rootDir, stateDir: harness.openclawDir }),
    OPENCLAW_GATEWAY_PORT: String(port),
  });
  const child = spawn(process.execPath, [bin, "gateway", "run", "--port", String(port)], {
    env,
    stdio: "pipe",
  });
  let output = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  child.on("exit", (code) => (exited = code));
  const startedAt = Date.now();
  try {
    await waitFor(
      async () => {
        if (exited !== null) return true;
        try {
          const r = await fetch(`http://127.0.0.1:${port}/healthz`);
          return r.ok;
        } catch {
          return false;
        }
      },
      kGatewayHealthTimeoutMs,
      `activated gateway /healthz on ${port} (last output: ${output.slice(-300)})`,
    );
    expect(exited, `gateway exited ${exited}:\n${output.slice(-1500)}`).toBeNull();
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthz.ok).toBe(true);
    return { readyMs: Date.now() - startedAt, output };
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (exited === null) child.kill("SIGKILL");
  }
};

describeLive("LIVE #54 downgrade: real 2026.9.1-beta.1 → 2026.8.2 through the hard gate", () => {
  let beta;
  let stable;

  beforeAll(async () => {
    // Fail fast with the sweep instruction, not mid-run with ENOSPC.
    assertFreeDiskBytes(undefined, { label: "the live downgrade suite" });
    beta = await stageOpenclawVersion(kOpenclawLines.beta, { timeoutMs: kInstallTimeoutMs });
    stable = await stageOpenclawVersion(kOpenclawLines.stable, { timeoutMs: kInstallTimeoutMs });
  }, kTestTimeoutMs);

  it(
    "beta-written state → stable: quiesced real backup verified, preflight migration-required, activation, and the 2026.8.2 gateway boots the migrated state",
    { timeout: kTestTimeoutMs },
    async () => {
      const harness = createDowngradeHarness({
        installed: { channel: "beta", version: beta.version, packageDir: beta.packageDir },
      });
      // The state the beta wrote (schema 12) + the lease-engaging audit log.
      expect(readUserVersion(harness.stateDbPath)).toBe(12);

      const applyRes = await postApply(harness, { channel: "stable", version: stable.version });
      expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(202);
      const { operationId } = applyRes.body;

      const run = await waitForRunToFinish(harness, `downgrade to ${stable.version}`);
      expect(run.ok, JSON.stringify(run.result || run.steps)).toBe(true);
      const stepNames = run.steps.map((step) => `${step.name}:${step.status}`);
      for (const expected of [
        "preflight:completed",
        "backup:completed",
        "download:completed",
        "verify:completed",
        "db-preflight:completed",
        "record:completed",
      ]) {
        expect(stepNames, stepNames.join(", ")).toContain(expected);
      }
      // ONE initial "backup: running" (WI-1.9) and the pause was real.
      const backupSteps = run.steps.filter((step) => step.name === "backup");
      expect(backupSteps[0].status).toBe("running");
      expect(backupSteps[0].detail).toMatch(/pausing the gateway for a consistent backup/);
      expect(backupSteps.filter((step) => step.status === "completed")).toHaveLength(1);
      const preflightStep = run.steps.find(
        (step) => step.name === "db-preflight" && step.status === "completed",
      );
      expect(preflightStep.detail).toMatch(/schema migration will run at the next start/);

      // The durable record: verified upstream artifact, usable, quiesced, one
      // attempt (no writer raced the paused backup here), and the structured
      // preflight verdict boot will size its migration from.
      const record = readLedgerRun(harness, operationId);
      expect(record.backup).toEqual(
        expect.objectContaining({
          noBackup: false,
          verified: true,
          usableCheck: "manifest_ok",
          producer: "openclaw",
          quiesced: true,
          attempts: 1,
          quiescedAttempts: 1,
          contentionRetries: 0,
        }),
      );
      expect(record.backup.file).toMatch(/openclaw-backup-.*\.tar\.gz$/);
      expect(fs.statSync(record.backup.file).size).toBeGreaterThan(0);
      expect(record.dbPreflight).toEqual(
        expect.objectContaining({ migrationRequired: true, foundVersion: 12, targetVersion: 15 }),
      );
      expect(readRunBackupRecord(harness.openclawDir).file).toBe(record.backup.file);
      // Quiesce transaction ran for real: stop → CLI → start → release.
      expect(harness.gatewayQuiesce.calls.indexOf("stop")).toBeGreaterThanOrEqual(0);
      expect(harness.gatewayQuiesce.calls.indexOf("start")).toBeGreaterThan(
        harness.gatewayQuiesce.calls.indexOf("stop"),
      );

      // Recorded intent + overlay persisted; restart requested.
      const state = harness.store.readState();
      expect(state.applied).toEqual(
        expect.objectContaining({ channel: "stable", version: stable.version, acceptedAt: null }),
      );
      // applied.operationId (WI-3.4, the apply-accepted notification key) is
      // stamped by applyUpdate but the store normalizer (normalizeApplied)
      // does not carry it yet — pinned by the hermetic state-file compat
      // tests once it does, not here.
      expect(harness.store.hasOverlay(stable.version)).toBe(true);
      await waitFor(() => harness.restartProcess.mock.calls.length > 0, 10_000, "restartProcess");

      // BOOT: activation with ZERO network (the apply tier's invariant).
      const throwingReleases = new Proxy(
        {},
        {
          get() {
            throw new Error("boot sync must never consult the release catalog");
          },
        },
      );
      const bootSync = harness.buildSync({ releasesOverride: throwingReleases });
      const realFetch = global.fetch;
      let bootFetchCalls = 0;
      global.fetch = () => {
        bootFetchCalls += 1;
        throw new Error("boot sync must never touch the network");
      };
      let bootResult;
      try {
        bootResult = bootSync.syncAtBoot();
      } finally {
        global.fetch = realFetch;
      }
      expect(bootResult.ok).toBe(true);
      expect(bootResult.action).toBe("activated");
      expect(bootFetchCalls).toBe(0);
      expect(harness.store.readSentinel({ installDir: harness.installDir })?.version).toBe(
        stable.version,
      );
      const activatedBin = harness.store.resolvePackageBin(
        path.join(harness.installDir, "node_modules", "openclaw"),
      );
      const versionOut = execFileSync(process.execPath, [activatedBin, "--version"], {
        env: buildCliEnv({ homeDir: mkTemp("openclaw-live-probe-home-"), stateDir: mkTemp("openclaw-live-probe-state-") }),
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(versionOut).toContain(stable.version);

      // The downgraded gateway runs the beta-written state: migration at
      // start, then /healthz. (Production runs the doctor migration in the
      // boot reconciler first; the gateway's own startup migration is the
      // floor this asserts.)
      const boot = await bootActivatedGateway(harness, { port: 18971 });
      console.log(`[live-downgrade] 2026.8.2 gateway ready on beta-written state in ${boot.readyMs} ms`);
      expect(readUserVersion(harness.stateDbPath)).toBe(15);
    },
  );

  it(
    "stable-written state → beta is refused by the target's database preflight (incompatible) AFTER a verified backup and BEFORE anything changed",
    { timeout: kTestTimeoutMs },
    async () => {
      const harness = createDowngradeHarness({
        installed: { channel: "stable", version: stable.version, packageDir: stable.packageDir },
      });
      expect(readUserVersion(harness.stateDbPath)).toBe(15);
      const appliedBefore = harness.store.readState().applied;

      const applyRes = await postApply(harness, { channel: "beta", version: beta.version });
      expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(202);
      const { operationId } = applyRes.body;
      const run = await waitForRunToFinish(harness, `apply of ${beta.version} to be refused`);
      expect(run.ok).toBe(false);
      expect(run.result).toEqual(
        expect.objectContaining({ ok: false, code: "db_preflight_failed" }),
      );
      expect(run.result.message).toMatch(/cannot safely read your current database/);
      expect(run.result.hint).toMatch(/stopped before anything changed/);
      const stepNames = run.steps.map((step) => `${step.name}:${step.status}`);
      expect(stepNames).toContain("backup:completed");
      expect(stepNames).toContain("db-preflight:failed");

      // The hard gate still produced its verified backup first (that is the
      // recovery artifact had the operator forced anything by hand).
      const record = readLedgerRun(harness, operationId);
      expect(record.backup).toEqual(
        expect.objectContaining({ noBackup: false, verified: true, usableCheck: "manifest_ok", quiesced: true }),
      );
      // Nothing changed: same applied intent, sentinel still the stable, no
      // restart requested, the state DB untouched.
      expect(harness.store.readState().applied).toEqual(appliedBefore);
      expect(harness.store.readSentinel({ installDir: harness.installDir })?.version).toBe(
        stable.version,
      );
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(readUserVersion(harness.stateDbPath)).toBe(15);
      // The failure reached the notification path with the honest code.
      expect(harness.notifications.some((m) => /update to .* failed/i.test(m))).toBe(true);
    },
  );
});
