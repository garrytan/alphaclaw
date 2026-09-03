import { h } from "preact";
import htm from "htm";
import { useCallback } from "preact/hooks";
import { fetchOpenclawOverseer, updateOpenclawOverseer } from "../../lib/api.js";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { SavedToggle } from "../saved-toggle.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// Self-contained "Overseer report" card: it owns its own SETTINGS loop (via
// useSavedSetting — optimistic flip, generation-guarded hydration, loud inline
// revert) and receives the runs list from the page hook. The card renders
// immediately — the availability line appears when the settings GET resolves;
// the toggle is never held hostage by the probe.
//
// The overseer is recommend-only: verdicts are advisory, the deterministic
// watchdog remains the enforcement layer, and the action buttons here are the
// same handlers the status card uses.

const kVerdictBadge = {
  healthy: { tone: "success", label: "Healthy" },
  suspect: { tone: "warning", label: "Suspect" },
  broken: { tone: "danger", label: "Broken" },
  unparseable: { tone: "neutral", label: "Unparseable" },
};

// Pure view-model: exported for tests.
export const buildOverseerReportModel = (run = null) => {
  const overseer = run?.overseer || null;
  if (!run || !overseer) return null;
  const state = overseer.state || "pending";
  if (state === "pending") {
    return { kind: "pending", line: "Overseer review in progress…" };
  }
  if (state === "unavailable") {
    return {
      kind: "unavailable",
      line: overseer.summary || "Overseer was unavailable for this run.",
    };
  }
  if (state === "failed") {
    return {
      kind: "failed",
      line: overseer.summary || "The overseer review failed.",
    };
  }
  const badge = kVerdictBadge[overseer.verdict] || kVerdictBadge.unparseable;
  return {
    kind: "verdict",
    stale: state === "stale",
    badge,
    verdict: overseer.verdict || "unparseable",
    summary: overseer.summary || "",
    recommendation: overseer.recommendation || "",
    // Mark-good / Roll-back act on the LIVE build, so only offer them when the
    // reviewed run IS the applied build (server stamps appliesToCurrent). A
    // "broken" verdict about a failed build that never activated must not let
    // the operator roll back the healthy build that's actually running.
    showActions:
      state !== "stale" &&
      overseer.appliesToCurrent === true &&
      (overseer.verdict === "healthy" ||
        overseer.verdict === "suspect" ||
        overseer.verdict === "broken"),
  };
};

// Chip headline after a failed/unconfirmed save: exported for tests.
export const describeOverseerSaveError = (attempted) =>
  attempted
    ? "Couldn't confirm enabling the overseer — showing the server's current state."
    : "Couldn't confirm disabling the overseer — showing the server's current state.";

export const buildOverseerAvailabilityLine = (availability = null) => {
  if (!availability) return null;
  return availability.available
    ? `Available (${availability.message || "claude CLI + Anthropic credential found"})`
    : availability.message || "Unavailable";
};

export const UpgradeOverseerCard = ({
  actionsDisabled = false,
  markingGood = false,
  onMarkGood = () => {},
  rollingBack = false,
  onRequestRollback = () => {},
  // Runs are fetched by the page hook — this card only reads them.
  runs = [],
}) => {
  const setting = useSavedSetting({
    cacheKey: "/api/openclaw/overseer",
    load: fetchOpenclawOverseer,
    select: (data) => data?.enabled === true,
    selectSaved: (response) =>
      typeof response?.enabled === "boolean" ? response.enabled : undefined,
    save: (next) => updateOpenclawOverseer(next),
    label: "overseer",
  });

  const onToggle = useCallback(
    async (next) => {
      const outcome = await setting.commit(next === true);
      if (outcome.ok) {
        showToast(
          next
            ? "Overseer enabled — it reviews future update runs"
            : "Overseer disabled",
          "info",
        );
      }
    },
    [setting.commit],
  );

  const enabled = setting.value === true;
  const availability = setting.payload?.availability || null;
  const availabilityLine = buildOverseerAvailabilityLine(availability);
  const report = buildOverseerReportModel(
    (Array.isArray(runs) && runs[0]) || null,
  );

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Overseer report</h2>
        <${SavedToggle}
          value=${enabled}
          hydrated=${setting.hydrated}
          saving=${setting.saving}
          savingContext=${setting.savingContext}
          saveError=${setting.saveError}
          loadError=${setting.loadError}
          onRetryLoad=${setting.retryLoad}
          onChange=${onToggle}
          describe=${describeOverseerSaveError}
        />
      </div>

      <p class="text-xs text-fg-muted">
        After an update settles, a local Claude Code review of the run is
        recorded here — advisory only; auto-rollback stays in charge. When
        enabled, redacted upgrade logs and doctor output are sent to the
        Anthropic API.
      </p>

      ${availabilityLine
        ? html`<p
            class=${`text-xs ${availability?.available ? "text-fg-muted" : "text-status-warning-muted"}`}
          >
            Availability: ${availabilityLine}
          </p>`
        : null}

      ${report
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
              ${report.kind === "verdict"
                ? html`
                    <div class="flex flex-wrap items-center gap-2">
                      <${Badge} tone=${report.badge.tone}>${report.badge.label}</${Badge}>
                      ${report.stale
                        ? html`<${Badge} tone="neutral">Stale — build changed since</${Badge}>`
                        : null}
                    </div>
                    ${report.summary
                      ? html`<p class="text-sm text-body">${report.summary}</p>`
                      : null}
                    ${report.recommendation
                      ? html`<p class="text-xs text-fg-muted">
                          ${report.recommendation}
                        </p>`
                      : null}
                    ${report.showActions
                      ? html`
                          <div class="flex flex-wrap items-center gap-2 pt-1">
                            <${ActionButton}
                              onClick=${onMarkGood}
                              tone="success"
                              idleLabel="Mark as good now"
                              loadingLabel="Marking..."
                              loading=${markingGood}
                              disabled=${actionsDisabled && !markingGood}
                            />
                            <${ActionButton}
                              onClick=${onRequestRollback}
                              tone="warning"
                              idleLabel="Roll back now"
                              loadingLabel="Rolling back..."
                              loading=${rollingBack}
                              disabled=${actionsDisabled && !rollingBack}
                            />
                          </div>
                        `
                      : null}
                  `
                : html`<p class="text-sm text-fg-muted">${report.line}</p>`}
            </div>
          `
        : enabled
          ? html`<p class="text-xs text-fg-muted">
              No overseer report yet — the next update run will be reviewed
              once its acceptance window resolves.
            </p>`
          : null}
    </div>
  `;
};
