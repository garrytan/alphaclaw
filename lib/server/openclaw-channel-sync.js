const crypto = require("crypto");
const {
  sanitizeNotificationText,
  utcDayBucket,
} = require("./notification-policy");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  kRootDir,
  OPENCLAW_DIR,
  kNpmPackageRoot,
  kOpenclawReleaseChannels,
  kOpenclawBackupsDir,
  kOpenclawBackupKeepCount,
  kOpenclawBackupTimeoutMs,
  kOpenclawBackupPhaseEnvelopeMs,
  kOpenclawBackupLiveAttempts,
  kOpenclawBackupRetryDelayMs,
  kOpenclawBackupQuiesceTimeoutMs,
  kOpenclawBackupQuiesceStopTimeoutMs,
  kOpenclawBackupQuiesceLockTimeoutMs,
  kOpenclawBackupQuiesceSuppressSlackMs,
  kOpenclawBackupContentionRetries,
  kOpenclawBackupContentionBackoffBaseMs,
  kOpenclawBackupPostQuiesceReadyTimeoutMs,
  kOpenclawBackupPostQuiescePollMs,
  kOpenclawBackupPostQuiesceSettleMs,
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupRollbackJournalSelfDeadlockBytes,
  kOpenclawBackupExclusivitySettleMs,
  kOpenclawBackupExclusivitySettlePollMs,
  kBackupTailClassifyLines,
  kOpenclawStateDbQuietSlackMs,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupPinMaxAgeMs,
  kOpenclawBackupUsableCheckReserveMs,
  kOpenclawBackupQuiesceLeaseReserveMs,
  kOpenclawBackupStaleTempDirSlackMs,
  kOpenclawBackupInventoryMaxEntries,
  kOpenclawBootMigrationBaseTimeoutMs,
  kOpenclawBootMigrationPerGbMs,
  kOpenclawBootMigrationMaxTimeoutMs,
  kOpenclawBootPreflightTimeoutMs,
  kReconcilerPolicyVersion,
  kOpenclawApplyTimeoutMs,
  kOpenclawStabilizationWindowMs,
  kOpenclawAcceptanceHoldMs,
  kOpenclawDevMinDiskBytes,
  kOpenclawPackageMinDiskBytes,
  kOpenclawDoctorMigrationTimeoutMs,
  kOpenclawBootOpsBudgetMs,
  kOpenclawBootPreflightBudgetMs,
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
const {
  isProtectedKeyPath,
  extractBlamedConfigPaths,
  removeKeyPathsFromConfigObject,
} = require("./openclaw-config-keys");
const {
  createDoctorGuard,
  buildDoctorRestoreBlockedNotification,
} = require("./doctor-guard");
const {
  detectAgentsShape,
  agentsArrayToKeyed,
} = require("./openclaw-config-migrations");
const {
  parseJsonObjectFromNoisyOutput,
  parseJsonValueFromNoisyOutput,
} = require("./utils/json");
const { collectSecretValues, redactSecrets } = require("./utils/redact");
const { resolveThinkingModulePath } = require("./openclaw-thinking");
const {
  kStateContentionPattern,
  listLiveOpenclawProcesses,
} = require("./openclaw-lock-contention");
const {
  beginStateDbQuiet,
  isStateDbQuiet,
  getStateDbHandleCount,
} = require("./state-db-quiet");
const {
  kOfflineCopyProducer,
  kUpstreamProducer,
  kOfflineCopyArchiveSuffix,
  kOfflineCopyTempDirPrefix,
  OfflineCopyError,
  producerOfArchiveName,
  createOfflineCopy,
  verifyArchiveManifest,
} = require("./openclaw-backup-offline-copy");

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

// `database preflight` verdict shape across CLI generations: a status string,
// requiresWrite, or migrationRequired — any one means the target must run its
// schema migration before serving. Shared by the boot probe and the
// apply-time preflight so the two can never drift.
const isMigrationRequiredVerdict = (parsed) =>
  Boolean(
    parsed &&
      typeof parsed === "object" &&
      (parsed.status === "migration-required" ||
        parsed.requiresWrite === true ||
        parsed.migrationRequired === true),
  );

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
  // Supervisor contract (1.1): even probe/build invocations must know an
  // external supervisor owns installs — beta code paths consult these to
  // refuse self-update/service mutation. Not secrets.
  "OPENCLAW_SUPERVISOR_MODE",
  "OPENCLAW_SERVICE_REPAIR_POLICY",
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

// ── Backup policy (issue #54) — data, not branches ──────────────────────────
//
// Archive names both producers write: the upstream CLI's
// `openclaw-backup-<ts>-<opId8>.tar.gz` (and the legacy-migration names) and
// AlphaClaw's `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz` offline copy.
// Retention, inventory, and failure cleanup all classify by this one pattern;
// `.unverified` quarantines and `.tmp` debris never match.
const kBackupArchiveNamePattern = /^openclaw-backup-[^/]*\.(alphaclaw\.)?tar\.gz$/;
const isBackupArchiveName = (name) => kBackupArchiveNamePattern.test(String(name ?? ""));
// The consented-reuse offer is only ever the digest-bearing object shape; the
// same predicate gates it in operation-events.fail().
const kWorkspaceExcludedPartialReason =
  "workspace excluded — settings too broken to discover workspaces";
const isReusableBackupOffer = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  /^[0-9a-f]{64}$/i.test(String(value.sha256 || ""));
// Operator-facing age ("3 hours", "2 days") — ONE helper for the driver's
// surviving-backup / reuse lines and the rollback route's reused-archive
// caveat, so the same age never reads differently across the update flow.
const formatAge = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
};

// What the quiesced driver does with each classified failure kind. `retry` is
// the budget-aware in-quiesce retry (contentionRetryVerdict); `offline_copy`
// skips straight to the AlphaClaw copy; `fallback` relaunches the gateway and
// hands over to the live ladder; `workspace_retry` runs the one-shot
// --no-include-workspace attempt LIVE; everything else is terminal.
const kQuiescedOutcomePolicy = Object.freeze({
  lock_contention: "retry",
  killed: "offline_copy",
  timeout: "fallback",
  vanished_file: "fallback",
  workspace_discovery: "workspace_retry",
  default: "terminal",
});

// Live-ladder retries per kind (attempt count is still capped by
// kOpenclawBackupLiveAttempts and the phase envelope). Delays are the
// budget knobs backupBudget carries (retryDelayMs / contentionBackoffBaseMs)
// so tests can shrink them; the values here document production.
const kLiveRetryPolicy = Object.freeze({
  vanished_file: Object.freeze({ retries: 2, delayMs: kOpenclawBackupRetryDelayMs }),
  lock_contention: Object.freeze({
    retries: 1,
    delayMs: kOpenclawBackupContentionBackoffBaseMs,
  }),
  killed: Object.freeze({ retries: 1, delayMs: kOpenclawBackupContentionBackoffBaseMs }),
});

// Failure kinds after which the consented-reuse gate (WI-4.5) may offer a
// verified earlier archive: transient/retryable classes plus the offline copy
// refusing on a retryable upstream failure. Never a broken CLI, a full disk,
// a verify failure, a phantom artifact, or a spawn error — reusing an old
// backup would paper over a box-level problem the operator must fix.
const kReuseEligibleKinds = Object.freeze([
  "lock_contention",
  "killed",
  "timeout",
  "vanished_file",
  "offline_copy_refused",
  "window_exhausted",
]);

// The retry must fit: attempt (bounded by how long the failed one took),
// backoff, and a reserve for the offline copy/relaunch that follows.
const kContentionRetryReserveMs = 30 * 1000;
const kContentionRetryMaxAttemptShare = 0.5;
const contentionRetryVerdict = ({
  failedMs,
  backoffMs,
  remainingMs,
  budgetMs,
  retries,
  maxRetries = kOpenclawBackupContentionRetries,
}) => {
  if (retries >= maxRetries) return { retry: false, reason: "retries_exhausted" };
  if (failedMs >= budgetMs * kContentionRetryMaxAttemptShare) {
    return { retry: false, reason: "attempt_too_long" };
  }
  if (remainingMs < failedMs + backoffMs + kContentionRetryReserveMs) {
    return { retry: false, reason: "insufficient_budget" };
  }
  return { retry: true, reason: null };
};

