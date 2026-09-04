const fs = require("fs");
const { resolvePublicOrigin } = require("./public-origin");
const crypto = require("crypto");
const {
  CODEX_JWT_CLAIM_PATH,
  kOnboardingModelProviders,
  gogClientCredentialsPath,
} = require("./constants");
const { isTruthyFlag } = require("./utils/boolean");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");
const { normalizeIp } = require("./utils/network");

const normalizeOpenclawVersion = (rawVersion) => {
  if (!rawVersion) return null;
  return (
    String(rawVersion)
      .trim()
      .replace(/^openclaw\s*/i, "") || null
  );
};

// OpenClaw's suffix conventions (must stay in sync with the frontend
// comparator in lib/public/js/components/upgrade-tab/helpers.js):
//   2026.7.1-2      = out-of-band HOTFIX, ranks ABOVE the base release
//   2026.8.1-beta.3 = prerelease label, ranks BELOW the base release
// Splitting on "." first would turn "-beta.3" into a winning extra numeric
// part, silently ranking prereleases above their release — which flips the
// downgrade/backup gate for beta→release moves. Parse core and suffix first.
const parseVersion = (raw) => {
  // Tags arrive v-prefixed from GitHub; the frontend comparator strips the
  // prefix, so the server must too or "v2026.7.1" ranks as 0.7.1.
  const value = String(raw || "").trim().replace(/^v/, "");
  const dashIndex = value.indexOf("-");
  const core = dashIndex === -1 ? value : value.slice(0, dashIndex);
  const suffix = dashIndex === -1 ? "" : value.slice(dashIndex + 1);
  const nums = core
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isFinite(num) ? num : 0));
  return { nums, suffix };
};

// 0 = base release, 1 = numeric hotfix (above base), -1 = prerelease (below).
const versionSuffixRank = (suffix) => {
  if (!suffix) return 0;
  if (/^\d+$/.test(suffix)) return 1;
  return -1;
};

const compareVersionSuffixLabels = (a, b) => {
  const aParts = String(a).split(".");
  const bParts = String(b).split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const aPart = aParts[i] ?? "";
    const bPart = bParts[i] ?? "";
    if (aPart === bPart) continue;
    const aNum = Number.parseInt(aPart, 10);
    const bNum = Number.parseInt(bPart, 10);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
      return aNum > bNum ? 1 : -1;
    }
    return aPart > bPart ? 1 : -1;
  }
  return 0;
};

// A labeled suffix (2026.8.1-beta.3) is a prerelease BELOW its base; a bare
// numeric suffix (2026.7.1-2) is a hotfix ABOVE it — the single source of the
// classification the comparator's suffix ranking encodes.
const isPrereleaseVersion = (version) =>
  /-(?!\d+$)[0-9A-Za-z.]+$/.test(String(version || "").trim());

const compareVersionParts = (a, b) => {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const length = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < length; i += 1) {
    const aNum = va.nums[i] ?? 0;
    const bNum = vb.nums[i] ?? 0;
    if (aNum > bNum) return 1;
    if (aNum < bNum) return -1;
  }
  const rankA = versionSuffixRank(va.suffix);
  const rankB = versionSuffixRank(vb.suffix);
  if (rankA !== rankB) return rankA > rankB ? 1 : -1;
  if (va.suffix === vb.suffix) return 0;
  if (rankA === 1) {
    const hotfixA = Number.parseInt(va.suffix, 10);
    const hotfixB = Number.parseInt(vb.suffix, 10);
    if (hotfixA === hotfixB) return 0;
    return hotfixA > hotfixB ? 1 : -1;
  }
  return compareVersionSuffixLabels(va.suffix, vb.suffix);
};

const parseJsonFromNoisyOutput = (raw) => parseJsonObjectFromNoisyOutput(raw);

const parseJwtPayload = (token) => {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const getCodexAccountId = (accessToken) => {
  const payload = parseJwtPayload(accessToken);
  const auth = payload?.[CODEX_JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : null;
};

const isTruthyEnvFlag = (value) => isTruthyFlag(value);
const isDebugEnabled = () =>
  isTruthyEnvFlag(process.env.ALPHACLAW_DEBUG) ||
  isTruthyEnvFlag(process.env.DEBUG);

const getClientKey = (req) =>
  normalizeIp(req.ip || req.socket?.remoteAddress || "") || "unknown";

const kGithubRepoSlugPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

const resolveGithubRepoUrl = (repoInput) => {
  const cleaned = String(repoInput || "")
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (!cleaned) return "";
  // Exactly owner/repo, each a GitHub-legal slug. The old check only required
  // a "/", so `owner/repo#$(cmd)` or `owner/repo?x=1` passed the GitHub API
  // pre-checks (fragment/query ignored) and reached a shell string (fix wave
  // F102) — and `../x` shapes reached path builders.
  if (!kGithubRepoSlugPattern.test(cleaned)) {
    throw new Error('GITHUB_WORKSPACE_REPO must be in "owner/repo" format.');
  }
  return cleaned;
};

const createPkcePair = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
};

const resolveModelProvider = (modelKey) =>
  String(modelKey || "").split("/")[0] || "";

const parseCodexAuthorizationInput = (input) => {
  const value = String(input || "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") || "",
      state: url.searchParams.get("state") || "",
    };
  } catch {}
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code: code || "", state: state || "" };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") || "",
      state: params.get("state") || "",
    };
  }
  return { code: value, state: "" };
};

