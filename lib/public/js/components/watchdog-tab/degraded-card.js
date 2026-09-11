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

// The card keys on the server's readiness VERDICT (#87 G5), not on the
// retained `readyzFailing[]` list alone — status carries `readiness`
// (ready | not_ready | unknown), `readinessReason`, `readinessStatus`
// (started | starting | draining | null) and `readinessProbe`:
//   degraded      readiness not_ready and NOT transitional — OpenClaw's own
//                 verdict; the component rows (or one generic signal built
//                 from readinessReason) earn the DEGRADED badge
//   transitional  starting | draining inside the ready budget — the header
//                 already says "Up — channels still starting"; no card from
//                 readiness (pressure still shows)
//   ready         an explicit ready:true wins: a non-empty failing[] beside
//                 it is telemetry, listed neutrally, never DEGRADED
//   unknown       fail-open / unsupported / unconfigured: the retained
//                 failing[] is stale — listed neutrally as unverified
//   legacy        no `readiness` field (an older server): failing
//                 components degrade, as before
export const kReadinessCardVerdicts = Object.freeze({
  degraded: "degraded",
  transitional: "transitional",
  ready: "ready",
  unknown: "unknown",
  legacy: "legacy",
});

const kTransitionalReadinessStatuses = new Set(["starting", "draining"]);

const stringOrNull = (value) => (typeof value === "string" ? value : null);

export const classifyReadinessCard = (watchdogStatus = null) => {
  const failing = Array.isArray(watchdogStatus?.readyzFailing)
    ? watchdogStatus.readyzFailing.filter((entry) => typeof entry === "string")
    : [];
  const probe = stringOrNull(watchdogStatus?.readinessProbe);
  const readiness = watchdogStatus?.readiness;
  if (typeof readiness !== "string") {
    return { verdict: kReadinessCardVerdicts.legacy, failing, reason: null, probe };
  }
  if (readiness === "not_ready") {
    const reason = stringOrNull(watchdogStatus.readinessReason);
    const status = stringOrNull(watchdogStatus.readinessStatus);
    // The transitional branch writes reason = status; the X2 expiry writes a
    // longer reason ("starting did not complete within Ns") — a real not-ready.
    if (kTransitionalReadinessStatuses.has(status) && reason === status) {
      return { verdict: kReadinessCardVerdicts.transitional, failing, reason, probe };
    }
    return { verdict: kReadinessCardVerdicts.degraded, failing, reason, probe };
  }
  if (readiness === "ready") {
    return { verdict: kReadinessCardVerdicts.ready, failing, reason: null, probe };
  }
  return { verdict: kReadinessCardVerdicts.unknown, failing, reason: null, probe };
};

const componentSignal = (component) => {
  const known = kReadyzComponentModels[component];
  return {
    key: `readyz-${component}`,
    kind: kDegradedSignalKinds.degraded,
    title: known ? known.title : `"${component}" failed its readiness check`,
    impact: known
      ? known.impact
      : "Part of OpenClaw is running but not fully ready.",
    action: known
      ? known.action
      : "Check the gateway log below for details; the check re-runs automatically.",
  };
};

// Action-model rows: pressure (telemetry, never DEGRADED) plus the readiness
// degradation's rows — component rows when the verdict counts the components
// against readiness (degraded / legacy), or one generic signal when OpenClaw
// says not ready without naming a component (#87 G5). A ready / unknown /
// transitional verdict contributes NO degraded row: the components it
// retained are telemetry, rendered by the card as a neutral list.
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
  const card = classifyReadinessCard(watchdogStatus);
  if (
    card.verdict === kReadinessCardVerdicts.degraded ||
    card.verdict === kReadinessCardVerdicts.legacy
  ) {
    for (const component of card.failing) signals.push(componentSignal(component));
    if (card.verdict === kReadinessCardVerdicts.degraded && card.failing.length === 0) {
      signals.push({
        key: "readiness",
        kind: kDegradedSignalKinds.degraded,
        title: "OpenClaw reports the gateway not ready",
        impact: card.reason
          ? `/readyz says: ${card.reason}. Part of OpenClaw is running but not fully ready.`
          : "Part of OpenClaw is running but not fully ready.",
        action: "Check the gateway log below; the check re-runs automatically.",
      });
    }
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
  const card = classifyReadinessCard(watchdogStatus);
  // Components OpenClaw's verdict does NOT count against readiness (#87 G5):
  // a ready body's failing[] and the stale list retained under an unknown
  // readiness. Listed, never a degraded row.
  const telemetryComponents =
    card.verdict === kReadinessCardVerdicts.ready ||
    card.verdict === kReadinessCardVerdicts.unknown
      ? card.failing
      : [];
  if (signals.length === 0 && telemetryComponents.length === 0) return null;
  const degraded = signals.filter(
    (signal) => signal.kind === kDegradedSignalKinds.degraded,
  );
  const pressure = signals.filter(
    (signal) => signal.kind === kDegradedSignalKinds.pressure,
  );
  // Pressure alone is a load signal on a gateway OpenClaw reports ready:
  // neutral LOAD label, neutral border, no DEGRADED wording anywhere. The
  // same neutral treatment carries a telemetry-only card (ready / unknown).
  const isDegraded = degraded.length > 0;
  const readinessLine =
    card.verdict === kReadinessCardVerdicts.unknown
      ? `readiness unverified (${card.probe || "unknown"})`
      : "OpenClaw reports it ready";
  const neutralHeadline =
    pressure.length > 0
      ? `Gateway is healthy but under load — ${readinessLine}.`
      : `Gateway is healthy — ${readinessLine}.`;
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
            : pressure.length > 0
              ? html`<${Badge} tone="neutral">LOAD</${Badge}>`
              : html`<${Badge} tone="neutral">TELEMETRY</${Badge}>`}
        </div>
        ${lastChecked
          ? html`<span class="text-xs text-fg-muted"
              >last checked ${lastChecked}</span
            >`
          : null}
      </div>
      ${isDegraded
        ? null
        : html`<p class="text-sm text-body">${neutralHeadline}</p>`}
      ${isDegraded
        ? html`<ul class="space-y-3">
            ${degraded.map((signal) => html`<${SignalRow} key=${signal.key} signal=${signal} />`)}
          </ul>`
        : null}
      ${pressure.length > 0
        ? html`<div class="space-y-2">
            ${isDegraded || telemetryComponents.length > 0
              ? html`<p class="ac-small-heading">Load (telemetry)</p>`
              : null}
            <ul class="space-y-3">
              ${pressure.map((signal) => html`<${SignalRow} key=${signal.key} signal=${signal} />`)}
            </ul>
          </div>`
        : null}
      ${telemetryComponents.length > 0
        ? html`<div class="space-y-2">
            <p class="ac-small-heading">Reported by /readyz (telemetry)</p>
            <ul class="flex flex-wrap gap-2">
              ${telemetryComponents.map(
                (component) => html`<li
                  key=${`readyz-${component}`}
                  class="ac-surface-inset border border-border rounded-lg px-2 py-1 text-xs text-fg-muted"
                >
                  ${component}
                </li>`,
              )}
            </ul>
          </div>`
        : null}
    </div>
  `;
};
