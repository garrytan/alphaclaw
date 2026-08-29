import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  fetchWatchdogOverseer,
  requestWatchdogOverseerReview,
  updateWatchdogOverseer,
} from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { showToast } from "../toast.js";
import { formatRelativeTime } from "../../lib/format.js";

const html = htm.bind(h);

// Watchdog incident overseer card. Advisory-only: verdicts never trigger
// anything; the CTA buttons are the SAME existing handlers the rest of the
// tab uses, and rollback is only ever a link to the Upgrade tab.
//
// Freshness rides the 15s incidents poll (the `incidents` prop) — no
// load-once staleness, no new SSE stream.

const kVerdictBadge = {
  resolved: { tone: "success", label: "Resolved" },
  monitoring: { tone: "warning", label: "Monitoring" },
  action_needed: { tone: "danger", label: "Action needed" },
  unparseable: { tone: "neutral", label: "Unparseable" },
};

// Pure view-model, exported for tests. `incidents` is the merged newest-first
// list; the report shown is the newest incident carrying an overseer record.
// CTAs only render when the verdict describes the CURRENT world: that
// incident is still the newest, nothing is open, and the review isn't stale.
export const buildWatchdogOverseerModel = (incidents = [], nowMs = Date.now()) => {
  const list = Array.isArray(incidents) ? incidents : [];
  const anyOpen = list.some((incident) => incident?.status === "open");
  const reviewed = list.find(
    (incident) => incident?.overseer && typeof incident.overseer === "object",
  );
  if (!reviewed) return null;
  const record = reviewed.overseer;
  const current =
    record.current && typeof record.current === "object" ? record.current : null;
  if (!current) return null;
  const state = current.state || "pending";
  const base = {
    incidentId: reviewed.id,
    reviewedAgo: current.at ? formatRelativeTime(current.at, { nowMs }) : null,
  };
  if (state === "pending") {
    return { ...base, kind: "pending", line: "Overseer review in progress…" };
  }
  if (state === "unavailable") {
    return {
      ...base,
      kind: "unavailable",
      line: current.summary || "Overseer was unavailable for this incident.",
    };
  }
  if (state === "failed") {
    return {
      ...base,
      kind: "failed",
      line: current.summary || "The overseer review failed.",
    };
  }
  const badge = kVerdictBadge[current.verdict] || kVerdictBadge.unparseable;
  const isNewest = list.length > 0 && list[0].id === reviewed.id;
  return {
    ...base,
    kind: "verdict",
    stale: state === "stale",
    badge,
    verdict: current.verdict || "unparseable",
    headline: current.headline || "",
    summary: current.summary || "",
    recommendation: current.recommendation || "",
    action:
      state !== "stale" && isNewest && !anyOpen && current.verdict !== "unparseable"
        ? current.action || "none"
        : "none",
  };
};

