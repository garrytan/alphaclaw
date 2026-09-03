const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isNotificationsDisabled,
  isVerboseEnabled,
  shouldSendNotification,
  kVerboseNotificationSites,
} = require("../../lib/server/notification-policy");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const kOriginalQuiet = process.env.WATCHDOG_NOTIFICATIONS_QUIET;
const kOriginalDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;

const restoreEnv = (key, original) => {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
};

afterEach(() => {
  restoreEnv("WATCHDOG_NOTIFICATIONS_QUIET", kOriginalQuiet);
  restoreEnv("WATCHDOG_NOTIFICATIONS_DISABLED", kOriginalDisabled);
});

const makeNotifier = ({ shouldSend, logger = kSilentLogger, nowRef } = {}) => {
  const openclawDir = mkTemp("notify-policy-test-");
  const clock = nowRef || { now: 1_000_000 };
  const outbox = createNotifyOutbox({
    openclawDir,
    nowFn: () => clock.now,
    logger: kSilentLogger,
  });
  const fanout = vi.fn(async () => ({ ok: true, sent: 1 }));
  const notifier = createUpgradeNotifier({
    notifier: { notify: fanout, sendToTarget: vi.fn() },
    outbox,
    operatorsStore: {
      read: () => ({
        notifications: { preferredChannel: null, adminTargets: [] },
      }),
    },
    logger,
    ...(shouldSend ? { shouldSend } : {}),
  });
  return { notifier, outbox, fanout, nowRef: clock };
};

describe("server/notification-policy", () => {
  it("parses the inverted env flags with the shared truthy forms", () => {
    for (const truthy of ["1", "true", "yes", "on", "TRUE"]) {
      expect(isVerboseEnabled({ WATCHDOG_NOTIFICATIONS_QUIET: truthy })).toBe(
        false,
      );
      expect(
        isNotificationsDisabled({ WATCHDOG_NOTIFICATIONS_DISABLED: truthy }),
      ).toBe(true);
    }
    for (const falsy of [undefined, "", "false", "0", "off"]) {
      expect(isVerboseEnabled({ WATCHDOG_NOTIFICATIONS_QUIET: falsy })).toBe(
        true,
      );
      expect(
        isNotificationsDisabled({ WATCHDOG_NOTIFICATIONS_DISABLED: falsy }),
      ).toBe(false);
    }
  });

  it("CRITICAL regression guard: a default env passes EVERY event", () => {
    // Nothing set — the exact state of every existing install on upgrade day.
    const env = {};
    expect(shouldSendNotification({}, env).ok).toBe(true);
    expect(shouldSendNotification(undefined, env).ok).toBe(true);
    expect(shouldSendNotification({ verbose: true }, env).ok).toBe(true);
    expect(shouldSendNotification({ audit: true }, env).ok).toBe(true);
    for (const eventType of [
      "info",
      "crash",
      "recovery",
      "health",
      "upgrade_failed",
      "autotune",
      "overseer",
      "doctor",
    ]) {
      expect(shouldSendNotification({ eventType }, env).ok).toBe(true);
    }
  });

  it("quiet mode suppresses ONLY verbose-tagged events, with a distinct reason", () => {
    const env = { WATCHDOG_NOTIFICATIONS_QUIET: "true" };
    expect(shouldSendNotification({ verbose: true }, env)).toEqual({
      ok: false,
      reason: "verbose_notifications_disabled",
    });
    // Untagged (important) and explicitly-false stay deliverable — the
    // fail-loud default: an unclassified site over-notifies, never silences.
    expect(shouldSendNotification({}, env).ok).toBe(true);
    expect(shouldSendNotification({ verbose: false }, env).ok).toBe(true);
    // Truthy-but-not-boolean never suppresses (classification is explicit).
    expect(shouldSendNotification({ verbose: "true" }, env).ok).toBe(true);
    // Audit notices pass regardless of the operator's toggles.
    expect(
      shouldSendNotification({ verbose: true, audit: true }, env).ok,
    ).toBe(true);
  });
});

