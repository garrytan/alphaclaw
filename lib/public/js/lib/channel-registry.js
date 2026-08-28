// Single frontend registry for channel providers (plan 5.0). The server-side
// counterparts are kChannelDefs (lib/server/constants.js) and the maps in
// lib/server/agents/shared.js — extend all of them when adding a provider.
export const kChannelRegistry = [
  {
    id: "telegram",
    label: "Telegram",
    iconSrc: "/assets/icons/telegram.svg",
    envKey: "TELEGRAM_BOT_TOKEN",
    onboarding: true,
    pairing: true,
  },
  {
    id: "discord",
    label: "Discord",
    iconSrc: "/assets/icons/discord.svg",
    envKey: "DISCORD_BOT_TOKEN",
    onboarding: true,
    pairing: true,
  },
  {
    id: "slack",
    label: "Slack",
    iconSrc: "/assets/icons/slack.svg",
    envKey: "SLACK_BOT_TOKEN",
    extraEnvKeys: ["SLACK_APP_TOKEN"],
    onboarding: true,
    pairing: true,
  },
  {
    // WhatsApp pairs by owner number after setup — not a token accordion.
    id: "whatsapp",
    label: "WhatsApp",
    iconSrc: "/assets/icons/whatsapp.svg",
    envKey: "WHATSAPP_OWNER_NUMBER",
  },
  {
    id: "clickclack",
    label: "ClickClack",
    iconSrc: "",
    envKey: "CLICKCLACK_BOT_TOKEN",
    // The paste-one-value guided flow: setup URLs work on stable OpenClaw
    // (--url); raw setup codes need the 2026.8 beta (--code), which the
    // clickclackGuidedSetup capability reports.
    guidedSetup: true,
    // Manual token only in onboarding — fresh installs run the stable pin.
    onboarding: true,
    pairing: true,
  },
  {
    id: "buzz",
    label: "Buzz",
    iconSrc: "",
    // Beta-only external plugin, set up through a resumable wizard instead of
    // the create-channel modal. Shown DISABLED with the unmet requirement
    // when the gateway can't support it yet (D15), never silently hidden.
    wizard: true,
    capability: "buzzChannel",
  },
];

export const kAllChannelIds = kChannelRegistry.map((entry) => entry.id);

// Token fields for the onboarding accordion (env key + extras), registry order.
export const kOnboardingChannelDefs = kChannelRegistry
  .filter((entry) => entry.onboarding && entry.envKey)
  .map((entry) => ({
    id: entry.id,
    title: entry.label,
    fieldKeys: [entry.envKey, ...(entry.extraEnvKeys || [])],
  }));

// Preferred pairing channel: first registry entry whose EVERY token is set
// (Slack needs bot + app token).
export const getPreferredPairingChannelFromRegistry = (vals = {}) => {
  for (const entry of kChannelRegistry) {
    if (!entry.pairing || !entry.envKey) continue;
    const keys = [entry.envKey, ...(entry.extraEnvKeys || [])];
    if (keys.every((key) => String(vals?.[key] || "").trim())) return entry.id;
  }
  return "";
};

export const getChannelRegistryEntry = (channelId) =>
  kChannelRegistry.find(
    (entry) => entry.id === String(channelId || "").trim(),
  ) || null;
