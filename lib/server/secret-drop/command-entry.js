const path = require("path");
const { ensurePluginsShell, ensurePluginAllowed } = require("../plugin-config");

// The openclaw.json plugin entry that loads AlphaClaw's /secret command
// (lib/plugin/secret-drop), applied inside ensureGatewayProxyConfig's locked
// writer like the relay guard's entry (relay/guard-entry.js). Owner-scoped:
// plugins.entries["secret-drop"].config carries "_alphaclawManaged":
// "secret-drop", an entry someone else owns is left alone, and a load path to
// another install location of the plugin is replaced by this one. The config
// holds only where to find the agent admin token and AlphaClaw's port, never
// a secret. ALPHACLAW_SECRET_DROP_COMMAND=off (deployment env only) removes it.
const kSecretDropPluginId = "secret-drop";
const kSecretDropPluginPath = path.resolve(__dirname, "..", "..", "plugin", "secret-drop");
const kSecretDropPathPattern = /[\\/]plugin[\\/]secret-drop[\\/]?$/;
const kSecretDropCommandEnvKey = "ALPHACLAW_SECRET_DROP_COMMAND";
const kManagedMarker = "_alphaclawManaged";
const kManagedOwner = "secret-drop";
const kOffValues = new Set(["0", "off", "false", "no", "disabled"]);

const buildSecretDropCommandEntry = ({ openclawDir, port }) => ({
  enabled: true,
  config: { [kManagedMarker]: kManagedOwner, openclawDir, port },
});

const resolveDesiredSecretDropCommandEntry = ({ env = process.env, openclawDir, port }) =>
  kOffValues.has(String(env[kSecretDropCommandEnvKey] ?? "").trim().toLowerCase()) ? null : buildSecretDropCommandEntry({ openclawDir, port });

const isOurs = (entry) => Boolean(entry) && typeof entry === "object" && entry.config?.[kManagedMarker] === kManagedOwner;

// Returns { changed, conflict }. desired null removes our entry, path and allow.
const applySecretDropCommandEntry = (cfg, desired, { log = console.log, pluginPath = kSecretDropPluginPath } = {}) => {
  const existing = cfg?.plugins?.entries?.[kSecretDropPluginId];
  if (existing && !isOurs(existing)) {
    if (desired) log("[alphaclaw] secret-drop: plugins.entries." + kSecretDropPluginId + " is not managed by AlphaClaw; leaving it");
    return { changed: false, conflict: Boolean(desired) };
  }
  if (!desired) {
    if (!existing) return { changed: false, conflict: false };
    delete cfg.plugins.entries[kSecretDropPluginId];
    if (Array.isArray(cfg.plugins.load?.paths)) cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => !kSecretDropPathPattern.test(String(entry || "")));
    if (Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = cfg.plugins.allow.filter((id) => id !== kSecretDropPluginId);
    log("[alphaclaw] secret-drop: removed the /secret command plugin entry (" + kSecretDropCommandEnvKey + "=off)");
    return { changed: true, conflict: false };
  }
  const before = JSON.stringify(cfg?.plugins ?? null);
  ensurePluginsShell(cfg);
  ensurePluginAllowed({ cfg, pluginKey: kSecretDropPluginId });
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => entry === pluginPath || !kSecretDropPathPattern.test(String(entry || "")));
  if (!cfg.plugins.load.paths.includes(pluginPath)) cfg.plugins.load.paths.push(pluginPath);
  cfg.plugins.entries[kSecretDropPluginId] = { ...(existing || {}), ...desired, config: { ...(existing?.config || {}), ...desired.config } };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] secret-drop: configured the /secret command plugin entry");
  return { changed, conflict: false };
};

module.exports = {
  kSecretDropPluginId,
  kSecretDropPluginPath,
  kSecretDropCommandEnvKey,
  buildSecretDropCommandEntry,
  resolveDesiredSecretDropCommandEntry,
  applySecretDropCommandEntry,
};
