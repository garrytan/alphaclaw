import {
  formatDurationLongMs,
  formatLocaleDateTimeWithZone,
  formatRelativeTime,
} from "../../../lib/format.js";

// Human labels for the event types the watchdog writes. Keys MUST cover the
// documented watchdog event-type list (see lib/server/watchdog.js logEvent
// call sites); the sync test in tests/frontend/watchdog-incidents-ui.test.js
// pins this map. Unknown/foreign types degrade to a humanized fallback —
// other subsystems (topic registry/discovery, release channel) share the
// events table.
export const kWatchdogEventLabels = {
  health_check: "Health check",
  crash: "Gateway crashed",
  crash_loop: "Crash loop detected",
  restart: "Gateway restart",
  repair: "Doctor repair",
  recovery: "Gateway recovered",
  config_error: "Configuration error",
  safe_mode: "Safe mode",
  safe_mode_resume: "Channels resumed",
  channel_rollback: "Release rollback",
  forward_recovery: "Forward recovery",
  notification: "Notification sent",
  operation: "Gateway operation",
  readiness_degraded: "Readiness degraded",
  medic: "Startup medic",
  autotune: "Resource autotune",
  memory: "Memory monitor",
};

const humanizeEventType = (eventType = "") =>
  String(eventType || "event")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());

const kStatusTone = {
  failed: "danger",
  backoff: "warning",
  warn: "warning",
  warning: "warning",
  requested: "info",
  ok: "success",
};

// One salient detail per event, pulled from the details JSON the server
// already writes — replaces the raw JSON.stringify dump.
const salientDetail = (event = {}) => {
  const details =
    event.details && typeof event.details === "object" ? event.details : {};
  if (details.unreadable) return "record unreadable";
  if (details.skipped) {
    if (details.startupGraceActive) return "skipped (startup grace)";
    if (details.expectedRestartActive) return "skipped (planned restart)";
    if (details.startupFailureRetryActive)
      return `skipped (startup retry ${details.startupConsecutiveFailures ?? "?"}/${details.startupFailureThreshold ?? "?"})`;
    return "skipped";
  }
  if (details.reason) return String(details.reason).slice(0, 160);
  if (details.backoffMs != null)
    return `backoff ${formatDurationLongMs(details.backoffMs)}`;
  if (details.code != null) return `exit code ${details.code}`;
  if (Array.isArray(details.suppressed) && details.suppressed.length)
    return `suppressed: ${details.suppressed.join(", ")}`;
  if (details.recovered) return "recovered";
  if (details.crashesInWindow != null)
    return `${details.crashesInWindow} crashes in window`;
  if (details.pid != null) return `pid ${details.pid}`;
  return null;
};

const kToneAriaLabels = {
  danger: "Failed",
  warning: "Warning",
  info: "In progress",
  success: "OK",
  neutral: "Routine",
};

export const describeEvent = (event = {}) => {
  const eventType = String(event.eventType || "");
  const status = String(event.status || "").toLowerCase();
  const label = kWatchdogEventLabels[eventType] || humanizeEventType(eventType);
  const detail = salientDetail(event);
  let tone = kStatusTone[status] || "neutral";
  // A skipped-but-ok probe is routine noise, not a green checkmark.
  if (event?.details?.skipped) tone = "neutral";
  return {
    label,
    detail,
    tone,
    // Human word for assistive tech — internal tone names ("danger") are
    // jargon when read aloud.
    toneLabel: kToneAriaLabels[tone] || "Event",
    summary: detail ? `${label} — ${detail}` : label,
  };
};

// Dual-register tooltip: the local+offset half disambiguates DST folds (two
// events can share a wall-clock time); the ISO half keeps UTC reachable in
// the UI for escalation.
export const buildIncidentTimeTooltip = (value) => {
  const formatted = formatLocaleDateTimeWithZone(value, { fallback: "" });
  if (!formatted) return "";
  let raw = null;
  if (typeof value === "string") {
    raw = value;
  } else if (value instanceof Date || typeof value === "number") {
    try {
      raw = new Date(value).toISOString();
    } catch {
      raw = null;
    }
  }
  return typeof raw === "string" ? `${formatted} · ${raw}` : formatted;
};

