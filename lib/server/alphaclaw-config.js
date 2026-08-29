const fs = require("fs");
const path = require("path");

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
  // Watchdog incident overseer (Claude Code advisory review of settled
  // incidents). DEFAULT OFF — it sends redacted logs to the Anthropic API.
  watchdog: Object.freeze({
    overseer: Object.freeze({
      enabled: false,
    }),
  }),
});

const resolveAlphaclawConfigPath = ({ openclawDir } = {}) =>
  path.join(openclawDir || process.cwd(), kConfigFileName);

const normalizeOpenAiCompatApiFeature = (feature = {}) => ({
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

// Watchdog incident overseer: strictly opt-in, same posture as the upgrade
// overseer — anything but a literal `true` normalizes to disabled.
const normalizeWatchdogConfig = (watchdog = {}) => {
  const base = watchdog && typeof watchdog === "object" ? watchdog : {};
  const overseer =
    base.overseer && typeof base.overseer === "object" ? base.overseer : {};
  return {
    ...base,
    overseer: {
      ...overseer,
      enabled: overseer.enabled === true,
    },
  };
};

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
    },
    updates: normalizeOpenclawUpdates(base.updates),
    team: normalizeTeamConfig(base.team),
    watchdog: normalizeWatchdogConfig(base.watchdog),
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

const writeAlphaclawConfig = ({
  fsModule = fs,
  openclawDir,
  config,
  spacing = 2,
} = {}) => {
  const configPath = resolveAlphaclawConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(configPath), { recursive: true });
  const normalized = normalizeAlphaclawConfig(config);
  fsModule.writeFileSync(configPath, `${JSON.stringify(normalized, null, spacing)}\n`);
  kConfigReadCache = null;
  return normalized;
};

const isOpenAiCompatApiEnabled = (options = {}) =>
  readAlphaclawConfig(options).features.openaiCompatApi.enabled === true;

const updateOpenAiCompatApiFeature = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    features: {
      ...current.features,
      openaiCompatApi: {
        ...current.features.openaiCompatApi,
        enabled: enabled === true,
      },
    },
  });
  const changed =
    current.features.openaiCompatApi.enabled !== next.features.openaiCompatApi.enabled;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

const readTeamConfig = (options = {}) => readAlphaclawConfig(options).team;

const isTeamEnabled = (options = {}) =>
  readAlphaclawConfig(options).team.enabled === true;

const updateTeamConfig = ({ fsModule = fs, openclawDir, enabled } = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    team: {
      ...current.team,
      enabled: enabled === true,
    },
  });
  const changed = current.team.enabled !== next.team.enabled;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

const readOpenclawReleaseChannel = (options = {}) =>
  readAlphaclawConfig(options).updates.openclaw.releaseChannel;

const updateOpenclawReleaseChannel = ({
  fsModule = fs,
  openclawDir,
  releaseChannel,
} = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    updates: {
      ...current.updates,
      openclaw: {
        ...current.updates.openclaw,
        releaseChannel,
      },
    },
  });
  const changed =
    current.updates.openclaw.releaseChannel !==
    next.updates.openclaw.releaseChannel;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

const readOpenclawOverseerEnabled = (options = {}) =>
  readAlphaclawConfig(options).updates.openclaw.overseer.enabled === true;

const readWatchdogOverseerEnabled = (options = {}) =>
  readAlphaclawConfig(options).watchdog.overseer.enabled === true;

const updateWatchdogOverseerEnabled = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    watchdog: {
      ...current.watchdog,
      overseer: {
        ...current.watchdog.overseer,
        enabled: enabled === true,
      },
    },
  });
  const changed =
    current.watchdog.overseer.enabled !== next.watchdog.overseer.enabled;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

const updateOpenclawOverseerEnabled = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    updates: {
      ...current.updates,
      openclaw: {
        ...current.updates.openclaw,
        overseer: {
          ...current.updates.openclaw.overseer,
          enabled: enabled === true,
        },
      },
    },
  });
  const changed =
    current.updates.openclaw.overseer.enabled !==
    next.updates.openclaw.overseer.enabled;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

module.exports = {
  kConfigFileName,
  kDefaultAlphaclawConfig,
  kOpenclawReleaseChannels,
  kDefaultOpenclawReleaseChannel,
  isOpenAiCompatApiEnabled,
  isTeamEnabled,
  normalizeAlphaclawConfig,
  readAlphaclawConfig,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  readTeamConfig,
  readWatchdogOverseerEnabled,
  resolveAlphaclawConfigPath,
  updateOpenAiCompatApiFeature,
  updateOpenclawOverseerEnabled,
  updateWatchdogOverseerEnabled,
  updateOpenclawReleaseChannel,
  updateTeamConfig,
  writeAlphaclawConfig,
};
