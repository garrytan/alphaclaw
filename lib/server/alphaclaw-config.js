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
  // Watchdog incident overseer (Claude Code advisory review of settled
  // incidents). DEFAULT OFF — it sends redacted logs to the Anthropic API.
  watchdog: Object.freeze({
    overseer: Object.freeze({
      enabled: false,
    }),
  }),
  // Resource autotune: derive gateway heap, agent concurrency, body limits,
  // SQLite caches, and backup budgets from the container's actual capacity.
  // DEFAULT ON (opt-out, medic-style): the alternative is every deployment
  // running 512MB-tuned constants regardless of box size. Detection always
  // runs; only APPLICATION is gated by `enabled` (and the
  // ALPHACLAW_AUTOTUNE_DISABLED=1 env kill-switch, checked in autotune.js).
  // `overrides` pins individual knobs (integer MB unless noted); unknown keys
  // and out-of-bounds values are dropped at normalize time.
  autotune: Object.freeze({
    enabled: true,
    overrides: Object.freeze({}),
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

// Storage bounds per override key. Application-time clamps against the live
// machine profile happen in autotune.js — a stored override can't know the
// box it lands on; these bounds only reject unrepresentable values.
const kAutotuneOverrideBounds = Object.freeze({
  gatewayHeapMb: Object.freeze({ min: 128, max: 65536 }),
  uvThreadpoolSize: Object.freeze({ min: 1, max: 64 }),
  agentConcurrencyCap: Object.freeze({ min: 1, max: 1024 }),
  openAiCompatBodyLimitMb: Object.freeze({ min: 1, max: 256 }),
  localBodyLimitMb: Object.freeze({ min: 1, max: 256 }),
  sqliteCacheMb: Object.freeze({ min: 2, max: 64 }),
  backupMaxTotalGb: Object.freeze({ min: 2, max: 60 }),
});

const normalizeAutotuneOverrides = (overrides = {}) => {
  const base = overrides && typeof overrides === "object" ? overrides : {};
  const next = {};
  for (const [key, bounds] of Object.entries(kAutotuneOverrideBounds)) {
    const raw = base[key];
    const value = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= bounds.min &&
      value <= bounds.max
    ) {
      next[key] = value;
    }
  }
  return next;
};

// Autotune is opt-OUT like the medic: anything but a literal `false`
// normalizes to enabled (see kDefaultAlphaclawConfig for why the default
// differs from the strict-boolean features).
const normalizeAutotuneSettings = (autotune = {}) => {
  const base = autotune && typeof autotune === "object" ? autotune : {};
  return {
    ...base,
    enabled: base.enabled !== false,
    overrides: normalizeAutotuneOverrides(base.overrides),
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
      agentAdmin: normalizeAgentAdminFeature(features.agentAdmin),
    },
    updates: normalizeOpenclawUpdates(base.updates),
    team: normalizeTeamSettings(base.team),
    watchdog: normalizeWatchdogConfig(base.watchdog),
    autotune: normalizeAutotuneSettings(base.autotune),
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

const readTeamSettings = (options = {}) =>
  readAlphaclawConfig(options).team;

// Routed through the shared lock (TODOS.md: this was the last unlocked
// read-modify-write on alphaclaw.json — a concurrent toggle could drop it).
const updateTeamSettings = ({
  fsModule = fs,
  openclawDir,
  enabled,
  disableLegacyLogin,
} = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      team: {
        ...cfg.team,
        ...(enabled === undefined ? {} : { enabled: enabled === true }),
        ...(disableLegacyLogin === undefined
          ? {}
          : { disableLegacyLogin: disableLegacyLogin === true }),
      },
    }),
  });
  const changed =
    current.team.enabled !== config.team.enabled ||
    current.team.disableLegacyLogin !== config.team.disableLegacyLogin;
  return { config, changed };
};

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

const readWatchdogOverseerEnabled = (options = {}) =>
  readAlphaclawConfig(options).watchdog.overseer.enabled === true;

const updateWatchdogOverseerEnabled = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  // Locked read-modify-write like every other alphaclaw.json writer — a
  // toggle PUT racing another config writer must not drop either write.
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      watchdog: {
        ...cfg.watchdog,
        overseer: {
          ...cfg.watchdog.overseer,
          enabled: enabled === true,
        },
      },
    }),
  });
  return {
    config,
    changed:
      current.watchdog.overseer.enabled !== config.watchdog.overseer.enabled,
  };
};

