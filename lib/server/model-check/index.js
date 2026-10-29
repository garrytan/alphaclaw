// Model check: can each model this box offers actually run? OpenClaw's /model
// accepts any ref the allowlist permits and only finds out at run time that a
// provider will not serve it (OpenClaw 2026.10.7: "This model was not found",
// with fallbacks off for a session override). This reads every configured ref,
// asks OpenClaw's own listing whether it resolves, and for custom providers
// (models.providers with a baseUrl) sends one tiny request on the configured
// API. When the provider rejects the id there, the check tries the other
// OpenAI API shape and reads the provider's model list, so the fix it names is
// the specific one. It never writes config. Probes run only on request (the
// Models tab, the admin op, and a model_not_found failure for that one ref).
const { collectModelTargets, resolveProviderConnection, splitRef } = require("./targets");
const { probeModel, listProviderModels } = require("./probe");
const { describeResult } = require("./diagnosis");
const { findOwnedProviderPreset } = require("../providers/presets");
const { classifyOwnedProvider } = require("../providers/ensure");

const kProbeConcurrency = 4;
const kMaxSuggestions = 5;
const kAlternateApi = { "openai-completions": "openai-responses", "openai-responses": "openai-completions" };

const editDistance = (a, b) => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
};

const closestIds = (modelId, listed) =>
  [...listed]
    .map((id) => ({ id, distance: editDistance(modelId, id) }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, kMaxSuggestions)
    .map((entry) => entry.id);

// OpenClaw's configured listing (`openclaw models list --json`): a ref it
// cannot resolve comes back with available null and no input or context.
const readOpenclawState = (row) => {
  if (!row) return null;
  if (row.available === true) return "available";
  if (row.available === false) return "unavailable";
  if ((row.input === "-" || !row.input) && (row.contextWindow === null || row.contextWindow === undefined)) return "unresolved";
  return "unknown";
};

const ownedProviderNotes = ({ preset, config, connection, isEnvRestartPending }) => {
  const notes = [];
  const { state, differs } = classifyOwnedProvider(config, preset);
  if (state === "customized") {
    notes.push(`models.providers.${preset.id} was edited (${differs.join(", ")}), so AlphaClaw no longer updates it. Delete the block and save ${preset.envVar} again to get AlphaClaw's version back.`);
  }
  try {
    if (connection.baseUrl && new URL(connection.baseUrl).origin !== new URL(preset.baseUrl).origin) {
      notes.push(`models.providers.${preset.id}.baseUrl points at ${new URL(connection.baseUrl).origin}, not ${new URL(preset.baseUrl).origin}; that host receives the ${preset.label} key.`);
    }
  } catch {}
  if (isEnvRestartPending?.()) {
    notes.push(`Environment variables changed since the gateway started. If you set or replaced ${preset.envVar}, restart the gateway before ${preset.label} can use it.`);
  }
  return notes;
};

const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
};

