import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { InfoTooltip } from "./info-tooltip.js";
import { Badge } from "./badge.js";
import { UpdateActionButton } from "./update-action-button.js";
import {
  RestartProgressCard,
  useGatewayShell,
} from "./restart-progress-card.js";
import { fetchWatchdogStatus } from "../lib/api.js";
import {
  formatDurationLongMs,
  formatLocaleDateTime,
  formatRelativeTime,
} from "../lib/format.js";

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

// Pre-first-frame: client-owned placeholder (never invent a server state).
const ConnectingCard = () => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
    <h2 class="card-label">OpenClaw Gateway</h2>
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 text-sm">
        <span
          class="ac-gateway-dot ac-gateway-dot--gray"
          aria-hidden="true"
        ></span>
        <span class="text-fg-muted">Connecting to AlphaClaw…</span>
      </div>
      <${ActionButton}
        disabled=${true}
        tone="secondary"
        size="sm"
        idleLabel="Restart"
        className="ac-touch"
      />
    </div>
  </div>
`;

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
  const pid = watchdogStatus?.gatewayPid || null;
  const reasons = Array.isArray(restartReasons) ? restartReasons : [];

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
                      ${serverState.supervision === "managed"
                        ? "managed by AlphaClaw"
                        : "detached (running outside AlphaClaw's supervision)"}
                    </dd>
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
  watchdogStatus = null,
  onRepair = null,
  repairing = false,
  onViewLogs = null,
  onOpenWatchdog = null,
  onResumeChannels = null,
  onRefreshStatuses = null,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [confirmAction, setConfirmAction] = useState(null);

  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const actions = Array.isArray(serverState.actions) ? serverState.actions : [];
  const primaryAction = actions.find((action) => action.kind === "primary") || null;
  const operation = shell.restartOperation;
  const shellActions = shell.actions || {};
  const frozen = shell.connectivityMode && shell.connectivityMode !== "online";
  const sinceMs = Number(serverState.since) || 0;
  const sinceLabel =
    sinceMs > 0 ? formatDurationLongMs(Math.max(0, nowMs - sinceMs)) : null;
  // lastFrameAtMs starts at 0 (no frame yet) — 0 must stay "no stamp", not
  // an epoch-1970 relative time.
  const staleStamp =
    frozen && shell.lastFrameAtMs > 0
      ? formatRelativeTime(shell.lastFrameAtMs, { nowMs, fallback: null })
      : null;
  const reasonsSummary = shell.restartRequired
    ? buildReasonsSummary(shell.restartReasons)
    : null;
  const glyph = glyphFor(serverState.dot);

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
      case "roll_back":
        shellActions.rollBack?.();
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

  const actionButtons = actions.map((action) => {
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

      ${operation
        ? html`<${RestartProgressCard}
            operation=${operation}
            nowMs=${nowMs}
            primaryAction=${operation.phase === "failed" ? primaryAction : null}
            onPrimaryAction=${runAction}
            onDismiss=${shellActions.dismissOutcome || null}
            onLoadEvidence=${shellActions.loadEvidence || null}
          />`
        : html`
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class=${dotClassFor(serverState.dot)} aria-hidden="true"></span>
                ${glyph
                  ? html`<span
                      class=${`text-xs font-semibold ${serverState.dot?.color === "red" ? "text-status-error" : "text-status-warning"}`}
                      aria-hidden="true"
                      >${glyph}</span
                    >`
                  : null}
                <span aria-live="polite">
                  <span class="text-sm font-semibold">${serverState.label}</span>
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

