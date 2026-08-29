const { kSystemVars, kKnownVars } = require("../constants");

// Env keys the /api/env editor and the agent-admin tier resolver must agree on.
// Single source of truth so the manifest tierResolver (env.js) classifies keys
// exactly as PUT /api/env treats them (system.js), preventing a mismatch where
// the resolver escalates on a key the route preserves/rejects server-side.

// Channel tokens are managed by the channel flows, not the raw env editor.
const kManagedChannelTokenPattern =
  /^(?:TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|WHATSAPP_OWNER_NUMBER)(?:_[A-Z0-9_]+)?$/;

// System vars plus keys reserved for other input surfaces — never editable via
// the generic env editor.
const kEnvVarsReservedForUserInput = new Set([
  "GITHUB_WORKSPACE_REPO",
  "GOG_KEYRING_PASSWORD",
  "ALPHACLAW_ROOT_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_CONFIG_PATH",
  "XDG_CONFIG_HOME",
]);

const kReservedUserEnvVarKeys = Array.from(
  new Set([...kSystemVars, ...kEnvVarsReservedForUserInput]),
);

// Keys the HUMAN Envars editor owns, but that the agent actor must not
// silently write: they reconfigure the Claude Code sidebar launcher, so an
// agent PUT /api/env that sets/rotates/clears one repoints the operator's
// one-click launcher at an agent-chosen routine + token — the operator's next
// click would then fire it. These stay human-editable (visibleInEnvars) but an
// agent change to them escalates env.update to a dangerous-tier operator
// confirm (see env.js tierResolver). Distinct from hidden vars (which are
// preserved server-side for everyone) because humans DO edit these.
const kAgentProtectedEnvKeys = new Set([
  "CLAUDE_CODE_ROUTINE_URL",
  "CLAUDE_CODE_ROUTINE_TOKEN",
]);

const isAgentProtectedEnvKey = (key) => kAgentProtectedEnvKeys.has(key);

const isManagedChannelTokenKey = (key) =>
  kManagedChannelTokenPattern.test(String(key || "").trim().toUpperCase());

const isReservedUserEnvVar = (key) =>
  kSystemVars.has(key) || kEnvVarsReservedForUserInput.has(key);

const isVisibleInEnvars = (def) => def?.visibleInEnvars !== false;

// Known vars that are deliberately hidden from the editor (e.g. ANTHROPIC_TOKEN)
// — the route preserves them on write, so the tier resolver must not treat
// clearing one as an agent action.
const kHiddenKnownVarKeys = new Set(
  kKnownVars.filter((def) => !isVisibleInEnvars(def)).map((def) => def.key),
);

// True when the agent's env editor can actually add/change/delete this key.
// A cleared reserved/managed/hidden key is preserved server-side regardless of
// the payload, so it must not drive tier escalation.
const isAgentEditableEnvKey = (key) =>
  !isReservedUserEnvVar(key) &&
  !isManagedChannelTokenKey(key) &&
  !kHiddenKnownVarKeys.has(key);

module.exports = {
  kManagedChannelTokenPattern,
  kEnvVarsReservedForUserInput,
  kReservedUserEnvVarKeys,
  kHiddenKnownVarKeys,
  kAgentProtectedEnvKeys,
  isManagedChannelTokenKey,
  isReservedUserEnvVar,
  isVisibleInEnvars,
  isAgentEditableEnvKey,
  isAgentProtectedEnvKey,
};
