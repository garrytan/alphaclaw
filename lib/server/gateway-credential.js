const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
} = require("./openclaw-config");

// Lazy gateway credential resolution.
//
// constants.js captures OPENCLAW_GATEWAY_TOKEN at module load, which breaks
// once team mode swaps the gateway to trusted-proxy auth: the gateway then
// rejects shared tokens outright ("mutually exclusive", trusted-proxy-auth.md)
// and internal same-host callers must use `gateway.auth.password` /
// OPENCLAW_GATEWAY_PASSWORD instead. This helper resolves the CURRENT auth
// mode + credential on every call so internal clients follow transitions.

const kEnvRefPattern = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

const resolveConfigSecret = (candidate, env) => {
  // Object SecretRef form: { source: "env", provider, id } (see
  // routes/system.js normalizeSecretValue). Naive String() would yield the
  // universally-guessable "[object Object]" — a real password if team-mode
  // migration then persists it. Resolve env-backed refs; refuse to treat any
  // other object as a literal secret.
  if (candidate && typeof candidate === "object") {
    if (
      String(candidate.source || "").toLowerCase() === "env" &&
      typeof candidate.id === "string"
    ) {
      return String(env[candidate.id] || "").trim();
    }
    return "";
  }
  const normalized = String(candidate || "").trim();
  if (!normalized) return "";
  const envMatch = normalized.match(kEnvRefPattern);
  if (!envMatch) return normalized;
  return String(env[envMatch[1]] || "").trim();
};

const isTrustedProxyAuthMode = (config) =>
  String(config?.gateway?.auth?.mode || "").trim() === "trusted-proxy";

// getGatewayCredential sits on hot paths (every /v1 bearer check, every
// gatewayEnv() subprocess spawn), so identical re-reads of openclaw.json are
// served from an mtime/size-keyed parsed copy — a stat per call instead of a
// full read+parse. Same pattern as openclaw-release-channel.js readState.
let configCache = null;

const readConfigCached = ({ fsModule, openclawDir }) => {
  let stat = null;
  try {
    stat = fsModule.statSync(resolveOpenclawConfigPath({ openclawDir }));
  } catch {
    // stat unavailable (mocked fs, exotic mounts): plain uncached read.
    configCache = null;
    return readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  }
  if (
    configCache &&
    configCache.openclawDir === openclawDir &&
    configCache.mtimeMs === stat.mtimeMs &&
    configCache.size === stat.size
  ) {
    return configCache.config;
  }
  const config = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  configCache = { openclawDir, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
};

// Returns { mode: "token" | "password", value }. `mode` is the credential
// mechanism internal clients must use, not the raw gateway.auth.mode:
// trusted-proxy gateways accept internal callers via the password fallback.
const getGatewayCredential = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
  // Callers that already parsed openclaw.json (applyGatewayAuthEnv) pass it
  // through so one gatewayEnv() call performs one config read, not two.
  config: providedConfig = null,
} = {}) => {
  const config =
    providedConfig || readConfigCached({ fsModule, openclawDir });
  const auth = config?.gateway?.auth || {};
  if (isTrustedProxyAuthMode(config) || String(auth.mode || "") === "password") {
    const value =
      String(env.OPENCLAW_GATEWAY_PASSWORD || "").trim() ||
      resolveConfigSecret(auth.password, env) ||
      // enableTeamMode derives the password from the previous shared token,
      // so the token env var still holds the right secret on hosts that only
      // configure OPENCLAW_GATEWAY_TOKEN.
      String(env.OPENCLAW_GATEWAY_TOKEN || "").trim();
    return { mode: "password", value };
  }
  const value =
    String(env.OPENCLAW_GATEWAY_TOKEN || "").trim() ||
    resolveConfigSecret(auth.token, env);
  return { mode: "token", value };
};

// Adjusts a child-process env for the current gateway auth mode. In
// trusted-proxy mode the gateway refuses to start when OPENCLAW_GATEWAY_TOKEN
// is set ("Mixed token configuration", trusted-proxy-auth.md), so the token is
// dropped and the derived password is provided instead — this also lets the
// openclaw CLI authenticate via the local-direct password fallback.
const applyGatewayAuthEnv = (
  env,
  { fsModule = fs, openclawDir = OPENCLAW_DIR } = {},
) => {
  try {
    const config = readConfigCached({ fsModule, openclawDir });
    if (!isTrustedProxyAuthMode(config)) return env;
    const credential = getGatewayCredential({ fsModule, openclawDir, env, config });
    delete env.OPENCLAW_GATEWAY_TOKEN;
    if (credential.value && !String(env.OPENCLAW_GATEWAY_PASSWORD || "").trim()) {
      env.OPENCLAW_GATEWAY_PASSWORD = credential.value;
    }
    return env;
  } catch {
    return env;
  }
};

module.exports = {
  applyGatewayAuthEnv,
  getGatewayCredential,
  isTrustedProxyAuthMode,
  resolveConfigSecret,
};
