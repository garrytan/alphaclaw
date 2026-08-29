const fs = require("fs");
const path = require("path");
const { kRootDir } = require("./constants");

const kDefaultOpenclawCompileCacheDir = path.join(
  kRootDir,
  "cache",
  "openclaw-compile-cache",
);

const normalizeEnvValue = (value) => String(value || "").trim();

const resolveOpenclawCompileCacheDir = (env = process.env) =>
  normalizeEnvValue(env.NODE_COMPILE_CACHE) || kDefaultOpenclawCompileCacheDir;

const resolveOpenclawNoRespawn = (env = process.env) =>
  normalizeEnvValue(env.OPENCLAW_NO_RESPAWN) || "1";

// AlphaClaw owns the OpenClaw gateway lifecycle (spawns it as a child, manages
// versions via the release-channel overlay). OpenClaw 2026.8 formalizes this with
// OPENCLAW_SUPERVISOR_MODE=external: it targets gateway restarts at the running
// process instead of launchd/systemd, refuses native service mutation, and blocks
// self-update (which would corrupt the overlay/sentinel model). Harmless no-op on
// stable. OPENCLAW_SERVICE_REPAIR_POLICY=external keeps Doctor diagnostic-only.
//
// Escape hatch: OPENCLAW_SUPERVISOR_MODE=off|none neutralizes BOTH variables so an
// operator can fully revert without a rebuild. The sentinel must be DELETED from the
// child env (not passed through) — a literal "off" is not a value OpenClaw accepts.
const kSupervisorEscapeHatch = new Set(["off", "none"]);

const isSupervisorEscapeHatch = (env = process.env) =>
  kSupervisorEscapeHatch.has(
    normalizeEnvValue(env.OPENCLAW_SUPERVISOR_MODE).toLowerCase(),
  );

const resolveOpenclawSupervisorMode = (env = process.env) => {
  if (isSupervisorEscapeHatch(env)) return null;
  return normalizeEnvValue(env.OPENCLAW_SUPERVISOR_MODE) || "external";
};

const resolveOpenclawServiceRepairPolicy = (env = process.env) => {
  if (isSupervisorEscapeHatch(env)) return null;
  return normalizeEnvValue(env.OPENCLAW_SERVICE_REPAIR_POLICY) || "external";
};

const withOpenclawStartupEnv = (env = process.env) => {
  const next = {
    ...env,
    NODE_COMPILE_CACHE: resolveOpenclawCompileCacheDir(env),
    OPENCLAW_NO_RESPAWN: resolveOpenclawNoRespawn(env),
  };
  // Autotune: size the libuv threadpool for CHILD processes only (the gateway
  // and openclaw CLI shells). An operator-set value always wins, and
  // process.env is never mutated for this variable (ensureOpenclawStartupEnv
  // deliberately skips it — a sticky global would survive disabling autotune
  // and later read as an operator override). Lazy require + catch: this runs
  // in early-boot CLI contexts and must never throw.
  if (!normalizeEnvValue(env.UV_THREADPOOL_SIZE)) {
    try {
      const { getUvThreadpoolSize } = require("./autotune");
      // Derive under the SAME env the operator-set check above used — an
      // isolated caller env (kill-switch present or absent) must not get a
      // value derived under process.env's different context.
      const uv = getUvThreadpoolSize({ env });
      if (uv != null) next.UV_THREADPOOL_SIZE = String(uv);
    } catch {}
  }
  const supervisorMode = resolveOpenclawSupervisorMode(env);
  const serviceRepairPolicy = resolveOpenclawServiceRepairPolicy(env);
  if (supervisorMode) {
    next.OPENCLAW_SUPERVISOR_MODE = supervisorMode;
  } else {
    delete next.OPENCLAW_SUPERVISOR_MODE;
  }
  if (serviceRepairPolicy) {
    next.OPENCLAW_SERVICE_REPAIR_POLICY = serviceRepairPolicy;
  } else {
    delete next.OPENCLAW_SERVICE_REPAIR_POLICY;
  }
  return next;
};

const ensureOpenclawStartupEnv = ({
  fsModule = fs,
  env = process.env,
  logger = console,
} = {}) => {
  const nextEnv = withOpenclawStartupEnv(env);
  try {
    fsModule.mkdirSync(nextEnv.NODE_COMPILE_CACHE, { recursive: true });
  } catch (err) {
    logger?.warn?.(
      `[alphaclaw] OpenClaw compile cache directory unavailable: ${err.message}`,
    );
  }

  if (!normalizeEnvValue(env.NODE_COMPILE_CACHE)) {
    env.NODE_COMPILE_CACHE = nextEnv.NODE_COMPILE_CACHE;
  }
  if (!normalizeEnvValue(env.OPENCLAW_NO_RESPAWN)) {
    env.OPENCLAW_NO_RESPAWN = nextEnv.OPENCLAW_NO_RESPAWN;
  }
  // Mirror the supervisor contract onto process.env so early direct `openclaw`
  // shells (before gatewayEnv() builds a child env) inherit it. The escape hatch
  // deletes the sentinel outright rather than backfilling.
  if (nextEnv.OPENCLAW_SUPERVISOR_MODE) {
    env.OPENCLAW_SUPERVISOR_MODE = nextEnv.OPENCLAW_SUPERVISOR_MODE;
  } else {
    delete env.OPENCLAW_SUPERVISOR_MODE;
  }
  if (nextEnv.OPENCLAW_SERVICE_REPAIR_POLICY) {
    env.OPENCLAW_SERVICE_REPAIR_POLICY = nextEnv.OPENCLAW_SERVICE_REPAIR_POLICY;
  } else {
    delete env.OPENCLAW_SERVICE_REPAIR_POLICY;
  }

  return nextEnv;
};

module.exports = {
  kDefaultOpenclawCompileCacheDir,
  ensureOpenclawStartupEnv,
  resolveOpenclawCompileCacheDir,
  resolveOpenclawNoRespawn,
  resolveOpenclawSupervisorMode,
  resolveOpenclawServiceRepairPolicy,
  withOpenclawStartupEnv,
};
