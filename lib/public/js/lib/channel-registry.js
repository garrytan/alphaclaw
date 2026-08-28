// Single frontend registry for channel providers (plan 5.0). The server-side
// counterparts are kChannelDefs (lib/server/constants.js) and the maps in
// lib/server/agents/shared.js — extend all of them when adding a provider.
export const kChannelRegistry = [
  {
    id: "telegram",
    label: "Telegram",
    iconSrc: "/assets/icons/telegram.svg",
    envKey: "TELEGRAM_BOT_TOKEN",
  },
  {
    id: "discord",
    label: "Discord",
    iconSrc: "/assets/icons/discord.svg",
    envKey: "DISCORD_BOT_TOKEN",
  },
  {
    id: "slack",
    label: "Slack",
    iconSrc: "/assets/icons/slack.svg",
    envKey: "SLACK_BOT_TOKEN",
    extraEnvKeys: ["SLACK_APP_TOKEN"],
  },
  {
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
  },
];

export const kAllChannelIds = kChannelRegistry.map((entry) => entry.id);

export const getChannelRegistryEntry = (channelId) =>
  kChannelRegistry.find(
    (entry) => entry.id === String(channelId || "").trim(),
  ) || null;
