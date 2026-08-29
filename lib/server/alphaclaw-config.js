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
      // Gateway startup medic (automatic EX_CONFIG repair). DEFAULT ON,
      // unlike the recommend-only overseer: every medic action is picked from
      // a deterministic whitelist, preceded by a backup, capped per incident,
      // and announced — and the alternative is a gateway that stays down.
      medic: Object.freeze({
        enabled: true,
      }),
    }),
  }),
  // Credentialed team members over one shared password. DEFAULT OFF: with
  // team.enabled false nothing observable changes anywhere in AlphaClaw or
  // the gateway.
  team: Object.freeze({
    enabled: false,
    disableLegacyLogin: false,
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
  // Startup medic is opt-OUT: anything but a literal `false` normalizes to
  // enabled (see kDefaultAlphaclawConfig for why the default differs from
  // the overseer's).
  const medic =
    openclaw.medic && typeof openclaw.medic === "object" ? openclaw.medic : {};
  return {
    ...base,
    openclaw: {
      ...openclaw,
      releaseChannel,
      overseer: {
        ...overseer,
        enabled: overseer.enabled === true,
      },
      medic: {
        ...medic,
        enabled: medic.enabled !== false,
      },
    },
  };
};

const normalizeTeamSettings = (team = {}) => {
  const base = team && typeof team === "object" ? team : {};
  return {
    ...base,
    enabled: base.enabled === true,
    disableLegacyLogin: base.disableLegacyLogin === true,
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
    team: normalizeTeamSettings(base.team),
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
      // Reader identity: tests swap fs.readFileSync between cases while the
      // on-disk stat stays put — a changed reader must never serve the old
      // parse.
      kConfigReadCache.reader === fsModule.readFileSync &&
      kConfigReadCache.mtimeMs === stat.mtimeMs &&
      kConfigReadCache.size === stat.size
    ) {
      return JSON.parse(kConfigReadCache.serialized);
    }
    const raw = fsModule.readFileSync(configPath, "utf8");
    const config = normalizeAlphaclawConfig(JSON.parse(raw));
    kConfigReadCache = {
      configPath,
      reader: fsModule.readFileSync,
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

const readTeamSettings = (options = {}) =>
  readAlphaclawConfig(options).team;

const updateTeamSettings = ({
  fsModule = fs,
  openclawDir,
  enabled,
  disableLegacyLogin,
} = {}) => {
  const current = readAlphaclawConfig({ fsModule, openclawDir });
  const next = normalizeAlphaclawConfig({
    ...current,
    team: {
      ...current.team,
      ...(enabled === undefined ? {} : { enabled: enabled === true }),
      ...(disableLegacyLogin === undefined
        ? {}
        : { disableLegacyLogin: disableLegacyLogin === true }),
    },
  });
  const changed =
    current.team.enabled !== next.team.enabled ||
    current.team.disableLegacyLogin !== next.team.disableLegacyLogin;
  return {
    config: writeAlphaclawConfig({ fsModule, openclawDir, config: next }),
    changed,
  };
};

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

const readOpenclawMedicEnabled = (options = {}) =>
  readAlphaclawConfig(options).updates.openclaw.medic.enabled === true;

const updateOpenclawMedicEnabled = ({
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
        medic: {
          ...current.updates.openclaw.medic,
          enabled: enabled === true,
        },
      },
    },
  });
  const changed =
    current.updates.openclaw.medic.enabled !== next.updates.openclaw.medic.enabled;
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
  readOpenclawMedicEnabled,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  readTeamSettings,
  readTeamConfig,
  resolveAlphaclawConfigPath,
  updateTeamSettings,
  updateOpenAiCompatApiFeature,
  updateOpenclawMedicEnabled,
  updateOpenclawOverseerEnabled,
  updateOpenclawReleaseChannel,
  updateTeamConfig,
  writeAlphaclawConfig,
};
