import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  fetchOpenclawOverseer,
  fetchOpenclawRuns,
  updateOpenclawOverseer,
} from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// Self-contained "Overseer report" card (kept out of use-upgrade-tab.js on
// purpose — the channel-switch flow is being refactored in parallel; this
// card loads its own data and only borrows the EXISTING mark-good / rollback
// handlers from the page).
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
    showActions:
      state !== "stale" &&
      (overseer.verdict === "healthy" ||
        overseer.verdict === "suspect" ||
        overseer.verdict === "broken"),
  };
};

export const UpgradeOverseerCard = ({
  actionsDisabled = false,
  markingGood = false,
  onMarkGood = () => {},
  rollingBack = false,
  onRequestRollback = () => {},
}) => {
  const [enabled, setEnabled] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [latestRun, setLatestRun] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const settings = await fetchOpenclawOverseer();
      setEnabled(settings?.enabled === true);
      setAvailability(settings?.availability || null);
    } catch {
      // The card still renders (toggle + disclosure) without availability.
    }
    try {
      const data = await fetchOpenclawRuns();
      const runs = Array.isArray(data?.runs) ? data.runs : [];
      setLatestRun(runs[0] || null);
    } catch {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = useCallback(
    async (next) => {
      if (saving) return;
      setSaving(true);
      try {
        await updateOpenclawOverseer(next);
        setEnabled(next === true);
        showToast(
          next
            ? "Overseer enabled — it reviews future update runs"
            : "Overseer disabled",
          "info",
        );
      } catch (err) {
        showToast(err?.message || "Could not save overseer settings", "error");
      } finally {
        setSaving(false);
      }
    },
    [saving],
  );

  if (!loaded) return null;

  const report = buildOverseerReportModel(latestRun);
  const availabilityLine = availability
    ? availability.available
      ? `Available (${availability.message || "claude CLI + Anthropic credential found"})`
      : availability.message || "Unavailable"
    : null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Overseer report</h2>
        <${ToggleSwitch}
          checked=${enabled}
          disabled=${saving}
          onChange=${onToggle}
          label=${enabled ? "Enabled" : "Disabled"}
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
