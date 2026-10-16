import { h } from "preact";
import htm from "htm";
import { useNowMs } from "../hooks/use-now-ms.js";
import { formatDurationLongMs } from "../lib/format.js";
import { ActionButton } from "./action-button.js";
import { CloseIcon } from "./icons.js";
import {
  describeRestartPhase,
  isUnfinishedUpgrade,
  isUpgradeOperation,
  useGatewayShell,
} from "./restart-progress-card.js";

const html = htm.bind(h);

export const kReconnectingBannerText = "Reconnecting to AlphaClaw…";
export const kAlphaclawRestartingBannerText =
  "AlphaClaw is restarting — reconnecting automatically";
export const kUnreachableBannerText =
  "Still can't reach AlphaClaw — check that the process is running. If this persists, restart AlphaClaw from your host's dashboard (Render/Railway).";
export const kStalledBannerText =
  "AlphaClaw answers, but its startup hasn't made progress for a while. Check the logs in the Watchdog tab, or run alphaclaw diagnose on the host.";
export const kStuckBannerText =
  "AlphaClaw has been starting for a long time without finishing. Check the logs; if this persists, restart AlphaClaw from your host's dashboard (Render/Railway).";
export const buildRestartLoopBannerText = (count) =>
  `AlphaClaw keeps restarting — it started ${count} times in the last 10 minutes. Check the logs in the Watchdog tab or run alphaclaw diagnose on the host. If it continues, restart AlphaClaw from your host's dashboard (Render/Railway).`;
// "AlphaClaw is restarting — Preparing" / "Updating AlphaClaw — Starting the gateway".
export const buildBootReconnectText = (reconnect = {}) => {
  const label = reconnect?.label === "Updating AlphaClaw" ? "AlphaClaw is updating"
    : reconnect?.label && reconnect.label !== "Restarting" ? reconnect.label
      : "AlphaClaw is restarting";
  return reconnect?.stageLabel ? `${label} — ${reconnect.stageLabel}` : `${label} — reconnecting automatically`;
};
// The passive boot row: "Upgrading OpenClaw data" during the data upgrade,
// else "<kind headline> — <stage>". Elapsed time is rendered beside it,
// outside the announced text.
export const buildBootBannerText = (bootProgress) => {
  if (!bootProgress?.stageLabel) return null;
  return bootProgress.stage === "upgrading"
    ? bootProgress.stageLabel
    : `${bootProgress.headline || bootProgress.label || "AlphaClaw is restarting"} — ${bootProgress.stageLabel}`;
};
export const kRestartRequiredBannerText =
  "Gateway restart required to apply pending configuration changes.";

