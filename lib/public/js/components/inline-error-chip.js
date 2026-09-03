import { h } from "preact";
import htm from "htm";
import { buildErrorEnvelopeModel } from "../lib/error-envelope.js";

const html = htm.bind(h);

// Persistent inline error chip — the house feedback surface for a control
// that failed or reverted ("never a silent snap-back"). Toasts are for
// successes and fire-and-forget notices; anything that reverts a control
// renders one of these adjacent to it, cleared on the next attempt.
// aria-live so screen readers hear the revert, not just sighted users.
export const InlineErrorChip = ({
  error = null,
  headline = null,
  onRetry = null,
  retryLabel = "Retry",
}) => {
  const envelope = buildErrorEnvelopeModel(error);
  if (!envelope && !headline) return null;
  const detail =
    envelope && envelope.message !== headline ? envelope.message : null;
  return html`
    <div
      class="ac-surface-inset border border-red-500/40 rounded-lg px-3 py-2 flex flex-wrap items-start justify-between gap-2"
      role="status"
      aria-live="polite"
    >
      <div class="min-w-0 space-y-0.5">
        ${headline
          ? html`<p class="text-xs text-status-error">${headline}</p>`
          : null}
        ${detail
          ? html`<p
              class=${headline ? "text-xs text-fg-muted" : "text-xs text-status-error"}
            >
              ${detail}
            </p>`
          : null}
        ${envelope?.hint
          ? html`<p class="text-xs text-fg-muted">${envelope.hint}</p>`
          : null}
        ${envelope?.docsUrl
          ? html`<a
              class="ac-tip-link text-xs"
              href=${envelope.docsUrl}
              target="_blank"
              rel="noreferrer"
              >Learn more</a
            >`
          : null}
      </div>
      ${onRetry
        ? html`<button
            type="button"
            class="text-xs text-fg-muted hover:text-body shrink-0"
            onclick=${onRetry}
          >
            ${retryLabel}
          </button>`
        : null}
    </div>
  `;
};
