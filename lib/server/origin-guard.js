const { classifyBrowserOrigin } = require("./control-ui-mount");
const { sanitizeLabel } = require("./utils/sanitize-label");

// One refusal for every cookie-authenticated surface that must come from the
// box's own pages (ALPH-71 L-4): /api writes, the terminal and chat upgrades,
// and the OAuth starts. The same-origin rule itself lives in
// control-ui-mount.js (classifyBrowserOrigin).
const kOriginMismatchCode = "origin_mismatch";
const kOriginMismatchBody = Object.freeze({
  error: "Cross-origin request refused",
  code: kOriginMismatchCode,
});

const logOriginRefusal = ({ surface, method, path, headers, actor }) => {
  const origin = String(headers?.origin || "");
  const fetchSite = String(headers?.["sec-fetch-site"] || "");
  console.warn(
    `[origin] refused ${surface} ${sanitizeLabel(`${String(method || "").toUpperCase()} ${String(path || "")}`, { maxLength: 96 })} code=${kOriginMismatchCode} actor=${actor} origin=${JSON.stringify(sanitizeLabel(origin, { maxLength: 80 }))}${fetchSite ? ` fetchSite=${JSON.stringify(sanitizeLabel(fetchSite, { maxLength: 24 }))}` : ""}`,
  );
};

module.exports = {
  classifyBrowserOrigin,
  kOriginMismatchBody,
  kOriginMismatchCode,
  logOriginRefusal,
};
