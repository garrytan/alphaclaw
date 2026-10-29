// Keeps the models.providers blocks of AlphaClaw's provider presets
// (./presets.js) in openclaw.json while their env var is set.
//
// Ownership: AlphaClaw owns only the keys it writes (baseUrl, api, apiKey and
// its own model rows). It writes the block when it is absent, upgrades it when
// those keys still match a subset an earlier release wrote, and otherwise
// leaves it alone as the operator's (the model check reports it). Keys it does
// not own (an operator's timeoutSeconds, extra model rows, fields OpenClaw
// adds) are preserved. It never removes a block, never writes a key value
// (the block refers to the env var) and never touches the model allowlists.
// Choosing a model stays with the explicit model routes; when a
// modelPolicy.allow list governs, the model joins it at the next gateway
// launch (model-policy.js), because a modelPolicy hot reload revokes
// in-flight session work on OpenClaw 2026.10.8. A models.providers write is
// safe to hot reload.
const { isDeepStrictEqual } = require("node:util");
const { updateOpenclawConfig } = require("../openclaw-config");
const { isNonArrayObject } = require("../utils/object");
const { kOwnedProviderPresets } = require("./presets");

const kPlaceholderEnvValue = "placeholder";

const isEnvValueSet = (value) => {
  const text = String(value ?? "").trim();
  return !!text && text !== kPlaceholderEnvValue;
};

const envRefFor = (preset) => `\${${preset.envVar}}`;

const canonicalOwnedSubset = (preset) => ({
  baseUrl: preset.baseUrl,
  api: preset.api,
  apiKey: envRefFor(preset),
  models: preset.models,
});

const ownedSubsetOf = (block, preset) => {
  const rows = Array.isArray(block?.models) ? block.models : [];
  return {
    baseUrl: block?.baseUrl,
    api: block?.api,
    apiKey: block?.apiKey,
    models: preset.models.map((model) => rows.find((row) => row?.id === model.id) || null),
  };
};

// absent | current | previous | customized, plus the owned keys that differ
// from the canonical preset (names only, never values).
const classifyOwnedProvider = (config, preset) => {
  const block = config?.models?.providers?.[preset.id];
  if (block === undefined) return { state: "absent", differs: [] };
  if (!isNonArrayObject(block)) return { state: "customized", differs: ["block"] };
  const live = ownedSubsetOf(block, preset);
  const canonical = canonicalOwnedSubset(preset);
  if (isDeepStrictEqual(live, canonical)) return { state: "current", differs: [] };
  const differs = ["baseUrl", "api", "apiKey"].filter((key) => !isDeepStrictEqual(live[key], canonical[key]));
  preset.models.forEach((model, index) => {
    if (!isDeepStrictEqual(live.models[index], model)) differs.push(`models[${model.id}]`);
  });
  if ((preset.previousOwned || []).some((previous) => isDeepStrictEqual(live, previous))) return { state: "previous", differs };
  return { state: "customized", differs };
};

const writeCanonical = (config, preset) => {
  if (!isNonArrayObject(config.models)) config.models = {};
  if (!isNonArrayObject(config.models.providers)) config.models.providers = {};
  const existing = isNonArrayObject(config.models.providers[preset.id]) ? config.models.providers[preset.id] : {};
  const ownedIds = new Set(preset.models.map((model) => model.id));
  const otherRows = (Array.isArray(existing.models) ? existing.models : []).filter((row) => !ownedIds.has(row?.id));
  config.models.providers[preset.id] = {
    ...existing,
    baseUrl: preset.baseUrl,
    api: preset.api,
    apiKey: envRefFor(preset),
    models: [...structuredClone(preset.models), ...otherRows],
  };
};

// In-memory: apply every preset whose env var is set. Returns what it did per
// preset; `changed` says whether config was modified.
const applyOwnedProviders = (config, { env = process.env, presets = kOwnedProviderPresets } = {}) => {
  const results = [];
  let changed = false;
  for (const preset of presets) {
    if (!isEnvValueSet(env[preset.envVar])) continue;
    const { state, differs } = classifyOwnedProvider(config, preset);
    if (state === "absent" || state === "previous") {
      writeCanonical(config, preset);
      changed = true;
      results.push({ id: preset.id, action: state === "absent" ? "written" : "upgraded" });
    } else {
      results.push({ id: preset.id, action: state === "current" ? "unchanged" : "left_customized", ...(differs.length ? { differs } : {}) });
    }
  }
  return { changed, results };
};

// The route-side writer: one locked read-modify-write that skips the write
// when nothing changes. Never throws; a failure (lock timeout, a 409 while
// Delete Agent holds the config, an unreadable file) comes back as a warning.
const ensureOwnedProviders = ({ openclawDir, env = process.env, presets = kOwnedProviderPresets, logger = console } = {}) => {
  if (!presets.some((preset) => isEnvValueSet(env[preset.envVar]))) return { ok: true, changed: false, results: [] };
  try {
    const outcome = updateOpenclawConfig({
      openclawDir,
      mutate: (config) => {
        const applied = applyOwnedProviders(config, { env, presets });
        return applied.changed ? applied : { ...applied, skipWrite: true };
      },
    });
    for (const result of outcome.results || []) {
      if (result.action === "written" || result.action === "upgraded") {
        logger.log?.(`[alphaclaw] provider ${result.id}: models.providers.${result.id} ${result.action}`);
      }
    }
    return { ok: true, changed: outcome.changed === true, results: outcome.results || [] };
  } catch (error) {
    const warning = `Saved, but writing the provider config failed (${error?.code || error?.message || "unknown error"}); it is retried on the next save or restart.`;
    logger.warn?.(`[alphaclaw] ${warning}`);
    return { ok: false, changed: false, results: [], warning };
  }
};

const ownedProviderEnvVars = (presets = kOwnedProviderPresets) => presets.map((preset) => preset.envVar);

module.exports = {
  applyOwnedProviders,
  classifyOwnedProvider,
  ensureOwnedProviders,
  isEnvValueSet,
  ownedProviderEnvVars,
};
