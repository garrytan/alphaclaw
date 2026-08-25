// LIVE TIER 3 — the dev channel against the REAL OpenClaw updater:
//   1. Updater JSON contract (OPENCLAW_LIVE_E2E): real `openclaw update
//      --channel dev --dry-run --json` through the pinned CLI — the tolerant
//      UpdateRunResult parsing in channel-sync exists because upstream owns
//      this contract; this test screams when it drifts.
//   2. Full dev-head build (OPENCLAW_LIVE_E2E_DEV=1 additionally): a real
//      `openclaw update --channel dev` — git clone of openclaw/openclaw main,
//      pnpm install, from-source build, doctor — driven through the real
//      channel-sync apply flow, then boot-activated (bin shim) and EXECUTED.
//      10-30 minutes, ~5 GB disk, build-grade RAM. Nightly/manual tier only.
//
// Requires: network, git, pnpm, a supported Node, the repo's pinned openclaw
// CLI in node_modules.

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
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const {
  parseJsonObjectFromNoisyOutput,
} = require("../../lib/server/utils/json");
const {
  kLiveEnabled,
  kLiveDevEnabled,
  kSilentLogger,
  kFullShaShape,
  mkTemp,
  kFixturePin,
  writePinFixture,
  createBackupStubRunner,
  repoBinDir,
  repoOpenclawBin,
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
      const runner = createRunStream({});
      const result = await runner.runStreamed({
        command: repoOpenclawBin(),
        args: ["update", "--channel", "dev", "--dry-run", "--json", "--yes"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeoutMs: 4 * 60 * 1000,
      });
      // A --dry-run emits the updater's PLAN object (verified live 2026-08):
      // { dryRun, mode, effectiveChannel, actions, ... }. The run-result
      // `status` contract is asserted by the full build below. What this test
      // pins is the D1 assumption: dev channel still means "switch to a git
      // source checkout", parseable through the same noisy-output parser
      // channel-sync uses in production.
      const parsed = parseJsonObjectFromNoisyOutput(result.tail || "");
      expect(
        parsed,
        `updater --json output was not parseable; tail:\n${(result.tail || "").slice(-2000)}`,
      ).toBeTruthy();
      expect(parsed.dryRun).toBe(true);
      expect(parsed.effectiveChannel).toBe("dev");
      expect(parsed.mode).toBe("git");
      expect(Array.isArray(parsed.actions)).toBe(true);
      expect(parsed.actions.length).toBeGreaterThan(0);
    },
  );
});

describeLiveDev("LIVE openclaw dev-head build (real from-source pipeline)", () => {
  it(
    "builds real main from source via the updater, boot-activates the shim, and executes it",
    { timeout: kDevBuildTimeoutMs + 5 * 60 * 1000 },
    async () => {
      const rootDir = mkTemp("alphaclaw-live-dev-e2e-");
      fs.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
      const openclawDir = path.join(rootDir, ".openclaw");
      const packageRoot = mkTemp("alphaclaw-live-dev-pkgroot-");
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "@live/alphaclaw", dependencies: { openclaw: kFixturePin } })}\n`,
      );
      const installDir = mkTemp("alphaclaw-live-dev-install-");
      writePinFixture(installDir);

      // The updater's post-update plugin convergence requires a PARSEABLE
      // openclaw config and reports status:"error" (reason invalid-config)
      // against a bare home — live-verified. Production always has one; seed
      // the minimal valid config at the path OPENCLAW_HOME resolves to.
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");

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

      const runner = createBackupStubRunner(createRunStream({}));

      const restartProcess = vi.fn();
      const buildSync = () =>
        createOpenclawChannelSync({
          rootDir,
          openclawDir,
          packageRoot,
          store,
          runStream: runner,
          resolveInstallDir: () => installDir,
          // The updater clones to $OPENCLAW_HOME/openclaw — pointed at this
          // harness's rootDir so the checkout lands where channel-sync looks.
          // The repo's node_modules/.bin supplies the real pinned `openclaw`.
          gatewayEnv: () => ({
            ...process.env,
            PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH}`,
            OPENCLAW_HOME: rootDir,
            OPENCLAW_NO_AUTO_UPDATE: "1",
          }),
          releases: null,
          isOnboarded: () => true,
          restartProcess,
          clearVersionCache: () => {},
          logger: kSilentLogger,
          backupsDir: path.join(rootDir, "backups", "openclaw"),
        });

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
      expect(
        applied.status,
        JSON.stringify(run?.result || run?.steps || applied.body),
      ).toBe(202);
      expect(run.ok).toBe(true);
      const stepNames = run.steps.map((step) => `${step.name}:${step.status}`);
      // build:completed requires the updater's real-run JSON to carry a
      // parseable `status` — a build:warning here means the UpdateRunResult
      // contract drifted (channel-sync could no longer tell revert from
      // success), which is exactly what this tier must catch.
      expect(stepNames, `steps were: ${stepNames.join(", ")}`).toContain(
        "build:completed",
      );
      expect(stepNames).toContain("verify:completed");

      // Recorded dev intent: a real 40-hex main-branch commit.
      const state = store.readState();
      expect(state.applied?.channel).toBe("dev");
      expect(state.applied?.sha).toMatch(kFullShaShape);

      // The real checkout the updater produced.
      const checkoutDir = path.join(rootDir, "openclaw");
      expect(fs.existsSync(path.join(checkoutDir, ".git"))).toBe(true);
      const checkoutBin = store.resolvePackageBin(checkoutDir);
      expect(checkoutBin, "dev checkout must expose a runnable bin").toBeTruthy();

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

      // Execute the REAL freshly built dev binary through the shim.
      const output = execFileSync(store.shimPath, ["--version"], {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENCLAW_HOME: rootDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
        },
      });
      expect(output).toMatch(/\d{4}\.\d+\.\d+/);
    },
  );
});
