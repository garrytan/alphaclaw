const fs = require("fs");
const path = require("path");
const { CODEX_PROFILE_ID, OPENCLAW_DIR } = require("./constants");
const { ensureCodexRuntimePlugin } = require("./codex-runtime-config");
const { updateOpenclawConfig } = require("./openclaw-config");
const { loadAuthStore, mutateAuthStore, refreshAuthStoreRuntime } = require("./auth-store");
const { isStateDbQuiet, whenStateDbQuietReleased } = require("./state-db-quiet");
const kDefaultAgentId = "main";

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

const resolveOpenclawConfigPath = () => path.join(OPENCLAW_DIR, "openclaw.json");
const hasCompletedOnboardingConfig = (cfg) =>
  String(cfg?.agents?.defaults?.model?.primary || "").trim().includes("/");

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

// Every openclaw.json write goes through ONE locked read-modify-write
// (fix wave F213, P1). The old load→save pair parsed with a `{}` fallback and
// wrote raw, so a JSON5-commented or torn file was rewritten from scratch —
// the config wipe class. updateOpenclawConfig reads inside its own lock via
// readOpenclawConfigForWrite (throws OPENCLAW_CONFIG_UNREADABLE for an
// existing-but-unparseable file; ENOENT is a legitimate empty config) and
// writes atomically, preserving the on-disk agents shape. Mutators here must
// edit `cfg` IN PLACE — the helper writes the object it handed out.
const replaceInPlace = (target, next) => {
  if (next === target || !next || typeof next !== "object") return target;
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
  Object.assign(target, next);
  return target;
};

const mutateOpenclawConfig = (mutator) =>
  updateOpenclawConfig({
    fsModule: fs,
    openclawDir: OPENCLAW_DIR,
    mutate: (cfg) => {
      const next = mutator(cfg);
      if (next && typeof next === "object" && next !== cfg) replaceInPlace(cfg, next);
      return {};
    },
  });

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

