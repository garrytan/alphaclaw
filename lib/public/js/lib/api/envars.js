import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchEnvVars() {
  const res = await authFetch("/api/env");
  return parseJsonOrThrow(res, "Could not load data");
}

// One key per request on PATCH /api/env: every other .env key is left as it
// is (Models & keys never sends the whole set).
export async function patchEnvVar({ key, value }) {
  const res = await authFetch("/api/env", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
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
