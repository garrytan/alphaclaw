import { h } from "preact";
import htm from "htm";
import { formatLocaleTime } from "../../lib/format.js";
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

// Signal kinds (#87): `/readyz` failing components are a real readiness
// degradation ("degraded"); the event-loop diagnostic is telemetry upstream
// says "does not change the readiness result by itself" ("pressure"). Only
// degraded signals earn the DEGRADED badge.
export const kDegradedSignalKinds = Object.freeze({
  degraded: "degraded",
  pressure: "pressure",
});

export const buildDegradedSignals = (watchdogStatus = null) => {
  if (!watchdogStatus) return [];
  const signals = [];
  if (watchdogStatus.eventLoopDegraded) {
    signals.push({
      key: "event-loop",
      kind: kDegradedSignalKinds.pressure,
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
      kind: kDegradedSignalKinds.degraded,
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

const SignalRow = ({ signal }) => html`
  <li key=${signal.key} class="ac-surface-inset border border-border rounded-lg p-3 space-y-1">
    <p class="text-sm text-body">${signal.title}</p>
    <p class="text-xs text-fg-muted">${signal.impact}</p>
    <p class="text-xs text-body">→ ${signal.action}</p>
  </li>
`;

export const WatchdogDegradedCard = ({ watchdogStatus = null }) => {
  const signals = buildDegradedSignals(watchdogStatus);
  if (signals.length === 0) return null;
  const degraded = signals.filter(
    (signal) => signal.kind === kDegradedSignalKinds.degraded,
  );
  const pressure = signals.filter(
    (signal) => signal.kind === kDegradedSignalKinds.pressure,
  );
  // Pressure alone is a load signal on a gateway OpenClaw reports ready:
  // neutral LOAD label, neutral border, no DEGRADED wording anywhere.
  const isDegraded = degraded.length > 0;
  // Seconds opt-in: health probes land seconds apart, so "last checked" must
  // distinguish consecutive probes within the same minute.
  const lastChecked = watchdogStatus?.lastHealthCheckAt
    ? formatLocaleTime(watchdogStatus.lastHealthCheckAt, {
        withSeconds: true,
        fallback: null,
      })
    : null;
  return html`
    <div
      class="bg-surface border ${isDegraded ? "border-yellow-500/35" : "border-border"} rounded-xl p-4 space-y-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="card-label">Gateway health</h2>
          ${isDegraded
            ? html`<${Badge} tone="warning">DEGRADED</${Badge}>`
            : html`<${Badge} tone="neutral">LOAD</${Badge}>`}
        </div>
        ${lastChecked
          ? html`<span class="text-xs text-fg-muted"
              >last checked ${lastChecked}</span
            >`
          : null}
      </div>
      ${isDegraded
        ? null
        : html`<p class="text-sm text-body">
            Gateway is healthy but under load — OpenClaw reports it ready.
          </p>`}
      ${isDegraded
        ? html`<ul class="space-y-3">
            ${degraded.map((signal) => html`<${SignalRow} key=${signal.key} signal=${signal} />`)}
          </ul>`
        : null}
      ${pressure.length > 0
        ? html`<div class="space-y-2">
            ${isDegraded
              ? html`<p class="ac-small-heading">Load (telemetry)</p>`
              : null}
            <ul class="space-y-3">
              ${pressure.map((signal) => html`<${SignalRow} key=${signal.key} signal=${signal} />`)}
            </ul>
          </div>`
        : null}
    </div>
  `;
};
