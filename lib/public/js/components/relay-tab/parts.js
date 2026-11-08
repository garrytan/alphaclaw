import { h } from "preact";
import htm from "htm";
import { resolveBadgeTone } from "../badge.js";

const html = htm.bind(h);

// The Relay page's dot-plus-word pieces. Dots use the status chip's shapes
// (filled for ok, ring for off, half-filled for warn); a colour always comes
// with its word. A healthy word stays neutral.
const kWordClass = {
  ok: "text-body",
  accent: "text-tone-accent",
  warn: "text-tone-warn",
  bad: "text-tone-bad",
  neutral: "text-fg-muted",
};

const kDotByTone = { ok: "running", accent: "starting", warn: "degraded", bad: "down", neutral: "offline" };

export const StatusDot = ({ tone = "neutral" }) =>
  html`<span class=${"status-chip-dot status-chip-dot--" + kDotByTone[resolveBadgeTone(tone)]} aria-hidden="true"></span>`;

export const ToneWord = ({ tone = "neutral", mono = false, children }) =>
  html`<span class=${"relay-word " + kWordClass[resolveBadgeTone(tone)] + (mono ? " font-mono" : "")}>${children}</span>`;

// Env keys and IPv4 addresses inside a sentence are literal values, so they
// are drawn in mono.
const kLiteralPattern = /(ALPHACLAW_[A-Z0-9_]+(?:=[a-z0-9]+)?|\b\d{1,3}(?:\.\d{1,3}){3}\b)/;

export const withLiterals = (text) =>
  String(text || "")
    .split(kLiteralPattern)
    .map((part, index) => (index % 2 === 1 ? html`<code class="font-mono">${part}</code>` : part));

// One fact under the headline. Without a word, the sentence itself carries
// the tone (the exposure warning).
export const FactRow = ({ tone = "neutral", word = "", children = null }) => html`
  <li class="relay-fact">
    <${StatusDot} tone=${tone} />
    <span class="relay-fact-body">
      ${word ? html`<${ToneWord} tone=${tone}>${word}</${ToneWord}>` : null}
      ${children
        ? html`<span class=${word ? "relay-fact-detail" : "relay-fact-detail " + kWordClass[resolveBadgeTone(tone)]}>${children}</span>`
        : null}
    </span>
  </li>
`;

export const BriefingSection = ({ id, title, actions = null, caption = null, children }) => html`
  <section class="briefing-section" aria-labelledby=${id}>
    <div class="briefing-section-head">
      <h2 class="briefing-section-title" id=${id}>${title}</h2>
      ${actions ? html`<div class="briefing-section-actions">${actions}</div>` : null}
    </div>
    ${caption ? html`<p class="briefing-section-caption">${caption}</p>` : null}
    ${children}
  </section>
`;
