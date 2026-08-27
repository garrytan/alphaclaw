const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const { readOpenclawConfig } = require("./openclaw-config");

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
  const normalized = String(candidate || "").trim();
  if (!normalized) return "";
  const envMatch = normalized.match(kEnvRefPattern);
  if (!envMatch) return normalized;
  return String(env[envMatch[1]] || "").trim();
};

const isTrustedProxyAuthMode = (config) =>
  String(config?.gateway?.auth?.mode || "").trim() === "trusted-proxy";

// Returns { mode: "token" | "password", value }. `mode` is the credential
// mechanism internal clients must use, not the raw gateway.auth.mode:
// trusted-proxy gateways accept internal callers via the password fallback.
const getGatewayCredential = ({
  fsModule = fs,
  openclawDir = OPENCLAW_DIR,
  env = process.env,
} = {}) => {
  const config = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
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
    const config = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
    if (!isTrustedProxyAuthMode(config)) return env;
    const credential = getGatewayCredential({ fsModule, openclawDir, env });
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
