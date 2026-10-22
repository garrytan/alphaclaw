import { kChannelRegistry } from "../../../lib/channel-registry.js";

// Derived from the shared channel registry (5.0).
const kChannelEnvKeys = Object.fromEntries(
  kChannelRegistry
    .filter((entry) => entry.envKey)
    .map((entry) => [entry.id, entry.envKey]),
);

export const kChannelExtraEnvKeys = {
  slack: "SLACK_APP_TOKEN",
};

export const slugifyChannelAccountId = (value) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const deriveChannelEnvKey = ({ provider, accountId }) => {
  const baseKey = kChannelEnvKeys[String(provider || "").trim()] || "";
  const normalizedAccountId = String(accountId || "").trim();
  if (!baseKey) return "";
  if (!normalizedAccountId || normalizedAccountId === "default") return baseKey;
  return `${baseKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
};
export const deriveChannelExtraEnvKey = ({ provider, accountId, index = 0 }) => {
  const baseKeys = [kChannelExtraEnvKeys[String(provider || "").trim()]].filter(
    Boolean,
  );
  const baseKey = String(baseKeys[index] || "").trim();
  const normalizedAccountId = String(accountId || "").trim();
  if (!baseKey) return "";
  if (!normalizedAccountId || normalizedAccountId === "default") return baseKey;
  return `${baseKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
};
export const isMaskedTokenValue = (value) => /^\*+$/.test(String(value || "").trim());
