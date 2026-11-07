import {
  getAuthProviderFromModelProvider,
  getEnvKeyProvider,
  getModelProvider,
  kProviderLabels,
  kProviderOrder,
} from "../../lib/model-config.js";
import { formatRelativeTime } from "../../lib/format.js";

// Pure view-models for Models & keys. Nothing here fetches;
// every word comes from the models config, the model check and GET /api/env.

const resolveAgentModel = (model) => {
  if (!model) return "";
  if (typeof model === "string") return model.trim();
  return String(model.primary || "").trim();
};

const agentLabel = (agent) => String(agent?.name || agent?.id || "").trim();

export const getProviderLabel = (provider) => kProviderLabels[provider] || provider;

export const getModelGroupProvider = (modelKey) =>
  getAuthProviderFromModelProvider(getModelProvider(modelKey));

export const buildModelsHeadline = ({ ready = false, primary = "", primaryLabel = "" } = {}) => {
  if (!ready) return "Loading the default model…";
  if (!primary) return "No default model yet. Add a model to start.";
  return (primaryLabel || primary) + " is the default for this box.";
};

// "Box default" plus the agents that inherit it, then agents with an
// override (an override equal to the default still inherits it).
export const buildUsedBy = ({ modelKey = "", primary = "", agents = [] } = {}) => {
  const isPrimary = !!primary && modelKey === primary;
  const inheriting = [];
  const overriding = [];
  for (const agent of Array.isArray(agents) ? agents : []) {
    const own = resolveAgentModel(agent?.model);
    if (!own || own === primary) {
      if (isPrimary) inheriting.push(agentLabel(agent));
    } else if (own === modelKey) {
      overriding.push(agentLabel(agent));
    }
  }
  return [...(isPrimary ? ["Box default", ...inheriting] : []), ...overriding].filter(Boolean);
};

const kCheckWords = {
  ok: { word: "Passed", tone: "success" },
  error: { word: "Failed", tone: "danger" },
  warn: { word: "Check again", tone: "warning" },
};

const findCheckResult = (lastRun, modelKey) =>
  (lastRun?.results || []).find(
    (result) => result?.ref === modelKey || (result?.aliases || []).includes(modelKey),
  ) || null;

// The check column: only a check result earns a word other than Not checked.
export const describeModelCheck = ({ lastRun = null, modelKey = "", running = false } = {}) => {
  if (running) return { word: "Checking…", tone: "neutral", fix: "" };
  const result = findCheckResult(lastRun, modelKey);
  const known = result ? kCheckWords[result.severity] : null;
  if (!known) return { word: "Not checked", tone: "neutral", fix: "" };
  return { ...known, fix: result.severity === "ok" ? "" : String(result.fix || result.reason || "") };
};

export const buildCheckSummary = ({ lastRun = null, loading = false, nowMs = Date.now() } = {}) => {
  if (loading && !lastRun) return "Loading the last check…";
  if (!lastRun) return "No check has run since AlphaClaw started.";
  const results = lastRun.results || [];
  const passed = results.filter((result) => result?.severity === "ok").length;
  const failed = results.filter((result) => result?.severity === "error").length;
  return (
    "Checked " +
    formatRelativeTime(lastRun.checkedAt, { nowMs, style: "long" }) +
    ": " +
    passed +
    " passed, " +
    failed +
    " failed."
  );
};

export const buildModelRows = ({
  configuredModels = {},
  catalog = [],
  primary = "",
  agents = [],
  lastRun = null,
  running = false,
  labelFor = (entry) => entry?.label || entry?.key,
} = {}) => {
  const configured = Object.keys(configuredModels || {});
  // The default model runs even when the allowlist does not name it, so it
  // always gets a row: a headline naming it over an empty table contradicts.
  const keys = primary && !configured.includes(primary) ? [primary, ...configured] : configured;
  return keys.map((key) => {
    const catalogEntry = (catalog || []).find((model) => model?.key === key) || { key };
    const provider = getModelGroupProvider(key);
    return {
      key,
      configured: configured.includes(key),
      label: labelFor(catalogEntry) || key,
      provider,
      providerLabel: getProviderLabel(provider),
      isPrimary: key === primary,
      usedBy: buildUsedBy({ modelKey: key, primary, agents }),
      check: describeModelCheck({ lastRun, modelKey: key, running }),
    };
  });
};

// A provider group's word comes from the model check alone: no API proves a
// key is "connected", so a group with no check result carries no word.
export const describeProviderCheck = ({ lastRun = null, provider = "" } = {}) => {
  const results = (lastRun?.results || []).filter((result) => getModelGroupProvider(result?.ref) === provider);
  if (results.length === 0) return null;
  if (results.some((result) => result?.severity === "error")) return { word: "Check failed", tone: "danger" };
  if (results.every((result) => result?.severity === "ok")) return { word: "Check passed", tone: "success" };
  return null;
};

const kSourceWords = {
  env_file: "Set in .env",
  deployment: "From deployment",
  unset: "Not set",
};

export const describeKeySource = (source) => kSourceWords[source] || kSourceWords.unset;

// What a key row offers: Show only for a value the server sent (env_file);
// the server never sends a deployment value, so it never gets Show.
export const getKeyRowActions = (entry = {}) => {
  if (entry.source === "env_file") return ["show", "replace"];
  if (entry.source === "deployment") return ["replace"];
  return ["add"];
};

const kOtherGroup = "other";

// GET /api/env's group "ai" entries, grouped by provider in the picker's
// order; an auth-card provider with no .env key still gets its group.
export const buildProviderKeyGroups = ({ vars = [], authProviders = [], lastRun = null } = {}) => {
  const groups = new Map();
  const ensure = (provider) => {
    if (!groups.has(provider)) {
      groups.set(provider, {
        provider,
        label: provider === kOtherGroup ? "Other provider keys" : getProviderLabel(provider),
        keys: [],
        authProviders: [],
        check: provider === kOtherGroup ? null : describeProviderCheck({ lastRun, provider }),
      });
    }
    return groups.get(provider);
  };
  for (const entry of Array.isArray(vars) ? vars : []) {
    if (entry?.group !== "ai") continue;
    ensure(getEnvKeyProvider(entry.key) || kOtherGroup).keys.push(entry);
  }
  for (const authProvider of authProviders) {
    ensure(getAuthProviderFromModelProvider(authProvider)).authProviders.push(authProvider);
  }
  const order = (provider) => {
    if (provider === kOtherGroup) return Number.MAX_SAFE_INTEGER;
    const index = kProviderOrder.indexOf(provider);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER - 1;
  };
  return [...groups.values()].sort((a, b) => order(a.provider) - order(b.provider));
};

export const hasAnyProviderKey = (groups = []) =>
  groups.some((group) => group.keys.some((entry) => entry.source === "env_file" || entry.source === "deployment"));
