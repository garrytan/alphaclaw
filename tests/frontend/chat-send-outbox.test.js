import { describe, expect, it, vi } from "vitest";
import {
  createSendOutbox,
  kAckTimeoutMs,
  kBusyRecheckMs,
  kMaxAutoAttempts,
  kOutboxMaxBytes,
} from "../../lib/public/js/components/chat/send-outbox.js";

const kStorageKey = "alphaclaw.chat.sendOutbox";

// In-memory localStorage stand-in (Map-backed, same getItem/setItem contract).
const makeStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
};

const makeOutbox = (overrides = {}) => {
  const { storage = makeStorage(), nowRef = { now: 1_000_000 }, ...rest } = overrides;
  let uuidCounter = 0;
  const outbox = createSendOutbox({
    storage,
    storageKey: kStorageKey,
    now: () => nowRef.now,
    uuid: () => {
      uuidCounter += 1;
      return `cm-${uuidCounter}`;
    },
    // Fixed 0.5 makes the ±15% jitter factor exactly 1.0: backoff is exact.
    random: () => 0.5,
    ...rest,
  });
  return { outbox, storage, nowRef };
};

const readStored = (storage) => JSON.parse(storage.getItem(kStorageKey) || "[]");

describe("frontend/chat send-outbox (durable send)", () => {
  it("enqueue persists first and the item is durable", () => {
    const { outbox, storage, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "hello there" });
    expect(item.clientMsgId).toBe("cm-1");
    expect(item.status).toBe("queued");

    // Persist-first: storage already holds the item right after enqueue.
    const stored = readStored(storage);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      clientMsgId: "cm-1",
      sessionKey: "s1",
      content: "hello there",
      status: "queued",
      createdAt: 1_000_000,
    });

    // A brand-new outbox over the SAME storage (page reload) restores the
    // item — but as `failed`, never auto-sent.
    const reborn = makeOutbox({ storage, nowRef });
    const restored = reborn.outbox.restoreOnLoad();
    expect(restored).toHaveLength(1);
    expect(restored[0].clientMsgId).toBe("cm-1");
    expect(restored[0].content).toBe("hello there");
    expect(restored[0].status).toBe("failed");
    expect(restored[0].lastError.code).toBe("restored");
    expect(restored[0].lastError.retryable).toBe(true);
  });

  it("restore keeps failed and unknown items as-is", () => {
    const storage = makeStorage();
    storage.setItem(
      kStorageKey,
      JSON.stringify([
        {
          clientMsgId: "f1",
          sessionKey: "s1",
          content: "already failed",
          createdAt: 900_000,
          status: "failed",
          attempts: 5,
          nextAttemptAt: 0,
          ackedAt: 0,
          sentAt: 0,
          lastError: { code: "boom", message: "hard failure", retryable: false },
        },
        {
          clientMsgId: "u1",
          sessionKey: "s1",
          content: "fate unknown",
          createdAt: 901_000,
          status: "unknown",
          attempts: 2,
          nextAttemptAt: 0,
          ackedAt: 0,
          sentAt: 0,
          lastError: { code: "unknown_outcome", message: "", retryable: false },
        },
      ]),
    );
    const { outbox } = makeOutbox({ storage });
    const restored = outbox.restoreOnLoad();
    expect(restored).toHaveLength(2);
    const failed = restored.find((entry) => entry.clientMsgId === "f1");
    const unknown = restored.find((entry) => entry.clientMsgId === "u1");
    // Terminal statuses pass through untouched — no "restored" overwrite.
    expect(failed.status).toBe("failed");
    expect(failed.lastError.code).toBe("boom");
    expect(unknown.status).toBe("unknown");
    expect(unknown.lastError.code).toBe("unknown_outcome");
  });

  it("content survives ack and started — only confirm/discard remove it", () => {
    const { outbox, storage, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "precious words" });

    outbox.markInflight(item.clientMsgId);
    expect(outbox.listAll()[0].status).toBe("inflight");
    expect(outbox.listAll()[0].content).toBe("precious words");

    outbox.markAcked(item.clientMsgId);
    const acked = outbox.listAll()[0];
    expect(acked.status).toBe("acked");
    expect(acked.ackedAt).toBe(nowRef.now);
    // Ack is a display state — the full content is still held, in memory AND
    // on disk (a gateway crash after `started` must leave it recoverable).
    expect(acked.content).toBe("precious words");
    expect(readStored(storage)[0].content).toBe("precious words");

    outbox.confirmDelivered(item.clientMsgId);
    expect(outbox.listAll()).toHaveLength(0);

    // Discard is the other removal path.
    const second = outbox.enqueue({ sessionKey: "s1", content: "discard me" });
    outbox.discard(second.clientMsgId);
    expect(outbox.listAll()).toHaveLength(0);
    expect(outbox.nextEligible("s1")).toBeNull();
  });

  it("ack timeout requeues with backoff until the cap, then parks failed", () => {
    const { outbox, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "hi" });

    // 2s * 2^(attempts-1), jitter factor exactly 1.0 with random()=0.5.
    const expectedBackoffs = [2_000, 4_000, 8_000, 16_000];
    for (const backoff of expectedBackoffs) {
      outbox.markInflight(item.clientMsgId);
      nowRef.now += kAckTimeoutMs;
      expect(outbox.sweepAckTimeouts()).toBe(true);
      const current = outbox.listAll()[0];
      expect(current.status).toBe("queued");
      expect(current.nextAttemptAt).toBeGreaterThan(nowRef.now);
      expect(current.nextAttemptAt).toBe(nowRef.now + backoff);
      nowRef.now = current.nextAttemptAt;
    }

    // Fifth attempt hits kMaxAutoAttempts: the next timeout parks it failed.
    outbox.markInflight(item.clientMsgId);
    expect(outbox.listAll()[0].attempts).toBe(kMaxAutoAttempts);
    nowRef.now += kAckTimeoutMs;
    expect(outbox.sweepAckTimeouts()).toBe(true);
    const parked = outbox.listAll()[0];
    expect(parked.status).toBe("failed");
    expect(parked.lastError.code).toBe("ack_timeout");
    // Content still intact for the manual Retry chip.
    expect(parked.content).toBe("hi");
  });

  it("session_busy never consumes attempts", () => {
    const { outbox, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "hi" });
    outbox.markInflight(item.clientMsgId);
    expect(outbox.listAll()[0].attempts).toBe(1);

    outbox.markFailed(item.clientMsgId, { code: "session_busy", message: "busy" });
    const busy = outbox.listAll()[0];
    expect(busy.status).toBe("queued");
    expect(busy.attempts).toBe(0);
    expect(busy.nextAttemptAt).toBe(nowRef.now + kBusyRecheckMs);
  });

  it("unknown_outcome parks as unknown (manual only)", () => {
    const { outbox, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "schroedinger" });
    outbox.markInflight(item.clientMsgId);
    outbox.markFailed(item.clientMsgId, { code: "unknown_outcome" });
    expect(outbox.listAll()[0].status).toBe("unknown");

    // No sweep or eligibility path ever touches an unknown item.
    nowRef.now += 10 * kAckTimeoutMs;
    expect(outbox.sweepAckTimeouts()).toBe(false);
    expect(outbox.listAll()[0].status).toBe("unknown");
    expect(outbox.nextEligible("s1")).toBeNull();

    // Manual retry re-queues with a clean slate AND a fresh clientMsgId:
    // the bridge replays an unknown terminal for the same id for its whole
    // dedupe window, which would turn the explicit Retry into a no-op loop.
    const originalId = String(item.clientMsgId);
    outbox.retry(originalId);
    const retried = outbox.listAll()[0];
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(0);
    expect(retried.nextAttemptAt).toBe(0);
    expect(retried.lastError).toBeNull();
    expect(retried.clientMsgId).not.toBe(originalId);
    expect(retried.content).toBe("schroedinger");
    expect(outbox.nextEligible("s1")).toBe(retried);
  });

  it("manual retry of a FAILED item keeps its clientMsgId (dedupe-safe path)", () => {
    const { outbox } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "keep id" });
    outbox.markInflight(item.clientMsgId);
    outbox.markFailed(item.clientMsgId, { code: "gateway_unavailable", retryable: false });
    // Non-retryable classified failure parks as failed; explicit Retry reuses
    // the id — error terminals fall through to a fresh send server-side.
    const failedId = outbox.listAll()[0].clientMsgId;
    outbox.retry(failedId);
    expect(outbox.listAll()[0].clientMsgId).toBe(failedId);
    expect(outbox.listAll()[0].status).toBe("queued");
  });

  it("retryable failures auto-requeue until the cap", () => {
    const { outbox, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "hi" });

    const expectedBackoffs = [2_000, 4_000, 8_000, 16_000];
    for (const backoff of expectedBackoffs) {
      outbox.markInflight(item.clientMsgId);
      outbox.markFailed(item.clientMsgId, {
        code: "gateway_unavailable",
        retryable: true,
      });
      const current = outbox.listAll()[0];
      expect(current.status).toBe("queued");
      expect(current.nextAttemptAt).toBe(nowRef.now + backoff);
      nowRef.now = current.nextAttemptAt;
    }

    // Attempt 5 == kMaxAutoAttempts: even a retryable failure parks it.
    outbox.markInflight(item.clientMsgId);
    outbox.markFailed(item.clientMsgId, {
      code: "gateway_unavailable",
      retryable: true,
    });
    expect(outbox.listAll()[0].status).toBe("failed");
    expect(outbox.listAll()[0].lastError.code).toBe("gateway_unavailable");

    // Non-retryable fails immediately on the first attempt.
    const second = outbox.enqueue({ sessionKey: "s1", content: "hopeless" });
    outbox.markInflight(second.clientMsgId);
    outbox.markFailed(second.clientMsgId, { code: "hard_stop", retryable: false });
    const failed = outbox.listAll().find((entry) => entry.clientMsgId === second.clientMsgId);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);
  });

  it("nextEligible respects nextAttemptAt and session scoping", () => {
    const { outbox, nowRef } = makeOutbox();
    const a = outbox.enqueue({ sessionKey: "s1", content: "for session 1" });
    const b = outbox.enqueue({ sessionKey: "s2", content: "for session 2" });

    expect(outbox.nextEligible("s1").clientMsgId).toBe(a.clientMsgId);
    expect(outbox.nextEligible("s2").clientMsgId).toBe(b.clientMsgId);

    // Put s1's item into backoff: not eligible until nextAttemptAt passes.
    outbox.markInflight(a.clientMsgId);
    outbox.markFailed(a.clientMsgId, { code: "session_busy" });
    expect(outbox.listAll()[0].status).toBe("queued");
    expect(outbox.nextEligible("s1")).toBeNull();
    // Session scoping: s2 is unaffected by s1's backoff.
    expect(outbox.nextEligible("s2").clientMsgId).toBe(b.clientMsgId);

    nowRef.now += kBusyRecheckMs;
    expect(outbox.nextEligible("s1").clientMsgId).toBe(a.clientMsgId);
  });

  it("cancel only from queued, never inflight", () => {
    const { outbox } = makeOutbox();
    const queued = outbox.enqueue({ sessionKey: "s1", content: "recall me" });
    expect(outbox.cancel(queued.clientMsgId)).toBe("recall me");
    expect(outbox.listAll()).toHaveLength(0);
    expect(outbox.nextEligible("s1")).toBeNull();

    // An inflight item cannot be recalled (cancel-vs-flush race excluded).
    const sent = outbox.enqueue({ sessionKey: "s1", content: "already flushing" });
    outbox.markInflight(sent.clientMsgId);
    expect(outbox.cancel(sent.clientMsgId)).toBeNull();
    expect(outbox.listAll()).toHaveLength(1);
    expect(outbox.listAll()[0].status).toBe("inflight");
  });

  it("merge-on-fresh-read survives a second tab's write", () => {
    const storage = makeStorage();
    const nowRef = { now: 1_000_000 };
    const tabA = makeOutbox({ storage, nowRef }).outbox;
    const tabB = makeOutbox({
      storage,
      nowRef,
      uuid: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `tabB-${n}`;
        };
      })(),
    }).outbox;

    const fromA = tabA.enqueue({ sessionKey: "s1", content: "written by A" });
    const fromB = tabB.enqueue({ sessionKey: "s1", content: "written by B" });

    // B's write merged onto a fresh read: A's item was not clobbered.
    let ids = readStored(storage).map((entry) => entry.clientMsgId);
    expect(ids).toContain(fromA.clientMsgId);
    expect(ids).toContain(fromB.clientMsgId);

    // A writes again from its stale snapshot (it never saw B's item): the
    // merge-on-fresh-read rule must preserve B's item through A's write-back.
    tabA.markAcked(fromA.clientMsgId);
    const stored = readStored(storage);
    ids = stored.map((entry) => entry.clientMsgId);
    expect(ids).toContain(fromA.clientMsgId);
    expect(ids).toContain(fromB.clientMsgId);
    expect(stored.find((entry) => entry.clientMsgId === fromA.clientMsgId).status).toBe(
      "acked",
    );
    expect(stored.find((entry) => entry.clientMsgId === fromB.clientMsgId).status).toBe(
      "queued",
    );
  });

  it("quota failure falls back to memory with one loud callback", () => {
    const onPersistError = vi.fn();
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const { outbox } = makeOutbox({ storage: throwingStorage, onPersistError });

    const first = outbox.enqueue({ sessionKey: "s1", content: "still safe" });
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(outbox.isMemoryOnly()).toBe(true);

    // Further writes stay silent (loud exactly once) and fully functional.
    outbox.enqueue({ sessionKey: "s1", content: "second" });
    outbox.markInflight(first.clientMsgId);
    outbox.markAcked(first.clientMsgId);
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(outbox.listAll()).toHaveLength(2);
    expect(outbox.listAll()[0].status).toBe("acked");
    expect(outbox.listAll()[0].content).toBe("still safe");
    expect(outbox.nextEligible("s1").content).toBe("second");
  });

  it("requeue refunds the attempt after a synchronous send failure", () => {
    const { outbox, nowRef } = makeOutbox();
    const item = outbox.enqueue({ sessionKey: "s1", content: "hi" });
    outbox.markInflight(item.clientMsgId);
    expect(outbox.listAll()[0].attempts).toBe(1);

    outbox.requeue(item.clientMsgId);
    const requeued = outbox.listAll()[0];
    expect(requeued.status).toBe("queued");
    // This was never a real attempt: the attempt is refunded.
    expect(requeued.attempts).toBe(0);
    expect(requeued.nextAttemptAt).toBe(nowRef.now + 1000);
  });

  it("byte cap evicts terminal items first and never balloons storage", () => {
    const { outbox, storage, nowRef } = makeOutbox();

    // Three sizable FAILED items (evictable), then a small queued one, then a
    // huge queued item that pushes the serialized list past kOutboxMaxBytes.
    const failedItems = [];
    for (let i = 0; i < 3; i += 1) {
      const item = outbox.enqueue({ sessionKey: "s1", content: "f".repeat(3_000) });
      outbox.markInflight(item.clientMsgId);
      outbox.markFailed(item.clientMsgId, { code: "evict_me", retryable: false });
      failedItems.push(item);
      nowRef.now += 1_000;
    }
    const smallQueued = outbox.enqueue({ sessionKey: "s1", content: "keep me queued" });
    nowRef.now += 1_000;
    const huge = outbox.enqueue({
      sessionKey: "s1",
      content: "h".repeat(kOutboxMaxBytes - 5_000),
    });

    // Storage never exceeds the byte cap.
    const raw = storage.getItem(kStorageKey);
    expect(raw.length).toBeLessThanOrEqual(kOutboxMaxBytes);

    // Queued items all survived; the space came from failed items only.
    const persistedIds = readStored(storage).map((entry) => entry.clientMsgId);
    expect(persistedIds).toContain(smallQueued.clientMsgId);
    expect(persistedIds).toContain(huge.clientMsgId);
    const evicted = [...failedItems, smallQueued, huge].filter(
      (item) => !persistedIds.includes(item.clientMsgId),
    );
    expect(evicted.length).toBeGreaterThan(0);
    for (const item of evicted) expect(item.status).toBe("failed");
    // Oldest failed items go first.
    expect(persistedIds).not.toContain(failedItems[0].clientMsgId);
  });

  it("clearAll wipes memory and storage", () => {
    const { outbox, storage } = makeOutbox();
    outbox.enqueue({ sessionKey: "s1", content: "member A's draft" });
    outbox.enqueue({ sessionKey: "s2", content: "member A's other draft" });
    expect(readStored(storage)).toHaveLength(2);

    outbox.clearAll();
    expect(outbox.listAll()).toHaveLength(0);
    expect(storage.getItem(kStorageKey)).toBeNull();
  });
});

