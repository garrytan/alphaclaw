const ensurePluginsShell = (cfg = {}) => {
  if (!cfg.plugins || typeof cfg.plugins !== "object") cfg.plugins = {};
  if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
  if (!cfg.plugins.load || typeof cfg.plugins.load !== "object") {
    cfg.plugins.load = {};
  }
  if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
  if (!cfg.plugins.entries || typeof cfg.plugins.entries !== "object") {
    cfg.plugins.entries = {};
  }
};

// OpenClaw's own memory plugin. A plugins.allow list that leaves it out makes
// 2026.11.5's `openclaw memory …` commands refuse to run, even though the
// gateway loads it anyway as the default memory slot. On 2026.10.9 and
// 2026.11.3 listing it changes nothing: the selected memory slot wins over the
// allowlist, and a memory slot set to another plugin keeps it off
// (dist/config-state-*.mjs resolvePluginActivationStateShared and
// resolveMemorySlotDecisionShared). So every allow list AlphaClaw writes
// carries it.
const kMemoryCorePluginId = "memory-core";

const ensureMemoryCoreAllowed = (cfg = {}) => {
  if (!Array.isArray(cfg.plugins?.allow) || cfg.plugins.allow.includes(kMemoryCorePluginId)) return false;
  cfg.plugins.allow.push(kMemoryCorePluginId);
  return true;
};

const ensurePluginAllowed = ({ cfg = {}, pluginKey = "" }) => {
  const normalizedPluginKey = String(pluginKey || "").trim();
  if (!normalizedPluginKey) return;
  ensurePluginsShell(cfg);
  if (!cfg.plugins.allow.includes(normalizedPluginKey)) {
    cfg.plugins.allow.push(normalizedPluginKey);
  }
  ensureMemoryCoreAllowed(cfg);
};

module.exports = { kMemoryCorePluginId, ensureMemoryCoreAllowed, ensurePluginsShell, ensurePluginAllowed };
