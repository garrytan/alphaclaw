const crypto = require("crypto");
const { timingSafeStringEqual } = require("../utils/timing-safe");

// "Connect Slack" (GST-3097): an admin signed in to AlphaClaw connects a Slack
// workspace to the box through Slack's OAuth v2 user-token flow, and the user
// token goes straight from Slack's answer into the same stores the secret drop
// writes (AlphaClaw's .env and OpenClaw's secret store), as
// SLACK_USER_TOKEN_<WORKSPACE>. The token is never logged, returned, shown or
// put in a URL. Only read scopes are asked for, and an answer that grants
// anything else is refused and its token revoked.

const kAuthorizeUrl = "https://slack.com/oauth/v2/authorize";
const kSlackApiBase = "https://slack.com/api";
const kCallbackPath = "/slack/oauth/callback";
const kStateTtlMs = 10 * 60 * 1000;
const kMaxOpenStates = 20;
const kSlackCallTimeoutMs = 15_000;
const kInstallsFileName = "slack-oauth-installs.json";
const kClientIdEnvKey = "SLACK_OAUTH_CLIENT_ID";
const kClientSecretEnvKey = "SLACK_OAUTH_CLIENT_SECRET";

const kReadUserScopes = Object.freeze([
  "search:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users:read.email",
]);
// Slack adds identify to every user token; it reads only the token's own user.
const kAllowedGrantedScopes = new Set([...kReadUserScopes, "identify"]);

const kWorkspaceNamesByTeamId = Object.freeze({ T02A11S1M: "YC" });
const kWorkspaceNamesByDomain = Object.freeze({ ycombinator: "YC", ycx26: "YCX26", overtonxyz: "OVERTON" });
const kEnvKeyPrefix = "SLACK_USER_TOKEN_";
const kTeamIdPattern = /^[TE][A-Z0-9]{2,20}$/;

const sanitizeWorkspaceName = (value) =>
  String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

// The env key for a workspace: the fixed map first (by team id, then by
// domain), else the team's domain, else its id.
const resolveTokenEnvKey = ({ teamId, domain }) => {
  const name =
    kWorkspaceNamesByTeamId[teamId] ||
    kWorkspaceNamesByDomain[String(domain || "").toLowerCase()] ||
    sanitizeWorkspaceName(domain) ||
    sanitizeWorkspaceName(teamId);
  const key = kEnvKeyPrefix + name;
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(key) && name ? key : null;
};

const domainFromUrl = (value) => {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase();
    return host.endsWith(".slack.com") ? host.slice(0, -".slack.com".length).split(".")[0] : "";
  } catch {
    return "";
  }
};

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

