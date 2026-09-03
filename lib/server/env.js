const fs = require("fs");
const { ENV_FILE_PATH, kKnownVars } = require("./constants");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");

const kSensitiveEnvKeyPattern = /token|key|password/i;
const kEnvWatchDebounceMs = 250;
let envWatchDebounceTimer = null;
let lastLoadedEnvSignature = null;
let pendingSelfWriteSignature = null;

// Line breaks never survive into .env (issue #26 hardening): a value with an
// embedded newline injects arbitrary extra lines into a file two root-cron
// shell scripts parse — value smuggling at best, key smuggling at worst.
// Stripped (not rejected) so every writer stays non-throwing; all .env writes
// funnel through writeEnvFile/updateEnvFile below.
const stripLineBreaks = (value) =>
  String(value ?? "").replace(/[\r\n\u2028\u2029]/g, "");

// The single key-normalization the write path applies before persisting.
// Exported so the agent-admin tier resolver classifies the SAME canonical
// key the file will hold \u2014 otherwise a padded/linebroken protected key
// ("CLAUDE_CODE_ROUTINE_URL ") misses the raw-key Set check (base tier, no
// operator confirm) yet persists canonical, repointing the launcher.
const normalizeEnvKey = (key) => stripLineBreaks(key ?? "").trim();

const normalizeEnvVars = (vars) => {
  const byKey = new Map();
  for (const entry of vars || []) {
    const key = normalizeEnvKey(entry?.key || "");
    if (!key) continue;
    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, {
      key,
      value: stripLineBreaks(entry?.value || ""),
    });
  }
  return Array.from(byKey.values());
};

const buildEnvSignature = (vars) =>
  JSON.stringify(normalizeEnvVars(vars).map(({ key, value }) => [key, value]));

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
  writeFileAtomic(ENV_FILE_PATH, lines.join("\n"));
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

const reloadEnv = () => {
  const vars = readEnvFile().filter((v) => !kDeploymentOnlyEnvKeys.has(v.key));
  const signature = buildEnvSignature(vars);
  const fileKeys = new Set(vars.map((v) => v.key));
  let changed = false;

  for (const { key, value } of vars) {
    if (value && value !== process.env[key]) {
      console.log(
        `[alphaclaw] Env updated: ${key}=${kSensitiveEnvKeyPattern.test(key) ? "***" : value}`,
      );
      process.env[key] = value;
      changed = true;
    } else if (!value && process.env[key]) {
      console.log(`[alphaclaw] Env cleared: ${key}`);
      delete process.env[key];
      changed = true;
    }
  }

  const allKnownKeys = kKnownVars.map((v) => v.key);
  for (const key of allKnownKeys) {
    if (!fileKeys.has(key) && process.env[key]) {
      console.log(`[alphaclaw] Env removed: ${key}`);
      delete process.env[key];
      changed = true;
    }
  }

  lastLoadedEnvSignature = signature;
  return changed;
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
