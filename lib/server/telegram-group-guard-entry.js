const path = require("path");
const { ensurePluginsShell, ensurePluginAllowed } = require("./plugin-config");

// The openclaw.json plugin entry that loads AlphaClaw's group guard
// (lib/plugin/group-guard, GST-1975 PR 1) on every box with Telegram, so a
// person or group blocked on the Groups page is dropped from the moment the
// block is saved, with no gateway restart. Owner-scoped like the relay
// guard: config._alphaclawManaged marks it ours, an entry someone else owns
// is left alone, and a load path to another install location of the guard is
// replaced by this one. before_dispatch is a conversation hook, which
// OpenClaw only runs for a non-bundled plugin with
// hooks.allowConversationAccess.
const kGroupGuardPluginId = "group-guard";
const kGroupGuardPluginPath = path.resolve(__dirname, "..", "plugin", "group-guard");
const kGroupGuardPathPattern = /[\\/]plugin[\\/]group-guard[\\/]?$/;
const kManagedMarker = "_alphaclawManaged";
const kManagedOwner = "telegram-groups";

const isOurs = (entry) => Boolean(entry) && typeof entry === "object" && entry.config?.[kManagedMarker] === kManagedOwner;

const applyGroupGuardEntry = (cfg, { rootDir, log = console.log, pluginPath = kGroupGuardPluginPath } = {}) => {
  if (!cfg?.channels?.telegram || typeof cfg.channels.telegram !== "object") return { changed: false, conflict: false };
  const existing = cfg.plugins?.entries?.[kGroupGuardPluginId];
  if (existing && !isOurs(existing)) {
    log("[alphaclaw] telegram groups: plugins.entries." + kGroupGuardPluginId + " is not managed by AlphaClaw; leaving it");
    return { changed: false, conflict: true };
  }
  const before = JSON.stringify(cfg.plugins ?? null);
  ensurePluginsShell(cfg);
  ensurePluginAllowed({ cfg, pluginKey: kGroupGuardPluginId });
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => entry === pluginPath || !kGroupGuardPathPattern.test(String(entry || "")));
  if (!cfg.plugins.load.paths.includes(pluginPath)) cfg.plugins.load.paths.push(pluginPath);
  cfg.plugins.entries[kGroupGuardPluginId] = {
    ...(existing || {}),
    enabled: true,
    hooks: { ...(existing?.hooks || {}), allowConversationAccess: true },
    config: { [kManagedMarker]: kManagedOwner, rootDir },
  };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] telegram groups: configured the group guard plugin entry");
  return { changed, conflict: false };
};

// Whether the gateway would load AlphaClaw's group guard from this config,
// so a block is enforced: { enforced, reason } with reason "missing" (no
// entry, e.g. Telegram added later through the channels route before the
// next gateway start), "foreign" (an entry AlphaClaw does not own) or
// "disabled" (the entry, its conversation hook or plugins are switched off).
const describeGroupGuard = (cfg) => {
  const plugins = cfg?.plugins;
  const entry = plugins?.entries?.[kGroupGuardPluginId];
  if (!entry || typeof entry !== "object") return { enforced: false, reason: "missing" };
  if (!isOurs(entry)) return { enforced: false, reason: "foreign" };
  const policyIds = (list) => (Array.isArray(list) ? list : []).filter((id) => typeof id === "string").map((id) => id.trim().toLowerCase()).filter(Boolean);
  const allow = policyIds(plugins.allow);
  const allowed = allow.length === 0 || allow.includes(kGroupGuardPluginId);
  const denied = policyIds(plugins.deny).includes(kGroupGuardPluginId);
  const loaded = (plugins.load?.paths || []).some((entryPath) => kGroupGuardPathPattern.test(String(entryPath || "")));
  if (plugins.enabled === false || entry.enabled === false || entry.hooks?.allowConversationAccess !== true || !allowed || denied || !loaded) return { enforced: false, reason: "disabled" };
  return { enforced: true, reason: null };
};

module.exports = { kGroupGuardPluginId, kGroupGuardPluginPath, applyGroupGuardEntry, describeGroupGuard };