describe("server/notification-policy — master toggle (C3)", () => {
  it("disabled silences everything through the pipeline, with its own reason", () => {
    const env = { WATCHDOG_NOTIFICATIONS_DISABLED: "true" };
    expect(shouldSendNotification({}, env)).toEqual({
      ok: false,
      reason: "notifications_disabled",
    });
    expect(shouldSendNotification({ verbose: true }, env).reason).toBe(
      "notifications_disabled",
    );
    for (const eventType of ["crash", "upgrade_failed", "health", "info"]) {
      expect(shouldSendNotification({ eventType }, env).ok).toBe(false);
    }
    // Audit notices (agent-admin) are exempt: a semi-trusted actor must not
    // be able to silence the audit trail of its own change (F3).
    expect(shouldSendNotification({ audit: true }, env).ok).toBe(true);
    expect(
      shouldSendNotification({ audit: true, verbose: true }, env).ok,
    ).toBe(true);
  });

  it("master gate refuses new enqueues but HOLDS (never destroys) queued events", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const { notifier, outbox, fanout, nowRef } = makeNotifier();

    // Queued while enabled…
    await notifier.notify("🔴 queued important", { id: "e1" });
    await notifier.notify("🔐 queued audit", { id: "e2", audit: true });
    // …operator disables notifications before delivery.
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
    await notifier.flush();

    // The important event HOLDS — not delivered, not terminally destroyed,
    // no attempt burned (a brief off-window must not purge alerts queued
    // while notifications were on). The audit event delivers regardless.
    const events = outbox.listEvents();
    const held = events.find((e) => e.id === "e1");
    expect(held.deliveredAt).toBeNull();
    expect(held.suppressedAt).toBeNull();
    expect(held.abandonedAt).toBeNull();
    expect(held.attempts).toBe(0);
    expect(events.find((e) => e.id === "e2").deliveredAt).toBeTruthy();
    expect(fanout).toHaveBeenCalledTimes(1);
    expect(fanout.mock.calls[0][0]).toBe("🔐 queued audit");

    // New enqueues are refused with the master reason.
    const refused = await notifier.notify("🔴 new", { id: "e3" });
    expect(refused).toEqual({
      ok: false,
      skipped: true,
      reason: "notifications_disabled",
    });

    // Re-enabling delivers the held alert — nothing was lost.
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    nowRef.now += 120_000;
    await notifier.flush();
    expect(
      outbox.listEvents().find((e) => e.id === "e1").deliveredAt,
    ).toBeTruthy();
  });

  it("a suppressed tombstone revives on a fresh same-id enqueue (F2)", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const { notifier, outbox, fanout, nowRef } = makeNotifier();

    // A verbose notice queued while verbose was on…
    await notifier.notify("⬆️ update available", {
      id: "alphaclaw-update-1.2.3",
      verbose: true,
    });
    // …terminally suppressed by a quiet flip before delivery.
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    await notifier.flush();
    expect(
      outbox.listEvents().find((e) => e.id === "alphaclaw-update-1.2.3")
        .suppressedAt,
    ).toBeTruthy();

    // Verbose back on: the daily re-check re-notifies the SAME stable id —
    // the tombstone must revive, not swallow every future notice forever.
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const requeued = await notifier.notify("⬆️ update available", {
      id: "alphaclaw-update-1.2.3",
      verbose: true,
    });
    expect(requeued.ok).toBe(true);
    nowRef.now += 60_000;
    await notifier.flush();
    expect(
      outbox.listEvents().find((e) => e.id === "alphaclaw-update-1.2.3")
        .deliveredAt,
    ).toBeTruthy();
    expect(fanout).toHaveBeenCalledTimes(1);

    // Delivered entries still dedupe (no duplicate chat messages).
    await notifier.notify("⬆️ update available", {
      id: "alphaclaw-update-1.2.3",
      verbose: true,
    });
    await notifier.flush();
    expect(fanout).toHaveBeenCalledTimes(1);
  });
});

