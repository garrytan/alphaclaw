const crypto = require("crypto");
const {
  kControlUiBasePath,
  isUnsafeGatewayProxyPath,
} = require("./control-ui-mount");

// Direct Control UI open for a signed-in admin (no /gateway/launch hop).
//
//   GET /openclaw/chat (document, admin, no marker for this session)
//     └─▶ 302 /gateway/attach?to=/openclaw/chat     (outside the SW scope)
//           ├─ Set-Cookie alphaclaw_control_ui=<marker>; Path=/openclaw
//           └─ page script: POST /gateway/attach ─▶ { token }   (no-store)
//                 sessionStorage["openclaw.control.token.v1:wss://<host>/openclaw"] = token
//                 location.replace("/openclaw/chat")
//   GET /openclaw/chat (marker matches) ──▶ gateway, the UI connects with the token
//
// The Control UI only learns the gateway token from #token= (what
// /gateway/launch hands it) or from that sessionStorage key, and the AlphaClaw
// sidebar logout clears both storages, so a fresh tab, a fresh browser or a
// re-login used to land on "This Gateway expects its token". The token never
// rides a URL, a log line or a cacheable response: it is fetched by a
// same-origin POST from a page outside the Control UI service worker's scope.
// The marker is a digest of the session cookie, so a new login (new cookie)
// attaches again once and an old marker never vouches for it.

const kControlUiAttachPath = "/gateway/attach";
const kControlUiAttachCookie = "alphaclaw_control_ui";
const kControlUiTokenStoragePrefix = "openclaw.control.token.v1:";
const kAttachRequestHeader = "x-alphaclaw-attach";
const kMaxTargetLength = 2048;

const readCookie = (req, name) => {
  const header = String(req?.headers?.cookie || "");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
};

const computeAttachMarker = (sessionToken) =>
  sessionToken
    ? crypto
        .createHash("sha256")
        .update(`alphaclaw-control-ui-attach:${sessionToken}`)
        .digest("base64url")
        .slice(0, 32)
    : "";

const resolveAttachMarker = (req) => computeAttachMarker(readCookie(req, "setup_token"));

const hasCurrentAttachMarker = (req) => {
  const expected = resolveAttachMarker(req);
  const presented = readCookie(req, kControlUiAttachCookie);
  return (
    Boolean(expected) &&
    presented.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  );
};

const setAttachMarkerCookie = (req, res) => {
  const marker = resolveAttachMarker(req);
  if (!marker) return;
  res.cookie(kControlUiAttachCookie, marker, {
    httpOnly: true,
    sameSite: "lax",
    path: kControlUiBasePath,
    secure: req?.secure === true,
  });
};

// Top-level document navigations only: subresources, fetches, iframes and
// WebSocket upgrades are never redirected. A browser that sends no Fetch
// Metadata keeps the old behavior (no attach).
const isControlUiDocumentNavigation = (req) =>
  req?.method === "GET" &&
  String(req.headers?.["sec-fetch-mode"] || "") === "navigate" &&
  String(req.headers?.["sec-fetch-dest"] || "") === "document";

const resolveAttachTarget = (value) => {
  const target = typeof value === "string" ? value : "";
  if (
    !target ||
    target.length > kMaxTargetLength ||
    !/^\/openclaw(?:[/?]|$)/.test(target) ||
    /[\\\s]/.test(target) ||
    isUnsafeGatewayProxyPath(target)
  ) {
    return kControlUiBasePath;
  }
  return target;
};

const buildAttachRedirect = (target) =>
  `${kControlUiAttachPath}?to=${encodeURIComponent(resolveAttachTarget(target))}`;

// The attach page script. The storage key is the one every supported Control
// UI line (2026.10.4 - 2026.10.10-beta.2) reads its gateway token from:
// prefix + the default gateway URL for this page, ws(s)://<host>/openclaw.
const renderAttachPage = (target) => {
  const script = `(async()=>{const target=${JSON.stringify(resolveAttachTarget(target)).replace(/</g, "\\u003c")};try{const response=await fetch(${JSON.stringify(kControlUiAttachPath)},{method:"POST",credentials:"same-origin",cache:"no-store",headers:{${JSON.stringify(kAttachRequestHeader)}:"1"}});if(response.ok){const body=await response.json();if(typeof body?.token==="string"&&body.token){sessionStorage.setItem(${JSON.stringify(kControlUiTokenStoragePrefix)}+(location.protocol==="https:"?"wss://":"ws://")+location.host+${JSON.stringify(kControlUiBasePath)},body.token)}}}catch{}location.replace(target)})();`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Opening OpenClaw…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1015;color:#bcbcc0}@media(prefers-color-scheme:light){body{background:#faf9f7;color:#403c35}}</style>
</head>
<body>
<p>Opening OpenClaw…</p>
<script>${script}</script>
</body>
</html>
`;
};

// The /openclaw route's question: should this request detour through the
// attach page first? Only a signed-in admin's top-level navigation, on a
// token-mode gateway, whose session has not attached yet.
const createControlUiAttachRedirect = ({ isAdminRequest, isOnboarded, isTokenlessGateway }) => (req) => {
  if (!isControlUiDocumentNavigation(req)) return null;
  if (hasCurrentAttachMarker(req)) return null;
  if (!isOnboarded() || !isAdminRequest(req)) return null;
  if (isTokenlessGateway()) return null;
  return buildAttachRedirect(req.originalUrl || req.url);
};

module.exports = {
  kControlUiAttachPath,
  kControlUiAttachCookie,
  kControlUiTokenStoragePrefix,
  kAttachRequestHeader,
  computeAttachMarker,
  hasCurrentAttachMarker,
  setAttachMarkerCookie,
  isControlUiDocumentNavigation,
  resolveAttachTarget,
  buildAttachRedirect,
  renderAttachPage,
  createControlUiAttachRedirect,
};