const createModelCheck = ({
  readConfig,
  getEnv = () => process.env,
  listProfiles = () => [],
  listOpenclawModels = async () => null,
  fetchImpl = (...args) => fetch(...args),
  redact = (text) => text,
  now = () => Date.now(),
  logger = console,
  // True while an env change waits for a gateway restart: the gateway
  // resolves an owned provider's ${VAR} key from its own env.
  isEnvRestartPending = () => false,
} = {}) => {
  let lastRun = null;
  let inFlight = null;

  const checkTarget = async ({ target, config, env, profiles, openclawRows, probe, listings }) => {
    const connection = resolveProviderConnection({ config, provider: target.provider, env, profiles });
    const openclawState = readOpenclawState(openclawRows?.get(target.ref));
    const result = {
      ref: target.ref,
      provider: target.provider,
      modelId: target.modelId,
      roles: target.roles,
      aliases: target.aliases,
      custom: connection.custom === true,
      api: connection.api || null,
      openclaw: openclawState,
      status: "not_checked",
    };
    if (connection.custom && connection.baseUrl) result.baseUrl = connection.baseUrl.replace(/\?.*$/, "");
    if (connection.custom && !connection.declaredModels.includes(target.modelId)) result.declared = false;
    if (connection.envVar) result.envVar = connection.envVar;
    if (connection.credentialSource) result.credentialSource = connection.credentialSource;
    const preset = findOwnedProviderPreset(target.provider);
    if (preset) {
      const notes = ownedProviderNotes({ preset, config, connection, isEnvRestartPending });
      if (notes.length) result.notes = notes;
    }

    if (!connection.custom) {
      if (openclawState === "unresolved") result.status = "unresolved";
      else if (openclawState === "unavailable") result.status = "no_credential";
      else if (openclawState === "available") result.status = "available";
      else result.notCheckedReason = "OpenClaw's model listing was not available, and this provider is managed by an OpenClaw plugin.";
      return result;
    }
    if (openclawState === "unresolved" && result.declared === false) {
      result.status = "unresolved";
      return result;
    }
    if (!connection.probe) {
      if (connection.skip === "no_credential") result.status = "no_credential";
      else if (connection.skip === "no_base_url" || connection.skip === "bad_base_url") result.status = "misconfigured";
      else if (connection.skip === "unsupported_api") result.notCheckedReason = `AlphaClaw does not test the ${connection.api} API.`;
      else if (connection.skip === "credential_unreadable") result.notCheckedReason = "The credential is a secret reference only OpenClaw can read.";
      return result;
    }
    if (!probe) {
      result.status = "not_probed";
      return result;
    }
    const declaredRow = (Array.isArray(config?.models?.providers?.[target.provider]?.models) ? config.models.providers[target.provider].models : [])
      .find((row) => row?.id === target.modelId);
    const offEffort = declaredRow?.compat?.reasoningEffortMap?.off;
    const first = await probeModel({
      fetchImpl,
      connection,
      modelId: target.modelId,
      reasoningEffort: typeof offEffort === "string" ? offEffort : null,
      ...(preset?.probeTimeoutMs ? { timeoutMs: preset.probeTimeoutMs } : {}),
      redact,
    });
    Object.assign(result, { endpoint: first.endpoint, providerStatus: first.status, providerAnswer: first.answer });
    if (first.outcome === "ok") {
      result.status = "ok";
      return result;
    }
    const listFor = () => {
      const key = `${target.provider}\n${connection.api}`;
      if (!listings.has(key)) listings.set(key, listProviderModels({ fetchImpl, connection }));
      return listings.get(key);
    };
    // A timeout from a provider that still answers its model list is a busy
    // queue, not a network fault.
    if (first.outcome === "unreachable" && first.answer === "timed out" && Array.isArray(await listFor())) {
      result.status = "busy";
      return result;
    }
    if (first.outcome === "model_rejected" || first.outcome === "endpoint_not_found") {
      const alternate = kAlternateApi[connection.api];
      if (alternate) {
        const second = await probeModel({ fetchImpl, connection, modelId: target.modelId, api: alternate, redact });
        if (second.outcome === "ok") {
          Object.assign(result, { status: "wrong_api", alternateApi: alternate });
          return result;
        }
      }
      const listed = await listFor();
      if (Array.isArray(listed)) {
        const listedAs = preset?.listedAliases?.[target.modelId];
        result.listed = listed.includes(target.modelId) || (!!listedAs && listed.includes(listedAs));
        result.listedCount = listed.length;
        if (!result.listed) result.suggestions = closestIds(target.modelId, listed);
      }
      result.status = first.outcome;
      return result;
    }
    result.status = first.outcome === "unreachable" ? "unreachable" : first.outcome;
    return result;
  };

  const runOnce = async ({ refs = null, probe = true } = {}) => {
    const startedAt = now();
    const config = readConfig() || {};
    let targets = collectModelTargets(config);
    if (Array.isArray(refs) && refs.length > 0) {
      const wanted = new Set(refs.map((ref) => String(ref || "").trim()).filter(Boolean));
      const known = new Set(targets.map((target) => target.ref));
      targets = targets.filter((target) => wanted.has(target.ref));
      for (const ref of wanted) {
        const parsed = splitRef(ref);
        if (parsed && !known.has(ref)) targets.push({ ...parsed, roles: [], aliases: [] });
      }
    }
    let openclawRows = null;
    try {
      const rows = await listOpenclawModels();
      if (Array.isArray(rows)) openclawRows = new Map(rows.map((row) => [String(row?.key || ""), row]));
    } catch (error) {
      logger.warn?.(`[alphaclaw] model-check: openclaw models list failed: ${redact(String(error?.message || error)).slice(0, 200)}`);
    }
    const env = getEnv() || {};
    let profiles = [];
    try {
      profiles = listProfiles() || [];
    } catch {}
    const listings = new Map();
    const results = await mapLimit(targets, kProbeConcurrency, async (target) => {
      const result = await checkTarget({ target, config, env, profiles, openclawRows, probe, listings });
      return { ...result, ...describeResult(result) };
    });
    const run = {
      checkedAt: new Date(startedAt).toISOString(),
      durationMs: now() - startedAt,
      probe,
      openclawListing: openclawRows !== null,
      results,
      problems: results.filter((result) => result.severity === "error").length,
    };
    if (!refs) lastRun = run;
    return run;
  };

  // Concurrent full checks share one run; a single-ref check runs on its own.
  const run = (options = {}) => {
    if (options.refs) return runOnce(options);
    if (inFlight) return inFlight;
    inFlight = runOnce(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const checkRef = async (ref) => (await run({ refs: [ref], probe: true })).results.find((result) => result.ref === ref) || null;

  return { run, checkRef, getLastRun: () => lastRun, isRunning: () => inFlight !== null };
};

module.exports = { createModelCheck, closestIds, readOpenclawState };