const createSlackOauth = ({
  readEnv,
  applier,
  installsStore,
  fetchImpl = (...args) => fetch(...args),
  nowFn = () => Date.now(),
  randomToken = () => crypto.randomBytes(24).toString("base64url"),
  logger = console,
}) => {
  // state → { sessionKey, createdAt }. One use each, ten minutes at most.
  const states = new Map();
  const csrfKey = crypto.randomBytes(32);
  const readConfig = () => ({ clientId: String(readEnv(kClientIdEnvKey) || ""), clientSecret: String(readEnv(kClientSecretEnvKey) || "") });

  const isConfigured = () => {
    const { clientId, clientSecret } = readConfig();
    return Boolean(clientId && clientSecret);
  };

  const pruneStates = () => {
    const now = nowFn();
    for (const [state, record] of states) if (now - record.createdAt >= kStateTtlMs) states.delete(state);
    while (states.size >= kMaxOpenStates) states.delete(states.keys().next().value);
  };

  // The page's CSRF value: tied to the admin's session and to this process.
  const csrfFor = (sessionCookie) =>
    sessionCookie ? crypto.createHmac("sha256", csrfKey).update(sha256Hex(sessionCookie)).digest("base64url") : "";

  const checkCsrf = (sessionCookie, presented) => timingSafeStringEqual(String(presented || ""), csrfFor(sessionCookie));

  const start = ({ sessionCookie, redirectUri }) => {
    const { clientId } = readConfig();
    if (!isConfigured()) return { ok: false, code: "not_configured" };
    if (!sessionCookie) return { ok: false, code: "no_session" };
    pruneStates();
    const state = randomToken();
    states.set(state, { sessionKey: sha256Hex(sessionCookie), createdAt: nowFn() });
    const url = new URL(kAuthorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", "");
    url.searchParams.set("user_scope", kReadUserScopes.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    logger.log("[slack-oauth] connect started");
    return { ok: true, url: url.toString() };
  };

  // Takes the state out whatever happens next, so it never works twice.
  const consumeState = ({ state, sessionCookie }) => {
    const key = String(state || "");
    const record = key ? states.get(key) : null;
    if (key) states.delete(key);
    if (!record) return { ok: false, code: "bad_state" };
    if (nowFn() - record.createdAt >= kStateTtlMs) return { ok: false, code: "expired_state" };
    if (!sessionCookie || !timingSafeStringEqual(sha256Hex(sessionCookie), record.sessionKey)) {
      return { ok: false, code: "other_session" };
    }
    return { ok: true };
  };

  const slackCall = async (method, { form = null, token = null } = {}) => {
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const res = await fetchImpl(kSlackApiBase + "/" + method, {
      method: "POST",
      headers,
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(kSlackCallTimeoutMs),
    });
    if (!res.ok) throw Object.assign(new Error("slack http " + res.status), { code: "slack_http" });
    return res.json();
  };

  const revoke = async (token) => {
    try {
      const answer = await slackCall("auth.revoke", { token });
      return Boolean(answer?.ok);
    } catch {
      return false;
    }
  };

  const listInstalls = () => {
    const installs = installsStore.read().installs;
    return Array.isArray(installs) ? installs : [];
  };

  const recordInstall = (install) => {
    installsStore.update((state) => {
      const rest = (Array.isArray(state.installs) ? state.installs : []).filter(
        (row) => row.teamId !== install.teamId && row.envKey !== install.envKey,
      );
      return { ...state, installs: [...rest, install] };
    });
  };

  // Slack's answer → stored token. Returns names and codes only, never the token.
  const finish = async ({ req, state, code, error, sessionCookie, redirectUri }) => {
    const verdict = consumeState({ state, sessionCookie });
    if (!verdict.ok) {
      logger.warn("[slack-oauth] callback refused: " + verdict.code);
      return verdict;
    }
    if (error) {
      logger.log("[slack-oauth] slack returned no grant: " + String(error).replace(/[^a-z_]/g, "").slice(0, 40));
      return { ok: false, code: error === "access_denied" ? "denied" : "slack_error" };
    }
    if (typeof code !== "string" || !code || code.length > 512) return { ok: false, code: "no_code" };
    const { clientId, clientSecret } = readConfig();
    if (!clientId || !clientSecret) return { ok: false, code: "not_configured" };

    let answer;
    try {
      answer = await slackCall("oauth.v2.access", {
        form: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
      });
    } catch (err) {
      logger.warn("[slack-oauth] code exchange failed: " + (err?.code || err?.name || "error"));
      return { ok: false, code: "exchange_failed" };
    }
    if (!answer?.ok) {
      logger.warn("[slack-oauth] code exchange refused: " + String(answer?.error || "unknown").replace(/[^a-z_]/g, "").slice(0, 40));
      return { ok: false, code: "exchange_refused" };
    }
    const user = answer.authed_user || {};
    const token = typeof user.access_token === "string" ? user.access_token : "";
    const granted = String(user.scope || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const extra = granted.filter((scope) => !kAllowedGrantedScopes.has(scope));
    const botToken = typeof answer.access_token === "string" && answer.access_token ? answer.access_token : "";
    if (!token || user.token_type !== "user" || !token.startsWith("xoxp-") || extra.length || botToken) {
      const revoked = [token ? await revoke(token) : null, botToken ? await revoke(botToken) : null].filter((v) => v !== null);
      logger.warn(
        "[slack-oauth] grant refused: " +
          (extra.length ? "extra scopes " + extra.join(",") : botToken ? "bot token granted" : "no user token") +
          " revoked=" + (revoked.length ? revoked.every(Boolean) : "n/a"),
      );
      return { ok: false, code: extra.length || botToken ? "extra_scopes" : "no_user_token", extraScopes: extra };
    }

    const teamId = String(answer.team?.id || "");
    const teamName = String(answer.team?.name || "").slice(0, 120);
    let domain = "";
    try {
      const who = await slackCall("auth.test", { token });
      if (who?.ok) domain = domainFromUrl(who.url);
    } catch {
      domain = "";
    }
    const envKey = kTeamIdPattern.test(teamId) || domain ? resolveTokenEnvKey({ teamId, domain }) : null;
    if (!envKey) {
      const revoked = await revoke(token);
      logger.warn("[slack-oauth] grant refused: workspace could not be named revoked=" + revoked);
      return { ok: false, code: "unnamed_workspace" };
    }

    const mapped = Boolean(kWorkspaceNamesByTeamId[teamId] || kWorkspaceNamesByDomain[domain.toLowerCase()]);
    const reserved = [...Object.values(kWorkspaceNamesByTeamId), ...Object.values(kWorkspaceNamesByDomain)].map((name) => kEnvKeyPrefix + name);
    if ((!mapped && reserved.includes(envKey)) || listInstalls().some((row) => row.envKey === envKey && row.teamId !== teamId)) {
      const revoked = await revoke(token);
      logger.warn("[slack-oauth] grant refused: name " + envKey + " belongs to another workspace revoked=" + revoked);
      return { ok: false, code: "name_taken", envKey };
    }

    let result;
    try {
      result = await applier.apply({ req, name: envKey, rawValue: token });
    } catch (err) {
      result = { status: "failed", code: err?.code || "error" };
    }
    if (result.status !== "stored" && result.status !== "partial") {
      const revoked = timingSafeStringEqual(String(readEnv(envKey) || ""), token) ? "skipped_existing" : await revoke(token);
      logger.error("[slack-oauth] store failed name=" + envKey + " code=" + (result.code || result.status) + " revoked=" + revoked);
      return { ok: false, code: "store_failed", envKey };
    }
    const install = {
      teamId,
      teamName,
      domain,
      envKey,
      installedAt: new Date(nowFn()).toISOString(),
      scopes: granted,
      status: result.status,
      stores: { env: Boolean(result.stores?.env), store: Boolean(result.stores?.store) },
      reachEnv: result.reach?.env || null,
    };
    recordInstall(install);
    logger.log("[slack-oauth] connected team=" + teamId + " name=" + envKey + " scopes=" + granted.length + " status=" + result.status);
    return { ok: true, install, status: result.status };
  };

  return { isConfigured, start, finish, listInstalls, csrfFor, checkCsrf };
};

module.exports = {
  createSlackOauth,
  resolveTokenEnvKey,
  domainFromUrl,
  kReadUserScopes,
  kAllowedGrantedScopes,
  kCallbackPath,
  kStateTtlMs,
  kInstallsFileName,
  kClientIdEnvKey,
  kClientSecretEnvKey,
};