describe("server/notification-policy — shared helpers", () => {
  it("utcDayBucket formats a UTC YYYYMMDD bucket", () => {
    const {
      utcDayBucket,
    } = require("../../lib/server/notification-policy");
    expect(utcDayBucket(Date.UTC(2026, 7, 31, 23, 59))).toBe("20260831");
    expect(utcDayBucket(Date.UTC(2026, 8, 1, 0, 0))).toBe("20260901");
  });

  it("fireAndForgetNotify never throws and swallows rejections", async () => {
    const {
      fireAndForgetNotify,
    } = require("../../lib/server/notification-policy");
    expect(() =>
      fireAndForgetNotify(() => {
        throw new Error("sync boom");
      }, "m"),
    ).not.toThrow();
    expect(() =>
      fireAndForgetNotify(async () => {
        throw new Error("async boom");
      }, "m"),
    ).not.toThrow();
    expect(() => fireAndForgetNotify(null, "m")).not.toThrow();
    const notify = vi.fn(async () => ({ ok: true }));
    fireAndForgetNotify(notify, "msg", { id: "x" });
    expect(notify).toHaveBeenCalledWith("msg", { id: "x" });
  });

  it("wrapRawNotifierWithPolicy gates raw paths exactly like the central pipeline", async () => {
    const {
      wrapRawNotifierWithPolicy,
    } = require("../../lib/server/notification-policy");
    const raw = vi.fn(async () => ({ ok: true, sent: 1 }));
    const wrapped = wrapRawNotifierWithPolicy(raw);

    // Default env: everything delivers.
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    await wrapped("hello", { eventType: "topic_discovery" });
    expect(raw).toHaveBeenCalledTimes(1);

    // Quiet suppresses verbose-tagged sends with the distinct reason.
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    const suppressed = await wrapped("digest", {
      eventType: "topic_discovery",
      ...{ verbose: true },
    });
    expect(suppressed).toEqual({
      ok: false,
      skipped: true,
      reason: "verbose_notifications_disabled",
    });
    expect(raw).toHaveBeenCalledTimes(1);

    // Master off suppresses everything…
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
    const masterOff = await wrapped("anything", {});
    expect(masterOff).toEqual({
      ok: false,
      skipped: true,
      reason: "notifications_disabled",
    });
    // …except audit-class notices.
    const audited = await wrapped("audit", { audit: true });
    expect(audited.ok).toBe(true);
    expect(raw).toHaveBeenCalledTimes(2);
  });
});

describe("server/notification-policy — audit-flag wiring contracts", () => {
  // The security property "the agent cannot silence its own audit trail"
  // rests on the two agent-admin call sites actually passing audit: true —
  // pin the wiring so a refactor can't drop the flag silently.
  it("both agent-admin notify call sites carry the audit flag", () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "lib",
        "server",
        "init",
        "register-server-routes.js",
      ),
      "utf8",
    );
    const confirmSite = source.slice(
      source.indexOf("agent-admin-confirm-"),
      source.indexOf("agent-admin-confirm-") + 600,
    );
    const changeSite = source.slice(
      source.indexOf("agent-admin-change-"),
      source.indexOf("agent-admin-change-") + 600,
    );
    expect(confirmSite).toContain("audit: true");
    expect(changeSite).toContain("audit: true");
  });

  it("the audit bypass exists at exactly the two agent-admin sites (nowhere else)", () => {
    // `audit: true` is a toggle-bypass capability — pin its emitter set the
    // same way the verbose registry pins classification, so a new bypass
    // site cannot appear unreviewed.
    const kRepoRoot = path.join(__dirname, "..", "..");
    const listServerFiles = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listServerFiles(full, out);
        else if (entry.name.endsWith(".js")) out.push(full);
      }
      return out;
    };
    const hits = [];
    for (const filePath of [
      ...listServerFiles(path.join(kRepoRoot, "lib", "server")),
      path.join(kRepoRoot, "lib", "server.js"),
    ]) {
      const rel = path
        .relative(kRepoRoot, filePath)
        .split(path.sep)
        .join("/");
      // The policy/outbox/notifier plumbing constructs audit fields by
      // design (same exclusion as the verbose scan).
      if (
        [
          "lib/server/notification-policy.js",
          "lib/server/notify-outbox.js",
          "lib/server/upgrade-notifier.js",
          "lib/server/watchdog.js", // envelope forwarding, not an emitter
        ].includes(rel)
      ) {
        continue;
      }
      const count = (
        fs.readFileSync(filePath, "utf8").match(/audit\s*:\s*true/g) || []
      ).length;
      if (count > 0) hits.push([rel, count]);
    }
    expect(Object.fromEntries(hits)).toEqual({
      "lib/server/init/register-server-routes.js": 2,
    });
  });
});

