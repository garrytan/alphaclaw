const fs = require("fs");
const path = require("path");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");

const kConfigFileName = "alphaclaw.json";
// Single source of truth lives in constants.js; re-exported here because the
// config module is the natural import site for config-shaped callers.
const { kOpenclawReleaseChannels } = require("./constants");
const kDefaultOpenclawReleaseChannel = "stable";
const kDefaultAlphaclawConfig = Object.freeze({
  features: Object.freeze({
    openaiCompatApi: Object.freeze({
      enabled: false,
    }),
    // Agent Admin: lets the OpenClaw agent administer this deployment via a
    // bearer token + the `alphaclaw admin` CLI. DEFAULT OFF: with the flag
    // off nothing observable changes anywhere (no token, no skill, no routes).
    agentAdmin: Object.freeze({
      enabled: false,
    }),
  }),
  updates: Object.freeze({
    openclaw: Object.freeze({
      releaseChannel: kDefaultOpenclawReleaseChannel,
      overseer: Object.freeze({
        enabled: false,
      }),
    }),
  }),
  // Named operators over one shared password. DEFAULT OFF: with team.enabled
  // false nothing observable changes anywhere in AlphaClaw or the gateway.
  team: Object.freeze({
    enabled: false,
  }),
});

const resolveAlphaclawConfigPath = ({ openclawDir } = {}) =>
  path.join(openclawDir || process.cwd(), kConfigFileName);

const normalizeOpenAiCompatApiFeature = (feature = {}) => ({
  ...(feature && typeof feature === "object" ? feature : {}),
  enabled: feature?.enabled === true,
});

// Strict-boolean like every other feature: anything but literal `true` is off.
const normalizeAgentAdminFeature = (feature = {}) => ({
  ...(feature && typeof feature === "object" ? feature : {}),
  enabled: feature?.enabled === true,
});

const normalizeOpenclawUpdates = (updates = {}) => {
  const base = updates && typeof updates === "object" ? updates : {};
  const openclaw =
    base.openclaw && typeof base.openclaw === "object" ? base.openclaw : {};
  const releaseChannel = kOpenclawReleaseChannels.includes(
    openclaw.releaseChannel,
  )
    ? openclaw.releaseChannel
    : kDefaultOpenclawReleaseChannel;
  // Upgrade overseer (Claude Code advisory review of update runs) is strictly
  // opt-in: anything but a literal `true` normalizes to disabled.
  const overseer =
    openclaw.overseer && typeof openclaw.overseer === "object"
      ? openclaw.overseer
      : {};
  return {
    ...base,
    openclaw: {
      ...openclaw,
      releaseChannel,
      overseer: {
        ...overseer,
        enabled: overseer.enabled === true,
      },
    },
  };
};

const normalizeTeamConfig = (team = {}) => ({
  ...(team && typeof team === "object" ? team : {}),
  enabled: team?.enabled === true,
});

const normalizeAlphaclawConfig = (raw = {}) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const features =
    base.features && typeof base.features === "object" && !Array.isArray(base.features)
      ? base.features
      : {};
  return {
    ...base,
    features: {
      ...features,
      openaiCompatApi: normalizeOpenAiCompatApiFeature(features.openaiCompatApi),
      agentAdmin: normalizeAgentAdminFeature(features.agentAdmin),
    },
    updates: normalizeOpenclawUpdates(base.updates),
    team: normalizeTeamConfig(base.team),
  };
};

// readAlphaclawConfig sits on hot request paths since team mode (the proxy
// identity resolver calls isTeamEnabled per gateway-bound request), so
// identical re-reads are served from an mtime/size-keyed parsed copy — one
// stat per call instead of read+parse. Same pattern as the release-channel
// store's readState.
let kConfigReadCache = null;

const readAlphaclawConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = kDefaultAlphaclawConfig,
} = {}) => {
  try {
    const configPath = resolveAlphaclawConfigPath({ openclawDir });
    let stat = null;
    try {
      stat = fsModule.statSync(configPath);
    } catch {
      // stat unavailable (mocked fs, exotic mounts): plain uncached read —
      // identical to the pre-cache behavior.
      kConfigReadCache = null;
      const raw = fsModule.readFileSync(configPath, "utf8");
      return normalizeAlphaclawConfig(JSON.parse(raw));
    }
    if (
      kConfigReadCache &&
      kConfigReadCache.configPath === configPath &&
      kConfigReadCache.mtimeMs === stat.mtimeMs &&
      kConfigReadCache.size === stat.size
    ) {
      return JSON.parse(kConfigReadCache.serialized);
    }
    const raw = fsModule.readFileSync(configPath, "utf8");
    const config = normalizeAlphaclawConfig(JSON.parse(raw));
    kConfigReadCache = {
      configPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      serialized: JSON.stringify(config),
    };
    return config;
  } catch {
    return normalizeAlphaclawConfig(fallback);
  }
};

