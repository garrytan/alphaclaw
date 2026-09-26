const fs = require("node:fs");
const path = require("node:path");
const { updateOpenclawConfig } = require("./openclaw-config");
const { migrateLegacyTelegramStreamingConfig } = require("./openclaw-config-migrations");
const { buildSecretReplacements } = require("./helpers");
const { pruneStaleUsageTrackerPaths, ensureUsageTrackerPluginEntry } = require("./usage-tracker-config");

const normalizeBootConfig = ({ hold, assertLease = () => {}, env = process.env, logger = console }) => {
  assertLease();
  if (typeof hold?.isValid !== "function" || !hold.isValid()) {
    throw Object.assign(new Error("Boot config normalization requires the boot lease"), { code: "boot_lease_expired" });
  }
  if (!env.OPENCLAW_CONFIG_PATH) return { changed: false };
  const selectedDir = path.dirname(env.OPENCLAW_CONFIG_PATH);
  let supported = !!env.OPENCLAW_STATE_DIR && path.basename(env.OPENCLAW_CONFIG_PATH) === "openclaw.json";
  if (supported && path.resolve(selectedDir) !== path.resolve(env.OPENCLAW_STATE_DIR)) {
    try { supported = fs.realpathSync(selectedDir) === fs.realpathSync(env.OPENCLAW_STATE_DIR); } catch { supported = false; }
  }
  if (!supported) throw Object.assign(new Error("Boot config normalization requires the state root's openclaw.json"), { code: "boot_config_selector_unsupported" });
  if (!fs.existsSync(env.OPENCLAW_CONFIG_PATH)) return { changed: false };
  let result;
  try {
    result = updateOpenclawConfig({
      openclawDir: selectedDir,
      mutate: (cfg) => {
        assertLease();
        let changed = migrateLegacyTelegramStreamingConfig(cfg);
        if (!cfg.channels) cfg.channels = {};
        for (const [channel, tokenKey, field] of [["telegram", "TELEGRAM_BOT_TOKEN", "botToken"], ["discord", "DISCORD_BOT_TOKEN", "token"]]) {
          if (!env[tokenKey] || cfg.channels[channel]) continue;
          cfg.channels[channel] = { enabled: true, [field]: env[tokenKey], dmPolicy: "pairing", groupPolicy: "allowlist" };
          if (!cfg.plugins) cfg.plugins = {};
          if (!cfg.plugins.entries) cfg.plugins.entries = {};
          cfg.plugins.entries[channel] = { enabled: true };
          changed = true;
        }
        if (pruneStaleUsageTrackerPaths(cfg)) changed = true;
        if (ensureUsageTrackerPluginEntry(cfg)) changed = true;
        if (!changed) return { changed: false, skipWrite: true };
        let content = JSON.stringify(cfg);
        for (const [secret, envRef] of buildSecretReplacements(env)) {
          if (secret) content = content.split(JSON.stringify(secret)).join(JSON.stringify(envRef));
        }
        const sanitized = JSON.parse(content);
        for (const key of Object.keys(cfg)) delete cfg[key];
        Object.assign(cfg, sanitized);
        return { changed: true };
      },
    });
  } catch (error) {
    throw Object.assign(new Error("Boot config normalization could not complete"), {
      code: error?.code || "boot_config_normalization_failed",
    });
  }
  if (result.changed) logger.log("[alphaclaw] Normalized admitted boot configuration");
  return { changed: result.changed };
};

module.exports = { normalizeBootConfig };
