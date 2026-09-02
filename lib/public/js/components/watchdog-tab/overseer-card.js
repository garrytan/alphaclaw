import { h } from "preact";
import htm from "htm";
import { useNowMs } from "../../hooks/use-now-ms.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { ToggleSwitch } from "../toggle-switch.js";
import {
  formatDurationCompactMs,
  formatInteger,
  formatLocaleTime,
  formatRelativeTime,
} from "../../lib/format.js";
import { kOverseerSharedCopy } from "./helpers.js";

const html = htm.bind(h);

// Watchdog incident overseer card. Advisory-only: verdicts never trigger
// anything; the CTA buttons are the SAME existing handlers the rest of the
// tab uses, and rollback is only ever a link to the Upgrade tab.
//
// Two report kinds share the card: the manual SITUATION report (what the
// overseer thinks is happening right now — polled from
// /api/watchdog/overseer/situation every 15s) and the newest POST-INCIDENT
// review riding the incidents poll. The newest one is primary; the other
// stays one click away via the secondary line. All review state (settings,
// poll, in-flight, ephemeral result) is lifted into use-watchdog-tab.js
// because the incidents card's row action shares it.

// Exported: the incident cards' verdict chips reuse this map (same bundle).
export const kOverseerVerdictBadge = {
  resolved: { tone: "success", label: "Resolved" },
  monitoring: { tone: "warning", label: "Monitoring" },
  action_needed: { tone: "danger", label: "Action needed" },
  unparseable: { tone: "neutral", label: "Unparseable" },
  all_clear: { tone: "success", label: "All clear" },
  watch: { tone: "warning", label: "Watch" },
};

export const kOverseerCardCopy = {
  description:
    "Ask a local Claude Code review what it thinks is happening — in any watchdog state. Advisory only; the deterministic watchdog stays in charge of recovery.",
  disclosure:
    "When enabled, redacted recent gateway logs, incident records, and doctor output are sent to the Anthropic API.",
  emptyTitle: "No situation report yet.",
  emptyBody:
    "Review the current watchdog state and recent logs with the button above; settled incidents are also reviewed automatically once the gateway is healthy.",
  freshRead: "Run Review current situation for a fresh read.",
  unreadable:
    "The last situation report couldn't be read — run Review current situation to replace it.",
  unavailable: "Situation reports unavailable — incident database not reachable.",
  pendingPrefix: "Situation report running — reading status, recent logs and doctor output",
  pendingSuffix: "(usually under 2 min)",
  persistFailed: kOverseerSharedCopy.persistFailed,
};

// Mirrors the server's situation log window; the client only uses it to
// label a log tail that starts late inside the requested window.
const kSituationLogWindowMs = 30 * 60 * 1000;
const kLateStartSlackMs = 60 * 1000;

const kGatewayHealthScope = {
  healthy: "gateway healthy",
  degraded: "gateway degraded",
  unhealthy: "gateway unhealthy",
};

const asRecord = (value) =>
  value && typeof value === "object" ? value : null;

