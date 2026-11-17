// A small AgentRun /v2 client for AlphaClaw's reporters (GST-2907). Every
// answer is classified by AgentRun's error code ({error: {code}}), never by
// status alone. The bearer token is never logged or returned.
const kTimeoutMs = 20000;

const kRetryCodes = new Set(["home_busy", "idempotency_in_progress", "rate_limited", "unavailable", "internal", "request_timeout", "precondition_failed"]);

// kind: ok | retry | auth | expired | ended | not_found | refused. AgentRun
// answers not_continuable both for a run whose window passed ("This SDK run
// expired.") and for one that already ended, for example stopped in its
// console ("This SDK run has ended."); only the message tells them apart.
const classify = (status, code, message = "") => {
  if (status >= 200 && status < 300) return "ok";
  if (code === "unauthenticated" || code === "forbidden" || code === "permission_denied" || status === 401 || status === 403) return "auth";
  if (code === "not_continuable") return /has ended/i.test(message) ? "ended" : "expired";
  if (code === "not_found") return "not_found";
  if (kRetryCodes.has(code) || status === 408 || status === 412 || status === 429 || status >= 500 || status === 0) return "retry";
  // Only AgentRun's own error code proves a refusal; a 4xx without one came
  // from something in between (a proxy, a wrong base URL) and is retried.
  if (!code) return "retry";
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
    return { kind: classify(response.status, code, message), status: response.status, code, message, body: json, etag: response.headers?.get?.("etag") || "" };
  };
  return { call };
};

module.exports = { createAgentrunClient, classify };
