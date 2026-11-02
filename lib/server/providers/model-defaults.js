// Per-model thinking defaults of AlphaClaw's provider presets
// (presets.js `thinkingDefaults`). OpenClaw reads a per-model thinking level
// only from the model's agents.defaults.models row (`params.thinking`); the
// provider block's model row has no such field. Without one, OpenClaw
// 2026.10.9 sends Particle reasoning_effort "low".
//
// The value is filled in only where the operator expressed nothing: the row
// has no own `thinking` param (any value, false included, is theirs) and
// agents.defaults.thinkingDefault is unset (a per-model param beats it in
// OpenClaw, so writing ours would override their global choice). A row is
// never created: before Doctor's modelPolicyAllowlist migration the keys of
// agents.defaults.models are the allowlist, and after it every row is a
// modelPolicy gap the launch adds to modelPolicy.allow. `openclaw models set`
// and the Models tab create the row for every model picked.
//
// Written only at a gateway launch, like modelPolicy (model-policy.js), so a
// running gateway never hot reloads it.
const { updateOpenclawConfig } = require("../openclaw-config");
const { isNonArrayObject } = require("../utils/object");
const { isEnvValueSet } = require("./ensure");
const { kOwnedProviderPresets } = require("./presets");

// In-memory: returns [{ ref, thinking }] for each row it filled in.
const applyOwnedProviderThinkingDefaults = (config, { env = process.env, presets = kOwnedProviderPresets } = {}) => {
  const defaults = config?.agents?.defaults;
  if (!isNonArrayObject(defaults) || !isNonArrayObject(defaults.models) || defaults.thinkingDefault) return [];
  const applied = [];
  for (const preset of presets) {
    if (!isEnvValueSet(env[preset.envVar])) continue;
    for (const [modelId, thinking] of Object.entries(preset.thinkingDefaults || {})) {
      const ref = `${preset.id}/${modelId}`;
      const row = defaults.models[ref];
      if (!isNonArrayObject(row)) continue;
      if (row.params !== undefined && !isNonArrayObject(row.params)) continue;
      if (Object.hasOwn(row.params || {}, "thinking")) continue;
      row.params = { ...row.params, thinking };
      applied.push({ ref, thinking });
    }
  }
  return applied;
};

// The launch-side writer. Call it only while no gateway serves. Never throws:
// a failure leaves the row for the next launch and never blocks this one.
const applyOwnedProviderThinkingDefaultsBeforeLaunch = ({ openclawDir, env = process.env, logger = console } = {}) => {
  try {
    const outcome = updateOpenclawConfig({
      openclawDir,
      mutate: (config) => {
        const applied = applyOwnedProviderThinkingDefaults(config, { env });
        return applied.length ? { applied } : { applied, skipWrite: true };
      },
    });
    for (const { ref, thinking } of outcome.applied) {
      logger.log?.(`[alphaclaw] provider defaults: agents.defaults.models["${ref}"].params.thinking=${thinking} before launch`);
    }
    return { ok: true, applied: outcome.applied };
  } catch (error) {
    logger.warn?.(`[alphaclaw] provider defaults: update before launch failed (${error?.code || error?.message || "unknown error"}); retried on the next launch`);
    return { ok: false, applied: [] };
  }
};

module.exports = { applyOwnedProviderThinkingDefaults, applyOwnedProviderThinkingDefaultsBeforeLaunch };
