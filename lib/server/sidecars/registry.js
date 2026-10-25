// Operator sidecars: the commands an operator wants running next to the
// gateway on the same box (a memory guard, a tmux-hosted CLI server, a
// long-running daemon). The registry comes ONLY from the deployment
// environment (ALPHACLAW_SIDECARS, a JSON array): the deployed agent shares
// AlphaClaw's uid and can write anywhere under the AlphaClaw root and the
// OpenClaw state dir, including alphaclaw.json and .env, so a registry there
// would let it run any command at boot with AlphaClaw's privileges (the same
// reason ALPHACLAW_GATEWAY_PRELAUNCH_HOOK is deployment-only). Agents read the
// registry through GET /api/sidecars and never edit it.
//
// Entry shape (validated here; a bad entry is reported and skipped, the rest
// still run):
//   name                 slug, unique
//   command              argv array, no shell
//   type                 simple (default, stays in the foreground) |
//                        forking (command daemonizes and exits 0; `check`
//                        argv says whether it still runs, `stop` argv stops
//                        it) | oneshot (runs once, e.g. a post-boot task)
//   check, stop          argv arrays (forking: check required)
//   user                 name or uid to run as (AlphaClaw must be root)
//   cwd                  absolute directory
//   envFile              absolute KEY=VALUE file merged over the base env
//   env                  { KEY: value } merged last
//   envUnset             names removed after merging; a trailing * matches
//                        a prefix (ANTHROPIC_*)
//   inheritEnv           true: start from AlphaClaw's whole environment
//                        (secrets included); default: a minimal base
//   restart              always (default) | on-failure | never
//                        (oneshot defaults to never)
//   startAfter           gateway (default: first gateway ready) | boot
//   stopTimeoutSeconds   SIGTERM grace before SIGKILL (1-8, default 5)
//   checkIntervalSeconds forking check cadence (5-3600, default 30)
//   enabled              false keeps the entry listed but never started

const kSidecarsEnvKey = "ALPHACLAW_SIDECARS";
const kMaxSidecars = 16;
const kMaxArgs = 64;
const kMaxArgChars = 4096;
const kNamePattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const kEnvKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const kEnvUnsetPattern = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;
const kUserPattern = /^[a-z_][a-z0-9_-]{0,31}$/;
const kTypes = Object.freeze(["simple", "forking", "oneshot"]);
const kRestartPolicies = Object.freeze(["always", "on-failure", "never"]);
const kStartAfter = Object.freeze(["gateway", "boot"]);
const kStopTimeoutBounds = Object.freeze({ min: 1, max: 8, fallback: 5 });
const kCheckIntervalBounds = Object.freeze({ min: 5, max: 3600, fallback: 30 });
const kKnownKeys = new Set([
  "name",
  "command",
  "type",
  "check",
  "stop",
  "user",
  "cwd",
  "envFile",
  "env",
  "envUnset",
  "inheritEnv",
  "restart",
  "startAfter",
  "stopTimeoutSeconds",
  "checkIntervalSeconds",
  "enabled",
]);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const validateArgv = (value, field) => {
  if (!Array.isArray(value) || value.length === 0) {
    return `${field} must be a non-empty array of strings (argv, no shell)`;
  }
  if (value.length > kMaxArgs) return `${field} has more than ${kMaxArgs} arguments`;
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length > kMaxArgChars || arg.includes("\0")) {
      return `${field} must contain only strings of at most ${kMaxArgChars} characters`;
    }
  }
  if (!value[0].trim()) return `${field}[0] must name a program`;
  return null;
};

const boundedInteger = (value, bounds, field, errors) => {
  if (value === undefined) return bounds.fallback;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    errors.push(`${field} must be an integer from ${bounds.min} to ${bounds.max}`);
    return bounds.fallback;
  }
  return value;
};

