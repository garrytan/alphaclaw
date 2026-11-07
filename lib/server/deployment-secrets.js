// Deployment-only secrets (SETUP_PASSWORD, platform deploy tokens, ...) never
// stay in an environment block. The agent's exec runs as AlphaClaw's uid, and
// /proc/<pid>/environ needs only same-uid read access, so a value that was in
// the environment AlphaClaw (or any child it spawned with process.env) was
// exec'd with is readable by the agent for the life of that process (CSO
// ALPH-71 M-1). Deleting it from process.env does not help: environ is the
// exec-time block, not the live map.
//
// So bin/alphaclaw.js moves these keys out of process.env into this module,
// writes them to a 0600 handoff file in a fresh 0700 temp dir, and re-execs
// itself (process.execve, same pid) with an environment that carries only the
// handoff path. The new image reads the file once, deletes it and keeps the
// values here; every reader asks getDeploymentSecret. A self-update respawn
// writes a fresh handoff the same way.
//
// Residual, documented in README and docs/designs/agent-admin.md: the agent
// still runs as the same uid, so it can read the .env file, AlphaClaw's memory
// where ptrace is allowed, the handoff file in the milliseconds before it is
// consumed, a container init that received the values (PID 1 on a template
// image that does not use AlphaClaw's entrypoint), and children that need a
// value by design (gog runs with GOG_KEYRING_PASSWORD).
//
// Requires only node built-ins and utils/timing-safe: bin loads it before
// anything else.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { timingSafeStringEqual } = require("./utils/timing-safe");

const kDeploymentSecretKeys = Object.freeze([
  "SETUP_PASSWORD",
  "GOG_KEYRING_PASSWORD",
  "ALPHACLAW_MANAGED_UPDATE_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_API_TOKEN",
  "VERCEL_TOKEN",
  "NPM_TOKEN",
]);
const kDeploymentSecretsHandoffEnvKey = "ALPHACLAW_DEPLOYMENT_SECRETS_FILE";
const kHandoffDirPrefix = "alphaclaw-secrets-";
const kHandoffFileName = "secrets.json";
// gog's keyring password at the value bin falls back to is AlphaClaw's own
// published default, not a secret (relay/mask.js skips it for the same reason).
const kGogKeyringDefaultPassword = "alphaclaw";

const secrets = new Map();

const hasOwn = (env, key) => Object.prototype.hasOwnProperty.call(env, key);

// Moves every deployment secret key out of env (normally process.env) into
// this module. Returns how many keys env held.
const captureDeploymentSecrets = (env) => {
  let held = 0;
  for (const key of kDeploymentSecretKeys) {
    if (!hasOwn(env, key)) continue;
    held += 1;
    const value = String(env[key] ?? "");
    delete env[key];
    if (value.trim()) secrets.set(key, value);
    else secrets.delete(key);
  }
  return held;
};

const getDeploymentSecret = (key, env = process.env) =>
  secrets.has(key) ? secrets.get(key) : String(env?.[key] ?? "");

// Values for the redaction collectors (utils/redact.js collectSecretValues).
const deploymentSecretValues = () =>
  [...secrets]
    .filter(([key, value]) => !(key === "GOG_KEYRING_PASSWORD" && timingSafeStringEqual(value, kGogKeyringDefaultPassword)))
    .map(([, value]) => value);

const writeDeploymentSecretsHandoff = ({ values = secrets, fsModule = fs, tmpDir = os.tmpdir() } = {}) => {
  const dir = fsModule.mkdtempSync(path.join(tmpDir, kHandoffDirPrefix));
  const filePath = path.join(dir, kHandoffFileName);
  fsModule.writeFileSync(filePath, JSON.stringify(Object.fromEntries(values)), { mode: 0o600, flag: "wx" });
  return filePath;
};

const removeHandoff = (filePath, fsModule = fs) => {
  try {
    fsModule.unlinkSync(filePath);
  } catch {}
  try {
    fsModule.rmdirSync(path.dirname(filePath));
  } catch {}
};

