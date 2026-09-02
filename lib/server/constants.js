const os = require("os");
const path = require("path");
const kBrowseFilePolicies = require("../public/shared/browse-file-policies.json");
const kBootstrapModelCatalog = require("./model-catalog-bootstrap.json");
const kCuratedModelCatalog = require("./model-catalog-curated.json");
const { parsePositiveInt, readClampedEnvSeconds } = require("./utils/number");

// Portable root directory: --root-dir flag sets ALPHACLAW_ROOT_DIR before require
const kRootDir =
  process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw");
const ALPHACLAW_DIR = kRootDir;
const kPackageRoot = path.resolve(__dirname, "..");
const kNpmPackageRoot = path.resolve(kPackageRoot, "..");
const kSetupDir = path.join(kPackageRoot, "setup");

const PORT = parseInt(process.env.PORT || "3000", 10);
const kDefaultGatewayPort = 18789;
const GATEWAY_HOST = "127.0.0.1";
const kDefaultGatewayUrl = `http://${GATEWAY_HOST}:${kDefaultGatewayPort}`;
const OPENCLAW_DIR = path.join(kRootDir, ".openclaw");
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const ENV_FILE_PATH = path.join(kRootDir, ".env");
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, "workspace");
const kOnboardingMarkerPath = path.join(ALPHACLAW_DIR, "onboarded.json");
const AUTH_PROFILES_PATH = path.join(
  OPENCLAW_DIR,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const CODEX_PROFILE_ID = "openai:codex-cli";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const kCodexOauthStateTtlMs = 10 * 60 * 1000;
const kGoogleOauthStateTtlMs = 10 * 60 * 1000;
/** Hygiene cap for the pending Google OAuth flow map (evict oldest live
 * entry past this — start is admin-gated, so this bounds memory, not DoS). */
const kGoogleOauthMaxPendingFlows = 32;

const kTrustProxyHops = parsePositiveInt(process.env.TRUST_PROXY_HOPS, 1);
const kLoginWindowMs = parsePositiveInt(
  process.env.LOGIN_RATE_WINDOW_MS,
  10 * 60 * 1000,
);
const kLoginMaxAttempts = parsePositiveInt(
  process.env.LOGIN_RATE_MAX_ATTEMPTS,
  5,
);
const kLoginBaseLockMs = parsePositiveInt(
  process.env.LOGIN_RATE_BASE_LOCK_MS,
  60 * 1000,
);
const kLoginMaxLockMs = parsePositiveInt(
  process.env.LOGIN_RATE_MAX_LOCK_MS,
  15 * 60 * 1000,
);
const kLoginGlobalWindowMs = parsePositiveInt(
  process.env.LOGIN_RATE_GLOBAL_WINDOW_MS,
  kLoginWindowMs,
);
const kLoginGlobalMaxAttempts = parsePositiveInt(
  process.env.LOGIN_RATE_GLOBAL_MAX_ATTEMPTS,
  Math.max(kLoginMaxAttempts * 5, 25),
);
const kLoginGlobalBaseLockMs = parsePositiveInt(
  process.env.LOGIN_RATE_GLOBAL_BASE_LOCK_MS,
  kLoginBaseLockMs,
);
const kLoginGlobalMaxLockMs = parsePositiveInt(
  process.env.LOGIN_RATE_GLOBAL_MAX_LOCK_MS,
  kLoginMaxLockMs,
);
const kLoginCleanupIntervalMs = parsePositiveInt(
  process.env.LOGIN_RATE_CLEANUP_INTERVAL_MS,
  60 * 1000,
);
const kLoginStateTtlMs = Math.max(
  parsePositiveInt(
    process.env.LOGIN_RATE_STATE_TTL_MS,
    Math.max(kLoginWindowMs, kLoginMaxLockMs) * 3,
  ),
  kLoginMaxLockMs,
);
// Rescue-link audit-event write caps (routes/rescue-link.js). These gate
// event WRITES only — never the response — so they are flood control for
// watchdog.db, not auth throttles. Single source of truth: the route wiring
// AND its tests import these, so the pinned windows cannot drift apart.
// Global locks are window-length so the documented per-window bound holds
// (a short lock would reset the window and multiply the effective rate).
const kRescueLinkProbeGate = Object.freeze({
  scope: "rescue-probe",
  windowMs: 5 * 60 * 1000, // 1 probe event / 5 min per client IP
  maxAttempts: 1,
  baseLockMs: 5 * 60 * 1000,
  maxLockMs: 5 * 60 * 1000,
  globalWindowMs: 60 * 60 * 1000, // 12 probe events / hour across all IPs
  globalMaxAttempts: 12,
  globalBaseLockMs: 60 * 60 * 1000,
  globalMaxLockMs: 60 * 60 * 1000,
  // Short store TTL: unlocked per-IP entries are garbage minutes after their
  // window; the sweep + the global-first pre-check together bound the store.
  stateTtlMs: 15 * 60 * 1000,
});
const kRescueLinkRedeemGate = Object.freeze({
  scope: "rescue-redeem",
  windowMs: 60 * 1000, // 1 redeemed event / min per client IP
  maxAttempts: 1,
  baseLockMs: 60 * 1000,
  maxLockMs: 60 * 1000,
  globalWindowMs: 60 * 60 * 1000, // 600 redeemed events / hour across all IPs
  globalMaxAttempts: 600,
  globalBaseLockMs: 60 * 60 * 1000,
  globalMaxLockMs: 60 * 60 * 1000,
  stateTtlMs: 5 * 60 * 1000,
});
const kOpenAiCompatApiRateWindowMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_WINDOW_MS,
  kLoginWindowMs,
);
const kOpenAiCompatApiRateMaxAttempts = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_MAX_ATTEMPTS,
  10,
);
const kOpenAiCompatApiRateBaseLockMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_BASE_LOCK_MS,
  kLoginBaseLockMs,
);
const kOpenAiCompatApiRateMaxLockMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_MAX_LOCK_MS,
  kLoginMaxLockMs,
);
const kOpenAiCompatApiRateGlobalWindowMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_GLOBAL_WINDOW_MS,
  kOpenAiCompatApiRateWindowMs,
);
const kOpenAiCompatApiRateGlobalMaxAttempts = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_GLOBAL_MAX_ATTEMPTS,
  Math.max(kOpenAiCompatApiRateMaxAttempts * 10, 100),
);
const kOpenAiCompatApiRateGlobalBaseLockMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_GLOBAL_BASE_LOCK_MS,
  kOpenAiCompatApiRateBaseLockMs,
);
const kOpenAiCompatApiRateGlobalMaxLockMs = parsePositiveInt(
  process.env.OPENAI_COMPAT_API_RATE_GLOBAL_MAX_LOCK_MS,
  kOpenAiCompatApiRateMaxLockMs,
);
const kOpenAiCompatApiRateStateTtlMs = Math.max(
  parsePositiveInt(
    process.env.OPENAI_COMPAT_API_RATE_STATE_TTL_MS,
    Math.max(kOpenAiCompatApiRateWindowMs, kOpenAiCompatApiRateMaxLockMs) * 3,
  ),
  kOpenAiCompatApiRateMaxLockMs,
);

