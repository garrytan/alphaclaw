import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchDevicePairings() {
  const res = await authFetch("/api/devices");
  return parseJsonOrThrow(res, "Could not load data");
}

export async function approveDevice(id) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/devices/${safeId}/approve`, { method: "POST" });
  return parseJsonOrThrow(res, "Could not approve device");
}

export async function rejectDevice(id) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/devices/${safeId}/reject`, { method: "POST" });
  return parseJsonOrThrow(res, "Could not reject device");
}

export const fetchNodesStatus = async () => {
  const res = await authFetch("/api/nodes");
  return parseJsonOrThrow(res, "Could not load nodes");
};

export const removeNode = async (nodeId) => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const res = await authFetch(`/api/nodes/${safeNodeId}`, {
    method: "DELETE",
  });
  return parseJsonOrThrow(res, "Could not remove node");
};

export const routeExecToNode = async (nodeId) => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await authFetch(`/api/nodes/${safeNodeId}/route`, {
      method: "POST",
      signal: controller.signal,
    });
    return parseJsonOrThrow(res, "Could not route execution to node");
  } catch (error) {
    if (String(error?.name || "") === "AbortError") {
      throw new Error("Routing timed out. Gateway may be restarting or unavailable.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const fetchNodeConnectInfo = async () => {
  const res = await authFetch("/api/nodes/connect-info");
  return parseJsonOrThrow(res, "Could not load connect info");
};

export const fetchNodeBrowserStatusForNode = async (nodeId, profile = "user") => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const params = new URLSearchParams({ profile: String(profile || "user") });
  const res = await authFetch(
    `/api/nodes/${safeNodeId}/browser-status?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load node browser status");
};
