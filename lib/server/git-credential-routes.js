// GitHub credential routes (GST-3351): which token answers for which
// repository. alphaclaw.json gitCredentials.routes maps "owner/repo",
// "owner/*" or "*" to the NAME of an env var that holds the token, never the
// token itself. AlphaClaw's managed credential helper
// (lib/scripts/git-credential-alphaclaw.js) and the server's push checks both
// read routes through this module, so they always agree on which route
// answers. Shared with the helper script, so it requires nothing.
const kTokenEnvPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const kUsernamePattern = /^[A-Za-z0-9._-]{1,64}$/;
const kSegmentPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const kMaxRoutes = 64;
const kDefaultUsername = "x-access-token";

const normalizeRepoPattern = (value) => {
  const text = String(value || "").trim().toLowerCase().replace(/\.git$/, "");
  if (text === "*") return "*";
  const parts = text.split("/");
  if (parts.length !== 2 || !kSegmentPattern.test(parts[0])) return "";
  if (parts[1] !== "*" && !kSegmentPattern.test(parts[1])) return "";
  return parts[0] + "/" + parts[1];
};

const normalizeGitCredentialsConfig = (raw = {}, { refusedEnvKeys = [] } = {}) => {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const refused = new Set(refusedEnvKeys);
  const routes = [];
  const seen = new Set();
  for (const entry of Array.isArray(base.routes) ? base.routes : []) {
    if (routes.length >= kMaxRoutes) break;
    const repo = normalizeRepoPattern(entry?.repo);
    const tokenEnv = typeof entry?.tokenEnv === "string" ? entry.tokenEnv.trim() : "";
    if (!repo || seen.has(repo) || !kTokenEnvPattern.test(tokenEnv) || refused.has(tokenEnv)) continue;
    const username = typeof entry.username === "string" && kUsernamePattern.test(entry.username.trim()) ? entry.username.trim() : kDefaultUsername;
    seen.add(repo);
    routes.push({ repo, tokenEnv, username });
  }
  return { routes, manageGlobalConfig: base.manageGlobalConfig === true };
};

// "owner/repo" from a credential request's or remote URL's path, lowercased,
// without ".git"; "" when the path does not name a repository.
const repoOfPath = (value) => {
  const parts = String(value || "").replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return "";
  return (parts[0] + "/" + parts[1].replace(/\.git$/i, "")).toLowerCase();
};

// The most specific route: "owner/repo", then "owner/*", then "*". A request
// with no path (credential.useHttpPath off) can only match "*".
const resolveGitCredentialRoute = (routes, repo) => {
  const list = Array.isArray(routes) ? routes : [];
  const exact = repo ? list.find((route) => route.repo === repo) : null;
  const owner = repo ? list.find((route) => route.repo === repo.split("/")[0] + "/*") : null;
  return exact || owner || list.find((route) => route.repo === "*") || null;
};

module.exports = {
  normalizeGitCredentialsConfig,
  normalizeRepoPattern,
  repoOfPath,
  resolveGitCredentialRoute,
  kDefaultUsername,
};
