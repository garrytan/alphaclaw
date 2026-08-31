// Durable send outbox — the client half of "a typed message is never lost".
// Patterned on lib/server/notify-outbox.js: persist-first, dedupe-by-id,
// exponential backoff via nextAttemptAt, merge-on-fresh-read write-back (a
// second tab's enqueue must never be clobbered by this tab's stale snapshot).
//
// Ownership contract (D9a): the draft is cleared only after enqueue succeeds;
// from then on the outbox owns the text. Item CONTENT is retained until the
// message is history-confirmed or terminally failed — ack/started are display
// states only (a gateway crash after `started` but before persisting the user
// message must still leave the text recoverable).
//
// Statuses: queued → inflight → acked → (confirmed = removed)
//                     ↓ failed (manual Retry/Discard) / unknown (manual only)
// After a reload, restored non-terminal items become `failed` — never
// auto-sent (a reload must not surprise-send stale messages).
//
// Pure module: storage/now/uuid injected; node-env tests drive it directly.

export const kOutboxMaxItems = 50;
export const kOutboxMaxBytes = 2 * 1024 * 1024;
export const kAckTimeoutMs = 10_000;
export const kRetryBaseMs = 2_000;
export const kRetryMaxMs = 30_000;
export const kMaxAutoAttempts = 5;
export const kBusyRecheckMs = 5_000;

const kPersistedStatuses = new Set(["queued", "inflight", "acked", "failed", "unknown"]);

// Jittered exponential backoff shared by the retryable-failure and
// ack-timeout paths.
const nextRetryDelayMs = (attempts, random) =>
  Math.round(
    Math.min(kRetryBaseMs * 2 ** (Math.max(1, attempts) - 1), kRetryMaxMs) *
      (0.85 + 0.3 * random()),
  );

