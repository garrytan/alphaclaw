const fs = require("fs");
const path = require("path");
const constants = require("./constants");

// Durable notification outbox.
//
// queueNotify used to be fire-and-forget: a send that raced the activation
// restart, or a notifier that returned {ok:false}, silently dropped the one
// message the admin most needed ("your upgrade failed"). Events are now
// persisted first and acknowledged only on a successful delivery; boot
// re-drains anything unacknowledged, deduplicated by event id.
//
//   enqueue(event) ─▶ outbox file ─▶ flush() ─▶ deliver(event) ok? ──▶ ack
//                                        │         │  failed>0 too? ─▶ ONE
//                                        │         │  `notification_partial`
//                                        │         │  event per id (partialAt)
//                                        │         ├─ suppressed? ─▶ terminal
//                                        │         │  (policy re-check at
//                                        │         │   delivery — no retry,
//                                        │         │   no abandonment alarm)
//                                        │         └─ terminal:true? ─▶ abandon
//                                        │            NOW (GIVING-UP log +
//                                        │            `notification_abandoned`)
//                                        └───── attempts+1, exponential
//                                               backoff, retry next flush
//
// Retry policy: a failed delivery defers the event by an exponential backoff
// (base delay doubling per attempt, capped) and keeps retrying — via the 60s
// periodic flush and the boot re-drain — until the event is 48h old
// (createdAt). Past that it is abandoned exactly once: one GIVING-UP log plus
// a persisted `notification_abandoned` watchdog event (via the injected
// insertEvent sink), so the loss is visible in the incidents UI even when no
// chat channel ever worked. The attempt cap is a belt only; age terminates.
// Exception: a delivery the notifier classifies as TERMINAL (every failed
// target failed deterministically — a blocked bot, a dead chat id) takes the
// same abandonment path immediately; 48h of retries cannot change it.
const kOutboxFileName = "notify-outbox.json";
const kManagedDirName = ".alphaclaw";
// Per-target failure records copied into persisted watchdog events are
// capped so a wide fan-out can't bloat the incidents row.
const kEventFailureDetailCap = 10;
const kAbandonedEventType = "notification_abandoned";
const kPartialEventType = "notification_partial";
const kOutboxEventSource = "notify-outbox";

const summarizeFailures = (failures) =>
  (Array.isArray(failures) ? failures : [])
    .slice(0, kEventFailureDetailCap)
    .map((failure) => ({
      channel: String(failure?.channel || "unknown"),
      reason: String(failure?.reason || "delivery failed"),
      errorCode: Number.isFinite(failure?.errorCode) ? failure.errorCode : null,
    }));

const listFailedChannels = (failures) =>
  Array.from(
    new Set(
      (Array.isArray(failures) ? failures : []).map((failure) =>
        String(failure?.channel || "unknown"),
      ),
    ),
  );

