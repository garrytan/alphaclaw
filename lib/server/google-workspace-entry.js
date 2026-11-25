const path = require("path");
const { ensurePluginsShell, ensurePluginAllowed } = require("./plugin-config");

// The openclaw.json entry that loads AlphaClaw's Google Workspace plugin
// (lib/plugin/google-workspace, GST-3848). Off until the deployment names
// the Google account: ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS (comma-separated
// addresses, the first is the default) adds the entry, unset removes ours.
// ALPHACLAW_GOOGLE_WORKSPACE_TOOLS picks "core" (default) or "all", and
// ALPHACLAW_GOOGLE_WORKSPACE_SOCKET an absolute broker socket path in place
// of GBrain's own. All three are deployment env only, and the relay guard
// treats the entry and the names as part of its trust anchor, so no agent
// can switch it on or point it elsewhere. Owner-scoped like the other
// guards: an entry someone else owns is left alone, and a load path to
// another install location of the plugin is replaced by this one.
const kGoogleWorkspacePluginId = "google-workspace";
const kGoogleWorkspacePluginPath = path.resolve(__dirname, "..", "plugin", "google-workspace");
const kPathPattern = /[\\/]plugin[\\/]google-workspace[\\/]?$/;
const kManagedMarker = "_alphaclawManaged";
const kManagedOwner = "google-workspace";
const kAccountsEnvKey = "ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS";
const kToolsEnvKey = "ALPHACLAW_GOOGLE_WORKSPACE_TOOLS";
const kSocketEnvKey = "ALPHACLAW_GOOGLE_WORKSPACE_SOCKET";
const kEmailPattern = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// The entry the deployment env asks for, or null (no valid account).
const resolveDesiredGoogleWorkspaceEntry = ({ env = process.env, rootDir }) => {
  const accounts = [
    ...new Set(
      String(env[kAccountsEnvKey] || "")
        .split(/[\s,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => kEmailPattern.test(entry)),
    ),
  ];
  if (!accounts.length) return null;
  const socketPath = String(env[kSocketEnvKey] || "").trim();
  return {
    enabled: true,
    config: {
      [kManagedMarker]: kManagedOwner,
      rootDir,
      accounts,
      toolSurface: String(env[kToolsEnvKey] || "").trim().toLowerCase() === "all" ? "all" : "core",
      ...(path.isAbsolute(socketPath) ? { socketPath } : {}),
    },
  };
};

const isOurs = (entry) => Boolean(entry) && typeof entry === "object" && entry.config?.[kManagedMarker] === kManagedOwner;

// Returns { changed, conflict }. desired null removes our entry, path and allow.
const applyGoogleWorkspaceEntry = (cfg, desired, { log = console.log, pluginPath = kGoogleWorkspacePluginPath } = {}) => {
  const existing = cfg?.plugins?.entries?.[kGoogleWorkspacePluginId];
  if (existing && !isOurs(existing)) {
    if (desired) log("[alphaclaw] google-workspace: plugins.entries." + kGoogleWorkspacePluginId + " is not managed by AlphaClaw; leaving it");
    return { changed: false, conflict: Boolean(desired) };
  }
  if (!desired) {
    if (!existing) return { changed: false, conflict: false };
    delete cfg.plugins.entries[kGoogleWorkspacePluginId];
    if (Array.isArray(cfg.plugins.load?.paths)) cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => !kPathPattern.test(String(entry || "")));
    if (Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = cfg.plugins.allow.filter((id) => id !== kGoogleWorkspacePluginId);
    log("[alphaclaw] google-workspace: removed the plugin entry (" + kAccountsEnvKey + " unset)");
    return { changed: true, conflict: false };
  }
  const before = JSON.stringify(cfg?.plugins ?? null);
  ensurePluginsShell(cfg);
  ensurePluginAllowed({ cfg, pluginKey: kGoogleWorkspacePluginId });
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => entry === pluginPath || !kPathPattern.test(String(entry || "")));
  if (!cfg.plugins.load.paths.includes(pluginPath)) cfg.plugins.load.paths.push(pluginPath);
  cfg.plugins.entries[kGoogleWorkspacePluginId] = { ...(existing || {}), ...desired };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] google-workspace: configured the plugin entry for " + desired.config.accounts.length + " account(s)");
  return { changed, conflict: false };
};

module.exports = {
  kGoogleWorkspacePluginId,
  kGoogleWorkspacePluginPath,
  kGoogleWorkspaceEnvKeys: Object.freeze([kAccountsEnvKey, kToolsEnvKey, kSocketEnvKey]),
  resolveDesiredGoogleWorkspaceEntry,
  applyGoogleWorkspaceEntry,
};