const kOnboardingModelProviders = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "opencode",
  "openrouter",
  "zai",
  "vercel-ai-gateway",
  "kilocode",
  "xai",
  "mistral",
  "cerebras",
  "moonshot",
  "kimi-coding",
  "volcengine",
  "volcengine-plan",
  "byteplus",
  "byteplus-plan",
  "synthetic",
  "minimax",
  // Same credential as minimax (the auth mapping lives in the UI's
  // getAuthProviderFromModelProvider); without this entry every minimax-cn/*
  // row is silently dropped from live/cached catalogs while the raw bootstrap
  // fallback still shows them — models appear on cold start, then vanish.
  "minimax-cn",
  "voyage",
  "groq",
  "vllm",
]);
const kMinimalFallbackOnboardingModels = [
  {
    key: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
  },
  {
    key: "anthropic/claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
  },
  {
    key: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    label: "Claude Opus 4.6",
  },
  {
    key: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
  },
  {
    key: "anthropic/claude-haiku-4-6",
    provider: "anthropic",
    label: "Claude Haiku 4.6",
  },
  {
    key: "openai/gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
  },
  {
    key: "openai/gpt-5.3-codex",
    provider: "openai",
    label: "Codex GPT-5.3",
  },
  {
    key: "openai/gpt-5.1-codex",
    provider: "openai",
    label: "OpenAI GPT-5.1 Codex",
  },
  {
    key: "google/gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
  },
  {
    key: "google/gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash Preview",
  },
];
// Curated rows (model-catalog-curated.json) fill gaps the pinned CLI does not
// emit; on a `key` collision the GENERATED row wins — freshest-from-CLI beats
// hand-curated. Output keeps the refresh script's localeCompare-by-key order.
const mergeCatalogModels = (generatedModels, curatedModels) => {
  const mergedByKey = new Map();
  for (const row of Array.isArray(curatedModels) ? curatedModels : []) {
    if (row && typeof row.key === "string" && row.key) {
      mergedByKey.set(row.key, row);
    }
  }
  for (const row of Array.isArray(generatedModels) ? generatedModels : []) {
    if (row && typeof row.key === "string" && row.key) {
      mergedByKey.set(row.key, row);
    }
  }
  return Array.from(mergedByKey.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
};
const kFallbackOnboardingModels =
  Array.isArray(kBootstrapModelCatalog.models) &&
  kBootstrapModelCatalog.models.length > 0
    ? mergeCatalogModels(
        kBootstrapModelCatalog.models,
        kCuratedModelCatalog.models,
      )
    : kMinimalFallbackOnboardingModels;

/** One shared status compute for all SSE clients + /api/status. */
const kStatusSnapshotIntervalMs = 2 * 1000;
/** /api/status serves the cached snapshot when younger than this. */
const kStatusSnapshotFreshnessMs = 2500;
/** Liveness guarantee: at least one status frame per this window even when
 * nothing changed — clients treat longer silence as a hung stream. */
const kStatusSnapshotHeartbeatMs = 10 * 1000;
/** Upper bound on any single gateway lifecycle operation (restart, repair,
 * apply, boot). A holder that never releases is force-released at expiry so
 * the operation queue cannot deadlock. */
const kGatewayLifecycleLeaseMs = 10 * 60 * 1000;
/** Gateway restart readiness budget (seconds via GATEWAY_RESTART_READY_TIMEOUT,
 * stored as ms). Raised from 120s after the 2026-09-01 incident: a loaded box
 * cold-starting 72 plugins took 90-150s and the timeout escalated a healthy
 * boot to a rescue session. The wait loop returns the instant the port
 * answers, so the budget is a backstop, not a delay. Read at module load — an
 * AlphaClaw process restart is required to change it. Clamped to 30..480s so
 * the derived operation budget below stays coherent with the lifecycle lease. */
const kGatewayRestartReadyTimeoutRawSeconds = parsePositiveInt(
  process.env.GATEWAY_RESTART_READY_TIMEOUT,
  300,
);
const kGatewayRestartReadyTimeoutMs =
  Math.min(480, Math.max(30, kGatewayRestartReadyTimeoutRawSeconds)) * 1000;
{
  const rawValue = process.env.GATEWAY_RESTART_READY_TIMEOUT;
  const clamped =
    kGatewayRestartReadyTimeoutRawSeconds * 1000 !== kGatewayRestartReadyTimeoutMs;
  // Junk that fell back to the default warns too: an operator who SET the
  // var mid-incident must not silently get a value they didn't choose.
  const junk =
    rawValue !== undefined &&
    rawValue !== "" &&
    String(kGatewayRestartReadyTimeoutRawSeconds) !== String(rawValue).trim();
  if (clamped || junk) {
    console.warn(
      `[alphaclaw] GATEWAY_RESTART_READY_TIMEOUT=${rawValue} ${clamped ? "clamped" : "not a positive integer — falling back"} to ${kGatewayRestartReadyTimeoutMs / 1000}s (valid range 30-480)`,
    );
  }
}
/** One shared budget for a full gateway restart operation: every restart-class
 * lifecycle-lock hold, the operation record's lifetime, and the watchdog's
 * expected-restart suppression windows derive from THIS number so a configured
 * ready wait can never outlive the lock/record/window that protects it.
 * Derivation: ready wait + 240s plugin preflight worst case (2 x the 120s
 * kPluginRuntimeDepsPreflightTimeoutMs in gateway.js — initial pass + retry)
 * + 90s stop-cmd/stop-settle/spawn margin; floored at the default lease. */
const kGatewayRestartOperationBudgetMs = Math.max(
  kGatewayLifecycleLeaseMs,
  kGatewayRestartReadyTimeoutMs + 240_000 + 90_000,
);
/** Terminal restart-operation records are kept this long for the reconnecting UI, then pruned. */
const kRestartOperationRetentionMs = 24 * 60 * 60 * 1000;
/** Event-loop lag p99 above this is logged as a warning — the single-threaded
 * server is blocking on synchronous work and every API call is queuing. */
const kEventLoopLagWarnMs = 200;
/** Minimum spacing between event-loop-lag warnings so a sustained stall
 * doesn't flood the log on every resources poll. */
const kEventLoopLagWarnIntervalMs = 60 * 1000;
/** macOS per-pid `ps` stats are refreshed in the background at most this
 * often — resources polls serve the memo instead of a blocking shell-out. */
const kPsStatsMemoMs = 5 * 1000;
/** A gateway liveness observation older than this cannot honestly back a
 * headline state — the reducer degrades to "unknown" instead of guessing. */
const kGatewayStateStaleMs = 15 * 1000;
/** Always-on gateway TCP watcher cadence: dead-gateway detection (and alert
 * latency) drops from <=120s to ~10s even with no browser tab open. */
const kGatewayTcpWatchIntervalMs = 10 * 1000;
/** Health-probe cadence while at least one status client is connected —
 * catches a wedged-but-TCP-up gateway while someone is actually watching.
 * fast_cadence is suppressed while the degraded retry loop is armed or in
 * flight (the loop owns the cadence then). */
const kWatchdogConnectedHealthCadenceMs = 30 * 1000;
/** Debounce for tcp up/down transition probes (flap absorption). */
const kGatewayTcpTransitionDebounceMs = 1000;
const kVersionCacheTtlMs = 60 * 1000;
/** Backoff before re-spawning `openclaw --version` after a failed probe — a
 * missing/broken binary must not be re-probed on every status tick. */
const kVersionFailureRetryMs = 30 * 1000;
const kLatestVersionCacheTtlMs = 10 * 60 * 1000;
/** `cp` of a full openclaw npm tree into /app/node_modules can exceed 60s on slow volumes. */
const kOpenclawUpdateCopyTimeoutMs = 5 * 60 * 1000;
/** Exit code for INTENTIONAL restarts (self-update, version switch, rollback)
 * on container platforms — 75 = EX_TEMPFAIL ("temporary failure, retry").
 * Contract with supervising wrappers (the templates' start.sh): exit 75 means
 * "relaunch me immediately" and must NOT count toward crash/failure
 * thresholds. Old wrappers that don't know the code treat it like any other
 * nonzero exit — no worse than the exit-1 behavior it replaces. */
const kIntentionalRestartExitCode = 75;
const kOpenclawRegistryUrl = "https://registry.npmjs.org/openclaw";
const kAlphaclawRegistryUrl = "https://registry.npmjs.org/@chrysb%2falphaclaw";
const kAlphaclawGithubReleasesBaseUrl =
  "https://api.github.com/repos/garrytan/alphaclaw/releases";

// --- OpenClaw release-channel pinning -------------------------------------
const kOpenclawReleaseChannels = Object.freeze(["stable", "beta", "dev"]);
const kOpenclawGithubApiBaseUrl =
  "https://api.github.com/repos/openclaw/openclaw";
// Managed internals live under <root>/.openclaw/.alphaclaw so they persist on
// the volume but stay out of the user's workspace repo.
// Only the shim dir is consumed outside the release-channel store (the PATH
// prepend in bin/alphaclaw.js) — it must stay byte-identical to the store's
// layout in openclaw-release-channel.js. The store derives every other path
// from its injected roots.
const kOpenclawManagedDir = path.join(OPENCLAW_DIR, ".alphaclaw");
const kOpenclawBinShimDir = path.join(kOpenclawManagedDir, "bin");
const kOpenclawBackupsDir = path.join(kRootDir, "backups", "openclaw");
// SQLite snapshot repository: `backup sqlite create` (2026.8.1 beta line)
// requires an explicit --repository directory; each committed snapshot is one
// subdirectory inside it.
const kOpenclawSqliteBackupDir = path.join(
  kRootDir,
  "backups",
  "openclaw-sqlite",
);
// Local Claude Code rescue session (claude-code-local). The home/ dir holds
// the CLI's full-scope OAuth credential (home/.claude/.credentials.json) — it
// is deliberately NOT the gateway children's HOME (that is kRootDir, so their
// implicit ~/.claude is <kRootDir>/.claude) and any future whole-rootDir
// backup mechanism MUST exclude claude-code-local/home (re-login after
// restore is the documented recovery) AND claude-code-local/state.json —
// state.json persists the live rescue-link capability token (linkToken) plus
// the raw claude.ai session URL, and a restored copy of either is a stale
// secret at best. Today's backups are openclaw-scoped (<root>/backups/…) and
// capture neither. workspace/ is a managed EMPTY cwd so
// unattended spawns never pick up project-level .claude/ settings or hooks
// that other processes may have written under the shared root.
const kClaudeCodeLocalDir = path.join(kRootDir, "claude-code-local");
const kClaudeCodeLocalHomeDir = path.join(kClaudeCodeLocalDir, "home");
const kClaudeCodeLocalWorkspaceDir = path.join(kClaudeCodeLocalDir, "workspace");
const kClaudeCodeLocalStateFile = path.join(kClaudeCodeLocalDir, "state.json");
// Explicit -S socket (never -L: that resolves under TMPDIR, which /tmp
// cleaning would orphan while the session lives on).
const kClaudeCodeLocalSocketPath = path.join(kClaudeCodeLocalDir, "tmux.sock");
const kClaudeCodeLocalLockFile = path.join(kClaudeCodeLocalDir, "lifecycle.lock");
const kClaudeCodeLocalSessionName = "alphaclaw-rescue";
// TUI-parsing fixtures (tests/server/fixtures/claude-code-tui/) are captured
// against this range; the Dockerfile pin and this constant move together.
const kClaudeCodeLocalTestedVersionPattern = /^2\.[12]\./;

const kOpenclawCatalogCacheDir = path.join(kRootDir, "cache", "openclaw-catalog");
const kOpenclawActivationSentinelName = ".openclaw-activation.json";
const kOpenclawCatalogCacheTtlMs =
  parsePositiveInt(process.env.OPENCLAW_CATALOG_CACHE_TTL, 600) * 1000;
// One-shot catalog prewarm after boot; the jitter keeps a fleet restarting
// together from hammering the anonymous GitHub quota in the same second.
const kOpenclawCatalogPrewarmDelayMs = 5000;
const kOpenclawCatalogPrewarmJitterMs = 15_000;
const kOpenclawStableCatalogCount = 5;
const kOpenclawBetaCatalogCount = 5;
const kOpenclawDevCommitCap = 50;
const kOpenclawDevCommitFallbackCount = 30;
const kOpenclawStabilizationWindowMs =
  parsePositiveInt(process.env.OPENCLAW_STABILIZATION_WINDOW_HOURS, 24) *
  60 *
  60 *
  1000;
const kOpenclawAcceptanceHoldMs =
  parsePositiveInt(process.env.OPENCLAW_ACCEPTANCE_HOLD, 120) * 1000;
const kOpenclawDegradedRollbackMs =
  parsePositiveInt(process.env.OPENCLAW_DEGRADED_ROLLBACK_MINUTES, 10) *
  60 *
  1000;
const kOpenclawDevMinDiskBytes = 5 * 1024 * 1024 * 1024;
const kOpenclawPackageMinDiskBytes = 1024 * 1024 * 1024;
// Live dev builds measured 20-35 min in drills; the budget needs headroom
// past the real ceiling or the timeout kill itself becomes the failure mode.
const kOpenclawApplyTimeoutMs = 45 * 60 * 1000;
const kOpenclawBackupTimeoutMs = 10 * 60 * 1000;
// Boot-time `doctor --fix` config migration (issue #21 bug 1): env-tunable
// default, scaled up by total state-DB size, and hard-capped BELOW the boot
// placeholder's 15-minute /health 503 flip — past that ceiling the platform
// restarts the container mid-migration, which is exactly the partial-migration
// brick the migration gate exists to prevent.
const kOpenclawDoctorMigrationTimeoutMs =
  parsePositiveInt(process.env.OPENCLAW_DOCTOR_MIGRATION_TIMEOUT, 600) * 1000;
const kOpenclawDoctorMigrationTimeoutCapMs = 12 * 60 * 1000;
const kOpenclawDoctorMigrationBytesPerSec = 1024 * 1024;
// One shared boot heavy-ops budget: the doctor migration AND the rollback
// preflights draw from it (a rollback boot with no restorable config runs
// both), so their per-operation ceilings can never stack past the placeholder.
const kOpenclawBootOpsBudgetMs = 12 * 60 * 1000;
const kOpenclawBootPreflightBudgetMs = 8 * 60 * 1000;
const kOpenclawBackupKeepCount = 3;

// Legacy agent-concurrency ceiling (pre-autotune): the telegram auto-scale
// formula's hard cap, and the value autotune's disable-path clamps back to.
// The subagent budget is always this minus the delta. One home so the two
// consumers (telegram-workspace.js, autotune.js) cannot drift.
const kAgentConcurrencyLegacyCap = 64;
const kSubagentConcurrencyDelta = 2;
// Backup live-race handling (issues #11/#18): the whole backup step — the
// quiesced attempt plus any live retries — shares one envelope so a
// pathological box can never eat the 45-min apply budget inside one step.
const kOpenclawBackupPhaseEnvelopeMs = 25 * 60 * 1000;
const kOpenclawBackupLiveAttempts = 3;
const kOpenclawBackupRetryDelayMs = 750;
// Quiesce transaction (lock + stop + backup + start) must finish inside
// kGatewayLifecycleLeaseMs (10 min) or the lease force-release lets a
// watchdog relaunch land mid-backup — hence 7 min, not the full 10.
const kOpenclawBackupQuiesceTimeoutMs = 7 * 60 * 1000;
const kOpenclawBackupQuiesceStopTimeoutMs = 30 * 1000;
const kOpenclawBackupQuiesceLockTimeoutMs = 90 * 1000;
// Boot config/DB migration (issue #20): budget scales with state-DB size —
// the fixed 120 s spawnSync timeout killed a 767 MB migration mid-write.
const kOpenclawBootMigrationBaseTimeoutMs = 10 * 60 * 1000;
const kOpenclawBootMigrationPerGbMs = 5 * 60 * 1000;
const kOpenclawBootMigrationMaxTimeoutMs = 30 * 60 * 1000;
const kOpenclawBootPreflightTimeoutMs = 120 * 1000;
// A sized doctor migration can legitimately hold the gateway lifecycle lock
// for up to the migration ceiling — the default 10-min lease would
// force-release mid-migration and let a queued restart/repair launch the
// gateway against half-migrated DBs. Boot and reconcile-retry acquire with
// this lease instead. The ceiling itself is env-raisable
// (OPENCLAW_DOCTOR_MIGRATION_TIMEOUT feeds sizedMigrationBudgetMs' base AND
// its cap), so the lease must track the knob; the 15-min margin covers the
// non-doctor overhead around it (validate ×2, live DB probes, gate
// preflights ≤8 min).
const kOpenclawReconcileLifecycleLeaseMs =
  Math.max(kOpenclawBootMigrationMaxTimeoutMs, kOpenclawDoctorMigrationTimeoutMs) +
  15 * 60 * 1000;
// Watchdog suppression during the backup quiesce outlives the quiesce budget
// by this slack so a stop that runs to its own timeout never races the
// watchdog's expected-restart expiry.
const kOpenclawBackupQuiesceSuppressSlackMs = 2 * 60 * 1000;
// Issue #54: the upstream `backup create` can lose its SQLite state lease to
// a concurrent writer. In-quiesce retries are budget-aware (a retry fires only
// when the failed attempt used < 50% of the quiesce budget and enough remains
// for attempt + backoff + 30 s); the backoff doubles from the base.
const kOpenclawBackupContentionRetries = 2;
const kOpenclawBackupContentionBackoffBaseMs = 15 * 1000;
// After a relaunch (quiesced attempt timed out / raced), the live ladder waits
// for the gateway to answer, then settles, so the first live attempt does not
// run against a gateway still replaying its startup writes.
const kOpenclawBackupPostQuiesceReadyTimeoutMs = 20 * 1000;
const kOpenclawBackupPostQuiescePollMs = 500;
const kOpenclawBackupPostQuiesceSettleMs = 10 * 1000;
// AlphaClaw offline copy (still quiesced): sqlite online backup() per DB +
// verbatim assets + `tar -I 'gzip -1'`. Workspaces ride along only below the
// inline threshold; above it the archive is recorded partial.
const kOpenclawBackupOfflineCopyBudgetMs = 8 * 60 * 1000;
const kOpenclawBackupWorkspaceInlineBytes = 512 * 1024 * 1024;
const kOpenclawBackupOfflineCopyBusyTimeoutMs = 30 * 1000;
// Rollback-journal mode (forced on cifs/smb/virtiofs/9p/nfs) makes a reader's
// SHARED lock block the writer's COMMIT with busy_timeout 0 — a large DB
// self-deadlocks the upstream snapshot, so the quiesced driver skips straight
// to the offline copy above this size.
const kOpenclawBackupRollbackJournalSelfDeadlockBytes = 256 * 1024 * 1024;
// The offline copy's live-process exclusivity gate refuses on ANY `openclaw`
// argv, and AlphaClaw's own transient CLI shell-outs (`sessions list` polled
// by the chat sidebar, a cron run, a capability --help probe) are not gated by
// the quiet barrier. Before refusing, the driver re-samples the process list
// for up to this long (every poll interval) while it is non-empty, so a child
// that is already exiting does not turn the last-resort copy into a terminal
// 409. A holder that stays is refused with its argv named.
const kOpenclawBackupExclusivitySettleMs = 5 * 1000;
const kOpenclawBackupExclusivitySettlePollMs = 250;
// Every regex branch of the backup classifier looks at the last N non-empty
// output lines — the lease-loss cause sits several lines above the final
// "Backup failed" line.
const kBackupTailClassifyLines = 20;
// State-DB quiet period held across the quiesced attempts AND the offline
// copy, with slack so the barrier can never expire inside a budgeted copy.
// The driver derives the effective maximum from its EFFECTIVE budgets (a
// backupTuning override that raises the quiesce/offline budgets raises the
// barrier with them); this constant is the default-budget value.
const kOpenclawStateDbQuietSlackMs = 2 * 60 * 1000;
const kOpenclawStateDbQuietMaxMs =
  kOpenclawBackupQuiesceTimeoutMs + kOpenclawBackupOfflineCopyBudgetMs + kOpenclawStateDbQuietSlackMs;
// Consented backup reuse: a verified archive at most this old, re-verified
// (gzip -t + manifest + sha256) within this budget — the reuse verification
// is read-only (touches neither the gateway nor the state DBs), so it gets
// this budget of its OWN, never what is left of the phase envelope; the
// archive a migrating run recorded stays pinned against keep-N pruning for
// this long.
const kOpenclawBackupReuseMaxAgeMs = 24 * 60 * 60 * 1000;
// A recorded backup timestamp ahead of the clock by more than this is not
// "recent": it is a clock jump or a forged record, and the age test alone
// (now - at ≤ 24 h) would accept it forever because the difference is
// negative. Small NTP corrections after a backup stay inside the tolerance.
const kOpenclawBackupClockSkewToleranceMs = 5 * 60 * 1000;
const kOpenclawBackupReuseVerifyTimeoutMs = 5 * 60 * 1000;
const kOpenclawBackupPinMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
// The usable check (gzip -t + manifest) of a CLI-verified archive needs time
// of its own: no ladder attempt starts unless the envelope still holds the
// attempt's budget PLUS this reserve, and the check always gets at least the
// reserve — otherwise a 1 ms check "times out" and quarantines a good archive.
const kOpenclawBackupUsableCheckReserveMs = 60 * 1000;
// The quiesce transaction's lifecycle-lock lease covers the quiesced
// attempts and the offline copy — plus everything around them that runs
// while the lock is held: the stop (≤30 s), the quiet-barrier begin (≤5 s
// listeners + ≤2 s handle drain), the usable check (≤ the reuse-verify
// budget), and the relaunch's ready budget. The prune and the advisory
// sha256 of a successful archive run AFTER the unlock (they touch neither the
// gateway nor the state DBs), so they need no share of it. Without the
// reserve the lease force-releases mid-copy and a queued gateway operation
// lands on a paused state dir.
const kOpenclawBackupQuiesceLeaseReserveMs =
  kOpenclawBackupQuiesceStopTimeoutMs +
  7 * 1000 +
  kOpenclawBackupReuseVerifyTimeoutMs +
  kGatewayRestartReadyTimeoutMs +
  30 * 1000;
// A `.offline-copy-<pid>-<rand>` temp dir under the backups dir that outlives
// the offline-copy budget by this much is crash/SIGTERM debris (gracefulExit
// hard-exits after 10 s, before the copy's finally can remove it) and is swept.
const kOpenclawBackupStaleTempDirSlackMs = 10 * 60 * 1000;
// Backup inventory (GET /api/openclaw/backups): entry cap + SWR ttl.
const kOpenclawBackupInventoryMaxEntries = 50;
const kOpenclawBackupInventoryTtlMs = 5 * 1000;
// Bump when the reconciler's strip/rename policy changes: the cross-boot
// re-attempt gate hashes (config + installedVersion + policy version).
const kReconcilerPolicyVersion = 1;
// Update run ledger: per-operation records + durable logs. Dev builds emit
// hundreds of MB, so both a per-run cap and a directory total-bytes cap exist.
const kOpenclawRunKeepCount = 10;
const kOpenclawUpdateLogMaxBytes = 10 * 1024 * 1024;
const kOpenclawUpdateLogsMaxTotalBytes = 200 * 1024 * 1024;
// Notification outbox: failed deliveries retry with exponential backoff
// (base delay doubling per attempt, capped) until the event ages out at 48h.
// The attempt cap is a belt only — age is the terminator (at a 1h backoff
// ceiling, 48h cannot reach 100 attempts).
const kNotifyOutboxMaxAttempts = 100;
const kNotifyOutboxKeepCount = 100;
const kNotifyOutboxMaxAgeMs = 48 * 60 * 60 * 1000;
const kNotifyOutboxBackoffBaseMs = 60_000;
const kNotifyOutboxBackoffMaxMs = 3600_000;
// ---------------------------------------------------------------------------
const kAppDir = kNpmPackageRoot;
const kMaxPayloadBytes = parsePositiveInt(process.env.WEBHOOK_LOG_MAX_BYTES, 50 * 1024);
const kWebhookPruneDays = parsePositiveInt(process.env.WEBHOOK_LOG_RETENTION_DAYS, 30);
/** Watchdog probe cadence (seconds via env, stored as ms). Healthy probes run
 * every kWatchdogCheckIntervalMs; once degraded, retries back off from
 * kWatchdogDegradedCheckIntervalMs, doubling per failure, and hold at
 * kWatchdogDegradedCheckMaxIntervalMs. Read at module load — an AlphaClaw
 * process restart is required to change them. Deployment env only: never
 * honored from the agent-writable .env (see deployment-only-env.js). */
const kWatchdogCheckIntervalMs =
  readClampedEnvSeconds("WATCHDOG_CHECK_INTERVAL", {
    fallback: 120,
    min: 30,
    max: 3600,
  }) * 1000;
const kWatchdogDegradedCheckIntervalMs =
  readClampedEnvSeconds("WATCHDOG_DEGRADED_CHECK_INTERVAL", {
    fallback: 5,
    min: 2,
    max: 120,
  }) * 1000;
const kWatchdogDegradedCheckMaxIntervalMs = (() => {
  const rawCapSeconds = readClampedEnvSeconds(
    "WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL",
    { fallback: 30, min: 5, max: 120 },
  );
  // A cap below the initial interval would make the backoff shrink; the loop
  // goes flat at the initial instead, and says so. Name the side that moved:
  // when the operator only raised the initial, the cap being raised is the
  // untouched default, not something they set.
  const capMs = Math.max(rawCapSeconds * 1000, kWatchdogDegradedCheckIntervalMs);
  if (capMs !== rawCapSeconds * 1000) {
    console.warn(
      `[alphaclaw] WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL=${rawCapSeconds}${String(process.env.WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL ?? "").trim() ? "" : " (default)"} raised to ${capMs / 1000}s to stay >= WATCHDOG_DEGRADED_CHECK_INTERVAL=${kWatchdogDegradedCheckIntervalMs / 1000}`,
    );
  }
  return capMs;
})();
const kWatchdogStartupFailureThreshold = parsePositiveInt(
  process.env.WATCHDOG_STARTUP_FAILURE_THRESHOLD,
  3,
);
const kWatchdogMaxRepairAttempts = parsePositiveInt(
  process.env.WATCHDOG_MAX_REPAIR_ATTEMPTS,
  2,
);
const kWatchdogCrashLoopWindowMs =
  parsePositiveInt(process.env.WATCHDOG_CRASH_LOOP_WINDOW, 300) * 1000;
const kWatchdogCrashLoopThreshold = parsePositiveInt(
  process.env.WATCHDOG_CRASH_LOOP_THRESHOLD,
  3,
);
const kWatchdogLogRetentionDays = parsePositiveInt(
  process.env.WATCHDOG_LOG_RETENTION_DAYS,
  30,
);
const kLogMaxBytes = parsePositiveInt(
  process.env.LOG_MAX_BYTES,
  2 * 1024 * 1024,
);
// Doctor status is rebuilt on a 2s SSE tick; these TTLs keep the expensive
// pieces (workspace hash walk, bootstrap file reads, run queries) off that
// hot path. Snapshots recompute in a background worker thread when stale.
const kDoctorWorkspaceSnapshotTtlMs = 60_000;
const kDoctorBootstrapContextTtlMs = 30_000;
const kDoctorStatusMemoTtlMs = 5_000;

const kSystemVars = new Set([
  "WEBHOOK_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "SETUP_PASSWORD",
  "PORT",
  "ALPHACLAW_DEPLOYMENT_PROVIDER",
  "ALPHACLAW_MANAGED_UPDATE_URL",
  "ALPHACLAW_MANAGED_UPDATE_TOKEN",
  "ALPHACLAW_TEMPLATE_REPO_URL",
  "ALPHACLAW_TEMPLATE_BRANCH",
  "WATCHDOG_AUTO_REPAIR",
  "WATCHDOG_NOTIFICATIONS_DISABLED",
  "WATCHDOG_NOTIFICATIONS_QUIET",
]);
const kKnownVars = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API Key",
    group: "ai",
    hint: "From console.anthropic.com",
    features: ["Models"],
  },
  {
    key: "ANTHROPIC_TOKEN",
    label: "Anthropic Setup Token",
    group: "ai",
    hint: "From claude setup-token",
    features: ["Models"],
    visibleInEnvars: false,
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API Key",
    group: "ai",
    hint: "From platform.openai.com",
    features: ["Models", "Embeddings", "TTS", "STT"],
  },
  {
    key: "GEMINI_API_KEY",
    label: "Gemini API Key",
    group: "ai",
    hint: "From aistudio.google.com",
    features: ["Models", "Embeddings", "Image", "STT"],
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API Key",
    group: "ai",
    hint: "From elevenlabs.io (XI_API_KEY also works)",
    features: ["TTS"],
  },
  {
    key: "GITHUB_TOKEN",
    label: "GitHub Access Token",
    group: "github",
  },
  {
    key: "GITHUB_WORKSPACE_REPO",
    label: "Workspace Repo",
    group: "github",
    hint: "username/repo or https://github.com/username/repo",
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    label: "Telegram Bot Token",
    group: "channels",
    hint: "From @BotFather",
  },
  {
    key: "DISCORD_BOT_TOKEN",
    label: "Discord Bot Token",
    group: "channels",
    hint: "From Discord Developer Portal",
  },
  {
    key: "SLACK_BOT_TOKEN",
    label: "Slack Bot Token",
    group: "channels",
    hint: "From your Slack app's OAuth & Permissions page (xoxb-...)",
  },
  {
    key: "SLACK_APP_TOKEN",
    label: "Slack App Token",
    group: "channels",
    hint: "From Basic Information → App-Level Tokens (xapp-...)",
  },
  {
    key: "WHATSAPP_OWNER_NUMBER",
    label: "WhatsApp Owner Number",
    group: "channels",
    hint: "E.164 number, e.g. +15551234567",
  },
  {
    key: "MISTRAL_API_KEY",
    label: "Mistral API Key",
    group: "ai",
    hint: "From console.mistral.ai",
    features: ["Models", "Embeddings", "STT"],
  },
  {
    key: "VOYAGE_API_KEY",
    label: "Voyage API Key",
    group: "ai",
    hint: "From dash.voyageai.com",
    features: ["Embeddings"],
  },
  {
    key: "GROQ_API_KEY",
    label: "Groq API Key",
    group: "ai",
    hint: "From console.groq.com",
    features: ["Models", "STT"],
  },
  {
    key: "DEEPGRAM_API_KEY",
    label: "Deepgram API Key",
    group: "ai",
    hint: "From console.deepgram.com",
    features: ["STT"],
  },
  {
    key: "BRAVE_API_KEY",
    label: "Brave Search API Key",
    group: "tools",
    hint: "From brave.com/search/api",
  },
  {
    key: "CLAUDE_CODE_ROUTINE_URL",
    label: "Claude Code Routine URL",
    group: "tools",
    hint: "Routine fire URL (or trig_… id) from claude.ai/code/routines — powers the sidebar launcher",
  },
  {
    key: "CLAUDE_CODE_ROUTINE_TOKEN",
    label: "Claude Code Routine Token",
    group: "tools",
    hint: "Per-routine token from claude.ai (sk-ant-oat01-…)",
  },
  {
    key: "CLAUDE_CODE_LOCAL_ENABLED",
    label: "Claude Code Local Rescue",
    group: "tools",
    hint: "On unless set to 0/false — the sidebar launcher prefers a Claude Code session running on this box (needs a one-time login on the Watchdog page). Disabling never kills a live session; stop it from the Watchdog card.",
  },
  {
    key: "CLAUDE_CODE_LOCAL_AUTOSTART",
    label: "Rescue Session Autostart",
    group: "tools",
    hint: "1 = start a warm rescue session at boot (after login). Costs ~200MB while running.",
  },
  {
    key: "CLAUDE_CODE_LOCAL_PERMISSION_MODE",
    label: "Rescue Session Permission Mode",
    group: "tools",
    hint: "default | acceptEdits | bypassPermissions. bypassPermissions runs with NO approval prompts (dangerous — full autonomy on this box) and only ever applies to sessions you start by clicking; autostart/incident sessions clamp to acceptEdits. Applies on next session start.",
  },
  {
    key: "CLAUDE_CODE_LOCAL_CWD",
    label: "Rescue Session Directory",
    group: "tools",
    hint: "Absolute path the session opens in. Default is a managed empty directory; pointing it at a project dir lets that dir's .claude/ settings and hooks load into rescue sessions.",
  },
  {
    key: "CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT",
    label: "Rescue Session on Incidents",
    group: "tools",
    hint: "On unless set to 0/false — when the watchdog opens an incident (and login is done), warm the rescue session and put its link in the notification when already running.",
  },
];
const kKnownKeys = new Set(kKnownVars.map((v) => v.key));