const createNotifyOutbox = ({
  fsModule = fs,
  openclawDir = constants.OPENCLAW_DIR,
  nowFn = Date.now,
  logger = console,
  maxAttempts = constants.kNotifyOutboxMaxAttempts,
  keepCount = constants.kNotifyOutboxKeepCount,
  maxAgeMs = constants.kNotifyOutboxMaxAgeMs,
  backoffBaseMs = constants.kNotifyOutboxBackoffBaseMs,
  backoffMaxMs = constants.kNotifyOutboxBackoffMaxMs,
  // Optional persisted-event sink (lib/server.js injects the watchdog DB's
  // insertWatchdogEvent). Best-effort: failures never break the flush.
  insertEvent = null,
} = {}) => {
  const outboxPath = path.join(openclawDir, kManagedDirName, kOutboxFileName);
  let flushing = false;

  const log = (message) => {
    try {
      logger.log?.(`[notify-outbox] ${message}`);
    } catch {}
  };

  const readEvents = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(outboxPath, "utf8"));
      return Array.isArray(parsed?.events) ? parsed.events : [];
    } catch {
      return [];
    }
  };

  const writeEvents = (events) => {
    const dir = path.dirname(outboxPath);
    fsModule.mkdirSync(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${kOutboxFileName}.${process.pid}.tmp`,
    );
    fsModule.writeFileSync(
      tempPath,
      `${JSON.stringify({ events }, null, 2)}\n`,
    );
    try {
      fsModule.renameSync(tempPath, outboxPath);
    } catch (error) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  };

  const normalizeEvent = (event) => {
    if (!event || typeof event !== "object") return null;
    const id = String(event.id || "").trim();
    const message = String(event.message || "").trim();
    if (!id || !message) return null;
    return {
      id,
      eventType: String(event.eventType || "info"),
      operationId: event.operationId || null,
      message,
      // Delivery-class flags (see notification-policy.js): consulted again at
      // flush time so a setting change between enqueue and a retried delivery
      // suppresses instead of delivering days late. Missing on old files →
      // false → important → delivered unchanged.
      verbose: event.verbose === true,
      audit: event.audit === true,
      createdAt: event.createdAt ?? nowFn(),
      attempts: Number.isFinite(event.attempts) ? event.attempts : 0,
      deliveredAt: event.deliveredAt ?? null,
      lastError: event.lastError ?? null,
      // Backoff gate: missing (old outbox files) means immediately eligible,
      // so files written before these fields existed load and drain unchanged.
      nextAttemptAt: event.nextAttemptAt ?? null,
      // Terminal give-up stamp (48h age-out, or an immediately-terminal
      // delivery verdict); never retried once set.
      abandonedAt: event.abandonedAt ?? null,
      // Set once the `notification_partial` event for this id was persisted
      // (sent>0 && failed>0) — the dedupe stamp; missing on old files → null.
      partialAt: event.partialAt ?? null,
      // Terminal policy-suppression stamp (deliverEvent returned
      // {suppressed:true} at flush): done, never retried, never counted as an
      // abandonment — the operator opted out, nothing was lost.
      suppressedAt: event.suppressedAt ?? null,
      suppressedReason: event.suppressedReason ?? null,
    };
  };

  // Terminal events (delivered, abandoned, or policy-suppressed) are done —
  // they exist only as a short audit trail and age out of the cap before
  // undelivered ones.
  const isTerminal = (entry) =>
    Boolean(entry?.deliveredAt || entry?.abandonedAt || entry?.suppressedAt);

  // Dedup by id: re-enqueueing an already-known event (boot re-drain racing a
  // live enqueue) is a no-op, never a duplicate chat message. Exception
  // (adversarial review F2): a terminally SUPPRESSED tombstone revives on a
  // fresh enqueue — the operator's settings allow the notice again (the
  // enqueue gate already passed), and a stale tombstone must not swallow
  // every future re-notify of a stable id forever. Delivered/abandoned
  // duplicates stay deduped.
  const enqueue = (event) => {
    const normalized = normalizeEvent(event);
    if (!normalized) return null;
    try {
      const events = readEvents();
      const existingIdx = events.findIndex(
        (entry) => entry?.id === normalized.id,
      );
      if (existingIdx >= 0) {
        const existing = events[existingIdx];
        if (
          existing?.suppressedAt &&
          !existing?.deliveredAt &&
          !existing?.abandonedAt
        ) {
          events[existingIdx] = normalized;
          writeEvents(events);
        }
        return normalized;
      }
      events.push(normalized);
      // Cap: terminal (delivered/abandoned) events age out first, then
      // oldest undelivered.
      const overflow = events.length - keepCount;
      if (overflow > 0) {
        const delivered = events.filter((entry) => isTerminal(entry));
        const undelivered = events.filter((entry) => !isTerminal(entry));
        const kept = [
          ...delivered.slice(Math.max(0, delivered.length - Math.max(0, keepCount - undelivered.length))),
          ...undelivered,
        ].slice(-keepCount);
        writeEvents(kept);
      } else {
        writeEvents(events);
      }
      return normalized;
    } catch (error) {
      log(`enqueue failed for ${normalized.id}: ${error.message}`);
      return null;
    }
  };

  // The single abandonment path — the 48h age-out AND an immediately-terminal
  // delivery verdict both land here: abandonedAt stamp (never retried), ONE
  // GIVING-UP log, ONE persisted `notification_abandoned` watchdog event so
  // the loss is visible in the incidents UI even when no channel works.
  const abandonEvent = (entry, now, { terminal = false, failures = null } = {}) => {
    const createdAt = Number(entry.createdAt) || 0;
    entry.abandonedAt = now;
    entry.nextAttemptAt = null;
    const why = terminal
      ? "every target failed deterministically, not retrying"
      : `over ${Math.round((now - createdAt) / 3600000)}h`;
    try {
      logger.error?.(
        `[notify-outbox] GIVING UP on "${entry.id}" (${entry.eventType}) after ${entry.attempts || 0} attempts ${why}: ${entry.lastError || "never delivered"}. Message never delivered: ${String(entry.message).slice(0, 200)}`,
      );
    } catch {}
    try {
      insertEvent?.({
        eventType: kAbandonedEventType,
        source: kOutboxEventSource,
        status: "failed",
        details: {
          id: entry.id,
          notifyEventType: entry.eventType || "info",
          attempts: entry.attempts || 0,
          ageMs: now - createdAt,
          lastError: entry.lastError || null,
          terminal,
          ...(failures ? { failures: summarizeFailures(failures) } : {}),
          message: String(entry.message).slice(0, 200),
        },
        correlationId: entry.operationId || "",
      });
    } catch (error) {
      log(`abandonment event insert failed for ${entry.id}: ${error.message}`);
    }
  };

  // sent>0 && failed>0: the operator got the alert on SOME channel, but a
  // configured one is broken — persist that once per outbox id (partialAt
  // dedupes across any retry path) so the incidents UI shows the gap.
  const recordPartialDelivery = (entry, now, result) => {
    entry.partialAt = now;
    try {
      insertEvent?.({
        eventType: kPartialEventType,
        source: kOutboxEventSource,
        status: "warning",
        details: {
          id: entry.id,
          notifyEventType: entry.eventType || "info",
          sent: Number(result.sent) || 0,
          failed: Number(result.failed) || 0,
          failedChannels: listFailedChannels(result.failures),
          failures: summarizeFailures(result.failures),
        },
        correlationId: entry.operationId || "",
      });
    } catch (error) {
      log(`partial-delivery event insert failed for ${entry.id}: ${error.message}`);
    }
  };

  // deliver(event) must resolve to a truthy `{ ok }` for the event to be
  // acknowledged; anything else counts as an attempt and retries next flush
  // — unless it says `terminal:true`, which abandons immediately.
  const flush = async ({ deliver }) => {
    if (typeof deliver !== "function" || flushing) {
      return { delivered: 0, failed: 0, abandoned: 0, suppressed: 0, partial: 0, pending: 0 };
    }
    flushing = true;
    let delivered = 0;
    let failed = 0;
    let abandoned = 0;
    let suppressed = 0;
    let partial = 0;
    try {
      const now = nowFn();
      const events = readEvents();
      // Updated entries to merge-write back, keyed by id (age-outs AND
      // delivery outcomes both ride the same fresh-read merge below).
      const updates = new Map();
      // Age-out sweep: an event still undelivered past maxAgeMs is abandoned
      // exactly once — the abandonedAt stamp keeps it out of every future
      // sweep.
      for (const entry of events) {
        if (!entry || isTerminal(entry)) continue;
        const createdAt = Number(entry.createdAt) || 0;
        if (now - createdAt < maxAgeMs) continue;
        abandonEvent(entry, now);
        abandoned += 1;
        updates.set(entry.id, entry);
      }
      const pendingEvents = events.filter(
        (entry) =>
          entry &&
          !isTerminal(entry) &&
          (entry.attempts || 0) < maxAttempts &&
          // Backoff gate: deferred events wait their turn; a missing/invalid
          // nextAttemptAt (old outbox files) compares false → eligible now.
          !(Number(entry.nextAttemptAt) > now),
      );
      for (const event of pendingEvents) {
        let result = null;
        try {
          result = await deliver(event);
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        if (result?.held) {
          // Master toggle is off right now: hold without burning an attempt
          // — the event redelivers when the operator re-enables (or ages out
          // at 48h with the visible abandonment event). One heartbeat defer
          // keeps the flush loop from re-consulting a static setting hotly.
          event.nextAttemptAt = nowFn() + backoffBaseMs;
          updates.set(event.id, event);
          continue;
        }
        event.attempts = (event.attempts || 0) + 1;
        if (result?.ok) {
          event.deliveredAt = nowFn();
          event.lastError = null;
          event.nextAttemptAt = null;
          delivered += 1;
          if ((Number(result.failed) || 0) > 0 && !event.partialAt) {
            recordPartialDelivery(event, nowFn(), result);
            partial += 1;
          }
        } else if (result?.suppressed) {
          // Policy suppressed at flush (settings changed since enqueue):
          // terminal — no retry, no backoff, and NEVER the abandonment alarm
          // (nothing was lost; the operator opted out). The reason persists
          // so the audit trail distinguishes master-disable from quiet-mode
          // suppression after a restart.
          event.suppressedAt = nowFn();
          event.suppressedReason = result.reason || null;
          event.lastError = null;
          event.nextAttemptAt = null;
          suppressed += 1;
        } else if (result?.terminal === true) {
          // Every failed target failed deterministically (blocked bot, dead
          // chat id, parse error surviving the plain fallback): no backoff
          // schedule can fix it — abandon now, loudly, via the same path the
          // 48h age-out uses.
          event.lastError = String(
            result?.reason || result?.error || "delivery failed",
          );
          failed += 1;
          abandonEvent(event, nowFn(), { terminal: true, failures: result.failures });
          abandoned += 1;
        } else {
          event.lastError = String(
            result?.reason || result?.error || "delivery failed",
          );
          failed += 1;
          // Exponential backoff: the first failure defers by the base delay,
          // doubling each attempt up to the cap. Age (48h), not the attempt
          // cap, is what ultimately gives up on an event.
          event.nextAttemptAt =
            nowFn() +
            Math.min(
              backoffBaseMs * 2 ** Math.max(0, event.attempts - 1),
              backoffMaxMs,
            );
          // Crossing the attempt cap stops retries (belt only — unreachable
          // before the 48h age-out under the default backoff constants); the
          // one outcome this outbox exists to prevent must never be silent.
          if (event.attempts >= maxAttempts) {
            try {
              logger.error?.(
                `[notify-outbox] GIVING UP on "${event.id}" (${event.eventType}) after ${event.attempts} attempts: ${event.lastError}. Message never delivered: ${String(event.message).slice(0, 200)}`,
              );
            } catch {}
          }
        }
        updates.set(event.id, event);
      }
      if (updates.size > 0) {
        // Merge onto a FRESH read, not the stale snapshot: an enqueue during
        // the awaits above wrote a newer file, and blindly writing `events`
        // back would delete those just-queued alerts (the exact class this
        // outbox exists to guarantee). Apply our per-event deltas by id.
        const current = readEvents();
        const merged = current.map((entry) => {
          const updated = entry && updates.get(entry.id);
          if (!updated) return entry;
          updates.delete(entry.id);
          return updated;
        });
        // Any delivered event that was evicted from `current` between read and
        // now is simply dropped (already delivered — nothing to preserve).
        writeEvents(merged);
      }
      const pending = readEvents().filter(
        (entry) =>
          entry && !isTerminal(entry) && (entry.attempts || 0) < maxAttempts,
      ).length;
      return { delivered, failed, abandoned, suppressed, partial, pending };
    } catch (error) {
      log(`flush failed: ${error.message}`);
      return { delivered, failed, abandoned, suppressed, partial, pending: 0 };
    } finally {
      flushing = false;
    }
  };

  const listEvents = () => readEvents();

  return { outboxPath, enqueue, flush, listEvents };
};

module.exports = { createNotifyOutbox };