export const WatchdogOverseerCard = ({
  incidents = [],
  onRepair = () => {},
  repairing = false,
  onRestartGateway = null,
  restartingGateway = false,
  onResumeChannels = () => {},
  resumingChannels = false,
  onRefreshIncidents = () => {},
}) => {
  const [enabled, setEnabled] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const load = useCallback(async () => {
    try {
      const settings = await fetchWatchdogOverseer();
      setEnabled(settings?.enabled === true);
      setAvailability(settings?.availability || null);
    } catch {
      // The card still renders (toggle + disclosure) without availability.
    }
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
        await updateWatchdogOverseer(next);
        setEnabled(next === true);
        showToast(
          next
            ? "Watchdog overseer enabled — it reviews settled incidents"
            : "Watchdog overseer disabled",
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

  const onReviewNow = useCallback(async () => {
    if (reviewing) return;
    setReviewing(true);
    try {
      const data = await requestWatchdogOverseerReview();
      if (!data?.ok) throw new Error(data?.error || "Review did not start");
      showToast("Overseer review finished", "success");
      onRefreshIncidents();
    } catch (err) {
      showToast(err?.message || "Could not start an overseer review", "error");
    } finally {
      setReviewing(false);
    }
  }, [reviewing, onRefreshIncidents]);

  // Loading shell so the card stack doesn't shift when the fetch settles.
  if (!loaded) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <h2 class="card-label">Incident overseer</h2>
        <p class="text-xs text-fg-muted mt-2">Loading overseer status...</p>
      </div>
    `;
  }

  const report = buildWatchdogOverseerModel(incidents);
  const availabilityLine = availability
    ? availability.available
      ? `Available (${availability.message || "claude CLI + Anthropic credential found"})`
      : availability.message || "Unavailable"
    : null;

  const actionButton = (() => {
    if (report?.kind !== "verdict") return null;
    if (report.action === "repair") {
      return html`<${ActionButton}
        onClick=${onRepair}
        tone="warning"
        idleLabel="Run repair"
        loadingLabel="Repairing..."
        loading=${repairing}
      />`;
    }
    if (report.action === "restart" && onRestartGateway) {
      return html`<${ActionButton}
        onClick=${onRestartGateway}
        tone="warning"
        idleLabel="Restart gateway"
        loadingLabel="Restarting..."
        loading=${restartingGateway}
      />`;
    }
    if (report.action === "resume_channels") {
      return html`<${ActionButton}
        onClick=${onResumeChannels}
        tone="warning"
        idleLabel="Resume channels"
        loadingLabel="Resuming..."
        loading=${resumingChannels}
      />`;
    }
    if (report.action === "rollback") {
      // Release-channel actions stay on their own surface — link, never call.
      return html`<a class="ac-tip-link text-xs" href="#/upgrade">
        Review rollback on the Upgrade page →
      </a>`;
    }
    if (report.action === "fix_config") {
      return html`<span class="text-xs text-fg-muted">
        Fix openclaw.json (Console → Terminal below), then run a repair.
      </span>`;
    }
    return null;
  })();

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Incident overseer</h2>
        <div class="flex items-center gap-3">
          ${enabled
            ? html`<${ActionButton}
                onClick=${onReviewNow}
                tone="secondary"
                size="sm"
                idleLabel="Review now"
                loadingLabel="Reviewing..."
                loading=${reviewing}
                disabled=${availability ? !availability.available : false}
              />`
            : null}
          <${ToggleSwitch}
            checked=${enabled}
            disabled=${saving}
            onChange=${onToggle}
            label=${enabled ? "Enabled" : "Disabled"}
          />
        </div>
      </div>

      <p class="text-xs text-fg-muted">
        After an incident settles, a local Claude Code review is recorded on it
        — advisory only; the deterministic watchdog stays in charge of
        recovery. When enabled, redacted gateway logs, incident records, and
        doctor output are sent to the Anthropic API.
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
                        ? html`<${Badge} tone="neutral">Stale — incident changed since</${Badge}>`
                        : null}
                      <span class="text-xs text-fg-muted">
                        incident #${report.incidentId}
                        ${report.reviewedAgo ? ` · reviewed ${report.reviewedAgo}` : ""}
                      </span>
                    </div>
                    ${report.headline
                      ? html`<p class="text-sm text-body">${report.headline}</p>`
                      : null}
                    ${report.summary
                      ? html`<p class="text-xs text-fg-muted">${report.summary}</p>`
                      : null}
                    ${report.recommendation
                      ? html`<p class="text-xs text-fg-muted">
                          ${report.recommendation}
                        </p>`
                      : null}
                    ${actionButton
                      ? html`<div class="flex flex-wrap items-center gap-2 pt-1">
                          ${actionButton}
                        </div>`
                      : null}
                  `
                : html`<p class="text-sm text-fg-muted">${report.line}</p>`}
            </div>
          `
        : enabled
          ? html`<p class="text-xs text-fg-muted">
              No overseer report yet — the next settled incident will be
              reviewed once the gateway is back to a healthy steady state.
            </p>`
          : null}
    </div>
  `;
};