describe("send-outbox: socket-death requeue and live-eviction warning", () => {
  it("requeueAllInflight returns every inflight item to queued, immediately eligible", async () => {
    const { createSendOutbox } = await import(
      "../../lib/public/js/components/chat/send-outbox.js"
    );
    const nowRef = { now: 1_000_000 };
    let uuidCounter = 0;
    const outbox = createSendOutbox({
      storage: null,
      storageKey: "t",
      now: () => nowRef.now,
      uuid: () => `rq-${(uuidCounter += 1)}`,
      random: () => 0.5,
    });
    const a = outbox.enqueue({ sessionKey: "s1", content: "one" });
    const b = outbox.enqueue({ sessionKey: "s2", content: "two" });
    outbox.markInflight(a.clientMsgId);
    outbox.markInflight(b.clientMsgId);
    outbox.requeueAllInflight();
    const items = outbox.listAll();
    expect(items.map((item) => item.status)).toEqual(["queued", "queued"]);
    expect(outbox.nextEligible("s1")?.clientMsgId).toBe(a.clientMsgId);
    expect(outbox.nextEligible("s2")?.clientMsgId).toBe(b.clientMsgId);
  });

  it("requeueAllInflight holds ACKED items for history confirmation; releaseAwaitingHistory re-queues the unconfirmed (F127)", async () => {
    // The socket died after ack but before a terminal. A blind close-relative
    // timer re-sent past the bridge's 10-minute dedupe window — a duplicate
    // turn. Acked items now wait for the reconnect's history merge: confirmed
    // ones are removed by the merge, only the rest go back to queued.
    const { createSendOutbox } = await import(
      "../../lib/public/js/components/chat/send-outbox.js"
    );
    const nowRef = { now: 1_000_000 };
    let uuidCounter = 0;
    const outbox = createSendOutbox({
      storage: null,
      storageKey: "t",
      now: () => nowRef.now,
      uuid: () => `ra-${(uuidCounter += 1)}`,
      random: () => 0.5,
    });
    const item = outbox.enqueue({ sessionKey: "s1", content: "acked one" });
    const other = outbox.enqueue({ sessionKey: "s2", content: "acked two" });
    outbox.markInflight(item.clientMsgId);
    outbox.markAcked(item.clientMsgId);
    outbox.markInflight(other.clientMsgId);
    outbox.markAcked(other.clientMsgId);
    outbox.requeueAllInflight();
    // Still acked (not queued), stamped as awaiting history; nothing eligible.
    expect(outbox.listAll().map((i) => i.status)).toEqual(["acked", "acked"]);
    expect(outbox.listAll()[0].awaitingHistoryAt).toBe(nowRef.now);
    expect(outbox.nextEligible("s1")).toBeNull();
    nowRef.now += 60_000;
    expect(outbox.nextEligible("s1")).toBeNull();

    // History for s1 merged and did NOT confirm the item → re-queued now.
    expect(outbox.releaseAwaitingHistory("s1")).toBe(true);
    expect(outbox.nextEligible("s1")?.clientMsgId).toBe(item.clientMsgId);
    expect(outbox.listAll().find((i) => i.clientMsgId === item.clientMsgId).awaitingHistoryAt).toBeUndefined();
    // s2 is untouched until ITS history answers…
    expect(outbox.nextEligible("s2")).toBeNull();
    // …or the staleness fallback releases everything older than the bound.
    expect(outbox.releaseAwaitingHistory("", { force: true, olderThanMs: 120_000 })).toBe(false);
    nowRef.now += 60_001;
    expect(outbox.releaseAwaitingHistory("", { force: true, olderThanMs: 120_000 })).toBe(true);
    expect(outbox.nextEligible("s2")?.clientMsgId).toBe(other.clientMsgId);
    // Confirmed delivery beats the gate: a confirmed item simply disappears.
    outbox.confirmDelivered(item.clientMsgId);
    expect(outbox.listAll().map((i) => i.clientMsgId)).toEqual([other.clientMsgId]);
  });

  it("sweepAckTimeouts reports each timed-out item so the run state can leave pendingSend (F124)", async () => {
    const { createSendOutbox, kAckTimeoutMs } = await import(
      "../../lib/public/js/components/chat/send-outbox.js"
    );
    const nowRef = { now: 1_000_000 };
    let uuidCounter = 0;
    const outbox = createSendOutbox({
      storage: null,
      storageKey: "t",
      now: () => nowRef.now,
      uuid: () => `to-${(uuidCounter += 1)}`,
      random: () => 0.5,
    });
    const item = outbox.enqueue({ sessionKey: "s9", content: "lost ack" });
    outbox.markInflight(item.clientMsgId);
    const timeouts = [];
    nowRef.now += kAckTimeoutMs;
    expect(outbox.sweepAckTimeouts({ onTimeout: (info) => timeouts.push(info) })).toBe(true);
    expect(timeouts).toEqual([{ clientMsgId: item.clientMsgId, sessionKey: "s9" }]);
    // A throwing callback never breaks the sweep.
    outbox.markInflight(item.clientMsgId);
    nowRef.now += kAckTimeoutMs;
    expect(() =>
      outbox.sweepAckTimeouts({
        onTimeout: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    expect(outbox.listAll()[0].status).toBe("queued");
  });

  it("warns loudly when the byte cap is forced to evict a LIVE item from storage", async () => {
    const { createSendOutbox, kOutboxMaxBytes } = await import(
      "../../lib/public/js/components/chat/send-outbox.js"
    );
    const backing = new Map();
    const storage = {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, value),
      removeItem: (key) => backing.delete(key),
    };
    const persistErrors = [];
    let uuidCounter = 0;
    const outbox = createSendOutbox({
      storage,
      storageKey: "t-evict",
      now: () => 1_000_000,
      uuid: () => `ev-${(uuidCounter += 1)}`,
      random: () => 0.5,
      onPersistError: (err) => persistErrors.push(String(err?.message || err)),
    });
    // Two queued items whose combined serialized size exceeds the byte cap:
    // no terminal items exist, so the eviction must sacrifice a LIVE one —
    // and say so (a reload would lose it).
    outbox.enqueue({ sessionKey: "s1", content: "x".repeat(kOutboxMaxBytes / 2) });
    outbox.enqueue({ sessionKey: "s1", content: "y".repeat(kOutboxMaxBytes / 2 + 1024) });
    expect(persistErrors.length).toBeGreaterThan(0);
    expect(persistErrors[0]).toContain("evicted a live item");
    // Both items still live in memory for this session.
    expect(outbox.listForSession("s1")).toHaveLength(2);
  });
});
