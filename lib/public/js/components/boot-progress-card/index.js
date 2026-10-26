import { h } from "preact";
import htm from "htm";
import { useBootProgress } from "./use-boot-progress.js";

const html = htm.bind(h);

// Stage glyphs never rely on color alone (gateway.js glyph rule).
const kStageGlyph = { done: "✓", failed: "✕", stopped: "–", running: "", pending: "" };

// The boot card, rendered in the Gateway card's progress slot while the boot
// timeline is non-terminal (a restart or upgrade operation owns the slot
// instead). Hierarchy: the Gateway card's label is the kind headline and its
// reason the stage sentence; this card adds the timing line, the stage list
// and, after two quiet minutes, the "no output" line with View logs. The
// clock ticks outside every live region; only stage changes are announced.
export const BootProgressCard = ({ shell, onViewLogs = null }) => {
  const model = useBootProgress(shell);
  if (!model) return null;
  if (model.kind === "success" || model.kind === "unverified") {
    return html`<p class=${`text-xs ${model.kind === "success" ? "text-status-success" : "text-fg-muted"}`} role="status" data-boot-card=${model.kind}>
      ${model.text}
    </p>`;
  }
  return html`
    <div class="ac-surface-inset border border-border rounded-lg px-3 py-2 space-y-2" data-boot-card=${model.kind}>
      ${model.kind === "failed"
        ? html`<p class="text-xs text-status-error" role="status">${model.text}</p>`
        : html`
            <span class="sr-only" aria-live="polite">${model.stageLabel || ""}</span>
            <p class="text-xs text-fg-muted" data-boot-timing>${model.frozen ? "Last known — " : ""}${model.timing}</p>
            ${model.doctorProgress ? html`<p class="text-xs text-fg-muted" data-boot-doctor-progress>${model.doctorProgress}</p>` : null}
            ${model.lockWait ? html`<p class="text-xs text-fg-muted" data-boot-lock-wait>${model.lockWait}</p>` : null}
          `}
      <ol class="ac-boot-stages" aria-label="Startup stages">
        ${model.stages.map((stage) => html`
          <li
            key=${stage.id}
            class=${`ac-boot-stage ac-boot-stage--${stage.status}`}
            aria-current=${stage.current ? "step" : null}
          >
            <span class="ac-boot-stage__mark" aria-hidden="true">
              ${stage.status === "running"
                ? html`<span class="ac-gateway-dot ac-gateway-dot--cyan ac-gateway-dot--pulse"></span>`
                : kStageGlyph[stage.status] || html`<span class="ac-gateway-dot ac-gateway-dot--gray ac-gateway-dot--hollow"></span>`}
            </span>
            <span class="ac-boot-stage__label">${stage.label}</span>
            <span class="ac-boot-stage__status">${stage.durationLabel && stage.status === "done" ? stage.durationLabel : stage.statusText}</span>
          </li>
        `)}
      </ol>
      ${model.quiet
        ? html`<p class="text-xs text-status-warning">
            ${model.quiet} ·
            <button type="button" class="ac-tip-link ac-touch" onclick=${() => onViewLogs?.()}>View logs</button>
          </p>`
        : null}
    </div>
  `;
};

// The boot internals group inside the Gateway card's existing Details
// disclosure: versions, each step with its duration, OpenClaw's own startup
// trace in plain words and the last activity.
export const BootDetailsGroup = ({ bootProgress, formatDuration }) => {
  if (!bootProgress) return null;
  const steps = Array.isArray(bootProgress.steps) ? bootProgress.steps : [];
  const doctor = bootProgress.doctor || {};
  const versions = bootProgress.versions || {};
  return html`
    <div data-boot-details>
      <dt>Startup:</dt>
      <dd>
        <ul class="mt-1 list-disc pl-4 space-y-0.5">
          ${versions.alphaclaw ? html`<li>AlphaClaw ${versions.alphaclaw}${versions.openclaw ? `, OpenClaw ${versions.openclaw}` : ""}</li>` : null}
          ${doctor.ran ? html`<li>OpenClaw data upgrade${doctor.fromVersion ? ` from ${doctor.fromVersion}` : ""}${doctor.toVersion ? ` to ${doctor.toVersion}` : ""}</li>` : null}
          ${steps.map((step) => html`<li key=${`${step.id}-${step.startedAt}`}>
            ${step.label}${Number.isFinite(step.startedAt) && Number.isFinite(step.endedAt) ? ` · ${formatDuration(step.endedAt - step.startedAt)}` : bootProgress.outcome === null ? " · in progress" : ""}
          </li>`)}
          ${bootProgress.trace?.words ? html`<li>OpenClaw: ${bootProgress.trace.words}</li>` : null}
          ${Number.isFinite(bootProgress.lastActivityAgeMs) && bootProgress.outcome === null
            ? html`<li>Last output ${formatDuration(bootProgress.lastActivityAgeMs)} ago</li>`
            : null}
        </ul>
      </dd>
    </div>
  `;
};
