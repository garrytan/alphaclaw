// Single frontend registry for channel providers (plan 5.0). The server-side
// counterparts are kChannelDefs (lib/server/constants.js) and the maps in
// lib/server/agents/shared.js — extend all of them when adding a provider.
// `icon` is a shared icon component (components/icons.js) — never an
// /assets/* URL: the gateway proxy shadows ALL /assets/* paths
// (lib/server/routes/proxy.js kAssetsPathPattern), so those never resolve.
import {
  DiscordIcon,
  SlackIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "../components/icons.js";

export const kChannelRegistry = [
  {
    id: "telegram",
    label: "Telegram",
    icon: TelegramIcon,
    envKey: "TELEGRAM_BOT_TOKEN",
    onboarding: true,
    pairing: true,
  },
  {
    id: "discord",
    label: "Discord",
    icon: DiscordIcon,
    envKey: "DISCORD_BOT_TOKEN",
    onboarding: true,
    pairing: true,
  },
  {
    id: "slack",
    label: "Slack",
    icon: SlackIcon,
    envKey: "SLACK_BOT_TOKEN",
    extraEnvKeys: ["SLACK_APP_TOKEN"],
    onboarding: true,
    pairing: true,
  },
  {
    // WhatsApp pairs by owner number after setup — not a token accordion.
    id: "whatsapp",
    label: "WhatsApp",
    icon: WhatsAppIcon,
    envKey: "WHATSAPP_OWNER_NUMBER",
  },
  {
    id: "clickclack",
    label: "ClickClack",
    icon: null,
    envKey: "CLICKCLACK_BOT_TOKEN",
    // The paste-one-value guided flow: setup URLs work on stable OpenClaw
    // (--url); raw setup codes need the 2026.8 beta (--code), which the
    // clickclackGuidedSetup capability reports.
    guidedSetup: true,
    // Manual token only in onboarding — fresh installs run the stable pin.
    onboarding: true,
    pairing: true,
    // Fresh onboarding only SAVES the manual bot token — unlike
    // telegram/discord/slack it does NOT write a ClickClack channel config
    // server-side (applyFreshOnboardingChannels), so ClickClack must never be
    // preselected as the onboarding pairing target: the Pairing step would
    // hang forever with no configured bot. Onboarding completes via web chat
    // (or another configured channel); ClickClack is then set up properly from
    // General → Channels (guided flow) in the running app (5.1).
    onboardingPairing: false,
  },
  {
    id: "buzz",
    label: "Buzz",
    icon: null,
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
    // Channels whose onboarding path only stashes a token but never writes a
    // server-side channel config (e.g. ClickClack) can't complete pairing in
    // fresh onboarding — never preselect them as the pairing target.
    if (entry.onboardingPairing === false) continue;
    const keys = [entry.envKey, ...(entry.extraEnvKeys || [])];
    if (keys.every((key) => String(vals?.[key] || "").trim())) return entry.id;
  }
  return "";
};

export const getChannelRegistryEntry = (channelId) =>
  kChannelRegistry.find(
    (entry) => entry.id === String(channelId || "").trim(),
  ) || null;