// The banner is a passive announcement + deep-link. The Gateway card
// exclusively owns restart actions and progress; connectivity outages
// supersede the restart slot entirely.
export const buildGlobalBannerModel = ({ shell = {}, visible = false } = {}) => {
  const mode = shell.connectivityMode || "online";
  if (mode === "restart_loop") {
    return { kind: "restart-loop", text: buildRestartLoopBannerText(shell.bootReconnect?.count || 4), showLogs: true };
  }
  if (mode === "alphaclaw_stuck") {
    return { kind: "stuck", text: kStuckBannerText, showRetry: true };
  }
  if (mode === "alphaclaw_stalled") {
    return { kind: "stalled", text: kStalledBannerText, showRetry: true };
  }
  if (mode === "alphaclaw_booting") {
    return { kind: "alphaclaw-restarting", text: buildBootReconnectText(shell.bootReconnect) };
  }
  if (mode === "unreachable") {
    return { kind: "unreachable", text: kUnreachableBannerText, showRetry: true };
  }
  if (mode === "reconnecting") {
    return { kind: "reconnecting", text: kReconnectingBannerText };
  }
  if (mode === "alphaclaw_restarting") {
    return { kind: "alphaclaw-restarting", text: kAlphaclawRestartingBannerText };
  }
  const operation = shell.restartOperation || null;
  if (operation?.phase === "running") {
    // The same phase sentence the Gateway card shows — never a step count.
    const phase = describeRestartPhase(operation.steps);
    const upgrade = isUpgradeOperation(operation);
    return {
      kind: "operation",
      text: phase
        ? `${upgrade ? "Upgrading OpenClaw data" : "Restarting"}: ${phase}`
        : upgrade
          ? "OpenClaw data upgrade in progress"
          : "Restart in progress",
      showView: true,
    };
  }
  // The boot timeline row: below connectivity and a running operation,
  // above stale/failed/restart-required. Passive (the Gateway card owns
  // every action).
  const boot = shell.bootProgress;
  if (boot && boot.outcome === null && buildBootBannerText(boot)) {
    return { kind: "boot", text: buildBootBannerText(boot), showView: true, elapsedFrom: Number(boot.startedAt) || null };
  }
  if (shell.statusFreshness?.mode === "stale") {
    return { kind: "stale-status", text: "Last known — status updates unavailable", showRetry: true };
  }
  if (operation?.phase === "failed") {
    return {
      kind: "failure",
      text: isUpgradeOperation(operation) ? "OpenClaw's data upgrade retry failed" : "Gateway restart failed",
      showView: true,
    };
  }
  if (isUnfinishedUpgrade(operation)) {
    return { kind: "failure", text: "OpenClaw is running again, but its data upgrade didn't finish", showView: true };
  }
  if (shell.restartRequired || visible) {
    return {
      kind: "required",
      text: kRestartRequiredBannerText,
      showView: true,
      dismissible: true,
    };
  }
  // Lowest precedence, passive: the upgrade alert lives under the Gateway
  // card; the banner only points there (never the admin-only notice).
  const alert = shell.upgradeAlert;
  if (alert && alert.kind !== "snapshotless" && alert.headline) {
    return { kind: "upgrade", text: alert.headline, showView: true };
  }
  return null;
};

export const GlobalRestartBanner = ({
  visible = false,
  // Legacy props kept for call-site compatibility; the banner no longer
  // carries a restart button (the Gateway card owns all restart actions).
  restarting = false, // eslint-disable-line no-unused-vars
  onRestart = null, // eslint-disable-line no-unused-vars
  onDismiss = () => {},
}) => {
  const shell = useGatewayShell();
  const model = buildGlobalBannerModel({ shell, visible });
  const nowMs = useNowMs(1000, { enabled: !!model?.elapsedFrom });
  if (!model) return null;
  // Server-anchored elapsed (the frame's compute time vs its receipt).
  const offsetMs = shell.statusFreshness?.observedAtMs && shell.statusFreshness?.receivedAtMs
    ? shell.statusFreshness.observedAtMs - shell.statusFreshness.receivedAtMs
    : 0;
  const elapsed = model.elapsedFrom ? formatDurationLongMs(Math.max(0, nowMs + offsetMs - model.elapsedFrom)) : null;
  const shellActions = shell.actions || {};
  const handleRetry = shellActions.retryConnect || null;
  const handleDismiss = shellActions.dismissRestartBanner || onDismiss;

  return html`
    <div class="global-restart-banner" role="status">
      <div class="global-restart-banner__content">
        <p class="global-restart-banner__text">
          ${model.text}${elapsed
            ? html` <span aria-hidden="true">· ${elapsed}</span>`
            : null}${model.showLogs
            ? html` <span aria-hidden="true">·</span>${" "}
                <a class="ac-tip-link" href="#/watchdog">View logs</a>`
            : null}${model.showView
            ? html` <span aria-hidden="true">·</span>${" "}
                <a class="ac-tip-link" href="#/general">view</a>`
            : null}
        </p>
        ${model.showRetry || model.dismissible
          ? html`
              <div class="global-restart-banner__actions">
                ${model.showRetry && handleRetry
                  ? html`<${ActionButton}
                      onClick=${handleRetry}
                      tone="secondary"
                      size="sm"
                      idleLabel="Retry"
                      className="ac-touch"
                    />`
                  : null}
                ${model.dismissible
                  ? html`
                      <button
                        type="button"
                        onclick=${handleDismiss}
                        class="global-restart-banner__dismiss ac-btn-ghost ac-touch"
                        aria-label="Dismiss restart banner"
                        title="Dismiss"
                      >
                        <${CloseIcon} className="h-3.5 w-3.5" />
                      </button>
                    `
                  : null}
              </div>
            `
          : null}
      </div>
    </div>
  `;
};
