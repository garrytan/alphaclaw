const path = require("path");
const { ensurePluginsShell, ensurePluginAllowed } = require("./plugin-config");
const { resolveOwnerIds } = require("./telegram-groups");
const { resolveTelegramAccountConfig } = require("./telegram-workspace");

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
  const { accountConfig } = resolveTelegramAccountConfig({ telegramConfig: cfg.channels.telegram, accountId: "default" });
  const ownerIds = resolveOwnerIds({ cfg, accountConfig });
  cfg.plugins.entries[kGroupGuardPluginId] = {
    ...(existing || {}),
    enabled: true,
    hooks: { ...(existing?.hooks || {}), allowConversationAccess: true },
    config: { [kManagedMarker]: kManagedOwner, rootDir, ...(ownerIds.length ? { ownerIds } : {}) },
  };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] telegram groups: configured the group guard plugin entry");
  return { changed, conflict: false };
};

module.exports = { kGroupGuardPluginId, kGroupGuardPluginPath, applyGroupGuardEntry };
