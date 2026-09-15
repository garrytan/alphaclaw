const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");
const { createWatchdogNotifier, sendTelegramRendered } = require("../../lib/server/watchdog-notify");
const { notificationTiming, overseerNotificationTiming, kOverseerNotificationMaxAgeMs: hour } = require("../../lib/server/notification-expiry");
const { beginStateDbQuiet, resetStateDbQuietForTests } = require("../../lib/server/state-db-quiet");

const cleanups = [];
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const makeHarness = ({ keepCount = 100, unavailable = false, targets = [], sendToTarget = null, shouldSend = () => ({ ok: true }) } = {}) => {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-expiry-"));
  const clock = { now: 10_000_000 };
  const insertEvent = vi.fn();
  const outbox = createNotifyOutbox({ openclawDir, nowFn: () => clock.now, keepCount, insertEvent, logger });
  if (unavailable) vi.spyOn(outbox, "enqueue").mockReturnValue(null);
  const fanout = vi.fn(async () => ({ ok: true, sent: 1 }));
  const send = sendToTarget || vi.fn(async () => ({ ok: true }));
  const notifier = createUpgradeNotifier({
    outbox, notifier: { notify: fanout, sendToTarget: send }, shouldSend, logger,
    operatorsStore: { read: () => ({ notifications: { preferredChannel: "telegram", adminTargets: targets } }) },
  });
  cleanups.push(() => { notifier.stop(); fs.rmSync(openclawDir, { recursive: true, force: true }); });
  return { openclawDir, clock, outbox, insertEvent, notifier, fanout, send };
};
const overseer = (id = "review") => ({ id, eventType: "overseer", message: "review outcome" });

beforeEach(() => resetStateDbQuietForTests({ listeners: true }));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetStateDbQuietForTests({ listeners: true });
});

