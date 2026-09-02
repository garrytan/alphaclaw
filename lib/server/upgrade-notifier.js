const crypto = require("crypto");
const { shouldSendNotification } = require("./notification-policy");
const { onStateDbQuiet } = require("./state-db-quiet");

// Preferred-channel routing + durable delivery on top of the watchdog
// notifier.
//
//   notify(message, {eventType, operationId, id, verbose, audit})
//     └─▶ policy gate (notification-policy.js) ─▶ suppressed? {ok:false,skipped:true}
//     └─▶ outbox.enqueue (durable, deduped by id) ─▶ flush ─▶ deliverEvent
//                                                       └─▶ policy re-check
//                                                           (suppressed →
//                                                            terminal, never
//                                                            retried)
//
//   deliverEvent routing:
//     adminTargets configured ─▶ preferred-channel targets first;
//       ALL preferred targets fail ─▶ remaining admin targets, message
//       prefixed "(fallback)" — fallback happens ONLY on delivery error,
//       never as a second copy of a success.
//     no adminTargets ─▶ today's fan-out to every paired ID (unchanged
//       default, documented).
//
//   deliverEvent result classification (consumed by notify-outbox flush):
//     ok:true  { sent, failed, failures }      ─▶ ack; failed>0 → partial event
//     ok:false { reason, failures }            ─▶ TRANSIENT: retry with backoff
//     ok:false { …, terminal:true }            ─▶ abandon now (no 48h of retries)
//       terminal ⇔ ≥1 target was tried AND every failed target reported
//       deterministic:true (Telegram 403 blocked/kicked, 400 chat-not-found,
//       parse-400 surviving the plain-text fallback). Zero resolvable targets
//       ("no_channels_delivered", no failures) stays transient — pairing or
//       tokens may appear later; 429/5xx/network/generic stay transient.
//
// notify() resolves ok:true once the event is durably queued — the outbox
// owns retries (attempt-capped), so a notifier {ok:false} is retried instead
// of silently acknowledged, and events queued just before the activation
// restart are re-drained at the next boot.
//
// The policy runs at BOTH ends: enqueue (don't queue what the operator's
// current settings suppress) and delivery (an event queued under one setting
// must not deliver up to 48h later under another via the retry loop). Both
// checks fail OPEN — a broken policy must never silence alerts — and log the
// event id + eventType only, never message content.
//
// State-DB quiet period: delivery resolves pairing targets out of the state
// db, so while the barrier holds the flush timers are cancelled and every
// scheduleFlush() is a no-op — enqueue is NEVER gated (the outbox is durable
// and lives outside the state dir), and release flushes immediately, so an
// outcome notification lands seconds after the backup finishes. The
// outbox-UNAVAILABLE direct-send path is held the same way: sending into the
// quiet period would resolve zero targets (the readers serve their
// "unavailable" fallback) and silently lose the message, so it is buffered
// in memory (bounded) and delivered when the barrier lifts.
const kFlushDebounceMs = 250;
const kPeriodicFlushMs = 60_000;
const kNotifierQuietListenerName = "upgrade-notifier";
const kAllAdminTargetsFailed = "all_admin_targets_failed";
const kHeldDirectSendReason = "state_db_quiet";
const kMaxHeldDirectSends = 50;

const isTerminalFailure = (failures) =>
  Array.isArray(failures) &&
  failures.length > 0 &&
  failures.every((failure) => failure?.deterministic === true);

const withTerminalVerdict = (result) =>
  isTerminalFailure(result?.failures) ? { ...result, terminal: true } : result;

// Per-target failure record in the notifier's uniform shape (see
// watchdog-notify.js failTarget) so both routing paths feed the same verdict.
const toTargetFailure = (target, result) => ({
  channel: target.channel,
  target: target.target,
  reason: String(result?.reason || "delivery failed"),
  errorCode: Number.isFinite(result?.errorCode) ? result.errorCode : null,
  deterministic: result?.deterministic === true,
});