const isHandoffPath = (filePath) =>
  path.isAbsolute(filePath) &&
  path.basename(filePath) === kHandoffFileName &&
  path.basename(path.dirname(filePath)).startsWith(kHandoffDirPrefix);

// The env a child AlphaClaw boots with: env minus the secrets, plus a fresh
// handoff holding this module's values (and any env still carried). When the
// handoff cannot be written the child gets the values inline and re-execs
// itself without them.
const withDeploymentSecretsHandoff = (env, { fsModule = fs, tmpDir } = {}) => {
  const childEnv = { ...env };
  const values = new Map(secrets);
  for (const key of kDeploymentSecretKeys) {
    const carried = String(childEnv[key] ?? "");
    if (carried.trim() && !values.has(key)) values.set(key, carried);
    delete childEnv[key];
  }
  delete childEnv[kDeploymentSecretsHandoffEnvKey];
  if (values.size === 0) return childEnv;
  try {
    childEnv[kDeploymentSecretsHandoffEnvKey] = writeDeploymentSecretsHandoff({ values, fsModule, tmpDir });
  } catch {
    Object.assign(childEnv, Object.fromEntries(values));
  }
  return childEnv;
};

// Reads and deletes the handoff named in env, then drops the variable.
const consumeDeploymentSecretsHandoff = (env, { fsModule = fs, logger = console } = {}) => {
  if (!hasOwn(env, kDeploymentSecretsHandoffEnvKey)) return false;
  const filePath = String(env[kDeploymentSecretsHandoffEnvKey] || "");
  delete env[kDeploymentSecretsHandoffEnvKey];
  if (!isHandoffPath(filePath)) {
    logger.warn?.(`[alphaclaw] Ignoring ${kDeploymentSecretsHandoffEnvKey}: not an AlphaClaw handoff path.`);
    return false;
  }
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    for (const key of kDeploymentSecretKeys) {
      if (typeof parsed?.[key] === "string" && parsed[key].trim()) secrets.set(key, parsed[key]);
    }
    return true;
  } catch (error) {
    logger.warn?.(`[alphaclaw] Could not read the deployment secrets handoff (${error?.code || "invalid"}).`);
    return false;
  } finally {
    removeHandoff(filePath, fsModule);
  }
};

// Re-execs this process without the deployment secrets in its environment
// when it was started with any. Returns only when it did not re-exec: nothing
// to scrub, or execve is unavailable or failed (then the values still leave
// process.env, so children are clean, and a warning names the residual).
const reexecWithoutDeploymentSecrets = ({
  env = process.env,
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv,
  execve = process.execve,
  fsModule = fs,
  tmpDir,
  logger = console,
} = {}) => {
  if (captureDeploymentSecrets(env) === 0) return false;
  const warn = (why) =>
    logger.warn?.(
      `[alphaclaw] Deployment secrets stay readable in this process's /proc environ: ${why}. Child processes do not inherit them.`,
    );
  if (typeof execve !== "function") {
    warn("process.execve is not available on this Node.js");
    return false;
  }
  if (secrets.size === 0) return false;
  let handoffPath;
  try {
    handoffPath = writeDeploymentSecretsHandoff({ fsModule, tmpDir });
  } catch (error) {
    warn(`the handoff file could not be written (${error?.code || "error"})`);
    return false;
  }
  try {
    execve.call(process, execPath, [execPath, ...execArgv, ...argv.slice(1)], {
      ...env,
      [kDeploymentSecretsHandoffEnvKey]: handoffPath,
    });
  } catch (error) {
    removeHandoff(handoffPath, fsModule);
    warn(`re-exec failed (${error?.code || "error"})`);
  }
  return false;
};

const resetDeploymentSecretsForTests = () => secrets.clear();

module.exports = {
  captureDeploymentSecrets,
  consumeDeploymentSecretsHandoff,
  deploymentSecretValues,
  getDeploymentSecret,
  kDeploymentSecretKeys,
  kDeploymentSecretsHandoffEnvKey,
  reexecWithoutDeploymentSecrets,
  resetDeploymentSecretsForTests,
  withDeploymentSecretsHandoff,
  writeDeploymentSecretsHandoff,
};
