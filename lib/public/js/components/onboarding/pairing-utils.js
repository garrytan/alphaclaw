import { getPreferredPairingChannelFromRegistry } from "../../lib/channel-registry.js";

// Derived from the shared channel registry (5.0): first pairing-capable
// provider whose every token is set (Slack needs bot + app token).
export const getPreferredPairingChannel = (vals = {}) =>
  getPreferredPairingChannelFromRegistry(vals);

export const isChannelPaired = (channels = {}, channel = "") => {
  if (!channel) return false;
  const info = channels?.[channel];
  if (!info) return false;
  return info.status === "paired" && Number(info.paired || 0) > 0;
};
