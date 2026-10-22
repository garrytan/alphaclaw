import { authFetch } from "./http.js";
import { parseEnvelopeOrThrow } from "./parse.js";

export async function fetchBuzzSetup() {
  const res = await authFetch("/api/channels/buzz/setup");
  return parseEnvelopeOrThrow(res, "Could not load Buzz setup state");
}

export async function runBuzzSetupAction(action, payload = {}) {
  const res = await authFetch(
    `/api/channels/buzz/setup/${encodeURIComponent(action)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseEnvelopeOrThrow(res, "Buzz setup step failed");
}
