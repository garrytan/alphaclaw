const { buildSecretReplacements } = require("../helpers");
const { writeFileAtomic } = require("../utils/safe-file");
const {
  ensurePluginsShell,
  ensurePluginAllowed,
  ensureUsageTrackerPluginEntry,
} = require("../usage-tracker-config");
const { isOpenAiCompatApiEnabled } = require("../alphaclaw-config");
const { ensureCodexRuntimePlugin } = require("../codex-runtime-config");
const { kChannelDefs } = require("../constants");
const { ensureLegacyCompatibilityDefaults } = require("../openclaw-config-migrations");

// Key names a config-derived object must never smuggle into a merge.
const kDangerousConfigKeys = new Set(["__proto__", "constructor", "prototype"]);

// Channels AlphaClaw does not manage via env tokens (e.g. signal linked via
// signal-cli). The fresh onboarding path runs `openclaw onboard`, which
// rewrites openclaw.json from scratch and would silently drop them (#113) —
// snapshot them first so writeSanitizedOpenclawConfig can re-add (add-only)
// any the onboard run lost. Values are restricted to plain objects and copied
// onto a null-prototype target; dangerous key names are skipped outright.
const snapshotExternalChannelConfigs = ({ fs, openclawDir }) => {
  const snapshot = Object.create(null);
  try {
    const raw = fs.readFileSync(`${openclawDir}/openclaw.json`, "utf8");
    const cfg = JSON.parse(raw);
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
      return snapshot;
    }
    const managedChannelIds = new Set(
      Object.entries(kChannelDefs)
        .filter(([, def]) => def.envKey)
        .map(([channelId]) => channelId),
    );
    for (const key of Object.keys(channels)) {
      if (kDangerousConfigKeys.has(key) || managedChannelIds.has(key)) continue;
      const value = channels[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      snapshot[key] = value;
    }
  } catch {}
  return snapshot;
};

const kDefaultToolsProfile = "full";
// AlphaClaw's prompt hardening ships as two extra files, rules first and
// operator data (Google accounts, topic registry) second, each under its own
// per-file cap: AGENTS.md is a valid bootstrap-extra-files basename on every
// supported OpenClaw line, while TOOLS.md is rejected on 2026.8.1+ (see
// docs/designs/openclaw-context-contract.md). The legacy TOOLS.md path is
// reconciled away by syncBootstrapPromptFiles on every resync.
const kAlphaclawRulesBootstrapPath = "hooks/bootstrap/AGENTS.md";
const kAlphaclawReferenceBootstrapPath = "hooks/bootstrap/reference/AGENTS.md";
const kAlphaclawBootstrapExtraPaths = [
  kAlphaclawRulesBootstrapPath,
  kAlphaclawReferenceBootstrapPath,
];
const kLegacyAlphaclawBootstrapExtraPaths = ["hooks/bootstrap/TOOLS.md"];
// The Setup UI map: written next to the reference file for every agent and
// read on demand. Never a bootstrap-extra-files path (it is not injected).
const kAlphaclawSetupUiReferencePath = "hooks/bootstrap/reference/setup-ui.md";

