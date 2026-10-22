import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchOnboardStatus() {
  const res = await authFetch("/api/onboard/status");
  // A JSON-bodied 5xx (proxy, or the server's own JSON error middleware) must
  // reject (fix wave F141): resolving it as data read `onboarded: false` and
  // dropped an onboarded operator into the Welcome wizard. The shell retries
  // failures with backoff.
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = String(body?.error || "");
    } catch {}
    throw new Error(detail || `Could not load onboarding status (HTTP ${res.status})`);
  }
  return res.json();
}

export async function fetchOnboardProgress() {
  const res = await authFetch("/api/onboard/progress");
  return parseJsonOrThrow(res, "Could not load data");
}

export async function runOnboard(vars, modelKey, { importMode = false } = {}) {
  const res = await authFetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars, modelKey, importMode }),
  });
  return res.json();
}

export async function verifyGithubOnboardingRepo(repo, token, mode = "new") {
  const res = await authFetch("/api/onboard/github/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, token, mode }),
  });
  return res.json();
}

export async function scanImportRepo(tempDir) {
  const res = await authFetch("/api/onboard/import/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempDir }),
  });
  return res.json();
}

export async function applyImport({
  tempDir,
  approvedSecrets = [],
  skipSecretExtraction = false,
  githubRepo = "",
  githubToken = "",
}) {
  const res = await authFetch("/api/onboard/import/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tempDir,
      approvedSecrets,
      skipSecretExtraction,
      githubRepo,
      githubToken,
    }),
  });
  return res.json();
}
