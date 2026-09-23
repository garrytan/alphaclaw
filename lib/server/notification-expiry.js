const { kNotifyOutboxMaxAgeMs } = require("./constants");

const kOverseerNotificationMaxAgeMs = 60 * 60 * 1000;
const validTimestamp = (value) => typeof value === "number" && value >= 0 &&
  Number.isFinite(new Date(value).getTime());
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Missing fields on a NEW event get one clock stamp. Old persisted records
// must carry their original creation time; malformed times fail closed.
const notificationTiming = (event = {}, {
  now = Date.now(), legacy = false, maxAgeMs = kNotifyOutboxMaxAgeMs,
} = {}) => {
  const lifetime = event.eventType === "overseer"
    ? Math.min(maxAgeMs, kOverseerNotificationMaxAgeMs) : maxAgeMs;
  if (legacy && !hasOwn(event, "createdAt")) return { createdAt: 0, expiresAt: 0 };
  const createdAt = hasOwn(event, "createdAt") ? event.createdAt : legacy ? 0 : now;
  if (!validTimestamp(createdAt)) return { createdAt: 0, expiresAt: 0 };
  const naturalExpiry = createdAt + lifetime;
  const expiresAt = hasOwn(event, "expiresAt")
    ? validTimestamp(event.expiresAt) ? Math.min(event.expiresAt, naturalExpiry) : 0
    : naturalExpiry;
  return { createdAt, expiresAt };
};

const notificationExpired = (event, now = Date.now()) =>
  !validTimestamp(event?.expiresAt) || now >= event.expiresAt;

// Source records keep this stamp even after their bounded outbox tombstone
// is pruned. A repeated stable id cannot become a fresh hour of notifications.
const overseerNotificationTiming = (record = {}, now = Date.now()) => {
  if (hasOwn(record || {}, "notifyExpiresAt")) {
    if (hasOwn(record, "notifyCreatedAt") && !validTimestamp(record.notifyCreatedAt)) {
      return { createdAt: 0, expiresAt: 0 };
    }
    const expiresAt = validTimestamp(record.notifyExpiresAt) ? record.notifyExpiresAt : 0;
    const createdAt = validTimestamp(record.notifyCreatedAt)
      ? record.notifyCreatedAt : Math.max(0, expiresAt - kOverseerNotificationMaxAgeMs);
    return notificationTiming({ eventType: "overseer", createdAt, expiresAt }, { now });
  }
  if (record?.state === "done" && (record.notifyOutcome == null || record.notifyOutcome !== "not_attempted")) {
    return notificationTiming({ eventType: "overseer", createdAt: record.at }, { now });
  }
  return notificationTiming({ eventType: "overseer" }, { now });
};

const expiredDelivery = ({ sent = 0, failures = [], skipped = 0 } = {}) => ({
  ok: sent > 0, sent, failed: failures.length, failures, skippedTargets: skipped,
  expired: true, ...(sent === 0 ? { suppressed: true } : {}), reason: "expired",
});

module.exports = {
  kOverseerNotificationMaxAgeMs, validTimestamp, notificationTiming,
  notificationExpired, overseerNotificationTiming, expiredDelivery,
};
