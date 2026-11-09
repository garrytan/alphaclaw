import { h } from "preact";
import htm from "htm";
import { StatusDot, ToneWord } from "../relay-tab/parts.js";
import { describeProblem } from "./model.js";

const html = htm.bind(h);

export const kFieldClass = "bg-field border rounded-lg px-2 py-1 text-sm min-h-[40px]";

// One problem body as the owner reads it: what failed, what to do, whether
// retrying helps and what already happened. A partial save is a warning,
// because part of the change is live.
export const ProblemCard = ({ problem, action = "" }) => {
  if (!problem) return null;
  const view = describeProblem(problem, { action });
  return html`
    <div class="groups-problem" role="alert">
      <p class="groups-problem-title">
        <${StatusDot} tone=${view.tone} />
        <${ToneWord} tone=${view.tone}>${view.title}</${ToneWord}>
      </p>
      ${view.detail ? html`<p class="groups-problem-detail">${view.detail}</p>` : null}
      ${view.sideEffects ? html`<p class=${view.partial ? "text-tone-warn" : ""}>${view.sideEffects}</p>` : null}
      ${view.fix ? html`<p><span class="text-fg-muted">Fix: </span>${view.fix}</p>` : null}
      ${view.retry || view.code
        ? html`<p class="groups-problem-meta">
            ${view.retry}
            ${view.code ? html`<span> (code <code class="font-mono">${view.code}</code>)</span>` : null}
          </p>`
        : null}
    </div>
  `;
};

// Rules as key: value lines (Custom groups, change previews).
export const RuleLines = ({ lines = [], empty = "No rules" }) =>
  lines.length
    ? html`<dl class="groups-rules">
        ${lines.map(
          (line) => html`<div class="groups-rules-row" key=${line.key}><dt class="font-mono">${line.key}</dt><dd>${line.value}</dd></div>`,
        )}
      </dl>`
    : html`<p class="text-sm text-fg-muted">${empty}</p>`;
