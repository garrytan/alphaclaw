const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AUTH_PROFILES_PATH, CODEX_PROFILE_ID, OPENCLAW_DIR } = require("./constants");
const { ensureCodexRuntimePlugin } = require("./codex-runtime-config");
const {
  resolveOpenclawStateDbPath,
  openWritableOpenclawStateDb,
  openTrackedReadonlyDatabase,
} = require("./openclaw-state-db");
const {
  readAuthSharedStoreLocation,
  tableHasColumns,
} = require("./openclaw-state-era");
const {
  isStateDbQuiet,
  StateDbQuietError,
  kBackupInProgressCode,
} = require("./state-db-quiet");

const kDefaultAgentId = "main";
// Parity with openclaw-state-db's writable open: a gateway (or backup)
// holding the agent db's write lock stalls us briefly instead of failing.
const kAgentDbBusyTimeoutMs = 3000;

// The lenient (display) read's answer while the state-DB quiet barrier holds:
// an honest "store unavailable" marker, never a bare empty profile list — on
// a migrated box the empty list would render as "no credentials configured"
// for the whole backup. `profiles` stays an object so every caller that only
// enumerates keeps working; routes render the marker.
const unavailableAuthStore = () => ({
  version: 1,
  profiles: {},
  unavailable: true,
  reason: kBackupInProgressCode,
});

// Every auth-store write lands inside the state tree a quiesced backup is
// snapshotting (state db, agent db, or auth-profiles.json), so ALL of them
// fail closed with the named class while the quiet barrier holds — routes
// map it to 409 backup_in_progress. Strict loads (the read half of a
// load→mutate→save cycle) throw the same class so the caller sees one
// consistent 409 instead of the generic "store busy" 500.
const throwIfStateDbQuiet = () => {
  if (isStateDbQuiet()) throw new StateDbQuietError();
};
const kApiKeyEnvVarByProvider = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  kilocode: "KILOCODE_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  volcengine: "VOLCANO_ENGINE_API_KEY",
  byteplus: "BYTEPLUS_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  minimax: "MINIMAX_API_KEY",
  // CN region reuses the same MINIMAX_API_KEY (upstream PR #111). Mapped here
  // so the server onboarding validator accepts a minimax-cn model selection
  // and a minimax-cn auth profile is seeded — without it, choosing a CN model
  // in the wizard hard-fails onboarding with a 400.
  "minimax-cn": "MINIMAX_API_KEY",
  voyage: "VOYAGE_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  vllm: "VLLM_API_KEY",
};

const normalizeSecret = (raw) =>
  String(raw ?? "")
    .replace(/[\r\n\u2028\u2029]/g, "")
    .trim();

const credentialMode = (credential) => {
  if (credential.type === "api_key") return "api_key";
  if (credential.type === "token") return "token";
  return "oauth";
};

const getEnvVarForApiKeyProvider = (provider) =>
  kApiKeyEnvVarByProvider[String(provider || "").trim()] || "";

const listApiKeyProviders = () => Object.keys(kApiKeyEnvVarByProvider);

const getDefaultProfileIdForApiKeyProvider = (provider) => {
  const normalized = String(provider || "").trim();
  return normalized ? `${normalized}:default` : "";
};

const resolveAgentDir = (agentId = kDefaultAgentId) =>
  path.join(OPENCLAW_DIR, "agents", agentId, "agent");

const resolveAuthProfilesPath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "auth-profiles.json");

const resolveAuthDatabasePath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "openclaw-agent.sqlite");

