// One sentence of evidence and one fix per checked model. Only token-shaped
// values (refs, provider ids, env var names, API names) and the provider's
// redacted answer reach this text.
const quote = (text) => (text ? ` "${text}"` : "");

const listedSentence = ({ modelId, listed, listedCount }) => {
  if (listed === true) return ` Its model list does include ${modelId}, so the API or the account's access to the model is the likely problem.`;
  if (listed === false && listedCount === 0) return " The key works, but the provider's model list for it is empty.";
  if (listed === false) return ` The key works, but ${modelId} is not among the ${listedCount} models the provider lists for it.`;
  return "";
};

// The provider authenticated the key and rejected the id: a list that is
// empty or lacks the id means an entitlement the owner enables at the
// provider, not a config change (unless the id itself is a typo).
const rejectedFix = ({ ref, provider, modelId, listed, listedCount, suggestions = [] }) => {
  if (listed === true) {
    return `Check which API ${provider} serves ${modelId} on and whether this key can use it. Until then, remove ${ref} from the allowlist so nobody can pick it.`;
  }
  if (listed === false && listedCount === 0) {
    return `Your ${provider} key has access to no models. Enable model access for this key in ${provider}'s dashboard, then run the check again. No AlphaClaw or OpenClaw config change is needed.`;
  }
  if (listed === false) {
    return `Your ${provider} key does not have access to ${modelId}. Enable it for this key in ${provider}'s dashboard, or, if the id is a typo, use one it lists (${suggestions.join(", ")}).`;
  }
  return `Check that ${provider} serves ${modelId} for this key (its dashboard or documentation). If it does not, change the id under models.providers.${provider}.models and in the allowlist, or remove ${ref}.`;
};

const describeResult = (result) => {
  const { ref, provider, modelId, status, api, endpoint, providerStatus, providerAnswer, alternateApi, envVar } = result;
  const answered = `${provider} answered ${providerStatus}${quote(providerAnswer)}`;
  switch (status) {
    case "ok":
      return { severity: "ok", reason: `${provider} accepted ${modelId} on ${api}.`, fix: null };
    case "available":
      return {
        severity: "ok",
        reason: "OpenClaw lists it with a usable credential. Its provider is managed by an OpenClaw plugin, so no test request was sent.",
        fix: null,
      };
    case "not_probed":
      return { severity: "info", reason: "Configured. No test request was sent.", fix: null };
    case "wrong_api":
      return {
        severity: "error",
        reason: `${answered} for ${modelId} on ${api} (${endpoint}), but accepted it on ${alternateApi}.`,
        fix: `Set models.providers.${provider}.api to "${alternateApi}". It applies to every model under ${provider}, so run the check again afterwards.`,
      };
    case "model_rejected":
      return {
        severity: "error",
        reason: `${answered} for ${modelId} (${endpoint}).${listedSentence(result)}`,
        fix: rejectedFix(result),
      };
    case "endpoint_not_found":
      return {
        severity: "error",
        reason: `${endpoint} answered 404 without naming the model, so the base URL or the API is probably wrong.`,
        fix: `Check models.providers.${provider}.baseUrl (the API root, usually ending in /v1) and models.providers.${provider}.api.`,
      };
    case "auth_rejected":
      return {
        severity: "error",
        reason: `${provider} refused the credential (${providerStatus}${providerAnswer ? `: ${providerAnswer}` : ""}).`,
        fix: envVar ? `Replace the key in ${envVar} (Envars), then restart the gateway.` : `Replace the credential for ${provider}.`,
      };
    case "no_credential":
      if (envVar) {
        return {
          severity: "error",
          reason: `The ${provider} credential refers to ${envVar}, which is not set.`,
          fix: `Set ${envVar} in Envars, then restart the gateway.`,
        };
      }
      return result.custom
        ? { severity: "error", reason: `${provider} has no credential.`, fix: `Add an API key for ${provider} (models.providers.${provider}.apiKey or an auth profile).` }
        : {
            severity: "error",
            reason: `OpenClaw lists ${ref} but reports it unavailable, usually because ${provider} has no usable credential.`,
            fix: `Add a credential for ${provider} on the Models tab, or run openclaw models status to see what is missing.`,
          };
    case "unresolved":
      return {
        severity: "error",
        reason: result.custom
          ? `OpenClaw cannot resolve ${ref}: models.providers.${provider} does not declare ${modelId}.`
          : `OpenClaw cannot resolve ${ref}: no installed plugin provides "${provider}" and models.providers has no "${provider}" entry.`,
        fix: result.custom
          ? `Add ${modelId} under models.providers.${provider}.models, or remove ${ref} from the allowlist.`
          : `Install or enable the plugin that provides ${provider} (openclaw plugins install), or add ${provider} under models.providers. Otherwise remove ${ref} from the allowlist.`,
      };
    case "rate_limited":
      return { severity: "warn", reason: `${answered}: rate limited. The model id was not rejected.`, fix: null };
    case "inconclusive":
      return {
        severity: "warn",
        reason: `${answered} to the test request.`,
        fix: `Run the check again. If it repeats, compare models.providers.${provider} with the provider's documentation.`,
      };
    case "unreachable":
      return {
        severity: "error",
        reason: `Could not reach ${endpoint} (${providerAnswer || "no answer"}).`,
        fix: `Check models.providers.${provider}.baseUrl and the box's network access to it.`,
      };
    case "misconfigured":
      return {
        severity: "error",
        reason: `models.providers.${provider} has no usable baseUrl.`,
        fix: `Set models.providers.${provider}.baseUrl to the provider's API root.`,
      };
    default:
      return { severity: "info", reason: result.notCheckedReason || "Not checked.", fix: null };
  }
};

module.exports = { describeResult };
