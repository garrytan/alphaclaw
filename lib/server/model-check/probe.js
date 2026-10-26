// One tiny live request per model, the way OpenClaw would send it: the
// provider's configured API, base URL and credential. It answers whether the
// provider accepts the model id, never whether the model is any good. A probe
// asks for at most 16 output tokens; the provider's own error text is kept
// (redacted, capped) because it is the evidence the owner needs.
const kProbeTimeoutMs = 20_000;
const kMaxAnswerChars = 300;
const kMaxListedModels = 500;
const kProbePrompt = "Reply with OK.";

// Mirrors OpenClaw's model-not-found classifier (classify-core.ts) closely
// enough for evidence: a provider saying the model does not exist, is
// unknown, retired, or has no route.
const kModelNotFoundText =
  /model(?:[_\-\s])?not(?:[_\-\s])?found|\bmodel\b.{0,80}?\b(?:not found|does not exist|doesn't exist|is not available|not available|not supported|unsupported|invalid|unknown)\b|unknown model|no such model|no endpoints found for|\b(?:was|is|has been) (?:retired|deprecated|decommissioned)\b|do(?:es)? not have access to (?:the )?model/i;

const joinUrl = (baseUrl, suffix) => {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
  return url.toString();
};

const anthropicUrl = (baseUrl, suffix) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v1$/.test(path) ? `${path}${suffix}` : `${path}/v1${suffix}`;
  return url.toString();
};

const buildRequest = ({ api, baseUrl, modelId, maxTokensField = "max_tokens" }) => {
  if (api === "openai-responses") {
    return {
      url: joinUrl(baseUrl, "/responses"),
      body: { model: modelId, input: kProbePrompt, max_output_tokens: 16, store: false },
    };
  }
  if (api === "anthropic-messages") {
    return {
      url: anthropicUrl(baseUrl, "/messages"),
      headers: { "anthropic-version": "2023-06-01" },
      body: { model: modelId, max_tokens: 16, messages: [{ role: "user", content: kProbePrompt }] },
    };
  }
  return {
    url: joinUrl(baseUrl, "/chat/completions"),
    body: { model: modelId, messages: [{ role: "user", content: kProbePrompt }], [maxTokensField]: 16, stream: false },
  };
};

const listUrl = (api, baseUrl) => (api === "anthropic-messages" ? anthropicUrl(baseUrl, "/models") : joinUrl(baseUrl, "/models"));

const errorTextOf = (bodyText) => {
  const text = String(bodyText || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    const message =
      (typeof error === "string" ? error : error?.message) ||
      parsed?.message ||
      parsed?.detail ||
      (typeof parsed?.error?.code === "string" ? parsed.error.code : "");
    if (message) return String(message);
  } catch {}
  if (/^\s*</.test(text)) return "";
  return text;
};

const requestJson = async ({ fetchImpl, url, method = "POST", headers = {}, body, timeoutMs }) => {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), accept: "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const text = await response.text().catch(() => "");
    return { status: response.status, text };
  } catch (error) {
    return { status: 0, error: error?.name === "TimeoutError" ? "timed out" : String(error?.cause?.code || error?.message || error) };
  }
};

// ok | model_rejected | endpoint_not_found | auth_rejected | rate_limited |
// inconclusive | unreachable
const classifyAnswer = ({ status, text, error }) => {
  if (status === 0) return { outcome: "unreachable", message: error || "no answer" };
  const message = errorTextOf(text);
  if (status >= 200 && status < 300) return { outcome: "ok", message: "" };
  if (kModelNotFoundText.test(message)) return { outcome: "model_rejected", message };
  if (status === 404) return { outcome: message ? "model_rejected" : "endpoint_not_found", message: message || "Not Found" };
  if (status === 401 || status === 403) return { outcome: "auth_rejected", message };
  if (status === 429) return { outcome: "rate_limited", message };
  return { outcome: "inconclusive", message };
};

const probeModel = async ({ fetchImpl = fetch, connection, modelId, api = connection.api, maxTokensField, timeoutMs = kProbeTimeoutMs, redact = (text) => text }) => {
  const request = buildRequest({ api, baseUrl: connection.baseUrl, modelId, maxTokensField });
  let answer = await requestJson({ fetchImpl, url: request.url, headers: { ...connection.headers, ...request.headers }, body: request.body, timeoutMs });
  let verdict = classifyAnswer(answer);
  if (verdict.outcome === "inconclusive" && api === "openai-completions" && /max_tokens/.test(verdict.message) && maxTokensField !== "max_completion_tokens") {
    return probeModel({ fetchImpl, connection, modelId, api, maxTokensField: "max_completion_tokens", timeoutMs, redact });
  }
  return {
    api,
    endpoint: request.url.replace(/\?.*$/, ""),
    status: answer.status,
    outcome: verdict.outcome,
    answer: redact(verdict.message).slice(0, kMaxAnswerChars),
  };
};

const listProviderModels = async ({ fetchImpl = fetch, connection, timeoutMs = kProbeTimeoutMs }) => {
  const answer = await requestJson({
    fetchImpl,
    url: listUrl(connection.api, connection.baseUrl),
    method: "GET",
    headers: { ...connection.headers, ...(connection.api === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) },
    timeoutMs,
  });
  if (answer.status < 200 || answer.status >= 300) return null;
  try {
    const parsed = JSON.parse(answer.text);
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : null;
    if (!rows) return null;
    return rows
      .map((row) => String((typeof row === "string" ? row : row?.id || row?.name) || "").trim())
      .filter(Boolean)
      .slice(0, kMaxListedModels);
  } catch {
    return null;
  }
};

module.exports = { probeModel, listProviderModels, classifyAnswer, buildRequest, kProbeTimeoutMs };
