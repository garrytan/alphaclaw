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
//     crash (any source — exit_event, or probe_death for a probe-proven dead
//     adopted gateway) · health_check/failed · config_error · safe_mode (not
//     recovered) · channel_rollback (EX_CONFIG-in-stabilization rollbacks
//     arrive with no prior crash/config_error event — see
//     kIncidentKeyByTrigger) · readiness_degraded/failed (a green /health
//     over a failing /readyz is an incident of its own: gateway_readiness) ·
//     version_mismatch (issue #76 A4: the boot verdict, a corroborated
//     version-family crash cause or a diverged installed tree — with no
//     incident open it must open one, or the signal is appended to nothing)
//   CLOSE (only while open):
//     recovery · health_check/ok WITHOUT details.skipped and WITHOUT a
//     pending marker · safe_mode with details.recovered when safe-mode was
//     the only trigger
//   APPEND-ONLY (stamped while open, never transitions):
//     health_check/ok with details.skipped (grace/expected-restart windows
//     must never close an incident) · health_check/ok with
//     details.readinessPending or details.replacementPending ("up" is not
//     recovery while readiness fails or a relaunched child is unverified) ·
//     readiness_degraded/ok · readiness_probe_error · serving_identity_lost ·
//     notification · restart · repair · crash_loop · crash_cause ·
//     safe_mode_resume · anything else
//
// Severity = worst event type observed:
//   crash_loop | config_error | channel_rollback | version_mismatch |
//   auto_repair_paused -> critical
//   crash | degraded health_check | safe_mode | readiness_degraded -> warning
//   PLUS the fingerprint rule (#76 A3): ≥ kFingerprintCriticalCount events
//   inside one incident carrying the SAME details.fingerprint (the crash
//   classifier's normalized "same crash again" key) -> critical, even when
//   the crash-loop threshold was never reached (a slow loop under backoff).
// Severity is persisted the moment it escalates (updateIncidentSeverity) so
// an AlphaClaw restart mid-incident never demotes it, and the close-time
// rollup reads the persisted value back.

const kCriticalEventTypes = new Set([
  "crash_loop",
  "config_error",
  "channel_rollback",
  // #76 A4: a version mismatch is critical wherever it lands.
  "version_mismatch",
  // Stage 3 (Codex 9): latching the durable auto-repair pause escalates the
  // incident it pauses; registered now so the pause never ships as warning.
  "auto_repair_paused",
]);

// Append-only events that warm the rescue session on an ALREADY-open
// incident (the "escalation" activity kind).
const kEscalationEventTypes = new Set([
  "crash_loop",
  "version_mismatch",
  "auto_repair_paused",
]);

// Identical-fingerprint count that escalates an incident to critical.
const kFingerprintCriticalCount = 3;
const kFingerprintPattern = /^[a-f0-9]{6,64}$/;

const kActionEventTypes = new Set([
  "repair",
  "restart",
  "channel_rollback",
  "safe_mode_resume",
]);

const kIncidentKeyByTrigger = {
  crash: "gateway_crash",
  health_check: "gateway_degraded",
  readiness_degraded: "gateway_readiness",
  config_error: "config_error",
  safe_mode: "safe_mode",
  crash_loop: "crash_loop",
  // EX_CONFIG inside a stabilization window goes straight to rollback with no
  // crash/config_error event — the rollback request itself must open the
  // incident or that critical outage leaves zero record.
  channel_rollback: "channel_rollback",
  // #76 A4: the installed build is not the build the channel state chose (boot
  // verdict, corroborated crash cause, or a diverged tree at runtime).
  version_mismatch: "version_mismatch",
};

const isRecord = (value) => value != null && typeof value === "object";

const classifyEvent = (event = {}) => {
  const eventType = String(event.eventType || "");
  const status = String(event.status || "");
  const details = isRecord(event.details) ? event.details : {};
  if (eventType === "crash") return "open";
  if (eventType === "config_error") return "open";
  if (eventType === "channel_rollback") return "open";
  if (eventType === "version_mismatch") return "open";
  if (eventType === "readiness_degraded") {
    return status === "failed" ? "open" : "append";
  }
  if (eventType === "health_check") {
    if (status === "failed") return "open";
    // Liveness without recovery: readiness still failing, or the relaunched
    // child not yet proven to be the process answering — checked BEFORE the
    // close rule so an "up" row never closes what it did not resolve.
    if (
      status === "ok" &&
      (details.readinessPending || details.replacementPending)
    ) {
      return "append";
    }
    if (status === "ok" && !details.skipped) return "close";
    return "append";
  }
  if (eventType === "safe_mode") {
    return details.recovered ? "close_safe_mode" : "open";
  }
  if (eventType === "recovery") return "close";
  return "append";
};