describe("fixed notification delivery deadlines", () => {
  it("gives new overseers one hour, other notices 48h, and old source records their original deadline", () => {
    expect(notificationTiming({ eventType: "overseer" }, { now: 100 })).toEqual({ createdAt: 100, expiresAt: 100 + hour });
    expect(notificationTiming({}, { now: 100 }).expiresAt).toBe(100 + 48 * hour);
    expect(overseerNotificationTiming({ state: "done", at: 100 }, 100 + 2 * hour)).toEqual({ createdAt: 100, expiresAt: 100 + hour });
    expect(overseerNotificationTiming({ notifyCreatedAt: 100, notifyExpiresAt: 100 + hour }, 100 + 2 * hour).expiresAt).toBe(100 + hour);
    expect(notificationTiming({}, { now: 100, legacy: true }).expiresAt).toBe(0);
    expect(overseerNotificationTiming({ notifyCreatedAt: "bad", notifyExpiresAt: 100 + hour }, 100).expiresAt).toBe(0);
  });

  it.each([
    { createdAt: "100" }, { createdAt: -1 }, { createdAt: NaN },
    { expiresAt: null }, { expiresAt: "later" }, { expiresAt: Infinity },
  ])("fails closed on malformed timestamps %j", async (timing) => {
    const h = makeHarness();
    h.outbox.enqueue({ ...overseer(), ...timing });
    const deliver = vi.fn();
    await h.outbox.flush({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(h.outbox.listEvents()[0].suppressedReason).toBe("expired");
  });

  it("derives legacy expiry on restart and preserves ordinary 48h delivery", async () => {
    const h = makeHarness();
    fs.mkdirSync(path.dirname(h.outbox.outboxPath), { recursive: true });
    fs.writeFileSync(h.outbox.outboxPath, JSON.stringify({ events: [
      { ...overseer(), createdAt: h.clock.now },
      { id: "critical", message: "still important", eventType: "crash", createdAt: h.clock.now },
    ] }));
    h.clock.now += hour;
    const restarted = createNotifyOutbox({ openclawDir: h.openclawDir, nowFn: () => h.clock.now, insertEvent: h.insertEvent, logger });
    const deliver = vi.fn(async () => ({ ok: true }));
    expect(await restarted.flush({ deliver })).toMatchObject({ suppressed: 1, delivered: 1 });
    expect(deliver.mock.calls.map(([event]) => event.id)).toEqual(["critical"]);
    expect(restarted.listEvents()[0]).toMatchObject({ suppressedReason: "expired", expiresAt: h.clock.now });
    await restarted.flush({ deliver });
    expect(h.insertEvent.mock.calls.filter(([event]) => event.eventType === "notification_expired")).toHaveLength(1);
  });

  it("does not renew a terminal failure or an expired tombstone on duplicate enqueue", async () => {
    const h = makeHarness();
    const first = h.outbox.enqueue(overseer());
    await h.outbox.flush({ deliver: async () => ({ ok: false, terminal: true }) });
    h.clock.now += hour / 2;
    const duplicate = h.outbox.enqueue(overseer());
    expect(duplicate).toMatchObject({ createdAt: first.createdAt, expiresAt: first.expiresAt });
    h.clock.now += hour / 2;
    await h.outbox.flush({ deliver: vi.fn() });
    h.outbox.enqueue(overseer());
    await h.notifier.notify("review outcome", { id: "review", eventType: "overseer" });
    const restarted = createNotifyOutbox({ openclawDir: h.openclawDir, nowFn: () => h.clock.now, insertEvent: h.insertEvent, logger });
    restarted.enqueue(overseer());
    const deliver = vi.fn();
    await restarted.flush({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(restarted.listEvents()[0].suppressedReason).toBe("expired");
    expect(h.insertEvent.mock.calls.filter(([event]) => event.eventType === "notification_expired")).toHaveLength(1);
  });

  it("rechecks each queued event after a slow preceding delivery", async () => {
    const h = makeHarness();
    h.outbox.enqueue({ id: "first", message: "slow" });
    h.outbox.enqueue(overseer());
    const deliver = vi.fn(async () => { h.clock.now += hour; return { ok: true }; });
    expect(await h.outbox.flush({ deliver })).toMatchObject({ delivered: 1, suppressed: 1 });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("preserves a shorter duplicate deadline written while delivery is awaiting", async () => {
    const h = makeHarness();
    h.outbox.enqueue(overseer());
    const shorter = h.clock.now + hour / 2;
    await h.outbox.flush({ deliver: async () => {
      h.outbox.enqueue({ ...overseer(), expiresAt: shorter });
      return { ok: false };
    } });
    expect(h.outbox.listEvents()[0].expiresAt).toBe(shorter);
  });

  it.each([false, true])("expires behind a quiet hold, including unavailable outbox=%s", async (unavailable) => {
    const h = makeHarness({ unavailable });
    const quiet = await beginStateDbQuiet({ owner: "expiry-test", maxMs: 10_000 });
    await h.notifier.notify("review outcome", { id: "review", eventType: "overseer" });
    h.clock.now += hour / 2;
    await h.notifier.notify("review outcome", { id: "review", eventType: "overseer" });
    h.clock.now += hour / 2;
    quiet.release();
    await vi.waitFor(() => expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "notification_expired" })));
    expect(h.fanout).not.toHaveBeenCalled();
    expect(h.insertEvent.mock.calls.filter(([event]) => event.eventType === "notification_expired")).toHaveLength(1);
  });

  it.each(["held", "suppressed"])("a policy %s and re-enable cannot create another hour", async (mode) => {
    let enabled = mode === "held";
    const h = makeHarness({ shouldSend: () => enabled ? { ok: true }
      : { ok: false, reason: mode === "held" ? "notifications_disabled" : "verbose_notifications_disabled" } });
    await h.notifier.notify("review", { id: "review", eventType: "overseer" });
    enabled = false;
    await h.notifier.flush();
    const deadline = h.outbox.listEvents()[0].expiresAt;
    h.clock.now = deadline;
    enabled = true;
    await h.notifier.notify("review", { id: "review", eventType: "overseer" });
    await h.notifier.flush();
    expect(h.fanout).not.toHaveBeenCalled();
    expect(h.outbox.listEvents()[0]).toMatchObject({ expiresAt: deadline, suppressedReason: "expired" });
  });

  it("uses the source record deadline after its outbox tombstone was pruned", async () => {
    const h = makeHarness({ keepCount: 1 });
    const source = overseerNotificationTiming({}, h.clock.now);
    await h.notifier.notify("review", { ...overseer(), ...source });
    await h.notifier.flush();
    h.outbox.enqueue({ id: "replacement", message: "new event" });
    expect(h.outbox.listEvents().map((event) => event.id)).toEqual(["replacement"]);
    h.clock.now += hour;
    expect(await h.notifier.notify("review", { ...overseer(), ...source })).toMatchObject({ skipped: true, reason: "expired" });
    await h.notifier.flush();
    expect(h.fanout.mock.calls.filter(([message]) => message === "review")).toHaveLength(1);
  });

  it("reports delivery to the first admin and expiry of the second as partial, without retry", async () => {
    const targets = [{ channel: "telegram", target: "one" }, { channel: "telegram", target: "two" }];
    const h = makeHarness({ targets });
    h.send.mockImplementation(async () => { h.clock.now += hour; return { ok: true }; });
    await h.notifier.notify("review", { ...overseer() });
    expect(await h.notifier.flush()).toMatchObject({ delivered: 1, partial: 1, suppressed: 1 });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.outbox.listEvents()[0]).toMatchObject({ deliveredAt: h.clock.now, suppressedReason: "expired" });
    expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "notification_partial", details: expect.objectContaining({ sent: 1, failed: 0, skipped: 1, reason: "expired" }),
    }));
    await h.notifier.flush();
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("checks the deadline before routing an unsuccessful primary to a fallback", async () => {
    const h = makeHarness({ targets: [{ channel: "telegram", target: "one" }, { channel: "discord", target: "two" }] });
    h.send.mockImplementation(async () => { h.clock.now += hour; return { ok: false, reason: "unavailable" }; });
    await h.notifier.notify("review", { ...overseer() });
    expect(await h.notifier.flush()).toMatchObject({ delivered: 0, suppressed: 1 });
    expect(h.send).toHaveBeenCalledOnce();
  });

  it("reports a partially delivered direct send as success with skipped targets, not whole-message suppression", async () => {
    const h = makeHarness({ unavailable: true,
      targets: [{ channel: "telegram", target: "one" }, { channel: "telegram", target: "two" }] });
    h.send.mockImplementation(async () => { h.clock.now += hour; return { ok: true }; });
    const result = await h.notifier.notify("review", { ...overseer() });
    expect(result).toMatchObject({ ok: true, sent: 1, expired: true, skippedTargets: 1 });
    expect(result.skipped).toBeUndefined();
    expect(result.suppressed).toBeUndefined();
    expect(h.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "notification_partial",
      details: expect.objectContaining({ sent: 1, skipped: 1 }) }));
  });

  it("checks paired recipients inside the watchdog fanout", async () => {
    let expired = false;
    const api = { sendMessage: vi.fn(async () => { expired = true; return { ok: true }; }) };
    const notifier = createWatchdogNotifier({ telegramApi: api, getTelegramToken: () => "token",
      readChannelAllowFrom: () => ["111", "222"], openclawDir: "/nonexistent-expiry-test", fsImpl: fs });
    expect(await notifier.notify("review", { shouldDeliver: () => !expired })).toMatchObject({ ok: true, sent: 1, skippedTargets: 1, expired: true });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("does not resend Telegram plain text when its HTML attempt consumed the remaining lifetime", async () => {
    let expired = false;
    const api = { sendMessage: vi.fn(async () => {
      expired = true;
      throw Object.assign(new Error("can't parse entities"), { telegramErrorCode: 400 });
    }) };
    const result = await sendTelegramRendered({ api, chatId: "111", text: "review", shouldDeliver: () => !expired, log: logger });
    expect(result).toMatchObject({ expired: true, sent: 0 });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});
