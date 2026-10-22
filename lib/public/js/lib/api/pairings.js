import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchPairings({ signal } = {}) {
  const res = await authFetch("/api/pairings", { signal });
  return parseJsonOrThrow(res, "Could not load data");
}

export async function approvePairing(id, channel, accountId = "") {
  const res = await authFetch(`/api/pairings/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, accountId }),
  });
  return res.json();
}

export async function rejectPairing(id, channel, accountId = "") {
  const res = await authFetch(`/api/pairings/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, accountId }),
  });
  return parseJsonOrThrow(res, "Could not reject pairing");
}
