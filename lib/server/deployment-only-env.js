// Env keys that must come from the REAL deployment environment only — never
// honored from the agent-writable .env file. The loaders share this registry
// with API/admin classification and onboarding import filtering:
//   1. bin/alphaclaw.js section 5 — the BOOT-time .env load into process.env
//      (the only path that matters for module-load-read constants like
//      GATEWAY_RESTART_READY_TIMEOUT).
//   2. lib/server/env.js reloadEnv — the RUNTIME re-apply path.
// This module is a leaf (zero requires) so bin can load it before lib/server.
const kExplicitOriginEnvKeys = Object.freeze([
  "ALPHACLAW_SETUP_URL",
  "ALPHACLAW_BASE_URL",
  "RENDER_EXTERNAL_URL",
  "URL",
]);

const kDeploymentOnlyEnvKeys = Object.freeze([
  "ALPHACLAW_ALLOW_LEGACY_LOGIN",
  // Sign-in recovery code (routes/auth.js): it lets its holder past the
  // box-wide and per-IP sign-in limits, so the agent must not set it.
  "ALPHACLAW_LOGIN_RECOVERY_CODE",
  ...kExplicitOriginEnvKeys,
  "RAILWAY_PUBLIC_DOMAIN",
  "RAILWAY_STATIC_URL",
  // Gateway-env allowlist hatches: honoring these from .env would let the
  // agent self-grant broader gateway-child env inheritance.
  "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED",
  "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH",
  // Restart-hardening knob: the agent must not be able to shrink the ready
  // budget (forcing every restart on a slow box to fail at the clamp floor).
  "GATEWAY_RESTART_READY_TIMEOUT",
  // Routine restart grace: from .env the agent could shrink it to the floor
  // and get its own turns cut short on every routine restart, or hold every
  // restart at the ceiling.
  "ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS",
  // Shutdown budget: from .env the agent could shrink it to the floor and
  // have every deploy cut its turns short, or stretch it past the platform's
  // grace so the platform SIGKILLs the whole box.
  "ALPHACLAW_SHUTDOWN_GRACE_SECONDS",
  // Copy retention (copy-retention.js): from .env the agent could shrink
  // either to 1 and have the sweep delete the operator's backups and
  // OpenClaw's recovery captures.
  "ALPHACLAW_BACKUP_RETENTION_KEEP",
  "ALPHACLAW_BACKUP_RETENTION_DAYS",
  "ALPHACLAW_UPDATE_CAPTURE_KEEP",
  // Watchdog cadence knobs: an agent that can write .env must not be able to
  // slow the watchdog's probes to the clamp ceiling (self-blinding).
  "WATCHDOG_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_INTERVAL",
  "WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL",
  // Sustained-failure gate: from .env the agent could raise the repair
  // threshold to the ceiling and keep its own wedged gateway from being
  // repaired (self-blinding, same class as the cadence knobs).
  "WATCHDOG_DEGRADED_REPAIR_THRESHOLD",
  // Disk-full resume margin: from .env the agent could raise it to the
  // ceiling and keep a gateway that ran out of disk from ever coming back.
  "WATCHDOG_DISK_RESUME_FREE_MB",
  // Gateway prelaunch hook path: an executable run before every gateway
  // launch — from .env the agent could point it at any file it can write and
  // run arbitrary code with AlphaClaw's privileges on the next restart.
  "ALPHACLAW_GATEWAY_PRELAUNCH_HOOK",
  // Crash-cause ladder kill switch (issue #76 B1 / CEO 1.3): from .env the
  // agent could switch off the structural repair + pause and put the watchdog
  // back on blind relaunches of a binary that cannot read its own database.
  "OPENCLAW_CRASH_CAUSE_LADDER",
  // Control UI mount kill switch (control-ui-mount.js): `legacy` makes boot
  // REMOVE gateway.controlUi.basePath and the proxy strip the /openclaw
  // prefix again. From .env the agent could flip the dashboard back into the
  // broken root-mounted state under a running proxy (self-blinding), and the
  // proxy routes snapshot the mode at module load while reloadEnv would feed
  // the config writer a different value — a split brain by construction.
  "ALPHACLAW_CONTROL_UI_MOUNT",
  // Restart-ladder knobs (bug #137): `ALPHACLAW_GATEWAY_STOP_ASK=0` skips the
  // graceful `openclaw gateway restart --wait` ask and `ALPHACLAW_LSOF_SHIM=0`
  // withholds the lsof shim that ask needs on an image without lsof. From
  // .env the agent could turn every restart of its own gateway into an
  // immediate SIGTERM of a mid-turn agent; the operator decides that.
  "ALPHACLAW_GATEWAY_STOP_ASK",
  "ALPHACLAW_LSOF_SHIM",
  // Git writer lock handoff (issue #140): a wrapper that already holds
  // alphaclaw-writer.lock passes its fd down. The CLI only trusts an fd whose
  // dev+inode is the lock file, so it is never a bypass, but it describes a
  // live process, not configuration, and has no business in .env.
  "ALPHACLAW_GIT_LOCK_FD",
  // Operator box lock (box-lock.js): from .env the agent could switch off
  // the operators' serialization, point AlphaClaw at another lock, or have
  // root create and append to files at paths it chose (the owner record and
  // the lock log).
  "ALPHACLAW_BOX_LOCK_PATH",
  "ALPHACLAW_BOX_LOCK_WAIT_SECONDS",
  "ALPHACLAW_BOX_LOCK_OWNER",
  "ALPHACLAW_BOX_LOCK_OWNER_PATH",
  "ALPHACLAW_BOX_LOCK_LOG_PATH",
  // Operator sidecars registry and post-boot hook (lib/server/sidecars): each
  // runs commands with AlphaClaw's privileges after every boot. From .env the
  // agent could register any command; the operator owns this list.
  "ALPHACLAW_SIDECARS",
  "ALPHACLAW_POST_BOOT_HOOK",
  // Agent Relay (lib/server/relay/config.js kRelayEnvKeys): from .env the
  // agent could switch off its own relay audit trail, lift the caps on the
  // runs other agents can make it do, shorten the retention of messages it
  // was sent, or move its relay identity; or widen who may connect to the
  // public OAuth MCP endpoint and where wakes are posted; or switch off the
  // brain archive of its relay conversations, or point it at another binary.
  "ALPHACLAW_RELAY",
  "ALPHACLAW_RELAY_RETENTION_DAYS",
  "ALPHACLAW_RELAY_MAX_CONCURRENT",
  "ALPHACLAW_RELAY_HOURLY_CAP",
  "ALPHACLAW_RELAY_PORT",
  "ALPHACLAW_RELAY_AGENT_NAME",
  "ALPHACLAW_RELAY_REMOTE",
  "ALPHACLAW_RELAY_OAUTH_REDIRECT_URIS",
  "ALPHACLAW_RELAY_WAKE_HOSTS",
  "ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT",
  "ALPHACLAW_RELAY_BRAIN",
  "ALPHACLAW_RELAY_BRAIN_BIN",
  "ALPHACLAW_RELAY_BRAIN_PEER_DAILY_MB",
  "ALPHACLAW_RELAY_BRAIN_PEER_TOTAL_MB",
  // Managed update token (alphaclaw-version.js): sent as a bearer header to
  // the managed update endpoint. From .env the agent could swap in a token of
  // its choosing for AlphaClaw's own update requests.
  "ALPHACLAW_MANAGED_UPDATE_TOKEN",
  // Platform deploy credentials the container runtime injects. Nothing in
  // AlphaClaw asks for them in .env, and from .env the agent could plant a
  // credential that every later AlphaClaw-run npm, Railway or Vercel call
  // would use in place of the operator's.
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "VERCEL_TOKEN",
  "NPM_TOKEN",
]);

