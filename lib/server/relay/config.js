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
  return {
    enabled: !kOffValues.has(enabledRaw),
    retentionDays: boundedInt(env[kRelayEnvKeys.retentionDays], { min: 0, max: 3650, fallback: 90 }),
    maxConcurrent: boundedInt(env[kRelayEnvKeys.maxConcurrent], { min: 1, max: 4, fallback: 2 }),
    hourlyCap: boundedInt(env[kRelayEnvKeys.hourlyCap], { min: 1, max: 1000, fallback: 30 }),
    port: boundedInt(env[kRelayEnvKeys.port], { min: 1024, max: 65535, fallback: kRelayDefaultPort }),
    agentName,
    agentNameFromEnv: isValidRelayAgentName(requestedName),
    agentNameRejected: Boolean(requestedName) && !isValidRelayAgentName(requestedName),
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

module.exports = { kRelayEnvKeys, readRelayConfig, isValidRelayAgentName, slugAgentName };