export const createSendOutbox = ({
  storage = null,
  // No default: the literal lives in lib/storage-keys.js only (a silently
  // diverging copy would orphan persisted outbox data on rename).
  storageKey,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  random = () => Math.random(),
  onPersistError = () => {},
  onChange = () => {},
} = {}) => {
  let items = [];
  let memoryOnly = storage === null;
  // Removal tombstones: merge-on-fresh-read must not resurrect an item this
  // tab confirmed/discarded from another tab's (or our own) stale storage
  // copy — a delivered message must never reappear as "failed" after reload.
  const removedIds = new Set();

  const readPersisted = () => {
    if (memoryOnly) return null;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.clientMsgId) : [];
    } catch {
      return [];
    }
  };

  const serializedSize = (list) => {
    try {
      return JSON.stringify(list).length;
    } catch {
      return Infinity;
    }
  };

  // Merge-on-fresh-read (the notify-outbox rule): another tab may have
  // written since our last read — merge by clientMsgId, our copy wins for
  // ids we own, then evict terminal items first when over the caps.
  const persist = () => {
    if (memoryOnly) {
      onChange(items);
      return;
    }
    try {
      const fresh = readPersisted() || [];
      const merged = new Map();
      for (const item of fresh) merged.set(item.clientMsgId, item);
      for (const item of items) {
        if (item.memoryOnly) continue;
        merged.set(item.clientMsgId, item);
      }
      for (const removedId of removedIds) merged.delete(removedId);
      let list = Array.from(merged.values()).sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
      );
      const evictable = () =>
        list.findIndex((item) => item.status === "failed" || item.status === "unknown");
      let evictedLive = false;
      while (
        list.length > kOutboxMaxItems ||
        (list.length > 0 && serializedSize(list) > kOutboxMaxBytes)
      ) {
        const terminalIndex = evictable();
        if (terminalIndex < 0) evictedLive = true;
        list.splice(terminalIndex >= 0 ? terminalIndex : 0, 1);
      }
      if (evictedLive) {
        // A live (queued/inflight) item lost its DURABLE copy to the byte cap
        // — it still exists in this tab's memory, but a reload would lose it.
        // Same loud-degradation surface as a quota failure.
        onPersistError(new Error("outbox byte cap evicted a live item"));
      }
      storage.setItem(storageKey, JSON.stringify(list));
    } catch (err) {
      // Quota exceeded / private mode: fall back to in-memory so every
      // in-session guarantee still holds — but say so, loudly, once.
      if (!memoryOnly) {
        memoryOnly = true;
        onPersistError(err);
      }
    }
    onChange(items);
  };

  const findItem = (clientMsgId) =>
    items.find((item) => item.clientMsgId === String(clientMsgId || "")) || null;

  const enqueue = ({ sessionKey, content }) => {
    const item = {
      clientMsgId: uuid(),
      sessionKey: String(sessionKey || ""),
      content: String(content || ""),
      createdAt: now(),
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      ackedAt: 0,
      sentAt: 0,
      lastError: null,
    };
    items.push(item);
    persist();
    return item;
  };

  const markInflight = (clientMsgId) => {
    const item = findItem(clientMsgId);
    if (!item || item.status !== "queued") return null;
    item.status = "inflight";
    item.sentAt = now();
    item.attempts += 1;
    persist();
    return item;
  };

  const markAcked = (clientMsgId) => {
    const item = findItem(clientMsgId);
    if (!item) return;
    item.status = "acked";
    item.ackedAt = now();
    item.lastError = null;
    persist();
  };

  const markFailed = (clientMsgId, { code = "", message = "", retryable = false } = {}) => {
    const item = findItem(clientMsgId);
    if (!item) return;
    item.lastError = { code, message, retryable };
    if (code === "session_busy") {
      // Another run (possibly another tab's) owns the session — wait for its
      // terminal on a gentle recheck cycle; NEVER consume auto-retry attempts
      // (server dedupe makes repeats harmless).
      item.status = "queued";
      item.attempts = Math.max(0, item.attempts - 1);
      item.nextAttemptAt = now() + kBusyRecheckMs;
    } else if (code === "unknown_outcome") {
      item.status = "unknown";
    } else if (retryable && item.attempts < kMaxAutoAttempts) {
      item.status = "queued";
      item.nextAttemptAt = now() + nextRetryDelayMs(item.attempts, random);
    } else {
      item.status = "failed";
    }
    persist();
  };

  // Ack timeout: an inflight item whose ack never came goes back to queued
  // (auto-retry — the bridge dedupes by clientMsgId, so a retry can never
  // duplicate a turn) until the attempt cap, then parks as failed.
  const sweepAckTimeouts = () => {
    const nowMs = now();
    let changed = false;
    for (const item of items) {
      if (item.status !== "inflight") continue;
      if (nowMs - item.sentAt < kAckTimeoutMs) continue;
      changed = true;
      if (item.attempts >= kMaxAutoAttempts) {
        item.status = "failed";
        item.lastError = {
          code: "ack_timeout",
          message: "The server did not acknowledge this message.",
          retryable: true,
        };
      } else {
        item.status = "queued";
        item.nextAttemptAt = nowMs + nextRetryDelayMs(item.attempts, random);
      }
    }
    if (changed) persist();
    return changed;
  };

  const confirmDelivered = (clientMsgId) => {
    const before = items.length;
    const id = String(clientMsgId || "");
    items = items.filter((item) => item.clientMsgId !== id);
    if (items.length !== before) {
      removedIds.add(id);
      persist();
    }
  };

  // Manual affordances (failed/unknown chips).
  const retry = (clientMsgId) => {
    const item = findItem(clientMsgId);
    if (!item || (item.status !== "failed" && item.status !== "unknown")) return;
    item.status = "queued";
    item.attempts = 0;
    item.nextAttemptAt = 0;
    item.lastError = null;
    persist();
  };

  const discard = (clientMsgId) => confirmDelivered(clientMsgId);

  // Cancel returns the content ONLY when the item is still atomically queued
  // (excludes the cancel-vs-flush race — an inflight item cannot be recalled).
  const cancel = (clientMsgId) => {
    const item = findItem(clientMsgId);
    if (!item || item.status !== "queued") return null;
    const content = item.content;
    confirmDelivered(clientMsgId);
    return content;
  };

  const nextEligible = (sessionKey) => {
    const nowMs = now();
    return (
      items.find(
        (item) =>
          item.sessionKey === String(sessionKey || "") &&
          item.status === "queued" &&
          (item.nextAttemptAt || 0) <= nowMs,
      ) || null
    );
  };

  const listForSession = (sessionKey) =>
    items.filter((item) => item.sessionKey === String(sessionKey || ""));

  // A flush whose ws.send failed synchronously (socket just closed): refund
  // the attempt and requeue shortly — this was never a real attempt.
  const requeue = (clientMsgId) => {
    const item = findItem(clientMsgId);
    if (!item || item.status !== "inflight") return;
    item.status = "queued";
    item.attempts = Math.max(0, item.attempts - 1);
    item.nextAttemptAt = now() + 1000;
    persist();
  };

  // Socket died before terminals arrived: inflight AND acked items go back
  // to queued (same clientMsgId — the bridge dedupes, so the retry is safe:
  // a still-live record re-acks and re-attaches this socket to its stream, a
  // terminal row replays the outcome). NOT requeueing acked items strands
  // them: their run's terminal went to the dead socket and pending runs are
  // never advertised in hello.activeRuns.
  const requeueAllInflight = () => {
    let changed = false;
    for (const item of items) {
      if (item.status !== "inflight" && item.status !== "acked") continue;
      // Acked items get a short hold: the reconnect history merge usually
      // CONFIRMS delivery (removing the item) before this fires — resending
      // is then dedupe-safe but pointless, and past the bridge's 10-minute
      // dedupe window it would be a real duplicate.
      const wasAcked = item.status === "acked";
      item.status = "queued";
      item.nextAttemptAt = wasAcked ? now() + 5000 : 0;
      changed = true;
    }
    if (changed) persist();
  };

  // Reload restore (D5): non-terminal items become `failed` — a reload never
  // auto-sends stale messages; boot-reconciled unknowns stay unknown.
  const restoreOnLoad = () => {
    const persisted = readPersisted();
    if (!persisted) return items;
    items = persisted
      .filter((item) => kPersistedStatuses.has(String(item.status || "")))
      .map((item) => {
        if (item.status === "unknown" || item.status === "failed") return item;
        return {
          ...item,
          status: "failed",
          lastError: {
            code: "restored",
            message: "Not sent — this message was pending when the page closed.",
            retryable: true,
          },
        };
      });
    persist();
    return items;
  };

  // Logout hygiene: queued message content must not survive member changes on
  // a shared origin.
  const clearAll = () => {
    items = [];
    removedIds.clear();
    if (!memoryOnly) {
      try {
        storage.removeItem(storageKey);
      } catch {}
    }
    onChange(items);
  };

  return {
    enqueue,
    markInflight,
    markAcked,
    markFailed,
    sweepAckTimeouts,
    confirmDelivered,
    retry,
    discard,
    cancel,
    nextEligible,
    listForSession,
    listAll: () => items.slice(),
    requeue,
    requeueAllInflight,
    restoreOnLoad,
    clearAll,
    isMemoryOnly: () => memoryOnly,
  };
};
