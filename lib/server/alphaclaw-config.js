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
  };
};

const readAlphaclawConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = kDefaultAlphaclawConfig,
} = {}) => {
  try {
    const configPath = resolveAlphaclawConfigPath({ openclawDir });
    const raw = fsModule.readFileSync(configPath, "utf8");
    return normalizeAlphaclawConfig(JSON.parse(raw));
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
  normalizeAlphaclawConfig,
  readAlphaclawConfig,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  resolveAlphaclawConfigPath,
  updateOpenAiCompatApiFeature,
  updateOpenclawOverseerEnabled,
  updateOpenclawReleaseChannel,
  writeAlphaclawConfig,
};
