import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const fetchModels = async () => {
  const res = await authFetch("/api/models");
  return parseJsonOrThrow(res, "Could not load data");
};

export const refreshModels = async () => {
  const res = await authFetch("/api/models/refresh", { method: "POST" });
  return parseJsonOrThrow(res, "Could not load data");
};

export const fetchModelStatus = async () => {
  const res = await authFetch("/api/models/status");
  return parseJsonOrThrow(res, "Could not load data");
};

export const fetchThinkingOptions = async (modelKey) => {
  const normalized = String(modelKey || "").trim();
  const qs = new URLSearchParams({ modelKey: normalized });
  const res = await authFetch(`/api/models/thinking-options?${qs.toString()}`);
  return parseJsonOrThrow(res, "Could not load data");
};

export const setPrimaryModel = async (modelKey) => {
  const res = await authFetch("/api/models/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelKey }),
  });
  return res.json();
};

export const fetchModelsConfig = async ({ agentId } = {}) => {
  const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await authFetch(`/api/models/config${qs}`);
  return parseJsonOrThrow(res, "Could not load data");
};

export const saveModelsConfig = async ({
  primary,
  configuredModels,
  profiles,
  authOrder,
  agentId,
} = {}) => {
  const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await authFetch(`/api/models/config${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ primary, configuredModels, profiles, authOrder }),
  });
  return res.json();
};

export const fetchCodexStatus = async () => {
  const res = await authFetch("/api/codex/status");
  return parseJsonOrThrow(res, "Could not load data");
};

export const disconnectCodex = async () => {
  const res = await authFetch("/api/codex/disconnect", { method: "POST" });
  return res.json();
};

export const exchangeCodexOAuth = async (input) => {
  const res = await authFetch("/api/codex/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return res.json();
};

export const fetchModelCheck = async () => {
  const res = await authFetch("/api/models/check");
  return parseJsonOrThrow(res, "Could not load the model check");
};

export const runModelCheck = async ({ refs, probe = true } = {}) => {
  const res = await authFetch("/api/models/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(refs ? { refs } : {}), probe }),
  });
  return parseJsonOrThrow(res, "Could not run the model check");
};
