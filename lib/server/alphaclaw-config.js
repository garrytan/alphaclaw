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
    // Gateway memory-leak detection (RSS trend sampling). DEFAULT ON
    // (opt-out, autotune-style): detection is report-only — events,
    // notifications, doctor cards. autoRestart (the pre-OOM mitigation
    // restart) is strictly opt-in and only effective while enabled is true.
    // budgetMb (null = derive the cap from heap/container) and
    // maxRestartsPerDay (the auto-restart brake budget) are the fast-leak
    // profile (issue #56): a diagnosed leak that crosses OpenClaw's own 6 GiB
    // drain in hours needs a cap below the derived one and more than two
    // restarts a day. Bounds: kWatchdogMemoryBounds.
    memory: Object.freeze({
      enabled: true,
      autoRestart: false,
      budgetMb: null,
      maxRestartsPerDay: 2,
    }),
  }),
  // Scheduled Drift Doctor scans. DEFAULT OFF: auto-runs spend the user's own
  // LLM tokens, so they are strictly opt-in.
  // doctor.scan: workspace-fingerprint cap overrides. `null` means "use the
  // built-in default" (kSnapshotMaxFiles / kSnapshotMaxFileBytes in
  // lib/server/doctor/workspace-fingerprint.js).
  doctor: Object.freeze({
    autoRun: Object.freeze({
      enabled: false,
    }),
    scan: Object.freeze({
      maxFiles: null,
      maxFileMb: null,
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
// Memory monitor: detection is opt-OUT (anything but literal `false` stays
// enabled, medic/autotune posture); autoRestart is strictly opt-in. Both raw
// values persist independently — the EFFECTIVE auto-restart (enabled &&
// autoRestart) is derived by readWatchdogMemorySettings, never stored, so a
// detection toggle round-trip can't silently drop an operator's autoRestart
// choice (the agent-admin tierResolver guards the re-arm path instead).
// Memory fast-leak profile bounds (issue #56). Storage-time normalization
// only — the route layer rejects out-of-bounds PUTs loudly; a hand-edited
// value outside the bounds normalizes to the default rather than surprising
// the detector (a 1 MB budget would restart the gateway every tick).
const kWatchdogMemoryBounds = Object.freeze({
  budgetMb: Object.freeze({ min: 256, max: 1048576 }),
  maxRestartsPerDay: Object.freeze({ min: 1, max: 24 }),
});

// null/undefined = no budget (derived cap); anything else must be a WHOLE
// number of MB inside the bounds (strict: 2800.4 is rejected, not rounded —
// the UI copy promises whole numbers, and rounding would let 255.6 sneak
// under the floor as 256). Shared by the route (loud 400) and storage (quiet
// fallback) so the two layers cannot drift on the rule.
const normalizeMemoryBudgetMb = (value) => {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    !Number.isInteger(n) ||
    n < kWatchdogMemoryBounds.budgetMb.min ||
    n > kWatchdogMemoryBounds.budgetMb.max
  ) {
    return null;
  }
  return n;
};

const normalizeMemoryMaxRestartsPerDay = (value) => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (
    !Number.isInteger(n) ||
    n < kWatchdogMemoryBounds.maxRestartsPerDay.min ||
    n > kWatchdogMemoryBounds.maxRestartsPerDay.max
  ) {
    return kDefaultAlphaclawConfig.watchdog.memory.maxRestartsPerDay;
  }
  return n;
};

const normalizeWatchdogConfig = (watchdog = {}) => {
  const base = watchdog && typeof watchdog === "object" ? watchdog : {};
  const overseer =
    base.overseer && typeof base.overseer === "object" ? base.overseer : {};
  const memory =
    base.memory && typeof base.memory === "object" ? base.memory : {};
  return {
    ...base,
    overseer: {
      ...overseer,
      enabled: overseer.enabled === true,
    },
    memory: {
      ...memory,
      enabled: memory.enabled !== false,
      autoRestart: memory.autoRestart === true,
      budgetMb: normalizeMemoryBudgetMb(memory.budgetMb),
      maxRestartsPerDay: normalizeMemoryMaxRestartsPerDay(
        memory.maxRestartsPerDay,
      ),
    },
  };
};

// Workspace-scan cap bounds. Storage-time clamps only — the route layer
// rejects out-of-bounds PUTs loudly; a hand-edited config value outside the
// bounds normalizes to null (built-in default) rather than surprising the
// scanner.
const kDoctorScanCapBounds = Object.freeze({
  maxFiles: Object.freeze({ min: 1000, max: 500000 }),
  maxFileMb: Object.freeze({ min: 1, max: 100 }),
});

const normalizeDoctorScanCap = (value, bounds) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < bounds.min || parsed > bounds.max) return null;
  return parsed;
};

