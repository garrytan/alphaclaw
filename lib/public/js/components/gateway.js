import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { GatewayRecoveryOptions } from "./gateway-recovery-options.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { InfoTooltip } from "./info-tooltip.js";
import { Badge } from "./badge.js";
import {
  RestartProgressCard,
  useGatewayShell,
} from "./restart-progress-card.js";
import { fetchWatchdogStatus } from "../lib/api.js";
import {
  formatDurationLongMs,
  formatLocaleDateTime,
  formatLocaleDateTimeWithTodayTime,
  formatRelativeTime,
} from "../lib/format.js";
import { useNowMs } from "../hooks/use-now-ms.js";

const html = htm.bind(h);

// Server-sent dot rendering: { color, motion } maps to classes only — the
// client never picks colors or motion on its own.
const kDotColorClass = {
  gray: "ac-gateway-dot--gray",
  green: "ac-gateway-dot--green",
  cyan: "ac-gateway-dot--cyan",
  yellow: "ac-gateway-dot--yellow",
  red: "ac-gateway-dot--red",
};

export const dotClassFor = (dot = {}) => {
  const color = kDotColorClass[dot?.color] || kDotColorClass.gray;
  const motion =
    dot?.motion === "pulse"
      ? " ac-gateway-dot--pulse"
      : dot?.motion === "hollow"
        ? " ac-gateway-dot--hollow"
        : "";
  return `ac-gateway-dot ${color}${motion}`;
};

// Error/warning states carry a glyph — never color alone.
const glyphFor = (dot = {}) =>
  dot?.color === "red" ? "✕" : dot?.color === "yellow" ? "!" : null;

const kActionToneByKind = {
  primary: "primary",
  secondary: "secondary",
  danger: "danger",
};

const kMaxReasonLabelsInBanner = 2;

export const buildReasonsSummary = (reasons = []) => {
  const labels = (Array.isArray(reasons) ? reasons : [])
    .map((reason) => reason?.label || reason?.code || "")
    .filter(Boolean);
  if (labels.length === 0) return null;
  const shown = labels.slice(0, kMaxReasonLabelsInBanner);
  const more = labels.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
};

// Supervision axis copy (server-derived, three-valued). "adopted" is a
// gateway AlphaClaw did not launch but did identify: health and memory are
// monitored through the discovered pid, exit events never arrive — the
// "estimated" crash-evidence detail carries that caveat, so the state phrase
// stays as short as its siblings.
const kSupervisionLabels = {
  managed: "managed by AlphaClaw",
  adopted: "adopted (started outside AlphaClaw)",
  detached: "detached (running outside AlphaClaw's supervision)",
};

// "pending (pid 4242, since 11:59 AM) — not yet confirmed …": a relaunched
// child the watchdog has not yet proven to be the process answering the
// port. One string, so the copy cannot be split across text nodes; the stamp
// is minutes old in practice, so today's entries show the time alone.
const formatReplacementPending = (pending) => {
  const since = formatLocaleDateTimeWithTodayTime(pending?.since, { fallback: null });
  const facts = [
    pending?.pid != null ? `pid ${pending.pid}` : null,
    since ? `since ${since}` : null,
  ].filter(Boolean);
  const scope = facts.length ? ` (${facts.join(", ")})` : "";
  return `pending${scope} — not yet confirmed as the process answering the port`;
};

