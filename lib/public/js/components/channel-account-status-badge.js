import { h } from "preact";
import htm from "htm";
import { Badge } from "./badge.js";
import { TooltipBadge } from "./tooltip-badge.js";

const html = htm.bind(h);

export const ChannelAccountStatusBadge = ({
  status = "configured",
  ownerAgentName = "",
  showAgentBadge = false,
  channelId = "",
  pairedCount = 0,
}) => {
  const normalizedStatus = String(status || "").trim();
  if (normalizedStatus !== "paired") {
    // Self-standing label; the how-to detail is supplementary (tooltips
    // never open on touch).
    return html`<${TooltipBadge}
      tone="warning"
      label="Pairing incomplete"
      text="Configured but not linked to an account yet — open this channel's pairing flow (QR code or pairing code) to finish."
    />`;
  }
  if (showAgentBadge && ownerAgentName) {
    return html`
      <${Badge} tone="neutral">
        <span class="inline-flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full bg-green-400"></span>
          ${ownerAgentName}
        </span>
      </${Badge}>
    `;
  }
  return html`
    <${Badge} tone="success">
      ${channelId === "telegram" || Number(pairedCount) <= 1
        ? "Paired"
        : `Paired (${Number(pairedCount)})`}
    </${Badge}>
  `;
};
