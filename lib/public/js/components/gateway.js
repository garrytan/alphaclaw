import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { RepairButton } from "./repair-button.js";
import { InfoTooltip } from "./info-tooltip.js";
import { Badge } from "./badge.js";
import {
  RestartProgressCard,
  isUnfinishedUpgrade,
  isUpgradeOperation,
  useGatewayShell,
} from "./restart-progress-card.js";
import { expediteGatewayRestart, fetchWatchdogStatus } from "../lib/api.js";
import { requestUpgradeRetryConfirm } from "./upgrade-alert/retry-request.js";
import {
  formatDurationLongMs,
  formatLocaleDateTime,
  formatLocaleDateTimeWithTodayTime,
  formatRelativeTime,
} from "../lib/format.js";
import { useNowMs } from "../hooks/use-now-ms.js";
import { BootDetailsGroup, BootProgressCard } from "./boot-progress-card/index.js";

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

export const SupervisionDetails = ({
  serverState = null,
  watchdogStatus = null,
  restartReasons = [],
  bootProgress = null,
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
              ${bootProgress
                ? html`<${BootDetailsGroup}
                    bootProgress=${bootProgress}
                    formatDuration=${formatDurationLongMs}
                  />`
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

export const kStaleRestartGuardText = "Status isn't current. Refresh before restarting.";
const kRestartControlIds = new Set(["repair", "restart", "retry"]);

// A succeeded restart was verified by the server itself (the new gateway
// answered /readyz), but the status frame can still be one computed before
// that. Until a fresh frame lands, the finished operation wins, so the card
// never says "Starting" and "Running: restarted" at once. Only two frames are
// stale for certain: one still carrying the restart's own lock badge (the
// lock whose startedAt the controller recorded while the restart ran, so a
// newer restart's lock is never mistaken for it), and a
// lock-free "starting" whose new gateway already has a serving identity
// (servingPid), with no unverified replacement pending, that only waits on
// the watchdog's first health check. servingPid is a heuristic, not a port
// probe: a crash relaunch clears it, so that frame keeps "Starting". If the
// lock was never recorded (a very short restart on the polling fallback), the
// frame stays the server's and the old overlap can show. A frame naming another
// operation, an unfinished upgrade (it stays on the card until the operator
// acts) and every other state stay the server's. The card hides its restart
// controls while the success line shows, so their descriptors are left as is.
export const reconcileFinishedRestart = (serverState, operation) => {
  if (!serverState || operation?.phase !== "succeeded" || isUnfinishedUpgrade(operation)) return serverState;
  const lockKind = isUpgradeOperation(operation) ? "openclaw_upgrade" : "restart";
  const heldLock =
    serverState.operation?.kind === lockKind &&
    operation.lockStartedAt != null &&
    serverState.operation.startedAt === operation.lockStartedAt;
  const awaitingFirstHealthCheck =
    !serverState.operation &&
    serverState.state === "starting" &&
    serverState.servingPid != null &&
    serverState.replacementPending == null;
  if (!heldLock && !awaitingFirstHealthCheck) return serverState;
  if (serverState.state !== "starting") return { ...serverState, operation: null };
  return {
    ...serverState,
    operation: null,
    state: "running",
    label: "Running",
    dot: { color: "green", motion: "steady" },
    reason: "",
    glossary: null,
    since: null,
    actions: (Array.isArray(serverState.actions) ? serverState.actions : []).filter((action) => kRestartControlIds.has(action.id)),
  };
};

// During setup the Gateway card stays hidden unless the status stream reports
// a problem: a red or yellow dot (startup failed, configuration error, down,
// unstable, running with issues, channels paused). A fresh box has no status
// frame at all, and "Not set up yet" is gray.
export const reportsGatewayProblem = (serverState) =>
  serverState?.dot?.color === "red" || serverState?.dot?.color === "yellow";

// Everything the gateway controls derive from the status stream, shared by
// the Gateway card and the Health page (ALPH-69 3b), so both surfaces run the
// same handlers: one Restart/Start (no confirmation — the server's admission
// gate refuses unsafe cases), one confirmed Repair, the server's other
// actions, and one status line while a restart runs. The client derives only
// elapsed times, plus the finished-restart exception in
// reconcileFinishedRestart above.
export const useGatewayControls = ({
  status = null,
  setupRequired = false,
  watchdogStatus = null,
  repairing = false,
  onViewLogs = null,
  onOpenWatchdog = null,
  onResumeChannels = null,
  onRefreshStatuses = null,
} = {}) => {
  const shell = useGatewayShell();
  const legacyStatus = status;
  const showServerState = !setupRequired || reportsGatewayProblem(shell.statusState);
  const serverState = (showServerState ? reconcileFinishedRestart(shell.statusState, shell.restartOperation) : null) || {
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
  // While the boot timeline covers the card its own card shows elapsed time;
  // a second "for …" clock would contradict it.
  const sinceLabel =
    sinceMs > 0 && !serverState.bootCovered ? formatDurationLongMs(Math.max(0, observedNowMs - sinceMs)) : null;
  // lastFrameAtMs starts at 0 (no frame yet) — 0 must stay "no stamp", not
  // an epoch-1970 relative time.
  const staleStamp =
    frozen && observedAtMs > 0
      ? formatRelativeTime(observedAtMs, { nowMs, fallback: null })
      : null;
  const reasonsSummary = shell.restartRequired
    ? buildReasonsSummary(shell.restartReasons)
    : null;
  // One line pointing at the upgrade alert; the admin-only snapshot notice
  // never takes the Gateway card's attention.
  const upgradePointer =
    shell.upgradeAlert && shell.upgradeAlert.kind !== "snapshotless" ? shell.upgradeAlert.headline : null;

  const viewLogs = () => {
    const handler = onViewLogs || onOpenWatchdog;
    if (handler) {
      handler();
      return;
    }
    window.location.hash = "/health";
  };

  const runAction = (action) => {
    if (!action) return;
    switch (action.id) {
      case "restart":
      case "retry":
        shellActions.restart?.();
        return;
      case "view_logs":
      case "view_config_error":
        viewLogs();
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

  const restartDescriptor = actions.find((action) => action.id === "restart") || null;
  const repairDescriptor = actions.find((action) => action.id === "repair") || null;
  const controlsBlockedReason = setupRequired
    ? "Complete setup first."
    : frozen
      ? kStaleRestartGuardText
      : "";
  const restartBlocked =
    !!controlsBlockedReason ||
    !!restartDescriptor?.disabledReason ||
    (restartDescriptor?.disposition != null && restartDescriptor.disposition !== "execute");
  const restartTitle = restartBlocked
    ? controlsBlockedReason || restartDescriptor?.disabledReason || restartDescriptor?.reason || ""
    : restartDescriptor?.description || "";

  return {
    shell,
    serverState,
    setupRequired,
    watchdogStatus: watchdogStatus || shell.watchdogStatus,
    repairing,
    nowMs,
    frozen,
    sinceLabel,
    staleStamp,
    reasonsSummary,
    upgradePointer,
    operation,
    shellActions,
    onRefreshStatuses,
    viewLogs,
    runAction,
    handleActionClick,
    confirmAction,
    setConfirmAction,
    otherActions: actions.filter((action) => !kRestartControlIds.has(action.id)),
    restartDescriptor,
    repairDescriptor,
    controlsBlockedReason,
    restartBlocked,
    restartTitle,
  };
};

// The dot, glyph, label, glossary and "for …" clock: the card's state row
// and the Health page's status line.
export const GatewayStateLabel = ({ gw, prefix = null }) => {
  const { serverState, frozen, sinceLabel } = gw;
  // Error/warning states carry a glyph — never color alone.
  const glyph = frozen ? null : glyphFor(serverState.dot);
  return html`
    <span class=${dotClassFor(frozen ? { color: "gray" } : serverState.dot)} aria-hidden="true"></span>
    ${glyph
      ? html`<span
          class=${`text-xs font-semibold ${serverState.dot?.color === "red" ? "text-status-error" : "text-status-warning"}`}
          aria-hidden="true"
          >${glyph}</span
        >`
      : null}
    <span aria-live="polite">
      <span class="text-sm font-semibold">${prefix}${frozen ? "Last known — " : ""}${serverState.label}</span>
    </span>
    ${serverState.glossary
      ? html`<${InfoTooltip} text=${serverState.glossary} />`
      : null}
    ${sinceLabel
      ? html`<span class="text-xs text-fg-muted"
          >for <span class="font-mono">${sinceLabel}</span></span
        >`
      : null}
  `;
};

// Reason, detail, freshness, restart-required and upgrade-pointer lines.
export const GatewayStateNotes = ({ gw, upgradeAlertBelow = false }) => {
  const { serverState, shell, staleStamp, reasonsSummary, upgradePointer } = gw;
  return html`
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
    ${upgradePointer
      ? html`<p class="text-xs text-status-warning" data-upgrade-pointer>
          ${upgradePointer} —
          ${upgradeAlertBelow
            ? html`<a class="ac-tip-link" href="#upgrade-alert" onclick=${(event) => {
                event.preventDefault();
                document.getElementById("upgrade-alert")?.scrollIntoView?.({ block: "nearest" });
                document.getElementById("upgrade-alert")?.focus?.({ preventScroll: true });
              }}>see below</a>`
            : html`<a class="ac-tip-link" href="#/home">open Home</a>`}
        </p>`
      : null}
  `;
};

// The running restart's one status line (and its failure sentence), or the
// boot timeline, the stale guard and a refused restart's notice.
export const GatewayProgress = ({ gw }) => {
  const { operation, nowMs, shellActions, setupRequired, frozen, shell, viewLogs } = gw;
  if (operation) {
    return html`<${RestartProgressCard}
      operation=${operation}
      nowMs=${nowMs}
      onRetry=${shellActions.restart || null}
      onRetryUpgrade=${requestUpgradeRetryConfirm}
      onViewLogs=${viewLogs}
      onExpedite=${(operationId) => expediteGatewayRestart(operationId).catch(() => {})}
    />`;
  }
  return html`
    ${setupRequired ? null : html`<${BootProgressCard} shell=${shell} onViewLogs=${viewLogs} />`}
    ${frozen && !setupRequired
      ? html`<p class="text-xs text-status-warning" role="status">${kStaleRestartGuardText}</p>`
      : null}
    ${shell.restartNotice?.message
      ? html`<p class="text-xs text-fg-muted" role="status">
          ${`Can't restart right now: ${shell.restartNotice.message}`}
        </p>`
      : null}
  `;
};

// The server's other actions (Resume channels, Set up, Refresh, View logs…).
export const GatewayOtherActions = ({ gw, exclude = [] }) =>
  gw.otherActions.filter((action) => !exclude.includes(action.id)).map((action) => html`<${ActionButton}
    key=${action.id}
    onClick=${() => gw.handleActionClick(action)}
    tone=${kActionToneByKind[action.kind] || "secondary"}
    size="sm"
    idleLabel=${action.label}
    loadingLabel=${action.label}
    disabled=${!!action.disabledReason}
    title=${action.disabledReason || action.description || ""}
    className="ac-touch"
  />`);

// Restart/Start. Hidden while a restart runs: the progress line owns that
// time, with its own Restart now and expedite flow.
export const GatewayRestartControl = ({ gw, tone = null, size = "sm", noun = "", className = "ac-touch" }) => {
  if (gw.operation) return null;
  const verb = gw.restartDescriptor?.stopped === true ? "Start" : "Restart";
  return html`<${ActionButton}
    onClick=${() => gw.shellActions.restart?.()}
    tone=${tone || (gw.restartDescriptor?.kind === "primary" ? "primary" : "secondary")}
    size=${size}
    idleLabel=${noun ? `${verb} ${noun}` : verb}
    disabled=${gw.restartBlocked}
    title=${gw.restartTitle}
    className=${className}
  />`;
};

export const GatewayRepairControl = ({ gw, size = "sm", onBusyChange = null, onOutcomeChange = null }) => {
  if (gw.operation) return null;
  return html`<${RepairButton}
    descriptor=${gw.repairDescriptor}
    frozen=${gw.frozen}
    disabled=${!!gw.controlsBlockedReason || !!gw.repairDescriptor?.disabledReason}
    disabledReason=${gw.controlsBlockedReason || gw.repairDescriptor?.disabledReason || ""}
    repairing=${gw.repairing}
    onRepaired=${gw.onRefreshStatuses || gw.shellActions.refresh || null}
    size=${size}
    onBusyChange=${onBusyChange}
    onOutcomeChange=${onOutcomeChange}
  />`;
};

export const GatewayDetails = ({ gw }) => html`<${SupervisionDetails}
  serverState=${gw.serverState}
  watchdogStatus=${gw.watchdogStatus}
  restartReasons=${gw.shell.restartReasons}
  bootProgress=${gw.shell.bootProgress}
/>`;

export const GatewayActionConfirm = ({ gw }) => {
  const { confirmAction, setConfirmAction, runAction } = gw;
  return html`<${ConfirmDialog}
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
  />`;
};

// The setup screen's slot for the card: nothing on a healthy new box, the card
// (its restart and repair controls still blocked until setup completes) when
// the gateway reports a problem.
export const SetupGatewayCard = () => {
  const shell = useGatewayShell();
  if (!reportsGatewayProblem(shell.statusState)) return null;
  return html`<div class="w-full max-w-2xl mb-6"><${Gateway} setupRequired=${true} /></div>`;
};

// The unified, server-driven card: label/dot/reason/actions render verbatim
// from status.state (the onboarding screens and the setup-required shell;
// Health lays the same parts out as a page).
export const Gateway = ({ upgradeAlertBelow = false, ...props }) => {
  const gw = useGatewayControls(props);
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="card-label">OpenClaw Gateway</h2>
        ${gw.serverState.operation
          ? html`<${Badge} tone="cyan">${gw.serverState.operation.label}<//>`
          : null}
      </div>

      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <${GatewayStateLabel} gw=${gw} />
        </div>
        <${GatewayStateNotes} gw=${gw} upgradeAlertBelow=${upgradeAlertBelow} />
        <${GatewayProgress} gw=${gw} />

        <div class="flex flex-wrap items-end justify-between gap-2">
          <${GatewayDetails} gw=${gw} />
          <div class="flex flex-wrap items-center justify-end gap-2">
            <${GatewayOtherActions} gw=${gw} />
            <${GatewayRestartControl} gw=${gw} />
            <${GatewayRepairControl} gw=${gw} />
          </div>
        </div>
      </div>

      <${GatewayActionConfirm} gw=${gw} />
    </div>
  `;
};