const SCOPE_MAP = {
  "gmail:read": "https://www.googleapis.com/auth/gmail.readonly",
  "gmail:write": "https://www.googleapis.com/auth/gmail.modify",
  "calendar:read": "https://www.googleapis.com/auth/calendar.readonly",
  "calendar:write": "https://www.googleapis.com/auth/calendar",
  "tasks:read": "https://www.googleapis.com/auth/tasks.readonly",
  "tasks:write": "https://www.googleapis.com/auth/tasks",
  "docs:read": "https://www.googleapis.com/auth/documents.readonly",
  "docs:write": "https://www.googleapis.com/auth/documents",
  "meet:read": "https://www.googleapis.com/auth/meetings.space.readonly",
  "meet:write": "https://www.googleapis.com/auth/meetings.space.created",
  "drive:read": "https://www.googleapis.com/auth/drive.readonly",
  "drive:write": "https://www.googleapis.com/auth/drive",
  "contacts:read": "https://www.googleapis.com/auth/contacts.readonly",
  "contacts:write": "https://www.googleapis.com/auth/contacts",
  "sheets:read": "https://www.googleapis.com/auth/spreadsheets.readonly",
  "sheets:write": "https://www.googleapis.com/auth/spreadsheets",
};
const REVERSE_SCOPE_MAP = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([k, v]) => [v, k]),
);
const BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

