const { RelayError } = require("./errors");

// Minimal REST client for the loopback relay engine. Every call carries one
// of the engine's credentials (internal secret, workspace key or an agent
// token); none of them is ever logged or returned to a caller.
const kRequestTimeoutMs = 10000;

const createEngineClient = ({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = kRequestTimeoutMs }) => {
  const request = async (method, path, { token = "", body, query } = {}) => {
    const url = new URL(baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { accept: "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RelayError("engine_unavailable", "The relay engine did not answer " + method + " " + path + ": " + (error?.message || error));
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok || json?.ok === false) {
      const code = json?.error?.code || "http_" + response.status;
      const error = new RelayError(
        response.status === 404 && /agent/.test(code) ? "recipient_unknown" : "engine_error",
        "Relay engine " + method + " " + path + " answered " + response.status + " " + code + (json?.error?.message ? ": " + json.error.message : ""),
      );
      error.engineStatus = response.status;
      error.engineCode = code;
      throw error;
    }
    return json && Object.prototype.hasOwnProperty.call(json, "data") ? json.data : json;
  };

  return {
    request,
    health: () => request("GET", "/health"),
    createWorkspace: (internalSecret, name) => request("POST", "/internal/workspaces", { token: internalSecret, body: { name } }),
    registerAgent: (workspaceKey, name, persona) =>
      request("POST", "/v1/agents", { token: workspaceKey, body: { name, type: "agent", ...(persona ? { persona } : {}) } }),
    deleteAgent: (workspaceKey, name) => request("DELETE", "/v1/agents/" + encodeURIComponent(name), { token: workspaceKey }),
    listAgents: (workspaceKey) => request("GET", "/v1/agents", { token: workspaceKey }),
    presence: (workspaceKey) => request("GET", "/v1/agents/presence", { token: workspaceKey }),
    events: (workspaceKey, since, limit = 100) => request("GET", "/v1/workspace/events", { token: workspaceKey, query: { since, limit } }),
    conversations: (workspaceKey) => request("GET", "/v1/dm/conversations/all", { token: workspaceKey }),
    getMessage: (token, id) => request("GET", "/v1/messages/" + encodeURIComponent(id), { token }),
    thread: (token, id, limit = 50) => request("GET", "/v1/messages/" + encodeURIComponent(id) + "/replies", { token, query: { limit } }),
    sendDm: (agentToken, to, text, data) => request("POST", "/v1/dm", { token: agentToken, body: { to, text, ...(data ? { data } : {}) } }),
    reply: (agentToken, id, text, data) =>
      request("POST", "/v1/messages/" + encodeURIComponent(id) + "/replies", { token: agentToken, body: { text, ...(data ? { data } : {}) } }),
    inbox: (agentToken) => request("GET", "/v1/inbox", { token: agentToken }),
    dmConversations: (agentToken) => request("GET", "/v1/dm/conversations", { token: agentToken }),
    dmMessages: (agentToken, conversationId, query = {}) =>
      request("GET", "/v1/dm/" + encodeURIComponent(conversationId) + "/messages", { token: agentToken, query }),
    consoleMessages: (workspaceKey, query = {}) => request("GET", "/v1/console/messages", { token: workspaceKey, query }),
  };
};

module.exports = { createEngineClient };
