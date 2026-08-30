import { kColorPalette } from "./constants.js";

export const toChartColor = (key) => {
  const raw = String(key || "");
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  }
  return kColorPalette[Math.abs(hash) % kColorPalette.length];
};

export const renderSourceLabel = (source) => {
  if (source === "hooks") return "Hooks";
  if (source === "cron") return "Cron";
  return "Chat";
};

export const renderBreakdownLabel = (value, breakdown) => {
  const normalizedBreakdown = String(breakdown || "model");
  const raw = String(value || "").trim();
  if (!raw) return "Unknown";
  if (normalizedBreakdown === "source") {
    return renderSourceLabel(raw);
  }
  if (normalizedBreakdown === "agent") {
    return raw === "unknown" ? "Unknown agent" : raw;
  }
  return raw;
};