const GOG_CONFIG_DIR = path.join(OPENCLAW_DIR, "gogcli");
const GOG_CREDENTIALS_PATH = path.join(GOG_CONFIG_DIR, "credentials.json");
const GOG_STATE_PATH = path.join(GOG_CONFIG_DIR, "state.json");
const GOG_KEYRING_PASSWORD = process.env.GOG_KEYRING_PASSWORD || "alphaclaw";
const kMaxGoogleAccounts = 5;
const kGmailServeBasePort = parsePositiveInt(
  process.env.GMAIL_SERVE_BASE_PORT,
  18801,
);
const kGmailWatchRenewalIntervalMs =
  parsePositiveInt(process.env.GMAIL_WATCH_RENEWAL_INTERVAL_SECONDS, 6 * 60 * 60) *
  1000;
const kGmailWatchRenewalThresholdMs =
  parsePositiveInt(process.env.GMAIL_WATCH_RENEWAL_THRESHOLD_SECONDS, 24 * 60 * 60) *
  1000;
const kGmailMaxBodyBytes = parsePositiveInt(
  process.env.GMAIL_WATCH_MAX_BODY_BYTES,
  20000,
);
const gogClientCredentialsPath = (clientName = "default") =>
  clientName === "default"
    ? GOG_CREDENTIALS_PATH
    : path.join(GOG_CONFIG_DIR, `credentials-${clientName}.json`);

