// LIVE TIER 2 — the full package pipeline against REAL upstream artifacts:
// real catalog (GitHub + npm), real `npm install` of the actual current
// latest stable and newest beta, real verification probes (`node <bin>
// --version`, dist-shape), real overlay persistence, then a real boot-time
// activation whose product is EXECUTED. Only three things are not real: the
// backup step (needs a live gateway), restartProcess (spied), and the pin
// (a tiny fixture — the shipped pin tree is not present in a test sandbox).
//
// Requires: network, a supported Node (the repo gate applies — the real
// installer and the real CLI both enforce it). Runtime: ~2-6 min.

// Isolate the module-level kRootDir (the real installer keeps its npm cache
// under it) BEFORE any lib/ module loads constants.
const fs = require("fs");
const path = require("path");
// live-helpers only touches fs/os/path — safe to load BEFORE the env below,
// and its mkTemp registers the dir for the exit-time cleanup sweep.
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-apply-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync } = require("child_process");
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
const {
  assertFreeDiskBytes,
  kLiveEnabled,
  kSilentLogger,
  kFixturePin,
  writePinFixture,
  createBackupStubRunner,
  mkTemp,
  stageTempInstall,
  waitFor,
} = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
// The apply also runs verify probes and a multi-hundred-MB overlay copy after
// the download — the wait needs headroom past the install's own budget.
const kApplySettleTimeoutMs = kInstallTimeoutMs + 2 * 60 * 1000;
const kApplyTestTimeoutMs = 12 * 60 * 1000;