const SupervisionDetails = ({
  serverState = null,
  watchdogStatus = null,
  restartReasons = [],
}) => {
  const [open, setOpen] = useState(false);
  // undefined = not fetched yet; last-notification-delivered only rides on
  // /api/watchdog/status, so it is fetched on demand when the disclosure
  // opens.
  const [notifDeliveredAt, setNotifDeliveredAt] = useState(undefined);

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && notifDeliveredAt === undefined) {
      fetchWatchdogStatus()
        .then((data) =>
          setNotifDeliveredAt(data?.status?.lastNotificationDeliveredAt ?? null),
        )
        .catch(() => setNotifDeliveredAt(null));
    }
  };

  const lastCheck = formatLocaleDateTime(watchdogStatus?.lastHealthCheckAt, {
    fallback: null,
  });
  // Serving pid first: an adopted gateway has no launch pid (`gatewayPid`
  // null) but a discovered serving identity, and that is the pid the memory
  // monitor samples.
  const pid = watchdogStatus?.servingPid ?? watchdogStatus?.gatewayPid ?? null;
  const reasons = Array.isArray(restartReasons) ? restartReasons : [];
  const replacementPending =
    serverState?.replacementPending ?? watchdogStatus?.replacementPending ?? null;
  const replacementLabel = replacementPending
    ? formatReplacementPending(replacementPending)
    : null;

  return html`
    <div>
      <button
        type="button"
        class="text-xs text-fg-muted hover:text-body ac-touch"
        onclick=${handleToggle}
        aria-expanded=${open ? "true" : "false"}
      >
        ${open ? "▾ Details" : "▸ Details"}
      </button>
      ${open
        ? html`
            <dl class="mt-2 space-y-1 text-xs text-fg-muted">
              ${serverState?.supervision
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Supervision:</dt>
                    <dd>
                      ${kSupervisionLabels[serverState.supervision] ||
                      String(serverState.supervision)}
                    </dd>
                  </div>`
                : null}
              ${replacementPending
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Replacement:</dt>
                    <dd>${replacementLabel}</dd>
                  </div>`
                : null}
              ${lastCheck
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Last health check:</dt>
                    <dd>${lastCheck}</dd>
                  </div>`
                : null}
              ${pid
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Gateway PID:</dt>
                    <dd>${pid}</dd>
                  </div>`
                : null}
              ${watchdogStatus
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Checks:</dt>
                    <dd>
                      ${watchdogStatus.crashCountInWindow || 0} crash${(watchdogStatus.crashCountInWindow || 0) === 1 ? "" : "es"}
                      in window · ${watchdogStatus.repairAttempts || 0} repair
                      attempt${(watchdogStatus.repairAttempts || 0) === 1 ? "" : "s"}
                    </dd>
                  </div>`
                : null}
              ${notifDeliveredAt !== undefined
                ? html`<div class="flex gap-2">
                    <dt class="shrink-0">Last notification delivered:</dt>
                    <dd>
                      ${formatLocaleDateTime(notifDeliveredAt, {
                        fallback: null,
                      }) || "never"}
                    </dd>
                  </div>`
                : null}
              ${reasons.length > 0
                ? html`<div>
                    <dt>Restart required for:</dt>
                    <dd>
                      <ul class="mt-1 list-disc pl-4 space-y-0.5">
                        ${reasons.map(
                          (reason) => html`<li key=${reason.code}>
                            ${reason.label || reason.code}
                          </li>`,
                        )}
                      </ul>
                    </dd>
                  </div>`
                : null}
            </dl>
          `
        : null}
    </div>
  `;
};

// The unified, server-driven card: label/dot/reason/actions render verbatim
// from status.state — the client derives nothing but elapsed times.
const GatewayStateCard = ({
  serverState,
  shell,
  legacyStatus = null,
  setupRequired = false,
  watchdogStatus = null,
  onRepair = null,
  repairing = false,
  onViewLogs = null,
  onOpenWatchdog = null,
  onResumeChannels = null,
  onRefreshStatuses = null,
}) => {
  const projection = serverState;
  serverState = serverState || {
    label: setupRequired ? "Setup required" : shell.hasStatus || legacyStatus ? `Last known gateway: ${legacyStatus || "status unavailable"}` : "Connecting to AlphaClaw…",
    reason: setupRequired ? "Complete setup below, then inspect current gateway status. No repair or restart is queued." : shell.hasStatus || legacyStatus ? "Refresh status to inspect current recovery options." : null,
    dot: { color: "gray", motion: "steady" },
    actions: [],
  };
  // Shared clock (fix wave F160): pauses while the tab is hidden like every
  // sibling watchdog card instead of a hand-rolled 1s ticker.
  const nowMs = useNowMs(1000);
  const [confirmAction, setConfirmAction] = useState(null);

  const actions = Array.isArray(serverState.actions) ? serverState.actions : [];
  const operation = shell.restartOperation;
  const shellActions = shell.actions || {};
  const frozen = shell.statusFreshness?.mode === "stale" ||
    (shell.connectivityMode && shell.connectivityMode !== "online");
  const observedAtMs = shell.statusFreshness?.observedAtMs || shell.lastFrameAtMs || 0;
  const observedNowMs = frozen && observedAtMs > 0 ? observedAtMs : nowMs;
  const sinceMs = Number(serverState.since) || 0;
  const sinceLabel =
    sinceMs > 0 ? formatDurationLongMs(Math.max(0, observedNowMs - sinceMs)) : null;
  // lastFrameAtMs starts at 0 (no frame yet) — 0 must stay "no stamp", not
  // an epoch-1970 relative time.
  const staleStamp =
    frozen && observedAtMs > 0
      ? formatRelativeTime(observedAtMs, { nowMs, fallback: null })
      : null;
  const reasonsSummary = shell.restartRequired
    ? buildReasonsSummary(shell.restartReasons)
    : null;
  const glyph = frozen ? null : glyphFor(serverState.dot);

  const runAction = (action) => {
    if (!action) return;
    switch (action.id) {
      case "restart":
      case "retry":
        shellActions.restart?.();
        return;
      case "repair":
        onRepair?.();
        return;
      case "view_logs":
      case "view_config_error":
        (onViewLogs || onOpenWatchdog)?.();
        return;
      case "resume_channels":
        (onResumeChannels || shellActions.resumeChannels)?.();
        return;
      case "refresh":
        (onRefreshStatuses || shellActions.refresh)?.();
        return;
      case "setup":
        // not_onboarded's only action: reopen the setup surface the app
        // already owns (the Welcome wizard, gated on the shell's onboarded
        // flag) instead of silently doing nothing.
        shellActions.openSetup?.();
        return;
      default:
        return;
    }
  };

  const handleActionClick = (action) => {
    if (action.needsConfirm) {
      setConfirmAction(action);
      return;
    }
    runAction(action);
  };

  const actionButtons = actions.filter((action) => !["repair", "restart", "retry"].includes(action.id)).map((action) => {
    const isRepairAction = action.id === "repair";
    return html`<${ActionButton}
      key=${action.id}
      onClick=${() => handleActionClick(action)}
      tone=${kActionToneByKind[action.kind] || "secondary"}
      size="sm"
      idleLabel=${action.label}
      loadingLabel=${action.label}
      loading=${isRepairAction && repairing}
      disabled=${!!action.disabledReason}
      title=${action.disabledReason || action.description || ""}
      className="ac-touch"
    />`;
  });

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="card-label">OpenClaw Gateway</h2>
        ${serverState.operation
          ? html`<${Badge} tone="cyan">${serverState.operation.label}<//>`
          : null}
      </div>

      ${html`
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class=${dotClassFor(frozen ? { color: "gray" } : serverState.dot)} aria-hidden="true"></span>
                ${glyph
                  ? html`<span
                      class=${`text-xs font-semibold ${serverState.dot?.color === "red" ? "text-status-error" : "text-status-warning"}`}
                      aria-hidden="true"
                      >${glyph}</span
                    >`
                  : null}
                <span aria-live="polite">
                  <span class="text-sm font-semibold">${frozen ? "Last known — " : ""}${serverState.label}</span>
                </span>
                ${serverState.glossary
                  ? html`<${InfoTooltip} text=${serverState.glossary} />`
                  : null}
                ${sinceLabel
                  ? html`<span class="text-xs text-fg-muted"
                      >for ${sinceLabel}</span
                    >`
                  : null}
              </div>

              ${serverState.reason
                ? html`<p class="text-sm text-body">${serverState.reason}</p>`
                : null}
              ${serverState.detail
                ? html`<p class="text-xs text-fg-muted">${serverState.detail}</p>`
                : null}
              ${shell.statusFreshness?.mode === "stale"
                ? html`<p class="text-xs text-status-warning">Status updates unavailable.</p>`
                : null}
              ${staleStamp
                ? html`<p class="text-xs text-fg-muted">as of ${staleStamp}</p>`
                : null}

              ${reasonsSummary
                ? html`
                    <div
                      class="ac-surface-inset border border-yellow-500/35 rounded-lg px-3 py-2 text-xs text-status-warning-muted"
                    >
                      Restart required — ${reasonsSummary}
                    </div>
                  `
                : null}

              <${GatewayRecoveryOptions}
                shell=${shell}
                serverState=${projection}
                setupRequired=${setupRequired}
                onRefresh=${onRefreshStatuses}
                progress=${operation ? html`<${RestartProgressCard}
                  operation=${operation}
                  nowMs=${nowMs}
                  onDismiss=${shellActions.dismissOutcome || null}
                  onLoadEvidence=${shellActions.loadEvidence || null}
                />` : null}
              />

              <div class="flex flex-wrap items-end justify-between gap-2">
                <${SupervisionDetails}
                  serverState=${serverState}
                  watchdogStatus=${watchdogStatus}
                  restartReasons=${shell.restartReasons}
                />
                <div class="flex flex-wrap items-center justify-end gap-2">
                  ${actionButtons}
                </div>
              </div>
            </div>
          `}

      <${ConfirmDialog}
        visible=${!!confirmAction}
        title=${confirmAction ? `${confirmAction.label}?` : ""}
        message=${confirmAction?.description || "Are you sure?"}
        confirmLabel=${confirmAction?.label || "Confirm"}
        confirmTone=${confirmAction?.kind === "danger" ? "warning" : "primary"}
        onConfirm=${() => {
          const action = confirmAction;
          setConfirmAction(null);
          runAction(action);
        }}
        onCancel=${() => setConfirmAction(null)}
      />
    </div>
  `;
};

export const Gateway = ({
  status = null,
  setupRequired = false,
  restarting = false,
  onRestart,
  watchdogStatus = null,
  onOpenWatchdog = null,
  onRepair = null,
  repairing = false,
  onViewLogs = null,
  onResumeChannels = null,
  onRefreshStatuses = null,
}) => {
  const shell = useGatewayShell();
  const serverState = setupRequired ? null : shell.statusState;

  return html`<${GatewayStateCard}
    serverState=${serverState}
    shell=${shell}
    legacyStatus=${status}
    setupRequired=${setupRequired}
    watchdogStatus=${watchdogStatus || shell.watchdogStatus}
    onRepair=${onRepair}
    repairing=${repairing}
    onViewLogs=${onViewLogs}
    onOpenWatchdog=${onOpenWatchdog}
    onResumeChannels=${onResumeChannels}
    onRefreshStatuses=${onRefreshStatuses}
  />`;
};
