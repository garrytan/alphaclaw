import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";

const html = htm.bind(h);

// D16: every degraded badge carries an action model — affected function, user
// impact, last checked, recommended action. Restart is only suggested where it
// can actually help (it can't for a wedged event loop or missing secrets).
const kReadyzComponentModels = {
  secrets: {
    title: "Referenced secrets couldn't load",
    impact: "Channels or models that use those secrets may fail to respond.",
    action:
      "Review Secrets in the OpenClaw dashboard (Settings → Secrets), then the gateway recovers on its own.",
  },
  providers: {
    title: "A model provider failed its readiness check",
    impact: "Messages routed to that provider may fail until it recovers.",
    action:
      "Check the provider's API key on the Models page and the provider's status page.",
  },
  channels: {
    title: "A channel failed its readiness check",
    impact: "Messages on that channel may not be delivered.",
    action: "Check the channel's credentials under Agents → Channels.",
  },
};

export const buildDegradedSignals = (watchdogStatus = null) => {
  if (!watchdogStatus) return [];
  const signals = [];
  if (watchdogStatus.eventLoopDegraded) {
    signals.push({
      key: "event-loop",
      title: "Gateway is running but responding slowly",
      impact: "Messages and the Control UI may lag or time out.",
      action:
        "This usually clears on its own — a restart doesn't help. If it persists, check CPU and memory in Resources below.",
    });
  }
  for (const component of watchdogStatus.readyzFailing || []) {
    const known = kReadyzComponentModels[component];
    signals.push({
      key: `readyz-${component}`,
      title: known
        ? known.title
        : `"${component}" failed its readiness check`,
      impact: known
        ? known.impact
        : "Part of OpenClaw is running but not fully ready.",
      action: known
        ? known.action
        : "Check the gateway log below for details; the check re-runs automatically.",
    });
  }
  return signals;
};

export const WatchdogDegradedCard = ({ watchdogStatus = null }) => {
  const signals = buildDegradedSignals(watchdogStatus);
  if (signals.length === 0) return null;
  const lastChecked = watchdogStatus?.lastHealthCheckAt
    ? new Date(watchdogStatus.lastHealthCheckAt).toLocaleTimeString()
    : null;
  return html`
    <div class="bg-surface border border-yellow-500/35 rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="card-label">Gateway health</h2>
          <${Badge} tone="warning">DEGRADED</${Badge}>
        </div>
        ${lastChecked
          ? html`<span class="text-xs text-fg-muted"
              >last checked ${lastChecked}</span
            >`
          : null}
      </div>
      <ul class="space-y-3">
        ${signals.map(
          (signal) => html`
            <li key=${signal.key} class="ac-surface-inset border border-border rounded-lg p-3 space-y-1">
              <p class="text-sm text-body">${signal.title}</p>
              <p class="text-xs text-fg-muted">${signal.impact}</p>
              <p class="text-xs text-body">→ ${signal.action}</p>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
};