// Deployment secrets a supported install may still keep in .env, so they
// cannot be deployment-only without locking those installs out. The
// deployment value wins: a .env line applies only when the deployment
// environment does not set the key at all, at boot and on reload alike.
const kDeploymentWinsEnvKeys = Object.freeze([
  // Setup UI password: the shipped env.template asks for it in .env, and a
  // host install that filled that line in would no longer boot. When the
  // deployment sets it, the agent cannot replace it from .env.
  "SETUP_PASSWORD",
  // gog file-keyring password: the README documents it as "the deployment
  // environment or a hand-edited .env", and a changed value no longer opens
  // the existing keyring. Boot still defaults it to "alphaclaw" when neither
  // sets it (kBootManagedEnvKeys below).
  "GOG_KEYRING_PASSWORD",
]);

// The deployment secrets, for masking (relay/mask.js). Never feed these
// to buildSecretReplacements: boot normalization would rewrite a matching
// openclaw.json value into an env ref the gateway cannot resolve.
const kDeploymentSecretEnvKeys = Object.freeze([
  ...kDeploymentWinsEnvKeys,
  "ALPHACLAW_MANAGED_UPDATE_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "VERCEL_TOKEN",
  "NPM_TOKEN",
  "ALPHACLAW_LOGIN_RECOVERY_CODE",
]);

