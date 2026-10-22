import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchEnvVars() {
  const res = await authFetch("/api/env");
  return parseJsonOrThrow(res, "Could not load data");
}

export async function saveEnvVars(vars) {
  const res = await authFetch("/api/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "Could not parse env save response");
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}
