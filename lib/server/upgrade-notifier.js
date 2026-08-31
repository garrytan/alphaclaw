const crypto = require("crypto");
const { shouldSendNotification } = require("./notification-policy");

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
const kFlushDebounceMs = 250;
const kPeriodicFlushMs = 60_000;

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
    // delivery: re-check, and terminally suppress instead of delivering a
    // notice the operator has since opted out of. Old outbox entries lack the
    // verbose/audit fields → undefined → important → delivered (unchanged).
    const verdict = consultPolicy(event, "flush");
    if (!verdict.ok) {
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
      return notifier.notify(message, opts);
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
    let delivered = 0;
    for (const target of preferred) {
      const result = await notifier.sendToTarget(target, message);
      if (result?.ok) delivered += 1;
      else log(`delivery failed (${target.channel}:${target.target}): ${result?.reason}`);
    }
    if (delivered > 0) return { ok: true, sent: delivered };
    for (const target of rest) {
      const result = await notifier.sendToTarget(
        target,
        `(fallback) ${message}`,
      );
      if (result?.ok) delivered += 1;
      else log(`fallback delivery failed (${target.channel}:${target.target}): ${result?.reason}`);
    }
    return delivered > 0
      ? { ok: true, sent: delivered, fallback: true }
      : { ok: false, reason: "all_admin_targets_failed" };
  };

  const flush = () => outbox.flush({ deliver: deliverEvent });

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, kFlushDebounceMs);
    flushTimer.unref?.();
  };

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
      const direct = await deliverEvent({
        message: String(message || ""),
        eventType: opts.eventType || "info",
        verbose: opts.verbose === true,
        audit: opts.audit === true,
      });
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
    if (periodicTimer) return;
    flush().catch(() => {});
    periodicTimer = setInterval(() => {
      flush().catch(() => {});
    }, kPeriodicFlushMs);
    periodicTimer.unref?.();
  };

  const stop = () => {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  return { notify, flush, start, stop, deliverEvent };
};

module.exports = { createUpgradeNotifier };