// Atomic (temp+rename) so a concurrent reader never sees a torn file. Not
// locked itself: updateAlphaclawConfig wraps read-modify-write in the lock,
// and the lockfile protocol is not reentrant.
const writeAlphaclawConfig = ({
  fsModule = fs,
  openclawDir,
  config,
  spacing = 2,
} = {}) => {
  const configPath = resolveAlphaclawConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(configPath), { recursive: true });
  const normalized = normalizeAlphaclawConfig(config);
  writeFileAtomic(configPath, `${JSON.stringify(normalized, null, spacing)}\n`, {
    fsModule,
  });
  kConfigReadCache = null;
  return normalized;
};

// The blessed mutation path: lock (shared with the CLI) → read → mutate →
// normalize → atomic write. Second writers serialize instead of clobbering —
// required now that the agent-admin API writes concurrently with the UI.
const updateAlphaclawConfig = ({ fsModule = fs, openclawDir, mutate } = {}) => {
  const configPath = resolveAlphaclawConfigPath({ openclawDir });
  return withFileLockSync(
    configPath,
    () => {
      const current = readAlphaclawConfig({ fsModule, openclawDir });
      const next = normalizeAlphaclawConfig(mutate(current) ?? current);
      const config = writeAlphaclawConfig({ fsModule, openclawDir, config: next });
      return { current, config };
    },
    { fsModule },
  );
};

const isOpenAiCompatApiEnabled = (options = {}) =>
  readAlphaclawConfig(options).features.openaiCompatApi.enabled === true;

const updateOpenAiCompatApiFeature = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      features: {
        ...cfg.features,
        openaiCompatApi: {
          ...cfg.features.openaiCompatApi,
          enabled: enabled === true,
        },
      },
    }),
  });
  return {
    config,
    changed:
      current.features.openaiCompatApi.enabled !==
      config.features.openaiCompatApi.enabled,
  };
};

const isAgentAdminEnabled = (options = {}) =>
  readAlphaclawConfig(options).features.agentAdmin.enabled === true;

const updateAgentAdminFeature = ({ fsModule = fs, openclawDir, enabled } = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      features: {
        ...cfg.features,
        agentAdmin: {
          ...cfg.features.agentAdmin,
          enabled: enabled === true,
        },
      },
    }),
  });
  return {
    config,
    changed:
      current.features.agentAdmin.enabled !== config.features.agentAdmin.enabled,
  };
};

const readTeamConfig = (options = {}) => readAlphaclawConfig(options).team;

const isTeamEnabled = (options = {}) =>
  readAlphaclawConfig(options).team.enabled === true;

const updateTeamConfig = ({ fsModule = fs, openclawDir, enabled } = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      team: { ...cfg.team, enabled: enabled === true },
    }),
  });
  return { config, changed: current.team.enabled !== config.team.enabled };
};

const readOpenclawReleaseChannel = (options = {}) =>
  readAlphaclawConfig(options).updates.openclaw.releaseChannel;

const updateOpenclawReleaseChannel = ({
  fsModule = fs,
  openclawDir,
  releaseChannel,
} = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      updates: {
        ...cfg.updates,
        openclaw: { ...cfg.updates.openclaw, releaseChannel },
      },
    }),
  });
  return {
    config,
    changed:
      current.updates.openclaw.releaseChannel !==
      config.updates.openclaw.releaseChannel,
  };
};

const readOpenclawOverseerEnabled = (options = {}) =>
  readAlphaclawConfig(options).updates.openclaw.overseer.enabled === true;

const updateOpenclawOverseerEnabled = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      updates: {
        ...cfg.updates,
        openclaw: {
          ...cfg.updates.openclaw,
          overseer: {
            ...cfg.updates.openclaw.overseer,
            enabled: enabled === true,
          },
        },
      },
    }),
  });
  return {
    config,
    changed:
      current.updates.openclaw.overseer.enabled !==
      config.updates.openclaw.overseer.enabled,
  };
};

module.exports = {
  kConfigFileName,
  kDefaultAlphaclawConfig,
  kOpenclawReleaseChannels,
  kDefaultOpenclawReleaseChannel,
  isAgentAdminEnabled,
  isOpenAiCompatApiEnabled,
  isTeamEnabled,
  normalizeAlphaclawConfig,
  readAlphaclawConfig,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  readTeamConfig,
  resolveAlphaclawConfigPath,
  updateAgentAdminFeature,
  updateAlphaclawConfig,
  updateOpenAiCompatApiFeature,
  updateOpenclawOverseerEnabled,
  updateOpenclawReleaseChannel,
  updateTeamConfig,
  writeAlphaclawConfig,
};
