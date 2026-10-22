import { h } from "preact";
import htm from "htm";
import { useNowMs } from "../../../hooks/use-now-ms.js";
import { ActionButton } from "../../action-button.js";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { SavedToggle } from "../../saved-toggle.js";
import { kOverseerSharedCopy } from "../helpers.js";
import {
  kOverseerCardCopy,
  asRecord,
  toMs,
  buildWatchdogOverseerModel,
  describeAvailability,
  describeOverseerToggleError,
} from "./model.js";

const html = htm.bind(h);

// Watchdog incident overseer card. Advisory-only: verdicts never trigger
// anything; the CTA buttons are the SAME existing handlers the rest of the
// tab uses.
//
// Two report kinds share the card: the manual SITUATION report (what the
// overseer thinks is happening right now — polled from
// /api/watchdog/overseer/situation every 15s) and the newest POST-INCIDENT
// review riding the incidents poll. The newest one is primary; the other
// stays one click away via the secondary line. All review state (settings,
// poll, in-flight, ephemeral result) is lifted into use-watchdog-tab.js
// because the incidents card's row action shares it.
const StatusSlot = ({ line = null }) => {
  if (!line) return null;
  if (line.tone === "error") {
    return html`<${InlineErrorChip} error=${line.error} headline=${line.text} />`;
  }
  const toneClass =
    line.tone === "warning" ? "text-status-warning-muted" : "text-fg-muted";
  // The live region carries only static text; a ticking fragment (elapsed
  // time) sits beside it, hidden from assistive tech.
  return html`<div class="flex flex-wrap items-baseline gap-x-1">
    <p class=${`text-xs ${toneClass}`} role="status" aria-live="polite">
      ${line.liveText ?? line.text}
    </p>
    ${line.tick
      ? html`<span class=${`text-xs ${toneClass}`} aria-hidden="true">${line.tick}</span>`
      : null}
  </div>`;
};

const ReportAction = ({
  action = "none",
  onRepair = () => {},
  repairing = false,
  onRestartGateway = null,
  restartingGateway = false,
  onResumeChannels = () => {},
  resumingChannels = false,
}) => {
  if (action === "repair") {
    return html`<${ActionButton}
      onClick=${onRepair}
      tone="warning"
      idleLabel="Run repair"
      loadingLabel="Repairing..."
      loading=${repairing}
    />`;
  }
  if (action === "restart" && onRestartGateway) {
    return html`<${ActionButton}
      onClick=${onRestartGateway}
      tone="warning"
      idleLabel="Restart gateway"
      loadingLabel="Restarting..."
      loading=${restartingGateway}
    />`;
  }
  if (action === "resume_channels") {
    return html`<${ActionButton}
      onClick=${onResumeChannels}
      tone="warning"
      idleLabel="Resume channels"
      loadingLabel="Resuming..."
      loading=${resumingChannels}
    />`;
  }
  if (action === "fix_config") {
    return html`<span class="text-xs text-fg-muted">
      Fix openclaw.json (Console → Terminal below), then run a repair.
    </span>`;
  }
  return null;
};

