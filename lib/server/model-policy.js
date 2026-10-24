const { isNonArrayObject } = require("./utils/object");

// OpenClaw 2026.10 restricts which models an agent may run. The allowlist is
// the agent's own `modelPolicy.allow` when it has one, otherwise
// `agents.defaults.modelPolicy.allow`, otherwise (before Doctor's
// `meta.migrations.modelPolicyAllowlist` migration) the keys of
// `agents.defaults.models`. An empty list allows every model. A configured
// primary outside the list is not refused: OpenClaw quietly runs an allowed
// model instead (agent-command's resolveSelection), so a model picked in
// AlphaClaw never takes effect. Choosing a primary here is the operator's
// consent to run it, so add it to the list that governs it.
const coversModel = (refs, modelKey) => {
  const provider = modelKey.slice(0, modelKey.indexOf("/"));
  return refs.some((ref) => {
    const value = String(ref || "").trim();
    return value === modelKey || value === `${provider}/*`;
  });
};

const appendToPolicy = (policy, modelKey) => {
  if (!Array.isArray(policy.allow) || policy.allow.length === 0) return;
  if (coversModel(policy.allow, modelKey)) return;
  policy.allow = [...policy.allow, modelKey];
};

const allowPrimaryModel = (cfg, modelKey, agent = null) => {
  const key = String(modelKey || "").trim();
  if (!key.includes("/") || !isNonArrayObject(cfg)) return;
  if (isNonArrayObject(agent?.modelPolicy) && Object.hasOwn(agent.modelPolicy, "allow")) {
    appendToPolicy(agent.modelPolicy, key);
    return;
  }
  const defaults = cfg.agents?.defaults;
  if (!isNonArrayObject(defaults)) return;
  if (isNonArrayObject(defaults.modelPolicy) && Object.hasOwn(defaults.modelPolicy, "allow")) {
    appendToPolicy(defaults.modelPolicy, key);
    return;
  }
  if (cfg.meta?.migrations?.modelPolicyAllowlist === true) return;
  if (!isNonArrayObject(defaults.models)) return;
  const refs = Object.keys(defaults.models).filter((ref) => ref.trim());
  if (refs.length === 0 || coversModel(refs, key)) return;
  defaults.models[key] = {};
};

module.exports = { allowPrimaryModel };
