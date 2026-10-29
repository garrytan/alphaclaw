const { updateOpenclawConfig } = require("./openclaw-config");
const { isNonArrayObject } = require("./utils/object");

// OpenClaw 2026.10 restricts which models an agent may run. The allowlist is
// the agent's own `modelPolicy.allow` when it has one, otherwise
// `agents.defaults.modelPolicy.allow`, otherwise (before Doctor's
// `meta.migrations.modelPolicyAllowlist` migration) the keys of
// `agents.defaults.models`. An empty list allows every model. A configured
// primary outside the list is not refused: OpenClaw quietly runs an allowed
// model instead (agent-command's resolveSelection), so a model picked in
// AlphaClaw never takes effect. A model listed in `agents.defaults.models` but
// not in a governing `modelPolicy.allow` is refused outright. Choosing a model
// here (a primary, or a row in the Models tab) is the operator's consent to
// run it, so it is added to the list that governs it.
//
// A modelPolicy list is written only while no gateway serves. On OpenClaw
// 2026.10.8 a hot reload of any modelPolicy change, even one that only adds a
// model, revokes in-flight session events: a background exec's completion is
// refused with "Session event configuration changed" and its result never
// reaches the agent. So a save leaves the gap (findModelPolicyGaps), the
// route marks the `model_policy_pending` restart reason, and
// applyModelPolicyBeforeLaunch closes it in requestGatewayLaunch, after the
// old gateway is gone and before the new one spawns. The pre-migration
// `agents.defaults.models` allowlist is not a modelPolicy and is still written
// with the save.
const kModelPolicyPendingReason = "model_policy_pending";

const coversModel = (refs, modelKey) => {
  const provider = modelKey.slice(0, modelKey.indexOf("/"));
  return refs.some((ref) => {
    const value = String(ref || "").trim();
    return value === modelKey || value === `${provider}/*`;
  });
};

const hasPolicyAllow = (node) => isNonArrayObject(node?.modelPolicy) && Object.hasOwn(node.modelPolicy, "allow");

const primaryOf = (model) => String((typeof model === "string" ? model : model?.primary) || "").trim();

const allowPrimaryModel = (cfg, modelKey, agent = null) => {
  const key = String(modelKey || "").trim();
  if (!key.includes("/") || !isNonArrayObject(cfg)) return;
  if (hasPolicyAllow(agent)) return;
  const defaults = cfg.agents?.defaults;
  if (!isNonArrayObject(defaults) || hasPolicyAllow(defaults)) return;
  if (cfg.meta?.migrations?.modelPolicyAllowlist === true) return;
  if (!isNonArrayObject(defaults.models)) return;
  const refs = Object.keys(defaults.models).filter((ref) => ref.trim());
  if (refs.length === 0 || coversModel(refs, key)) return;
  defaults.models[key] = {};
};

// The refs a governing modelPolicy.allow is missing: [{ agentId, ref }], where
// agentId null is agents.defaults. The defaults list governs the defaults
// primary, every agents.defaults.models row and the primary of each agent
// without its own list; an agent's own list governs that agent's primary.
const findModelPolicyGaps = (cfg) => {
  const gaps = [];
  const agentsNode = isNonArrayObject(cfg?.agents) ? cfg.agents : {};
  const defaults = isNonArrayObject(agentsNode.defaults) ? agentsNode.defaults : {};
  const list = Array.isArray(agentsNode.list) ? agentsNode.list.filter(isNonArrayObject) : [];
  const check = (node, agentId, refs) => {
    const allow = node.modelPolicy.allow;
    if (!Array.isArray(allow) || allow.length === 0) return;
    const missing = [];
    for (const ref of refs) {
      if (!ref.includes("/") || coversModel(allow, ref) || missing.includes(ref)) continue;
      missing.push(ref);
    }
    for (const ref of missing) gaps.push({ agentId, ref });
  };
  if (hasPolicyAllow(defaults)) {
    check(defaults, null, [
      primaryOf(defaults.model),
      ...Object.keys(isNonArrayObject(defaults.models) ? defaults.models : {}).map((ref) => ref.trim()),
      ...list.filter((agent) => !hasPolicyAllow(agent)).map((agent) => primaryOf(agent.model)),
    ]);
  }
  for (const agent of list) {
    if (hasPolicyAllow(agent)) check(agent, String(agent.id || "").trim(), [primaryOf(agent.model)]);
  }
  return gaps;
};

const applyModelPolicyGaps = (cfg) => {
  const gaps = findModelPolicyGaps(cfg);
  for (const { agentId, ref } of gaps) {
    const node = agentId === null
      ? cfg.agents.defaults
      : cfg.agents.list.find((agent) => isNonArrayObject(agent) && String(agent.id || "").trim() === agentId);
    node.modelPolicy.allow = [...node.modelPolicy.allow, ref];
  }
  return gaps;
};

// The save side: a save that leaves a gap marks the restart reason and tells
// the caller which models wait for it. Never throws.
const noteModelPolicyGaps = ({ readConfig, restartRequiredState = null } = {}) => {
  try {
    const refs = [...new Set(findModelPolicyGaps(readConfig()).map((gap) => gap.ref))];
    if (!refs.length) return {};
    restartRequiredState?.markRequired?.(kModelPolicyPendingReason);
    return {
      modelPolicyPending: refs,
      modelPolicyWarning: `Saved. ${refs.join(", ")} ${refs.length === 1 ? "is" : "are"} added to the model policy (modelPolicy.allow) when the gateway restarts, and OpenClaw refuses ${refs.length === 1 ? "it" : "them"} until then. AlphaClaw changes the model policy only at a restart, because changing it while the gateway runs interrupts running work.`,
    };
  } catch {
    return {};
  }
};

// The launch-side writer. Call it only while no gateway serves. Never throws:
// a failure leaves the gap for the next launch and never blocks this one.
const applyModelPolicyBeforeLaunch = ({ openclawDir, logger = console } = {}) => {
  try {
    const outcome = updateOpenclawConfig({
      openclawDir,
      mutate: (config) => {
        const added = applyModelPolicyGaps(config);
        return added.length ? { added } : { added, skipWrite: true };
      },
    });
    for (const { agentId, ref } of outcome.added) {
      logger.log?.(`[alphaclaw] model policy: added ${ref} to ${agentId === null ? "agents.defaults" : `agent ${agentId}`} modelPolicy.allow before launch`);
    }
    return { ok: true, added: outcome.added };
  } catch (error) {
    logger.warn?.(`[alphaclaw] model policy: update before launch failed (${error?.code || error?.message || "unknown error"}); retried on the next launch`);
    return { ok: false, added: [] };
  }
};

module.exports = {
  allowPrimaryModel,
  applyModelPolicyBeforeLaunch,
  applyModelPolicyGaps,
  findModelPolicyGaps,
  kModelPolicyPendingReason,
  noteModelPolicyGaps,
};
