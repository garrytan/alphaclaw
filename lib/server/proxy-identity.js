// Shared identity handling for both gateway proxy boundaries (HTTP proxying in
// routes/proxy.js and the catch-all WS proxy in watchdog-terminal-ws.js).
//
// The gateway's trusted-proxy auth (node_modules/openclaw/docs/gateway/
// trusted-proxy-auth.md) trusts whatever user id arrives in the configured
// `gateway.auth.trustedProxy.userHeader`. AlphaClaw configures that header to
// `x-alphaclaw-user`, so a client-supplied value MUST never pass through —
// stripping happens unconditionally (team mode on or off) and injection only
// happens for a resolved operator session.

const net = require("net");
const { kTrustProxyHopsDeclared } = require("./constants");
const { isProxyHopAddress } = require("./login-client-ip");

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
// Same-origin marker of an attached Control UI session (control-ui-attach.js):
// AlphaClaw's own state, never the gateway's business.
const kControlUiAttachCookieName = "alphaclaw_control_ui";
// Known-browser sign-in pass (routes/auth.js), scoped to /api/auth; stripped
// here too so it can never reach the gateway.
const kDevicePassCookieName = "alphaclaw_device";

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

// Removes the AlphaClaw session, Control UI attach and sign-in pass cookies, keeping any
// other cookies intact. Returns "" when nothing else was left.
const stripSessionCookie = (cookieHeader) => {
  const raw = String(cookieHeader || "");
  if (!raw.trim()) return "";
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = part.split("=")[0].trim();
      return (
        name !== kSessionCookieName &&
        name !== kControlUiAttachCookieName &&
        name !== kDevicePassCookieName
      );
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

// OpenClaw treats a request as local (its "direct-local" ingress) when the
// socket peer is loopback and no Forwarded, X-Real-IP or X-Forwarded-* header
// is present, and local clients skip device pairing, keep self-declared
// scopes, may install plugins from the host, are exempt from the auth rate
// limiter and share one pre-auth socket budget. AlphaClaw reaches the gateway
// from loopback, so a forward that only strips forwarded headers makes every
// internet client look local. resolveGatewayClientAddress names the address a
// forward must present in X-Forwarded-For (gateway.trustedProxies holds
// 127.0.0.1, so OpenClaw attributes the request to it as a remote client), or
// "" for a client that really is on this host.
const kLoopbackRanges = new net.BlockList();
kLoopbackRanges.addSubnet("127.0.0.0", 8, "ipv4");
kLoopbackRanges.addAddress("::1", "ipv6");
kLoopbackRanges.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

const toIpLiteral = (value) => {
  let text = String(value || "").trim();
  const bracketed = text.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) text = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.split("%")[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(text)) text = text.slice(7);
  return net.isIP(text) ? text : "";
};

const isLoopbackIp = (ip) => {
  const family = net.isIP(ip);
  return family !== 0 && kLoopbackRanges.check(ip, family === 6 ? "ipv6" : "ipv4");
};

const hasForwardedRequestHeaders = (headers = {}) =>
  Object.keys(headers || {}).some((name) => {
    const lower = name.toLowerCase();
    return lower === "forwarded" || lower === "x-real-ip" || lower.startsWith("x-forwarded-");
  });

const resolveGatewayClientAddress = ({
  remoteAddress = "",
  headers = {},
  clientIp = "",
  trustProxyHopsDeclared = kTrustProxyHopsDeclared,
} = {}) => {
  const peer = toIpLiteral(remoteAddress);
  if (isLoopbackIp(peer) && !hasForwardedRequestHeaders(headers)) return "";
  // A forwarded address counts only behind a proxy hop, as for the sign-in
  // limiter (login-client-ip.js): a public peer with TRUST_PROXY_HOPS unset
  // is the client itself. A same-host proxy with TRUST_PROXY_HOPS=0 leaves
  // clientIp on loopback, so its own X-Forwarded-For entry is read right to
  // left past loopback hops, as OpenClaw reads it.
  const trusted = trustProxyHopsDeclared || isProxyHopAddress(peer);
  const rawForwardedFor = headers?.["x-forwarded-for"];
  const forwardedFor = String(Array.isArray(rawForwardedFor) ? rawForwardedFor.join(",") : rawForwardedFor || "")
    .split(",")
    .map(toIpLiteral)
    .reverse();
  const candidates = trusted ? [toIpLiteral(clientIp), ...forwardedFor, peer] : [peer];
  // Nothing but loopback (a same-host proxy that names no client): present
  // the peer anyway, and OpenClaw refuses the request as an unattributable
  // proxy instead of treating it as local.
  return candidates.find((ip) => ip && !isLoopbackIp(ip)) || peer || "127.0.0.1";
};

// In-place helper for the proxy boundaries: sanitize an incoming request's
// headers, ALWAYS strip client-supplied forwarded-evidence, and — when a
// member session resolved — stamp its identity plus a rebuilt X-Forwarded-For
// carrying the trust-proxy-resolved client IP (4.3/C5). Stripping evidence is
// unconditional: on a trusted-proxy gateway, client-supplied forwarded
// headers either forge attribution or disqualify the loopback local-direct
// fallback (trusted-proxy-auth.md), so they must never pass through the
// catch-all HTTP proxy or a WS upgrade (1.10).
// With { sessionless: true } (a forward no AlphaClaw session opened), a client
// that is not on this host is presented to the gateway as remote through
// X-Forwarded-For (resolveGatewayClientAddress); a session's forward stays as
// it was, so the signed-in Control UI keeps the gateway's local treatment.
const applyProxyIdentity = (req, member = null, clientIp = "", { sessionless = false } = {}) => {
  if (!req || typeof req !== "object") return req;
  const remoteClient = sessionless
    ? resolveGatewayClientAddress({
        remoteAddress: req.socket?.remoteAddress,
        headers: req.headers,
        clientIp,
      })
    : "";
  const headers = sanitizeProxyHeaders(req.headers);
  for (const evidenceHeader of kForwardedEvidenceHeaders) {
    delete headers[evidenceHeader];
  }
  const identity = buildIdentityHeaders(member);
  if (identity[kIdentityUserHeader]) {
    Object.assign(headers, identity);
    const resolved = String(clientIp || "").trim();
    if (resolved) headers["x-forwarded-for"] = resolved;
  } else if (remoteClient) {
    headers["x-forwarded-for"] = remoteClient;
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
  resolveGatewayClientAddress,
  resolveWsClientIp,
  sanitizeProxyHeaders,
  stripSessionCookie,
};
