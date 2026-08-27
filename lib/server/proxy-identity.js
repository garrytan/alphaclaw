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

// Pure: identity headers for a resolved operator. The trusted-proxy contract
// only defines a single user header (`userHeader`); it has no name/avatar
// headers, so the operator id is all that crosses the boundary.
const buildIdentityHeaders = (operator) => {
  const id = String(operator?.id || "").trim();
  if (!id) return {};
  return { [kIdentityUserHeader]: id };
};

// In-place helper for the proxy boundaries: sanitize an incoming request's
// headers and, when an operator session resolved, stamp its identity.
const applyProxyIdentity = (req, operator = null) => {
  if (!req || typeof req !== "object") return req;
  req.headers = {
    ...sanitizeProxyHeaders(req.headers),
    ...buildIdentityHeaders(operator),
  };
  return req;
};

module.exports = {
  kIdentityUserHeader,
  kSessionCookieName,
  kStrippedIdentityHeaders,
  applyProxyIdentity,
  buildIdentityHeaders,
  sanitizeProxyHeaders,
  stripSessionCookie,
};
