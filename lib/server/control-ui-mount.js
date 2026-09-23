// The ONE owner of AlphaClaw's Control UI mount contract. Leaf module (zero
// requires) so bin/, routes/, gateway.js and tests can all load it cheaply.
//
//   Browser ── GET /openclaw/fonts/x.css ──▶ AlphaClaw ── verbatim ──▶ Gateway
//                                            │                          basePath=/openclaw
//                                            └─ unauthenticated?        stamps <html data-…-base-path="/openclaw">
//                                               resource → 401          serves /openclaw/{assets,fonts,themes,sw.js,…}
//                                               document → 302 /login.html
//
// The gateway serves its Control UI under `gateway.controlUi.basePath`, which
// ensureGatewayProxyConfig (gateway.js) pins to kControlUiBasePath. The UI
// resolves every resource URL (fonts, themes, sw.js, bootstrap config,
// avatars) from the base-path attribute the gateway stamps into index.html —
// NOT from the page URL. Stripping the prefix in the proxy (the pre-v0.9.83
// behavior) made the gateway stamp an empty base path, so the UI fetched
// those resources from AlphaClaw's root, 404'd, and showed "Styles failed to
// load". Both sides of the contract therefore live here:
//
//   mount = basepath (default)   config writes basePath=/openclaw, proxy forwards /openclaw* verbatim
//   mount = legacy               config REMOVES AlphaClaw's basePath, proxy strips the prefix (pre-fix)
//
// ALPHACLAW_CONTROL_UI_MOUNT is deployment-env only (deployment-only-env.js):
// an agent that can write .env must not be able to flip the mount under a
// running proxy. It is resolved ONCE per process (kControlUiMount) so the
// proxy routes and the config writer can never disagree.

const kControlUiBasePath = "/openclaw";
const kControlUiMountEnvKey = "ALPHACLAW_CONTROL_UI_MOUNT";
const kControlUiMountModes = ["basepath", "legacy"];
// Bound for operator-supplied config text echoed into a log line.
const kLoggedValueMaxChars = 200;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Exact port of OpenClaw's normalizeControlUiBasePath (control-ui-shared.ts):
// "" or "/" → ""; otherwise a leading-slash path without a trailing slash.
// Case is preserved — the gateway compares pathnames case-sensitively.
const normalizeControlUiBasePath = (value) => {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
};

const resolveControlUiMount = (env = process.env, { warn = console.warn } = {}) => {
  const raw = String(env?.[kControlUiMountEnvKey] ?? "").trim().toLowerCase();
  if (!raw) return "basepath";
  if (kControlUiMountModes.includes(raw)) return raw;
  warn(
    `[alphaclaw] ${kControlUiMountEnvKey}=${JSON.stringify(raw.slice(0, 40))} is not one of ${kControlUiMountModes.join("|")} — using basepath`,
  );
  return "basepath";
};

// Resolved once at module load: every consumer in this process sees the same
// mode. Tests that need the other mode set the env and re-require the module.
const kControlUiMount = resolveControlUiMount();

const describeLoggedValue = (value) => {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text ?? "");
  return text.length > kLoggedValueMaxChars
    ? `${text.slice(0, kLoggedValueMaxChars)}…`
    : text;
};

