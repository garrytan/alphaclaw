// LIVE TIER 3 — the dev channel against real OpenClaw source:
//   1. Updater JSON contract (OPENCLAW_LIVE_E2E): real `openclaw update
//      --channel dev --dry-run --json` through the pinned CLI — stdout must
//      remain exactly one JSON document, independently of stderr diagnostics.
//   2. Full dev-head build (OPENCLAW_LIVE_E2E_DEV=1 additionally): a real
//      git clone of openclaw/openclaw main, pnpm install, source/UI runtime build,
//      doctor — driven through the real candidate preparation and apply flow,
//      then boot-activated through the shim and EXECUTED. The old executing
//      tree is a small fixture; the candidate is a real GitHub source build.
//      Uses upstream's native-updater runtime mode, not declaration publication.
//      20-35 minutes, ~5 GB disk, build-grade RAM. Nightly/manual tier only.
//
// Requires: network, git, pnpm, a Node supported by both AlphaClaw AND current
// upstream main (which can advance beyond the stable pin's requirements),
// and the repo's pinned openclaw CLI in node_modules. No global installation
// or native updater is allowed during candidate preparation.

const fs = require("fs");
const path = require("path");
// live-helpers only touches fs/os/path — safe to load BEFORE the env below,
// and its mkTemp registers the dir for the exit-time cleanup sweep.
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-dev-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync } = require("child_process");

