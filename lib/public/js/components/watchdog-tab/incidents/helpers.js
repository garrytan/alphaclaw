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
  repair_attempt: "Doctor attempt",
  recovery: "Gateway recovered",
  config_error: "Configuration error",
  safe_mode: "Safe mode",
  safe_mode_resume: "Channels resumed",
  channel_rollback: "Release rollback",
  forward_recovery: "Forward recovery",
  notification: "Notification sent",
  operation: "Gateway operation",
  readiness_degraded: "Readiness degraded",
  readiness_probe_error: "Readiness probe error",
  serving_identity_lost: "Gateway process lost",
  medic: "Startup medic",
  autotune: "Resource autotune",
  memory: "Memory monitor",
  overseer_review: "Overseer review",
  // Written by the prelaunch-hook handler (createGatewayPrelaunchHookHandler
  // → recordOperationEvent kind "prelaunch_hook") and the notify path's
  // eventType — the source-extracted pin above only sees logEvent literals,
  // so this label is pinned explicitly in watchdog-incidents-ui.test.js.
  prelaunch_hook: "Prelaunch hook",
  // Written once per boot by the boot-report server phase (lib/server/
  // boot-report-steps.js, not a watchdog.js logEvent literal) — pinned by
  // hand in watchdog-incidents-ui.test.js like prelaunch_hook.
  boot: "Boot verdict",
  // Issue #76 A3/A4: the crash classifier's follow-up row (corroboration
  // verdict) and the latched version-mismatch signal.
  crash_cause: "Crash cause",
  version_mismatch: "Version mismatch",
  // Stage 3 (#76 B1.3): the scoped auto-repair pause latching (a critical
  // event; the structural ladder's own rows ride the `repair` label).
  auto_repair_paused: "Auto-repair paused",
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

// Rows whose status column alone misleads: a relaunch writes `requested` at
// spawn and `ok {verified: true}` only once the new child is proven to be the
// process answering the port; a green probe while readiness or an unverified
// replacement is pending is "up" but NOT a recovery; a probe-detected process
// death is a crash the watchdog never saw exit. Both the timeline text
// (describeEvent) and the status dot (getIncidentStatusTone) read this one
// table so they can never disagree.
export const describeEventOutcome = (event = {}) => {
  const eventType = String(event?.eventType || "").trim().toLowerCase();
  const status = String(event?.status || "").trim().toLowerCase();
  const source = String(event?.source || "").trim().toLowerCase();
  const details =
    event?.details && typeof event.details === "object" ? event.details : {};
  if (eventType === "health_check" && status === "ok") {
    if (details.replacementPending) {
      return { phrase: "up, replacement unverified", tone: "warning" };
    }
    if (details.readinessPending) {
      return { phrase: "up, not ready", tone: "warning" };
    }
    return null;
  }
  if (eventType === "restart") {
    if (status === "requested") {
      return { phrase: "relaunch requested", tone: "info" };
    }
    if (status === "ok" && details.verified === true) {
      return { phrase: "replacement verified", tone: "success" };
    }
    return null;
  }
  if (eventType === "crash" && source === "probe_death") {
    return { phrase: "process vanished without an exit event", tone: "danger" };
  }
  // Crash-cause rows (#76 A3): stderr only SUGGESTS a cause; the row says
  // whether an independent fact agreed. A suspected cause is a warning, a
  // corroborated one is the danger the structural ladder acts on.
  if (eventType === "crash_cause") {
    const cause = typeof details.cause === "string" && details.cause
      ? details.cause.replaceAll("_", " ")
      : "unknown";
    if (details.corroborated === true) {
      const by = typeof details.by === "string" && details.by
        ? ` (by ${details.by.replaceAll("_", " ")})`
        : "";
      return { phrase: `confirmed: ${cause}${by}`, tone: "danger" };
    }
    return { phrase: `suspected: ${cause} — not corroborated`, tone: "warning" };
  }
  // Version-mismatch rows (#76 A4): running vs expected is the whole story.
  if (eventType === "version_mismatch") {
    const running = details.running || "unknown";
    const expected = details.expected || "unknown";
    return { phrase: `running ${running}, expected ${expected}`, tone: "danger" };
  }
  // Boot verdict rows: the status alone reads as a pass/fail; name the
  // findings (the persisted kBootVerdicts vocabulary) so the timeline says
  // WHY a boot was inconsistent without opening boot-report.json.
  if (eventType === "boot") {
    const verdict = Array.isArray(details.verdict)
      ? details.verdict.filter((entry) => typeof entry === "string" && entry)
      : [];
    if (verdict.length) {
      return {
        phrase: `inconsistent: ${verdict.map((entry) => entry.replaceAll("_", " ")).join(", ")}`,
        tone: "danger",
      };
    }
    return { phrase: "consistent", tone: "success" };
  }
  return null;
};

// One salient detail per event, pulled from the details JSON the server
// already writes — replaces the raw JSON.stringify dump.
const salientDetail = (event = {}) => {
  const details =
    event.details && typeof event.details === "object" ? event.details : {};
  if (details.unreadable) return "record unreadable";
  // Overseer audit rows: the payload IS the verdict (or why no verdict came).
  if (details.mode === "situation" || details.mode === "incident") {
    const kind = details.mode === "situation" ? "situation report" : "incident review";
    if (details.unavailableReason) {
      return `${kind} refused: ${String(details.unavailableReason).replaceAll("_", " ")}`;
    }
    if (details.verdict) return `${kind}: ${String(details.verdict).replaceAll("_", " ")}`;
    return kind;
  }
  if (details.skipped) {
    if (details.startupGraceActive) return "skipped (startup grace)";
    if (details.expectedRestartActive) return "skipped (planned restart)";
    if (details.startupFailureRetryActive)
      return `skipped (startup retry ${details.startupConsecutiveFailures ?? "?"}/${details.startupFailureThreshold ?? "?"})`;
    return "skipped";
  }
  const reason = details.reason ? String(details.reason).slice(0, 160) : null;
  // Degraded-retry rows compose reason + schedule: the retry delay backs off,
  // so the failed probe alone no longer tells the operator when the next is.
  if (
    details.degradedRetry &&
    Number.isFinite(details.degradedRetry.nextDelayMs)
  ) {
    const nextRetry = `next retry in ${formatDurationLongMs(details.degradedRetry.nextDelayMs)}`;
    return reason ? `${reason} · ${nextRetry}` : nextRetry;
  }
  if (reason) return reason;
  if (details.readinessReason) return String(details.readinessReason).slice(0, 160);
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
  const salient = salientDetail(event);
  const outcome = describeEventOutcome(event);
  // The outcome phrase leads ("up, not ready · secrets"): it is the fact the
  // status column hides; the salient detail is the supporting evidence.
  const detail = outcome
    ? salient
      ? `${outcome.phrase} · ${salient}`
      : outcome.phrase
    : salient;
  let tone = outcome?.tone || kStatusTone[status] || "neutral";
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
  gateway_readiness: "Gateway not ready",
  crash_loop: "Crash loop",
  config_error: "Configuration error",
  safe_mode: "Safe mode",
  channel_rollback: "Release rollback",
  version_mismatch: "Version mismatch",
};

// Timeline dot tones — ONE table for the incidents timeline and the
// watchdog-tab status dot (same palette as upgrade-tab/timeline-card.js), so
// the same row never renders two colours depending on the surface.
export const kDotClassByTone = {
  success: "bg-green-500/90",
  danger: "bg-red-500/90",
  warning: "bg-yellow-400/90",
  info: "bg-cyan-400/90",
  neutral: "bg-gray-500/60",
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
