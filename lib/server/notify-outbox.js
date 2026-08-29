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
//   enqueue(event) ─▶ outbox file ─▶ flush() ─▶ deliver(event) ok? ─▶ ack
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
const kOutboxFileName = "notify-outbox.json";
const kManagedDirName = ".alphaclaw";

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
      createdAt: event.createdAt ?? nowFn(),
      attempts: Number.isFinite(event.attempts) ? event.attempts : 0,
      deliveredAt: event.deliveredAt ?? null,
      lastError: event.lastError ?? null,
      // Backoff gate: missing (old outbox files) means immediately eligible,
      // so files written before these fields existed load and drain unchanged.
      nextAttemptAt: event.nextAttemptAt ?? null,
      // Terminal give-up stamp (48h age-out); never retried once set.
      abandonedAt: event.abandonedAt ?? null,
    };
  };

  // Terminal events (delivered or abandoned) are done — they exist only as a
  // short audit trail and age out of the cap before undelivered ones.
  const isTerminal = (entry) => Boolean(entry?.deliveredAt || entry?.abandonedAt);

  // Dedup by id: re-enqueueing an already-known event (boot re-drain racing a
  // live enqueue) is a no-op, never a duplicate chat message.
  const enqueue = (event) => {
    const normalized = normalizeEvent(event);
    if (!normalized) return null;
    try {
      const events = readEvents();
      if (events.some((entry) => entry?.id === normalized.id)) {
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

  // deliver(event) must resolve to a truthy `{ ok }` for the event to be
  // acknowledged; anything else counts as an attempt and retries next flush.
  const flush = async ({ deliver }) => {
    if (typeof deliver !== "function" || flushing) {
      return { delivered: 0, failed: 0, abandoned: 0, pending: 0 };
    }
    flushing = true;
    let delivered = 0;
    let failed = 0;
    let abandoned = 0;
    try {
      const now = nowFn();
      const events = readEvents();
      // Updated entries to merge-write back, keyed by id (age-outs AND
      // delivery outcomes both ride the same fresh-read merge below).
      const updates = new Map();
      // Age-out sweep: an event still undelivered past maxAgeMs is abandoned
      // exactly once — the abandonedAt stamp keeps it out of every future
      // sweep — with ONE GIVING-UP log plus a persisted watchdog event so the
      // loss is visible in the incidents UI even when no channel works.
      for (const entry of events) {
        if (!entry || isTerminal(entry)) continue;
        const createdAt = Number(entry.createdAt) || 0;
        if (now - createdAt < maxAgeMs) continue;
        entry.abandonedAt = now;
        abandoned += 1;
        try {
          logger.error?.(
            `[notify-outbox] GIVING UP on "${entry.id}" (${entry.eventType}) after ${entry.attempts || 0} attempts over ${Math.round((now - createdAt) / 3600000)}h: ${entry.lastError || "never delivered"}. Message never delivered: ${String(entry.message).slice(0, 200)}`,
          );
        } catch {}
        try {
          insertEvent?.({
            eventType: "notification_abandoned",
            source: "notify-outbox",
            status: "failed",
            details: {
              id: entry.id,
              notifyEventType: entry.eventType || "info",
              attempts: entry.attempts || 0,
              ageMs: now - createdAt,
              lastError: entry.lastError || null,
              message: String(entry.message).slice(0, 200),
            },
            correlationId: entry.operationId || "",
          });
        } catch (error) {
          log(`abandonment event insert failed for ${entry.id}: ${error.message}`);
        }
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
        event.attempts = (event.attempts || 0) + 1;
        if (result?.ok) {
          event.deliveredAt = nowFn();
          event.lastError = null;
          event.nextAttemptAt = null;
          delivered += 1;
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
      return { delivered, failed, abandoned, pending };
    } catch (error) {
      log(`flush failed: ${error.message}`);
      return { delivered, failed, abandoned, pending: 0 };
    } finally {
      flushing = false;
    }
  };

  const listEvents = () => readEvents();

  return { outboxPath, enqueue, flush, listEvents };
};

module.exports = { createNotifyOutbox };