// Episode-correlation lead: an episode freezes at pid death, moments before
// the crash opens the incident — accept summaries that ended up to this long
// before the incident opened.
const kEpisodeCorrelationLeadMs = 10 * 60 * 1000;

const createWatchdogIncidentTracker = ({
  db,
  // Late-bound (the tracker is constructed BEFORE createWatchdog); both are
  // read at incident close for the incident-scoped evidence snapshot.
  getStatus = () => null,
  getResourceSample = () => null,
  // Fired on incident open/adopt and on crash_loop escalation appends —
  // the rescue-session warm-up hook (claude-code-local). Fail-open like
  // everything else here: a throwing observer must never affect incident
  // processing, so every call site wraps it.
  onIncidentActivity = () => {},
  nowFn = () => Date.now(),
  logger = console,
} = {}) => {
  let activeIncidentId = null;
  let rollup = null;

  const notifyIncidentActivity = (kind, event) => {
    try {
      onIncidentActivity({
        kind,
        eventType: String(event?.eventType || ""),
        incidentId: activeIncidentId,
      });
    } catch {}
  };

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
    // #76 A3: per-fingerprint crash counts and the last cause record the
    // classifier stamped (see trackCause / trackFingerprint).
    fingerprints: {},
    cause: null,
  });

  // Escalate the live rollup and persist it in the same breath (fail-open:
  // the in-memory rollup escalates even when the write fails — the close-time
  // summary still carries it). Returns true when the severity CHANGED.
  const escalateSeverity = (severity) => {
    if (!rollup || rollup.severity === severity) return false;
    rollup.severity = severity;
    if (activeIncidentId && typeof db.updateIncidentSeverity === "function") {
      try {
        db.updateIncidentSeverity(activeIncidentId, severity);
      } catch (err) {
        logger.error(
          `[watchdog-incidents] severity persist failed (fail-open): ${err.message}`,
        );
      }
    }
    return true;
  };

  // Fingerprint rule: count identical crash fingerprints inside this
  // incident; the third identical one is critical (returns true exactly on
  // the escalation).
  const trackFingerprint = (details) => {
    const fingerprint =
      typeof details.fingerprint === "string" && kFingerprintPattern.test(details.fingerprint)
        ? details.fingerprint
        : null;
    if (!fingerprint || !rollup) return false;
    rollup.fingerprints = rollup.fingerprints || {};
    const count = (rollup.fingerprints[fingerprint] || 0) + 1;
    rollup.fingerprints[fingerprint] = count;
    if (count < kFingerprintCriticalCount) return false;
    return escalateSeverity("critical");
  };

  // Cause record: a crash / crash_cause row carrying details.cause updates
  // the incident's persisted cause. Precedence — a corroborated cause is never
  // overwritten by a merely suspected one; within a tier the latest wins.
  const trackCause = (details) => {
    if (!rollup || typeof details.cause !== "string" || !details.cause) return;
    const next = {
      cause: details.cause.slice(0, 64),
      fingerprint:
        typeof details.fingerprint === "string" ? details.fingerprint.slice(0, 64) : null,
      corroborated: details.corroborated === true,
      by: typeof details.by === "string" ? details.by.slice(0, 64) : null,
      suspectedCause:
        typeof details.suspectedCause === "string" ? details.suspectedCause.slice(0, 64) : null,
      at: new Date(nowFn()).toISOString(),
    };
    if (rollup.cause?.corroborated && !next.corroborated) return;
    rollup.cause = next;
    if (activeIncidentId && typeof db.updateIncidentCause === "function") {
      try {
        db.updateIncidentCause(activeIncidentId, next);
      } catch (err) {
        logger.error(
          `[watchdog-incidents] cause persist failed (fail-open): ${err.message}`,
        );
      }
    }
  };

  // Returns { escalated } — true when THIS event moved the severity to
  // critical (the caller fires the escalation hook outside any transaction).
  const trackEvent = (event) => {
    if (!rollup) return { escalated: false };
    const eventType = String(event.eventType || "");
    const details = isRecord(event.details) ? event.details : {};
    rollup.eventCounts[eventType] = (rollup.eventCounts[eventType] || 0) + 1;
    let escalated = false;
    if (kCriticalEventTypes.has(eventType)) {
      escalated = escalateSeverity("critical") || escalated;
    }
    if (kActionEventTypes.has(eventType) && !rollup.actions.includes(eventType)) {
      rollup.actions.push(eventType);
    }
    escalated = trackFingerprint(details) || escalated;
    trackCause(details);
    // Crashed-process identities inside this incident (an incident can span
    // several crashes) — episode correlation matches identity, not just time.
    if (eventType === "crash" && isRecord(event.details)) {
      const pid = Number(event.details.pid);
      if (Number.isFinite(pid) && pid > 0) {
        rollup.crashedPids = rollup.crashedPids || [];
        if (!rollup.crashedPids.includes(pid) && rollup.crashedPids.length < 20) {
          rollup.crashedPids.push(pid);
        }
      }
    }
    return { escalated };
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
    // The persisted severity is the floor: an escalation written before an
    // adoption (or by a previous process) outranks whatever this rollup saw.
    try {
      const persisted =
        activeIncidentId && typeof db.getIncidentById === "function"
          ? db.getIncidentById(activeIncidentId)?.severity
          : null;
      if (persisted === "critical") summary.severity = "critical";
    } catch {}
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
    // Episode correlation (never present an unrelated stale episode as
    // incident evidence): keep lastEpisodeSummary only when it ended inside
    // this incident's window (with a 10-minute lead — the episode freezes at
    // pid death, moments before the crash opens the incident) AND — when both
    // sides know the process identity — its pid matches one of the crashes
    // this incident tracked. Time bounds staleness; identity establishes
    // ownership. The LIVE trend stays regardless; it describes close-time
    // reality.
    try {
      const trend = summary.resourceSample?.gatewayMemoryTrend;
      const episode = trend?.lastEpisodeSummary;
      if (episode) {
        const endedMs = Date.parse(String(episode.endedAt || ""));
        const windowStart = Number.isFinite(openedMs)
          ? openedMs - kEpisodeCorrelationLeadMs
          : null;
        const inWindow =
          Number.isFinite(endedMs) &&
          windowStart !== null &&
          endedMs >= windowStart &&
          endedMs <= nowFn();
        const episodePid = Number(episode.pid);
        const crashedPids = Array.isArray(summary.crashedPids)
          ? summary.crashedPids
          : [];
        const pidMismatch =
          crashedPids.length > 0 &&
          Number.isFinite(episodePid) &&
          episodePid > 0 &&
          !crashedPids.includes(episodePid);
        if (!inWindow || pidMismatch) trend.lastEpisodeSummary = null;
      }
    } catch {}
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
          // Persisted escalation/cause survive the adoption (a fingerprint
          // escalation cannot be reseeded from event-type counts).
          if (orphan.severity === "critical") rollup.severity = "critical";
          if (isRecord(orphan.cause)) rollup.cause = orphan.cause;
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
          notifyIncidentActivity("open", event);
        } else {
          const eventId = db.withTransaction(() => {
            const incidentId = db.insertIncident({
              incidentKey:
                kIncidentKeyByTrigger[String(event.eventType || "")] ||
                "gateway_degraded",
            });
            activeIncidentId = incidentId;
            rollup = startRollup(event);
            trackEvent(event);
            const insertedId = originalInsert({ ...event, incidentId });
            logInfo(
              `[watchdog-incidents] opened incident #${incidentId} (${rollup.trigger})`,
            );
            return insertedId;
          });
          // Outside the transaction: the observer must never sit inside a
          // DB write, and a rolled-back open must never fire it.
          notifyIncidentActivity("open", event);
          return eventId;
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
      if (kEscalationEventTypes.has(String(event.eventType || ""))) {
        // Severity escalation on an already-open incident — the append-only
        // events that warm the rescue session.
        notifyIncidentActivity("escalation", event);
      }
      try {
        const tracked = trackEvent(event);
        if (
          tracked?.escalated &&
          !kEscalationEventTypes.has(String(event.eventType || ""))
        ) {
          // The fingerprint rule (or a critical event type outside the
          // escalation set) just made this incident critical — same hook,
          // fired once per escalation.
          notifyIncidentActivity("escalation", event);
        }
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

module.exports = {
  createWatchdogIncidentTracker,
  classifyEvent,
  // The overseer validates incident-history rollups against this closed set
  // before letting them ride its trusted prompt tier.
  kIncidentKeyByTrigger,
  kCriticalEventTypes,
  kFingerprintCriticalCount,
};