const API_TEST_COMMANDS = {
  gmail: "gmail labels list",
  calendar: "calendar calendars",
  tasks: "tasks lists",
  docs: "docs info __api_check__",
  meet: "meet spaces list",
  drive: "drive ls",
  contacts: "contacts list",
  sheets: "sheets metadata __api_check__",
};

const kChannelDefs = {
  telegram: { envKey: "TELEGRAM_BOT_TOKEN" },
  discord: { envKey: "DISCORD_BOT_TOKEN" },
  slack: { envKey: "SLACK_BOT_TOKEN", extraEnvKeys: ["SLACK_APP_TOKEN"] },
  whatsapp: { envKey: "WHATSAPP_OWNER_NUMBER", sync: false },
  clickclack: { envKey: "CLICKCLACK_BOT_TOKEN" },
  // Externally configured (signal-cli link) — no managed env token. The
  // missing envKey keeps syncChannelConfig's add/remove loop away from it;
  // `external` lets getChannelStatus report it without a token (#113).
  signal: { external: true, sync: false },
};
const kProtectedBrowsePaths = new Set(
  Array.isArray(kBrowseFilePolicies?.protectedPaths)
    ? kBrowseFilePolicies.protectedPaths
    : [],
);
const kLockedBrowsePaths = new Set(
  Array.isArray(kBrowseFilePolicies?.lockedPaths)
    ? kBrowseFilePolicies.lockedPaths
    : [],
);

