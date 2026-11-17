// AlphaClaw's AgentRun reporter: settings and the openclaw.json plugin entry
// (GST-2907). Every setting is deployment env only (deployment-only-env.js),
// and the ALPHACLAW_ prefix keeps them out of the gateway's env, so the plugin
// never sees them: privacy policy is applied here, in the server process.
const path = require("path");
const { ensurePluginsShell, ensurePluginAllowed } = require("../plugin-config");

const kPluginId = "agentrun-reporter";
const kPluginPath = path.resolve(__dirname, "..", "..", "plugin", "agentrun-reporter");
const kPluginPathPattern = /[\\/]plugin[\\/]agentrun-reporter[\\/]?$/;
const kManagedMarker = "_alphaclawManaged";
const kManagedOwner = "agentrun-reporter";
const kDefaultRuntime = "claude-agent-sdk";
const kRuntimePattern = /^[a-z][a-z0-9-]{1,63}$/;

const listOf = (value) =>
  String(value || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

// { enabled, url, token, runtime, contentCronJobs } — enabled when the URL is
// set (capture runs); sending also needs the token.
const resolveAgentrunReporterConfig = (env = process.env) => {
  const url = String(env.ALPHACLAW_AGENTRUN_URL || "").trim().replace(/\/+$/, "");
  const runtime = String(env.ALPHACLAW_AGENTRUN_RUNTIME || "").trim() || kDefaultRuntime;
  return {
    enabled: /^https?:\/\//i.test(url),
    url,
    token: String(env.ALPHACLAW_AGENTRUN_OPENCLAW_TOKEN || "").trim(),
    runtime: kRuntimePattern.test(runtime) ? runtime : kDefaultRuntime,
    runtimeValid: kRuntimePattern.test(runtime),
    contentCronJobs: new Set(listOf(env.ALPHACLAW_AGENTRUN_CONTENT_CRON)),
  };
};

const isOurs = (entry) => Boolean(entry) && typeof entry === "object" && entry.config?.[kManagedMarker] === kManagedOwner;

// Adds the plugin entry when the reporter is on and removes ours when it is
// off. An entry someone else owns is left alone.
const applyAgentrunReporterEntry = (cfg, { enabled, rootDir, log = console.log, pluginPath = kPluginPath } = {}) => {
  const existing = cfg?.plugins?.entries?.[kPluginId];
  if (existing && !isOurs(existing)) {
    if (enabled) log("[alphaclaw] agentrun-reporter: plugins.entries." + kPluginId + " is not managed by AlphaClaw; leaving it");
    return { changed: false, conflict: Boolean(enabled) };
  }
  const before = JSON.stringify(cfg?.plugins ?? null);
  if (!enabled) {
    if (!existing) return { changed: false, conflict: false };
    delete cfg.plugins.entries[kPluginId];
    if (Array.isArray(cfg.plugins.load?.paths)) cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => !kPluginPathPattern.test(String(entry || "")));
    if (Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = cfg.plugins.allow.filter((id) => id !== kPluginId);
    log("[alphaclaw] agentrun-reporter: removed the plugin entry (ALPHACLAW_AGENTRUN_URL unset)");
    return { changed: true, conflict: false };
  }
  ensurePluginsShell(cfg);
  ensurePluginAllowed({ cfg, pluginKey: kPluginId });
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter((entry) => entry === pluginPath || !kPluginPathPattern.test(String(entry || "")));
  if (!cfg.plugins.load.paths.includes(pluginPath)) cfg.plugins.load.paths.push(pluginPath);
  cfg.plugins.entries[kPluginId] = {
    ...(existing || {}),
    enabled: true,
    hooks: { ...(existing?.hooks || {}), allowConversationAccess: true },
    config: { [kManagedMarker]: kManagedOwner, rootDir },
  };
  const changed = JSON.stringify(cfg.plugins) !== before;
  if (changed) log("[alphaclaw] agentrun-reporter: configured the plugin entry");
  return { changed, conflict: false };
};

module.exports = {
  kAgentrunReporterPluginId: kPluginId,
  kAgentrunReporterPluginPath: kPluginPath,
  kDefaultRuntime,
  resolveAgentrunReporterConfig,
  applyAgentrunReporterEntry,
};
