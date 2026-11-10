const { kRelayDefaultPort, kRelayDefaultAgentName } = require("./constants");

// Relay settings. Every key is deployment environment only (registered in
// deployment-only-env.js): from the agent-writable .env the deployed agent
// could switch its own audit trail off, lift its rate caps or shorten the
// retention of messages it was sent.
const kRelayEnvKeys = Object.freeze({
  enabled: "ALPHACLAW_RELAY",
  retentionDays: "ALPHACLAW_RELAY_RETENTION_DAYS",
  maxConcurrent: "ALPHACLAW_RELAY_MAX_CONCURRENT",
  hourlyCap: "ALPHACLAW_RELAY_HOURLY_CAP",
  port: "ALPHACLAW_RELAY_PORT",
  agentName: "ALPHACLAW_RELAY_AGENT_NAME",
  remote: "ALPHACLAW_RELAY_REMOTE",
  oauthRedirectUris: "ALPHACLAW_RELAY_OAUTH_REDIRECT_URIS",
  wakeHosts: "ALPHACLAW_RELAY_WAKE_HOSTS",
  maxBindingsPerClient: "ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT",
  brain: "ALPHACLAW_RELAY_BRAIN",
  brainBin: "ALPHACLAW_RELAY_BRAIN_BIN",
  brainPeerDailyMb: "ALPHACLAW_RELAY_BRAIN_PEER_DAILY_MB",
  brainPeerTotalMb: "ALPHACLAW_RELAY_BRAIN_PEER_TOTAL_MB",
  delegateAgents: "ALPHACLAW_RELAY_DELEGATE_AGENTS",
  delegateTools: "ALPHACLAW_RELAY_DELEGATE_TOOLS",
  capyOrg: "ALPHACLAW_RELAY_CAPY_ORG",
  capyAudience: "ALPHACLAW_RELAY_CAPY_AUDIENCE",
  narration: "ALPHACLAW_RELAY_NARRATION",
  capyOwners: "ALPHACLAW_RELAY_CAPY_OWNERS",
  trustedBindings: "ALPHACLAW_RELAY_TRUSTED_BINDINGS",
  trustedBindingsRequireAttestation: "ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION",
});
const kDefaultOauthRedirectUris = Object.freeze(["https://capy.ai/web/callbacks/mcp"]);
const kDefaultWakeHosts = Object.freeze(["api.capy.ai"]);
const kHostPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const listFromEnv = (raw) =>
  String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const httpsUrlsFromEnv = (raw) =>
  listFromEnv(raw).filter((entry) => {
    try {
      const url = new URL(entry);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.href === entry;
    } catch {
      return false;
    }
  });
const kAgentNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const kReservedAgentNames = new Set(["__proto__", "constructor", "prototype", "self", "all", "everyone"]);
const kOffValues = new Set(["0", "off", "false", "no", "disabled"]);
const kDelegateAgentPattern = /^capy-[a-z0-9-]{1,43}$/;
// Capy OIDC (PR3): the Capy organization whose issuer the box trusts, and
// the audience its Generic OIDC setup names. Both set, or attestation is off.
const kCapyOrgPattern = /^[A-Za-z0-9_-]{1,128}$/;
const kCapyAudiencePattern = /^[\x21-\x7e]{1,255}$/;
// The Capy user ids (the token's user claim, the thread's owner) whose
// attested threads act for the owner with no confirmations (GST-2323).
// Empty by default: no thread is trusted that far.
const kCapyOwnerPattern = /^[A-Za-z0-9_-]{1,128}$/;
// The capy-* relay agents (bindings) the owner pinned as trusted like their
// own threads (GST-2323 PR3): a pinned binding that is a live delegate acts
// for the owner with no confirmations, with no Capy attestation. Empty by
// default. A box uses this or the Capy owner allowlist above, not both,
// unless ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION is on: then
// owner trust needs both, a pinned binding whose message is Capy-attested
// for an owner on the list, and either alone is a plain delegate.
const kOnValues = new Set(["1", "on", "true", "yes", "enabled"]);
const kToolNamePattern = /^(?:[a-z0-9][a-z0-9_.-]{0,126}|[a-z0-9][a-z0-9_-]{0,60}__\*)$/;

// Delegate settings (GST-1982): the capy-* relay agents whose live bindings
// act for the owner (one per Capy thread, held by that thread's capability), and extra tool names a delegate turn may use. Entries that
// do not fit their pattern are dropped and counted, never guessed.
const splitChecked = (raw, pattern, normalize = (entry) => entry) => {
  const accepted = [];
  let rejected = 0;
  for (const entry of listFromEnv(raw).map(normalize)) {
    if (pattern.test(entry) && !kReservedAgentNames.has(entry)) accepted.push(entry);
    else rejected += 1;
  }
  return { accepted: [...new Set(accepted)], rejected };
};

const boundedInt = (raw, { min, max, fallback }) => {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Math.min(max, Math.max(min, value));
};

const isValidRelayAgentName = (name) =>
  typeof name === "string" && kAgentNamePattern.test(name) && !kReservedAgentNames.has(name);