const SETUP_API_PREFIXES = [
  "/api/status",
  "/api/team",
  "/api/pairings",
  "/api/google",
  "/api/codex",
  "/api/models",
  "/api/browse",
  "/api/chat",
  "/api/gateway",
  "/api/restart-status",
  "/api/onboard",
  "/api/env",
  "/api/auth",
  "/api/openclaw",
  "/api/devices",
  "/api/sync-cron",
  "/api/telegram",
  "/api/webhooks",
  "/api/gmail",
  "/api/watchdog",
  "/api/usage",
  "/api/cron",
  "/api/agents",
  "/api/channels",
  "/api/operations",
  "/api/nodes",
  "/api/admin",
  "/api/autotune",
];

module.exports = {
  ALPHACLAW_DIR,
  kRootDir,
  kPackageRoot,
  kNpmPackageRoot,
  kSetupDir,
  PORT,
  kDefaultGatewayPort,
  GATEWAY_HOST,
  kDefaultGatewayUrl,
  OPENCLAW_DIR,
  GATEWAY_TOKEN,
  ENV_FILE_PATH,
  WORKSPACE_DIR,
  kOnboardingMarkerPath,
  AUTH_PROFILES_PATH,
  CODEX_PROFILE_ID,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_TOKEN_URL,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_SCOPE,
  CODEX_JWT_CLAIM_PATH,
  kCodexOauthStateTtlMs,
  kGoogleOauthStateTtlMs,
  kGoogleOauthMaxPendingFlows,
  kTrustProxyHops,
  kLoginWindowMs,
  kLoginMaxAttempts,
  kLoginBaseLockMs,
  kLoginMaxLockMs,
  kLoginGlobalWindowMs,
  kLoginGlobalMaxAttempts,
  kLoginGlobalBaseLockMs,
  kLoginGlobalMaxLockMs,
  kLoginCleanupIntervalMs,
  kLoginStateTtlMs,
  kRescueLinkProbeGate,
  kRescueLinkRedeemGate,
  kOpenAiCompatApiRateWindowMs,
  kOpenAiCompatApiRateMaxAttempts,
  kOpenAiCompatApiRateBaseLockMs,
  kOpenAiCompatApiRateMaxLockMs,
  kOpenAiCompatApiRateGlobalWindowMs,
  kOpenAiCompatApiRateGlobalMaxAttempts,
  kOpenAiCompatApiRateGlobalBaseLockMs,
  kOpenAiCompatApiRateGlobalMaxLockMs,
  kOpenAiCompatApiRateStateTtlMs,
  kOnboardingModelProviders,
  kFallbackOnboardingModels,
  mergeCatalogModels,
  kGatewayLifecycleLeaseMs,
  kGatewayRestartReadyTimeoutMs,
  kGatewayRestartOperationBudgetMs,
  kRestartOperationRetentionMs,
  kEventLoopLagWarnMs,
  kEventLoopLagWarnIntervalMs,
  kPsStatsMemoMs,
  kGatewayStateStaleMs,
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kStatusSnapshotIntervalMs,
  kStatusSnapshotFreshnessMs,
  kStatusSnapshotHeartbeatMs,
  kVersionCacheTtlMs,
  kVersionFailureRetryMs,
  kLatestVersionCacheTtlMs,
  kOpenclawUpdateCopyTimeoutMs,
  kIntentionalRestartExitCode,
  kOpenclawRegistryUrl,
  kOpenclawReleaseChannels,
  kOpenclawGithubApiBaseUrl,
  kOpenclawManagedDir,
  kOpenclawBinShimDir,
  kOpenclawBackupsDir,
  kOpenclawSqliteBackupDir,
  kOpenclawCatalogCacheDir,
  kOpenclawActivationSentinelName,
  kOpenclawCatalogCacheTtlMs,
  kOpenclawCatalogPrewarmDelayMs,
  kOpenclawCatalogPrewarmJitterMs,
  kOpenclawStableCatalogCount,
  kOpenclawBetaCatalogCount,
  kOpenclawDevCommitCap,
  kOpenclawDevCommitFallbackCount,
  kOpenclawStabilizationWindowMs,
  kOpenclawAcceptanceHoldMs,
  kOpenclawDegradedRollbackMs,
  kOpenclawDevMinDiskBytes,
  kOpenclawPackageMinDiskBytes,
  kOpenclawApplyTimeoutMs,
  kOpenclawBackupTimeoutMs,
  kOpenclawDoctorMigrationTimeoutMs,
  kOpenclawDoctorMigrationTimeoutCapMs,
  kOpenclawDoctorMigrationBytesPerSec,
  kOpenclawBootOpsBudgetMs,
  kOpenclawBootPreflightBudgetMs,
  kOpenclawBackupKeepCount,
  kAgentConcurrencyLegacyCap,
  kSubagentConcurrencyDelta,
  kOpenclawBackupPhaseEnvelopeMs,
  kOpenclawBackupLiveAttempts,
  kOpenclawBackupRetryDelayMs,
  kOpenclawBackupQuiesceTimeoutMs,
  kOpenclawBackupQuiesceStopTimeoutMs,
  kOpenclawBackupQuiesceLockTimeoutMs,
  kOpenclawBootMigrationBaseTimeoutMs,
  kOpenclawBootMigrationPerGbMs,
  kOpenclawBootMigrationMaxTimeoutMs,
  kOpenclawBootPreflightTimeoutMs,
  kOpenclawReconcileLifecycleLeaseMs,
  kOpenclawBackupQuiesceSuppressSlackMs,
  kOpenclawBackupContentionRetries,
  kOpenclawBackupContentionBackoffBaseMs,
  kOpenclawBackupPostQuiesceReadyTimeoutMs,
  kOpenclawBackupPostQuiescePollMs,
  kOpenclawBackupPostQuiesceSettleMs,
  kOpenclawBackupOfflineCopyBudgetMs,
  kOpenclawBackupWorkspaceInlineBytes,
  kOpenclawBackupOfflineCopyBusyTimeoutMs,
  kOpenclawBackupRollbackJournalSelfDeadlockBytes,
  kOpenclawBackupExclusivitySettleMs,
  kOpenclawBackupExclusivitySettlePollMs,
  kBackupTailClassifyLines,
  kOpenclawStateDbQuietSlackMs,
  kOpenclawStateDbQuietMaxMs,
  kOpenclawBackupReuseMaxAgeMs,
  kOpenclawBackupClockSkewToleranceMs,
  kOpenclawBackupReuseVerifyTimeoutMs,
  kOpenclawBackupPinMaxAgeMs,
  kOpenclawBackupUsableCheckReserveMs,
  kOpenclawBackupQuiesceLeaseReserveMs,
  kOpenclawBackupStaleTempDirSlackMs,
  kOpenclawBackupInventoryMaxEntries,
  kOpenclawBackupInventoryTtlMs,
  kReconcilerPolicyVersion,
  kOpenclawRunKeepCount,
  kOpenclawUpdateLogMaxBytes,
  kOpenclawUpdateLogsMaxTotalBytes,
  kNotifyOutboxMaxAttempts,
  kNotifyOutboxKeepCount,
  kNotifyOutboxMaxAgeMs,
  kNotifyOutboxBackoffBaseMs,
  kNotifyOutboxBackoffMaxMs,
  kAlphaclawRegistryUrl,
  kAlphaclawGithubReleasesBaseUrl,
  kAppDir,
  kMaxPayloadBytes,
  kWebhookPruneDays,
  kWatchdogCheckIntervalMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogDegradedCheckMaxIntervalMs,
  kWatchdogStartupFailureThreshold,
  kWatchdogMaxRepairAttempts,
  kWatchdogCrashLoopWindowMs,
  kWatchdogCrashLoopThreshold,
  kWatchdogLogRetentionDays,
  kLogMaxBytes,
  kDoctorWorkspaceSnapshotTtlMs,
  kDoctorBootstrapContextTtlMs,
  kDoctorStatusMemoTtlMs,
  kSystemVars,
  kKnownVars,
  kKnownKeys,
  kClaudeCodeLocalDir,
  kClaudeCodeLocalHomeDir,
  kClaudeCodeLocalWorkspaceDir,
  kClaudeCodeLocalStateFile,
  kClaudeCodeLocalSocketPath,
  kClaudeCodeLocalLockFile,
  kClaudeCodeLocalSessionName,
  kClaudeCodeLocalTestedVersionPattern,
  kProtectedBrowsePaths,
  kLockedBrowsePaths,
  SCOPE_MAP,
  REVERSE_SCOPE_MAP,
  BASE_SCOPES,
  GOG_CONFIG_DIR,
  GOG_CREDENTIALS_PATH,
  GOG_STATE_PATH,
  GOG_KEYRING_PASSWORD,
  kMaxGoogleAccounts,
  kGmailServeBasePort,
  kGmailWatchRenewalIntervalMs,
  kGmailWatchRenewalThresholdMs,
  kGmailMaxBodyBytes,
  gogClientCredentialsPath,
  API_TEST_COMMANDS,
  kChannelDefs,
  SETUP_API_PREFIXES,
};