const normalizeOnboardingModels = (models) => {
  const deduped = new Map();
  for (const model of models || []) {
    if (!model?.key || typeof model.key !== "string") continue;
    const sourceProvider = resolveModelProvider(model.key);
    const isCodexRuntimeModel = sourceProvider === "codex";
    const key = isCodexRuntimeModel
      ? `openai/${model.key.split("/").slice(1).join("/")}`
      : model.key;
    const provider = resolveModelProvider(key);
    if (!kOnboardingModelProviders.has(provider)) continue;
    if (!deduped.has(key)) {
      const agentRuntime = isCodexRuntimeModel
        ? { id: "codex" }
        : model.agentRuntime;
      deduped.set(key, {
        key,
        provider,
        label: model.name || model.key,
        ...(typeof model.available === "boolean"
          ? { available: model.available }
          : {}),
        ...(typeof model.reasoning === "boolean"
          ? { reasoning: model.reasoning }
          : {}),
        ...(Number.isFinite(model.contextWindow)
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(Number.isFinite(model.maxTokens)
          ? { maxTokens: model.maxTokens }
          : {}),
        ...(model.compat && typeof model.compat === "object"
          ? { compat: model.compat }
          : {}),
        ...(agentRuntime ? { agentRuntime } : {}),
      });
    }
  }
  return Array.from(deduped.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
};

// The public origin for URLs we hand out or persist (webhook callbacks, the
// Gmail push endpoint, OAuth redirect_uri, allowedOrigins). One resolver for
// the whole server (fix wave PR 8a): configured canonical origin first, then
// the request through Express's trust-proxy view — X-Forwarded-Host is never
// read raw (any client can set it when no proxy fronts the process).
const getBaseUrl = (req) => resolvePublicOrigin(req);

const getApiEnableUrl = (svc, projectId) => {
  const apiMap = {
    gmail: "gmail.googleapis.com",
    calendar: "calendar-json.googleapis.com",
    tasks: "tasks.googleapis.com",
    docs: "docs.googleapis.com",
    meet: "meet.googleapis.com",
    drive: "drive.googleapis.com",
    contacts: "people.googleapis.com",
    sheets: "sheets.googleapis.com",
  };
  const api = apiMap[svc] || "";
  const project = projectId ? `?project=${projectId}` : "";
  return `https://console.developers.google.com/apis/api/${api}/overview${project}`;
};

const readGoogleCredentials = (clientName = "default") => {
  try {
    const credentialsPath = gogClientCredentialsPath(clientName);
    const c = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    const webCredentials = c.web || c.installed || c;
    return {
      clientId: webCredentials?.client_id || null,
      clientSecret: webCredentials?.client_secret || null,
      projectId: webCredentials?.project_id || null,
      path: credentialsPath,
      client: clientName,
    };
  } catch {
    return {
      clientId: null,
      clientSecret: null,
      projectId: null,
      path: gogClientCredentialsPath(clientName),
      client: clientName,
    };
  }
};

const kSecretKeyMatchers = [
  /(?:^|_)TOKEN(?:$|_)/i,
  /(?:^|_)API_KEY(?:$|_)/i,
  /(?:^|_)PASSWORD(?:$|_)/i,
  /(?:^|_)SECRET(?:$|_)/i,
  /(?:^|_)PRIVATE_KEY(?:$|_)/i,
];

const isSensitiveKey = (key) =>
  kSecretKeyMatchers.some((matcher) => matcher.test(String(key || "")));

const buildSecretReplacements = (...sources) => {
  const replacements = [];
  const seen = new Set();
  for (const source of sources) {
    for (const [rawKey, rawValue] of Object.entries(source || {})) {
      const key = String(rawKey || "").trim();
      const value = String(rawValue || "");
      if (!key || !value || !isSensitiveKey(key)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      replacements.push([value, `\${${key}}`]);
    }
  }
  return replacements.sort((a, b) => b[0].length - a[0].length);
};

module.exports = {
  kGithubRepoSlugPattern,
  isPrereleaseVersion,
  normalizeOpenclawVersion,
  compareVersionParts,
  parseJsonFromNoisyOutput,
  parseJwtPayload,
  getCodexAccountId,
  normalizeIp,
  isTruthyEnvFlag,
  isDebugEnabled,
  getClientKey,
  resolveGithubRepoUrl,
  createPkcePair,
  resolveModelProvider,
  parseCodexAuthorizationInput,
  normalizeOnboardingModels,
  getBaseUrl,
  getApiEnableUrl,
  readGoogleCredentials,
  isSensitiveKey,
  buildSecretReplacements,
};
