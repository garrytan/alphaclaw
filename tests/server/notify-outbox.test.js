const fs = require("fs");
const os = require("os");
const path = require("path");

const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const makeOutbox = (overrides = {}) => {
  const openclawDir = mkTemp("notify-outbox-test-");
  const nowRef = { now: 1_000_000 };
  const outbox = createNotifyOutbox({
    openclawDir,
    nowFn: () => nowRef.now,
    logger: kSilentLogger,
    ...overrides,
  });
  return { outbox, openclawDir, nowRef };
};

describe("server/notify-outbox", () => {
  it("deduplicates by event id — re-enqueueing never doubles a message", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "hello", eventType: "info" });
    outbox.enqueue({ id: "e1", message: "hello", eventType: "info" });
    const deliver = vi.fn(async () => ({ ok: true }));
    const result = await outbox.flush({ deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
  });

  it("acks ONLY on {ok:true}: an {ok:false} delivery is retried next flush", async () => {
    const { outbox, nowRef } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "important failure notice" });
    const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
    await outbox.flush({ deliver: failing });
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();
    expect(outbox.listEvents()[0].lastError).toBe("api down");

    // Past the backoff deferral the event is retried.
    nowRef.now += 60_000;
    const succeeding = vi.fn(async () => ({ ok: true }));
    const second = await outbox.flush({ deliver: succeeding });
    expect(second.delivered).toBe(1);
    expect(outbox.listEvents()[0].deliveredAt).toBeTruthy();

    // Already-delivered events never redeliver.
    const third = await outbox.flush({ deliver: succeeding });
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(third.delivered).toBe(0);
  });

  it("stops retrying after the attempt cap", async () => {
    const { outbox, nowRef } = makeOutbox({ maxAttempts: 2 });
    outbox.enqueue({ id: "e1", message: "msg" });
    const failing = vi.fn(async () => ({ ok: false }));
    await outbox.flush({ deliver: failing });
    nowRef.now += 60_000;
    await outbox.flush({ deliver: failing });
    nowRef.now += 120_000;
    await outbox.flush({ deliver: failing });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("a thrown deliver counts as a failed attempt, never rejects the flush", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "msg" });
    await expect(
      outbox.flush({
        deliver: async () => {
          throw new Error("socket reset");
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ failed: 1 }));
    expect(outbox.listEvents()[0].lastError).toBe("socket reset");
  });

  it("evicts delivered events before undelivered ones on overflow", async () => {
    const { outbox } = makeOutbox({ keepCount: 3 });
    outbox.enqueue({ id: "e1", message: "first" });
    outbox.enqueue({ id: "e2", message: "second" });
    await outbox.flush({ deliver: async () => ({ ok: true }) });
    // e1/e2 delivered; e3 undelivered fills the cap.
    outbox.enqueue({ id: "e3", message: "third" });
    // e4 overflows: the oldest DELIVERED event ages out, never the
    // undelivered one.
    outbox.enqueue({ id: "e4", message: "fourth" });

    const events = outbox.listEvents();
    expect(events.map((entry) => entry.id)).toEqual(["e2", "e3", "e4"]);
    expect(events.find((entry) => entry.id === "e3").deliveredAt).toBeNull();
    expect(events.find((entry) => entry.id === "e4").deliveredAt).toBeNull();
  });

  it("keeps the newest undelivered events when undelivered alone exceed keepCount", async () => {
    const { outbox } = makeOutbox({ keepCount: 3 });
    outbox.enqueue({ id: "e1", message: "first" });
    outbox.enqueue({ id: "e2", message: "second" });
    outbox.enqueue({ id: "e3", message: "third" });
    outbox.enqueue({ id: "e4", message: "fourth" });
    expect(outbox.listEvents().map((entry) => entry.id)).toEqual([
      "e2",
      "e3",
      "e4",
    ]);

    outbox.enqueue({ id: "e5", message: "fifth" });
    // Order preserved, newest kept.
    expect(outbox.listEvents().map((entry) => entry.id)).toEqual([
      "e3",
      "e4",
      "e5",
    ]);
  });

  it("does not lose an event enqueued concurrently during a flush", async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "first" });
    let enqueuedDuringFlush = false;
    const deliver = vi.fn(async () => {
      if (!enqueuedDuringFlush) {
        enqueuedDuringFlush = true;
        // A live enqueue racing the in-flight flush writes a newer file; the
        // flush's write-back must merge onto a fresh read, not clobber it.
        outbox.enqueue({ id: "e-new", message: "queued mid-flush" });
      }
      return { ok: true };
    });
    await outbox.flush({ deliver });
    const ids = outbox.listEvents().map((entry) => entry.id);
    expect(ids).toContain("e-new");
    expect(
      outbox.listEvents().find((entry) => entry.id === "e-new").deliveredAt,
    ).toBeNull();
    // The original event's delivery ack still persisted through the merge.
    expect(
      outbox.listEvents().find((entry) => entry.id === "e1").deliveredAt,
    ).toBeTruthy();
  });

  it("logs via logger.error when an event crosses maxAttempts (giving up)", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { outbox, nowRef } = makeOutbox({ maxAttempts: 2, logger });
    outbox.enqueue({ id: "e1", message: "critical upgrade failure" });
    const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
    await outbox.flush({ deliver: failing });
    expect(logger.error).not.toHaveBeenCalled();
    nowRef.now += 60_000;
    await outbox.flush({ deliver: failing });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0][0];
    expect(message).toContain("GIVING UP");
    expect(message).toContain('"e1"');
    expect(message).toContain("critical upgrade failure");
  });

  it("persists across instances (restart survival)", async () => {
    const { outbox, openclawDir, nowRef } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "queued just before restart" });
    const reborn = createNotifyOutbox({
      openclawDir,
      // Same logical clock as the pre-restart instance: with a real Date.now
      // the fixture's 1970-era createdAt would look 48h-stale and abandon.
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
    });
    const deliver = vi.fn(async () => ({ ok: true }));
    const result = await reborn.flush({ deliver });
    expect(result.delivered).toBe(1);
    expect(deliver.mock.calls[0][0].message).toBe(
      "queued just before restart",
    );
  });

  // Backoff + replay-until-age-out (#21 Bug 7): a broken box may take hours
  // to heal — the outbox must keep trying the whole time, then fail loudly.
  describe("backoff and 48h abandonment", () => {
    it("defers a failed delivery by exponential backoff (base, doubling per attempt)", async () => {
      const { outbox, nowRef } = makeOutbox();
      outbox.enqueue({ id: "e1", message: "msg" });
      const failing = vi.fn(async () => ({ ok: false, reason: "down" }));
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(1_000_000 + 60_000);

      // A flush before the deferral elapses does not attempt delivery.
      const succeeding = vi.fn(async () => ({ ok: true }));
      await outbox.flush({ deliver: succeeding });
      expect(succeeding).not.toHaveBeenCalled();

      // At the deferral boundary it retries; the second failure doubles.
      nowRef.now += 60_000;
      await outbox.flush({ deliver: failing });
      expect(failing).toHaveBeenCalledTimes(2);
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 120_000);
    });

    it("caps the backoff delay at backoffMaxMs", async () => {
      const { outbox, nowRef } = makeOutbox({
        backoffBaseMs: 100,
        backoffMaxMs: 300,
      });
      outbox.enqueue({ id: "e1", message: "msg" });
      const failing = vi.fn(async () => ({ ok: false }));
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 100);
      nowRef.now += 100;
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 200);
      nowRef.now += 200;
      await outbox.flush({ deliver: failing });
      // 100 * 2^2 = 400 → capped at 300.
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 300);
      nowRef.now += 300;
      await outbox.flush({ deliver: failing });
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 300);
    });

    it("keeps retrying past the legacy 5-attempt cap until delivery succeeds", async () => {
      const { outbox, nowRef } = makeOutbox({
        backoffBaseMs: 1,
        backoffMaxMs: 1,
      });
      outbox.enqueue({ id: "e1", message: "eventually delivered" });
      const failing = vi.fn(async () => ({ ok: false, reason: "still down" }));
      for (let i = 0; i < 10; i += 1) {
        await outbox.flush({ deliver: failing });
        nowRef.now += 2;
      }
      expect(failing).toHaveBeenCalledTimes(10);

      const succeeding = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver: succeeding });
      expect(result.delivered).toBe(1);
      expect(outbox.listEvents()[0].attempts).toBe(11);
      expect(outbox.listEvents()[0].deliveredAt).toBeTruthy();
    });

    it("abandons past 48h exactly once: one GIVING-UP log + one persisted watchdog event, never retried", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ logger, insertEvent });
      outbox.enqueue({
        id: "e1",
        message: "critical never-delivered failure",
        eventType: "upgrade_failed",
        operationId: "op-9",
      });
      const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
      await outbox.flush({ deliver: failing });
      expect(logger.error).not.toHaveBeenCalled();

      nowRef.now += 48 * 60 * 60 * 1000;
      const deliver = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.abandoned).toBe(1);
      const entry = outbox.listEvents()[0];
      expect(entry.abandonedAt).toBe(nowRef.now);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toContain("GIVING UP");
      expect(logger.error.mock.calls[0][0]).toContain('"e1"');
      expect(logger.error.mock.calls[0][0]).toContain(
        "critical never-delivered failure",
      );
      expect(insertEvent).toHaveBeenCalledTimes(1);
      expect(insertEvent.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          eventType: "notification_abandoned",
          source: "notify-outbox",
          status: "failed",
          correlationId: "op-9",
        }),
      );
      expect(insertEvent.mock.calls[0][0].details).toEqual(
        expect.objectContaining({
          id: "e1",
          notifyEventType: "upgrade_failed",
          attempts: 1,
          lastError: "api down",
        }),
      );

      // A later flush neither retries nor re-logs nor re-emits (abandonedAt
      // is terminal).
      const again = await outbox.flush({ deliver });
      expect(deliver).not.toHaveBeenCalled();
      expect(again.abandoned).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    it("a throwing insertEvent sink never breaks the abandonment flush", async () => {
      const insertEvent = vi.fn(() => {
        throw new Error("watchdog db closed");
      });
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      nowRef.now += 48 * 60 * 60 * 1000;
      const result = await outbox.flush({ deliver: async () => ({ ok: true }) });
      expect(result.abandoned).toBe(1);
      expect(outbox.listEvents()[0].abandonedAt).toBe(nowRef.now);
    });

    it("an outbox file written before backoff/abandonment existed loads and delivers unchanged", async () => {
      // Old files have neither nextAttemptAt nor abandonedAt, and may carry
      // attempts at the legacy 5-attempt cap — they must load, be eligible
      // immediately, and retry under the new policy.
      const openclawDir = mkTemp("notify-outbox-legacy-");
      const outboxPath = path.join(
        openclawDir,
        ".alphaclaw",
        "notify-outbox.json",
      );
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.writeFileSync(
        outboxPath,
        `${JSON.stringify(
          {
            events: [
              {
                id: "old-1",
                eventType: "upgrade_failed",
                operationId: null,
                message: "queued by an older alphaclaw",
                createdAt: 999_000,
                attempts: 5,
                deliveredAt: null,
                lastError: "api down",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      const outbox = createNotifyOutbox({
        openclawDir,
        nowFn: () => 1_000_000,
        logger: kSilentLogger,
      });
      const deliver = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver });
      expect(result.delivered).toBe(1);
      expect(deliver.mock.calls[0][0].id).toBe("old-1");
      expect(outbox.listEvents()[0].deliveredAt).toBe(1_000_000);
      // Legacy entries are written back as-is (no field backfill): the later
      // terminal/partial stamps are simply absent, which every reader treats
      // as "not set".
      expect(outbox.listEvents()[0].partialAt ?? null).toBeNull();
      expect(outbox.listEvents()[0].abandonedAt ?? null).toBeNull();
    });

    it("a legacy outbox entry whose delivery still fails (no terminal verdict) retries under the backoff, never abandons", async () => {
      const openclawDir = mkTemp("notify-outbox-legacy-retry-");
      const outboxPath = path.join(openclawDir, ".alphaclaw", "notify-outbox.json");
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.writeFileSync(
        outboxPath,
        `${JSON.stringify({
          events: [
            {
              id: "old-2",
              eventType: "upgrade_failed",
              operationId: null,
              message: "queued by an older alphaclaw",
              createdAt: 999_000,
              attempts: 3,
              deliveredAt: null,
              lastError: "api down",
            },
          ],
        })}\n`,
      );
      const insertEvent = vi.fn();
      const nowRef = { now: 1_000_000 };
      const outbox = createNotifyOutbox({
        openclawDir,
        nowFn: () => nowRef.now,
        logger: kSilentLogger,
        insertEvent,
      });
      // An old-style {ok:false, reason} (no failures, no terminal) is transient.
      const failing = vi.fn(async () => ({ ok: false, reason: "still down" }));
      const result = await outbox.flush({ deliver: failing });
      expect(result).toEqual(
        expect.objectContaining({ failed: 1, abandoned: 0, partial: 0 }),
      );
      const entry = outbox.listEvents()[0];
      expect(entry.abandonedAt ?? null).toBeNull();
      expect(entry.partialAt ?? null).toBeNull();
      expect(entry.attempts).toBe(4);
      expect(entry.nextAttemptAt).toBe(1_000_000 + 60_000 * 2 ** 3);
      expect(insertEvent).not.toHaveBeenCalled();
    });
  });

  // WI-3.2 / WI-3.3: the routing layer's verdict decides the outbox's fate —
  // a TERMINAL failure abandons now through the same path as the 48h age-out,
  // a partial success persists exactly one notification_partial event.
  describe("terminal verdicts and partial delivery", () => {
    const kBlocked = {
      channel: "telegram",
      target: "100",
      reason: "Forbidden: bot was blocked by the user",
      errorCode: 403,
      deterministic: true,
    };
    const kRateLimited = {
      channel: "telegram",
      target: "100",
      reason: "Too Many Requests: retry after 7",
      errorCode: 429,
      deterministic: false,
    };

    it("a terminal result abandons immediately: abandonedAt stamped, ONE GIVING-UP log, ONE notification_abandoned event with terminal:true, never retried", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ logger, insertEvent });
      outbox.enqueue({
        id: "e1",
        message: "backup failed, downgrade refused",
        eventType: "upgrade_failed",
        operationId: "op-54",
      });
      const terminal = vi.fn(async () => ({
        ok: false,
        reason: "no_channels_delivered",
        sent: 0,
        failed: 1,
        failures: [kBlocked],
        terminal: true,
      }));

      const result = await outbox.flush({ deliver: terminal });

      expect(result).toEqual(
        expect.objectContaining({ delivered: 0, failed: 1, abandoned: 1, pending: 0 }),
      );
      const entry = outbox.listEvents()[0];
      expect(entry.abandonedAt).toBe(nowRef.now);
      expect(entry.deliveredAt).toBeNull();
      expect(entry.nextAttemptAt).toBeNull();
      expect(entry.attempts).toBe(1);
      expect(entry.lastError).toBe("no_channels_delivered");
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0][0]).toContain("GIVING UP");
      expect(logger.error.mock.calls[0][0]).toContain("deterministically");
      expect(logger.error.mock.calls[0][0]).toContain('"e1"');
      expect(insertEvent).toHaveBeenCalledTimes(1);
      expect(insertEvent.mock.calls[0][0]).toEqual({
        eventType: "notification_abandoned",
        source: "notify-outbox",
        status: "failed",
        correlationId: "op-54",
        details: {
          id: "e1",
          notifyEventType: "upgrade_failed",
          attempts: 1,
          ageMs: 0,
          lastError: "no_channels_delivered",
          terminal: true,
          failures: [
            {
              channel: "telegram",
              reason: "Forbidden: bot was blocked by the user",
              errorCode: 403,
            },
          ],
          message: "backup failed, downgrade refused",
        },
      });

      // Hours later, nothing retries, re-logs or re-emits — and the 48h
      // sweep does not abandon it a second time.
      nowRef.now += 48 * 60 * 60 * 1000;
      const again = await outbox.flush({ deliver: terminal });
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(again.abandoned).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    // C9: a terminal abandonment happens after ONE attempt, so a stable-id
    // repeat notice (the daily `alphaclaw-update-<version>`) that hit a
    // blocked bot must not stay silenced forever once the operator fixes the
    // channel — a fresh same-id enqueue revives the tombstone (attempts
    // reset), and if still blocked it costs one more honest abandonment.
    it("a fresh same-id enqueue revives a TERMINAL-abandoned tombstone: new attempt, delivered once the channel works", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ logger, insertEvent });
      const stable = { id: "alphaclaw-update-1.2.3", message: "update available", eventType: "info" };
      outbox.enqueue(stable);
      const blocked = vi.fn(async () => ({
        ok: false,
        reason: "no_channels_delivered",
        failures: [kBlocked],
        terminal: true,
      }));
      await outbox.flush({ deliver: blocked });
      expect(outbox.listEvents()[0]).toMatchObject({
        abandonedAt: nowRef.now,
        abandonedTerminal: true,
        attempts: 1,
      });

      // Next day: the daily re-notify enqueues the same id — still blocked →
      // one more attempt and one more abandonment (honest, never a storm).
      nowRef.now += 24 * 60 * 60 * 1000;
      outbox.enqueue(stable);
      expect(outbox.listEvents()).toHaveLength(1);
      expect(outbox.listEvents()[0]).toMatchObject({ abandonedAt: null, attempts: 0 });
      await outbox.flush({ deliver: blocked });
      expect(blocked).toHaveBeenCalledTimes(2);
      expect(insertEvent).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledTimes(2);

      // Operator unblocks the bot; the next day's enqueue delivers.
      nowRef.now += 24 * 60 * 60 * 1000;
      outbox.enqueue(stable);
      const ok = vi.fn(async () => ({ ok: true }));
      const result = await outbox.flush({ deliver: ok });
      expect(result.delivered).toBe(1);
      expect(outbox.listEvents()[0]).toMatchObject({
        deliveredAt: nowRef.now,
        abandonedAt: null,
        abandonedTerminal: false,
      });
      // Delivered: a further same-id enqueue is the plain dedupe again.
      outbox.enqueue(stable);
      await outbox.flush({ deliver: ok });
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it("a 48h age-out tombstone (terminal:false) stays deduped on a same-id enqueue", async () => {
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      nowRef.now += 48 * 60 * 60 * 1000 + 1;
      await outbox.flush({ deliver: vi.fn(async () => ({ ok: false, reason: "down" })) });
      expect(outbox.listEvents()[0]).toMatchObject({
        abandonedAt: nowRef.now,
        abandonedTerminal: false,
      });
      outbox.enqueue({ id: "e1", message: "msg" });
      expect(outbox.listEvents()[0].abandonedAt).toBe(nowRef.now);
      const deliver = vi.fn(async () => ({ ok: true }));
      await outbox.flush({ deliver });
      expect(deliver).not.toHaveBeenCalled();
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    it("an old outbox file without abandonedTerminal loads as an age-out tombstone (deduped, never revived)", () => {
      const { outbox, openclawDir } = makeOutbox();
      const outboxPath = path.join(openclawDir, ".alphaclaw", "notify-outbox.json");
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.writeFileSync(
        outboxPath,
        JSON.stringify({
          events: [
            { id: "legacy", message: "m", eventType: "info", createdAt: 1, abandonedAt: 2 },
          ],
        }),
      );
      // listEvents is the raw file: the marker is simply absent on old files,
      // and an absent marker means "age-out semantics" — no revival.
      expect(outbox.listEvents()[0].abandonedTerminal).toBeUndefined();
      outbox.enqueue({ id: "legacy", message: "m", eventType: "info" });
      expect(outbox.listEvents()[0].abandonedAt).toBe(2);
      expect(outbox.listEvents()).toHaveLength(1);
    });

    it("the 48h age-out still labels its abandonment terminal:false", async () => {
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      nowRef.now += 48 * 60 * 60 * 1000;
      await outbox.flush({ deliver: async () => ({ ok: true }) });
      expect(insertEvent.mock.calls[0][0].details).toEqual(
        expect.objectContaining({ terminal: false }),
      );
      expect(insertEvent.mock.calls[0][0].details).not.toHaveProperty("failures");
    });

    it("a transient failure (429, non-terminal) keeps the 60s→1h backoff and never abandons", async () => {
      const insertEvent = vi.fn();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { outbox, nowRef } = makeOutbox({ insertEvent, logger });
      outbox.enqueue({ id: "e1", message: "msg" });
      const rateLimited = vi.fn(async () => ({
        ok: false,
        reason: "no_channels_delivered",
        sent: 0,
        failed: 1,
        failures: [kRateLimited],
      }));

      await outbox.flush({ deliver: rateLimited });
      expect(outbox.listEvents()[0].abandonedAt).toBeNull();
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 60_000);
      nowRef.now += 60_000;
      await outbox.flush({ deliver: rateLimited });
      expect(rateLimited).toHaveBeenCalledTimes(2);
      expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 120_000);
      expect(insertEvent).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("a terminal verdict on a later retry still abandons through the same path", async () => {
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      await outbox.flush({
        deliver: async () => ({ ok: false, reason: "down", failures: [kRateLimited] }),
      });
      nowRef.now += 60_000;
      const result = await outbox.flush({
        deliver: async () => ({
          ok: false,
          reason: "no_channels_delivered",
          failures: [kBlocked],
          terminal: true,
        }),
      });
      expect(result.abandoned).toBe(1);
      expect(outbox.listEvents()[0].attempts).toBe(2);
      expect(outbox.listEvents()[0].abandonedAt).toBe(nowRef.now);
      expect(insertEvent.mock.calls[0][0].details.attempts).toBe(2);
    });

    it("failures in the abandonment event are capped at 10 records", async () => {
      const insertEvent = vi.fn();
      const { outbox } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      const failures = Array.from({ length: 14 }, (_, index) => ({
        ...kBlocked,
        target: String(index),
      }));
      await outbox.flush({
        deliver: async () => ({ ok: false, reason: "x", failures, terminal: true }),
      });
      expect(insertEvent.mock.calls[0][0].details.failures).toHaveLength(10);
    });

    it("sent>0 && failed>0 acks the event AND persists ONE notification_partial event naming the failed channels", async () => {
      const insertEvent = vi.fn();
      const { outbox, nowRef } = makeOutbox({ insertEvent });
      outbox.enqueue({
        id: "e1",
        message: "update applied",
        eventType: "upgrade",
        operationId: "op-1",
      });
      const partial = vi.fn(async () => ({
        ok: true,
        sent: 1,
        failed: 2,
        failures: [
          kBlocked,
          {
            channel: "slack",
            target: "U1",
            reason: "missing SLACK_BOT_TOKEN",
            errorCode: null,
            deterministic: false,
          },
        ],
      }));

      const result = await outbox.flush({ deliver: partial });

      expect(result).toEqual(
        expect.objectContaining({ delivered: 1, failed: 0, abandoned: 0, partial: 1 }),
      );
      const entry = outbox.listEvents()[0];
      expect(entry.deliveredAt).toBe(nowRef.now);
      expect(entry.partialAt).toBe(nowRef.now);
      expect(insertEvent).toHaveBeenCalledTimes(1);
      expect(insertEvent.mock.calls[0][0]).toEqual({
        eventType: "notification_partial",
        source: "notify-outbox",
        status: "warning",
        correlationId: "op-1",
        details: {
          id: "e1",
          notifyEventType: "upgrade",
          sent: 1,
          failed: 2,
          failedChannels: ["telegram", "slack"],
          failures: [
            {
              channel: "telegram",
              reason: "Forbidden: bot was blocked by the user",
              errorCode: 403,
            },
            { channel: "slack", reason: "missing SLACK_BOT_TOKEN", errorCode: null },
          ],
        },
      });

      // Delivered: a later flush neither redelivers nor re-emits.
      const again = await outbox.flush({ deliver: partial });
      expect(partial).toHaveBeenCalledTimes(1);
      expect(again.partial).toBe(0);
      expect(insertEvent).toHaveBeenCalledTimes(1);
    });

    it("a full success (failed:0) never emits a partial event", async () => {
      const insertEvent = vi.fn();
      const { outbox } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "msg" });
      const result = await outbox.flush({
        deliver: async () => ({ ok: true, sent: 2, failed: 0, failures: [] }),
      });
      expect(result.partial).toBe(0);
      expect(outbox.listEvents()[0].partialAt).toBeNull();
      expect(insertEvent).not.toHaveBeenCalled();
    });

    it("the partial event is deduped per outbox id: an entry already stamped partialAt emits nothing", async () => {
      // Persisted stamp from an earlier flush (e.g. before a crash between
      // the insert and the ack write-back).
      const openclawDir = mkTemp("notify-outbox-partial-dedupe-");
      const outboxPath = path.join(openclawDir, ".alphaclaw", "notify-outbox.json");
      fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
      fs.writeFileSync(
        outboxPath,
        `${JSON.stringify({
          events: [
            {
              id: "e1",
              eventType: "upgrade",
              message: "update applied",
              createdAt: 999_000,
              attempts: 1,
              deliveredAt: null,
              partialAt: 999_500,
            },
          ],
        })}\n`,
      );
      const insertEvent = vi.fn();
      const outbox = createNotifyOutbox({
        openclawDir,
        nowFn: () => 1_000_000,
        logger: kSilentLogger,
        insertEvent,
      });
      const result = await outbox.flush({
        deliver: async () => ({ ok: true, sent: 1, failed: 1, failures: [kBlocked] }),
      });
      expect(result.delivered).toBe(1);
      expect(result.partial).toBe(0);
      expect(insertEvent).not.toHaveBeenCalled();
      expect(outbox.listEvents()[0].partialAt).toBe(999_500);
    });

    it("a throwing insertEvent sink never breaks a partial or terminal flush", async () => {
      const insertEvent = vi.fn(() => {
        throw new Error("watchdog db closed");
      });
      const { outbox } = makeOutbox({ insertEvent });
      outbox.enqueue({ id: "e1", message: "partial" });
      outbox.enqueue({ id: "e2", message: "terminal" });
      const result = await outbox.flush({
        deliver: async (event) =>
          event.id === "e1"
            ? { ok: true, sent: 1, failed: 1, failures: [kBlocked] }
            : { ok: false, reason: "x", failures: [kBlocked], terminal: true },
      });
      expect(result).toEqual(
        expect.objectContaining({ delivered: 1, partial: 1, abandoned: 1 }),
      );
      expect(outbox.listEvents().find((entry) => entry.id === "e1").partialAt).toBeTruthy();
      expect(outbox.listEvents().find((entry) => entry.id === "e2").abandonedAt).toBeTruthy();
    });
  });
});

describe("server/upgrade-notifier routing", () => {
  const makeNotifier = ({
    prefs,
    sendResults = {},
    fanoutResult = { ok: true, sent: 3, failed: 0, failures: [] },
    insertEvent = undefined,
  } = {}) => {
    const { outbox, nowRef } = makeOutbox(insertEvent ? { insertEvent } : {});
    const sendToTarget = vi.fn(async (target) => {
      const key = `${target.channel}:${target.target}`;
      return sendResults[key] ?? { ok: true };
    });
    const fanout = vi.fn(async () => fanoutResult);
    const operatorsStore = {
      read: () => ({
        notifications: prefs || { preferredChannel: null, adminTargets: [] },
      }),
    };
    const notifier = createUpgradeNotifier({
      notifier: { notify: fanout, sendToTarget },
      outbox,
      operatorsStore,
      logger: kSilentLogger,
    });
    return { notifier, sendToTarget, fanout, outbox, nowRef };
  };

  // Per-target failure shapes as watchdog-notify's failTarget() reports them.
  const kBlocked = () => ({
    ok: false,
    reason: "Forbidden: bot was blocked by the user",
    errorCode: 403,
    deterministic: true,
  });
  // C30: `400 chat not found` is deterministic ONLY when the target came from
  // the pairing store (fan-out path). sendToTarget's admin targets report the
  // same wire error as retryable — the id may simply never have messaged the
  // bot. Two fixtures, one per provenance.
  const kChatNotFoundPaired = {
    ok: false,
    reason: "Bad Request: chat not found",
    errorCode: 400,
    deterministic: true,
  };
  const kChatNotFoundRetryable = {
    ok: false,
    reason: "Bad Request: chat not found",
    errorCode: 400,
    deterministic: false,
  };
  const kRateLimited = {
    ok: false,
    reason: "Too Many Requests: retry after 7",
    errorCode: 429,
    deterministic: false,
  };
  const kUnconfigured = {
    ok: false,
    reason: "telegram_unconfigured",
    errorCode: null,
    deterministic: false,
  };
  const fanoutFailure = (failures) => ({
    ok: false,
    sent: 0,
    failed: failures.length,
    reason: "no_channels_delivered",
    channels: {},
    failures,
  });
  const asFanoutFailure = (target, result) => ({
    channel: "telegram",
    target,
    reason: result.reason,
    errorCode: result.errorCode,
    deterministic: result.deterministic,
  });

  it("no adminTargets configured → today's fan-out, unchanged default", async () => {
    const { notifier, fanout, sendToTarget } = makeNotifier();
    await notifier.notify("hello", { id: "e1" });
    await notifier.flush();
    expect(fanout).toHaveBeenCalledWith("hello", { eventType: "info" });
    expect(sendToTarget).not.toHaveBeenCalled();
  });

  it("preferred channel targets only — no fallback copy on success", async () => {
    const { notifier, sendToTarget, fanout } = makeNotifier({
      prefs: {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: "111" },
          { channel: "slack", target: "U222", accountId: null },
        ],
      },
    });
    await notifier.notify("update done", { id: "e1" });
    await notifier.flush();
    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget.mock.calls[0][0]).toEqual(
      expect.objectContaining({ channel: "telegram", target: "111" }),
    );
    expect(fanout).not.toHaveBeenCalled();
  });

  it("falls back to remaining admin targets ONLY on delivery error, message prefixed", async () => {
    const { notifier, sendToTarget } = makeNotifier({
      prefs: {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: "111" },
          { channel: "slack", target: "U222", accountId: null },
        ],
      },
      sendResults: { "telegram:111": { ok: false, reason: "blocked" } },
    });
    await notifier.notify("upgrade failed", { id: "e1" });
    await notifier.flush();
    expect(sendToTarget).toHaveBeenCalledTimes(2);
    expect(sendToTarget.mock.calls[1][0].channel).toBe("slack");
    expect(sendToTarget.mock.calls[1][1]).toBe("(fallback) upgrade failed");
  });

  it("upgrade-lifecycle messages deep-link to the hash route (the SPA 404s on /upgrade)", async () => {
    const { outbox } = makeOutbox();
    const sendToTarget = vi.fn(async () => ({ ok: true }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: vi.fn(async () => ({ ok: true })), sendToTarget },
      outbox,
      operatorsStore: {
        read: () => ({
          notifications: {
            preferredChannel: null,
            adminTargets: [{ channel: "telegram", target: "111" }],
          },
        }),
      },
      getBaseUrl: () => "https://claw.example.com/",
      logger: kSilentLogger,
    });
    await notifier.notify("update finished", {
      id: "e1",
      operationId: "op-1",
    });
    await notifier.flush();
    expect(sendToTarget.mock.calls[0][1]).toBe(
      "update finished\n🔗 https://claw.example.com/#/upgrade",
    );
  });

  it("degrades to a single direct delivery when the outbox is unavailable", async () => {
    // enqueue() returning null (e.g. disk full) must not drop the message —
    // and must not pretend it was queued either.
    const outboxStub = {
      enqueue: vi.fn(() => null),
      flush: vi.fn(async () => ({ delivered: 0, failed: 0, pending: 0 })),
      listEvents: () => [],
    };
    const sendToTarget = vi.fn(async () => ({ ok: true }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: vi.fn(async () => ({ ok: true })), sendToTarget },
      outbox: outboxStub,
      operatorsStore: {
        read: () => ({
          notifications: {
            preferredChannel: null,
            adminTargets: [{ channel: "telegram", target: "111" }],
          },
        }),
      },
      logger: kSilentLogger,
    });

    const result = await notifier.notify("disk is full", { id: "e1" });

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(sendToTarget.mock.calls[0][1]).toBe("disk is full");
    expect(result.ok).toBe(true);
    expect(result.queued).toBeUndefined();
    // The degrade path never schedules a flush of the broken outbox.
    expect(outboxStub.flush).not.toHaveBeenCalled();
  });

  it("all admin targets failing leaves the event unacked for retry", async () => {
    const { notifier, outbox } = makeNotifier({
      prefs: {
        preferredChannel: null,
        adminTargets: [{ channel: "telegram", target: "111" }],
      },
      sendResults: { "telegram:111": { ok: false, reason: "down" } },
    });
    await notifier.notify("msg", { id: "e1" });
    await notifier.flush();
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();
    // A bare {ok:false, reason} (no deterministic flag) is transient.
    expect(outbox.listEvents()[0].abandonedAt).toBeNull();
  });

  // WI-3.2: deliverEvent's verdict. terminal ⇔ ≥1 target tried AND every
  // failed target deterministic; zero resolvable targets stays transient.
  describe("deliverEvent terminal vs transient classification", () => {
    const kEvent = { id: "e1", message: "msg", eventType: "upgrade_failed" };

    describe("fan-out path (no admin targets)", () => {
      it.each([
        [
          "every target deterministic (403 + pairing-store chat-not-found) → terminal",
          [asFanoutFailure("1", kBlocked()), asFanoutFailure("2", kChatNotFoundPaired)],
          true,
        ],
        [
          "403 + an allowFrom-fallback chat-not-found (retryable) → transient",
          [asFanoutFailure("1", kBlocked()), asFanoutFailure("2", kChatNotFoundRetryable)],
          false,
        ],
        [
          "zero resolvable targets (no_channels_delivered, no failures) → transient",
          [],
          false,
        ],
        ["a 429 → transient", [asFanoutFailure("1", kRateLimited)], false],
        [
          "mixed deterministic + transient → transient",
          [asFanoutFailure("1", kBlocked()), asFanoutFailure("2", kRateLimited)],
          false,
        ],
        [
          "a deterministic telegram target + a transient webhook → transient",
          [
            asFanoutFailure("1", kBlocked()),
            {
              channel: "webhook",
              target: null,
              reason: "webhook POST did not succeed",
              errorCode: null,
              deterministic: false,
            },
          ],
          false,
        ],
      ])("%s", async (_label, failures, terminal) => {
        const { notifier } = makeNotifier({ fanoutResult: fanoutFailure(failures) });
        const result = await notifier.deliverEvent(kEvent);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("no_channels_delivered");
        expect(result.failures).toEqual(failures);
        if (terminal) expect(result.terminal).toBe(true);
        else expect(result).not.toHaveProperty("terminal");
      });

      it("a successful fan-out passes through untouched (incl. partial evidence)", async () => {
        const fanoutResult = {
          ok: true,
          sent: 1,
          failed: 1,
          failures: [asFanoutFailure("2", kBlocked())],
        };
        const { notifier } = makeNotifier({ fanoutResult });
        expect(await notifier.deliverEvent(kEvent)).toBe(fanoutResult);
      });

      it("a legacy notifier result without a failures list stays transient", async () => {
        const { notifier } = makeNotifier({
          fanoutResult: { ok: false, sent: 0, reason: "no_channels_delivered" },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result).not.toHaveProperty("terminal");
      });
    });

    describe("admin-target path", () => {
      const kTwoTargets = {
        preferredChannel: "telegram",
        adminTargets: [
          { channel: "telegram", target: "111" },
          { channel: "discord", target: "999" },
        ],
      };

      it("preferred AND fallback both deterministic → terminal, with every failure recorded", async () => {
        const { notifier } = makeNotifier({
          prefs: kTwoTargets,
          sendResults: {
            "telegram:111": kBlocked(),
            "discord:999": {
              ok: false,
              reason: "Unknown User",
              errorCode: 404,
              deterministic: true,
            },
          },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result).toEqual({
          ok: false,
          reason: "all_admin_targets_failed",
          sent: 0,
          failed: 2,
          failures: [
            {
              channel: "telegram",
              target: "111",
              reason: "Forbidden: bot was blocked by the user",
              errorCode: 403,
              deterministic: true,
            },
            {
              channel: "discord",
              target: "999",
              reason: "Unknown User",
              errorCode: 404,
              deterministic: true,
            },
          ],
          terminal: true,
        });
      });

      it("preferred deterministic but fallback transient → transient", async () => {
        const { notifier } = makeNotifier({
          prefs: kTwoTargets,
          sendResults: {
            "telegram:111": kBlocked(),
            "discord:999": { ok: false, reason: "discord down", errorCode: 503, deterministic: false },
          },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("all_admin_targets_failed");
        expect(result).not.toHaveProperty("terminal");
        expect(result.failures.map((f) => f.errorCode)).toEqual([403, 503]);
      });

      it("an unconfigured channel is a fixable misconfiguration → transient", async () => {
        const { notifier } = makeNotifier({
          prefs: { preferredChannel: null, adminTargets: [{ channel: "telegram", target: "111" }] },
          sendResults: { "telegram:111": kUnconfigured },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result).not.toHaveProperty("terminal");
        expect(result.failures[0]).toEqual(
          expect.objectContaining({ reason: "telegram_unconfigured", deterministic: false }),
        );
      });

      it("a single deterministic admin target (403 blocked) → terminal", async () => {
        const { notifier } = makeNotifier({
          prefs: { preferredChannel: null, adminTargets: [{ channel: "telegram", target: "111" }] },
          sendResults: { "telegram:111": kBlocked() },
        });
        expect((await notifier.deliverEvent(kEvent)).terminal).toBe(true);
      });

      it("an admin target's 400 chat not found → transient (the operator can still message the bot)", async () => {
        const { notifier } = makeNotifier({
          prefs: { preferredChannel: null, adminTargets: [{ channel: "telegram", target: "111" }] },
          sendResults: { "telegram:111": kChatNotFoundRetryable },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result.ok).toBe(false);
        expect(result).not.toHaveProperty("terminal");
        expect(result.failures[0]).toEqual(
          expect.objectContaining({ errorCode: 400, deterministic: false }),
        );
      });

      it("preferred fails, fallback succeeds → ok:true with the failed target as partial evidence", async () => {
        const { notifier } = makeNotifier({
          prefs: kTwoTargets,
          sendResults: { "telegram:111": kBlocked() },
        });
        expect(await notifier.deliverEvent(kEvent)).toEqual({
          ok: true,
          sent: 1,
          failed: 1,
          fallback: true,
          failures: [
            {
              channel: "telegram",
              target: "111",
              reason: "Forbidden: bot was blocked by the user",
              errorCode: 403,
              deterministic: true,
            },
          ],
        });
      });

      it("one preferred target fails while another delivers → ok:true, no fallback, partial evidence", async () => {
        const { notifier, sendToTarget } = makeNotifier({
          prefs: {
            preferredChannel: "telegram",
            adminTargets: [
              { channel: "telegram", target: "111" },
              { channel: "telegram", target: "222" },
              { channel: "discord", target: "999" },
            ],
          },
          sendResults: { "telegram:111": kRateLimited },
        });
        const result = await notifier.deliverEvent(kEvent);
        expect(result).toEqual({
          ok: true,
          sent: 1,
          failed: 1,
          failures: [expect.objectContaining({ target: "111", errorCode: 429 })],
        });
        expect(sendToTarget).toHaveBeenCalledTimes(2);
      });
    });

    describe("end to end through the outbox", () => {
      it("a terminal fan-out abandons the event on the FIRST flush with a persisted notification_abandoned", async () => {
        const insertEvent = vi.fn();
        const { notifier, outbox, fanout } = makeNotifier({
          insertEvent,
          fanoutResult: fanoutFailure([asFanoutFailure("1", kBlocked())]),
        });
        await notifier.notify("backup failed", { id: "e1", eventType: "upgrade_failed" });
        const flushed = await notifier.flush();
        expect(flushed).toEqual(expect.objectContaining({ abandoned: 1, pending: 0 }));
        const entry = outbox.listEvents()[0];
        expect(entry.abandonedAt).not.toBeNull();
        expect(entry.deliveredAt).toBeNull();
        expect(insertEvent).toHaveBeenCalledTimes(1);
        expect(insertEvent.mock.calls[0][0]).toEqual(
          expect.objectContaining({ eventType: "notification_abandoned" }),
        );
        expect(insertEvent.mock.calls[0][0].details).toEqual(
          expect.objectContaining({ terminal: true, id: "e1" }),
        );
        await notifier.flush();
        expect(fanout).toHaveBeenCalledTimes(1);
      });

      it("a zero-target fan-out stays queued and retries after the backoff", async () => {
        const insertEvent = vi.fn();
        const { notifier, outbox, fanout, nowRef } = makeNotifier({
          insertEvent,
          fanoutResult: fanoutFailure([]),
        });
        await notifier.notify("backup failed", { id: "e1" });
        await notifier.flush();
        expect(outbox.listEvents()[0].abandonedAt).toBeNull();
        expect(outbox.listEvents()[0].nextAttemptAt).toBe(nowRef.now + 60_000);
        expect(insertEvent).not.toHaveBeenCalled();
        nowRef.now += 60_000;
        await notifier.flush();
        expect(fanout).toHaveBeenCalledTimes(2);
      });

      it("a fallback delivery persists one notification_partial naming the failed channel", async () => {
        const insertEvent = vi.fn();
        const { notifier, outbox } = makeNotifier({
          insertEvent,
          prefs: {
            preferredChannel: "telegram",
            adminTargets: [
              { channel: "telegram", target: "111" },
              { channel: "slack", target: "U1", accountId: null },
            ],
          },
          sendResults: { "telegram:111": kChatNotFoundRetryable },
        });
        await notifier.notify("update applied", { id: "e1", eventType: "upgrade" });
        const flushed = await notifier.flush();
        expect(flushed).toEqual(expect.objectContaining({ delivered: 1, partial: 1 }));
        expect(outbox.listEvents()[0].deliveredAt).not.toBeNull();
        expect(insertEvent).toHaveBeenCalledTimes(1);
        expect(insertEvent.mock.calls[0][0]).toEqual(
          expect.objectContaining({ eventType: "notification_partial", status: "warning" }),
        );
        expect(insertEvent.mock.calls[0][0].details).toEqual(
          expect.objectContaining({
            id: "e1",
            sent: 1,
            failed: 1,
            failedChannels: ["telegram"],
          }),
        );
      });
    });
  });
});

describe("server/upgrade-notifier state-db quiet hold", () => {
  const {
    beginStateDbQuiet,
    resetStateDbQuietForTests,
  } = require("../../lib/server/state-db-quiet");

  const makeHeldNotifier = () => {
    const { outbox } = makeOutbox();
    const fanout = vi.fn(async () => ({ ok: true, sent: 1 }));
    const flushSpy = vi.spyOn(outbox, "flush");
    const notifier = createUpgradeNotifier({
      notifier: { notify: fanout, sendToTarget: vi.fn(async () => ({ ok: true })) },
      outbox,
      operatorsStore: {
        read: () => ({ notifications: { preferredChannel: null, adminTargets: [] } }),
      },
      logger: kSilentLogger,
    });
    return { notifier, outbox, fanout, flushSpy };
  };

  beforeEach(() => {
    // Notifiers built by earlier tests in this file never called stop(); drop
    // their listeners so only the one under test observes the barrier.
    resetStateDbQuietForTests({ listeners: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStateDbQuietForTests({ listeners: true });
  });

  it("enqueue is never gated: events queue durably while quiet and flush the moment the barrier lifts", async () => {
    const { notifier, outbox, fanout, flushSpy } = makeHeldNotifier();
    const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });

    const result = await notifier.notify("update applied", { id: "e1" });
    expect(result).toEqual({ ok: true, queued: true, id: "e1" });
    expect(outbox.listEvents()).toHaveLength(1);
    // The debounce would fire at 250ms — held, so nothing is delivered.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(fanout).not.toHaveBeenCalled();
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();

    token.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(fanout).toHaveBeenCalledWith("update applied", { eventType: "info" });
    expect(outbox.listEvents()[0].deliveredAt).not.toBeNull();
  });

  it("begin cancels a pending debounce and the periodic heartbeat; end re-arms the heartbeat", async () => {
    const { notifier, flushSpy } = makeHeldNotifier();
    notifier.start();
    expect(flushSpy).toHaveBeenCalledTimes(1);
    await notifier.notify("queued before quiet", { id: "e1" });
    flushSpy.mockClear();

    const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 600_000 });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(flushSpy).not.toHaveBeenCalled();

    token.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("start() during a hold defers the boot re-drain and heartbeat until the barrier lifts", async () => {
    const { notifier, flushSpy } = makeHeldNotifier();
    const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 600_000 });
    notifier.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(flushSpy).not.toHaveBeenCalled();

    token.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    notifier.stop();
  });

  it("stop() unsubscribes from the barrier: a later release no longer flushes a stopped notifier", async () => {
    const { notifier, flushSpy } = makeHeldNotifier();
    notifier.start();
    notifier.stop();
    flushSpy.mockClear();
    const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
    token.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushSpy).not.toHaveBeenCalled();
  });

  it("without a hold, notify() still debounces a flush as before", async () => {
    const { notifier, flushSpy, fanout } = makeHeldNotifier();
    await notifier.notify("plain", { id: "e1" });
    await vi.advanceTimersByTimeAsync(250);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(fanout).toHaveBeenCalledTimes(1);
  });

  // Adversarial review (g): with the outbox unavailable the direct send used
  // to run straight into the quiet period, where target resolution serves the
  // readers' "unavailable" fallback — the message was silently lost.
  describe("outbox unavailable while quiet", () => {
    const makeBrokenOutboxNotifier = ({ logger = kSilentLogger } = {}) => {
      const outboxStub = {
        enqueue: vi.fn(() => null),
        flush: vi.fn(async () => ({ delivered: 0, failed: 0, pending: 0 })),
        listEvents: () => [],
      };
      const fanout = vi.fn(async () => ({ ok: true, sent: 1, failed: 0, failures: [] }));
      const notifier = createUpgradeNotifier({
        notifier: { notify: fanout, sendToTarget: vi.fn(async () => ({ ok: true })) },
        outbox: outboxStub,
        operatorsStore: {
          read: () => ({ notifications: { preferredChannel: null, adminTargets: [] } }),
        },
        logger,
      });
      return { notifier, fanout, outboxStub };
    };

    it("holds the direct send and delivers it when the barrier lifts — never into the quiet period", async () => {
      const { notifier, fanout } = makeBrokenOutboxNotifier();
      const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });

      const result = await notifier.notify("backup failed", { id: "e1", eventType: "upgrade_failed" });

      expect(result).toEqual({ ok: true, held: true, reason: "state_db_quiet" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fanout).not.toHaveBeenCalled();

      token.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fanout).toHaveBeenCalledTimes(1);
      expect(fanout).toHaveBeenCalledWith("backup failed", { eventType: "upgrade_failed" });
    });

    it("held sends are delivered in arrival order, then the outbox flush runs", async () => {
      const { notifier, fanout, outboxStub } = makeBrokenOutboxNotifier();
      const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
      await notifier.notify("first", { id: "e1" });
      await notifier.notify("second", { id: "e2" });
      expect(fanout).not.toHaveBeenCalled();

      token.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fanout.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
      expect(outboxStub.flush).toHaveBeenCalledTimes(1);
    });

    it("the barrier EXPIRING (not released) also delivers the held send", async () => {
      const { notifier, fanout } = makeBrokenOutboxNotifier();
      await beginStateDbQuiet({ owner: "backup", maxMs: 10_000 });
      await notifier.notify("held", { id: "e1" });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fanout).toHaveBeenCalledWith("held", { eventType: "info" });
    });

    it("a failed held delivery is logged, never retried (there is no durable outbox to retry from)", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { notifier, fanout } = makeBrokenOutboxNotifier({ logger });
      fanout.mockResolvedValue({ ok: false, reason: "no_channels_delivered", failures: [] });
      const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
      await notifier.notify("held", { id: "e1" });

      token.release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fanout).toHaveBeenCalledTimes(1);
      expect(logger.log).toHaveBeenCalledWith(
        "[upgrade-notifier] held direct send failed (info): no_channels_delivered",
      );
    });

    it("the hold buffer is bounded at 50: the oldest is dropped with a log line", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { notifier, fanout } = makeBrokenOutboxNotifier({ logger });
      const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
      for (let i = 0; i < 51; i += 1) {
        await notifier.notify(`m${i}`, { id: `e${i}` });
      }
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining("held direct-send buffer full (50) — dropping oldest"),
      );

      token.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fanout).toHaveBeenCalledTimes(50);
      expect(fanout.mock.calls[0][0]).toBe("m1");
      expect(fanout.mock.calls[49][0]).toBe("m50");
    });

    it("stop() during a hold drops the buffer loudly instead of sending into the quiet period", async () => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { notifier, fanout } = makeBrokenOutboxNotifier({ logger });
      const { token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 });
      await notifier.notify("held", { id: "e1" });

      notifier.stop();
      expect(logger.log).toHaveBeenCalledWith(
        "[upgrade-notifier] stopping with 1 held direct send(s) undelivered",
      );
      token.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fanout).not.toHaveBeenCalled();
    });

    it("outside a quiet period the direct send is still immediate (unchanged degrade path)", async () => {
      const { notifier, fanout, outboxStub } = makeBrokenOutboxNotifier();
      const result = await notifier.notify("disk is full", { id: "e1" });
      expect(fanout).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.held).toBeUndefined();
      expect(outboxStub.flush).not.toHaveBeenCalled();
    });
  });
});
