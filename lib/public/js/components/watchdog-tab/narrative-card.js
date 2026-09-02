import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { useNowMs } from "../../hooks/use-now-ms.js";
import {
  buildWatchdogNarrative,
  formatCountdownRemaining,
} from "./helpers.js";

const html = htm.bind(h);

const kToneHeadlineClass = {
  success: "text-body",
  info: "text-body",
  warning: "text-status-warning-muted",
  danger: "text-status-error-muted",
  neutral: "text-fg-muted",
};

// "What is going on right now" — deterministic narration from the SSE status.
// Countdowns tick on a 1s LOCAL interval against a server-clock offset
// (status.serverNow − Date.now()), so no extra polling and no skew drift.
// The ticking region is deliberately NOT aria-live: a once-per-second
// announcer is hostile to screen readers.
export const WatchdogNarrativeCard = ({ watchdogStatus = null }) => {
  // Only tick when something on screen is time-dependent (countdowns or a
  // "degraded for X" duration line) — a healthy card doesn't re-render every
  // second, and the shared hook pauses while the tab is hidden.
  const timeDependent =
    !!watchdogStatus &&
    (watchdogStatus.degradedSince != null ||
      watchdogStatus.degradedRetry?.dueAt != null ||
      watchdogStatus.backoff?.active === true ||
      watchdogStatus.startupGraceUntil != null ||
      watchdogStatus.expectedRestartUntil != null ||
      watchdogStatus.rollbackDeadlineAt != null ||
      watchdogStatus.stabilization?.active === true);
  const tickNowMs = useNowMs(1000, { enabled: timeDependent });

  const serverOffsetMs = useMemo(
    () =>
      Number.isFinite(Number(watchdogStatus?.serverNow))
        ? Number(watchdogStatus.serverNow) - Date.now()
        : 0,
    [watchdogStatus?.serverNow],
  );
  const serverNowMs = tickNowMs + serverOffsetMs;
  const narrative = buildWatchdogNarrative(watchdogStatus, serverNowMs);

  // Loading shell so the card stack doesn't shift when the SSE settles.
  if (!narrative) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <p class="text-sm text-fg-muted">Loading watchdog status...</p>
      </div>
    `;
  }

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex items-start gap-2">
        <span class="text-sm" aria-hidden="true">${narrative.emoji}</span>
        <div class="min-w-0 space-y-1">
          <div
            class=${`text-sm font-semibold ${kToneHeadlineClass[narrative.tone] || "text-body"}`}
          >
            ${narrative.headline}
          </div>
          ${narrative.detail
            ? html`<p class="text-xs text-fg-muted">${narrative.detail}</p>`
            : null}
        </div>
      </div>
      ${narrative.countdowns.length
        ? html`
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              ${narrative.countdowns.map((countdown) => {
                // A static `value` (e.g. "probing…") wins over the live
                // countdown and must not touch endsAt, which may be null.
                const remaining =
                  countdown.value ??
                  formatCountdownRemaining(countdown.endsAt, serverNowMs);
                if (!remaining) return null;
                return html`
                  <span key=${countdown.key} class="text-xs text-fg-muted">
                    ▸ ${countdown.label}:${" "}
                    <span class="font-mono text-body">${remaining}</span>
                  </span>
                `;
              })}
            </div>
          `
        : null}
      ${narrative.chips.length
        ? html`
            <div class="flex flex-wrap gap-2">
              ${narrative.chips.map(
                (chip) => html`
                  <span
                    key=${chip.key}
                    class="inline-flex items-center rounded-full border border-status-warning-border bg-status-warning-bg px-2 py-0.5 text-xs text-status-warning-muted"
                  >
                    ${chip.label}
                  </span>
                `,
              )}
            </div>
          `
        : null}
      ${narrative.budgets.length
        ? html`
            <div class="text-xs text-fg-muted font-mono">
              ${narrative.budgets.map((budget) => budget.label).join(" · ")}
            </div>
          `
        : null}
    </div>
  `;
};
