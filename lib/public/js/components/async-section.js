import { h } from "preact";
import htm from "htm";
import { InlineErrorChip } from "./inline-error-chip.js";
import { LoadingSpinner } from "./loading-spinner.js";

const html = htm.bind(h);

// Standard region-state wrapper for fetched lists/status panes. Renders
// exactly one of: error chip (+Retry), loading line, distinct empty state,
// or the children — so "loading", "failed", and "genuinely empty" are never
// conflated (a fetch error must not masquerade as an empty list).
// Precedence: error > loading > empty > children; pass `error` only when the
// error should own the region (e.g. no last-known-good data to keep showing).
export const AsyncSection = ({
  loading = false,
  loadingLabel = "Loading...",
  error = null,
  errorHeadline = "Couldn't load this section.",
  onRetry = null,
  empty = false,
  emptyLabel = "Nothing here yet.",
  children,
}) => {
  if (error) {
    return html`<${InlineErrorChip}
      error=${error}
      headline=${errorHeadline}
      onRetry=${onRetry}
    />`;
  }
  if (loading) {
    return html`
      <div class="flex items-center gap-2 text-sm text-fg-muted py-2">
        <${LoadingSpinner} className="h-4 w-4" />
        ${loadingLabel}
      </div>
    `;
  }
  if (empty) {
    return html`<p class="text-sm text-fg-muted">${emptyLabel}</p>`;
  }
  return children;
};
