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
