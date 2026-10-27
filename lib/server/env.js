const fs = require("fs");
const { ENV_FILE_PATH, kKnownVars } = require("./constants");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");
const {
  kBootManagedEnvKeys,
  getDeploymentEnvBaseline,
  resolveEnvFileOverlay,
} = require("./deployment-only-env");
const { stripLineBreaks, normalizeEnvKey } = require("./utils/env-values");

const kEnvWatchDebounceMs = 250;
let envWatchDebounceTimer = null;
let lastLoadedEnvSignature = null;
let pendingSelfWriteSignature = null;

// One entry per key, at its last position. Its value is the one boot and
// reload apply (resolveEnvFileOverlay): the last non-empty value, so Envars
// shows the live value of "KEY=a" then "KEY=" and the next save keeps it.
const normalizeEnvVars = (vars) => {
  const byKey = new Map();
  for (const entry of vars || []) {
    const key = normalizeEnvKey(entry?.key || "");
    if (!key) continue;
    const value = stripLineBreaks(entry?.value || "");
    const earlier = byKey.get(key);
    byKey.delete(key);
    byKey.set(key, { key, value: value || earlier?.value || "" });
  }
  return Array.from(byKey.values());
};

// Every line in file order, duplicates included: the effective value of a
// duplicated key is its last non-empty line (resolveEnvFileOverlay), so a
// signature that collapsed duplicates would miss an edit to that line.
// Deployment-only keys are left out because a reload never applies them.
const buildEnvSignature = (vars) =>
  JSON.stringify(
    (vars || [])
      .map((entry) => [normalizeEnvKey(entry?.key || ""), stripLineBreaks(entry?.value || "")])
      .filter(([key]) => key && !kDeploymentOnlyEnvKeys.has(key)),
  );

const readRawEnvFile = () => {
  const content = fs.readFileSync(ENV_FILE_PATH, "utf8");
  const vars = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    vars.push({
      key: trimmed.slice(0, eqIdx).trim(),
      value: trimmed.slice(eqIdx + 1),
    });
  }
  return vars;
};

const readEnvFile = () => {
  try {
    return normalizeEnvVars(readRawEnvFile());
  } catch {
    return [];
  }
};

// Strict variant for secret-redaction sources: a legitimately-absent file is
// empty, but a real read failure (EACCES/EIO) THROWS so the caller can fail
// closed instead of proceeding with an incomplete secret list.
const readEnvFileStrict = () => {
  try {
    return normalizeEnvVars(readRawEnvFile());
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};

// Atomic (temp+rename): a reader — including the fs.watchFile watcher's
// signature check — never observes a torn .env. The self-write signature is
// recorded exactly as before so the watcher still suppresses our own writes.
const writeEnvFile = (vars) => {
  const lines = [];
  const normalizedVars = normalizeEnvVars(vars);
  for (const { key, value } of normalizedVars) {
    lines.push(`${key}=${String(value || "")}`);
  }
  // Secret-bearing: 0600 on a fresh inode (umask-default 0644 leaked API keys
  // to every same-host reader).
  writeFileAtomic(ENV_FILE_PATH, lines.join("\n"), { mode: 0o600 });
  pendingSelfWriteSignature = buildEnvSignature(normalizedVars);
};

// Locked read-modify-write for concurrent writers (UI route vs agent-admin
// API vs CLI). Atomic writes alone prevent torn files, not lost updates —
// two unserialized read-modify-write cycles still clobber each other.
const updateEnvFile = (mutator) =>
  withFileLockSync(ENV_FILE_PATH, () => {
    const current = readEnvFile();
    const next = normalizeEnvVars(mutator(current) ?? current);
    writeEnvFile(next);
    return next;
  });

// Deployment-only keys are never applied from the (agent-writable) .env, at
// boot or at runtime. The shared list lives in ./deployment-only-env so this
// runtime reloadEnv skip and the boot skip in bin/alphaclaw.js can never
// drift apart.
const kDeploymentOnlyEnvKeys = new Set(
  require("./deployment-only-env").kDeploymentOnlyEnvKeys,
);
const kReloadSkippedKeys = new Set([...kDeploymentOnlyEnvKeys, ...kBootManagedEnvKeys]);

const readRawEnvEntries = () => {
  try {
    return readRawEnvFile().map(({ key, value }) => ({
      key: normalizeEnvKey(key),
      value: stripLineBreaks(value),
    }));
  } catch {
    return [];
  }
};

// A reload makes process.env what a fresh boot would make it: the deployment
// environment recorded at boot, overlaid with the .env file's non-empty values
// (resolveEnvFileOverlay, the rule bin/alphaclaw.js uses). A key whose .env
// line is empty or gone falls back to its deployment value, and is removed
// only when the deployment never set it. Without a recorded baseline (a
// caller that did not boot through bin) an empty or missing key is removed.
// Deployment-only and boot-managed keys are never touched.
const reloadEnv = () => {
  const entries = readRawEnvEntries();
  const overlay = resolveEnvFileOverlay(entries);
  const baseline = getDeploymentEnvBaseline();
  const signature = buildEnvSignature(entries);
  // Key names only, never values: whatever a key is called, its value may be
  // a credential (a database URL with an embedded password, for one).
  const added = [];
  const updated = [];
  const restored = [];
  const removed = [];

  const keys = new Set([...entries.map(({ key }) => key), ...kKnownVars.map((v) => v.key)]);
  for (const key of keys) {
    if (!key || kReloadSkippedKeys.has(key)) continue;
    const current = process.env[key];
    const fromFile = overlay.get(key);
    const fromDeployment = baseline?.[key] || undefined;
    const target = fromFile ?? fromDeployment;
    if (target === undefined) {
      if (current) {
        removed.push(key);
        delete process.env[key];
      }
      continue;
    }
    if (target === current) continue;
    if (fromFile === undefined) restored.push(key);
    else (current ? updated : added).push(key);
    process.env[key] = target;
  }

  const changes = [
    ["added", added],
    ["changed", updated],
    ["restored from deployment env", restored],
    ["removed", removed],
  ].filter(([, keys]) => keys.length);
  if (changes.length) {
    console.log(
      `[alphaclaw] Env updated: ${changes.map(([label, keys]) => `${label} ${keys.join(", ")}`).join("; ")}`,
    );
  }

  lastLoadedEnvSignature = signature;
  return changes.length > 0;
};

const readEnvFileSignature = () => {
  try {
    return buildEnvSignature(readRawEnvFile());
  } catch {
    return null;
  }
};

const startEnvWatcher = () => {
  try {
    fs.watchFile(ENV_FILE_PATH, { interval: 2000 }, () => {
      if (envWatchDebounceTimer) clearTimeout(envWatchDebounceTimer);
      envWatchDebounceTimer = setTimeout(() => {
        envWatchDebounceTimer = null;
        const signature = readEnvFileSignature();
        if (signature && signature === pendingSelfWriteSignature) {
          pendingSelfWriteSignature = null;
          lastLoadedEnvSignature = signature;
          return;
        }
        pendingSelfWriteSignature = null;
        if (signature && signature === lastLoadedEnvSignature) return;
        console.log(
          `[alphaclaw] ${ENV_FILE_PATH} changed externally, reloading...`,
        );
        reloadEnv();
      }, kEnvWatchDebounceMs);
    });
  } catch {}
};

module.exports = {
  normalizeEnvVars,
  normalizeEnvKey,
  readEnvFile,
  readEnvFileStrict,
  writeEnvFile,
  updateEnvFile,
  reloadEnv,
  startEnvWatcher,
};
