import { h } from "preact";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { CloseIcon } from "./icons.js";
import { describeRestartPhase, useGatewayShell } from "./restart-progress-card.js";

const html = htm.bind(h);

export const kReconnectingBannerText = "Reconnecting to AlphaClaw…";
export const kAlphaclawRestartingBannerText =
  "AlphaClaw is restarting — reconnecting automatically";
export const kUnreachableBannerText =
  "Still can't reach AlphaClaw — check that the process is running. If this persists, restart AlphaClaw from your host's dashboard (Render/Railway).";
export const kRestartRequiredBannerText =
  "Gateway restart required to apply pending configuration changes.";

// The banner is a passive announcement + deep-link. The Gateway card
// exclusively owns restart actions and progress; connectivity outages
// supersede the restart slot entirely.
export const buildGlobalBannerModel = ({ shell = {}, visible = false } = {}) => {
  const mode = shell.connectivityMode || "online";
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
    return {
      kind: "operation",
      text: phase ? `Restarting: ${phase}` : "Restart in progress",
      showView: true,
    };
  }
  if (shell.statusFreshness?.mode === "stale") {
    return { kind: "stale-status", text: "Last known — status updates unavailable", showRetry: true };
  }
  if (operation?.phase === "failed") {
    return { kind: "failure", text: "Gateway restart failed", showView: true };
  }
  if (shell.restartRequired || visible) {
    return {
      kind: "required",
      text: kRestartRequiredBannerText,
      showView: true,
      dismissible: true,
    };
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
  if (!model) return null;
  const shellActions = shell.actions || {};
  const handleRetry = shellActions.retryConnect || null;
  const handleDismiss = shellActions.dismissRestartBanner || onDismiss;

  return html`
    <div class="global-restart-banner" role="status">
      <div class="global-restart-banner__content">
        <p class="global-restart-banner__text">
          ${model.text}${model.showView
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
