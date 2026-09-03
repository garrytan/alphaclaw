import { h } from "preact";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { CloseIcon } from "./icons.js";
import {
  buildRestartStepModels,
  useGatewayShell,
} from "./restart-progress-card.js";

const html = htm.bind(h);

// Banner progress counter. Only the COUNT is derived client-side (labels stay
// server-sent): a restart is stopping → launching → waiting_ready → ready,
// plus a preparing_plugins step (always emitted by current servers — with
// status "skipped" when the preflight is skipped; absent only on old servers).
const kRestartStepBaseCount = 4;

export const buildRestartBannerProgress = (operation = null) => {
  if (!operation || operation.phase !== "running") return null;
  const models = buildRestartStepModels(operation.steps).filter(
    (step) => !step.name.startsWith("__"),
  );
  // No real step yet (optimistic placeholder only): no plan to count against.
  if (models.length === 0) return null;
  const hasPrepare = models.some((step) => step.name === "preparing_plugins");
  const total = kRestartStepBaseCount + (hasPrepare ? 1 : 0);
  // Steps are appended as the server starts them, and not every step gets a
  // terminal status ("launching" never does; a preflight ends "skipped"), so
  // the current step is the latest STARTED step — not done_count + 1, which
  // sat at "step 2/5" through most of every restart.
  return { step: Math.min(total, models.length), of: total };
};

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
  if (mode === "alphaclaw_restarting" || shell.upgradeRestartActive) {
    return { kind: "alphaclaw-restarting", text: kAlphaclawRestartingBannerText };
  }
  const operation = shell.restartOperation || null;
  if (operation?.phase === "running") {
    const progress = buildRestartBannerProgress(operation);
    return {
      kind: "operation",
      text: progress
        ? `Restart in progress — step ${progress.step}/${progress.of}`
        : "Restart in progress",
      showView: true,
    };
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
