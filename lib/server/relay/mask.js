const fs = require("fs");
const path = require("path");
const { collectSecretValues, redactCapabilityUrls, redactSecretText, redactSecrets } = require("../utils/redact");
const { parseEnvFileContent } = require("../utils/env-file-format");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { readOpenclawConfig } = require("../openclaw-config");
const { relayPaths, kRelayWithheldText } = require("./constants");
const { readInternalSecret, readRelaySecrets } = require("./provision");

// Text that leaves the box over the relay (the bridge's replies and the box
// agent's own relay_send / relay_reply) is masked first, against the same
// secret set the other off-box paths use: secret-named env values, every
// .env value, the credentials in openclaw.json, and the relay's own
// workspace key, agent tokens and internal secret, plus the remote side's
// binding tokens and wake URLs (remote.db), the agent-admin token and the
// auth-profile keys. Read on every call, so a rotated value is masked
// without a restart. Everything derives from the AlphaClaw root, which the
// box agent's stdio server gets as dirname(relay dir).
//
// Masking is defence in depth, not the boundary: the relay guard plugin is
// what keeps a relay session away from these files. An exact copy is
// redacted in place; a disguised copy (spaced out, split by zero-width
// characters, base64 at any byte alignment, URL-safe base64, hex) withholds
// the whole message, because a partial redaction of an encoding still leaks.
const readEnvFileVars = (rootDir, fsModule) => {
  try {
    return parseEnvFileContent(fsModule.readFileSync(path.join(rootDir, ".env"), "utf8"));
  } catch {
    return [];
  }
};

// GOG_KEYRING_PASSWORD left at its published default (bin/alphaclaw.js sets
// it to the product's name) is not a secret: it is in AlphaClaw's own source,
// and masking it turned every reply that mentioned the product into "***".
// Only that variable at that value is skipped. Every other collected value
// is masked, a plain word included: a password like "bluemonkey" is still a
// secret, and so is any other setting whose value happens to be "alphaclaw".
const kGogKeyringPasswordKey = "GOG_KEYRING_PASSWORD";
const kGogKeyringDefaultPassword = "alphaclaw";
const isKeyringDefault = (key, value) =>
  key === kGogKeyringPasswordKey && timingSafeStringEqual(String(value ?? ""), kGogKeyringDefaultPassword);

// The remote side's plaintext values: each binding's engine token and wake
// URL, and the URL's path segments on their own (the capability is in the
// path). No remote.db means no remote side yet.
const readRemoteValues = (paths, fsModule) => {
  if (!fsModule.existsSync(paths.remoteDb)) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(paths.remoteDb, { readOnly: true });
  try {
    const values = [];
    for (const row of db.prepare("SELECT agent_token, webhook_url FROM relay_bindings").all()) {
      values.push(row.agent_token, row.webhook_url);
      try {
        values.push(...new URL(String(row.webhook_url)).pathname.split("/").filter((segment) => segment.length >= 16));
      } catch {}
    }
    return values;
  } finally {
    db.close();
  }
};

const readFileValue = (file, fsModule) => {
  try {
    return fsModule.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

// Every credential-looking string in each agent's auth-profiles.json.
const kAuthProfileKeyPattern = /^(?:key|api[-_]?key|token|access|refresh|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password)$/i;
const readAuthProfileValues = (openclawDir, fsModule) => {
  const values = [];
  const walk = (value, key, depth) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (kAuthProfileKeyPattern.test(key)) values.push(value);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey, depth + 1);
  };
  let agents = [];
  try {
    agents = fsModule.readdirSync(path.join(openclawDir, "agents"));
  } catch {
    return values;
  }
  for (const agent of agents) {
    const raw = readFileValue(path.join(openclawDir, "agents", agent, "agent", "auth-profiles.json"), fsModule);
    if (!raw) continue;
    try {
      walk(JSON.parse(raw), "", 0);
    } catch {}
  }
  return values;
};

const collectRelaySecrets = ({ rootDir, env = process.env, fsModule = fs }) => {
  const paths = relayPaths(rootDir);
  const openclawDir = path.join(rootDir, ".openclaw");
  const config = readOpenclawConfig({ fsModule, openclawDir, fallback: null });
  const relay = readRelaySecrets(paths, fsModule);
  const relayValues = [relay?.workspaceKey, ...Object.values(relay?.agents || {}).map((agent) => agent?.token)];
  try {
    relayValues.push(readInternalSecret(paths, fsModule));
  } catch {}
  relayValues.push(...readRemoteValues(paths, fsModule));
  relayValues.push(readFileValue(path.join(openclawDir, ".alphaclaw", "agent-admin-token"), fsModule));
  relayValues.push(...readAuthProfileValues(openclawDir, fsModule));
  return collectSecretValues({
    env: Object.fromEntries(Object.entries(env).filter(([key, value]) => !isKeyringDefault(key, value))),
    envFileVars: [
      ...readEnvFileVars(rootDir, fsModule).filter((entry) => !isKeyringDefault(entry?.key, entry?.value)),
      ...relayValues.map((value) => ({ value })),
    ],
    configObjects: config && typeof config === "object" ? [config] : [],
  });
};

const kZeroWidthPattern = /[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
const kMinEncodedLength = 8;
const normalize = (text) => String(text).replace(kZeroWidthPattern, "").replace(/\s+/g, "");

// The base64 characters that depend only on the value's own bytes, for a
// value starting at each of the three byte offsets in a longer encoded run.
const base64Cores = (bytes) => {
  const cores = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const core = encoded.slice([0, 2, 3][offset], Math.floor((bytes.length + offset) / 3) * 4);
    if (core.length >= kMinEncodedLength) cores.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return cores;
};

// Whether text (already redacted for exact copies) still carries a
// collected value in a disguised form.
const carriesDisguisedSecret = (text, secrets) => {
  const flat = normalize(text);
  const flatLower = flat.toLowerCase();
  for (const secret of secrets) {
    const value = normalize(secret);
    if (value.length < 6) continue;
    if (flat.includes(value)) return true;
    if (value.length < kMinEncodedLength) continue;
    const bytes = Buffer.from(value, "utf8");
    if (flatLower.includes(bytes.toString("hex"))) return true;
    if (base64Cores(bytes).some((core) => flat.includes(core))) return true;
  }
  return false;
};

const createRelayMasker = ({ rootDir, env = process.env, fsModule = fs }) => (text) => {
  const secrets = collectRelaySecrets({ rootDir, env, fsModule });
  const redacted = redactSecrets(String(text ?? ""), { secrets });
  if (carriesDisguisedSecret(redacted, secrets)) return kRelayWithheldText;
  return redactSecretText(redactCapabilityUrls(redacted));
};

module.exports = { createRelayMasker, collectRelaySecrets, carriesDisguisedSecret };
