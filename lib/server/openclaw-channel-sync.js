const { hasDatabaseRecoveryCoverage, projectRecoverySummary } = require("./openclaw-recovery-coverage");
const { buildRecoveryInventory, inspectRecoveryDatabases } = require("./openclaw-recovery-plan");
const { createRecoveryCheckpoint, readRecoveryCheckpoint, inspectRecoveryCheckpoint } = require("./openclaw-recovery-checkpoint");
const { beginRecoveryOperation, inspectRecoveryAtBootSync } = require("./openclaw-recovery-operation");
const { readDirectoryNamesBounded } = require("./utils/bounded-directory");
const { withIsolatedDevPreparation } = require("./openclaw-dev-preparation");
const { waitForBackupReadiness } = require("./openclaw-backup-readiness");
const crypto = require("crypto");
const { projectBackupSummary } = require("./openclaw-backup-summary");
const { selectMigrationBackupProtection } = require("./openclaw-backup-retention");
const { resolveBackupPath } = require("./openclaw-backup-paths");
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
  kOpenclawBackupQuiesceSuppressSlackMs,
  kOpenclawBackupWorkspaceInlineBytes,
  kBackupTailClassifyLines,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
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
  kOpenclawReconcileLifecycleLeaseMs,
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
  formatServerPidDecision,
  kManagedDirName,
} = require("./openclaw-release-channel");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");
// Backup ladder policy tables + envelope arithmetic (Eng review 2C): the
// driver below reads them from ONE module and re-exports them (see
// module.exports) so existing imports and the pinned policy table keep
// working.
const {
  priorBackupFailure,
  liveBackupAttemptBudget,
  kQuiescedOutcomePolicy,
  kLiveRetryPolicy,
  kReuseEligibleKinds,
  contentionRetryVerdict,
  chooseBackupRung,
  predictTransferMs,
  kDefaultBackupBudget,
  backupBudgetPins,
} = require("./openclaw-backup-ladder");
const { diffConfigKeyPaths } = require("./utils/config-key-diff");
const { pruneFilesMatching } = require("./utils/file-retention");
const { getProcessBootId } = require("./boot-id");
const { createRunLedger } = require("./openclaw-run-ledger");
const { createRunStream } = require("./openclaw-run-stream");
const { installOpenclawVersionToTempDir } = require("./openclaw-version");
const { resolveSelfDependency } = require("./self-dependency");
const { compareVersionParts, isPrereleaseVersion } = require("./helpers");
// ONE channel-boundary predicate for the backup hard gate and the Upgrade
// tab's confirm (#79 Stage 4a) — dependency-free so the UI bundle imports it.
const { crossesChannelBoundary } = require("../channel-boundary");
const {
  controlUiMountSatisfied,
  kControlUiMount,
} = require("./control-ui-mount");
// ONE engines-range evaluator for the apply preflight, the boot floor and the
// Upgrade tab's catalog rows (v0.9.80) — dependency-free for the same reason.
const { satisfiesEngines } = require("../engines-range");
// The one elapsed-time formatter the Upgrade tab renders ("1m 5s"), so the
// backup progress line (#79 (h)) reads like the step timer beside it.
const { formatElapsed } = require("../update-progress-model");
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
const { createOutputLineRing } = require("./output-line-ring");
const { assessApplyIntent } = require("./openclaw-update-intent");
const { resolveThinkingModulePath } = require("./openclaw-thinking");
const {
  kStateContentionPattern,
  listLiveOpenclawProcesses,
  readContainerStartTicks,
  readContainerStartMs,
} = require("./openclaw-lock-contention");
const {
  buildBinPhaseReport,
  createBootReportWriter,
  kPidfileSkipReason,
  kBootReportFileName,
  kBootReportIncidentFileName,
  normalizeVerdict,
} = require("./boot-report");
const { readSelfVersionStamp } = require("./alphaclaw-self-version");
const {
  beginStateDbQuiet,
  isStateDbQuiet,
  getStateDbHandleCount,
} = require("./state-db-quiet");
const { openTrackedReadonlyDatabase } = require("./openclaw-state-db");
const { describeExecutingBuild, readCheckoutBuildId } = require("./openclaw-build");
const { createDevCandidate, resolveDevCheckout, activateDevCandidate, pruneDevCandidates } = require("./openclaw-dev-candidates");
const { prepareDevBuild } = require("./openclaw-dev-build");
const { readSchemaMetadata, metadataDeclaration } = require("./openclaw-schema-metadata");
const { createBackupRiskCoordinator, consentConfigError, fingerprintBuild, fingerprintDatabase } = require("./backup-risk-consent");
const { isConfigUnreadableError } = require("./utils/config-unreadable");
const { createGatewayLifecycleLock } = require("./gateway-lifecycle-lock");
const { createOpenclawUpdateRepair } = require("./openclaw-update-repair");
const { createRepairOperation, kRepairCleanupAllowanceMs, kRepairKillGraceMs } = require("./repair-operation");
const { readDevUpdateFailureEvidence } = require("./openclaw-dev-update-failure");
const { createGatewayMutationPolicy, kGatewayMutationIntents, matchesApplyRecoveryHold } = require("./gateway-mutation-policy");
const {
  readSqliteUserVersion,
  resolveDeclaredSchemaVersions,
  resolveDeclaredSchemaVersionsAsync,
  compareSchema,
  createSchemaVersionTable,
  kLaunchCompatReasons,
  assessLaunchCompatibility,
  chooseBootableVersion,
} = require("./openclaw-schema-versions");
const {
  kOfflineCopyProducer,
  kUpstreamProducer,
  kOfflineCopyArchiveSuffix,
  kOfflineCopyTempDirPrefix,
  producerOfArchiveName,
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

// Engines gate for the apply preflight: the ONE range evaluator shared with
// AlphaClaw's boot floor and the Upgrade tab's catalog rows
// (lib/engines-range.js). Until v0.9.80 this compared MAJOR versions only, so
// `>=24.16.0 <25 || >=26.1.0` (OpenClaw 2026.9.3) let Node 24.14 install a
// build that refuses to start and let Node 25 through although excluded.
// Anything outside upstream's published grammar still passes (warn-only
// posture — npm itself only warns on engines).
const enginesSatisfied = (enginesNode, nodeVersion) =>
  satisfiesEngines(enginesNode, nodeVersion);

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

// The per-kind migration facts of a persisted db-preflight verdict
// (runDatabasePreflight's `byKind`), for the post-preflight backup checkpoint
// (#79 (b)): only the kinds that migrate, each with the schema numbers the
// preflight saw (null when a CLI generation did not report them).
//   { state: { from, to } | null, agent: { from, to } | null }
const describeMigrationByKind = (verdict) => {
  const out = { state: null, agent: null };
  for (const kind of ["state", "agent"]) {
    const tally = verdict?.byKind?.[kind];
    if (!tally || tally.migrationRequired !== true) continue;
    out[kind] = {
      from: tally.foundVersion ?? null,
      to: tally.targetVersion ?? null,
    };
  }
  return out;
};
// Operator-facing parenthetical: "state 12→15, agent 17→19"; a kind whose
// numbers the preflight could not report reads "state schema"; a legacy
// verdict without byKind (pre-#78 record) reads "schema".
const describeMigrationLines = (verdict) => {
  const byKind = describeMigrationByKind(verdict);
  const parts = [];
  for (const kind of ["state", "agent"]) {
    const line = byKind[kind];
    if (!line) continue;
    parts.push(
      line.from != null && line.to != null
        ? `${kind} ${line.from}→${line.to}`
        : `${kind} schema`,
    );
  }
  return parts.length > 0 ? parts.join(", ") : "schema";
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
// The 2026.9.x CLI's publish-staging dot-dir prefix (mkdtemp'd in the
// output's parent, see measureCliProgressBytes / cleanupFailedBackup /
// sweepBackupDebris).
const kCliPublishStagingPrefix = ".openclaw-backup-publish-";

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

// #79 (h): the progress line a running backup rung emits once per tick — the
// backup log, the apply's SSE output pane and the live step row carry this
// text verbatim (the client never re-words it). Pure. `doneBytes` /
// `totalBytes` are what the rung itself exposed so far (the CLI's staging
// file size; the offline copy's onProgress feed) — null means "not measurable
// yet", never 0; `stage` is the copy's current step.
const formatBackupBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
};
const describeBackupProgress = ({
  rung,
  quiesced = false,
  elapsedMs = 0,
  doneBytes = null,
  totalBytes = null,
  stage = null,
  // v0.9.81 (D19): the upstream rung passes its output ring's newest line
  // (null = the CLI has printed nothing yet). Omitted (undefined) by the
  // offline copy, which has no CLI — the segment is then left out entirely.
  lastOutput,
} = {}) => {
  const label = rung === "migration_minimal" ? "Migration backup" : rung === "offline_copy" ? "AlphaClaw offline copy" : "upstream backup create";
  const where = quiesced ? " (gateway paused)" : "";
  let bytes;
  if (Number.isFinite(doneBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
    const pct = Math.max(0, Math.min(100, Math.floor((doneBytes / totalBytes) * 100)));
    bytes = `${formatBackupBytes(doneBytes)} of ${formatBackupBytes(totalBytes)} (${pct}%)`;
  } else if (Number.isFinite(doneBytes)) {
    bytes = `${formatBackupBytes(doneBytes)} written so far`;
  } else {
    bytes = rung !== "upstream" ? "sizing the copy set" : "nothing written yet";
  }
  const step = stage ? `, ${String(stage).replace(/_/g, " ")}` : "";
  let output = "";
  if (lastOutput !== undefined) {
    output = lastOutput ? ` — last output: ${lastOutput}` : " — no output yet";
  }
  // formatElapsed takes a start stamp and a now; any positive base works, and
  // it keeps this line's "1m 5s" identical to the step timer's.
  const elapsed = formatElapsed(1, 1 + Math.max(0, Number(elapsedMs) || 0));
  return `${label} in progress${where}: ${bytes}${step}${output} — ${elapsed} elapsed`;
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

// ── Config-gate intent (issue #76 RC3) ──────────────────────────────────
//
// `configMigration.completedForVersion` sitting ABOVE the installed version
// has two very different causes: the operator CHOSE an older build (apply,
// rollback, pin bump — restore that build's pre-fix settings snapshot) or the
// installed tree silently stopped being the recorded build (a boot sync that
// skipped behind a stale pidfile, npm reconciling node_modules, an image
// reset — DRIFT, where touching the settings migrates them for a build nobody
// picked). The table below is the ONE list of evidence that counts as intent,
// in precedence order; the first row whose test passes names the source.
// Deliberately absent: `applied.reason === "pin_rollback"` — by construction
// that reason exists only while applied.version ≠ pinVersion, i.e. exactly
// on drift.
const kTransitionIntentMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const kRecentUpdateRunIntentMaxAgeMs = 24 * 60 * 60 * 1000;
const kVersionRegressionIntentRows = Object.freeze([
  {
    // Primary: the stamp applyUpdate, rollback-marker consumption and a pin
    // bump write. Honoured only when the transition LANDED (`ok`), has not
    // already authorized a restore (`consumedAt`, Codex D10) and is at most
    // 7 days old (CEO 4.2 — defence in depth; the stamp is overwritten on
    // every transition anyway).
    source: "lastTransition",
    test: ({ state, installedVersion, now }) => {
      const t = state?.lastTransition;
      return Boolean(
        t &&
          t.ok === true &&
          t.consumedAt == null &&
          t.to === installedVersion &&
          t.kind === "downgrade" &&
          Number.isFinite(t.at) &&
          now - t.at <= kTransitionIntentMaxAgeMs,
      );
    },
  },
  {
    // Pre-stamp fallbacks (state written by an older AlphaClaw). The apply
    // whose activation restart this boot IS targets this version …
    source: "pendingRun",
    test: ({ pendingRun, installedVersion }) =>
      Boolean(
        installedVersion && pendingRun?.target?.version === installedVersion,
      ),
  },
  {
    // … THIS boot rolled back onto it (boot-scoped: lastBoot must have been
    // written since the process started, else it is a stale record from an
    // earlier boot) …
    source: "bootRollback",
    test: ({ state, installedVersion, bootStartedAt }) => {
      const boot = state?.lastBoot;
      return Boolean(
        boot &&
          boot.action === "rollback" &&
          boot.rollbackTargetVersion === installedVersion &&
          Number.isFinite(boot.at) &&
          Number.isFinite(bootStartedAt) &&
          boot.at >= bootStartedAt,
      );
    },
  },
  {
    // … or an update run that finished within the last 24 h targeted it (a
    // failed run authorizes nothing).
    source: "recentUpdateRun",
    test: ({ state, installedVersion, now }) => {
      const run = state?.lastUpdateRun;
      return Boolean(
        run &&
          installedVersion &&
          run.target?.version === installedVersion &&
          run.ok !== false &&
          Number.isFinite(run.finishedAt) &&
          now - run.finishedAt <= kRecentUpdateRunIntentMaxAgeMs,
      );
    },
  },
]);

// → { intentional, source, evaluated: [{ source, matched }] }. Pure: reads
// only the values passed in. Every row is evaluated (the boot log names what
// was checked); the FIRST match is the source.
const describeVersionRegressionIntent = ({
  state = null,
  installedVersion = null,
  pendingRun = null,
  bootStartedAt = null,
  now = Date.now(),
} = {}) => {
  const evaluated = [];
  let source = null;
  for (const row of kVersionRegressionIntentRows) {
    let matched = false;
    try {
      matched =
        row.test({ state, installedVersion, pendingRun, bootStartedAt, now }) ===
        true;
    } catch {
      matched = false;
    }
    evaluated.push({ source: row.source, matched });
    if (matched && source === null) source = row.source;
  }
  return { intentional: source !== null, source, evaluated };
};

// A boot that finds the pin NOT installed while `applied` is null is either
// external drift or the operator's own return-to-pin apply landing (applyUpdate
// records `applied = null` for a pin target and leaves its in-flight
// transition stamp: to = the pin, ok = null, source = operator_apply). The
// stamp within its intent window is the evidence that tells the two apart;
// without it the boot rightly treats the mismatch as drift.
const isRecordedReturnToPin = ({ state, installedVersion, now = Date.now() }) => {
  const t = state?.lastTransition;
  return Boolean(
    t &&
      typeof state?.pinVersion === "string" &&
      t.to === state.pinVersion &&
      t.to !== installedVersion &&
      t.source === "operator_apply" &&
      t.ok == null &&
      t.consumedAt == null &&
      Number.isFinite(t.at) &&
      now - t.at <= kTransitionIntentMaxAgeMs,
  );
};

// Direction of a transition for the intent stamp: dev builds have no order
// ("dev"); an unknown side is null.
const transitionKind = ({ from, to, channel = null }) => {
  if (channel === "dev") return "dev";
  if (typeof from !== "string" || !from || typeof to !== "string" || !to) {
    return null;
  }
  try {
    const cmp = compareVersionParts(to, from);
    return cmp < 0 ? "downgrade" : cmp > 0 ? "upgrade" : "same";
  } catch {
    return null;
  }
};

// ── Installed-vs-recorded divergence (issue #76 RC4/A4) ─────────────────
// The build the state file says should be running: the applied package
// version, else the declared pin; null for a dev apply (its installedVersion
// is the dormant fallback, not what runs).
const expectedVersionOf = (state) => {
  const applied = state?.applied || null;
  if (applied?.channel === "dev") return null;
  return applied?.version || state?.pinVersion || null;
};

// Pin lag (issue #76 RC4, Codex D12): the pin_reconciled boot that finds the
// installed tree still on the OLD pin records
// `state.pinLag = { pin, installed, at, bootId, bootsSeen }` — an AlphaClaw
// self-update's expected npm lag, not drift. The excuse is bounded: it dies
// after kPinLagMaxBoots boots or kPinLagMaxAgeMs, whichever comes first
// (syncAtBoot counts the boots — see advancePinLag), and it is cleared the
// moment the installed tree IS the pin.
const kPinLagMaxBoots = 3;
const kPinLagMaxAgeMs = 24 * 60 * 60 * 1000;
const pinLagExpired = (pinLag, now) => {
  if (!pinLag || typeof pinLag !== "object") return true;
  if (Number.isFinite(pinLag.bootsSeen) && pinLag.bootsSeen > kPinLagMaxBoots) {
    return true;
  }
  if (
    Number.isFinite(pinLag.at) &&
    Number.isFinite(now) &&
    now - pinLag.at > kPinLagMaxAgeMs
  ) {
    return true;
  }
  return false;
};
// A live lag excuses exactly one (pin, installed) pair: the tree it named,
// lagging the pin it named. It never excuses an applied build's divergence
// (expected !== the lagging pin) — that is the #76 shape, not npm lag.
const pinLagExcuses = (pinLag, { expected, installedVersion, now }) =>
  !pinLagExpired(pinLag, now) &&
  pinLag.installed === installedVersion &&
  pinLag.pin === expected;
// One boot's worth of pin-lag bookkeeping (pure): null once the installed
// tree reached the pin or the pin moved on, otherwise this boot counts
// (unless it is the boot that recorded the lag) and an expired record is
// dropped so `installedDiverged` starts telling the truth again.
const advancePinLag = (
  pinLag,
  { pinVersion, installedVersion, now, recordedThisBoot = false },
) => {
  if (!pinLag || typeof pinLag !== "object") return null;
  if (pinLag.pin !== pinVersion) return null;
  if (installedVersion && installedVersion === pinLag.pin) return null;
  const next = recordedThisBoot
    ? pinLag
    : {
        ...pinLag,
        bootsSeen:
          (Number.isFinite(pinLag.bootsSeen) ? pinLag.bootsSeen : 1) + 1,
      };
  return pinLagExpired(next, now) ? null : next;
};

// True when the live tree is a build the state file did not choose. Values
// only (no fs, no spawn): getChannelInfo owns the derived `installedDiverged`
// on its 2 s status tick and every gate (boot reconciler first guard,
// rollback/forward-recovery requests) consumes THAT field — reuse this
// predicate, do not re-derive it. A live `state.pinLag` for exactly this
// (pin, installed) pair excludes the expected lag of an AlphaClaw self-update
// from "diverged"; `now` drives its age expiry.
const computeInstalledDiverged = (
  state,
  installedVersion,
  { now = Date.now() } = {},
) => {
  const expected = expectedVersionOf(state);
  if (!expected || typeof installedVersion !== "string" || !installedVersion) {
    return false;
  }
  if (installedVersion === expected) return false;
  if (pinLagExcuses(state?.pinLag, { expected, installedVersion, now })) {
    return false;
  }
  return true;
};

// ── ONE hold model (issue #76, Codex 6) ─────────────────────────────────
// gatewayHold.reason is free text for the migration-class holds the boot
// reconciler owns (doctor failed, snapshot failed, gateway running, machinery
// error, agent DB incompatible) and a class token for STRUCTURAL holds set by
// the version gates. Only migration-class holds may re-arm the migration
// machinery (re-attempt gate, doctor); a structural hold returns `held`
// before any snapshot or doctor.
const kStructuralHoldReasons = new Set([
  "version_mismatch",
  "state_db_unreadable",
  "state_db_unverified",
  "activation_failed",
]);
const isMigrationClassHold = (hold) =>
  Boolean(
    hold &&
      typeof hold === "object" &&
      typeof hold.reason === "string" &&
      hold.reason &&
      !kStructuralHoldReasons.has(hold.reason),
  );

// Runtime installed-tree reconcile (issue #76 B1.2). The kill switch is
// deployment-only (deployment-only-env.js): `off` disables the runtime path
// (route, Upgrade-tab action, structural repair) — boot activation is
// unaffected. Disk headroom is 1.2 × the overlay's bytes (CEO 2.2): the
// staged copy coexists with the live tree until the rename.
const kRuntimeReconcileEnvKey = "OPENCLAW_RUNTIME_RECONCILE";
const kReconcileDiskHeadroom = 1.2;
// Boot launch-compatibility gate (issue #76 C1 belt / C2), deployment-only:
// `off` skips the gate (the boot launches whatever tree is on disk, as before
// 0.9.77); the bin-phase activation and the config gate are unaffected.
const kLaunchCompatGateEnvKey = "OPENCLAW_LAUNCH_COMPAT_GATE";
// Blocking gate token → hold class (Codex 5/6). First match wins, so a
// corrupt DB is named before a schema finding. `legacy_exec_approvals` is the
// class the plan names for the exec-approvals finding; NOTE it is not in
// kStructuralHoldReasons yet (both copies — store + this module — must gain it
// before any caller sets it), and the BOOT gate never does: see
// assessLaunchCompatibilityAtBoot.
const kLaunchCompatHoldReasons = Object.freeze([
  [kLaunchCompatReasons.stateDbUnreadable, "state_db_unreadable"],
  [kLaunchCompatReasons.legacyExecApprovalsPresent, "legacy_exec_approvals"],
  [kLaunchCompatReasons.stateSchemaTooNew, "version_mismatch"],
  [kLaunchCompatReasons.agentSchemaTooNew, "version_mismatch"],
  [kLaunchCompatReasons.stateDbPreflightBlocked, "version_mismatch"],
]);
const compatHoldReasonFor = (reasons) => {
  const set = new Set(Array.isArray(reasons) ? reasons : []);
  const hit = kLaunchCompatHoldReasons.find(([token]) => set.has(token));
  return hit ? hit[1] : null;
};
// Watchdog expected-restart window armed around the stop + swap so the
// gateway exit is never crash-counted; the caller's relaunch re-arms its own.
const kReconcileSuppressMs = 10 * 60 * 1000;
// exec-approvals.json is existence-fatal from the sqlite-era line (#23).
const kExecApprovalsSqliteMinCoreVersion = "2026.9.1";
const kExecApprovalsFileName = "exec-approvals.json";

const createOpenclawChannelSync = ({
  getActiveGatewayOperation = null,
  // Injected by lib/server.js: re-applies AlphaClaw's gateway proxy config
  // (incl. the Control UI mount key, control-ui-mount.js) after a whole-file
  // config restore, which runs AFTER the boot's own call and right before the
  // gateway launches. The bin boot-sync instance omits it (startup.js re-runs
  // ensureGatewayProxyConfig anyway).
  ensureGatewayProxyConfig = null,
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
  // Runtime installed-tree reconcile seams (issue #76 B1.2), injected by
  // lib/server.js only:
  //   acquireLifecycleLock(kind, options) → Promise<release> — the shared
  //     gateway lifecycle lock; reconcileInstalled acquires its own
  //     "reconcile_installed" hold ONLY when the caller passed none.
  //   discoverServingIdentity() → identity | null — gateway.js's
  //     resolveServingIdentity: a serving pid tree AlphaClaw did not spawn
  //     refuses the tree swap (incumbent_running).
  //   diskSpace(requiredBytes, dir) → { ok, free } — test seam for the
  //     statfs probe (the ENOSPC path).
  acquireLifecycleLock = null,
  tryAcquireLifecycleLock = null,
  gatewayMutationPolicy = null,
  discoverServingIdentity = null,
  diskSpace = null,
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
  // Test seam (#79 (g)): the advisory retention budget pruneBackups warns
  // against (bytes, or null = no budget). The default reads autotune's
  // disk-derived backupMaxTotalGb through its never-throw getter.
  readBackupBudgetBytes = null,
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
  // Bin-phase boot report (issue #76 A1): a createBootReportWriter() whose
  // writeBinPhase receives ONE report per syncAtBoot, on every return path.
  // null (the default, and every server-side instance) writes nothing;
  // runOpenclawChannelBootSync constructs the production writer.
  bootReport = null,
  // stampSelfVersionAtBoot()'s { changed, previousVersion, record } when the
  // bin already stamped this boot; null → the report reads the stamp file.
  selfVersion = null,
} = {}) => {
  const channelStore =
    store ||
    createOpenclawReleaseChannelStore({ fsModule, rootDir, openclawDir, nowFn, logger });
  const baseRunner = runStream || createRunStream({ fsModule });
  const ledger =
    runLedger || createRunLedger({ fsModule, openclawDir, nowFn, logger });
  // Learned schema table (#78): which {state, agent} schema each OpenClaw
  // version supports — declared constants recorded at apply time over the
  // seeded tarball facts. Lives beside the channel state in the store's
  // managed dir; the path is derived FROM the store (its pidfile's directory),
  // never recomputed from openclawDir.
  const schemaTable = createSchemaVersionTable({
    fsModule,
    managedDir:
      channelStore.managedDir || path.dirname(channelStore.serverPidPath),
    nowFn,
    logger,
  });
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
  const localApplyLock = createGatewayLifecycleLock({ logger });
  const applyCommitPolicy = gatewayMutationPolicy || createGatewayMutationPolicy({
    lock: localApplyLock, getChannelInfo: () => getChannelInfo(), isApplyInProgress: () => applyInProgress,
  });
  let pendingRollbackRestart = false;
  let firstHealthyAt = null;
  // Once-per-boot arm for the pin last-known-good promotion (issue #21 bug 5).
  let pinLkgPromotionArmed = true;
  const pendingNotifications = [];
  // Boot heavy-ops budget (issue #21): the clock starts near the top of
  // syncAtBoot and only the rollback-preflight prober
  // (createBootPreflightProber) draws from it, so the probes never outlive
  // the boot placeholder's 15-minute no-progress /health flip. The doctor
  // migration does NOT draw from this clock — it is sized separately by
  // sizedMigrationBudgetMs (10 min + 5 min/GB, capped at 30 min unless
  // OPENCLAW_DOCTOR_MIGRATION_TIMEOUT raises it; v0.9.45), and it logs one
  // ledger step when it starts, which re-arms the placeholder's window once
  // (60-minute absolute cap). Real wall clock on purpose — nowFn is a
  // logical clock in tests and may never advance.
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
    } catch {
      throw Object.assign(new Error("Candidate probe isolation could not be created"), { code: "candidate_probe_isolation_failed" });
    }
    return env;
  };
  const devUpdateEnv = () => buildDevUpdateEnv(openclawSpawnEnv());
  // The budget table: the shared defaults (kDefaultBackupBudget maps the
  // constants to these field names — the envelope relations in
  // backupBudgetPins are written over the same keys) under any tuning
  // override the caller injects.
  const backupBudget = {
    ...kDefaultBackupBudget,
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

  // The apply OUTCOME notification names a consented no-backup apply (#79
  // (b)): the run record is the durable memory of `confirmNoBackup`, and the
  // acceptance message is the one line the operator is guaranteed to see.
  const describeNoBackupConsentOutcome = (operationId) => {
    try {
      const record = operationId ? ledger.readRun(operationId) : null;
      if (record?.recovery?.kind !== "forward_only" && record?.backup?.noBackupConfirmed !== true) return "";
      return record.dbPreflight?.migrationRequired === true
        ? " It was applied WITHOUT a backup by operator consent (confirmNoBackup) — the database was migrated and there is no rollback path to the previous build."
        : " It was applied WITHOUT a backup by operator consent (confirmNoBackup) — the failed backup left no verified archive for restoring the pre-update state.";
    } catch {
      return "";
    }
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
    // Issue #76 RC4: the build the state file CHOSE vs the build actually on
    // disk. `isPin` (= no apply recorded) is not "the pin is running" — a
    // recorded apply that never activated (a stale-pidfile skip, npm lag)
    // leaves the pin's tree live with `applied` set, and the RC4 ladder
    // blocklisted/refused by the record instead of the running tree.
    const isDevApplied = applied?.channel === "dev";
    const expectedVersion = expectedVersionOf(state);
    return {
      releaseChannel: safeReadChannel(),
      installedVersion,
      // The runtime this AlphaClaw runs on — the Upgrade tab judges every
      // catalog row's `engines.node` against it with the same evaluator the
      // apply preflight uses (v0.9.80), so a row it cannot install says so
      // before the click instead of after the download.
      nodeVersion: process.versions.node,
      pinVersion: state.pinVersion,
      previousPin: state.previousPin || null,
      pinWindow: state.pinWindow || null,
      applied,
      appliedId: appliedId(applied),
      appliedVersion: applied?.version || null,
      isPin,
      // The version that should be running: the applied package version,
      // else the pin; null for a dev apply (expectedKind "dev" — its
      // installedVersion is the dormant fallback, not what runs).
      expectedVersion,
      expectedKind: isDevApplied
        ? "dev"
        : !expectedVersion
          ? null
          : applied
            ? "applied"
            : "pin",
      // The pin's tree IS what runs — the forward-recovery gate (watchdog
      // tryForwardRecovery, requestForwardRecovery agree with this).
      installedIsPin: Boolean(
        installedVersion &&
          state.pinVersion &&
          installedVersion === state.pinVersion &&
          !isDevApplied,
      ),
      // The live tree is neither the recorded build nor a live pin lag: the
      // boot reconciler holds before any doctor, rollback refuses to
      // blocklist a build that was not running. Values only (hot path).
      installedDiverged: computeInstalledDiverged(state, installedVersion, {
        now,
      }),
      // The recorded self-update lag (pin_reconciled boot; see advancePinLag)
      // that keeps installedDiverged quiet while npm catches up.
      pinLag: state.pinLag || null,
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
      // Read-time flag from channelStore.readState(): the state file could not
      // be parsed, so `gatewayHold: null` above is NOT evidence of "no hold".
      // Hold gates treat this as held (fail closed).
      stateCorrupted: Boolean(state.corrupted),
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
        fsModule.readFileSync(path.join(executingBuild()?.packageDir || checkoutDir, "package.json"), "utf8"),
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

  const selectedDevCheckout = (recordedCheckoutDir = channelStore.readState().applied?.checkoutDir) =>
    resolveDevCheckout({ checkoutDir, recordedCheckoutDir, fsModule });
  const readCheckoutHead = (directory = selectedDevCheckout()) => readCheckoutBuildId(directory, { fsModule });
  const executingBuild = () => describeExecutingBuild({
    installDir: safeInstallDir(), checkoutDir, store: channelStore, fsModule,
  });

  const checkoutBuildReady = (directory = selectedDevCheckout()) => {
    const bin = channelStore.resolvePackageBin(directory);
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
      const entries = readDirectoryNamesBounded(openclawDir, { fsModule })
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

  // Intent stamp (issue #76 RC3): who last changed the EXPECTED build and
  // whether it landed. Written by applyUpdate (operator_apply, `ok` null
  // until finish() settles it), rollback-marker consumption (rollback) and a
  // declared-pin bump (pin_bump); read by describeVersionRegressionIntent.
  // Mutates the state object inside an updateState callback.
  const stampLastTransition = (
    s,
    { from = null, to, source, reason = null, operationId = null, ok = null, channel = null },
  ) => {
    if (typeof to !== "string" || !to) return null;
    s.lastTransition = {
      at: nowFn(),
      from: typeof from === "string" && from ? from : null,
      to,
      kind: transitionKind({ from, to, channel }),
      source,
      reason,
      operationId,
      ok,
      consumedAt: null,
    };
    return s.lastTransition;
  };

  // ── Whole-file settings restores (issue #76 A5) ───────────────────────
  // Every path that copies a backup over openclaw.json (round-trip restore,
  // crash-rollback restore, migration hard-gate revert) goes through this
  // ONE primitive, so each leaves the same evidence: a byte-exact pre-restore
  // copy beside the config (newest kPreRestoreBackupKeep kept), a key-paths-
  // only diff under <managedDir>/config-gate/ (newest kConfigGateDiffKeep;
  // paths and counts, never values — the doctor-guard precedent) and
  // configMigration.lastRestore naming both plus the boot that did it. The
  // live read and both writes run under the config lock updateOpenclawConfig
  // uses and go through writeFileAtomic as BYTE copies — never re-serialized,
  // so a JSON5/$include config survives the round trip (Codex D13).
  const kPreRestoreBackupPattern = /^openclaw\.json\.pre-restore-\d+\.bak$/;
  const kPreRestoreBackupKeep = 3;
  const kConfigGateDiffDirName = "config-gate";
  const kConfigGateDiffPattern = /^\d+\.json$/;
  const kConfigGateDiffKeep = 10;
  // The store owns <openclawDir>/.alphaclaw; test doubles that wrap the store
  // without re-exporting managedDir fall back to its exported name.
  const managedDirPath = () =>
    channelStore.managedDir || path.join(openclawDir, kManagedDirName);
  const parseJsonOrNull = (raw) => {
    if (raw == null) return null;
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  };
  const restoreConfigFromBackup = ({
    configPath,
    backupPath,
    installedVersion,
    previousCompletedForVersion = null,
    source,
    // Caller's warnings[] (boot report / notification surface); the mount
    // repair pushes its failure there so it is never silent.
    warnings = null,
  }) => {
    const at = nowFn();
    let liveRaw = null;
    let backupRaw = null;
    let preRestorePath = null;
    withFileLockSync(
      configPath,
      () => {
        try {
          liveRaw = fsModule.readFileSync(configPath);
        } catch {
          liveRaw = null;
        }
        backupRaw = fsModule.readFileSync(backupPath);
        if (liveRaw != null) {
          const target = path.join(
            openclawDir,
            `openclaw.json.pre-restore-${at}.bak`,
          );
          writeFileAtomic(target, liveRaw, { fsModule });
          preRestorePath = target;
          pruneFilesMatching({
            fsModule,
            dir: openclawDir,
            pattern: kPreRestoreBackupPattern,
            keep: kPreRestoreBackupKeep,
          });
        }
        writeFileAtomic(configPath, backupRaw, { fsModule });
      },
      { fsModule, timeoutMs: 1000 },
    );
    // Direction: live → restored. `added` = paths the restore brings back,
    // `removed` = paths the restore drops, `changed` = leaves that differ. A
    // config AlphaClaw cannot parse (JSON5/$include) gets no diff — the copy
    // itself is still byte-exact.
    const live = parseJsonOrNull(liveRaw);
    const restored = parseJsonOrNull(backupRaw);
    const diffAvailable = live !== null && restored !== null;
    const diff = diffAvailable
      ? diffConfigKeyPaths(live, restored)
      : { added: [], removed: [], changed: [] };
    const counts = {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
    };
    const from = path.basename(backupPath);
    const preRestore = preRestorePath ? path.basename(preRestorePath) : null;
    let diffPath = null;
    try {
      const diffDir = path.join(managedDirPath(), kConfigGateDiffDirName);
      const target = path.join(diffDir, `${at}.json`);
      writeFileAtomic(
        target,
        `${JSON.stringify(
          {
            at,
            source,
            installedVersion,
            from,
            previousCompletedForVersion,
            preRestore,
            direction: "live → restored",
            diffAvailable,
            counts,
            ...diff,
          },
          null,
          2,
        )}\n`,
        { fsModule },
      );
      diffPath = target;
      pruneFilesMatching({
        fsModule,
        dir: diffDir,
        pattern: kConfigGateDiffPattern,
        keep: kConfigGateDiffKeep,
      });
    } catch (error) {
      log(`config-gate: key-path diff not persisted (${error.message})`);
    }
    const lastRestore = {
      at,
      from,
      previousCompletedForVersion,
      diffPath,
      preRestorePath,
      bootId: getProcessBootId(),
      source,
    };
    try {
      channelStore.updateState((s) => {
        const prev =
          s.configMigration && typeof s.configMigration === "object"
            ? s.configMigration
            : {};
        s.configMigration = {
          completedForVersion: prev.completedForVersion ?? null,
          completedForBuild: prev.completedForBuild ?? null,
          lastAttempt: prev.lastAttempt ?? null,
          lastRestore,
        };
        return s;
      });
    } catch (error) {
      log(`config-gate: lastRestore not recorded (${error.message})`);
    }
    const summary = `+${counts.added} −${counts.removed} ~${counts.changed} key path(s)`;
    log(
      `config-gate: restored ${from} over openclaw.json for ${installedVersion} (${source}; pre-restore copy ${preRestore || "none — no live config"}; ${diffAvailable ? `restore changes ${summary}` : "diff unavailable (config is not plain JSON)"}${diffPath ? ` → ${diffPath}` : ""})`,
    );
    logEvent("config_migration_gate", `${source}_restore`, {
      installedVersion,
      from,
      previousCompletedForVersion,
      source,
      counts,
      diffAvailable,
      diffPath,
      preRestore,
    });
    // Restore repair (v0.9.83, control-ui-mount.js): the restored file may
    // predate AlphaClaw's Control UI mount key (gateway.controlUi.basePath),
    // and this runs AFTER the boot's ensureGatewayProxyConfig, right before
    // the gateway launches. Re-apply, then VERIFY by re-reading the file —
    // the hook returns false for both "already correct" and "failed".
    let mountRepair = null;
    if (typeof ensureGatewayProxyConfig === "function") {
      let hookError = null;
      try {
        ensureGatewayProxyConfig(undefined);
      } catch (error) {
        hookError = error;
      }
      // STRICT read: the lenient reader's `fallback: {}` would make an
      // unreadable or unparseable file look "satisfied" in legacy mode (no key
      // is exactly what legacy wants) and mask the failure this check exists
      // to surface. Read + parse ourselves; any throw is "not satisfied".
      let satisfied = false;
      try {
        const parsed = JSON.parse(fsModule.readFileSync(configPath, "utf8"));
        satisfied =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          controlUiMountSatisfied(parsed, kControlUiMount);
      } catch {
        satisfied = false;
      }
      mountRepair = {
        satisfied,
        mount: kControlUiMount,
        error: hookError ? String(hookError.message || hookError) : null,
      };
      if (satisfied) {
        log(
          `config-gate: re-applied the gateway proxy config after the ${source} restore (control_ui_mount=${kControlUiMount})`,
        );
      } else {
        // Fixed, greppable code; the dashboard symptom is named so an
        // operator can connect the two.
        log(
          `config-gate: control_ui_mount_repair_failed source=${source} mount=${kControlUiMount}${hookError ? ` (${hookError.message})` : ""} — the Control UI may show "Styles failed to load" until the next AlphaClaw boot`,
        );
        if (Array.isArray(warnings)) {
          warnings.push(
            `control UI mount repair failed after the ${source} config restore — the dashboard may show "Styles failed to load" until the next AlphaClaw boot`,
          );
        }
      }
    }
    return {
      preRestorePath,
      diffPath,
      counts,
      diff,
      diffAvailable,
      live,
      restored,
      lastRestore,
      mountRepair,
    };
  };

  // ── Boot config reconciler (issue #20) ────────────────────────────────
  //
  //   reconcileBootConfig()                (server boot sequence, boot lock
  //     │                                   held, BEFORE startGateway)
  //     │ recover stranded last-good quarantines (crash-safe guard)
  //     ▼
  //   installed tree ≠ recorded build with a complete overlay? (#76 RC3)
  //     ────────────────────────────────► HOLD version_mismatch — no snapshot,
  //     │                                 no strips, no doctor from a build
  //     │                                 nobody chose (Stage 3 reconciles it)
  //   structural hold persisted (state_db_unreadable, activation_failed)?
  //     ────────────────────────────────► HOLD stays (not a migration failure)
  //   no config? ─────────────────────────► done (fresh install)
  //   completedForVersion ABOVE installed + that version's pre-fix .bak?
  //     │ intent recorded (lastTransition / pending run / this boot's
  //     │ rollback / update run ≤ 24 h)? ► RESTORE it (pre-restore copy +
  //     │                                 key-path diff + lastRestore; LOUD)
  //     └ no intent ───────────────────► DRIFT: settings untouched, .bak kept,
  //                                       warning + event + notification,
  //                                       skipped (or held if a hold exists)
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
  //     │ an AGENT DB at a NEWER agent schema than this build declares
  //     │ (#78)? → HOLD (no doctor from a binary that cannot read the DB)
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
  const validateConfigWithBin = async (bin, { operation, assertCurrent }) => {
    const result = await operation.runWriter(() => {
      assertCurrent();
      return runner.runStreamed({
      command: process.execPath,
      args: [bin, "config", "validate"],
      env: openclawSpawnEnv(),
      timeoutMs: kOpenclawBootPreflightTimeoutMs,
      signal: operation.signal, deadlineAt: operation.deadlineAt,
      onProcess: operation.noteProcess, killGraceMs: kRepairKillGraceMs,
      });
    });
    assertCurrent();
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
  // the live DBs is race-free). Ledger hints are hints, never authority.
  // Returns { migrationNeeded: true | false | null (inconclusive),
  //           incompatible: null | { label, agentId, foundVersion, targetVersion } }.
  // STATE DBs go through the installed CLI's `database preflight` (a
  // state-schema verb, unchanged). AGENT DBs are judged here against the
  // INSTALLED tree's supported agent schema — declared from its own dist,
  // else the schema table (issue #78). `incompatible` is the caller's hard
  // gate: a plain null would be coerced to "run doctor --fix" from the very
  // binary that cannot read the database.
  const probeDbMigrationNeeded = async (bin, { installDir = null, installedVersion = null, build = null } = {}) => {
    try {
      const verdict = await inspectRecoveryTarget(build?.packageDir || path.join(installDir, "node_modules", "openclaw"),
      installedVersion, await recoveryInventory());
      return { migrationNeeded: verdict.ok ? verdict.migrationRequired : null,
      incompatible: verdict.ok ? null : { label: "database set", foundVersion: null, targetVersion: null } };
    } catch { return { migrationNeeded: null, incompatible: null }; }
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
    // When this process started, in nowFn's clock: scopes the "this boot
    // rolled back" intent row to a lastBoot record written since. Defaults
    // to now − process uptime (both sides of the comparison are then in the
    // injected clock); tests pass an explicit value.
    bootStartedAt = null,
    hold: bootHold = null,
    operation = null,
    normalizeBootConfig = null,
  } = {}) => {
    const warnings = [];
    const assertBootLease = () => {
      operation.assertActive();
      if (bootHold?.isValid?.() === false) throw Object.assign(new Error("Boot lease expired"), { code: "lease_expired" });
    };
    const isBootCurrent = () => { try { assertBootLease(); return true; } catch { return false; } };
    const updateBootState = (mutate) => { assertBootLease(); return channelStore.updateState(mutate); };
    let state = channelStore.readState();
    if (bootHold?.isValid?.() === false) return { status: "held", hold: state.gatewayHold || { reason: "lease_expired" }, warnings: ["Boot no longer owns the gateway lifecycle."] };
    if (!state.gatewayHold && state.recoveryReview?.hold?.reason === "recovery_review") {
      state = updateBootState((current) => {
        if (!current.gatewayHold && current.recoveryReview?.hold?.reason === "recovery_review") current.gatewayHold = current.recoveryReview.hold;
        return current;
      });
    }
    if (state.gatewayHold?.reason === "recovery_review") {
      if (state.recoveryReview?.operationId) ledger.updateRun(state.recoveryReview.operationId, (run) => ({ ...run,
        recoveryReview: { active: true, gatewayHeld: true }, result: { ...run.result, code: "recovery_choice_required", gatewayHeld: true } }));
      return { status: "held", hold: state.gatewayHold, warnings: ["The gateway is stopped pending a fresh recovery choice or safe cancellation."] };
    }
    const installDir = safeInstallDir();
    const build = executingBuild();
    const installedVersion = build?.version ?? null;
    const installedBuildId = build?.buildId ?? null;

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

    // `extra` carries the structural-hold fields (detail, installed,
    // expected, bootId — see normalizeGatewayHold); migration-class holds
    // pass none.
    const setHold = (reason, blamedKeys = [], extra = {}) => {
      const hold = {
        reason,
        at: nowFn(),
        operationId,
        blamedKeys: blamedKeys.slice(0, 50),
        ...extra,
      };
      updateBootState((s) => {
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
      updateBootState((s) => {
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
      return { status: "skipped", reason: readInstalledVersionSafe() ? "binary-unresolved" : "no-install", warnings };
    }

    const migration =
      state.configMigration && typeof state.configMigration === "object"
        ? state.configMigration
        : {};

    const recordAttempt = (ok, error, extra = {}) =>
      updateBootState((s) => {
        const prev =
          s.configMigration && typeof s.configMigration === "object"
            ? s.configMigration
            : {};
        s.configMigration = {
          completedForVersion: ok
            ? installedVersion
            : (prev.completedForVersion ?? null),
          completedForBuild: ok ? installedBuildId : (prev.completedForBuild ?? null),
          lastAttempt: {
            version: installedVersion,
            buildId: installedBuildId,
            at: nowFn(),
            ok,
            error: error || null,
            ...extra,
          },
          // The last whole-file restore is evidence, not attempt state: an
          // attempt record never erases it (Stage 3's undo reads it).
          lastRestore: prev.lastRestore ?? null,
        };
        return s;
      });

    const configPath = resolveOpenclawConfigPath({ openclawDir });

    // FIRST guard (issue #76 RC3 / Codex D11 — the C1 belt): the live tree is
    // not the build the state file recorded AND that build's overlay is
    // complete on disk — the boot sync should have activated it and did not
    // (skipped behind a stale pidfile in #76, a fail-open sync error, a
    // partial activation). NOTHING below may run against this tree: no
    // snapshot, no known-safe strips, no doctor — `doctor --fix` from the
    // wrong binary is how #76 migrated a 2026.7 config for a 2026.9 build.
    // Hold with the structural `version_mismatch` class (Stage 3's
    // reconcileInstalled owns the repair); an operator retry (force) cannot
    // bypass a wrong binary. The pending run did NOT activate its target —
    // say so (activated:false is the honest ledger state here).
    // getChannelInfo() owns the divergence verdict (pin-lag- and dev-aware,
    // on the injected clock) — the same field the rollback/forward gates and
    // the status tick read, so no gate can disagree with another.
    const divergence = getChannelInfo();
    const expectedVersion = divergence.expectedVersion;
    if (
      divergence.installedDiverged &&
      channelStore.hasOverlay(expectedVersion)
    ) {
      const detail = `OpenClaw ${installedVersion} is installed but ${expectedVersion} is the recorded build and its overlay is complete — the gateway is held; no settings migration runs from a build that was not chosen`;
      warnings.push(detail);
      bootStep(
        "config-migrate",
        "failed",
        "installed build differs from the recorded build",
      );
      const hold = setHold("version_mismatch", [], {
        detail,
        installed: installedVersion,
        expected: expectedVersion,
        bootId: getProcessBootId(),
      });
      log(
        `config-gate: version mismatch — installed ${installedVersion}, recorded ${expectedVersion} (overlay complete); gateway held, nothing migrated`,
      );
      logEvent("config_migration_gate", "version_mismatch", {
        installed: installedVersion,
        expected: expectedVersion,
      });
      queueNotify(
        `⚠️ OpenClaw ${installedVersion} is installed, but ${expectedVersion} is the build you chose and its files are on disk. The gateway is HELD so nothing runs or migrates your settings from the wrong build — nothing was modified. Restart AlphaClaw to re-activate ${expectedVersion}, or open the Upgrade page.`,
        {
          eventType: "health",
          id: `version-mismatch-held-${installedVersion}-${expectedVersion}`,
        },
      );
      resolvePendingRun({ activated: false });
      return { status: "held", hold, warnings };
    }
    let bootRecoveryVerdict;
    try {
      assertBootLease();
      const inventory = await recoveryInventory(assertBootLease);
      assertBootLease();
      bootRecoveryVerdict = await inspectRecoveryTarget(build.packageDir, installedVersion, inventory);
      assertBootLease();
      if (!bootRecoveryVerdict.ok) throw Object.assign(new Error("Database compatibility is unresolved"), { code: "db_preflight_failed" });
      if (!bootRecoveryVerdict.migrationRequired) bootStep("db-migrate", "completed", "no database migration needed");
      if (bootRecoveryVerdict.migrationRequired || pendingRun?.recoveryIntent?.approved) {
        const approved = pendingRun?.recoveryIntent;
        const recovery = pendingRun?.recovery;
        const targetMatches = approved?.target?.channel === "dev"
          ? approved.target.sha === installedBuildId
          : approved?.target?.version === installedVersion;
        if (approved?.approved !== true || !targetMatches || recovery?.checkpoint?.verified !== true ||
            (bootRecoveryVerdict.migrationRequired && !(hasDatabaseRecoveryCoverage(recovery) || (recovery?.kind === "forward_only" && recovery.consent?.recorded === true)))) {
          throw Object.assign(new Error("Database migration requires a recovery choice"), { code: "recovery_choice_required" });
        }
        const targetBuild = recovery.checkpoint?.targetBuild;
        if (!targetBuild || await fingerprintBuild(targetBuild, { fsModule }) !== approved.targetFingerprint) {
          throw Object.assign(new Error("Approved target changed"), { code: "recovery_intent_stale" });
        }
        assertBootLease();
        if (await fingerprintBuild(build, { fsModule, contentOnly: true }) !== approved.targetContentFingerprint) throw new Error("Installed recovery target changed");
        assertBootLease();
        if (!inspectRecoveryCheckpoint(recovery.checkpoint.file, { record: recovery, backupsDir, fsModule }).ok) throw new Error("Recovery checkpoint changed");
        const verifiedRecovery = await readRecoveryCheckpoint(recovery.checkpoint.file, { operationId: pendingRun.operationId,
          sourceBuild: recovery.checkpoint.sourceBuild, targetBuild, fsModule, inventory,
          isLeaseValid: isBootCurrent });
        assertBootLease();
        const currentPaths = inventory.dbs.map((db) => db.sourcePath).sort();
        const rootStat = fsModule.statSync(inventory.stateDir);
        if (inventory.stateDir !== verifiedRecovery.manifest.stateDir || inventory.requestedStateDir !== verifiedRecovery.manifest.requestedStateDir ||
            rootStat.dev !== verifiedRecovery.manifest.rootIdentity.dev || rootStat.ino !== verifiedRecovery.manifest.rootIdentity.ino) throw new Error("Recovery state root changed");
        const approvedPaths = approved.databases.map((db) => db.path).sort();
        if (JSON.stringify(currentPaths) !== JSON.stringify(approvedPaths)) throw new Error("Recovery inventory changed");
        for (const db of approved.databases) {
          if (JSON.stringify(await fingerprintDatabase(db.path, { fsModule })) !== JSON.stringify(db.files)) throw new Error("Recovery database changed");
          assertBootLease();
        }
        if (inventory.configDigest !== verifiedRecovery.manifest.files.find((file) => file.archivePath === verifiedRecovery.manifest.configArchivePath)?.sha256) throw new Error("Recovery config changed");
      } else if (!pendingRun && inventory.configPresent && bootHold &&
          (migration.completedForVersion !== installedVersion || migration.completedForBuild !== installedBuildId)) {
        const assertBoot = assertBootLease;
        assertBoot();
        if (gatewayQuiesce && await gatewayQuiesce.isRunning()) throw Object.assign(new Error("A gateway is running"), { code: "gateway_stop_unconfirmed" });
        assertBoot();
        const checkpointId = crypto.randomUUID();
        ledger.createRun({ operationId: checkpointId, target: { kind: "backup", source: "boot", version: installedVersion } });
        let quiet = null;
        let quietLost = false;
        try {
          quiet = await dbQuiet({ owner: "boot-config-checkpoint", maxMs: 15_000,
            onEvent: (event) => { if (["expired", "released", "disabled"].includes(event?.status)) quietLost = true; } });
          assertBoot();
          if (!quiet || quiet.token?.disabled || quietLost) throw Object.assign(new Error("Boot quiet unavailable"), { code: "state_db_quiet_unavailable" });
          const recovery = await createRecoveryCheckpoint({ inventory: await recoveryInventory(assertBoot), backupsDir,
            operationId: checkpointId, sourceBuild: { version: migration.completedForVersion || state.lastBoot?.previousInstalledVersion || null,
              buildId: migration.completedForBuild || null }, targetBuild: build, includeDatabases: false, fsModule, nowFn,
            isLeaseValid: isBootCurrent, isQuiet: () => !quietLost });
          assertBoot();
          if (!ledger.updateRun(checkpointId, (record) => ({ ...record, recovery }))) throw new Error("Recovery provenance unavailable");
          ledger.completeRun(checkpointId, { state: "completed", ok: true, result: { ok: true, recovery } });
        } catch (error) {
          ledger.completeRun(checkpointId, { state: "failed", ok: false, result: { ok: false, code: error.code || "boot_checkpoint_failed" } });
          throw error;
        } finally {
          if (quiet) dbResume(quiet);
        }
      }
    } catch (error) {
      if (operation.signal.aborted || error?.name === "AbortError" || ["lease_expired", "operation_cancelled", "operation_timed_out"].includes(error?.code)) {
        const reason = operation.signal.aborted ? "operation_cancelled" : error.code || "operation_cancelled";
        return { status: "held", hold: channelStore.readState().gatewayHold || { reason }, warnings: ["Boot no longer owns mutation authority."] };
      }
      if (error.code?.startsWith("CHECKPOINT_")) error.code = "recovery_intent_stale";
      const incompatibleAgent = bootRecoveryVerdict?.perDb?.find((db) => db.dbKind === "agent" && db.compatible === false);
      const detail = incompatibleAgent
        ? `agent database ${dbEntryLabel({ path: incompatibleAgent.sourcePath })} is at agent schema ${incompatibleAgent.userVersion} and OpenClaw ${installedVersion} supports up to ${bootRecoveryVerdict.byKind.agent.targetVersion} — the gateway is held so this build never opens a database it cannot read`
        : error.code === "gateway_stop_unconfirmed"
          ? `settings migration for ${installedVersion} was not attempted: a gateway process is running — stop it, then Retry migration`
        : error.code === "db_preflight_failed" || error.code?.startsWith("ERR_SQLITE")
          ? `Database compatibility is not verified (${bootRecoveryVerdict?.reasons?.join(", ") || error.code}); nothing was modified`
          : error.code || "recovery_intent_stale";
      const reason = incompatibleAgent || error.code === "gateway_stop_unconfirmed" ? detail : error.code === "db_preflight_failed"
        ? bootRecoveryVerdict?.compatible === false ? "version_mismatch" : "state_db_unreadable"
        : error.code?.startsWith("ERR_SQLITE") ? "state_db_unreadable" : error.code || "recovery_intent_stale";
      warnings.push(detail);
      for (const db of bootRecoveryVerdict?.perDb || []) {
        if (db.compatible !== true) log(`boot db probe: ${dbEntryLabel({ path: db.sourcePath })}: ${db.reasons.join(", ")}`);
      }
      const priorHold = channelStore.readState().gatewayHold;
      const hold = priorHold && !isMigrationClassHold(priorHold) ? priorHold : setHold(reason, [], { detail });
      bootStep("db-migrate", "failed", incompatibleAgent
        ? `${dbEntryLabel({ path: incompatibleAgent.sourcePath })}: agent schema ${incompatibleAgent.userVersion} is newer than the ${bootRecoveryVerdict.byKind.agent.targetVersion} this build supports`
        : detail);
      bootStep("config-migrate", "failed", "database recovery refused");
      recordAttempt(false, incompatibleAgent ? "db-incompatible" : reason);
      queueNotify(incompatibleAgent
        ? `OpenClaw ${installedVersion} cannot read your agent database: it is at agent schema ${incompatibleAgent.userVersion} and this build supports up to ${bootRecoveryVerdict.byKind.agent.targetVersion}. The gateway is held to protect your data.`
        : `OpenClaw ${installedVersion} is held to protect your data. ${detail}. Open the Upgrade page to choose a compatible build and recovery protection.`,
        { eventType: "health", id: incompatibleAgent ? `db-incompatible-held-${installedVersion}` : error.code === "gateway_stop_unconfirmed"
          ? `config-migration-held-${installedVersion}` : `recovery-held-${installedVersion}-${reason}` });
      if (pendingRun && !["recovery_choice_required", "recovery_intent_stale"].includes(reason)) resolvePendingRun({ activated: false });
      return { status: "held", hold, warnings };
    }

    // Structural holds are not settings-migration failures: they never
    // re-arm the re-attempt gate or doctor (Codex 6). A version_mismatch hold
    // was set by this reconciler, which therefore owns clearing it — but only
    // on the DIVERGENCE predicate, never on the first guard's fall-through:
    // a tree that is still diverged while the recorded build's overlay is no
    // longer complete (crash mid-prune — pruneOverlays tombstones the
    // sentinel first — a partial volume restore, a lost sentinel) stays held,
    // because doctor from the un-chosen build is the exact #76 mutation this
    // hold exists to prevent. The other structural classes belong to the
    // version gates and stay until their owner clears them.
    if (state.gatewayHold && !isMigrationClassHold(state.gatewayHold)) {
      // The launch gate (boot step 4, #76 C2) writes the SAME reason for a
      // tree that cannot open the state databases — a condition divergence
      // says nothing about. Before clearing on "the tree converged", re-judge
      // the live tree (fresh user_version reads, memoized declared schema, no
      // prober): a hold the gate would set again right now stays.
      let liveCompat = null;
      if (
        state.gatewayHold.reason === "version_mismatch" &&
        !divergence.installedDiverged
      ) {
        try {
          liveCompat = await assessInstalledLaunchCompatibility({
            legacyExecApprovals: "ignore",
          });
        } catch (error) {
          liveCompat = null;
          log(`config-gate: live compatibility re-check failed open (${error?.message || error})`);
        }
      }
      if (
        state.gatewayHold.reason === "version_mismatch" &&
        !divergence.installedDiverged &&
        liveCompat?.compatible !== true
      ) {
        liveCompat ||= { compatible: null, reasons: ["compatibility_unknown"], perDb: [] };
        const detail = describeLaunchCompatHold(liveCompat, {
          installed: installedVersion,
          expected: expectedVersion,
        });
        const hold = updateBootState((s) => {
          s.gatewayHold = {
            ...s.gatewayHold,
            detail,
            installed: installedVersion,
            expected: expectedVersion,
          };
          return s;
        }).gatewayHold;
        warnings.push(detail);
        bootStep(
          "config-migrate",
          "failed",
          "installed build cannot open the state databases",
        );
        log(
          `config-gate: version_mismatch hold stays — installed ${installedVersion} still cannot open the state databases (${liveCompat.reasons.join(", ")}); nothing migrated`,
        );
        resolvePendingRun();
        return { status: "held", hold, warnings };
      }
      if (
        state.gatewayHold.reason === "version_mismatch" &&
        !divergence.installedDiverged
      ) {
        log(
          `config-gate: cleared the version_mismatch hold — installed ${installedVersion} is the recorded build again`,
        );
        warnings.push(
          `cleared the version_mismatch hold: ${installedVersion} is the recorded build again`,
        );
        clearHold();
        state = channelStore.readState();
      } else if (state.gatewayHold.reason === "version_mismatch") {
        // Still diverged, overlay incomplete: a restart can no longer heal
        // this by re-activating the recorded build — say so in the hold's
        // operator prose (at/bootId keep naming the boot that set it).
        const detail = `OpenClaw ${installedVersion} is installed but ${expectedVersion} is the recorded build and its overlay is no longer complete — the gateway stays held; no settings migration runs from a build that was not chosen`;
        const hold = updateBootState((s) => {
          s.gatewayHold = {
            ...s.gatewayHold,
            detail,
            installed: installedVersion,
            expected: expectedVersion,
          };
          return s;
        }).gatewayHold;
        warnings.push(detail);
        bootStep(
          "config-migrate",
          "failed",
          "installed build differs from the recorded build",
        );
        log(
          `config-gate: version mismatch persists — installed ${installedVersion}, recorded ${expectedVersion} (overlay incomplete); gateway stays held, nothing migrated`,
        );
        resolvePendingRun({ activated: false });
        return { status: "held", hold, warnings };
      } else {
        warnings.push(
          `gateway hold "${state.gatewayHold.reason}" is not a settings-migration hold — nothing to migrate; it stays until its owner clears it`,
        );
        resolvePendingRun();
        return { status: "held", hold: state.gatewayHold, warnings };
      }
    }

    // Recovering stranded files is a real auto-fix: announce it (day-bucketed
    // id — boot loops dedupe, a genuinely new incident weeks later re-fires).
    try {
      assertBootLease();
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

    if (typeof normalizeBootConfig === "function") {
      const assertLease = assertBootLease;
      assertLease();
      await normalizeBootConfig({ assertLease });
      assertLease();
    }

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
          // Same evidence trail as every whole-file restore (#76 A5):
          // pre-restore copy, key-path diff, lastRestore. The notification
          // id stays boot-scoped (config-restore-rollback-<v>).
          restoreConfigFromBackup({
            configPath,
            backupPath: rollbackRestorePath,
            installedVersion,
            previousCompletedForVersion: migration.completedForVersion ?? null,
            source: "rollback",
            warnings,
          });
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
      (migration.completedForBuild
        ? migration.completedForBuild === installedBuildId
        : build?.source !== "dev" && migration.completedForVersion === installedVersion) &&
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
    //
    // Issue #76 RC3: a regression is RESTORED only when the operator asked
    // for this build (describeVersionRegressionIntent — the stamp, the
    // pending run, this boot's rollback, a recent update run). Without that
    // evidence the regression is DRIFT (the installed tree stopped being the
    // recorded build) and the settings are left exactly as they are: the .bak
    // is kept, the boot log/event/notification say so, and nothing below runs
    // — a forward migration here would migrate the settings for a build
    // nobody chose. An operator retry (force) never replays a downgrade
    // restore over live edits and never takes the drift exit: the operator is
    // present and asked for the forward migration.
    const restorePath = path.join(
      openclawDir,
      `openclaw.json.pre-fix-${installedVersion}.bak`,
    );
    // "Regressed" means the installed build is OLDER than the one the
    // migration completed for — by version order, not mere inequality. The
    // fresh-boot snapshot is named by its fallback chain (completedForVersion,
    // else lastBoot, else the PIN), so a first boot on an overlay leaves a
    // pre-fix-<pin>.bak that names a version nobody has run yet; when that
    // pin is later activated by an UPGRADE, the name matches installedVersion
    // and, without this check, the gate restored the old build's config over
    // the freshly migrated one and marked the new version migrated — so no
    // doctor ran before the gateway and 2026.9.5 refused with its pending
    // audit-events-v2 repair (container tier, 2026-09-22, 3 of 5 runs).
    // Not comparable (dev shas, malformed) → not a regression: the forward
    // migration below is the safe default.
    const regressedFromCompleted = (() => {
      try {
        return compareVersionParts(installedVersion, migration.completedForVersion) < 0;
      } catch {
        return false;
      }
    })();
    if (
      !force &&
      migration.completedForVersion &&
      migration.completedForVersion !== installedVersion &&
      regressedFromCompleted &&
      fsModule.existsSync(restorePath)
    ) {
      const intent = describeVersionRegressionIntent({
        state,
        installedVersion,
        pendingRun,
        bootStartedAt: Number.isFinite(bootStartedAt)
          ? bootStartedAt
          : nowFn() - Math.round(process.uptime() * 1000),
        now: nowFn(),
      });
      const checked = intent.evaluated
        .map((row) => `${row.source}=${row.matched ? "yes" : "no"}`)
        .join(" ");
      if (!intent.intentional) {
        const summary = `installed ${installedVersion} regressed from the migrated ${migration.completedForVersion} without a recorded update, rollback or pin change`;
        warnings.push(
          `${summary} — settings left untouched (${path.basename(restorePath)} kept); the recorded build must be re-activated`,
        );
        log(
          `config-gate: DRIFT — ${summary} (${checked}); openclaw.json untouched, ${path.basename(restorePath)} kept`,
        );
        logEvent("config_migration_gate", "drift_detected", {
          installedVersion,
          completedForVersion: migration.completedForVersion,
          backup: path.basename(restorePath),
          checked: intent.evaluated,
        });
        bootStep("config-migrate", "warning", "version drift");
        const message = `⚠️ OpenClaw ${installedVersion} is running, but your settings were last migrated for ${migration.completedForVersion} and no update, rollback or pin change asked for ${installedVersion}. Settings were left untouched (the ${path.basename(restorePath)} backup is kept) — the gateway may reject them until the recorded build is active again. Open the Upgrade page.`;
        queueNotify(message, {
          eventType: "health",
          id: `config-drift-${installedVersion}-${migration.completedForVersion}-${notifyDayBucket()}`,
        });
        postBootWebhook(message);
        resolvePendingRun();
        // Exit contract: never 'skipped' while a hold is persisted.
        const priorHold = channelStore.readState().gatewayHold;
        if (priorHold) return { status: "held", hold: priorHold, warnings };
        return { status: "skipped", reason: "version_drift", warnings };
      }
      try {
        const restored = restoreConfigFromBackup({
          configPath,
          backupPath: restorePath,
          installedVersion,
          previousCompletedForVersion: migration.completedForVersion,
          source: "round_trip",
          warnings,
        });
        let droppedNote = "";
        try {
          const before = restored.live || {};
          const after = restored.restored || {};
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
        // The intent stamp authorizes exactly one restore (Codex D10).
        if (intent.source === "lastTransition") {
          updateBootState((s) => {
            if (s.lastTransition) s.lastTransition.consumedAt = nowFn();
            return s;
          });
        }
        warnings.push(
          `restored ${path.basename(restorePath)} for downgrade to ${installedVersion} (intent: ${intent.source}); settings changed on a newer version were discarded`,
        );
        log(
          `config-gate: round-trip restore for ${installedVersion} authorized by ${intent.source} (${checked})`,
        );
        queueNotify(
          `ℹ️ Restored the OpenClaw settings saved before you moved past ${installedVersion}. Settings changed on the newer version were reset.${droppedNote}`,
          {
            eventType: "info",
            // Day-bucketed (#76 RC3): the outbox dedupes a DELIVERED id
            // forever, and a later genuine downgrade to the same version
            // must still notify.
            id: `config-restore-${installedVersion}-${notifyDayBucket()}`,
          },
        );
        recordAttempt(true);
        clearHold();
        resolvePendingRun();
        return {
          status: "ok",
          reason: "round-trip-restore",
          intent: intent.source,
          warnings,
        };
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
    const gateHash = computeGateHash(configRaw, installedBuildId);

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

    const bin = build?.bin;
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
      assertBootLease();
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
    assertBootLease();
    let validation = await validateConfigWithBin(bin, { operation, assertCurrent: assertBootLease });
    assertBootLease();
    const dbMigrationNeeded = bootRecoveryVerdict.migrationRequired;

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
      assertBootLease();
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
      assertBootLease();
      doctorOutcome = await operation.runWriter(() => {
        assertBootLease();
        return doctorGuard.withDoctorRestoreGuard({
        operationId,
        run: () => {
          assertBootLease();
          return runner.runStreamed({
            command: process.execPath,
            // Never combine --fix with --json (beta rejects the combo).
            args: [bin, "doctor", "--fix", "--yes"],
            env: openclawSpawnEnv(),
            timeoutMs: budgetMs,
            signal: operation.signal, deadlineAt: operation.deadlineAt,
            onProcess: operation.noteProcess, killGraceMs: kRepairKillGraceMs,
          });
        },
        });
      });
      assertBootLease();
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
        const verdict = await probeDbMigrationNeeded(bin, {
          installDir,
          installedVersion,
          build,
        });
        bootStep(
          "db-migrate",
          "warning",
          verdict.migrationNeeded === false
            ? "databases report consistent after the timeout"
            : "database state after the timeout is unverified",
        );
      }
      // Re-validate on the migrated config (when the build can).
      assertBootLease();
      validation = await validateConfigWithBin(bin, { operation, assertCurrent: assertBootLease });
      assertBootLease();
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
        // The DBs now carry the schema this build migrated them to — record
        // it as observed evidence for the learned table (#78, Codex D7).
        recordObservedSchemaAfterMigration({ installedVersion, buildId: installedBuildId });
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
        assertCurrent: assertBootLease,
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
        installedBuildId,
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
  const reconcileBootConfigOwned = async (options) => {
    const assertCurrent = () => {
      options.operation.assertActive();
      if (options.hold?.isValid?.() === false) throw Object.assign(new Error("Reconciliation lease expired"), { code: "lease_expired" });
    };
    try {
      assertCurrent();
      const deferredMirror = ledger.listRuns().some((run) => run.state === "restart_expected" && run.recoveryIntent?.approved);
      const result = await reconcileBootConfigInner(options);
      assertCurrent();
      if (result.status === "ok" && deferredMirror) {
        const applied = channelStore.readState().applied;
        assertCurrent();
        reconcileOpenclawJsonMirror(applied?.channel || "stable", { devShimActive: applied?.channel === "dev" });
      }
      return result;
    } catch (error) {
      let authorityError = null;
      try { assertCurrent(); } catch (cancelled) { authorityError = cancelled; }
      if (authorityError || error?.name === "AbortError" || ["lease_expired", "operation_cancelled", "operation_timed_out"].includes(error?.code)) {
        const reason = authorityError?.code || error.code || "operation_cancelled";
        return { status: "held", hold: channelStore.readState().gatewayHold || { reason }, warnings: ["Reconciliation no longer owns mutation authority."] };
      }
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
          assertCurrent();
          s.gatewayHold = hold;
          const prev =
            s.configMigration && typeof s.configMigration === "object"
              ? s.configMigration
              : {};
          s.configMigration = {
            completedForVersion: prev.completedForVersion ?? null,
            completedForBuild: prev.completedForBuild ?? null,
            // No gateHash on purpose: the re-attempt gate must not reuse a
            // machinery failure — the next boot retries the real work.
            lastAttempt: {
              version: installedVersion,
              at: nowFn(),
              ok: false,
              error: reason,
            },
            lastRestore: prev.lastRestore ?? null,
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

  const reconcileBootConfig = async (options = {}) => {
    const refuse = (reason) => ({ status: "held", hold: channelStore.readState().gatewayHold || { reason }, warnings: [reason] });
    if (Boolean(options.hold) !== Boolean(options.operation)) return refuse("recovery_ownership_unavailable");
    let hold = options.hold || null;
    let operation = options.operation || null;
    const owned = !operation;
    try {
      if (owned) {
        if (getActiveGatewayOperation?.()) return refuse("gateway_operation_in_progress");
        operation = createRepairOperation({ signal: gatewayQuiesce?.signal,
          isCurrent: () => Boolean(hold) && hold.isValid?.() !== false });
        const lockOptions = { leaseMs: kOpenclawReconcileLifecycleLeaseMs, cleanup: operation.cleanup };
        hold = tryAcquireLifecycleLock
          ? tryAcquireLifecycleLock("reconcile_retry", lockOptions)
          : await (acquireLifecycleLock || localApplyLock.acquire)("reconcile_retry", lockOptions);
        if (!hold) return refuse("gateway_operation_in_progress");
        operation.start(kOpenclawReconcileLifecycleLeaseMs - kRepairCleanupAllowanceMs);
      }
      return await operation.runWriter(() => reconcileBootConfigOwned({ ...options, hold, operation }));
    } catch (error) {
      return refuse(error?.code || "recovery_ownership_unavailable");
    } finally {
      if (owned && operation) {
        operation.finishWork();
        await operation.cleanup.wait();
        await hold?.();
      }
    }
  };

  const createBootPreflightProber = ({ allowMigration = true } = {}) => ({
    probeBin: (bin, { packageDir, version } = {}) => {
      if (!bin) return "block";
      const spawnEnv = Object.freeze({ ...openclawSpawnEnv() });
      const verdict = inspectRecoveryAtBootSync({ stateDir: stateDir(spawnEnv), spawnEnv,
        supported: supportedSchemaSync({ packageDir, version }) });
      return verdict.ok && (allowMigration || verdict.migrationRequired === false) ? "pass" : "block";
    },
    probeBinStreamed: async (bin, { packageDir, version } = {}) => {
      if (!bin) return "block";
      try {
        const verdict = await inspectRecoveryTarget(packageDir, version, await recoveryInventory());
        return verdict.ok && (allowMigration || verdict.migrationRequired === false) ? "pass" : "block";
      } catch { return "block"; }
    },
    cleanup: () => {},
  });

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
      // { bin, packageDir }: packageDir locates the candidate's declared
      // agent schema for the prober's agent arm (#78); a null bin means
      // "could not check".
      const noTarget = { bin: null, packageDir: null };
      const overlayTarget = (version) => {
        if (!version || !channelStore.hasOverlay(version)) return noTarget;
        const packageDir = channelStore.overlayPackageDir(version);
        return {
          bin: channelStore.resolvePackageBin(packageDir) || null,
          packageDir,
        };
      };
      const pinTarget = () => {
        const fromOverlay = overlayTarget(state.pinVersion);
        if (fromOverlay.bin || !state.pinVersion) return fromOverlay;
        // No pin overlay: when the installed tree IS the pin, probe it
        // (best-effort — null just means "could not check").
        const installedVersion = channelStore.readInstalledVersion({
          installDir,
        });
        if (installedVersion !== state.pinVersion) return noTarget;
        const packageDir = path.join(installDir, "node_modules", "openclaw");
        return {
          bin: channelStore.resolvePackageBin(packageDir) || null,
          packageDir,
        };
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
          ...overlayTarget(target.version),
        });
        if (
          !pinIsBlocked &&
          state.pinVersion &&
          state.pinVersion !== target.version
        ) {
          candidates.push({
            kind: "pin",
            version: state.pinVersion,
            ...pinTarget(),
          });
        }
      } else if (!pinIsBlocked) {
        candidates.push({
          kind: "pin",
          version: state.pinVersion,
          ...pinTarget(),
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
            ...overlayTarget(lkg),
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
        let verdict = prober.probeBin(candidate.bin, {
          packageDir: candidate.packageDir,
          version: candidate.version,
        });
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
    assertCurrent,
    installDir,
    state,
    warnings,
    migration,
    action,
  }) => {
    const none = { state, aborted: false };
    try {
      assertCurrent();
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
      const prober = createBootPreflightProber({ allowMigration: false });
      let revertVersion = null;
      let revertBlocked = false;
      try {
        for (const version of revertCandidates) {
          if (!channelStore.hasOverlay(version)) continue;
          const packageDir = channelStore.overlayPackageDir(version);
          const verdict = await prober.probeBinStreamed(
            channelStore.resolvePackageBin(packageDir),
            { packageDir, version },
          );
          assertCurrent();
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
      assertCurrent();
      channelStore.addBlocklist({
        id: installedVersion,
        reason: "config_migration_failed",
        exitCode: null,
      });
      try {
        // Same evidence trail as every whole-file restore (#76 A5):
        // pre-restore copy, key-path diff, lastRestore (source
        // migration_gate).
        restoreConfigFromBackup({
          configPath: resolveOpenclawConfigPath({ openclawDir }),
          backupPath: bakPath,
          installedVersion,
          previousCompletedForVersion:
            state?.configMigration?.completedForVersion ?? null,
          source: "migration_gate",
          warnings,
        });
      } catch (error) {
        assertCurrent();
        warnings.push(
          `migration gate: pre-fix config restore failed (${error.message})`,
        );
      }
      assertCurrent();
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
      const actualBuild = executingBuild();
      const finalVerdict = actualBuild && await inspectRecoveryTarget(actualBuild.packageDir, actualBuild.version, await recoveryInventory(assertCurrent));
      assertCurrent();
      if (!finalVerdict?.ok || finalVerdict.migrationRequired !== false) {
        warnings.push("The reverted build still needs database recovery review; the gateway remains held.");
        return { state: newState, aborted: false };
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
      assertCurrent();
      warnings.push(
        `migration gate error (${error.message}) — holding the gateway`,
      );
      return none;
    }
  };

  // Stores without the full judge (test doubles, older shapes) still yield
  // a decision record so the audit line and the boot report have one shape.
  const describePidDecision = () => {
    if (typeof channelStore.describeServerPidDecision === "function") {
      return channelStore.describeServerPidDecision();
    }
    const evidence =
      typeof channelStore.readLiveServerPidEvidence === "function"
        ? channelStore.readLiveServerPidEvidence()
        : (() => {
            const pid = channelStore.readLiveServerPid();
            return pid ? { pid, corroborated: false } : null;
          })();
    return {
      evidence,
      decision: evidence ? "skip" : "proceed",
      reason: evidence ? "evidence_only" : "absent",
      record: { raw: null, format: null, legacyClaim: false },
      pid: evidence?.pid ?? null,
    };
  };

  // Dangling records never survive a boot (#76 A7). Idempotent and safe to
  // call from BOTH boot phases: runs still "running" in the ledger died with
  // their process (restart_expected runs are NOT touched — the activation
  // branch resolves them by whether their target actually came up), and a
  // process death mid-apply (OOM during a dev build, host reboot) leaves
  // lastUpdateRun.finishedAt = null forever — the UI would resurrect it as a
  // phantom in-flight operation (use-upgrade-tab's `finishedAt == null`
  // predicate) and lock every action. Called twice per boot: by the bin
  // phase's syncAtBoot (after the pidfile decision proved no live sibling —
  // its closures land in boot-report.json under bootSync.danglingRecords) and
  // again by the server phase from the LISTENING path (idempotent; the port
  // bind proved single-instance). Never throws.
  //   { closedRuns: operationId[], closedLastUpdateRun, warnings }
  const closeDanglingRecordsAtBoot = () => {
    const result = { closedRuns: [], closedLastUpdateRun: false, warnings: [] };
    try {
      const closed = ledger.closeInterruptedRuns();
      result.closedRuns = (Array.isArray(closed) ? closed : [])
        .map((run) => run?.operationId)
        .filter(Boolean);
    } catch (error) {
      log(`boot: could not close interrupted ledger runs (${error?.message || error})`);
    }
    try {
      const current = channelStore.readState();
      if (current.lastUpdateRun && current.lastUpdateRun.finishedAt == null) {
        channelStore.updateState((s) => {
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
        result.closedLastUpdateRun = true;
        result.warnings.push("closed an update run interrupted by a restart");
      }
    } catch (error) {
      log(`boot: could not close the interrupted update run (${error?.message || error})`);
    }
    return result;
  };

  // PRAGMA user_version of every state DB through the TRACKED read-only
  // handle (the quiet barrier counts it), plus the launch-record shape the
  // watchdog / restart-op record persist (#76 A2). Async by contract so no
  // caller can put it on a status tick; never throws.
  //   { userVersion, agentUserVersions, entries: [{ path, kind, agentId,
  //     userVersion, status, error }] }
  const readStateDbVersions = async () => {
    const entries = enumerateStateDbEntries().map((entry) => {
      const read = readSqliteUserVersion(entry.path, {
        open: openTrackedReadonlyDatabase,
        fsModule,
      });
      return {
        ...entry,
        userVersion: Number.isInteger(read?.userVersion) ? read.userVersion : null,
        status: String(read?.status || "error"),
        error: read?.error?.code ?? null,
      };
    });
    const stateEntry = entries.find((entry) => entry.kind === "state");
    return {
      userVersion: stateEntry?.userVersion ?? null,
      agentUserVersions: entries
        .filter((entry) => entry.kind === "agent")
        .map((entry) => entry.userVersion)
        .filter((value) => Number.isInteger(value)),
      entries,
    };
  };

  // The boot report's server-phase facts (#76 A1): per-DB user_version plus
  // the schema line the INSTALLED tree supports (declared > learned table).
  //   { installedVersion, packageDir, stateDb, supportedSchema }
  const describeStateDbSchema = async () => {
    const build = await getExecutingBuild();
    const installedVersion = build?.version ?? null;
    const packageDir = build?.packageDir ?? null;
    const versions = await readStateDbVersions();
    // The same memoized resolution the launch gate reads (Eng 1A): the boot
    // report's read primes it, the gate a few steps later reuses it.
    const supportedSchema = build?.schemas ?? { state: null, agent: null, source: { state: null, agent: null } };
    return {
      installedVersion,
      packageDir,
      executingBuild: build,
      stateDb: versions.entries.map(({ path: dbPath, kind, agentId, userVersion, status, error }) => ({
        path: dbPath,
        kind,
        agentId,
        userVersion,
        status,
        ...(error ? { error } : {}),
      })),
      supportedSchema,
    };
  };

  // Evidence for the learned schema table (#78 / Codex D7): the user_version
  // each DB kind carries AFTER `version` migrated it. Recorded as `observed`
  // only — never consulted as a maximum. Agent DBs share one line, so the
  // highest observed agent version is the line this build migrated to.
  // Advisory: a failed read/write costs one log line.
  const recordObservedSchemaAfterMigration = ({ installedVersion, buildId = installedVersion } = {}) => {
    if (!installedVersion) return null;
    try {
      const entries = enumerateStateDbEntries().map((entry) => ({
        ...entry,
        read: readSqliteUserVersion(entry.path, {
          open: openTrackedReadonlyDatabase,
          fsModule,
        }),
      }));
      const observedOf = (kind) =>
        entries
          .filter((entry) => entry.kind === kind && entry.read.status === "ok")
          .reduce(
            (max, entry) =>
              max === null || entry.read.userVersion > max ? entry.read.userVersion : max,
            null,
          );
      const observed = { state: observedOf("state"), agent: observedOf("agent") };
      const recorded = schemaTable.recordObserved(installedVersion, observed, { buildId });
      if (recorded) {
        log(
          `schema table: observed state ${observed.state ?? "n/a"} / agent ${observed.agent ?? "n/a"} after ${installedVersion} migrated`,
        );
      }
      return recorded;
    } catch (error) {
      log(
        `schema table: could not record the observed schema after ${installedVersion} migrated (${error?.message || error})`,
      );
      return null;
    }
  };

  // The sync proper. syncAtBoot (below) wraps it to leave the bin-phase boot
  // report behind on every return path — keep the wrapper as the public name.
  // Dangling-record closures of THIS boot's bin phase (#76 A7). The server
  // phase runs the same closer again from the listening path and finds
  // nothing left, so the bin phase's list is the one boot-report.json must
  // carry (bootSync.danglingRecords); the server step unions both phases.
  // null until the closer has run (a skipped_concurrent boot never closes a
  // live sibling's records, so its report says null, not []).
  let bootDanglingRecords = null;

  const syncAtBootInner = () => {
    const warnings = [];
    let action = "none";
    let pidDecision = null;
    try {
      // Single-instance guard: a second `alphaclaw start` beside a live
      // server would run this DESTRUCTIVE sync (rm+cp over the tree the live
      // gateway executes from, marker consumption, interrupted-run closing)
      // before dying on the port bind. A VPS respawn handoff briefly overlaps
      // its predecessor, so give a dying process a short grace to exit.
      // Real wall clock on purpose: nowFn is an injectable LOGICAL clock in
      // tests and may never advance — this loop must always terminate.
      const deadline = Date.now() + kConcurrentGraceMs;
      pidDecision = describePidDecision();
      while (pidDecision.evidence && Date.now() < deadline) {
        sleepSync(300);
        pidDecision = describePidDecision();
      }
      // ONE audit line per boot, on both paths: the judge's whole reasoning
      // (issue #76 RC1 — "skipped: pid 21 is live" explained nothing).
      log(`pidfile: ${formatServerPidDecision(pidDecision)}`);
      // Convergence (RC2) happens HERE, once, after the loop settles — never
      // in the reader or the loop, so the pidfile changes at most once per
      // boot. A positively identified raw legacy claim becomes a format-2
      // record the next boot can disprove; anything weaker is left alone.
      if (typeof channelStore.convergeLegacyServerPidClaim === "function") {
        const converged = channelStore.convergeLegacyServerPidClaim(pidDecision);
        if (converged?.converged) {
          log(
            `pidfile: legacy claim for pid ${pidDecision.pid} converged to format 2 (observedTicks=${converged.record.observedTicks})`,
          );
        }
      }
      const evidence = pidDecision.evidence;
      if (evidence) {
        // `corroborated` (pid alive AND /proc start time matches the record)
        // is what lets the boot script REFUSE to start; an alive-but-
        // unverifiable pid (legacy record, no /proc, or a recycled pid after
        // a hard kill) only skips the destructive sync and boots on.
        log(
          `boot sync skipped: another alphaclaw server (pid ${evidence.pid}) is live` +
            (evidence.corroborated ? "" : " (unverified — pidfile may be stale)"),
        );
        // The contradiction the #76 incident hid for 45 minutes: a complete
        // overlay for the applied build sits beside an installed tree that
        // is NOT that build, and the sync that would activate it is being
        // skipped on this claim. Read-only here — the C1 belt (Stage 3)
        // reconciles it; no state.lastBoot write on this path either (a
        // whole-file rewrite of the state a live sibling may be writing).
        try {
          const installDir = safeInstallDir();
          const installedVersion = installDir
            ? channelStore.readInstalledVersion({ installDir })
            : null;
          const applied = channelStore.readState().applied;
          if (
            applied?.version &&
            applied.channel !== "dev" &&
            installedVersion &&
            installedVersion !== applied.version &&
            channelStore.hasOverlay(applied.version)
          ) {
            const contradiction =
              `installed openclaw ${installedVersion} ≠ applied ${applied.version} with a complete overlay while a live sibling (pid ${evidence.pid}) is claimed — the applied build stays inactive until the claim is disproved`;
            warnings.push(contradiction);
            log(`pidfile: ${contradiction}`);
          }
        } catch {}
        return {
          ok: false,
          action: "skipped_concurrent",
          livePid: evidence.pid,
          corroborated: evidence.corroborated === true,
          warnings,
          pidDecision,
        };
      }
      // Claim the instance pidfile NOW, not at server start — the window
      // between this guard and lib/server.js is exactly where a simultaneous
      // second start would begin its own destructive sync.
      channelStore.writeServerPid();
      const installDir = safeInstallDir();
      if (!installDir) {
        log("boot sync skipped: install dir unresolved");
        return { ok: false, action: "skipped", warnings, pidDecision };
      }
      const channel = safeReadChannel();
      let state = channelStore.readState();
      // Dangling records first (#76 A7): interrupted ledger runs and a
      // lastUpdateRun left running died with their process. The server phase
      // runs the same closer again from the listening path (idempotent).
      const dangling = closeDanglingRecordsAtBoot();
      bootDanglingRecords = {
        closedRuns: [...dangling.closedRuns],
        closedLastUpdateRun: dangling.closedLastUpdateRun === true,
      };
      if (dangling.closedLastUpdateRun) {
        warnings.push(...dangling.warnings);
        state = channelStore.readState();
      }
      for (const run of ledger.listRuns()) {
        if (run.recoveryReview?.active && run.operationId !== state.recoveryReview?.operationId) {
          ledger.updateRun(run.operationId, (record) => ({ ...record, recoveryReview: { active: false, interrupted: true } }));
        }
      }
      if (state.gatewayHold?.reason === "recovery_review" || state.recoveryReview?.hold?.reason === "recovery_review") {
        if (state.recoveryReview?.operationId) ledger.updateRun(state.recoveryReview.operationId, (run) => ({ ...run,
          recoveryReview: { active: true, gatewayHeld: true }, result: { ...run.result, code: "recovery_choice_required", gatewayHeld: true } }));
        if (!state.gatewayHold) channelStore.updateState((current) => {
          if (!current.gatewayHold && current.recoveryReview?.hold?.reason === "recovery_review") current.gatewayHold = current.recoveryReview.hold;
          return current;
        });
        return { ok: true, action: "held", warnings: ["The gateway remains stopped pending recovery review or safe cancellation."], pidDecision };
      }
      // Start the boot heavy-ops clock the rollback-preflight prober draws from.
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
      // Set by the pin-lag branch below: this boot recorded state.pinLag, so
      // the end-of-boot bookkeeping must not count it a second time.
      let pinLagRecordedThisBoot = false;
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

      // Activation debris (#76 Codex 3): a `node_modules/.openclaw-staging-*`
      // copy a dead process left mid-swap (rename never ran, or it ran and
      // the process died before the sentinel) is reclaimed HERE, the one
      // sync bin-phase owner, before any activation branch below stages a
      // new one — the dir name is boot-keyed, so nothing later in this boot
      // would ever look at an older boot's copy, and each interrupted
      // activation would otherwise strand one full openclaw tree forever.
      const stagingSweep = channelStore.sweepStaleStagingDirs({ installDir });
      if (stagingSweep.removed.length > 0) {
        warnings.push(
          `removed ${stagingSweep.removed.length} stale activation staging dir${stagingSweep.removed.length === 1 ? "" : "s"}`,
        );
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
          const ranBefore = previousVersion || s.pinVersion || null;
          s.previousPin = previousVersion
            ? { version: previousVersion, at: nowFn() }
            : null;
          s.pinVersion = declaredPin;
          // Intent stamp (#76 RC3): an AlphaClaw self-update that moves the
          // pin is a chosen transition — a pin that moves BACKWARDS restores
          // that version's settings at boot instead of reading as drift.
          stampLastTransition(s, {
            from: ranBefore,
            to: declaredPin,
            source: "pin_bump",
            reason: "declared_pin_changed",
            ok: true,
          });
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
          // Intent stamp (#76 RC3): the rollback CHOSE rollbackTargetVersion;
          // `ok` is whether the tree really landed on it (an overlay that
          // failed to activate and fell back to the pin did not).
          state = channelStore.updateState((s) => {
            stampLastTransition(s, {
              from: marker.blockedId || previousInstalledVersion || null,
              to: rollbackTargetVersion,
              source: "rollback",
              reason: marker.reason || null,
              ok:
                channelStore.readInstalledVersion({ installDir }) ===
                rollbackTargetVersion,
            });
            return s;
          });
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
            // Record the lag (#76 RC4 / Codex D12) so getChannelInfo's
            // installedDiverged — and every gate reading it — stays quiet
            // for this (pin, installed) pair until npm catches up, for at
            // most kPinLagMaxBoots boots / kPinLagMaxAgeMs (advancePinLag).
            state = channelStore.updateState((s) => {
              s.pinLag = {
                pin: s.pinVersion,
                installed: installedVersion,
                at: nowFn(),
                bootId: getProcessBootId(),
                bootsSeen: 1,
              };
              return s;
            });
            pinLagRecordedThisBoot = true;
          } else if (
            installedVersion &&
            state.pinVersion &&
            installedVersion !== state.pinVersion &&
            isRecordedReturnToPin({ state, installedVersion })
          ) {
            // The operator applied the PIN itself (applyUpdate records
            // `applied = null` for that target and stamps the transition
            // in-flight). Activating it here is the recorded selection
            // landing, not external drift — no tampering alarm, and the
            // action reads "activated" like any other recorded apply.
            const landed = activatePinFallback({
              installDir,
              state,
              warnings,
              reason: `activating the recorded return to the pin ${state.pinVersion} (from ${installedVersion})`,
            });
            action = landed ? "activated" : "activation_failed";
            if (!landed) {
              queueNotify(
                `⚠️ Could not activate the built-in OpenClaw ${state.pinVersion} at startup — running ${installedVersion}. Open the Upgrade page to retry.`,
              );
            }
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
          let selected = null;
          try { selected = selectedDevCheckout(applied.checkoutDir); } catch {}
          const head = selected ? readCheckoutHead(selected) : null;
          const bin = selected ? checkoutBuildReady(selected) : null;
          const headMatches =
            head && applied.sha && head.startsWith(applied.sha);
          if (headMatches && bin) {
            const shim = activateDevCandidate({ checkoutDir, candidateDir: selected, sha: head, store: channelStore, fsModule });
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
          if (pending && !pending.recoveryIntent?.approved) {
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


      if (channelStore.readState().gatewayHold?.reason !== "recovery_review" && !ledger.listRuns().some((run) => run.state === "restart_expected" && run.recoveryIntent?.approved)) {
        reconcileOpenclawJsonMirror(channel, { devShimActive: action === "dev_shim" });
      }
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
        // Pin-lag bookkeeping (Codex D12): cleared once the tree reached the
        // pin, otherwise this boot counts against the 3-boot / 24 h excuse.
        if (s.pinLag) {
          const advanced = advancePinLag(s.pinLag, {
            pinVersion: s.pinVersion,
            installedVersion: installedAfterActivation,
            now: nowFn(),
            recordedThisBoot: pinLagRecordedThisBoot,
          });
          if (!advanced) {
            const reconciled =
              installedAfterActivation && installedAfterActivation === s.pinLag.pin;
            log(
              reconciled
                ? `pin lag cleared: installed ${installedAfterActivation} is the pin`
                : `pin lag expired: installed ${installedAfterActivation || "unknown"} still is not the pin ${s.pinLag.pin} after ${s.pinLag.bootsSeen ?? "?"} boot(s) — now reads as divergence`,
            );
          }
          s.pinLag = advanced;
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
      return { ok: true, action, warnings, pidDecision };
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
      return {
        ok: false,
        action: "failed",
        error: error.message,
        warnings: [...warnings, error.message],
        pidDecision,
      };
    }
  };

  // ---------------------------------------------------------------------
  // Bin-phase boot report (issue #76 A1)
  // ---------------------------------------------------------------------
  // Every return path of the boot sync — skipped_concurrent, skipped, ok,
  // failed — leaves ONE machine-readable statement of what this boot saw:
  // <managedDir>/boot-report.json with serverPhase pending (the server phase
  // merges its half after the port bind). The one exception is the refused
  // start: a CORROBORATED skipped_concurrent makes bin/alphaclaw.js exit 1
  // right after this call, so that report goes to boot-report-refused.json
  // with serverPhase not_reached and the ring is not rotated — the live
  // server's completed report stays current. The report is evidence ABOUT
  // the sync, so it is built after the sync from its result and can never
  // change the outcome: the whole build+write is try/caught and a throwing
  // writer costs one log line. `installedAtBoot` is read BEFORE the sync (the
  // tree the container woke up with); `resolvedForLaunch` after it (what the
  // gateway will actually run) — the verdict judges the latter. Reads only —
  // package.json, channel state, overlay dirs, /proc — no spawn, no network
  // (the boot harness pins this).
  const readInstalledSafely = () => {
    try {
      const installDir = safeInstallDir();
      return installDir ? channelStore.readInstalledVersion({ installDir }) : null;
    } catch {
      return null;
    }
  };

  // alphaclaw { version, commit, previousVersion, firstBootOfVersion }: the
  // stamp this boot wrote when the bin passed it in, else the file's record
  // (bootCount resets on every version change, so 1 is that version's first
  // boot), else null — a report without a stamp is still a report.
  const alphaclawBlock = () => {
    if (selfVersion?.record?.version) {
      return {
        version: selfVersion.record.version,
        commit: selfVersion.record.commit ?? null,
        previousVersion: selfVersion.previousVersion ?? null,
        firstBootOfVersion: selfVersion.changed === true,
      };
    }
    const record = readSelfVersionStamp({
      fsModule,
      managedDir:
        channelStore.managedDir || path.dirname(channelStore.serverPidPath),
      logger,
    });
    if (!record) return null;
    return {
      version: record.version,
      commit: record.commit,
      previousVersion: record.previous?.version ?? null,
      firstBootOfVersion: record.bootCount === 1,
    };
  };

  // Why the sync ended the way it did, derived from the result so the return
  // shapes above stay as they are. Mirrors the inner's return sites: the one
  // `skipped` is the unresolved install dir; `skipped_concurrent` names
  // whether the live claim was corroborated (the pidfile record carries the
  // full judgement); `failed` carries the error text.
  const bootSyncReason = (result) => {
    if (!result) return "threw";
    switch (result.action) {
      case "failed":
        return result.error || "error";
      case "skipped_concurrent":
        return result.corroborated
          ? "live_server_corroborated"
          : "live_server_unverified";
      case "skipped":
        return "install_dir_unresolved";
      default:
        return null;
    }
  };

  const buildBootReport = ({ result, installedAtBoot }) => {
    const state = channelStore.readState();
    const applied = state.applied || null;
    // What the channel state says SHOULD be running (null for a dev shim —
    // a checkout has no package version to compare against).
    const expected = expectedVersionOf(state);
    const installDir = safeInstallDir();
    const resolvedForLaunch = readInstalledSafely();
    return buildBinPhaseReport({
      bootId: bootReport.bootId || getProcessBootId(),
      at: nowFn(),
      alphaclaw: alphaclawBlock(),
      container: {
        pid1StartTicks: readContainerStartTicks({ fsModule }),
        startMs: readContainerStartMs({ fsModule }),
      },
      pidDecision: result?.pidDecision ?? null,
      openclaw: {
        stateDir: openclawSpawnEnv().OPENCLAW_STATE_DIR || openclawDir,
        declaredPin: readDeclaredPin({ fsModule, packageRoot }),
        channelApplied: applied
          ? `${applied.channel}:${appliedId(applied) ?? "unknown"}`
          : null,
        lastKnownGood: state.lastKnownGood ?? null,
        expected,
        installedAtBoot,
        resolvedForLaunch,
        // The canonical predicate over the tree the gateway will RUN — the
        // same answer getChannelInfo().installedDiverged gives, pinLag excuse
        // included — so the boot-report verdict never re-derives it. null
        // when either side is unknown (the verdict rule then knows the
        // predicate was not evaluated rather than reading "not diverged").
        installedDiverged:
          expected && resolvedForLaunch
            ? computeInstalledDiverged(state, resolvedForLaunch, { now: nowFn() })
            : null,
        overlayPresent:
          expected && typeof channelStore.overlayPresent === "function"
            ? channelStore.overlayPresent(expected)
            : null,
        overlayComplete: expected ? channelStore.hasOverlay(expected) : null,
        sentinelMatches:
          expected && installDir
            ? !channelStore.needsActivation({ installDir, expectedVersion: expected })
            : null,
      },
      bootSync: {
        action: result?.action ?? "failed",
        reason: bootSyncReason(result),
        warnings: Array.isArray(result?.warnings) ? result.warnings : [],
        // { closedRuns: operationId[], closedLastUpdateRun } once the bin-phase
        // closer ran; null when this boot never reached it (skipped_concurrent,
        // an early throw). The server phase unions this into
        // serverPhase.danglingRecords — the list a reader should consult.
        danglingRecords: bootDanglingRecords,
      },
    });
  };

  // The refusal predicate bin/alphaclaw.js applies to this result (F004): a
  // corroborated live owner → exit 1 before any server phase. Mirrored here
  // so the report lands where a doomed second instance cannot evict the
  // live server's report; an UNVERIFIED skip boots on and stays in the ring
  // (its server phase — or pidfile_contradiction — is still to come).
  const isRefusedStart = (result) =>
    result?.action === "skipped_concurrent" && result.corroborated === true;

  const writeBootReportSafely = (context) => {
    if (!bootReport || typeof bootReport.writeBinPhase !== "function") return;
    try {
      const report = buildBootReport(context);
      if (isRefusedStart(context.result) && typeof bootReport.writeRefusedBinPhase === "function") {
        bootReport.writeRefusedBinPhase(report, kPidfileSkipReason);
      } else {
        bootReport.writeBinPhase(report);
      }
    } catch (error) {
      log(`boot report not written (${error?.message || error})`);
    }
  };

  const syncAtBoot = () => {
    const installedAtBoot = readInstalledSafely();
    bootDanglingRecords = null;
    let result = null;
    try {
      result = syncAtBootInner();
      return result;
    } finally {
      // Runs on the throw path too (result null → action "failed", reason
      // "threw"); a finally that neither returns nor throws leaves the
      // try's return value — and any exception — exactly as they were.
      writeBootReportSafely({ result, installedAtBoot });
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
        s.lastKnownGood.devCheckoutDir = s.applied.checkoutDir || checkoutDir;
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
          `🟢 OpenClaw ${appliedId(state.applied)} is healthy — activation verified.${describeNoBackupConsentOutcome(acceptedOperationId)}`,
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

  // Issue #76 RC4: a rollback blocklists the RECORDED build (applied, or the
  // pin under its window) — which is only honest when that build is what
  // crashed. getChannelInfo().installedDiverged (dev-safe: a dev apply's tree
  // is never "expected"; pin-lag-safe) says the live tree is something else:
  // refuse instead of blocklisting a build that was not running. The
  // watchdog treats the refusal as unhandled; the structural path (Stage 3,
  // which honours the record by activating it) owns that shape.
  const divergedRollbackRefusal = ({ reason, exitCode }) => {
    const info = getChannelInfo();
    if (!info.installedDiverged) return null;
    const recorded = info.applied ? "recorded applied" : "recorded pinned";
    log(
      `rollback refused: installed ${info.installedVersion} is not the ${recorded} build ${info.expectedVersion} (${reason})`,
    );
    logEvent("channel_rollback", "refused", {
      code: "installed_diverged",
      installed: info.installedVersion,
      expected: info.expectedVersion,
      reason,
      exitCode,
    });
    return channelError(
      "installed_diverged",
      `The crashing build (${info.installedVersion}) is not the ${recorded} build (${info.expectedVersion}) — refusing to blocklist a build that was not running.`,
      `Restart AlphaClaw to re-activate ${info.expectedVersion}, or open the Upgrade page.`,
      null,
      {
        installedVersion: info.installedVersion,
        expectedVersion: info.expectedVersion,
      },
    );
  };

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
      return (
        divergedRollbackRefusal({ reason, exitCode }) ||
        requestPinRollback({ state, reason, exitCode })
      );
    }
    const blockedId = appliedId(applied);
    const diverged = divergedRollbackRefusal({ reason, exitCode });
    if (diverged) return diverged;
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
  // `installedVersion` is the caller's (watchdog's) view of the running tree,
  // recorded on the event for the audit trail; the gate below re-reads the
  // authoritative value itself.
  // The marker-writing tail both selection paths share (blocklist and
  // schema-driven, below): one-shot latch per build, blocklist clear for a
  // blocklisted pick, marker, event, notification, restart.
  const dispatchForwardRecovery = ({
    state,
    entry,
    exitCode,
    installedVersion,
    observedInstalledVersion,
    selection,
  }) => {
    const blocklisted = entry.blocklisted !== false;
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
        selection,
      });
      const exhaustedMessage =
        `🔴 No bootable OpenClaw version: the built-in ${state.pinVersion} cannot read the migrated state, ` +
        `and the forward build ${entry.id} already failed once. Manual recovery needed — see the Upgrade page ` +
        (blocklisted
          ? `(restore the newest openclaw-backup archive, or Clear ${entry.id}'s blocklist entry to retry it).`
          : `(restore the newest openclaw-backup archive, or re-apply ${entry.id} to retry it).`);
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
        clearedEntry: blocklisted ? entry : null,
        selection,
      };
      return s;
    });
    if (blocklisted) channelStore.clearBlocklist(entry.id);
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
        selection,
      });
      return channelError(
        "rollback_marker_write_failed",
        `Could not write the forward-recovery marker: ${written.error}`,
        "Free disk space on the data volume, then restart AlphaClaw.",
      );
    }
    logEvent("forward_recovery", "requested", {
      ...marker,
      installedVersion,
      observedInstalledVersion,
      selection,
    });
    const message =
      `🟠 The built-in OpenClaw ${state.pinVersion} cannot boot${exitCode != null ? ` (exit ${exitCode})` : ""} ` +
      `and the state was already migrated forward — moving forward to ${entry.id}, which can read it. ` +
      (blocklisted
        ? `Its blocklist entry was cleared; this is attempted once. AlphaClaw is restarting.`
        : `It was chosen because its schema matches the migrated databases; this is attempted once. AlphaClaw is restarting.`);
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
  };

  const requestForwardRecovery = ({
    exitCode = null,
    installedVersion: observedInstalledVersion = null,
  } = {}) => {
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
      // Issue #76 RC4: "the pin is running" is a fact about the INSTALLED
      // tree, not about `applied` — a recorded apply that never activated
      // (stale-pidfile skip, npm lag) leaves the pin live with `applied`
      // set, and that pin may only be able to move forward. A dev apply is
      // refused outright: its pin tree is the dormant fallback, not a build
      // whose crash says anything about the migrated state.
      if (state.applied?.channel === "dev") {
        return channelError(
          "not_pin",
          "Forward recovery only applies when the built-in pin is running (a dev build is applied).",
        );
      }
      if (!state.pinVersion) {
        return channelError("no_pin", "No pin version recorded.");
      }
      const installedVersion = readInstalledVersionSafe();
      if (installedVersion !== state.pinVersion) {
        return channelError(
          "not_pin",
          `Forward recovery only applies when the built-in pin is running (installed ${installedVersion || "unknown"}, pin ${state.pinVersion}).`,
        );
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
      return dispatchForwardRecovery({
        state,
        entry,
        exitCode,
        installedVersion,
        observedInstalledVersion,
        selection: "blocklist",
      });
    } catch (error) {
      return channelError("forward_recovery_failed", error.message);
    }
  };

  // Second, schema-driven selection path (#76 B1.4): when no blocklisted
  // newer build qualifies, any newer COMPLETE overlay the schema table says
  // can open the current databases — confirmed by the boot prober — is a
  // forward candidate too: the migrated state names the build that wrote it
  // whether or not that build ever crashed here. Async because the chooser
  // is (dist scan + prober); the sync requestForwardRecovery above keeps its
  // contract for the watchdog's inline exit-78 call, so a caller that can
  // await gets both paths here and a caller that cannot still gets the first.
  const requestForwardRecoveryAsync = async (payload = {}) => {
    const first = requestForwardRecovery(payload);
    if (first.ok || first.code !== "no_forward_candidate") return first;
    const prober = createBootPreflightProber();
    try {
      const state = channelStore.readState();
      const installedVersion = readInstalledVersionSafe();
      const overlays = channelStore
        .listOverlays()
        .filter(
          (version) =>
            compareVersionParts(version, state.pinVersion) > 0 &&
            !channelStore.isBlocklisted(version),
        );
      if (overlays.length === 0) return first;
      const chosen = await chooseBootableVersion({
        expected: null,
        lastKnownGood: null,
        overlays,
        userVersions: await currentUserVersions(),
        table: schemaTable,
        ...chooserOracles(prober),
      });
      if (!chosen) {
        return channelError(
          "no_forward_candidate",
          "No newer local build can read the migrated state databases.",
        );
      }
      return dispatchForwardRecovery({
        state,
        entry: {
          id: chosen.version,
          blocklisted: false,
          source: chosen.source,
          confirmed: chosen.confirmed,
        },
        exitCode: payload.exitCode ?? null,
        installedVersion,
        observedInstalledVersion: payload.installedVersion ?? null,
        selection: "schema",
      });
    } catch (error) {
      return channelError("forward_recovery_failed", error.message);
    } finally {
      prober.cleanup();
    }
  };

  // ---------------------------------------------------------------------
  // Explicit apply flow (prepare + verify + record + restart)
  // ---------------------------------------------------------------------

  const stepRecorder = (operationId, sink = null, { mirrorLastUpdateRun = true } = {}) => {
    const steps = [];
    // One row → the SSE `step` event (the client appends it; its collapsed
    // model keeps the latest status/detail per name) and the two durable
    // copies of steps[] (channel state's lastUpdateRun, the run ledger).
    const publishStep = (entry) => {
      try {
        if (operationEvents && operationId) {
          operationEvents.publish(operationId, {
            event: "step",
            data: entry,
          });
        }
      } catch {}
    };
    const persistSteps = () => {
      // The channel state's lastUpdateRun mirror is the APPLY's compatibility
      // pointer; backups and repairs record only into their own ledger run.
      // A stale recorder never rewrites a successor's compatibility pointer.
      if (mirrorLastUpdateRun) {
        try {
          channelStore.updateState((s) => {
            if (s.lastUpdateRun?.operationId === operationId) s.lastUpdateRun.steps = steps;
            return s;
          });
        } catch {}
      }
      try {
        ledger.updateRun(operationId, (record) => {
          record.steps = steps;
          return record;
        });
      } catch {}
    };
    const emit = (name, status, detail = {}) => {
      // Core fields LAST so a detail key (e.g. the updater's own status) can
      // never clobber the step's status — live-verified failure mode where a
      // failed build recorded as "unknown".
      const entry = { ...detail, name, status, at: nowFn() };
      steps.push(entry);
      publishStep(entry);
      persistSteps();
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
    // #79 (h): a progress tick rewrites the LAST row's detail IN PLACE —
    // steps[] never grows from a ticker (a 10-minute backup would otherwise
    // append ~40 rows to the run record). Only a row of the same name that is
    // still `running` qualifies: a warning or failed row is an outcome, never
    // a canvas for a progress line. The rewritten row is republished (same
    // `at`; the client's collapsed model takes the latest detail per name)
    // and re-persisted, so a page reload mid-backup shows the live figure.
    // The sink line and the console line are the ticker's own (backupLog).
    const updateDetail = (name, detail) => {
      const last = steps[steps.length - 1];
      if (!last || last.name !== name || last.status !== "running") return false;
      last.detail = detail;
      publishStep(last);
      persistSteps();
      return true;
    };
    return { steps, emit, updateDetail };
  };

  const checkDiskSpace = (requiredBytes, dir = rootDir) => {
    if (typeof diskSpace === "function") {
      try {
        return diskSpace(requiredBytes, dir);
      } catch {
        return { ok: true, free: null };
      }
    }
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
        if (backupSafetyFailure(error)) return { ok: false, safetyFailure: backupSafetyFailure(error),
          message: `The backup directory could not be created: ${sanitizeForDisplay(error.message)}`,
          hint: "Free disk space, then retry the backup." };
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
      if (backupSafetyFailure(error)) return { ok: false, safetyFailure: backupSafetyFailure(error),
        message: `The backup directory could not be prepared: ${sanitizeForDisplay(error.message)}`,
        hint: "Free disk space, then retry the backup." };
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
    // Only legacy temp siblings of this archive belong to this cleanup.
    // Current attempts remove their private staging root after the process
    // group drains; shared publication directories are not ownership proof.
    try {
      const base = path.basename(outputFile);
      for (const name of readDirectoryNamesBounded(backupsDir, { fsModule })) {
        const full = path.join(backupsDir, name);
        if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
          try {
            fsModule.unlinkSync(full);
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

  // ONE directory scan (lstat — a symlinked archive is never a candidate)
  // behind the size estimate, the newest-archive hints, and the inventory.
  const scanBackupArchives = () => {
    let names;
    try {
      names = readDirectoryNamesBounded(backupsDir, { fsModule });
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
    // Ties are not hypothetical: two archives written in the same millisecond
    // (and every fixture that writes a directory in one go) leave `sort`
    // stable, so "newest" would fall back to readdir order — inode order on
    // ext4/overlayfs, near-alphabetical on APFS — and the archive a refusal
    // names as the manual recovery artifact would differ per filesystem. The
    // name carries the timestamp (`openclaw-backup-<ts>-<opId8>`), so the
    // greater name is the newer artifact.
    entries.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
    );
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
  const isFreshStateTree = (root = stateDir()) => {
    try {
      if (enumerateStateDbs(root).length > 0) return false;
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

  // Prior-run calibration (Codex 16): each rung's rate comes from the newest
  // successful run of the SAME rung, never the other — predicting the
  // upstream from a copy's wall time (or the copy from an upstream's) made
  // the verdicts self-reinforcing: one slow step ruled a rung out of every
  // later run's pause. Both readers skip reused records (the archive was not
  // written that run).
  //
  //   upstream   the newest run whose UPSTREAM `backup create` succeeded, and
  //              how long that ONE CLI attempt took (attemptMs — the wall time
  //              around the CLI alone; never the step's durationMs: lock wait,
  //              stop, barrier, backoffs, prune, relaunch) against the state
  //              bytes (DBs + WAL) it snapshotted
  //   copy       the newest run whose AlphaClaw offline copy succeeded:
  //              offlineCopyMs (createOfflineCopy's own wall time) against the
  //              archive bytes it wrote (offlineCopyBytes — the `gzip -1`
  //              output, so the rate under-reads source throughput and the
  //              prediction stays conservative)
  const priorUpstreamThroughput = () => {
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
  const priorOfflineCopyThroughput = () => {
    try {
      for (const run of ledger.listRuns()) {
        const backup = run?.backup;
        if (
          backup &&
          backup.noBackup === false &&
          !backup.reused &&
          backup.producer === kOfflineCopyProducer &&
          backup.profile !== "migration-minimal" &&
          Number.isFinite(backup.offlineCopyMs) &&
          backup.offlineCopyMs > 0 &&
          Number.isFinite(backup.offlineCopyBytes) &&
          backup.offlineCopyBytes > 0
        ) {
          return {
            operationId: run.operationId,
            offlineCopyMs: backup.offlineCopyMs,
            offlineCopyBytes: backup.offlineCopyBytes,
          };
        }
      }
    } catch {}
    return null;
  };

  // tar/gzip get the bare probe env: they need PATH, not gateway secrets.
  const archiveCommandRunner = (spec) =>
    runner.runStreamed({ ...spec, env: probeEnv() });

  // Relative archive paths of this box's state databases — the manifest of a
  // usable archive must list them (WI-6.1).
  const requiredArchivePaths = (root = stateDir()) => {
    return enumerateStateDbs(root).map((dbPath) =>
      path.relative(root, dbPath).split(path.sep).join("/"),
    );
  };

  // The result carries `timedOut` when any stage's command hit OUR timeout:
  // a check that ran out of OUR clock says nothing about the archive, so the
  // caller must not treat it as a verify failure (no quarantine).
  const runUsableCheck = async (file, { timeoutMs, sourceStateDir = stateDir() }) => {
    let timedOut = false;
    const runCommand = async (spec) => {
      const result = await archiveCommandRunner(spec);
      if (result?.timedOut) timedOut = true;
      return result;
    };
    const verified = await verifyArchiveManifest({
      file,
      runCommand,
      requiredArchivePaths: requiredArchivePaths(sourceStateDir),
      stateDir: sourceStateDir,
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
          ...projectBackupSummary(backup),
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
          ...projectBackupSummary(entry),
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
        // A standalone backup run (v0.9.81 "Back up now") activates nothing
        // and rewrites no state: it must never raise the floor — it would
        // fence out every archive, its own included (review P1).
        if (run?.target?.kind === "backup") continue;
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
    let inventoryTruncated = scanned === null;
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
      else if (provenance.partial || provenance.profile === "migration-minimal") ineligibleReason = "partial";
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
        ...projectBackupSummary(provenance),
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
        ...projectBackupSummary(provenance),
        reused: provenance?.reused === true,
        sha256: provenance?.sha256 ?? null,
        mode: provenance?.mode ?? null,
        exists: false,
        operationId: provenance?.operationId ?? null,
        eligible: false,
        ineligibleReason: "missing",
      });
    }
    const checkpointRuns = runs.filter((run) => run.recovery?.checkpoint?.file);
    if (checkpointRuns.length > 8) inventoryTruncated = true;
    for (const run of checkpointRuns.slice(0, 8)) {
      const recovery = projectRecoverySummary(run.recovery);
      if (!recovery?.checkpoint?.file) continue;
      const file = recovery.checkpoint.file;
      if (seen.has(file) || !path.resolve(file).startsWith(`${resolvedDir}${path.sep}`)) continue;
      seen.add(file);
      let exists = false;
      try { exists = fsModule.lstatSync(file).isDirectory(); } catch {}
      const valid = exists && inspectRecoveryCheckpoint(file, { record: run.recovery, backupsDir, fsModule }).ok;
      if (!valid) {
        recovery.checkpoint.verified = false;
        recovery.databases.complete = false;
        recovery.databases.verified = false;
        recovery.restore = { configAvailable: false, databaseSetAvailable: false };
      }
      entries.push({ file, name: path.basename(file), producer: "alphaclaw-checkpoint", profile: recovery.kind,
        sizeBytes: recovery.checkpoint.bytes, at: run.startedAt ?? run.createdAt ?? 0,
        operationId: run.operationId, recovery, verified: valid,
        exists, eligible: false, ineligibleReason: "checkpoint", partial: recovery.kind !== "database_set" });
    }
    try {
      for (const name of readDirectoryNamesBounded(backupsDir, { fsModule })) {
        if (!/^recovery-[0-9a-f-]{36}$/.test(name)) continue;
        const file = path.join(backupsDir, name);
        if (seen.has(file)) continue;
        const stat = fsModule.lstatSync(file);
        if (!stat.isDirectory()) continue;
        entries.push({ file, name, producer: "alphaclaw-checkpoint", profile: "unverified",
          sizeBytes: null, at: stat.mtimeMs, operationId: null, recovery: null, verified: false,
          exists: true, eligible: false, ineligibleReason: "no_provenance" });
      }
    } catch (error) {
      if (error.code !== "ENOENT" || fsModule.existsSync(backupsDir)) inventoryTruncated = true;
    }
    entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const capped = entries.slice(0, kOpenclawBackupInventoryMaxEntries);
    return {
      backupsDir,
      readable: scanned !== null,
      entries: capped,
      truncated: inventoryTruncated || entries.length > capped.length,
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
      return selectMigrationBackupProtection(ledger.listRuns(), { nowMs: nowFn() }).pinnedArchiveFiles;
    } catch {
      return [];
    }
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
  // silently stop this sweep from matching. Runs at the start of every
  // runBackup, from pruneBackups, and as the directory arm of the boot sweep
  // (sweepBackupDebris boot mode). Returns the dirs it removed.
  const sweepStaleOfflineCopyDirs = async () => {
    const removed = [];
    let names = [];
    try {
      names = readDirectoryNamesBounded(backupsDir, { fsModule });
    } catch {
      return removed;
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
      const ageMs = nowFn() - st.mtimeMs;
      backupLog(
        `[openclaw-update] backup: removing stale offline-copy temp dir ${full} (${formatAge(ageMs)} old)`,
      );
      await removeBackupDebris(full);
      removed.push({ name, ageMs });
    }
    return removed;
  };

  // #79 (g): `.tmp` hygiene. Both producers stage their archive as
  // `<output>.<uuid>.tmp` beside its final name and remove it on every exit
  // path of their own; a crash, an OOM kill or the platform's SIGKILL does
  // not (the 2026-09 incident: an 8 GB `.tmp` younger than 20 minutes at the
  // next boot, which the age-gated sweeps of the day left alone). Two modes:
  //   boot     nothing can be in flight, so: EVERY `.tmp` regardless of age
  //            (pruneBackups' unconditional temp removal, applied at boot),
  //            every `.unverified` quarantine but the newest (kept for
  //            diagnosis, as prune keeps it) and the stale `.offline-copy-*`
  //            staging dirs. Runs synchronously inside
  //            runOnboardedBootSequence under the boot lifecycle lock, before
  //            startGateway, and only when the pidfile decision found no
  //            live owner (Codex 18): applies are refused while booting and
  //            a quiesced backup cannot take the lock, so no `.tmp` is live.
  //   in-run   from a FAILURE finisher (finishFailure, finishNoArtifact)
  //            while another CLI run may exist on the box: only `.tmp` older
  //            than the CLI ceiling plus slack (cliTimeoutMs +
  //            staleTempDirSlackMs); a younger one may still be written.
  //            Never inside the quiesce (sweepDebrisInRun defers it).
  // lstat only — a symlink is never followed and never removed; an
  // operator's stray file matches neither suffix; a failed unlink is logged
  // per file and carried on the summary (F008), never thrown into a boot or
  // a 409. A missing backups dir is the fresh-box state, not an error.
  //   → { mode, removed: [{ name, bytes, why }], removedBytes, kept: [name],
  //       errors: [{ name, error }] }
  const kBackupDebrisModes = Object.freeze(["boot", "in-run"]);
  const sumDirBytesForSweep = (dir) => {
    let bytes = 0;
    try {
      for (const name of fsModule.readdirSync(dir)) {
        try {
          const st = fsModule.lstatSync(path.join(dir, name));
          if (st.isFile()) bytes += st.size;
        } catch {}
      }
    } catch {}
    return bytes;
  };
  const sweepBackupDebris = async ({ mode } = {}) => {
    if (!kBackupDebrisModes.includes(mode)) {
      throw new TypeError(`sweepBackupDebris: unknown mode ${JSON.stringify(mode)}`);
    }
    const boot = mode === "boot";
    const summary = { mode, removed: [], removedBytes: 0, kept: [], errors: [] };
    let names = [];
    try {
      names = readDirectoryNamesBounded(backupsDir, { fsModule });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        summary.errors.push({ name: null, error: error.message });
        log(`backup debris sweep (${mode}) skipped: ${error.message}`);
      }
      return summary;
    }
    const staleTempBeforeMs =
      nowFn() - (backupBudget.phaseEnvelopeMs + backupBudget.staleTempDirSlackMs);
    const removeFile = async (name, bytes, why) => {
      const full = path.join(backupsDir, name);
      try {
        await (fsModule.promises || fs.promises).rm(full, { force: true });
        summary.removed.push({ name, bytes, why });
        summary.removedBytes += bytes;
      } catch (error) {
        summary.errors.push({ name, error: error.message });
        log(`backup debris sweep (${mode}) could not remove ${full}: ${error.message}`);
      }
    };
    const unverified = [];
    for (const name of names) {
      let st;
      try {
        st = fsModule.lstatSync(path.join(backupsDir, name));
      } catch {
        continue;
      }
      if (st.isDirectory() && (name.startsWith(kCliPublishStagingPrefix) || /^\.recovery-[0-9a-f-]{36}\.staging$/.test(name))) {
        // The 2026.9.x CLI's publish staging dir (v0.9.81): same age rule as
        // a `.tmp` — a killed/stalled CLI leaves it behind.
        if (boot || st.mtimeMs <= staleTempBeforeMs) {
          const bytes = sumDirBytesForSweep(path.join(backupsDir, name));
          try {
            await removeBackupDebris(path.join(backupsDir, name));
            summary.removed.push({ name, bytes, why: boot ? "boot" : "stale" });
            summary.removedBytes += bytes;
          } catch (error) {
            summary.errors.push({ name, error: error.message });
          }
        } else {
          summary.kept.push(name);
        }
        continue;
      }
      if (!st.isFile()) continue;
      if (name.endsWith(".tmp")) {
        if (boot || st.mtimeMs <= staleTempBeforeMs) {
          await removeFile(name, st.size, boot ? "boot" : "stale");
        } else {
          summary.kept.push(name);
        }
      } else if (boot && name.endsWith(".unverified")) {
        unverified.push({ name, mtime: st.mtimeMs, bytes: st.size });
      }
    }
    if (boot) {
      unverified.sort((a, b) => b.mtime - a.mtime);
      for (const entry of unverified.slice(1)) {
        await removeFile(entry.name, entry.bytes, "unverified_superseded");
      }
      for (const dir of await sweepStaleOfflineCopyDirs()) {
        summary.removed.push({ name: dir.name, bytes: null, why: "stale_offline_copy_dir" });
      }
    }
    if (summary.removed.length > 0 || summary.errors.length > 0) {
      log(
        `backup debris sweep (${mode}): removed ${summary.removed.length} item${
          summary.removed.length === 1 ? "" : "s"
        } (${formatBackupBytes(summary.removedBytes)} of files)${
          summary.kept.length ? `, kept ${summary.kept.length} younger .tmp` : ""
        }${summary.errors.length ? `, ${summary.errors.length} could not be removed` : ""}`,
      );
    }
    if (boot) await pruneBackups();
    return summary;
  };

  // Retention with strict name classes. Only files this code (or the CLI)
  // named are retention's business — an operator's stray file in the
  // directory is never deleted, and debris (temps, quarantined .unverified
  // archives, stale offline-copy temp dirs) can never evict a verified backup
  // by being newer. The archive a still-fenced migrating run recorded is
  // exempt from eviction (WI-4.2).
  // Async: archives are multi-GB and this runs on the live event loop.
  const pruneBackups = async ({ keepPaths = [], deadline = Infinity } = {}) => {
    let names = [];
    try {
      names = readDirectoryNamesBounded(backupsDir, { fsModule });
    } catch (error) {
      // A silent retention failure is issue #9's disk-fill all over again.
      log(`backup prune skipped: ${error.message}`);
      return;
    }
    const pinned = new Set([...pinnedArchivePaths(), ...keepPaths]);
    const unverified = [];
    const temps = [];
    for (const name of names) {
      const full = path.join(backupsDir, name);
      let mtime = 0;
      let bytes = 0;
      try {
        const st = fsModule.lstatSync(full);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
        bytes = st.size || 0;
      } catch {
        continue;
      }
      if (name.endsWith(".tmp")) temps.push({ full, mtime, bytes });
      else if (name.endsWith(".unverified")) unverified.push({ full, mtime, bytes });
    }
    const remove = (file) => nowFn() < deadline ? removeBackupDebris(file) : Promise.resolve();
    const newestFirst = (entries) => entries.sort((a, b) => b.mtime - a.mtime);
    for (const entry of newestFirst(unverified).slice(1)) {
      await remove(entry.full);
    }
    // Temps are crash debris — the CLI removes its own on every exit path.
    for (const entry of temps) {
      await remove(entry.full);
    }
    if (nowFn() < deadline) await sweepStaleOfflineCopyDirs();
    const checkpoints = [];
    for (const run of ledger.listRuns()) {
      const recovery = run.recovery;
      const file = recovery?.checkpoint?.file;
      if (!file || !inspectRecoveryCheckpoint(file, { record: recovery, backupsDir, fsModule }).ok) continue;
      if (["running", "restart_expected"].includes(run.state)) pinned.add(file);
      checkpoints.push({ file, at: run.startedAt || 0, kind: recovery.kind === "database_set" ? "database_set" : "config_only" });
    }
    for (const kind of ["config_only", "database_set"]) {
      const ordered = checkpoints.filter((entry) => entry.kind === kind).sort((a, b) => b.at - a.at);
      for (const entry of ordered.slice(3)) if (!pinned.has(entry.file)) await remove(entry.file);
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

  // The state dir the INSTALLED CLI actually uses: OPENCLAW_STATE_DIR from the
  // spawn env when set (gatewayEnv pins it to OPENCLAW_DIR in production, an
  // operator override wins elsewhere), else openclawDir.
  const stateDir = (snapshot) => {
    let env = snapshot;
    try { env ??= openclawSpawnEnv(); } catch {}
    return resolveBackupPath(env?.OPENCLAW_STATE_DIR, { spawnEnv: env || {}, fallback: openclawDir });
  };

  // State databases OpenClaw 2026.8 may migrate: the global control-plane DB
  // (kind "state") and every per-agent data-plane DB (kind "agent",
  // docs/reference/database-schemas.md). The two kinds carry DIFFERENT
  // schema lines (2026.9.2: state 15, agent 19), and upstream's `database
  // preflight` verb compares a file with the STATE schema only — feeding it an
  // agent DB produced the false "incompatible" of issue #78. Every consumer
  // that hands a path to that verb must filter on `kind`; agent DBs are
  // judged by assessAgentDb below.
  const enumerateStateDbEntries = (root = stateDir()) => {
    const entries = [];
    const globalDb = path.join(root, "state", "openclaw.sqlite");
    if (fsModule.existsSync(globalDb)) {
      entries.push({ path: globalDb, kind: "state", agentId: null });
    }
    const agentsDir = path.join(root, "agents");
    try {
      for (const agentId of fsModule.readdirSync(agentsDir)) {
        const agentDb = path.join(
          agentsDir,
          agentId,
          "agent",
          "openclaw-agent.sqlite",
        );
        if (fsModule.existsSync(agentDb)) {
          entries.push({ path: agentDb, kind: "agent", agentId });
        }
      }
    } catch {}
    return entries;
  };
  // Flat path list for size accounting and the fresh-tree predicate — never
  // for the state-schema verb (see enumerateStateDbEntries).
  const enumerateStateDbs = (root = stateDir()) =>
    enumerateStateDbEntries(root).map((entry) => entry.path);
  // Operator-facing name for a DB entry, relative to the state dir
  // ("agents/main/agent/openclaw-agent.sqlite").
  const dbEntryLabel = (entry) => {
    const relative = path.relative(stateDir(), entry.path);
    return relative && !relative.startsWith("..") ? relative : entry.path;
  };

  // Which schema line does build `version` (whose package lives at
  // packageDir) support? Declared constants from ITS OWN dist are the only
  // authority (Codex D7); the learned/seeded table answers per kind when the
  // dist declares nothing (a pre-2026.8 build, a scan-budget skip). null =
  // unknown → callers fail open with a loud warning, never a guess.
  const mergeSupportedSchema = (declared, version, buildId = version) => {
    const fromTable = version
      ? schemaTable.supportedFor(version, { buildId })
      : { state: null, agent: null, source: null };
    const pick = (kind) => {
      if (declared?.unknownKinds?.includes(kind)) return { value: null, source: null, unknown: true };
      if (declared && declared[kind] != null) {
        return { value: declared[kind], source: "declared" };
      }
      if (fromTable[kind] != null) {
        return { value: fromTable[kind], source: fromTable.source };
      }
      return { value: null, source: null, unknown: fromTable.unknownKinds?.includes(kind) };
    };
    const state = pick("state");
    const agent = pick("agent");
    return {
      state: state.value,
      agent: agent.value,
      source: { state: state.source, agent: agent.source },
      ...((state.unknown || agent.unknown) ? { unknownKinds: kSupportedSchemaKinds.filter((kind) => (kind === "state" ? state : agent).unknown) } : {}),
    };
  };
  // Sync form: bin-phase callers only (chooseBootRollbackTarget's prober) —
  // the dist scan's pass-2 fallback may read up to 16 MB.
  const kSupportedSchemaKinds = ["state", "agent"];
  const supportedSchemaSync = ({ packageDir = null, version = null, buildId = version } = {}) =>
    mergeSupportedSchema(
      packageDir ? resolveDeclaredSchemaVersions(packageDir, { fsModule }) : null,
      version,
      buildId,
    );
  const supportedSchemaAsync = async ({ packageDir = null, version = null, buildId = version } = {}) =>
    mergeSupportedSchema(
      packageDir
        ? await resolveDeclaredSchemaVersionsAsync(packageDir, { fsModule })
        : null,
      version,
      buildId,
    );
  // The executing tree's declaration, memoized by full build identity and
  // package path and freshly read public metadata: dev commits can share a
  // package version, and malformed metadata must defeat an already warm memo.
  // The legacy scan
  // is the expensive half (pass 2 may read 16 MB), while the learned
  // table is merged FRESH on every call (it can gain an entry after an apply)
  // and user_versions are never cached at all (WAL keeps a write in the -wal
  // until checkpoint, so DB mtimes are not a valid key). A rejected scan is
  // not memoized. A single memo entry bounds memory across dev updates.
  let declaredForInstalledMemo = null; // { version, buildId, packageDir, metadataKey, promise }
  const declaredSchemaForInstalled = ({ packageDir, version, buildId = version }) => {
    const metadata = readSchemaMetadata(packageDir, { fsModule });
    const metadataKey = JSON.stringify(metadata);
    const memo = declaredForInstalledMemo;
    if (memo && memo.buildId === buildId && memo.packageDir === packageDir && memo.metadataKey === metadataKey) {
      return memo.promise;
    }
    const publicDeclaration = metadataDeclaration(metadata);
    const declaration = publicDeclaration
      ? Promise.resolve(publicDeclaration)
      : resolveDeclaredSchemaVersionsAsync(packageDir, { fsModule });
    const promise = declaration.then((declared) => {
      try {
        // A legacy scan begun before a new public declaration must not
        // overwrite the newer valid/explicit-unknown persisted authority.
        if (declaredForInstalledMemo?.promise === promise) schemaTable.recordDeclared(version, declared, { buildId });
      } catch (error) {
        log(`schema declaration for ${buildId} could not be recorded (${error?.message || error})`);
      }
      return declared;
    }).catch(
      (error) => {
        if (declaredForInstalledMemo?.promise === promise) declaredForInstalledMemo = null;
        log(`declared schema scan of ${version} failed (${error?.message || error})`);
        return null;
      },
    );
    declaredForInstalledMemo = { version, buildId, packageDir, metadataKey, promise };
    return promise;
  };
  const supportedSchemaForInstalledTree = async ({ packageDir = null, version = null, buildId = version } = {}) =>
    packageDir && version
      ? mergeSupportedSchema(await declaredSchemaForInstalled({ packageDir, version, buildId }), version, buildId)
      : supportedSchemaAsync({ packageDir, version, buildId });
  const getExecutingBuild = async () => {
    const build = executingBuild();
    return build ? { ...build, schemas: await supportedSchemaForInstalledTree(build) } : null;
  };
  // Which schema line does the tree on disk support right now? The runtime
  // relaunch step (Stage 3 I3) and the boot gate share this one reader.
  //   { state, agent, source: { state, agent } }
  const getSupportedSchemaForInstalled = async () => {
    return (await getExecutingBuild())?.schemas ?? { state: null, agent: null, source: { state: null, agent: null } };
  };

  // Judge one agent DB (or a snapshot of it) against a build's supported
  // agent schema: PRAGMA user_version IS the agent schema (issue #78's own
  // evidence). { verdict: "exact" | "migration-required" | "incompatible" |
  // "unknown", foundVersion, targetVersion, read } — `read` is the raw
  // readSqliteUserVersion result so callers can name a corrupt/busy DB.
  // `open` defaults to the tracked read-only handle (quiet-barrier accounting)
  // for live DBs; snapshot callers pass nothing special either — a tracked
  // handle on a temp copy is harmless.
  const assessAgentDb = (dbPath, targetAgentSchema, { open = openTrackedReadonlyDatabase } = {}) => {
    const read = readSqliteUserVersion(dbPath, { open, fsModule });
    const foundVersion = read.status === "ok" ? read.userVersion : null;
    const targetVersion = Number.isInteger(targetAgentSchema) ? targetAgentSchema : null;
    return {
      verdict: compareSchema({ found: foundVersion, target: targetVersion }),
      foundVersion,
      targetVersion,
      read,
    };
  };
  const kAgentTargetUnknownWarning =
    "agent database compatibility not checked — the target build's agent schema version could not be determined";

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

  const recoveryInventory = async (checkpoint = () => {}) => {
    const spawnEnv = Object.freeze({ ...openclawSpawnEnv() });
    const inventory = await buildRecoveryInventory({ stateDir: stateDir(spawnEnv), spawnEnv, fsModule, checkpoint });
    if (inventory.configPath !== path.join(inventory.stateDir, "openclaw.json") || inventory.stateDir !== fsModule.realpathSync(openclawDir)) {
      throw Object.assign(new Error("Recovery orchestration does not support this configuration selector"), { code: "RECOVERY_INVENTORY_UNSUPPORTED" });
    }
    return inventory;
  };
  const inspectRecoveryTarget = async (packageDir, version, inventory) => {
    const supported = await supportedSchemaAsync({ packageDir, version });
    return inspectRecoveryDatabases({ inventory, supported, timeoutMs: 5000 });
  };
  const runDatabasePreflight = async ({ version, emit = () => {}, packageDirOverride = null }) => {
    emit("db-preflight", "running");
    const inventory = await recoveryInventory();
    const verdict = await inspectRecoveryTarget(packageDirOverride || channelStore.overlayPackageDir(version), version, inventory);
    emit("db-preflight", verdict.ok ? "completed" : "failed");
    return verdict.ok ? { ok: true, verdict } : { ok: false, verdict,
      error: channelError("db_preflight_failed", "The target database compatibility could not be established.", "Choose a supported compatible build; recovery consent cannot override this check.", null, { preflight: verdict }) };
  };
  const startRecovery = (intent, recoveryHold = null) => beginRecoveryOperation({
    acquire: ({ leaseMs }) => (acquireLifecycleLock || localApplyLock.acquire)(intent === kGatewayMutationIntents.backup ? "backup_quiesce" : "apply_commit", { leaseMs }),
    gateway: gatewayQuiesce, quiet: dbQuiet, resume: dbResume,
    assertPolicy: (hold) => applyCommitPolicy.assert({ hold, intent, recoveryHold }),
    acquireTimeoutMs: backupBudget.quiesceLockTimeoutMs,
    readinessTimeoutMs: backupBudget.postQuiesceReadyTimeoutMs,
    readinessPollMs: backupBudget.postQuiescePollMs,
  });
  const checkRecoverySpace = async (recoveryMode) => {
    const inventory = await recoveryInventory();
    let bytes = inventory.totalBytes;
    if (recoveryMode === "database_set") {
      for (const db of inventory.dbs) {
        bytes += db.bytes;
        for (const suffix of ["-wal", "-journal"]) {
          try { bytes += fsModule.statSync(`${db.sourcePath}${suffix}`).size; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
    }
    let destination = backupsDir;
    while (!fsModule.existsSync(destination) && path.dirname(destination) !== destination) destination = path.dirname(destination);
    if (!checkDiskSpace(bytes * 2 + 64 * 1024 * 1024, destination).ok) {
      throw Object.assign(new Error("Insufficient recovery checkpoint disk space"), { code: "insufficient_disk" });
    }
  };
  const captureRecovery = async ({ transaction, operationId, sourceBuild, targetBuild, recoveryMode, emit = () => {}, updateDetail = () => {} }) => {
    transaction.assert();
    emit("backup", "running", { detail: recoveryMode === "database_set" ? "Capturing configuration and the complete database set" : "Capturing configuration; databases are not copied" });
    try {
      const inventory = await recoveryInventory(() => transaction.assert());
      transaction.assert();
      const recovery = await createRecoveryCheckpoint({ inventory, backupsDir, operationId, sourceBuild, targetBuild,
        includeDatabases: recoveryMode === "database_set", fsModule, nowFn,
        isLeaseValid: transaction.isLeaseValid, isQuiet: transaction.isQuiet,
        onProgress: (progress) => updateDetail("backup", progress.phase === "database"
          ? `Database snapshot: ${progress.totalPages - progress.remainingPages} of ${progress.totalPages} pages`
          : `Configuration checkpoint: ${progress.fileCount} files`) });
      transaction.assert();
      if (!ledger.updateRun(operationId, (record) => ({ ...record, recovery }))) throw Object.assign(new Error("Recovery provenance unavailable"), { code: "consent_record_failed" });
      emit("backup", "completed", { detail: recoveryMode === "database_set" ? "Configuration and complete database recovery set verified" : "Configuration checkpoint verified; databases omitted" });
      return recovery;
    } catch (error) {
      emit("backup", "failed", { error: error.code || "recovery_capture_failed" });
      throw error;
    }
  };
  const verifyRecordedRecovery = (operationId) => {
    const recovery = ledger.readRun(operationId)?.recovery;
    if (!recovery) return { valid: false, recovery: null };
    const valid = inspectRecoveryCheckpoint(recovery.checkpoint?.file, { record: recovery, backupsDir, fsModule }).ok;
    if (!valid) {
      recovery.checkpoint = { ...recovery.checkpoint, verified: false };
      recovery.databases = { ...recovery.databases, complete: false, verified: false };
      recovery.restore = { configAvailable: false, databaseSetAvailable: false };
      ledger.updateRun(operationId, (run) => ({ ...run, recovery }));
    }
    return { valid, recovery };
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

  const backupRisk = createBackupRiskCoordinator({
    now: nowFn, fsModule, openclawDir, makeError: channelError,
    describeSource: () => getExecutingBuild(),
    describeTarget: async ({ channel, version, sha, checkoutDir: recordedCheckoutDir }) => {
      const id = channel === "dev" ? sha : version;
      if (!id) return null;
      if (channelStore.isBlocklisted(id)) throw Object.assign(new Error("version blocklisted"), { code: "version_blocklisted" });
      const packageDir = channel === "dev" ? selectedDevCheckout(recordedCheckoutDir) : channelStore.overlayPackageDir(version);
      if (channel === "dev" && (!/^[a-f0-9]{40}$/i.test(sha) || readCheckoutHead(packageDir) !== sha)) return null;
      if (channel !== "dev" && !channelStore.hasOverlay(version)) return null;
      let pkg;
      try { pkg = JSON.parse(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8")); } catch { return null; }
      if (typeof pkg.version !== "string" || (channel !== "dev" && pkg.version !== version)) return null;
      const build = describeBinAt(packageDir, pkg.version, channel === "dev" ? "dev" : "overlay");
      if (!build) return null;
      build.buildId = id;
      return { ...build, schemas: await supportedSchemaAsync(build) };
    },
    readVersions: async (candidate) => {
      const inventory = await recoveryInventory();
      const verdict = await inspectRecoveryDatabases({ inventory, supported: candidate.schemas });
      if (!verdict.ok) throw Object.assign(new Error("Database compatibility is unverified"), { code: "db_preflight_failed" });
      const root = fsModule.statSync(inventory.stateDir);
      return { entries: verdict.perDb.map((entry) => ({ ...entry, path: entry.sourcePath || entry.path,
        kind: entry.dbKind || entry.kind, status: "ok" })), inventory: { stateDir: inventory.stateDir,
          requestedStateDir: inventory.requestedStateDir, rootIdentity: { dev: root.dev, ino: root.ino },
          configPath: inventory.configPath, configDigest: inventory.configDigest,
          files: inventory.files.map((file) => ({ path: file.sourcePath, identity: file.sourceIdentity })) } };
    },
    getChannelInfo: () => getChannelInfo(),
    isQuiet: () => isStateDbQuiet(),
    canIssue: () => !applyInProgress,
    checkDisk: ({ channel }) => checkDiskSpace(channel === "dev" ? kOpenclawDevMinDiskBytes : kOpenclawPackageMinDiskBytes).ok &&
      (channel === "dev" || checkDiskSpace(kOpenclawPackageMinDiskBytes, os.tmpdir()).ok),
    assertPolicy: ({ hold, intent, recoveryHold, strict }) => {
      let selfUpdating = false;
      try { selfUpdating = isSelfUpdateInProgress(); } catch {
        if (strict) throw Object.assign(new Error("self update status unavailable"), { code: "self_update_unverified" });
      }
      if (selfUpdating) throw Object.assign(new Error("An AlphaClaw update or unresolved provider deployment blocks this operation. Check the provider and resolve its attempt before retrying."), { code: "self_update_in_progress" });
      if (hold) return applyCommitPolicy.assert({ hold, intent, recoveryHold });
      // Preparation/issuance is read-only and owns no lease. It may inspect
      // its own apply latch and a backed-up recovery's original hold. Other
      // holds and corrupt authority refuse; mutation uses the owned policy.
      const info = getChannelInfo();
      if (info.stateCorrupted || (info.gatewayHold && !["recovery_choice_required", "recovery_intent_stale", "recovery_review"].includes(info.gatewayHold.reason) && !matchesApplyRecoveryHold({
        intent, recoveryHold, gatewayHold: info.gatewayHold,
      }))) throw Object.assign(new Error("gateway held"), { code: info.stateCorrupted ? "state_corrupted" : "gateway_held" });
    },
    readRun: (operationId) => ledger.readRun(operationId),
  });
  const preparingDevPaths = new Set();
  const prunePreparedDevBuilds = async () => {
    const state = channelStore.readState();
    if (state.corrupted) throw Object.assign(new Error("Candidate retention authority is unreadable"), { code: "dev_candidate_cleanup_required" });
    const build = executingBuild();
    const keepPaths = [build?.source === "dev" ? build.packageDir : null, state.applied?.checkoutDir,
      state.previousDev?.checkoutDir, state.lastKnownGood?.devCheckoutDir, state.recoveryReview?.sourceBuild?.packageDir,
      ...preparingDevPaths, ...backupRisk.protectedTargets().map((target) => target.checkoutDir || target.packageDir)];
    for (const run of ledger.listRuns()) {
      if (run.state !== "restart_expected" && !run.recoveryReview?.active) continue;
      keepPaths.push(run.target?.checkoutDir, run.recoveryIntent?.target?.checkoutDir, run.recoveryIntent?.target?.packageDir,
        run.recovery?.checkpoint?.sourceBuild?.packageDir, run.recovery?.checkpoint?.targetBuild?.packageDir);
    }
    try { return await pruneDevCandidates({ checkoutDir, keepPaths: keepPaths.filter(Boolean), keepRecent: 3, fsModule }); }
    catch { throw Object.assign(new Error("Candidate storage could not be safely cleaned"), { code: "dev_candidate_cleanup_required" }); }
  };
  const requestBackupRiskConsent = (options) => backupRisk.request(options);
  const persistRecoveryReview = ({ operationId, sourceBuild, sourceFingerprint, wasRunning, expectedHold, inventory, detail = null }) => {
    const previous = channelStore.readState().recoveryReview;
    const saved = channelStore.updateState((state) => {
      if (JSON.stringify(state.gatewayHold) !== JSON.stringify(expectedHold)) {
        throw Object.assign(new Error("Gateway hold changed"), { code: "recovery_review_stale" });
      }
      const hold = { reason: "recovery_review", at: nowFn(), operationId, blamedKeys: [],
        detail: detail || "The gateway is stopped while you review its post-shutdown recovery facts. Approve again or cancel to safely resume the previous build.",
        installed: sourceBuild.version || null, expected: expectedVersionOf(state), bootId: getProcessBootId() };
      state.gatewayHold = hold;
      state.recoveryReview = { operationId, sourceBuild, sourceFingerprint, wasRunning, hold, inventory };
      return state;
    });
    if (previous?.operationId && previous.operationId !== operationId) {
      backupRisk.revoke(previous.operationId);
      ledger.updateRun(previous.operationId, (run) => ({ ...run, recoveryReview: { active: false, supersededBy: operationId } }));
    }
    ledger.updateRun(operationId, (run) => ({ ...run, recoveryReview: { active: true, gatewayHeld: true } }));
    return saved.gatewayHold;
  };

  const cancelRecoveryReview = async ({ operationId } = {}) => {
    const refuse = (code) => ({ status: 409, body: channelError(code, "The stopped recovery review could not be safely cancelled.", {
      recovery_source_changed: "The previous build or state root changed. Restore the previous build and state-root identity, then refresh the Upgrade page before retrying.",
      db_preflight_failed: "The previous build cannot safely open the current databases. Restore compatible state or choose a compatible target; confirmation cannot override this check.",
      gateway_running: "Another gateway is running. Stop it through the Gateway controls before cancelling this review.",
      gateway_relaunch_failed: "The previous gateway did not reach readiness. Check its Gateway logs, fix the startup failure, then retry cancellation. The recovery review remains held.",
    }[code] || "The gateway remains held. Refresh the Upgrade page and review the current recovery state.") });
    if (applyInProgress) return refuse("operation_in_progress");
    const state = channelStore.readState();
    const review = state.recoveryReview;
    const held = state.gatewayHold;
    if (!review || !review.sourceBuild || !review.inventory?.rootIdentity || typeof review.wasRunning !== "boolean" ||
        !/^[a-f0-9]{64}$/.test(review.sourceFingerprint || "") || review.operationId !== operationId || held?.reason !== "recovery_review" || held.operationId !== operationId ||
        JSON.stringify(held) !== JSON.stringify(review.hold)) return refuse("recovery_review_stale");
    if (!gatewayQuiesce) return refuse("recovery_ownership_unavailable");
    applyInProgress = true;
    let release = null;
    let suppression = null;
    let suppressed = false;
    let started = false;
    const assert = () => {
      if (gatewayQuiesce.isCancelled?.()) throw Object.assign(new Error("Recovery cancellation was interrupted by shutdown"), { code: "operation_cancelled" });
      applyCommitPolicy.assert({ hold: release, intent: kGatewayMutationIntents.applyRecovery, recoveryHold: held });
      const current = channelStore.readState();
      if (JSON.stringify(current.recoveryReview) !== JSON.stringify(review) || JSON.stringify(current.gatewayHold) !== JSON.stringify(held)) {
        throw Object.assign(new Error("Recovery review changed"), { code: "recovery_review_stale" });
      }
    };
    try {
      release = await (acquireLifecycleLock || localApplyLock.acquire)("apply_commit", { leaseMs: 120_000 });
      assert();
      const source = await getExecutingBuild();
      assert();
      if (!source || source.buildId !== review.sourceBuild.buildId || await fingerprintBuild(source, { fsModule }) !== review.sourceFingerprint) {
        throw Object.assign(new Error("Source build changed"), { code: "recovery_source_changed" });
      }
      assert();
      if (path.resolve(stateDir()) !== review.inventory.requestedStateDir) throw Object.assign(new Error("Recovery state root changed"), { code: "recovery_source_changed" });
      const inventory = await recoveryInventory(assert);
      const root = fsModule.statSync(inventory.stateDir);
      if (review.inventory && (review.inventory.stateDir !== inventory.stateDir || review.inventory.requestedStateDir !== inventory.requestedStateDir ||
          review.inventory.rootIdentity.dev !== root.dev || review.inventory.rootIdentity.ino !== root.ino)) throw Object.assign(new Error("Recovery state root changed"), { code: "recovery_source_changed" });
      const verdict = await assessBinCompatibility(source);
      assert();
      if (verdict.compatible !== true || verdict.migrationRequired) throw Object.assign(new Error("Prior build cannot safely resume"), { code: "db_preflight_failed" });
      if (await gatewayQuiesce.isRunning()) throw Object.assign(new Error("Another gateway is running"), { code: "gateway_running" });
      assert();
      suppression = gatewayQuiesce.suppress?.(120_000);
      suppressed = true;
      const canResume = () => { try { assert(); return true; } catch { return false; } };
      if (review.wasRunning) {
        started = true;
        await gatewayQuiesce.start({ shouldAbort: () => !canResume() });
        assert();
        const ready = await waitForBackupReadiness({ gateway: { isRunning: () => gatewayQuiesce.isRunning(),
          probeReadiness: () => gatewayQuiesce.probeReadiness?.() ?? { kind: "unsupported" } },
          timeoutMs: backupBudget.postQuiesceReadyTimeoutMs, pollMs: backupBudget.postQuiescePollMs,
          settleMs: 0, shouldAbort: () => !canResume() });
        assert();
        if (!ready) throw Object.assign(new Error("Prior gateway did not become ready"), { code: "gateway_relaunch_failed" });
      }
      assert();
      ledger.updateRun(operationId, (run) => ({ ...run, recoveryReview: { active: false, cancelled: true },
        result: { ok: false, code: "recovery_review_cancelled", gatewayHeld: false } }));
      channelStore.updateState((current) => {
        if (JSON.stringify(current.gatewayHold) === JSON.stringify(held) && JSON.stringify(current.recoveryReview) === JSON.stringify(review)) {
          current.gatewayHold = null;
          current.recoveryReview = null;
        }
        else throw Object.assign(new Error("Recovery review changed"), { code: "recovery_review_stale" });
        return current;
      });
      backupRisk.revoke(operationId);
      return { status: 200, body: { ok: true, resumed: review.wasRunning === true, operationId } };
    } catch (error) {
      const ownsReview = () => { try { assert(); return true; } catch { return false; } };
      if (started && ownsReview()) {
        try { await gatewayQuiesce.stop({ shouldAbort: () => !ownsReview() }); } catch {}
      }
      return refuse(error.code || (started ? "gateway_relaunch_failed" : "recovery_review_stale"));
    } finally {
      try { if (suppressed) gatewayQuiesce.unsuppress?.(suppression); }
      finally { release?.(); applyInProgress = false; }
    }
  };

  const runStandaloneBackup = async ({ operationId = null, recoveryMode = "config_only" } = {}) => {
    if (!["config_only", "database_set"].includes(recoveryMode)) return { status: 400, body: channelError("invalid_recovery_mode", "Choose config_only or database_set.") };
    let activeGatewayOp = null;
    try {
      activeGatewayOp = getActiveGatewayOperation?.() || null;
    } catch {}
    if (activeGatewayOp) {
      const migrationHolder =
        activeGatewayOp.kind === "reconcile_retry" || activeGatewayOp.kind === "boot";
      return {
        status: 409,
        body: migrationHolder
          ? channelError(
              "gateway_busy",
              "A settings migration is running — a backup cannot pause the gateway until it finishes.",
              "Wait for the migration to finish (the Upgrade page shows its progress), then retry.",
            )
          : channelError(
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
          "An OpenClaw update or backup is already running.",
          "Wait for it to finish — progress is on the Upgrade page.",
        ),
      };
    }
    if (!isOnboarded()) {
      return {
        status: 409,
        body: channelError(
          "not_onboarded",
          "Finish onboarding before running a backup.",
          "The gateway has to be running so its state can be paused and copied.",
        ),
      };
    }
    try {
      if (isSelfUpdateInProgress()) {
        return {
          status: 409,
          body: channelError(
            "self_update_in_progress",
            "An AlphaClaw update or unresolved provider deployment blocks this backup.",
            "Wait for a local update to finish. For a managed deployment, check the provider and resolve its attempt before retrying.",
          ),
        };
      }
    } catch {}
    // Admission (AGENTS.md "Lifecycle and repair admission"): a gateway hold,
    // corrupt state or an unreadable state file refuses the backup with the
    // hold's own copy — nothing is paused for a box that is already held.
    const blockedBody = (error) =>
      channelError(
        error.code || "gateway_held",
        error.error || error.message || "The gateway cannot be paused right now.",
        error.hint || null,
        null,
        error.hold ? { hold: error.hold } : null,
      );
    try {
      applyCommitPolicy.assert({ intent: kGatewayMutationIntents.backup });
    } catch (error) {
      if (error?.blocked) return { status: error.statusCode || 409, body: blockedBody(error) };
      throw error;
    }

    applyInProgress = true;
    if (!operationId) operationId = crypto.randomUUID();
    const target = { kind: "backup" };
    try {
      ledger.createRun({ operationId, target });
    } catch (error) {
      log(`run ledger unavailable: ${error.message}`);
    }
    const sink = ledger.createLogSink({ operationId, extraSecretEnv: openclawSpawnEnv() });
    activeSink = sink;
    sink.writeLine(`[openclaw-backup] manual backup ${operationId} started`);
    const { emit, updateDetail } = stepRecorder(operationId, sink, { mirrorLastUpdateRun: false });
    queueNotify(`⏳ OpenClaw backup started (manual).`, {
      eventType: "info",
      operationId,
      id: `backup-start-${operationId}`,
      verbose: true,
    });
    const finish = (status, body) => {
      applyInProgress = false;
      try {
        if (operationEvents && operationId) {
          if (body.ok) {
            operationEvents.complete(operationId, body);
          } else {
            operationEvents.fail(
              operationId,
              Object.assign(new Error(body.message), {
                code: body.code,
                hint: body.hint,
                docsUrl: body.docsUrl,
                finishedAt: nowFn(),
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
                  : {}),
              }),
            );
          }
        }
      } catch {}
      try {
        ledger.completeRun(operationId, {
          state: body.ok ? "completed" : "failed",
          ok: Boolean(body.ok),
          result: body.ok
            ? { ok: true, recovery: body.recovery }
            : { ok: false, code: body.code, message: body.message, hint: body.hint ?? null, docsUrl: body.docsUrl ?? null },
        });
        ledger.pruneRuns();
      } catch {}
      if (!body.ok) {
        try {
          logEvent("channel_backup", "failed", { code: body.code, operationId });
        } catch {}
        queueNotify(
          `❌ OpenClaw backup failed: ${body.message}${body.hint ? `\n${body.hint}` : ""}`,
          { eventType: "health", operationId, id: `backup-failed-${operationId}` },
        );
      } else if (body.recovery?.checkpoint?.verified) {
        queueNotify(`${hasDatabaseRecoveryCoverage(body.recovery) ? "Recovery checkpoint with complete database set verified" : "Configuration checkpoint verified (database contents omitted)"}: ${path.basename(body.recovery.checkpoint.file)}.`, {
          eventType: "info",
          operationId,
          id: `backup-done-${operationId}`,
          verbose: true,
        });
      }
      try {
        sink.writeLine(
          `[openclaw-backup] manual backup ${operationId} finished: status=${status} ok=${Boolean(body.ok)}${
            body.code ? ` code=${body.code}` : ""
          }`,
        );
        activeSink = null;
        void sink.close();
      } catch {}
      return { status, body: { ...body, operationId } };
    };
    try {
      const sourceBuild = await getExecutingBuild();
      if (!sourceBuild) return finish(409, channelError("build_unverified", "Cannot identify the running build."));
      await checkRecoverySpace(recoveryMode);
      const transaction = await startRecovery(kGatewayMutationIntents.backup);
      try {
        const recovery = await captureRecovery({ transaction, operationId, sourceBuild,
          targetBuild: sourceBuild, recoveryMode, emit, updateDetail });
        if (!ledger.updateRun(operationId, (record) => ({ ...record, recovery }))) throw new Error("Recovery record unavailable");
        await transaction.close();
        const verified = verifyRecordedRecovery(operationId);
        if (!verified.valid) return finish(409, channelError("CHECKPOINT_PAYLOAD_CHANGED", "The captured recovery checkpoint changed before publication.",
          "The gateway resumed, but this checkpoint must not be used for recovery.", null, { recovery: verified.recovery }));
        await pruneBackups({ keepPaths: [recovery.checkpoint.file] });
        return finish(200, { ok: true, recovery });
      } finally {
        await transaction.close();
      }
    } catch (error) {
      const recovery = verifyRecordedRecovery(operationId).recovery;
      if (error?.blocked) return finish(error.statusCode || 409, { ...blockedBody(error), ...(recovery ? { recovery } : {}) });
      if (isConfigUnreadableError(error)) return finish(409, consentConfigError(error));
      if (/^(RECOVERY_|CHECKPOINT_|recovery_|state_db_quiet|gateway_stop|gateway_relaunch)/.test(error?.code || "") || ["insufficient_disk", "lease_expired", "backup_in_progress"].includes(error?.code)) {
        return finish(error.code === "insufficient_disk" ? 507 : 409, channelError(error.code,
          "The recovery operation did not complete safely.", "Resolve the reported condition and retry; no broader backup was attempted.", null,
          { recovery }));
      }
      return finish(
        500,
        channelError(
          "backup_failed",
          `The backup failed unexpectedly: ${sanitizeForDisplay(error?.message, 300)}`,
          "Check the run log under Update history, then retry.",
        ),
      );
    }
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
    recoveryMode = "config_only",
    // A human approval must carry the issued token and authenticated session.
    // The boolean alone never authorizes skipping a backup failure.
    confirmNoBackup = false,
    confirmNoBackupToken = null,
    consentSessionId = null,
    // v0.9.81 (D13/D21): the caller's declared direction (update | downgrade
    // | switch) and its "this is the channel's latest" claim. The route
    // REQUIRES intent for stable/beta; here it is judged again against the
    // executing build (belt 3, for direct callers) whenever it is present,
    // and the verdict is recorded on the run as `intentCheck` either way.
    intent = null,
    expectLatest = false,
  } = {}) => {
    if (allowBackupReuse !== null) return { status: 400, body: channelError("recovery_option_retired", "Archive reuse is retired.") };
    if (!["config_only", "database_set"].includes(recoveryMode)) return { status: 400, body: channelError("invalid_recovery_mode", "Choose config_only or database_set.") };
    if (confirmNoBackup && recoveryMode !== "config_only") return { status: 400, body: channelError("invalid_recovery_mode", "Forward-only consent and database-set capture are separate recovery choices.") };
    const confirmation = confirmNoBackup === true ? backupRisk.peek(confirmNoBackupToken, consentSessionId) : null;
    if (confirmNoBackup === true && (!confirmation || confirmation.facts.target.channel !== channel ||
        (channel === "dev" ? confirmation.facts.target.sha !== sha : confirmation.facts.target.version !== version))) {
      return { status: 409, body: channelError("backup_consent_required", "Review the failed update and approve its current backup risk before continuing.", "Retry the update or request a fresh backup-risk confirmation.") };
    }
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
            "An AlphaClaw update or unresolved provider deployment blocks this version change.",
            "Wait for a local update to finish. For a managed deployment, check the provider and resolve its attempt before retrying.",
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
    let managedOperationStarted = false;
    // Every apply gets a durable identity: the run record and log survive the
    // activation restart and are the correlation key for the overseer,
    // notifications, and the Upgrade page's post-restart "what happened".
    if (!operationId) operationId = crypto.randomUUID();
    const target = { channel, version, sha, devHead, ...(intent ? { intent } : {}) };
    try {
      ledger.createRun({ operationId, target });
      ledger.updateRun(operationId, (record) => ({ ...record, intent, expectLatest, recoveryMode }));
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
    const { steps, emit, updateDetail } = stepRecorder(operationId, sink);
    const startedAt = nowFn();
    let commitHold = null;
    let recoveryTransaction = null;
    let recoveryHandedOff = false;
    let preparedDevDir = null;
    let newDevCandidate = null;
    let retainDevCandidate = false;
    const targetLabel = channel === "dev" ? (devHead ? "dev-head" : sha) : version;
    queueNotify(
      `⏳ OpenClaw update started: ${targetLabel || "latest"} (${channel} channel).`,
      { eventType: "info", operationId, id: `apply-start-${operationId}`, verbose: true },
    );

    const finish = async (status, body) => {
      if (recoveryTransaction && !recoveryHandedOff && !body.restarting) {
        try { await recoveryTransaction.close(); }
        catch (error) {
          const originalCode = /^[a-z][a-z0-9_]{0,79}$/i.test(body.code || "") ? body.code : "apply_failed";
          const unwindCode = /^[a-z][a-z0-9_]{0,79}$/i.test(error.code || "") ? error.code : "gateway_relaunch_failed";
          log(`apply unwind failed: original=${originalCode}; unwind=${unwindCode}`);
          status = 409;
          body = channelError(unwindCode, "The prior gateway did not become ready after the recovery operation failed.",
            `Original failure: ${originalCode}. Check gateway health before retrying.`, null, { recovery: verifyRecordedRecovery(operationId).recovery });
        }
      }
      // The flag resets FIRST: everything after is best-effort, and a
      // bookkeeping throw (ENOSPC on the state file) must never leave the
      // latch stuck. EXCEPTION: when this result schedules a restart (a
      // restarting success, or a deferred rollback restart below), the latch
      // stays held — the process dies in ~1.5s, and releasing it would let a
      // second apply start only to be killed mid-overlay-write.
      const updaterFailure = readDevUpdateFailureEvidence({
        reason: body.updaterReason, recovery: body.updaterRecovery,
      });
      const restartImminent =
        (body.ok && body.restarting) || pendingRollbackRestart || (recoveryHandedOff && body.restartRequired === true);
      applyInProgress = Boolean(restartImminent);
      if (!restartImminent && !recoveryTransaction) {
        commitHold?.();
        commitHold = null;
      }
      try {
        // On a restarting success the swap is NOT over until the process
        // restart lands (~1.5s): releasing the latch here re-arms crash
        // accounting while `applied` already names the never-run new version,
        // and an old-gateway exit-78 in that gap would blocklist it. The
        // latch state dies with the process, so holding it leaks nothing.
        if (managedOperationStarted && !(body.ok && body.restarting)) {
          watchdogManagedOperation?.end?.();
        }
      } catch {}
      try {
        channelStore.updateState((s) => {
          // Settle the intent stamp this apply wrote (#76 RC3): only a
          // landed apply may later authorize a settings restore.
          if (
            s.lastTransition &&
            s.lastTransition.operationId === operationId &&
            (s.lastTransition.ok === null || body.restartDeferred === true)
          ) {
            s.lastTransition.ok = status < 400 && body?.ok === true;
          }
          if (s.lastUpdateRun?.operationId === operationId) {
            s.lastUpdateRun.finishedAt = nowFn();
            s.lastUpdateRun.ok = status < 400;
            s.lastUpdateRun.result = body.ok
              ? { ok: true, ...(body.recovery ? { recovery: body.recovery } : {}) }
              : {
                  ok: false,
                  code: body.code,
                  message: body.message,
                  hint: body.hint ?? null,
                  docsUrl: body.docsUrl ?? null,
                  ...updaterFailure,
                  ...(body.repairApplicable === true
                    ? { repairApplicable: true }
                    : {}),
                  // The consented-reuse offer must survive the quick window:
                  // the UI's resume poll reads it from here.
                  ...(isReusableBackupOffer(body.reusableBackup)
                    ? { reusableBackup: body.reusableBackup }
                    : {}),
                  ...(body.code === "recovery_choice_required" ? { operationId, backupRiskEligible: body.backupRiskEligible, choices: body.choices, preflight: body.preflight, coverage: body.coverage, target: body.target, intent: body.intent, expectLatest: body.expectLatest, recoveryMode: body.recoveryMode, gatewayHeld: body.gatewayHeld === true } : {}),
                  ...(body.restartDeferred === true ? { restartDeferred: true, restartRequired: true } : {}),
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
                ...updaterFailure,
                finishedAt: nowFn(),
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
                  : {}),
                ...(body.code === "recovery_choice_required" ? { operationId, backupRiskEligible: body.backupRiskEligible, choices: body.choices, preflight: body.preflight, coverage: body.coverage, target: body.target, intent: body.intent, expectLatest: body.expectLatest, recoveryMode: body.recoveryMode, gatewayHeld: body.gatewayHeld === true } : {}),
                ...(body.restartDeferred === true ? { restartDeferred: true, restartRequired: true } : {}),
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
                : body.restartDeferred === true && recoveryHandedOff ? "restart_expected" : "failed";
        ledger.completeRun(operationId, {
          state: ledgerState,
          ok: Boolean(body.ok),
          result: body.ok
            ? { ok: true, ...(body.recovery ? { recovery: body.recovery } : {}) }
            : {
                ok: false,
                code: body.code,
                message: body.message,
                hint: body.hint ?? null,
                docsUrl: body.docsUrl ?? null,
                ...updaterFailure,
                ...(body.repairApplicable === true
                  ? { repairApplicable: true }
                  : {}),
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
                  : {}),
                ...(body.code === "recovery_choice_required" ? { operationId, backupRiskEligible: body.backupRiskEligible, choices: body.choices, preflight: body.preflight, coverage: body.coverage, target: body.target, intent: body.intent, expectLatest: body.expectLatest, recoveryMode: body.recoveryMode, gatewayHeld: body.gatewayHeld === true } : {}),
                ...(body.restartDeferred === true ? { restartDeferred: true, restartRequired: true } : {}),
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
      const sourceBuildAtStart = executingBuild();
      const installedVersion = sourceBuildAtStart?.version ?? null;
      let recoveryHold = state.gatewayHold ? structuredClone(state.gatewayHold) : null;
      if (recoveryHold?.reason === "recovery_review") {
        const review = state.recoveryReview;
        if (!review || review.operationId !== recoveryHold.operationId || JSON.stringify(review.hold) !== JSON.stringify(recoveryHold)) {
          return finish(409, channelError("recovery_review_stale", "The held recovery review changed."));
        }
        if (!sourceBuildAtStart || sourceBuildAtStart.buildId !== review.sourceBuild?.buildId ||
            await fingerprintBuild(sourceBuildAtStart, { fsModule }) !== review.sourceFingerprint) {
          return finish(409, channelError("recovery_source_changed", "The held recovery source build changed.", "Restore the previous source build before reviewing this operation."));
        }
        if (path.resolve(stateDir()) !== review.inventory?.requestedStateDir) return finish(409, channelError("recovery_source_changed",
          "The held recovery state root changed.", "Restore the previous state-root identity, then refresh the Upgrade page."));
        const inventory = await recoveryInventory();
        const root = fsModule.statSync(inventory.stateDir);
        if (review.inventory?.stateDir !== inventory.stateDir || review.inventory?.requestedStateDir !== inventory.requestedStateDir ||
            review.inventory?.rootIdentity?.dev !== root.dev || review.inventory?.rootIdentity?.ino !== root.ino) {
          return finish(409, channelError("recovery_source_changed", "The held recovery state root changed.", "Restore the previous state-root identity, then refresh the Upgrade page."));
        }
      }

      // Intent belt (v0.9.81): judged against the SAME installed version the
      // route and the Upgrade page use (`getChannelInfo().installedVersion` —
      // the package tree's version), never the executing build's: with a dev
      // build live the two differ, and a "Switch to <pin>" the row labelled
      // from the tree version would otherwise be refused intent_mismatch
      // here with nothing the operator can do about it (review P2). The
      // v0.9.79 apply_source_changed guard still fences the executing build
      // through commit. A direct caller that sent no intent is recorded as
      // such (the HTTP route never lets that happen for stable/beta).
      let intentCheck = { direction: "caller_omitted", latest: "not_checked" };
      if (channel !== "dev" && intent) {
        let judgedInstalledVersion = null;
        try {
          judgedInstalledVersion = getChannelInfo()?.installedVersion ?? null;
        } catch {
          judgedInstalledVersion = installedVersion;
        }
        let intentCatalog = null;
        if (intent === "update" && expectLatest === true) {
          try {
            intentCatalog = await releases.getCatalog({});
          } catch {
            intentCatalog = null;
          }
        }
        const verdict = assessApplyIntent({
          intent,
          channel,
          version,
          installedVersion: judgedInstalledVersion,
          catalog: intentCatalog,
          expectLatest: expectLatest === true,
        });
        if (!verdict.ok) {
          const { status, code, message, hint, ok: _ok, ...extra } = verdict;
          return finish(status, channelError(code, message, hint, null, extra));
        }
        intentCheck = verdict.check;
      } else if (channel === "dev") {
        intentCheck = { direction: "not_applicable", latest: "not_applicable" };
      }
      try {
        ledger.updateRun(operationId, (record) => {
          record.intentCheck = intentCheck;
          return record;
        });
      } catch {}

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
        // Intent stamp (#76 RC3): the operator chose this transition. `ok`
        // stays null until finish() settles the run — a failed apply never
        // authorizes a settings restore (Codex D10).
        stampLastTransition(s, {
          from: installedVersion,
          to: channel === "dev" ? sha || "dev" : version,
          source: "operator_apply",
          operationId,
          ok: null,
          channel,
        });
        return s;
      });

      const currentApplied = state.applied;
      const samePackage = channel !== "dev" && version && version === installedVersion && installDir &&
        sourceBuildAtStart?.source !== "dev" && (!currentApplied || currentApplied.channel !== "dev") &&
        !channelStore.needsActivation({ installDir, expectedVersion: version });
      const sameDev = channel === "dev" && sha && currentApplied?.channel === "dev" && currentApplied.sha &&
        (currentApplied.sha === sha || sha.length >= 7 && currentApplied.sha.startsWith(sha)) &&
        sourceBuildAtStart?.source === "dev" && sourceBuildAtStart.buildId === currentApplied.sha &&
        checkoutBuildReady() && readCheckoutHead()?.startsWith(currentApplied.sha.slice(0, 7));
      if (!recoveryHold && (samePackage || sameDev)) {
        const verdict = await assessInstalledLaunchCompatibility({ legacyExecApprovals: "block" });
        if (verdict.compatible !== true || verdict.migrationRequired == null) return finish(409, channelError("db_preflight_failed",
          "The current build's database compatibility could not be verified.", "Resolve the database compatibility finding before reapplying.", null, { preflight: verdict }));
        if (!verdict.migrationRequired) return finish(200, { ok: true, noop: true, ...(sameDev ? { sha: currentApplied.sha } : { version }) });
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

      await prunePreparedDevBuilds();

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
                "Move this AlphaClaw to a Node that satisfies it (rebuild the container image, or upgrade the host's Node for an npx install), then retry.",
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

      try {
        watchdogManagedOperation?.begin?.();
        managedOperationStarted = true;
      } catch {}

      // Keep the pin floor local-offline before the first non-pin activation.
      // CX-J: a failed snapshot with no existing floor means a later rollback
      // has nowhere to land — that is an abort, not a warning.
      const floor = await ensurePinSnapshot(installDir);
      // The structured db-preflight verdict of whichever branch ran below —
      // read by the post-preflight backup checkpoint before the record step.
      let preflightVerdict = null;
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
      if (confirmation) {
        if (channel === "dev") preparedDevDir = selectedDevCheckout(confirmation.facts.target.checkoutDir || confirmation.facts.target.packageDir);
        if (preparedDevDir) preparingDevPaths.add(preparedDevDir);
        preflightVerdict = confirmation.preflight;
        emit("verify", "completed", { detail: "reusing the verified build from the reviewed failed update" });
        ledger.updateRun(operationId, (record) => {
          record.dbPreflight = preflightVerdict;
          return record;
        });
      } else if (channel !== "dev") {
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
        let verify;
        try { verify = await verifyPackageArtifact({ packageDir: tempInstall.openclawPackageDir, version, emit }); }
        catch (error) { await cleanupTempInstall(tempInstall); throw error; }
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
        // Learn the target's declared schema (#78) the moment its overlay is
        // durable: later boots (rollback prober, launch gate) can then judge
        // agent DBs against this version without rescanning its dist.
        // Advisory — a failed read/write never fails the apply.
        try {
          schemaTable.recordDeclared(
            version,
            await resolveDeclaredSchemaVersionsAsync(
              channelStore.overlayPackageDir(version),
              { fsModule },
            ),
          );
        } catch (error) {
          log(
            `schema table: could not record the declared schema of ${version} (${error?.message || error})`,
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
        preflightVerdict = preflight.verdict ?? null;
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
        const reusable = !devHead && sha ? ledger.listRuns().find((run) => {
          if (run.operationId === operationId || run.target?.channel !== "dev" || run.target.sha !== sha || !run.target.checkoutDir ||
              run.result?.code !== "recovery_choice_required") return false;
          try { return readCheckoutHead(selectedDevCheckout(run.target.checkoutDir)) === sha; } catch { return false; }
        }) : null;
        if (reusable) {
          preparedDevDir = selectedDevCheckout(reusable.target.checkoutDir);
          preparingDevPaths.add(preparedDevDir);
          if (readCheckoutHead(preparedDevDir) !== sha) return finish(409, channelError("target_unverified", "The prepared dev candidate changed. Prepare the target again."));
          emit("build", "completed", { detail: "reusing the exact prepared dev candidate" });
        } else {
          newDevCandidate = createDevCandidate({ checkoutDir, fsModule });
          preparedDevDir = newDevCandidate.checkoutDir;
          preparingDevPaths.add(preparedDevDir);
          rotateDevLog();
          const buildResult = await withIsolatedDevPreparation({ env: devUpdateEnv(), checkoutDir: preparedDevDir, fsModule }, (env) => prepareDevBuild({
            sha: devHead ? null : sha, candidateDir: preparedDevDir, env, runner, emit, output: makeOutputPublisher(operationId),
            rootDir, readHead: readCheckoutHead, resolveBin: checkoutBuildReady, channelError }));
          if (!buildResult.ok) return finish(409, buildResult);
          sha = buildResult.sha;
        }
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
        const bin = checkoutBuildReady(preparedDevDir);
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
        const versionResult = await withIsolatedDevPreparation({ env: probeEnv(), checkoutDir: preparedDevDir, fsModule }, (env) => runner.runStreamed({
          command: "node",
          args: [bin, "--version"],
          env,
          timeoutMs: 30_000,
        }));
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
          // The checkout's dist declares the just-built tree's schema
          // constants (a dev build has no overlay to scan).
          packageDirOverride: preparedDevDir,
        });
        if (!devPreflight.ok) return finish(409, devPreflight.error);
        preflightVerdict = devPreflight.verdict ?? null;
        // Same boot hint as the package branch: the reconciler sizes its
        // migration budget from it and knows whether doctor must run.
        if (devPreflight.verdict) {
          try {
            ledger.updateRun(operationId, (record) => {
              record.dbPreflight = devPreflight.verdict;
              return record;
            });
          } catch {}
        }
      }

      const migrationRequired = preflightVerdict?.migrationRequired === true;
      const commitTarget = confirmation?.facts.target || { channel, version, sha, ...(channel === "dev" ? { checkoutDir: preparedDevDir } : {}) };
      const preparedTarget = channel === "dev" ? { channel, sha } : { channel, version };
      ledger.updateRun(operationId, (record) => ({ ...record, target: { ...preparedTarget, ...(channel === "dev" ? { checkoutDir: preparedDevDir } : {}), ...(intent ? { intent } : {}) } }));
      if (migrationRequired && recoveryMode === "config_only" && !confirmation) {
        retainDevCandidate = channel === "dev";
        if (recoveryHold?.reason === "recovery_review") {
          const review = channelStore.readState().recoveryReview;
          if (!review || review.operationId !== recoveryHold.operationId) return finish(409, channelError("recovery_review_stale", "The held recovery review changed."));
          recoveryHold = persistRecoveryReview({ operationId, sourceBuild: review.sourceBuild,
            sourceFingerprint: review.sourceFingerprint, wasRunning: review.wasRunning, expectedHold: recoveryHold, inventory: review.inventory });
        }
        let eligible = false;
        if (consentSessionId) {
          try {
            const facts = await backupRisk.collectFacts(commitTarget);
            if (facts.source.buildId === sourceBuildAtStart?.buildId) {
              eligible = backupRisk.offer({ operationId, sessionId: consentSessionId, facts,
                backup: null, preflight: preflightVerdict });
            }
          } catch (error) {
            if (isConfigUnreadableError(error)) return finish(409, consentConfigError(error));
          }
        }
        return finish(409, { ...channelError("recovery_choice_required",
          "This update migrates databases. Choose database recovery protection or explicitly accept forward-only recovery.",
          "A configuration checkpoint does not restore database contents."),
          operationId, target: preparedTarget, intent, expectLatest, recoveryMode, gatewayHeld: recoveryHold?.reason === "recovery_review",
          preflight: preflightVerdict, backupRiskEligible: eligible,
          choices: ["database_set", ...(eligible ? ["forward_only"] : []), "cancel"],
          coverage: { config: "complete", databases: "omitted" } });
      }
      const commitIntent = recoveryHold && (recoveryMode === "database_set" || ["recovery_choice_required", "recovery_intent_stale", "recovery_review"].includes(recoveryHold.reason))
        ? kGatewayMutationIntents.applyRecovery : kGatewayMutationIntents.apply;
      const commitPolicy = { intent: commitIntent, recoveryHold };
      const preparedFacts = await backupRisk.collectFacts(commitTarget, { ...commitPolicy, strict: Boolean(confirmation) });
      if (recoveryHold?.reason === "recovery_review") {
        const review = channelStore.readState().recoveryReview;
        if (preparedFacts.source.fingerprint !== review?.sourceFingerprint || preparedFacts.inventory?.stateDir !== review?.inventory?.stateDir ||
            preparedFacts.inventory?.requestedStateDir !== review?.inventory?.requestedStateDir ||
            JSON.stringify(preparedFacts.inventory?.rootIdentity) !== JSON.stringify(review?.inventory?.rootIdentity)) {
          return finish(409, channelError("recovery_source_changed", "The held recovery source changed during preparation.", "Restore the previous build and state-root identity, then refresh the Upgrade page."));
        }
      }
      if (preparedFacts.source.buildId !== sourceBuildAtStart?.buildId) {
        return finish(409, channelError("apply_source_changed", "The running OpenClaw build changed while this update was prepared.", "Retry from the current build."));
      }
      if (confirmation && JSON.stringify(preparedFacts) !== JSON.stringify(confirmation.facts)) {
        return finish(409, channelError("backup_consent_required", "The approved recovery facts changed before the gateway was paused.", "Request a fresh recovery confirmation."));
      }
      await checkRecoverySpace(recoveryMode);
      recoveryTransaction = await startRecovery(commitIntent, recoveryHold);
      commitHold = recoveryTransaction.hold;
      const commitFacts = await backupRisk.collectFacts(commitTarget, { hold: commitHold, ...commitPolicy,
        strict: Boolean(confirmation), ownedQuiet: true });
      recoveryTransaction.assert();
      if (JSON.stringify(preparedFacts) !== JSON.stringify(commitFacts)) {
        if (confirmation) {
          recoveryTransaction.assert();
          backupRisk.revoke(confirmation.operationId);
          const previousReview = channelStore.readState().recoveryReview;
          const sourceFingerprint = previousReview?.sourceFingerprint || preparedFacts.source.fingerprint;
          const sourceInventory = previousReview?.inventory || preparedFacts.inventory;
          const sourceChanged = commitFacts.source.fingerprint !== sourceFingerprint || commitFacts.inventory?.stateDir !== sourceInventory?.stateDir ||
            commitFacts.inventory?.requestedStateDir !== sourceInventory?.requestedStateDir ||
            JSON.stringify(commitFacts.inventory?.rootIdentity) !== JSON.stringify(sourceInventory?.rootIdentity);
          const reviewHold = persistRecoveryReview({ operationId, sourceBuild: previousReview?.sourceBuild || preparedFacts.source,
            sourceFingerprint, wasRunning: previousReview?.wasRunning ?? recoveryTransaction.wasRunning,
            expectedHold: recoveryHold, inventory: sourceInventory,
            detail: sourceChanged ? "The source build or state root changed during shutdown. Restore the previous build and state-root identity before retrying or cancelling." : null });
          recoveryTransaction.park();
          retainDevCandidate = channel === "dev";
          commitHold = null;
          if (sourceChanged) {
            return finish(409, { ...channelError("recovery_source_changed", "The source build or state root changed during shutdown. The gateway remains held.",
              "Restore the previous build and state-root identity, then refresh the Upgrade page."), operationId, gatewayHeld: true });
          }
          let eligible = false;
          let currentPreflight = preflightVerdict;
          try {
            const screen = await runDatabasePreflight({ version: channel === "dev" ? sha : version,
              packageDirOverride: channel === "dev" ? preparedDevDir : null });
            currentPreflight = screen.verdict;
            if (screen.ok) {
              const facts = await backupRisk.collectFacts(commitTarget, { intent: kGatewayMutationIntents.applyRecovery, recoveryHold: reviewHold });
              eligible = backupRisk.offer({ operationId, sessionId: consentSessionId, facts, backup: null, preflight: currentPreflight });
            }
          } catch {}
          return finish(409, { ...channelError("recovery_choice_required", "The gateway is stopped. Its shutdown changed the database recovery facts, so the previous approval was revoked.",
            "Review and approve these post-shutdown facts, or cancel to safely resume the previous build."),
            operationId, target: preparedTarget, intent, expectLatest, recoveryMode, gatewayHeld: true,
            preflight: currentPreflight, backupRiskEligible: eligible,
            choices: ["database_set", ...(eligible ? ["forward_only"] : []), "cancel"],
            coverage: { config: "not_captured", databases: "omitted" } });
        }
        return finish(409, channelError("apply_facts_changed", "The update facts changed while it waited for the gateway.", "Retry and review the current state."));
      }
      const finalPreflight = await runDatabasePreflight({ version: channel === "dev" ? sha : version,
        packageDirOverride: channel === "dev" ? preparedDevDir : null, emit });
      recoveryTransaction.assert();
      if (!finalPreflight.ok || finalPreflight.verdict.migrationRequired !== migrationRequired) {
        return finish(409, finalPreflight.error || channelError("apply_facts_changed", "Database migration requirements changed."));
      }
      const recoverySourceFacts = await backupRisk.collectFacts(commitTarget, { hold: commitHold, ...commitPolicy,
        strict: true, ownedQuiet: true });
      recoveryTransaction.assert();
      const recovery = await captureRecovery({ transaction: recoveryTransaction, operationId,
        sourceBuild: commitFacts.source, targetBuild: commitFacts.target, recoveryMode, emit, updateDetail });
      const targetContentFingerprint = await fingerprintBuild(commitFacts.target, { fsModule, contentOnly: true });
      recoveryTransaction.assert();
      const capturedFacts = await backupRisk.collectFacts(commitTarget, { hold: commitHold, ...commitPolicy,
        strict: true, ownedQuiet: true });
      recoveryTransaction.assert();
      if (JSON.stringify(recoverySourceFacts) !== JSON.stringify(capturedFacts)) {
        return finish(409, channelError("apply_facts_changed", "The recovery source changed during capture."));
      }
      if (confirmation && !backupRisk.consume({ token: confirmNoBackupToken, sessionId: consentSessionId, facts: capturedFacts })) {
        return finish(409, channelError("backup_consent_required", "The recovery approval expired or changed.", "Request a fresh confirmation."));
      }
      if (migrationRequired && recoveryMode === "database_set" && !hasDatabaseRecoveryCoverage(recovery)) {
        return finish(409, channelError("recovery_coverage_incomplete", "The complete database recovery set could not be verified."));
      }
      recovery.kind = confirmation ? "forward_only" : recoveryMode;
      recovery.consent = { required: migrationRequired && recoveryMode !== "database_set", recorded: Boolean(confirmation),
        ...(confirmation ? { approvalId: confirmation.operationId } : {}) };
      if (!ledger.updateRun(operationId, (record) => ({ ...record, recovery,
        recoveryIntent: { approved: true, target: commitTarget, targetFingerprint: capturedFacts.target.fingerprint, targetContentFingerprint,
          configurations: capturedFacts.configurations || null, databases: capturedFacts.databases,
          migrationRequired, operationId }, dbPreflight: finalPreflight.verdict }))) {
        throw Object.assign(new Error("Recovery intent could not be persisted"), { code: "consent_record_failed" });
      }

      // Record + restart. An APPLY never activates in-process: the boot sync
      // activates the recorded build (bin phase), and the only runtime
      // activation is reconcileInstalled (#76 B1.2), which re-activates the
      // build already recorded here — never a new pick.
      emit("record", "running");
      applyCommitPolicy.assert({ hold: commitHold, ...commitPolicy });
      channelStore.updateState((s) => {
        // operationId ties the acceptance notification to this run (WI-3.4).
        if (sourceBuildAtStart?.source === "dev") s.previousDev = { sha: sourceBuildAtStart.buildId, checkoutDir: sourceBuildAtStart.packageDir };
        s.applied =
          channel === "dev"
            ? { channel: "dev", sha, checkoutDir: preparedDevDir, at: nowFn(), acceptedAt: null, operationId }
            : version === s.pinVersion
              ? null
              : { channel, version, at: nowFn(), acceptedAt: null, operationId };
        if (recoveryHold?.reason === "recovery_review" && JSON.stringify(s.gatewayHold) === JSON.stringify(recoveryHold)) {
          const reviewId = s.recoveryReview?.operationId;
          s.gatewayHold = null;
          s.recoveryReview = null;
          if (reviewId) ledger.updateRun(reviewId, (run) => ({ ...run, recoveryReview: { active: false, appliedBy: operationId } }));
        }
        // An explicit successful apply is the operator's way out of the #21
        // recovery latches — reset them for the fresh attempt.
        s.rollbackRefused = null;
        s.forwardRecovery = null;
        s.noBootableVersion = null;
        return s;
      });
      recoveryTransaction.handoff();
      recoveryHandedOff = true;
      retainDevCandidate = channel === "dev";
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
        setTimeout(async () => {
          try {
            applyCommitPolicy.assert({ hold: commitHold, ...commitPolicy });
            await restartProcess();
          } catch (error) {
            log(`apply restart deferred (${error.code || "restart_failed"})`);
            emit("restarting", "failed", { error: error.code || "restart_deferred" });
            if (recoveryTransaction.isLeaseValid()) channelStore.updateState((state) => {
              if (!state.gatewayHold && state.lastUpdateRun?.operationId === operationId) state.gatewayHold = { reason: "recovery_restart_required", operationId, at: nowFn() };
              return state;
            });
            recoveryTransaction.defer();
            await finish(409, channelError(error.code || "restart_deferred",
              "The prepared OpenClaw target was recorded, but AlphaClaw could not restart to activate it.",
              error.hint || "Resolve the gateway blocker, then restart AlphaClaw to activate the recorded target.", null,
              { restartDeferred: true, restartRequired: true }));
          } finally {
            commitHold?.();
            commitHold = null;
          }
        }, 1500).unref?.();
      } else {
        commitHold?.();
        commitHold = null;
      }
      return finish(202, {
        ok: true,
        restarting: true,
        target: { channel, version, sha },
        recovery,
        operationId,
      });
    } catch (error) {
      if (isConfigUnreadableError(error)) return finish(409, consentConfigError(error));
      if (error?.code === "candidate_probe_isolation_failed") return finish(409, channelError(error.code,
        "The candidate cannot run without an isolated probe home.", "Free temporary disk space or fix its permissions, then retry."));
      if (/^dev_candidate_/.test(error?.code || "")) return finish(409, channelError(error.code,
        "Prepared dev candidate storage could not be verified.", "Inspect the managed candidate directory and free space before retrying."));
      if (error?.status === "corrupt" || /SQLITE_(?:NOTADB|CORRUPT)/.test(error?.code || "") || [11, 26].includes((error?.errcode || 0) & 0xff)) {
        return finish(409, channelError("db_preflight_failed", "The current databases are unreadable or corrupt.",
          "Restore a verified database recovery set or repair the damaged database before retrying. Recovery confirmation cannot override this refusal.", null,
          { backupRiskEligible: false, preflight: { compatible: false, migrationRequired: null, perDb: [{ sourcePath: error.sourcePath,
            status: "corrupt", reasons: [error.code || "sqlite_corrupt"], error: { code: error.code, errcode: error.errcode } }] } }));
      }
      if (/^(RECOVERY_|CHECKPOINT_|recovery_|state_db_quiet|gateway_stop)/.test(error?.code || "")) {
        return finish(409, channelError(error.code, "Recovery could not be safely verified.", "Resolve the condition and retry; no broader backup was attempted."));
      }
      if (error?.blocked || error?.code === "lease_expired") {
        return finish(error.statusCode || 409, channelError(error.code, error.error || error.message, error.hint));
      }
      if (["state_db_quiet", "state_corrupted", "state_db_unreadable", "state_db_unverified", "state_db_changed", "build_unverified", "target_unverified", "db_preflight_failed", "insufficient_disk", "gateway_held", "version_blocklisted", "self_update_in_progress", "self_update_unverified", "build_changed", "consent_record_failed"].includes(error?.code)) {
        return finish(error.code === "insufficient_disk" ? 507 : 409, channelError(error.code, "The update cannot commit because its current state or target is no longer safe to activate.", "Resolve the reported condition and retry the update."));
      }
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
    } finally {
      if (recoveryTransaction && !recoveryHandedOff) await recoveryTransaction.close();
      if (newDevCandidate && !retainDevCandidate) await newDevCandidate.remove();
      preparingDevPaths.delete(preparedDevDir);
      try { await prunePreparedDevBuilds(); } catch { log("dev candidate cleanup deferred: storage could not be safely verified"); }
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

  // Explicit user action: rebuild is heavy, so it is never done in a crash
  // context — only from the Upgrade page with full preflight (via applyUpdate).

  // Dev repair owns its own lifecycle lease and ledger; package channels
  // remain under the normal re-stage/apply pipeline.
  const runUpdateRepair = (options) => {
    const currentRepairDir = () => {
      const build = executingBuild();
      return build?.source === "dev" ? build.packageDir : selectedDevCheckout();
    };
    let repairDir;
    try {
      repairDir = currentRepairDir();
    } catch {
      return Promise.resolve({ status: 409, body: channelError("dev_checkout_unavailable", "The recorded dev checkout cannot be safely identified.", "Prepare a verified dev build from the Upgrade page before retrying repair.") });
    }
    return withIsolatedDevPreparation({ env: devUpdateEnv(), checkoutDir: repairDir, fsModule }, (preparationEnv) => createOpenclawUpdateRepair({
    getChannelInfo, isOnboarded, isSelfUpdateInProgress,
    isApplyInProgress: () => applyInProgress,
    setApplyInProgress: (value) => { applyInProgress = value; },
    getActiveGatewayOperation: getActiveGatewayOperation || localApplyLock.getActiveOperation,
    acquireLifecycleLock: acquireLifecycleLock || localApplyLock.acquire,
    mutationPolicy: applyCommitPolicy,
    ledger, runner, devUpdateEnv: () => {
      if (currentRepairDir() !== repairDir) throw Object.assign(new Error("The active dev checkout changed while repair waited for its lease."), { code: "repair_source_changed", blocked: true, statusCode: 409 });
      return preparationEnv;
    }, stepRecorder, makeOutputPublisher,
    setActiveSink: (sink) => { activeSink = sink; },
    operationEvents, watchdogManagedOperation, channelError, rootDir, log,
    })(options));
  };

  // ---------------------------------------------------------------------
  // Which binary (#76 C6 / Codex 8)
  // ---------------------------------------------------------------------
  //
  // While the live tree is not the recorded build (installedDiverged), the
  // `openclaw` on PATH is the wrong binary for anything that touches the
  // CURRENT state databases — a backup, a doctor pass, a capability probe.
  // describeExpectedBin / describeInstalledBin name the two candidate trees;
  // compatibleBinForCurrentDb asks the launch-compat gate which of them can
  // open the DBs, preferring the recorded build. The apply preflight is NOT
  // routed here: it keeps probing the TARGET overlay's bin (Codex 8).
  // resolveExpectedBin is state/fs reads only — it sits on the capability
  // layer's probe path (openclaw-capabilities resolveBin), never spawns.
  const describeBinAt = (packageDir, version, source) => {
    let bin = null;
    try {
      bin = channelStore.resolvePackageBin(packageDir);
    } catch {
      bin = null;
    }
    return bin && fsModule.existsSync(bin) ? { bin, version, buildId: version, packageDir, source } : null;
  };
  const installedPackageDir = (installDir) =>
    path.join(installDir, "node_modules", "openclaw");
  const describeExpectedBin = () => {
    const state = channelStore.readState();
    // A dev apply runs the checkout behind the shim; its installed package
    // tree is the dormant fallback, not "expected".
    if (state.applied?.channel === "dev") {
      const build = executingBuild();
      return build?.source === "dev" ? build : null;
    }
    const expected = expectedVersionOf(state);
    if (!expected) return null;
    if (channelStore.hasOverlay(expected)) {
      const fromOverlay = describeBinAt(
        channelStore.overlayPackageDir(expected),
        expected,
        "overlay",
      );
      if (fromOverlay) return fromOverlay;
    }
    const installDir = safeInstallDir();
    if (
      installDir &&
      readInstalledVersionSafe() === expected &&
      pinTreeLooksComplete(installDir)
    ) {
      return describeBinAt(installedPackageDir(installDir), expected, "installed");
    }
    return null;
  };
  const describeInstalledBin = () => {
    return executingBuild();
  };
  const resolveExpectedBin = () => {
    try {
      return describeExpectedBin()?.bin ?? null;
    } catch {
      return null;
    }
  };
  // A legacy exec-approvals.json is a finding only for a sqlite-era build
  // (#23): its presence fails all channels closed there, nothing before.
  const legacyExecApprovalsPresentFor = (version) => {
    const core = String(version || "").trim().split("-")[0];
    if (!core || compareVersionParts(core, kExecApprovalsSqliteMinCoreVersion) < 0) {
      return false;
    }
    try {
      return fsModule.existsSync(path.join(openclawDir, kExecApprovalsFileName));
    } catch {
      return false;
    }
  };
  // Server-phase reader for the compat gate: the TRACKED read-only handle so
  const assessBinCompatibility = async (
    candidate,
    { prober = null, supported = null, legacyExecApprovalsPresent = null } = {},
  ) => {
    const resolved =
      supported ??
      (await supportedSchemaAsync({
        packageDir: candidate.packageDir,
        version: candidate.version,
        buildId: candidate.buildId ?? candidate.version,
      }));
    try {
      const inventory = await recoveryInventory();
      const verdict = await inspectRecoveryDatabases({ inventory, supported: resolved });
      if (legacyExecApprovalsPresent ?? legacyExecApprovalsPresentFor(candidate.version)) {
        verdict.compatible = false;
        verdict.ok = false;
        verdict.reasons = [...verdict.reasons, kLaunchCompatReasons.legacyExecApprovalsPresent];
      }
      return { ...verdict, perDb: verdict.perDb.map((entry) => ({ ...entry, path: entry.sourcePath, kind: entry.dbKind,
        status: entry.status || (entry.compatible === null ? "unverified" : "ok"), verdict: entry.compatible === true ? "compatible" : entry.compatible === false ? "incompatible" : "unknown" })),
        supported: resolved, legacyExecApprovalsPresent:
        legacyExecApprovalsPresent ?? legacyExecApprovalsPresentFor(candidate.version),
        holdReason: verdict.compatible === true ? null : verdict.compatible === false ? "version_mismatch"
          : verdict.perDb.some((entry) => entry.status === "corrupt") ? "state_db_unreadable" : "state_db_unverified" };
    } catch (error) {
      const unreadable = error.status === "corrupt";
      return { compatible: null, migrationRequired: null, perDb: error.sourcePath ? [{
        path: error.sourcePath, sourcePath: error.sourcePath, status: error.status || "unverified", verdict: "unknown",
        error: { code: error.code, errcode: error.errcode },
      }] : [], supported: resolved,
        reasons: [unreadable ? kLaunchCompatReasons.stateDbUnreadable : error.code || "recovery_inventory_unavailable"],
        holdReason: unreadable ? "state_db_unreadable" : "state_db_unverified" };
    }
  };
  const compatibleBinForCurrentDb = async () => {
    const candidates = [];
    const expected = describeExpectedBin();
    if (expected) candidates.push(expected);
    const installed = describeInstalledBin();
    if (installed && (!expected || installed.bin !== expected.bin)) {
      candidates.push(installed);
    }
    for (const candidate of candidates) {
      let compat = null;
      try {
        compat = await assessBinCompatibility(candidate);
      } catch {
        compat = null;
      }
      if (compat?.compatible !== true || compat.migrationRequired !== false) continue;
      return {
        ...candidate,
        compatible: compat?.compatible ?? null,
        migrationRequired: false,
        reasons: compat?.reasons ?? [],
      };
    }
    return null;
  };

  // ---------------------------------------------------------------------
  // Installed-tree reconcile (#76 B1.2)
  // ---------------------------------------------------------------------
  //
  //   reconcileInstalled({ hold, source, relaunch, recover })
  //     ├─ gates (no lock): kill switch (OPENCLAW_RUNTIME_RECONCILE=off —
  //     │    RUNTIME sources only: the route, the Upgrade-tab action, the
  //     │    structural ladder; source "boot" is the C1 belt, runs under the
  //     │    boot lock with the port bind proving single-instance, and is
  //     │    the very thing the README promises the switch leaves alone) ·
  //     │    apply in flight · quiet barrier ·
  //     │    unreadable state · migration-class hold · dev apply · no
  //     │    expected build · no complete overlay / pin tree → { ok:false,
  //     │    code, action:"none" } (event reconcile_installed/skipped)
  //     ├─ installed === expected ∧ sentinel matches → { action: "none" } —
  //     │    unless `recover` (the watchdog's structural repair, rung 3 of
  //     │    #76 B1.1): then the installed tree is judged against the live
  //     │    user_versions first and ONLY a proven incompatibility continues
  //     │    into the chooser (a compatible / unknown tree is `none` with a
  //     │    reason — the operator's build is never swapped on a guess)
  //     ├─ lock: the caller's hold (structural repair, the route) or its own
  //     │    "reconcile_installed" acquire — NEVER both (the lifecycle lock is
  //     │    not re-entrant, Codex 1); hold.isValid() re-checked after every
  //     │    await; the gates re-run once the lock is held
  //     ├─ ledger run { kind: "reconcile", version } — steps stop → activate
  //     │    → verify; the CALLER appends `relaunch` and completes the run
  //     │    (completeReconcileRun) after its verified launch (Codex 7); a
  //     │    run left `running` is closed by closeInterruptedRuns
  //     ├─ target compatibility FIRST (Eng 1B / Codex 2): the target's
  //     │    declared schema vs the live user_versions → incompatible →
  //     │    chooseBootableVersion (table shortlist ≤ 3 overlays, boot prober
  //     │    confirm; Codex 4) → nothing → no_bootable_version. A chosen
  //     │    candidate ≠ expected is recorded as applied.reason
  //     │    "schema_recovery"
  //     ├─ stop: CONFIRMED stop of any serving identity — gateway stopped, no
  //     │    serving pid tree (discoverServingIdentity), zero live openclaw
  //     │    processes (the backup quiesce's exclusivity shape; CEO 1.2) →
  //     │    else incumbent_running — never an rm under a live gateway
  //     ├─ disk: free ≥ 1.2 × the overlay's bytes beside node_modules (CEO 2.2)
  //     ├─ activate: activateOverlayAsync (stage → verify → rm → rename →
  //     │    sentinel LAST). A failure BEFORE the rm leaves the live tree
  //     │    intact (plain failure, no hold); a failure AFTER it writes no
  //     │    sentinel, sets gatewayHold { reason: "activation_failed", error },
  //     │    notifies (always-send) and tries the chooser ONCE for another
  //     │    candidate that can read the DBs
  //     ├─ verify: readInstalledVersion === target ∧ sentinel matches
  //     └─ clearVersionCache() (the apply record-step hook) · clear only the
  //          holds this path owns (version_mismatch, activation_failed,
  //          state_db_unreadable — kStructuralHoldReasons) · event +
  //          always-send notification · { ok, action:"activated", from, to,
  //          runId }
  const runtimeReconcileDisabled = () =>
    String(process.env[kRuntimeReconcileEnvKey] || "")
      .trim()
      .toLowerCase() === "off";
  // The C1 belt's source (boot-launch-steps.js and the boot compat gate's
  // re-activation): exempt from the runtime kill switch.
  const kBootReconcileSource = "boot";

  const setStructuralHold = (reason, { detail, installed, expected, error = null }) => {
    const hold = {
      reason,
      at: nowFn(),
      operationId: null,
      blamedKeys: [],
      detail,
      installed: installed ?? null,
      expected: expected ?? null,
      bootId: getProcessBootId(),
      ...(error ? { error: String(error) } : {}),
    };
    channelStore.updateState((s) => {
      s.gatewayHold = hold;
      return s;
    });
    try {
      watchdogLatch?.();
    } catch {}
    logEvent("reconciler", "hold", { reason, blamedKeys: [] });
    return hold;
  };

  // The gate half: pure over getChannelInfo() and the overlay store. Runs
  // before the lock (fast refusal) and again once the lock is held. `source`
  // scopes the kill switch: it disables the RUNTIME reconcile, never the boot
  // belt (a diverged box with the switch set must still boot the recorded
  // build — otherwise the switch holds the gateway instead of restoring the
  // pre-0.9.77 behaviour it exists to bring back).
  const evaluateReconcilePlan = ({ source = "manual" } = {}) => {
    const refusal = (code, message, hint = null, extra = null) => ({
      refusal: { code, message, hint, extra },
    });
    if (source !== kBootReconcileSource && runtimeReconcileDisabled()) {
      return refusal(
        "disabled",
        `Runtime reconcile is disabled (${kRuntimeReconcileEnvKey}=off).`,
        "Unset the kill switch in the deployment environment, or restart AlphaClaw to re-activate the recorded build at boot.",
      );
    }
    if (applyInProgress) {
      return refusal(
        "apply_in_progress",
        "A channel update is in progress — the installed tree cannot be reconciled until it finishes.",
        "Wait for the update to settle, then retry.",
      );
    }
    if (isStateDbQuiet()) {
      return refusal(
        "state_db_quiet",
        "A backup is holding the state databases quiet — the installed tree cannot be swapped underneath it.",
        "Retry in about two minutes.",
      );
    }
    const info = getChannelInfo();
    if (info.stateCorrupted) {
      return refusal(
        "state_corrupted",
        "The release-channel state file could not be read — refusing to reconcile against an unknown record.",
        "Check the release-channel state file under .openclaw/.alphaclaw/ and the server log.",
      );
    }
    if (info.gatewayHold && isMigrationClassHold(info.gatewayHold)) {
      return refusal(
        "gateway_held",
        "The gateway is held after a failed settings migration — reconciling the installed tree cannot clear that hold.",
        "Use Retry migration on the Upgrade page first.",
        { hold: info.gatewayHold },
      );
    }
    if (info.applied?.channel === "dev") {
      return refusal(
        "dev_channel",
        "A dev build is applied — its checkout is what runs, not the installed package tree.",
        "Re-apply the dev build from the Upgrade page instead.",
      );
    }
    const expected = info.expectedVersion;
    if (!expected) {
      return refusal("no_expected_version", "No recorded build to reconcile against.");
    }
    const installDir = safeInstallDir();
    if (!installDir) {
      return refusal(
        "install_dir_unresolved",
        "Could not locate the app install directory.",
      );
    }
    const installed = info.installedVersion;
    const overlayComplete = channelStore.hasOverlay(expected);
    const pinTreeComplete =
      !overlayComplete && installed === expected && pinTreeLooksComplete(installDir);
    if (!overlayComplete && !pinTreeComplete) {
      return refusal(
        "overlay_missing",
        `No complete local copy of OpenClaw ${expected} to activate.`,
        "Re-apply the version from the Upgrade page (it will be downloaded again).",
        { expected, installed },
      );
    }
    const needsActivation = channelStore.needsActivation({
      installDir,
      expectedVersion: expected,
    });
    return {
      plan: {
        info,
        expected,
        installed,
        installDir,
        overlayComplete,
        pinTreeComplete,
        none: installed === expected && !needsActivation,
      },
    };
  };

  const measureTreeBytes = async (dir) => {
    const fsp = fsModule.promises || fs.promises;
    let total = 0;
    const walk = async (current) => {
      let entries;
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          try {
            total += (await fsp.stat(full)).size;
          } catch {}
        }
      }
    };
    await walk(dir);
    return total;
  };

  // { state, agent } — the live DBs' user_version (agent = the highest agent
  // DB, the line this box's agents were migrated to).
  const currentUserVersions = async () => {
    const versions = await readStateDbVersions();
    return {
      state: versions.userVersion,
      agent:
        versions.agentUserVersions.length > 0
          ? Math.max(...versions.agentUserVersions)
          : null,
    };
  };
  // The chooser's oracles: the overlay's public metadata (bounded legacy
  // scan when absent), and the EXISTING boot rollback prober plus the
  // agents.entries config-shape guard as the confirmation.
  const chooserOracles = (prober, { allowMigration = true } = {}) => ({
    resolveSupported: async (version) =>
      supportedSchemaAsync({
        packageDir: channelStore.overlayPackageDir(version),
        version,
      }),
    confirm: async (version) => {
      if (rollbackTargetShapeBlocked(version)) return "block";
      const packageDir = channelStore.overlayPackageDir(version);
      if (!allowMigration) {
        const verdict = await inspectRecoveryTarget(packageDir, version, await recoveryInventory());
        if (!verdict.ok || verdict.migrationRequired) return "block";
      }
      const bin = channelStore.resolvePackageBin(packageDir);
      return prober.probeBinStreamed(bin, { packageDir, version });
    },
    lacksVerb: allowMigration ? lacksDatabasePreflight : () => false,
  });
  // Which locally available build can open the current databases, excluding
  // `exclude` and anything blocklisted: lastKnownGood first (when its overlay
  // is complete), then the newest overlays. null = nothing bootable.
  const chooseBootableCandidate = async ({ exclude = [], prober, allowMigration = false }) => {
    const state = channelStore.readState();
    const excluded = new Set(exclude.filter(Boolean));
    const usable = (version) =>
      Boolean(version) &&
      !excluded.has(version) &&
      !channelStore.isBlocklisted(version) &&
      channelStore.hasOverlay(version);
    const lkg = state.lastKnownGood?.package || null;
    return chooseBootableVersion({
      expected: null,
      lastKnownGood: usable(lkg) ? lkg : null,
      overlays: channelStore.listOverlays().filter(usable),
      userVersions: await currentUserVersions(),
      table: schemaTable,
      ...chooserOracles(prober, { allowMigration }),
    });
  };

  // Confirmed-stop predicate (CEO 1.2): a serving pid tree AlphaClaw did not
  // spawn, any live openclaw process (sampled with the backup quiesce's
  // settle so a stop still unwinding is not misread), or a gateway the
  // quiesce seam still reports running → { kind, pids } — else null.
  const detectIncumbent = async () => {
    let serving = null;
    try {
      serving =
        typeof discoverServingIdentity === "function" ? discoverServingIdentity() : null;
    } catch {
      serving = null;
    }
    if (serving) {
      return {
        kind: "serving_identity",
        pids: Array.isArray(serving.pids) ? serving.pids : [serving.rootPid].filter(Boolean),
      };
    }
    const pollMs = Math.max(1, backupBudget.exclusivitySettlePollMs);
    const maxPolls = Math.ceil(Math.max(0, backupBudget.exclusivitySettleMs) / pollMs);
    let live = probes.listProcesses() || [];
    for (let poll = 0; poll < maxPolls && live.length > 0; poll += 1) {
      await sleepMs(pollMs);
      live = probes.listProcesses() || [];
    }
    if (live.length > 0) {
      return { kind: "live_processes", pids: live.map((entry) => entry.pid) };
    }
    let stillRunning = false;
    try {
      stillRunning = gatewayQuiesce?.isRunning
        ? Boolean(await gatewayQuiesce.isRunning())
        : false;
    } catch {
      stillRunning = false;
    }
    return stillRunning ? { kind: "gateway_running", pids: [] } : null;
  };

  const reconcileInstalled = async ({
    hold = null,
    source = "manual",
    relaunch = false,
    // Schema-recovery mode (#76 B1.1 rung 3): proceed on a NON-diverged tree
    // when the installed build provably cannot read the databases.
    recover = false,
  } = {}) => {
    const requiresRecoveryChoice = source !== "boot" || relaunch;
    const migrationRefusal = (verdict) => ({ code: "recovery_choice_required",
      message: "This runtime repair would migrate databases without an approved recovery checkpoint.",
      hint: "Apply this build from the Upgrade page and choose a complete database recovery set or explicitly approve forward-only recovery.",
      extra: { preflight: verdict } });
    const skipped = ({ code, message, hint, extra }) => {
      logEvent("reconcile_installed", "skipped", { source, code, ...(extra || {}) });
      return { ...channelError(code, message, hint, null, extra), action: "none" };
    };
    const none = (plan) => ({
      ok: true,
      action: "none",
      from: plan.installed,
      to: plan.expected,
      runId: null,
    });
    const first = evaluateReconcilePlan({ source });
    if (first.refusal) return skipped(first.refusal);
    if (first.plan.none) {
      if (!recover) {
        if (requiresRecoveryChoice) {
          const verdict = await assessInstalledLaunchCompatibility({ legacyExecApprovals: "block" });
          if (verdict.migrationRequired) return skipped(migrationRefusal(verdict));
          if (verdict.compatible !== true) return skipped({ code: "db_preflight_failed", message: "Database compatibility could not be verified.", hint: "Restore compatible state before relaunching this build." });
        }
        return none(first.plan);
      }
      // Recovery preflight (no lock, read-only): the installed tree IS the
      // recorded build — swapping it for another local build is justified
      // only by a PROVEN incompatibility with the live databases.
      const preflightProber = createBootPreflightProber();
      let judged = null;
      try {
        judged = await assessInstalledLaunchCompatibility({
          prober: preflightProber,
          legacyExecApprovals: "ignore",
        });
      } catch (error) {
        log(`reconcile(recover): compatibility check failed open (${error?.message || error})`);
        judged = null;
      } finally {
        preflightProber.cleanup();
      }
      if (requiresRecoveryChoice && judged?.migrationRequired) return skipped(migrationRefusal(judged));
      if (requiresRecoveryChoice && judged?.compatible == null) return skipped({ code: "db_preflight_failed", message: "Database compatibility could not be verified.", hint: "Restore compatible state before relaunching this build." });
      if (judged?.compatible !== false) {
        const reason = judged?.compatible === true ? "target_compatible" : "compatibility_unknown";
        logEvent("reconcile_installed", "skipped", { source, code: reason, recover: true });
        return { ...none(first.plan), reason };
      }
    }

    // Lock (Codex 1): the caller's hold or our own — never both.
    let release = hold;
    let ownHold = false;
    if (!release && typeof acquireLifecycleLock === "function") {
      release = await acquireLifecycleLock("reconcile_installed", {
        leaseMs: kOpenclawReconcileLifecycleLeaseMs,
      });
      ownHold = true;
    }
    const holdValid = () =>
      release && typeof release.isValid === "function" ? release.isValid() : true;
    try {
      // The world may have moved while we queued: re-run the gates.
      const gate = evaluateReconcilePlan({ source });
      if (gate.refusal) return skipped(gate.refusal);
      const { plan } = gate;
      if (plan.none && !recover) return none(plan);
      if (!holdValid()) {
        return skipped({
          code: "lease_expired",
          message: "The gateway lifecycle lease expired before the tree was touched.",
          hint: "Retry.",
        });
      }
      const operationId = crypto.randomUUID();
      try {
        ledger.createRun({
          operationId,
          target: { kind: "reconcile", version: plan.expected, from: plan.installed },
        });
      } catch (error) {
        log(`run ledger unavailable: ${error.message}`);
      }
      const step = (name, status, detail = {}) => {
        try {
          ledger.appendStep(operationId, { name, status, ...detail });
        } catch {}
        log(
          `reconcile step ${name}: ${status}${detail.error ? ` (${detail.error})` : ""}`,
        );
      };
      const failRun = ({ code, message, hint = null, extra = null, state = "failed" }) => {
        try {
          ledger.completeRun(operationId, {
            state,
            ok: false,
            result: { ok: false, code, message },
          });
        } catch {}
        logEvent("reconcile_installed", "failed", {
          source,
          code,
          operationId,
          expected: plan.expected,
          installed: plan.installed,
          ...(extra || {}),
        });
        return {
          ...channelError(code, message, hint, null, extra),
          action: "none",
          from: plan.installed,
          to: plan.expected,
          runId: operationId,
        };
      };
      const leaseExpired = () =>
        failRun({
          code: "lease_expired",
          message: "The gateway lifecycle lease expired before the tree was touched.",
          hint: "Retry.",
        });
      const prober = createBootPreflightProber();
      let suppressed = false;
      let suppressionOwner = null;
      let managed = false;
      try {
        // 1. Target compatibility FIRST (Eng 1B / Codex 2).
        let chosen = { version: plan.expected, source: "expected", confirmed: false };
        let schemaRecovery = false;
        const targetCandidate = plan.overlayComplete
          ? describeBinAt(
              channelStore.overlayPackageDir(plan.expected),
              plan.expected,
              "overlay",
            )
          : describeBinAt(installedPackageDir(plan.installDir), plan.expected, "installed");
        let compat = null;
        try {
          compat = targetCandidate
            ? await assessBinCompatibility(targetCandidate, { prober })
            : null;
        } catch (error) {
          compat = null;
          log(`reconcile: compatibility check for ${plan.expected} failed open (${error?.message || error})`);
        }
        if (!holdValid()) return leaseExpired();
        if (requiresRecoveryChoice && compat?.migrationRequired) return failRun(migrationRefusal(compat));
        if (compat?.compatible !== true) {
          compat ||= { reasons: ["compatibility_unknown"] };
          logEvent("reconcile_installed", "target_incompatible", {
            source,
            operationId,
            expected: plan.expected,
            reasons: compat.reasons,
          });
          log(
            `reconcile: ${plan.expected} cannot open the current state databases (${compat.reasons.join(", ")}) — consulting the bootable-candidate chooser`,
          );
          const candidate = await chooseBootableCandidate({
            exclude: [plan.expected],
            prober,
            allowMigration: !requiresRecoveryChoice,
          });
          if (!holdValid()) return leaseExpired();
          if (!candidate) {
            return failRun({
              code: "no_bootable_version",
              message: `OpenClaw ${plan.expected} cannot read the current state databases (${compat.reasons.join(", ")}) and no other local build can either.`,
              hint: "Restore the newest verified backup, or apply a newer version from the Upgrade page.",
              extra: { expected: plan.expected, reasons: compat.reasons },
            });
          }
          chosen = candidate;
          schemaRecovery = true;
          try {
            ledger.updateRun(operationId, (record) => {
              record.target = {
                ...(record.target || {}),
                version: candidate.version,
                expected: plan.expected,
                schemaRecovery: true,
              };
              return record;
            });
          } catch {}
        }
        if (recover && plan.none && !schemaRecovery) {
          // Recovery mode on a non-diverged tree: the preflight said the
          // installed build cannot read the DBs, the locked re-check does not
          // agree (a restore landed meanwhile) — nothing to swap. The run
          // closes as a no-op, the tree is untouched.
          const reason = compat?.compatible === true ? "target_compatible" : "compatibility_unknown";
          try {
            ledger.completeRun(operationId, {
              state: "noop",
              ok: true,
              result: { ok: true, action: "none", reason },
            });
          } catch {}
          logEvent("reconcile_installed", "skipped", { source, code: reason, recover: true, operationId });
          return { ...none(plan), reason, runId: operationId };
        }
        const activatesOverlay = plan.overlayComplete || schemaRecovery;

        // 2. Confirmed stop (CEO 1.2).
        step("stop", "running");
        try {
          watchdogManagedOperation?.begin?.();
          managed = true;
        } catch {}
        if (gatewayQuiesce?.suppress) {
          try {
            suppressionOwner = gatewayQuiesce.suppress(kReconcileSuppressMs);
            suppressed = true;
          } catch {}
        }
        let wasRunning = false;
        try {
          wasRunning = gatewayQuiesce?.isRunning
            ? Boolean(await gatewayQuiesce.isRunning())
            : false;
        } catch {
          wasRunning = false;
        }
        let stopped = !wasRunning;
        if (wasRunning && gatewayQuiesce?.stop) {
          try {
            stopped = Boolean(await gatewayQuiesce.stop());
          } catch {
            stopped = false;
          }
        }
        if (!holdValid()) return leaseExpired();
        const incumbent = stopped ? await detectIncumbent() : { kind: "stop_unconfirmed", pids: [] };
        if (incumbent) {
          const detail =
            incumbent.pids.length > 0
              ? `${incumbent.kind}: pid ${incumbent.pids.join(", ")}`
              : incumbent.kind;
          step("stop", "failed", { error: detail });
          queueNotify(
            `🔴 Could not re-activate OpenClaw ${chosen.version}: a gateway process is still running (${detail}). Nothing was changed — stop it, then retry from the Upgrade page.`,
            {
              eventType: "health",
              id: `reconcile-incumbent-${plan.installed}-${chosen.version}-${notifyDayBucket()}`,
            },
          );
          return failRun({
            code: "incumbent_running",
            message: `A gateway process is still running (${detail}) — refusing to replace the OpenClaw tree underneath it.`,
            hint: "Stop the process running the gateway (an external supervisor or a manual `openclaw gateway`), then retry.",
            extra: { incumbent },
          });
        }
        step("stop", "completed", {
          detail: wasRunning ? "gateway stopped" : "gateway was not running",
        });
        if (requiresRecoveryChoice) {
          const verdict = await inspectRecoveryTarget(activatesOverlay ? channelStore.overlayPackageDir(chosen.version) : installedPackageDir(plan.installDir),
            chosen.version, await recoveryInventory());
          if (!holdValid()) return leaseExpired();
          if (verdict.migrationRequired) return failRun(migrationRefusal(verdict));
          if (!verdict.ok) return failRun({ code: "db_preflight_failed", message: "Database compatibility changed while stopping the gateway.", hint: "Restore compatible state before reactivating this build." });
        }

        // 3. Disk headroom (CEO 2.2) — the staged copy coexists with the
        // live tree until the rename.
        const diskFor = async (version) => {
          const bytes = await measureTreeBytes(channelStore.overlayPackageDir(version));
          const required = Math.ceil(bytes * kReconcileDiskHeadroom);
          return {
            required,
            ...checkDiskSpace(required, path.join(plan.installDir, "node_modules")),
          };
        };
        if (activatesOverlay) {
          const space = await diskFor(chosen.version);
          if (!holdValid()) return leaseExpired();
          if (!space.ok) {
            step("activate", "failed", { error: "insufficient disk" });
            return failRun({
              code: "insufficient_disk",
              message: `Not enough free space to stage OpenClaw ${chosen.version} (${Math.round(space.required / 1e6)} MB needed, ${Math.round((space.free ?? 0) / 1e6)} MB free).`,
              hint: "Free space or grow the volume in your hosting dashboard, then retry.",
              extra: { requiredBytes: space.required, freeBytes: space.free },
            });
          }
        }

        // 4. Activate.
        step("activate", "running", {
          detail: `activating ${chosen.version}${schemaRecovery ? ` (schema recovery — ${plan.expected} cannot read the databases)` : ""}`,
        });
        let activation;
        if (activatesOverlay) {
          activation = await channelStore.activateOverlayAsync({
            installDir: plan.installDir,
            version: chosen.version,
          });
        } else {
          // The pin's tree is complete and IS the expected build; only the
          // sentinel is missing (same rule as the boot pin fallback).
          try {
            channelStore.removeBinShim?.();
          } catch {}
          const sentinel = channelStore.writeSentinel({
            installDir: plan.installDir,
            version: chosen.version,
          });
          activation = sentinel.ok
            ? { ok: true }
            : { ok: false, stage: "sentinel", error: sentinel.error };
        }
        if (!activation.ok) {
          const afterRm = activation.stage === "swap" || activation.stage === "sentinel";
          step("activate", "failed", {
            error: `${activation.stage}: ${activation.error}`,
          });
          if (!afterRm) {
            return failRun({
              code: "activation_failed",
              message: `Could not stage OpenClaw ${chosen.version} (${activation.stage}: ${activation.error}); the installed tree was not touched.`,
              hint: "Check disk space and the overlay store, then retry.",
              extra: { stage: activation.stage, error: activation.error },
              state: "activation_failed",
            });
          }
          // After the rm: no sentinel, tree gutted → hold + notify, then ONE
          // chooser retry for a candidate that can read the DBs.
          const hold = setStructuralHold("activation_failed", {
            detail: `OpenClaw ${chosen.version} could not be activated after the previous tree was removed (${activation.stage}: ${activation.error}) — the gateway is held until a build is activated`,
            installed: plan.installed,
            expected: chosen.version,
            error: activation.error || activation.stage,
          });
          queueNotify(
            `🔴 OpenClaw ${chosen.version} could not be re-activated after the previous tree was removed (${activation.error}). The gateway is HELD — nothing launches from a half-copied tree. Free disk space, then use "Re-activate recorded build" on the Upgrade page or restart AlphaClaw.`,
            {
              eventType: "upgrade_failed",
              id: `reconcile-activation-failed-${chosen.version}-${notifyDayBucket()}`,
            },
          );
          let recovered = null;
          const fallback = await chooseBootableCandidate({
            exclude: [chosen.version, plan.expected],
            prober,
            allowMigration: !requiresRecoveryChoice,
          });
          if (fallback && holdValid()) {
            const space = await diskFor(fallback.version);
            if (space.ok) {
              const second = await channelStore.activateOverlayAsync({
                installDir: plan.installDir,
                version: fallback.version,
              });
              if (second.ok) recovered = fallback;
              else {
                step("activate", "failed", {
                  error: `${fallback.version}: ${second.stage}: ${second.error}`,
                });
              }
            }
          }
          if (!recovered) {
            return failRun({
              code: "activation_failed",
              message: `OpenClaw ${chosen.version} could not be activated after the previous tree was removed (${activation.stage}: ${activation.error}) — the gateway is held.`,
              hint: "Free disk space, then retry from the Upgrade page or restart AlphaClaw.",
              extra: { stage: activation.stage, error: activation.error, hold },
              state: "activation_failed",
            });
          }
          chosen = recovered;
          schemaRecovery = true;
          step("activate", "completed", {
            detail: `activated ${chosen.version} after the first candidate failed`,
          });
        } else {
          step("activate", "completed", { detail: `activated ${chosen.version}` });
        }

        // 5. Verify.
        step("verify", "running");
        const installedNow = channelStore.readInstalledVersion({
          installDir: plan.installDir,
        });
        const sentinelOk = !channelStore.needsActivation({
          installDir: plan.installDir,
          expectedVersion: chosen.version,
        });
        if (installedNow !== chosen.version || !sentinelOk) {
          const error = `installed ${installedNow || "nothing"} after activating ${chosen.version}${sentinelOk ? "" : " (sentinel missing)"}`;
          step("verify", "failed", { error });
          const hold = setStructuralHold("activation_failed", {
            detail: `OpenClaw ${chosen.version} was activated but the live tree reads as ${installedNow || "nothing"} — the gateway is held`,
            installed: installedNow,
            expected: chosen.version,
            error,
          });
          queueNotify(
            `🔴 OpenClaw ${chosen.version} was re-activated but the installed tree reads as ${installedNow || "nothing"}. The gateway is HELD — restart AlphaClaw or retry from the Upgrade page.`,
            {
              eventType: "upgrade_failed",
              id: `reconcile-verify-failed-${chosen.version}-${notifyDayBucket()}`,
            },
          );
          return failRun({
            code: "verify_failed",
            message: `Activation of OpenClaw ${chosen.version} did not verify: ${error}.`,
            hint: "Restart AlphaClaw to re-activate at boot, or retry from the Upgrade page.",
            extra: { installedNow, hold },
            state: "activation_failed",
          });
        }
        step("verify", "completed", { detail: `installed ${installedNow}` });

        // 6. Bookkeeping: the post-activation invalidation hook applyUpdate
        // calls at its record step, the holds this path owns, the record.
        channelStore.updateState((s) => {
          if (s.gatewayHold && kStructuralHoldReasons.has(s.gatewayHold.reason)) {
            s.gatewayHold = null;
          }
          if (schemaRecovery) {
            s.applied =
              chosen.version === s.pinVersion
                ? null
                : {
                    channel: isPrereleaseVersion(chosen.version) ? "beta" : "stable",
                    version: chosen.version,
                    at: nowFn(),
                    acceptedAt: null,
                    operationId,
                    reason: "schema_recovery",
                  };
          }
          return s;
        });
        firstHealthyAt = null;
        try {
          clearVersionCache();
        } catch {}
        const leaseExpiredAfterSwap = !holdValid();
        logEvent("reconcile_installed", "activated", {
          source,
          operationId,
          from: plan.installed,
          to: chosen.version,
          expected: plan.expected,
          schemaRecovery,
          relaunch,
          leaseExpired: leaseExpiredAfterSwap,
        });
        const who = source === "operator" ? "An operator re-activated" : "AlphaClaw re-activated";
        queueNotify(
          `🔧 ${who} OpenClaw ${chosen.version} (the tree on disk was ${plan.installed || "unknown"})${schemaRecovery ? ` — the recorded ${plan.expected} cannot read the current state databases, so the newest compatible local build was chosen` : ""}. The gateway is relaunching on it.`,
          { eventType: "health", id: `reconcile-installed-${operationId}` },
        );
        return {
          ok: true,
          action: "activated",
          from: plan.installed,
          to: chosen.version,
          expected: plan.expected,
          schemaRecovery,
          runId: operationId,
          leaseExpired: leaseExpiredAfterSwap,
        };
      } catch (error) {
        return failRun({
          code: "reconcile_failed",
          message: `Reconcile failed unexpectedly: ${error?.message || error}`,
        });
      } finally {
        prober.cleanup();
        if (suppressed) {
          try {
            gatewayQuiesce.unsuppress(suppressionOwner);
          } catch {}
        }
        if (managed) {
          try {
            watchdogManagedOperation?.end?.();
          } catch {}
        }
      }
    } finally {
      if (ownHold) {
        try {
          release?.();
        } catch {}
      }
    }
  };

  // Codex 7: the caller owns the relaunch step. `relaunch` is the caller's
  // outcome ({ ok, verdict?, error? }); a relaunch that did not verify
  // completes the run `failed` with code relaunch_failed — the activation
  // itself stood, which the steps show.
  const completeReconcileRun = ({ runId, relaunch = null } = {}) => {
    if (!runId) return null;
    const ok = relaunch?.ok === true;
    try {
      ledger.appendStep(runId, {
        name: "relaunch",
        status: ok ? "completed" : "failed",
        ...(relaunch?.verdict ? { detail: String(relaunch.verdict) } : {}),
        ...(relaunch?.error ? { error: String(relaunch.error) } : {}),
      });
      const record = ledger.completeRun(runId, {
        state: ok ? "activated" : "failed",
        ok,
        result: {
          ok,
          ...(relaunch?.verdict ? { verdict: relaunch.verdict } : {}),
          ...(ok ? {} : { code: "relaunch_failed" }),
          ...(relaunch?.error ? { error: String(relaunch.error) } : {}),
        },
      });
      ledger.pruneRuns();
      return record;
    } catch (error) {
      log(`reconcile run ${runId} could not be completed (${error?.message || error})`);
      return null;
    }
  };

  // ── Launch compatibility gate (#76 C1 belt / C2) ───────────────────────
  //
  //   assessLaunchCompatibilityAtBoot({ hold })      boot step (4), startup.js
  //     ├─ OPENCLAW_LAUNCH_COMPAT_GATE=off → { compatible: null, skipped }
  //     ├─ no installed tree → nothing to judge (a fresh box)
  //     ├─ assessInstalledLaunchCompatibility: the INSTALLED tree's supported
  //     │    schema (declared dist constants memoized per installedVersion —
  //     │    Eng 1A — else the learned/seeded table) vs every DB's
  //     │    user_version read FRESH through the tracked handle; the boot
  //     │    rollback prober only for a build with the verb whose state line
  //     │    stays unknown (the expensive oracle, Codex 4)
  //     ├─ false → gatewayHold { reason: version_mismatch |
  //     │    state_db_unreadable, detail, installed, expected, bootId } via
  //     │    setStructuralHold (the writer the reconcile path uses), a
  //     │    launch_compat_gate/held row, an always-send notification →
  //     │    { compatible: false, hold } (startup.js skips startGateway;
  //     │    reconcileBootConfig returns `held` before any doctor — Codex 6)
  //     ├─ null ∧ installedDiverged ∧ hasOverlay(expected) → treated as false
  //     │    for the purpose of PREFERRING reconciliation: ONE more
  //     │    reconcileInstalled({ hold, source: "boot" }) (step 3 may have
  //     │    been refused) → activated → the NEW tree is judged; refused →
  //     │    hold version_mismatch
  //     ├─ pure null → loud warning + launch_compat_gate/unknown row,
  //     │    { compatible: null, hold: null } (fail open — F008)
  //     └─ true → a stale state_db_unreadable hold this gate owns is cleared
  //   Contract: the RETURN decides; a throw is swallowed by startup.js's
  //   runBootStep and reads as "no verdict" (fail open). The lifecycle lock
  //   is not re-entrant (Codex 1): `hold` is the boot lease and is passed
  //   through to reconcileInstalled, never re-acquired.
  //
  //   legacy exec-approvals.json (#23): the boot gate records the fact but
  //   never holds on it — ensureManagedExecDefaults, the very next boot step,
  //   renames the stray file before the gateway launches (AGENTS.md "Exec
  //   approvals"), so a hold here would freeze a box the boot heals a moment
  //   later. Callers on a path with no reaper (the runtime relaunch step)
  //   pass legacyExecApprovals: "block"; see kLaunchCompatHoldReasons.
  const launchCompatGateDisabled = () =>
    String(process.env[kLaunchCompatGateEnvKey] || "")
      .trim()
      .toLowerCase() === "off";
  const warn = (message) => {
    try {
      logger.warn(`${kLogPrefix} ${message}`);
    } catch {}
  };

  // The pure verdict for the tree on disk, with the hold class it maps to.
  //   → { compatible, reasons, perDb, supported: { state, agent },
  //       installedVersion, legacyExecApprovalsPresent, holdReason }
  const assessInstalledLaunchCompatibility = async ({
    prober = null,
    legacyExecApprovals = "block",
  } = {}) => {
    const build = await getExecutingBuild();
    const version = build?.version;
    if (!build) {
      return {
        compatible: null,
        reasons: [],
        perDb: [],
        supported: { state: null, agent: null },
        installedVersion: null,
        legacyExecApprovalsPresent: false,
        holdReason: null,
      };
    }
    const supported = build.schemas;
    const legacyExecApprovalsPresent = legacyExecApprovalsPresentFor(version);
    const candidate = build;
    const verdict = await assessBinCompatibility(candidate, {
      prober,
      supported,
      legacyExecApprovalsPresent:
        legacyExecApprovals === "block" ? legacyExecApprovalsPresent : false,
    });
    return {
      ...verdict,
      supported: { state: supported.state, agent: supported.agent },
      installedVersion: version,
      executingBuild: build,
      legacyExecApprovalsPresent,
      holdReason: verdict.compatible !== true ? compatHoldReasonFor(verdict.reasons) || verdict.holdReason : null,
    };
  };

  const holdRecoveryChoice = async ({ verdict, hold = null } = {}) => {
    const expected = verdict?.executingBuild;
    if (verdict?.compatible !== true || verdict?.migrationRequired !== true || !expected?.buildId) return { ok: false, code: "recovery_choice_not_required" };
    const sameBuild = () => {
      const current = executingBuild();
      return current && ["buildId", "version", "packageDir", "bin"].every((key) => current[key] === expected[key]);
    };
    if (applyInProgress || !sameBuild()) return { ok: false, code: "recovery_source_changed" };
    let release = hold;
    let owned = false;
    try {
      if (!release) {
        if (tryAcquireLifecycleLock) release = tryAcquireLifecycleLock("recovery_choice", { leaseMs: 30_000 });
        else if (!acquireLifecycleLock) release = localApplyLock.tryAcquire("recovery_choice", { leaseMs: 30_000 });
        else {
          if (getActiveGatewayOperation?.()) return { ok: false, code: "gateway_operation_in_progress" };
          release = await acquireLifecycleLock("recovery_choice", { leaseMs: 30_000 });
        }
        owned = true;
      }
      if (!release) return { ok: false, code: "gateway_operation_in_progress" };
      if (gatewayQuiesce?.isCancelled?.()) return { ok: false, code: "operation_cancelled" };
      applyCommitPolicy.assert({ hold: release, intent: kGatewayMutationIntents.restart });
      if (applyInProgress || !sameBuild()) return { ok: false, code: "recovery_source_changed" };
      let saved = false;
      const state = channelStore.updateState((current) => {
        if (current.gatewayHold || !sameBuild() || release.isValid?.() === false) return current;
        current.gatewayHold = { reason: "recovery_choice_required", at: nowFn(), operationId: null, blamedKeys: [],
          installed: expected.buildId, expected: expectedVersionOf(current), bootId: getProcessBootId(),
          detail: "This build needs to migrate the databases. Apply it from the Upgrade page and choose recovery protection before restarting." };
        saved = true;
        return current;
      });
      return saved ? { ok: true, hold: state.gatewayHold } : { ok: false, code: "gateway_held" };
    } catch (error) { return { ok: false, code: error.code || "recovery_hold_unavailable" }; }
    finally { if (owned) release?.(); }
  };

  // Operator prose for a refusal: one clause per finding, relative DB paths.
  const describeLaunchCompatFindings = (verdict) => {
    const findings = [];
    for (const row of Array.isArray(verdict?.perDb) ? verdict.perDb : []) {
      const label = dbEntryLabel({ path: row.path });
      if (row.status === "corrupt") {
        findings.push(`${label} is unreadable (corrupt)`);
      } else if (row.verdict === "incompatible") {
        findings.push(
          `${label} is at ${row.kind} schema ${row.userVersion}, newer than the ${row.supported} this build supports`,
        );
      } else if (row.probe === "block") {
        findings.push(`${label} was refused by this build's database preflight`);
      }
    }
    if (
      Array.isArray(verdict?.reasons) &&
      verdict.reasons.includes(kLaunchCompatReasons.legacyExecApprovalsPresent)
    ) {
      findings.push("a legacy exec-approvals.json is present");
    }
    return findings;
  };
  const describeLaunchCompatHold = (verdict, { installed, expected }) => {
    const findings = describeLaunchCompatFindings(verdict);
    const what = findings.length > 0 ? findings.join("; ") : verdict.reasons.join(", ");
    return `OpenClaw ${installed || "unknown"} cannot open the state databases on disk (${what}) — the gateway is held; nothing launches or migrates from a build that cannot read them${expected && expected !== installed ? ` (recorded build: ${expected})` : ""}`;
  };

  const assessLaunchCompatibilityAtBoot = async ({ hold = null } = {}) => {
    const info = getChannelInfo();
    const base = {
      installed: info.installedVersion ?? null,
      expected: info.expectedVersion ?? null,
      reasons: [],
      perDb: [],
      supported: null,
      hold: null,
      reconcile: null,
    };
    if (!info.installedVersion) {
      return { ...base, compatible: null, skipped: "no_install" };
    }
    const prober = createBootPreflightProber();
    try {
      let verdict = await assessInstalledLaunchCompatibility({
        prober,
        legacyExecApprovals: "ignore",
      });
      let installed = verdict.installedVersion;
      let expected = info.expectedVersion ?? null;
      let reconcile = null;
      let treatedAsFalse = false;
      if (
        verdict.compatible === null &&
        info.installedDiverged &&
        channelStore.hasOverlay(expected)
      ) {
        // Activating the recorded build is non-destructive; an unknown
        // verdict on a tree nobody chose is not worth launching.
        log(
          `launch gate: compatibility of installed ${installed} is unknown (${verdict.reasons.join(", ") || "no oracle"}) while ${expected} is the recorded build with a complete overlay — re-activating it first`,
        );
        reconcile = await reconcileInstalled({ hold, source: "boot", relaunch: false });
        if (reconcile?.ok && reconcile.action === "activated") {
          verdict = await assessInstalledLaunchCompatibility({
            prober,
            legacyExecApprovals: "ignore",
          });
          installed = verdict.installedVersion;
        } else {
          treatedAsFalse = true;
        }
      }
      const summary = {
        ...base,
        installed,
        expected,
        reasons: verdict.reasons,
        perDb: verdict.perDb,
        supported: verdict.supported,
        reconcile,
        legacyExecApprovalsPresent: verdict.legacyExecApprovalsPresent,
      };
      if (verdict.legacyExecApprovalsPresent) {
        log(
          "launch gate: a legacy exec-approvals.json is present — ensureManagedExecDefaults renames it before the gateway launches; not a hold",
        );
      }
      if (verdict.compatible !== true || treatedAsFalse) {
        const reason = treatedAsFalse ? "version_mismatch" : verdict.holdReason || "version_mismatch";
        const divergedWithOverlay =
          getChannelInfo().installedDiverged && channelStore.hasOverlay(expected);
        const detail = treatedAsFalse
          ? `OpenClaw ${installed} is not the recorded build ${expected} (its overlay is complete) and its compatibility with the state databases is unknown (${verdict.reasons.join(", ") || "no oracle"}; re-activation ${reconcile?.code || reconcile?.action || "failed"}) — the gateway is held until ${expected} is active`
          : describeLaunchCompatHold(verdict, { installed, expected });
        const gatewayHold = setStructuralHold(reason, { detail, installed, expected });
        logEvent("launch_compat_gate", "held", {
          reason,
          reasons: verdict.reasons,
          installed,
          expected,
          supported: verdict.supported,
          stateDb: verdict.perDb.map((row) => ({
            path: dbEntryLabel({ path: row.path }),
            kind: row.kind,
            userVersion: row.userVersion,
            status: row.status,
            verdict: row.verdict,
            ...(row.probe ? { probe: row.probe } : {}),
          })),
          ...(reconcile ? { reconcile: { ok: reconcile.ok, code: reconcile.code ?? null, action: reconcile.action ?? null } } : {}),
        });
        warn(`launch gate: HELD (${reason}) — ${detail}`);
        const remedy =
          reason === "state_db_unreadable"
            ? "Restore the newest verified backup from the Upgrade page."
            : divergedWithOverlay
              ? `Restart AlphaClaw to re-activate ${expected}, or use "Re-activate recorded build" on the Upgrade page.`
              : "Apply a newer OpenClaw from the Upgrade page (one that understands this database), or restore the newest verified backup.";
        queueNotify(
          `🔴 OpenClaw ${installed} cannot open the state databases on disk (${describeLaunchCompatFindings(verdict).join("; ") || verdict.reasons.join(", ") || "compatibility unknown, tree not the recorded build"}). The gateway is HELD — nothing launches or migrates your settings from a build that cannot read them. ${remedy} Details: \`alphaclaw diagnose\`.`,
          {
            eventType: "health",
            // The config gate's first guard notifies the diverged+overlay
            // shape under this id too: one notice per boot for one condition.
            id: divergedWithOverlay
              ? `version-mismatch-held-${installed}-${expected}`
              : `launch-compat-held-${reason}-${installed}-${notifyDayBucket()}`,
          },
        );
        return { ...summary, compatible: false, hold: gatewayHold };
      }
      // Compatible: the one hold class this gate owns outright is cleared
      // when every DB reads again (version_mismatch is the config gate's to
      // clear on convergence — it re-judges the tree through this module).
      const stale = channelStore.readState().gatewayHold;
      if (["state_db_unreadable", "state_db_unverified"].includes(stale?.reason)) {
        channelStore.updateState((s) => {
          if (s.gatewayHold?.reason === stale.reason) s.gatewayHold = null;
          return s;
        });
        log(
          `launch gate: cleared the ${stale.reason} hold — every state database reads again under OpenClaw ${installed}`,
        );
        logEvent("launch_compat_gate", "hold_cleared", { reason: stale.reason, installed });
      }
      log(`launch gate: OpenClaw ${installed} can open the state databases (state ${verdict.supported.state ?? "?"}, agent ${verdict.supported.agent ?? "?"})`);
      return { ...summary, compatible: true };
    } catch (error) {
      const gatewayHold = setStructuralHold("state_db_unverified", { detail: "Recovery metadata could not be verified", installed: base.installed, expected: base.expected });
      return { ...base, compatible: false, hold: gatewayHold, reasons: [error.code || "recovery_metadata_unavailable"] };
    } finally {
      prober.cleanup();
    }
  };

  // ── Revert collateral (#76 B1.5) ───────────────────────────────────────
  // A whole-file config restore this boot performed (configMigration.
  // lastRestore, written by restoreConfigFromBackup) is only right when the
  // boot it served was consistent. When THIS boot's report verdict is
  // INCONSISTENT (the restore ran under a wrong binary), the structural repair
  // undoes it before relaunching the corrected binary: the byte-exact
  // pre-restore copy goes back under the config lock, completedForVersion
  // returns to previousCompletedForVersion, and the record is cleared (the
  // event + config-gate diff keep the evidence). `inconsistent` lets a caller
  // that already holds the verdict skip the report read.
  const readBootVerdictForBoot = (bootId) => {
    for (const name of [kBootReportFileName, kBootReportIncidentFileName]) {
      try {
        const report = JSON.parse(
          fsModule.readFileSync(path.join(managedDirPath(), name), "utf8"),
        );
        if (report && typeof report === "object" && report.bootId === bootId) {
          return normalizeVerdict(report.serverPhase?.verdict ?? report.verdict);
        }
      } catch {}
    }
    return null;
  };
  const undoLastConfigRestore = ({
    bootId = getProcessBootId(),
    inconsistent = null,
  } = {}) => {
    const decline = (code, extra = {}) => ({ ok: false, code, ...extra });
    let state;
    try {
      state = channelStore.readState();
    } catch (error) {
      return decline("state_unreadable", { error: error.message });
    }
    const lastRestore =
      state.configMigration && typeof state.configMigration === "object"
        ? state.configMigration.lastRestore
        : null;
    if (!lastRestore || typeof lastRestore !== "object") return decline("no_restore");
    if (lastRestore.bootId !== bootId) {
      return decline("foreign_boot", { restoreBootId: lastRestore.bootId ?? null });
    }
    const verdict = inconsistent === null ? readBootVerdictForBoot(bootId) : null;
    const isInconsistent =
      inconsistent === null ? Array.isArray(verdict) && verdict.length > 0 : inconsistent === true;
    if (!isInconsistent) return decline("boot_consistent", { verdict });
    const preRestorePath = lastRestore.preRestorePath;
    if (!preRestorePath || !fsModule.existsSync(preRestorePath)) {
      return decline("pre_restore_missing", { preRestorePath: preRestorePath ?? null });
    }
    const configPath = resolveOpenclawConfigPath({ openclawDir });
    try {
      withFileLockSync(
        configPath,
        () => {
          // Byte copy, never re-serialized (JSON5/$include survive).
          writeFileAtomic(configPath, fsModule.readFileSync(preRestorePath), { fsModule });
        },
        { fsModule, timeoutMs: 1000 },
      );
    } catch (error) {
      log(`config-gate: undo of ${lastRestore.from} FAILED (${error.message})`);
      return decline("restore_failed", { error: error.message });
    }
    const completedForVersion = lastRestore.previousCompletedForVersion ?? null;
    try {
      channelStore.updateState((s) => {
        const prev =
          s.configMigration && typeof s.configMigration === "object" ? s.configMigration : {};
        s.configMigration = {
          completedForVersion,
          // The previous version alone cannot establish a dev build's SHA.
          completedForBuild: null,
          lastAttempt: prev.lastAttempt ?? null,
          lastRestore: null,
        };
        return s;
      });
    } catch (error) {
      log(`config-gate: undo recorded on disk but not in state (${error.message})`);
    }
    const from = path.basename(preRestorePath);
    log(
      `config-gate: undid the ${lastRestore.source || "config"} restore of ${lastRestore.from} — ${from} is live again; completedForVersion reset to ${completedForVersion ?? "none"} (boot ${bootId} was inconsistent)`,
    );
    logEvent("config_migration_gate", "restore_undone", {
      bootId,
      from: lastRestore.from,
      restoredFrom: from,
      source: lastRestore.source ?? null,
      completedForVersion,
      verdict,
    });
    queueNotify(
      `↩️ The settings restore this boot performed (${lastRestore.from}) ran under the wrong OpenClaw build and was undone — your settings are back to the pre-restore copy (${from}). The corrected build relaunches next.`,
      { eventType: "health", id: `config-restore-undone-${bootId}` },
    );
    return { ok: true, restoredFrom: preRestorePath, completedForVersion, verdict };
  };

  return {
    syncAtBoot,
    applyUpdate,
    runStandaloneBackup,
    getBackupPreflight: async () => {
      try {
        const inventory = await recoveryInventory();
        return { ok: true, blocked: false, profile: "config_only",
          checkpoint: { bytes: inventory.totalBytes, fileCount: inventory.files.length, maxBytes: 16777216 },
          databaseCount: inventory.dbs.length, databaseBytes: inventory.dbs.reduce((sum, db) => sum + db.bytes + (db.walBytes || 0), 0),
          coverage: { config: "complete", databases: "omitted" }, reason: null };
      } catch (error) {
        return { ok: true, blocked: true, profile: "config_only",
          checkpoint: { bytes: 0, fileCount: 0, maxBytes: 16777216 },
          databaseCount: 0, databaseBytes: 0, coverage: { config: "unverified", databases: "omitted" },
          reason: error.code || "recovery_inventory_unavailable" };
      }
    },
    getBackupSourceContext: () => {
      const spawnEnv = Object.freeze({ ...openclawSpawnEnv() });
      return { stateDir: stateDir(spawnEnv), spawnEnv };
    },
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
    // Issue #76 A7 / A1 / A2: the server boot sequence's listening-path
    // closer, the boot report's state-DB facts, the launch-record reader
    // (watchdog relaunch rows + restart-op record) and the pre-outbox
    // webhook the INCONSISTENT verdict rides on.
    closeDanglingRecordsAtBoot,
    // #79 (g): `.tmp` hygiene — boot mode from runOnboardedBootSequence
    // (lib/server.js sweepBackupDebrisAtBoot), in-run mode from the ladder.
    sweepBackupDebris,
    describeStateDbSchema,
    readStateDbVersions,
    recordObservedSchemaAfterMigration,
    postBootWebhook,
    isApplyInProgress: () => applyInProgress,
    // Issue #76 B1.2 / B1.4 / B1.5 / C6 (Stage 3): the runtime installed-tree
    // reconcile (route + structural repair), its caller-owned run completion,
    // the schema-driven forward-recovery path (await-capable callers), the
    // revert-collateral undo, and the DB-compatible binary resolvers the
    // backup step / capability probes route through while the tree diverges.
    reconcileInstalled,
    completeReconcileRun,
    requestForwardRecoveryAsync,
    undoLastConfigRestore,
    resolveExpectedBin,
    compatibleBinForCurrentDb,
    // Issue #76 C1 belt / C2 (Stage 3 I2): the boot launch-compatibility gate
    // (step 4 of runOnboardedBootSequence), its pure core for the runtime
    // relaunch step, and the memoized supported-schema reader they share.
    assessLaunchCompatibilityAtBoot,
    assessInstalledLaunchCompatibility,
    getSupportedSchemaForInstalled,
    getExecutingBuild,
    requestBackupRiskConsent,
    cancelRecoveryReview,
    holdRecoveryChoice,
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
// default-wired sync (no gateway, no watchdog, no network) and runs it. The
// bin-phase boot-report writer (issue #76 A1) is built HERE, once per boot,
// from the store's managed dir and the process boot id — the same id the
// server phase merges against — and a writer that cannot be constructed
// costs one warning, never the sync. `selfVersion` is the bin's
// stampSelfVersionAtBoot() result (null when the stamp failed).
const runOpenclawChannelBootSync = ({ logger = console, selfVersion = null } = {}) => {
  const store = createOpenclawReleaseChannelStore({ logger });
  let bootReport = null;
  try {
    bootReport = createBootReportWriter({
      managedDir: store.managedDir,
      bootId: getProcessBootId(),
      logger,
    });
  } catch (error) {
    try {
      logger.warn(`${kLogPrefix} boot report writer unavailable (${error?.message || error})`);
    } catch {}
  }
  const sync = createOpenclawChannelSync({ logger, store, bootReport, selfVersion });
  return sync.syncAtBoot();
};

module.exports = {
  createOpenclawChannelSync,
  runOpenclawChannelBootSync,
  // Config-gate intent + ONE hold model (issue #76 RC3 / Codex 6): pure
  // helpers the boot reconciler, getChannelInfo (Stage 1d) and the version
  // gates share — do not re-derive them.
  describeVersionRegressionIntent,
  kVersionRegressionIntentRows,
  kTransitionIntentMaxAgeMs,
  kRecentUpdateRunIntentMaxAgeMs,
  computeInstalledDiverged,
  expectedVersionOf,
  // Pin-lag bookkeeping (Codex D12) — pure, shared with the tests.
  advancePinLag,
  kPinLagMaxBoots,
  kPinLagMaxAgeMs,
  isMigrationClassHold,
  kStructuralHoldReasons,
  kLaunchCompatGateEnvKey,
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
  chooseBackupRung,
  predictTransferMs,
  kDefaultBackupBudget,
  backupBudgetPins,
  parseMountInfoFsType,
  selectClassifierTail,
  // #79 (h): the progress line, pinned as data by the backup-retry suite.
  describeBackupProgress,
  formatBackupBytes,
  // Secret-free env (OpenClaw paths kept, credentials stripped) for running
  // external package code — dev builds here, Buzz plugin install (E-C12).
  buildDevUpdateEnv,
};
