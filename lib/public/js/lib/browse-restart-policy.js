// Which explorer edits require a gateway restart. The rules ship as JSON under
// lib/public/shared so the server (routes/browse/restart-rules.js, which
// persists the restart-required flag) and this client mirror (which flips the
// banner immediately) read the same file. The inline defaults only cover a
// failed fetch.
import { fetchBrowseRestartRules } from "./api/browse.js";

let kBrowseRestartRequiredRules = [
  { type: "file", path: "openclaw.json" },
  { type: "directory", path: "hooks/transforms" },
];
try {
  const rulesJson = await fetchBrowseRestartRules();
  if (Array.isArray(rulesJson?.rules)) {
    kBrowseRestartRequiredRules = rulesJson.rules;
  }
} catch {}

const normalizeRestartRulePath = (value) =>
  String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");

const matchesBrowseRestartRequiredRule = (path, rule) => {
  const normalizedPath = normalizeRestartRulePath(path);
  if (!normalizedPath) return false;
  if (!rule || typeof rule !== "object") return false;
  const type = String(rule.type || "").toLowerCase();
  const targetPath = normalizeRestartRulePath(rule.path);
  if (!targetPath) return false;
  if (type === "directory") {
    return normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}/`);
  }
  if (type === "file") {
    return normalizedPath === targetPath;
  }
  return false;
};

export const shouldRequireRestartForBrowsePath = (path) =>
  kBrowseRestartRequiredRules.some((rule) => matchesBrowseRestartRequiredRule(path, rule));
