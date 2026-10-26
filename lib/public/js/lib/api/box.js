import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

// Read-only box status views (GET /api/box/:view, ALPH-40).
export async function fetchBoxView(view, params = {}) {
  const query = new URLSearchParams(params).toString();
  const res = await authFetch(`/api/box/${encodeURIComponent(view)}${query ? `?${query}` : ""}`);
  return parseJsonOrThrow(res, `Could not load box ${view}`);
}