describe("server/upgrade-notifier policy gate", () => {
  it("suppresses a verbose event at enqueue when quiet — never queued", async () => {
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    const { notifier, outbox, fanout } = makeNotifier();

    const result = await notifier.notify("🟢 back online", {
      id: "e1",
      eventType: "recovery",
      verbose: true,
    });
    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: "verbose_notifications_disabled",
    });
    expect(outbox.listEvents()).toEqual([]);
    await notifier.flush();
    expect(fanout).not.toHaveBeenCalled();

    // An untagged event in the same env delivers.
    const important = await notifier.notify("🔴 went down", { id: "e2" });
    expect(important.ok).toBe(true);
    await notifier.flush();
    expect(fanout).toHaveBeenCalledTimes(1);
  });

  it("persists the delivery-class flags in the outbox envelope", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const { notifier, outbox } = makeNotifier();
    await notifier.notify("🟢 healthy", {
      id: "e1",
      eventType: "recovery",
      verbose: true,
    });
    await notifier.notify("🔐 agent change", { id: "e2", audit: true });
    const events = outbox.listEvents();
    expect(events.find((e) => e.id === "e1").verbose).toBe(true);
    expect(events.find((e) => e.id === "e1").audit).toBe(false);
    expect(events.find((e) => e.id === "e2").audit).toBe(true);
    expect(events.find((e) => e.id === "e2").verbose).toBe(false);
  });

  it("a throwing policy FAILS OPEN at both gates — the event still delivers", async () => {
    const boom = vi.fn(() => {
      throw new Error("policy exploded");
    });
    const { notifier, fanout } = makeNotifier({ shouldSend: boom });
    const result = await notifier.notify("must not be silenced", { id: "e1" });
    expect(result.ok).toBe(true);
    await notifier.flush();
    // Called at enqueue AND at flush; both throws delivered anyway.
    expect(boom).toHaveBeenCalledTimes(2);
    expect(fanout).toHaveBeenCalledTimes(1);
  });

  it("suppression logs the event id + eventType, never message content", async () => {
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    const lines = [];
    const logger = { log: (line) => lines.push(String(line)), error() {} };
    const { notifier } = makeNotifier({ logger });
    await notifier.notify("SECRET-TOPIC-NAME went quiet", {
      id: "evt-42",
      eventType: "recovery",
      verbose: true,
    });
    const suppression = lines.find((line) => line.includes("suppressed"));
    expect(suppression).toContain("evt-42");
    expect(suppression).toContain("recovery");
    expect(suppression).not.toContain("SECRET-TOPIC-NAME");
  });

  it("flush-time double-gate: a queued verbose event terminally suppresses after a quiet flip", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const { notifier, outbox, fanout, nowRef } = makeNotifier();
    // Queued while verbose was ON…
    await notifier.notify("🟢 informational", {
      id: "e-verbose",
      eventType: "recovery",
      verbose: true,
    });
    await notifier.notify("🔴 important", { id: "e-important" });
    // …operator flips to Important only before delivery happens.
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    await notifier.flush();

    const verboseEvent = outbox
      .listEvents()
      .find((entry) => entry.id === "e-verbose");
    expect(verboseEvent.suppressedAt).toBeTruthy();
    expect(verboseEvent.deliveredAt).toBeNull();
    // Only the important event reached the fan-out.
    expect(fanout).toHaveBeenCalledTimes(1);
    expect(fanout.mock.calls[0][0]).toBe("🔴 important");

    // Terminal: never retried, and NEVER the 48h abandonment alarm.
    fanout.mockClear();
    nowRef.now += 49 * 60 * 60 * 1000;
    const sweep = await notifier.flush();
    expect(fanout).not.toHaveBeenCalled();
    expect(sweep.abandoned).toBe(0);
    expect(
      outbox.listEvents().find((entry) => entry.id === "e-verbose")
        .abandonedAt,
    ).toBeNull();
  });

  it("outbox-unavailable fallback normalizes flush suppression to the public skipped shape", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    // Policy passes the enqueue gate, then suppresses at the flush re-check
    // (models a settings flip mid-call); the broken outbox forces the direct
    // fallback path.
    let calls = 0;
    const flippy = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? { ok: true }
        : { ok: false, reason: "verbose_notifications_disabled" };
    });
    const fanout = vi.fn(async () => ({ ok: true, sent: 1 }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: fanout, sendToTarget: vi.fn() },
      outbox: { enqueue: () => null, flush: async () => ({}) },
      operatorsStore: { read: () => ({ notifications: {} }) },
      logger: kSilentLogger,
      shouldSend: flippy,
    });
    const result = await notifier.notify("late suppression", { id: "e1" });
    // Public contract: callers see `skipped`, never the internal `suppressed`.
    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: "verbose_notifications_disabled",
    });
    expect(result.suppressed).toBeUndefined();
    expect(fanout).not.toHaveBeenCalled();
  });

  it("terminal suppression persists its reason for the audit trail", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const { notifier, outbox } = makeNotifier();
    await notifier.notify("queued then silenced", { id: "e1", verbose: true });
    process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    await notifier.flush();
    const event = outbox.listEvents()[0];
    expect(event.suppressedAt).toBeTruthy();
    // The reason survives (and restarts, via normalizeEvent) so the audit
    // trail shows WHY the event terminally suppressed.
    expect(event.suppressedReason).toBe("verbose_notifications_disabled");
  });

  it("suppressedAt survives a restart — a suppressed event never resurrects", async () => {
    delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    const openclawDir = mkTemp("notify-policy-restart-");
    const clock = { now: 1_000_000 };
    const makeInstance = () =>
      createNotifyOutbox({
        openclawDir,
        nowFn: () => clock.now,
        logger: kSilentLogger,
      });
    const first = makeInstance();
    first.enqueue({ id: "e1", message: "informational", verbose: true });
    await first.flush({
      deliver: async () => ({ ok: false, suppressed: true, reason: "test" }),
    });
    expect(first.listEvents()[0].suppressedAt).toBeTruthy();

    // New instance over the same file (process restart).
    const second = makeInstance();
    const deliver = vi.fn(async () => ({ ok: true }));
    clock.now += 60_000;
    const result = await second.flush({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);
    expect(second.listEvents()[0].suppressedAt).toBeTruthy();
  });
});