// AlphaClaw's paths stay first (they must win the injection-order budget race
// among extras); user-added paths are preserved verbatim; the legacy
// AlphaClaw TOOLS.md path and the Setup UI map (provably ours, and neither a
// valid extras basename) are dropped; exact duplicates dedupe.
// includeReference: false leaves the reference path out (an operator opt-out,
// see resolveBootstrapExtraEntryPlan); the rules path is always written.
const reconcileBootstrapExtraPaths = (existingPaths = [], { includeReference = true } = {}) => {
  const preservedUserPaths = (Array.isArray(existingPaths) ? existingPaths : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter(
      (value) =>
        !kAlphaclawBootstrapExtraPaths.includes(value) &&
        !kLegacyAlphaclawBootstrapExtraPaths.includes(value) &&
        value !== kAlphaclawSetupUiReferencePath,
    );
  const managedPaths = includeReference
    ? kAlphaclawBootstrapExtraPaths
    : [kAlphaclawRulesBootstrapPath];
  return [...new Set([...managedPaths, ...preservedUserPaths])];
};

// The bundled bootstrap-extra-files hook resolves extras as `paths` if
// non-empty, ELSE `patterns` if non-empty, ELSE `files` — a managed non-empty
// `paths` array short-circuits the alias keys COMPLETELY. So the reconciled
// `paths` must fold in any alias-configured extras (order: AlphaClaw's path,
// existing paths, patterns, files; dedupe + legacy-drop via
// reconcileBootstrapExtraPaths). The alias keys themselves stay untouched on
// the entry — harmless once `paths` is a superset, and never ours to delete.
const listBootstrapExtraEntryPaths = (entry = {}) => [
  ...(Array.isArray(entry?.paths) ? entry.paths : []),
  ...(Array.isArray(entry?.patterns) ? entry.patterns : []),
  ...(Array.isArray(entry?.files) ? entry.files : []),
];

const reconcileBootstrapExtraEntryPaths = (entry = {}, options = {}) =>
  reconcileBootstrapExtraPaths(listBootstrapExtraEntryPaths(entry), options);

const listEffectiveBootstrapExtraPaths = (entry = {}) => {
  for (const value of [entry?.paths, entry?.patterns, entry?.files]) {
    const list = (Array.isArray(value) ? value : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return [];
};

// What the bootstrap-extra-files entry must hold, decided from the LIVE
// config (callers run it inside the locked openclaw.json mutate) and the
// persisted opt-out flag (alphaclaw.json promptFiles.reference), never from
// the absence of a path alone:
// - referenceRemoved: an operator took the reference path out of a live entry
//   (the entry exists, it and hooks.internal are enabled, it still lists the
//   rules path) after an AlphaClaw that writes the reference file had run.
//   Without that evidence (referenceFileSeen false: a config written before
//   v0.10.117, when the rules file was the only extra) both paths are added.
//   A deleted entry, disabled hooks or an onboard rewrite never count.
// - referenceReadded: the flag is set but the reference path is back in the
//   entry (a hand edit, or onboarding's managed shell), so the flag clears.
//   The flag only stops AlphaClaw adding the path; it never removes one.
// - rulesRestored: a live, non-empty entry lost the rules path. The rules are
//   AlphaClaw's safety floor, so they always go back.
const resolveBootstrapExtraEntryPlan = ({
  config,
  referenceDisabled = false,
  referenceFileSeen = false,
} = {}) => {
  const entry = config?.hooks?.internal?.entries?.["bootstrap-extra-files"];
  const entryPaths = listEffectiveBootstrapExtraPaths(entry);
  const entryLive =
    config?.hooks?.internal?.enabled === true && Boolean(entry) && entry.enabled === true;
  const listsRules = entryPaths.includes(kAlphaclawRulesBootstrapPath);
  const listsReference = entryPaths.includes(kAlphaclawReferenceBootstrapPath);
  const referenceRemoved =
    !referenceDisabled && referenceFileSeen && entryLive && listsRules && !listsReference;
  const referenceReadded = referenceDisabled && listsReference;
  const includeReference = referenceReadded || (!referenceDisabled && !referenceRemoved);
  return {
    paths: reconcileBootstrapExtraEntryPaths(entry, { includeReference }),
    referenceRemoved,
    referenceReadded,
    rulesRestored: entryLive && entryPaths.length > 0 && !listsRules,
  };
};

const buildOnboardArgs = ({
  varMap,
  selectedProvider,
  hasCodexOauth,
  workspaceDir,
}) => {
  const openclawGatewayToken =
    varMap.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";
  const anthropicToken = varMap.ANTHROPIC_TOKEN || "";
  const anthropicApiKey = varMap.ANTHROPIC_API_KEY || "";
  const openaiApiKey = varMap.OPENAI_API_KEY || "";
  const geminiApiKey = varMap.GEMINI_API_KEY || "";
  const onboardArgs = [
    "--non-interactive",
    "--accept-risk",
    "--flow",
    "quickstart",
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    "18789",
    "--gateway-auth",
    "token",
    "--gateway-token",
    openclawGatewayToken,
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    workspaceDir,
  ];

  if (
    selectedProvider === "openai-codex" &&
    openaiApiKey
  ) {
    onboardArgs.push(
      "--auth-choice",
      "openai-api-key",
      "--openai-api-key",
      openaiApiKey,
    );
  } else if (selectedProvider === "openai-codex" && hasCodexOauth) {
    onboardArgs.push("--auth-choice", "skip");
  } else if (
    (selectedProvider === "anthropic" || !selectedProvider) &&
    anthropicToken
  ) {
    onboardArgs.push(
      "--auth-choice",
      "token",
      "--token-provider",
      "anthropic",
      "--token",
      anthropicToken,
    );
  } else if (
    (selectedProvider === "anthropic" || !selectedProvider) &&
    anthropicApiKey
  ) {
    onboardArgs.push(
      "--auth-choice",
      "apiKey",
      "--anthropic-api-key",
      anthropicApiKey,
    );
  } else if (
    (selectedProvider === "openai" || !selectedProvider) &&
    openaiApiKey
  ) {
    onboardArgs.push(
      "--auth-choice",
      "openai-api-key",
      "--openai-api-key",
      openaiApiKey,
    );
  } else if (
    (selectedProvider === "google" || !selectedProvider) &&
    geminiApiKey
  ) {
    onboardArgs.push(
      "--auth-choice",
      "gemini-api-key",
      "--gemini-api-key",
      geminiApiKey,
    );
  } else if (anthropicToken) {
    onboardArgs.push(
      "--auth-choice",
      "token",
      "--token-provider",
      "anthropic",
      "--token",
      anthropicToken,
    );
  } else if (anthropicApiKey) {
    onboardArgs.push(
      "--auth-choice",
      "apiKey",
      "--anthropic-api-key",
      anthropicApiKey,
    );
  } else if (openaiApiKey) {
    onboardArgs.push(
      "--auth-choice",
      "openai-api-key",
      "--openai-api-key",
      openaiApiKey,
    );
  } else if (geminiApiKey) {
    onboardArgs.push(
      "--auth-choice",
      "gemini-api-key",
      "--gemini-api-key",
      geminiApiKey,
    );
  } else if (hasCodexOauth) {
    onboardArgs.push("--auth-choice", "skip");
  }

  return onboardArgs;
};

const ensureManagedConfigShell = (cfg, { openAiCompatApiEnabled = false } = {}) => {
  if (!cfg.channels) cfg.channels = {};
  ensurePluginsShell(cfg);
  if (!cfg.commands) cfg.commands = {};
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.gateway) cfg.gateway = {};
  ensureLegacyCompatibilityDefaults(cfg);
  if (!cfg.hooks) cfg.hooks = {};
  if (!cfg.hooks.internal) cfg.hooks.internal = {};
  if (!cfg.hooks.internal.entries) cfg.hooks.internal.entries = {};
  cfg.commands.restart = true;
  cfg.tools.profile = kDefaultToolsProfile;
  if (openAiCompatApiEnabled) {
    if (!cfg.gateway.http) cfg.gateway.http = {};
    if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
    cfg.gateway.http.endpoints.chatCompletions = {
      ...(cfg.gateway.http.endpoints.chatCompletions || {}),
      enabled: true,
    };
    cfg.gateway.http.endpoints.responses = {
      ...(cfg.gateway.http.endpoints.responses || {}),
      enabled: true,
    };
  }
  cfg.hooks.internal.enabled = true;
  cfg.hooks.internal.entries["bootstrap-extra-files"] = {
    ...(cfg.hooks.internal.entries["bootstrap-extra-files"] || {}),
    enabled: true,
    paths: reconcileBootstrapExtraEntryPaths(
      cfg.hooks.internal.entries["bootstrap-extra-files"],
    ),
  };
};

const getSafeImportedDmPolicy = (channelConfig = {}) => {
  if (
    channelConfig?.dmPolicy === "allowlist" &&
    (!Array.isArray(channelConfig?.allowFrom) ||
      channelConfig.allowFrom.length === 0)
  ) {
    return "pairing";
  }
  return channelConfig?.dmPolicy || "pairing";
};

const applyFreshOnboardingChannels = ({
  cfg,
  varMap,
}) => {
  if (varMap.TELEGRAM_BOT_TOKEN) {
    cfg.channels.telegram = {
      enabled: true,
      botToken: varMap.TELEGRAM_BOT_TOKEN,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    };
    cfg.plugins.entries.telegram = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "telegram" });
    console.log("[onboard] Telegram configured");
  }
  if (varMap.DISCORD_BOT_TOKEN) {
    cfg.channels.discord = {
      enabled: true,
      token: varMap.DISCORD_BOT_TOKEN,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    };
    cfg.plugins.entries.discord = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "discord" });
    console.log("[onboard] Discord configured");
  }
  if (varMap.SLACK_BOT_TOKEN && varMap.SLACK_APP_TOKEN) {
    cfg.channels.slack = {
      enabled: true,
      botToken: varMap.SLACK_BOT_TOKEN,
      appToken: varMap.SLACK_APP_TOKEN,
      mode: "socket",
      dmPolicy: "pairing",
      groupPolicy: "open",
    };
    cfg.plugins.entries.slack = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "slack" });
    console.log("[onboard] Slack configured");
  }
  if (varMap.WHATSAPP_OWNER_NUMBER) {
    cfg.channels.whatsapp = {
      enabled: true,
      allowFrom: [varMap.WHATSAPP_OWNER_NUMBER],
      groupAllowFrom: [varMap.WHATSAPP_OWNER_NUMBER],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      selfChatMode: true,
    };
    cfg.plugins.entries.whatsapp = { enabled: true };
    ensurePluginAllowed({ cfg, pluginKey: "whatsapp" });
    console.log("[onboard] WhatsApp configured");
  }
  ensureUsageTrackerPluginEntry(cfg);
};

