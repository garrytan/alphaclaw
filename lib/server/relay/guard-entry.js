const path = require("path");
const { kRelayManagedOwner } = require("./constants");
const { readRelayConfig } = require("./config");
const { ensurePluginsShell, ensurePluginAllowed } = require("../plugin-config");

// The openclaw.json plugin entry that loads AlphaClaw's relay guard
// (lib/plugin/relay-guard, ALPH-71 H-1), applied inside
// ensureGatewayProxyConfig's locked writer beside the relay MCP entry. It is
// owner-scoped the same way: plugins.entries["relay-guard"].config carries
// "_alphaclawManaged": "relay", an entry someone else owns is left alone, and
// a load path to another install location of the guard is replaced by this
// one. The bridge holds relay messages until the gateway reports the plugin
// active (plugins.list), so a refused or missing entry fails closed.
const kRelayGuardPluginId = "relay-guard";
const kRelayGuardPluginPath = path.resolve(__dirname, "..", "..", "plugin", "relay-guard");
const kRelayGuardPathPattern = /[\\/]plugin[\\/]relay-guard[\\/]?$/;
const kManagedMarker = "_alphaclawManaged";

const buildRelayGuardEntry = ({ rootDir }) => ({
  enabled: true,
  config: { [kManagedMarker]: kRelayManagedOwner, rootDir, logDirs: [path.join(rootDir, "logs")] },
});

const resolveDesiredRelayGuardEntry = ({ env = process.env, rootDir }) =>
  readRelayConfig({ env }).enabled ? buildRelayGuardEntry({ rootDir }) : null;

const isOurs = (entry) => Boolean(entry) && typeof entry === "object" && entry.config?.[kManagedMarker] === kRelayManagedOwner;

// Returns { changed, conflict }. desired null removes our entry, path and allow.
const applyRelayGuardEntry = (cfg, desired, { log = console.log, pluginPath = kRelayGuardPluginPath } = {}) => {
  const existing = cfg?.plugins?.entries?.[kRelayGuardPluginId];
  if (existing && !isOurs(existing)) {
    if (desired) log("[alphaclaw] relay: plugins.entries." + kRelayGuardPluginId + " is not managed by AlphaClaw; leaving it");
    return { changed: false, conflict: Boolean(desired) };
  }
  const before = JSON.stringify(cfg?.plugins ?? null);
  if (!desired) {
    if (!existing) return { changed: false, conflict: false };
    delete cfg.plugins.entries[kRelayGuardPluginId];
    if (Array.isArray(cfg.plugins.load?.paths)) cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => !kRelayGuardPathPattern.test(String(entry || "")));
    if (Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = cfg.plugins.allow.filter((id) => id !== kRelayGuardPluginId);
    log("[alphaclaw] relay: removed the relay guard plugin entry (relay off)");
    return { changed: true, conflict: false };
  }
  ensurePluginsShell(cfg);
  ensurePluginAllowed({ cfg, pluginKey: kRelayGuardPluginId });
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => entry === pluginPath || !kRelayGuardPathPattern.test(String(entry || "")));
  if (!cfg.plugins.load.paths.includes(pluginPath)) cfg.plugins.load.paths.push(pluginPath);
  cfg.plugins.entries[kRelayGuardPluginId] = { ...(existing || {}), ...desired, config: { ...(existing?.config || {}), ...desired.config } };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] relay: configured the relay guard plugin entry");
  return { changed, conflict: false };
};

module.exports = {
  kRelayGuardPluginId,
  kRelayGuardPluginPath,
  buildRelayGuardEntry,
  resolveDesiredRelayGuardEntry,
  applyRelayGuardEntry,
};
