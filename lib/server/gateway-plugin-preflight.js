const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { OPENCLAW_DIR, kChannelDefs } = require("./constants");

const resolveOpenclawExtensionsDir = () => {
  try {
    const entryPath = require.resolve("openclaw");
    const entryDir = path.dirname(entryPath);
    const distDir =
      path.basename(entryDir) === "dist" ? entryDir : path.join(entryDir, "dist");
    return path.join(distDir, "extensions");
  } catch {
    return "";
  }
};

const isOpenclawInstallStageDir = (name) =>
  name === ".openclaw-install-stage" ||
  String(name || "").startsWith(".openclaw-install-stage-");

const cleanupOpenclawPluginInstallStages = ({
  extensionsDir = resolveOpenclawExtensionsDir(),
} = {}) => {
  if (!extensionsDir) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry?.isDirectory?.()) continue;
      const pluginDir = path.join(extensionsDir, entry.name);
      for (const child of fs.readdirSync(pluginDir, { withFileTypes: true })) {
        if (!child?.isDirectory?.() || !isOpenclawInstallStageDir(child.name)) {
          continue;
        }
        const stageDir = path.join(pluginDir, child.name);
        fs.rmSync(stageDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
        removed += 1;
        console.log(`[alphaclaw] Removed stale OpenClaw plugin install stage: ${stageDir}`);
      }
    }
  } catch (err) {
    console.warn(
      `[alphaclaw] Could not clean OpenClaw plugin install stages: ${err.message}`,
    );
  }
  return removed;
};

const hasEnabledChannelConfig = () => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    return Object.keys(kChannelDefs).some((channel) => channels?.[channel]?.enabled === true);
  } catch {
    return false;
  }
};

const isInstallStageFailure = (err) =>
  /ENOTEMPTY|openclaw-install-stage/i.test(
    [
      err?.message,
      err?.stdout?.toString?.(),
      err?.stderr?.toString?.(),
    ]
      .filter(Boolean)
      .join("\n"),
  );

const readInstalledOpenclawVersion = () => {
  try {
    const entryDir = path.dirname(require.resolve("openclaw"));
    const pkgDir =
      path.basename(entryDir) === "dist" ? path.dirname(entryDir) : entryDir;
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    return String(pkg.version || "");
  } catch {
    return "";
  }
};

const computeDesiredPluginStateHash = () => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const channels = cfg?.channels && typeof cfg.channels === "object" ? cfg.channels : {};
    const enabled = Object.keys(kChannelDefs)
      .filter((channel) => channels?.[channel]?.enabled === true)
      .sort();
    if (enabled.length === 0) return null;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ enabled, version: readInstalledOpenclawVersion() }),
      )
      .digest("hex");
  } catch {
    return null;
  }
};

module.exports = {
  resolveOpenclawExtensionsDir,
  cleanupOpenclawPluginInstallStages,
  hasEnabledChannelConfig,
  isInstallStageFailure,
  readInstalledOpenclawVersion,
  computeDesiredPluginStateHash,
};
