const os = require("os");
const path = require("path");
const kBrowseFilePolicies = require("../public/shared/browse-file-policies.json");
const kBootstrapModelCatalog = require("./model-catalog-bootstrap.json");
const { parsePositiveInt } = require("./utils/number");

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
const kFallbackOnboardingModels =
  Array.isArray(kBootstrapModelCatalog.models) &&
  kBootstrapModelCatalog.models.length > 0
    ? kBootstrapModelCatalog.models
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
 * catches a wedged-but-TCP-up gateway while someone is actually watching. */
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
const kWatchdogCheckIntervalMs =
  parsePositiveInt(process.env.WATCHDOG_CHECK_INTERVAL, 120) * 1000;
const kWatchdogDegradedCheckIntervalMs =
  parsePositiveInt(process.env.WATCHDOG_DEGRADED_CHECK_INTERVAL, 5) * 1000;
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
  kGatewayLifecycleLeaseMs,
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
