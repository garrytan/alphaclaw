const fs = require("fs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { kBrokerAgentLabel } = require("./constants");

// The broker's gbrain client: MCP over HTTP to the box's gbrain server with
// the broker's own OAuth client (client_credentials), never the local CLI,
// which records local_cli and reads as the owner. Every call names the
// audience member it acts for in X-Gbrain-On-Behalf-Of, writes and reads
// alike: the page's readable_by names the owner and that member, never the
// broker, so an unbound call reads nothing. gbrain checks the member
// against the client's may_act_for. A write also carries who the guest is
// (the group slug and the sender label) as request metadata, _meta.guest,
// which gbrain records on the row; page frontmatter is for people only.
const kTokenSkewMs = 60 * 1000;
const kRetryableCodes = new Set([
  "lock_busy",
  "queue_capacity",
  "write_queue_full",
  "writer_busy",
  "busy",
  "admission_closed",
  "not_admitted",
  "rate_limited",
  "too_many_requests",
  "temporarily_unavailable",
  "write_capacity_backpressure",
  "write_quota_exhausted",
  "retryable",
]);
const kRevisionCodes = new Set(["revision_required", "revision_conflict", "conflict", "slug_exists", "already_exists", "page_exists"]);
const kDeniedPattern = /may_act_for|on_behalf|audience|forbidden|permission|not_permitted|denied|insufficient_scope/;
// gbrain's own codes for a page or write request that isn't there
// (page_not_found from get_page and delete_page, not_found from
// get_write_request). Matched exactly: a scope or auth error must never
// read as "already gone".
const kNotFoundCodes = new Set(["page_not_found", "not_found"]);

class GbrainCallError extends Error {
  constructor(code, { retryable = false, ambiguous = false, message = "" } = {}) {
    super(message || code);
    this.code = code;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

const classify = (code) => ({
  retryable: kRetryableCodes.has(code),
  revision: kRevisionCodes.has(code),
  denied: kDeniedPattern.test(code),
  notFound: !kDeniedPattern.test(code) && kNotFoundCodes.has(code),
});

const isLoopbackHost = (host) => host === "127.0.0.1" || host === "localhost" || host === "[::1]";

const validUrl = (value) => {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
};

// broker-client.json (0600, root): { mcp_url, token_url, client_id,
// client_secret, owner_member }. Missing or malformed reads as null, which
// the broker answers guest_saves_unavailable.
const readBrokerCredential = (clientFile, fsModule = fs) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(clientFile, "utf8"));
    const fields = ["mcp_url", "token_url", "client_id", "client_secret", "owner_member"];
    if (!parsed || typeof parsed !== "object" || fields.some((field) => typeof parsed[field] !== "string" || !parsed[field])) return null;
    if (!validUrl(parsed.mcp_url) || !validUrl(parsed.token_url)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const firstText = (result) => (Array.isArray(result?.content) ? result.content.find((part) => part?.type === "text")?.text : null) || "";

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const errorCodeOf = (json, text) => {
  const candidates = [json?.error?.code, json?.code, typeof json?.error === "string" ? json.error : null, json?.write_error];
  const found = candidates.find((value) => typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value));
  if (found) return found;
  return /\b([a-z]+(?:_[a-z0-9]+)+)\b/.exec(String(text))?.[1] || "gbrain_error";
};

const parseToolResult = (result) => {
  const text = firstText(result);
  const json = result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : parseJson(text);
  if (result?.isError) {
    const code = errorCodeOf(json, text);
    throw new GbrainCallError(code, { retryable: classify(code).retryable, message: code });
  }
  return json && typeof json === "object" ? json : { text };
};

const createGbrainGuestClient = ({ readCredential, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20000, version = "0" }) => {
  let cachedToken = null;

  const accessToken = async (credential) => {
    if (cachedToken && cachedToken.clientId === credential.client_id && cachedToken.expiresAt > now() + kTokenSkewMs) return cachedToken.value;
    let response;
    try {
      response = await fetchImpl(credential.token_url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: credential.client_id, client_secret: credential.client_secret }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GbrainCallError("token_unreachable", { retryable: true });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.access_token !== "string") {
      throw new GbrainCallError(response.status >= 500 || response.status === 429 ? "token_unreachable" : "token_refused", { retryable: response.status >= 500 || response.status === 429 });
    }
    const ttlMs = Number.isFinite(body.expires_in) ? body.expires_in * 1000 : 5 * 60 * 1000;
    cachedToken = { clientId: credential.client_id, value: body.access_token, expiresAt: now() + ttlMs };
    return cachedToken.value;
  };

  const callTool = async ({ name, args = {}, onBehalfOf = null, meta = null }) => {
    const credential = readCredential();
    if (!credential) throw new GbrainCallError("not_configured");
    const bearer = await accessToken(credential);
    const headers = { authorization: "Bearer " + bearer, "x-gbrain-agent-label": kBrokerAgentLabel };
    if (onBehalfOf) headers["x-gbrain-on-behalf-of"] = "member:" + onBehalfOf;
    const client = new Client({ name: "alphaclaw-guest-broker", version }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(credential.mcp_url), { requestInit: { headers }, fetch: fetchImpl });
    let connected = false;
    try {
      await client.connect(transport);
      connected = true;
      const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: timeoutMs });
      return parseToolResult(result);
    } catch (error) {
      if (error instanceof GbrainCallError) throw error;
      if (/\b401\b|unauthori[sz]ed/i.test(String(error?.message || ""))) cachedToken = null;
      throw new GbrainCallError(connected ? "call_outcome_unknown" : "gbrain_unreachable", { retryable: true, ambiguous: connected });
    } finally {
      await client.close().catch(() => {});
    }
  };

  return {
    callTool,
    brainIdentity: () => callTool({ name: "get_brain_identity" }),
    credential: () => readCredential(),
  };
};

module.exports = { createGbrainGuestClient, readBrokerCredential, parseToolResult, classify, GbrainCallError, validUrl };
