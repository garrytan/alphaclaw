import { h } from "preact";
import htm from "htm";
import { useGatewayShell } from "./restart-progress-card.js";

const html = htm.bind(h);

const kChipByGatewayState = {
  running: { key: "running", word: "Running" },
  starting: { key: "starting", word: "Starting" },
  booting: { key: "starting", word: "Starting" },
  degraded: { key: "degraded", word: "Degraded" },
  safe_mode: { key: "degraded", word: "Degraded" },
  flapping: { key: "degraded", word: "Degraded" },
  down: { key: "down", word: "Down" },
  config_error: { key: "down", word: "Down" },
  boot_failed: { key: "down", word: "Down" },
};

const kRestartLockKinds = new Set(["restart", "openclaw_upgrade"]);

// The global status chip's state, from the gateway shell snapshot the
// controller publishes from the status stream. Pure, so every state is
// tested from fixture frames; the chip never fetches.
export const deriveStatusChip = (shell = {}) => {
  const mode = shell.connectivityMode || "online";
  if (mode === "alphaclaw_restarting") {
    return { key: "restarting", word: "Restarting", title: "AlphaClaw is restarting." };
  }
  if (mode === "alphaclaw_booting") {
    return { key: "starting", word: "Starting", title: "AlphaClaw is starting." };
  }
  if (mode !== "online" && mode !== "reconnecting") {
    return { key: "offline", word: "Offline", title: "AlphaClaw is not answering." };
  }
  if (shell.restartOperation?.phase === "running") {
    return { key: "restarting", word: "Restarting", title: "The gateway is restarting." };
  }
  if (shell.statusFreshness?.mode === "stale") {
    return {
      key: "connecting",
      word: "Checking…",
      title: "Gateway status is out of date. AlphaClaw could not refresh it.",
    };
  }
  const statusState = shell.statusState || null;
  if (kRestartLockKinds.has(statusState?.operation?.kind)) {
    return { key: "restarting", word: "Restarting", title: "The gateway is restarting." };
  }
  const chip = mode === "online" && shell.hasStatus ? kChipByGatewayState[statusState?.state] : null;
  if (!chip) {
    return {
      key: "connecting",
      word: "Connecting…",
      title: statusState?.label || "Waiting for the first status update.",
    };
  }
  return { ...chip, title: `Gateway: ${statusState.label || chip.word}` };
};

export const StatusChip = ({ className = "", onClick = () => {}, linkToHealth = true }) => {
  const chip = deriveStatusChip(useGatewayShell());
  const classes = `status-chip status-chip--${chip.key} ${className}`.trim();
  const content = html`
    <span class=${`status-chip-dot status-chip-dot--${chip.key}`} aria-hidden="true"></span>
    <span class="status-chip-word">${chip.word}</span>
  `;
  if (!linkToHealth) {
    return html`
      <span
        class=${classes}
        data-state=${chip.key}
        title=${chip.title}
      >
        ${content}
      </span>
    `;
  }
  return html`
    <a
      href="#/health"
      class=${classes}
      data-state=${chip.key}
      title=${chip.title}
      aria-label=${`Gateway status: ${chip.word}. Open Health`}
      onclick=${onClick}
    >
      ${content}
    </a>
  `;
};