const slugAgentName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const readRelayConfig = ({ env = process.env, defaultAgentLabel = "" } = {}) => {
  const enabledRaw = String(env[kRelayEnvKeys.enabled] ?? "").trim().toLowerCase();
  const requestedName = String(env[kRelayEnvKeys.agentName] ?? "").trim().toLowerCase();
  const labelName = slugAgentName(defaultAgentLabel);
  const agentName = isValidRelayAgentName(requestedName)
    ? requestedName
    : isValidRelayAgentName(labelName)
      ? labelName
      : kRelayDefaultAgentName;
  const brainBin = String(env[kRelayEnvKeys.brainBin] ?? "").trim();
  const delegateAgents = splitChecked(env[kRelayEnvKeys.delegateAgents], kDelegateAgentPattern, (entry) => entry.toLowerCase());
  const capyOrg = String(env[kRelayEnvKeys.capyOrg] ?? "").trim();
  const capyAudience = String(env[kRelayEnvKeys.capyAudience] ?? "").trim();
  const delegateTools = splitChecked(env[kRelayEnvKeys.delegateTools], kToolNamePattern, (entry) => entry.toLowerCase());
  const capyOwners = splitChecked(env[kRelayEnvKeys.capyOwners], kCapyOwnerPattern);
  const trustedBindings = splitChecked(env[kRelayEnvKeys.trustedBindings], kDelegateAgentPattern, (entry) => entry.toLowerCase());
  return {
    enabled: !kOffValues.has(enabledRaw),
    brainMode: kOffValues.has(String(env[kRelayEnvKeys.brain] ?? "").trim().toLowerCase()) ? "off" : "auto",
    brainBin: brainBin.startsWith("/") ? brainBin : "",
    brainBinRejected: Boolean(brainBin) && !brainBin.startsWith("/"),
    brainPeerDailyBytes: boundedInt(env[kRelayEnvKeys.brainPeerDailyMb], { min: 1, max: 10240, fallback: 8 }) * 1024 * 1024,
    brainPeerTotalBytes: boundedInt(env[kRelayEnvKeys.brainPeerTotalMb], { min: 1, max: 102400, fallback: 512 }) * 1024 * 1024,
    retentionDays: boundedInt(env[kRelayEnvKeys.retentionDays], { min: 0, max: 3650, fallback: 90 }),
    maxConcurrent: boundedInt(env[kRelayEnvKeys.maxConcurrent], { min: 1, max: 4, fallback: 2 }),
    hourlyCap: boundedInt(env[kRelayEnvKeys.hourlyCap], { min: 1, max: 1000, fallback: 30 }),
    maxBindingsPerClient: boundedInt(env[kRelayEnvKeys.maxBindingsPerClient], { min: 1, max: 1000, fallback: 20 }),
    port: boundedInt(env[kRelayEnvKeys.port], { min: 1024, max: 65535, fallback: kRelayDefaultPort }),
    agentName,
    agentNameFromEnv: isValidRelayAgentName(requestedName),
    agentNameRejected: Boolean(requestedName) && !isValidRelayAgentName(requestedName),
    delegateAgents: delegateAgents.accepted,
    delegateAgentsRejected: delegateAgents.rejected,
    delegateTools: delegateTools.accepted,
    delegateToolsRejected: delegateTools.rejected,
    capyOrg: kCapyOrgPattern.test(capyOrg) ? capyOrg : "",
    capyAudience: kCapyAudiencePattern.test(capyAudience) ? capyAudience : "",
    capyOwners: capyOwners.accepted,
    capyOwnersRejected: capyOwners.rejected,
    trustedBindings: trustedBindings.accepted,
    trustedBindingsRejected: trustedBindings.rejected,
    trustedBindingsRequireAttestation: kOnValues.has(String(env[kRelayEnvKeys.trustedBindingsRequireAttestation] ?? "").trim().toLowerCase()),
    remoteEnabled: !kOffValues.has(String(env[kRelayEnvKeys.remote] ?? "").trim().toLowerCase()),
    oauthRedirectUris: [...new Set([...kDefaultOauthRedirectUris, ...httpsUrlsFromEnv(env[kRelayEnvKeys.oauthRedirectUris])])],
    wakeHosts: [
      ...new Set([
        ...kDefaultWakeHosts,
        ...listFromEnv(env[kRelayEnvKeys.wakeHosts])
          .map((host) => host.toLowerCase())
          .filter((host) => kHostPattern.test(host)),
      ]),
    ],
  };
};

// Narration of relay asks to the owner (narration.js, GST-2304): on unless
// ALPHACLAW_RELAY_NARRATION is off, 0 or false (no and disabled too, like the
// other relay switches). Read at every narration pass, never cached.
const isRelayNarrationOn = (env = process.env) => !kOffValues.has(String(env[kRelayEnvKeys.narration] ?? "").trim().toLowerCase());

module.exports = { kRelayEnvKeys, readRelayConfig, isValidRelayAgentName, slugAgentName, isRelayNarrationOn };