const createAuthProfiles = ({ prepareFreshStore, refreshRuntime = refreshAuthStoreRuntime } = {}) => {
  const mutateStore = (agentId, mutate) => mutateAuthStore(agentId, mutate, prepareFreshStore);
  const refreshGatewayAuth = async (agentId, restartRequiredState) => {
    const result = await refreshRuntime(agentId);
    if (result.refreshed) return { authRuntimeRefreshed: true };
    if (restartRequiredState) {
      const markRestartRequired = () => restartRequiredState.markRequired("config_changed");
      if (isStateDbQuiet()) whenStateDbQuietReleased(markRestartRequired);
      else markRestartRequired();
    }
    return { authRuntimeRefreshed: false, restartRequired: true, warning: "Credential changes were saved, but the gateway could not refresh them. Restart the gateway to apply the change." };
  };
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
    const sanitized = { ...credential };
    if (sanitized.key) sanitized.key = normalizeSecret(sanitized.key);
    if (sanitized.token) sanitized.token = normalizeSecret(sanitized.token);
    if (sanitized.access) sanitized.access = normalizeSecret(sanitized.access);
    if (sanitized.refresh)
      sanitized.refresh = normalizeSecret(sanitized.refresh);
    mutateStore(agentId, (store) => {
      const existing = store.profiles[profileId];
      const next = existing?.type === sanitized.type && existing?.provider === sanitized.provider
        ? { ...existing, ...sanitized }
        : sanitized;
      const field = sanitized.type === "api_key" ? "key" : sanitized.type === "token" ? "token" : null;
      if (field && sanitized[field] && !Object.hasOwn(sanitized, `${field}Ref`)) {
        delete next[`${field}Ref`];
      }
      store.profiles[profileId] = next;
    });

    if (!canSyncOpenclawAuthReferences()) return;
    mutateOpenclawConfig((cfg) => syncConfigAuthReference(cfg, profileId, sanitized));
  };

  const removeProfile = (profileId, agentId = kDefaultAgentId) => {
    const removed = mutateStore(agentId, (store) => {
      if (!Object.hasOwn(store.profiles, profileId)) return false;
      delete store.profiles[profileId];
      return true;
    });
    if (!removed) return false;

    if (!canSyncOpenclawAuthReferences()) return true;
    mutateOpenclawConfig((cfg) => removeConfigAuthReference(cfg, profileId));
    return true;
  };

  const setAuthOrder = (provider, orderedProfileIds, agentId = kDefaultAgentId) => {
    mutateStore(agentId, (store) => {
      if (!store.order) store.order = {};
      store.order[provider] = orderedProfileIds;
    });
  };

  const syncConfigAuthReferencesForAgent = (agentId = kDefaultAgentId) => {
    if (!canSyncOpenclawAuthReferences()) return;
    const store = loadAuthStore(agentId, { strict: true });
    mutateOpenclawConfig((initial) => {
      let cfg = initial;
      for (const [profileId, credential] of Object.entries(store.profiles || {})) {
        if (!credential?.type || !credential?.provider) continue;
        cfg = syncConfigAuthReference(cfg, profileId, credential);
      }
      return cfg;
    });
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
    const removed = mutateStore(agentId, (store) => {
      const existing = store.profiles[profileId];
      if (existing?.type !== "api_key" || existing.provider !== provider) return false;
      delete store.profiles[profileId];
      return true;
    });
    if (removed && canSyncOpenclawAuthReferences()) {
      mutateOpenclawConfig((cfg) => removeConfigAuthReference(cfg, profileId));
    }
    return removed;
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
    // Lenient read for the answer; the normalization write below goes through
    // the fail-closed mutator, so an unparseable file is REPORTED (warn) and
    // left alone instead of being rewritten as `{plugins: …}` (the wipe).
    const cfg = loadOpenclawConfig();
    const defaults = cfg.agents?.defaults || {};
    const configuredModels = preserveCodexRuntimeModels(defaults.models || {});
    const modelsChanged =
      JSON.stringify(configuredModels) !== JSON.stringify(defaults.models || {});
    const pluginsChanged = ensureCodexRuntimePlugin(structuredClone(cfg));
    if (modelsChanged || pluginsChanged) {
      try {
        mutateOpenclawConfig((live) => {
          if (modelsChanged) {
            if (!live.agents) live.agents = {};
            if (!live.agents.defaults) live.agents.defaults = {};
            live.agents.defaults.models = configuredModels;
          }
          ensureCodexRuntimePlugin(live);
        });
      } catch (error) {
        if (error?.code !== "OPENCLAW_CONFIG_UNREADABLE") throw error;
        console.warn(`[auth-profiles] skipped model-config normalization: ${error.message}`);
      }
    }
    return {
      primary: defaults.model?.primary || null,
      configuredModels,
    };
  };

  const setModelConfig = ({ primary, configuredModels }) =>
    mutateOpenclawConfig((cfg) => {
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
    });

  // ── Legacy Codex-specific wrappers ──

  const listCodexProfiles = ({ strict = false } = {}) =>
    Object.entries(loadAuthStore(kDefaultAgentId, { strict }).profiles).map(([id, credential]) => ({ id, ...credential })).filter(
      (profile) =>
        profile.type === "oauth" &&
        (profile.provider === "openai" || profile.provider === "openai-codex"),
    );

  const getCodexProfile = (options) => {
    const profiles = listCodexProfiles(options);
    if (profiles.length === 0) return null;
    const preferred =
      profiles.find((p) => p.id === CODEX_PROFILE_ID) || profiles[0];
    return { profileId: preferred.id, ...preferred };
  };

  const hasCodexOauthProfile = () => {
    const profile = getCodexProfile();
    return !!(profile?.access && profile?.refresh);
  };

  const getAuthStoreAvailability = (agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    return { unavailable: store.unavailable === true, reason: store.reason || null };
  };

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
    const changed = mutateStore(kDefaultAgentId, (store) => {
      let removed = false;
      for (const [id, cred] of Object.entries(store.profiles || {})) {
        if (
          cred?.type === "oauth" &&
          (cred.provider === "openai" || cred.provider === "openai-codex")
        ) {
          delete store.profiles[id];
          removed = true;
        }
      }
      return removed;
    });
    if (changed) {
      if (!canSyncOpenclawAuthReferences()) return changed;
      mutateOpenclawConfig((initial) => {
        let cfg = initial;
        for (const [id, cred] of Object.entries(cfg.auth?.profiles || {})) {
          if (
            cred?.mode === "oauth" &&
            (cred.provider === "openai" || cred.provider === "openai-codex")
          ) {
            cfg = removeConfigAuthReference(cfg, id);
          }
        }
        return cfg;
      });
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
    refreshGatewayAuth,
    loadAuthStore,
  };
};

module.exports = { createAuthProfiles, getEnvVarForApiKeyProvider };