// Both store readers open through the tracked read-only helper: counted while
// open (the quiet barrier drains in-flight handles before a backup snapshots
// the state tree) and armed with the pinned 2000 ms read busy_timeout (an
// untimed reader that fails fast is what stalls a rollback-journal writer's
// COMMIT loop).
const loadSqliteAuthStore = (agentId = kDefaultAgentId) => {
  const databasePath = resolveAuthDatabasePath(agentId);
  if (!fs.existsSync(databasePath)) return null;
  let database;
  try {
    database = openTrackedReadonlyDatabase(databasePath);
    const secretsRow = database
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    if (!secretsRow?.store_json) return null;
    const secrets = JSON.parse(secretsRow.store_json);
    const stateRow = database
      .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
      .get("primary");
    const state = stateRow?.state_json ? JSON.parse(stateRow.state_json) : {};
    return {
      version: Number(secrets.version || state.version || 1),
      profiles: secrets.profiles || {},
      order: state.order,
      lastGood: state.lastGood,
      usageStats: state.usageStats,
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
};

const saveSqliteAuthStore = (agentId, store) => {
  throwIfStateDbQuiet();
  const databasePath = resolveAuthDatabasePath(agentId);
  if (!fs.existsSync(databasePath)) return false;
  let database;
  try {
    database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA busy_timeout = ${kAgentDbBusyTimeoutMs};`);
    const now = Date.now();
    const secrets = {
      version: Number(store.version || 1),
      profiles: store.profiles || {},
    };
    const state = {
      version: Number(store.version || 1),
      ...(store.order !== undefined ? { order: store.order } : {}),
      ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
      ...(store.usageStats !== undefined ? { usageStats: store.usageStats } : {}),
    };
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           store_json = excluded.store_json,
           updated_at = excluded.updated_at`,
      )
      .run("primary", JSON.stringify(secrets), now);
    database
      .prepare(
        `INSERT INTO auth_profile_state (state_key, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run("primary", JSON.stringify(state), now);
    database.exec("COMMIT");
    return true;
  } catch {
    try {
      database?.exec("ROLLBACK");
    } catch {}
    return false;
  } finally {
    database?.close();
  }
};

// ── Relocated shared auth store (openclaw >= 2026.9.1-beta.1) ────────────────
//
// The beta's doctor --fix (which alphaclaw runs on every version activation)
// MOVES the main agent's rows out of the agent db into state/openclaw.sqlite
// — tables auth_profile_stores / auth_profile_state, row key 'shared' — then
// DELETES the agent-db 'primary' rows and flips the auth.sharedStore machine
// state. After the flip openclaw reads main-agent auth ONLY from the shared
// db: a credential written to the agent db there "succeeds" and is silently
// ignored, and the resurrected 'primary' rows make every later doctor --fix
// warn about a relocation conflict. The machine-state flag — migration
// completion — is the sole backend authority (a version/capability signal
// must never flip it). Direct writes here are the documented exception:
// `openclaw models auth paste-api-key/paste-token` covers api keys only —
// oauth profiles (access/refresh/expires), ordering, and usage state have no
// CLI surface, and splitting the store across two writers would fork its
// consistency. Same BEGIN IMMEDIATE pattern as the agent-db writer below.
const kSharedAuthRowKey = "shared";

// Returns { ok: true, store } — where an EMPTY store is a legitimate,
// successful read — or { ok: false } when the db could not be read (lock,
// corruption, schema drift). The distinction is load-bearing: conflating a
// transient read failure with "no profiles" would let the next mutator's
// load→mutate→save cycle persist a near-empty store and wipe every shared
// credential.
const loadSharedAuthStore = () => {
  const databasePath = resolveOpenclawStateDbPath({ openclawDir: OPENCLAW_DIR });
  if (!fs.existsSync(databasePath)) return { ok: false };
  let database;
  try {
    // Tracked + busy_timeout-armed: a concurrent gateway holding the write
    // lock stalls this read briefly instead of failing it.
    database = openTrackedReadonlyDatabase(databasePath);
    if (
      !tableHasColumns(database, "auth_profile_stores", ["store_key", "store_json"]) ||
      !tableHasColumns(database, "auth_profile_state", ["store_key", "state_json"])
    ) {
      return { ok: false };
    }
    const secretsRow = database
      .prepare("SELECT store_json FROM auth_profile_stores WHERE store_key = ?")
      .get(kSharedAuthRowKey);
    const secrets = secretsRow?.store_json ? JSON.parse(secretsRow.store_json) : {};
    const stateRow = database
      .prepare("SELECT state_json FROM auth_profile_state WHERE store_key = ?")
      .get(kSharedAuthRowKey);
    const state = stateRow?.state_json ? JSON.parse(stateRow.state_json) : {};
    return {
      ok: true,
      store: {
        version: Number(secrets.version || state.version || 1),
        profiles: secrets.profiles || {},
        order: state.order,
        lastGood: state.lastGood,
        usageStats: state.usageStats,
      },
    };
  } catch {
    return { ok: false };
  } finally {
    database?.close();
  }
};

const saveSharedAuthStore = (store) => {
  throwIfStateDbQuiet();
  let opened;
  try {
    opened = openWritableOpenclawStateDb({ openclawDir: OPENCLAW_DIR });
    if (!opened) return false;
    const database = opened.db;
    if (
      !tableHasColumns(database, "auth_profile_stores", ["store_key", "store_json", "updated_at"]) ||
      !tableHasColumns(database, "auth_profile_state", ["store_key", "state_json", "updated_at"])
    ) {
      // Schema drift: fail closed rather than write a shape openclaw ignores.
      return false;
    }
    const now = Date.now();
    const secrets = {
      version: Number(store.version || 1),
      profiles: store.profiles || {},
    };
    const state = {
      version: Number(store.version || 1),
      ...(store.order !== undefined ? { order: store.order } : {}),
      ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
      ...(store.usageStats !== undefined ? { usageStats: store.usageStats } : {}),
    };
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO auth_profile_stores (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           store_json = excluded.store_json,
           updated_at = excluded.updated_at`,
      )
      .run(kSharedAuthRowKey, JSON.stringify(secrets), now);
    database
      .prepare(
        `INSERT INTO auth_profile_state (store_key, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(kSharedAuthRowKey, JSON.stringify(state), now);
    database.exec("COMMIT");
    return true;
  } catch {
    try {
      opened?.db?.exec("ROLLBACK");
    } catch {}
    return false;
  } finally {
    try {
      opened?.db?.close();
    } catch {}
  }
};

const resolveMainAuthBackend = () =>
  readAuthSharedStoreLocation({ openclawDir: OPENCLAW_DIR });

const resolveOpenclawConfigPath = () =>
  path.join(OPENCLAW_DIR, "openclaw.json");

const hasCompletedOnboardingConfig = (cfg) =>
  String(cfg?.agents?.defaults?.model?.primary || "").trim().includes("/");

// `strict` is the mutator contract: a load whose result feeds a
// load→mutate→save cycle must THROW on a shared-store read failure — saving
// a store built from a failed read would wipe every shared credential.
// Display reads stay lenient (an empty list beats a 500 on the models page).
const loadAuthStore = (agentId = kDefaultAgentId, { strict = false } = {}) => {
  if (strict) throwIfStateDbQuiet();
  // Lenient read while the barrier holds: every store (shared db, agent db,
  // auth-profiles.json) lives in the state tree being snapshotted, and the
  // shared-store location itself reads as "unreadable" — which would degrade
  // a migrated box to the stale/empty agent db. Say "unavailable" instead.
  if (isStateDbQuiet()) return unavailableAuthStore();
  if (agentId === kDefaultAgentId) {
    const backend = resolveMainAuthBackend();
    if (backend === "state-db") {
      // Post-relocation the shared db is the only store openclaw reads.
      const shared = loadSharedAuthStore();
      if (shared.ok) return shared.store;
      if (strict) {
        throw new Error(
          "Could not read the shared OpenClaw auth store (state/openclaw.sqlite is busy or its schema changed) — retry shortly",
        );
      }
      return { version: 1, profiles: {} };
    }
    if (backend === "unreadable" && strict) {
      // Mirror saveAuthStore: a mutator must not build its save from the
      // agent db when the box may already be migrated.
      throw new Error(
        "Could not determine the OpenClaw auth store location (state/openclaw.sqlite is busy) — retry shortly",
      );
    }
    // "unreadable" (transient lock), lenient read: the agent db is a safe
    // stale fallback for display — the WRITE path fails closed instead.
  }
  const sqliteStore = loadSqliteAuthStore(agentId);
  if (sqliteStore) return sqliteStore;
  const storePath = resolveAuthProfilesPath(agentId);
  let store = { version: 1, profiles: {} };
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.profiles &&
        typeof parsed.profiles === "object"
      ) {
        store = {
          version: Number(parsed.version || 1),
          profiles: parsed.profiles,
          order: parsed.order,
          lastGood: parsed.lastGood,
          usageStats: parsed.usageStats,
        };
      }
    }
  } catch {}
  return store;
};

const saveAuthStore = (agentId, store) => {
  throwIfStateDbQuiet();
  if (agentId === kDefaultAgentId) {
    const backend = resolveMainAuthBackend();
    if (backend === "state-db") {
      if (!saveSharedAuthStore(store)) {
        // Never fall back to the agent db / JSON here: openclaw ignores both
        // after the relocation, so a "successful" fallback save silently
        // loses the credential — the exact failure class issue #23 is about.
        throw new Error(
          "Could not write the shared OpenClaw auth store (state/openclaw.sqlite is busy or its schema changed) — retry shortly",
        );
      }
      return;
    }
    if (backend === "unreadable") {
      // A transient lock on a possibly-migrated box: writing the agent db
      // could recreate the relocated 'primary' rows openclaw ignores (and
      // doctor then flags forever). Fail closed; the caller can retry.
      throw new Error(
        "Could not determine the OpenClaw auth store location (state/openclaw.sqlite is busy) — retry shortly",
      );
    }
  }
  if (saveSqliteAuthStore(agentId, store)) return;
  const storePath = resolveAuthProfilesPath(agentId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        version: Number(store.version || 1),
        profiles: store.profiles || {},
        ...(store.order !== undefined ? { order: store.order } : {}),
        ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
        ...(store.usageStats !== undefined
          ? { usageStats: store.usageStats }
          : {}),
      },
      null,
      2,
    ),
  );
};

const loadOpenclawConfig = () => {
  const configPath = resolveOpenclawConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
};

const canSyncOpenclawAuthReferences = () => {
  const configPath = resolveOpenclawConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return hasCompletedOnboardingConfig(cfg);
  } catch {
    return false;
  }
};

const saveOpenclawConfig = (cfg) => {
  const configPath = resolveOpenclawConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
};

const syncConfigAuthReference = (cfg, profileId, credential) => {
  const next = { ...cfg };
  if (!next.auth) next.auth = {};
  if (!next.auth.profiles) next.auth.profiles = {};
  next.auth = { ...next.auth, profiles: { ...next.auth.profiles } };
  next.auth.profiles[profileId] = {
    provider: credential.provider,
    mode: credentialMode(credential),
  };
  return next;
};

const removeConfigAuthReference = (cfg, profileId) => {
  if (!cfg.auth?.profiles?.[profileId]) return cfg;
  const next = { ...cfg };
  next.auth = { ...next.auth, profiles: { ...next.auth.profiles } };
  delete next.auth.profiles[profileId];
  if (Object.keys(next.auth.profiles).length === 0) {
    delete next.auth.profiles;
  }
  if (Object.keys(next.auth).length === 0) {
    delete next.auth;
  }
  return next;
};

const createAuthProfiles = () => {
  // ── Generic profile operations ──

  const listProfiles = (agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    return Object.entries(store.profiles || {}).map(([id, cred]) => ({
      id,
      ...cred,
    }));
  };

  const listProfilesByProvider = (provider, agentId = kDefaultAgentId) =>
    listProfiles(agentId).filter((p) => p.provider === provider);

  const getProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    const cred = store.profiles?.[profileId];
    if (!cred) return null;
    return { id: profileId, ...cred };
  };

  const upsertProfile = (profileId, credential, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId, { strict: true });
    const sanitized = { ...credential };
    if (sanitized.key) sanitized.key = normalizeSecret(sanitized.key);
    if (sanitized.token) sanitized.token = normalizeSecret(sanitized.token);
    if (sanitized.access) sanitized.access = normalizeSecret(sanitized.access);
    if (sanitized.refresh)
      sanitized.refresh = normalizeSecret(sanitized.refresh);
    store.profiles[profileId] = sanitized;
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return;
    const cfg = loadOpenclawConfig();
    const updated = syncConfigAuthReference(cfg, profileId, sanitized);
    saveOpenclawConfig(updated);
  };

  const removeProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId, { strict: true });
    if (!store.profiles[profileId]) return false;
    delete store.profiles[profileId];
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return true;
    const cfg = loadOpenclawConfig();
    const updated = removeConfigAuthReference(cfg, profileId);
    saveOpenclawConfig(updated);
    return true;
  };

  const setAuthOrder = (provider, orderedProfileIds, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId, { strict: true });
    if (!store.order) store.order = {};
    store.order[provider] = orderedProfileIds;
    saveAuthStore(agentId, store);
  };

  const syncConfigAuthReferencesForAgent = (agentId = kDefaultAgentId) => {
    if (!canSyncOpenclawAuthReferences()) return;
    const store = loadAuthStore(agentId);
    let cfg = loadOpenclawConfig();
    for (const [profileId, credential] of Object.entries(store.profiles || {})) {
      if (!credential?.type || !credential?.provider) continue;
      cfg = syncConfigAuthReference(cfg, profileId, credential);
    }
    saveOpenclawConfig(cfg);
  };

  const upsertApiKeyProfileForEnvVar = (
    provider,
    rawValue,
    agentId = kDefaultAgentId,
  ) => {
    const key = normalizeSecret(rawValue);
    if (!provider || !key) return false;
    upsertProfile(
      getDefaultProfileIdForApiKeyProvider(provider),
      {
        type: "api_key",
        provider,
        key,
      },
      agentId,
    );
    return true;
  };

  const removeApiKeyProfileForEnvVar = (provider, agentId = kDefaultAgentId) => {
    const profileId = getDefaultProfileIdForApiKeyProvider(provider);
    if (!profileId) return false;
    const existing = getProfile(profileId, agentId);
    if (!existing) return false;
    if (existing.type !== "api_key" || existing.provider !== provider) return false;
    return removeProfile(profileId, agentId);
  };

  // ── Model config operations ──

  const preserveCodexRuntimeModels = (configuredModels) => {
    const models =
      configuredModels && typeof configuredModels === "object"
        ? configuredModels
        : {};
    if (!hasCodexOauthProfile()) return models;
    return Object.fromEntries(
      Object.entries(models).map(([modelKey, modelConfig]) => {
        if (!modelKey.startsWith("openai/gpt-")) {
          return [modelKey, modelConfig];
        }
        return [
          modelKey,
          {
            ...(modelConfig && typeof modelConfig === "object"
              ? modelConfig
              : {}),
            agentRuntime: { id: "codex" },
          },
        ];
      }),
    );
  };

  const getModelConfig = () => {
    const cfg = loadOpenclawConfig();
    const defaults = cfg.agents?.defaults || {};
    const configuredModels = preserveCodexRuntimeModels(defaults.models || {});
    const modelsChanged =
      JSON.stringify(configuredModels) !== JSON.stringify(defaults.models || {});
    if (modelsChanged) {
      cfg.agents.defaults.models = configuredModels;
    }
    const pluginsChanged = ensureCodexRuntimePlugin(cfg);
    if (modelsChanged || pluginsChanged) {
      saveOpenclawConfig(cfg);
    }
    return {
      primary: defaults.model?.primary || null,
      configuredModels,
    };
  };

  const setModelConfig = ({ primary, configuredModels }) => {
    const cfg = loadOpenclawConfig();
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    if (primary !== undefined) {
      cfg.agents.defaults.model.primary = primary;
    }
    if (configuredModels !== undefined) {
      cfg.agents.defaults.models = preserveCodexRuntimeModels(configuredModels);
    }
    ensureCodexRuntimePlugin(cfg);
    saveOpenclawConfig(cfg);
  };

  // ── Legacy Codex-specific wrappers ──

  const listCodexProfiles = () =>
    listProfiles().filter(
      (profile) =>
        profile.type === "oauth" &&
        (profile.provider === "openai" || profile.provider === "openai-codex"),
    );

  const getCodexProfile = () => {
    const profiles = listCodexProfiles();
    if (profiles.length === 0) return null;
    const preferred =
      profiles.find((p) => p.id === CODEX_PROFILE_ID) || profiles[0];
    return { profileId: preferred.id, ...preferred };
  };

  const hasCodexOauthProfile = () => {
    const profile = getCodexProfile();
    return !!(profile?.access && profile?.refresh);
  };

  // In-memory only (no fs/sqlite): the marker lenient reads return while the
  // quiet barrier holds, for routes whose response shape cannot carry it
  // (getCodexProfile() answers null, which reads as "disconnected").
  const getAuthStoreAvailability = () =>
    isStateDbQuiet()
      ? { unavailable: true, reason: kBackupInProgressCode }
      : { unavailable: false, reason: null };

  const upsertCodexProfile = ({ access, refresh, expires, accountId }) => {
    upsertProfile(CODEX_PROFILE_ID, {
      type: "oauth",
      provider: "openai",
      access,
      refresh,
      expires,
      ...(accountId ? { accountId } : {}),
    });
  };

  const removeCodexProfiles = () => {
    const store = loadAuthStore(kDefaultAgentId, { strict: true });
    let changed = false;
    for (const [id, cred] of Object.entries(store.profiles || {})) {
      if (
        cred?.type === "oauth" &&
        (cred.provider === "openai" || cred.provider === "openai-codex")
      ) {
        delete store.profiles[id];
        changed = true;
      }
    }
    if (changed) {
      saveAuthStore(kDefaultAgentId, store);
      if (!canSyncOpenclawAuthReferences()) return changed;
      let cfg = loadOpenclawConfig();
      for (const [id, cred] of Object.entries(cfg.auth?.profiles || {})) {
        if (
          cred?.mode === "oauth" &&
          (cred.provider === "openai" || cred.provider === "openai-codex")
        ) {
          cfg = removeConfigAuthReference(cfg, id);
        }
      }
      saveOpenclawConfig(cfg);
    }
    return changed;
  };

  return {
    listProfiles,
    listProfilesByProvider,
    getProfile,
    upsertProfile,
    removeProfile,
    setAuthOrder,
    syncConfigAuthReferencesForAgent,
    upsertApiKeyProfileForEnvVar,
    removeApiKeyProfileForEnvVar,
    getEnvVarForApiKeyProvider,
    listApiKeyProviders,
    getDefaultProfileIdForApiKeyProvider,
    getModelConfig,
    setModelConfig,
    getCodexProfile,
    hasCodexOauthProfile,
    getAuthStoreAvailability,
    upsertCodexProfile,
    removeCodexProfiles,
    loadAuthStore,
  };
};

module.exports = { createAuthProfiles, getEnvVarForApiKeyProvider };
