const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  kRootDir,
  OPENCLAW_DIR,
  kNpmPackageRoot,
  kOpenclawReleaseChannels,
  kOpenclawBackupsDir,
  kOpenclawBackupKeepCount,
  kOpenclawBackupTimeoutMs,
  kOpenclawApplyTimeoutMs,
  kOpenclawStabilizationWindowMs,
  kOpenclawAcceptanceHoldMs,
  kOpenclawDevMinDiskBytes,
  kOpenclawPackageMinDiskBytes,
} = require("./constants");
const {
  readOpenclawReleaseChannel,
  readAlphaclawConfig,
} = require("./alphaclaw-config");
const {
  resolveOpenclawConfigPath,
  updateOpenclawConfig,
} = require("./openclaw-config");
const {
  createOpenclawReleaseChannelStore,
} = require("./openclaw-release-channel");
const { createRunLedger } = require("./openclaw-run-ledger");
const { createRunStream } = require("./openclaw-run-stream");
const { installOpenclawVersionToTempDir } = require("./openclaw-version");
const { resolveSelfDependency } = require("./self-dependency");
const { compareVersionParts, isPrereleaseVersion } = require("./helpers");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");
const { resolveThinkingModulePath } = require("./openclaw-thinking");

const kLogPrefix = "[openclaw-channel]";
// Pins git/npm config lookups away from agent-writable HOME dotfiles.
const kDevNullPath = process.platform === "win32" ? "NUL" : "/dev/null";

// Error envelope shared by every channel API failure: problem + cause + fix.
// `extra` carries additive envelope fields (e.g. repairApplicable: true on
// failures where `openclaw update repair` genuinely helps — the UI shows its
// repair advice only when the server says so).
const channelError = (code, message, hint = null, docsUrl = null, extra = null) => ({
  ok: false,
  code,
  message,
  hint,
  docsUrl,
  ...(extra || {}),
});

// packageRoot must be the CONSUMER APP root (the package.json that declares
// the openclaw dependency) — constants.kPackageRoot is lib/, which has no
// package.json; using it left pinVersion null and the rollback floor missing.
const readDeclaredPin = ({ fsModule = fs, packageRoot = kNpmPackageRoot } = {}) => {
  try {
    const pkg = JSON.parse(
      fsModule.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    return pkg?.dependencies?.openclaw || null;
  } catch {
    return null;
  }
};

// The workspace git-auth shim (GIT_ASKPASS + credential helpers installed by
// bin/alphaclaw.js) is scoped to the user's workspace repo. The openclaw
// checkout fetch must never route through it.
const stripGitShimEnv = (env) => {
  const next = { ...env };
  delete next.GIT_ASKPASS;
  // HOME points at the agent-writable data volume: a planted ~/.gitconfig
  // (url.insteadOf) or ~/.npmrc (registry=) could redirect the checkout fetch
  // or pnpm's registry. Pin both AWAY from dotfiles instead of deleting.
  next.GIT_CONFIG_GLOBAL = kDevNullPath;
  next.GIT_CONFIG_NOSYSTEM = "1";
  next.npm_config_userconfig = kDevNullPath;
  next.GIT_TERMINAL_PROMPT = "0";
  return next;
};

// Minimal engines gate: only hard-reject when the requirement names a major
// version floor we clearly do not meet. Anything unparseable passes (warn-only
// posture — npm itself only warns on engines).
const enginesSatisfied = (enginesNode, nodeVersion) => {
  const spec = String(enginesNode || "").trim();
  if (!spec) return true;
  const match = spec.match(/>=\s*(\d+)/);
  if (!match) return true;
  const requiredMajor = Number.parseInt(match[1], 10);
  const currentMajor = Number.parseInt(String(nodeVersion).replace(/^v/, ""), 10);
  if (!Number.isFinite(requiredMajor) || !Number.isFinite(currentMajor)) {
    return true;
  }
  return currentMajor >= requiredMajor;
};

// Candidate code — a not-yet-accepted download's --version probe, or upstream
// build scripts run by the dev channel — must not inherit the gateway env:
// it carries provider API keys, and verification exists precisely because the
// code is not trusted yet. Probes get a bare environment; dev builds add the
// OpenClaw/tooling variables they need, still without secrets.
const kProbeEnvKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
];
const kDevEnvAllowPrefixes = ["OPENCLAW_", "XDG_", "COREPACK_", "npm_config_"];

const buildProbeEnv = (source) => {
  const env = {};
  for (const key of kProbeEnvKeys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
};

const kSecretShapedKeyPattern = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE)/i;

