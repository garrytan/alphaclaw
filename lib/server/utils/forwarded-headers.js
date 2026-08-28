// Single source of truth for how AlphaClaw handles forwarding + identity headers on
// the OpenClaw gateway proxy hops.
//
// Phase 1 (now): STRIP. AlphaClaw is a same-host reverse proxy that does not add
// its own X-Forwarded-* today. OpenClaw 2026.8 fails closed (403
// proxy_attribution_required) when forwarding headers arrive from an unlisted proxy,
// so any client-supplied `x-forwarded-*` / `Forwarded` / `X-Real-IP` must be removed
// at the boundary. The identity/scope headers (`x-alphaclaw-user`, `x-openclaw-scopes`)
// are ALSO stripped unconditionally so a logged-in user can never smuggle another
// identity to the gateway (a spoof guard) — Phase 4 re-injects them itself, always
// after this strip.
//
// Phase 4 (team mode): the same module gains a rebuild path — strip inbound, then
// inject a verified `x-alphaclaw-user` and rebuild `x-forwarded-for` from the
// trust-proxy-resolved client address. Keeping it here means the strip→rebuild flip
// happens in one place.

// Forwarding-provenance headers a same-host proxy must not pass through untrusted.
const kForwardingHeaders = Object.freeze([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "forwarded",
  "x-real-ip",
]);

// Identity/authority headers only AlphaClaw itself may set (Phase 4). Always stripped
// from inbound before any injection so a client cannot forge them.
const kIdentityHeaders = Object.freeze(["x-alphaclaw-user", "x-openclaw-scopes"]);

const kStrippedInboundHeaders = Object.freeze([
  ...kForwardingHeaders,
  ...kIdentityHeaders,
]);

// Remove the stripped headers from a plain headers object (returns a shallow copy;
// header names in Node are lowercased on inbound requests, but we match
// case-insensitively to be safe).
const stripInboundForwardedHeaders = (headers = {}) => {
  const out = {};
  const blocked = new Set(kStrippedInboundHeaders);
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(String(name).toLowerCase())) continue;
    out[name] = value;
  }
  return out;
};

// Apply the strip to an http.ClientRequest (the object http-proxy hands to its
// `proxyReq` / `proxyReqWs` events). Removing a header that is not present is a no-op.
const stripForwardedHeadersFromProxyReq = (proxyReq) => {
  if (!proxyReq || typeof proxyReq.removeHeader !== "function") return;
  for (const name of kStrippedInboundHeaders) {
    proxyReq.removeHeader(name);
  }
};

// Phase 4 rebuild path. Resolve the real client address for a raw (non-Express)
// upgrade request using the same hop semantics as Express's `trust proxy: N`:
// take the address N hops from the right of X-Forwarded-For; with no trusted
// hops (or an empty header) it is the socket peer. Inbound XFF is attacker-
// controlled beyond the trusted hops — never read past them (C5).
const resolveWsClientIp = ({
  remoteAddress = "",
  xForwardedFor = "",
  trustProxyHops = 0,
} = {}) => {
  const hops = Math.max(0, Number(trustProxyHops) || 0);
  if (hops === 0) return String(remoteAddress || "");
  const chain = String(xForwardedFor || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  // The socket peer is hop 1; each trusted hop consumes one XFF entry from
  // the right. More trusted hops than entries → leftmost available.
  const index = chain.length - hops;
  if (chain.length === 0) return String(remoteAddress || "");
  return chain[Math.max(0, index)] || String(remoteAddress || "");
};

// Inject the verified identity onto an outbound gateway proxyReq. Always runs
// AFTER the strip, so inbound spoofs are gone. Only member identities carry a
// durable email — legacy owner sessions inject nothing and behave exactly as
// before team mode (gateway-side device approval).
//
// x-openclaw-scopes is deliberately NOT injected: per-member authority is
// written into the gateway's identityScopes config by team/gateway-config.js,
// which the gateway treats as authoritative for the userHeader identity.
const applyIdentityProxyHeaders = ({
  proxyReq,
  identity = null,
  clientIp = "",
} = {}) => {
  if (!proxyReq || typeof proxyReq.setHeader !== "function") return false;
  if (!identity || identity.kind !== "member" || !identity.email) return false;
  try {
    proxyReq.setHeader("x-alphaclaw-user", String(identity.email));
    if (clientIp) proxyReq.setHeader("x-forwarded-for", String(clientIp));
    return true;
  } catch {
    // Headers already sent (streamed body) — leave the request unattributed.
    return false;
  }
};

module.exports = {
  kForwardingHeaders,
  kIdentityHeaders,
  kStrippedInboundHeaders,
  stripInboundForwardedHeaders,
  stripForwardedHeadersFromProxyReq,
  resolveWsClientIp,
  applyIdentityProxyHeaders,
};