// Scheduled Drift Doctor scans: strictly opt-in, same posture as the
// overseers — anything but a literal `true` normalizes to disabled.
const normalizeDoctorConfig = (doctor = {}) => {
  const base = doctor && typeof doctor === "object" ? doctor : {};
  const autoRun =
    base.autoRun && typeof base.autoRun === "object" ? base.autoRun : {};
  const scan = base.scan && typeof base.scan === "object" ? base.scan : {};
  return {
    ...base,
    autoRun: {
      ...autoRun,
      enabled: autoRun.enabled === true,
    },
    scan: {
      ...scan,
      maxFiles: normalizeDoctorScanCap(scan.maxFiles, kDoctorScanCapBounds.maxFiles),
      maxFileMb: normalizeDoctorScanCap(scan.maxFileMb, kDoctorScanCapBounds.maxFileMb),
    },
  };
};

// Storage bounds per override key. Application-time clamps against the live
// machine profile happen in autotune.js — a stored override can't know the
// box it lands on; these bounds only reject unrepresentable values.
const kAutotuneOverrideBounds = Object.freeze({
  gatewayHeapMb: Object.freeze({ min: 128, max: 65536 }),
  uvThreadpoolSize: Object.freeze({ min: 1, max: 64 }),
  // Floor 8, not 1: consumers assume the pre-feature floor — a sub-8 cap
  // would make the boot default exceed the requested cap and let subagent
  // concurrency rise above agent concurrency in the telegram formula.
  agentConcurrencyCap: Object.freeze({ min: 8, max: 1024 }),
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
    doctor: normalizeDoctorConfig(base.doctor),
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

// Fail-CLOSED team reader for the auth boundary (fix wave F049). The generic
// reader merges an existing-but-unparseable alphaclaw.json onto defaults, so a
// corrupt file silently re-enabled shared-password login and killed member
// sessions. Same probe as readWatchdogMemorySettings: an existing file that
// does not parse is a SIGNAL (`configUnreadable: true`), not a fallback; a
// missing file is a legitimate fresh install.
const readTeamSettingsStrict = (options = {}) => {
  try {
    const fsModule = options.fsModule || fs;
    const configPath = resolveAlphaclawConfigPath(options);
    if (fsModule.existsSync(configPath)) {
      JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    }
  } catch {
    return { ...kDefaultAlphaclawConfig.team, configUnreadable: true };
  }
  return readAlphaclawConfig(options).team;
};

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

// Memory-monitor settings with the medic-style fail-closed guard: detection
// defaults ON, so the generic defaults-on-unreadable fallback would silently
// re-enable sampling an operator turned off whenever alphaclaw.json is
// corrupt. A MISSING file is a fresh install and keeps the defaults.
// `effectiveAutoRestart` is the only value enforcement may consult.
const readWatchdogMemorySettings = (options = {}) => {
  try {
    const fsModule = options.fsModule || fs;
    const configPath = resolveAlphaclawConfigPath(options);
    if (fsModule.existsSync(configPath)) {
      JSON.parse(fsModule.readFileSync(configPath, "utf8"));
    }
  } catch {
    // configUnreadable is a SIGNAL, not just a fallback: the agent-admin
    // tier resolver must escalate writes it cannot evaluate (the generic
    // write path fail-opens to defaults, so a gate computed against this
    // fail-closed read would otherwise disagree with what a write merges
    // onto — the corrupt-config arming bypass).
    return {
      enabled: false,
      autoRestart: false,
      effectiveAutoRestart: false,
      budgetMb: null,
      maxRestartsPerDay:
        kDefaultAlphaclawConfig.watchdog.memory.maxRestartsPerDay,
      configUnreadable: true,
    };
  }
  const memory = readAlphaclawConfig(options).watchdog.memory;
  return {
    enabled: memory.enabled === true,
    autoRestart: memory.autoRestart === true,
    effectiveAutoRestart: memory.enabled === true && memory.autoRestart === true,
    budgetMb: memory.budgetMb,
    maxRestartsPerDay: memory.maxRestartsPerDay,
  };
};

// Per-field narrow (undefined leaves the sibling untouched) — a stale local
// copy of one toggle must never write the other back. Locked like every
// other alphaclaw.json writer.
const updateWatchdogMemorySettings = ({
  fsModule = fs,
  openclawDir,
  enabled,
  autoRestart,
  // budgetMb: undefined = untouched, null = clear (derived cap), number = set.
  budgetMb,
  maxRestartsPerDay,
} = {}) => {
  // An EXISTING-but-corrupt config must reject the write, not merge onto
  // defaults: updateAlphaclawConfig's read falls back to
  // kDefaultAlphaclawConfig on a parse error, so writing "just this toggle"
  // would silently rebuild the entire file from defaults — destroying every
  // unrelated operator setting. A missing file is fine (fresh install).
  if (
    readWatchdogMemorySettings({ fsModule, openclawDir }).configUnreadable ===
    true
  ) {
    const err = new Error(
      "alphaclaw.json exists but cannot be parsed — refusing to rewrite it from defaults",
    );
    err.code = "config_unreadable";
    throw err;
  }
  const { current, config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      watchdog: {
        ...cfg.watchdog,
        memory: {
          ...cfg.watchdog.memory,
          ...(enabled === undefined ? {} : { enabled: enabled !== false }),
          ...(autoRestart === undefined
            ? {}
            : { autoRestart: autoRestart === true }),
          ...(budgetMb === undefined
            ? {}
            : { budgetMb: normalizeMemoryBudgetMb(budgetMb) }),
          ...(maxRestartsPerDay === undefined
            ? {}
            : {
                maxRestartsPerDay:
                  normalizeMemoryMaxRestartsPerDay(maxRestartsPerDay),
              }),
        },
      },
    }),
  });
  const before = current.watchdog.memory;
  const after = config.watchdog.memory;
  return {
    config,
    changed:
      before.enabled !== after.enabled ||
      before.autoRestart !== after.autoRestart ||
      before.budgetMb !== after.budgetMb ||
      before.maxRestartsPerDay !== after.maxRestartsPerDay,
    settings: {
      enabled: after.enabled,
      autoRestart: after.autoRestart,
      effectiveAutoRestart: after.enabled && after.autoRestart,
      budgetMb: after.budgetMb,
      maxRestartsPerDay: after.maxRestartsPerDay,
    },
  };
};

