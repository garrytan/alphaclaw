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
//                                        └───── attempts+1, retry next flush
const kOutboxFileName = "notify-outbox.json";
const kManagedDirName = ".alphaclaw";

const createNotifyOutbox = ({
  fsModule = fs,
  openclawDir = constants.OPENCLAW_DIR,
  nowFn = Date.now,
  logger = console,
  maxAttempts = constants.kNotifyOutboxMaxAttempts,
  keepCount = constants.kNotifyOutboxKeepCount,
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
    };
  };

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
      // Cap: delivered events age out first, then oldest undelivered.
      const overflow = events.length - keepCount;
      if (overflow > 0) {
        const delivered = events.filter((entry) => entry?.deliveredAt);
        const undelivered = events.filter((entry) => !entry?.deliveredAt);
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
      return { delivered: 0, failed: 0, pending: 0 };
    }
    flushing = true;
    let delivered = 0;
    let failed = 0;
    try {
      const events = readEvents();
      const pendingEvents = events.filter(
        (entry) =>
          entry &&
          !entry.deliveredAt &&
          (entry.attempts || 0) < maxAttempts,
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
          delivered += 1;
        } else {
          event.lastError = String(
            result?.reason || result?.error || "delivery failed",
          );
          failed += 1;
          // Crossing the attempt cap permanently abandons the event — the one
          // outcome this outbox exists to prevent must never be silent.
          if (event.attempts >= maxAttempts) {
            try {
              logger.error?.(
                `[notify-outbox] GIVING UP on "${event.id}" (${event.eventType}) after ${event.attempts} attempts: ${event.lastError}. Message never delivered: ${String(event.message).slice(0, 200)}`,
              );
            } catch {}
          }
        }
      }
      if (pendingEvents.length > 0) {
        // Merge onto a FRESH read, not the stale snapshot: an enqueue during
        // the awaits above wrote a newer file, and blindly writing `events`
        // back would delete those just-queued alerts (the exact class this
        // outbox exists to guarantee). Apply our per-event deltas by id.
        const updates = new Map(pendingEvents.map((e) => [e.id, e]));
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
          entry && !entry.deliveredAt && (entry.attempts || 0) < maxAttempts,
      ).length;
      return { delivered, failed, pending };
    } catch (error) {
      log(`flush failed: ${error.message}`);
      return { delivered, failed, pending: 0 };
    } finally {
      flushing = false;
    }
  };

  const listEvents = () => readEvents();

  return { outboxPath, enqueue, flush, listEvents };
};

module.exports = { createNotifyOutbox };
