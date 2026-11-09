// Hook ingress policy (alphaclaw.json hooksIngress: builtins, and per-hook
// sender verification under hooks) and its secrets
// (<root>/hook-ingress/secrets.json, 0600: digests of AlphaClaw-minted tokens,
// and the signing secrets senders share with this box). Never in .env: the
// gateway loads AlphaClaw's .env itself, and the env APIs reach it. Both files
// are read strictly: an unreadable file refuses rather than falling back to
// defaults (fail closed).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readAlphaclawConfigForWrite, updateAlphaclawConfig } = require("../alphaclaw-config");
const { writeFileAtomic } = require("../utils/safe-file");
const { hashHookToken } = require("./verify");

const kBuiltinNames = Object.freeze(["agent", "wake"]);
const kBuiltinMigrationVersion = 1;
const kHooksPolicyVersion = 1;

const hookIngressSecretsPath = (rootDir) => path.join(rootDir, "hook-ingress", "secrets.json");

const readBuiltinsPolicy = ({ fsModule = fs, openclawDir }) => {
  let builtins;
  try {
    builtins = readAlphaclawConfigForWrite({ fsModule, openclawDir })?.hooksIngress?.builtins;
  } catch {
    return { unreadable: true, builtins: null };
  }
  return {
    unreadable: false,
    builtins: builtins && typeof builtins === "object" && !Array.isArray(builtins) ? builtins : null,
  };
};

const updateBuiltinsPolicy = ({ fsModule = fs, openclawDir, mutate }) => {
  let next = null;
  updateAlphaclawConfig({
    fsModule,
    openclawDir,
    strictRead: true,
    mutate: (cfg) => {
      const hooksIngress =
        cfg.hooksIngress && typeof cfg.hooksIngress === "object" && !Array.isArray(cfg.hooksIngress)
          ? cfg.hooksIngress
          : {};
      const current =
        hooksIngress.builtins && typeof hooksIngress.builtins === "object" ? hooksIngress.builtins : {};
      next = mutate(structuredClone(current));
      return { ...cfg, hooksIngress: { ...hooksIngress, builtins: next } };
    },
  });
  return next;
};

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Per-hook sender policy: { unreadable, version, hooks }. No defaults: a hook
// with no entry is decided by the caller (fail closed when a secret exists).
const readHooksPolicy = ({ fsModule = fs, openclawDir }) => {
  let hooksIngress;
  try {
    hooksIngress = readAlphaclawConfigForWrite({ fsModule, openclawDir })?.hooksIngress;
  } catch {
    return { unreadable: true, version: 0, hooks: null };
  }
  if (hooksIngress != null && !isPlainObject(hooksIngress)) return { unreadable: true, version: 0, hooks: null };
  const hooks = hooksIngress?.hooks;
  if (hooks != null && !isPlainObject(hooks)) return { unreadable: true, version: 0, hooks: null };
  return { unreadable: false, version: Number(hooksIngress?.version || 0), hooks: hooks || {} };
};

// One config-writer transaction over hooksIngress.{version,hooks}; mutate gets
// a clone of { version, hooks } and returns the next one.
const updateHooksPolicy = ({ fsModule = fs, openclawDir, mutate }) => {
  let next = null;
  updateAlphaclawConfig({
    fsModule,
    openclawDir,
    strictRead: true,
    mutate: (cfg) => {
      const hooksIngress = isPlainObject(cfg.hooksIngress) ? cfg.hooksIngress : {};
      const current = {
        version: Number(hooksIngress.version || 0),
        hooks: isPlainObject(hooksIngress.hooks) ? hooksIngress.hooks : {},
      };
      next = mutate(structuredClone(current));
      return { ...cfg, hooksIngress: { ...hooksIngress, version: next.version, hooks: next.hooks } };
    },
  });
  return next;
};

const readSecrets = ({ fsModule = fs, rootDir }) => {
  const filePath = hookIngressSecretsPath(rootDir);
  try {
    if (!fsModule.existsSync(filePath)) return { unreadable: false, missing: true, secrets: { version: 1, builtins: {}, hooks: {} } };
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    if (!isPlainObject(parsed)) throw new Error("not an object");
    return {
      unreadable: false,
      missing: false,
      secrets: {
        version: 1,
        ...parsed,
        builtins: isPlainObject(parsed.builtins) ? parsed.builtins : {},
        hooks: isPlainObject(parsed.hooks) ? parsed.hooks : {},
      },
    };
  } catch {
    return { unreadable: true, missing: false, secrets: null };
  }
};

const writeSecrets = ({ fsModule = fs, rootDir, secrets }) => {
  writeFileAtomic(hookIngressSecretsPath(rootDir), JSON.stringify(secrets, null, 2) + "\n", { fsModule, mode: 0o600 });
  try {
    fsModule.chmodSync(hookIngressSecretsPath(rootDir), 0o600);
  } catch {}
};

const secretsUnreadableError = () =>
  Object.assign(new Error("hook-ingress secrets file is unreadable"), { code: "SECRETS_UNREADABLE", status: 503 });

// Replaces a hook's secret entry (or removes it when entry is null) and
// returns the new generation. The generation only grows, so a policy naming an
// older generation is detected as a mismatch.
const setHookSecret = ({ fsModule = fs, rootDir, name, entry }) => {
  const read = readSecrets({ fsModule, rootDir });
  if (read.unreadable) throw secretsUnreadableError();
  const secrets = read.secrets;
  const previous = secrets.hooks[name];
  const generation = Number(previous?.generation || 0) + 1;
  const hooks = { ...secrets.hooks };
  if (entry) hooks[name] = { ...entry, generation };
  else delete hooks[name];
  writeSecrets({ fsModule, rootDir, secrets: { ...secrets, hooks } });
  return entry ? generation : 0;
};

// Mints a new own token for a built-in and returns it once. Only the digest is
// stored; a lost token is replaced by minting again.
const mintBuiltinToken = ({ fsModule = fs, rootDir, name, nowIso }) => {
  const read = readSecrets({ fsModule, rootDir });
  if (read.unreadable) throw Object.assign(new Error("hook-ingress secrets file is unreadable"), { code: "SECRETS_UNREADABLE" });
  const token = crypto.randomBytes(32).toString("base64url");
  const secrets = read.secrets;
  secrets.builtins = { ...secrets.builtins, [name]: { tokenSha256: hashHookToken(token), createdAt: nowIso } };
  writeSecrets({ fsModule, rootDir, secrets });
  return token;
};

module.exports = {
  kBuiltinMigrationVersion,
  kBuiltinNames,
  kHooksPolicyVersion,
  hookIngressSecretsPath,
  mintBuiltinToken,
  readBuiltinsPolicy,
  readHooksPolicy,
  readSecrets,
  setHookSecret,
  updateBuiltinsPolicy,
  updateHooksPolicy,
};