const toMs = (value) => {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const findOpenIncident = (list) =>
  list.find((incident) => incident?.status === "open") || null;

const buildIncidentReport = (list, nowMs) => {
  const anyOpen = list.some((incident) => incident?.status === "open");
  const reviewed = list.find((incident) => asRecord(incident?.overseer));
  if (!reviewed) return null;
  const current = asRecord(reviewed.overseer.current);
  if (!current) return null;
  const state = current.state || "pending";
  const at = toMs(current.at);
  const reviewedAgo = at != null ? formatRelativeTime(at, { nowMs }) : null;
  const base = {
    kind: "incident",
    incidentId: reviewed.id,
    at: at ?? 0,
    reviewedAgo,
    kindLabel: ["Post-incident review", `incident #${reviewed.id}`, reviewedAgo]
      .filter(Boolean)
      .join(" · "),
    evidenceLine: null,
  };
  if (state === "pending") {
    return {
      ...base,
      state: "pending",
      shortLabel: "In progress",
      line: "Overseer review in progress…",
    };
  }
  if (state === "unavailable") {
    return {
      ...base,
      state,
      shortLabel: "Unavailable",
      line: current.summary || "Overseer was unavailable for this incident.",
    };
  }
  if (state === "failed") {
    return {
      ...base,
      state,
      shortLabel: "Failed",
      line: current.summary || "The overseer review failed.",
    };
  }
  const verdict = current.verdict || "unparseable";
  const badge = kOverseerVerdictBadge[verdict] || kOverseerVerdictBadge.unparseable;
  const stale = state === "stale";
  const isNewest = list.length > 0 && list[0].id === reviewed.id;
  return {
    ...base,
    state: "verdict",
    stale,
    changedSince: stale,
    // One verdict badge (neutral when stale) + a delta line — never two badges.
    badge: stale ? { ...badge, tone: "neutral" } : badge,
    shortLabel: badge.label,
    deltaLine: stale ? `Incident #${reviewed.id} changed after this review.` : null,
    verdict,
    headline: current.headline || "",
    summary: current.summary || "",
    recommendation: current.recommendation || "",
    action:
      !stale && isNewest && !anyOpen && verdict !== "unparseable"
        ? current.action || "none"
        : "none",
  };
};

// The ephemeral POST result wins over polled data until a polled `done`
// record is newer (E6/DD10). A polled `current` with the same-or-older `at`
// describes the very run whose result we already hold — it is not a status.
const resolveSituationRecords = ({ situation, ephemeral }) => {
  const polledCurrent = asRecord(situation?.current);
  const polledLast = asRecord(situation?.lastVerdict);
  const eph = asRecord(ephemeral);
  const ephAt = eph ? (toMs(eph.at) ?? 0) : null;
  const newerDone = (record) =>
    !!record && record.state === "done" && (toMs(record.at) ?? 0) > ephAt;
  const ephemeralWins =
    !!eph && !newerDone(polledCurrent) && !newerDone(polledLast);
  const verdictRecord = ephemeralWins ? eph : polledLast;
  const serverCurrent =
    polledCurrent && !(ephemeralWins && (toMs(polledCurrent.at) ?? 0) <= ephAt)
      ? polledCurrent
      : null;
  return { verdictRecord, serverCurrent, ephemeralWins };
};

// First applicable change since the evidence was collected, in the order the
// operator cares: gateway state, then incidents opened, then resolved, then
// the open-incident identity as a backstop (E2 fingerprint, client side).
const describeChangeSince = ({ record, incidents, watchdogStatus }) => {
  const evidence = asRecord(record?.evidence);
  if (!evidence) return null;
  const evidenceStatus = asRecord(evidence.status);
  const live = asRecord(watchdogStatus);
  if (evidenceStatus && live) {
    // `phase` is deliberately not compared: it flips on routine transitions
    // and would neutralize an all_clear report (and hide its CTA) for nothing.
    const nouns = {
      health: "Gateway",
      lifecycle: "Gateway lifecycle",
    };
    for (const field of ["health", "lifecycle"]) {
      const before = evidenceStatus[field];
      const after = live[field];
      if (before != null && after != null && before !== after) {
        return `${nouns[field]} went ${before} → ${after} after this report.`;
      }
    }
  }
  const collectedFrom = toMs(evidence.collectedFrom);
  if (collectedFrom != null) {
    const opened = incidents.find(
      (incident) => (toMs(incident?.openedAt) ?? -Infinity) > collectedFrom,
    );
    if (opened) return `Incident #${opened.id} opened after this report.`;
    const resolved = incidents.find(
      (incident) => (toMs(incident?.resolvedAt) ?? -Infinity) > collectedFrom,
    );
    if (resolved) return `Incident #${resolved.id} resolved after this report.`;
  }
  const liveOpen = findOpenIncident(incidents);
  const liveOpenId = liveOpen ? liveOpen.id : null;
  const evidenceOpenId = evidence.openIncidentId ?? null;
  if (liveOpenId !== evidenceOpenId) {
    return liveOpenId != null
      ? `Incident #${liveOpenId} opened after this report.`
      : `Incident #${evidenceOpenId} resolved after this report.`;
  }
  return null;
};

const buildEvidenceLine = (record) => {
  const evidence = asRecord(record?.evidence);
  if (!evidence) return null;
  const parts = [];
  const logLines = Number(evidence.logLines) || 0;
  const logFrom = toMs(evidence.logFrom);
  const logThrough = toMs(evidence.logThrough);
  const windowMs = Number(evidence.windowMs) || kSituationLogWindowMs;
  const windowLabel = `${Math.round(windowMs / 60_000)}-min`;
  if (logLines <= 0 || logFrom == null || logThrough == null) {
    parts.push(`logs: none in the last ${Math.round(windowMs / 60_000)} min`);
  } else {
    const range = `${formatLocaleTime(logFrom)}–${formatLocaleTime(logThrough)}`;
    const qualifiers = [`${formatInteger(logLines)} lines`];
    if (evidence.logPartial) {
      qualifiers.push(`${windowLabel} window not honored`);
    } else if (evidence.logFrontTruncated) {
      qualifiers.push("window cut short");
    } else {
      const collectedFrom = toMs(evidence.collectedFrom);
      const lateStart =
        collectedFrom != null && logFrom > collectedFrom - windowMs + kLateStartSlackMs;
      if (lateStart) qualifiers.push(`log begins ${formatLocaleTime(logFrom)}`);
    }
    if (evidence.logCapped) qualifiers.push("newest 64k chars");
    parts.push(
      `${evidence.logPartial ? "logs: full tail" : "logs"} ${range} (${qualifiers.join(" · ")})`,
    );
  }
  parts.push(
    evidence.doctor === "ok"
      ? "doctor: ok"
      : evidence.doctor === "empty"
        ? "doctor: no output"
        : "doctor: unavailable",
  );
  const status = asRecord(evidence.status);
  parts.push(status ? `status: ${status.health || "unknown"}` : "status: unavailable");
  parts.push(
    evidence.openIncidentId != null
      ? `incident #${evidence.openIncidentId} ongoing`
      : "no open incident",
  );
  return `Evidence: ${parts.join(" · ")}`;
};

const buildSituationReport = ({ record, incidents, watchdogStatus, nowMs }) => {
  if (!record) return null;
  const at = toMs(record.at) ?? 0;
  const reviewedAgo = at ? formatRelativeTime(at, { nowMs }) : null;
  const verdict = record.verdict || "unparseable";
  const badge = kOverseerVerdictBadge[verdict] || kOverseerVerdictBadge.unparseable;
  const change = describeChangeSince({ record, incidents, watchdogStatus });
  const changedSince = !!change;
  return {
    kind: "situation",
    state: "verdict",
    at,
    reviewedAgo,
    kindLabel: ["Situation report", reviewedAgo].filter(Boolean).join(" · "),
    stale: false,
    changedSince,
    badge: changedSince ? { ...badge, tone: "neutral" } : badge,
    shortLabel: badge.label,
    deltaLine: changedSince ? `${change} ${kOverseerCardCopy.freshRead}` : null,
    verdict,
    headline: record.headline || "",
    summary: record.summary || "",
    recommendation: record.recommendation || "",
    // No model-driven CTA while the deterministic ladder is mid-operation: the
    // verdict came from UNTRUSTED log text, and the watchdog is already acting.
    action:
      !changedSince && verdict === "action_needed" && !watchdogStatus?.operationInProgress
        ? record.action || "none"
        : "none",
    evidenceLine: buildEvidenceLine(record),
  };
};

// `inFlight` is null when idle, `{ kind, incidentId, startedAt }` otherwise
// (an older server sent a bare boolean — treat `true` as a running situation
// report). Exported for tests.
export const serverInFlightOf = (situation) => {
  const raw = situation?.inFlight;
  if (raw === true) return { kind: "situation", incidentId: null, startedAt: null };
  return asRecord(raw);
};

const describeServerInFlight = (situation) => {
  const running = serverInFlightOf(situation);
  if (!running || running.kind === "situation") return null;
  const target = running.incidentId != null ? ` of incident #${running.incidentId}` : "";
  return running.kind === "automatic"
    ? `Automatic review${target} in progress — the button frees up when it finishes.`
    : `Review${target} in progress — the button frees up when it finishes.`;
};

// One status slot (DD7): client-transient (refusal / persist warning /
// connection lost) > server `current` (pending / failed / unavailable) >
// GET-level trouble. A client-transient entry expires once the polled
// `current.at` advances past the record it was about.
const buildStatusLine = ({
  reviewStatus,
  serverCurrent,
  situation,
  situationError,
  nowMs,
}) => {
  const currentAt = toMs(asRecord(situation?.current)?.at) ?? 0;
  if (reviewStatus?.text && !(currentAt > (Number(reviewStatus.sinceAt) || 0))) {
    return {
      tone: reviewStatus.tone || "warning",
      text: reviewStatus.text,
      error: reviewStatus.error || null,
      source: "client",
    };
  }
  if (serverCurrent) {
    if (serverCurrent.state === "pending") {
      const startedAt = toMs(serverCurrent.at);
      const elapsed =
        startedAt != null
          ? formatDurationCompactMs(Math.max(1000, nowMs - startedAt))
          : null;
      // `liveText` is what the live region announces (static); the ticking
      // elapsed counter is rendered separately and hidden from assistive tech —
      // a once-per-second announcer is hostile to screen readers (see the
      // narrative card's identical rule).
      const liveText = `${kOverseerCardCopy.pendingPrefix} ${kOverseerCardCopy.pendingSuffix}`;
      const tick = elapsed ? `· started ${elapsed} ago` : null;
      return {
        tone: "muted",
        text: `${kOverseerCardCopy.pendingPrefix}${tick ? ` ${tick}` : ""} ${kOverseerCardCopy.pendingSuffix}`,
        liveText,
        tick,
        error: null,
        source: "server",
      };
    }
    if (serverCurrent.state === "failed") {
      // A report that ran but could not be saved is a durability warning, not
      // a failed review — the verdict it describes is still shown (lastVerdict
      // or the ephemeral record in the tab that ran it).
      if (serverCurrent.reason === "persist_failed") {
        return {
          tone: "warning",
          text: kOverseerCardCopy.persistFailed,
          error: null,
          source: "server",
        };
      }
      return {
        tone: "error",
        text: serverCurrent.summary || "The situation report failed.",
        error: null,
        source: "server",
      };
    }
    if (serverCurrent.state === "unavailable") {
      return {
        tone: "warning",
        text: serverCurrent.summary || "The overseer was unavailable for this report.",
        error: null,
        source: "server",
      };
    }
  }
  // The server mutex is held by a review that is not ours (an automatic
  // post-incident review, or an incident re-review from another tab): say so
  // instead of showing a disabled button with no explanation.
  const busy = describeServerInFlight(situation);
  if (busy) return { tone: "muted", text: busy, error: null, source: "server" };
  if (situation?.unreadable) {
    return { tone: "warning", text: kOverseerCardCopy.unreadable, error: null, source: "get" };
  }
  if (situationError && situation == null) {
    return { tone: "warning", text: kOverseerCardCopy.unavailable, error: null, source: "get" };
  }
  return null;
};

const pickPrimary = ({ incidentReport, situationReport, primaryKind }) => {
  if (primaryKind === "situation" && situationReport) return situationReport;
  if (primaryKind === "incident" && incidentReport) return incidentReport;
  if (!incidentReport) return situationReport;
  if (!situationReport) return incidentReport;
  return situationReport.at >= incidentReport.at ? situationReport : incidentReport;
};

const buildSecondaryLine = (other) => {
  if (!other) return null;
  const when = other.reviewedAgo ? ` · ${other.reviewedAgo}` : "";
  return other.kind === "incident"
    ? `Also: post-incident review for incident #${other.incidentId} — ${other.shortLabel}${when}`
    : `Also: situation report — ${other.shortLabel}${when}`;
};

export const buildWatchdogScopeLine = ({ watchdogStatus = null, incidents = [] } = {}) => {
  const list = Array.isArray(incidents) ? incidents : [];
  const open = findOpenIncident(list);
  const health = kGatewayHealthScope[watchdogStatus?.health] || "gateway status unknown";
  return `Scope: ${health} · ${open ? `incident #${open.id} ongoing` : "no open incident"}`;
};

// Pure view-model, exported for tests. `situation` is the polled GET payload
// ({ current, lastVerdict, nextManualAt, inFlight, unreadable? }), `ephemeral`
// the last POST record, `reviewStatus` the hook's client-transient slot
// ({ tone, text, error?, sinceAt }).
export const buildWatchdogOverseerModel = ({
  incidents = [],
  situation = null,
  situationError = null,
  ephemeral = null,
  watchdogStatus = null,
  primaryKind = "auto",
  reviewStatus = null,
  nowMs = Date.now(),
} = {}) => {
  const list = Array.isArray(incidents) ? incidents : [];
  const scopeLine = buildWatchdogScopeLine({ watchdogStatus, incidents: list });
  // usePolling seeds `data` from the cache (null on a miss), so "first poll
  // not back yet" is exactly data == null && error == null (DD8).
  if (situation == null && situationError == null) {
    return {
      loading: true,
      incidentReport: null,
      situationReport: null,
      primary: null,
      secondaryLine: null,
      secondaryKind: null,
      statusLine: null,
      scopeLine,
      availableInLine: null,
      rateLimitRemainingMs: 0,
      serverPending: false,
      newestAt: 0,
    };
  }
  const { verdictRecord, serverCurrent } = resolveSituationRecords({
    situation,
    ephemeral,
  });
  const incidentReport = buildIncidentReport(list, nowMs);
  const situationReport = buildSituationReport({
    record: verdictRecord,
    incidents: list,
    watchdogStatus,
    nowMs,
  });
  const primary = pickPrimary({ incidentReport, situationReport, primaryKind });
  const other =
    primary && incidentReport && situationReport
      ? primary.kind === "situation"
        ? incidentReport
        : situationReport
      : null;
  const nextManualAt = toMs(situation?.nextManualAt) ?? 0;
  const rateLimitRemainingMs = Math.max(0, nextManualAt - nowMs);
  return {
    loading: false,
    incidentReport,
    situationReport,
    primary,
    secondaryLine: buildSecondaryLine(other),
    secondaryKind: other ? other.kind : null,
    statusLine: buildStatusLine({
      reviewStatus,
      serverCurrent,
      situation,
      situationError,
      nowMs,
    }),
    scopeLine,
    availableInLine:
      rateLimitRemainingMs > 0
        ? `Available in ${formatDurationCompactMs(rateLimitRemainingMs)}`
        : null,
    rateLimitRemainingMs,
    // "Reviewing…" only for a situation report (ours or another tab's); any
    // other holder of the server mutex disables the button with a reason.
    serverPending:
      serverCurrent?.state === "pending" || serverInFlightOf(situation)?.kind === "situation",
    serverBusy: (() => {
      const running = serverInFlightOf(situation);
      return !!running && running.kind !== "situation";
    })(),
    newestAt: Math.max(incidentReport?.at ?? 0, situationReport?.at ?? 0),
  };
};

const describeAvailability = (availability) => {
  if (!availability) {
    return {
      text: "Availability: unknown — overseer settings couldn't be loaded.",
      warning: false,
    };
  }
  // available === null means the server answered instantly with "probing"
  // instead of blocking the response on a cold `claude --version` spawn.
  if (availability.available === null) {
    return { text: "Availability: Checking claude availability...", warning: false };
  }
  return {
    text: `Availability: ${availability.message || "Unavailable"}`,
    warning: true,
  };
};

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
  if (action === "rollback") {
    // Release-channel actions stay on their own surface — link, never call.
    return html`<a class="ac-tip-link text-xs" href="#/upgrade">
      Review rollback on the Upgrade page →
    </a>`;
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
          <${ToggleSwitch}
            checked=${enabled}
            disabled=${saving}
            onChange=${onToggle}
            label=${enabled ? "Enabled" : "Disabled"}
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