const normalizeSidecarEntry = (raw) => {
  const errors = [];
  if (!isPlainObject(raw)) return { entry: null, errors: ["entry must be an object"] };
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!kNamePattern.test(name)) {
    errors.push("name must be a lowercase slug (a-z, 0-9, - and _, at most 48 characters)");
  }
  for (const key of Object.keys(raw)) {
    if (!kKnownKeys.has(key)) errors.push(`unknown field: ${key}`);
  }
  const commandError = validateArgv(raw.command, "command");
  if (commandError) errors.push(commandError);
  const type = raw.type === undefined ? "simple" : raw.type;
  if (!kTypes.includes(type)) errors.push(`type must be one of ${kTypes.join(", ")}`);
  for (const field of ["check", "stop"]) {
    if (raw[field] === undefined) continue;
    const error = validateArgv(raw[field], field);
    if (error) errors.push(error);
    else if (type !== "forking") errors.push(`${field} applies only to type forking`);
  }
  if (type === "forking" && raw.check === undefined) {
    errors.push("type forking needs a check command (argv that exits 0 while it runs)");
  }
  let user = null;
  if (raw.user !== undefined) {
    if (Number.isInteger(raw.user) && raw.user >= 0) user = raw.user;
    else if (typeof raw.user === "string" && kUserPattern.test(raw.user)) user = raw.user;
    else errors.push("user must be a user name or a numeric uid");
  }
  for (const field of ["cwd", "envFile"]) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string" || !raw[field].startsWith("/")) {
      errors.push(`${field} must be an absolute path`);
    }
  }
  const env = {};
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env)) errors.push("env must be an object of string values");
    else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (!kEnvKeyPattern.test(key) || typeof value !== "string" || value.includes("\0")) {
          errors.push(`env.${key} must be a valid name with a string value`);
          continue;
        }
        env[key] = value;
      }
    }
  }
  let envUnset = [];
  if (raw.envUnset !== undefined) {
    if (!Array.isArray(raw.envUnset) || raw.envUnset.some((item) => typeof item !== "string" || !kEnvUnsetPattern.test(item))) {
      errors.push("envUnset must be an array of variable names (a trailing * matches a prefix)");
    } else {
      envUnset = [...raw.envUnset];
    }
  }
  if (raw.inheritEnv !== undefined && typeof raw.inheritEnv !== "boolean") {
    errors.push("inheritEnv must be true or false");
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    errors.push("enabled must be true or false");
  }
  const restart = raw.restart === undefined ? (type === "oneshot" ? "never" : "always") : raw.restart;
  if (!kRestartPolicies.includes(restart)) {
    errors.push(`restart must be one of ${kRestartPolicies.join(", ")}`);
  }
  const startAfter = raw.startAfter === undefined ? "gateway" : raw.startAfter;
  if (!kStartAfter.includes(startAfter)) {
    errors.push(`startAfter must be one of ${kStartAfter.join(", ")}`);
  }
  const stopTimeoutSeconds = boundedInteger(raw.stopTimeoutSeconds, kStopTimeoutBounds, "stopTimeoutSeconds", errors);
  const checkIntervalSeconds = boundedInteger(raw.checkIntervalSeconds, kCheckIntervalBounds, "checkIntervalSeconds", errors);
  if (errors.length) return { entry: null, errors };
  return {
    entry: {
      name,
      command: [...raw.command],
      type,
      check: raw.check ? [...raw.check] : null,
      stop: raw.stop ? [...raw.stop] : null,
      user,
      cwd: raw.cwd || null,
      envFile: raw.envFile || null,
      env,
      envUnset,
      inheritEnv: raw.inheritEnv === true,
      restart,
      startAfter,
      stopTimeoutSeconds,
      checkIntervalSeconds,
      enabled: raw.enabled !== false,
    },
    errors: [],
  };
};

// { configured, entries, errors }: errors carry the entry index and name so
// one bad entry never hides the others.
const parseSidecarRegistry = (rawValue) => {
  const text = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!text) return { configured: false, entries: [], errors: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      configured: true,
      entries: [],
      errors: [{ index: null, name: null, errors: [`${kSidecarsEnvKey} is not valid JSON: ${error.message}`] }],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      configured: true,
      entries: [],
      errors: [{ index: null, name: null, errors: [`${kSidecarsEnvKey} must be a JSON array of sidecar entries`] }],
    };
  }
  const entries = [];
  const errors = [];
  const seen = new Set();
  parsed.forEach((raw, index) => {
    const label = isPlainObject(raw) && typeof raw.name === "string" ? raw.name : null;
    if (index >= kMaxSidecars) {
      errors.push({ index, name: label, errors: [`at most ${kMaxSidecars} sidecars are supported`] });
      return;
    }
    const { entry, errors: entryErrors } = normalizeSidecarEntry(raw);
    if (entry && seen.has(entry.name)) {
      errors.push({ index, name: entry.name, errors: ["duplicate name"] });
      return;
    }
    if (!entry) {
      errors.push({ index, name: label, errors: entryErrors });
      return;
    }
    seen.add(entry.name);
    entries.push(entry);
  });
  return { configured: true, entries, errors };
};

const readSidecarRegistry = ({ env = process.env } = {}) => parseSidecarRegistry(env[kSidecarsEnvKey]);

module.exports = {
  kSidecarsEnvKey,
  kMaxSidecars,
  parseSidecarRegistry,
  readSidecarRegistry,
  normalizeSidecarEntry,
};
