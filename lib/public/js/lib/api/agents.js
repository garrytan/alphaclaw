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

// A delete OpenClaw was asked to do answers with an outcome (deleted,
// cleanup_incomplete, not_deleted, unknown, config_only) whatever its HTTP
// status; anything else (a refusal before the send) throws.
const parseDeleteOutcome = async (res, fallbackError) => {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (data && typeof data.outcome === "string") return { ...data, status: res.status };
  throw Object.assign(new Error(data?.error || data?.message || text || fallbackError), {
    status: res.status,
    code: data?.code,
  });
};

export const deleteAgent = async (agentId, { snapshot = true } = {}) => {
  const query = new URLSearchParams({ snapshot: snapshot ? "true" : "false" });
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}?${query.toString()}`,
    { method: "DELETE" },
  );
  return parseDeleteOutcome(res, "Could not delete agent");
};

export const finishAgentDelete = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/finish-delete`,
    { method: "POST" },
  );
  return parseDeleteOutcome(res, "Could not finish deleting the agent");
};

export const fetchAgentDeletePreview = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/delete-preview`,
  );
  const data = await parseJsonOrThrow(res, "Could not check the agent");
  return data.preview;
};

export const fetchAgentDeletions = async () => {
  const res = await authFetch("/api/agent-deletions");
  return parseJsonOrThrow(res, "Could not load agent deletions");
};

export const setDefaultAgent = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/default`,
    { method: "POST" },
  );
  return parseJsonOrThrow(res, "Could not set default agent");
};
