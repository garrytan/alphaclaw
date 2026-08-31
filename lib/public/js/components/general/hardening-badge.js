import { h } from "preact";
import htm from "htm";
import { TooltipBadge } from "../tooltip-badge.js";

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
  // Problem states (blocked/starved) are owned by GeneralHardeningCard —
  // a persistent card naming each file, cause, and fix. Danger-grade info
  // must never be hover-only, so the badge yields entirely (dev channel
  // already returned "unverified" above).
  if (state === "starved" || state === "blocked") return null;
  return {
    tone: "neutral",
    label: "Hardening: unknown",
    title:
      String(hardening.reason || "") === "config_unreadable"
        ? "openclaw.json uses a config flavor AlphaClaw cannot parse, so hardening injection cannot be verified. Use /context on the agent to check."
        : "Prompt hardening state could not be determined. Run /context on the agent to check.",
  };
};

export const GeneralHardeningBadge = ({ doctorStatus = null }) => {
  const model = getHardeningBadgeModel(doctorStatus);
  if (!model) return null;
  return html`
    <div class="flex items-center px-1">
      <${TooltipBadge}
        tone=${model.tone}
        label=${model.label}
        text=${model.title}
        widthClass="w-auto max-w-64"
      />
    </div>
  `;
};
