// The gateway env's absolute deny (gateway-env-policy.js admitsGatewayEnvKey):
// keys no OpenClaw process may hold, whatever an allow rule or the hatch says.
// Its own module, with no requires, so the git credential helper script
// (lib/scripts/git-credential-alphaclaw.js) refuses exactly the same keys.

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
  "ALPHACLAW_GATEWAY_LOCKED_ENV",
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

// ALPHACLAW_ROOT_DIR is the documented deny-prefix exception.
const isDeniedGatewayEnvKey = (key) =>
  (kGatewayEnvDenyKeys.has(key) || kDenyPrefixes.some((p) => key.startsWith(p))) && key !== "ALPHACLAW_ROOT_DIR";

module.exports = { isDeniedGatewayEnvKey, kGatewayEnvDenyKeys };
