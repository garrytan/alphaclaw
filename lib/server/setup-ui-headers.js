// Security headers for the Setup UI's own pages (ALPH-71 H-2 follow-up, L-4).
//
//   GET /, /setup, /setup.html, /login.html ──▶ CSP + X-Frame-Options: DENY
//   everything else ──────────────────────────▶ untouched
//
// The pages run no inline script: the theme pre-paint snippet and the login
// form live in lib/public/js (theme-prepaint.js stays a blocking classic
// script in <head>, so the page still never flashes). Styles keep
// 'unsafe-inline' for the htm components' style attributes and the
// interstitial <style> the Claude Code launcher writes into its about:blank
// popup (which inherits this policy). img-src allows https:, data: and blob:
// for Markdown previews and the file viewer's image data URLs; media-src the
// audio data URLs; connect-src this host (fetch, EventSource, the chat and
// terminal sockets) and GitHub's API, the release-notes fallback.
//
// Only these paths: the /openclaw Control UI keeps the gateway's own headers,
// the relay consent page sends its own CSP, and /gateway/attach and the OAuth
// callback pages carry inline scripts of their own. Express matches routes
// case-insensitively and with a trailing slash, and express.static decodes the
// path and resolves its dot segments and repeated slashes (/%73etup.html,
// //setup.html and /js/%2e%2e/setup.html all serve setup.html), so the path is
// normalized the same way before the lookup.
const path = require("path");

const kSetupUiPagePaths = new Set(["/", "/setup", "/setup.html", "/login.html"]);
const kSocketHostPattern = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

const buildSetupUiCsp = ({ host = "" } = {}) => {
  const socketSources = kSocketHostPattern.test(host)
    ? ` ws://${host} wss://${host}`
    : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${socketSources} https://api.github.com`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
};

const decodePath = (pathname) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

const normalizePagePath = (pathname) => {
  const normalized = path.posix.normalize(decodePath(String(pathname || "")).toLowerCase());
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") || "/" : normalized;
};

const isSetupUiPageRequest = (req) =>
  (req.method === "GET" || req.method === "HEAD") &&
  kSetupUiPagePaths.has(normalizePagePath(req.path));

const setupUiSecurityHeaders = (req, res, next) => {
  if (!isSetupUiPageRequest(req)) return next();
  res.set(
    "Content-Security-Policy",
    buildSetupUiCsp({ host: String(req.headers.host || "").trim() }),
  );
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  return next();
};

module.exports = {
  kSetupUiPagePaths,
  buildSetupUiCsp,
  isSetupUiPageRequest,
  setupUiSecurityHeaders,
};
