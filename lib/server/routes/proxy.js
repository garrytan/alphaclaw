const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const {
  applyProxyIdentity,
  kForwardedEvidenceHeaders,
  sanitizeProxyHeaders,
} = require("../proxy-identity");

const {
  kHopByHopResponseHeaders,
  kAlwaysStrippedResponseHeaders,
} = require("./response-header-policy");
const {
  isUnsafeGatewayProxyPath,
  kControlUiMount,
} = require("../control-ui-mount");

const kOpenAiCompatProxyPathPattern =
  /^\/v1\/(?:chat\/completions|responses|embeddings|models(?:\/[^/?#]+)?)$/;

const extractBearerToken = (authorization) => {
  const match = String(authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
};

const getApiAuthThrottleState = (authThrottle, req, now) => {
  if (!authThrottle || typeof authThrottle.getOrCreateLoginAttemptState !== "function") {
    return null;
  }
  const clientKey =
    typeof authThrottle.getClientKey === "function"
      ? authThrottle.getClientKey(req)
      : req.ip || req.socket?.remoteAddress || "unknown";
  return {
    clientKey,
    state: authThrottle.getOrCreateLoginAttemptState(clientKey, now),
  };
};

const sendTooManyAuthAttempts = (res, retryAfterSec = 1) => {
  const normalizedRetryAfterSec = Math.max(1, Math.ceil(Number(retryAfterSec) || 1));
  res.set("Retry-After", String(normalizedRetryAfterSec));
  return res.status(429).json({
    error: "Too many attempts. Try again shortly.",
    retryAfterSec: normalizedRetryAfterSec,
  });
};

const timingSafeStringEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const extractBodyBuffer = (req) => {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body), "utf8");
  }
  return Buffer.alloc(0);
};

const createGatewayProxyHeaders = ({ reqHeaders, bodyBuffer }) => {
  // sanitizeProxyHeaders strips client-supplied identity headers (spoofing
  // guard) and the AlphaClaw session cookie.
  const headers = sanitizeProxyHeaders(reqHeaders || {});
  for (const evidenceHeader of kForwardedEvidenceHeaders) {
    delete headers[evidenceHeader];
  }
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  // Express has already parsed and (if gzip/deflate) inflated the body, so
  // the bytes we reserialize are plain JSON. Forwarding the original
  // Content-Encoding would tell the gateway to gunzip plain text and fail.
  delete headers["content-encoding"];
  delete headers.cookie;
  if (bodyBuffer.length > 0) {
    headers["content-length"] = String(bodyBuffer.length);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  return headers;
};

const proxyOpenAiCompatRequest = ({
  req,
  res,
  getGatewayUrl,
  getGatewayToken,
  openAiCompatApiThrottle,
}) => {
  const now = Date.now();
  const throttleState = getApiAuthThrottleState(
    openAiCompatApiThrottle,
    req,
    now,
  );
  if (
    throttleState &&
    typeof openAiCompatApiThrottle.evaluateLoginThrottle === "function"
  ) {
    const throttle = openAiCompatApiThrottle.evaluateLoginThrottle(
      throttleState.state,
      now,
    );
    if (throttle.blocked) {
      return sendTooManyAuthAttempts(res, throttle.retryAfterSec);
    }
  }

  const bearerToken = extractBearerToken(req.headers.authorization);
  const expectedGatewayToken = String(getGatewayToken?.() || "").trim();
  if (
    !bearerToken ||
    !expectedGatewayToken ||
    !timingSafeStringEqual(bearerToken, expectedGatewayToken)
  ) {
    if (
      throttleState &&
      typeof openAiCompatApiThrottle.recordLoginFailure === "function"
    ) {
      const failure = openAiCompatApiThrottle.recordLoginFailure(
        throttleState.state,
        now,
      );
      if (failure.locked) {
        return sendTooManyAuthAttempts(res, failure.retryAfterSec);
      }
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (
    throttleState?.clientKey &&
    typeof openAiCompatApiThrottle?.recordLoginSuccess === "function"
  ) {
    openAiCompatApiThrottle.recordLoginSuccess(throttleState.clientKey);
  }

  let gateway;
  try {
    gateway = new URL(getGatewayUrl());
  } catch {
    return res.status(502).json({ error: "Gateway unavailable" });
  }

  const bodyBuffer = extractBodyBuffer(req);
  const protocolClient = gateway.protocol === "https:" ? https : http;
  const headers = createGatewayProxyHeaders({
    reqHeaders: req.headers,
    bodyBuffer,
  });
  headers.authorization = `Bearer ${bearerToken}`;

  const requestOptions = {
    protocol: gateway.protocol,
    hostname: gateway.hostname,
    port: gateway.port,
    method: req.method,
    path: req.originalUrl || req.url,
    headers,
  };

  const proxyReq = protocolClient.request(requestOptions, (proxyRes) => {
    res.statusCode = proxyRes.statusCode || 502;
    for (const [key, value] of Object.entries(proxyRes.headers || {})) {
      if (value == null) continue;
      const lowerKey = key.toLowerCase();
      if (kHopByHopResponseHeaders.has(lowerKey)) continue;
      if (kAlwaysStrippedResponseHeaders.has(lowerKey)) continue;
      res.setHeader(key, value);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Gateway unavailable" });
    } else {
      res.end();
    }
  });

  if (bodyBuffer.length > 0) {
    proxyReq.write(bodyBuffer);
  }
  proxyReq.end();
};

// /openclaw, /openclaw/ and every path below it (the Control UI mount) —
// but never /openclawx. Trailing-slash form included so the JSON parser skips
// it like every other proxied path (Express matches "/openclaw" for both).
const kOpenClawPathPattern = /^\/openclaw(?:\/.*)?$/;
const kAssetsPathPattern = /^\/assets\/.+/;

// A2A is a gateway-served channel whose auth is a per-peer bearer token that
// the gateway validates itself, so these paths forward WITHOUT requireAuth and
// without the gateway-token equality the /v1 compat proxy enforces — imposing
// either would reject a valid peer before the gateway ever sees it. Agent Card
// discovery is public by design ("Agent Card discovery is intentionally
// public", openclaw docs/channels/a2a.md). Without these routes an enabled A2A
// channel is unreachable through the front door: the gateway listens on
// container loopback only, so it cannot be published around this proxy.
const kA2aPathPattern = /^\/a2a\/.+/;
const kAgentCardPathPattern = /^\/\.well-known\/agent(?:-card)?\.json$/;

// Local /api namespaces that are NOT in SETUP_API_PREFIXES (the catch-all
// proxy's list) but ARE served by locally-registered routes, which need
// parsed bodies. The parser-skip predicate below must treat them as local.
// tests/server/proxy-structural-guard.test.js asserts every locally-
// registered /api route is covered by the union of this list and
// SETUP_API_PREFIXES.
const kLocalOnlyApiPrefixes = [
  "/api/agent",
  "/api/alphaclaw",
  "/api/claude-code",
  "/api/diagnose",
  "/api/doctor",
  "/api/events",
  "/api/gateway-status",
];

// A proxied path's request body is piped verbatim to the gateway, so body
// parsers must NOT consume it (a parsed stream reaches the gateway empty and
// the request hangs until the gateway gives up). Matching is SEGMENT-aware
// ("/api/gateway" covers "/api/gateway/restart" but NOT "/api/gateway-echo")
// so a gateway path sharing a local prefix's first characters is still
// proxied unparsed. `/v1/*` compat paths are intentionally NOT proxied-paths:
// their proxy reserializes `req.body` and needs the parser.
//
// Gray zone (unchanged from the pre-fix behavior): a request into a local
// namespace that no local route matches falls to the catch-all and may be
// proxied WITH a consumed body — those gateway POSTs hung before this fix
// and are out of scope; the catch-all's own prefix list is deliberately left
// with its original semantics.
const matchesApiPrefixSegment = (requestPath, prefix) =>
  requestPath === prefix || requestPath.startsWith(`${prefix}/`);

const createIsProxiedPath = (setupApiPrefixes = []) => {
  const localPrefixes = [...setupApiPrefixes, ...kLocalOnlyApiPrefixes];
  return (req) => {
    const requestPath = String(req?.path || "");
    if (requestPath === "/openclaw") return true;
    if (kOpenClawPathPattern.test(requestPath)) return true;
    if (kAssetsPathPattern.test(requestPath)) return true;
    if (kA2aPathPattern.test(requestPath)) return true;
    if (kAgentCardPathPattern.test(requestPath)) return true;
    if (/^\/api\/.+/.test(requestPath)) {
      return !localPrefixes.some((prefix) =>
        matchesApiPrefixSegment(requestPath, prefix),
      );
    }
    return false;
  };
};

// Skipping the parser removes its accidental size cap, so bound proxied
// request bodies by counting streamed bytes (a Content-Length check alone is
// bypassed by chunked encoding). Returns false when the request was rejected.
const kProxiedBodyMaxBytes = 50 * 1024 * 1024;

const enforceProxiedBodyLimit = (req, res, maxBytes = kProxiedBodyMaxBytes) => {
  const declaredLength = Number.parseInt(String(req.headers["content-length"] || ""), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    res.status(413).json({ error: "Request body too large" });
    return false;
  }
  let streamedBytes = 0;
  const onData = (chunk) => {
    streamedBytes += chunk.length;
    if (streamedBytes > maxBytes) {
      req.removeListener("data", onData);
      if (!res.headersSent) {
        // Let the 413 flush to the client BEFORE tearing down the shared
        // socket — destroying immediately turns the response into a reset.
        res.once("finish", () => {
          try {
            req.destroy();
          } catch {}
        });
        res.status(413).json({ error: "Request body too large" });
      } else {
        try {
          req.destroy();
        } catch {}
      }
    }
  };
  req.on("data", onData);
  return true;
};

const registerProxyRoutes = ({
  app,
  proxy,
  getGatewayUrl,
  getGatewayToken,
  isOpenAiCompatApiEnabled = () => true,
  openAiCompatApiThrottle = null,
  SETUP_API_PREFIXES,
  requireAuth,
  oauthCallbackMiddleware,
  webhookMiddleware,
  resolveProxyIdentity = () => null,
}) => {
  const kHooksPathPattern = /^\/hooks\/.+/;
  const kWebhookPathPattern = /^\/webhook\/.+/;
  const kApiPathPattern = /^\/api\/.+/;
  const isProxiedPath = createIsProxiedPath(SETUP_API_PREFIXES);

  // Every gateway-bound request goes through here: the streamed body cap is
  // enforced (the parser skip removed its accidental limit), inbound identity
  // headers and the setup_token cookie are ALWAYS stripped (team mode on or
  // off), and the operator identity header is injected only when the session
  // resolves to a known operator (team mode on).
  const forwardToGateway = (req, res) => {
    if (!enforceProxiedBodyLimit(req, res)) return;
    let operator = null;
    try {
      operator = resolveProxyIdentity(req);
    } catch {
      operator = null;
    }
    // req.ip is the trust-proxy-resolved client (app.set("trust proxy",...));
    // applyProxyIdentity rebuilds X-Forwarded-For from it for a member and
    // strips all inbound forwarded-evidence either way.
    applyProxyIdentity(req, operator, req.ip);
    proxy.web(req, res, { target: getGatewayUrl() });
  };

  // ── Control UI mount ──────────────────────────────────────────────────
  //
  //   Browser ── GET /openclaw/fonts/x.css ──▶ requireAuth ──▶ traversal guard
  //        ──▶ forwardToGateway (URL UNTOUCHED) ──▶ gateway, basePath=/openclaw
  //                                               stamps <html data-…-base-path="/openclaw">
  //                                               serves /openclaw/{assets,fonts,themes,sw.js,…}
  //
  // The gateway serves the dashboard under gateway.controlUi.basePath=/openclaw
  // (pinned by ensureGatewayProxyConfig, see control-ui-mount.js) and the UI
  // resolves EVERY resource URL from the base path the gateway stamps — not
  // from the page URL. AlphaClaw therefore never strips the prefix: the old
  // strip (mount a root-served UI under /openclaw) made the gateway stamp an
  // empty base path, so fonts, themes, sw.js and the bootstrap config were
  // fetched from AlphaClaw's root, 404'd, and the UI showed "Styles failed to
  // load". ALPHACLAW_CONTROL_UI_MOUNT=legacy (deployment env only) restores
  // the strip for one release cycle as the rollback path — boot removes the
  // basePath key in that mode so both sides still agree.
  //
  // Traversal guard: Express `req.path` is un-normalized, and http-proxy-3's
  // getPath() runs `new URL(req.url)` and forwards pathname+search — the
  // `..`/`%2e` collapse and `\`→`/` happen right here at the proxy.web
  // handoff (the gateway parses the same way). So `/openclaw/../v1/models`,
  // `%2e%2e` or `..\v1` would leave the Control UI namespace and reach the
  // gateway's root handlers with only an AlphaClaw session cookie unless the
  // RAW request-target is checked first. Same guard on the retained
  // /assets/* forward.
  const kLegacyStrip = kControlUiMount === "legacy";
  const rejectUnsafePath = (req, res) => {
    if (!isUnsafeGatewayProxyPath(req.originalUrl || req.url)) return false;
    res.status(404).json({ error: "Not found" });
    return true;
  };
  app.all(kOpenClawPathPattern, requireAuth, (req, res) => {
    if (rejectUnsafePath(req, res)) return;
    if (kLegacyStrip) {
      // Pre-v0.9.83 mount of the gateway's ROOT UI under /openclaw. The
      // query survives (the old exact-match handler dropped it).
      const stripped = req.url.replace(/^\/openclaw(?=[/?#]|$)/, "");
      req.url = stripped.startsWith("/") ? stripped : `/${stripped}`;
    }
    forwardToGateway(req, res);
  });
  app.all(kAssetsPathPattern, requireAuth, (req, res) => {
    if (rejectUnsafePath(req, res)) return;
    forwardToGateway(req, res);
  });

  // Deliberately no requireAuth: the A2A peer credential IS the caller's
  // identity, and the gateway is the only component that can validate it.
  // forwardToGateway still strips inbound identity headers and the setup
  // cookie and enforces the streamed body cap, so an unauthenticated caller
  // reaches the gateway's own A2A auth and nothing else.
  // rejectUnsafePath applies here too: an unauthenticated route must not be
  // the one place a traversal or bad-encoding path reaches the gateway.
  app.all(kA2aPathPattern, (req, res) => {
    if (rejectUnsafePath(req, res)) return;
    forwardToGateway(req, res);
  });
  app.all(kAgentCardPathPattern, (req, res) => {
    if (rejectUnsafePath(req, res)) return;
    forwardToGateway(req, res);
  });

  app.all("/oauth/:id", oauthCallbackMiddleware);
  app.all(kHooksPathPattern, webhookMiddleware);
  app.all(kWebhookPathPattern, webhookMiddleware);

  app.all(kOpenAiCompatProxyPathPattern, (req, res) => {
    if (!isOpenAiCompatApiEnabled()) {
      return res.status(404).json({ error: "Not found" });
    }
    return proxyOpenAiCompatRequest({
      req,
      res,
      getGatewayUrl,
      getGatewayToken,
      openAiCompatApiThrottle,
    });
  });

  // Catch-all keeps its ORIGINAL semantics (raw startsWith on the setup
  // list) — changing which unmatched paths proxy vs 404 is out of scope for
  // the body-parsing fix. isProxiedPath governs parsing only.
  app.all(kApiPathPattern, (req, res, next) => {
    if (SETUP_API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    forwardToGateway(req, res);
  });
};

module.exports = {
  kOpenAiCompatProxyPathPattern,
  kA2aPathPattern,
  kAgentCardPathPattern,
  createIsProxiedPath,
  registerProxyRoutes,
  // Exported for tests.
  __testing: {
    createGatewayProxyHeaders,
    extractBearerToken,
    kForwardedEvidenceHeaders,
    kHopByHopResponseHeaders,
    kAlwaysStrippedResponseHeaders,
    enforceProxiedBodyLimit,
    kProxiedBodyMaxBytes,
  },
};
