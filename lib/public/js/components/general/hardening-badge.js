import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";
import { Tooltip } from "../tooltip.js";

const html = htm.bind(h);

export const getHardeningBadgeModel = (doctorStatus = null) => {
  const hardening = doctorStatus?.bootstrapContext?.hardening || null;
  // Old server payloads lack `hardening`; hide the badge entirely.
  if (!hardening || typeof hardening !== "object") return null;
  if (String(doctorStatus?.releaseChannel || "") === "dev") {
    return {
      tone: "warning",
      label: "Hardening: unverified",
      title:
        "Dev channel builds run upstream source, so prompt hardening cannot be verified.",
    };
  }
  const state = String(hardening.state || "").trim();
  if (state === "injected") {
    return {
      tone: "success",
      label: "Hardening: injected",
      title: "Prompt hardening files are fully injected into agent context.",
    };
  }
  if (state === "starved") {
    return {
      tone: "warning",
      label: "Hardening: partial",
      title:
        "Part of the prompt hardening was cut by the total context budget.",
    };
  }
  if (state === "blocked") {
    return {
      tone: "danger",
      label: "Hardening: blocked",
      title:
        "A prompt hardening file is being rejected and does not reach the agent.",
    };
  }
  return {
    tone: "neutral",
    label: "Hardening: unknown",
    title:
      String(hardening.reason || "") === "config_unreadable"
        ? "openclaw.json uses a config flavor AlphaClaw cannot parse, so hardening injection cannot be verified. Use /context on the agent to check."
        : "Prompt hardening state could not be determined.",
  };
};

export const GeneralHardeningBadge = ({ doctorStatus = null }) => {
  const model = getHardeningBadgeModel(doctorStatus);
  if (!model) return null;
  return html`
    <div class="flex items-center px-1">
      <${Tooltip}
        text=${model.title}
        widthClass="w-auto max-w-64 whitespace-normal"
      >
        <span class="inline-flex" tabindex="0" aria-label=${model.title}>
          <${Badge} tone=${model.tone}>${model.label}<//>
        </span>
      </${Tooltip}>
    </div>
  `;
};