// Version-skew adapter: an old server sends no `status.state`, so the legacy
// presentation (and its client-side derivation) survives here — and ONLY
// here.
const LegacyGatewayCard = ({
  status,
  restarting = false,
  onRestart,
  watchdogStatus = null,
  onOpenWatchdog,
  onRepair,
  repairing = false,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isRunning = status === "running" && !restarting;
  const dotClass = isRunning
    ? "ac-status-dot ac-status-dot--healthy"
    : "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
  const watchdogHealth =
    watchdogStatus?.lifecycle === "crash_loop"
      ? "crash_loop"
      : watchdogStatus?.health;
  const hasConfigurationError =
    watchdogStatus?.lifecycle === "configuration_error";
  // Safe mode: gateway healthy but channel autostart suppressed by its
  // crash-loop breaker — a green "healthy" badge would be misleading.
  const isSafeMode = !!watchdogStatus?.safeMode;
  const watchdogDotClass =
    isSafeMode && watchdogHealth === "healthy"
      ? "bg-yellow-500"
      : watchdogHealth === "healthy"
        ? "ac-status-dot ac-status-dot--healthy ac-status-dot--healthy-offset"
        : watchdogHealth === "degraded"
          ? "bg-yellow-500"
          : watchdogHealth === "unhealthy" || watchdogHealth === "crash_loop"
            ? "bg-red-500"
            : "bg-gray-500";
  const watchdogLabel = hasConfigurationError
    ? "configuration error"
    : isSafeMode
      ? "safe mode"
      : watchdogHealth === "unknown"
        ? "initializing"
        : watchdogHealth || "unknown";
  const isRepairInProgress = repairing || !!watchdogStatus?.operationInProgress;
  const showInspectButton = watchdogHealth === "degraded" && !!onOpenWatchdog;
  const showRepairButton =
    isRepairInProgress ||
    (watchdogStatus?.health === "degraded" && !onOpenWatchdog) ||
    watchdogStatus?.lifecycle === "crash_loop" ||
    watchdogStatus?.health === "unhealthy" ||
    watchdogStatus?.health === "crashed";
  const liveUptimeMs = useMemo(() => {
    const startedAtMs = watchdogStatus?.uptimeStartedAt
      ? Date.parse(watchdogStatus.uptimeStartedAt)
      : null;
    if (Number.isFinite(startedAtMs)) {
      return Math.max(0, nowMs - startedAtMs);
    }
    return watchdogStatus?.uptimeMs || 0;
  }, [watchdogStatus?.uptimeStartedAt, watchdogStatus?.uptimeMs, nowMs]);

  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return html` <div class="bg-surface border border-border rounded-xl p-4">
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0 flex items-center gap-2 text-sm">
          <span class=${dotClass}></span>
          <span class="font-semibold">Gateway:</span>
          <span class="text-fg-muted"
            >${restarting ? "restarting..." : status || "checking..."}</span
          >
        </div>
        <div class="flex items-center gap-3 shrink-0">
          ${!restarting && isRunning
            ? html`
                <span class="text-xs text-fg-muted whitespace-nowrap"
                  >Uptime: ${formatDurationLongMs(liveUptimeMs)}</span
                >
              `
            : null}
          <${UpdateActionButton}
            onClick=${onRestart}
            disabled=${!status}
            loading=${restarting}
            warning=${false}
            idleLabel="Restart"
            loadingLabel="On it..."
          />
        </div>
      </div>
      <div class="flex items-center justify-between gap-3">
        ${onOpenWatchdog
          ? html`
              <button
                class="inline-flex items-center gap-2 text-sm hover:opacity-90"
                onclick=${onOpenWatchdog}
                title="Open Watchdog tab"
              >
                <span
                  class=${watchdogDotClass.startsWith("ac-status-dot")
                    ? watchdogDotClass
                    : `w-2 h-2 rounded-full ${watchdogDotClass}`}
                ></span>
                <span class="font-semibold">Watchdog:</span>
                <span class="text-fg-muted">${watchdogLabel}</span>
              </button>
            `
          : html`
              <div class="inline-flex items-center gap-2 text-sm">
                <span
                  class=${watchdogDotClass.startsWith("ac-status-dot")
                    ? watchdogDotClass
                    : `w-2 h-2 rounded-full ${watchdogDotClass}`}
                ></span>
                <span class="font-semibold">Watchdog:</span>
                <span class="text-fg-muted">${watchdogLabel}</span>
              </div>
            `}
        ${onRepair
          ? html`
              <div class="shrink-0 w-32 flex justify-end">
                ${showInspectButton
                  ? html`
                      <${UpdateActionButton}
                        onClick=${onOpenWatchdog}
                        warning=${false}
                        idleLabel="Inspect"
                        loadingLabel="Inspect"
                        className="w-full justify-center"
                      />
                    `
                  : showRepairButton
                    ? html`
                        <${UpdateActionButton}
                          onClick=${onRepair}
                          loading=${isRepairInProgress}
                          warning=${true}
                          idleLabel="Repair"
                          loadingLabel="Repairing..."
                          className="w-full justify-center"
                        />
                      `
                    : html`<span
                        class="inline-flex h-7 w-full"
                        aria-hidden="true"
                      ></span>`}
              </div>
            `
          : null}
      </div>
    </div>
  </div>`;
};

// One primary operational surface, rendered identically on the General and
// Watchdog pages. Page-specific behavior arrives via props (the Watchdog
// page passes onViewLogs to focus its logs pane instead of navigating).
export const Gateway = ({
  status = null,
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
  const serverState = shell.statusState;
  const hasStatus = shell.hasStatus || !!status;

  if (!hasStatus) {
    return html`<${ConnectingCard} />`;
  }

  if (!serverState) {
    return html`<${LegacyGatewayCard}
      status=${status}
      restarting=${restarting}
      onRestart=${onRestart}
      watchdogStatus=${watchdogStatus || shell.watchdogStatus}
      onOpenWatchdog=${onOpenWatchdog}
      onRepair=${onRepair}
      repairing=${repairing}
    />`;
  }

  return html`<${GatewayStateCard}
    serverState=${serverState}
    shell=${shell}
    watchdogStatus=${watchdogStatus || shell.watchdogStatus}
    onRepair=${onRepair}
    repairing=${repairing}
    onViewLogs=${onViewLogs}
    onOpenWatchdog=${onOpenWatchdog}
    onResumeChannels=${onResumeChannels}
    onRefreshStatuses=${onRefreshStatuses}
  />`;
};
