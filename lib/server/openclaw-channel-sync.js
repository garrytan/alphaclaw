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
  kOpenclawBackupQuiesceSuppressSlackMs,
  kOpenclawBackupWorkspaceInlineBytes,
  kBackupTailClassifyLines,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
  kOpenclawBackupPinMaxAgeMs,
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
const { readSchemaMetadata, metadataDeclaration } = require("./openclaw-schema-metadata");
const { createBackupRiskCoordinator, consentConfigError } = require("./backup-risk-consent");
const { isConfigUnreadableError } = require("./utils/config-unreadable");
const { createGatewayLifecycleLock } = require("./gateway-lifecycle-lock");
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
  OfflineCopyError,
  producerOfArchiveName,
  createOfflineCopy,
  verifyArchiveManifest,
  walkStateTreeAsync,
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
} = {}) => {
  const label = rung === "offline_copy" ? "AlphaClaw offline copy" : "upstream backup create";
  const where = quiesced ? " (gateway paused)" : "";
  let bytes;
  if (Number.isFinite(doneBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
    const pct = Math.max(0, Math.min(100, Math.floor((doneBytes / totalBytes) * 100)));
    bytes = `${formatBackupBytes(doneBytes)} of ${formatBackupBytes(totalBytes)} (${pct}%)`;
  } else if (Number.isFinite(doneBytes)) {
    bytes = `${formatBackupBytes(doneBytes)} written so far`;
  } else {
    bytes = rung === "offline_copy" ? "sizing the copy set" : "nothing written yet";
  }
  const step = stage ? `, ${String(stage).replace(/_/g, " ")}` : "";
  // formatElapsed takes a start stamp and a now; any positive base works, and
  // it keeps this line's "1m 5s" identical to the step timer's.
  const elapsed = formatElapsed(1, 1 + Math.max(0, Number(elapsedMs) || 0));
  return `${label} in progress${where}: ${bytes}${step} — ${elapsed} elapsed`;
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
    } catch {}
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
      if (record?.backup?.noBackupConfirmed !== true) return "";
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

  const readCheckoutHead = () => readCheckoutBuildId(checkoutDir, { fsModule });
  const executingBuild = () => describeExecutingBuild({
    installDir: safeInstallDir(), checkoutDir, store: channelStore, fsModule,
  });

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
    return { preRestorePath, diffPath, counts, diff, diffAvailable, live, restored, lastRestore };
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
  // the live DBs is race-free). Ledger hints are hints, never authority.
  // Returns { migrationNeeded: true | false | null (inconclusive),
  //           incompatible: null | { label, agentId, foundVersion, targetVersion } }.
  // STATE DBs go through the installed CLI's `database preflight` (a
  // state-schema verb, unchanged). AGENT DBs are judged here against the
  // INSTALLED tree's supported agent schema — declared from its own dist,
  // else the schema table (issue #78). `incompatible` is the caller's hard
  // gate: a plain null would be coerced to "run doctor --fix" from the very
  // binary that cannot read the database.
  const probeDbMigrationNeeded = async (
    bin,
    { installDir = null, installedVersion = null, build = null } = {},
  ) => {
    const entries = enumerateStateDbEntries();
    if (!entries.length) return { migrationNeeded: false, incompatible: null };
    let sawVerdict = false;
    let migrationNeeded = false;
    // Agent arm first: no spawn, and an incompatible DB must short-circuit
    // before any probe of the binary that cannot read it.
    const agentEntries = entries.filter((entry) => entry.kind === "agent");
    if (agentEntries.length) {
      const supported = await supportedSchemaAsync({
        packageDir: build?.packageDir || (installDir
          ? path.join(installDir, "node_modules", "openclaw")
          : null),
        version: installedVersion,
        buildId: build?.buildId,
      });
      if (supported.agent == null) {
        // Fail open like an unsupported verb: one warning, no verdict.
        log(
          `boot db probe: ${kAgentTargetUnknownWarning} (${installedVersion || "unknown version"})`,
        );
      } else {
        for (const entry of agentEntries) {
          const assessed = assessAgentDb(entry.path, supported.agent);
          if (assessed.read.status !== "ok") {
            log(
              `boot db probe: could not read the schema version of ${dbEntryLabel(entry)} (${assessed.read.error?.code || assessed.read.status})`,
            );
            continue;
          }
          sawVerdict = true;
          if (assessed.verdict === "incompatible") {
            return {
              migrationNeeded: null,
              incompatible: {
                label: dbEntryLabel(entry),
                agentId: entry.agentId,
                foundVersion: assessed.foundVersion,
                targetVersion: assessed.targetVersion,
              },
            };
          }
          if (assessed.verdict === "migration-required") migrationNeeded = true;
        }
      }
    }
    // Inconclusive state probe: a migration already established by the agent
    // arm stays true (null would be coerced to true anyway; false must not
    // win over evidence).
    const inconclusive = () => ({
      migrationNeeded: migrationNeeded ? true : null,
      incompatible: null,
    });
    for (const entry of entries) {
      if (entry.kind !== "state") continue;
      const result = await runner.runStreamed({
        command: process.execPath,
        args: [bin, "database", "preflight", entry.path, "--json"],
        env: probeEnv(),
        timeoutMs: kOpenclawBootPreflightTimeoutMs,
      });
      const text = String(result.tail || "");
      // Narrow capability pattern: an incompatibility error mentioning
      // "unrecognized" must stay inconclusive-or-worse, never "unsupported".
      if (kUnknownCliCommandPattern.test(text)) return inconclusive();
      const parsed = parseJsonObjectFromNoisyOutput(text);
      if (parsed && typeof parsed === "object") {
        sawVerdict = true;
        if (isMigrationRequiredVerdict(parsed)) {
          return { migrationNeeded: true, incompatible: null };
        }
      } else if (!result.ok) {
        return inconclusive();
      }
    }
    return {
      migrationNeeded: sawVerdict ? migrationNeeded : null,
      incompatible: null,
    };
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
  } = {}) => {
    const warnings = [];
    const installDir = safeInstallDir();
    const build = executingBuild();
    const installedVersion = build?.version ?? null;
    const installedBuildId = build?.buildId ?? null;

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
      return { status: "skipped", reason: readInstalledVersionSafe() ? "binary-unresolved" : "no-install", warnings };
    }

    let state = channelStore.readState();
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
        liveCompat?.compatible === false
      ) {
        const detail = describeLaunchCompatHold(liveCompat, {
          installed: installedVersion,
          expected: expectedVersion,
        });
        const hold = channelStore.updateState((s) => {
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
        const hold = channelStore.updateState((s) => {
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
    if (
      !force &&
      migration.completedForVersion &&
      migration.completedForVersion !== installedVersion &&
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
          channelStore.updateState((s) => {
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
      const probe = await probeDbMigrationNeeded(bin, {
        installDir,
        installedVersion,
        build,
      });
      if (probe.incompatible) {
        // Hard gate (#78): an agent DB written by a NEWER build than the one
        // installed. No doctor — `doctor --fix` from this binary would run
        // against a database it cannot read — and no revert: every older
        // build declares an even lower agent schema, so the only way out is
        // a build at least as new as the database. Same fail-CLOSED shape as
        // the running-gateway hold below: state.gatewayHold + watchdog latch
        // (setHold), and NO gateHash on the failed attempt — a restored or
        // replaced DB does not change the config hash, and the next boot
        // must re-probe (one PRAGMA read, no spawn).
        const { label, foundVersion, targetVersion } = probe.incompatible;
        const reason = `agent database ${label} is at agent schema ${foundVersion} and OpenClaw ${installedVersion} supports up to ${targetVersion} — the gateway is held so this build never opens a database it cannot read`;
        warnings.push(reason);
        bootStep(
          "db-migrate",
          "failed",
          `${label}: agent schema ${foundVersion} is newer than the ${targetVersion} this build supports`,
        );
        bootStep("config-migrate", "failed", "database schema is newer than this build");
        const hold = setHold(reason);
        recordAttempt(false, "db-incompatible");
        queueNotify(
          `⚠️ OpenClaw ${installedVersion} cannot read your agent database ${label}: it is at agent schema ${foundVersion} and this build supports up to ${targetVersion}. The gateway is HELD to protect your data — nothing was modified. Activate a build whose agent schema is at least ${foundVersion} from the Upgrade page.`,
          { eventType: "health", id: `db-incompatible-held-${installedVersion}` },
        );
        resolvePendingRun();
        return { status: "held", hold, warnings };
      }
      dbMigrationNeeded = probe.migrationNeeded;
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

  // ── Boot rollback preflight (issue #21 bug 3) ────────────────────────────
  //
  // Snapshot the state DBs ONCE (WAL-consistent VACUUM INTO), then probe each
  // candidate binary against its own COPY of the snapshot — probe read-only-
  // ness is an assumption, not a guarantee, so candidates never share a file.
  // The whole prober draws from the shared boot-ops budget.
  //
  // Two arms per candidate (issue #78): STATE snapshots go to the candidate's
  // `database preflight` (a state-schema verb); AGENT snapshots are judged by
  // assessAgentDb against the candidate's declared agent schema (its overlay
  // dist, else the schema table). An agent DB newer than the candidate
  // supports blocks it; an unknown candidate agent schema reads as
  // "unsupported" so callers keep the existing fail-open warning wording.
  const kBootPreflightPerProbeMs = 120000;
  const createBootPreflightProber = () => {
    const budgetMs = Math.min(
      kOpenclawBootPreflightBudgetMs,
      remainingBootOpsMs(),
    );
    const startedAt = Date.now();
    const remaining = () => budgetMs - (Date.now() - startedAt);
    const entries = enumerateStateDbEntries();
    // { snapPath, kind, agentId, label }
    const snapshots = [];
    let snapped = false;
    // Deliberately synchronous even under probeBinStreamed: VACUUM INTO is a
    // one-time, seconds-scale block for incident-class DBs (hundreds of MB),
    // taken once per prober — the event-loop hazard was the per-candidate
    // ≤120s execFileSync probes, not this bounded snapshot.
    const ensureSnapshots = () => {
      if (snapped) return;
      snapped = true;
      entries.forEach((entry, index) => {
        // Index keeps the names distinct: every agent DB shares the basename
        // openclaw-agent.sqlite, and the snapshots coexist for the prober's
        // whole lifetime.
        const snapPath = path.join(
          os.tmpdir(),
          `alphaclaw-boot-preflight-${nowFn()}-${index}-${path.basename(entry.path)}`,
        );
        try {
          const db = new DatabaseSync(entry.path, { readOnly: true });
          try {
            db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
          } finally {
            db.close();
          }
          snapshots.push({
            snapPath,
            kind: entry.kind,
            agentId: entry.agentId,
            label: dbEntryLabel(entry),
          });
        } catch {
          // Our snapshot failure is not the target's incompatibility.
        }
      });
    };
    const stateSnapshots = () =>
      snapshots.filter((snap) => snap.kind === "state");
    // Agent arm: "block" | "unsupported" (candidate agent schema unknown) |
    // "pass". An unreadable snapshot is ours, not the candidate's — skipped.
    const probeAgentSnapshots = (supportedAgent) => {
      const agentSnaps = snapshots.filter((snap) => snap.kind === "agent");
      if (agentSnaps.length === 0) return "pass";
      if (supportedAgent == null) return "unsupported";
      for (const snap of agentSnaps) {
        const assessed = assessAgentDb(snap.snapPath, supportedAgent);
        if (assessed.verdict === "incompatible") return "block";
      }
      return "pass";
    };
    const makeProbeCopy = (snap) => {
      const probeCopy = `${snap.snapPath}.probe-${crypto.randomUUID().slice(0, 8)}`;
      try {
        fsModule.copyFileSync(snap.snapPath, probeCopy);
      } catch {
        return null;
      }
      return probeCopy;
    };
    const perProbeTimeoutMs = () =>
      Math.max(10_000, Math.min(kBootPreflightPerProbeMs, remaining()));
    // "pass" | "unsupported" | "block" | "budget_exhausted" | null
    // (null = nothing to check / could not check — never the target's fault).
    // `packageDir`/`version` locate the candidate's declared agent schema.
    const probeBin = (bin, { packageDir = null, version = null } = {}) => {
      try {
        if (!bin) return null;
        if (entries.length === 0) return "pass";
        ensureSnapshots();
        if (snapshots.length === 0) return null;
        // Sync dist scan: this arm serves the bin-phase rollback chooser.
        const agentVerdict = probeAgentSnapshots(
          supportedSchemaSync({ packageDir, version }).agent,
        );
        if (agentVerdict === "block") return "block";
        for (const snap of stateSnapshots()) {
          if (remaining() < 5000) return "budget_exhausted";
          const probeCopy = makeProbeCopy(snap);
          if (!probeCopy) continue;
          try {
            execFileSyncImpl(
              process.execPath,
              [bin, "database", "preflight", probeCopy, "--json"],
              {
                env: probeEnv(),
                timeout: perProbeTimeoutMs(),
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
        return agentVerdict;
      } catch {
        return null;
      }
    };
    // Async twin of probeBin for the SERVER-phase migration gate: the sync
    // execFileSync probes (≤120s per candidate per DB, budget ≤8 min) froze
    // the event loop — /health went unanswered and platforms killed the
    // container mid-gate. Same args/env/per-probe timeout/verdicts as
    // probeBin; only the spawn (runner.runStreamed) and the dist scan are
    // async. The bin-phase rollback chooser (chooseBootRollbackTarget) keeps
    // the sync probeBin — it runs before the server (and its event loop's
    // consumers) exists.
    const probeBinStreamed = async (
      bin,
      { packageDir = null, version = null } = {},
    ) => {
      try {
        if (!bin) return null;
        if (entries.length === 0) return "pass";
        ensureSnapshots();
        if (snapshots.length === 0) return null;
        const agentVerdict = probeAgentSnapshots(
          (await supportedSchemaAsync({ packageDir, version })).agent,
        );
        if (agentVerdict === "block") return "block";
        for (const snap of stateSnapshots()) {
          if (remaining() < 5000) return "budget_exhausted";
          const probeCopy = makeProbeCopy(snap);
          if (!probeCopy) continue;
          try {
            const result = await runner.runStreamed({
              command: process.execPath,
              args: [bin, "database", "preflight", probeCopy, "--json"],
              env: probeEnv(),
              timeoutMs: perProbeTimeoutMs(),
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
        return agentVerdict;
      } catch {
        return null;
      }
    };
    const cleanup = () => {
      for (const snap of snapshots) {
        try {
          fsModule.rmSync(snap.snapPath, { force: true });
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
          const packageDir = channelStore.overlayPackageDir(version);
          const verdict = await prober.probeBinStreamed(
            channelStore.resolvePackageBin(packageDir),
            { packageDir, version },
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
        });
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
            head && applied.sha && head.startsWith(applied.sha);
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

  const stepRecorder = (operationId, sink = null) => {
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
  // `gateHint` is runBackup's ONE gate sentence (noun + escape route); the
  // fallback below exists for callers that only know the noun.
  const classifyBackupFailure = (
    result,
    { outputFile, gateNoun, gateHint: gateHintOverride = null },
  ) => {
    const tailLines = selectClassifierTail(result?.tail);
    const tail = tailLines.join("\n");
    const lastLine = sanitizeForDisplay(tailLines[tailLines.length - 1] || "", 400);
    const gateHint =
      gateHintOverride ||
      `${gateNoun} are blocked without a backup because the rollback target may not read migrated state. Fix the backup or choose a same-channel version.`;
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

  // WI-1.0 / #79 (d): read-only look at what the backup is about to walk
  // into — journal mode (rollback-journal DBs self-block the upstream
  // snapshot), the state dir's filesystem, live openclaw processes — and the
  // SIZE of the job: ONE budgeted walk of the state tree with the policy
  // excludes applied (the same walk the offline copy runs) yields
  //
  //   copySetBytes / fileCount   what the copy writes: DBs + assets + the
  //                              workspaces when their post-exclude total fits
  //                              the inline limit (createOfflineCopy's rule)
  //   tarSetBytes / tarFileCount what upstream tars: the whole tree, every
  //                              workspace, excludes included (it takes none)
  //   workspaceBytes / excludedBytes  the post-exclude workspace total and
  //                              what the policy dropped
  //
  // from which BOTH rungs are predicted (Codex 16: bytes / rate + files ×
  // per-file overhead; the rate from the rung's own prior run, else the
  // default constant — the calibrated rate already carries this box's
  // per-file cost, so the file term applies only to the defaults). The walk
  // is bounded by diagnosisBudgetMs: a walk that hits it (or fails) leaves
  // every size null and both predictions "unknown", which the ladder reads
  // as copy-first (chooseBackupRung fails closed on it). stateBytes (DBs +
  // WAL, stat'ed directly) stays the veto's and the upstream calibration's
  // measure. Unreadable → "unknown"; never blocks the apply, never throws.
  // Runs BEFORE runBackup stamps the phase deadline, so its budget is a term
  // of the quiesced-path envelope relation (backupBudgetPins), not a bite out
  // of the envelope.
  const kRollbackJournalModes = new Set(["delete", "truncate", "persist"]);
  const kDiagnosisBudgetCode = "diagnosis_budget";
  const runBackupDiagnosis = async ({ operationId }) => {
    const startedAt = nowFn();
    const diagnosis = {
      journalMode: "unknown",
      journalModes: {},
      fsType: "unknown",
      stateBytes: null,
      dbCount: 0,
      otherProcesses: [],
      // The budgeted walk: "complete" | "incomplete" (budget hit) | "failed"
      // (enumeration error), and what it measured (null = unknown).
      walk: "unknown",
      walkMs: null,
      walkError: null,
      copySetBytes: null,
      tarSetBytes: null,
      workspaceBytes: null,
      excludedBytes: null,
      fileCount: null,
      tarFileCount: null,
      predictedOfflineCopyMs: null,
      predictedUpstreamMs: null,
      // "calibrated" (a prior run of that rung) | "default" (the constants)
      // | null (unknown — the walk did not complete).
      predictionSource: { offlineCopy: null, upstream: null },
      priorRun: null,
      priorCopyRun: null,
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
      // The sizing walk. Its checkpoint runs every kWalkCheckpointEvery
      // entries (the walk yields to the event loop between them) and aborts
      // the enumeration once the diagnosis budget is spent — an 8 GB
      // node_modules is measured, not copied, but even measuring it is
      // bounded.
      const deadline = startedAt + Math.max(0, backupBudget.diagnosisBudgetMs);
      const checkpoint = () => {
        if (nowFn() > deadline) {
          const error = new Error(
            `diagnosis budget (${Math.round(backupBudget.diagnosisBudgetMs / 1000)} s) exhausted during the state walk`,
          );
          error.code = kDiagnosisBudgetCode;
          throw error;
        }
      };
      const walkStartedAt = nowFn();
      try {
        const tree = await walkStateTreeAsync({ stateDir: root, fsModule, checkpoint });
        const sum = (list, pick) => list.reduce((total, entry) => total + pick(entry), 0);
        const workspaces = [...tree.workspaces.values()];
        const dbBytes = sum(tree.dbs, (db) => db.bytes);
        const assetBytes = sum(tree.files, (file) => file.bytes);
        const workspaceBytes = sum(workspaces, (ws) => ws.bytes);
        const workspaceFiles = sum(workspaces, (ws) => ws.files.length);
        const excludedBytes = sum(workspaces, (ws) => ws.excludedBytes);
        const excludedFiles = sum(workspaces, (ws) => ws.excludedFiles);
        // createOfflineCopy's inline rule, post-exclude.
        const includeWorkspace =
          workspaces.length > 0 && workspaceBytes <= kOpenclawBackupWorkspaceInlineBytes;
        diagnosis.copySetBytes = dbBytes + assetBytes + (includeWorkspace ? workspaceBytes : 0);
        diagnosis.fileCount =
          tree.dbs.length + tree.files.length + (includeWorkspace ? workspaceFiles : 0);
        diagnosis.tarSetBytes = dbBytes + assetBytes + workspaceBytes + excludedBytes;
        diagnosis.tarFileCount = tree.dbs.length + tree.files.length + workspaceFiles + excludedFiles;
        diagnosis.workspaceBytes = workspaceBytes;
        diagnosis.excludedBytes = excludedBytes;
        diagnosis.walk = "complete";
      } catch (error) {
        diagnosis.walk = error?.code === kDiagnosisBudgetCode ? "incomplete" : "failed";
        diagnosis.walkError = sanitizeForDisplay(error?.message, 200);
      }
      diagnosis.walkMs = Math.max(0, nowFn() - walkStartedAt);
      if (diagnosis.walk === "complete") {
        const priorCopy = priorOfflineCopyThroughput();
        diagnosis.priorCopyRun = priorCopy;
        diagnosis.predictedOfflineCopyMs = predictTransferMs({
          bytes: diagnosis.copySetBytes,
          files: priorCopy ? 0 : diagnosis.fileCount,
          bytesPerSec: priorCopy
            ? (priorCopy.offlineCopyBytes / priorCopy.offlineCopyMs) * 1000
            : backupBudget.defaultCopyBytesPerSec,
          perFileOverheadMs: backupBudget.perFileOverheadMs,
        });
        diagnosis.predictionSource.offlineCopy = priorCopy ? "calibrated" : "default";
        const prior = priorUpstreamThroughput();
        if (prior && stateBytes > 0) {
          // The calibrated path: the prior CLI's rate over the state bytes it
          // snapshotted, applied to today's — attemptMs × (bytes / prior bytes).
          diagnosis.priorRun = prior;
          diagnosis.predictedUpstreamMs = predictTransferMs({
            bytes: stateBytes,
            files: 0,
            bytesPerSec: (prior.stateBytes / prior.attemptMs) * 1000,
          });
          diagnosis.predictionSource.upstream = "calibrated";
        } else {
          // First run (or no successful upstream yet): the conservative
          // default rate over the TAR set — upstream tars the excluded trees
          // too, and their file count is the cost bytes/rate misses.
          diagnosis.predictedUpstreamMs = predictTransferMs({
            bytes: diagnosis.tarSetBytes,
            files: diagnosis.tarFileCount,
            bytesPerSec: backupBudget.defaultUpstreamBytesPerSec,
            perFileOverheadMs: backupBudget.perFileOverheadMs,
          });
          diagnosis.predictionSource.upstream = "default";
        }
      }
    } catch (error) {
      diagnosis.error = sanitizeForDisplay(error.message, 200);
    }
    const megabytes = (bytes) => (bytes == null ? "?" : `${Math.round(bytes / 1e6)} MB`);
    const seconds = (ms) => (ms == null ? "unknown" : `${Math.round(ms / 1000)}s`);
    backupLog(
      `[openclaw-update] backup: diagnosis journal=${diagnosis.journalMode} fs=${diagnosis.fsType} state=${
        diagnosis.stateBytes == null ? "?" : `${Math.round(diagnosis.stateBytes / 1e6)}MB`
      } dbs=${diagnosis.dbCount} processes=${diagnosis.otherProcesses.length} walk=${diagnosis.walk}${
        diagnosis.walkMs == null ? "" : ` (${Math.round(diagnosis.walkMs / 1000)}s)`
      } predicted upstream=${seconds(diagnosis.predictedUpstreamMs)} copy=${seconds(
        diagnosis.predictedOfflineCopyMs,
      )} (tar set ${megabytes(diagnosis.tarSetBytes)}, excluded ${megabytes(diagnosis.excludedBytes)}, ${
        diagnosis.tarFileCount == null ? "?" : diagnosis.tarFileCount
      } files)${diagnosis.walkError ? ` — ${diagnosis.walkError}` : ""}`,
    );
    logEvent("backup_diagnosis", "completed", {
      operationId,
      journalMode: diagnosis.journalMode,
      fsType: diagnosis.fsType,
      stateBytes: diagnosis.stateBytes,
      dbCount: diagnosis.dbCount,
      otherProcesses: diagnosis.otherProcesses.length,
      walk: diagnosis.walk,
      walkMs: diagnosis.walkMs,
      copySetBytes: diagnosis.copySetBytes,
      tarSetBytes: diagnosis.tarSetBytes,
      excludedBytes: diagnosis.excludedBytes,
      fileCount: diagnosis.fileCount,
      tarFileCount: diagnosis.tarFileCount,
      predictedUpstreamMs: diagnosis.predictedUpstreamMs,
      predictedOfflineCopyMs: diagnosis.predictedOfflineCopyMs,
      predictionSource: diagnosis.predictionSource,
    });
    return diagnosis;
  };

  // Rollback-journal + large DB = deterministic self-block of the upstream
  // snapshot (a reader's SHARED lock blocks the writer's COMMIT with
  // busy_timeout 0). Since #79 (c) the offline copy is unconditional and
  // FIRST, so this is no longer a short-circuit to it. BOTH drivers consult
  // it (#79 (d)): the quiesced driver rules out the in-quiesce UPSTREAM
  // attempt that may follow a failed copy; the live ladder runs its ONE
  // upstream attempt (the last rung — the veto is a prediction, not a
  // measurement) and declines the retry a retryable failure would otherwise
  // earn. The speed question (predicted upstream ms, byte cap, remaining
  // pause) is chooseBackupRung's (openclaw-backup-ladder.js), not this
  // helper's.
  const describeUpstreamVeto = (diagnosis) => {
    if (!diagnosis) return null;
    if (
      diagnosis.journalMode === "delete" &&
      Number.isFinite(diagnosis.stateBytes) &&
      diagnosis.stateBytes > backupBudget.rollbackJournalSelfDeadlockBytes
    ) {
      return "rollback_journal_self_deadlock";
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
  // be limited. Since #79 (c) (decision D1a) the gate decides ONLY fatality:
  // every apply that can pause the gateway does, copy-first.
  //
  //   runBackup(opId)
  //     │ ONE "backup: running" (detail names the path)
  //     │ ensureBackupsDir()  (legacy-file migration, symlink fail-closed)
  //     │ which binary (#76 C6): the DB-compatible bin on a diverged tree
  //     │ runBackupDiagnosis()  journal mode · fs type · state bytes · live
  //     │   processes · ONE budgeted walk of the state tree (policy excludes,
  //     │   ≤ diagnosisBudgetMs) → copy set / tar set / excluded bytes / file
  //     │   counts → predicted copy ms + upstream ms (each rung's own prior-run
  //     │   rate, else the default constants — Codex 16); a walk that hits its
  //     │   budget predicts "unknown" (→ copy-first, fail-closed). Never
  //     │   blocks the apply, never throws.
  //     │ phase envelope stamped HERE, after the diagnosis (its budget is a
  //     │   term of the envelope relation, not a bite out of the envelope)
  //     ▼
  //   gatewayQuiesce injected? (willQuiesce — soft AND hard gates)
  //     │ yes: QUIESCE FIRST — the gateway is the only writer; stopping it is
  //     │      the deterministic fix for the vanished-file tar race (#11/#18):
  //     │        lock(≤90s, lease = quiesce + offline-copy budgets + reserve)
  //     │          busy → hard gate: honest 409 · soft gate: `backup: warning`
  //     │                 + fall through to the LIVE LADDER (only the backup
  //     │                 RUNG degrades — Codex 14: the apply's own
  //     │                 serialization is applyUpdate's applyInProgress /
  //     │                 getActiveGatewayOperation gate at its entry)
  //     │        → wasRunning? → suppress watchdog → stop(≤30s) → CONFIRMED
  //     │          (stop unavailable → relaunch, live ladder)
  //     │        → fixed quiesce deadline, sized quiesceTimeoutMs +
  //     │          offlineCopyBudgetMs UP FRONT (≤ envelope − usable-check
  //     │          reserve): both quiesced rungs share it, never a fresh budget
  //     │        → dbQuiet (state-DB quiet barrier, owner token)
  //     │          held elsewhere → hard: 409 · soft: warning + live ladder
  //     │        → runQuiescedAttemptLoop:
  //     │            1. OFFLINE COPY FIRST, unconditionally (D1a): still
  //     │               quiesced, exclusivity evidence, sqlite backup() per
  //     │               DB, policy excludes, tar gzip -1, manifest check;
  //     │               bounded by min(offlineCopyBudgetMs, quiesceRemaining)
  //     │                 ok → { publish } (producer alphaclaw-offline-copy)
  //     │                 refused (not exclusive: foreign holder, lost
  //     │                   barrier, unconfirmed stop) → fallback (relaunch →
  //     │                   settle → LIVE): the live upstream needs no
  //     │                   exclusivity; the refusal rides the record
  //     │                   (offlineCopy.next, attemptsDetail) and is appended
  //     │                   to the eventual failure message — never a
  //     │                   one-rung terminal (a reuse offer needs the full
  //     │                   fresh ladder to have failed)
  //     │                 other stage failure → 2.
  //     │            2. post-copy decision — describeUpstreamVeto (rollback
  //     │               journal + >256MB self-deadlock) else chooseBackupRung
  //     │               (predicted upstream ms × 1.5 < remaining pause, copy
  //     │               set ≤ upstreamMaxBytes; any unknown → hand over):
  //     │                 not "upstream" → fallback (relaunch → settle → LIVE)
  //     │                 "upstream" → 3.
  //     │            3. in-quiesce upstream `backup create` loop
  //     │               (kQuiescedOutcomePolicy; timeout = remaining deadline):
  //     │                 success           → usable check → { publish }
  //     │                 lock_contention   → contentionRetryVerdict: retry ≤2
  //     │                                     (15s→30s backoff) else fallback
  //     │                 killed / timeout  → fallback (the policy's
  //     │                                     "offline_copy" rung already ran
  //     │                                     this pause — never twice)
  //     │                 vanished          → fallback (exogenous writer)
  //     │                 workspace broken  → relaunch + unlock FIRST, then the
  //     │                                     one-shot --no-include-workspace LIVE
  //     │                 anything else     → terminal { failure }
  //     │            every rung is one run.backup.attemptsDetail[] entry
  //     │              { rung, reason, quiesced, startedAt, elapsedMs, bytes,
  //     │              kind, ok } and one `backup_rung` event
  //     │            every FAILURE is only classified in-quiesce; it is
  //     │              finalized (warning / 409 + reuse gate) by runBackup
  //     │              AFTER the finally below — the reuse gate's gzip/tar/
  //     │              sha256 never run with the gateway down, barrier held
  //     │            a SUCCESS is only CHECKED in-quiesce (usable check +
  //     │              chmod, budgeted by the lease reserve); its publish
  //     │              (prune, advisory sha256, record) runs after the finally
  //     │              too, and a check that times out is a failure on that
  //     │              same deferred path (finishSuccess `deferred`)
  //     │        → finally: dbResume BEFORE start (if wasRunning; a failed
  //     │          relaunch is its own `gateway-relaunch: warning` step)
  //     │          → unsuppress → unlock
  //     ▼
  //   after a relaunch: poll isRunning (≤20s) + settle (10s), charged to the
  //   envelope; the first live attempt's detail names the prior failure
  //     ▼
  //   LIVE LADDER (no quiesce seam, or any fallback above), kLiveRetryPolicy:
  //     attempt (fresh --output file each time, isBackupArchiveName-conforming
  //     so keep-N retention still prunes) → vanished_file: 750ms ×≤2 ·
  //     lock_contention/killed: 1 retry after 15s · else break
  //     (≤kOpenclawBackupLiveAttempts, all inside one phase envelope; an
  //     attempt starts only if the envelope still holds its budget PLUS the
  //     usable-check reserve — else window_exhausted; a vetoed upstream
  //     (describeUpstreamVeto, consulted by BOTH drivers) gets ONE live
  //     attempt and no retry — `backup_rung: skipped`, upstreamVeto on the
  //     record)
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
  //   soft gate + any failure ──► `backup: warning` + health notification,
  //     noBackup: true, the apply continues — UNTIL the db-preflight: when the
  //     target migrates the DBs (migrationRequired) a noBackup apply stops at
  //     applyUpdate's post-preflight checkpoint with 409
  //     backup_required_for_migration. A verified failed run can offer a
  //     session-bound, one-use waiver after immutable target preparation.
  //   hard gate + retryable class exhausted ──► REUSE GATE (WI-4.5):
  //     verified ≤24h archive, nothing applied since, re-verified on an open
  //     fd (gzip -t, manifest, sha256) → consent {sha256} matches → record as
  //     reused (no prune) · no consent → 409 + reusableBackup offer
  //   every FAILURE finisher (finishFailure, finishNoArtifact) ──► in-run
  //     debris sweep (sweepBackupDebris: `.tmp` older than the CLI ceiling +
  //     slack) — NEVER inside the quiesce: a finisher that runs paused only
  //     ARMS it and runBackup consumes the flag after the unwind, mirroring
  //     finishSuccess({ deferred }); a success sweeps through pruneBackups.
  //     The boot sweeps EVERYTHING (boot mode) from runOnboardedBootSequence.
  //   every running rung ──► progress ticker (backupBudget.progressIntervalMs):
  //     ONE backupLog line + the SSE output pane + the live step row rewritten
  //     in place (stepRecorder.updateDetail — steps[] length constant); bytes
  //     from the CLI's `<output>.<uuid>.tmp` staging file or the copy's
  //     onProgress feed
  const runBackup = async ({
    emit,
    // stepRecorder.updateDetail — the progress ticker's live-row seam (#79
    // (h)); a caller without a recorder gets a no-op.
    updateDetail = () => false,
    hardGate,
    gateReason = "downgrade",
    operationId = null,
    allowBackupReuse = null,
  }) => {
    // D1a: every apply that CAN pause the gateway does — the copy of a paused
    // state dir is the honest backup for soft gates too. `hardGate` decides
    // only whether a failure is fatal.
    const willQuiesce = Boolean(gatewayQuiesce);
    emit(
      "backup",
      "running",
      willQuiesce
        ? { detail: "pausing the gateway for a consistent backup (AlphaClaw offline copy first)" }
        : undefined,
    );
    const backupStartedAt = nowFn();
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
          : gateReason === "prerelease"
            ? "Prerelease updates"
            : "Cross-channel updates";
    // The ladder itself never waives a failure. applyUpdate can offer a
    // separately verified backup-availability waiver after preparation.
    const gateHint = `${gateNoun} are blocked without a backup because the rollback target may not read migrated state. Fix the backup or choose a ${gateReason === "prerelease" ? "stable" : "same-channel"} version.`;
    const emptyTrack = {
      attempts: 0,
      quiesced: false,
      quiescedAttempts: 0,
      vanishedPaths: [],
      contentionRetries: 0,
      offlineCopy: null,
      attemptsDetail: [],
      upstreamVeto: null,
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
    // Which binary (#76 C6 / Codex 8): with the live tree diverged from the
    // recorded build, the `openclaw` on PATH is the wrong binary for the
    // CURRENT databases. Prefer the recorded build's bin (its overlay), else
    // the installed tree — whichever the launch-compat gate does not refuse —
    // and refuse `version_mismatch` only when neither can read the DBs, so
    // the operator's re-apply from the Upgrade tab keeps working.
    let backupBin = null;
    if (getChannelInfo().installedDiverged) {
      const compatible = await compatibleBinForCurrentDb();
      if (!compatible) {
        const info = getChannelInfo();
        const message = `The installed OpenClaw (${info.installedVersion || "unknown"}) is not the recorded build (${info.expectedVersion || "unknown"}) and no local build can read the current state databases, so the pre-update backup cannot run.`;
        const hint =
          'Use "Re-activate recorded build" on the Upgrade page (or restart AlphaClaw), then retry.';
        if (hardGate) {
          emit("backup", "failed", { error: "version_mismatch" });
          return { ...channelError("version_mismatch", message, hint), ...emptyTrack };
        }
        emit("backup", "warning", { error: "version_mismatch" });
        queueNotify(
          `⚠️ Pre-update backup skipped — continuing (upgrades are protected by auto-rollback, but rollback recovery may be limited). ${message}`,
          {
            eventType: "health",
            id: `backup-warn-version-mismatch-${info.installedVersion}-${info.expectedVersion}`,
          },
        );
        return { ok: true, warned: true, noBackup: true, ...emptyTrack };
      }
      backupBin = compatible;
      backupLog(
        `[openclaw-update] backup: installed tree diverged from the recorded build — running the backup with the ${compatible.source} bin for ${compatible.version} (${compatible.bin})`,
      );
    }
    const diagnosis = await runBackupDiagnosis({ operationId });
    // Codex 16: the phase envelope is stamped AFTER the diagnosis. The sizing
    // walk has its own budget (diagnosisBudgetMs — a term of the quiesced-path
    // relation in backupBudgetPins), so a two-minute walk of a big tree never
    // eats the ladder's clock; the record's durationMs still counts it, as the
    // step's honest wall time. Every budget below derives from this deadline.
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
      attemptsDetail: [],
      // describeUpstreamVeto's verdict, recorded whenever a driver consulted
      // it (a copy that succeeds never asks); null otherwise.
      upstreamVeto: null,
    };
    const trackFields = () => ({
      attempts: track.attempts,
      quiesced: track.quiesced,
      quiescedAttempts: track.quiescedAttempts,
      vanishedPaths: track.vanishedPaths,
      contentionRetries: track.contentionRetries,
      offlineCopy: track.offlineCopy,
      attemptsDetail: track.attemptsDetail,
      upstreamVeto: track.upstreamVeto,
      diagnosis,
      durationMs: nowFn() - backupStartedAt,
      ...(track.backupRiskBlocked ? { backupRiskBlocked: true } : {}),
    });
    // Issue #79 (c): every rung the ladder runs — the offline copy, each
    // in-quiesce upstream attempt, each live attempt — is one entry of
    // run.backup.attemptsDetail[] and one `backup_rung` event on the events
    // tab, so the run record alone says which rungs ran, why each was chosen
    // (the policy's own reason strings: primary, predicted_fits,
    // contention_retry, live_fallback, live_retry, workspace_retry,
    // live_ladder), how long it took and how it ended. The returned closer
    // fills in the outcome: `bytes` is the archive a succeeding rung wrote,
    // `kind` the classified failure of a failing one.
    const beginRung = ({ rung, reason, quiesced }) => {
      const entry = {
        rung,
        reason,
        quiesced,
        startedAt: nowFn(),
        elapsedMs: null,
        bytes: null,
        kind: null,
        ok: null,
      };
      track.attemptsDetail.push(entry);
      logEvent("backup_rung", "chosen", {
        operationId,
        rung,
        reason,
        quiesced,
        index: track.attemptsDetail.length,
        remainingMs: remainingMs(),
      });
      return ({ ok, bytes = null, kind = null } = {}) => {
        entry.elapsedMs = Math.max(0, nowFn() - entry.startedAt);
        entry.bytes = Number.isFinite(bytes) ? bytes : null;
        entry.kind = kind ?? null;
        entry.ok = ok === true;
        return entry;
      };
    };
    const fileSizeOrNull = (file) => {
      try {
        return file ? fsModule.statSync(file).size : null;
      } catch {
        return null;
      }
    };
    // #79 (h): the progress ticker — one per running rung. Every
    // backupBudget.progressIntervalMs (15 s; harness-tunable) it logs ONE
    // line (rung, elapsed, bytes so far — describeBackupProgress), publishes
    // it on the apply's SSE output stream (the Upgrade tab's log pane, via the
    // coalescing publisher) and rewrites the live step row's detail IN PLACE
    // through stepRecorder.updateDetail, so steps[] never grows from a tick.
    // `sample()` is the rung's own measure (the CLI's staging file, the copy's
    // onProgress snapshot); a sampler that throws costs the bytes, never the
    // rung. Real timers, unref'd — a frozen test clock only fixes the elapsed
    // figure. The returned stop() clears the timer and flushes the output
    // buffer so the last line lands BEFORE the step event that follows.
    const output = makeOutputPublisher(operationId);
    const startProgressTicker = ({ rung, quiesced = false, sample = () => null }) => {
      const intervalMs = backupBudget.progressIntervalMs;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
      const tickerStartedAt = nowFn();
      const tick = () => {
        let snapshot = null;
        try {
          snapshot = sample() || null;
        } catch {
          snapshot = null;
        }
        const line = describeBackupProgress({
          rung,
          quiesced,
          elapsedMs: nowFn() - tickerStartedAt,
          ...(snapshot || {}),
        });
        backupLog(`[openclaw-update] backup: ${line}`);
        output(`${line}\n`);
        try {
          updateDetail("backup", line);
        } catch {}
      };
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        try {
          output.flush();
        } catch {}
      };
    };
    // What the upstream CLI has written so far: its `<output>.<uuid>.tmp`
    // staging file(s) (removed on its own success path — cleanupFailedBackup
    // sweeps a failed run's), or the archive itself once the CLI has moved it
    // into place ahead of --verify. {} until either exists.
    const measureCliProgressBytes = (outputFile) => {
      const base = path.basename(outputFile);
      let bytes = 0;
      let seen = false;
      try {
        for (const name of fsModule.readdirSync(backupsDir)) {
          if (name !== base && !(name.startsWith(`${base}.`) && name.endsWith(".tmp"))) continue;
          try {
            const st = fsModule.statSync(path.join(backupsDir, name));
            if (!st.isFile()) continue;
            bytes += st.size;
            seen = true;
          } catch {}
        }
      } catch {}
      return seen ? { doneBytes: bytes } : {};
    };
    // WI-1.8: honest attempt wording — how many CLI attempts, how many of
    // them with the gateway paused. Never "including one" when zero were.
    const describeAttempts = () => {
      // No CLI attempt ran (copy-first: the offline copy is the common
      // success, and the envelope may be spent before the live ladder that a
      // refused copy hands over to gets its first attempt): "(after 0
      // attempts)" would misread as "nothing was attempted" when the copy WAS.
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
      // Why this rung runs (attemptsDetail[].reason / the backup_rung event).
      reason,
    }) => {
      track.attempts += 1;
      if (quiesced) track.quiescedAttempts += 1;
      const closeRung = beginRung({ rung: "upstream", reason, quiesced });
      if (detail) emit("backup", "running", { detail });
      // The workspace retry takes a random suffix: the ladder's freshness
      // comes from nowFn(), which tests legitimately freeze — the CLI would
      // refuse to overwrite the first attempt's artifact path.
      const outputFile = buildBackupOutputFile(
        noWorkspace ? crypto.randomUUID() : operationId,
      );
      // attemptMs is the CLI's own wall time — the only honest input to the
      // next run's predictedUpstreamMs (see priorUpstreamThroughput).
      const attemptStartedAt = nowFn();
      // #79 (h): progress while the CLI runs — its staging file's size is the
      // only figure it exposes (no progress output of its own).
      const stopProgress = startProgressTicker({
        rung: "upstream",
        quiesced,
        sample: () => measureCliProgressBytes(outputFile),
      });
      let raw;
      try {
        raw = await runner.runStreamed({
          // Diverged tree (#76 C6): the DB-compatible bin under the current
          // node, never whatever `openclaw` resolves to on PATH.
          command: backupBin ? process.execPath : "openclaw",
          args: [
            ...(backupBin ? [backupBin.bin] : []),
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
      } finally {
        stopProgress();
      }
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
          closeRung({ ok: true, kind: "fresh_install" });
          return { status: "fresh_install", outputFile, quiesced };
        }
        cleanupFailedBackup(outputFile);
        closeRung({ ok: false, kind: "no_artifact" });
        return { status: "no_artifact", outputFile, quiesced };
      }
      if (result.ok) {
        closeRung({ ok: true, bytes: fileSizeOrNull(artifactFile) });
        return { status: "success", artifactFile, outputFile, quiesced, attemptMs };
      }
      cleanupFailedBackup(outputFile);
      const classified = classifyBackupFailure(result, {
        outputFile,
        gateNoun,
        gateHint,
      });
      if (classified.kind === "vanished_file" && classified.offendingPath) {
        track.vanishedPaths.push(classified.offendingPath);
      }
      closeRung({ ok: false, kind: classified.kind });
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
        // The copy is the FIRST rung (D1a), so this normally reads without an
        // attempt count; "after N upstream attempts" appears only when some
        // ran, never "after 0".
        const afterAttempts =
          track.attempts > 0
            ? ` after ${track.attempts} upstream attempt${track.attempts === 1 ? "" : "s"}`
            : "";
        emit("backup", offlineCopy.partial ? "warning" : "completed", {
          detail: `succeeded via AlphaClaw offline copy${afterAttempts} (gateway paused)${partialWhy}`,
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
              // The copy's own wall time against the archive it wrote — the
              // next run's copy-rate calibration (priorOfflineCopyThroughput;
              // never read by the upstream series).
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
        reason: "workspace_retry",
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

    // #79 (g): the in-run debris sweep from a FAILURE finisher — stale `.tmp`
    // staging files (older than the CLI ceiling + slack; sweepBackupDebris
    // in-run mode). Never inside the quiesce: unlinking a multi-GB temp would
    // extend the gateway's downtime, so a finisher that runs paused
    // (finishNoArtifact from the in-quiesce upstream loop) only ARMS the
    // sweep and runBackup consumes the flag right after runQuiescedBackup's
    // finally (dbResume → start → unsuppress → release) — the same deferred
    // shape as finishSuccess({ deferred }). Hygiene never changes the
    // verdict: a throw is logged and swallowed. A SUCCESS sweeps through
    // pruneBackups instead (its unconditional temp removal).
    let inQuiesce = false;
    let debrisSweepDeferred = false;
    const sweepDebrisInRun = async () => {
      if (inQuiesce) {
        debrisSweepDeferred = true;
        return null;
      }
      try {
        return await sweepBackupDebris({ mode: "in-run" });
      } catch (error) {
        backupLog(
          `[openclaw-update] backup: debris sweep failed (${sanitizeForDisplay(error?.message, 200)})`,
        );
        return null;
      }
    };
    const consumeDeferredDebrisSweep = async () => {
      if (!debrisSweepDeferred) return;
      debrisSweepDeferred = false;
      await sweepDebrisInRun();
    };

    // Async since #79 (g): the failure sweep (deferred when this runs inside
    // the quiesce — see sweepDebrisInRun). Callers return its promise.
    const finishNoArtifact = async (attempt) => {
      emit("backup", "failed", {
        error: `no backup artifact at ${attempt.outputFile}`,
      });
      await sweepDebrisInRun();
      return {
        ...channelError(
          "backup_failed",
          `The backup command reported success but produced no backup file at ${attempt.outputFile}.`,
          `Check the update log for where the backup wrote its archive, then retry — or choose a same-channel version. ${describeNewestArchive()}`,
        ),
        expectedFile: attempt.outputFile,
        backupFailureKind: "no_artifact",
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

    // A refused first-rung copy handed over to the live ladder; when THAT
    // failed too, the message must still say why no copy exists (invariant
    // (1): "say exactly why not") — the holder's pid (argv) is on the record
    // (offlineCopy.error) and here, never only in the log.
    const describeRefusedCopy = (base) =>
      track.offlineCopy?.ok === false && track.offlineCopy.stage === "exclusivity"
        ? `${/[.!?]$/.test(base) ? "" : "."} The AlphaClaw offline copy of the paused state was refused first because ${track.offlineCopy.error}.`
        : "";
    const finishFailure = async (attempt) => {
      const { classified, result, outputFile } = attempt;
      const base = `${classified.message}${describeAttempts()}`;
      const message = `${base}${describeRefusedCopy(base)}`;
      // #79 (g): every failure path reclaims stale staging debris first (only
      // `.tmp` older than the CLI ceiling + slack — a candidate archive the
      // reuse gate below may offer is never a `.tmp`). Deferred if we are
      // somehow still paused; today every caller runs after the unwind.
      await sweepDebrisInRun();
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
          backupFailureKind: classified.kind,
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
      return { ok: true, warned: true, noBackup: true, backupFailureKind: classified.kind, ...trackFields() };
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
      if (kind === "offline_copy_failed") {
        const stage = attempt.classified.stage;
        return `a failed offline copy${stage ? ` (${stage})` : ""}`;
      }
      if (kind === "offline_copy_refused") {
        return "a refused offline copy (the paused state dir was not exclusively ours)";
      }
      return kind ? `a ${kind.replace(/_/g, "-")} failure` : "the paused attempt";
    };

    // WI-1.6 / #79 (c): the AlphaClaw offline copy — the FIRST rung of every
    // quiesce, unconditionally (D1a): sqlite backup() per DB, policy
    // excludes, gzip -1, against a paused state dir that is provably ours.
    // Exclusivity is proven before a byte is copied; a hard miss is
    // classified here (`offline_copy_refused`, holder named) and HANDED OVER:
    // the pause ends and the live ladder runs — the upstream `backup create`
    // runs against a RUNNING gateway by design and needs no exclusivity, so a
    // stray `openclaw` argv must never cost the apply its only fresh rung
    // (AGENTS.md ladder invariant (5): reuse is offered only after the full
    // fresh ladder failed). Any other stage failure hands the decision back
    // to runQuiescedAttemptLoop: an in-quiesce upstream attempt if it is
    // predicted to fit, else the live ladder. The copy never runs twice in
    // one pause.
    const runOfflineCopy = async ({ stopEvidence, quietToken, stopConfirmed, quiesceRemaining }) => {
      // Its own budget, bounded by what is left of the quiesce deadline (sized
      // for both quiesced rungs up front) — never the phase clock alone, which
      // outlives the lifecycle lease and the quiet barrier.
      const budgetMs = Math.max(1, Math.min(backupBudget.offlineCopyBudgetMs, quiesceRemaining()));
      const outputFile = buildBackupOutputFile(operationId, { producer: kOfflineCopyProducer });
      const reason = "primary";
      const closeRung = beginRung({ rung: "offline_copy", reason, quiesced: true });
      logEvent("backup_offline_copy", "started", { operationId, reason, budgetMs });
      // The diagnosis sized the copy set before the pause (#79 (d)); the
      // copy's own walk measures it again — exact, and seconds fresher — and
      // reports it through the progress feed's totalBytes. A copy that fails
      // AFTER its walk leaves that figure for chooseBackupRung's byte cap
      // (preferred over the diagnosis's when both exist).
      // The same feed drives the progress ticker (#79 (h)): the newest
      // { stage, doneBytes, totalBytes } is sampled once per interval — the
      // copy reports per step, the operator hears once per 15 s.
      const measured = { copySetBytes: null, latest: null };
      const onProgress = ({ stage, doneBytes, totalBytes } = {}) => {
        if (Number.isFinite(totalBytes) && totalBytes >= 0) measured.copySetBytes = totalBytes;
        measured.latest = {
          stage: stage ?? null,
          doneBytes: Number.isFinite(doneBytes) ? doneBytes : null,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
        };
      };
      const stopProgress = startProgressTicker({
        rung: "offline_copy",
        quiesced: true,
        sample: () => measured.latest,
      });
      // One process-list sample refuses on ANY `openclaw` argv — including
      // AlphaClaw's own transient CLI shell-outs (a cron run, a `--help`
      // capability probe), which the quiet barrier does not gate. Re-sample
      // briefly while the list is non-empty so a child that is already
      // exiting does not turn the first-rung copy into a terminal 409; a
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
              return executingBuild()?.version ?? null;
            } catch {
              return null;
            }
          })(),
          budgetMs,
          onProgress,
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
          // Honest coverage (Codex 17): what the archive holds of the core
          // assets and of the workspaces, and what the policy excludes left
          // out — `partial` stays reserved for a missing CORE asset.
          coverage: copy.coverage ?? null,
          excludedBytes: Number.isFinite(copy.excludedBytes) ? copy.excludedBytes : 0,
          ...(Array.isArray(copy.refusedExcludes) && copy.refusedExcludes.length > 0
            ? { refusedExcludes: copy.refusedExcludes }
            : {}),
        };
        logEvent("backup_offline_copy", "completed", {
          operationId,
          reason,
          durationMs: copy.durationMs,
          bytes: copy.bytes,
          partial: copy.partial,
          ...(copy.partial ? { partialReasons: copy.partialReasons } : {}),
          coverage: copy.coverage ?? null,
          excludedBytes: Number.isFinite(copy.excludedBytes) ? copy.excludedBytes : 0,
          completeness: copy.exclusivityEvidence?.completeness,
        });
        closeRung({ ok: true, bytes: copy.bytes });
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
          // Classified here; runQuiescedAttemptLoop hands over to the live
          // ladder (never a terminal on its own — a one-rung ladder would
          // offer consented reuse before any fresh upstream attempt ran).
          // The refusal travels as the live ladder's prior attempt (its first
          // row names it) and finishFailure appends it to the eventual
          // message, so "why no copy" is never lost from the 409/warning.
          closeRung({ ok: false, kind: "offline_copy_refused" });
          return {
            copyRefused: {
              classified: {
                kind: "offline_copy_refused",
                message: `The pre-update backup could not be taken: the AlphaClaw offline copy of the paused state was refused because ${detail}.`,
                hint: `Stop whatever else is using the OpenClaw state directory, then retry. ${gateHint}`,
                stepError: `offline copy refused: ${detail}`,
                detail,
              },
              result: null,
              outputFile,
            },
          };
        }
        closeRung({ ok: false, kind: "offline_copy_failed" });
        return { copyFailed: { stage, error: detail, copySetBytes: measured.copySetBytes } };
      } finally {
        stopProgress();
      }
    };

    // WI-1.4 / #79 (c): the in-quiesce ladder. The offline copy runs FIRST,
    // unconditionally (D1a). A REFUSED copy (exclusivity — a foreign holder,
    // a lost barrier, an unconfirmed stop) ends the pause and hands over to
    // the live ladder: the in-quiesce upstream would face the same holder,
    // while the live upstream runs against a running gateway anyway. Only
    // when the copy failed at a non-exclusivity stage AND the upstream
    // `backup create` is predicted to fit what is left of the pause does the
    // upstream attempt loop run (kQuiescedOutcomePolicy, fixed deadline,
    // budget-aware contention retries). The copy never runs twice in one
    // pause, so every policy arm that used to say "offline copy next" hands
    // over to the live ladder instead.
    const runQuiescedAttemptLoop = async ({ quiesceDeadline, stopEvidence, quietToken, stopConfirmed }) => {
      const quiesceRemaining = () => Math.max(0, quiesceDeadline - nowFn());
      const copy = await runOfflineCopy({ stopEvidence, quietToken, stopConfirmed, quiesceRemaining });
      // { publish } — decided; the caller finalizes after the unwind.
      if (copy.publish) return copy;
      if (copy.copyRefused) {
        if (track.offlineCopy) track.offlineCopy.next = { rung: "live", reason: "offline_copy_refused" };
        backupLog(
          `[openclaw-update] backup: offline copy refused (${copy.copyRefused.classified.detail}); the paused rungs need exclusivity the live upstream does not — handing over to the live ladder`,
        );
        logEvent("backup_rung", "handed_over", {
          operationId,
          rung: "upstream",
          quiesced: false,
          reason: "offline_copy_refused",
          remainingMs: quiesceRemaining(),
        });
        return { fallback: true, lastAttempt: copy.copyRefused };
      }
      const copyAttempt = {
        classified: { kind: "offline_copy_failed", stage: copy.copyFailed.stage },
      };
      // Post-copy decision: the deterministic veto first, then the speed
      // verdict — the diagnosis's predicted upstream ms × safety factor vs.
      // the remaining pause, and the copy set (the copy's own exact walk
      // figure when it got that far, else the diagnosis's) vs. the upstream
      // byte cap. Fail-closed: a diagnosis walk that hit its budget left the
      // prediction unknown, and any unknown hands over to the live ladder.
      // Recorded on the run (offlineCopy.next, upstreamVeto) and as a
      // `backup_rung` event either way.
      const veto = describeUpstreamVeto(diagnosis);
      if (veto) track.upstreamVeto = veto;
      const verdict = veto
        ? { rung: "offline_copy", reason: veto }
        : chooseBackupRung({
            diagnosis: {
              ...(diagnosis || {}),
              copySetBytes: copy.copyFailed.copySetBytes ?? diagnosis?.copySetBytes ?? null,
            },
            remainingMs: quiesceRemaining(),
            upstreamMaxBytes: backupBudget.upstreamMaxBytes,
          });
      if (verdict.rung !== "upstream") {
        if (track.offlineCopy) track.offlineCopy.next = { rung: "live", reason: verdict.reason };
        backupLog(
          `[openclaw-update] backup: offline copy failed (${copy.copyFailed.stage}); the in-quiesce upstream attempt is ruled out (${verdict.reason}) — handing over to the live ladder`,
        );
        logEvent("backup_rung", "handed_over", {
          operationId,
          rung: "upstream",
          quiesced: false,
          reason: verdict.reason,
          remainingMs: quiesceRemaining(),
        });
        return { fallback: true, lastAttempt: copyAttempt };
      }
      if (track.offlineCopy) track.offlineCopy.next = { rung: "upstream", reason: verdict.reason };
      backupLog(
        `[openclaw-update] backup: offline copy failed (${copy.copyFailed.stage}); the upstream backup is predicted to fit the remaining pause (${verdict.reason}) — running it with the gateway still paused`,
      );
      const quiesceBudgetMs = Math.max(1, quiesceRemaining());
      let lastAttempt = null;
      for (;;) {
        const attemptStartedAt = nowFn();
        const attempt = await runBackupAttempt({
          timeoutMs: Math.max(1, quiesceRemaining()),
          quiesced: true,
          reason: lastAttempt ? "contention_retry" : verdict.reason,
          detail: lastAttempt
            ? `attempt ${track.attempts + 1} — retrying after state-database lock contention (gateway still paused)`
            : `offline copy failed (${copy.copyFailed.stage}) — upstream backup predicted to fit the pause, gateway still paused`,
        });
        // { publish } or { failure } — the usable check ran in-quiesce, the
        // rest is finalized by runBackup after the unwind.
        if (attempt.status === "success") return finishSuccess(attempt, { deferred: true });
        if (attempt.status === "fresh_install") return { done: finishFreshInstall() };
        // In-quiesce: finishNoArtifact arms the debris sweep (inQuiesce is
        // set), runBackup runs it after the unwind.
        if (attempt.status === "no_artifact") return { done: await finishNoArtifact(attempt) };
        lastAttempt = attempt;
        const kind = attempt.classified.kind;
        const policy = kQuiescedOutcomePolicy[kind] ?? kQuiescedOutcomePolicy.default;
        if (policy === "retry") {
          const failedMs = nowFn() - attemptStartedAt;
          const backoffMs =
            backupBudget.contentionBackoffBaseMs * 2 ** track.contentionRetries;
          const retryVerdict = contentionRetryVerdict({
            failedMs,
            backoffMs,
            remainingMs: quiesceRemaining(),
            budgetMs: quiesceBudgetMs,
            retries: track.contentionRetries,
            maxRetries: backupBudget.contentionRetries,
          });
          logEvent("backup_contention", retryVerdict.retry ? "retrying" : "exhausted", {
            operationId,
            attempt: track.attempts,
            failedMs,
            backoffMs,
            remainingMs: quiesceRemaining(),
            reason: retryVerdict.reason,
          });
          if (retryVerdict.retry) {
            track.contentionRetries += 1;
            backupLog(
              `[openclaw-update] backup: state-database lock contention on attempt ${track.attempts} — retrying in ${Math.round(backoffMs / 1000)}s with the gateway still paused (${track.contentionRetries}/${backupBudget.contentionRetries})`,
            );
            await sleepMs(backoffMs);
            continue;
          }
          backupLog(
            `[openclaw-update] backup: not retrying in-quiesce (${retryVerdict.reason}) — the offline copy already ran this pause; handing over to the live ladder`,
          );
          return { fallback: true, lastAttempt: attempt };
        }
        // "offline_copy" is the rung built to fit — but it already ran (and
        // failed) this pause; a second copy would meet the same failure, so
        // it hands over exactly like "fallback".
        if (policy === "offline_copy" || policy === "fallback") {
          return { fallback: true, lastAttempt: attempt };
        }
        if (policy === "workspace_retry") return { workspaceRetry: true, lastAttempt: attempt };
        // Terminal: classified in-quiesce, finalized after the unwind (a
        // failure's finalization may run the reuse gate — see runOfflineCopy).
        return { failure: attempt };
      }
    };

    // Quiesce transaction. Returns { done: <final result> } when the step
    // decided without an archive (fresh install, phantom artifact — whose
    // debris sweep is armed in-quiesce and run by the caller after the finally
    // below (#79 (g)) — or, hard gate only, lock or barrier unavailable),
    // { publish: <thunk> } when a
    // backup was written and CHECKED in-quiesce (the caller runs the publish
    // — prune, sha256, record — after the finally below), { failure:
    // <attempt> } when it failed terminally (the caller finalizes it —
    // soft-gate warning, or 409 + reuse gate — only after the finally below
    // has resumed the state DB and relaunched the gateway),
    // { fallback: true, relaunched } when the live ladder should take over
    // (lock or barrier unavailable on a SOFT gate, stop unavailable, an
    // exogenous writer raced even the paused gateway, or the offline copy
    // failed at a non-exclusivity stage and the in-quiesce upstream did not
    // fit or failed too), or { workspaceRetry: true } when the caller must run
    // the one-shot --no-include-workspace retry LIVE (never in-quiesce).
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
        track.backupRiskBlocked = true;
        backupLog(
          `[openclaw-update] backup: quiesce lock unavailable (${acquireError.message}) — falling back to live attempts`,
        );
        return { fallback: true };
      }
      if (!release) {
        track.backupRiskBlocked = true;
        const message =
          "The pre-update backup could not pause the gateway: another gateway operation is in progress.";
        if (!hardGate) {
          // #79 (c): a soft gate degrades the backup RUNG, never the apply —
          // the live ladder runs against the un-paused gateway. (Codex 14:
          // the apply's own serialization is applyUpdate's applyInProgress /
          // getActiveGatewayOperation gate at its entry, untouched here.)
          backupLog(
            `[openclaw-update] backup: quiesce lock busy — soft gate, falling back to live attempts`,
          );
          emit("backup", "warning", {
            detail:
              "could not pause the gateway (another gateway operation is in progress) — live backup attempts instead",
          });
          return { fallback: true };
        }
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
      // From here to the release in the finally, a failure finisher must not
      // sweep debris (sweepDebrisInRun defers it) — nothing heavy runs under
      // the lock with the gateway down.
      inQuiesce = true;
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
        // Fixed deadline, computed ONCE and sized for BOTH quiesced rungs up
        // front (the offline copy's budget plus the upstream's — #79 (c)):
        // every in-quiesce step gets what is left of it, never a fresh
        // budget, and the envelope keeps the usable-check reserve back from
        // it. The lease (quiesceHoldMs) and the quiet barrier's maximum are
        // derived from the same two budgets, so the deadline can never
        // outlive either.
        const quiesceDeadline =
          nowFn() +
          Math.min(
            backupBudget.quiesceTimeoutMs + backupBudget.offlineCopyBudgetMs,
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
          track.backupRiskBlocked = true;
          backupLog(`[openclaw-update] backup: state-db quiet barrier unavailable (${detail})`);
          if (!hardGate) {
            // Soft gate: the finally below relaunches the stopped gateway and
            // `relaunched` makes the caller settle (poll isRunning + settle)
            // before the live ladder runs against its startup writes — the
            // same rung change as the busy lock above; hardGate keeps the
            // honest 409.
            emit("backup", "warning", {
              detail: `could not pause state-database access (${detail}) — live backup attempts instead`,
            });
            return { fallback: true, relaunched: gatewayDown };
          }
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
        inQuiesce = false;
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
    // Why the first live attempt runs: the plain ladder (no quiesce seam —
    // the bin/boot instance) or a fallback out of the quiesce transaction.
    let firstLiveReason = "live_ladder";
    if (willQuiesce) {
      const quiesced = await runQuiescedBackup();
      // #79 (g): a finisher that ran paused (finishNoArtifact) armed the
      // debris sweep; the finally above has resumed the state DB, relaunched
      // the gateway and released the lock, so it runs here.
      await consumeDeferredDebrisSweep();
      if (quiesced.done) return quiesced.done;
      // Finalized HERE — the quiesce's finally has resumed the state DB,
      // relaunched the gateway, and released the lock — so neither the
      // success publish (prune + advisory sha256 + record) nor the reuse
      // gate's candidate re-verification ever runs against a paused box.
      // `failure` is a TERMINAL in-quiesce upstream kind (kQuiescedOutcome-
      // Policy default); a refused copy is not one — it arrives as
      // `fallback` + `lastAttempt` and the live ladder below runs first.
      // A soft gate's failure lands on finishFailure's warning path (noBackup).
      if (quiesced.publish) return quiesced.publish();
      if (quiesced.failure) return finishFailure(quiesced.failure);
      if (quiesced.relaunched) await settleAfterRelaunch();
      priorAttempt = quiesced.lastAttempt || null;
      firstLiveReason = "live_fallback";
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
    //
    // The veto is consulted by BOTH drivers (#79 (d)): the quiesced one ruled
    // the post-copy in-quiesce upstream out with it above; here it rules out
    // the live RETRY. The first live attempt still runs — it is the last rung
    // and the veto is a prediction — but a second CLI ceiling against a
    // snapshot predicted to self-deadlock buys nothing but a burnt envelope.
    const liveVeto = describeUpstreamVeto(diagnosis);
    if (liveVeto) {
      track.upstreamVeto = liveVeto;
      backupLog(
        `[openclaw-update] backup: the upstream snapshot is predicted to self-deadlock on this box (${liveVeto}: journal=${
          diagnosis.journalMode
        }, state=${Math.round((diagnosis.stateBytes || 0) / 1e6)}MB) — one live attempt, no retry`,
      );
    }
    const vetoNote = liveVeto
      ? " — last rung, no retry: the upstream snapshot is predicted to self-deadlock on this rollback-journal database"
      : "";
    let liveAttempts = 0;
    let lastAttempt = null;
    const retriesUsed = {};
    while (liveAttempts < backupBudget.liveAttempts) {
      const budget = attemptBudgetMs();
      if (budget < 1) break;
      liveAttempts += 1;
      const prior = lastAttempt || priorAttempt;
      // The row names what this attempt follows: an earlier CLI attempt, or
      // (attempts still 0 — the paused rung was the offline copy) the copy.
      const detail =
        track.attempts > 0
          ? `attempt ${track.attempts + 1} — retrying after ${describePriorFailure(prior)}${vetoNote}`
          : prior
            ? `live upstream attempt after ${describePriorFailure(prior)}${vetoNote}`
            : undefined;
      const attempt = await runBackupAttempt({
        timeoutMs: budget,
        detail,
        reason: liveAttempts === 1 ? firstLiveReason : "live_retry",
      });
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
      if (liveVeto) {
        backupLog(
          `[openclaw-update] backup: not retrying the live upstream attempt (${liveVeto}) — a ${kind.replace(/_/g, "-")} failure against a snapshot predicted to self-deadlock`,
        );
        logEvent("backup_rung", "skipped", {
          operationId,
          rung: "upstream",
          quiesced: false,
          reason: liveVeto,
          kind,
          remainingMs: remainingMs(),
        });
        break;
      }
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
  // silently stop this sweep from matching. Runs at the start of every
  // runBackup, from pruneBackups, and as the directory arm of the boot sweep
  // (sweepBackupDebris boot mode). Returns the dirs it removed.
  const sweepStaleOfflineCopyDirs = async () => {
    const removed = [];
    let names = [];
    try {
      names = fsModule.readdirSync(backupsDir);
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
  const sweepBackupDebris = async ({ mode } = {}) => {
    if (!kBackupDebrisModes.includes(mode)) {
      throw new TypeError(`sweepBackupDebris: unknown mode ${JSON.stringify(mode)}`);
    }
    const boot = mode === "boot";
    const summary = { mode, removed: [], removedBytes: 0, kept: [], errors: [] };
    let names = [];
    try {
      names = fsModule.readdirSync(backupsDir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        summary.errors.push({ name: null, error: error.message });
        log(`backup debris sweep (${mode}) skipped: ${error.message}`);
      }
      return summary;
    }
    const staleTempBeforeMs =
      nowFn() - (backupBudget.cliTimeoutMs + backupBudget.staleTempDirSlackMs);
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
    return summary;
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
      let bytes = 0;
      try {
        const st = fsModule.statSync(full);
        mtime = st.mtimeMs;
        bytes = st.size || 0;
      } catch {
        continue;
      }
      if (name.endsWith(".tmp")) temps.push({ full, mtime, bytes });
      else if (name.endsWith(".unverified")) unverified.push({ full, mtime, bytes });
      else if (isBackupArchiveName(name)) archives.push({ full, mtime, bytes });
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
    // budget so the operator frees space or adds disk. Since #79 (g) the
    // `.tmp` / `.unverified` debris on disk at this moment is folded in: a
    // quarantined multi-GB archive or a crash's staging file is what filled
    // the volume in the incident, not the kept archives, and a warning that
    // counted only the archives would have said "within budget".
    try {
      const budgetBytes =
        typeof readBackupBudgetBytes === "function"
          ? readBackupBudgetBytes()
          : require("./autotune").getBackupMaxTotalBytes();
      if (budgetBytes != null) {
        const keptBytes = newestFirst(archives)
          .slice(0, kOpenclawBackupKeepCount)
          .reduce((sum, entry) => sum + entry.bytes, 0);
        const debrisBytes = [...temps, ...unverified].reduce((sum, entry) => sum + entry.bytes, 0);
        if (keptBytes + debrisBytes > budgetBytes) {
          const gb = (n) => `${Math.round((n / 1024 ** 3) * 10) / 10}GB`;
          const debris =
            debrisBytes > 0
              ? ` plus ${gb(debrisBytes)} of .tmp/.unverified debris (temps swept now; the newest .unverified is kept for diagnosis)`
              : "";
          log(
            `backup retention warning: kept archives use ${gb(keptBytes)}${debris} of the ${gb(budgetBytes)} disk budget — delete old archives from the backups directory or add disk`,
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

  // State databases OpenClaw 2026.8 may migrate: the global control-plane DB
  // (kind "state") and every per-agent data-plane DB (kind "agent",
  // docs/reference/database-schemas.md). The two kinds carry DIFFERENT
  // schema lines (2026.9.2: state 15, agent 19), and upstream's `database
  // preflight` verb compares a file with the STATE schema only — feeding it an
  // agent DB produced the false "incompatible" of issue #78. Every consumer
  // that hands a path to that verb must filter on `kind`; agent DBs are
  // judged by assessAgentDb below.
  const enumerateStateDbEntries = () => {
    const entries = [];
    const root = stateDir();
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
  const enumerateStateDbs = () =>
    enumerateStateDbEntries().map((entry) => entry.path);
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

  // Verify the target release can read the current state DBs before we let it run.
  // Runs the EXACT overlay binary (not the installed runtime) against a WAL-consistent
  // VACUUM INTO snapshot of each DB. Fail-open ONLY for a genuinely unsupported command
  // (stable target); any real incompatibility hard-blocks the apply in both directions.
  // binOverride: dev applies probe the freshly built checkout binary; the boot
  // rollback path probes the rollback target's overlay bin. packageDirOverride
  // names the package tree whose dist declares the target's schema constants
  // (dev applies pass the checkout — a dev build has no overlay). emit
  // defaults to a no-op so non-operation callers (boot) can use it too.
  //
  // Two arms (issue #78): the STATE DB goes through the target's own
  // `database preflight` (a state-schema verb) exactly as before; every AGENT
  // DB is judged here — its PRAGMA user_version against the target's declared
  // OPENCLAW_AGENT_SCHEMA_VERSION — because the verb would compare it with
  // the wrong schema line. An unknown target agent schema fails open with one
  // warning (like an unsupported verb); a snapshot that reads as a NEWER
  // agent schema hard-blocks, naming the DB and both numbers.
  const runDatabasePreflight = async ({
    version,
    emit = () => {},
    binOverride = null,
    packageDirOverride = null,
  }) => {
    emit("db-preflight", "running");
    const packageDir =
      packageDirOverride || channelStore.overlayPackageDir(version);
    const bin = binOverride || channelStore.resolvePackageBin(packageDir);
    if (!bin) {
      emit("db-preflight", "warning", { detail: "no target binary to probe" });
      return { ok: true, warned: true };
    }
    const entries = enumerateStateDbEntries();
    if (entries.length === 0) {
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
    // The target's supported schema, resolved ONCE per preflight: declared
    // from its own dist, else the learned/seeded table (mergeSupportedSchema).
    const supported = await supportedSchemaAsync({ packageDir, version });
    let anyUnsupported = false;
    let migrationRequired = false;
    let foundVersion = null;
    let targetVersion = null;
    let dbSizesBytes = 0;
    // Per-kind tallies for the persisted verdict. `checked` = at least one DB
    // of the kind received a real verdict (the fail-open paths never count).
    const byKind = {
      state: {
        dbCount: 0,
        bytes: 0,
        foundVersion: null,
        // Our own PRAGMA read of the same snapshot — evidence beside the
        // CLI's foundVersion, never a second authority.
        userVersion: null,
        targetVersion: null,
        migrationRequired: false,
        unsupported: false,
        checked: false,
      },
      agent: {
        dbCount: 0,
        bytes: 0,
        // max across agent DBs
        foundVersion: null,
        targetVersion: supported.agent,
        migrationRequired: false,
        unknownTarget: supported.agent == null,
        checked: false,
      },
    };
    for (const entry of entries) {
      const dbPath = entry.path;
      const tally = byKind[entry.kind];
      const label = dbEntryLabel(entry);
      tally.dbCount += 1;
      try {
        const size = fsModule.statSync(dbPath).size;
        dbSizesBytes += size;
        tally.bytes += size;
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
        if (entry.kind === "agent") {
          // Agent arm: never the state-schema verb. Unknown target → counted
          // once after the loop; an unreadable snapshot names the DB and code
          // and fails open (the snapshot is ours, not the target's fault).
          const assessed = assessAgentDb(snapshot, supported.agent);
          if (assessed.read.status !== "ok") {
            emit("db-preflight", "warning", {
              detail: `could not read the schema version of ${label} (${assessed.read.error?.code || assessed.read.status}) — agent database compatibility not checked`,
            });
            continue;
          }
          tally.foundVersion = Math.max(
            tally.foundVersion ?? -1,
            assessed.foundVersion,
          );
          if (assessed.verdict === "unknown") continue;
          tally.checked = true;
          if (assessed.verdict === "incompatible") {
            emit("db-preflight", "failed", {
              detail: `${label}: agent schema ${assessed.foundVersion} is newer than the ${assessed.targetVersion} this build supports`,
            });
            return {
              ok: false,
              error: channelError(
                "db_preflight_failed",
                `OpenClaw ${version} cannot read your agent database ${label}: it is at agent schema ${assessed.foundVersion} and this build supports up to ${assessed.targetVersion}.`,
                // D2 contract: consequence + fix. The block fired BEFORE
                // activation, so nothing changed — no restore is needed.
                "The update was stopped before anything changed — your current version keeps running. Pick a version whose agent schema is at least as new as your database, or check the target's release notes for a database migration note.",
                null,
                {
                  dbKind: "agent",
                  agentId: entry.agentId,
                  foundVersion: assessed.foundVersion,
                  targetVersion: assessed.targetVersion,
                },
              ),
            };
          }
          if (assessed.verdict === "migration-required") {
            tally.migrationRequired = true;
            migrationRequired = true;
          }
          continue;
        }
        const result = await runner.runStreamed({
          command: "node",
          args: [bin, "database", "preflight", snapshot, "--json"],
          env: probeEnv(),
          timeoutMs: 120000,
        });
        const verdict = classifyPreflight(result);
        if (verdict === "unsupported") {
          anyUnsupported = true;
          tally.unsupported = true;
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
              null,
              { dbKind: "state", agentId: null },
            ),
          };
        } else {
          tally.checked = true;
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
              tally.migrationRequired = true;
            }
            if (foundVersion == null && parsed.foundVersion != null) {
              foundVersion = parsed.foundVersion;
              tally.foundVersion = parsed.foundVersion;
            }
            if (targetVersion == null && parsed.targetVersion != null) {
              targetVersion = parsed.targetVersion;
              tally.targetVersion = parsed.targetVersion;
            }
          }
          // Two oracles on ONE snapshot: the target's verb is authoritative
          // for the state line; our PRAGMA read is evidence. A disagreement
          // is worth one warning (it is how #78-class bugs surface), never a
          // block and never a substitute verdict.
          const own = readSqliteUserVersion(snapshot, { fsModule });
          if (own.status === "ok") {
            tally.userVersion = own.userVersion;
            if (
              Number.isInteger(parsed?.foundVersion) &&
              own.userVersion !== parsed.foundVersion
            ) {
              const detail = `${label}: PRAGMA user_version is ${own.userVersion} but the target's preflight reported foundVersion ${parsed.foundVersion}`;
              log(`db-preflight: ${detail}`);
              emit("db-preflight", "warning", { detail });
            }
          }
        }
      } finally {
        try {
          if (snapped) fsModule.rmSync(snapshot, { force: true });
        } catch {}
      }
    }
    const anyChecked = byKind.state.checked || byKind.agent.checked;
    if (byKind.agent.dbCount > 0 && byKind.agent.unknownTarget) {
      emit("db-preflight", "warning", { detail: kAgentTargetUnknownWarning });
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
    const { checked: _stateChecked, ...stateVerdict } = byKind.state;
    const { checked: _agentChecked, ...agentVerdict } = byKind.agent;
    return {
      ok: true,
      unsupported: anyUnsupported,
      verdict: {
        // OR across kinds; null only when NO database received a verdict.
        migrationRequired: anyChecked ? migrationRequired : null,
        // Top-level found/target stay the STATE line's (issue #20 consumers).
        foundVersion,
        targetVersion,
        // Every DB, both kinds — the boot migration budget scales on it.
        dbSizesBytes,
        byKind: { state: stateVerdict, agent: agentVerdict },
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

  const backupRisk = createBackupRiskCoordinator({
    now: nowFn, fsModule, openclawDir, makeError: channelError,
    describeSource: () => getExecutingBuild(),
    describeTarget: async ({ channel, version, sha }) => {
      const id = channel === "dev" ? sha : version;
      if (!id) return null;
      if (channelStore.isBlocklisted(id)) throw Object.assign(new Error("version blocklisted"), { code: "version_blocklisted" });
      if (channel === "dev" && (!/^[a-f0-9]{40}$/i.test(sha) || readCheckoutHead() !== sha)) return null;
      if (channel !== "dev" && !channelStore.hasOverlay(version)) return null;
      const packageDir = channel === "dev" ? checkoutDir : channelStore.overlayPackageDir(version);
      let pkg;
      try { pkg = JSON.parse(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8")); } catch { return null; }
      if (typeof pkg.version !== "string" || (channel !== "dev" && pkg.version !== version)) return null;
      const build = describeBinAt(packageDir, pkg.version, channel === "dev" ? "dev" : "overlay");
      if (!build) return null;
      build.buildId = id;
      return { ...build, schemas: await supportedSchemaAsync(build) };
    },
    readVersions: () => readStateDbVersions(),
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
      if (selfUpdating) throw Object.assign(new Error("self update in progress"), { code: "self_update_in_progress" });
      if (hold) return applyCommitPolicy.assert({ hold, intent, recoveryHold });
      // Preparation/issuance is read-only and owns no lease. It may inspect
      // its own apply latch and a backed-up recovery's original hold. Other
      // holds and corrupt authority refuse; mutation uses the owned policy.
      const info = getChannelInfo();
      if (info.stateCorrupted || (info.gatewayHold && !matchesApplyRecoveryHold({
        intent, recoveryHold, gatewayHold: info.gatewayHold,
      }))) throw Object.assign(new Error("gateway held"), { code: info.stateCorrupted ? "state_corrupted" : "gateway_held" });
    },
    readRun: (operationId) => ledger.readRun(operationId),
  });
  const requestBackupRiskConsent = (options) => backupRisk.request(options);
  const isBackupRiskEligible = (backup) => !backup.backupRiskBlocked && !backup.orphanedBackup && !backup.offlineCopy?.orphanedBackup &&
    backup.offlineCopy?.stage !== "exclusivity" &&
    ["no_command", "timeout", "killed", "vanished_file", "verify", "no_artifact"].includes(backup.backupFailureKind);

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
    // A human approval must carry the issued token and authenticated session.
    // The boolean alone never authorizes skipping a backup failure.
    confirmNoBackup = false,
    confirmNoBackupToken = null,
    consentSessionId = null,
  } = {}) => {
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
    const { steps, emit, updateDetail } = stepRecorder(operationId, sink);
    const startedAt = nowFn();
    let commitHold = null;
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
      if (!restartImminent) {
        commitHold?.();
        commitHold = null;
      }
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
          // Settle the intent stamp this apply wrote (#76 RC3): only a
          // landed apply may later authorize a settings restore.
          if (
            s.lastTransition &&
            s.lastTransition.operationId === operationId &&
            (s.lastTransition.ok === null || body.restartDeferred === true)
          ) {
            s.lastTransition.ok = status < 400 && body?.ok === true;
          }
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
                  ...(body.backupRiskEligible === true ? { backupRiskEligible: true, operationId } : {}),
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
                finishedAt: nowFn(),
                ...(isReusableBackupOffer(body.reusableBackup)
                  ? { reusableBackup: body.reusableBackup }
                  : {}),
                ...(body.backupRiskEligible === true ? { backupRiskEligible: true, operationId } : {}),
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
                : body.restartDeferred === true ? "activation_failed" : "failed";
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
                ...(body.backupRiskEligible === true ? { backupRiskEligible: true, operationId } : {}),
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
      const recoveryHold = state.gatewayHold ? structuredClone(state.gatewayHold) : null;

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
      // state that 2026.7.x cannot read back. And every channel-boundary
      // crossing hard-gates (#79 (a)): prerelease ↔ stable in EITHER direction
      // or a channel-name change — the SAME predicate the Upgrade confirm
      // renders its hard-gate copy from, so a beta→stable apply can no longer
      // be gated here while the confirm promised nothing. `currentChannel` is
      // the PERSISTED applied channel (Codex 19), never alphaclaw.json's
      // mutable releaseChannel selection: the operator may have flipped that
      // minutes ago for this very apply, and it would then read "same
      // channel" for a stable→beta move.
      const isDowngrade =
        channel !== "dev" &&
        installedVersion &&
        version &&
        compareVersionParts(version, installedVersion) < 0;
      const isPrereleaseTarget =
        channel !== "dev" && isPrereleaseVersion(version);
      const crossesBoundary = crossesChannelBoundary({
        installedVersion,
        targetVersion: version,
        currentChannel: state.applied?.channel ?? "stable",
        targetChannel: channel,
      });
      const backupHardGate =
        isDowngrade || channel === "dev" || isPrereleaseTarget || crossesBoundary;
      const backup = confirmation ? { ...confirmation.backup, ok: true, noBackup: true } : await runBackup({
        emit,
        updateDetail,
        hardGate: backupHardGate,
        // The reason names the gate the operator tripped: a same-channel
        // prerelease target (beta.1 → beta.2) is a "prerelease" gate, not a
        // "cross-channel" one — its hint must not send them to "a same-channel
        // version" they are already on.
        gateReason: isDowngrade
          ? "downgrade"
          : channel === "dev"
            ? "dev"
            : crossesBoundary
              ? "cross-channel"
              : "prerelease",
        operationId,
        allowBackupReuse,
      });
      // attempts/quiesced/vanishedPaths make a live-race failure (#11/#18)
      // diagnosable from the run record alone: how many tries, whether the
      // gateway was paused, and which volatile files kept vanishing. The
      // pre-backup diagnosis, contention retries, the offline-copy outcome
      // (#54) and the per-rung attemptsDetail[] (#79: which rungs ran, why
      // each was chosen, how long, how it ended) ride along for the same
      // reason. attempts is 0 — never a fabricated 1 — when no CLI attempt
      // ran (the copy-first ladder's common success).
      const backupDiagnostics = {
        attempts: backup.attempts ?? 0,
        quiesced: Boolean(backup.quiesced),
        quiescedAttempts: backup.quiescedAttempts ?? 0,
        vanishedPaths: Array.isArray(backup.vanishedPaths)
          ? backup.vanishedPaths.slice(0, 10)
          : [],
        contentionRetries: backup.contentionRetries ?? 0,
        offlineCopy: backup.offlineCopy ?? null,
        attemptsDetail: Array.isArray(backup.attemptsDetail)
          ? backup.attemptsDetail.slice(0, 10)
          : [],
        upstreamVeto: backup.upstreamVeto ?? null,
        diagnosis: backup.diagnosis ?? null,
        durationMs: backup.durationMs ?? null,
      };
      let failedBackup = null;
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
        if (!isBackupRiskEligible(backup) || (channel === "dev" &&
            (!/^[a-f0-9]{40}$/i.test(sha || "") || devHead || readCheckoutHead() !== sha || !checkoutBuildReady()))) {
          return finish(409, backup);
        }
        // Preparing an immutable package is safe after an availability-only
        // failure. Dev must already be built: never mutate its live checkout
        // merely to discover what a no-backup confirmation would approve.
        failedBackup = backup;
        backup.noBackup = true;
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
        const buildResult = failedBackup ? { ok: true, sha } : devHead
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
          // The checkout's dist declares the just-built tree's schema
          // constants (a dev build has no overlay to scan).
          packageDirOverride: checkoutDir,
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

      // The failed attempt prepares an immutable target but cannot record an
      // activation. Only verified availability failures may offer a waiver;
      // the retry binds it to the source, target, schemas, and human session.
      const migrationRequired = preflightVerdict?.migrationRequired === true;
      const needsWaiver = Boolean(confirmation || failedBackup || (migrationRequired && backup.noBackup === true));
      const commitTarget = confirmation?.facts.target || { channel, version, sha };
      if (needsWaiver && !confirmation) {
        let eligible = false;
        if (consentSessionId && isBackupRiskEligible(backup)) {
          try {
            const facts = await backupRisk.collectFacts(commitTarget);
            if (facts.source.buildId === sourceBuildAtStart?.buildId) {
              eligible = backupRisk.offer({ operationId, sessionId: consentSessionId, facts, backup, preflight: preflightVerdict });
            }
          } catch (error) {
            if (isConfigUnreadableError(error)) return finish(409, consentConfigError(error));
            log(`backup risk cannot be offered (${error.code || "facts_unverified"})`);
          }
        }
        const migrationLine = describeMigrationLines(preflightVerdict);
        const failure = failedBackup || channelError(
          "backup_required_for_migration",
          `OpenClaw ${targetLabel || version || sha} will migrate your database (${migrationLine}) and no backup exists — the running ${installedVersion || "OpenClaw"} cannot read the migrated database, so there would be no rollback path.`,
          "Fix the backup and retry, or review this failed update's backup risk before continuing without a backup.",
          null,
          { migration: { ...describeMigrationByKind(preflightVerdict), installedVersion: installedVersion || null } },
        );
        if (!failedBackup) emit("backup", "failed", { error: failure.code });
        return finish(409, { ...failure, ...(eligible ? { backupRiskEligible: true, operationId } : {}) });
      }

      // Expensive preparation happened with the gateway available. The final
      // state/schema/artifact read is made under the lifecycle lease, and a
      // queued confirmation must still be unexpired when actually consumed.
      // A verified backup preserves the operator's existing recovery path:
      // applying a compatible build can resolve the hold present at admission.
      // A waiver never grants this capability, and a replacement hold refuses.
      const commitIntent = !confirmation && backup.artifact?.verified === true && recoveryHold
        ? kGatewayMutationIntents.applyRecovery : kGatewayMutationIntents.apply;
      const commitPolicy = { intent: commitIntent, recoveryHold };
      const preparedFacts = await backupRisk.collectFacts(commitTarget, { ...commitPolicy, strict: Boolean(confirmation) });
      if (preparedFacts.source.buildId !== sourceBuildAtStart?.buildId) {
        return finish(409, channelError("apply_source_changed", "The running OpenClaw build changed while this update was prepared.", "Retry the update from the current build."));
      }
      commitHold = await (acquireLifecycleLock || localApplyLock.acquire)("apply_commit", { leaseMs: 60_000 });
      applyCommitPolicy.assert({ hold: commitHold, ...commitPolicy });
      const commitFacts = await backupRisk.collectFacts(commitTarget, { hold: commitHold, ...commitPolicy, strict: Boolean(confirmation) });
      if (JSON.stringify(preparedFacts) !== JSON.stringify(commitFacts)) {
        return finish(409, channelError("apply_facts_changed", "The update facts changed while it waited for the gateway.", "Retry the update and review its current state."));
      }
      if (confirmation && !backupRisk.consume({ token: confirmNoBackupToken, sessionId: consentSessionId, facts: commitFacts })) {
        return finish(409, channelError("backup_consent_required", "The backup-risk confirmation expired or no longer matches this update.", "Request a fresh confirmation for the current failed update."));
      }
      if (confirmation) {
        const migrationLine = describeMigrationLines(preflightVerdict);
        const runningLabel = installedVersion
          ? `the running ${installedVersion}`
          : "the running OpenClaw";
        const consentLine = migrationRequired
          ? `continuing without a backup by operator consent (confirmNoBackup) — the ${migrationLine} migration has no rollback path to ${installedVersion || "the running version"}`
          : "continuing without a backup by operator consent (confirmNoBackup) — no verified archive is available to restore the pre-update state";
        const consentRecord = ledger.updateRun(operationId, (record) => {
            record.backup = { ...(record.backup || { noBackup: true }), noBackupConfirmed: true,
              confirmedFromOperationId: confirmation.operationId };
            return record;
          });
        if (!consentRecord) throw Object.assign(new Error("Could not record the backup-risk approval."), { code: "consent_record_failed" });
        emit("backup", "warning", { detail: consentLine });
        backupLog(`[openclaw-update] backup: ${consentLine}`);
        queueNotify(
          `⚠️ OpenClaw update to ${targetLabel || version || sha} continues WITHOUT a backup by operator consent (confirmNoBackup): ${migrationRequired
            ? `it migrates your database (${migrationLine}) and ${runningLabel} cannot read the migrated database — there is no rollback path.`
            : "no verified archive is available to restore the pre-update state."}`,
          { eventType: "health", operationId, id: `backup-no-backup-consented-${operationId}` },
        );
        logEvent("backup_no_backup_consented", "completed", {
          operationId,
          channel,
          version,
          sha,
          installedVersion: installedVersion || null,
          ...describeMigrationByKind(preflightVerdict),
        });
      }

      // Record + restart. An APPLY never activates in-process: the boot sync
      // activates the recorded build (bin phase), and the only runtime
      // activation is reconcileInstalled (#76 B1.2), which re-activates the
      // build already recorded here — never a new pick.
      emit("record", "running");
      applyCommitPolicy.assert({ hold: commitHold, ...commitPolicy });
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
        setTimeout(async () => {
          try {
            applyCommitPolicy.assert({ hold: commitHold, ...commitPolicy });
            await restartProcess();
          } catch (error) {
            log(`apply restart deferred (${error.code || "restart_failed"})`);
            emit("restarting", "failed", { error: error.code || "restart_deferred" });
            finish(409, channelError(error.code || "restart_deferred",
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
        operationId,
      });
    } catch (error) {
      if (isConfigUnreadableError(error)) return finish(409, consentConfigError(error));
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
  // the quiet barrier counts it (assessLaunchCompatibility's default is the
  // untracked bin-phase reader).
  const trackedReadUserVersion = (dbPath) =>
    readSqliteUserVersion(dbPath, { open: openTrackedReadonlyDatabase, fsModule });
  // Can `candidate` ({ bin, packageDir, version }) open the current DBs?
  // Declared dist constants > learned table (supportedSchemaAsync); the
  // prober (VACUUM INTO snapshot + `database preflight`) only when one is
  // wired AND the state line stays unknown — it is the expensive oracle.
  // `supported` (pre-resolved, e.g. the installed tree's memoized line) and
  // `legacyExecApprovalsPresent` (a caller that KNOWS the file is about to be
  // reaped passes false) override the defaults.
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
    return assessLaunchCompatibility({
      entries: enumerateStateDbEntries(),
      supported: resolved,
      readUserVersion: trackedReadUserVersion,
      lacksVerb: lacksDatabasePreflight(candidate.version),
      probeState:
        prober && candidate.bin
          ? () =>
              prober.probeBinStreamed(candidate.bin, {
                packageDir: candidate.packageDir,
                version: candidate.version,
              })
          : null,
      legacyExecApprovalsPresent:
        legacyExecApprovalsPresent ?? legacyExecApprovalsPresentFor(candidate.version),
    });
  };
  // Prefer the recorded build, else the installed tree, else null. Only a
  // PROVEN mismatch (compatible === false) excludes a candidate; an unknown
  // line fails open (the C1 policy) and is reported as compatible: null.
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
      if (compat?.compatible === false) continue;
      return {
        ...candidate,
        compatible: compat?.compatible ?? null,
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
  const chooserOracles = (prober) => ({
    resolveSupported: async (version) =>
      supportedSchemaAsync({
        packageDir: channelStore.overlayPackageDir(version),
        version,
      }),
    confirm: async (version) => {
      if (rollbackTargetShapeBlocked(version)) return "block";
      const packageDir = channelStore.overlayPackageDir(version);
      const bin = channelStore.resolvePackageBin(packageDir);
      return prober.probeBinStreamed(bin, { packageDir, version });
    },
    lacksVerb: lacksDatabasePreflight,
  });
  // Which locally available build can open the current databases, excluding
  // `exclude` and anything blocklisted: lastKnownGood first (when its overlay
  // is complete), then the newest overlays. null = nothing bootable.
  const chooseBootableCandidate = async ({ exclude = [], prober }) => {
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
      ...chooserOracles(prober),
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
      if (!recover) return none(first.plan);
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
        if (compat?.compatible === false) {
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
        } else if (compat?.compatible === null) {
          log(
            `reconcile: compatibility of ${plan.expected} with the current state databases is unknown (${compat.reasons.join(", ") || "no oracle"}) — proceeding (fail-open)`,
          );
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
            gatewayQuiesce.suppress(kReconcileSuppressMs);
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
            gatewayQuiesce.unsuppress();
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
      holdReason: verdict.compatible === false ? compatHoldReasonFor(verdict.reasons) : null,
    };
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
    if (launchCompatGateDisabled()) {
      warn(
        `launch gate: skipped — ${kLaunchCompatGateEnvKey}=off (the gateway launches whatever tree is on disk)`,
      );
      logEvent("launch_compat_gate", "skipped", { reason: "disabled" });
      return { ...base, compatible: null, skipped: "disabled" };
    }
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
      if (verdict.compatible === false || treatedAsFalse) {
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
      if (verdict.compatible === null) {
        warn(
          `⚠️ launch gate: compatibility of OpenClaw ${installed} with the state databases is UNKNOWN (${verdict.reasons.join(", ") || "no oracle"}) — launching anyway (fail-open); a crash on this tree is classified by stderr, and \`alphaclaw diagnose\` shows the schema lines`,
        );
        logEvent("launch_compat_gate", "unknown", {
          reasons: verdict.reasons,
          installed,
          expected,
          supported: verdict.supported,
        });
        return { ...summary, compatible: null };
      }
      // Compatible: the one hold class this gate owns outright is cleared
      // when every DB reads again (version_mismatch is the config gate's to
      // clear on convergence — it re-judges the tree through this module).
      const stale = channelStore.readState().gatewayHold;
      if (stale?.reason === "state_db_unreadable") {
        channelStore.updateState((s) => {
          if (s.gatewayHold?.reason === "state_db_unreadable") s.gatewayHold = null;
          return s;
        });
        log(
          `launch gate: cleared the state_db_unreadable hold — every state database reads again under OpenClaw ${installed}`,
        );
        logEvent("launch_compat_gate", "hold_cleared", { reason: "state_db_unreadable", installed });
      }
      log(`launch gate: OpenClaw ${installed} can open the state databases (state ${verdict.supported.state ?? "?"}, agent ${verdict.supported.agent ?? "?"})`);
      return { ...summary, compatible: true };
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
