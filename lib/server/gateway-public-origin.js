// gateway.publicOrigin: the origin OpenClaw puts in the links it sends to
// channels (its credential prompt at <origin>/openclaw/ask/<id>, chat deep
// links, plugin viewer links, MCP OAuth callbacks). AlphaClaw writes it once,
// from the configured setup URL, and never overwrites a value already there.
// OpenClaw's schema accepts only a bare https origin, or http on a literal
// loopback host, and refuses one under gateway.portals.ingress.domain; a
// config it refuses would keep the gateway from starting, so anything else is
// skipped with the reason logged.
const { resolveConfiguredOrigin } = require("./public-origin");

const kLoopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const decideGatewayPublicOrigin = (cfg, configured = resolveConfiguredOrigin()) => {
  const current = cfg?.gateway?.publicOrigin;
  if (typeof current === "string" && current.trim()) return { write: null, reason: "already_set" };
  if (!configured) return { write: null, reason: "no setup URL is configured (ALPHACLAW_SETUP_URL)" };
  let url;
  try {
    url = new URL(configured);
  } catch {
    return { write: null, reason: "the setup URL is not a URL" };
  }
  if (url.pathname.replace(/\/+$/, "") !== "") return { write: null, reason: "the setup URL has a path" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && kLoopbackHosts.has(url.hostname))) {
    return { write: null, reason: "the setup URL is not https (OpenClaw allows http only on localhost)" };
  }
  const portalDomain = String(cfg?.gateway?.portals?.ingress?.domain || "").toLowerCase();
  const host = url.hostname.toLowerCase();
  if (portalDomain && (host === portalDomain || host.endsWith(`.${portalDomain}`))) {
    return { write: null, reason: "the setup URL is under gateway.portals.ingress.domain" };
  }
  return { write: url.origin, reason: null };
};

module.exports = { decideGatewayPublicOrigin };