const writeSanitizedOpenclawConfig = ({
  fs,
  openclawDir,
  varMap,
  preservedChannels = null,
}) => {
  const configPath = `${openclawDir}/openclaw.json`;
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ensureManagedConfigShell(cfg, {
    openAiCompatApiEnabled: isOpenAiCompatApiEnabled({
      fsModule: fs,
      openclawDir,
    }),
  });
  applyFreshOnboardingChannels({
    cfg,
    varMap,
  });
  ensureCodexRuntimePlugin(cfg);
  // Re-add externally-configured channels the `openclaw onboard` rewrite
  // dropped (#113). ADD-ONLY through this same sanitized write path: a key
  // onboarding itself wrote is never overwritten by the stale snapshot.
  if (preservedChannels && typeof preservedChannels === "object") {
    if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
    for (const key of Object.keys(preservedChannels)) {
      if (kDangerousConfigKeys.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(cfg.channels, key)) continue;
      cfg.channels[key] = preservedChannels[key];
    }
  }

  let content = JSON.stringify(cfg, null, 2);
  const replacements = buildSecretReplacements(varMap, process.env);
  for (const [secret, envRef] of replacements) {
    if (secret) {
      // Only replace exact JSON string values so path substrings are never mutated.
      const secretJson = JSON.stringify(secret);
      content = content.replace(
        new RegExp(
          secretJson.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
          "g",
        ),
        JSON.stringify(envRef),
      );
    }
  }
  writeFileAtomic(configPath, content, { fsModule: fs });
  console.log("[onboard] Config sanitized");
};

