// A small AgentRun /v2 client for AlphaClaw's reporters (GST-2907). Every
// answer is classified by AgentRun's error code ({error: {code}}), never by
// status alone. The bearer token is never logged or returned.
const kTimeoutMs = 20000;

const kRetryCodes = new Set(["home_busy", "idempotency_in_progress", "rate_limited", "unavailable", "internal", "request_timeout", "precondition_failed"]);

// kind: ok | retry | auth | expired | not_found | refused
const classify = (status, code) => {
  if (status >= 200 && status < 300) return "ok";
  if (code === "unauthenticated" || code === "forbidden" || code === "permission_denied" || status === 401 || status === 403) return "auth";
  if (code === "not_continuable") return "expired";
  if (code === "not_found" || status === 404) return "not_found";
  if (kRetryCodes.has(code) || status === 412 || status === 429 || status >= 500 || status === 0) return "retry";
  return "refused";
};

const createAgentrunClient = ({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = kTimeoutMs }) => {
  const call = async ({ method, path, token, body, idempotencyKey, ifMatch }) => {
    const headers = { accept: "application/json", authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (ifMatch) headers["if-match"] = ifMatch;
    let response;
    try {
      response = await fetchImpl(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { kind: "retry", status: 0, code: "network", message: String(error?.name || "network error") };
    }
    let json = null;
    try {
      json = await response.json();
    } catch {}
    const code = String(json?.error?.code || "");
    const message = String(json?.error?.message || "").slice(0, 300);
    return { kind: classify(response.status, code), status: response.status, code, message, body: json, etag: response.headers?.get?.("etag") || "" };
  };
  return { call };
};

module.exports = { createAgentrunClient, classify };