const createLiveHarness = () => {
  const rootDir = mkTemp("alphaclaw-live-apply-e2e-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-live-apply-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@live/alphaclaw", dependencies: { openclaw: kFixturePin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-live-apply-install-");
  writePinFixture(installDir);

  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    logger: kSilentLogger,
  });
  store.writeSentinel({ installDir, version: kFixturePin });
  store.updateState((s) => {
    s.pinVersion = kFixturePin;
    return s;
  });

  // The stub writes a real upstream-layout archive of THIS box's state dir;
  // the hard gate's usable check then judges it like a real one.
  const runner = createBackupStubRunner(createRunStream({}), { stateDir: openclawDir });

  const releases = createOpenclawReleasesService({
    cacheDir: path.join(rootDir, "cache", "openclaw-catalog"),
    getGithubToken: () => process.env.GITHUB_TOKEN || null,
    logger: kSilentLogger,
  });

  const restartProcess = vi.fn();
  const notifications = [];
  const operationEvents = createOperationEventsService();

  const buildSync = ({ releasesOverride } = {}) =>
    createOpenclawChannelSync({
      rootDir,
      openclawDir,
      packageRoot,
      store,
      runStream: runner,
      // Tracked real install (prepare dir swept even if the run is killed
      // mid-download; see live-helpers stageTempInstall).
      installToTempDir: (opts) =>
        stageTempInstall({ ...opts, timeoutMs: kInstallTimeoutMs }),
      resolveInstallDir: () => installDir,
      readReleaseChannel: () => readOpenclawReleaseChannel({ openclawDir }),
      releases: releasesOverride !== undefined ? releasesOverride : releases,
      isOnboarded: () => true,
      restartProcess,
      clearVersionCache: () => {},
      notify: async (message) => {
        notifications.push(message);
      },
      operationEvents,
      logger: kSilentLogger,
      backupsDir: path.join(rootDir, "backups", "openclaw"),
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
    installDir,
    restartProcess,
    notifications,
    operationEvents,
  };
};

// Runs the real, freshly ACTIVATED binary and returns its stdout. Env mirrors
// production's minimal probe env, plus an isolated OPENCLAW_HOME so the real
// CLI neither reads nor pollutes the machine's ~/.openclaw, and no update
// check can stall the exec.
const runActivatedBinary = (store, installDir) => {
  const bin = store.resolvePackageBin(
    path.join(installDir, "node_modules", "openclaw"),
  );
  expect(bin, "activated openclaw package must expose a runnable bin").toBeTruthy();
  const env = { OPENCLAW_HOME: mkTemp("openclaw-live-probe-home-"), OPENCLAW_NO_AUTO_UPDATE: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return execFileSync("node", [bin, "--version"], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
};

const applyAndActivate = async (harness, { channel, version }) => {
  const { app, store, buildSync, restartProcess, operationEvents } = harness;

  const applyRes = await request(app)
    .post("/api/openclaw/apply")
    .send({ channel, version });
  expect(applyRes.status, JSON.stringify(applyRes.body)).toBe(202);
  const { operationId } = applyRes.body;
  expect(typeof operationId).toBe("string");

  // The real download takes minutes; poll the persisted run record.
  await waitFor(
    () => {
      const run = store.readState().lastUpdateRun;
      return run && run.finishedAt !== null;
    },
    kApplySettleTimeoutMs,
    `apply of ${version} to finish`,
  );

  const run = store.readState().lastUpdateRun;
  expect(run.ok, JSON.stringify(run.result || run.steps)).toBe(true);
  const stepNames = run.steps.map((step) => `${step.name}:${step.status}`);
  for (const expected of [
    "preflight:completed",
    "download:completed",
    "verify:completed",
    "record:completed",
  ]) {
    expect(stepNames).toContain(expected);
  }

  // Recorded intent + persisted overlay of the REAL artifact.
  const state = store.readState();
  expect(state.applied).toEqual(
    expect.objectContaining({ channel, version, acceptedAt: null }),
  );
  expect(store.hasOverlay(version)).toBe(true);
  expect(store.hasOverlay(kFixturePin)).toBe(true); // pin floor snapshotted
  await waitFor(
    () => restartProcess.mock.calls.length > 0,
    10_000,
    "restartProcess to be requested",
  );

  // Step events reached the operation stream.
  const operation = operationEvents.getOperation(operationId);
  expect(
    operation.events.filter((entry) => entry.event === "step").length,
  ).toBeGreaterThanOrEqual(4);
  expect(operation.events.at(-1).event).toBe("done");

  // BOOT (fresh instance, as after the restart): must activate the overlay
  // with ZERO network — D2's offline-determinism invariant, on real artifacts.
  // Two tripwires: a booby-trapped releases service (the realistic regression
  // path — boot consulting the catalog) and a poisoned global fetch (any raw
  // network call added to the boot path).
  const throwingReleases = new Proxy(
    {},
    {
      get() {
        throw new Error("boot sync must never consult the release catalog");
      },
    },
  );
  const bootSync = buildSync({ releasesOverride: throwingReleases });
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
  expect(store.readSentinel({ installDir: harness.installDir })?.version).toBe(
    version,
  );

  return { bootSync };
};

describeLive("LIVE openclaw package apply (real npm artifacts)", () => {
  beforeAll(() => {
    // Two real installs + their overlays + activated copies (~3 GB peak):
    // fail fast with the sweep instruction rather than mid-run with ENOSPC.
    assertFreeDiskBytes(undefined, { label: "the live package-apply suite" });
  });

  it(
    "applies the real latest STABLE release end-to-end and executes the activated binary",
    { timeout: kApplyTestTimeoutMs },
    async () => {
      const harness = createLiveHarness();
      const catalog = await harness.releases.getCatalog({});
      expect(catalog.ok).toBe(true);
      const version = catalog.distTags.latest;

      const { bootSync } = await applyAndActivate(harness, {
        channel: "stable",
        version,
      });

      // The activated tree is the real upstream artifact — run it.
      const output = runActivatedBinary(harness.store, harness.installDir);
      expect(output).toContain(version);

      // Idempotence against the REAL activated version: re-apply is a noop.
      const again = await bootSync.applyUpdate({ channel: "stable", version });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(
        expect.objectContaining({ ok: true, noop: true, version }),
      );
    },
  );

  it(
    "applies the real newest BETA release end-to-end and executes the activated binary",
    { timeout: kApplyTestTimeoutMs },
    async () => {
      const harness = createLiveHarness();
      const catalog = await harness.releases.getCatalog({});
      expect(catalog.ok).toBe(true);
      // Newest beta that npm has actually published (a GitHub prerelease can
      // precede its npm publish; the apply route gates on npm membership).
      const version = catalog.beta
        .map((row) => row.version)
        .find((candidate) => harness.releases.isKnownVersion(candidate, "beta"));
      expect(
        version,
        "no npm-published beta in the catalog window — likely an upstream publish gap",
      ).toBeTruthy();

      await applyAndActivate(harness, { channel: "beta", version });

      const output = runActivatedBinary(harness.store, harness.installDir);
      expect(output).toContain(version);
    },
  );
});