// Set by bin/alphaclaw.js after the .env load, from AlphaClaw's own layout
// (root dir, state dir, PATH shims, port flag). A runtime .env reload never
// touches them: the running process keeps what its boot derived.
const kBootManagedEnvKeys = Object.freeze([
  "ALPHACLAW_ROOT_DIR",
  "PORT",
  "PATH",
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "XDG_CONFIG_HOME",
  "GOG_KEYRING_PASSWORD",
]);

// The deployment environment exactly as the process received it, recorded
// once at the top of bin/alphaclaw.js before anything (the .env load, the
// managed keys above) changes process.env. A .env reload falls back to it for
// a key whose .env line is empty or gone, so a reload produces what a fresh
// boot would. Values are secrets: never logged, persisted or reported.
let deploymentEnvBaseline = null;
const recordDeploymentEnvBaseline = (env) => {
  if (deploymentEnvBaseline) return;
  deploymentEnvBaseline = Object.freeze({ ...env });
};
const getDeploymentEnvBaseline = () => deploymentEnvBaseline;

// The values a .env file contributes, the one rule boot and reload share:
// entries apply in file order, an empty value contributes nothing (so
// "KEY=a" then "KEY=" leaves "a", and "KEY=" never hides the deployment's
// value), deployment-only keys never apply, and a deployment-wins key applies
// only when the recorded deployment environment does not set it. Keys must be
// normalized.
const resolveEnvFileOverlay = (entries) => {
  const overlay = new Map();
  for (const { key, value } of entries || []) {
    if (!key) continue;
    if (kDeploymentOnlyEnvKeys.includes(key)) {
      if (value) noteIgnoredDeploymentEnvKey(key);
      continue;
    }
    if (kDeploymentWinsEnvKeys.includes(key) && String(deploymentEnvBaseline?.[key] || "").trim() !== "") {
      if (value) noteDeploymentWinsEnvKey(key);
      continue;
    }
    if (value) overlay.set(key, value);
  }
  return overlay;
};

const warnedFileOnlyKeys = new Set();
const noteIgnoredDeploymentEnvKey = (key) => {
  if (
    !kDeploymentOnlyEnvKeys.includes(key) ||
    String(process.env[key] || "").trim() !== "" ||
    warnedFileOnlyKeys.has(key)
  ) return;
  warnedFileOnlyKeys.add(key);
  console.warn(
    `[alphaclaw] Ignoring deployment-only setting ${key} in .env. Configure ${key} in the deployment environment instead; file values are not migrated.`,
  );
};

const notedDeploymentWinsKeys = new Set();
const noteDeploymentWinsEnvKey = (key) => {
  if (notedDeploymentWinsKeys.has(key)) return;
  notedDeploymentWinsKeys.add(key);
  console.warn(
    `[alphaclaw] Ignoring ${key} in .env: the deployment environment sets it, and the deployment value wins.`,
  );
};

module.exports = {
  kBootManagedEnvKeys,
  kDeploymentSecretEnvKeys,
  kDeploymentWinsEnvKeys,
  getDeploymentEnvBaseline,
  recordDeploymentEnvBaseline,
  resolveEnvFileOverlay,
  kDeploymentOnlyEnvKeys,
  kExplicitOriginEnvKeys,
  noteIgnoredDeploymentEnvKey,
};