// Shared toggle updater for the boolean features under updates.openclaw
// (overseer, medic). Normalization applies each feature's own default
// semantics after the write.
const updateOpenclawFeatureEnabled = ({
  fsModule = fs,
  openclawDir,
  featureKey,
  enabled,
} = {}) => {
  // Locked read-modify-write (from the agent-admin branch) + the generic
  // featureKey (from the team-mode branch) so medic and overseer both toggle
  // through the shared lock.
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      updates: {
        ...cfg.updates,
        openclaw: {
          ...cfg.updates.openclaw,
          [featureKey]: {
            ...cfg.updates.openclaw[featureKey],
            enabled: enabled === true,
          },
        },
      },
    }),
  });
  return {
    config,
    changed:
      current.updates.openclaw[featureKey].enabled !==
      config.updates.openclaw[featureKey].enabled,
  };
};

const readOpenclawMedicEnabled = (options = {}) => {
  // Opt-out must fail CLOSED: the medic default is ON, so the generic
  // defaults-on-unreadable fallback would silently re-enable a medic the
  // operator turned off whenever alphaclaw.json is corrupt or unreadable. A
  // MISSING file is a fresh install and keeps the default.
  try {
    const fsModule = options.fsModule || fs;
    const configPath = resolveAlphaclawConfigPath(options);
    if (fsModule.existsSync(configPath)) {
      JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    }
  } catch {
    return false;
  }
  return readAlphaclawConfig(options).updates.openclaw.medic.enabled === true;
};

const updateOpenclawMedicEnabled = ({ fsModule = fs, openclawDir, enabled } = {}) =>
  updateOpenclawFeatureEnabled({ fsModule, openclawDir, featureKey: "medic", enabled });

const readAutotuneSettings = (options = {}) => readAlphaclawConfig(options).autotune;

const readAutotuneEnabled = (options = {}) => {
  // Same fail-closed guard as the medic: autotune defaults ON, so the generic
  // defaults-on-unreadable fallback would silently re-enable tuning the
  // operator turned off whenever alphaclaw.json is corrupt. A MISSING file is
  // a fresh install and keeps the default.
  try {
    const fsModule = options.fsModule || fs;
    const configPath = resolveAlphaclawConfigPath(options);
    if (fsModule.existsSync(configPath)) {
      JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    }
  } catch {
    return false;
  }
  return readAlphaclawConfig(options).autotune.enabled === true;
};

// Per-key shallow merge; explicit `null` clears a key. The UI saving one
// override must never erase sibling API-set overrides.
const updateAutotuneSettings = ({
  fsModule = fs,
  openclawDir,
  enabled,
  overrides,
} = {}) => {
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => {
      const nextOverrides = { ...cfg.autotune.overrides };
      if (overrides && typeof overrides === "object") {
        for (const key of Object.keys(kAutotuneOverrideBounds)) {
          if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
          if (overrides[key] === null) delete nextOverrides[key];
          else nextOverrides[key] = overrides[key];
        }
      }
      return {
        ...cfg,
        autotune: {
          ...cfg.autotune,
          ...(enabled === undefined ? {} : { enabled: enabled !== false }),
          overrides: nextOverrides,
        },
      };
    },
  });
  return {
    config,
    changed:
      JSON.stringify(current.autotune) !== JSON.stringify(config.autotune),
  };
};

const updateOpenclawOverseerEnabled = ({ fsModule = fs, openclawDir, enabled } = {}) =>
  updateOpenclawFeatureEnabled({
    fsModule,
    openclawDir,
    featureKey: "overseer",
    enabled,
  });

module.exports = {
  kConfigFileName,
  kDefaultAlphaclawConfig,
  kOpenclawReleaseChannels,
  kDefaultOpenclawReleaseChannel,
  kAutotuneOverrideBounds,
  readAutotuneEnabled,
  readAutotuneSettings,
  updateAutotuneSettings,
  isAgentAdminEnabled,
  isOpenAiCompatApiEnabled,
  isTeamEnabled,
  normalizeAlphaclawConfig,
  readAlphaclawConfig,
  readOpenclawMedicEnabled,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  readTeamSettings,
  readTeamConfig,
  readWatchdogOverseerEnabled,
  resolveAlphaclawConfigPath,
  updateAgentAdminFeature,
  updateAlphaclawConfig,
  updateTeamSettings,
  updateOpenAiCompatApiFeature,
  updateOpenclawMedicEnabled,
  updateOpenclawOverseerEnabled,
  updateWatchdogOverseerEnabled,
  updateOpenclawReleaseChannel,
  updateTeamConfig,
  writeAlphaclawConfig,
};
