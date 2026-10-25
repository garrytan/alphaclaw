const fs = require("fs");
const os = require("os");

// The environment and identity a sidecar runs with. Base env: a minimal
// projection of AlphaClaw's (PATH, locale, terminal, time zone) unless the
// entry opts into inheritEnv, then the entry's envFile, then its env map,
// then envUnset removes names (a trailing * matches a prefix). HOME, USER and
// LOGNAME follow the resolved user unless the entry sets them.
const kMinimalEnvKeys = Object.freeze(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"]);
const kFallbackPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const parseEnvFileText = (text) => {
  const vars = {};
  for (const line of String(text || "").split("\n")) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eqIdx + 1);
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    vars[key] = value;
  }
  return vars;
};

const parsePasswd = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.split(":"))
    .filter((fields) => fields.length >= 7)
    .map(([name, , uid, gid, , home, shell]) => ({
      name,
      uid: Number(uid),
      gid: Number(gid),
      home,
      shell,
    }));

// Resolves an entry's user to { uid, gid, name, home }; null user means
// AlphaClaw's own identity. Running as anyone else needs root.
const resolveSidecarUser = (
  user,
  { readFileSync = fs.readFileSync, getuid = process.getuid?.bind(process) } = {},
) => {
  const currentUid = typeof getuid === "function" ? getuid() : null;
  if (user === null || user === undefined) {
    return { ok: true, identity: null };
  }
  let records = [];
  try {
    records = parsePasswd(readFileSync("/etc/passwd", "utf8"));
  } catch {}
  const record = records.find((entry) => (typeof user === "number" ? entry.uid === user : entry.name === user));
  if (!record && typeof user === "string") {
    return { ok: false, error: `user ${user} does not exist on this machine` };
  }
  const identity = record
    ? { uid: record.uid, gid: record.gid, name: record.name, home: record.home }
    : { uid: user, gid: user, name: String(user), home: null };
  if (currentUid !== null && currentUid !== 0 && currentUid !== identity.uid) {
    return { ok: false, error: `running as ${identity.name} needs AlphaClaw to run as root` };
  }
  return { ok: true, identity };
};

const unsetMatches = (pattern, key) =>
  pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;

const buildSidecarEnv = (
  entry,
  { baseEnv = process.env, identity = null, readFileSync = fs.readFileSync, homedir = os.homedir } = {},
) => {
  let env = {};
  if (entry.inheritEnv) {
    env = { ...baseEnv };
  } else {
    for (const key of kMinimalEnvKeys) {
      if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
    }
    if (!env.PATH) env.PATH = kFallbackPath;
  }
  if (identity) {
    if (identity.home) env.HOME = identity.home;
    env.USER = identity.name;
    env.LOGNAME = identity.name;
  } else if (!env.HOME) {
    env.HOME = baseEnv.HOME || homedir();
  }
  if (entry.envFile) {
    let text;
    try {
      text = readFileSync(entry.envFile, "utf8");
    } catch (error) {
      return { ok: false, error: `envFile ${entry.envFile} could not be read (${error.code || error.message})` };
    }
    Object.assign(env, parseEnvFileText(text));
  }
  Object.assign(env, entry.env || {});
  for (const pattern of entry.envUnset || []) {
    for (const key of Object.keys(env)) {
      if (unsetMatches(pattern, key)) delete env[key];
    }
  }
  delete env.ALPHACLAW_SIDECARS;
  env.ALPHACLAW_SIDECAR_NAME = entry.name;
  return { ok: true, env };
};

module.exports = {
  kMinimalEnvKeys,
  parseEnvFileText,
  parsePasswd,
  resolveSidecarUser,
  buildSidecarEnv,
};