const buildDevUpdateEnv = (source) => {
  const env = buildProbeEnv(source);
  for (const [key, value] of Object.entries(source)) {
    if (!kDevEnvAllowPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    // The prefix allowlist still admits OPENCLAW_GATEWAY_TOKEN and channel
    // credentials — the not-yet-verified checkout's build scripts must not
    // inherit those. The updater itself needs paths/flags, not secrets.
    if (kSecretShapedKeyPattern.test(key)) continue;
    env[key] = value;
  }
  // The workspace git-auth shim must never serve the openclaw checkout, and a
  // fetch must never hang on a credential prompt.
  return stripGitShimEnv(env);
};

const createOpenclawChannelSync = ({
  fsModule = fs,
  rootDir = kRootDir,
  openclawDir = OPENCLAW_DIR,
  packageRoot = kNpmPackageRoot,
  store = null,
  runStream = null,
  runLedger = null,
  installToTempDir = installOpenclawVersionToTempDir,
  resolveInstallDir = () => resolveSelfDependency({ fsImpl: fs }).installDir,
  gatewayEnv = () => process.env,
  readReleaseChannel = () => readOpenclawReleaseChannel({ openclawDir }),
  releases = null,
  isOnboarded = () => false,
  restartProcess = null,
  isSelfUpdateInProgress = () => false,
  clearVersionCache = () => {},
  notify = null,
  insertEvent = null,
  operationEvents = null,
  watchdogLatch = null,
  watchdogManagedOperation = null,
  nowFn = Date.now,
  logger = console,
  backupsDir = kOpenclawBackupsDir,
  stabilizationWindowMs = kOpenclawStabilizationWindowMs,
  acceptanceHoldMs = kOpenclawAcceptanceHoldMs,
} = {}) => {
  const channelStore =
    store ||
    createOpenclawReleaseChannelStore({ fsModule, rootDir, openclawDir, nowFn, logger });
  const baseRunner = runStream || createRunStream({ fsModule });
  const ledger =
    runLedger || createRunLedger({ fsModule, openclawDir, nowFn, logger });
  // During an apply, every child command's output tees into the operation's
  // durable log sink — including the dev-channel helpers that pass their own
  // legacy logFile. Outside an apply, activeSink is null and this is a
  // pass-through. Observer failures must never break the run itself.
  let activeSink = null;
  const runner = {
    runStreamed: (opts = {}) =>
      baseRunner.runStreamed({
        ...opts,
        onOutput: (chunk, streamName) => {
          try {
            activeSink?.write(chunk);
          } catch {}
          try {
            opts.onOutput?.(chunk, streamName);
          } catch {}
        },
      }),
  };
  const checkoutDir =
    process.env.OPENCLAW_GIT_DIR || path.join(rootDir, "openclaw");

  let applyInProgress = false;
  let pendingRollbackRestart = false;
  let firstHealthyAt = null;
  const pendingNotifications = [];
  // Probe HOME is an isolated temp dir: candidate code must not get
  // $HOME-relative reads into the data volume (.openclaw state, .env).
  let probeHomeDir = null;
  const probeEnv = () => {
    const env = buildProbeEnv(process.env);
    try {
      if (!probeHomeDir) {
        probeHomeDir = fs.mkdtempSync(
          path.join(require("os").tmpdir(), "openclaw-probe-home-"),
        );
      }
      env.HOME = probeHomeDir;
    } catch {}
    return env;
  };
  const devUpdateEnv = () => buildDevUpdateEnv(gatewayEnv());

  const log = (message) => {
    try {
      logger.log(`${kLogPrefix} ${message}`);
    } catch {}
  };

  // opts carries the lifecycle envelope: { eventType, operationId, id }.
  // The server-side notify (wired in lib/server.js) routes envelopes through
  // the durable outbox, so delivery survives the activation restart and a
  // notifier {ok:false} is retried instead of silently acknowledged.
  const queueNotify = (message, opts = {}) => {
    if (typeof notify === "function") {
      Promise.resolve()
        .then(() => notify(message, opts))
        .catch(() => {});
      return;
    }
    // Pre-server (bin) instance: persisted into state.lastBoot.notifications
    // by syncAtBoot; the server instance delivers them after boot.
    pendingNotifications.push({ message, ...opts });
  };

  const flushBootNotifications = async () => {
    if (typeof notify !== "function") return;
    // Boot-time warnings/notifications were queued in the pre-server (bin)
    // instance; they persist in state.lastBoot for this instance to surface.
    try {
      const state = channelStore.readState();
      const lastBoot = state.lastBoot;
      const bootNotifications = Array.isArray(lastBoot?.notifications)
        ? lastBoot.notifications
        : [];
      const bootWarnings = Array.isArray(lastBoot?.warnings)
        ? lastBoot.warnings
        : [];
      if (lastBoot && !lastBoot.notifiedAt) {
        if (bootNotifications.length > 0) {
          // Full user-facing wording queued by the bin-process boot sync.
          // Entries are envelopes ({message, eventType, operationId}) since
          // the outbox landed; bare strings are the pre-outbox legacy shape.
          for (const entry of bootNotifications) {
            if (entry && typeof entry === "object" && entry.message) {
              await notify(entry.message, entry);
            } else {
              await notify(String(entry));
            }
          }
        } else if (bootWarnings.length > 0) {
          await notify(
            [
              "🐺 *AlphaClaw* — OpenClaw version notes from startup:",
              ...bootWarnings.map((w) => `• ${w}`),
            ].join("\n"),
          );
        }
        if (bootNotifications.length > 0 || bootWarnings.length > 0) {
          // The boot-time rollback happened in the bin process where the
          // events DB is not wired — backfill the incident-timeline row here.
          if (lastBoot.action === "rollback") {
            logEvent("channel_rollback_boot", "completed", {
              at: lastBoot.at,
              warnings: bootWarnings,
            });
          }
          channelStore.updateState((s) => {
            if (s.lastBoot) s.lastBoot.notifiedAt = nowFn();
            return s;
          });
        }
      }
    } catch {}
  };

  const logEvent = (type, status, detail) => {
    try {
      if (typeof insertEvent === "function") {
        insertEvent({
          eventType: type,
          source: "release_channel",
          status,
          details: detail || {},
          correlationId: "",
        });
      }
    } catch {}
  };

  // ---------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------

  const appliedId = (applied) =>
    applied ? (applied.channel === "dev" ? applied.sha : applied.version) : null;

  const getChannelInfo = () => {
    const state = channelStore.readState();
    const installDir = safeInstallDir();
    const installedVersion = installDir
      ? channelStore.readInstalledVersion({ installDir })
      : null;
    const applied = state.applied;
    const isPin = !applied;
    const acceptedAt = applied?.acceptedAt || null;
    const now = nowFn();
    // Two-tier window: auto-acceptance (120s of health) keeps the 24h
    // rollback window armed — a build that crash-loops at hour 3 still rolls
    // back. An explicit "Mark as good now" disarms it entirely (U7).
    const inStabilizationWindow = Boolean(
      applied &&
        (!acceptedAt ||
          (applied.acceptedSource !== "manual" &&
            now - acceptedAt < stabilizationWindowMs)),
    );
    return {
      releaseChannel: safeReadChannel(),
      installedVersion,
      pinVersion: state.pinVersion,
      applied,
      appliedId: appliedId(applied),
      isPin,
      acceptedAt,
      inStabilizationWindow,
      lastKnownGood: state.lastKnownGood,
      blocklist: state.blocklist,
      lastUpdateRun: state.lastUpdateRun,
      lastBoot: state.lastBoot,
    };
  };

  const safeReadChannel = () => {
    try {
      const channel = readReleaseChannel();
      return kOpenclawReleaseChannels.includes(channel) ? channel : "stable";
    } catch {
      return "stable";
    }
  };

  let installDirMemo;
  const safeInstallDir = () => {
    // Memoize successes only: a transient resolver failure at startup must not
    // pin installDir to null for the process lifetime.
    if (installDirMemo) return installDirMemo;
    try {
      installDirMemo = resolveInstallDir() || null;
    } catch {
      installDirMemo = null;
    }
    return installDirMemo;
  };

  // ---------------------------------------------------------------------
  // Boot sync (fail-open; start-command only; NEVER touches the network)
  // ---------------------------------------------------------------------

  const reconcileOpenclawJsonMirror = (channel) => {
    try {
      // Only mirror into a config that exists AND parses. readOpenclawConfig's
      // {}-fallback would turn a missing config (fresh install, or one waiting
      // for the git-sync restore later in boot) or a torn write into a 4-line
      // stub that clobbers the user's channels/settings and defeats the
      // restore path's exists-check.
      const configPath = resolveOpenclawConfigPath({ openclawDir });
      let parsed;
      try {
        parsed = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
      } catch (error) {
        log(`mirror reconcile skipped: openclaw.json missing or unreadable (${error.message})`);
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        log("mirror reconcile skipped: openclaw.json is not an object");
        return;
      }
      const update =
        parsed.update && typeof parsed.update === "object" ? parsed.update : {};
      const auto =
        update.auto && typeof update.auto === "object" ? update.auto : {};
      const nextUpdate = {
        ...update,
        channel,
        auto: { ...auto, enabled: false },
      };
      if (
        JSON.stringify(parsed.update || null) !== JSON.stringify(nextUpdate)
      ) {
        // Locked read-modify-write: openclaw.json has other writers (CLI
        // crons, the telegram-workspace sync) — an unserialized RMW here
        // could drop their update even with an atomic write.
        updateOpenclawConfig({
          fsModule,
          openclawDir,
          mutate: (config) => {
            const liveUpdate =
              config.update && typeof config.update === "object"
                ? config.update
                : {};
            const liveAuto =
              liveUpdate.auto && typeof liveUpdate.auto === "object"
                ? liveUpdate.auto
                : {};
            config.update = {
              ...liveUpdate,
              channel,
              auto: { ...liveAuto, enabled: false },
            };
          },
        });
        log(`openclaw.json update.channel mirrored to "${channel}"`);
      }
    } catch (error) {
      log(`mirror reconcile skipped: ${error.message}`);
    }
  };

  const readCheckoutHead = () => {
    try {
      const headRaw = fsModule
        .readFileSync(path.join(checkoutDir, ".git", "HEAD"), "utf8")
        .trim();
      if (!headRaw.startsWith("ref: ")) return headRaw;
      const ref = headRaw.slice(5).trim();
      try {
        return fsModule
          .readFileSync(path.join(checkoutDir, ".git", ref), "utf8")
          .trim();
      } catch {
        // The ref may live only in packed-refs (git packs loose refs over
        // time; verified against a real updater-produced checkout).
        const packed = fsModule.readFileSync(
          path.join(checkoutDir, ".git", "packed-refs"),
          "utf8",
        );
        for (const line of packed.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) {
            continue;
          }
          const spaceIndex = trimmed.indexOf(" ");
          if (spaceIndex > 0 && trimmed.slice(spaceIndex + 1) === ref) {
            return trimmed.slice(0, spaceIndex);
          }
        }
        return null;
      }
    } catch {
      return null;
    }
  };

  const checkoutBuildReady = () => {
    const bin = channelStore.resolvePackageBin(checkoutDir);
    return bin && fsModule.existsSync(bin) ? bin : null;
  };

  // A bare version match must never certify a tree: package.json is copied
  // early, so a crash mid-copy leaves a plausible version over a gutted tree
  // (the sentinel-clear-before-copy fix makes exactly this state reachable).
  const pinTreeLooksComplete = (installDir) => {
    const packageDir = path.join(installDir, "node_modules", "openclaw");
    const bin = channelStore.resolvePackageBin(packageDir);
    return Boolean(
      bin &&
        fsModule.existsSync(bin) &&
        fsModule.existsSync(path.join(packageDir, "dist")),
    );
  };

  const activatePinFallback = ({ installDir, state, warnings, reason }) => {
    channelStore.removeBinShim();
    const installedVersion = channelStore.readInstalledVersion({ installDir });
    if (
      installedVersion &&
      state.pinVersion &&
      installedVersion === state.pinVersion &&
      pinTreeLooksComplete(installDir)
    ) {
      channelStore.writeSentinel({ installDir, version: state.pinVersion });
      warnings.push(reason);
      return true;
    }
    if (state.pinVersion && channelStore.hasOverlay(state.pinVersion)) {
      const result = channelStore.activateOverlay({
        installDir,
        version: state.pinVersion,
      });
      warnings.push(reason);
      if (!result.ok) warnings.push(`pin activation failed: ${result.error}`);
      return result.ok;
    }
    warnings.push(
      `${reason}; pin tree unavailable locally — running whatever is installed`,
    );
    return false;
  };

  // Fully synchronous by design: boot activation is offline (overlay store +
  // checkout fs checks only), so bin/alphaclaw.js can run it inline before its
  // remaining synchronous startup sections without restructuring the boot flow.
  const kConcurrentGraceMs = 3000;
  const sleepSync = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
  };

  const syncAtBoot = () => {
    const warnings = [];
    let action = "none";
    try {
      // Single-instance guard: a second `alphaclaw start` beside a live
      // server would run this DESTRUCTIVE sync (rm+cp over the tree the live
      // gateway executes from, marker consumption, interrupted-run closing)
      // before dying on the port bind. A VPS respawn handoff briefly overlaps
      // its predecessor, so give a dying process a short grace to exit.
      // Real wall clock on purpose: nowFn is an injectable LOGICAL clock in
      // tests and may never advance — this loop must always terminate.
      const deadline = Date.now() + kConcurrentGraceMs;
      let livePid = channelStore.readLiveServerPid();
      while (livePid && Date.now() < deadline) {
        sleepSync(300);
        livePid = channelStore.readLiveServerPid();
      }
      if (livePid) {
        log(
          `boot sync skipped: another alphaclaw server (pid ${livePid}) is live`,
        );
        return { ok: false, action: "skipped_concurrent", livePid };
      }
      // Claim the instance pidfile NOW, not at server start — the window
      // between this guard and lib/server.js is exactly where a simultaneous
      // second start would begin its own destructive sync.
      channelStore.writeServerPid();
      const installDir = safeInstallDir();
      if (!installDir) {
        log("boot sync skipped: install dir unresolved");
        return { ok: false, action: "skipped" };
      }
      const channel = safeReadChannel();
      let state = channelStore.readState();
      // Ledger first: runs still "running" here died with their process
      // (restart_expected runs are NOT touched — the activation branch below
      // resolves them by whether their target actually came up).
      try {
        ledger.closeInterruptedRuns();
      } catch {}
      // A process death mid-apply (OOM during a dev build, host reboot) leaves
      // lastUpdateRun.finishedAt = null forever; the UI would resurrect it as
      // a phantom in-flight operation and lock every action. Close it here —
      // boot is single-process, so nothing can still be running it.
      if (state.lastUpdateRun && state.lastUpdateRun.finishedAt == null) {
        warnings.push("closed an update run interrupted by a restart");
        state = channelStore.updateState((s) => {
          if (s.lastUpdateRun && s.lastUpdateRun.finishedAt == null) {
            s.lastUpdateRun.finishedAt = nowFn();
            s.lastUpdateRun.ok = false;
            s.lastUpdateRun.result = {
              ok: false,
              code: "interrupted",
              message: "AlphaClaw restarted before the update finished.",
              hint: "Nothing was activated. Start the update again from the Upgrade page.",
              docsUrl: null,
            };
          }
          return s;
        });
      }
      if (state.corrupted) {
        warnings.push("channel state file was corrupted — reset to defaults");
        queueNotify(
          "⚠️ OpenClaw channel state file was corrupted and has been reset. Running the built-in stable version.",
        );
      }

      // Bin shim must never dangle: every `openclaw` invocation (including
      // watchdog repair) resolves through it when present.
      const shimCheck = channelStore.validateBinShim();
      if (shimCheck.removed) {
        warnings.push("removed dangling openclaw bin shim");
      }

      // Self-update pin reconciliation: a changed declared pin is a legitimate
      // AlphaClaw upgrade, not external drift.
      const declaredPin = readDeclaredPin({ fsModule, packageRoot });
      if (declaredPin && !state.pinVersion) {
        state = channelStore.updateState((s) => {
          s.pinVersion = declaredPin;
          return s;
        });
      } else if (declaredPin && state.pinVersion !== declaredPin) {
        log(
          `pin changed ${state.pinVersion} -> ${declaredPin} (AlphaClaw self-update)`,
        );
        state = channelStore.updateState((s) => {
          s.pinVersion = declaredPin;
          if (
            s.applied &&
            s.applied.channel === "stable" &&
            compareVersionParts(s.applied.version, declaredPin) < 0
          ) {
            // The new shipped pin supersedes an older explicit stable pick.
            s.applied = null;
          }
          return s;
        });
        const installedVersion = channelStore.readInstalledVersion({
          installDir,
        });
        if (installedVersion === declaredPin) {
          channelStore.snapshotPinFromInstall({
            installDir,
            pinVersion: declaredPin,
          });
        }
        action = "pin_reconciled";
      }

      // Rollback marker: activate its (already validated) target, offline.
      const marker = channelStore.readMarker();
      if (marker && marker.target) {
        action = "rollback";
        const target = marker.target;
        if (target.kind === "package" && target.version) {
          // Record what ACTUALLY ended up active: if overlay activation falls
          // back to the pin, `applied` must not claim the target is running —
          // a later pin crash would blocklist a build that isn't live, and
          // every boot would re-detect phantom drift.
          let targetActivated = false;
          if (channelStore.hasOverlay(target.version)) {
            const result = channelStore.activateOverlay({
              installDir,
              version: target.version,
            });
            if (!result.ok) {
              activatePinFallback({
                installDir,
                state,
                warnings,
                reason: `rollback overlay activation failed (${result.error}) — using pin`,
              });
            } else {
              targetActivated = true;
              channelStore.removeBinShim();
            }
          } else {
            activatePinFallback({
              installDir,
              state,
              warnings,
              reason: "rollback target overlay missing — using pin",
            });
          }
          state = channelStore.updateState((s) => {
            s.applied =
              !targetActivated || target.version === s.pinVersion
                ? null
                : {
                    channel: target.channel || "stable",
                    version: target.version,
                    at: nowFn(),
                    // A last-known-good target was already accepted once;
                    // it re-enters a fresh stabilization window regardless.
                    acceptedAt: nowFn(),
                  };
            return s;
          });
        } else {
          // Pin target: the container image reset usually restored it already;
          // on VPS installs activate the pin snapshot explicitly.
          activatePinFallback({
            installDir,
            state,
            warnings,
            reason: "rolled back to the built-in pin",
          });
          state = channelStore.updateState((s) => {
            s.applied = null;
            return s;
          });
        }
        channelStore.clearMarker();
        queueNotify(
          `🟡 OpenClaw rolled back after ${marker.reason || "a failure"} on ${marker.blockedId || "the previous build"}. Now running ${
            target.kind === "pin" ? `the built-in ${state.pinVersion}` : target.version
          }. The broken build was blocklisted — see the Upgrade page.`,
        );
        logEvent("channel_rollback_boot", "completed", marker);
      } else {
        // Normal boot: re-apply the recorded selection (D2 — never fetch).
        const applied = channelStore.readState().applied;
        if (!applied) {
          // Pin. Detect external drift on persistent installs.
          const installedVersion = channelStore.readInstalledVersion({
            installDir,
          });
          if (
            installedVersion &&
            state.pinVersion &&
            installedVersion !== state.pinVersion &&
            action === "pin_reconciled"
          ) {
            // The pin changed via the declared dependency THIS boot (AlphaClaw
            // self-update) and node_modules has not been reinstalled yet —
            // expected lag, not external drift. Accusing the user's agent of
            // tampering here is false and alarming.
            warnings.push(
              `installed ${installedVersion} lags the new pin ${state.pinVersion} until npm reconciles — not external drift`,
            );
          } else if (
            installedVersion &&
            state.pinVersion &&
            installedVersion !== state.pinVersion
          ) {
            action = "drift_reverted";
            const reverted = activatePinFallback({
              installDir,
              state,
              warnings,
              reason: `installed ${installedVersion} != pin ${state.pinVersion} without a recorded apply`,
            });
            queueNotify(
              `⚠️ OpenClaw was changed outside this dashboard (found ${installedVersion}, possibly by your agent). ${
                reverted
                  ? `Reverted to your selection (${state.pinVersion}).`
                  : "Could not revert automatically — open the Upgrade page."
              }`,
            );
          } else if (
            state.pinVersion &&
            channelStore.needsActivation({
              installDir,
              expectedVersion: state.pinVersion,
            })
          ) {
            // Missing sentinel on the pin path can mean a crashed activation
            // left a partial tree behind a plausible package.json — re-copy
            // from the complete pin overlay when available; only stamp a
            // structurally complete tree.
            if (
              channelStore.hasOverlay(state.pinVersion) &&
              !pinTreeLooksComplete(installDir)
            ) {
              const repair = channelStore.activateOverlay({
                installDir,
                version: state.pinVersion,
              });
              if (!repair.ok) {
                warnings.push(
                  `pin re-activation failed (${repair.error}) — running whatever is installed`,
                );
              } else {
                warnings.push("re-activated the pin from its overlay (sentinel was missing)");
              }
            } else if (pinTreeLooksComplete(installDir)) {
              channelStore.writeSentinel({
                installDir,
                version: state.pinVersion,
              });
            } else {
              warnings.push(
                "pin tree looks incomplete and no pin overlay exists — not certifying it",
              );
            }
          }
          channelStore.removeBinShim();
        } else if (applied.channel === "dev") {
          const head = readCheckoutHead();
          const bin = checkoutBuildReady();
          const headMatches =
            head && applied.sha && head.startsWith(applied.sha.slice(0, 7));
          if (headMatches && bin) {
            const shim = channelStore.writeBinShim({
              targetBin: bin,
              label: `dev ${applied.sha.slice(0, 7)}`,
            });
            if (!shim.ok) {
              activatePinFallback({
                installDir,
                state,
                warnings,
                reason: `dev shim write failed (${shim.error}) — using pin`,
              });
            } else {
              action = "dev_shim";
            }
          } else {
            action = "dev_unavailable";
            activatePinFallback({
              installDir,
              state,
              warnings,
              reason:
                "dev checkout unavailable or stale — open the Upgrade page to rebuild",
            });
            // The pin is what actually runs now: keeping `applied` pointing at
            // the lost dev sha would make a re-apply of that sha a false noop
            // and mark it "current" in the catalog. lastKnownGood.dev keeps
            // the rebuild target.
            state = channelStore.updateState((s) => {
              s.applied = null;
              return s;
            });
            queueNotify(
              "⚠️ The OpenClaw dev build could not be restored at startup — running the built-in stable version. Open the Upgrade page to rebuild.",
            );
          }
        } else {
          // Package channel (stable pick or beta): sentinel decides — and the
          // live tree's version must also match, or something rewrote
          // node_modules without touching the sentinel (npm reconciling back
          // to the pin, partial image update, agent tampering).
          const installedNow = channelStore.readInstalledVersion({ installDir });
          if (
            channelStore.needsActivation({
              installDir,
              expectedVersion: applied.version,
            }) ||
            (installedNow && installedNow !== applied.version)
          ) {
            if (channelStore.hasOverlay(applied.version)) {
              const result = channelStore.activateOverlay({
                installDir,
                version: applied.version,
              });
              action = result.ok ? "activated" : "activation_failed";
              if (!result.ok) {
                activatePinFallback({
                  installDir,
                  state,
                  warnings,
                  reason: `overlay activation failed (${result.error}) — using pin`,
                });
                // The PIN is what actually runs: `applied` must not keep
                // claiming the pick, or the watchdog blocklists (and
                // acceptance "verifies") a build that never ran.
                state = channelStore.updateState((s) => {
                  s.applied = null;
                  return s;
                });
                queueNotify(
                  `⚠️ Could not activate OpenClaw ${applied.version} at startup — running the built-in stable version instead. Open the Upgrade page to retry.`,
                );
              }
            } else {
              action = "overlay_missing";
              activatePinFallback({
                installDir,
                state,
                warnings,
                reason: `overlay for ${applied.version} missing — using pin`,
              });
              // Same applied-must-match-reality rule as the branch above.
              state = channelStore.updateState((s) => {
                s.applied = null;
                return s;
              });
              queueNotify(
                `⚠️ The saved OpenClaw ${applied.version} build is missing from disk — running the built-in stable version. Open the Upgrade page to re-apply.`,
              );
            }
          } else {
            action = action === "none" ? "already_active" : action;
          }
          channelStore.removeBinShim();
        }
      }

      // Resolve a run that intentionally spanned this restart: activation is
      // the run's real outcome, not "interrupted". Fail-open — a ledger issue
      // must never block the boot sync.
      try {
        const bootActivated =
          action === "activated" || action === "already_active";
        const bootFellBack =
          action === "activation_failed" ||
          action === "overlay_missing" ||
          action === "dev_unavailable";
        if (bootActivated || bootFellBack) {
          ledger.resolveRestartExpected({
            activated: bootActivated,
            detail: warnings.join("; ") || null,
          });
        } else {
          // A pin-targeted apply leaves `applied` null and the boot action
          // "none" — resolve by whether the run's target is what's actually
          // installed now, so no run hangs in restart_expected forever.
          const pending = ledger
            .listRuns()
            .find((run) => run.state === "restart_expected");
          if (pending) {
            const installedNow = channelStore.readInstalledVersion({
              installDir,
            });
            ledger.resolveRestartExpected({
              activated: Boolean(
                pending.target?.version &&
                  installedNow === pending.target.version,
              ),
              detail: warnings.join("; ") || null,
            });
          }
        }
        ledger.pruneRuns();
      } catch {}
      reconcileOpenclawJsonMirror(channel);
      channelStore.updateState((s) => {
        // Notifications queued in the pre-server (bin) instance die with it;
        // persisting them lets the server instance deliver the full wording.
        s.lastBoot = {
          at: nowFn(),
          action,
          warnings,
          notifications: pendingNotifications.slice(),
        };
        return s;
      });
      for (const warning of warnings) log(`boot: ${warning}`);
      log(`boot sync done (action=${action})`);
      return { ok: true, action, warnings };
    } catch (error) {
      // Fail-open: the Setup UI must always come up.
      log(`boot sync failed (fail-open): ${error.message}`);
      // Queue BEFORE persisting lastBoot: in the bin process the notification
      // only survives via lastBoot.notifications, so ordering matters.
      queueNotify(
        `⚠️ OpenClaw channel startup check failed (${error.message}). Running the installed version.`,
      );
      try {
        channelStore.updateState((s) => {
          s.lastBoot = {
            at: nowFn(),
            action: "failed",
            warnings: [...warnings, error.message],
            notifications: pendingNotifications.slice(),
          };
          return s;
        });
      } catch {}
      return { ok: false, action: "failed", error: error.message };
    }
  };

  // ---------------------------------------------------------------------
  // Acceptance (post-boot stabilization) — driven by watchdog health checks
  // ---------------------------------------------------------------------

  const onGatewayHealthy = () => {
    try {
      const state = channelStore.readState();
      const applied = state.applied;
      if (!applied || applied.acceptedAt) return;
      const now = nowFn();
      if (!firstHealthyAt) firstHealthyAt = now;
      if (now - firstHealthyAt >= acceptanceHoldMs) {
        markGoodNow({ source: "acceptance" });
      }
    } catch {}
  };

  const onGatewayUnhealthy = () => {
    firstHealthyAt = null;
  };

  const markGoodNow = ({ source = "manual" } = {}) => {
    const state = channelStore.updateState((s) => {
      if (!s.applied) return s;
      s.applied.acceptedAt = s.applied.acceptedAt || nowFn();
      // Manual always wins: an operator's explicit mark-good upgrades an
      // earlier auto-acceptance and disarms the remaining window.
      if (source === "manual" || !s.applied.acceptedSource) {
        s.applied.acceptedSource = source;
      }
      const id = appliedId(s.applied);
      if (s.applied.channel === "dev") {
        s.lastKnownGood.dev = id;
      } else {
        s.lastKnownGood.package = id;
      }
      return s;
    });
    if (state.applied?.acceptedAt) {
      log(`accepted ${appliedId(state.applied)} (${source})`);
      logEvent("channel_accepted", "completed", {
        id: appliedId(state.applied),
        source,
      });
      if (source === "acceptance") {
        queueNotify(
          `🟢 OpenClaw ${appliedId(state.applied)} is healthy — activation verified.`,
        );
      }
      return { ok: true, acceptedAt: state.applied.acceptedAt };
    }
    return channelError(
      "nothing_to_accept",
      "No pending version to mark as good — you are on the built-in stable version.",
    );
  };

  // ---------------------------------------------------------------------
  // Rollback (watchdog-triggered or explicit)
  // ---------------------------------------------------------------------

  const requestChannelRollback = ({ reason = "failure", exitCode = null } = {}) => {
    const state = channelStore.readState();
    const applied = state.applied;
    if (!applied) {
      return channelError(
        "nothing_to_roll_back",
        "Already running the built-in stable version.",
      );
    }
    const blockedId = appliedId(applied);
    channelStore.addBlocklist({ id: blockedId, reason, exitCode });

    // Dev builds always roll back to the pin floor — never an in-crash
    // rebuild. Package channels prefer the last-known-good overlay.
    const usableLkg = () => {
      const lkg = state.lastKnownGood.package;
      return lkg &&
        lkg !== blockedId &&
        !channelStore.isBlocklisted(lkg) &&
        channelStore.hasOverlay(lkg)
        ? lkg
        : null;
    };
    let target = { kind: "pin" };
    if (applied.channel !== "dev") {
      const lkg = usableLkg();
      if (lkg) {
        target = { kind: "package", channel: applied.channel, version: lkg };
      }
    }
    if (target.kind === "pin") {
      // On VPS installs the pin tree may not exist locally (pin bumped by a
      // self-update while a non-pin build was active). A pin rollback that
      // cannot materialize would leave the broken build running — prefer a
      // usable last-known-good overlay over an unrecoverable pin.
      const installDir = safeInstallDir();
      const installedVersion = installDir
        ? channelStore.readInstalledVersion({ installDir })
        : null;
      const pinRecoverable = Boolean(
        state.pinVersion &&
          (channelStore.hasOverlay(state.pinVersion) ||
            installedVersion === state.pinVersion),
      );
      if (!pinRecoverable) {
        const lkg = usableLkg();
        if (lkg) {
          target = { kind: "package", channel: "stable", version: lkg };
        }
      }
    }

    const marker = {
      target,
      blockedId,
      reason,
      exitCode,
      at: nowFn(),
    };
    const written = channelStore.writeMarker(marker);
    if (!written.ok) {
      // A restart without a marker would re-apply the broken build in a loop.
      log(`rollback marker write FAILED: ${written.error} — latching`);
      if (typeof watchdogLatch === "function") {
        try {
          watchdogLatch({ reason: "rollback_marker_write_failed" });
        } catch {}
      }
      queueNotify(
        `🔴 OpenClaw ${blockedId} is failing (${reason}) and the rollback marker could not be written (${written.error}). Automatic restart is paused — manual action required on the Upgrade page.`,
      );
      logEvent("channel_rollback", "failed", { ...marker, error: written.error });
      return channelError(
        "rollback_marker_write_failed",
        `Could not write the rollback marker: ${written.error}`,
        "Free disk space on the data volume, then restart AlphaClaw.",
      );
    }

    logEvent("channel_rollback", "requested", marker);
    queueNotify(
      `🔴 OpenClaw ${blockedId} (${applied.channel} channel) ${
        reason === "crash_loop" ? "crash-looped" : `failed (${reason})`
      }${exitCode != null ? ` · exit code ${exitCode}` : ""} — rolling back to ${
        target.kind === "pin" ? `the built-in ${state.pinVersion}` : target.version
      }. The broken build was blocklisted. AlphaClaw is restarting.`,
    );
    if (applyInProgress) {
      // A restartProcess() mid-overlay-write corrupts the store; the marker is
      // on disk, so finishing (or failing) the apply and THEN restarting loses
      // nothing.
      pendingRollbackRestart = true;
      log("rollback restart deferred until the in-flight apply settles");
    } else if (typeof restartProcess === "function") {
      setTimeout(() => {
        try {
          restartProcess();
        } catch {}
      }, 1000).unref?.();
    }
    return { ok: true, target, blockedId };
  };

  // ---------------------------------------------------------------------
  // Explicit apply flow (prepare + verify + record + restart)
  // ---------------------------------------------------------------------

  const stepRecorder = (operationId, sink = null) => {
    const steps = [];
    const emit = (name, status, detail = {}) => {
      // Core fields LAST so a detail key (e.g. the updater's own status) can
      // never clobber the step's status — live-verified failure mode where a
      // failed build recorded as "unknown".
      const entry = { ...detail, name, status, at: nowFn() };
      steps.push(entry);
      try {
        if (operationEvents && operationId) {
          operationEvents.publish(operationId, {
            event: "step",
            data: entry,
          });
        }
      } catch {}
      try {
        channelStore.updateState((s) => {
          if (s.lastUpdateRun) s.lastUpdateRun.steps = steps;
          return s;
        });
      } catch {}
      try {
        ledger.updateRun(operationId, (record) => {
          record.steps = steps;
          return record;
        });
      } catch {}
      try {
        sink?.writeLine(
          `[openclaw-update] step ${name}: ${status}${
            detail?.error ? ` (${detail.error})` : ""
          }`,
        );
      } catch {}
      // The [openclaw-channel] prefix makes container logs (Render/Railway)
      // searchable for update progress.
      log(`apply step ${name}: ${status}`);
    };
    return { steps, emit };
  };

  const checkDiskSpace = (requiredBytes, dir = rootDir) => {
    try {
      const stats = fsModule.statfsSync(dir);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(free) && free < requiredBytes) {
        return { ok: false, free };
      }
      return { ok: true, free };
    } catch {
      return { ok: true, free: null };
    }
  };

  // Temp trees are multi-hundred-MB; deleting them synchronously would block
  // the live event loop (SSE progress, proxied gateway traffic).
  const cleanupTempInstall = async (tempInstall) => {
    try {
      if (tempInstall?.tmpDir) {
        await (fsModule.promises || fs.promises).rm(tempInstall.tmpDir, {
          recursive: true,
          force: true,
        });
        return;
      }
    } catch {}
    try {
      tempInstall?.cleanup?.();
    } catch {}
  };

  // ── Backup step ──────────────────────────────────────────────────────────
  //
  //   runBackup(opId)
  //     │ ensureBackupsDir()          legacy FILE at dir path? → migrate in
  //     │                             symlink/special? → fail closed
  //     ▼
  //   openclaw backup create --output <dir>/openclaw-backup-<ts>-<opId8>.tar.gz --verify
  //     │                             (CLI contract, verified against the
  //     │                              pinned 2026.7.1-2 package source:
  //     │                              exact path → archive written THERE,
  //     │                              refused if it exists; --verify runs
  //     │                              AFTER the atomic publish)
  //     ▼
  //   exit 0 ── artifact at exact path? ──► record {dir, file, verified} + prune
  //   exit ≠0 ─ classifyBackupFailure ────► honest message; own artifact only:
  //                                         empty → delete, non-empty → .unverified
  //
  // The exact per-run path (uuid suffix — nowFn is frozen in tests) makes
  // artifact identity, failure cleanup, and quarantine deterministic; the
  // pre-fix code passed the fixed directory path itself, which the CLI wrote
  // AS the archive file — first run false-failed the artifact check (#9),
  // every later run hit refuse-to-overwrite (#7).

  const kBackupArchivePattern = /openclaw-backup.*\.tar\.gz$/;

  // Best-effort line into the current run's durable log + console.
  const backupLog = (line) => {
    try {
      activeSink?.writeLine(line);
    } catch {}
    log(line.replace(/^\[openclaw-update\] /, ""));
  };

  const buildBackupOutputFile = (operationId) => {
    const runSuffix =
      String(operationId || "")
        .replace(/[^0-9A-Za-z-]/g, "")
        .slice(0, 8) || crypto.randomUUID().slice(0, 8);
    return path.join(
      backupsDir,
      `openclaw-backup-${nowFn()}-${runSuffix}.tar.gz`,
    );
  };

  // A crash between the staging rename and the final move must never strand
  // the user's only backup: finish any interrupted migration on the next run.
  const recoverStagedMigrations = () => {
    const parent = path.dirname(backupsDir);
    const prefix = `${path.basename(backupsDir)}.migrating-`;
    let entries = [];
    try {
      entries = fsModule.readdirSync(parent);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const staged = path.join(parent, name);
      try {
        const st = fsModule.lstatSync(staged);
        if (!st.isFile()) continue;
        let dest = path.join(
          backupsDir,
          `openclaw-backup-legacy-${Math.round(st.mtimeMs)}.tar.gz`,
        );
        if (fsModule.existsSync(dest)) {
          dest = path.join(
            backupsDir,
            `openclaw-backup-legacy-${Math.round(st.mtimeMs)}-${process.pid}.tar.gz`,
          );
        }
        fsModule.renameSync(staged, dest);
        backupLog(
          `[openclaw-update] backup: recovered staged legacy archive → ${dest}`,
        );
      } catch (error) {
        log(`backup migration recovery failed for ${staged}: ${error.message}`);
      }
    }
  };

  // Self-heal the backups path. Pre-fix releases left a multi-GB archive FILE
  // exactly where the directory must go; it is migrated (renamed, same
  // filesystem, never copied or deleted) into the directory, where keep-N
  // retention owns it. Symlinks fail closed: archives carry credentials and
  // must not be written through a redirect.
  const ensureBackupsDir = () => {
    let st = null;
    try {
      st = fsModule.lstatSync(backupsDir);
    } catch {}
    if (st && st.isDirectory()) {
      recoverStagedMigrations();
      return { ok: true };
    }
    if (st && !st.isFile()) {
      const kind = st.isSymbolicLink() ? "symlink" : "special file";
      return {
        ok: false,
        message: `The pre-update backup was refused: ${backupsDir} is a ${kind}, and backups are only written into a real directory.`,
        hint: `Remove or rename ${backupsDir}, then retry.`,
      };
    }
    if (!st) {
      try {
        fsModule.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // The CLI mkdir -p's the parent itself; if this fails for a real
        // reason the CLI's own error maps honestly below.
        log(`could not create ${backupsDir}: ${error.message}`);
      }
      recoverStagedMigrations();
      return { ok: true };
    }
    const staged = `${backupsDir}.migrating-${process.pid}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      fsModule.renameSync(backupsDir, staged);
      fsModule.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
      const dest = path.join(
        backupsDir,
        `openclaw-backup-legacy-${Math.round(st.mtimeMs)}.tar.gz`,
      );
      fsModule.renameSync(staged, dest);
      backupLog(
        `[openclaw-update] backup: migrated legacy archive ${backupsDir} → ${dest}`,
      );
      return { ok: true, migrated: true };
    } catch (error) {
      try {
        if (!fsModule.existsSync(backupsDir) && fsModule.existsSync(staged)) {
          fsModule.renameSync(staged, backupsDir);
        }
      } catch {}
      // Proceed: the archive survives (original or staged name — recovery
      // picks staged ones up next run) and the CLI failure maps honestly.
      log(`backup legacy migration failed: ${error.message}`);
      return { ok: true, migrationFailed: true };
    }
  };

  const backupArtifactAt = (outputFile) => {
    try {
      const st = fsModule.statSync(outputFile);
      return st.isFile() && st.size > 0 ? outputFile : null;
    } catch {
      return null;
    }
  };

  // The CLI publishes the archive BEFORE --verify runs, so a verify failure
  // leaves a full-size unverified archive at the final path. It must not pose
  // as the newest restore candidate — and a backup is never deleted outright.
  // Only THIS run's artifact is touched; a global prune here could evict the
  // last verified backup.
  const cleanupFailedBackup = (outputFile) => {
    try {
      const st = fsModule.statSync(outputFile);
      if (st.isFile() && st.size === 0) {
        fsModule.unlinkSync(outputFile);
      } else if (st.isFile()) {
        fsModule.renameSync(outputFile, `${outputFile}.unverified`);
        backupLog(
          `[openclaw-update] backup: quarantined unverified archive → ${outputFile}.unverified`,
        );
      }
    } catch {}
    // The CLI's temp is `<outputFile>.<uuid>.tmp` (removed on its own success
    // path) — sweep leftovers from a killed/crashed run.
    try {
      const base = path.basename(outputFile);
      for (const name of fsModule.readdirSync(backupsDir)) {
        if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
          try {
            fsModule.unlinkSync(path.join(backupsDir, name));
          } catch {}
        }
      }
    } catch {}
  };

  const stripAnsi = (value) =>
    String(value).replace(/\[[0-9;]*[A-Za-z]/g, "");

  // One honest message per failure cause. The pre-fix catch-all claimed every
  // CLI failure "failed to verify" and hinted at the wrong subsystem — the
  // exact misdirection issues #7/#9 reported.
  const classifyBackupFailure = (result, { outputFile, gateNoun }) => {
    const tail = String(result.tail || "");
    const lastLine = stripAnsi(
      tail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop() || "",
    ).slice(0, 200);
    const gateHint = `${gateNoun} are blocked without a backup because the rollback target may not read migrated state. Fix the backup or choose a same-channel version.`;
    if (/unknown command|unrecognized|unexpected argument/i.test(tail)) {
      return {
        message: `This OpenClaw version has no backup command, and ${gateNoun.toLowerCase()} require a verified backup.`,
        hint: gateHint,
        stepError: "backup command unavailable",
      };
    }
    if (result.timedOut) {
      return {
        message: `The pre-update backup timed out after ${Math.round(kOpenclawBackupTimeoutMs / 60000)} minutes.`,
        hint: gateHint,
        stepError: "timed out",
      };
    }
    // Only the CLI's own refusal message routes here — a raw EEXIST/ENOTDIR
    // from mkdir names a different path and reads honestly via the generic
    // branch's verbatim last line.
    if (/refus\w*\s+to\s+overwrite/i.test(tail)) {
      return {
        message: `The pre-update backup was refused: a file already exists at ${outputFile}.`,
        hint: `Remove or relocate that file, then retry. ${gateHint}`,
        stepError: lastLine || "refused to overwrite existing archive",
      };
    }
    if (/ENOSPC|no space left/i.test(tail)) {
      return {
        message: "The pre-update backup failed: not enough disk space.",
        hint: `Free up space or delete old backups in ${backupsDir}, then retry. ${gateHint}`,
        stepError: lastLine || "no space left on device",
      };
    }
    if (/verif/i.test(tail)) {
      return {
        message: `The pre-update backup failed to verify${lastLine ? ` — ${lastLine}` : "."}`,
        hint: gateHint,
        stepError: lastLine || "verification failed",
      };
    }
    return {
      message: `The pre-update backup failed${lastLine ? ` — ${lastLine}` : "."}`,
      hint: gateHint,
      stepError: lastLine || "backup command failed",
    };
  };

  const newestArchiveSize = () => {
    try {
      let best = null;
      for (const name of fsModule.readdirSync(backupsDir)) {
        if (!kBackupArchivePattern.test(name)) continue;
        try {
          const st = fsModule.statSync(path.join(backupsDir, name));
          if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = st;
        } catch {}
      }
      return best ? best.size : null;
    } catch {
      return null;
    }
  };

  // hardGate: downgrades, dev switches, and cross-channel/prerelease applies
  // all block on a failed verified backup — those transitions can migrate
  // state formats their rollback target cannot read. Same-channel stable
  // upgrades stay soft-gated (auto-rollback still protects them), but the run
  // record carries noBackup so the UI and notifications can say rollback may
  // be limited.
  const runBackup = async ({
    emit,
    hardGate,
    gateReason = "downgrade",
    operationId = null,
  }) => {
    emit("backup", "running");
    const backupStartedAt = nowFn();
    const gateNoun =
      gateReason === "downgrade"
        ? "Downgrades"
        : gateReason === "dev"
          ? "Dev switches"
          : "Cross-channel updates";
    const dirReady = ensureBackupsDir();
    if (!dirReady.ok) {
      if (hardGate) {
        emit("backup", "failed", { error: dirReady.message });
        return channelError("backup_failed", dirReady.message, dirReady.hint);
      }
      emit("backup", "warning", { error: dirReady.message });
      queueNotify(
        `⚠️ Pre-update backup skipped — continuing (upgrades are protected by auto-rollback, but rollback recovery may be limited). ${dirReady.message}`,
        { eventType: "health", id: `backup-warn-${backupStartedAt}` },
      );
      return { ok: true, warned: true, noBackup: true };
    }
    const outputFile = buildBackupOutputFile(operationId);
    // Space heads-up only (sized from the newest archive) — the CLI's own
    // ENOSPC failure is the honest gate.
    const estimate = newestArchiveSize();
    if (estimate != null) {
      const space = checkDiskSpace(Math.ceil(estimate * 1.5), backupsDir);
      if (!space.ok && Number.isFinite(space.free)) {
        backupLog(
          `[openclaw-update] backup: low disk — ~${Math.round(estimate / 1e6)}MB likely needed, ${Math.round(space.free / 1e6)}MB free`,
        );
      }
    }
    const result = await runner.runStreamed({
      command: "openclaw",
      args: ["backup", "create", "--output", outputFile, "--verify"],
      env: gatewayEnv(),
      timeoutMs: kOpenclawBackupTimeoutMs,
    });
    // Exit 0 alone is not proof: a defective/compromised current build can
    // return success without writing anything. Check the exact path the CLI
    // was told to write (hard gate blocks on it; soft gate records honestly).
    const artifactFile = backupArtifactAt(outputFile);
    if (result.ok && hardGate && !artifactFile) {
      emit("backup", "failed", {
        error: `no backup artifact at ${outputFile}`,
      });
      cleanupFailedBackup(outputFile);
      return {
        ...channelError(
          "backup_failed",
          `The backup command reported success but produced no backup file at ${outputFile}.`,
          "Check the update log for where the backup wrote its archive, then retry — or choose a same-channel version.",
        ),
        expectedFile: outputFile,
      };
    }
    if (result.ok) {
      emit("backup", "completed");
      await pruneBackups();
      if (!artifactFile) {
        backupLog(
          `[openclaw-update] backup: exit 0 but no archive at ${outputFile} — recording no backup file`,
        );
      }
      const artifact = {
        at: backupStartedAt,
        dir: backupsDir,
        file: artifactFile,
        verified: Boolean(artifactFile),
      };
      channelStore.updateState((s) => {
        s.backups = [
          artifact,
          ...(Array.isArray(s.backups) ? s.backups : []),
        ].slice(0, kOpenclawBackupKeepCount);
        return s;
      });
      return { ok: true, artifact };
    }
    cleanupFailedBackup(outputFile);
    const classified = classifyBackupFailure(result, { outputFile, gateNoun });
    if (hardGate) {
      emit("backup", "failed", {
        error: classified.stepError,
        tail: result.tail?.slice(-2000),
      });
      return {
        ...channelError("backup_failed", classified.message, classified.hint),
        expectedFile: outputFile,
      };
    }
    emit("backup", "warning", {
      error: classified.stepError,
      tail: result.tail?.slice(-2000),
    });
    queueNotify(
      `⚠️ Pre-update backup failed — continuing (upgrades are protected by auto-rollback, but rollback recovery may be limited). ${classified.message}`,
      { eventType: "health", id: `backup-warn-${backupStartedAt}` },
    );
    return { ok: true, warned: true, noBackup: true };
  };

  // Retention with strict name classes. Only files this code (or the CLI)
  // named are retention's business — an operator's stray file in the
  // directory is never deleted, and debris (temps, quarantined .unverified
  // archives) can never evict a verified backup by being newer.
  // Async: archives are multi-GB and this runs on the live event loop.
  const pruneBackups = async () => {
    let names = [];
    try {
      names = fsModule.readdirSync(backupsDir);
    } catch (error) {
      // A silent retention failure is issue #9's disk-fill all over again.
      log(`backup prune skipped: ${error.message}`);
      return;
    }
    const archives = [];
    const unverified = [];
    const temps = [];
    for (const name of names) {
      const full = path.join(backupsDir, name);
      let mtime = 0;
      try {
        mtime = fsModule.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (name.endsWith(".tmp")) temps.push({ full, mtime });
      else if (name.endsWith(".unverified")) unverified.push({ full, mtime });
      else if (kBackupArchivePattern.test(name)) archives.push({ full, mtime });
    }
    const remove = async (target) => {
      try {
        await (fsModule.promises || fs.promises).rm(target, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        log(`backup prune could not remove ${target}: ${error.message}`);
      }
    };
    const newestFirst = (entries) => entries.sort((a, b) => b.mtime - a.mtime);
    for (const entry of newestFirst(archives).slice(kOpenclawBackupKeepCount)) {
      await remove(entry.full);
    }
    // Keep the single newest quarantined archive briefly for diagnosis.
    for (const entry of newestFirst(unverified).slice(1)) {
      await remove(entry.full);
    }
    // Temps are crash debris — the CLI removes its own on every exit path.
    for (const entry of temps) {
      await remove(entry.full);
    }
  };

  const verifyPackageArtifact = async ({ packageDir, version, emit }) => {
    emit("verify", "running");
    const bin = channelStore.resolvePackageBin(packageDir);
    if (!bin || !fsModule.existsSync(bin)) {
      emit("verify", "failed", { error: "bin entry missing" });
      return channelError(
        "verify_failed",
        `The downloaded OpenClaw ${version} package has no runnable binary.`,
        "This looks like a broken publish — pick a different version.",
      );
    }
    const versionResult = await runner.runStreamed({
      command: "node",
      args: [bin, "--version"],
      // Minimal env: this binary has NOT passed verification yet.
      env: probeEnv(),
      timeoutMs: 30_000,
    });
    const reported = String(versionResult.tail || "").trim();
    // Exact token match: "2026.7.10" must not verify a requested "2026.7.1".
    const reportedMatches = reported
      .split(/[\s()]+/)
      .map((token) => token.replace(/^v/, ""))
      .includes(version);
    if (!versionResult.ok || !reportedMatches) {
      emit("verify", "failed", { error: `--version reported "${reported}"` });
      return channelError(
        "verify_failed",
        `OpenClaw ${version} did not start correctly during verification (${reported || "no output"}).`,
        "The build may be broken — pick a different version, or retry.",
      );
    }
    // Dist-shape compat probes against the CANDIDATE tree (require.resolve
    // would serve the cached live copy).
    const distDir = path.join(packageDir, "dist");
    try {
      resolveThinkingModulePath(distDir);
    } catch (error) {
      emit("verify", "failed", { error: `thinking probe: ${error.message}` });
      return channelError(
        "verify_failed",
        `OpenClaw ${version} is missing internals AlphaClaw depends on (thinking module).`,
        "This version is incompatible with your AlphaClaw build — wait for an AlphaClaw update or pick another version.",
      );
    }
    if (!fsModule.existsSync(path.join(distDir, "extensions"))) {
      emit("verify", "failed", { error: "dist/extensions missing" });
      return channelError(
        "verify_failed",
        `OpenClaw ${version} has an unexpected layout (no dist/extensions).`,
        "This version is incompatible with your AlphaClaw build.",
      );
    }
    emit("verify", "completed");
    return { ok: true };
  };

  // Returns the snapshot result when a snapshot was REQUIRED (pin present
  // locally, no overlay yet); null when nothing needed doing.
  const ensurePinSnapshot = async (installDir) => {
    const state = channelStore.readState();
    if (!state.pinVersion) return null;
    if (channelStore.hasOverlay(state.pinVersion)) return null;
    const installedVersion = channelStore.readInstalledVersion({ installDir });
    if (installedVersion !== state.pinVersion) return null;
    return channelStore.snapshotPinFromInstallAsync({
      installDir,
      pinVersion: state.pinVersion,
    });
  };

  const ensureDevToolchain = async ({ emit }) => {
    const git = await runner.runStreamed({
      command: "git",
      args: ["--version"],
      timeoutMs: 15_000,
    });
    if (!git.ok) {
      return channelError(
        "toolchain_missing",
        "git is not available, and the dev channel builds OpenClaw from its git repository.",
        "Container installs: wait for an AlphaClaw image update. VPS installs: install git.",
      );
    }
    const pnpm = await runner.runStreamed({
      command: "pnpm",
      args: ["--version"],
      timeoutMs: 15_000,
    });
    if (pnpm.ok) return { ok: true };
    emit("toolchain", "running", { detail: "installing pnpm" });
    const corepack = await runner.runStreamed({
      command: "corepack",
      args: ["enable", "pnpm"],
      timeoutMs: 60_000,
    });
    if (corepack.ok) return { ok: true };
    // Node 25 removed corepack from the default distribution.
    const npmInstall = await runner.runStreamed({
      command: "npm",
      args: ["install", "-g", "pnpm"],
      timeoutMs: 120_000,
    });
    if (npmInstall.ok) return { ok: true };
    return channelError(
      "toolchain_missing",
      "pnpm could not be installed (corepack unavailable and npm -g failed).",
      "Container installs: wait for an AlphaClaw image update. VPS installs: install pnpm manually.",
    );
  };

  const applyUpdate = async ({
    channel,
    version = null,
    sha = null,
    devHead = false,
    operationId = null,
  } = {}) => {
    if (applyInProgress) {
      return {
        status: 409,
        body: channelError(
          "operation_in_progress",
          "Another OpenClaw update is already running.",
          "Wait for it to finish — progress is on the Upgrade page.",
        ),
      };
    }
    if (!isOnboarded()) {
      return {
        status: 409,
        body: channelError(
          "not_onboarded",
          "Finish onboarding before changing OpenClaw versions.",
          "The gateway has to be running so a new version can be health-checked.",
        ),
      };
    }
    try {
      if (isSelfUpdateInProgress()) {
        return {
          status: 409,
          body: channelError(
            "self_update_in_progress",
            "An AlphaClaw update is currently installing.",
            "Wait for it to finish (AlphaClaw will restart), then change OpenClaw versions.",
          ),
        };
      }
    } catch {}
    if (!kOpenclawReleaseChannels.includes(channel)) {
      return {
        status: 400,
        body: channelError("invalid_channel", `Unknown channel "${channel}".`),
      };
    }

    applyInProgress = true;
    // Any gateway exit while a version swap is mid-flight must not feed crash
    // accounting — three quick switches would otherwise fake a crash loop.
    try {
      watchdogManagedOperation?.begin?.();
    } catch {}
    // Every apply gets a durable identity: the run record and log survive the
    // activation restart and are the correlation key for the overseer,
    // notifications, and the Upgrade page's post-restart "what happened".
    if (!operationId) operationId = crypto.randomUUID();
    const target = { channel, version, sha, devHead };
    try {
      ledger.createRun({ operationId, target });
    } catch (error) {
      log(`run ledger unavailable: ${error.message}`);
    }
    const sink = ledger.createLogSink({
      operationId,
      extraSecretEnv: gatewayEnv(),
    });
    activeSink = sink;
    sink.writeLine(
      `[openclaw-update] apply ${operationId} started: ${JSON.stringify(target)}`,
    );
    const { steps, emit } = stepRecorder(operationId, sink);
    const startedAt = nowFn();
    const targetLabel = channel === "dev" ? (devHead ? "dev-head" : sha) : version;
    queueNotify(
      `⏳ OpenClaw update started: ${targetLabel || "latest"} (${channel} channel).`,
      { eventType: "info", operationId, id: `apply-start-${operationId}` },
    );

    const finish = (status, body) => {
      // The flag resets FIRST: everything after is best-effort, and a
      // bookkeeping throw (ENOSPC on the state file) must never leave the
      // latch stuck. EXCEPTION: when this result schedules a restart (a
      // restarting success, or a deferred rollback restart below), the latch
      // stays held — the process dies in ~1.5s, and releasing it would let a
      // second apply start only to be killed mid-overlay-write.
      const restartImminent =
        (body.ok && body.restarting) || pendingRollbackRestart;
      applyInProgress = Boolean(restartImminent);
      try {
        // On a restarting success the swap is NOT over until the process
        // restart lands (~1.5s): releasing the latch here re-arms crash
        // accounting while `applied` already names the never-run new version,
        // and an old-gateway exit-78 in that gap would blocklist it. The
        // latch state dies with the process, so holding it leaks nothing.
        if (!(body.ok && body.restarting)) {
          watchdogManagedOperation?.end?.();
        }
      } catch {}
      try {
        channelStore.updateState((s) => {
          if (s.lastUpdateRun) {
            s.lastUpdateRun.finishedAt = nowFn();
            s.lastUpdateRun.ok = status < 400;
            s.lastUpdateRun.result = body.ok
              ? { ok: true }
              : {
                  ok: false,
                  code: body.code,
                  message: body.message,
                  hint: body.hint ?? null,
                  docsUrl: body.docsUrl ?? null,
                  ...(body.repairApplicable === true
                    ? { repairApplicable: true }
                    : {}),
                };
            s.lastUpdateRun.steps = steps;
          }
          return s;
        });
      } catch (error) {
        log(`could not record apply result: ${error.message}`);
      }
      try {
        if (operationEvents && operationId) {
          if (body.ok) {
            operationEvents.complete(operationId, body);
          } else {
            // Carry the full envelope so the streamed path is as informative
            // as the sub-400ms quick-result path. finishedAt uses the SERVER
            // clock: the UI freezes its elapsed counter on it (a failed card
            // once kept ticking through post-failure overseer analysis).
            operationEvents.fail(
              operationId,
              Object.assign(new Error(body.message), {
                code: body.code,
                hint: body.hint,
                docsUrl: body.docsUrl,
                repairApplicable: body.repairApplicable === true,
                finishedAt: nowFn(),
              }),
            );
          }
        }
      } catch {}
      // Ledger terminal state. restart_expected is resolved by the NEXT boot
      // (activated / activation_failed); everything else is terminal now.
      try {
        const ledgerState =
          body.ok && body.restarting
            ? "restart_expected"
            : body.ok && body.noop
              ? "noop"
              : body.ok
                ? "activated"
                : "failed";
        ledger.completeRun(operationId, {
          state: ledgerState,
          ok: Boolean(body.ok),
          result: body.ok
            ? { ok: true }
            : {
                ok: false,
                code: body.code,
                message: body.message,
                hint: body.hint ?? null,
                docsUrl: body.docsUrl ?? null,
                ...(body.repairApplicable === true
                  ? { repairApplicable: true }
                  : {}),
              },
        });
        // Boot also prunes, but non-restarting outcomes (failed, noop) would
        // otherwise stack records and up-to-10MB logs until the next restart.
        if (ledgerState !== "restart_expected") ledger.pruneRuns();
      } catch {}
      // The failure the admin most needs to hear about — the SSE stream may
      // already be gone, and before the outbox this message did not exist.
      if (!body.ok) {
        try {
          logEvent("channel_apply", "failed", {
            channel,
            version,
            sha,
            code: body.code,
            operationId,
          });
        } catch {}
        queueNotify(
          `❌ OpenClaw update to ${targetLabel || version || sha || "latest"} failed: ${body.message}${
            body.hint ? `\n${body.hint}` : ""
          }`,
          {
            eventType: "upgrade_failed",
            operationId,
            id: `apply-failed-${operationId}`,
          },
        );
      }
      try {
        sink.writeLine(
          `[openclaw-update] apply ${operationId} finished: status=${status} ok=${Boolean(body.ok)}${
            body.code ? ` code=${body.code}` : ""
          }`,
        );
        activeSink = null;
        void sink.close();
      } catch {}
      if (pendingRollbackRestart) {
        pendingRollbackRestart = false;
        if (body.ok && body.restarting) {
          // The apply superseded the rollback: the crashing build is already
          // blocklisted and no longer selected — honoring the stale marker at
          // the next boot would roll back the fresh version instead.
          log("clearing rollback marker superseded by a successful apply");
          try {
            channelStore.clearMarker();
          } catch {}
        } else if (typeof restartProcess === "function") {
          log("running the rollback restart deferred during this apply");
          setTimeout(() => {
            try {
              restartProcess();
            } catch {}
          }, 1000).unref?.();
        }
      }
      return { status, body };
    };

    try {
      const installDir = safeInstallDir();
      const state = channelStore.readState();
      const installedVersion = installDir
        ? channelStore.readInstalledVersion({ installDir })
        : null;

      channelStore.updateState((s) => {
        // lastUpdateRun remains the compatibility pointer; the per-operation
        // ledger record (runs/<operationId>.json) is the durable authority.
        s.lastUpdateRun = {
          operationId,
          target: { channel, version, sha, devHead },
          startedAt,
          finishedAt: null,
          ok: null,
          steps,
        };
        return s;
      });

      // Idempotence: re-applying the active selection is a safe no-op.
      const currentApplied = state.applied;
      if (
        channel !== "dev" &&
        version &&
        version === installedVersion &&
        installDir &&
        // With a dev build applied, the dormant pin tree in node_modules
        // still matches its sentinel — but the SHIM runs the dev checkout.
        // "Switch to stable" must be a real switch, never a false noop.
        (!currentApplied || currentApplied.channel !== "dev") &&
        !channelStore.needsActivation({ installDir, expectedVersion: version })
      ) {
        return finish(200, { ok: true, noop: true, version });
      }
      if (
        channel === "dev" &&
        sha &&
        currentApplied?.channel === "dev" &&
        currentApplied.sha &&
        (currentApplied.sha === sha ||
          (sha.length >= 7 && currentApplied.sha.startsWith(sha)))
      ) {
        // Only a genuinely LIVE dev build noops: after a boot-time pin
        // fallback the recorded intent alone must not short-circuit a rebuild.
        const head = readCheckoutHead();
        if (
          checkoutBuildReady() &&
          head &&
          head.startsWith(currentApplied.sha.slice(0, 7))
        ) {
          return finish(200, { ok: true, noop: true, sha: currentApplied.sha });
        }
      }

      if (!installDir) {
        return finish(
          500,
          channelError("install_dir_unresolved", "Could not locate the app install directory."),
        );
      }

      // Blocklist gate.
      const requestedId = channel === "dev" ? sha : version;
      if (requestedId && channelStore.isBlocklisted(requestedId)) {
        return finish(
          409,
          channelError(
            "version_blocklisted",
            `${requestedId} previously failed here and is blocklisted.`,
            'Use "Clear" on the Upgrade page blocklist first if you want to try it again.',
          ),
        );
      }

      // Preflight.
      emit("preflight", "running");
      // Re-sweep the PATH-first shim dir: the boot-time sweep leaves the whole
      // uptime as a planting window, and this apply is about to spawn
      // PATH-resolved commands with elevated purpose.
      try {
        channelStore.sweepShimDir();
      } catch {}
      const requiredBytes =
        channel === "dev" ? kOpenclawDevMinDiskBytes : kOpenclawPackageMinDiskBytes;
      // Package downloads stage in os.tmpdir(), often the small container root
      // FS — a full /tmp fails the install even when /data has room.
      const disk = checkDiskSpace(requiredBytes);
      if (disk.ok && channel !== "dev") {
        const tmpDisk = checkDiskSpace(requiredBytes, os.tmpdir());
        if (!tmpDisk.ok) {
          emit("preflight", "failed", { error: "insufficient tmp disk" });
          return finish(
            507,
            channelError(
              "insufficient_disk",
              `Not enough free space in the temporary directory (${Math.round(tmpDisk.free / 1e9)} GB free in ${os.tmpdir()}).`,
              "Free space on the root filesystem, or grow the instance in your hosting dashboard.",
            ),
          );
        }
      }
      if (!disk.ok) {
        emit("preflight", "failed", { error: "insufficient disk" });
        return finish(
          507,
          channelError(
            "insufficient_disk",
            `Not enough free space on the data volume (${Math.round(disk.free / 1e9)} GB free, ${
              channel === "dev" ? "~5" : "~1"
            } GB needed).`,
            channel === "dev"
              ? "Dev builds compile from source. Free space, grow the volume in your hosting dashboard, or switch to beta (no build required)."
              : "Free space or grow the volume in your hosting dashboard.",
          ),
        );
      }
      if (channel !== "dev" && releases) {
        try {
          const catalog = await releases.getCatalog({});
          const row = [...(catalog.stable || []), ...(catalog.beta || [])].find(
            (r) => r.version === version,
          );
          const enginesNode = row?.engines?.node;
          if (enginesNode && !enginesSatisfied(enginesNode, process.versions.node)) {
            emit("preflight", "failed", { error: `engines ${enginesNode}` });
            return finish(
              409,
              channelError(
                "engines_unsupported",
                `OpenClaw ${version} needs Node ${enginesNode}; this AlphaClaw runs Node ${process.versions.node}.`,
                "Wait for an AlphaClaw image update that ships a newer Node.",
              ),
            );
          }
        } catch (error) {
          log(`engines preflight skipped (catalog unavailable): ${error.message}`);
        }
      }
      if (channel === "dev") {
        const toolchain = await ensureDevToolchain({ emit });
        if (!toolchain.ok) {
          emit("preflight", "failed", { error: toolchain.code });
          return finish(409, toolchain);
        }
      }
      emit("preflight", "completed");

      // Backup gate. Dev switches hard-gate like downgrades: a from-source
      // build can migrate state formats, and its rollback target (the pin)
      // may not read them — a verified backup is the only recovery. Prerelease
      // (beta) targets hard-gate for the same reason: 2026.8.x betas migrate
      // state that 2026.7.x cannot read back.
      const isDowngrade =
        channel !== "dev" &&
        installedVersion &&
        version &&
        compareVersionParts(version, installedVersion) < 0;
      const isPrereleaseTarget =
        channel !== "dev" && isPrereleaseVersion(version);
      const backupHardGate = isDowngrade || channel === "dev" || isPrereleaseTarget;
      const backup = await runBackup({
        emit,
        hardGate: backupHardGate,
        gateReason: isDowngrade
          ? "downgrade"
          : channel === "dev"
            ? "dev"
            : "cross-channel",
        operationId,
      });
      if (!backup.ok) {
        // Record WHERE the backup was expected before failing — a bare
        // `backup: null` run record made issue #9 undiagnosable.
        try {
          ledger.updateRun(operationId, (record) => {
            record.backup = {
              noBackup: true,
              at: nowFn(),
              expectedFile: backup.expectedFile ?? null,
            };
            return record;
          });
        } catch {}
        return finish(409, backup);
      }
      try {
        ledger.updateRun(operationId, (record) => {
          record.backup = backup.artifact
            ? { ...backup.artifact, noBackup: false }
            : { noBackup: true, at: nowFn() };
          return record;
        });
      } catch {}

      // Keep the pin floor local-offline before the first non-pin activation.
      // CX-J: a failed snapshot with no existing floor means a later rollback
      // has nowhere to land — that is an abort, not a warning.
      const floor = await ensurePinSnapshot(installDir);
      if (floor && floor.ok === false) {
        emit("preflight", "failed", { error: "pin snapshot failed" });
        return finish(
          507,
          channelError(
            "pin_snapshot_failed",
            `Could not persist the built-in rollback floor: ${floor.error}`,
            "Free disk space on the data volume — without the pin snapshot, auto-rollback would have no local target.",
          ),
        );
      }

      // Prepare.
      if (channel !== "dev") {
        emit("download", "running", { detail: `npm install openclaw@${version}` });
        let tempInstall;
        try {
          tempInstall = await installToTempDir({
            versionSpec: version,
            timeoutMs: kOpenclawApplyTimeoutMs,
            onOutput: (chunk) => {
              try {
                activeSink?.write(chunk);
              } catch {}
            },
          });
        } catch (error) {
          emit("download", "failed", { error: error.message });
          return finish(
            502,
            channelError(
              "install_failed",
              `Downloading OpenClaw ${version} failed: ${error.message.slice(0, 300)}`,
              "Check the network/registry status and retry.",
            ),
          );
        }
        emit("download", "completed");
        const verify = await verifyPackageArtifact({
          packageDir: tempInstall.openclawPackageDir,
          version,
          emit,
        });
        if (!verify.ok) {
          await cleanupTempInstall(tempInstall);
          return finish(409, verify);
        }
        const saved = await channelStore.saveOverlayFromTempInstallAsync({
          openclawPackageDir: tempInstall.openclawPackageDir,
          version,
        });
        await cleanupTempInstall(tempInstall);
        if (!saved.ok) {
          return finish(
            500,
            channelError(
              "overlay_save_failed",
              `Could not persist the OpenClaw ${version} build: ${saved.error}`,
              "Check disk space on the data volume.",
            ),
          );
        }
        // Re-read state for the keep-list: a version accepted as
        // last-known-good DURING the download must not be pruned.
        const freshState = channelStore.readState();
        await channelStore.pruneOverlaysAsync({
          keep: [
            freshState.pinVersion,
            freshState.lastKnownGood.package,
            version,
          ].filter(Boolean),
        });
      } else {
        const buildResult = devHead
          ? await runDevHeadUpdate({ emit, operationId })
          : await runDevCommitPin({ sha, emit, operationId });
        if (!buildResult.ok) return finish(409, buildResult);
        sha = buildResult.sha;
        // devHead resolves its sha only AFTER the build — a blocklisted,
        // crash-looping HEAD must not be re-applied through "latest dev".
        if (sha && channelStore.isBlocklisted(sha)) {
          return finish(
            409,
            channelError(
              "version_blocklisted",
              `main is still at ${sha.slice(0, 7)}, which previously failed here and is blocklisted.`,
              'Wait for a new commit on main, or use "Clear" on the blocklist entry to try it again.',
            ),
          );
        }
        const bin = checkoutBuildReady();
        if (!bin) {
          return finish(
            409,
            channelError(
              "verify_failed",
              "The dev build finished but no runnable binary was found in the checkout.",
              'Run `openclaw update repair` from the Watchdog terminal, then retry.',
              null,
              { repairApplicable: true },
            ),
          );
        }
        emit("verify", "running");
        const versionResult = await runner.runStreamed({
          command: "node",
          args: [bin, "--version"],
          // Minimal env: this build has NOT passed verification yet.
          env: probeEnv(),
          timeoutMs: 30_000,
        });
        if (!versionResult.ok) {
          emit("verify", "failed", { tail: versionResult.tail?.slice(-2000) });
          return finish(
            409,
            channelError(
              "verify_failed",
              "The freshly built OpenClaw dev binary did not start.",
              'Run `openclaw update repair` from the Watchdog terminal and retry, or pick a different commit.',
              null,
              { repairApplicable: true },
            ),
          );
        }
        emit("verify", "completed");
      }

      // Record + restart. Activation happens ONLY at boot.
      emit("record", "running");
      channelStore.updateState((s) => {
        s.applied =
          channel === "dev"
            ? { channel: "dev", sha, at: nowFn(), acceptedAt: null }
            : version === s.pinVersion
              ? null
              : { channel, version, at: nowFn(), acceptedAt: null };
        return s;
      });
      firstHealthyAt = null;
      clearVersionCache();
      emit("record", "completed");
      emit("restarting", "running");
      logEvent("channel_apply", "completed", { channel, version, sha, operationId });
      queueNotify(
        `🔄 Restarting AlphaClaw to activate OpenClaw ${targetLabel || version || sha}.`,
        { eventType: "info", operationId, id: `apply-restarting-${operationId}` },
      );
      if (typeof restartProcess === "function") {
        setTimeout(() => {
          try {
            restartProcess();
          } catch {}
        }, 1500).unref?.();
      }
      return finish(202, {
        ok: true,
        restarting: true,
        target: { channel, version, sha },
        operationId,
      });
    } catch (error) {
      log(`apply failed: ${error.message}`);
      return finish(
        500,
        channelError(
          "apply_failed",
          `The update failed unexpectedly: ${error.message}`,
          'Try again; if it keeps failing, run `openclaw update repair` from the Watchdog terminal.',
          null,
          { repairApplicable: true },
        ),
      );
    }
  };

  // Coalesce chatty build output: a pnpm build can emit tens of chunks per
  // second, and each publish fans out a JSON.stringify + SSE write + a full
  // client re-render. One flush per 250ms is indistinguishable to a human.
  const makeOutputPublisher = (operationId) => {
    if (!operationEvents || !operationId) {
      const noop = () => {};
      noop.flush = () => {};
      return noop;
    }
    let buffer = "";
    let timer = null;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!buffer) return;
      const chunk = buffer.slice(-4000);
      buffer = "";
      try {
        operationEvents.publish(operationId, {
          event: "output",
          data: { chunk },
        });
      } catch {}
    };
    const push = (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 64_000) buffer = buffer.slice(-8_000);
      if (!timer) {
        timer = setTimeout(flush, 250);
        timer.unref?.();
      }
    };
    // Callers flush after each command so buffered output always lands BEFORE
    // the step/terminal events that follow it.
    push.flush = flush;
    return push;
  };

  // Append-mode log with no cap would let repeated builds fill the data
  // volume — and a full volume blocks the rollback marker itself.
  const kDevLogMaxBytes = 5 * 1024 * 1024;
  const devLogPath = () => path.join(rootDir, "logs", "openclaw-dev-update.log");
  const rotateDevLog = () => {
    try {
      const p = devLogPath();
      if (fsModule.statSync(p).size > kDevLogMaxBytes) {
        fsModule.renameSync(p, `${p}.old`);
      }
    } catch {}
  };

  const runDevHeadUpdate = async ({ emit, operationId }) => {
    rotateDevLog();
    emit("build", "running", { detail: "openclaw update --channel dev" });
    const output = makeOutputPublisher(operationId);
    const result = await runner.runStreamed({
      command: "openclaw",
      args: ["update", "--channel", "dev", "--json", "--yes", "--no-restart"],
      // Filtered env: the updater spawns upstream build scripts, which must
      // not see gateway secrets. OpenClaw's own OPENCLAW_*/XDG_* config vars
      // pass through; the workspace git shim is stripped.
      env: devUpdateEnv(),
      timeoutMs: kOpenclawApplyTimeoutMs,
      logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"),
      onOutput: output,
      // The updater's final JSON report (steps + plugin convergence) runs
      // ~70KB+; a 64KB rolling tail truncates its head and the status parse
      // degrades to "unknown" (live-verified 2026-08-25).
      tailBytes: 512 * 1024,
    });
    output.flush();
    // Tolerant UpdateRunResult parsing: upstream owns this contract.
    const parsed = parseJsonObjectFromNoisyOutput(result.tail || "") || {};
    const status = typeof parsed.status === "string" ? parsed.status : "unknown";
    if (!result.ok || status === "error") {
      emit("build", "failed", {
        updaterStatus: status,
        tail: result.tail?.slice(-3000),
      });
      return channelError(
        "dev_build_failed",
        result.timedOut
          ? "The dev build timed out."
          : `The dev build failed (updater status: ${status}).`,
        'OpenClaw reverted the checkout to its previous state automatically. If the checkout looks stuck, run `openclaw update repair` from the Watchdog terminal, then retry.',
        null,
        { repairApplicable: true },
      );
    }
    if (status === "unknown") {
      emit("build", "warning", { detail: "updater output was not parseable" });
    } else {
      emit("build", "completed", { updaterStatus: status });
    }
    const head = readCheckoutHead();
    if (!head) {
      return channelError(
        "dev_build_failed",
        "The dev checkout is missing after the update.",
        'Run `openclaw update repair` from the Watchdog terminal, then retry.',
        null,
        { repairApplicable: true },
      );
    }
    return { ok: true, sha: head };
  };

  const runDevCommitPin = async ({ sha, emit, operationId }) => {
    if (!fsModule.existsSync(path.join(checkoutDir, ".git"))) {
      // No checkout yet — establish one via the native updater first.
      const bootstrap = await runDevHeadUpdate({ emit, operationId });
      if (!bootstrap.ok) return bootstrap;
    }
    // Filtered env for the same reason as runDevHeadUpdate: pnpm install/build
    // executes the pinned commit's own scripts.
    const gitEnv = devUpdateEnv();
    const output = makeOutputPublisher(operationId);
    const streamOpts = (extra) => ({
      env: gitEnv,
      cwd: checkoutDir,
      timeoutMs: kOpenclawApplyTimeoutMs,
      logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"),
      onOutput: output,
      ...extra,
    });
    const runStep = async (opts) => {
      const result = await runner.runStreamed(opts);
      output.flush();
      return result;
    };
    rotateDevLog();
    emit("fetch", "running");
    const fetchResult = await runStep(
      streamOpts({ command: "git", args: ["fetch", "--all", "--tags"] }),
    );
    if (!fetchResult.ok) {
      emit("fetch", "failed", { tail: fetchResult.tail?.slice(-2000) });
      return channelError(
        "dev_build_failed",
        "Fetching the OpenClaw repository failed.",
        "Check network access and retry.",
      );
    }
    emit("fetch", "completed");
    emit("checkout", "running", { detail: sha });
    const checkoutResult = await runStep(
      streamOpts({ command: "git", args: ["checkout", "--detach", sha] }),
    );
    if (!checkoutResult.ok) {
      emit("checkout", "failed", { tail: checkoutResult.tail?.slice(-2000) });
      return channelError(
        "dev_build_failed",
        `Could not check out commit ${sha.slice(0, 7)} (the checkout may have local changes from an interrupted build).`,
        'Run `openclaw update repair` from the Watchdog terminal to clean it up, then retry.',
        null,
        { repairApplicable: true },
      );
    }
    emit("checkout", "completed");
    emit("install", "running");
    const installResult = await runStep(
      streamOpts({ command: "pnpm", args: ["install"] }),
    );
    if (!installResult.ok) {
      emit("install", "failed", { tail: installResult.tail?.slice(-2000) });
      return channelError(
        "dev_build_failed",
        "pnpm install failed for the pinned commit.",
        "This snapshot may be broken upstream — try a different commit.",
      );
    }
    emit("install", "completed");
    emit("build", "running");
    const buildResult = await runStep(
      streamOpts({ command: "pnpm", args: ["build"] }),
    );
    if (!buildResult.ok) {
      emit("build", "failed", { tail: buildResult.tail?.slice(-2000) });
      return channelError(
        "dev_build_failed",
        "Building the pinned commit failed.",
        "This snapshot may be broken upstream — try a different commit.",
      );
    }
    emit("build", "completed");
    emit("doctor", "running");
    const bin = checkoutBuildReady();
    if (bin) {
      const doctorResult = await runStep(
        streamOpts({ command: "node", args: [bin, "doctor"] }),
      );
      emit("doctor", doctorResult.ok ? "completed" : "warning", {
        tail: doctorResult.ok ? undefined : doctorResult.tail?.slice(-2000),
      });
    } else {
      emit("doctor", "warning", { detail: "no binary to run doctor with" });
    }
    const head = readCheckoutHead();
    return { ok: true, sha: head || sha };
  };

  // Explicit user action: rebuild is heavy, so it is never done in a crash
  // context — only from the Upgrade page with full preflight (via applyUpdate).

  return {
    syncAtBoot,
    applyUpdate,
    requestChannelRollback,
    markGoodNow,
    onGatewayHealthy,
    onGatewayUnhealthy,
    getChannelInfo,
    flushBootNotifications,
    isApplyInProgress: () => applyInProgress,
    store: channelStore,
    runLedger: ledger,
  };
};

// Boot entry used by bin/alphaclaw.js before lib/server.js loads. Constructs a
// default-wired sync (no gateway, no watchdog, no network) and runs it.
const runOpenclawChannelBootSync = ({ logger = console } = {}) => {
  const sync = createOpenclawChannelSync({ logger });
  return sync.syncAtBoot();
};

module.exports = {
  createOpenclawChannelSync,
  runOpenclawChannelBootSync,
  readDeclaredPin,
  stripGitShimEnv,
  enginesSatisfied,
  channelError,
};
