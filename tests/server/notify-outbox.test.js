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
    const { outbox } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "important failure notice" });
    const failing = vi.fn(async () => ({ ok: false, reason: "api down" }));
    await outbox.flush({ deliver: failing });
    expect(outbox.listEvents()[0].deliveredAt).toBeNull();
    expect(outbox.listEvents()[0].lastError).toBe("api down");

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
    const { outbox } = makeOutbox({ maxAttempts: 2 });
    outbox.enqueue({ id: "e1", message: "msg" });
    const failing = vi.fn(async () => ({ ok: false }));
    await outbox.flush({ deliver: failing });
    await outbox.flush({ deliver: failing });
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

  it("persists across instances (restart survival)", async () => {
    const { outbox, openclawDir } = makeOutbox();
    outbox.enqueue({ id: "e1", message: "queued just before restart" });
    const reborn = createNotifyOutbox({
      openclawDir,
      logger: kSilentLogger,
    });
    const deliver = vi.fn(async () => ({ ok: true }));
    const result = await reborn.flush({ deliver });
    expect(result.delivered).toBe(1);
    expect(deliver.mock.calls[0][0].message).toBe(
      "queued just before restart",
    );
  });
});

describe("server/upgrade-notifier routing", () => {
  const makeNotifier = ({ prefs, sendResults = {} } = {}) => {
    const { outbox } = makeOutbox();
    const sendToTarget = vi.fn(async (target) => {
      const key = `${target.channel}:${target.target}`;
      return sendResults[key] ?? { ok: true };
    });
    const fanout = vi.fn(async () => ({ ok: true, sent: 3 }));
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
    return { notifier, sendToTarget, fanout, outbox };
  };

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
  });
});
