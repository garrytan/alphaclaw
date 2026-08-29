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
  // EX_CONFIG inside a stabilization window goes straight to rollback with no
  // crash/config_error event — the rollback request itself must open the
  // incident or that critical outage leaves zero record.
  channel_rollback: "channel_rollback",
};

const isRecord = (value) => value != null && typeof value === "object";

const classifyEvent = (event = {}) => {
  const eventType = String(event.eventType || "");
  const status = String(event.status || "");
  const details = isRecord(event.details) ? event.details : {};
  if (eventType === "crash") return "open";
  if (eventType === "config_error") return "open";
  if (eventType === "channel_rollback") return "open";
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

  // Routine lifecycle messages (opened/resolved/adopted/abandoned) log at
  // info level; logger.error stays reserved for the fail-open branches so
  // real tracker failures stand out in the logs.
  const logInfo = (message) => {
    try {
      (logger.info || logger.log || (() => {})).call(logger, message);
    } catch {}
  };

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
    logInfo(
      `[watchdog-incidents] resolved incident #${incidentId} (${summary.trigger}, ${summary.severity}, ${summary.durationMs != null ? Math.round(summary.durationMs / 1000) + "s" : "unknown duration"})`,
    );
    activeIncidentId = null;
    rollup = null;
  };

  // Wraps the watchdog's injected event sink. Synchronous by design — the
  // sink is called from a single-threaded event loop and DatabaseSync is
  // synchronous, so open+stamp+insert can share one transaction.
  //
  // Error handling is split per phase so "fail-open" never lies:
  // - OPEN path failures roll back the whole transaction (incident row AND
  //   event), so exactly one unstamped re-insert is correct.
  // - APPEND/CLOSE path failures happen AFTER the event autocommitted — the
  //   already-persisted event id is returned, NEVER re-inserted, and a failed
  //   close keeps activeIncidentId so the next healthy tick retries it
  //   (self-healing) instead of orphaning an open row forever.
  // - An orphaned open row from a previous error (or a memory/DB split) is
  //   ADOPTED on the next open trigger — the one-open unique index must never
  //   turn one transient DB error into permanently disabled incident tracking.
  const wrapInsertEvent = (originalInsert) => (event = {}) => {
    const decision = classifyEvent(event);

    if (decision === "open" && !activeIncidentId) {
      try {
        // Adopt an orphaned open row before trying to insert a new one.
        const orphan = db.getOpenIncident();
        if (orphan) {
          activeIncidentId = orphan.id;
          rollup = startRollup(event);
          // orphan.incidentKey is already an incident key — no map lookup.
          rollup.trigger = orphan.incidentKey || rollup.trigger;
          if (orphan.openedAt) rollup.openedAt = orphan.openedAt;
          // Reseed counts/severity/actions from the orphan's already-stamped
          // events so the close-time rollup covers the WHOLE incident, not
          // just the post-adoption arc (fail-open: a failed reseed keeps the
          // fresh rollup and the list falls back to a live COUNT).
          try {
            if (typeof db.getIncidentEventTypeCounts === "function") {
              const priorCounts = db.getIncidentEventTypeCounts(orphan.id);
              for (const [eventType, total] of Object.entries(priorCounts)) {
                rollup.eventCounts[eventType] =
                  (rollup.eventCounts[eventType] || 0) + total;
                if (kCriticalEventTypes.has(eventType)) {
                  rollup.severity = "critical";
                }
                if (
                  kActionEventTypes.has(eventType) &&
                  !rollup.actions.includes(eventType)
                ) {
                  rollup.actions.push(eventType);
                }
              }
            }
          } catch {}
          logInfo(
            `[watchdog-incidents] adopted orphaned open incident #${orphan.id}`,
          );
        } else {
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
            logInfo(
              `[watchdog-incidents] opened incident #${incidentId} (${rollup.trigger})`,
            );
            return eventId;
          });
        }
      } catch (err) {
        // The open transaction rolled back (event NOT persisted) or adoption
        // failed before any insert — one unstamped insert is exactly once.
        logger.error(
          `[watchdog-incidents] open failed (fail-open): ${err.message}`,
        );
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
    }

    if (activeIncidentId) {
      // The stamped insert autocommits here; anything that throws after it
      // must NOT re-insert.
      let eventId;
      try {
        eventId = originalInsert({ ...event, incidentId: activeIncidentId });
      } catch (insertErr) {
        logger.error(
          `[watchdog-incidents] stamped insert failed, retrying unstamped: ${insertErr.message}`,
        );
        try {
          return originalInsert(event);
        } catch {
          return 0;
        }
      }
      try {
        trackEvent(event);
        if (decision === "close" && rollup?.trigger !== "safe_mode") {
          closeActive("recovered");
        } else if (
          decision === "close_safe_mode" &&
          rollup?.trigger === "safe_mode"
        ) {
          // safe_mode recovered closes only a safe-mode-triggered incident;
          // a routine healthy probe must NOT (the gateway's /health stays
          // green in safe mode by design — suppression persists).
          closeActive("recovered");
        }
      } catch (transitionErr) {
        // Close/rollup failed AFTER the event persisted: keep the incident
        // active so the next close-triggering event retries; return the id.
        logger.error(
          `[watchdog-incidents] transition failed (will retry on next event): ${transitionErr.message}`,
        );
      }
      return eventId;
    }

    try {
      return originalInsert(event);
    } catch (insertErr) {
      logger.error(
        `[watchdog-incidents] event insert failed: ${insertErr.message}`,
      );
      return 0;
    }
  };

  // Boot scan: a restart mid-incident leaves an open row from the previous
  // process. Mark them abandoned (terminal timestamp = last stamped event).
  const abandonDanglingOnBoot = () => {
    try {
      const abandoned = db.abandonOpenIncidents();
      for (const incidentId of abandoned) {
        logInfo(
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
