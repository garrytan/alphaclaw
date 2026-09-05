// Which explorer edits require a gateway restart. ONE source — the JSON under
// lib/public/shared is read by this server module AND fetched by the client
// (lib/public/js/lib/browse-restart-policy.js), so the banner logic can never
// drift between the two (fix wave F152: the flag used to live only in one
// tab's React state — lost on reload, invisible to other tabs, never set for
// agent writes).
const { rules } = require("../../../public/shared/browse-restart-rules.json");

const normalizeRulePath = (value) =>
  String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

const matchesRule = (relativePath, rule) => {
  const normalizedPath = normalizeRulePath(relativePath);
  if (!normalizedPath || !rule || typeof rule !== "object") return false;
  const targetPath = normalizeRulePath(rule.path);
  if (!targetPath) return false;
  const type = String(rule.type || "").toLowerCase();
  if (type === "directory") {
    return normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}/`);
  }
  if (type === "file") return normalizedPath === targetPath;
  return false;
};

const kBrowseRestartRules = Array.isArray(rules) ? rules : [];

const shouldRequireRestartForBrowsePath = (relativePath) =>
  kBrowseRestartRules.some((rule) => matchesRule(relativePath, rule));

module.exports = { kBrowseRestartRules, shouldRequireRestartForBrowsePath };
