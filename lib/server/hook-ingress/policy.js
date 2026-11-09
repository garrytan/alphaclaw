// Built-in hook policy (alphaclaw.json hooksIngress.builtins) and the
// AlphaClaw-minted per-hook tokens (<root>/hook-ingress/secrets.json, 0600,
// sha256 digests only). Both are read strictly: an unreadable file refuses
// the built-ins rather than falling back to defaults (fail closed).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readAlphaclawConfigForWrite, updateAlphaclawConfig } = require("../alphaclaw-config");
const { writeFileAtomic } = require("../utils/safe-file");
const { hashHookToken } = require("./verify");

const kBuiltinNames = Object.freeze(["agent", "wake"]);
const kBuiltinMigrationVersion = 1;

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

const readSecrets = ({ fsModule = fs, rootDir }) => {
  const filePath = hookIngressSecretsPath(rootDir);
  try {
    if (!fsModule.existsSync(filePath)) return { unreadable: false, secrets: { version: 1, builtins: {} } };
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return {
      unreadable: false,
      secrets: { version: 1, ...parsed, builtins: parsed.builtins && typeof parsed.builtins === "object" ? parsed.builtins : {} },
    };
  } catch {
    return { unreadable: true, secrets: null };
  }
};

// Mints a new own token for a built-in and returns it once. Only the digest is
// stored; a lost token is replaced by minting again.
const mintBuiltinToken = ({ fsModule = fs, rootDir, name, nowIso }) => {
  const read = readSecrets({ fsModule, rootDir });
  if (read.unreadable) throw Object.assign(new Error("hook-ingress secrets file is unreadable"), { code: "SECRETS_UNREADABLE" });
  const token = crypto.randomBytes(32).toString("base64url");
  const secrets = read.secrets;
  secrets.builtins = { ...secrets.builtins, [name]: { tokenSha256: hashHookToken(token), createdAt: nowIso } };
  writeFileAtomic(hookIngressSecretsPath(rootDir), JSON.stringify(secrets, null, 2) + "\n", { fsModule, mode: 0o600 });
  try {
    fsModule.chmodSync(hookIngressSecretsPath(rootDir), 0o600);
  } catch {}
  return token;
};

module.exports = {
  kBuiltinMigrationVersion,
  kBuiltinNames,
  hookIngressSecretsPath,
  mintBuiltinToken,
  readBuiltinsPolicy,
  readSecrets,
  updateBuiltinsPolicy,
};
