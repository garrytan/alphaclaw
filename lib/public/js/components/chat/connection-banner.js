import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// Connection pill: hidden when online; every degraded mode is named honestly
// and "offline" carries a manual Retry-now affordance (the old client gave up
// silently after 8 attempts with a permanently dead composer).
export const ConnectionBanner = ({ status = {}, persistWarning = false, onRetryNow }) => {
  const mode = String(status.mode || "online");
  const legacy = status.legacy === true;
  const rows = [];
  if (legacy) {
    rows.push(
      html`<div class="chat-connection-pill is-legacy" role="status">
        Limited mode — this server predates chat retries; messages send once.
      </div>`,
    );
  } else if (mode === "connecting" || mode === "reconnecting") {
    rows.push(
      html`<div class="chat-connection-pill is-reconnecting" role="status">
        <span class="chat-connection-spinner" aria-hidden="true"></span>
        Reconnecting…
      </div>`,
    );
  } else if (mode === "offline") {
    rows.push(
      html`<div class="chat-connection-pill is-offline" role="status">
        <span>Chat disconnected.</span>
        <button type="button" class="ac-btn-secondary" onclick=${onRetryNow}>
          Retry now
        </button>
      </div>`,
    );
  } else if (mode === "httpFallback") {
    rows.push(
      html`<div class="chat-connection-pill is-fallback" role="status">
        <span>Realtime unavailable — history only; messages stay queued.</span>
        <button type="button" class="ac-btn-secondary" onclick=${onRetryNow}>
          Retry realtime
        </button>
      </div>`,
    );
  }
  if (persistWarning) {
    rows.push(
      html`<div class="chat-connection-pill is-storage" role="status">
        Messages can't be saved in this browser — don't close the tab
        mid-send.
      </div>`,
    );
  }
  if (rows.length === 0) return null;
  return html`<div class="chat-connection-banner">${rows}</div>`;
};