describe("server/notification-policy conventions (pin-list sync)", () => {
  // Drift-guard: /verbose\s*:/ matches in emitter source files must equal the
  // kVerboseNotificationSites registry, in both directions. The correctness
  // invariant is the behavioral per-site tests — this test only pins the SET
  // of classified sites so a tag can't appear or vanish unnoticed.
  const kRepoRoot = path.join(__dirname, "..", "..");
  // Infrastructure files construct `verbose:` plumbing literals by design and
  // are excluded from the scan (documented in notification-policy.js).
  const kInfrastructureFiles = new Set([
    "lib/server/notification-policy.js",
    "lib/server/notify-outbox.js",
    "lib/server/upgrade-notifier.js",
  ]);

  const listServerFiles = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) listServerFiles(full, out);
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };

  const countMatches = (filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    return (content.match(/verbose\s*:/g) || []).length;
  };

  it("every verbose tag maps to a registry entry and vice versa", () => {
    const expectedByFile = new Map();
    for (const site of kVerboseNotificationSites) {
      expectedByFile.set(site.file, (expectedByFile.get(site.file) || 0) + 1);
    }

    const serverFiles = [
      ...listServerFiles(path.join(kRepoRoot, "lib", "server")),
      path.join(kRepoRoot, "lib", "server.js"),
    ];
    const actualByFile = new Map();
    for (const filePath of serverFiles) {
      const rel = path.relative(kRepoRoot, filePath).split(path.sep).join("/");
      if (kInfrastructureFiles.has(rel)) continue;
      const count = countMatches(filePath);
      if (count > 0) actualByFile.set(rel, count);
    }

    expect(Object.fromEntries([...actualByFile.entries()].sort())).toEqual(
      Object.fromEntries([...expectedByFile.entries()].sort()),
    );
  });

  it("the registry is frozen and names only literal/predicate kinds", () => {
    expect(Object.isFrozen(kVerboseNotificationSites)).toBe(true);
    for (const site of kVerboseNotificationSites) {
      expect(Object.isFrozen(site)).toBe(true);
      expect(["literal", "predicate"]).toContain(site.kind);
      expect(site.file).toMatch(/^lib\//);
      expect(site.symbol.length).toBeGreaterThan(0);
    }
  });
});
