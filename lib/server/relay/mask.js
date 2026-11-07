const fs = require("fs");
const path = require("path");
const { collectSecretValues, redactSecretText, redactSecrets } = require("../utils/redact");
const { parseEnvFileContent } = require("../utils/env-file-format");
const { readOpenclawConfig } = require("../openclaw-config");
const { relayPaths } = require("./constants");
const { readInternalSecret, readRelaySecrets } = require("./provision");

// Text that leaves the box over the relay (the bridge's replies and the box
// agent's own relay_send / relay_reply) is masked first, against the same
// secret set the other off-box paths use: secret-named env values, every
// .env value, the credentials in openclaw.json, and the relay's own
// workspace key, agent tokens and internal secret. Read on every call, so a
// rotated value is masked without a restart. Everything derives from the
// AlphaClaw root, which the box agent's stdio server gets as dirname(relay dir).
const readEnvFileVars = (rootDir, fsModule) => {
  try {
    return parseEnvFileContent(fsModule.readFileSync(path.join(rootDir, ".env"), "utf8"));
  } catch {
    return [];
  }
};

// Public values are never masked in relay text: the product names, one of
// which is GOG_KEYRING_PASSWORD's published default (bin/alphaclaw.js). They
// are in AlphaClaw's own source, so masking them protects nothing, and it
// turned every reply that mentioned the product into "***". Every other
// collected value is masked, a plain word included: a password like
// "bluemonkey" is still a secret.
const kPublicValues = new Set(["alphaclaw", "openclaw"]);
const isPublicValue = (value) => kPublicValues.has(String(value).trim().toLowerCase());

const collectRelaySecrets = ({ rootDir, env = process.env, fsModule = fs }) => {
  const paths = relayPaths(rootDir);
  const config = readOpenclawConfig({ fsModule, openclawDir: path.join(rootDir, ".openclaw"), fallback: null });
  const relay = readRelaySecrets(paths, fsModule);
  const relayValues = [relay?.workspaceKey, ...Object.values(relay?.agents || {}).map((agent) => agent?.token)];
  try {
    relayValues.push(readInternalSecret(paths, fsModule));
  } catch {}
  const values = collectSecretValues({
    env,
    envFileVars: [...readEnvFileVars(rootDir, fsModule), ...relayValues.map((value) => ({ value }))],
    configObjects: config && typeof config === "object" ? [config] : [],
  });
  return new Set([...values].filter((value) => !isPublicValue(value)));
};

const createRelayMasker = ({ rootDir, env = process.env, fsModule = fs }) => (text) =>
  redactSecretText(redactSecrets(String(text ?? ""), { secrets: collectRelaySecrets({ rootDir, env, fsModule }) }));

module.exports = { createRelayMasker, collectRelaySecrets };