// Pure config transform (no fs). ONE equivalence rule in both modes:
//   basepath: the stored value must be the canonical string "/openclaw" — any
//             other raw value ("openclaw/", "/openclaw/", "/dash", 123) is
//             rewritten, so a later legacy removal always matches.
//   legacy:   remove the key when its normalized value IS /openclaw (ours);
//             a hand-set different path is left alone.
// Returns { changed, previous }.
const applyControlUiBasePath = (cfg, { mount = kControlUiMount, log = console.log } = {}) => {
  if (!isPlainObject(cfg)) {
    throw new TypeError("applyControlUiBasePath: cfg must be a plain object");
  }
  if (!isPlainObject(cfg.gateway)) {
    if (cfg.gateway !== undefined) {
      log(
        `[alphaclaw] gateway was ${describeLoggedValue(cfg.gateway)} (not an object) — replaced with {}`,
      );
    }
    cfg.gateway = {};
  }
  const controlUi = cfg.gateway.controlUi;
  const hadObject = isPlainObject(controlUi);
  const previous = hadObject ? controlUi.basePath : undefined;

  if (mount === "legacy") {
    if (!hadObject) {
      if (controlUi === undefined) return { changed: false, previous };
      log(
        `[alphaclaw] gateway.controlUi was ${describeLoggedValue(controlUi)} (not an object) — replaced with {}`,
      );
      cfg.gateway.controlUi = {};
      return { changed: true, previous };
    }
    if (normalizeControlUiBasePath(previous) === kControlUiBasePath) {
      delete controlUi.basePath;
      log(
        `[alphaclaw] control_ui_mount=legacy — removed gateway.controlUi.basePath=${describeLoggedValue(previous)} (the proxy strips the prefix again)`,
      );
      return { changed: true, previous };
    }
    return { changed: false, previous };
  }

  if (!hadObject) {
    if (controlUi !== undefined) {
      log(
        `[alphaclaw] gateway.controlUi was ${describeLoggedValue(controlUi)} (not an object) — replaced with {}`,
      );
    }
    cfg.gateway.controlUi = {};
  }
  if (cfg.gateway.controlUi.basePath === kControlUiBasePath) {
    return { changed: false, previous };
  }
  cfg.gateway.controlUi.basePath = kControlUiBasePath;
  log(
    previous === undefined
      ? `[alphaclaw] Set gateway.controlUi.basePath=${kControlUiBasePath} (AlphaClaw mounts the Control UI there)`
      : `[alphaclaw] Replaced gateway.controlUi.basePath=${describeLoggedValue(previous)} with ${kControlUiBasePath} (AlphaClaw's proxy, dashboard links and WebSocket auth are pinned to it)`,
  );
  return { changed: true, previous };
};

// Postcondition check for the active mode — used after a whole-file config
// restore, where ensureGatewayProxyConfig's boolean cannot tell "already
// correct" from "failed".
const controlUiMountSatisfied = (cfg, mount = kControlUiMount) => {
  const controlUi = cfg?.gateway?.controlUi;
  if (mount === "legacy") {
    return (
      !isPlainObject(controlUi) ||
      normalizeControlUiBasePath(controlUi.basePath) !== kControlUiBasePath
    );
  }
  return isPlainObject(controlUi) && controlUi.basePath === kControlUiBasePath;
};

