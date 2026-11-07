import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

const kToneClasses = {
  ok: "bg-tone-ok-bg text-tone-ok",
  warn: "bg-tone-warn-bg text-tone-warn",
  bad: "bg-tone-bad-bg text-tone-bad",
  accent: "bg-tone-accent-bg text-tone-accent",
  neutral: "bg-tone-neutral-bg text-tone-neutral",
};

const kToneAliases = {
  success: "ok",
  warning: "warn",
  danger: "bad",
  info: "accent",
  cyan: "accent",
  secondary: "neutral",
  subtle: "neutral",
};

export const resolveBadgeTone = (tone = "neutral") => {
  const resolved = kToneAliases[tone] || tone;
  return kToneClasses[resolved] ? resolved : "neutral";
};

export const Badge = ({ tone = "neutral", children }) => html`
  <span class="text-xs px-2 py-0.5 rounded-full font-medium ${kToneClasses[resolveBadgeTone(tone)]}">
    ${children}
  </span>
`;