export const WatchdogOverseerCard = ({
  incidents = [],
  watchdogStatus = null,
  enabled = false,
  availability = null,
  settingsLoaded = false,
  saving = false,
  onToggle = () => {},
  // useSavedSetting slice from the tab hook (F158); the legacy props above
  // stand in when a caller renders the card without one.
  setting = null,
  situation = null,
  situationError = null,
  ephemeral = null,
  reviewStatus = null,
  reviewInFlight = null,
  onReviewSituation = () => {},
  primaryKind = "auto",
  onSelectPrimaryKind = () => {},
  onRepair = () => {},
  repairing = false,
  onRestartGateway = null,
  restartingGateway = false,
  onResumeChannels = () => {},
  resumingChannels = false,
}) => {
  // 1s ticks only while something on screen counts (pending elapsed time or
  // the rate-limit countdown); relative "Nm ago" labels are fine at 30s.
  const needsFastTick =
    asRecord(situation?.current)?.state === "pending" ||
    (toMs(situation?.nextManualAt) ?? 0) > Date.now();
  const nowMs = useNowMs(needsFastTick ? 1000 : 30_000);
  const model = buildWatchdogOverseerModel({
    incidents,
    situation,
    situationError,
    ephemeral,
    watchdogStatus,
    primaryKind,
    reviewStatus,
    nowMs,
  });

  // Loading shell so the card stack doesn't shift when the fetches settle —
  // the settings load AND the first situation poll both gate it (DD8).
  if (!settingsLoaded || model.loading) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <h2 class="card-label">Incident overseer</h2>
        <p class="text-xs text-fg-muted mt-2">Loading overseer status...</p>
      </div>
    `;
  }

  const availabilityOk = availability?.available === true;
  const buttonLoading = reviewInFlight === "situation" || model.serverPending;
  const rateLimited = model.rateLimitRemainingMs > 0;
  const scopeVisible = enabled && availabilityOk && !buttonLoading && !model.serverBusy;
  const availabilityLine = availabilityOk ? null : describeAvailability(availability);
  const primary = model.primary;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Incident overseer</h2>
        <div class="flex items-center gap-3">
          ${enabled
            ? html`<${ActionButton}
                onClick=${onReviewSituation}
                tone="secondary"
                size="sm"
                idleLabel="Review current situation"
                loadingLabel="Reviewing..."
                loading=${buttonLoading}
                disabled=${!availabilityOk || rateLimited || model.serverBusy}
                title=${!availabilityOk
                  ? kOverseerSharedCopy.waitingForClaude
                  : model.serverBusy
                    ? kOverseerSharedCopy.reviewRunning
                    : rateLimited
                      ? model.availableInLine
                      : ""}
              />`
            : null}
          <${SavedToggle}
            value=${enabled}
            hydrated=${setting ? setting.hydrated : settingsLoaded}
            saving=${setting ? setting.saving : saving}
            savingContext=${setting?.savingContext ?? null}
            saveError=${setting?.saveError ?? null}
            loadError=${setting?.loadError ?? null}
            onRetryLoad=${setting?.retryLoad ?? null}
            onChange=${onToggle}
            describe=${describeOverseerToggleError}
          />
        </div>
      </div>

      ${scopeVisible
        ? html`<p class="text-xs text-fg-muted">
            ${rateLimited ? model.availableInLine : model.scopeLine}
          </p>`
        : null}

      <div class="space-y-1">
        <p class="text-xs text-fg-muted">${kOverseerCardCopy.description}</p>
        <p class="text-xs text-fg-muted">${kOverseerCardCopy.disclosure}</p>
      </div>

      ${availabilityLine
        ? html`<p
            class=${`text-xs ${availabilityLine.warning ? "text-status-warning-muted" : "text-fg-muted"}`}
          >
            ${availabilityLine.text}
          </p>`
        : null}

      <${StatusSlot} line=${model.statusLine} />

      ${primary
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                ${primary.state === "verdict"
                  ? html`<${Badge} tone=${primary.badge.tone}>${primary.badge.label}</${Badge}>`
                  : null}
                <span class="text-xs text-fg-muted min-w-0 break-words">
                  ${primary.kindLabel}
                </span>
              </div>
              ${primary.state === "verdict"
                ? html`
                    ${primary.deltaLine
                      ? html`<p class="text-xs text-status-warning-muted break-words">
                          ${primary.deltaLine}
                        </p>`
                      : null}
                    ${primary.headline
                      ? html`<p class="text-sm text-body break-words">${primary.headline}</p>`
                      : null}
                    ${primary.summary
                      ? html`<p class="text-xs text-fg-muted break-words">${primary.summary}</p>`
                      : null}
                    ${primary.recommendation
                      ? html`<p class="text-xs text-body break-words">
                          <span aria-hidden="true">→ </span>${primary.recommendation}
                        </p>`
                      : null}
                    ${primary.evidenceLine
                      ? html`<p class="text-xs text-fg-muted break-words">
                          ${primary.evidenceLine}
                        </p>`
                      : null}
                    ${primary.action !== "none"
                      ? html`<div class="flex flex-wrap items-center gap-2 pt-1">
                          <${ReportAction}
                            action=${primary.action}
                            onRepair=${onRepair}
                            repairing=${repairing}
                            onRestartGateway=${onRestartGateway}
                            restartingGateway=${restartingGateway}
                            onResumeChannels=${onResumeChannels}
                            resumingChannels=${resumingChannels}
                          />
                        </div>`
                      : null}
                  `
                : html`<p class="text-sm text-fg-muted">${primary.line}</p>`}
              ${model.secondaryLine
                ? html`<button
                    type="button"
                    class="ac-tip-link text-xs text-left py-2 -my-2"
                    onclick=${() => onSelectPrimaryKind(model.secondaryKind)}
                  >
                    ${model.secondaryLine}
                  </button>`
                : null}
            </div>
          `
        : enabled
          ? html`<div class="space-y-1">
              <p class="text-xs text-body">${kOverseerCardCopy.emptyTitle}</p>
              <p class="text-xs text-fg-muted">${kOverseerCardCopy.emptyBody}</p>
            </div>`
          : null}
    </div>
  `;
};
