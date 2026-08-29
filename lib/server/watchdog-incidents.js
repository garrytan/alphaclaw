// Watchdog incident tracker — a transition observer over the watchdog's
// event sink. server.js wraps the `insertWatchdogEvent` dependency injected
// into createWatchdog with `tracker.wrapInsertEvent(...)`, so the tracker
// sees every watchdog-sourced event and NOTHING else (foreign writers —
// topic registry/discovery, release channel — call the unwrapped db function
// and are never stamped or counted).
//
// Design constraints (see docs in the wave plan):
// - NEVER touches the watchdog's in-memory openIncident()/closeIncident()/
//   sentIncidentNotifications — those form the notification-dedup seam, and
//   re-arming them causes duplicate notification storms.
// - Fail-open: any tracker DB failure must not block the watchdog's logEvent
//   path. Every entry point is wrapped; on failure the event is inserted once
//   without an incident_id.
// - Zero watchdog.js changes: the watchdog does not know this module exists.
//
// Transition table (exhaustive; first match wins):
//   OPEN (or append if already open):
//     crash · health_check/failed · config_error · safe_mode (not recovered)
//   CLOSE (only while open):
//     recovery · health_check/ok WITHOUT details.skipped ·
//     safe_mode with details.recovered when safe-mode was the only trigger
//   APPEND-ONLY (stamped while open, never transitions):
//     health_check/ok with details.skipped (grace/expected-restart windows
//     must never close an incident) · notification · restart · repair ·
//     channel_rollback · crash_loop · safe_mode_resume · anything else
//
// Severity = worst event type observed:
//   crash_loop | config_error | channel_rollback -> critical
//   crash | degraded health_check | safe_mode    -> warning

const kCriticalEventTypes = new Set([
  "crash_loop",
  "config_error",
  "channel_rollback",
]);

const kActionEventTypes = new Set([
  "repair",
  "restart",
  "channel_rollback",
  "safe_mode_resume",
]);

const kIncidentKeyByTrigger = {
  crash: "gateway_crash",
  health_check: "gateway_degraded",
  config_error: "config_error",
  safe_mode: "safe_mode",
  crash_loop: "crash_loop",
};

const isRecord = (value) => value != null && typeof value === "object";

const classifyEvent = (event = {}) => {
  const eventType = String(event.eventType || "");
  const status = String(event.status || "");
  const details = isRecord(event.details) ? event.details : {};
  if (eventType === "crash") return "open";
  if (eventType === "config_error") return "open";
  if (eventType === "health_check") {
    if (status === "failed") return "open";
    if (status === "ok" && !details.skipped) return "close";
    return "append";
  }
  if (eventType === "safe_mode") {
    return details.recovered ? "close_safe_mode" : "open";
  }
  if (eventType === "recovery") return "close";
  return "append";
};

