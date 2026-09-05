// The ONE public-origin resolver (fix wave PR 8a, eng review E12).
//
// Persisted origins (gateway.controlUi.allowedOrigins), OAuth redirect_uri,
// the Gmail push endpoint, webhook callback URLs, invite links and rescue
// links all need "the URL operators reach this dashboard at". Before this
// module three resolvers disagreed, and two of them trusted X-Forwarded-Host
// verbatim — a header any client can set when no proxy sits in front, and
// which `trust proxy` does NOT vet (Express only uses it to derive
// req.hostname/req.protocol when the peer is a trusted hop).
//
// Order:
//   1. the configured canonical origin (ALPHACLAW_SETUP_URL, ALPHACLAW_BASE_URL,
//      RENDER_EXTERNAL_URL, URL, then Railway's domain variables) — the only
//      source a persisted value may come from when it is set;
//   2. the request, through Express's trust-proxy-resolved view: forwarded
//      headers are honored ONLY when `app.set("trust proxy", …)` marks this
//      peer as a trusted hop (first hop value only — proxies append), else the
//      Host header and the socket's own scheme;
//   3. http://localhost:<PORT> (zero-config installs with no Host header).
const { PORT } = require("./constants");

const kExplicitOriginEnvKeys = Object.freeze([
  "ALPHACLAW_SETUP_URL",
  "ALPHACLAW_BASE_URL",
  "RENDER_EXTERNAL_URL",
  "URL",
]);

const normalizeOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const basePath = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${basePath === "/" ? "" : basePath}`;
  } catch {
    return "";
  }
};

const resolveConfiguredOrigin = (env = process.env) => {
  for (const key of kExplicitOriginEnvKeys) {
    const normalized = normalizeOrigin(env[key]);
    if (normalized) return normalized;
  }
  const railwayPublicDomain = String(env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) return normalizeOrigin(`https://${railwayPublicDomain}`);
  return normalizeOrigin(env.RAILWAY_STATIC_URL);
};

const firstHeaderValue = (value) =>
  String(Array.isArray(value) ? value[0] : value || "")
    .split(",")[0]
    .trim();

// Express stores the compiled trust function under "trust proxy fn"; hop 0 is
// the peer that connected to us. Plain objects (unit tests, internal callers)
// have no app → never trusted.
const requestTrustsProxy = (req) => {
  const trust = req?.app?.get?.("trust proxy fn");
  if (typeof trust !== "function") return false;
  try {
    return trust(req.socket?.remoteAddress ?? req.ip ?? "", 0) === true;
  } catch {
    return false;
  }
};

const isLocalhostOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(String(origin || ""));

const resolveRequestOrigin = (req) => {
  if (!req || !req.headers) return "";
  const trusted = requestTrustsProxy(req);
  const forwardedHost = trusted ? firstHeaderValue(req.headers["x-forwarded-host"]) : "";
  const host = forwardedHost || String(req.headers.host || "").trim();
  if (!host || /[\s/\\]/.test(host)) return "";
  // req.protocol is already trust-proxy aware in Express; for bare objects fall
  // back to the socket's own scheme.
  const proto =
    String(req.protocol || "").trim() ||
    (trusted && firstHeaderValue(req.headers["x-forwarded-proto"])) ||
    (req.socket?.encrypted ? "https" : "http");
  return normalizeOrigin(`${proto}://${host}`);
};

const localFallbackOrigin = () => `http://localhost:${PORT || 3000}`;

const firstExplicitValue = (env) => {
  for (const key of kExplicitOriginEnvKeys) {
    const raw = String(env[key] || "").trim();
    if (raw) return { key, raw };
  }
  return null;
};

// A configured-but-malformed explicit URL is an operator mistake, not a
// license to derive the origin from the request (the operator asked for a
// fixed one): fall back to the local default and say so once.
const kWarnedMalformed = new Set();
const resolvePublicOrigin = (req, { env = process.env } = {}) => {
  const configured = resolveConfiguredOrigin(env);
  if (configured) return configured;
  const explicit = firstExplicitValue(env);
  if (explicit) {
    if (!kWarnedMalformed.has(explicit.key)) {
      kWarnedMalformed.add(explicit.key);
      console.warn(
        `[alphaclaw] ${explicit.key} is not a valid http(s) URL (${explicit.raw}); using ${localFallbackOrigin()} for generated links until it is fixed`,
      );
    }
    return localFallbackOrigin();
  }
  return resolveRequestOrigin(req) || localFallbackOrigin();
};

module.exports = {
  kExplicitOriginEnvKeys,
  normalizeOrigin,
  resolveConfiguredOrigin,
  resolveRequestOrigin,
  resolvePublicOrigin,
  requestTrustsProxy,
  isLocalhostOrigin,
};
