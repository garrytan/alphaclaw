import { h } from "preact";
import htm from "htm";
import { useNowMs } from "../../hooks/use-now-ms.js";
import { buildWatchdogStatusDetails } from "./helpers.js";

const html = htm.bind(h);

const kToneClass = {
  warning: "text-status-warning-muted",
  info: "text-status-info-muted",
  muted: "text-fg-muted",
};

// Compact fact row under the Gateway card: degraded duration, last probe age,
// crash budget, repair attempts, PID. Values tick locally off the SSE status.
export const WatchdogStatusDetails = ({ watchdogStatus = null }) => {
  // Time-relative rows exist only when these fields do; otherwise the row
  // renders null and there is nothing to tick for.
  const timeDependent =
    !!watchdogStatus &&
    (watchdogStatus.degradedSince != null ||
      watchdogStatus.lastHealthCheckAt != null);
  const nowMs = useNowMs(1000, { enabled: timeDependent });

  const details = buildWatchdogStatusDetails(watchdogStatus, nowMs);
  if (!details.length) return null;

  return html`
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs">
      ${details.map(
        (detail, index) => html`
          <span
            key=${detail.key}
            class=${`inline-flex items-center gap-3 ${kToneClass[detail.tone] || "text-fg-muted"}`}
          >
            ${index > 0 ? html`<span class="text-fg-dim" aria-hidden="true">·</span>` : null}
            ${detail.label}
          </span>
        `,
      )}
    </div>
  `;
};