const readDoctorAutoRunEnabled = (options = {}) =>
  readAlphaclawConfig(options).doctor.autoRun.enabled === true;

// Configured scan caps (null = built-in default). Effective values resolve at
// the consumer against the exported workspace-fingerprint defaults — this
// module stays ignorant of the scanner.
const readDoctorScanConfig = (options = {}) => {
  const scan = readAlphaclawConfig(options).doctor.scan || {};
  return {
    maxFiles: scan.maxFiles ?? null,
    maxFileMb: scan.maxFileMb ?? null,
  };
};

// ATOMIC combined settings write: one locked read-modify-write covering the
// auto-run toggle AND the scan caps — a mixed PUT must never half-apply
// (toggle changed, caps write failed → 500 with silent partial state).
// `undefined` leaves a field untouched throughout.
const updateDoctorSettingsConfig = ({
  fsModule = fs,
  openclawDir,
  autoRunEnabled = undefined,
  maxFiles = undefined,
  maxFileMb = undefined,
} = {}) => {
  const { config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      doctor: {
        ...cfg.doctor,
        ...(autoRunEnabled !== undefined
          ? { autoRun: { ...cfg.doctor.autoRun, enabled: autoRunEnabled === true } }
          : {}),
        ...(maxFiles !== undefined || maxFileMb !== undefined
          ? {
              scan: {
                ...cfg.doctor.scan,
                ...(maxFiles !== undefined ? { maxFiles } : {}),
                ...(maxFileMb !== undefined ? { maxFileMb } : {}),
              },
            }
          : {}),
      },
    }),
  });
  return {
    autoRunEnabled: config.doctor.autoRun.enabled,
    scan: {
      maxFiles: config.doctor.scan.maxFiles ?? null,
      maxFileMb: config.doctor.scan.maxFileMb ?? null,
    },
  };
};

