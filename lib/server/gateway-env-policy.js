// The single decision point for what environment reaches an OpenClaw child
// process (the gateway daemon and every short-lived `openclaw` CLI spawn).
//
// Before this, gatewayEnv() spread the ENTIRE process.env into the child, so
// the deployed agent inherited SETUP_PASSWORD, webhook secrets, platform
// deploy tokens, and every AlphaClaw-internal credential — making the
// agent-admin tier system "not a security boundary against the agent"
// (TODOS P1). filterGatewayChildEnv keeps an explicit allowlist and strips
// everything else, with an ABSOLUTE deny list that wins over every allow
// source (including the passthrough hatch), so a config or .env edit can
// never re-grant a denied secret.
//
// Residual, documented: this closes ENV inheritance only. The child still
// runs as the same UID with HOME=kRootDir, so it can read kRootDir/.env from
// disk if exec is unsandboxed — a separate, filesystem-level concern, not a
// claim this function makes.

const { kKnownVars } = require("./constants");

// Absolute deny — stripped no matter what any allow rule or hatch says.
// These are AlphaClaw-ADMIN / operator credentials the agent must never hold;
// they are NOT things the OpenClaw gateway resolves from its own config.
// (WEBHOOK_TOKEN is deliberately NOT here: the gateway resolves
// hooks.token="${WEBHOOK_TOKEN}" from this child env, so denying it would
// break — and could fail OPEN — all webhook/Gmail-push ingress. It is the
// gateway's own operational token, not an admin credential.)
const kGatewayEnvDenyKeys = new Set([
  "SETUP_PASSWORD",
  "GOG_KEYRING_PASSWORD",
  // Platform deploy credentials that the container runtime injects.
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "VERCEL_TOKEN",
  "NPM_TOKEN",
  // The filter's own controls never travel to the child.
  "ALPHACLAW_GATEWAY_ENV_PASSTHROUGH",
  "ALPHACLAW_GATEWAY_ENV_UNRESTRICTED",
]);

const kDenyPrefixes = [
  // AlphaClaw-internal controls/secrets — EXCEPT ALPHACLAW_ROOT_DIR (the one
  // literal the child needs, allowlisted below). Everything else stays
  // server-side.
  "ALPHACLAW_",
  // The Claude Code launcher config lets its holder start autonomous, billable
  // cloud runs on the operator's personal account — the agent must never see
  // any of it. Denied by PREFIX so a NEW launcher key added to kKnownVars can
  // never silently leak (kKnownVars would otherwise allowlist it).
  "CLAUDE_CODE_ROUTINE_",
  "CLAUDE_CODE_LOCAL_",
  // npm registry AUTH (not the harmless registry/proxy/cache knobs the
  // npm_config_ allow-prefix admits). NPM_TOKEN is denied above; these are the
  // dotted forms npm writes into the environment.
  "npm_config__auth",
  "npm_config_//",
];

// Provider/config keys the agent genuinely needs to run models + channels.
// kKnownVars includes the launcher keys, but those are denied by prefix above
// and deny wins, so they never leak through this set.
const kKnownAllowKeys = new Set(kKnownVars.map((v) => v.key));

// Operational integration keys the OpenClaw gateway resolves from its own
// openclaw.json (${VAR} refs) that are not in kKnownVars and match no pattern.
// Withholding these silently breaks the integration (found by adversarial
// review): webhooks/Gmail-push (WEBHOOK_TOKEN), managed remote MCP
// (REMOTE_MCP_API_TOKEN, a _API_TOKEN not _API_KEY), Mattermost, Google Chat,
// and non-default model backends (base URLs / auth tokens). Anything NOT here
// and needed is recoverable via ALPHACLAW_GATEWAY_ENV_PASSTHROUGH.
const kOperationalAllowKeys = new Set([
  "WEBHOOK_TOKEN",
  "REMOTE_MCP_API_TOKEN",
  "MATTERMOST_BOT_TOKEN",
  "MATTERMOST_URL",
  "GOOGLE_CHAT_SERVICE_ACCOUNT",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL",
]);