const writeManagedImportOpenclawConfig = ({
  fs,
  openclawDir,
  varMap,
}) => {
  const configPath = `${openclawDir}/openclaw.json`;
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ensureManagedConfigShell(cfg, {
    openAiCompatApiEnabled: isOpenAiCompatApiEnabled({
      fsModule: fs,
      openclawDir,
    }),
  });

  ensureUsageTrackerPluginEntry(cfg);

  if (varMap.TELEGRAM_BOT_TOKEN) {
    cfg.channels.telegram = {
      ...(cfg.channels.telegram || {}),
      enabled: true,
      botToken: "${TELEGRAM_BOT_TOKEN}",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.telegram),
      groupPolicy: cfg.channels.telegram?.groupPolicy || "allowlist",
    };
    cfg.plugins.entries.telegram = {
      ...(cfg.plugins.entries.telegram || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "telegram" });
  }

  if (varMap.DISCORD_BOT_TOKEN) {
    cfg.channels.discord = {
      ...(cfg.channels.discord || {}),
      enabled: true,
      token: "${DISCORD_BOT_TOKEN}",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.discord),
      groupPolicy: cfg.channels.discord?.groupPolicy || "allowlist",
    };
    cfg.plugins.entries.discord = {
      ...(cfg.plugins.entries.discord || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "discord" });
  }

  if (varMap.SLACK_BOT_TOKEN && varMap.SLACK_APP_TOKEN) {
    cfg.channels.slack = {
      ...(cfg.channels.slack || {}),
      enabled: true,
      botToken: "${SLACK_BOT_TOKEN}",
      appToken: "${SLACK_APP_TOKEN}",
      mode: cfg.channels.slack?.mode || "socket",
      dmPolicy: getSafeImportedDmPolicy(cfg.channels.slack),
      groupPolicy: cfg.channels.slack?.groupPolicy || "open",
    };
    cfg.plugins.entries.slack = {
      ...(cfg.plugins.entries.slack || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "slack" });
  }

  if (varMap.WHATSAPP_OWNER_NUMBER) {
    const existingWhatsApp = cfg.channels.whatsapp || {};
    const existingAllowFrom = Array.isArray(existingWhatsApp.allowFrom)
      ? existingWhatsApp.allowFrom
      : [];
    const ownerRef = "${WHATSAPP_OWNER_NUMBER}";
    cfg.channels.whatsapp = {
      ...existingWhatsApp,
      enabled: true,
      allowFrom: existingAllowFrom.includes(ownerRef)
        ? existingAllowFrom
        : [...existingAllowFrom, ownerRef],
      groupAllowFrom: existingAllowFrom.includes(ownerRef)
        ? existingAllowFrom
        : [...existingAllowFrom, ownerRef],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      selfChatMode: true,
    };
    cfg.plugins.entries.whatsapp = {
      ...(cfg.plugins.entries.whatsapp || {}),
      enabled: true,
    };
    ensurePluginAllowed({ cfg, pluginKey: "whatsapp" });
  }

  ensureCodexRuntimePlugin(cfg);

  writeFileAtomic(configPath, JSON.stringify(cfg, null, 2), { fsModule: fs });
};

module.exports = {
  buildOnboardArgs,
  kAlphaclawBootstrapExtraPaths,
  kAlphaclawReferenceBootstrapPath,
  kAlphaclawRulesBootstrapPath,
  kAlphaclawSetupUiReferencePath,
  kLegacyAlphaclawBootstrapExtraPaths,
  reconcileBootstrapExtraEntryPaths,
  reconcileBootstrapExtraPaths,
  resolveBootstrapExtraEntryPlan,
  snapshotExternalChannelConfigs,
  writeManagedImportOpenclawConfig,
  writeSanitizedOpenclawConfig,
};
