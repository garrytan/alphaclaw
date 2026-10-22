import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const fetchAgentSessions = async () => {
  const res = await authFetch("/api/agent/sessions");
  return parseJsonOrThrow(res, "Could not load agent sessions");
};

export const sendAgentMessage = async ({
  message = "",
  sessionKey = "",
} = {}) => {
  const res = await authFetch("/api/agent/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: String(message || ""),
      sessionKey: String(sessionKey || ""),
    }),
  });
  return parseJsonOrThrow(res, "Could not send message to agent");
};

export const fetchAgents = async () => {
  const res = await authFetch("/api/agents");
  return parseJsonOrThrow(res, "Could not load agents");
};

export const fetchAgentWorkspaceSize = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/workspace-size`,
  );
  return parseJsonOrThrow(res, "Could not load workspace size");
};

export const fetchAgentBindings = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/bindings`,
  );
  return parseJsonOrThrow(res, "Could not load agent bindings");
};

export const createAgent = async (payload) => {
  const res = await authFetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not create agent");
};

export const updateAgent = async (agentId, payload) => {
  const res = await authFetch(`/api/agents/${encodeURIComponent(String(agentId || ""))}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not update agent");
};

export const deleteAgent = async (agentId, { keepWorkspace = true } = {}) => {
  const query = new URLSearchParams({
    keepWorkspace: keepWorkspace ? "true" : "false",
  });
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}?${query.toString()}`,
    { method: "DELETE" },
  );
  return parseJsonOrThrow(res, "Could not delete agent");
};

export const setDefaultAgent = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/default`,
    { method: "POST" },
  );
  return parseJsonOrThrow(res, "Could not set default agent");
};