const {
  createOpenclawChannelSync,
  buildDevUpdateEnv,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { resetStateDbQuietForTests } = require("../../lib/server/state-db-quiet");
const {
  assertFreeDiskBytes,
  kLiveEnabled,
  kLiveDevEnabled,
  kSilentLogger,
  kFullShaShape,
  mkTemp,
  kFixturePin,
  writePinFixture,
  scrubTestRunnerEnv,
  repoOpenclawBin,
  runCliJson,
  waitFor,
} = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;
const describeLiveDev = kLiveEnabled && kLiveDevEnabled ? describe : describe.skip;

const kDevBuildTimeoutMs = 35 * 60 * 1000;


describeLive("LIVE openclaw updater JSON contract (real pinned CLI)", () => {
  it(
    "emits parseable UpdateRunResult JSON from a --dry-run dev update",
    { timeout: 5 * 60 * 1000 },
    async () => {
      const homeDir = mkTemp("openclaw-live-dryrun-home-");
      const parsed = runCliJson(repoOpenclawBin(),
        ["update", "--channel", "dev", "--dry-run", "--json", "--yes"], {
        env: scrubTestRunnerEnv({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
          GIT_TERMINAL_PROMPT: "0",
        }),
        timeoutMs: 4 * 60 * 1000,
      });
      // A --dry-run emits the updater's PLAN object (verified live 2026-08):
      // { dryRun, mode, effectiveChannel, actions, ... }. The run-result
      // `status` contract is asserted by the full build below. What this test
      // pins is the D1 assumption: dev channel still means "switch to a git
      // source checkout", and the CLI's JSON boundary remains strict.
      expect(parsed.dryRun).toBe(true);
      expect(parsed.effectiveChannel).toBe("dev");
      expect(parsed.mode).toBe("git");
      expect(Array.isArray(parsed.actions)).toBe(true);
      expect(parsed.actions.length).toBeGreaterThan(0);
    },
  );
});

describeLiveDev("LIVE openclaw dev-head build (isolated candidate acceptance)", () => {
  let buildRoot = null;
  let completed = false;
  afterAll(() => {
    resetStateDbQuietForTests();
    if (completed || !buildRoot) return;
    const artifactsDir = path.join(__dirname, "artifacts", path.basename(buildRoot));
    fs.mkdirSync(artifactsDir, { recursive: true });
    for (const relative of [
      "logs/openclaw-dev-update.log",
      ".openclaw/.alphaclaw/openclaw-channel-state.json",
    ]) {
      const source = path.join(buildRoot, relative);
      if (fs.existsSync(source)) {
        fs.writeFileSync(
          path.join(artifactsDir, path.basename(relative)),
          fs.readFileSync(source).subarray(-5 * 1024 * 1024),
        );
      }
    }
    console.warn(`[live-dev] failure artifacts: ${artifactsDir}`);
  });
  it(
    "builds real main without touching the active checkout, checkpoints config, then boot-activates and executes it",
    { timeout: kDevBuildTimeoutMs + 5 * 60 * 1000, retry: 0 },
    async () => {
      // A from-source build needs ~5 GB (git clone + pnpm store + dist):
      // fail fast with the sweep instruction rather than 20 min in.
      assertFreeDiskBytes(8 * 1024 ** 3, { label: "the live dev source build" });
      const rootDir = mkTemp("alphaclaw-live-dev-e2e-");
      buildRoot = rootDir;
      fs.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
      const openclawDir = path.join(rootDir, ".openclaw");
      const packageRoot = mkTemp("alphaclaw-live-dev-pkgroot-");
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "@live/alphaclaw", dependencies: { openclaw: kFixturePin } })}\n`,
      );
      const installDir = mkTemp("alphaclaw-live-dev-install-");
      writePinFixture(installDir);

      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
      const legacyCheckout = path.join(rootDir, "openclaw");
      execFileSync("git", ["clone", "--shared", "--no-checkout", path.resolve(__dirname, "../.."), legacyCheckout], {
        env: scrubTestRunnerEnv(), stdio: "pipe", timeout: 120_000,
      });
      fs.cpSync(path.join(installDir, "node_modules", "openclaw"), legacyCheckout, { recursive: true });
      const oldSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: legacyCheckout, env: scrubTestRunnerEnv(), encoding: "utf8", timeout: 30_000,
      }).trim();

      const store = createOpenclawReleaseChannelStore({
        rootDir,
        openclawDir,
        logger: kSilentLogger,
      });
      store.writeSentinel({ installDir, version: kFixturePin });
      store.updateState((s) => {
        s.pinVersion = kFixturePin;
        s.applied = { channel: "dev", sha: oldSha, at: Date.now(), acceptedAt: Date.now() };
        return s;
      });
      const oldBin = store.resolvePackageBin(legacyCheckout);
      expect(store.writeBinShim({ targetBin: oldBin, label: "old dev fixture" }).ok).toBe(true);
      const oldShim = fs.readFileSync(store.shimPath);
      const oldPackage = fs.readFileSync(path.join(legacyCheckout, "package.json"));
      const oldExecutable = fs.readFileSync(oldBin);
      const oldConfig = fs.readFileSync(path.join(openclawDir, "openclaw.json"));
      const trapDir = path.join(rootDir, "trap-bin");
      fs.mkdirSync(trapDir);
      const trapMarker = path.join(rootDir, "unexpected-active-cli");
      fs.writeFileSync(path.join(trapDir, "openclaw"), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(trapMarker)}, JSON.stringify(process.argv) + '\\n'); process.exit(97);\n`, { mode: 0o755 });
      const updaterEnv = buildDevUpdateEnv({
        ...scrubTestRunnerEnv(),
        HOME: rootDir,
        PATH: `${trapDir}${path.delimiter}${process.env.PATH}`,
        OPENCLAW_HOME: rootDir,
        OPENCLAW_STATE_DIR: openclawDir,
        OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
        OPENCLAW_NO_AUTO_UPDATE: "1",
      });
      const calls = [];
      const realRunner = createRunStream({});
      const runner = { runStreamed: async (options) => {
        calls.push({ command: options.command, args: options.args, cwd: options.cwd,
          runtimeBuild: options.env?.OPENCLAW_UPDATE_IN_PROGRESS === "1" || options.env?.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD === "1" });
        return realRunner.runStreamed({ ...options, env: scrubTestRunnerEnv(options.env || updaterEnv) });
      } };
      const order = [];
      let running = true;
      const gatewayQuiesce = {
        isRunning: async () => running,
        suppress: () => "live-dev-owner", unsuppress: () => {},
        stop: async () => { order.push("stop"); running = false; return true; },
        start: async () => { order.push("start"); running = true; },
      };
      const buildSync = () => {
        const lock = createGatewayLifecycleLock();
        let instance;
        const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => instance.getChannelInfo(), isApplyInProgress: () => instance.isApplyInProgress() });
        instance = createOpenclawChannelSync({
          rootDir,
          openclawDir,
          packageRoot,
          store,
          runStream: runner,
          resolveInstallDir: () => installDir,
          openclawSpawnEnv: () => updaterEnv,
          releases: null,
          isOnboarded: () => true,
          gatewayQuiesce,
          acquireLifecycleLock: lock.acquire,
          gatewayMutationPolicy: policy,
          clearVersionCache: () => {},
          logger: kSilentLogger,
          backupsDir: path.join(rootDir, "backups", "openclaw"),
        });
        return instance;
      };

      const sync = buildSync();
      const applyPromise = sync.applyUpdate({ channel: "dev", devHead: true });
      // Interim handler: an early rejection must surface as this test's own
      // failure, not an unhandledRejection while waitFor burns the budget.
      let applyRejection = null;
      applyPromise.catch((error) => {
        applyRejection = error;
      });
      await waitFor(
        () => {
          if (applyRejection) throw applyRejection;
          const run = store.readState().lastUpdateRun;
          return run && run.finishedAt !== null;
        },
        kDevBuildTimeoutMs,
        "dev-head build to finish",
      );
      const applied = await applyPromise;
      const run = store.readState().lastUpdateRun;
      const updateLogPath = path.join(rootDir, "logs", "openclaw-dev-update.log");
      expect(
        applied.status,
        JSON.stringify({
          result: run?.result || applied.body,
          steps: run?.steps,
          updaterLog: applied.status !== 202 && fs.existsSync(updateLogPath)
            ? fs.readFileSync(updateLogPath, "utf8").slice(-16_000)
            : undefined,
        }),
      ).toBe(202);
      expect(run.ok).toBe(true);
      const stepNames = run.steps.map((step) => `${step.name}:${step.status}`);
      expect(stepNames, `steps were: ${stepNames.join(", ")}`).toContain(
        "build:completed",
      );
      expect(stepNames).toContain("verify:completed");
      expect(stepNames).toContain("fetch:completed");
      expect(stepNames).toContain("checkout:completed");
      expect(stepNames).toContain("install:completed");
      expect(stepNames.some((step) => step.startsWith("doctor:"))).toBe(true);

      // Recorded dev intent: a real 40-hex main-branch commit.
      const state = store.readState();
      expect(state.applied?.channel).toBe("dev");
      expect(state.applied?.sha).toMatch(kFullShaShape);

      const checkoutDir = state.applied.checkoutDir;
      expect(path.dirname(checkoutDir)).toBe(`${legacyCheckout}-candidates`);
      expect(path.basename(checkoutDir)).toMatch(/^candidate-[a-f0-9-]{36}$/);
      expect(checkoutDir).not.toBe(legacyCheckout);
      expect(fs.existsSync(path.join(checkoutDir, ".git"))).toBe(true);
      const checkoutBin = store.resolvePackageBin(checkoutDir);
      expect(checkoutBin, "dev checkout must expose a runnable bin").toBeTruthy();
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkoutDir, encoding: "utf8", env: scrubTestRunnerEnv(), timeout: 30_000 }).trim()).toBe(state.applied.sha);
      expect(calls.some((call) => call.command === "git" && call.args.includes("https://github.com/openclaw/openclaw.git"))).toBe(true);
      for (const action of ["install", "build", "ui:build"]) expect(calls.some((call) => call.command === "pnpm" && call.args[0] === action && call.cwd === checkoutDir)).toBe(true);
      expect(calls.find((call) => call.command === "pnpm" && call.args[0] === "build").runtimeBuild).toBe(true);
      expect(calls.some((call) => call.args?.includes("doctor") && call.args[0] === checkoutBin)).toBe(true);
      expect(calls.some((call) => call.command === "openclaw" || call.args?.includes("--global") || call.args?.includes("backup") || call.args?.includes("preflight"))).toBe(false);
      expect(fs.existsSync(trapMarker)).toBe(false);
      expect(fs.readFileSync(store.shimPath)).toEqual(oldShim);
      expect(fs.readFileSync(path.join(legacyCheckout, "package.json"))).toEqual(oldPackage);
      expect(fs.readFileSync(oldBin)).toEqual(oldExecutable);
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: legacyCheckout, encoding: "utf8", env: scrubTestRunnerEnv(), timeout: 30_000 }).trim()).toBe(oldSha);
      expect(fs.readFileSync(path.join(openclawDir, "openclaw.json"))).toEqual(oldConfig);
      expect(order).toEqual(["stop"]);
      expect(state.previousDev).toEqual({ sha: oldSha, checkoutDir: legacyCheckout });
      const record = sync.runLedger.readRun(applied.body.operationId);
      expect(record.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true, fileCount: 1 }, databases: { entries: [], complete: false } });
      expect(record.recovery.checkpoint.bytes).toBeLessThan(1024);
      expect(record.recoveryIntent.target.checkoutDir).toBe(checkoutDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(record.recovery.checkpoint.file, "manifest.json")));
      expect(manifest.databases).toEqual([]);
      expect(manifest.requiredPaths).toEqual([]);
      expect(fs.existsSync(path.join(openclawDir, "state", "openclaw.sqlite"))).toBe(false);

      // BOOT: offline, verifies HEAD == recorded sha (including the
      // packed-refs path on real updater checkouts) and writes the shim.
      const bootSync = buildSync();
      const realFetch = global.fetch;
      global.fetch = () => {
        throw new Error("boot sync must never touch the network");
      };
      let bootResult;
      try {
        bootResult = bootSync.syncAtBoot();
      } finally {
        global.fetch = realFetch;
      }
      expect(bootResult.ok).toBe(true);
      expect(bootResult.action).toBe("dev_shim");
      expect(fs.existsSync(store.shimPath)).toBe(true);
      expect(store.readBinShimTarget()).toBe(checkoutBin);
      expect(fs.existsSync(oldBin)).toBe(true);

      // Execute the REAL freshly built dev binary through the shim.
      const output = execFileSync(store.shimPath, ["--version"], {
        encoding: "utf8",
        timeout: 120_000,
        env: scrubTestRunnerEnv({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENCLAW_HOME: rootDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
        }),
      });
      expect(output).toMatch(/\d{4}\.\d+\.\d+/);
      console.info(`[live-dev] acceptance ${JSON.stringify({ upstreamSha: state.applied.sha, cliVersion: output.trim(),
        candidateDir: checkoutDir, previousDevSha: oldSha, oldSourceUnchanged: true, shimActivatedAtBoot: true,
        recoveryKind: record.recovery.kind, configBytes: record.recovery.checkpoint.bytes,
        configFiles: record.recovery.checkpoint.fileCount, databaseFiles: manifest.databases.length,
        buildMode: "upstream-native-updater-runtime" })}`);
      completed = true;
    },
  );
});