// /proc/self/mountinfo: "<id> <parent> <maj:min> <root> <mountPoint> <opts>
// [optional…] - <fstype> <source> <superOpts>". Longest mount point that
// contains dirPath wins; octal escapes (\040) in mount points are decoded.
const parseMountInfoFsType = (text, dirPath) => {
  const target = String(dirPath || "");
  if (!target) return "unknown";
  let best = null;
  for (const line of String(text || "").split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(" ");
    const tailFields = line.slice(separator + 3).split(" ");
    const mountPoint = String(head[4] || "").replace(/\\([0-7]{3})/g, (_, oct) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    const fsType = tailFields[0];
    if (!mountPoint || !fsType) continue;
    const contains =
      target === mountPoint ||
      mountPoint === "/" ||
      target.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (!contains) continue;
    if (!best || mountPoint.length > best.mountPoint.length) best = { mountPoint, fsType };
  }
  return best ? best.fsType : "unknown";
};

// Last N non-empty output lines — every classifier regex reads this window,
// never the whole tail and never only the final line (issue #54's lease-loss
// cause sat several lines above "Backup failed").
const selectClassifierTail = (tail, lines = kBackupTailClassifyLines) =>
  String(tail || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines);

const createOpenclawChannelSync = ({
  getActiveGatewayOperation = null,
  fsModule = fs,
  rootDir = kRootDir,
  openclawDir = OPENCLAW_DIR,
  packageRoot = kNpmPackageRoot,
  store = null,
  runStream = null,
  runLedger = null,
  installToTempDir = installOpenclawVersionToTempDir,
  resolveInstallDir = () => resolveSelfDependency({ fsImpl: fs }).installDir,
  // Env for INSTALLED-binary operations (backup, doctor, validate). Named to
  // never be confused with gateway.js's gatewayEnv(): the old shared name let
  // the boot migration silently run on ambient process.env (issue #20).
  // Candidate-binary probes (verify, db-preflight) use probeEnv() instead —
  // an untrusted build must never receive gateway secrets.
  openclawSpawnEnv = () => process.env,
  // Injected by lib/server.js only (the boot-sync instance omits it → the
  // backup falls back to live retries). Shape:
  //   { acquireLock(): Promise<release>, suppress(durationMs), unsuppress(),
  //     stop(): Promise<boolean>, start(): Promise, isRunning(): Promise<bool> }
  gatewayQuiesce = null,
  // Test seam: override backup retry/quiesce budgets (defaults = constants).
  backupTuning = null,
  // State-DB quiet period (issue #54): held from stop-confirmed to just before
  // the relaunch. Two seams so the retry suite's recorder can pin the exact
  // order (dbQuiet after stop, dbResume before start); defaults are the module.
  dbQuiet = (opts) => beginStateDbQuiet(opts),
  dbResume = (quiet) => quiet?.release?.(),
  // Pre-backup diagnosis probes (mountinfo, live processes, fd holders) —
  // injectable so the hermetic suites never depend on this box's /proc.
  backupProbes = null,
  // Test seam: the reuse gate hands archive tools /proc/<pid>/fd/<fd> on
  // Linux and falls back to path + re-stat elsewhere; the suite pins both.
  platform = process.platform,
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
  // Sync exec for boot-time config migration (doctor --fix). Injectable for tests.
  execFileSyncImpl = execFileSync,
  backupsDir = kOpenclawBackupsDir,
  stabilizationWindowMs = kOpenclawStabilizationWindowMs,
  acceptanceHoldMs = kOpenclawAcceptanceHoldMs,
  doctorMigrationTimeoutMs = kOpenclawDoctorMigrationTimeoutMs,
  bootOpsBudgetMs = kOpenclawBootOpsBudgetMs,
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
  // Once-per-boot arm for the pin last-known-good promotion (issue #21 bug 5).
  let pinLkgPromotionArmed = true;
  const pendingNotifications = [];
  // Shared boot heavy-ops budget (issue #21): the doctor migration and the
  // rollback preflights both draw from one clock so their ceilings can never
  // stack past the boot placeholder's 15-minute /health flip. Real wall clock
  // on purpose — nowFn is a logical clock in tests and may never advance.
  let bootOpsStartedAt = null;
  const remainingBootOpsMs = () =>
    bootOpsStartedAt == null
      ? bootOpsBudgetMs
      : Math.max(0, bootOpsBudgetMs - (Date.now() - bootOpsStartedAt));
  // Best-effort out-of-band webhook for boot-time incidents (gate reverts,
  // refused rollbacks, forward recovery): the durable outbox only drains after
  // the server starts, so a boot that never completes would otherwise never
  // reach any channel. Lazy require + swallow-all: never blocks or fails boot.
  const postBootWebhook = (message) => {
    try {
      const { postNotifyWebhookDirect } = require("./notify-webhook");
      void postNotifyWebhookDirect(message);
    } catch {}
  };
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
  const devUpdateEnv = () => buildDevUpdateEnv(openclawSpawnEnv());
  const backupBudget = {
    phaseEnvelopeMs: kOpenclawBackupPhaseEnvelopeMs,
    liveAttempts: kOpenclawBackupLiveAttempts,
    retryDelayMs: kOpenclawBackupRetryDelayMs,
    quiesceTimeoutMs: kOpenclawBackupQuiesceTimeoutMs,
    quiesceStopTimeoutMs: kOpenclawBackupQuiesceStopTimeoutMs,
    quiesceLockTimeoutMs: kOpenclawBackupQuiesceLockTimeoutMs,
    cliTimeoutMs: kOpenclawBackupTimeoutMs,
    contentionRetries: kOpenclawBackupContentionRetries,
    contentionBackoffBaseMs: kOpenclawBackupContentionBackoffBaseMs,
    postQuiesceReadyTimeoutMs: kOpenclawBackupPostQuiesceReadyTimeoutMs,
    postQuiescePollMs: kOpenclawBackupPostQuiescePollMs,
    postQuiesceSettleMs: kOpenclawBackupPostQuiesceSettleMs,
    offlineCopyBudgetMs: kOpenclawBackupOfflineCopyBudgetMs,
    stateDbQuietSlackMs: kOpenclawStateDbQuietSlackMs,
    reuseVerifyTimeoutMs: kOpenclawBackupReuseVerifyTimeoutMs,
    usableCheckReserveMs: kOpenclawBackupUsableCheckReserveMs,
    quiesceLeaseReserveMs: kOpenclawBackupQuiesceLeaseReserveMs,
    staleTempDirSlackMs: kOpenclawBackupStaleTempDirSlackMs,
    rollbackJournalSelfDeadlockBytes: kOpenclawBackupRollbackJournalSelfDeadlockBytes,
    exclusivitySettleMs: kOpenclawBackupExclusivitySettleMs,
    exclusivitySettlePollMs: kOpenclawBackupExclusivitySettlePollMs,
    ...(backupTuning || {}),
  };
  // The quiet barrier's expiry must outlive the budgets it protects. Derived
  // from the EFFECTIVE quiesce/offline budgets (a tuning override that raises
  // them raises the barrier too); an explicit stateDbQuietMaxMs override wins.
  if (!Number.isFinite(backupBudget.stateDbQuietMaxMs)) {
    backupBudget.stateDbQuietMaxMs =
      backupBudget.quiesceTimeoutMs +
      backupBudget.offlineCopyBudgetMs +
      backupBudget.stateDbQuietSlackMs;
  }
  const probes = {
    readMountInfo: () => fsModule.readFileSync("/proc/self/mountinfo", "utf8"),
    listProcesses: () => listLiveOpenclawProcesses(),
    listFdHolders: undefined,
    ...(backupProbes || {}),
  };
  const sleepMs = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });

  const log = (message) => {
    try {
      logger.log(`${kLogPrefix} ${message}`);
    } catch {}
  };

  // Stable-id helpers for auto-fix notifications: outbox ids must be
  // signature keys, never bare timestamps (a boot loop dedupes into ONE alert
  // per distinct failure). Events that can legitimately recur as a NEW
  // episode weeks later append a UTC day bucket — boot loops within a day
  // dedupe, a fresh episode re-fires.
  const notifyDayBucket = () => utcDayBucket(nowFn());
  // Hash a NORMALIZED failure signature: volatile fragments (paths with
  // temp-file suffixes, timings, byte counts) would mint a fresh id per boot
  // and defeat the boot-loop dedupe this key exists for.
  const notifyReasonHash = (reason) =>
    crypto
      .createHash("sha256")
      .update(
        String(reason || "")
          .replace(/\/[^\s"']+/g, "<path>")
          .replace(/\d+/g, "N"),
      )
      .digest("hex")
      .slice(0, 8);

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
          } else if (lastBoot.action === "migration_gate_reverted") {
            // KEEP this branch even though the merged reconciler no longer
            // sets the action (the gate now runs in the server phase, which
            // logs the event directly): a 0.9.43 box upgrading through this
            // build can still carry a pre-0.9.44 state file whose lastBoot
            // recorded it, and its incident-timeline row must not be lost.
            logEvent("config_migration_gate", "reverted", {
              at: lastBoot.at,
              warnings: bootWarnings,
            });
          } else if (lastBoot.action === "rollback_refused") {
            logEvent("channel_rollback", "refused", {
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

  // Two-tier window: auto-acceptance (120s of health) keeps the 24h rollback
  // window armed — a build that crash-loops at hour 3 still rolls back. An
  // explicit "Mark as good now" disarms it entirely (U7). The same clock runs
  // for a non-pin build (`applied`) and for a freshly bumped pin
  // (`pinWindow`); only the accepted stamps differ in where they live.
  const windowArmed = ({ acceptedAt, acceptedSource }, now) =>
    !acceptedAt ||
    (acceptedSource !== "manual" && now - acceptedAt < stabilizationWindowMs);

  const pinWindowOpen = (state, now = nowFn()) =>
    Boolean(
      !state.applied &&
        state.pinWindow &&
        state.pinWindow.openedAt &&
        state.pinWindow.version === state.pinVersion &&
        windowArmed(state.pinWindow, now),
    );

  // The window's rollback target must be retained even while a channel build
  // sits on top of the pin (its own rollback lands back on the pin, and the
  // pin's watch resumes): armed-or-pending, independent of `applied`.
  const pinWindowRetainsPrevious = (state, now = nowFn()) =>
    Boolean(
      state.pinWindow &&
        state.pinWindow.version === state.pinVersion &&
        (!state.pinWindow.openedAt || windowArmed(state.pinWindow, now)),
    );

  // Where a pin-window rollback lands: the previous pin's overlay, else a
  // usable last-known-good — never the pin being blocklisted. Shared by the
  // rollback request and the display-only `stabilization.target` so the UI
  // can only promise a target the request would actually pick.
  // Display callers (getChannelInfo rides status polls) memoize the overlay
  // stats for 5s; dispatch callers always look fresh.
  let pinTargetMemo = { at: 0, key: null, version: null };
  const pinRollbackTargetVersion = (state, { fresh = true } = {}) => {
    const key = `${state.pinVersion}|${state.previousPin?.version || ""}|${state.lastKnownGood?.package || ""}|${state.blocklist.length}`;
    const now = nowFn();
    if (!fresh && pinTargetMemo.key === key && now - pinTargetMemo.at < 5000) {
      return pinTargetMemo.version;
    }
    const version = resolvePinRollbackTarget(state);
    pinTargetMemo = { at: now, key, version };
    return version;
  };
  const resolvePinRollbackTarget = (state) => {
    const blockedId = state.pinVersion;
    const usable = (version) =>
      version &&
      version !== blockedId &&
      !channelStore.isBlocklisted(version) &&
      channelStore.hasOverlay(version)
        ? version
        : null;
    return (
      usable(state.previousPin?.version) ||
      usable(state.lastKnownGood?.package) ||
      null
    );
  };

  // Single home for "is a rollback automatic right now, and to what": the
  // watchdog predicate, the rollback request, the boot target chooser, the
  // prune keep-list and the Upgrade page all read this object.
  const buildStabilization = (state, now) => {
    const applied = state.applied;
    if (applied) {
      const inWindow = windowArmed(applied, now);
      return {
        source: "channel",
        inWindow,
        acceptedAt: applied.acceptedAt || null,
        acceptedSource: applied.acceptedSource || null,
        endsAt:
          inWindow && applied.acceptedAt && applied.acceptedSource !== "manual"
            ? applied.acceptedAt + stabilizationWindowMs
            : null,
        blockedId: appliedId(applied),
        target: null,
      };
    }
    const pinWindow = state.pinWindow;
    if (pinWindowOpen(state, now)) {
      const targetVersion = pinRollbackTargetVersion(state, { fresh: false });
      return {
        source: "pin",
        inWindow: true,
        acceptedAt: pinWindow.acceptedAt || null,
        acceptedSource: pinWindow.acceptedSource || null,
        endsAt:
          pinWindow.acceptedAt && pinWindow.acceptedSource !== "manual"
            ? pinWindow.acceptedAt + stabilizationWindowMs
            : null,
        blockedId: state.pinVersion,
        target: targetVersion
          ? { kind: "package", channel: "stable", version: targetVersion }
          : null,
      };
    }
    return {
      source: null,
      inWindow: false,
      acceptedAt: pinWindow?.acceptedAt || null,
      acceptedSource: pinWindow?.acceptedSource || null,
      endsAt: null,
      blockedId: null,
      target: null,
    };
  };

  const getChannelInfo = () => {
    const state = channelStore.readState();
    const installDir = safeInstallDir();
    const installedVersion = installDir
      ? channelStore.readInstalledVersion({ installDir })
      : null;
    const applied = state.applied;
    const isPin = !applied;
    const now = nowFn();
    const stabilization = buildStabilization(state, now);
    const acceptedAt = stabilization.acceptedAt;
    const inStabilizationWindow = stabilization.inWindow;
    return {
      releaseChannel: safeReadChannel(),
      installedVersion,
      pinVersion: state.pinVersion,
      previousPin: state.previousPin || null,
      pinWindow: state.pinWindow || null,
      applied,
      appliedId: appliedId(applied),
      appliedVersion: applied?.version || null,
      isPin,
      stabilization,
      // EXPECTED divergence only (incident 2026-09-01: `npm ls` reporting the
      // openclaw dep "invalid" was read as a version-drift bug — it is the
      // release-channel overlay working as designed). True strictly when a
      // recorded apply is active AND the live tree matches ITS version AND
      // that differs from the declared pin. An installed version matching
      // NEITHER pin nor applied is an anomaly and must never be legitimized
      // here (drift_reverted owns tamper detection); dev builds are excluded
      // (their installedVersion is the dormant fallback, not what runs).
      pinDiverged: Boolean(
        applied &&
          applied.channel !== "dev" &&
          installedVersion &&
          state.pinVersion &&
          installedVersion === applied.version &&
          installedVersion !== state.pinVersion,
      ),
      acceptedAt,
      inStabilizationWindow,
      lastKnownGood: state.lastKnownGood,
      blocklist: state.blocklist,
      lastUpdateRun: state.lastUpdateRun,
      lastBoot: state.lastBoot,
      configMigration: state.configMigration || null,
      // First-class hold state (issue #20): non-null while the boot
      // reconciler is refusing to start the gateway on this build's config.
      gatewayHold: state.gatewayHold || null,
      // Issue #21 recovery latches (state reads only — this function must
      // never gain probe/spawn work; it feeds the 2s status tick).
      rollbackRefused: state.rollbackRefused || null,
      forwardRecovery: state.forwardRecovery || null,
      noBootableVersion: state.noBootableVersion || null,
      // D1: "post-upgrade monitoring period" remaining-time display. Only
      // meaningful once auto-acceptance stamped the clock; manual mark-good
      // disarms the window entirely.
      stabilizationEndsAt: stabilization.endsAt,
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

  // Managed Control UI environment stripe per channel (E1). Marked so we only ever
  // rewrite/remove our own stripe, never one an operator set by hand.
  // D17: the stripe names the train AND the build. The beta schema is a
  // strictObject({label: string().max(24), color: enum}) — NO extra keys (a
  // `_alphaclawManaged` marker would exit-78 the gateway) and a 24-char label
  // budget, so managed-ness is tracked in ALPHACLAW state instead.
  const kStripeLabelMaxChars = 24;
  const readInstalledVersionSafe = () => {
    try {
      const installDir = safeInstallDir();
      return installDir
        ? channelStore.readInstalledVersion({ installDir })
        : null;
    } catch {
      return null;
    }
  };
  // gateway.controlUi.environment first shipped in the 2026.8.1 line; the pin
  // (2026.7.1-x) and every earlier build hard-reject the key with EX_CONFIG at
  // startup. Compare CORE version parts only: compareVersionParts ranks
  // "2026.8.1-beta.N" below "2026.8.1" (prerelease), but the beta schema
  // already knows the key.
  const kStripeMinOpenclawCoreVersion = "2026.8.1";
  const installSupportsEnvironmentStripe = (version) => {
    const core = String(version || "").trim().split("-")[0];
    return (
      !!core && compareVersionParts(core, kStripeMinOpenclawCoreVersion) >= 0
    );
  };
  // The stripe may only exist in openclaw.json while the build that will
  // actually RUN knows the key. The channel selection alone proves nothing:
  // every boot fallback (overlay missing, activation failed, dev checkout
  // stale, rollback, drift revert) leaves the selection on beta/dev while the
  // stable pin runs — and the pin exits 78 on the key, crash-looping the boot.
  // Dev builds run from the checkout, so capability comes from the CHECKOUT's
  // package version, not the installDir. Fail closed on anything unreadable
  // or placeholder-versioned: the stripe is cosmetic, the exit-78 is not.
  const devCheckoutSupportsEnvironmentStripe = () => {
    try {
      const pkg = JSON.parse(
        fsModule.readFileSync(path.join(checkoutDir, "package.json"), "utf8"),
      );
      return installSupportsEnvironmentStripe(pkg?.version);
    } catch {
      return false;
    }
  };

  const stripeCapabilityForChannel = (channel, { devShimActive = false } = {}) => {
    if (channel === "dev") {
      return devShimActive && devCheckoutSupportsEnvironmentStripe();
    }
    if (channel !== "beta") return false;
    return installSupportsEnvironmentStripe(readInstalledVersionSafe());
  };
  const environmentStripeForChannel = (channel) => {
    if (channel === "beta") {
      const version = readInstalledVersionSafe();
      const label = version ? `BETA · ${version}` : "BETA";
      return {
        label: label.slice(0, kStripeLabelMaxChars),
        color: "amber",
      };
    }
    if (channel === "dev") {
      let sha = null;
      try {
        const applied = channelStore.readState().applied;
        sha = applied?.channel === "dev" ? applied.sha : null;
      } catch {}
      const label = sha ? `DEV · ${String(sha).slice(0, 7)}` : "DEV";
      return { label: label.slice(0, kStripeLabelMaxChars), color: "purple" };
    }
    return null; // stable: no stripe
  };

  // A stripe shaped exactly like one AlphaClaw generates. Needed beyond the
  // recorded-state match because the record and the file can desync through
  // no operator action: a pre-fix backup restore rewrites openclaw.json
  // wholesale, a corrupted channel-state reset loses managedStripe, and a
  // failed write can commit one side but not the other. A hand-set stripe
  // that is byte-identical to a generated one is indistinguishable anyway.
  const stripeLooksAlphaclawGenerated = (stripe) => {
    if (!stripe || typeof stripe !== "object") return false;
    if (Object.keys(stripe).length !== 2) return false;
    const { label, color } = stripe;
    if (typeof label !== "string") return false;
    if (color === "amber") return label === "BETA" || label.startsWith("BETA · ");
    if (color === "purple") return label === "DEV" || label.startsWith("DEV · ");
    return false;
  };

  const stripeIsAlphaclawManaged = (liveStripe) => {
    if (!liveStripe) return true; // nothing there = nothing hand-set
    if (typeof liveStripe !== "object") return false;
    // Legacy marker written before the strict-schema fix — still ours.
    if (liveStripe._alphaclawManaged === true) return true;
    const recorded = channelStore.readState().managedStripe;
    if (
      !!recorded &&
      recorded.label === liveStripe.label &&
      recorded.color === liveStripe.color &&
      Object.keys(liveStripe).length === 2
    ) {
      return true;
    }
    return stripeLooksAlphaclawGenerated(liveStripe);
  };

  const applyEnvironmentStripe = (config, desiredStripe) => {
    if (!desiredStripe) {
      // Remove a managed stripe; leave a hand-set one alone.
      const current = config.gateway?.controlUi?.environment;
      if (current && stripeIsAlphaclawManaged(current)) {
        delete config.gateway.controlUi.environment;
        if (
          config.gateway.controlUi &&
          Object.keys(config.gateway.controlUi).length === 0
        ) {
          delete config.gateway.controlUi;
        }
      }
    } else {
      if (!config.gateway || typeof config.gateway !== "object") config.gateway = {};
      if (!config.gateway.controlUi || typeof config.gateway.controlUi !== "object") {
        config.gateway.controlUi = {};
      }
      config.gateway.controlUi.environment = desiredStripe;
    }
  };

  // Record what we own OUTSIDE openclaw.json (strict schema, C6-class rule).
  // Called AFTER the locked config write commits — recording inside the
  // mutate callback could persist ownership for a write that then failed,
  // desyncing record and file.
  const recordManagedStripe = (desiredStripe) => {
    try {
      channelStore.updateState((s) => {
        s.managedStripe = desiredStripe
          ? { label: desiredStripe.label, color: desiredStripe.color }
          : null;
        return s;
      });
    } catch {}
  };

  const reconcileOpenclawJsonMirror = (channel, { devShimActive = false } = {}) => {
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
      // E1: a thin Control UI environment stripe so a team sees which train they're
      // on, even before sign-in. Only beta/dev get a stripe, and only when the
      // build that will actually run supports gateway.controlUi.environment
      // (explicit capability gate — see stripeCapabilityForChannel). Stable or
      // an incapable build removes any managed stripe, which self-heals a
      // config poisoned by a pre-gate write on the next boot.
      const desiredStripe = stripeCapabilityForChannel(channel, { devShimActive })
        ? environmentStripeForChannel(channel)
        : null;
      const liveStripe = parsed.gateway?.controlUi?.environment ?? null;
      const stripeChanged =
        stripeIsAlphaclawManaged(liveStripe) &&
        JSON.stringify(liveStripe) !== JSON.stringify(desiredStripe);
      const updateChanged =
        JSON.stringify(parsed.update || null) !== JSON.stringify(nextUpdate);
      if (updateChanged || stripeChanged) {
        // Locked read-modify-write: openclaw.json has other writers (CLI
        // crons, the telegram-workspace sync) — an unserialized RMW here
        // could drop their update even with an atomic write.
        let stripeApplied = false;
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
            if (stripeChanged) {
              // Re-check ownership INSIDE the lock: stripeChanged was computed
              // from a pre-lock read, and a stripe hand-set by a concurrent
              // writer in that window must not be overwritten as "managed".
              const liveNow = config.gateway?.controlUi?.environment ?? null;
              if (stripeIsAlphaclawManaged(liveNow)) {
                applyEnvironmentStripe(config, desiredStripe);
                stripeApplied = true;
              }
            }
          },
        });
        if (stripeApplied) recordManagedStripe(desiredStripe);
        log(
          `openclaw.json mirrored (channel="${channel}"${stripeChanged ? ", environment stripe" : ""})`,
        );
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

  // Keep the newest N pre-fix config backups (openclaw.json.pre-fix-<ver>.bak).
  const kConfigBackupKeep = 3;
  const kConfigBackupPattern = /^openclaw\.json\.pre-fix-.+\.bak$/;
  const pruneConfigBackups = () => {
    try {
      const entries = fsModule
        .readdirSync(openclawDir)
        .filter((name) => kConfigBackupPattern.test(name))
        .map((name) => {
          let mtimeMs = 0;
          try {
            mtimeMs = fsModule.statSync(path.join(openclawDir, name)).mtimeMs;
          } catch {}
          return { name, mtimeMs };
        })
        .sort((a, b) => {
          // Consumed '.restored.bak' artifacts evict FIRST regardless of age:
          // a downgrade-restore's renamed snapshot is only a diagnostic
          // leftover, and (being freshly renamed) it is usually the NEWEST
          // entry — a pure-mtime sort would let it push an older epoch's only
          // live pre-fix snapshot out of the keep set.
          const aRestored = a.name.endsWith(".restored.bak") ? 1 : 0;
          const bRestored = b.name.endsWith(".restored.bak") ? 1 : 0;
          if (aRestored !== bRestored) return aRestored - bRestored;
          return b.mtimeMs - a.mtimeMs;
        });
      for (const extra of entries.slice(kConfigBackupKeep)) {
        try {
          fsModule.unlinkSync(path.join(openclawDir, extra.name));
        } catch {}
      }
    } catch {}
  };

  // ── Boot config reconciler (issue #20) ────────────────────────────────
  //
  //   reconcileBootConfig()                (server boot sequence, boot lock
  //     │                                   held, BEFORE startGateway)
  //     │ recover stranded last-good quarantines (crash-safe guard)
  //     ▼
  //   no config? ─────────────────────────► done (fresh install)
  //   downgrade round-trip backup exists? ► restore it (LOUD: inventory diff)
  //   re-attempt gate: hash(config+version+policy) unchanged since a failed
  //     attempt? ─────────────────────────► keep the hold (no 30-min doctor
  //     ▼                                   per crash-loop restart)
  //   SNAPSHOT openclaw.json.pre-fix-<fromVersion>.bak (keep kConfigBackupKeep = 3)
  //     │ write fails? → HOLD (no revert = no doctor — F7)
  //     ▼
  //   known-safe migrations: agents.list→entries rename + curated
  //     retired-key strips (version-gated, protected prefixes excluded)
  //     ▼
  //   validate (`config validate`, capability-probed) + DB-migration need
  //     (apply-time db-preflight verdict as HINT; live probe when absent;
  //      inconclusive → assume needed — config validity ≠ state compatibility)
  //     ▼
  //   guarded doctor --fix: async runStream (process-group kill on timeout),
  //     budget sized to live DB bytes, last-good QUARANTINED (doctor-guard)
  //     ▼
  //   re-validate → still invalid? → HOLD: state.gatewayHold + watchdog latch
  //     + loud notification with the exact blamed keys. Unknown keys are
  //     NEVER auto-deleted — the operator's "Strip blamed keys and retry"
  //     action runs the same machinery with explicit consent.
  //
  // The old runBootConfigMigration ran `doctor --fix` under execFileSync with
  // a hardcoded 120s timeout and stdio:"ignore", failed OPEN, and let the
  // gateway crash-loop on the un-migrated config — issue #20's bugs 1 and 2.
  const kConfigRetiredKeys = [
    // The exact retired-key set OpenClaw ≥2026.8 rejects with exit 78,
    // captured verbatim from issue #20's gateway error output. Curated =
    // auto-strippable; anything else needs operator consent.
    {
      minCoreVersion: "2026.8.0",
      keys: [
        "meta.lastTouchedAt",
        "diagnostics.memoryPressureSnapshot",
        "agents.defaults.compaction.truncateAfterCompaction",
        "agents.defaults.compaction.maxHistoryShare",
        "agents.defaults.compaction.reserveTokens",
        "agents.defaults.compaction.reserveTokensFloor",
        "agents.defaults.heartbeat.includeSystemPromptSection",
        "messages.queue.debounceMs",
        "cron.maxConcurrentRuns",
        "gateway.tailscale.resetOnExit",
        "plugins.bundledDiscovery",
      ],
    },
  ];

  const coreVersionOf = (version) =>
    String(version || "").split("-")[0] || null;

  const retiredKeysForVersion = (installedVersion) => {
    const core = coreVersionOf(installedVersion);
    if (!core) return [];
    const keys = [];
    for (const entry of kConfigRetiredKeys) {
      if (compareVersionParts(core, entry.minCoreVersion) >= 0) {
        keys.push(...entry.keys);
      }
    }
    return keys;
  };

  const doctorGuard = createDoctorGuard({
    fsModule,
    openclawDir,
    nowFn,
    logger,
  });

  const totalStateDbBytes = () => {
    let total = 0;
    for (const dbPath of enumerateStateDbs()) {
      try {
        total += fsModule.statSync(dbPath).size;
      } catch {}
    }
    return total;
  };

  // Budget scales with the state DBs the migration must rewrite — the fixed
  // 120s killed a 767MB migration ~30% through (issue #20 bug 1). The #21
  // env knob (OPENCLAW_DOCTOR_MIGRATION_TIMEOUT) raises the floor — and the
  // cap, when the operator explicitly asks for more than the 30-min ceiling.
  const sizedMigrationBudgetMs = () => {
    const gb = totalStateDbBytes() / (1024 * 1024 * 1024);
    // OPENCLAW_DOCTOR_MIGRATION_TIMEOUT (or an injected override) IS the
    // base, both directions — shorter for constrained platforms, longer past
    // the 30-min ceiling. Its default equals the boot-migration base (10
    // min), so an unset env changes nothing.
    const base = doctorMigrationTimeoutMs;
    const cap = Math.max(kOpenclawBootMigrationMaxTimeoutMs, base);
    return Math.min(
      cap,
      Math.round(base + gb * kOpenclawBootMigrationPerGbMs),
    );
  };

  const computeGateHash = (configRaw, installedVersion) =>
    crypto
      .createHash("sha256")
      .update(String(configRaw ?? ""))
      .update("|")
      .update(String(installedVersion ?? ""))
      .update("|")
      .update(String(kReconcilerPolicyVersion))
      .digest("hex");

  // `config validate` capability probe + blame parse. Returns
  // { available, valid, blamedKeys, tail }.
  const validateConfigWithBin = async (bin) => {
    const result = await runner.runStreamed({
      command: process.execPath,
      args: [bin, "config", "validate"],
      env: openclawSpawnEnv(),
      timeoutMs: kOpenclawBootPreflightTimeoutMs,
    });
    const text = String(result.tail || "");
    if (result.ok) return { available: true, valid: true, blamedKeys: [], tail: text };
    // Parse blame BEFORE the unknown-command check: validator output like
    // 'Unrecognized key: "mystery"' would otherwise match the pattern's
    // "unrecognized" and misclassify an INVALID config as validate-missing.
    const blamed = extractBlamedConfigPaths(text.split(/\r?\n/));
    const blamedKeys = [
      ...blamed.unrecognized,
      ...blamed.invalid.map((entry) => entry.path),
    ];
    // Narrow capability pattern on purpose: a validator error containing the
    // word "unrecognized" (no parsable blame) must classify as INVALID, not
    // validate-missing — see kUnknownCliCommandPattern.
    if (!blamedKeys.length && kUnknownCliCommandPattern.test(text)) {
      return { available: false, valid: null, blamedKeys: [], tail: text };
    }
    return {
      available: true,
      valid: false,
      blamedKeys,
      tail: text,
    };
  };

  // A persisted validator tail flows into channel state and out through
  // GET /api/openclaw/channel — scrub it like every sibling output path (the
  // run-ledger log sink, the medic's blamed problems): a validator can echo
  // a secret value in its error text. Value-match against the spawn env and
  // inline config secrets; redact BEFORE truncating so a secret straddling
  // the cut cannot leak its remainder.
  const redactValidatorTail = (tail) => {
    const text = String(tail ?? "");
    if (!text) return null;
    let configObject = null;
    try {
      configObject = JSON.parse(
        fsModule.readFileSync(resolveOpenclawConfigPath({ openclawDir }), "utf8"),
      );
    } catch {}
    const secrets = collectSecretValues({
      env: openclawSpawnEnv(),
      configObjects: configObject ? [configObject] : [],
    });
    return redactSecrets(text, { secrets }).slice(-2000);
  };

  // Live DB-migration probe (the gateway is NOT running at boot, so reading
  // the live DBs is race-free). Ledger hints are hints, never authority:
  // returns true / false / null (inconclusive).
  const probeDbMigrationNeeded = async (bin) => {
    const dbPaths = enumerateStateDbs();
    if (!dbPaths.length) return false;
    let sawVerdict = false;
    for (const dbPath of dbPaths) {
      const result = await runner.runStreamed({
        command: process.execPath,
        args: [bin, "database", "preflight", dbPath, "--json"],
        env: probeEnv(),
        timeoutMs: kOpenclawBootPreflightTimeoutMs,
      });
      const text = String(result.tail || "");
      // Narrow capability pattern: an incompatibility error mentioning
      // "unrecognized" must stay inconclusive-or-worse, never "unsupported".
      if (kUnknownCliCommandPattern.test(text)) return null;
      const parsed = parseJsonObjectFromNoisyOutput(text);
      if (parsed && typeof parsed === "object") {
        sawVerdict = true;
        if (isMigrationRequiredVerdict(parsed)) return true;
      } else if (!result.ok) {
        return null;
      }
    }
    return sawVerdict ? false : null;
  };

  // Runs in the SERVER boot sequence with the boot lifecycle lock held,
  // strictly before startGateway(). Returns { status, hold } — startup skips
  // the gateway launch on hold. `force` (operator retry) bypasses the
  // re-attempt gate; `stripBlamedKeys` (operator consent) removes the held
  // keys with the shared guarded walk before revalidating.
  //
  // Exit contract: never 'ok' or 'skipped' while state.gatewayHold is set —
  // 'skipped' promises no hold exists (the retry route keys latch clearing
  // and relaunch off the status alone). The reconcileBootConfig wrapper
  // below turns internal machinery errors into a PERSISTED hold too.
  const reconcileBootConfigInner = async ({
    force = false,
    stripBlamedKeys = false,
  } = {}) => {
    const warnings = [];
    const installDir = safeInstallDir();
    const installedVersion = installDir
      ? channelStore.readInstalledVersion({ installDir })
      : null;

    // Crash-safe quarantine recovery runs every boot, even when nothing else
    // does — a crash mid-doctor must never strand openclaw's last-good.
    // Recovering stranded files is a real auto-fix: announce it (day-bucketed
    // id — boot loops dedupe, a genuinely new incident weeks later re-fires).
    try {
      const quarantine = doctorGuard.recoverQuarantinedLastGood();
      if (quarantine?.recovered > 0) {
        queueNotify(
          `🩹 Recovered ${quarantine.recovered} stranded openclaw.json.last-good file(s) from an interrupted repair.`,
          {
            eventType: "recovery",
            id: `quarantine-recovered-${notifyDayBucket()}`,
          },
        );
      }
    } catch {}

    const pendingRun = (() => {
      try {
        return ledger.listRuns().find((run) => run.state === "restart_expected") || null;
      } catch {
        return null;
      }
    })();
    const operationId = pendingRun?.operationId || null;
    const bootStep = (name, status, detail) => {
      if (!operationId) return;
      try {
        ledger.appendStep(operationId, { name, status, ...(detail ? { detail } : {}) });
      } catch {}
    };
    // Resolution deferred from syncAtBoot (issue #20 bug: the run was stamped
    // activated/ok BEFORE the migration ran). Never activation_failed here —
    // the code activation DID succeed, and marking it failed would invite a
    // code rollback against possibly-migrated DBs (the #20 data-loss shape).
    const resolvePendingRun = ({ activated = true } = {}) => {
      try {
        if (pendingRun) {
          ledger.resolveRestartExpected({
            // activated:false only on a migration-gate revert — the code
            // activation was undone before anything launched on it.
            activated,
            detail: warnings.join("; ") || null,
          });
        }
        ledger.pruneRuns();
      } catch {}
    };

    const setHold = (reason, blamedKeys = []) => {
      const hold = {
        reason,
        at: nowFn(),
        operationId,
        blamedKeys: blamedKeys.slice(0, 50),
      };
      channelStore.updateState((s) => {
        s.gatewayHold = hold;
        return s;
      });
      try {
        watchdogLatch?.();
      } catch {}
      logEvent("reconciler", "hold", { reason, blamedKeys: hold.blamedKeys });
      return hold;
    };
    const clearHold = () => {
      channelStore.updateState((s) => {
        s.gatewayHold = null;
        return s;
      });
    };

    if (!installedVersion) {
      resolvePendingRun();
      // Exit contract: a persisted hold from an earlier boot must surface as
      // 'held', never hide behind 'skipped'.
      const priorHold = channelStore.readState().gatewayHold;
      if (priorHold) return { status: "held", hold: priorHold, warnings };
      return { status: "skipped", reason: "no-install", warnings };
    }

    const state = channelStore.readState();
    const migration =
      state.configMigration && typeof state.configMigration === "object"
        ? state.configMigration
        : {};

    const recordAttempt = (ok, error, extra = {}) =>
      channelStore.updateState((s) => {
        const prev =
          s.configMigration && typeof s.configMigration === "object"
            ? s.configMigration
            : {};
        s.configMigration = {
          completedForVersion: ok
            ? installedVersion
            : (prev.completedForVersion ?? null),
          lastAttempt: {
            version: installedVersion,
            at: nowFn(),
            ok,
            error: error || null,
            ...extra,
          },
        };
        return s;
      });

    const configPath = resolveOpenclawConfigPath({ openclawDir });

    // Crash-rollback restore (issue #21 bug 4): THIS boot rolled back to this
    // version (syncAtBoot persisted the marker's target in lastBoot) AND the
    // config was migrated away from it since its pre-fix backup was written
    // (lastAttempt names a different version). Restore that backup even
    // though completedForVersion may already equal this version — skipping it
    // is exactly the blind spot that left the #21 box unbootable. Boot-only:
    // an operator retry (force/strip) must never replay a stale rollback.
    const lastBoot = state.lastBoot || null;
    const rollbackTargetVersion =
      !force && !stripBlamedKeys && lastBoot?.action === "rollback"
        ? lastBoot.rollbackTargetVersion || null
        : null;
    if (
      rollbackTargetVersion &&
      rollbackTargetVersion === installedVersion &&
      migration.lastAttempt &&
      migration.lastAttempt.version &&
      migration.lastAttempt.version !== installedVersion &&
      fsModule.existsSync(configPath)
    ) {
      const rollbackRestorePath = path.join(
        openclawDir,
        `openclaw.json.pre-fix-${installedVersion}.bak`,
      );
      if (fsModule.existsSync(rollbackRestorePath)) {
        try {
          fsModule.copyFileSync(rollbackRestorePath, configPath);
          warnings.push(
            `restored ${path.basename(rollbackRestorePath)} after rolling back to ${installedVersion}; settings changed on the newer version were discarded`,
          );
          queueNotify(
            `ℹ️ Restored the OpenClaw settings saved before you moved past ${installedVersion} (rollback recovery). Settings changed on the newer version were reset.`,
            {
              eventType: "info",
              id: `config-restore-rollback-${installedVersion}`,
            },
          );
          recordAttempt(true);
          clearHold();
          resolvePendingRun();
          return { status: "ok", reason: "rollback-restore", warnings };
        } catch (error) {
          warnings.push(
            `could not restore pre-fix config for rollback to ${installedVersion}: ${error.message}`,
          );
          // fall through to the normal flow
        }
      }
    }

    if (!fsModule.existsSync(configPath)) {
      // No config to migrate yet; mark done so we do not retry every boot.
      recordAttempt(true);
      clearHold();
      resolvePendingRun();
      return { status: "ok", reason: "no-config", warnings };
    }

    if (
      migration.completedForVersion === installedVersion &&
      !state.gatewayHold &&
      !force
    ) {
      resolvePendingRun();
      return { status: "ok", reason: "already-completed", warnings };
    }

    // Round-trip restore: downgrading to a version V for which we saved V's
    // config shape before migrating away from it — restore that backup
    // instead of running V's older doctor on a newer-shaped config
    // (deterministic beats hopeful). Gated on an ACTUAL version regression
    // (a migration completed for a NEWER version): a fresh install's first
    // snapshot is also named pre-fix-<installedVersion>.bak, and an ungated
    // restore let any later forced retry silently overwrite live settings
    // with that first-boot shape. LOUD by design: this replaces the whole
    // file, so the notification names what the swap dropped (paths only).
    const restorePath = path.join(
      openclawDir,
      `openclaw.json.pre-fix-${installedVersion}.bak`,
    );
    if (
      migration.completedForVersion &&
      migration.completedForVersion !== installedVersion &&
      fsModule.existsSync(restorePath)
    ) {
      try {
        let droppedNote = "";
        try {
          const before = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
          const after = JSON.parse(fsModule.readFileSync(restorePath, "utf8"));
          const names = (obj, keyPath) =>
            Object.keys(
              keyPath
                .split(".")
                .reduce((node, key) => (node && node[key]) || {}, obj) || {},
            );
          const dropped = [
            ...names(before, "mcp.servers").filter(
              (name) => !names(after, "mcp.servers").includes(name),
            ).map((name) => `mcp.servers.${name}`),
            ...names(before, "models.providers").filter(
              (name) => !names(after, "models.providers").includes(name),
            ).map((name) => `models.providers.${name}`),
          ];
          if (dropped.length) {
            droppedNote = ` This restore drops: ${dropped.join(", ")}.`;
          }
        } catch {}
        fsModule.copyFileSync(restorePath, configPath);
        // Consume the snapshot: a restore is one-shot per downgrade epoch.
        // The .restored rename stays inside pruneConfigBackups' pattern (so
        // retention still owns it) but can never match restorePath again.
        try {
          fsModule.renameSync(
            restorePath,
            path.join(
              openclawDir,
              `openclaw.json.pre-fix-${installedVersion}.restored.bak`,
            ),
          );
          pruneConfigBackups();
        } catch {}
        warnings.push(
          `restored ${path.basename(restorePath)} for downgrade to ${installedVersion}; settings changed on a newer version were discarded`,
        );
        queueNotify(
          `ℹ️ Restored the OpenClaw settings saved before you moved past ${installedVersion}. Settings changed on the newer version were reset.${droppedNote}`,
          { eventType: "info", id: `config-restore-${installedVersion}` },
        );
        recordAttempt(true);
        clearHold();
        resolvePendingRun();
        return { status: "ok", reason: "round-trip-restore", warnings };
      } catch (error) {
        warnings.push(
          `could not restore pre-fix config for ${installedVersion}: ${error.message}`,
        );
        // fall through to a forward migration
      }
    }

    let configRaw = null;
    try {
      configRaw = fsModule.readFileSync(configPath, "utf8");
    } catch (error) {
      warnings.push(`config unreadable: ${error.message}`);
    }
    const gateHash = computeGateHash(configRaw, installedVersion);

    // Cross-boot re-attempt gate: a failed reconcile re-runs only when the
    // config, the binary, or the policy changed — or the operator asked.
    if (
      !force &&
      !stripBlamedKeys &&
      migration.lastAttempt &&
      migration.lastAttempt.ok === false &&
      migration.lastAttempt.gateHash === gateHash &&
      state.gatewayHold
    ) {
      warnings.push(
        `settings migration for ${installedVersion} still needs attention (unchanged since the last failed attempt)`,
      );
      resolvePendingRun();
      return { status: "held", hold: state.gatewayHold, reused: true, warnings };
    }

    const bin = channelStore.resolvePackageBin(
      path.join(installDir, "node_modules", "openclaw"),
    );
    if (!bin) {
      warnings.push(
        `config migration skipped for ${installedVersion}: could not resolve the openclaw binary`,
      );
      recordAttempt(false, "binary-unresolved", { gateHash });
      resolvePendingRun();
      // Exit contract: never 'skipped' while a hold is persisted.
      if (state.gatewayHold) {
        return { status: "held", hold: state.gatewayHold, warnings };
      }
      return { status: "skipped", reason: "binary-unresolved", warnings };
    }

    bootStep("config-migrate", "running");

    // SNAPSHOT gate (F7): every mutation below (strips, doctor, operator
    // strip) is revertable only through this backup — no snapshot, no doctor.
    // A retry of the SAME failed epoch keeps attempt 1's snapshot: the config
    // on disk already carries that attempt's strips/doctor mutations, and
    // re-copying would overwrite the only pristine pre-migration shape (the
    // existing file still satisfies the no-snapshot-no-doctor gate).
    // The snapshot must NEVER be named after the version being migrated TO —
    // a same-version .bak would read as a downgrade-restore candidate on a
    // later boot and silently disarm the failed-migration retry (#21 bug 4).
    const notSelf = (candidate) =>
      candidate && candidate !== installedVersion ? candidate : null;
    const fromVersion =
      notSelf(migration.completedForVersion) ||
      notSelf(lastBoot?.previousInstalledVersion) ||
      notSelf(state.pinVersion) ||
      "unknown";
    // Redundant re-run AFTER this version's migration already completed (a
    // FORCE retry, or a boot re-entering with a stale hold): the on-disk
    // config is the MIGRATED shape, so re-snapshotting it under the
    // fromVersion name would overwrite the old epoch's pristine
    // pre-fix-<fromVersion>.bak and poison a later downgrade restore.
    // Self-name the snapshot instead — content and name now agree — and keep
    // any existing snapshot untouched. Constraint: a self-named
    // pre-fix-<installedVersion>.bak is INERT as a restore candidate: the
    // crash-rollback restore requires lastAttempt.version !== installedVersion
    // and the round-trip restore requires completedForVersion !==
    // installedVersion, so neither gate can fire on it while this version
    // stays installed.
    const migrationAlreadyCompleted =
      migration.completedForVersion === installedVersion;
    const snapshotPath = path.join(
      openclawDir,
      `openclaw.json.pre-fix-${
        migrationAlreadyCompleted ? installedVersion : fromVersion
      }.bak`,
    );
    const retryOfFailedEpoch =
      migration.lastAttempt?.version === installedVersion &&
      migration.lastAttempt?.ok === false &&
      fsModule.existsSync(snapshotPath);
    const keepExistingSnapshot =
      retryOfFailedEpoch ||
      (migrationAlreadyCompleted && fsModule.existsSync(snapshotPath));
    if (!keepExistingSnapshot) {
      try {
        fsModule.copyFileSync(configPath, snapshotPath);
        pruneConfigBackups();
      } catch (error) {
        warnings.push(`config snapshot failed: ${error.message}`);
        bootStep("config-migrate", "failed", "snapshot failed");
        const hold = setHold(`config snapshot failed: ${error.message}`);
        recordAttempt(false, `snapshot-failed: ${error.message}`, { gateHash });
        queueNotify(
          `⚠️ OpenClaw settings migration was NOT attempted: the pre-migration backup could not be written (${error.message}). The gateway is held until this is resolved — check disk space and permissions, then use Retry migration on the Upgrade page.`,
          { eventType: "health", id: `config-migration-held-${installedVersion}` },
        );
        resolvePendingRun();
        return { status: "held", hold, warnings };
      }
    }

    // Known-safe migrations: rename table + curated retired keys. Anything
    // here is confidently ours to fix; unknown keys are NOT (X8).
    const renamedKeys = [];
    const removedKeys = [];
    const operatorStripKeys =
      stripBlamedKeys && state.gatewayHold?.blamedKeys?.length
        ? state.gatewayHold.blamedKeys
        : [];
    try {
      updateOpenclawConfig({
        fsModule,
        openclawDir,
        mutate: (config) => {
          if (detectAgentsShape(config) === "list") {
            const keyed = agentsArrayToKeyed(config.agents.list);
            if (keyed) {
              config.agents.entries = keyed;
              delete config.agents.list;
              renamedKeys.push("agents.list → agents.entries");
            }
          }
          const stripTargets = [
            ...retiredKeysForVersion(installedVersion),
            ...operatorStripKeys,
          ];
          removedKeys.push(
            ...removeKeyPathsFromConfigObject(config, stripTargets, {
              skipKeyPath: (keyPath) => isProtectedKeyPath(keyPath),
            }),
          );
        },
      });
    } catch (error) {
      // JSON5/$include configs fail closed out of AlphaClaw's strict writer —
      // doctor (openclaw's own tooling) is the right layer for those.
      warnings.push(`known-safe migrations skipped: ${error.message}`);
    }
    if (renamedKeys.length || removedKeys.length) {
      logEvent("reconciler", "migrated", { renamedKeys, removedKeys });
      queueNotify(
        `ℹ️ OpenClaw settings migrated for ${installedVersion}: ${[...renamedKeys, ...removedKeys.map((k) => `removed ${k}`)].join(", ")}. A backup was saved first (${path.basename(snapshotPath)}).`,
        { eventType: "info", id: `config-migrated-${installedVersion}` },
      );
    }

    // Validate + DB-migration need. Hint from the apply-time run record;
    // live probe when absent; inconclusive → doctor runs (conservative — the
    // old code ran doctor on every version change, and #20 proved skipping
    // state migration is the expensive mistake).
    let validation = await validateConfigWithBin(bin);
    const hint = pendingRun?.dbPreflight || null;
    let dbMigrationNeeded =
      hint && typeof hint.migrationRequired === "boolean"
        ? hint.migrationRequired
        : null;
    if (dbMigrationNeeded === null) {
      bootStep("db-migrate", "running", "probing database compatibility");
      dbMigrationNeeded = await probeDbMigrationNeeded(bin);
      // Close what the probe opened: a no-migration verdict otherwise leaves
      // the step 'running' forever on the placeholder/UI timeline.
      if (dbMigrationNeeded === false) {
        bootStep("db-migrate", "completed", "no database migration needed");
      }
    }
    if (dbMigrationNeeded === null) dbMigrationNeeded = true;

    const needsDoctor =
      validation.valid !== true || dbMigrationNeeded === true;
    // doctor --fix rewrites the live state DBs, and the reconciler's "the
    // gateway is NOT running at boot" assumption only covers OUR managed
    // child. An externally-supervised `openclaw gateway run` (VPS supervisor
    // outside this process) can be live right now — running doctor against
    // its open DBs is the corruption the quiesce machinery exists to prevent.
    // Fail CLOSED with a hold naming the running gateway. The bin-phase
    // boot-sync factory has no gatewayQuiesce dep, so absence skips the check
    // exactly as before. No gateHash on the failed attempt: a stopped gateway
    // does not change the config hash, and the next boot must retry.
    if (needsDoctor && typeof gatewayQuiesce?.isRunning === "function") {
      let externalGatewayRunning = false;
      try {
        externalGatewayRunning = Boolean(await gatewayQuiesce.isRunning());
      } catch {}
      if (externalGatewayRunning) {
        const reason = `settings migration for ${installedVersion} was not attempted: a gateway process is running — stop it, then Retry migration`;
        warnings.push(reason);
        bootStep("config-migrate", "failed", "a gateway process is running");
        // Close what the probe opened: no step may be left 'running' after
        // the reconciler returns.
        if (dbMigrationNeeded) {
          bootStep("db-migrate", "failed", "a gateway process is running");
        }
        const hold = setHold(reason, validation.blamedKeys || []);
        recordAttempt(false, "gateway-running");
        queueNotify(
          `⚠️ OpenClaw settings migration was NOT attempted: a gateway process is already running, and migrating live databases can corrupt them. Stop the gateway (or its external supervisor), then use Retry migration on the Upgrade page.`,
          { eventType: "health", id: `config-migration-held-${installedVersion}` },
        );
        resolvePendingRun();
        return { status: "held", hold, warnings };
      }
    }
    let doctorRan = false;
    let doctorOutcome = null;
    if (needsDoctor) {
      const budgetMs = sizedMigrationBudgetMs();
      bootStep(
        dbMigrationNeeded ? "db-migrate" : "config-migrate",
        "running",
        `running doctor --fix (budget ${Math.round(budgetMs / 60000)} min)`,
      );
      doctorRan = true;
      doctorOutcome = await doctorGuard.withDoctorRestoreGuard({
        operationId,
        run: () =>
          runner.runStreamed({
            command: process.execPath,
            // Never combine --fix with --json (beta rejects the combo).
            args: [bin, "doctor", "--fix", "--yes"],
            env: openclawSpawnEnv(),
            timeoutMs: budgetMs,
          }),
      });
      if (doctorOutcome.code === "doctor_restored_stale_config") {
        warnings.push(
          `doctor tried to restore a stale last-known-good config (${doctorOutcome.signals.join(", ")}); AlphaClaw reverted it — settings unchanged`,
        );
        logEvent("reconciler", "doctor_restore_reverted", {
          signals: doctorOutcome.signals,
          droppedKeyPaths: doctorOutcome.droppedKeyPaths,
        });
        queueNotify(
          buildDoctorRestoreBlockedNotification(
            doctorOutcome.droppedKeyPaths.length,
            { held: true },
          ),
          { eventType: "health", id: `doctor-restore-blocked-${installedVersion}` },
        );
      } else if (doctorOutcome.timedOut) {
        warnings.push(
          `doctor --fix timed out after its sized budget; the migration process group was terminated`,
        );
        // Post-kill diagnostic (X4): record whether the kill left the DBs
        // consistent so the operator sees the blast radius immediately.
        const verdict = await probeDbMigrationNeeded(bin);
        bootStep(
          "db-migrate",
          "warning",
          verdict === false
            ? "databases report consistent after the timeout"
            : "database state after the timeout is unverified",
        );
      }
      // Re-validate on the migrated config (when the build can).
      validation = await validateConfigWithBin(bin);
    }

    const configHealthy =
      validation.valid === true ||
      (validation.available === false &&
        (!doctorRan || doctorOutcome?.ok === true));

    if (configHealthy) {
      bootStep("config-migrate", "completed");
      // Close the db-migrate step on every doctor outcome (the timeout
      // branch above already closed it with its post-kill verdict).
      if (dbMigrationNeeded && doctorRan && !doctorOutcome?.timedOut) {
        bootStep(
          "db-migrate",
          doctorOutcome?.ok ? "completed" : "warning",
          doctorOutcome?.ok
            ? undefined
            : "doctor did not complete — database migration state unverified",
        );
      }
      recordAttempt(true, null, { gateHash });
      clearHold();
      logEvent("reconciler", "completed", {
        doctorRan,
        renamedKeys,
        removedKeys,
      });
      // A doctor run that completed here IS the automatic migration/repair —
      // the single most consequential silent mutation this box performs.
      // Failures already notify; the success must too. One notice per
      // migration episode (from→to pair, mirroring config-migrated-<v>).
      if (doctorRan && doctorOutcome?.ok === true) {
        queueNotify(
          `🩺 OpenClaw automatic repair completed for ${installedVersion} — settings/databases updated; a backup was saved first.`,
          {
            eventType: "recovery",
            id: `db-migrated-${fromVersion}-${installedVersion}`,
          },
        );
      }
      log(`boot: settings reconciled for ${installedVersion}`);
      resolvePendingRun();
      return { status: "ok", warnings, renamedKeys, removedKeys };
    }

    // Fail CLOSED: the gateway never starts on a config this build rejects
    // (issue #20 bug 2: fail-open here became an exit-78 crash loop that took
    // the box down). The full admin UI stays up; the operator gets the exact
    // keys and one-click retry/strip actions.
    const blamedKeys = validation.blamedKeys || [];
    const doctorNote =
      doctorOutcome?.code === "doctor_restored_stale_config"
        ? "doctor attempted a stale restore (blocked)"
        : doctorOutcome?.timedOut
          ? "doctor timed out"
          : doctorRan
            ? "doctor did not repair the config"
            : "doctor was not run";
    bootStep("config-migrate", "failed", doctorNote);
    // Close the db-migrate step on the hold path too (the timeout branch
    // already closed it with its post-kill verdict): a doctor that ran the
    // migration successfully still 'completed' it even though the config
    // stays invalid; a failed doctor closes it 'failed'.
    if (dbMigrationNeeded && doctorRan && !doctorOutcome?.timedOut) {
      bootStep(
        "db-migrate",
        doctorOutcome?.ok ? "completed" : "failed",
        doctorOutcome?.ok ? undefined : doctorNote,
      );
    }
    // Migration hard gate (#21 bug 2) — boot phase only: on a fresh apply
    // whose migration failed, revert to a preflight-proven older build with
    // its pre-migration settings restored and blocklist the target, BEFORE
    // anything launches on it. The gate declines (and we fall through to the
    // hold) when reverting is the more dangerous move — part-migrated state
    // DBs, no restorable snapshot, no compatible target, or the kill switch.
    // Operator retries (force/strip) stay in hold-land: the operator is
    // present and consent-driven recovery beats a silent revert.
    if (!force && !stripBlamedKeys) {
      const gate = await abortFailedMigrationBoot({
        installDir,
        state: channelStore.readState(),
        warnings,
        migration: {
          fromVersion,
          error: doctorNote,
          errorTail: validation.tail ? redactValidatorTail(validation.tail) : null,
          bakWritten: fsModule.existsSync(snapshotPath),
        },
        action: lastBoot?.action || "none",
      });
      if (gate.aborted) {
        bootStep("config-migrate", "failed", "reverted before first launch");
        clearHold();
        resolvePendingRun({ activated: false });
        logEvent("reconciler", "migration_gate_reverted", {
          blocked: installedVersion,
        });
        return { status: "ok", reason: "migration-gate-reverted", warnings };
      }
    }
    const hold = setHold(
      `settings migration for ${installedVersion} failed: ${doctorNote}`,
      blamedKeys,
    );
    // Strips/doctor may have mutated the config since gateHash was taken —
    // store a hash of the CURRENT on-disk config so the next boot's
    // re-attempt gate (which hashes what IT reads) can actually hold instead
    // of re-running the sized doctor budget on every crash-loop restart.
    let failedGateHash = gateHash;
    try {
      failedGateHash = computeGateHash(
        fsModule.readFileSync(configPath, "utf8"),
        installedVersion,
      );
    } catch {}
    recordAttempt(false, doctorNote, {
      gateHash: failedGateHash,
      tail: validation.tail ? redactValidatorTail(validation.tail) : null,
    });
    queueNotify(
      `⚠️ OpenClaw ${installedVersion} rejects the current settings and automatic migration did not complete (${doctorNote}). The gateway is HELD to protect your data — nothing was deleted. Blamed settings: ${blamedKeys.length ? blamedKeys.join(", ") : "(none parsed)"}. Open the Upgrade page to Retry migration or strip the blamed keys.`,
      { eventType: "health", id: `config-migration-held-${installedVersion}` },
    );
    resolvePendingRun();
    return { status: "held", hold, warnings, blamedKeys };
  };

  // Machinery-error backstop: an unexpected throw must become a PERSISTED
  // hold, never propagate — startup.js only keeps an in-memory flag, so an
  // unpersisted hold lets the watchdog relaunch the gateway on the
  // unreconciled config it exists to protect.
  const reconcileBootConfig = async (options = {}) => {
    try {
      return await reconcileBootConfigInner(options);
    } catch (error) {
      const reason = `reconcile error: ${error?.message || error}`;
      let operationId = null;
      try {
        operationId =
          ledger.listRuns().find((run) => run.state === "restart_expected")
            ?.operationId || null;
      } catch {}
      let installedVersion = null;
      try {
        const installDir = safeInstallDir();
        installedVersion = installDir
          ? channelStore.readInstalledVersion({ installDir })
          : null;
      } catch {}
      const hold = { reason, at: nowFn(), operationId, blamedKeys: [] };
      try {
        channelStore.updateState((s) => {
          s.gatewayHold = hold;
          const prev =
            s.configMigration && typeof s.configMigration === "object"
              ? s.configMigration
              : {};
          s.configMigration = {
            completedForVersion: prev.completedForVersion ?? null,
            // No gateHash on purpose: the re-attempt gate must not reuse a
            // machinery failure — the next boot retries the real work.
            lastAttempt: {
              version: installedVersion,
              at: nowFn(),
              ok: false,
              error: reason,
            },
          };
          return s;
        });
      } catch {}
      try {
        watchdogLatch?.();
      } catch {}
      logEvent("reconciler", "hold", { reason, blamedKeys: [] });
      // The machinery-error backstop HOLDS the gateway (the agent stops
      // responding) — the one hold path that previously notified nothing.
      // Signature-keyed id: a boot loop on the same failure dedupes, a
      // different failure still alerts.
      queueNotify(
        `🔴 OpenClaw settings reconciliation crashed (${sanitizeNotificationText(reason)}). The gateway is HELD to protect your data — open the Upgrade page to retry.`,
        {
          eventType: "health",
          id: `reconcile-machinery-hold-${installedVersion}-${notifyReasonHash(reason)}`,
        },
      );
      return { status: "held", hold, warnings: [reason] };
    }
  };

  // ── Boot rollback preflight (issue #21 bug 3) ────────────────────────────
  //
  // Snapshot the state DBs ONCE (WAL-consistent VACUUM INTO), then probe each
  // candidate binary against its own COPY of the snapshot — probe read-only-
  // ness is an assumption, not a guarantee, so candidates never share a file.
  // The whole prober draws from the shared boot-ops budget.
  const kBootPreflightPerProbeMs = 120000;
  const createBootPreflightProber = () => {
    const budgetMs = Math.min(
      kOpenclawBootPreflightBudgetMs,
      remainingBootOpsMs(),
    );
    const startedAt = Date.now();
    const remaining = () => budgetMs - (Date.now() - startedAt);
    const dbPaths = enumerateStateDbs();
    const snapshots = [];
    let snapped = false;
    // Deliberately synchronous even under probeBinStreamed: VACUUM INTO is a
    // one-time, seconds-scale block for incident-class DBs (hundreds of MB),
    // taken once per prober — the event-loop hazard was the per-candidate
    // ≤120s execFileSync probes, not this bounded snapshot.
    const ensureSnapshots = () => {
      if (snapped) return;
      snapped = true;
      for (const dbPath of dbPaths) {
        const snapPath = path.join(
          os.tmpdir(),
          `alphaclaw-boot-preflight-${nowFn()}-${path.basename(dbPath)}`,
        );
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
          } finally {
            db.close();
          }
          snapshots.push(snapPath);
        } catch {
          // Our snapshot failure is not the target's incompatibility.
        }
      }
    };
    // "pass" | "unsupported" | "block" | "budget_exhausted" | null
    // (null = nothing to check / could not check — never the target's fault).
    const probeBin = (bin) => {
      try {
        if (!bin) return null;
        if (dbPaths.length === 0) return "pass";
        ensureSnapshots();
        if (snapshots.length === 0) return null;
        for (const snapPath of snapshots) {
          if (remaining() < 5000) return "budget_exhausted";
          const probeCopy = `${snapPath}.probe-${crypto.randomUUID().slice(0, 8)}`;
          try {
            fsModule.copyFileSync(snapPath, probeCopy);
          } catch {
            continue;
          }
          try {
            execFileSyncImpl(
              process.execPath,
              [bin, "database", "preflight", probeCopy, "--json"],
              {
                env: probeEnv(),
                timeout: Math.max(
                  10_000,
                  Math.min(kBootPreflightPerProbeMs, remaining()),
                ),
                stdio: "pipe",
              },
            );
          } catch (error) {
            const text = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
            return kUnknownCommandPattern.test(text) ? "unsupported" : "block";
          } finally {
            try {
              fsModule.rmSync(probeCopy, { force: true });
            } catch {}
          }
        }
        return "pass";
      } catch {
        return null;
      }
    };
    // Async twin of probeBin for the SERVER-phase migration gate: the sync
    // execFileSync probes (≤120s per candidate per DB, budget ≤8 min) froze
    // the event loop — /health went unanswered and platforms killed the
    // container mid-gate. Same args/env/per-probe timeout/verdicts as
    // probeBin; only the spawn is async (runner.runStreamed). The bin-phase
    // rollback chooser (chooseBootRollbackTarget) keeps the sync probeBin —
    // it runs before the server (and its event loop's consumers) exists.
    const probeBinStreamed = async (bin) => {
      try {
        if (!bin) return null;
        if (dbPaths.length === 0) return "pass";
        ensureSnapshots();
        if (snapshots.length === 0) return null;
        for (const snapPath of snapshots) {
          if (remaining() < 5000) return "budget_exhausted";
          const probeCopy = `${snapPath}.probe-${crypto.randomUUID().slice(0, 8)}`;
          try {
            fsModule.copyFileSync(snapPath, probeCopy);
          } catch {
            continue;
          }
          try {
            const result = await runner.runStreamed({
              command: process.execPath,
              args: [bin, "database", "preflight", probeCopy, "--json"],
              env: probeEnv(),
              timeoutMs: Math.max(
                10_000,
                Math.min(kBootPreflightPerProbeMs, remaining()),
              ),
            });
            if (!result.ok) {
              const text = `${result.tail || ""}\n${result.stderr || ""}`;
              return kUnknownCommandPattern.test(text) ? "unsupported" : "block";
            }
          } finally {
            try {
              fsModule.rmSync(probeCopy, { force: true });
            } catch {}
          }
        }
        return "pass";
      } catch {
        return null;
      }
    };
    const cleanup = () => {
      for (const snapPath of snapshots) {
        try {
          fsModule.rmSync(snapPath, { force: true });
        } catch {}
      }
    };
    return { probeBin, probeBinStreamed, cleanup };
  };

  // The C1 warning wordings are load-bearing (asserted by tests, read by
  // operators) — keep them verbatim.
  const preflightUnsupportedWarning = (version) =>
    `rollback target ${version} cannot verify state written by the newer version — ` +
    "the backup taken before the update is the recovery path if anything looks wrong";
  const preflightBlockWarning = (version) =>
    `rollback target ${version} reports it cannot safely read the current database — ` +
    "state written by the newer version may be lost; the backup taken before the update is the recovery path";

  // `openclaw database preflight` first shipped in the 2026.8 line (verified
  // absent from the 2026.7.1-2 dist, present from 2026.8.1).
  const kDatabasePreflightMinCoreVersion = "2026.8.0";
  const lacksDatabasePreflight = (version) => {
    const core = String(version || "").trim().split("-")[0];
    return Boolean(
      core && compareVersionParts(core, kDatabasePreflightMinCoreVersion) < 0,
    );
  };

  // Config-shape guard (issue #21 bug 3): a DB probe cannot see openclaw.json.
  // Keyed `agents.entries` first shipped in the 2026.9.1 line (#21: the beta
  // migrated agents.list → agents.entries; the 2026.7 pin exit-78s on it). An
  // entries-shaped config with no pre-fix backup to restore makes any older
  // target unbootable — treat it like a preflight block.
  const kAgentsEntriesMinCoreVersion = "2026.9.1";
  const rollbackTargetShapeBlocked = (version) => {
    try {
      if (!version) return false;
      const core = String(version).trim().split("-")[0];
      if (
        !core ||
        compareVersionParts(core, kAgentsEntriesMinCoreVersion) >= 0
      ) {
        return false;
      }
      const cfg = JSON.parse(
        fsModule.readFileSync(
          resolveOpenclawConfigPath({ openclawDir }),
          "utf8",
        ),
      );
      if (detectAgentsShape(cfg) !== "entries") return false;
      return !fsModule.existsSync(
        path.join(openclawDir, `openclaw.json.pre-fix-${version}.bak`),
      );
    } catch {
      // Unreadable/unparseable config: the restore and medic layers own that.
      return false;
    }
  };

  // Choose (and validate) the actual boot-rollback target (issue #21 bug 3):
  // preflight EVERY candidate — package targets AND the pin — reroute a
  // blocked target to the next compatible candidate, and refuse the rollback
  // outright when nothing can read the migrated state. Landing on a provably
  // unbootable target is how the #21 box ended with zero bootable versions.
  const chooseBootRollbackTarget = ({ marker, state, installDir }) => {
    const prober = createBootPreflightProber();
    try {
      const overlayBin = (version) =>
        version && channelStore.hasOverlay(version)
          ? channelStore.resolvePackageBin(
              channelStore.overlayPackageDir(version),
            )
          : null;
      const pinBin = () => {
        let bin = overlayBin(state.pinVersion);
        if (!bin && state.pinVersion) {
          // No pin overlay: when the installed tree IS the pin, probe it
          // (best-effort — null just means "could not check").
          const installedVersion = channelStore.readInstalledVersion({
            installDir,
          });
          if (installedVersion === state.pinVersion) {
            bin = channelStore.resolvePackageBin(
              path.join(installDir, "node_modules", "openclaw"),
            );
          }
        }
        return bin || null;
      };
      const candidates = [];
      const target = marker.target || {};
      // A pin-window rollback is blocklisting the pin itself: the pin is never
      // a fallback candidate, and a package target must really exist locally
      // (a missing overlay must not quietly degrade into "use the pin").
      const pinRollback = marker.source === "pin";
      const pinIsBlocked =
        pinRollback ||
        (marker.blockedId && marker.blockedId === state.pinVersion) ||
        channelStore.isBlocklisted(state.pinVersion);
      if (target.kind === "package" && target.version) {
        candidates.push({
          kind: "package",
          channel: target.channel || "stable",
          version: target.version,
          bin: overlayBin(target.version),
        });
        if (
          !pinIsBlocked &&
          state.pinVersion &&
          state.pinVersion !== target.version
        ) {
          candidates.push({
            kind: "pin",
            version: state.pinVersion,
            bin: pinBin(),
          });
        }
      } else if (!pinIsBlocked) {
        candidates.push({
          kind: "pin",
          version: state.pinVersion,
          bin: pinBin(),
        });
      }
      if (target.kind !== "package" || pinRollback) {
        const lkg = state.lastKnownGood?.package;
        if (
          lkg &&
          lkg !== state.pinVersion &&
          lkg !== marker.blockedId &&
          lkg !== target.version &&
          !channelStore.isBlocklisted(lkg) &&
          channelStore.hasOverlay(lkg)
        ) {
          candidates.push({
            kind: "package",
            channel: "stable",
            version: lkg,
            bin: overlayBin(lkg),
          });
        }
      }
      const rejected = [];
      for (const candidate of candidates) {
        if (rollbackTargetShapeBlocked(candidate.version)) {
          rejected.push({
            version: candidate.version,
            warning: `rollback target ${candidate.version} cannot read the migrated settings shape (agents.entries) and no pre-fix settings backup exists for it`,
          });
          continue;
        }
        if (pinRollback && candidate.kind === "package" && !candidate.bin) {
          rejected.push({
            version: candidate.version,
            warning: `rollback target ${candidate.version} has no local overlay to activate`,
          });
          continue;
        }
        let verdict = prober.probeBin(candidate.bin);
        if (
          verdict === "unsupported" &&
          pinRollback &&
          lacksDatabasePreflight(candidate.version)
        ) {
          // Lines before 2026.8 have no `database preflight` at all, so
          // "unsupported" proves nothing about the migrated state — inside a
          // pin window that is a refusal, not a warn-and-proceed.
          verdict = "block";
        }
        if (verdict === "block") {
          rejected.push({
            version: candidate.version,
            warning: preflightBlockWarning(candidate.version),
          });
          continue;
        }
        const warning =
          verdict === "unsupported"
            ? preflightUnsupportedWarning(candidate.version)
            : verdict === "budget_exhausted"
              ? `rollback preflight budget exhausted — proceeding to ${candidate.version} unverified`
              : null;
        return { candidate, warning, rejected };
      }
      return { refused: true, rejected };
    } finally {
      prober.cleanup();
    }
  };

  // Migration hard gate (issue #21 bug 2 — THE fix): a failed config
  // migration on a freshly applied build must abort BEFORE that build ever
  // runs — its first boot one-way migrates openclaw.json and the state DB,
  // stranding every older version. Runs on the reconciler's FAILURE path:
  // every decline ({aborted:false} — kill switch, no restorable snapshot, no
  // preflight-clean target, internal error) falls through to the fail-closed
  // gateway HOLD, never a launch on the rejected config.
  // Async on purpose: the revert-target preflights stream through the runner
  // (probeBinStreamed) so the server event loop keeps answering /health — the
  // only caller is the async reconciler.
  const abortFailedMigrationBoot = async ({
    installDir,
    state,
    warnings,
    migration,
    action,
  }) => {
    const none = { state, aborted: false };
    try {
      if (
        String(process.env.OPENCLAW_MIGRATION_GATE || "").toLowerCase() ===
        "off"
      ) {
        warnings.push(
          "migration gate disabled (OPENCLAW_MIGRATION_GATE=off) — holding the gateway instead of reverting",
        );
        return none;
      }
      const applied = state.applied;
      const installedVersion = channelStore.readInstalledVersion({
        installDir,
      });
      // Only gate a non-pin package build that is actually the installed
      // tree. Pin boots have no older target to return to; dev boots migrate
      // for the dormant pin; rollback boots are owned by the restore path.
      if (!applied || applied.channel === "dev") return none;
      if (!installedVersion || applied.version !== installedVersion) {
        return none;
      }
      if (action === "rollback" || action === "rollback_refused") return none;
      // A restorable config is a precondition: reverting the binary while the
      // config may already be candidate-mutated recreates the exact brick.
      const bakPath = migration.fromVersion
        ? path.join(
            openclawDir,
            `openclaw.json.pre-fix-${migration.fromVersion}.bak`,
          )
        : null;
      if (!bakPath || !fsModule.existsSync(bakPath)) {
        warnings.push(
          `migration gate skipped for ${installedVersion}: no restorable pre-fix settings backup — holding the gateway`,
        );
        return none;
      }
      // Revert target: the version the config is still shaped for, else the
      // pin, else a usable last-known-good — each must exist locally as an
      // overlay AND pass a preflight against the (possibly part-migrated)
      // state DB. A timed-out doctor may have already migrated some of it, in
      // which case the new build owns that state and is the safer run.
      const completedFor = state.configMigration?.completedForVersion || null;
      const lkg = state.lastKnownGood?.package;
      const revertCandidates = [];
      if (completedFor && completedFor !== installedVersion) {
        revertCandidates.push(completedFor);
      }
      if (state.pinVersion && !revertCandidates.includes(state.pinVersion)) {
        revertCandidates.push(state.pinVersion);
      }
      if (
        lkg &&
        lkg !== installedVersion &&
        !channelStore.isBlocklisted(lkg) &&
        !revertCandidates.includes(lkg)
      ) {
        revertCandidates.push(lkg);
      }
      const prober = createBootPreflightProber();
      let revertVersion = null;
      let revertBlocked = false;
      try {
        for (const version of revertCandidates) {
          if (!channelStore.hasOverlay(version)) continue;
          const verdict = await prober.probeBinStreamed(
            channelStore.resolvePackageBin(
              channelStore.overlayPackageDir(version),
            ),
          );
          if (verdict === "block") {
            revertBlocked = true;
            continue;
          }
          revertVersion = version;
          break;
        }
      } finally {
        prober.cleanup();
      }
      if (!revertVersion) {
        warnings.push(
          revertBlocked
            ? `migration gate: no revert target can read the current state — holding the gateway on ${installedVersion}`
            : `migration gate skipped for ${installedVersion}: no local revert target — holding the gateway`,
        );
        return none;
      }
      // Crash-window ordering (idempotent by construction): blocklist →
      // config restore → overlay re-activate → applied update. A kill between
      // any two steps leaves the migration trigger armed (completedForVersion
      // unchanged), so the next boot re-enters this gate; addBlocklist dedups.
      channelStore.addBlocklist({
        id: installedVersion,
        reason: "config_migration_failed",
        exitCode: null,
      });
      try {
        fsModule.copyFileSync(
          bakPath,
          resolveOpenclawConfigPath({ openclawDir }),
        );
      } catch (error) {
        warnings.push(
          `migration gate: pre-fix config restore failed (${error.message})`,
        );
      }
      const activation = channelStore.activateOverlay({
        installDir,
        version: revertVersion,
      });
      let newState = state;
      if (activation.ok) {
        channelStore.removeBinShim();
        newState = channelStore.updateState((s) => {
          s.applied =
            revertVersion === s.pinVersion
              ? null
              : {
                  channel: state.applied?.channel || "stable",
                  version: revertVersion,
                  at: nowFn(),
                  // Same re-accepted semantic as a rollback boot: a
                  // previously good build re-enters a fresh window.
                  acceptedAt: nowFn(),
                };
          return s;
        });
      } else {
        activatePinFallback({
          installDir,
          state,
          warnings,
          reason: `migration gate revert activation failed (${activation.error}) — using pin`,
        });
        newState = channelStore.updateState((s) => {
          s.applied = null;
          return s;
        });
      }
      warnings.push(
        `config migration failed for ${installedVersion} — reverted to ${revertVersion} before first launch (build blocklisted)`,
      );
      const message =
        `🔴 OpenClaw ${installedVersion} was stopped before its first launch: the settings migration ${migration.error || "failed"}. ` +
        `Reverted to ${revertVersion} with the previous settings restored. ` +
        `${installedVersion} was blocklisted — use Clear → Try again on the Upgrade page to retry.` +
        (migration.errorTail ? `\nDoctor output: ${migration.errorTail}` : "") +
        (migration.bakWritten
          ? ""
          : "\n⚠️ The pre-migration settings backup could not be written this boot; the restored settings came from an earlier backup.");
      queueNotify(message, {
        eventType: "upgrade_failed",
        id: `config-migration-aborted-${installedVersion}`,
      });
      postBootWebhook(message);
      logEvent("config_migration_gate", "reverted", {
        blocked: installedVersion,
        revertedTo: revertVersion,
        error: migration.error,
      });
      return { state: newState, aborted: true };
    } catch (error) {
      warnings.push(
        `migration gate error (${error.message}) — holding the gateway`,
      );
      return none;
    }
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
      // Start the shared boot heavy-ops clock (doctor migration + preflights).
      bootOpsStartedAt = Date.now();
      // What was installed BEFORE this boot's activation branches ran — names
      // the pre-fix backup honestly when configMigration has no history yet.
      const previousInstalledVersion = channelStore.readInstalledVersion({
        installDir,
      });
      // Set by the rollback-marker branch: the version that actually ended up
      // active, so the migration step can restore that version's pre-fix
      // settings backup (issue #21 bug 4).
      let rollbackTargetVersion = null;
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
        const installedVersion = channelStore.readInstalledVersion({
          installDir,
        });
        state = channelStore.updateState((s) => {
          // The rollback target is what actually RAN before the bump: a
          // stable overlay we were parked on (e.g. after an earlier pin
          // rollback) beats the declared pin, and a blocklisted old pin
          // yields to the last-known-good package.
          const parkedStable =
            s.applied?.channel === "stable" && s.applied.version
              ? s.applied.version
              : null;
          const candidates = [parkedStable, s.pinVersion, s.lastKnownGood?.package];
          const previousVersion =
            candidates.find(
              (version) =>
                version &&
                version !== declaredPin &&
                !s.blocklist.some((entry) => entry.id === version),
            ) || null;
          s.previousPin = previousVersion
            ? { version: previousVersion, at: nowFn() }
            : null;
          s.pinVersion = declaredPin;
          // The new pin's own 24h watch. It only starts once the installed
          // tree IS the new pin — on VPS installs npm may still be catching
          // up, so an unopened window waits for a later boot to arm it.
          s.pinWindow = {
            version: declaredPin,
            openedAt: installedVersion === declaredPin ? nowFn() : null,
            acceptedAt: null,
            acceptedSource: null,
          };
          if (
            s.applied &&
            s.applied.channel === "stable" &&
            compareVersionParts(s.applied.version, declaredPin) < 0 &&
            !s.blocklist.some((entry) => entry.id === declaredPin)
          ) {
            // The new shipped pin supersedes an older explicit stable pick —
            // unless that pin is blocklisted: a pin-window rollback parked us
            // on the previous pin on purpose, and re-activating the blocked
            // pin here would undo it every boot.
            s.applied = null;
          }
          return s;
        });
        if (installedVersion === declaredPin) {
          channelStore.snapshotPinFromInstall({
            installDir,
            pinVersion: declaredPin,
          });
        }
        action = "pin_reconciled";
      }

      // Rollback marker: choose + validate the target (issue #21 bug 3 —
      // every candidate, including the pin, is preflighted; a blocked target
      // reroutes to the next compatible candidate; nothing compatible refuses
      // the rollback), then activate the survivor offline.
      const marker = channelStore.readMarker();
      if (marker && marker.target) {
        const choice = chooseBootRollbackTarget({ marker, state, installDir });
        for (const rejectedEntry of choice.rejected || []) {
          if (!rejectedEntry?.warning) continue;
          warnings.push(rejectedEntry.warning);
          queueNotify(`⚠️ ${rejectedEntry.warning}`, {
            eventType: "health",
            id: `boot-rollback-preflight-${rejectedEntry.version || "target"}`,
          });
        }
        if (choice.refused) {
          // Refusal (issue #21 bugs 3/10): every candidate provably cannot
          // read the migrated state. Landing on an unbootable target is
          // strictly worse than keeping the blocked-but-compatible build
          // running under the watchdog latch — keep the installed build,
          // clear the marker (no loop), and say so unmissably.
          action = "rollback_refused";
          channelStore.clearMarker();
          state = channelStore.updateState((s) => {
            s.rollbackRefused = {
              at: nowFn(),
              blockedId: marker.blockedId || null,
              reason: "no_compatible_target",
            };
            return s;
          });
          const newestBackup = newestArchiveName();
          const refusalMessage =
            `🔴 Rollback refused: no OpenClaw version on this box can read the migrated state` +
            ` (requested after ${marker.reason || "a failure"} on ${marker.blockedId || "the current build"}).` +
            ` Continuing on the current build.` +
            (newestBackup
              ? ` Manual recovery path: restore ${newestBackup} (see the "downgrade landed on migrated state" runbook step).`
              : " Manual recovery: restore the newest openclaw-backup archive.");
          warnings.push(
            "rollback refused: no compatible target for the migrated state",
          );
          queueNotify(refusalMessage, {
            eventType: "upgrade_failed",
            id: `rollback-refused-${marker.blockedId || "unknown"}`,
          });
          postBootWebhook(refusalMessage);
          logEvent("channel_rollback", "refused", {
            blockedId: marker.blockedId || null,
            reason: marker.reason || null,
          });
        } else {
          action = "rollback";
          const chosen = choice.candidate;
          if (choice.warning) {
            warnings.push(choice.warning);
            queueNotify(`⚠️ ${choice.warning}`, {
              eventType: "health",
              id: `boot-rollback-preflight-${chosen.version || "pin"}`,
            });
          }
          if (chosen.kind === "package" && chosen.version) {
            // Record what ACTUALLY ended up active: if overlay activation
            // falls back to the pin, `applied` must not claim the target is
            // running — a later pin crash would blocklist a build that isn't
            // live, and every boot would re-detect phantom drift.
            let targetActivated = false;
            if (channelStore.hasOverlay(chosen.version)) {
              const result = channelStore.activateOverlay({
                installDir,
                version: chosen.version,
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
            rollbackTargetVersion = targetActivated
              ? chosen.version
              : state.pinVersion;
            state = channelStore.updateState((s) => {
              s.applied =
                !targetActivated || chosen.version === s.pinVersion
                  ? null
                  : {
                      channel: chosen.channel || "stable",
                      version: chosen.version,
                      at: nowFn(),
                      // A last-known-good target was already accepted once;
                      // it re-enters a fresh stabilization window regardless.
                      acceptedAt: nowFn(),
                      reason: marker.source === "pin" ? "pin_rollback" : null,
                    };
              if (marker.source === "pin" && !targetActivated) {
                // The only local fallback IS the blocklisted pin: say so
                // instead of pretending the rollback landed.
                s.rollbackRefused = {
                  at: nowFn(),
                  blockedId: marker.blockedId || null,
                  reason: "pin_rollback_activation_failed",
                };
              }
              return s;
            });
          } else {
            // Pin target: the container image reset usually restored it
            // already; on VPS installs activate the pin snapshot explicitly.
            activatePinFallback({
              installDir,
              state,
              warnings,
              reason:
                marker.reason === "forward_recovery"
                  ? "forward recovery target unavailable — using pin"
                  : "rolled back to the built-in pin",
            });
            rollbackTargetVersion = state.pinVersion;
            state = channelStore.updateState((s) => {
              s.applied = null;
              return s;
            });
          }
          channelStore.clearMarker();
          const pinRollbackLandedOnBlockedPin =
            marker.source === "pin" &&
            rollbackTargetVersion === state.pinVersion;
          if (pinRollbackLandedOnBlockedPin) {
            // The previous pin's overlay failed to activate and the only
            // local fallback is the blocklisted pin itself: say so as the
            // refusal it is, never as a successful rollback.
            action = "rollback_refused";
            const newestBackup = newestArchiveName();
            queueNotify(
              `🔴 Rollback from the pinned ${marker.blockedId || state.pinVersion} could not activate ${chosen.version}; the blocklisted pin is still running under the watchdog latch.` +
                (newestBackup
                  ? ` Manual recovery path: restore ${newestBackup}.`
                  : " Manual recovery: restore the newest openclaw-backup archive."),
              {
                eventType: "upgrade_failed",
                id: `rollback-refused-${marker.blockedId || "unknown"}`,
              },
            );
            logEvent("channel_rollback", "refused", {
              blockedId: marker.blockedId || null,
              reason: "pin_rollback_activation_failed",
            });
          } else {
            queueNotify(
              marker.reason === "forward_recovery"
                ? `🟠 Moved forward to OpenClaw ${chosen.version || state.pinVersion} — the built-in pin could not read the migrated state. Its blocklist entry was cleared for this one-shot attempt.`
                : `🟡 OpenClaw rolled back after ${marker.reason || "a failure"} on ${marker.blockedId || "the previous build"}. Now running ${
                    rollbackTargetVersion === state.pinVersion
                      ? `the built-in ${state.pinVersion}`
                      : rollbackTargetVersion
                  }. The broken build was blocklisted — see the Upgrade page.`,
            );
            logEvent("channel_rollback_boot", "completed", marker);
          }
        }
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
                // A real self-repair (interrupted activation re-copied from
                // the overlay). BOTH records: the warning feeds the returned
                // boot status/diagnostics, the notification reaches chat
                // (day-bucketed id: boot loops dedupe).
                warnings.push(
                  "re-activated the pin from its overlay (sentinel was missing)",
                );
                queueNotify(
                  `🩹 OpenClaw ${state.pinVersion} was re-activated from its overlay after an interrupted activation.`,
                  {
                    eventType: "recovery",
                    id: `pin-reactivated-${state.pinVersion}-${notifyDayBucket()}`,
                  },
                );
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
          // Legibility (incident 2026-09-01): running an applied channel
          // build over the declared pin makes `npm ls` report the openclaw
          // dep "invalid" — EXPECTED while an apply is active, but during
          // that incident it was diagnosed as version drift. Name it once
          // per boot so the next responder greps this instead of guessing.
          {
            const runningNow = channelStore.readInstalledVersion({ installDir });
            if (
              runningNow &&
              state.pinVersion &&
              state.applied &&
              runningNow !== state.pinVersion
            ) {
              log(
                `running ${runningNow} (${state.applied.channel} channel) over declared pin ${state.pinVersion} — expected while a channel apply is active; npm ls will report the openclaw dep as "invalid"`,
              );
            }
          }
          channelStore.removeBinShim();
        }
      }

      // Config/DB migration for the just-activated version runs in the
      // SERVER boot sequence (reconcileBootConfig — sized, doctor-guarded,
      // fail-closed, still strictly before the gateway starts), where the
      // #21 migration hard gate can revert-before-first-launch on its
      // failure path. This bin phase only persists the boot context the
      // reconciler needs: the rollback target (crash-rollback restore, #21
      // bug 4) and the pre-activation version (pre-fix .bak naming).

      // Resolve a run that intentionally spanned this restart: activation is
      // the run's real outcome, not "interrupted". Fail-open — a ledger issue
      // must never block the boot sync.
      //
      // Issue #20 ordering fix: a SUCCESSFUL activation is NOT resolved here.
      // The old code stamped the run activated/ok before the config migration
      // ran — #20's ledger showed a clean activation while the box crash-
      // looped. reconcileBootConfig (server boot sequence, before the gateway
      // starts) appends the boot steps and resolves the run after migration.
      try {
        const bootActivated =
          action === "activated" || action === "already_active";
        const bootFellBack =
          action === "activation_failed" ||
          action === "overlay_missing" ||
          action === "dev_unavailable";
        if (bootActivated) {
          ledger.appendStep?.(
            ledger.listRuns().find((run) => run.state === "restart_expected")
              ?.operationId,
            { name: "activate", status: "completed" },
          );
        } else if (bootFellBack) {
          ledger.resolveRestartExpected({
            activated: false,
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
      // Config/DB migration for the just-activated version happens in the
      // SERVER boot sequence (reconcileBootConfig, boot lock held) — still
      // strictly before the gateway can start on it, but async, sized to the
      // state DBs, doctor-guarded, and fail-CLOSED (issue #20). The #21
      // migration hard gate (revert-before-first-launch) runs THERE, on the
      // reconciler's failure path — not in this bin phase.


      reconcileOpenclawJsonMirror(channel, {
        devShimActive: action === "dev_shim",
      });
      // A pending pin window (bumped pin, install still catching up) arms on
      // the first boot whose activation settles on the pin — this one
      // included, e.g. a rollback-to-pin boot — never a boot late.
      const installedAfterActivation = channelStore.readInstalledVersion({
        installDir,
      });
      channelStore.updateState((s) => {
        if (
          s.pinWindow &&
          !s.pinWindow.openedAt &&
          s.pinWindow.version === s.pinVersion &&
          !s.applied &&
          installedAfterActivation === s.pinVersion
        ) {
          s.pinWindow.openedAt = nowFn();
        }
        return s;
      });
      channelStore.updateState((s) => {
        // Notifications queued in the pre-server (bin) instance die with it;
        // persisting them lets the server instance deliver the full wording.
        s.lastBoot = {
          at: nowFn(),
          action,
          warnings,
          notifications: pendingNotifications.slice(),
          // Boot context for the server-phase reconciler: the crash-rollback
          // restore (#21 bug 4) fires only on a boot whose action was
          // "rollback" onto this target; the pre-activation version keeps
          // pre-fix .bak names off the version being migrated TO.
          rollbackTargetVersion: rollbackTargetVersion || null,
          previousInstalledVersion: previousInstalledVersion || null,
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

  // Pin last-known-good promotion (issue #21 bug 5): a pin-only box never had
  // an `applied` build, so `markGoodNow` never ran and lastKnownGood.package
  // stayed null forever — every rollback degraded to the pin, which is itself
  // ineligible for further rollback. After the same health hold, record the
  // healthy pin as LKG and make sure its overlay exists so usableLkg() can
  // actually select it. Fire-and-forget with a .catch: ensurePinSnapshot
  // copies an install tree and an ENOSPC must never become an unhandled
  // rejection (the once-per-boot arm stays disarmed — no retry loop).
  const promotePinToLkg = async () => {
    const installDir = safeInstallDir();
    if (!installDir) return;
    const state = channelStore.readState();
    if (!state.pinVersion) return;
    if (!channelStore.hasOverlay(state.pinVersion)) {
      const space = checkDiskSpace(kOpenclawPackageMinDiskBytes, rootDir);
      if (!space.ok) {
        log(
          `pin LKG snapshot skipped: low disk (${space.free ?? "?"} bytes free)`,
        );
        return;
      }
      await ensurePinSnapshot(installDir);
    }
    if (!channelStore.hasOverlay(state.pinVersion)) return;
    channelStore.updateState((s) => {
      if (!s.applied && s.pinVersion) s.lastKnownGood.package = s.pinVersion;
      return s;
    });
    logEvent("channel_accepted", "completed", {
      id: state.pinVersion,
      source: "pin_health",
    });
    log(`pin ${state.pinVersion} promoted to last-known-good after health hold`);
  };

  const onGatewayHealthy = () => {
    try {
      const state = channelStore.readState();
      const applied = state.applied;
      if (!applied) {
        const now = nowFn();
        if (!firstHealthyAt) firstHealthyAt = now;
        // A freshly bumped pin auto-accepts after the same health hold as a
        // channel apply; its 24h window stays armed until mark-good/expiry.
        if (
          pinWindowOpen(state, now) &&
          !state.pinWindow.acceptedAt &&
          now - firstHealthyAt >= acceptanceHoldMs
        ) {
          markGoodNow({ source: "acceptance" });
        }
        // Minimal state change by design: `applied` stays null and nothing is
        // stamped acceptedAt — the pin only earns an LKG designation.
        if (!state.pinVersion || !pinLkgPromotionArmed) return;
        if (
          state.lastKnownGood?.package === state.pinVersion &&
          channelStore.hasOverlay(state.pinVersion)
        ) {
          pinLkgPromotionArmed = false;
          return;
        }
        if (now - firstHealthyAt >= acceptanceHoldMs) {
          pinLkgPromotionArmed = false;
          promotePinToLkg().catch((error) => {
            log(`pin LKG promotion failed: ${error.message}`);
            logEvent("channel_accepted", "failed", {
              source: "pin_health",
              error: error.message,
            });
          });
        }
        return;
      }
      if (applied.acceptedAt) return;
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
    let pinAccepted = false;
    const state = channelStore.updateState((s) => {
      if (!s.applied) {
        if (!pinWindowOpen(s)) return s;
        s.pinWindow.acceptedAt = s.pinWindow.acceptedAt || nowFn();
        if (source === "manual" || !s.pinWindow.acceptedSource) {
          s.pinWindow.acceptedSource = source;
        }
        s.rollbackRefused = null;
        s.forwardRecovery = null;
        s.noBootableVersion = null;
        pinAccepted = true;
        return s;
      }
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
      // A healthy accepted build resolves the #21 recovery latches.
      s.rollbackRefused = null;
      s.forwardRecovery = null;
      s.noBootableVersion = null;
      return s;
    });
    if (state.applied?.acceptedAt) {
      log(`accepted ${appliedId(state.applied)} (${source})`);
      logEvent("channel_accepted", "completed", {
        id: appliedId(state.applied),
        source,
      });
      if (source === "acceptance") {
        // The apply OUTCOME must always reach the operator (issue #54: quiet
        // mode swallowed every success while the failures never sent either).
        // Important class, keyed to the operation that produced this build so
        // a boot loop dedupes; older state files without operationId fall
        // back to the applied id + acceptance stamp.
        const { operationId: acceptedOperationId, acceptedAt } = state.applied;
        queueNotify(
          `🟢 OpenClaw ${appliedId(state.applied)} is healthy — activation verified.`,
          {
            eventType: "recovery",
            id: acceptedOperationId
              ? `apply-accepted-${acceptedOperationId}`
              : `apply-accepted-${appliedId(state.applied)}-${acceptedAt}`,
            ...(acceptedOperationId ? { operationId: acceptedOperationId } : {}),
          },
        );
      }
      return { ok: true, acceptedAt: state.applied.acceptedAt };
    }
    if (pinAccepted) {
      log(`accepted pin ${state.pinVersion} (${source})`);
      logEvent("channel_accepted", "completed", {
        id: state.pinVersion,
        source,
      });
      if (source === "acceptance") {
        // Same class as the channel acceptance above (issue #54 / WI-3.4): the
        // OUTCOME of a pin bump under watch is important, never verbose — quiet
        // mode must not swallow it. Keyed to the pin + acceptance stamp so a
        // boot loop dedupes (a pin has no apply operation to key on).
        queueNotify(
          `🟢 OpenClaw ${state.pinVersion} (new pinned version) is healthy — activation verified.`,
          {
            eventType: "recovery",
            id: `pin-accepted-${state.pinVersion}-${state.pinWindow.acceptedAt}`,
          },
        );
      }
      return { ok: true, acceptedAt: state.pinWindow.acceptedAt };
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
      if (!pinWindowOpen(state)) {
        return channelError(
          "nothing_to_roll_back",
          "Already running the built-in stable version.",
        );
      }
      return requestPinRollback({ state, reason, exitCode });
    }
    const blockedId = appliedId(applied);
    // A refusal already established that no target can read this build's
    // migrated state — re-requesting would churn markers/restarts forever.
    // Returning unhandled lets the watchdog fall through to its legacy latch.
    if (state.rollbackRefused && state.rollbackRefused.blockedId === blockedId) {
      return channelError(
        "rollback_refused_previously",
        `A rollback from ${blockedId} was already refused: no compatible version can read the migrated state.`,
        "Manual recovery: restore the newest openclaw-backup archive, or apply a newer version from the Upgrade page (Clear the blocklist entry to retry).",
      );
    }
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
    if (target.kind === "pin" && channelStore.isBlocklisted(state.pinVersion)) {
      // The pin itself was blocklisted by an earlier pin-window rollback:
      // landing on it would re-run the build that failed. The previous pin's
      // overlay (or a usable last-known-good) is the only honest floor.
      const floor = pinRollbackTargetVersion(state);
      if (floor && floor !== blockedId) {
        target = { kind: "package", channel: "stable", version: floor };
      } else {
        channelStore.updateState((s) => {
          s.rollbackRefused = {
            at: nowFn(),
            blockedId,
            reason: "pin_floor_blocklisted",
          };
          return s;
        });
        queueNotify(
          `🔴 OpenClaw ${blockedId} is failing (${reason}) and the built-in ${state.pinVersion} is blocklisted from an earlier failure — no version is available locally to roll back to. Automatic restart is paused; restore the newest openclaw-backup archive or apply another version from the Upgrade page.`,
          { eventType: "upgrade_failed", id: `rollback-floor-blocklisted-${blockedId}` },
        );
        logEvent("channel_rollback", "refused", {
          blockedId,
          reason,
          exitCode,
          floor: state.pinVersion,
        });
        return channelError(
          "rollback_floor_blocklisted",
          `Cannot roll back from ${blockedId}: the built-in ${state.pinVersion} is blocklisted and no other version is available locally.`,
          "Restore the newest openclaw-backup archive, or apply another version from the Upgrade page.",
        );
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

    return dispatchRollbackMarker({
      marker: { target, blockedId, reason, exitCode, at: nowFn() },
      notice:
        `🔴 OpenClaw ${blockedId} (${applied.channel} channel) ${
          reason === "crash_loop" ? "crash-looped" : `failed (${reason})`
        }${exitCode != null ? ` · exit code ${exitCode}` : ""} — rolling back to ${
          target.kind === "pin" ? `the built-in ${state.pinVersion}` : target.version
        }. The broken build was blocklisted. AlphaClaw is restarting.`,
    });
  };

  // A freshly bumped pin inside its own watch: the only way back is the
  // PREVIOUS pin's overlay (or a usable last-known-good) — never `kind: "pin"`,
  // which would re-activate the very build being blocklisted. With no such
  // target the request refuses (latch + notification) rather than looping.
  const requestPinRollback = ({ state, reason, exitCode }) => {
    const blockedId = state.pinVersion;
    if (state.rollbackRefused && state.rollbackRefused.blockedId === blockedId) {
      return channelError(
        "rollback_refused_previously",
        `A rollback from the pinned ${blockedId} was already refused: no earlier version is available locally.`,
        "Manual recovery: restore the newest openclaw-backup archive (see the Upgrade page).",
      );
    }
    const targetVersion = pinRollbackTargetVersion(state);
    if (!targetVersion) {
      // Refusing must leave the box no worse off: the pin stays runnable (no
      // blocklist entry it could never leave), and the watchdog's own latch
      // fires on the unhandled result — exactly the rollback_refused_previously
      // contract.
      if (reason === "manual") {
        return channelError(
          "pin_rollback_unavailable",
          `No earlier OpenClaw version is available locally to roll back from the pinned ${blockedId}.`,
          "Restore the newest openclaw-backup archive, or apply another version from the Upgrade page.",
        );
      }
      channelStore.updateState((s) => {
        s.rollbackRefused = {
          at: nowFn(),
          blockedId,
          reason: "no_pin_rollback_target",
        };
        return s;
      });
      const message =
        `🔴 The new pinned OpenClaw ${blockedId} is failing (${reason})` +
        `${exitCode != null ? ` · exit code ${exitCode}` : ""} and no earlier version is available locally to roll back to.` +
        " Automatic restart is paused — restore the newest openclaw-backup archive or apply another version from the Upgrade page.";
      queueNotify(message, {
        eventType: "upgrade_failed",
        id: `pin-rollback-unavailable-${blockedId}`,
      });
      logEvent("channel_rollback", "refused", {
        blockedId,
        reason,
        exitCode,
        source: "pin",
      });
      return channelError(
        "pin_rollback_unavailable",
        `No earlier OpenClaw version is available locally to roll back from the pinned ${blockedId}.`,
        "Restore the newest openclaw-backup archive, or apply another version from the Upgrade page.",
      );
    }
    channelStore.addBlocklist({ id: blockedId, reason, exitCode });
    // The landing build is written with acceptedAt pre-stamped (it already
    // earned acceptance once), so onGatewayHealthy never re-points LKG for
    // it — do it here, or a poisoned LKG keeps naming the blocklisted pin.
    channelStore.updateState((s) => {
      if (s.lastKnownGood.package === blockedId) {
        s.lastKnownGood.package = targetVersion;
      }
      return s;
    });
    const target = { kind: "package", channel: "stable", version: targetVersion };
    return dispatchRollbackMarker({
      marker: { target, blockedId, reason, exitCode, at: nowFn(), source: "pin" },
      notice:
        `🔴 The new pinned OpenClaw ${blockedId} ${
          reason === "crash_loop" ? "crash-looped" : `failed (${reason})`
        }${exitCode != null ? ` · exit code ${exitCode}` : ""} — rolling back to the previous version ${targetVersion}. The new pin was blocklisted. AlphaClaw is restarting.`,
    });
  };

  const dispatchRollbackMarker = ({ marker, notice }) => {
    const { blockedId, reason, target } = marker;
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
    queueNotify(notice);
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

  // Forward recovery (issue #21 bug 10): the pin itself cannot boot — usually
  // because a one-way migration already moved openclaw.json/state past it —
  // and a NEWER blocklisted build with a local overlay exists whose blocklist
  // reason implies it owns that migrated state. Rolling further back is
  // impossible; moving forward to the build that wrote the state is the only
  // viable direction. Strictly one-shot per build (persisted attemptedId), so
  // it can never ping-pong: a second pin failure after the attempt latches
  // with an unmissable "no bootable version".
  const requestForwardRecovery = ({ exitCode = null } = {}) => {
    try {
      if (
        String(process.env.OPENCLAW_FORWARD_RECOVERY || "").toLowerCase() ===
        "off"
      ) {
        return channelError(
          "disabled",
          "Forward recovery is disabled (OPENCLAW_FORWARD_RECOVERY=off).",
        );
      }
      const state = channelStore.readState();
      if (state.applied) {
        return channelError(
          "not_pin",
          "Forward recovery only applies when the built-in pin is running.",
        );
      }
      if (!state.pinVersion) {
        return channelError("no_pin", "No pin version recorded.");
      }
      const candidates = (state.blocklist || [])
        .filter(
          (entry) =>
            entry &&
            typeof entry.id === "string" &&
            ["config_error", "config_migration_failed"].includes(entry.reason) &&
            channelStore.hasOverlay(entry.id) &&
            compareVersionParts(entry.id, state.pinVersion) > 0,
        )
        .sort((a, b) => compareVersionParts(b.id, a.id));
      const entry = candidates[0] || null;
      if (!entry) {
        return channelError(
          "no_forward_candidate",
          "No blocklisted newer build with a local overlay to move forward to.",
        );
      }
      if (state.forwardRecovery?.attemptedId === entry.id) {
        // Second cycle: the pin failed again after the forward attempt —
        // nothing on this box can boot. Persist the flag so the UI can show
        // an unmissable banner even if every notification channel is down.
        channelStore.updateState((s) => {
          s.noBootableVersion = { at: nowFn(), attemptedId: entry.id };
          return s;
        });
        logEvent("forward_recovery", "exhausted", {
          attemptedId: entry.id,
          exitCode,
        });
        const exhaustedMessage =
          `🔴 No bootable OpenClaw version: the built-in ${state.pinVersion} cannot read the migrated state, ` +
          `and the forward build ${entry.id} already failed once. Manual recovery needed — see the Upgrade page ` +
          `(restore the newest openclaw-backup archive, or Clear ${entry.id}'s blocklist entry to retry it).`;
        queueNotify(exhaustedMessage, {
          eventType: "upgrade_failed",
          id: `no-bootable-version-${entry.id}`,
        });
        postBootWebhook(exhaustedMessage);
        return channelError(
          "forward_already_attempted",
          "Forward recovery was already attempted for this build.",
        );
      }
      channelStore.updateState((s) => {
        s.forwardRecovery = {
          attemptedId: entry.id,
          at: nowFn(),
          clearedEntry: entry,
        };
        return s;
      });
      channelStore.clearBlocklist(entry.id);
      const marker = {
        target: {
          kind: "package",
          channel: isPrereleaseVersion(entry.id) ? "beta" : "stable",
          version: entry.id,
        },
        blockedId: null,
        reason: "forward_recovery",
        exitCode,
        at: nowFn(),
      };
      const written = channelStore.writeMarker(marker);
      if (!written.ok) {
        log(`forward recovery marker write FAILED: ${written.error} — latching`);
        if (typeof watchdogLatch === "function") {
          try {
            watchdogLatch({ reason: "rollback_marker_write_failed" });
          } catch {}
        }
        queueNotify(
          `🔴 The built-in OpenClaw cannot boot and the forward-recovery marker could not be written (${written.error}). Automatic restart is paused — manual action required on the Upgrade page.`,
        );
        logEvent("forward_recovery", "failed", {
          ...marker,
          error: written.error,
        });
        return channelError(
          "rollback_marker_write_failed",
          `Could not write the forward-recovery marker: ${written.error}`,
          "Free disk space on the data volume, then restart AlphaClaw.",
        );
      }
      logEvent("forward_recovery", "requested", marker);
      const message =
        `🟠 The built-in OpenClaw ${state.pinVersion} cannot boot${exitCode != null ? ` (exit ${exitCode})` : ""} ` +
        `and the state was already migrated forward — moving forward to ${entry.id}, which can read it. ` +
        `Its blocklist entry was cleared; this is attempted once. AlphaClaw is restarting.`;
      queueNotify(message, {
        eventType: "health",
        id: `forward-recovery-${entry.id}`,
      });
      postBootWebhook(message);
      if (typeof restartProcess === "function") {
        setTimeout(() => {
          try {
            restartProcess();
          } catch {}
        }, 1000).unref?.();
      }
      return { ok: true, target: marker.target };
    } catch (error) {
      return channelError("forward_recovery_failed", error.message);
    }
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
  // CLI contract (verified against the pinned 2026.7.1-2 package source):
  //   openclaw backup create --output <dir>/openclaw-backup-<ts>-<opId8>.tar.gz --verify
  //   exact path → archive written THERE, refused if it exists; --verify runs
  //   AFTER the atomic publish. The full quiesce-first / live-ladder flow is
  //   diagrammed on runBackup below; a workspace-discovery failure (broken
  //   config blocks enumeration, #21 bug 6) earns ONE retry with
  //   --no-include-workspace against a FRESH filename, recorded and announced
  //   as {partial: true} — config and state databases are still included.
  //
  // The exact per-run path (uuid suffix — nowFn is frozen in tests) makes
  // artifact identity, failure cleanup, and quarantine deterministic; the
  // pre-fix code passed the fixed directory path itself, which the CLI wrote
  // AS the archive file — first run false-failed the artifact check (#9),
  // every later run hit refuse-to-overwrite (#7). Retries reuse
  // buildBackupOutputFile so every attempt's name stays inside
  // kBackupArchiveNamePattern (isBackupArchiveName) — a bespoke suffix would escape keep-N retention
  // and refill the disk (issue #9's failure class).

  // Best-effort line into the current run's durable log + console.
  const backupLog = (line) => {
    try {
      activeSink?.writeLine(line);
    } catch {}
    log(line.replace(/^\[openclaw-update\] /, ""));
  };

  // Both producers share the prefix and the <ts>-<opId8> identity; only the
  // suffix says who wrote it (isBackupArchiveName accepts both).
  const buildBackupOutputFile = (operationId, { producer = kUpstreamProducer } = {}) => {
    const runSuffix =
      String(operationId || "")
        .replace(/[^0-9A-Za-z-]/g, "")
        .slice(0, 8) || crypto.randomUUID().slice(0, 8);
    const suffix = producer === kOfflineCopyProducer ? kOfflineCopyArchiveSuffix : ".tar.gz";
    return path.join(backupsDir, `openclaw-backup-${nowFn()}-${runSuffix}${suffix}`);
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

  // Archives carry credentials: the directory is 0700 whether this code
  // created it or an operator/older release (mkdir under umask 022 → 0755)
  // did. Best-effort — a filesystem that refuses chmod still gets its backup —
  // but never silent: the refusal is kept so the archive record and the
  // completion warning can say the directory stayed at its default mode.
  let backupsDirModeError = null;
  const repairBackupsDirMode = (st) => {
    if ((st.mode & 0o777) === 0o700) {
      backupsDirModeError = null;
      return;
    }
    try {
      fsModule.chmodSync(backupsDir, 0o700);
      backupsDirModeError = null;
    } catch (error) {
      backupsDirModeError = String(error?.message || error).slice(0, 200);
      log(`could not chmod ${backupsDir} to 0700: ${error.message}`);
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
      repairBackupsDirMode(st);
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
    String(value).replace(/\[[0-9;]*[A-Za-z]/g, "");

  // Render-safe text for notifications, step errors, and the run ledger:
  // ANSI/control chars stripped, markdown backticks neutralized, and a
  // generous middle-ellipsis cap — long enough that a path is never cut
  // mid-name (issue #18's "/data/.opencla…" notification), bounded so a
  // pathological string can't bloat ledger or notification payloads.
  const kSanitizedTextMaxChars = 512;
  const sanitizeForDisplay = (value, max = kSanitizedTextMaxChars) => {
    const text = stripAnsi(String(value ?? ""))
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/`/g, "'");
    if (text.length <= max) return text;
    const half = Math.floor((max - 1) / 2);
    return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
  };

  const producerLabel = (producer) =>
    producer === kOfflineCopyProducer ? "AlphaClaw offline copy" : "OpenClaw backup";

  // A vanished-file failure is a live-mutation race: the CLI's tar walk
  // enumerated a volatile file (session .jsonl.lock, plugin catalog.json, …)
  // that the running gateway deleted before lstat. Never re-check existence —
  // churned files are recreated within milliseconds, so absence-now proves
  // nothing (issues #11 and #18 are the same bug class two files apart).
  const extractVanishedPath = (tail) => {
    const text = String(tail || "");
    const primary = text.match(/ENOENT[^'"]*['"]([^'"]+)['"]/);
    if (primary?.[1]) return primary[1];
    const fallback = text.match(
      /,\s*(?:lstat|open|stat|scandir|readlink)\s+'([^']+)'/,
    );
    return fallback?.[1] || null;
  };

  // One honest message per failure cause, each carrying a machine-readable
  // `kind` so runBackup branches on classification instead of re-grepping the
  // tail at call sites. Order (plan §6): no_command → timedOut → spawn_error
  // (flag, terminal) → killed (flag) → refuse_overwrite → enospc →
  // workspace_discovery → lock_contention → vanished_file → verify → generic;
  // every regex branch reads the last kBackupTailClassifyLines non-empty lines.
  // The pre-fix catch-all claimed every CLI failure "failed to verify" (#7/#9);
  // issue #54's lease loss fell into `generic` and was never retried.
  const classifyBackupFailure = (result, { outputFile, gateNoun }) => {
    const tailLines = selectClassifierTail(result?.tail);
    const tail = tailLines.join("\n");
    const lastLine = sanitizeForDisplay(tailLines[tailLines.length - 1] || "", 400);
    const gateHint = `${gateNoun} are blocked without a backup because the rollback target may not read migrated state. Fix the backup or choose a same-channel version.`;
    if (/unknown command|unrecognized|unexpected argument/i.test(tail)) {
      return {
        kind: "no_command",
        message: `This OpenClaw version has no backup command, and ${gateNoun.toLowerCase()} require a verified backup.`,
        hint: gateHint,
        stepError: "backup command unavailable",
      };
    }
    if (result?.timedOut) {
      return {
        kind: "timeout",
        message: `The pre-update backup timed out after ${Math.round((result.timeoutMs || backupBudget.cliTimeoutMs) / 60000)} minutes.`,
        hint: gateHint,
        stepError: "timed out",
      };
    }
    if (result?.error) {
      const error = sanitizeForDisplay(result.error, 300);
      return {
        kind: "spawn_error",
        message: `The pre-update backup could not start: ${error}.`,
        hint: `The backup CLI never ran (a missing binary, permissions, or a bad working directory) — check the install and PATH, then retry. ${gateHint}`,
        stepError: `spawn failed: ${error}`,
      };
    }
    if (result?.signal || result?.killed) {
      const signal = sanitizeForDisplay(result.signal || "signal", 32);
      return {
        kind: "killed",
        signal,
        message: `The pre-update backup was killed (${signal}) before it finished.`,
        hint: `Something outside the update killed the backup process — an OOM kill or a platform restart, not a data problem. ${gateHint}`,
        stepError: `killed by ${signal}`,
      };
    }
    // Only the CLI's own refusal message routes here — a raw EEXIST/ENOTDIR
    // from mkdir names a different path and reads honestly via the generic
    // branch's verbatim last line.
    if (/refus\w*\s+to\s+overwrite/i.test(tail)) {
      return {
        kind: "refuse_overwrite",
        message: `The pre-update backup was refused: a file already exists at ${outputFile}.`,
        hint: `Remove or relocate that file, then retry. ${gateHint}`,
        stepError: lastLine || "refused to overwrite existing archive",
      };
    }
    if (/ENOSPC|no space left/i.test(tail)) {
      return {
        kind: "enospc",
        message: "The pre-update backup failed: not enough disk space.",
        hint: `Free up space or delete old backups in ${backupsDir}, then retry. ${gateHint}`,
        stepError: lastLine || "no space left on device",
      };
    }
    // Workspace-discovery failure (#21 bug 6): a config-broken box cannot
    // enumerate custom workspaces, and the CLI itself names the escape
    // hatch. The ladder retries ONCE with --no-include-workspace.
    if (
      /--no-include-workspace|cannot reliably discover .*workspaces/i.test(
        tail,
      )
    ) {
      return {
        kind: "workspace_discovery",
        message:
          "The pre-update backup failed: the OpenClaw settings file is too broken to discover workspace folders.",
        hint: `Fix openclaw.json or retry — AlphaClaw retries once without workspace files (config and state databases are still included). ${gateHint}`,
        stepError: lastLine || "workspace discovery failed",
      };
    }
    // Issue #54: the upstream backup holds a state lease across its SQLite
    // snapshot; a concurrent writer (our own status readers, cron store,
    // notifier) makes the lease renewal hit busy_timeout 0 and the CLI
    // aborts. Before the vanished_file branch: the tail also carries an
    // ENOENT from the lease's cleanup, which is not the cause.
    if (kStateContentionPattern.test(tail)) {
      return {
        kind: "lock_contention",
        message: `The pre-update backup lost its state-database lease to a concurrent writer (SQLite lock contention)${lastLine ? ` — ${lastLine}` : "."}`,
        hint: `AlphaClaw retries with the gateway paused and falls back to its own offline copy; if this repeats, something else is writing the state databases during the backup. ${gateHint}`,
        stepError: "state-database lock contention",
      };
    }
    if (/ENOENT|no such file or directory/i.test(tail)) {
      const offendingPath = sanitizeForDisplay(
        extractVanishedPath(tail) || "unknown file",
      );
      return {
        kind: "vanished_file",
        offendingPath,
        message: `The pre-update backup hit a live-file race — a file vanished while the archive was being written (${offendingPath}).`,
        hint: `This is a live-state race (lock files, plugin catalogs), not a disk or data problem. ${gateHint}`,
        stepError: `live-file race: ${offendingPath}`,
      };
    }
    if (/verif/i.test(tail)) {
      return {
        kind: "verify",
        message: `The pre-update backup failed to verify${lastLine ? ` — ${lastLine}` : "."}`,
        hint: gateHint,
        stepError: lastLine || "verification failed",
      };
    }
    return {
      kind: "generic",
      message: `The pre-update backup failed${lastLine ? ` — ${lastLine}` : "."}`,
      hint: gateHint,
      stepError: lastLine || "backup command failed",
    };
  };

  // ONE directory scan (lstat — a symlinked archive is never a candidate)
  // behind the size estimate, the newest-archive hints, and the inventory.
  const scanBackupArchives = () => {
    let names;
    try {
      names = fsModule.readdirSync(backupsDir);
    } catch (error) {
      // A backups directory that does not exist yet is the normal fresh-box
      // state (the first update creates it) — an EMPTY inventory, never an
      // unreadable one; EACCES/ENOTDIR and friends are genuinely unreadable.
      if (error?.code === "ENOENT") return [];
      return null;
    }
    const entries = [];
    for (const name of names) {
      if (!isBackupArchiveName(name)) continue;
      const full = path.join(backupsDir, name);
      let st;
      try {
        st = fsModule.lstatSync(full);
      } catch {
        continue;
      }
      entries.push({
        name,
        full,
        size: st.size,
        mtimeMs: st.mtimeMs,
        isFile: st.isFile(),
        isSymlink: st.isSymbolicLink(),
        producer: producerOfArchiveName(name),
      });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
  };

  const newestArchive = () => (scanBackupArchives() || []).find((entry) => entry.isFile) || null;
  const newestArchiveSize = () => newestArchive()?.size ?? null;

  // Full path of the newest backup archive — named in refusal notifications
  // as the manual recovery artifact (issue #21 bug 3).
  const newestArchiveName = () => newestArchive()?.full ?? null;

  // WI-1.10: every hard-gate refusal says what the operator DOES have.
  const describeNewestArchive = () => {
    const newest = newestArchive();
    if (!newest) return `No earlier backup archive exists in ${backupsDir}.`;
    return `The newest surviving backup is ${newest.full} (${formatAge(nowFn() - newest.mtimeMs)} old, ${producerLabel(newest.producer)}).`;
  };

  // WI-1.7: the hard gate is waived ONLY for a literally empty state tree.
  // "Empty" is an ALLOWLIST, not a checklist of known state kinds: the tree
  // may hold nothing but AlphaClaw's own bookkeeping (.alphaclaw, logs,
  // backups, tmp, the .env link onboarding plants), an absent/empty/`{}`
  // openclaw.json, and empty directories — and the channel state may carry
  // no applied/last-known-good history (the pin's own self-promotion to LKG
  // is not history). Anything else — a credentials or identity store,
  // auth-profiles.json, cron state, pairing files, a session transcript, a
  // database — is state a migration could lose whether or not this code
  // knows its name, so a CLI that exits 0 without an archive over it is a
  // phantom backup, not a fresh install. Symlinks and special files are
  // never "empty". Any fs error → not fresh (fail closed).
  // The allowlisted names are accepted only in their expected SHAPE — the
  // name alone proved nothing (a symlink named `logs`, a special file named
  // `tmp` or a credentials dump renamed `.env` all matched the name):
  // `.alphaclaw`/`logs`/`backups`/`tmp` must be real directories (Dirent
  // types never follow symlinks; their contents are AlphaClaw bookkeeping and
  // are not inspected), and `.env` must be either the onboarding symlink —
  // its literal target is `<rootDir>/.env` (ensureOpenclawRuntimeArtifacts),
  // which if present must itself be a regular file — or a small regular file
  // that carries no OpenClaw/credential-shaped keys.
  const kFreshTreeBookkeepingDirs = new Set([".alphaclaw", "logs", "backups", "tmp"]);
  const kFreshTreeEnvFileMaxBytes = 4 * 1024;
  const kFreshTreeEnvSecretKeyPattern = /^OPENCLAW_|TOKEN|SECRET|API_KEY|CREDENTIAL|PRIVATE/i;
  const kFreshTreeMaxDepth = 8;
  const isEmptyDirTree = (dir, depth) => {
    if (depth > kFreshTreeMaxDepth) return false;
    for (const entry of fsModule.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) return false;
      if (!isEmptyDirTree(path.join(dir, entry.name), depth + 1)) return false;
    }
    return true;
  };
  const isFreshTreeEnvEntry = (root, entry) => {
    const envPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = path.resolve(root, fsModule.readlinkSync(envPath));
      if (target !== path.resolve(rootDir, ".env")) return false;
      let targetStat = null;
      try {
        targetStat = fsModule.lstatSync(target);
      } catch (error) {
        // A dangling onboarding link (root .env not written yet) holds nothing.
        return error?.code === "ENOENT";
      }
      return targetStat.isFile();
    }
    if (!entry.isFile()) return false;
    if (fsModule.lstatSync(envPath).size > kFreshTreeEnvFileMaxBytes) return false;
    const lines = fsModule.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const key = trimmed.replace(/^export\s+/, "").split("=")[0].trim();
      if (kFreshTreeEnvSecretKeyPattern.test(key)) return false;
    }
    return true;
  };
  const isFreshStateTree = () => {
    try {
      if (enumerateStateDbs().length > 0) return false;
      const root = stateDir();
      let entries = [];
      try {
        entries = fsModule.readdirSync(root, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
      }
      for (const entry of entries) {
        if (kFreshTreeBookkeepingDirs.has(entry.name)) {
          if (!entry.isDirectory()) return false;
          continue;
        }
        if (entry.name === ".env") {
          if (!isFreshTreeEnvEntry(root, entry)) return false;
          continue;
        }
        if (entry.name === "openclaw.json") {
          if (!entry.isFile()) return false;
          const raw = fsModule.readFileSync(path.join(root, entry.name), "utf8").trim();
          if (raw !== "") {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
            if (Object.keys(parsed).length > 0) return false;
          }
          continue;
        }
        if (!entry.isDirectory()) return false;
        if (!isEmptyDirTree(path.join(root, entry.name), 1)) return false;
      }
      const state = channelStore.readState();
      if (state.applied) return false;
      if (state.lastKnownGood?.dev) return false;
      if (state.lastKnownGood?.package && state.lastKnownGood.package !== state.pinVersion) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const readJournalMode = (dbPath) => {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db.prepare("PRAGMA journal_mode").get();
      const mode = String(row?.journal_mode ?? "").toLowerCase();
      return mode || "unknown";
    } catch {
      return "unknown";
    } finally {
      try {
        db?.close();
      } catch {}
    }
  };

  // Prior-run calibration: the newest run whose UPSTREAM `backup create`
  // succeeded, and how long that one CLI attempt took (attemptMs — the wall
  // time around the CLI alone) against how many state bytes. Never the whole
  // step's durationMs (lock wait, stop, barrier, backoffs, prune, relaunch)
  // and never an offline-copy run: predicting the upstream speed from either
  // made the predicted_too_slow short-circuit self-reinforcing — one slow
  // step pushed every later run straight to the offline copy.
  const priorBackupThroughput = () => {
    try {
      for (const run of ledger.listRuns()) {
        const backup = run?.backup;
        if (
          backup &&
          backup.noBackup === false &&
          !backup.reused &&
          (backup.producer == null || backup.producer === kUpstreamProducer) &&
          Number.isFinite(backup.attemptMs) &&
          backup.attemptMs > 0 &&
          Number.isFinite(backup.stateBytes) &&
          backup.stateBytes > 0
        ) {
          return {
            operationId: run.operationId,
            attemptMs: backup.attemptMs,
            stateBytes: backup.stateBytes,
          };
        }
      }
    } catch {}
    return null;
  };

  // WI-1.0: read-only look at what the backup is about to walk into — journal
  // mode (rollback-journal DBs self-block the upstream snapshot), the state
  // dir's filesystem, sizes, live openclaw processes, and a prediction from
  // the prior run. Unreadable → "unknown"; never blocks, never throws.
  const kRollbackJournalModes = new Set(["delete", "truncate", "persist"]);
  const runBackupDiagnosis = ({ operationId }) => {
    const diagnosis = {
      journalMode: "unknown",
      journalModes: {},
      fsType: "unknown",
      stateBytes: null,
      dbCount: 0,
      otherProcesses: [],
      predictedUpstreamMs: null,
      priorRun: null,
    };
    try {
      const root = stateDir();
      const dbs = enumerateStateDbs();
      let stateBytes = 0;
      const modes = new Set();
      for (const dbPath of dbs) {
        for (const suffix of ["", "-wal"]) {
          try {
            stateBytes += fsModule.statSync(`${dbPath}${suffix}`).size;
          } catch {}
        }
        const mode = readJournalMode(dbPath);
        diagnosis.journalModes[path.relative(root, dbPath)] = mode;
        if (mode !== "unknown") modes.add(mode);
      }
      diagnosis.dbCount = dbs.length;
      diagnosis.stateBytes = stateBytes;
      diagnosis.journalMode =
        modes.size === 0
          ? "unknown"
          : [...modes].some((mode) => kRollbackJournalModes.has(mode))
            ? "delete"
            : modes.size === 1
              ? [...modes][0]
              : "mixed";
      try {
        let real = root;
        try {
          real = fsModule.realpathSync(root);
        } catch {}
        diagnosis.fsType = parseMountInfoFsType(probes.readMountInfo(), real);
      } catch {
        diagnosis.fsType = "unknown";
      }
      try {
        diagnosis.otherProcesses = (probes.listProcesses() || []).map((entry) => ({
          pid: entry.pid,
          cmdline: sanitizeForDisplay(entry.cmdline, 200),
        }));
      } catch {
        diagnosis.otherProcesses = [];
      }
      const prior = priorBackupThroughput();
      if (prior && stateBytes > 0) {
        diagnosis.priorRun = prior;
        diagnosis.predictedUpstreamMs = Math.round(
          prior.attemptMs * (stateBytes / prior.stateBytes),
        );
      }
    } catch (error) {
      diagnosis.error = sanitizeForDisplay(error.message, 200);
    }
    backupLog(
      `[openclaw-update] backup: diagnosis journal=${diagnosis.journalMode} fs=${diagnosis.fsType} state=${
        diagnosis.stateBytes == null ? "?" : `${Math.round(diagnosis.stateBytes / 1e6)}MB`
      } dbs=${diagnosis.dbCount} processes=${diagnosis.otherProcesses.length} predicted=${
        diagnosis.predictedUpstreamMs == null ? "n/a" : `${Math.round(diagnosis.predictedUpstreamMs / 1000)}s`
      }`,
    );
    logEvent("backup_diagnosis", "completed", {
      operationId,
      journalMode: diagnosis.journalMode,
      fsType: diagnosis.fsType,
      stateBytes: diagnosis.stateBytes,
      dbCount: diagnosis.dbCount,
      otherProcesses: diagnosis.otherProcesses.length,
      predictedUpstreamMs: diagnosis.predictedUpstreamMs,
    });
    return diagnosis;
  };

  // Rollback-journal + large DB = deterministic self-block (a reader's SHARED
  // lock blocks the writer's COMMIT with busy_timeout 0); a prior run slower
  // than what is left cannot fit either. Both skip straight to the offline copy.
  const describeShortCircuit = (diagnosis, quiesceRemainingMs) => {
    if (!diagnosis) return null;
    if (
      diagnosis.journalMode === "delete" &&
      Number.isFinite(diagnosis.stateBytes) &&
      diagnosis.stateBytes > backupBudget.rollbackJournalSelfDeadlockBytes
    ) {
      return "rollback_journal_self_deadlock";
    }
    if (
      Number.isFinite(diagnosis.predictedUpstreamMs) &&
      diagnosis.predictedUpstreamMs > quiesceRemainingMs
    ) {
      return "predicted_too_slow";
    }
    return null;
  };

  // tar/gzip get the bare probe env: they need PATH, not gateway secrets.
  const archiveCommandRunner = (spec) =>
    runner.runStreamed({ ...spec, env: probeEnv() });

  // Relative archive paths of this box's state databases — the manifest of a
  // usable archive must list them (WI-6.1).
  const requiredArchivePaths = () => {
    const root = stateDir();
    return enumerateStateDbs().map((dbPath) =>
      path.relative(root, dbPath).split(path.sep).join("/"),
    );
  };

  // The result carries `timedOut` when any stage's command hit OUR timeout:
  // a check that ran out of OUR clock says nothing about the archive, so the
  // caller must not treat it as a verify failure (no quarantine).
  const runUsableCheck = async (file, { timeoutMs }) => {
    let timedOut = false;
    const runCommand = async (spec) => {
      const result = await archiveCommandRunner(spec);
      if (result?.timedOut) timedOut = true;
      return result;
    };
    const verified = await verifyArchiveManifest({
      file,
      runCommand,
      requiredArchivePaths: requiredArchivePaths(),
      stateDir: stateDir(),
      timeoutMs,
      nowFn,
    });
    return { ...verified, timedOut };
  };

  // Verified provenance for an archive: the ledger run that produced it, else
  // the state.backups entry. null = nothing this code ever recorded.
  const findArchiveProvenance = (file, { runs, stateBackups }) => {
    for (const run of runs) {
      const backup = run?.backup;
      if (backup && backup.noBackup === false && backup.file === file) {
        return {
          operationId: run.operationId,
          at: backup.at ?? run.startedAt ?? null,
          verified: backup.verified === true,
          partial: backup.partial === true,
          partialReasons: partialReasonsOf(backup),
          reused: backup.reused === true,
          producer: backup.producer || producerOfArchiveName(path.basename(file)),
          sha256: backup.sha256 || null,
          usableCheck: backup.usableCheck || null,
          mode: backup.mode || null,
        };
      }
    }
    for (const entry of stateBackups) {
      if (entry && entry.file === file) {
        return {
          operationId: entry.operationId || null,
          at: entry.at ?? null,
          verified: entry.verified === true,
          partial: entry.partial === true,
          partialReasons: partialReasonsOf(entry),
          reused: entry.reused === true,
          producer: entry.producer || producerOfArchiveName(path.basename(file)),
          sha256: entry.sha256 || null,
          usableCheck: entry.usableCheck || null,
          mode: entry.mode || null,
        };
      }
    }
    return null;
  };

  // WI-4.5 reuse window lower bound — the ONE computation shared by the reuse
  // gate (`tryReuseRecentBackup`) and the inventory (`reuseWindowStartMs`):
  // an archive taken before the newest successful apply / activation /
  // settings migration predates state the current build has already
  // rewritten, so the gate refuses it. The UI mirrors the three channel-store
  // records from GET /api/openclaw/channel but cannot see the run ledger's
  // older activations, so the inventory publishes this value and the confirm
  // dialog prefers it — sharing the helper is what keeps the two from
  // drifting. `excludeOperationId` = the run currently backing up (its own
  // in-progress record must not fence out the archives it may reuse).
  // `runs`/`state` are optional pre-read copies so the inventory does not
  // read the ledger twice.
  const computeReuseWindowStartMs = ({
    excludeOperationId = null,
    runs = null,
    state = null,
  } = {}) => {
    let since = 0;
    try {
      const current = state || channelStore.readState();
      if (Number.isFinite(current.applied?.at)) since = Math.max(since, current.applied.at);
      const migration = current.configMigration?.lastAttempt;
      if (migration?.ok && Number.isFinite(migration.at)) since = Math.max(since, migration.at);
      const lastRun = current.lastUpdateRun;
      if (
        lastRun &&
        (excludeOperationId == null || lastRun.operationId !== excludeOperationId) &&
        lastRun.ok === true &&
        Number.isFinite(activationTimeOf(lastRun))
      ) {
        since = Math.max(since, activationTimeOf(lastRun));
      }
    } catch {}
    try {
      for (const run of runs || ledger.listRuns()) {
        if (excludeOperationId != null && run.operationId === excludeOperationId) continue;
        const activated =
          run.ok === true || run.state === "activated" || run.state === "restart_expected";
        if (activated && Number.isFinite(activationTimeOf(run))) {
          since = Math.max(since, activationTimeOf(run));
        }
      }
    } catch {}
    return since;
  };
  // A run fences archives taken before it ACTIVATED, not before it started: a
  // run's own pre-update backup is stamped after startedAt, so flooring on the
  // start would keep that archive reusable after the switch it preceded —
  // exactly the state the new build has since rewritten. Legacy records
  // without finishedAt fall back to startedAt (the old, looser floor).
  const activationTimeOf = (run) =>
    Number.isFinite(run?.finishedAt) ? run.finishedAt : run?.startedAt;

  // A record's partial reasons (offline copy: workspace exclusion and/or
  // skipped core symlinks such as credentials) — strings only, never
  // undefined, so the UI can key on `null` for "old record, reason unknown".
  const partialReasonsOf = (record) =>
    Array.isArray(record?.partialReasons)
      ? record.partialReasons.filter((reason) => typeof reason === "string" && reason.trim())
      : null;

  // WI-4.3: what is on disk, what AlphaClaw knows about each file, and whether
  // the reuse gate may consider it. One scan, capped, containment-checked.
  const listBackupInventory = () => {
    const scanned = scanBackupArchives();
    let runs = [];
    try {
      runs = ledger.listRuns();
    } catch {}
    let stateBackups = [];
    let state = null;
    try {
      state = channelStore.readState();
      stateBackups = Array.isArray(state.backups) ? state.backups : [];
    } catch {}
    const resolvedDir = path.resolve(backupsDir);
    const entries = [];
    const seen = new Set();
    for (const scan of scanned || []) {
      const resolved = path.resolve(scan.full);
      seen.add(scan.full);
      const contained = resolved.startsWith(`${resolvedDir}${path.sep}`);
      const provenance = contained
        ? findArchiveProvenance(scan.full, { runs, stateBackups })
        : null;
      let ineligibleReason = null;
      if (!contained) ineligibleReason = "outside_dir";
      else if (!scan.isFile) ineligibleReason = "symlink";
      else if (!provenance) ineligibleReason = "no_provenance";
      else if (!provenance.verified) ineligibleReason = "unverified";
      else if (provenance.partial) ineligibleReason = "partial";
      else if (
        Number.isFinite(provenance.at) &&
        provenance.at > nowFn() + kOpenclawBackupClockSkewToleranceMs
      ) {
        ineligibleReason = "future_dated";
      }
      entries.push({
        file: scan.full,
        name: scan.name,
        producer: provenance?.producer || scan.producer,
        sizeBytes: scan.size,
        mtimeMs: scan.mtimeMs,
        at: provenance?.at ?? scan.mtimeMs,
        verified: provenance?.verified === true,
        partial: provenance?.partial === true,
        partialReasons: provenance?.partialReasons ?? null,
        reused: provenance?.reused === true,
        sha256: provenance?.sha256 ?? null,
        mode: provenance?.mode ?? null,
        exists: true,
        operationId: provenance?.operationId ?? null,
        eligible: ineligibleReason === null,
        ineligibleReason,
      });
    }
    // Recorded-but-missing archives: the UI and the fence hint need to know a
    // run's backup is gone, and pruning/quarantine is the usual reason.
    const recorded = [
      ...runs
        .map((run) => run?.backup)
        .filter((backup) => backup && backup.noBackup === false && backup.file),
      ...stateBackups.filter((entry) => entry && entry.file),
    ];
    for (const record of recorded) {
      if (seen.has(record.file)) continue;
      seen.add(record.file);
      const provenance = findArchiveProvenance(record.file, { runs, stateBackups });
      entries.push({
        file: record.file,
        name: path.basename(record.file),
        producer: provenance?.producer || producerOfArchiveName(path.basename(record.file)),
        sizeBytes: null,
        mtimeMs: null,
        at: provenance?.at ?? null,
        verified: provenance?.verified === true,
        partial: provenance?.partial === true,
        partialReasons: provenance?.partialReasons ?? null,
        reused: provenance?.reused === true,
        sha256: provenance?.sha256 ?? null,
        mode: provenance?.mode ?? null,
        exists: false,
        operationId: provenance?.operationId ?? null,
        eligible: false,
        ineligibleReason: "missing",
      });
    }
    entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const capped = entries.slice(0, kOpenclawBackupInventoryMaxEntries);
    return {
      backupsDir,
      readable: scanned !== null,
      entries: capped,
      truncated: entries.length > capped.length,
      newestArchive: (scanned || []).find((entry) => entry.isFile)
        ? {
            file: newestArchiveName(),
            sizeBytes: newestArchiveSize(),
          }
        : null,
      // The reuse gate's window, published so the UI's consent model can bind
      // to the SAME bounds the server enforces (the ledger's older activations
      // are not in the channel payload): archives older than
      // `reuseWindowStartMs` or than `reuseMaxAgeMs` are never offered.
      reuseWindowStartMs: computeReuseWindowStartMs({ runs, state }),
      reuseMaxAgeMs: kOpenclawBackupReuseMaxAgeMs,
    };
  };

  // WI-4.2: the archive the newest migration-required run recorded stays
  // exempt from keep-N eviction while that run is younger than the pin age
  // (the rollback fence names it as the restore candidate).
  const pinnedArchivePaths = () => {
    try {
      const migratedRun = ledger
        .listRuns()
        .find((run) => run?.dbPreflight?.migrationRequired);
      if (!migratedRun) return [];
      const startedAt = Number(migratedRun.startedAt) || 0;
      if (nowFn() - startedAt > kOpenclawBackupPinMaxAgeMs) return [];
      const file = migratedRun.backup?.verified === true ? migratedRun.backup.file : null;
      return file ? [file] : [];
    } catch {
      return [];
    }
  };

  // hardGate: downgrades, dev switches, and cross-channel/prerelease applies
  // all block on a failed verified backup — those transitions can migrate
  // state formats their rollback target cannot read. Same-channel stable
  // upgrades stay soft-gated (auto-rollback still protects them), but the run
  // record carries noBackup so the UI and notifications can say rollback may
  // be limited.
  //
  //   runBackup(opId)
  //     │ ensureBackupsDir()  (legacy-file migration, symlink fail-closed)
  //     │ runBackupDiagnosis() journal mode · fs type · state bytes · live
  //     │                      processes · predicted upstream ms (never blocks)
  //     │ ONE "backup: running" (detail names the path)
  //     ▼
  //   hard gate + gatewayQuiesce injected?
  //     │ yes: QUIESCE FIRST — the gateway is the only writer; stopping it is
  //     │      the deterministic fix for the vanished-file tar race (#11/#18):
  //     │        lock(≤90s, lease = quiesce + offline-copy budgets)
  //     │        → wasRunning? → suppress watchdog → stop(≤30s) → CONFIRMED
  //     │        → dbQuiet (state-DB quiet barrier, owner token)
  //     │        → fixed quiesce deadline
  //     │        → runQuiescedAttemptLoop (kQuiescedOutcomePolicy):
  //     │            upstream attempt (timeout = remaining deadline)
  //     │              success           → usable check → record
  //     │              lock_contention   → contentionRetryVerdict: retry ≤2
  //     │                                  (15s→30s backoff) else OFFLINE COPY
  //     │              killed            → OFFLINE COPY
  //     │              timeout/vanished  → fallback (relaunch → settle → live)
  //     │              workspace broken  → relaunch + unlock FIRST, then the
  //     │                                  one-shot --no-include-workspace LIVE
  //     │              anything else     → terminal 409 (newest archive named)
  //     │            short-circuit to OFFLINE COPY when the diagnosis says
  //     │              rollback-journal + >256MB, or predicted > remaining
  //     │            OFFLINE COPY (still quiesced, exclusivity evidence,
  //     │              sqlite backup() per DB, tar gzip -1, manifest check):
  //     │              ok → record (producer alphaclaw-offline-copy)
  //     │              refused (not exclusive) → honest 409
  //     │              other stage failure → fallback
  //     │            every FAILURE is only classified in-quiesce; it is
  //     │              finalized (409 + reuse gate) by runBackup AFTER the
  //     │              finally below — the reuse gate's gzip/tar/sha256 never
  //     │              run with the gateway down and the barrier held
  //     │            a SUCCESS is only CHECKED in-quiesce (usable check +
  //     │              chmod, budgeted by the lease reserve); its publish
  //     │              (prune, advisory sha256, record) runs after the finally
  //     │              too, and a check that times out is a failure on that
  //     │              same deferred path (finishSuccess `deferred`)
  //     │        → finally: dbResume BEFORE start (if wasRunning; a failed
  //     │          relaunch is its own `gateway-relaunch: warning` step)
  //     │          → unsuppress → unlock
  //     │      lease = quiesce + offline-copy budgets + a reserve for the
  //     │      stop, barrier begin, usable check, prune, and relaunch
  //     │      lock busy / barrier held elsewhere → fail honestly
  //     │      stop unavailable → relaunch, fall through to the live ladder
  //     ▼
  //   after a relaunch: poll isRunning (≤20s) + settle (10s), charged to the
  //   envelope; the first live attempt's detail names the prior failure kind
  //     ▼
  //   LIVE LADDER (soft gates always; hard gates as fallback), kLiveRetryPolicy:
  //     attempt (fresh --output file each time, isBackupArchiveName-conforming
  //     so keep-N retention still prunes) → vanished_file: 750ms ×≤2 ·
  //     lock_contention/killed: 1 retry after 15s · else break
  //     (≤kOpenclawBackupLiveAttempts, all inside one phase envelope; an
  //     attempt starts only if the envelope still holds its budget PLUS the
  //     usable-check reserve — else window_exhausted)
  //     ▼
  //   exit 0 ── artifact at exact path? ──► usable check (gzip -t + manifest;
  //                                          ≥ the reserve; OUR timeout →
  //                                          window_exhausted, no quarantine)
  //                                          ──► record + prune (pinned archive
  //                                          exempt; stale .offline-copy-* temp
  //                                          dirs swept) (+ attempts/quiesced/…)
  //   exit ≠0 ─ classifyBackupFailure ────► honest message incl. attempt count
  //             and the newest surviving archive; own artifact only: empty →
  //             delete, non-empty → .unverified
  //   hard gate + retryable class exhausted ──► REUSE GATE (WI-4.5):
  //     verified ≤24h archive, nothing applied since, re-verified on an open
  //     fd (gzip -t, manifest, sha256) → consent {sha256} matches → record as
  //     reused (no prune) · no consent → 409 + reusableBackup offer
  const runBackup = async ({
    emit,
    hardGate,
    gateReason = "downgrade",
    operationId = null,
    allowBackupReuse = null,
  }) => {
    const willQuiesce = Boolean(hardGate && gatewayQuiesce);
    emit(
      "backup",
      "running",
      willQuiesce ? { detail: "pausing the gateway for a consistent backup" } : undefined,
    );
    const backupStartedAt = nowFn();
    const phaseDeadline = nowFn() + backupBudget.phaseEnvelopeMs;
    const remainingMs = () => Math.max(0, phaseDeadline - nowFn());
    // A LIVE CLI attempt's budget: the CLI ceiling, bounded by what the
    // envelope still holds AFTER the usable-check reserve. < 1 means "do not
    // start another attempt" — a success now could not be checked in time.
    const attemptBudgetMs = () =>
      Math.min(
        backupBudget.cliTimeoutMs,
        remainingMs() - backupBudget.usableCheckReserveMs,
      );
    // How long the quiesce transaction may hold the lifecycle lock (and the
    // watchdog suppression, plus its own slack).
    const quiesceHoldMs = () =>
      backupBudget.quiesceTimeoutMs +
      backupBudget.offlineCopyBudgetMs +
      backupBudget.quiesceLeaseReserveMs;
    const gateNoun =
      gateReason === "downgrade"
        ? "Downgrades"
        : gateReason === "dev"
          ? "Dev switches"
          : "Cross-channel updates";
    const gateHint = `${gateNoun} are blocked without a backup because the rollback target may not read migrated state. Fix the backup or choose a same-channel version.`;
    const emptyTrack = {
      attempts: 0,
      quiesced: false,
      quiescedAttempts: 0,
      vanishedPaths: [],
      contentionRetries: 0,
      offlineCopy: null,
      diagnosis: null,
      durationMs: 0,
    };
    const dirReady = ensureBackupsDir();
    if (!dirReady.ok) {
      if (hardGate) {
        emit("backup", "failed", { error: dirReady.message });
        return {
          ...channelError(
            "backup_failed",
            dirReady.message,
            `${dirReady.hint} ${describeNewestArchive()}`,
          ),
          ...emptyTrack,
        };
      }
      emit("backup", "warning", { error: dirReady.message });
      queueNotify(
        `⚠️ Pre-update backup skipped — continuing (upgrades are protected by auto-rollback, but rollback recovery may be limited). ${dirReady.message}`,
        { eventType: "health", id: `backup-warn-${backupStartedAt}` },
      );
      return { ok: true, warned: true, noBackup: true, ...emptyTrack };
    }
    const diagnosis = runBackupDiagnosis({ operationId });
    // Crash debris from an earlier offline copy holds a full copy of the
    // state DBs — reclaim it before this run needs the space, whether or not
    // this run ends in a prune.
    await sweepStaleOfflineCopyDirs();
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

    const track = {
      attempts: 0,
      quiesced: false,
      quiescedAttempts: 0,
      vanishedPaths: [],
      contentionRetries: 0,
      offlineCopy: null,
    };
    const trackFields = () => ({
      attempts: track.attempts,
      quiesced: track.quiesced,
      quiescedAttempts: track.quiescedAttempts,
      vanishedPaths: track.vanishedPaths,
      contentionRetries: track.contentionRetries,
      offlineCopy: track.offlineCopy,
      diagnosis,
      durationMs: nowFn() - backupStartedAt,
    });
    // WI-1.8: honest attempt wording — how many CLI attempts, how many of
    // them with the gateway paused. Never "including one" when zero were.
    const describeAttempts = () => {
      // No CLI attempt ran (the quiesced driver short-circuited straight to
      // the offline copy): "(after 0 attempts)" would misread as "nothing was
      // attempted" when the copy WAS.
      if (track.attempts === 0) return "";
      if (track.attempts <= 1 && !track.quiesced) return "";
      if (track.attempts === 1 && track.quiescedAttempts === 1) {
        return " (single attempt, with the gateway paused)";
      }
      const paused =
        track.quiescedAttempts > 0 ? `, ${track.quiescedAttempts} with the gateway paused` : "";
      return ` (after ${track.attempts} attempt${track.attempts === 1 ? "" : "s"}${paused})`;
    };

    // One CLI invocation against a fresh output path. Discriminated result so
    // the quiesce/ladder policy above never re-greps the tail.
    const runBackupAttempt = async ({
      timeoutMs,
      detail,
      noWorkspace = false,
      quiesced = false,
    }) => {
      track.attempts += 1;
      if (quiesced) track.quiescedAttempts += 1;
      if (detail) emit("backup", "running", { detail });
      // The workspace retry takes a random suffix: the ladder's freshness
      // comes from nowFn(), which tests legitimately freeze — the CLI would
      // refuse to overwrite the first attempt's artifact path.
      const outputFile = buildBackupOutputFile(
        noWorkspace ? crypto.randomUUID() : operationId,
      );
      // attemptMs is the CLI's own wall time — the only honest input to the
      // next run's predictedUpstreamMs (see priorBackupThroughput).
      const attemptStartedAt = nowFn();
      const raw = await runner.runStreamed({
        command: "openclaw",
        args: [
          "backup",
          "create",
          "--output",
          outputFile,
          "--verify",
          ...(noWorkspace ? ["--no-include-workspace"] : []),
        ],
        env: openclawSpawnEnv(),
        timeoutMs,
      });
      const attemptMs = Math.max(1, nowFn() - attemptStartedAt);
      const result = { ...raw, timeoutMs };
      // Exit 0 alone is not proof: a defective/compromised current build can
      // return success without writing anything. Check the exact path the CLI
      // was told to write (hard gate blocks on it; soft gate records
      // honestly).
      const artifactFile = backupArtifactAt(outputFile);
      if (result.ok && hardGate && !artifactFile) {
        // Live-verified nuance: on a FRESH install the real stable binary
        // exits 0 without writing anything — there is nothing to back up, and
        // nothing a migration could lose, so blocking the switch would brick
        // fresh installs' first channel change. "Fresh" is the strict WI-1.7
        // predicate; anything else with no artifact is a phantom backup.
        if (isFreshStateTree()) {
          cleanupFailedBackup(outputFile);
          return { status: "fresh_install", outputFile, quiesced };
        }
        cleanupFailedBackup(outputFile);
        return { status: "no_artifact", outputFile, quiesced };
      }
      if (result.ok) {
        return { status: "success", artifactFile, outputFile, quiesced, attemptMs };
      }
      cleanupFailedBackup(outputFile);
      const classified = classifyBackupFailure(result, {
        outputFile,
        gateNoun,
      });
      if (classified.kind === "vanished_file" && classified.offendingPath) {
        track.vanishedPaths.push(classified.offendingPath);
      }
      return { status: "failed", classified, result, outputFile, quiesced };
    };

    const recordArtifact = (artifact) => {
      channelStore.updateState((s) => {
        s.backups = [
          artifact,
          ...(Array.isArray(s.backups) ? s.backups : []),
        ].slice(0, kOpenclawBackupKeepCount);
        return s;
      });
    };

    // Two halves. CHECK (usable check + chmod) is the verdict that decides
    // whether the quiesced transaction produced a backup: it is budgeted by
    // the lease reserve and must precede the record. PUBLISH (step outcome,
    // prune, advisory sha256, record) touches neither the gateway nor the
    // state DBs. With `deferred: true` (the quiesced call sites) the check
    // still runs in-quiesce but the publish comes back as a thunk for
    // runBackup to run AFTER the quiesce unwinds (dbResume → start →
    // unsuppress → release) — a multi-GB prune and the up-to-5-min sha256
    // never extend the gateway's downtime — and a check that fails or times
    // out is returned as { failure } for the same post-unwind finalization:
    // finishFailure's reuse gate re-verifies every candidate (gzip -t + tar +
    // sha256), which must never run with the gateway down and the barrier
    // held. Live call sites finalize inline. The archive is immutable once
    // written, and a consented reuse re-verifies on its own opened inode, so
    // nothing in the publish half needs the pause.
    const finishSuccess = async (
      attempt,
      { partial = false, offlineCopy = null, deferred = false } = {},
    ) => {
      const fail = (failure) => (deferred ? { failure } : finishFailure(failure));
      // WI-6.1: "verified" means usable — the archive decompresses and its
      // manifest names this box's state databases. The offline copy ran the
      // same check on its own tmp file before publishing.
      if (attempt.artifactFile && !offlineCopy) {
        // At least the reserve, even when the ladder spent the envelope: a
        // 1 ms check can only time out, and that verdict is about OUR clock.
        const usable = await runUsableCheck(attempt.artifactFile, {
          timeoutMs: Math.max(
            backupBudget.usableCheckReserveMs,
            Math.min(backupBudget.reuseVerifyTimeoutMs, remainingMs()),
          ),
        });
        if (!usable.ok && usable.timedOut) {
          // The CLI verified this archive; OUR check ran out of time. It stays
          // on disk under its real name (the newest survivor named below),
          // unrecorded — never quarantined as unverified, never claimed usable.
          backupLog(
            `[openclaw-update] backup: usable check timed out (${usable.stage}) — the backup window is exhausted; ${attempt.artifactFile} is left in place, unrecorded`,
          );
          return fail({
            classified: {
              kind: "window_exhausted",
              message: `The pre-update backup ran out of time — the archive was written but could not be checked within the ${Math.round(backupBudget.phaseEnvelopeMs / 60000)}-minute backup window.`,
              hint: `Retry the update; if this repeats, the backup itself is too slow for the window — check archive size and disk speed. ${gateHint}`,
              stepError: `usable check timed out: ${usable.stage}`,
            },
            result: null,
            outputFile: attempt.outputFile,
          });
        }
        if (!usable.ok) {
          backupLog(
            `[openclaw-update] backup: usable check failed (${usable.stage}: ${usable.reason}) — treating as a verify failure`,
          );
          cleanupFailedBackup(attempt.artifactFile);
          return fail({
            classified: {
              kind: "verify",
              message: `The pre-update backup failed to verify — the archive's manifest could not be read (${sanitizeForDisplay(usable.reason, 200)}).`,
              hint: gateHint,
              stepError: `usable check failed: ${usable.stage}`,
            },
            result: null,
            outputFile: attempt.outputFile,
          });
        }
      }
      // The archive carries credentials and the upstream CLI writes it under
      // the umask (0644 with the usual 022); the offline copy already
      // tightened its own, so this is a no-op there. One syscall, so it stays
      // in the CHECK half — the file is never left world-readable for the
      // length of a relaunch. Best-effort: a filesystem that refuses chmod
      // (cifs, some bind mounts) still keeps its verified backup — but the
      // refusal is carried on the attempt so the record, a warning step and
      // the completion notification say the archive is at the default mode
      // instead of a silent 0644 file recorded as verified.
      if (attempt.artifactFile) {
        try {
          fsModule.chmodSync(attempt.artifactFile, 0o600);
          attempt.archiveMode = "0600";
          attempt.archiveModeError = null;
        } catch (error) {
          attempt.archiveMode = "default";
          attempt.archiveModeError = sanitizeForDisplay(error.message, 200);
          backupLog(
            `[openclaw-update] backup: chmod 0600 on ${attempt.artifactFile} failed (${attempt.archiveModeError}) — it keeps the filesystem's default mode`,
          );
        }
      }
      const publish = async () => publishSuccess(attempt, { partial, offlineCopy });
      return deferred ? { publish } : publish();
    };

    const publishSuccess = async (attempt, { partial, offlineCopy }) => {
      if (partial) {
        // #21 bug 6: the workspace-excluded retry succeeded. Config + state
        // databases — the data a migration could lose — ARE included.
        emit("backup", "warning", {
          detail:
            "workspace excluded — settings too broken to discover workspaces",
        });
        queueNotify(
          "⚠️ Pre-update backup succeeded WITHOUT workspace files (your OpenClaw settings file is invalid, so workspaces could not be discovered). Config and state databases — the data a migration could lose — ARE included.",
          { eventType: "health", id: `backup-partial-${backupStartedAt}` },
        );
      } else if (offlineCopy) {
        const partialWhy = offlineCopy.partial
          ? ` — partial: ${
              offlineCopy.partialReasons?.length
                ? offlineCopy.partialReasons.join("; ")
                : "workspace files excluded (over the inline size limit)"
            }`
          : "";
        emit("backup", offlineCopy.partial ? "warning" : "completed", {
          detail: `succeeded via AlphaClaw offline copy after ${track.attempts} upstream attempt${
            track.attempts === 1 ? "" : "s"
          } (gateway paused)${partialWhy}`,
        });
      } else {
        // The pause is claimed only when the SUCCEEDING attempt ran quiesced.
        const detail =
          track.attempts > 1 || attempt.quiesced
            ? `succeeded on attempt ${track.attempts}${attempt.quiesced ? " (gateway paused briefly)" : ""}`
            : undefined;
        emit("backup", "completed", detail ? { detail } : undefined);
      }
      // A mode the CHECK half could not tighten is a warning the operator
      // hears about (the archive carries credentials): a step detail plus an
      // always-delivered health notification keyed to this backup — the
      // record below carries the same facts, so nothing about the archive's
      // exposure is only in the log.
      const archiveMode = attempt.artifactFile ? attempt.archiveMode || "default" : null;
      const archiveModeError = attempt.artifactFile ? attempt.archiveModeError || null : null;
      const modeWarnings = [];
      if (archiveMode === "default") {
        modeWarnings.push(
          `archive left at the filesystem's default mode — chmod 0600 failed${archiveModeError ? ` (${archiveModeError})` : ""}`,
        );
      }
      if (backupsDirModeError) {
        modeWarnings.push(
          `backups directory left at the filesystem's default mode — chmod 0700 failed (${backupsDirModeError})`,
        );
      }
      if (modeWarnings.length && attempt.artifactFile) {
        emit("backup", "warning", { detail: modeWarnings.join("; ") });
        queueNotify(
          `⚠️ Pre-update backup succeeded, but its permissions could not be tightened: ${modeWarnings.join("; ")}. The archive (${attempt.artifactFile}) carries credentials — restrict it by hand (chmod 0600) if other users share this filesystem.`,
          { eventType: "health", id: `backup-mode-${backupStartedAt}` },
        );
      }
      await pruneBackups();
      if (!attempt.artifactFile) {
        backupLog(
          `[openclaw-update] backup: exit 0 but no archive at ${attempt.outputFile} — recording no backup file`,
        );
      }
      // Size + mtime are what the rollback fence checks the file against
      // later without hashing (routes/openclaw-channel.js): an archive is
      // never rewritten after publish, so either changing means a swap.
      let bytes = null;
      let mtimeMs = null;
      try {
        if (attempt.artifactFile) {
          const st = fsModule.statSync(attempt.artifactFile);
          bytes = st.size;
          mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
        }
      } catch {}
      // The digest a later consented reuse binds to. It is hashed over an fd
      // opened AFTER the usable check ran on the path, so a writer who swaps
      // the file in between could make this digest name an unchecked inode —
      // acceptable only because the reuse gate never trusts it: it re-runs
      // the usable check AND the hash on its own opened inode and compares
      // the consent digest against THAT result. A missing digest here merely
      // disables pre-consent for this archive; it is never a safety hole.
      // Bounded like the usable check; a timeout or read error is logged,
      // not fatal.
      let sha256 = null;
      if (attempt.artifactFile) {
        let fd = null;
        try {
          fd = (fsModule.openSync || fs.openSync).call(fsModule, attempt.artifactFile, "r");
          sha256 = await sha256OverFd(fd, {
            timeoutMs: Math.max(
              backupBudget.usableCheckReserveMs,
              Math.min(backupBudget.reuseVerifyTimeoutMs, remainingMs()),
            ),
          });
        } catch (error) {
          backupLog(
            `[openclaw-update] backup: sha256 of ${attempt.artifactFile} skipped (${sanitizeForDisplay(error.message, 200)}) — reuse consent for this archive will be unavailable`,
          );
        } finally {
          if (fd !== null) {
            try {
              (fsModule.closeSync || fs.closeSync).call(fsModule, fd);
            } catch {}
          }
        }
      }
      const artifact = {
        at: backupStartedAt,
        dir: backupsDir,
        file: attempt.artifactFile,
        verified: Boolean(attempt.artifactFile),
        producer: offlineCopy ? kOfflineCopyProducer : kUpstreamProducer,
        usableCheck: attempt.artifactFile ? "manifest_ok" : null,
        sha256,
        bytes,
        mtimeMs,
        // "0600" | "default" — the fence and the inventory project it; a
        // default-mode archive is still a verified backup, just an exposed one.
        mode: archiveMode,
        ...(archiveModeError ? { modeError: archiveModeError } : {}),
        ...(backupsDirModeError ? { backupsDirModeError } : {}),
        stateBytes: diagnosis.stateBytes,
        durationMs: nowFn() - backupStartedAt,
        // The succeeding upstream CLI attempt's own wall time (null for an
        // offline copy) — the next run's throughput calibration.
        attemptMs: offlineCopy ? null : (attempt.attemptMs ?? null),
        ...(partial || offlineCopy?.partial
          ? {
              partial: true,
              // The inventory and the Backups card read the reasons from THIS
              // record, so a partial copy must say why (a skipped credentials
              // symlink is not "workspace excluded").
              partialReasons:
                partialReasonsOf(offlineCopy) ??
                (partial ? [kWorkspaceExcludedPartialReason] : null),
            }
          : {}),
        ...(offlineCopy
          ? {
              offlineCopyMs: offlineCopy.durationMs,
              offlineCopyBytes: offlineCopy.bytes,
              exclusivityEvidence: offlineCopy.exclusivityEvidence,
            }
          : {}),
      };
      recordArtifact(artifact);
      return {
        ok: true,
        artifact,
        ...(artifact.partial
          ? {
              partial: true,
              ...(Array.isArray(artifact.partialReasons)
                ? { partialReasons: artifact.partialReasons }
                : {}),
            }
          : {}),
        ...trackFields(),
      };
    };

    // One workspace-excluded retry per backup step (#21 bug 6), from either
    // driver — the CLI itself names the flag when a broken config blocks
    // workspace discovery, and config brokenness will not heal by retrying.
    let workspaceRetryUsed = false;
    const tryWorkspaceRetry = async () => {
      if (workspaceRetryUsed) return null;
      workspaceRetryUsed = true;
      const budget = attemptBudgetMs();
      if (budget < 1) return null;
      const attempt = await runBackupAttempt({
        timeoutMs: budget,
        detail:
          "workspace discovery failed — retrying once without workspace files",
        noWorkspace: true,
      });
      if (attempt.status === "success") {
        return finishSuccess(attempt, { partial: true });
      }
      if (attempt.status === "fresh_install") return finishFreshInstall();
      if (attempt.status === "no_artifact") return finishNoArtifact(attempt);
      return finishFailure(attempt);
    };

    const finishFreshInstall = () => {
      emit("backup", "warning", {
        detail: "no state to back up yet — nothing a migration could lose",
      });
      return { ok: true, warned: true, noBackup: true, ...trackFields() };
    };

    const finishNoArtifact = (attempt) => {
      emit("backup", "failed", {
        error: `no backup artifact at ${attempt.outputFile}`,
      });
      return {
        ...channelError(
          "backup_failed",
          `The backup command reported success but produced no backup file at ${attempt.outputFile}.`,
          `Check the update log for where the backup wrote its archive, then retry — or choose a same-channel version. ${describeNewestArchive()}`,
        ),
        expectedFile: attempt.outputFile,
        ...trackFields(),
      };
    };

    // WI-4.5: the consented-reuse gate. Runs ONLY from a hard-gate failure of
    // a retryable class after the ladder is exhausted. Selection works on an
    // OPEN fd: fstat before and after, sha256 streamed over the fd, gzip -t +
    // manifest on the path (a swapped file fails the digest binding either
    // way). Every candidate is bounded by reuseVerifyTimeoutMs.
    // Shared with listBackupInventory (`reuseWindowStartMs` field) — the UI's
    // consent model binds to the value the gate enforces, so the two must be
    // one computation. Only the exclusion of THIS run differs.
    const reuseWindowStartMs = () =>
      computeReuseWindowStartMs({ excludeOperationId: operationId });

    const sha256OverFd = (fd, { timeoutMs }) =>
      new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = (fsModule.createReadStream || fs.createReadStream).call(fsModule, null, {
          fd,
          autoClose: false,
          start: 0,
        });
        const timer = setTimeout(() => {
          stream.destroy(new Error("sha256 timed out"));
        }, timeoutMs);
        timer.unref?.();
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        stream.on("end", () => {
          clearTimeout(timer);
          resolve(hash.digest("hex"));
        });
      });

    // Every reuse check binds to the OPENED inode, never to the pathname: on
    // Linux gzip -t and the manifest extraction read /proc/<our pid>/fd/<fd>
    // (the PARENT's pid, not /proc/self — the children get a fresh fd table;
    // the same trick gateway.js uses for the prelaunch hook), so a writer
    // who swaps a valid archive onto the path for the usable check and
    // restores the original inode before the final stat still had THIS
    // inode checked and hashed. The children open their own description, so
    // our fd's offset is untouched for the hash. null = /proc unavailable
    // (or not Linux): the tools read the path and the path is re-stat'ed
    // right after the checks against the opened inode.
    const archiveToolTargetForFd = (fd) => {
      if (platform !== "linux") return null;
      const procPath = `/proc/${process.pid}/fd/${fd}`;
      try {
        return fsModule.existsSync(procPath) ? procPath : null;
      } catch {
        return null;
      }
    };

    const verifyReuseCandidate = async (candidate) => {
      // Its OWN budget, independent of the phase envelope: the gate runs only
      // once the ladder has spent the envelope (window_exhausted would
      // otherwise verify every candidate with 1 ms and skip them all), and
      // it is read-only — the gateway is back up and the barrier released.
      const budgetMs = Math.max(1, backupBudget.reuseVerifyTimeoutMs);
      const startedAt = nowFn();
      const remaining = () => Math.max(1, budgetMs - (nowFn() - startedAt));
      let fd = null;
      try {
        fd = fsModule.openSync(candidate.file, "r");
        const before = fsModule.fstatSync(fd);
        if (!before.isFile() || before.size <= 0) {
          return { ok: false, reason: "not_a_regular_file" };
        }
        const viaFd = archiveToolTargetForFd(fd);
        const usable = await runUsableCheck(viaFd || candidate.file, { timeoutMs: remaining() });
        if (!viaFd) {
          const afterCheck = fsModule.statSync(candidate.file);
          if (afterCheck.ino !== before.ino || afterCheck.dev !== before.dev) {
            return { ok: false, reason: "changed_during_verify" };
          }
        }
        if (!usable.ok) return { ok: false, reason: `usable_check_${usable.stage}` };
        const sha256 = await sha256OverFd(fd, { timeoutMs: remaining() });
        const after = fsModule.fstatSync(fd);
        const pathStat = fsModule.statSync(candidate.file);
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          pathStat.ino !== before.ino ||
          pathStat.dev !== before.dev
        ) {
          return { ok: false, reason: "changed_during_verify" };
        }
        // The verified inode's size + mtime travel with the verdict: the
        // rollback fence compares the file on disk against the facts the
        // record captured, and a reused record without them is
        // `unverifiable_content` — "do not restore it" for an archive this
        // code just verified.
        return {
          ok: true,
          sha256,
          producer: usable.producer || candidate.producer,
          bytes: after.size,
          mtimeMs: Number.isFinite(after.mtimeMs) ? after.mtimeMs : null,
        };
      } catch (error) {
        return {
          ok: false,
          reason: /timed out/i.test(error?.message || "") ? "verify_timeout" : "open_failed",
          error: sanitizeForDisplay(error?.message, 200),
        };
      } finally {
        try {
          if (fd != null) fsModule.closeSync(fd);
        } catch {}
      }
    };

    const tryReuseRecentBackup = async ({ failedKind, failedMessage }) => {
      const now = nowFn();
      const since = reuseWindowStartMs();
      let inventory;
      try {
        inventory = listBackupInventory();
      } catch (error) {
        backupLog(`[openclaw-update] backup: reuse inventory unavailable (${error.message})`);
        return null;
      }
      const candidates = inventory.entries.filter(
        (entry) =>
          entry.eligible &&
          entry.exists &&
          entry.verified &&
          !entry.partial &&
          Number.isFinite(entry.at) &&
          now - entry.at <= kOpenclawBackupReuseMaxAgeMs &&
          // Bounded on BOTH sides: a future-dated record has a negative age
          // and would otherwise stay "recent" forever.
          entry.at <= now + kOpenclawBackupClockSkewToleranceMs &&
          entry.at >= since,
      );
      // The first verified candidate is the offer; a consent that matches
      // none of them still returns it so the UI can re-offer honestly.
      let firstOffer = null;
      for (const candidate of candidates) {
        const verified = await verifyReuseCandidate(candidate);
        if (!verified.ok) {
          backupLog(
            `[openclaw-update] backup: reuse candidate ${candidate.name} skipped (${verified.reason})`,
          );
          continue;
        }
        const ageMs = now - candidate.at;
        const offer = {
          file: candidate.file,
          at: candidate.at,
          ageMs,
          sha256: verified.sha256,
          producer: verified.producer,
        };
        firstOffer = firstOffer || offer;
        if (!allowBackupReuse) return { offer };
        if (allowBackupReuse.sha256 !== verified.sha256) {
          backupLog(
            `[openclaw-update] backup: reuse consent sha256 does not match ${candidate.name} — not reusing it`,
          );
          continue;
        }
        const age = formatAge(ageMs);
        const line = `fresh backup failed (${failedKind}) — proceeding with the verified backup from ${age} ago; state written since is not in it`;
        emit("backup", "warning", { detail: line });
        queueNotify(
          `⚠️ Pre-update backup could not be taken fresh (${failedKind}). Proceeding with the verified backup from ${age} ago (${candidate.file}) — state written since then is not in it.`,
          { eventType: "health", operationId, id: `backup-reused-${operationId}` },
        );
        logEvent("backup_reused", "completed", {
          operationId,
          file: candidate.file,
          ageMs,
          sha256: verified.sha256,
          producer: verified.producer,
          failedKind,
        });
        const artifact = {
          at: candidate.at,
          dir: backupsDir,
          file: candidate.file,
          verified: true,
          reused: true,
          reusedAgeMs: ageMs,
          sha256: verified.sha256,
          producer: verified.producer,
          // Same content facts the fresh publish records (the fence's
          // record-vs-disk check reads them; see verifyReuseCandidate).
          bytes: verified.bytes,
          mtimeMs: verified.mtimeMs,
          usableCheck: "manifest_ok",
          freshAttemptFailure: { kind: failedKind, message: failedMessage },
        };
        return { reused: { ok: true, reused: true, artifact, ...trackFields() } };
      }
      return firstOffer ? { offer: firstOffer } : null;
    };

    const finishFailure = async (attempt) => {
      const { classified, result, outputFile } = attempt;
      const message = `${classified.message}${describeAttempts()}`;
      if (hardGate) {
        const reuseEligible = kReuseEligibleKinds.includes(classified.kind);
        const reuse = reuseEligible
          ? await tryReuseRecentBackup({
              failedKind: classified.kind,
              failedMessage: message,
            })
          : null;
        if (reuse?.reused) return reuse.reused;
        emit("backup", "failed", {
          error: classified.stepError,
          tail: result?.tail?.slice(-2000),
        });
        return {
          ...channelError(
            "backup_failed",
            message,
            `${classified.hint} ${describeNewestArchive()}`,
          ),
          expectedFile: outputFile ?? null,
          ...(reuse?.offer ? { reusableBackup: reuse.offer } : {}),
          ...trackFields(),
        };
      }
      emit("backup", "warning", {
        error: classified.stepError,
        tail: result?.tail?.slice(-2000),
      });
      queueNotify(
        `⚠️ Pre-update backup failed — continuing (upgrades are protected by auto-rollback, but rollback recovery may be limited). ${message}`,
        { eventType: "health", id: `backup-warn-${backupStartedAt}` },
      );
      return { ok: true, warned: true, noBackup: true, ...trackFields() };
    };

    const describePriorFailure = (attempt) => {
      const kind = attempt?.classified?.kind;
      if (kind === "vanished_file") {
        const last = track.vanishedPaths[track.vanishedPaths.length - 1];
        return `a live-file race${last ? ` (${last})` : ""}`;
      }
      if (kind === "timeout") return "a timed-out attempt with the gateway paused";
      if (kind === "lock_contention") return "state-database lock contention";
      if (kind === "killed") return `a killed backup (${attempt.classified.signal || "signal"})`;
      if (kind === "offline_copy_failed") return "a failed offline copy";
      return kind ? `a ${kind.replace(/_/g, "-")} failure` : "the paused attempt";
    };

    // WI-1.6: the AlphaClaw offline copy, still quiesced. Exclusivity is
    // proven before a byte is copied; any hard miss is an honest 409, every
    // other stage failure hands over to the relaunch + live ladder.
    const runOfflineCopy = async ({ reason, lastAttempt, stopEvidence, quietToken, stopConfirmed }) => {
      const budgetMs = Math.max(1, Math.min(backupBudget.offlineCopyBudgetMs, remainingMs()));
      const outputFile = buildBackupOutputFile(operationId, { producer: kOfflineCopyProducer });
      const because =
        reason === "rollback_journal_self_deadlock"
          ? "the state database uses a rollback journal too large for the upstream snapshot"
          : reason === "predicted_too_slow"
            ? "the prior run's backup speed cannot fit the remaining pause budget"
            : `the upstream backup failed (${reason})`;
      emit("backup", "running", {
        detail: `${because} — taking an AlphaClaw offline copy of the paused state`,
      });
      logEvent("backup_offline_copy", "started", { operationId, reason, budgetMs });
      // One process-list sample refuses on ANY `openclaw` argv — including
      // AlphaClaw's own transient CLI shell-outs (a cron run, a `--help`
      // capability probe), which the quiet barrier does not gate. Re-sample
      // briefly while the list is non-empty so a child that is already
      // exiting does not turn the last-resort copy into a terminal 409; a
      // holder that stays is refused with its argv named. Bounded by poll
      // COUNT, not the clock (nowFn is frozen in tests), and by a quarter of
      // the copy budget. The /proc/*/fd holder scan inside createOfflineCopy
      // stays the hard refusal — and it runs AFTER the multi-second state
      // walk, so createOfflineCopy calls this sampler again right before that
      // scan: the argv sample and the fd scan must describe the same instant,
      // or a child spawned during the walk is refused as a foreign holder.
      const settleLiveProcesses = async () => {
        const pollMs = Math.max(1, backupBudget.exclusivitySettlePollMs);
        const settleMs = Math.max(
          0,
          Math.min(backupBudget.exclusivitySettleMs, Math.floor(budgetMs / 4)),
        );
        const maxPolls = Math.ceil(settleMs / pollMs);
        let live = probes.listProcesses() || [];
        for (let poll = 0; poll < maxPolls && live.length > 0; poll += 1) {
          await sleepMs(pollMs);
          live = probes.listProcesses() || [];
        }
        return live;
      };
      try {
        // The pre-walk sample is the evidence's starting point only; the
        // settled sample that gates the copy is taken by createOfflineCopy
        // through `sampleLiveProcesses`, next to the fd scan.
        const liveProcesses = probes.listProcesses() || [];
        const copy = await createOfflineCopy({
          stateDir: stateDir(),
          backupsDir,
          outputFile,
          exclusivity: {
            stopConfirmed,
            stopEvidence,
            quietToken,
            liveProcesses,
            handleCount: getStateDbHandleCount(),
          },
          sampleLiveProcesses: settleLiveProcesses,
          isQuiet: isStateDbQuiet,
          runCommand: archiveCommandRunner,
          diagnosis,
          runtimeVersion: (() => {
            try {
              return channelStore.readInstalledVersion({ installDir: safeInstallDir() });
            } catch {
              return null;
            }
          })(),
          budgetMs,
          fsModule,
          nowFn,
          log: (line) => backupLog(`[openclaw-update] backup: ${line}`),
          ...(probes.listFdHolders ? { listFdHolders: probes.listFdHolders } : {}),
        });
        track.offlineCopy = {
          ok: true,
          reason,
          durationMs: copy.durationMs,
          bytes: copy.bytes,
          partial: copy.partial,
          ...(copy.partial ? { partialReasons: copy.partialReasons } : {}),
        };
        logEvent("backup_offline_copy", "completed", {
          operationId,
          reason,
          durationMs: copy.durationMs,
          bytes: copy.bytes,
          partial: copy.partial,
          ...(copy.partial ? { partialReasons: copy.partialReasons } : {}),
          completeness: copy.exclusivityEvidence?.completeness,
        });
        // { publish }: the copy verified itself on its tmp file, so the check
        // half is a no-op here and the prune + sha256 + record run after the
        // unwind (see finishSuccess).
        return finishSuccess(
          { status: "success", artifactFile: copy.file, outputFile, quiesced: true },
          { offlineCopy: copy, deferred: true },
        );
      } catch (error) {
        const stage = error instanceof OfflineCopyError ? error.stage : "unexpected";
        const detail = sanitizeForDisplay(error?.message, 300);
        // A budget/quiet abort cancels sqlite backup() at its next step (the
        // progress hook throws into the job); one whose current step never
        // returned inside the orphan bound is still stepping when the barrier
        // lifts below — that fact travels with the failure (record + event),
        // never only in the log.
        const orphanFields = error?.orphanedBackup === true ? { orphanedBackup: true } : {};
        track.offlineCopy = { ok: false, reason, stage, error: detail, ...orphanFields };
        logEvent("backup_offline_copy", "failed", {
          operationId,
          reason,
          stage,
          error: detail,
          ...orphanFields,
        });
        backupLog(
          `[openclaw-update] backup: offline copy failed at ${stage}: ${detail}${
            orphanFields.orphanedBackup
              ? " — an orphaned sqlite backup() step did not return inside the bound (its source was closed and its temp destination unlinked; the job aborts at its next step, and until then it may hold a read lock on the state DB)"
              : ""
          }`,
        );
        cleanupFailedBackup(outputFile);
        if (stage === "exclusivity") {
          // Classified here, finalized by runBackup AFTER the quiesce unwinds:
          // finishFailure runs the reuse gate (gzip -t + tar + sha256 over
          // every candidate, minutes on real archives), which must never run
          // with the gateway down and the state-DB barrier held.
          return {
            failure: {
              classified: {
                kind: "offline_copy_refused",
                message: `The pre-update backup could not be taken: ${because}, and the offline copy was refused because ${detail}.`,
                hint: `Stop whatever else is using the OpenClaw state directory, then retry. ${gateHint}`,
                stepError: `offline copy refused: ${detail}`,
              },
              result: lastAttempt?.result ?? null,
              outputFile,
            },
          };
        }
        return { fallback: true, lastAttempt: lastAttempt || { classified: { kind: "offline_copy_failed" } } };
      }
    };

    // WI-1.4: the in-quiesce attempt loop — policy table, fixed deadline,
    // budget-aware retries, then the offline copy.
    const runQuiescedAttemptLoop = async ({ quiesceDeadline, stopEvidence, quietToken, stopConfirmed }) => {
      const quiesceBudgetMs = Math.max(1, quiesceDeadline - nowFn());
      const quiesceRemaining = () => Math.max(0, quiesceDeadline - nowFn());
      const shortCircuit = describeShortCircuit(diagnosis, quiesceRemaining());
      let lastAttempt = null;
      if (shortCircuit) {
        backupLog(
          `[openclaw-update] backup: skipping the upstream attempt (${shortCircuit}) — offline copy first`,
        );
      } else {
        for (;;) {
          const attemptStartedAt = nowFn();
          const attempt = await runBackupAttempt({
            timeoutMs: Math.max(1, quiesceRemaining()),
            quiesced: true,
            detail: lastAttempt
              ? `attempt ${track.attempts + 1} — retrying after state-database lock contention (gateway still paused)`
              : undefined,
          });
          // { publish } or { failure } — the usable check ran in-quiesce, the
          // rest is finalized by runBackup after the unwind.
          if (attempt.status === "success") return finishSuccess(attempt, { deferred: true });
          if (attempt.status === "fresh_install") return { done: finishFreshInstall() };
          if (attempt.status === "no_artifact") return { done: finishNoArtifact(attempt) };
          lastAttempt = attempt;
          const kind = attempt.classified.kind;
          const policy = kQuiescedOutcomePolicy[kind] ?? kQuiescedOutcomePolicy.default;
          if (policy === "retry") {
            const failedMs = nowFn() - attemptStartedAt;
            const backoffMs =
              backupBudget.contentionBackoffBaseMs * 2 ** track.contentionRetries;
            const verdict = contentionRetryVerdict({
              failedMs,
              backoffMs,
              remainingMs: quiesceRemaining(),
              budgetMs: quiesceBudgetMs,
              retries: track.contentionRetries,
              maxRetries: backupBudget.contentionRetries,
            });
            logEvent("backup_contention", verdict.retry ? "retrying" : "exhausted", {
              operationId,
              attempt: track.attempts,
              failedMs,
              backoffMs,
              remainingMs: quiesceRemaining(),
              reason: verdict.reason,
            });
            if (verdict.retry) {
              track.contentionRetries += 1;
              backupLog(
                `[openclaw-update] backup: state-database lock contention on attempt ${track.attempts} — retrying in ${Math.round(backoffMs / 1000)}s with the gateway still paused (${track.contentionRetries}/${backupBudget.contentionRetries})`,
              );
              await sleepMs(backoffMs);
              continue;
            }
            backupLog(
              `[openclaw-update] backup: not retrying in-quiesce (${verdict.reason}) — offline copy next`,
            );
            break;
          }
          if (policy === "offline_copy") break;
          if (policy === "fallback") return { fallback: true, lastAttempt: attempt };
          if (policy === "workspace_retry") return { workspaceRetry: true, lastAttempt: attempt };
          // Terminal: classified in-quiesce, finalized after the unwind (a
          // failure's finalization may run the reuse gate — see runOfflineCopy).
          return { failure: attempt };
        }
      }
      const copy = await runOfflineCopy({
        reason: shortCircuit || lastAttempt.classified.kind,
        lastAttempt,
        stopEvidence,
        quietToken,
        stopConfirmed,
      });
      if (copy.publish || copy.failure) return copy;
      return { fallback: true, lastAttempt: copy.lastAttempt };
    };

    // Quiesce transaction. Returns { done: <final result> } when the step
    // decided without an archive (fresh install, phantom artifact, lock or
    // barrier unavailable), { publish: <thunk> } when a backup was written
    // and CHECKED in-quiesce (the caller runs the publish — prune, sha256,
    // record — after the finally below), { failure: <attempt> } when it
    // failed terminally (the caller finalizes it — 409 + reuse gate — only
    // after the finally below has resumed the state DB and relaunched the
    // gateway),
    // { fallback: true, relaunched } when the live ladder should take over
    // (stop unavailable, quiesced attempt timed out, an exogenous writer raced
    // even the paused gateway, or the offline copy failed), or
    // { workspaceRetry: true } when the caller must run the one-shot
    // --no-include-workspace retry LIVE (never in-quiesce).
    const runQuiescedBackup = async () => {
      let release = null;
      let lockTimedOut = false;
      let acquireError = null;
      release = await Promise.race([
        Promise.resolve()
          .then(() =>
            gatewayQuiesce.acquireLock({
              // The hold must outlive the quiesced attempts AND the offline
              // copy AND everything else done under the lock (stop, barrier
              // begin, usable check, relaunch ready budget — the prune and
              // sha256 run after the unlock); the default 10-min lease would
              // force-release mid-copy.
              leaseMs: quiesceHoldMs(),
            }),
          )
          .then((rel) => {
            if (!lockTimedOut) return rel;
            // The race already gave up: never strand a lock nobody will
            // release — the lease would block every gateway operation for
            // its full 10 minutes.
            try {
              rel?.();
            } catch {}
            return null;
          })
          // The .catch keeps a POST-timeout acquire rejection off the
          // unhandledRejection path (the watchdog's twin race carries the
          // same guard); a PRE-timeout rejection still falls back to the
          // live ladder via acquireError below.
          .catch((error) => {
            acquireError = error || new Error("acquire failed");
            return null;
          }),
        sleepMs(backupBudget.quiesceLockTimeoutMs).then(() => {
          lockTimedOut = true;
          return null;
        }),
      ]);
      if (acquireError && !lockTimedOut) {
        backupLog(
          `[openclaw-update] backup: quiesce lock unavailable (${acquireError.message}) — falling back to live attempts`,
        );
        return { fallback: true };
      }
      if (!release) {
        const message =
          "The pre-update backup could not pause the gateway: another gateway operation is in progress.";
        emit("backup", "failed", { error: "gateway busy" });
        return {
          done: {
            ...channelError(
              "backup_failed",
              message,
              "Wait for the running gateway operation to finish, then retry.",
            ),
            ...trackFields(),
          },
        };
      }
      // wasRunning is sampled AFTER the lock is held: sampling before it
      // races whoever held the lock (they may stop/start the gateway).
      let wasRunning = true;
      let gatewayDown = false;
      let quietToken = null;
      try {
        try {
          wasRunning = Boolean(await gatewayQuiesce.isRunning());
        } catch {
          wasRunning = true;
        }
        try {
          // The watchdog's expected-restart window must outlive the whole
          // hold, or it treats our own relaunch as an unexpected exit.
          gatewayQuiesce.suppress(quiesceHoldMs() + kOpenclawBackupQuiesceSuppressSlackMs);
        } catch {}
        let stopped = !wasRunning;
        if (wasRunning) {
          try {
            stopped = Boolean(await gatewayQuiesce.stop());
          } catch (error) {
            backupLog(
              `[openclaw-update] backup: gateway stop failed (${error.message}) — falling back to live attempts`,
            );
            stopped = false;
          }
        }
        if (!stopped) {
          // The stop attempt already SIGTERMed the managed child — bring the
          // gateway back before the ladder runs against a live writer.
          try {
            await gatewayQuiesce.start();
          } catch {}
          emit("backup", "running", {
            detail:
              "gateway did not pause cleanly — falling back to live backup attempts",
          });
          return { fallback: true };
        }
        gatewayDown = wasRunning;
        let stopEvidence = null;
        try {
          stopEvidence = gatewayQuiesce.getStopEvidence?.() ?? null;
        } catch {}
        // Fixed deadline, computed ONCE: every in-quiesce attempt gets what is
        // left of it, never a fresh budget — and the envelope keeps the
        // usable-check reserve back from it.
        const quiesceDeadline =
          nowFn() +
          Math.min(
            backupBudget.quiesceTimeoutMs,
            Math.max(remainingMs() - backupBudget.usableCheckReserveMs, 1),
          );
        // State-DB quiet barrier (lane D): status readers fall back, writers
        // 409, the cron store and notifier stand down — until dbResume in the
        // finally. An already-held barrier is another backup in flight.
        const quietAbort = new AbortController();
        const quietAbortTimer = setTimeout(
          () => quietAbort.abort(new Error("quiesce deadline passed while pausing state-db access")),
          Math.max(1, quiesceDeadline - nowFn()),
        );
        quietAbortTimer.unref?.();
        try {
          quietToken = await dbQuiet({
            owner: "quiesced-backup",
            maxMs: backupBudget.stateDbQuietMaxMs,
            signal: quietAbort.signal,
            onEvent: (event) =>
              logEvent("state_db_quiet", event?.status || "event", { ...event, operationId }),
          });
        } catch (error) {
          const detail = sanitizeForDisplay(error?.message, 300);
          backupLog(`[openclaw-update] backup: state-db quiet barrier unavailable (${detail})`);
          emit("backup", "failed", { error: "state database busy" });
          return {
            done: {
              ...channelError(
                "backup_failed",
                `The pre-update backup could not pause state-database access: ${detail}.`,
                `Wait for the other backup to finish, then retry. ${describeNewestArchive()}`,
              ),
              ...trackFields(),
            },
          };
        } finally {
          clearTimeout(quietAbortTimer);
        }
        track.quiesced = true;
        // The events tab is the operator's audit timeline — a deliberate
        // gateway pause must appear on it (F14).
        logEvent("backup_quiesce", "engaged", {
          operationId,
          stopConfirmed: true,
          stopEvidence: stopEvidence ?? null,
        });
        const outcome = await runQuiescedAttemptLoop({
          quiesceDeadline,
          stopEvidence,
          quietToken: quietToken?.token ?? quietToken,
          stopConfirmed: true,
        });
        // `relaunched` asks the caller to settle before LIVE attempts; a
        // decided outcome (success to publish, or terminal failure) runs none.
        return {
          ...outcome,
          relaunched: gatewayDown && !outcome.done && !outcome.publish && !outcome.failure,
        };
      } finally {
        // dbResume BEFORE start: the relaunched gateway's first writes must
        // not land while readers are still told to stand down.
        try {
          if (quietToken) dbResume(quietToken);
        } catch (error) {
          backupLog(`[openclaw-update] backup: state-db quiet release failed (${error.message})`);
        }
        if (gatewayDown) {
          try {
            await gatewayQuiesce.start();
          } catch (error) {
            // WI-1.9: its own step — the backup's outcome is not this failure.
            emit("gateway-relaunch", "warning", {
              error: `gateway relaunch after backup failed: ${sanitizeForDisplay(error.message)}`,
            });
            queueNotify(
              `⚠️ The gateway did not relaunch cleanly after the pre-update backup pause — the watchdog will retry. (${sanitizeForDisplay(error.message)})`,
              { eventType: "health", id: `backup-restart-${backupStartedAt}` },
            );
          }
        }
        try {
          gatewayQuiesce.unsuppress();
        } catch {}
        try {
          release?.();
        } catch {}
      }
    };

    // WI-1.5: after a relaunch, let the gateway answer and settle before any
    // live CLI attempt runs against its startup writes. Real sleeps, charged
    // to the envelope through nowFn in production.
    const settleAfterRelaunch = async () => {
      emit("backup", "running", {
        detail: "gateway relaunched — waiting for it to answer before live attempts",
      });
      const pollMs = Math.max(1, backupBudget.postQuiescePollMs);
      const maxPolls = Math.ceil(backupBudget.postQuiesceReadyTimeoutMs / pollMs);
      let ready = false;
      for (let poll = 0; poll < maxPolls && !ready; poll += 1) {
        try {
          ready = Boolean(await gatewayQuiesce.isRunning());
        } catch {
          ready = false;
        }
        if (!ready) await sleepMs(pollMs);
      }
      if (backupBudget.postQuiesceSettleMs > 0) await sleepMs(backupBudget.postQuiesceSettleMs);
      backupLog(
        `[openclaw-update] backup: gateway ${
          ready ? "answered" : `did not answer within ${Math.round(backupBudget.postQuiesceReadyTimeoutMs / 1000)}s`
        } after the relaunch — live attempts start now`,
      );
    };

    let priorAttempt = null;
    if (willQuiesce) {
      const quiesced = await runQuiescedBackup();
      if (quiesced.done) return quiesced.done;
      // Finalized HERE — the quiesce's finally has resumed the state DB,
      // relaunched the gateway, and released the lock — so neither the
      // success publish (prune + advisory sha256 + record) nor the reuse
      // gate's candidate re-verification ever runs against a paused box.
      if (quiesced.publish) return quiesced.publish();
      if (quiesced.failure) return finishFailure(quiesced.failure);
      if (quiesced.relaunched) await settleAfterRelaunch();
      priorAttempt = quiesced.lastAttempt || null;
      if (quiesced.workspaceRetry) {
        // The quiesced driver classified workspace_discovery but must not
        // retry in-quiesce (see the comment there): by now its finally has
        // restarted the gateway and released the lifecycle lock, so the
        // one-shot retry runs live — equivalent coverage, no lease risk.
        const done = await tryWorkspaceRetry();
        return done || finishFailure(quiesced.lastAttempt);
      }
    }

    // Live ladder (kLiveRetryPolicy): retries help only when the failure is
    // transient — vanished-file races, lock contention, a killed CLI. ENOSPC
    // or a missing subcommand will not heal by trying again.
    let liveAttempts = 0;
    let lastAttempt = null;
    const retriesUsed = {};
    while (liveAttempts < backupBudget.liveAttempts) {
      const budget = attemptBudgetMs();
      if (budget < 1) break;
      liveAttempts += 1;
      const prior = lastAttempt || priorAttempt;
      const detail =
        track.attempts > 0
          ? `attempt ${track.attempts + 1} — retrying after ${describePriorFailure(prior)}`
          : undefined;
      const attempt = await runBackupAttempt({ timeoutMs: budget, detail });
      if (attempt.status === "success") return finishSuccess(attempt);
      if (attempt.status === "fresh_install") return finishFreshInstall();
      if (attempt.status === "no_artifact") return finishNoArtifact(attempt);
      lastAttempt = attempt;
      const kind = attempt.classified.kind;
      if (kind === "workspace_discovery") {
        const done = await tryWorkspaceRetry();
        return done || finishFailure(attempt);
      }
      const rule = kLiveRetryPolicy[kind];
      if (!rule) break;
      if ((retriesUsed[kind] || 0) >= rule.retries) break;
      if (liveAttempts >= backupBudget.liveAttempts) break;
      if (attemptBudgetMs() < 1) break;
      retriesUsed[kind] = (retriesUsed[kind] || 0) + 1;
      await sleepMs(
        kind === "vanished_file"
          ? backupBudget.retryDelayMs
          : backupBudget.contentionBackoffBaseMs,
      );
    }
    if (!lastAttempt) {
      // Envelope exhausted before any live attempt could run (a quiesced
      // attempt consumed it, or what is left would not cover an attempt plus
      // the usable-check reserve). Report the truth rather than a fake attempt.
      return finishFailure({
        classified: {
          kind: "window_exhausted",
          message: `The pre-update backup ran out of time — the ${Math.round(backupBudget.phaseEnvelopeMs / 60000)}-minute backup window was exhausted.`,
          hint: "Retry the update; if this repeats, the backup itself is too slow for the window — check archive size and disk speed.",
          stepError: "backup window exhausted",
        },
        result: priorAttempt?.result ?? null,
        outputFile: priorAttempt?.outputFile ?? null,
      });
    }
    return finishFailure(lastAttempt);
  };

  const removeBackupDebris = async (target) => {
    try {
      await (fsModule.promises || fs.promises).rm(target, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      log(`backup prune could not remove ${target}: ${error.message}`);
    }
  };

  // The offline copy stages its state-DB copies in
  // `<backupsDir>/<kOfflineCopyTempDirPrefix><pid>-<rand>` and removes the dir
  // in its finally — a crash or a SIGTERM (gracefulExit hard-exits after 10 s)
  // skips that, leaving a full copy of the state tree on disk. A dir older
  // than the offline-copy budget plus slack cannot belong to a copy still in
  // flight. Fresh dirs are never touched: they may be this very run's copy.
  // The prefix is the producer's own export, so a rename there cannot
  // silently stop this sweep from matching.
  const sweepStaleOfflineCopyDirs = async () => {
    let names = [];
    try {
      names = fsModule.readdirSync(backupsDir);
    } catch {
      return;
    }
    const staleBeforeMs =
      nowFn() - (backupBudget.offlineCopyBudgetMs + backupBudget.staleTempDirSlackMs);
    for (const name of names) {
      if (!String(name).startsWith(kOfflineCopyTempDirPrefix)) continue;
      const full = path.join(backupsDir, name);
      let st;
      try {
        st = fsModule.lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.mtimeMs > staleBeforeMs) continue;
      backupLog(
        `[openclaw-update] backup: removing stale offline-copy temp dir ${full} (${formatAge(nowFn() - st.mtimeMs)} old)`,
      );
      await removeBackupDebris(full);
    }
  };

  // Retention with strict name classes. Only files this code (or the CLI)
  // named are retention's business — an operator's stray file in the
  // directory is never deleted, and debris (temps, quarantined .unverified
  // archives, stale offline-copy temp dirs) can never evict a verified backup
  // by being newer. The archive a still-fenced migrating run recorded is
  // exempt from eviction (WI-4.2).
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
    const pinned = new Set(pinnedArchivePaths());
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
      else if (isBackupArchiveName(name)) archives.push({ full, mtime });
    }
    const remove = removeBackupDebris;
    const newestFirst = (entries) => entries.sort((a, b) => b.mtime - a.mtime);
    for (const entry of newestFirst(archives).slice(kOpenclawBackupKeepCount)) {
      if (pinned.has(entry.full)) {
        log(`backup prune kept ${entry.full}: pinned by the newest migration-required run`);
        continue;
      }
      await remove(entry.full);
    }
    // Autotune backup budget is ADVISORY ONLY: it never deletes below the
    // keep-N guarantee (auto-pruning verified backups is destructive and not
    // revertible) — it warns when the kept archives outgrow the disk-derived
    // budget so the operator frees space or adds disk.
    try {
      const { getBackupMaxTotalBytes } = require("./autotune");
      const budgetBytes = getBackupMaxTotalBytes();
      if (budgetBytes != null) {
        let keptBytes = 0;
        for (const entry of newestFirst(archives).slice(0, kOpenclawBackupKeepCount)) {
          try {
            keptBytes += fsModule.statSync(entry.full).size || 0;
          } catch {}
        }
        if (keptBytes > budgetBytes) {
          const gb = (n) => `${Math.round((n / 1024 ** 3) * 10) / 10}GB`;
          log(
            `backup retention warning: kept archives use ${gb(keptBytes)} of the ${gb(budgetBytes)} disk budget — delete old archives from the backups directory or add disk`,
          );
        }
      }
    } catch {}
    // Keep the single newest quarantined archive briefly for diagnosis.
    for (const entry of newestFirst(unverified).slice(1)) {
      await remove(entry.full);
    }
    // Temps are crash debris — the CLI removes its own on every exit path.
    for (const entry of temps) {
      await remove(entry.full);
    }
    await sweepStaleOfflineCopyDirs();
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

  // The state dir the INSTALLED CLI actually uses: OPENCLAW_STATE_DIR from the
  // spawn env when set (gatewayEnv pins it to OPENCLAW_DIR in production, an
  // operator override wins elsewhere), else openclawDir.
  const stateDir = () => {
    let fromEnv = "";
    try {
      fromEnv = String(openclawSpawnEnv()?.OPENCLAW_STATE_DIR || "").trim();
    } catch {}
    if (!fromEnv) return openclawDir;
    if (fromEnv.startsWith("~/")) fromEnv = path.join(os.homedir(), fromEnv.slice(2));
    return path.resolve(fromEnv);
  };

  // State databases OpenClaw 2026.8 may migrate: the global control-plane DB and
  // every per-agent data-plane DB (docs/reference/database-schemas.md).
  const enumerateStateDbs = () => {
    const dbs = [];
    const root = stateDir();
    const globalDb = path.join(root, "state", "openclaw.sqlite");
    if (fsModule.existsSync(globalDb)) dbs.push(globalDb);
    const agentsDir = path.join(root, "agents");
    try {
      for (const agentId of fsModule.readdirSync(agentsDir)) {
        const agentDb = path.join(
          agentsDir,
          agentId,
          "agent",
          "openclaw-agent.sqlite",
        );
        if (fsModule.existsSync(agentDb)) dbs.push(agentDb);
      }
    } catch {}
    return dbs;
  };

  const kUnknownCommandPattern = /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;
  // Narrow CLI-capability classifier for validate/db-preflight sites: the
  // broad pattern's bare /unrecognized/ also matches VALIDATOR output
  // ("Unrecognized keys detected in configuration") whose blame lines miss
  // the extraction regex — misreading an INVALID config as validate-missing
  // lets configHealthy pass and launches the gateway on a rejected config.
  // The broad pattern stays for the backup step's no_command bucket, where
  // over-matching only softens an error message, never a gate.
  const kUnknownCliCommandPattern =
    /unknown (?:command|subcommand)|command not found|no such (?:command|subcommand)/i;

  // Classify a `database preflight` run:
  //   "unsupported" — the target binary has no such command (stable) → warn+continue
  //   "block"       — incompatible / crash / timeout / unparseable → HARD-block
  //   "pass"        — exit 0 with no explicit incompatibility marker
  const classifyPreflight = (result) => {
    const text = `${result?.tail || ""}\n${result?.stderr || ""}`;
    if (!result?.ok) {
      // Narrow capability pattern (kUnknownCliCommandPattern): a real
      // incompatibility error that happens to contain "unrecognized" must
      // hard-block, not soften into the missing-command warn+continue.
      if (kUnknownCliCommandPattern.test(text)) return "unsupported";
      return "block"; // nonzero exit = incompatible or crashed (once supported)
    }
    const parsed = parseJsonObjectFromNoisyOutput(result.tail || result.stdout || "");
    if (parsed && typeof parsed === "object") {
      if (
        parsed.ok === false ||
        parsed.compatible === false ||
        parsed.result === "incompatible" ||
        parsed.result === "indeterminate"
      ) {
        return "block";
      }
    }
    return "pass"; // preflight exits nonzero on incompatibility; exit 0 = compatible
  };

  // Verify the target release can read the current state DBs before we let it run.
  // Runs the EXACT overlay binary (not the installed runtime) against a WAL-consistent
  // VACUUM INTO snapshot of each DB. Fail-open ONLY for a genuinely unsupported command
  // (stable target); any real incompatibility hard-blocks the apply in both directions.
  // binOverride: dev applies probe the freshly built checkout binary; the boot
  // rollback path probes the rollback target's overlay bin. emit defaults to a
  // no-op so non-operation callers (boot) can use it too.
  const runDatabasePreflight = async ({
    version,
    emit = () => {},
    binOverride = null,
  }) => {
    emit("db-preflight", "running");
    const bin =
      binOverride ||
      channelStore.resolvePackageBin(channelStore.overlayPackageDir(version));
    if (!bin) {
      emit("db-preflight", "warning", { detail: "no target binary to probe" });
      return { ok: true, warned: true };
    }
    const dbPaths = enumerateStateDbs();
    if (dbPaths.length === 0) {
      // Same fail-closed predicate as the backup step's fresh-install waiver
      // (WI-1.7): only a literally empty state tree is "nothing to probe". A
      // tree with sessions/config but no database has nothing the target CLI
      // can be probed against — say so instead of claiming compatibility.
      if (isFreshStateTree()) {
        emit("db-preflight", "completed", { detail: "no state database" });
        return { ok: true };
      }
      emit("db-preflight", "warning", {
        detail:
          "no state database to probe — the state tree is not empty, so compatibility could not be checked",
      });
      return { ok: true, warned: true };
    }
    let anyUnsupported = false;
    let anyChecked = false;
    let migrationRequired = false;
    let foundVersion = null;
    let targetVersion = null;
    let dbSizesBytes = 0;
    for (const dbPath of dbPaths) {
      try {
        dbSizesBytes += fsModule.statSync(dbPath).size;
      } catch {}
      const snapshot = path.join(
        os.tmpdir(),
        `alphaclaw-preflight-${version}-${nowFn()}-${path.basename(dbPath)}`,
      );
      let snapped = false;
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
          snapped = true;
        } finally {
          db.close();
        }
      } catch (error) {
        // Our own snapshot failure (disk, lock) is a WARNING, not a block.
        emit("db-preflight", "warning", {
          detail: `snapshot of ${path.basename(dbPath)} failed: ${error.message}`,
        });
        continue;
      }
      try {
        const result = await runner.runStreamed({
          command: "node",
          args: [bin, "database", "preflight", snapshot, "--json"],
          env: probeEnv(),
          timeoutMs: 120000,
        });
        const verdict = classifyPreflight(result);
        if (verdict === "unsupported") {
          anyUnsupported = true;
        } else if (verdict === "block") {
          emit("db-preflight", "failed", { tail: result.tail?.slice(-2000) });
          return {
            ok: false,
            error: channelError(
              "db_preflight_failed",
              `OpenClaw ${version} cannot safely read your current database (${path.basename(dbPath)}).`,
              // D2 contract: consequence + fix. The block fired BEFORE
              // activation, so nothing changed — no restore is needed.
              "The update was stopped before anything changed — your current version keeps running. Pick a different version, or check the target's release notes for a database migration note.",
            ),
          };
        } else {
          anyChecked = true;
          // Structured verdict persisted into the run record (issue #20):
          // boot sizes its migration budget and decides whether the official
          // migration must run from this hint. Fields per the target CLI's
          // JSON ("migration-required", foundVersion, targetVersion).
          const parsed = parseJsonObjectFromNoisyOutput(
            result.tail || result.stdout || "",
          );
          if (parsed && typeof parsed === "object") {
            if (isMigrationRequiredVerdict(parsed)) {
              migrationRequired = true;
            }
            if (foundVersion == null && parsed.foundVersion != null) {
              foundVersion = parsed.foundVersion;
            }
            if (targetVersion == null && parsed.targetVersion != null) {
              targetVersion = parsed.targetVersion;
            }
          }
        }
      } finally {
        try {
          if (snapped) fsModule.rmSync(snapshot, { force: true });
        } catch {}
      }
    }
    if (anyUnsupported && !anyChecked) {
      emit("db-preflight", "warning", {
        detail: "target OpenClaw has no database preflight command",
      });
    } else if (migrationRequired) {
      emit("db-preflight", "completed", {
        detail: "schema migration will run at the next start",
      });
    } else {
      emit("db-preflight", "completed");
    }
    return {
      ok: true,
      unsupported: anyUnsupported,
      verdict: {
        migrationRequired: anyChecked ? migrationRequired : null,
        foundVersion,
        targetVersion,
        dbSizesBytes,
      },
    };
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
    // WI-4.5 consent: { sha256 } of the ONE archive the operator agreed to
    // reuse if the fresh backup ladder fails. Validated by the route (strict
    // object, humans only); null = no consent = 409 + reusableBackup offer.
    allowBackupReuse = null,
  } = {}) => {
    // Reciprocal of the restart route's apply_in_progress gate: an apply must
    // never start while a restart/repair/boot holds the gateway — its
    // activation restart would kill the gateway mid-operation.
    let activeGatewayOp = null;
    try {
      activeGatewayOp = getActiveGatewayOperation?.() || null;
    } catch {}
    if (activeGatewayOp) {
      // Migration-class holders get the specific gateway_busy envelope: a
      // reconcile retry / boot reconcile can legitimately hold the lock for a
      // 30-min doctor pass, and a soft-gate apply never touches the lock —
      // its terminal restartProcess() would SIGKILL that migration mid-write.
      // The 409 (not a queue) is the protection.
      const migrationHolder =
        activeGatewayOp.kind === "reconcile_retry" ||
        activeGatewayOp.kind === "boot";
      if (migrationHolder) {
        return {
          status: 409,
          body: channelError(
            "gateway_busy",
            "A settings migration is running — an OpenClaw update cannot start until it finishes.",
            "Wait for the migration to finish (the Upgrade page shows its progress), then retry.",
          ),
        };
      }
      return {
        status: 409,
        body: channelError(
          "gateway_operation_in_progress",
          `A gateway ${activeGatewayOp.kind === "restart" ? "restart" : "operation"} is in progress.`,
          "Wait for it to finish — the Gateway card shows its progress.",
        ),
      };
    }
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
      extraSecretEnv: openclawSpawnEnv(),
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
      { eventType: "info", operationId, id: `apply-start-${operationId}`, verbose: true },
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
                  // The consented-reuse offer must survive the quick window:
                  // the UI's resume poll reads it from here.
                  ...(isReusableBackupOffer(body.reusableBackup)
                    ? { reusableBackup: body.reusableBackup }
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
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
                  : {}),
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
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
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
        allowBackupReuse,
      });
      // attempts/quiesced/vanishedPaths make a live-race failure (#11/#18)
      // diagnosable from the run record alone: how many tries, whether the
      // gateway was paused, and which volatile files kept vanishing. The
      // pre-backup diagnosis, contention retries, and the offline-copy
      // outcome (#54) ride along for the same reason. attempts is 0 — never
      // a fabricated 1 — when no CLI attempt ran.
      const backupDiagnostics = {
        attempts: backup.attempts ?? 0,
        quiesced: Boolean(backup.quiesced),
        quiescedAttempts: backup.quiescedAttempts ?? 0,
        vanishedPaths: Array.isArray(backup.vanishedPaths)
          ? backup.vanishedPaths.slice(0, 10)
          : [],
        contentionRetries: backup.contentionRetries ?? 0,
        offlineCopy: backup.offlineCopy ?? null,
        diagnosis: backup.diagnosis ?? null,
        durationMs: backup.durationMs ?? null,
      };
      if (!backup.ok) {
        // Record WHERE the backup was expected before failing — a bare
        // `backup: null` run record made issue #9 undiagnosable.
        try {
          ledger.updateRun(operationId, (record) => {
            record.backup = {
              noBackup: true,
              at: nowFn(),
              expectedFile: backup.expectedFile ?? null,
              ...backupDiagnostics,
            };
            return record;
          });
        } catch {}
        return finish(409, backup);
      }
      try {
        ledger.updateRun(operationId, (record) => {
          record.backup = backup.artifact
            ? { ...backup.artifact, noBackup: false, ...backupDiagnostics }
            : { noBackup: true, at: nowFn(), ...backupDiagnostics };
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
            // The previous pin is the pin window's rollback target — pruning
            // it would leave a bad pin with nothing to roll back to.
            pinWindowRetainsPrevious(freshState)
              ? freshState.previousPin?.version
              : null,
            version,
          ].filter(Boolean),
        });
        // Verify the target can read the current state DBs before we record it as
        // the version to activate. Hard-blocks on a real incompatibility.
        const preflight = await runDatabasePreflight({ version, emit });
        if (!preflight.ok) return finish(409, preflight.error);
        // Persist the structured verdict for the boot phase: the reconciler
        // sizes its migration budget from it and knows whether the official
        // migration must run even when the config validates (issue #20).
        if (preflight.verdict) {
          try {
            ledger.updateRun(operationId, (record) => {
              record.dbPreflight = preflight.verdict;
              return record;
            });
          } catch {}
        }
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
        // Dev has the highest same-version drift risk (E-C1): probe the just-
        // built binary against the current state DBs, same hard-block rules.
        const devPreflight = await runDatabasePreflight({
          version: sha || "dev",
          emit,
          binOverride: bin,
        });
        if (!devPreflight.ok) return finish(409, devPreflight.error);
      }

      // Record + restart. Activation happens ONLY at boot.
      emit("record", "running");
      channelStore.updateState((s) => {
        // operationId ties the acceptance notification to this run (WI-3.4).
        s.applied =
          channel === "dev"
            ? { channel: "dev", sha, at: nowFn(), acceptedAt: null, operationId }
            : version === s.pinVersion
              ? null
              : { channel, version, at: nowFn(), acceptedAt: null, operationId };
        // An explicit successful apply is the operator's way out of the #21
        // recovery latches — reset them for the fresh attempt.
        s.rollbackRefused = null;
        s.forwardRecovery = null;
        s.noBootableVersion = null;
        return s;
      });
      firstHealthyAt = null;
      clearVersionCache();
      emit("record", "completed");
      emit("restarting", "running");
      logEvent("channel_apply", "completed", { channel, version, sha, operationId });
      queueNotify(
        `🔄 Restarting AlphaClaw to activate OpenClaw ${targetLabel || version || sha}.`,
        { eventType: "info", operationId, id: `apply-restarting-${operationId}`, verbose: true },
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
    // Tolerant UpdateRunResult parsing: upstream owns this contract. The tail
    // is a build log with the report at its END, and the log itself carries
    // brace/bracket noise that parses as JSON (tool output, arrays); without a
    // shape predicate the FIRST such value won and `status` read as unknown on
    // every real dev build (live-verified 2026-09-02), so the scan keeps going
    // until it finds the object that actually carries a string `status`.
    const parsed =
      parseJsonValueFromNoisyOutput(result.tail || "", {
        validate: (candidate) =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          typeof candidate.status === "string",
      }) || {};
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

  // "Run repair" (2.3): `openclaw update repair` mutates config/install records/
  // plugins, which collides with AlphaClaw's overlay ownership for package channels
  // (E-C7). It is therefore restricted to DEV-CHECKOUT recovery; stable/beta
  // failures re-stage the version through the normal apply pipeline instead. Runs
  // under the apply latch so it can never race a version swap.
  const runUpdateRepair = async ({ operationId = null } = {}) => {
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
    const info = getChannelInfo();
    const isDev =
      info.releaseChannel === "dev" || info.applied?.channel === "dev";
    if (!isDev) {
      return {
        status: 409,
        body: channelError(
          "repair_not_applicable",
          "Repair only applies to dev builds from source.",
          "For stable or beta, re-apply the version from the catalog instead — AlphaClaw owns those installs and re-staging replaces the whole tree.",
        ),
      };
    }
    applyInProgress = true;
    // Repairs are update runs too: they get a durable ledger record and a
    // redacting log sink so the timeline and post-restart views include them.
    if (!operationId) operationId = crypto.randomUUID();
    // Declared before the try so the catch/finally can clean up even when the
    // sink/recorder SETUP throws — otherwise the latch stays stuck (10).
    let sink = null;
    let steps = [];
    const completeRepairRun = ({ ok, result }) => {
      try {
        ledger.completeRun(operationId, {
          state: ok ? "activated" : "failed",
          ok,
          result,
        });
      } catch {}
    };
    try {
      try {
        ledger.createRun({
          operationId,
          target: { channel: "dev", repair: true },
        });
      } catch (error) {
        log(`run ledger unavailable: ${error.message}`);
      }
      sink = ledger.createLogSink({
        operationId,
        extraSecretEnv: devUpdateEnv(),
      });
      activeSink = sink;
      sink.writeLine(`[openclaw-update] repair ${operationId} started`);
      const recorder = stepRecorder(operationId, sink);
      steps = recorder.steps;
      const emit = recorder.emit;
      const output = makeOutputPublisher(operationId);
      emit("repair", "running", { detail: "openclaw update repair" });
      const result = await runner.runStreamed({
        command: "openclaw",
        args: ["update", "repair"],
        env: devUpdateEnv(),
        timeoutMs: kOpenclawApplyTimeoutMs,
        logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"),
        onOutput: output,
        tailBytes: 512 * 1024,
      });
      output.flush();
      if (!result.ok) {
        // Beta refuses repair under OPENCLAW_SUPERVISOR_MODE=external (it is an
        // updater surface) — show the refusal verbatim, never strip the var.
        emit("repair", "failed", { tail: result.tail?.slice(-2000) });
        const body = channelError(
          "repair_failed",
          "OpenClaw repair did not complete.",
          result.tail
            ? `OpenClaw said: ${result.tail.slice(-400)}`
            : "Check the raw log, then retry or re-apply a version from the catalog.",
        );
        if (operationEvents && operationId) {
          // fail(), not complete(): subscribers key success/failure off the
          // SSE event name, and complete() emits "done".
          operationEvents.fail(
            operationId,
            Object.assign(new Error(body.message), {
              code: body.code,
              hint: body.hint,
              docsUrl: body.docsUrl,
            }),
          );
        }
        completeRepairRun({
          ok: false,
          result: { ok: false, code: body.code, message: body.message },
        });
        return { status: 500, body: { ...body, steps } };
      }
      emit("repair", "completed");
      const body = { ok: true, steps };
      if (operationEvents && operationId) {
        operationEvents.complete(operationId, body);
      }
      completeRepairRun({ ok: true, result: { ok: true } });
      return { status: 200, body };
    } catch (error) {
      // An unexpected throw — from the sink/recorder SETUP or from
      // runStreamed rejecting — must still terminate the ledger run and the
      // SSE subscription, or the run hangs in "running" and the Upgrade page
      // waits until next boot. (emit is scoped to the try; go straight to the
      // durable + SSE terminators, which are always in scope here.)
      const body = channelError(
        "repair_failed",
        "OpenClaw repair did not complete.",
        error?.message ? `Details: ${String(error.message).slice(-400)}` : null,
      );
      if (operationEvents && operationId) {
        operationEvents.fail(
          operationId,
          Object.assign(new Error(body.message), { code: body.code }),
        );
      }
      completeRepairRun({
        ok: false,
        result: { ok: false, code: body.code, message: body.message },
      });
      return { status: 500, body: { ...body, steps } };
    } finally {
      activeSink = null;
      if (sink) void sink.close();
      applyInProgress = false;
    }
  };

  return {
    syncAtBoot,
    applyUpdate,
    requestChannelRollback,
    requestForwardRecovery,
    markGoodNow,
    onGatewayHealthy,
    onGatewayUnhealthy,
    getChannelInfo,
    flushBootNotifications,
    runUpdateRepair,
    // Issue #20: fail-closed config/DB reconciliation, run by the server boot
    // sequence before the gateway starts; also the engine behind the
    // operator's "Retry migration" / "Strip blamed keys and retry" actions.
    reconcileBootConfig,
    isApplyInProgress: () => applyInProgress,
    // The single managed-ness authority for the Control-UI stripe — the
    // startup medic consults it before treating the key as removable.
    isStripeManaged: stripeIsAlphaclawManaged,
    // Backup inventory for GET /api/openclaw/backups (WI-4.3). Deliberately
    // NOT folded into getChannelInfo(): that sits on the 2s status path and
    // this does a directory scan + ledger read.
    listBackupInventory,
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
  // Backup policy surface (issue #54): pure helpers the routes and tests
  // share with the driver so the two can never drift.
  isBackupArchiveName,
  formatAge,
  kQuiescedOutcomePolicy,
  kLiveRetryPolicy,
  kReuseEligibleKinds,
  contentionRetryVerdict,
  parseMountInfoFsType,
  selectClassifierTail,
  // Secret-free env (OpenClaw paths kept, credentials stripped) for running
  // external package code — dev builds here, Buzz plugin install (E-C12).
  buildDevUpdateEnv,
};