const kQueryOrFragment = /[?#]/;
const stripQuery = (rawPath) => {
  const text = String(rawPath ?? "");
  const cut = text.search(kQueryOrFragment);
  return cut === -1 ? text : text.slice(0, cut);
};

// The pathname a request-target denotes, for CLASSIFICATION (not for the
// traversal guard, which must see the raw bytes). Node's parser accepts
// absolute-form targets (`GET http://host/openclaw/fonts/x.css`) and Express
// routes them by pathname while `req.originalUrl` keeps the scheme+host —
// classifying that raw string would miss the Control UI scope and hand the
// request the login redirect. WHATWG parsing also collapses dot segments, so
// `/openclaw/../v1/x` classifies as `/v1/x` (outside the scope → redirect),
// which is fine: this only decides 401-vs-302 for unauthenticated requests;
// forwarding of authenticated ones is decided by isUnsafeGatewayProxyPath.
const requestTargetPathname = (rawUrl) => {
  const text = String(rawUrl ?? "");
  try {
    return new URL(text, "http://alphaclaw.invalid").pathname;
  } catch {
    return stripQuery(text);
  }
};

// Traversal guard for the gateway-UI proxies. Express `req.path` is NOT
// normalized, and http-proxy-3's own getPath() runs `new URL(req.url)` and
// forwards pathname+search — so the WHATWG normalization (`..` and `%2e`
// segments collapse, `\` becomes `/`) happens INSIDE this process, at the
// proxy.web / proxy.ws handoff, before the gateway (which parses the same
// way) ever sees the request. So `/openclaw/../v1/models`,
// `/openclaw/%2e%2e/v1/models` and `/openclaw/..\v1/models` would all leave
// the Control UI namespace and reach the gateway's root handlers with only an
// AlphaClaw session cookie. Reject them here, on the RAW request-target's
// path, BEFORE the handoff (query and fragment excluded — `?v=..` is a
// legitimate cache buster nothing normalizes). `%5c` is rejected as defense
// in depth: WHATWG keeps it literal, so it is not a live vector today.
const kEncodedBackslash = /%5c/i;
const kEncodedDot = /%2e/i;
const isUnsafeGatewayProxyPath = (rawUrl) => {
  const pathPart = stripQuery(rawUrl);
  if (
    pathPart.includes("\\") ||
    kEncodedBackslash.test(pathPart) ||
    kEncodedDot.test(pathPart)
  ) {
    return true;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return true;
  }
  return decoded
    .split(/[\\/]/)
    .some((segment) => segment === "." || segment === "..");
};

// ── Unauthenticated-response classifier for requireAuth ────────────────────
//
//   method HEAD ────────────────────────────────▶ redirect  (the UI's stale-chunk
//                                                            HEAD probe must still
//                                                            reach the login page;
//                                                            sw.js ignores non-GET)
//   method ≠ GET ───────────────────────────────▶ redirect  (existing behavior)
//   path outside /openclaw* and /assets/* ──────▶ redirect  (existing behavior)
//   asset-shaped path (never a document) ───────▶ unauthorized, header-independent
//   Sec-Fetch-Dest present ─┬─ document/iframe/… ▶ redirect
//                           └─ anything else ────▶ unauthorized
//   no fetch metadata ──────┬─ Accept leads with a resource type ▶ unauthorized
//                           └─ otherwise (curl, */*, text/html) ▶ redirect
//
// Why: the pinned Control UI service worker caches ANY `response.ok` under the
// requested URL. A 302 → /login.html (200) for an expired-session font or
// chunk fetch would be cached forever under that asset URL. A 401 is never
// `ok`, so nothing is cached, and the browser never tries to parse HTML as
// CSS. Documents keep the login redirect so a stale tab still lands on login.
const kControlUiResourcePrefixes = [
  "assets/",
  "fonts/",
  "themes/",
  "__openclaw/",
  "__openclaw__/",
  "avatar/",
];
const kControlUiResourceFiles = new Set([
  "sw.js",
  "manifest.webmanifest",
  "apple-touch-icon.png",
  "share/card.png",
]);
const kDocumentFetchDests = new Set(["document", "iframe", "frame", "embed", "object"]);
const kResourceAcceptTypes = [
  /^text\/css$/,
  /^text\/javascript$/,
  /^application\/javascript$/,
  /^application\/json$/,
  /^application\/manifest\+json$/,
  /^font\//,
  /^image\//,
];

const isControlUiScopedPath = (path) =>
  path === kControlUiBasePath ||
  path.startsWith(`${kControlUiBasePath}/`) ||
  path.startsWith("/assets/");

const isControlUiResourcePath = (rawPath) => {
  const path = stripQuery(rawPath);
  if (path.startsWith("/assets/")) return true;
  if (!path.startsWith(`${kControlUiBasePath}/`)) return false;
  const rel = path.slice(kControlUiBasePath.length + 1);
  if (kControlUiResourcePrefixes.some((prefix) => rel.startsWith(prefix))) return true;
  if (rel.startsWith("favicon")) return true;
  return kControlUiResourceFiles.has(rel);
};

const classifyControlUiAuthResponse = ({ method, path, headers } = {}) => {
  const verb = String(method || "GET").toUpperCase();
  if (verb !== "GET") return "redirect";
  const cleanPath = requestTargetPathname(path);
  if (!isControlUiScopedPath(cleanPath)) return "redirect";
  if (isControlUiResourcePath(cleanPath)) return "unauthorized";
  const h = headers && typeof headers === "object" ? headers : {};
  const dest = String(h["sec-fetch-dest"] ?? "").trim().toLowerCase();
  if (dest) return kDocumentFetchDests.has(dest) ? "redirect" : "unauthorized";
  const accept = String(h.accept ?? "")
    .split(",")[0]
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (accept && kResourceAcceptTypes.some((pattern) => pattern.test(accept))) {
    return "unauthorized";
  }
  return "redirect";
};

module.exports = {
  kControlUiBasePath,
  kControlUiMount,
  kControlUiMountEnvKey,
  kControlUiMountModes,
  normalizeControlUiBasePath,
  resolveControlUiMount,
  applyControlUiBasePath,
  controlUiMountSatisfied,
  isUnsafeGatewayProxyPath,
  isControlUiResourcePath,
  isControlUiScopedPath,
  classifyControlUiAuthResponse,
  requestTargetPathname,
};
