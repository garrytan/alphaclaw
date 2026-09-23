import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";
import { TooltipBadge } from "../tooltip-badge.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { InfoTooltip } from "../info-tooltip.js";

const html = htm.bind(h);

const resolveWatchState = ({
  watchStatus,
  busy = false,
  statusUnknown = false,
  statusLoading = false,
}) => {
  const operation = watchStatus?.remoteOperation;
  if (!watchStatus?.enabled && operation?.kind !== "start") {
    if (operation?.status === "pending") return {
      label: "Disabled locally", tone: "warning",
      tooltip: operation.kind === "disconnect"
        ? "Gmail delivery is disabled. Google account disconnection is still pending."
        : "Gmail delivery is disabled. Cancellation of the watch at Google is still pending.",
    };
    if (operation?.status === "failed") return { label: "Disabled · retry needed", tone: "danger" };
  }
  if (busy) {
    const label = watchStatus?.enabled ? "Stopping" : "Starting";
    return { label, tone: "warning" };
  }
  // Neither a failed NOR a still-pending config load may read as a confident
  // "Stopped" — loading and unknown are their own states.
  if (statusLoading) return { label: "Loading", tone: "neutral" };
  if (statusUnknown) return { label: "Unknown", tone: "warning" };
  if (!watchStatus?.enabled) return { label: "Stopped", tone: "neutral" };
  // Self-standing label stating the observed fact — enabled && !running does
  // not prove it stopped (may be starting or temporarily unavailable), and a
  // bare "Error" names nothing. The payload carries no richer error field;
  // the tooltip's static remediation is supplementary (never opens on touch).
  if (watchStatus.enabled && !watchStatus.running)
    return {
      label: "Watch not running",
      tone: "danger",
      tooltip:
        "Gmail watch is enabled but not running — renew the watch or check the account's Pub/Sub setup.",
    };
  return { label: "Watching", tone: "success" };
};

export const GmailWatchToggle = ({
  account,
  watchStatus = null,
  busy = false,
  // Initial config load still in flight (no status known yet).
  statusLoading = false,
  // Config load failure while no status is known for this account.
  statusError = null,
  // { attempted, error } from the last enable/disable failure.
  saveError = null,
  onRetryStatus = null,
  onEnable = () => {},
  onDisable = () => {},
  onOpenWebhook = () => {},
}) => {
  const hasGmailReadScope = Array.isArray(account?.activeScopes)
    ? account.activeScopes.includes("gmail:read")
    : Array.isArray(account?.services)
      ? account.services.includes("gmail:read")
      : false;
  if (!hasGmailReadScope) {
    return html`
      <div class="bg-field rounded-lg px-3 py-2">
        <div class="text-xs text-fg-muted">
          Gmail watch requires <code>gmail:read</code>. Add it in permissions
          above, then update permissions.
        </div>
      </div>
    `;
  }

  const statusUnknown = !watchStatus && Boolean(statusError);
  const statusPending = !watchStatus && !statusUnknown && Boolean(statusLoading);
  const state = resolveWatchState({
    watchStatus,
    busy,
    statusUnknown,
    statusLoading: statusPending,
  });
  const enabled = Boolean(watchStatus?.enabled);
  const operation = watchStatus?.remoteOperation;
  const disconnecting = Boolean(watchStatus?.disconnecting) ||
    (operation?.kind === "disconnect" && operation.status === "pending");
  const stopFailed = !enabled && operation?.kind === "stop" && operation.status === "failed";
  return html`
    <div class="space-y-2">
      <div
        class="flex items-center justify-between bg-field border border-transparent rounded-lg px-3 py-2 cursor-pointer hover:bg-field hover:border-white/20 transition-colors"
        role="button"
        tabindex="0"
        onClick=${() => onOpenWebhook?.()}
        onKeyDown=${(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpenWebhook?.();
        }}
      >
        <div class="flex items-center gap-1.5 text-sm">
          <span>🔔 Gmail</span>
          <${InfoTooltip}
            text="Watches this inbox for new email events and routes them to your agent via the Gmail hook."
            widthClass="w-72"
          />
        </div>
        <div
          class="flex items-center gap-2"
          onClick=${(event) => event.stopPropagation()}
          onKeyDown=${(event) => event.stopPropagation()}
        >
          ${state.tooltip
            ? html`<${TooltipBadge}
                tone=${state.tone}
                label=${state.label}
                text=${state.tooltip}
              />`
            : html`<${Badge} tone=${state.tone}>${state.label}</${Badge}>`}
          <${ToggleSwitch}
            checked=${enabled}
            disabled=${busy || disconnecting || statusUnknown || statusPending}
            busy=${busy}
            label=""
            onChange=${(nextChecked) => {
              if (busy || disconnecting || statusUnknown || statusPending) return;
              if (nextChecked) onEnable?.();
              else onDisable?.();
            }}
          />
        </div>
      </div>
      ${state.tooltip
        ? html`
            <p class="text-xs text-fg-muted">${state.tooltip}</p>
          `
        : null}
      ${statusUnknown
        ? html`
            <${InlineErrorChip}
              error=${statusError}
              headline="Couldn't load Gmail watch status."
              onRetry=${onRetryStatus}
            />
          `
        : null}
      ${saveError
        ? html`
            <${InlineErrorChip}
              error=${saveError.error}
              headline=${`Couldn't ${saveError.attempted ? "enable" : "disable"} Gmail watch — showing the server's current state.`}
            />
          `
        : null}
      ${operation?.status === "failed" && operation.kind !== "disconnect"
        ? html`<${InlineErrorChip}
            error=${new Error(operation.message || "Gmail watch operation did not finish.")}
            headline=${stopFailed ? "Gmail is disabled locally; the remote stop needs a retry." : "Gmail watch could not start."}
            onRetry=${stopFailed && !busy ? onDisable : null}
          />`
        : null}
    </div>
  `;
};