const kSeverityBadgeTone = {
  critical: "danger",
  warning: "warning",
};

// Keys mirror the server tracker's incident-key enum
// (kIncidentKeyByTrigger values in lib/server/watchdog-incidents.js); the
// drift-pin test extracts that enum from source and asserts coverage here.
export const kTriggerTitles = {
  gateway_crash: "Gateway crash",
  gateway_degraded: "Gateway degraded",
  crash_loop: "Crash loop",
  config_error: "Configuration error",
  safe_mode: "Safe mode",
  channel_rollback: "Release rollback",
};

const kOutcomeLabels = {
  recovered: "recovered",
  abandoned: "interrupted by restart",
};

// Deterministic incident card model from the server rollup — e.g.
// "Crash loop → rolled back · resolved in 8m".
export const buildIncidentCardModel = (incident = null, nowMs = Date.now()) => {
  if (!incident || typeof incident !== "object") return null;
  const summary =
    incident.summary && typeof incident.summary === "object"
      ? incident.summary
      : {};
  const unreadable = !!summary.unreadable;
  const trigger = summary.trigger || incident.incidentKey || "gateway_degraded";
  const titleParts = [kTriggerTitles[trigger] || humanizeEventType(trigger)];
  if (Array.isArray(summary.actions) && summary.actions.includes("channel_rollback")) {
    titleParts.push("→ rolled back");
  } else if (
    Array.isArray(summary.actions) &&
    summary.actions.includes("repair")
  ) {
    titleParts.push("→ repaired");
  }
  const open = incident.status === "open";
  const severity = unreadable ? "warning" : summary.severity || "warning";
  const durationMs = open
    ? Math.max(0, nowMs - (Date.parse(incident.openedAt) || nowMs))
    : Number(summary.durationMs);
  let outcome;
  if (open) {
    outcome = "ongoing";
  } else if (unreadable) {
    outcome = "record unreadable";
  } else {
    const label = kOutcomeLabels[summary.outcome] || incident.status;
    outcome = Number.isFinite(durationMs)
      ? `${label} in ${formatDurationLongMs(durationMs)}`
      : label;
  }
  return {
    id: incident.id,
    open,
    title: titleParts.join(" "),
    severity,
    badgeTone: open ? "info" : kSeverityBadgeTone[severity] || "neutral",
    badgeLabel: open ? "Ongoing" : severity,
    outcome,
    openedAt: incident.openedAt,
    openedAgo: formatRelativeTime(incident.openedAt, { nowMs }),
    eventCount: Number(incident.eventCount) || 0,
    eventsPruned: !open && Number(incident.eventCount) === 0,
    overseer: incident.overseer || null,
  };
};

// Load-more merge: the first page polls while older pages are cached — merge
// by id (dedup on refresh), newest first.
export const mergeIncidentPages = (pages = []) => {
  const byId = new Map();
  for (const page of pages) {
    for (const incident of page || []) {
      if (incident && Number.isInteger(incident.id)) {
        byId.set(incident.id, incident);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
};

// Deep-link arrival: `/#/watchdog?incident=<id>`. Pure over the hash string;
// garbage never throws, it just returns null.
export const parseIncidentAnchor = (hash = "") => {
  const raw = String(hash || "");
  const queryIndex = raw.indexOf("?");
  if (queryIndex === -1) return null;
  try {
    const params = new URLSearchParams(raw.slice(queryIndex + 1));
    const value = String(params.get("incident") || "").trim();
    const incidentId = Number.parseInt(value, 10);
    return Number.isInteger(incidentId) &&
      incidentId > 0 &&
      String(incidentId) === value
      ? incidentId
      : null;
  } catch {
    return null;
  }
};