// Partial update: `undefined` leaves a cap untouched, `null` resets it to the
// built-in default, integers are clamped by normalize. Locked
// read-modify-write like every other alphaclaw.json writer.
const updateDoctorScanConfig = ({
  fsModule = fs,
  openclawDir,
  maxFiles = undefined,
  maxFileMb = undefined,
} = {}) => {
  const { config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      doctor: {
        ...cfg.doctor,
        scan: {
          ...cfg.doctor.scan,
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(maxFileMb !== undefined ? { maxFileMb } : {}),
        },
      },
    }),
  });
  return {
    maxFiles: config.doctor.scan.maxFiles ?? null,
    maxFileMb: config.doctor.scan.maxFileMb ?? null,
  };
};

// Returns the persisted boolean (not {config, changed}): the doctor settings
// route surfaces the new value directly. Locked read-modify-write like every
// other alphaclaw.json writer.
const updateDoctorAutoRunEnabled = ({
  fsModule = fs,
  openclawDir,
  enabled,
} = {}) => {
  const { config } = updateAlphaclawConfig({
    fsModule,
    openclawDir,
    mutate: (cfg) => ({
      ...cfg,
      doctor: {
        ...cfg.doctor,
        autoRun: {
          ...cfg.doctor.autoRun,
          enabled: enabled === true,
        },
      },
    }),
  });
  return config.doctor.autoRun.enabled;
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

// The fail-closed probe re-parses the raw file, bypassing kConfigReadCache —
// and readAutotuneEnabled rides hot paths (the 2s status snapshot via
// buildMachineSummary, gatewayEnv() per spawn, every DB open). Memoize the
// validity verdict on the same mtime/size key so a cache hit costs one stat.
let kAutotuneProbeCache = null;

const readAutotuneEnabled = (options = {}) => {
  // Same fail-closed guard as the medic: autotune defaults ON, so the generic
  // defaults-on-unreadable fallback would silently re-enable tuning the
  // operator turned off whenever alphaclaw.json is corrupt. A MISSING file is
  // a fresh install and keeps the default.
  try {
    const fsModule = options.fsModule || fs;
    const configPath = resolveAlphaclawConfigPath(options);
    let stat = null;
    try {
      stat = fsModule.statSync(configPath);
    } catch (error) {
      // Only a MISSING file is a fresh install. Any other stat failure
      // (EACCES, EIO) means an existing config we can't read — and an
      // operator's enabled:false may be in it, so fail closed.
      if (error?.code !== "ENOENT") return false;
      stat = null;
    }
    if (stat) {
      const cached = kAutotuneProbeCache;
      if (
        cached &&
        cached.configPath === configPath &&
        cached.reader === fsModule.readFileSync &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        if (!cached.parseOk) return false;
      } else {
        let parseOk = true;
        try {
          JSON.parse(fsModule.readFileSync(configPath, "utf8"));
        } catch {
          parseOk = false;
        }
        kAutotuneProbeCache = {
          configPath,
          reader: fsModule.readFileSync,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          parseOk,
        };
        if (!parseOk) return false;
      }
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
  kDoctorScanCapBounds,
  readDoctorAutoRunEnabled,
  readDoctorScanConfig,
  updateDoctorScanConfig,
  updateDoctorSettingsConfig,
  readOpenclawMedicEnabled,
  readOpenclawOverseerEnabled,
  readOpenclawReleaseChannel,
  readTeamSettings,
  readTeamSettingsStrict,
  readTeamConfig,
  readWatchdogOverseerEnabled,
  readWatchdogMemorySettings,
  updateWatchdogMemorySettings,
  kWatchdogMemoryBounds,
  normalizeMemoryBudgetMb,
  normalizeMemoryMaxRestartsPerDay,
  resolveAlphaclawConfigPath,
  updateAgentAdminFeature,
  updateAlphaclawConfig,
  updateDoctorAutoRunEnabled,
  updateTeamSettings,
  updateOpenAiCompatApiFeature,
  updateOpenclawMedicEnabled,
  updateOpenclawOverseerEnabled,
  updateWatchdogOverseerEnabled,
  updateOpenclawReleaseChannel,
  updateTeamConfig,
  writeAlphaclawConfig,
};