const createUpgradeNotifier = ({
  notifier,
  outbox,
  operatorsStore,
  // Returns the dashboard base URL (or null). Upgrade-lifecycle messages get
  // a deep link appended so an admin reading Telegram on a phone lands
  // directly on the Upgrade page.
  getBaseUrl = () => null,
  logger = console,
  // The REAL policy is the default — an omitted injection must not silently
  // fail open. The parameter exists for tests only.
  shouldSend = shouldSendNotification,
} = {}) => {
  let flushTimer = null;
  let periodicTimer = null;
  let started = false;
  let heldForStateDbQuiet = false;
  // Direct sends (outbox unavailable) that arrived while quiet — oldest first.
  const heldDirectSends = [];

  const log = (message) => {
    try {
      logger.log?.(`[upgrade-notifier] ${message}`);
    } catch {}
  };

  // Fail-open policy consult shared by both gates: a thrown policy delivers
  // (never retries/fails), and suppression logs id + eventType only.
  const consultPolicy = (event, gate) => {
    let verdict = { ok: true };
    try {
      verdict = shouldSend(event) || { ok: true };
    } catch (error) {
      log(`policy error at ${gate} — failing open: ${error.message}`);
      return { ok: true };
    }
    if (!verdict.ok) {
      log(
        `suppressed at ${gate}: ${event?.id || "(no id)"} (${event?.eventType || "info"}) — ${verdict.reason}`,
      );
    }
    return verdict;
  };

  const deliverEvent = async (event) => {
    // Settings may have changed between enqueue and this (possibly retried)
    // delivery: re-check. VERBOSE suppression is terminal (the notice class
    // is unwanted); MASTER-toggle suppression HOLDS instead — a brief
    // notifications-off window must not destroy alerts queued while they
    // were on (adversarial review F1): held events redeliver after
    // re-enable, and the 48h age-out still bounds them. Old outbox entries
    // lack the verbose/audit fields → undefined → important → delivered.
    const verdict = consultPolicy(event, "flush");
    if (!verdict.ok) {
      if (verdict.reason === "notifications_disabled") {
        return { ok: false, held: true, reason: verdict.reason };
      }
      return { ok: false, suppressed: true, reason: verdict.reason };
    }
    let message = event.message;
    if (event.operationId || event.eventType === "upgrade_failed") {
      try {
        const baseUrl = String(getBaseUrl() || "").trim().replace(/\/+$/, "");
        // The SPA uses hash routing — /upgrade 404s at the server; the
        // in-app route is /#/upgrade (same shape as the watchdog's links).
        if (baseUrl) message = `${message}\n🔗 ${baseUrl}/#/upgrade`;
      } catch {}
    }
    const opts = { eventType: event.eventType };
    let prefs = { preferredChannel: null, adminTargets: [] };
    try {
      prefs = operatorsStore?.read?.().notifications || prefs;
    } catch {}
    const adminTargets = Array.isArray(prefs.adminTargets)
      ? prefs.adminTargets
      : [];
    if (adminTargets.length === 0) {
      const result = await notifier.notify(message, opts);
      return result?.ok ? result : withTerminalVerdict(result);
    }
    // A preferred channel that matches no configured target is a
    // misconfiguration, not a delivery failure — treat every target as
    // primary (no "(fallback)" prefix) and log it.
    let preferred = prefs.preferredChannel
      ? adminTargets.filter((t) => t.channel === prefs.preferredChannel)
      : adminTargets;
    if (preferred.length === 0) {
      log(
        `preferred channel "${prefs.preferredChannel}" matches no admin target — delivering to all targets as primary`,
      );
      preferred = adminTargets;
    }
    const rest = adminTargets.filter((t) => !preferred.includes(t));
    const failures = [];
    let delivered = 0;
    for (const target of preferred) {
      const result = await notifier.sendToTarget(target, message);
      if (result?.ok) {
        delivered += 1;
        continue;
      }
      failures.push(toTargetFailure(target, result));
      log(`delivery failed (${target.channel}:${target.target}): ${result?.reason}`);
    }
    if (delivered > 0) {
      return { ok: true, sent: delivered, failed: failures.length, failures };
    }
    for (const target of rest) {
      const result = await notifier.sendToTarget(
        target,
        `(fallback) ${message}`,
      );
      if (result?.ok) {
        delivered += 1;
        continue;
      }
      failures.push(toTargetFailure(target, result));
      log(`fallback delivery failed (${target.channel}:${target.target}): ${result?.reason}`);
    }
    if (delivered > 0) {
      return { ok: true, sent: delivered, failed: failures.length, failures, fallback: true };
    }
    return withTerminalVerdict({
      ok: false,
      reason: kAllAdminTargetsFailed,
      sent: 0,
      failed: failures.length,
      failures,
    });
  };

  const flush = () => outbox.flush({ deliver: deliverEvent });

  const scheduleFlush = () => {
    if (flushTimer || heldForStateDbQuiet) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, kFlushDebounceMs);
    flushTimer.unref?.();
  };

  const clearFlushTimers = () => {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  const armPeriodicFlush = () => {
    if (periodicTimer || heldForStateDbQuiet) return;
    periodicTimer = setInterval(() => {
      flush().catch(() => {});
    }, kPeriodicFlushMs);
    periodicTimer.unref?.();
  };

  // Best-effort by construction: the outbox was already unavailable when
  // these were held, so there is nothing durable to fall back to — a failed
  // delivery is logged, never retried.
  const flushHeldDirectSends = async () => {
    const pending = heldDirectSends.splice(0, heldDirectSends.length);
    if (pending.length === 0) return;
    log(`delivering ${pending.length} direct send(s) held during the quiet period`);
    for (const event of pending) {
      try {
        const result = await deliverEvent(event);
        if (!result?.ok) {
          log(
            `held direct send failed (${event.eventType}): ${result?.reason || "delivery failed"}`,
          );
        }
      } catch (error) {
        log(`held direct send threw (${event.eventType}): ${error.message}`);
      }
    }
  };

  const holdDirectSend = (event) => {
    if (heldDirectSends.length >= kMaxHeldDirectSends) {
      const dropped = heldDirectSends.shift();
      log(
        `held direct-send buffer full (${kMaxHeldDirectSends}) — dropping oldest (${dropped.eventType})`,
      );
    }
    heldDirectSends.push(event);
    return { ok: true, held: true, reason: kHeldDirectSendReason };
  };

  const unsubscribeStateDbQuiet = onStateDbQuiet({
    name: kNotifierQuietListenerName,
    begin: () => {
      heldForStateDbQuiet = true;
      clearFlushTimers();
      log("holding flushes while the state db is quiet");
    },
    end: () => {
      heldForStateDbQuiet = false;
      if (started) armPeriodicFlush();
      log("state db quiet period over — flushing held events");
      flushHeldDirectSends()
        .catch(() => {})
        .then(() => flush())
        .catch(() => {});
    },
  });

  const notify = async (message, opts = {}) => {
    const verdict = consultPolicy(opts, "enqueue");
    if (!verdict.ok) {
      return { ok: false, skipped: true, reason: verdict.reason };
    }
    const event = outbox.enqueue({
      id: opts.id || `evt-${crypto.randomUUID()}`,
      eventType: opts.eventType || "info",
      operationId: opts.operationId || null,
      message: String(message || ""),
      // Delivery-class flags persist in the envelope so the flush-time
      // re-check sees them (notification-policy.js documents both).
      verbose: opts.verbose === true,
      audit: opts.audit === true,
    });
    if (!event) {
      // Outbox unavailable (disk full): degrade to a direct best-effort send
      // rather than dropping the message entirely. Already behind the gate.
      const directEvent = {
        message: String(message || ""),
        eventType: opts.eventType || "info",
        verbose: opts.verbose === true,
        audit: opts.audit === true,
      };
      // While the state db is quiet, target resolution would hit the readers'
      // fallback and the send would vanish — hold it for end() instead.
      if (heldForStateDbQuiet) return holdDirectSend(directEvent);
      const direct = await deliverEvent(directEvent);
      // One public suppression contract: callers branch on `skipped` (the
      // watchdog logs skipped-vs-failed rows) — never leak the flush-gate's
      // internal `suppressed` shape from this path.
      if (direct && direct.suppressed) {
        return { ok: false, skipped: true, reason: direct.reason };
      }
      return direct;
    }
    scheduleFlush();
    return { ok: true, queued: true, id: event.id };
  };

  // Retry heartbeat + boot re-drain of anything left unacknowledged.
  const start = () => {
    if (started) return;
    started = true;
    if (heldForStateDbQuiet) return;
    flush().catch(() => {});
    armPeriodicFlush();
  };

  const stop = () => {
    started = false;
    clearFlushTimers();
    unsubscribeStateDbQuiet();
    if (heldDirectSends.length > 0) {
      // Shutdown mid-quiet with a broken outbox: nothing durable can carry
      // these across the restart — say so rather than vanish silently.
      log(`stopping with ${heldDirectSends.length} held direct send(s) undelivered`);
      heldDirectSends.length = 0;
    }
  };

  return { notify, flush, start, stop, deliverEvent };
};

module.exports = { createUpgradeNotifier };