const createWatchdogIncidentTracker = ({
  db,
  // Late-bound (the tracker is constructed BEFORE createWatchdog); both are
  // read at incident close for the incident-scoped evidence snapshot.
  getStatus = () => null,
  getResourceSample = () => null,
  nowFn = () => Date.now(),
  logger = console,
} = {}) => {
  let activeIncidentId = null;
  let rollup = null;

  const startRollup = (event) => ({
    v: 1,
    trigger:
      kIncidentKeyByTrigger[String(event.eventType || "")] || "gateway_degraded",
    openedAt: new Date(nowFn()).toISOString(),
    eventCounts: {},
    actions: [],
    severity: "warning",
    triggerDetail:
      isRecord(event.details) && event.details.reason
        ? String(event.details.reason).slice(0, 200)
        : null,
  });

  const trackEvent = (event) => {
    if (!rollup) return;
    const eventType = String(event.eventType || "");
    rollup.eventCounts[eventType] = (rollup.eventCounts[eventType] || 0) + 1;
    if (kCriticalEventTypes.has(eventType)) rollup.severity = "critical";
    if (kActionEventTypes.has(eventType) && !rollup.actions.includes(eventType)) {
      rollup.actions.push(eventType);
    }
  };

  const buildCloseSummary = (outcome) => {
    const resolvedAtIso = new Date(nowFn()).toISOString();
    const openedMs = Date.parse(rollup?.openedAt || "");
    const summary = {
      ...(rollup || { v: 1, trigger: "gateway_degraded", eventCounts: {}, actions: [], severity: "warning" }),
      outcome,
      resolvedAt: resolvedAtIso,
      durationMs: Number.isFinite(openedMs)
        ? Math.max(0, nowFn() - openedMs)
        : null,
    };
    // Incident-scoped evidence for the overseer: capture status + one
    // resource sample at CLOSE time, not review time.
    try {
      summary.statusSnapshot = getStatus() || null;
    } catch {
      summary.statusSnapshot = null;
    }
    try {
      summary.resourceSample = getResourceSample() || null;
    } catch {
      summary.resourceSample = null;
    }
    return summary;
  };

  const closeActive = (outcome) => {
    const incidentId = activeIncidentId;
    if (!incidentId) return;
    const summary = buildCloseSummary(outcome);
    db.resolveIncident(incidentId, { status: "resolved", summaryJson: summary });
    logger.error(
      `[watchdog-incidents] resolved incident #${incidentId} (${summary.trigger}, ${summary.severity}, ${summary.durationMs != null ? Math.round(summary.durationMs / 1000) + "s" : "unknown duration"})`,
    );
    activeIncidentId = null;
    rollup = null;
  };

  // Wraps the watchdog's injected event sink. Synchronous by design — the
  // sink is called from a single-threaded event loop and DatabaseSync is
  // synchronous, so open+stamp+insert can share one transaction.
  const wrapInsertEvent = (originalInsert) => (event = {}) => {
    try {
      const decision = classifyEvent(event);
      if (decision === "open" && !activeIncidentId) {
        return db.withTransaction(() => {
          const incidentId = db.insertIncident({
            incidentKey:
              kIncidentKeyByTrigger[String(event.eventType || "")] ||
              "gateway_degraded",
          });
          activeIncidentId = incidentId;
          rollup = startRollup(event);
          trackEvent(event);
          const eventId = originalInsert({ ...event, incidentId });
          logger.error(
            `[watchdog-incidents] opened incident #${incidentId} (${rollup.trigger})`,
          );
          return eventId;
        });
      }
      if (activeIncidentId) {
        const eventId = originalInsert({ ...event, incidentId: activeIncidentId });
        trackEvent(event);
        if (decision === "close") {
          closeActive("recovered");
        } else if (
          decision === "close_safe_mode" &&
          rollup?.trigger === "safe_mode"
        ) {
          // safe_mode recovered closes only a safe-mode-triggered incident;
          // inside a crash/degraded incident it is just another data point.
          closeActive("recovered");
        }
        return eventId;
      }
      return originalInsert(event);
    } catch (err) {
      // Fail-open: the transaction (if any) rolled back, so the event has not
      // been persisted — insert it exactly once without stamping. A tracker
      // failure must never block the watchdog's logEvent path.
      logger.error(`[watchdog-incidents] tracker error (fail-open): ${err.message}`);
      activeIncidentId = null;
      rollup = null;
      try {
        return originalInsert(event);
      } catch (insertErr) {
        logger.error(
          `[watchdog-incidents] event insert failed after tracker error: ${insertErr.message}`,
        );
        return 0;
      }
    }
  };

  // Boot scan: a restart mid-incident leaves an open row from the previous
  // process. Mark them abandoned (terminal timestamp = last stamped event).
  const abandonDanglingOnBoot = () => {
    try {
      const abandoned = db.abandonOpenIncidents();
      for (const incidentId of abandoned) {
        logger.error(
          `[watchdog-incidents] abandoned incident #${incidentId} (server_restart)`,
        );
      }
      return abandoned;
    } catch (err) {
      logger.error(
        `[watchdog-incidents] boot abandonment failed (fail-open): ${err.message}`,
      );
      return [];
    }
  };

  return {
    wrapInsertEvent,
    abandonDanglingOnBoot,
    getActiveIncidentId: () => activeIncidentId,
  };
};

module.exports = { createWatchdogIncidentTracker, classifyEvent };
