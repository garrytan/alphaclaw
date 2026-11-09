// Where a key saved to AlphaClaw's .env can be used. AlphaClaw and anything
// that reads the file see it at once. The gateway's environment is filtered
// (gateway-env-policy.js): an admitted key reaches it on the next restart; a
// withheld key still reaches the gateway process when OpenClaw loads its own
// <state dir>/.env at start, but only when that file is AlphaClaw's .env (the
// managed link) and the key is not one the filter blanks.
const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR, ENV_FILE_PATH } = require("./constants");
const { admitsGatewayEnvKey, isBlankedGatewayEnvKey } = require("./gateway-env-policy");

const stateDirEnvIsEnvFile = ({ openclawDir = OPENCLAW_DIR, envFilePath = ENV_FILE_PATH, fsModule = fs } = {}) => {
  try {
    return fsModule.realpathSync(path.join(openclawDir, ".env")) === fsModule.realpathSync(envFilePath);
  } catch {
    return false;
  }
};

// "gateway_env" | "next_gateway_start" | "never"
const classifyEnvKeyReach = (key, { stateDirEnvLinked = stateDirEnvIsEnvFile() } = {}) => {
  if (admitsGatewayEnvKey(key)) return "gateway_env";
  if (stateDirEnvLinked && !isBlankedGatewayEnvKey(key)) return "next_gateway_start";
  return "never";
};

module.exports = { classifyEnvKeyReach, stateDirEnvIsEnvFile };
