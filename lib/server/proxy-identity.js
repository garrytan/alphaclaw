// Shared identity handling for both gateway proxy boundaries (HTTP proxying in
// routes/proxy.js and the catch-all WS proxy in watchdog-terminal-ws.js).
//
// The gateway's trusted-proxy auth (node_modules/openclaw/docs/gateway/
// trusted-proxy-auth.md) trusts whatever user id arrives in the configured
// `gateway.auth.trustedProxy.userHeader`. AlphaClaw configures that header to
// `x-alphaclaw-user`, so a client-supplied value MUST never pass through —
// stripping happens unconditionally (team mode on or off) and injection only
// happens for a resolved operator session.

const kIdentityUserHeader = "x-alphaclaw-user";

// Headers the gateway may treat as proxy-asserted identity. Includes the
// header names from the trusted-proxy doc's proxy examples so a config edited
// by hand to one of those names is still spoof-safe, plus the scopes header
// the gateway honors on identity-bearing HTTP requests.
const kStrippedIdentityHeaders = Object.freeze([
  kIdentityUserHeader,
  "x-forwarded-user",
  "x-auth-request-email",
  "x-pomerium-claim-email",
  "x-pomerium-jwt-assertion",
  "x-openclaw-scopes",
]);

const kSessionCookieName = "setup_token";

// Forwarded-evidence headers: on a trusted-proxy gateway, any of these on a
// loopback request disqualifies the local-direct password fallback
// (trusted-proxy-auth.md "Runtime rules"). Every gateway-bound surface that
// relies on loopback locality must strip them — the proxy path, the OpenAI
// bridge, AND the unauthenticated webhook/oauth path (where the client fully
// controls them).
const kForwardedEvidenceHeaders = Object.freeze([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-real-ip",
]);

// Removes the AlphaClaw session cookie, keeping any other cookies intact.
// Returns "" when setup_token was the only cookie.
const stripSessionCookie = (cookieHeader) => {
  const raw = String(cookieHeader || "");
  if (!raw.trim()) return "";
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = part.split("=")[0].trim();
      return name !== kSessionCookieName;
    });
  return kept.join("; ");
};

// Pure: returns a new headers object with identity headers and the AlphaClaw
// session cookie removed. Never mutates the input.
const sanitizeProxyHeaders = (headers = {}) => {
  const source = headers && typeof headers === "object" ? headers : {};
  const sanitized = {};
  for (const [key, value] of Object.entries(source)) {
    const lowerKey = key.toLowerCase();
    if (kStrippedIdentityHeaders.includes(lowerKey)) continue;
    if (lowerKey === "cookie") {
      const remaining = stripSessionCookie(value);
      if (remaining) sanitized[key] = remaining;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
};

// Pure: identity headers for a resolved member. The trusted-proxy contract
// only defines a single user header (`userHeader`); it has no name/avatar
// headers, so the member email — the id `gateway.auth.allowUsers` and
// `identityScopes` are keyed by — is all that crosses the boundary.
const buildIdentityHeaders = (member) => {
  const id = String(member?.email || member?.id || "").trim();
  if (!id) return {};
  return { [kIdentityUserHeader]: id };
};

// Trust-proxy-resolved client address for a raw WS upgrade request, which has
// no Express `req.ip`. Mirrors Express's `trust proxy` hop count: walk the
// X-Forwarded-For chain right-to-left past `trustProxyHops` trusted hops.
const resolveWsClientIp = ({
  remoteAddress = "",
  xForwardedFor = "",
  trustProxyHops = 0,
} = {}) => {
  const remote = String(remoteAddress || "").trim();
  const chain = String(xForwardedFor || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const hops = Math.max(0, Number(trustProxyHops) || 0);
  if (chain.length === 0 || hops === 0) return remote;
  // Mirror Express proxy-addr: the address list is [remote, ...reverse(XFF)],
  // and `trust proxy = N` resolves to list[N] — i.e. XFF[length - N]. When N
  // exceeds the chain, the leftmost (original client) is used.
  const idx = chain.length - hops;
  if (idx < 0) return chain[0];
  return chain[idx] || remote;
};

// In-place helper for the proxy boundaries: sanitize an incoming request's
// headers, ALWAYS strip client-supplied forwarded-evidence, and — when a
// member session resolved — stamp its identity plus a rebuilt X-Forwarded-For
// carrying the trust-proxy-resolved client IP (4.3/C5). Stripping evidence is
// unconditional: on a trusted-proxy gateway, client-supplied forwarded
// headers either forge attribution or disqualify the loopback local-direct
// fallback (trusted-proxy-auth.md), so they must never pass through the
// catch-all HTTP proxy or a WS upgrade (1.10).
const applyProxyIdentity = (req, member = null, clientIp = "") => {
  if (!req || typeof req !== "object") return req;
  const headers = sanitizeProxyHeaders(req.headers);
  for (const evidenceHeader of kForwardedEvidenceHeaders) {
    delete headers[evidenceHeader];
  }
  const identity = buildIdentityHeaders(member);
  if (identity[kIdentityUserHeader]) {
    Object.assign(headers, identity);
    const resolved = String(clientIp || "").trim();
    if (resolved) headers["x-forwarded-for"] = resolved;
  }
  req.headers = headers;
  return req;
};

module.exports = {
  kForwardedEvidenceHeaders,
  kIdentityUserHeader,
  kSessionCookieName,
  kStrippedIdentityHeaders,
  applyProxyIdentity,
  buildIdentityHeaders,
  resolveWsClientIp,
  sanitizeProxyHeaders,
  stripSessionCookie,
};
