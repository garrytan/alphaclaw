const crypto = require("crypto");
const { shouldSendNotification } = require("./notification-policy");
const { notificationTiming, notificationExpired, expiredDelivery } = require("./notification-expiry");

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
//       deterministic:true (Telegram 403 blocked/kicked/deactivated, 400
//       chat-not-found ONLY for a pairing-store fan-out target — for an
//       allowFrom-fallback or admin target it means "never messaged the bot"
//       and stays retryable — and a parse-400 surviving the plain-text
//       fallback). Zero resolvable targets ("no_channels_delivered", no
//       failures) stays transient — pairing or tokens may appear later;
//       429/5xx/network/generic stay transient.
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
const kAllAdminTargetsFailed = "all_admin_targets_failed";

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
  logger = console,
  nowFn = () => outbox?.now?.() ?? Date.now(),
  // The REAL policy is the default — an omitted injection must not silently
  // fail open. The parameter exists for tests only.
  shouldSend = shouldSendNotification,
} = {}) => {
  let flushTimer = null;
  let periodicTimer = null;
  let started = false;

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
    Object.assign(event, notificationTiming(event, { now: nowFn() }));
    const shouldDeliver = () => !notificationExpired(event, nowFn());
    if (!shouldDeliver()) return expiredDelivery();
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
    const message = event.message;
    const opts = { eventType: event.eventType, shouldDeliver };
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
    for (const [index, target] of preferred.entries()) {
      if (!shouldDeliver()) return expiredDelivery({ sent: delivered, failures, skipped: preferred.length - index });
      const result = await notifier.sendToTarget(target, message, { shouldDeliver });
      if (result?.expired) return expiredDelivery({ sent: delivered, failures, skipped: preferred.length - index });
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
    for (const [index, target] of rest.entries()) {
      if (!shouldDeliver()) return expiredDelivery({ sent: delivered, failures, skipped: rest.length - index });
      const result = await notifier.sendToTarget(
        target,
        `(fallback) ${message}`,
        { shouldDeliver },
      );
      if (result?.expired) return expiredDelivery({ sent: delivered, failures, skipped: rest.length - index });
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
    if (flushTimer) return;
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
    if (periodicTimer) return;
    periodicTimer = setInterval(() => {
      flush().catch(() => {});
    }, kPeriodicFlushMs);
    periodicTimer.unref?.();
  };

  const notify = async (message, opts = {}) => {
    // Capture identity and lifetime BEFORE policy or an in-memory hold. The
    // same object travels through direct delivery if durable enqueue fails.
    const envelope = {
      id: opts.id || `evt-${crypto.randomUUID()}`,
      eventType: opts.eventType || "info",
      operationId: opts.operationId || null,
      message: String(message || ""),
      verbose: opts.verbose === true, audit: opts.audit === true,
      ...notificationTiming(opts, { now: nowFn() }),
    };
    const expired = notificationExpired(envelope, nowFn());
    const verdict = expired ? { ok: false, reason: "expired" } : consultPolicy(envelope, "enqueue");
    if (!verdict.ok) {
      // A suppressed overseer is still history. Keeping its timestamp means
      // a later re-enable/duplicate cannot reset the one-hour lifetime.
      if (envelope.eventType === "overseer") {
        const retained = outbox.enqueue({ ...envelope,
          suppressedAt: nowFn(), suppressedReason: verdict.reason });
        if (expired) outbox.noteExpired?.(retained || envelope);
      }
      return { ok: false, skipped: true, reason: verdict.reason };
    }
    const event = outbox.enqueue(envelope);
    if (!event) {
      const direct = await deliverEvent(envelope);
      if (direct?.expired) outbox.noteExpired?.(envelope, direct);
      if (direct?.suppressed && !direct.ok) {
        return { ok: false, skipped: true, reason: direct.reason,
          ...(direct.expired ? { expired: true, sent: direct.sent, failed: direct.failed, failures: direct.failures } : {}) };
      }
      return direct;
    }
    if (event.suppressedReason === "expired" || notificationExpired(event, nowFn())) {
      outbox.noteExpired?.(event);
      scheduleFlush();
      return { ok: false, skipped: true, reason: "expired" };
    }
    scheduleFlush();
    return { ok: true, queued: true, id: event.id };
  };

  // Retry heartbeat + boot re-drain of anything left unacknowledged.
  const start = () => {
    if (started) return;
    started = true;
    flush().catch(() => {});
    armPeriodicFlush();
  };

  const stop = () => {
    started = false;
    clearFlushTimers();
  };

  return { notify, flush, start, stop, deliverEvent };
};

module.exports = { createUpgradeNotifier };