// Literal system + OpenClaw + agent-tooling keys the child needs to function.
const kAllowLiterals = new Set([
  // Set explicitly by gatewayEnv / withOpenclawStartupEnv.
  "HOME",
  "NODE_COMPILE_CACHE",
  "NODE_OPTIONS",
  "UV_THREADPOOL_SIZE",
  // System basics.
  "PATH",
  "HOSTNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "LANGUAGE",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "DEBUG",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_NO_WARNINGS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "BROWSER_EXECUTABLE_PATH",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "HOMEBREW_PREFIX",
  "COREPACK_ENABLE_STRICT",
  // Agent-tooling: `alphaclaw admin` inside the agent shell resolves the
  // server via PORT and the root dir via ALPHACLAW_ROOT_DIR. ALPHACLAW_ROOT_DIR
  // is the one ALPHACLAW_ key that crosses the boundary (deny-prefix exception).
  "PORT",
  "ALPHACLAW_ROOT_DIR",
]);

const kAllowPrefixes = [
  "OPENCLAW_", // OPENCLAW_HOME/STATE_DIR/CONFIG_PATH/GATEWAY_*/SUPERVISOR_MODE/…
  "XDG_",
  "LC_",
  "SSH_",
  "npm_config_", // dev-channel builds (auth forms are denied above)
  // Cloud model backends the agent may run (Bedrock/Vertex/Azure).
  "AWS_",
  "VERTEX_",
  "GOOGLE_VERTEX_",
  "AZURE_",
];

// Provider secrets follow *_API_KEY or *_AUTH_TOKEN (exotic providers not in
// kKnownVars). Deny still wins, so RAILWAY_API_TOKEN etc. can't ride this in.
const kAllowKeyPattern = /(_API_KEY|_AUTH_TOKEN)$/;

// Snapshot the escape-hatch controls ONCE at module load. The agent-writable
// .env can NEVER supply them: the boot loader (bin/alphaclaw.js) and runtime
// reloadEnv (env.js) both skip these two keys, so process.env only ever holds
// them from the real deployment environment. The snapshot then freezes that
// value and never re-reads process.env.
const kBootHatchSnapshot = {
  passthrough: String(process.env.ALPHACLAW_GATEWAY_ENV_PASSTHROUGH || ""),
  unrestricted: /^(1|true|yes)$/i.test(
    String(process.env.ALPHACLAW_GATEWAY_ENV_UNRESTRICTED || "").trim(),
  ),
};

const parseGatewayEnvPassthrough = (raw) =>
  String(raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

// De-dupe the drop-log so a per-spawn filter doesn't spam identical lines.
let lastDroppedSignature = null;

const filterGatewayChildEnv = (
  env,
  { logger = console, hatch = kBootHatchSnapshot } = {},
) => {
  const source = env && typeof env === "object" ? env : {};
  const passthroughGlobs = parseGatewayEnvPassthrough(hatch.passthrough);
  const out = {};
  const dropped = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // Absolute deny wins over every allow source and the hatch.
    if (kGatewayEnvDenyKeys.has(key) || kDenyPrefixes.some((p) => key.startsWith(p))) {
      // ALPHACLAW_ROOT_DIR is the documented deny-prefix exception.
      if (key !== "ALPHACLAW_ROOT_DIR") {
        dropped.push(key);
        continue;
      }
    }
    if (hatch.unrestricted) {
      out[key] = value; // break-glass: legacy spread minus the absolute deny
      continue;
    }
    if (
      kAllowLiterals.has(key) ||
      kKnownAllowKeys.has(key) ||
      kOperationalAllowKeys.has(key) ||
      kAllowKeyPattern.test(key) ||
      kAllowPrefixes.some((p) => key.startsWith(p)) ||
      passthroughGlobs.some((g) => (g.endsWith("*") ? key.startsWith(g.slice(0, -1)) : g === key))
    ) {
      out[key] = value;
      continue;
    }
    dropped.push(key);
  }

  if (dropped.length) {
    const signature = dropped.slice().sort().join(",");
    if (signature !== lastDroppedSignature) {
      lastDroppedSignature = signature;
      logger.log?.(
        `[alphaclaw] gateway env: withheld ${dropped.length} non-allowlisted key(s) from the OpenClaw child: ${dropped
          .slice()
          .sort()
          .join(", ")}. If one is genuinely needed, add it to ALPHACLAW_GATEWAY_ENV_PASSTHROUGH (deployment env).`,
      );
    }
  }
  return out;
};

const resetGatewayEnvPolicyForTests = () => {
  lastDroppedSignature = null;
};

module.exports = {
  filterGatewayChildEnv,
  kGatewayEnvDenyKeys,
  parseGatewayEnvPassthrough,
  resetGatewayEnvPolicyForTests,
};
