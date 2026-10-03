const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNativeNotificationDelivery } = require("../../lib/server/native-notification-delivery");
const { createWatchdogNotifier } = require("../../lib/server/watchdog-notify");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");
const { createOpenclawRuntime } = require("../../lib/server/openclaw-runtime");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const logger = { log() {}, warn() {}, error() {} };
const roots = [];
const notifiers = [];
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-notification-"));
  roots.push(root);
  return root;
};
const kBuild = { buildId: "2026.9.5", version: "2026.9.5", packageDir: "/fixture/openclaw", bin: "/fixture/openclaw/openclaw.mjs" };
const kMessage = { target: "+15550001111", message: "Gateway needs recovery" };
const createCell = (overrides = {}) => {
  const state = { admitted: true };
  const lock = createGatewayLifecycleLock({ logger });
  const runStreamed = vi.fn(async () => ({ ok: true }));
  const getExecutingBuild = vi.fn(async () => kBuild);
  const tryAcquire = vi.fn((options) => lock.tryAcquire("native_notification", options));
  const getEnv = vi.fn(() => ({ PATH: process.env.PATH }));
  const deliver = createNativeNotificationDelivery({
    isBootAdmitted: () => state.admitted,
    tryAcquire,
    getExecutingBuild,
    getEnv,
    runStreamed,
    ...overrides,
  });
  return { state, lock, runStreamed, getExecutingBuild, getEnv, tryAcquire, deliver };
};
const notifierFor = (cell, options = {}) => createWatchdogNotifier({
  nativeDelivery: cell.deliver,
  clawCmd: vi.fn(async () => { throw new Error("legacy native command must not run"); }),
  openclawDir: temp(), readEnvFile: () => [{ key: "WHATSAPP_OWNER_NUMBER", value: kMessage.target }],
  getTelegramToken: () => "", getDiscordToken: () => "", ...options,
});

beforeEach(() => {
  for (const key of ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "WHATSAPP_OWNER_NUMBER", "ALPHACLAW_NOTIFY_WEBHOOK_URL"]) vi.stubEnv(key, "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const notifier of notifiers.splice(0)) notifier.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native notification admission", () => {
  it("wires production WhatsApp delivery to late-bound boot, lease and executing-build admission", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../lib/server.js"), "utf8");
    const start = source.indexOf("const watchdogNotifier = createWatchdogNotifier({");
    const block = source.slice(start, source.indexOf("\n});", start));
    expect(block).toContain("createNativeNotificationDelivery({");
    expect(block).toContain('getBootPhase().phase === "ready"');
    expect(block).toContain("!shutdownAbort.signal.aborted");
    expect(block).toContain('gatewayLifecycleLock.tryAcquire("native_notification", options)');
    expect(block).toContain("openclawRuntime.getExecutingBuild()");
    expect(block).not.toContain("openclawChannelService");
  });

  it("refuses an unadmitted boot before any native process or build read", async () => {
    const cell = createCell();
    cell.state.admitted = false;
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false, reason: "native_delivery_boot_unadmitted" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.getExecutingBuild).not.toHaveBeenCalled();
    expect(cell.tryAcquire).not.toHaveBeenCalled();
  });

  it.each(["tryAcquire", "getExecutingBuild", "getEnv"])("refuses when the %s seam is not configured", async (seam) => {
    const cell = createCell({ [seam]: undefined });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_unconfigured", deterministic: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it.each(["boot", "manual_restart", "repair"])("never queues behind an existing %s lease", async (kind) => {
    const cell = createCell();
    const owner = cell.lock.tryAcquire(kind);
    const acquire = vi.spyOn(cell.lock, "acquire");
    try {
      expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_lifecycle_busy", deterministic: false });
      expect(acquire).not.toHaveBeenCalled();
      expect(cell.lock.owns(owner)).toBe(true);
      expect(cell.getExecutingBuild).not.toHaveBeenCalled();
      expect(cell.runStreamed).not.toHaveBeenCalled();
    } finally { await owner(); }
  });

  it("refuses boot-time outbox drain before touching late-bound runtime dependencies", async () => {
    const getExecutingBuild = vi.fn(() => { throw new ReferenceError("runtime is not initialized"); });
    const cell = createCell({ getExecutingBuild }); cell.state.admitted = false;
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(getExecutingBuild).not.toHaveBeenCalled();
    expect(cell.tryAcquire).not.toHaveBeenCalled();
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("refuses a fresh outbox drain after shutdown even if boot had reached ready", async () => {
    const shutdown = new AbortController();
    shutdown.abort("shutdown");
    const cell = createCell({ isBootAdmitted: () => !shutdown.signal.aborted });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(cell.tryAcquire).not.toHaveBeenCalled();
    expect(cell.getExecutingBuild).not.toHaveBeenCalled();
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("does not launch if shutdown begins while the executing build is being read", async () => {
    const shutdown = new AbortController();
    const cell = createCell({ isBootAdmitted: () => !shutdown.signal.aborted });
    cell.getExecutingBuild.mockImplementation(async () => {
      await Promise.resolve();
      shutdown.abort("shutdown");
      return kBuild;
    });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(cell.tryAcquire).toHaveBeenCalledOnce();
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it.each([null, {}, { bin: 42 }, { bin: "" }, { bin: "relative/openclaw.mjs" }])("refuses an unverified executing build %j", async (build) => {
    const cell = createCell({ getExecutingBuild: async () => build });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_build_unverified", deterministic: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("runs the executing build with argv isolation, an owned lease, and a cancellable process-group runner", async () => {
    const cell = createCell();
    cell.runStreamed.mockImplementation(async (options) => {
      expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "native_notification" });
      expect(options.signal.aborted).toBe(false);
      return { ok: true };
    });
    const message = "Message with `shell` and $(expressions)";
    expect(await cell.deliver({ ...kMessage, message })).toEqual({ ok: true });
    expect(cell.runStreamed).toHaveBeenCalledOnce();
    expect(cell.runStreamed).toHaveBeenCalledWith(expect.objectContaining({ command: process.execPath,
      args: [kBuild.bin, "message", "send", "--channel", "whatsapp", "--target", kMessage.target, "--message", message],
      killGraceMs: 1000, signal: expect.any(AbortSignal), onProcess: expect.any(Function) }));
    expect(cell.getExecutingBuild).toHaveBeenCalledOnce();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("reports a failed send as a non-deterministic refusal", async () => {
    const cell = createCell();
    cell.runStreamed.mockResolvedValue({ ok: false });
    expect(await cell.deliver(kMessage)).toEqual({ ok: false, reason: "native_whatsapp_send_failed", errorCode: null, deterministic: false });
  });

  it("rechecks admission that is lost during the executing-build read", async () => {
    const cell = createCell();
    cell.getExecutingBuild.mockImplementation(async () => { cell.state.admitted = false; return kBuild; });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("checks admission again immediately before spawning, after environment resolution", async () => {
    const cell = createCell();
    cell.getEnv.mockImplementation(() => { cell.state.admitted = false; return {}; });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("does not launch after its lease is revoked while the executing build is being read", async () => {
    const cell = createCell();
    let hold;
    const acquire = cell.tryAcquire.getMockImplementation();
    cell.tryAcquire.mockImplementation((options) => { hold = acquire(options); return hold; });
    cell.getExecutingBuild.mockImplementation(async () => {
      await hold();
      return kBuild;
    });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("bounds an unresponsive executing-build read and ignores its eventual result", async () => {
    let resolveBuild;
    const cell = createCell({ buildReadTimeoutMs: 10,
      getExecutingBuild: () => new Promise((resolve) => { resolveBuild = resolve; }) });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false });
    resolveBuild(kBuild);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("retains the lifecycle cleanup lease until the native process confirms completion after timeout", async () => {
    vi.useFakeTimers();
    const cell = createCell({ timeoutMs: 20 });
    let finishProcess;
    let signal;
    cell.runStreamed.mockImplementation((options) => {
      signal = options.signal;
      options.onProcess({ pid: 12345, phase: "running" });
      return new Promise((resolve) => { finishProcess = () => {
        options.onProcess({ pid: 12345, phase: "cleaned" }); resolve({ ok: false });
      }; });
    });
    let settled = false;
    const delivery = cell.deliver(kMessage).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(21);
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "native_notification", phase: "cleanup" });
    expect(cell.lock.tryAcquire("manual_restart")).toBeNull();
    finishProcess();
    expect(await delivery).toMatchObject({ ok: false, deterministic: false });
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("drains a real synthetic process group before releasing its notification lease", async () => {
    const root = temp();
    const bin = path.join(root, "synthetic-native.cjs");
    const started = path.join(root, "started");
    const drained = path.join(root, "drained");
    fs.writeFileSync(bin, `const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(started)}, "started");
      process.on("SIGTERM", () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(drained)}, "drained"); process.exit(0);
      }, 40));
      setInterval(() => {}, 100);
    `);
    const build = { ...kBuild, packageDir: root, bin };
    const realRunner = createRunStream();
    let cell;
    let observedCleanup = false;
    cell = createCell({ timeoutMs: 400,
      getExecutingBuild: async () => build,
      runStreamed: (options) => realRunner.runStreamed({ ...options, onProcess: (event) => {
        if (event.phase === "cleaned") {
          observedCleanup = true;
          expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "native_notification" });
          expect(fs.readFileSync(drained, "utf8")).toBe("drained");
        }
        options.onProcess(event);
      } }),
    });

    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false });
    expect(fs.readFileSync(started, "utf8")).toBe("started");
    expect(fs.readFileSync(drained, "utf8")).toBe("drained");
    expect(observedCleanup).toBe(true);
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("does not send a notification which expires during the executing-build read", async () => {
    let current = true;
    const cell = createCell({ getExecutingBuild: async () => { current = false; return kBuild; } });
    expect(await cell.deliver({ ...kMessage, shouldDeliver: () => current })).toMatchObject({ expired: true, ok: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });
});

describe("native notification routing and durable retries", () => {
  it("uses the admitted native path for both fan-out and explicit WhatsApp targets without the legacy CLI", async () => {
    const cell = createCell();
    const legacy = vi.fn();
    const notifier = notifierFor(cell, { clawCmd: legacy });
    expect(await notifier.notify("fan-out alert")).toMatchObject({ ok: true, sent: 1, channels: { whatsapp: { sent: 1, failed: 0 } } });
    expect(await notifier.sendToTarget({ channel: "whatsapp", target: "+15550002222" }, "targeted alert")).toEqual({ ok: true });
    expect(cell.runStreamed).toHaveBeenCalledTimes(2);
    expect(cell.runStreamed.mock.calls.map(([options]) => options.args.slice(-3))).toEqual([
      [kMessage.target, "--message", "fan-out alert"], ["+15550002222", "--message", "targeted alert"],
    ]);
    expect(legacy).not.toHaveBeenCalled();
    expect(notifier.getLastDeliveredAt()).not.toBeNull();
  });

  it("never bypasses a malformed production admission seam through the legacy command fallback", async () => {
    const legacy = vi.fn();
    const notifier = notifierFor(createCell(), { nativeDelivery: false, clawCmd: legacy });
    expect(await notifier.sendToTarget({ channel: "whatsapp", target: kMessage.target }, "m"))
      .toMatchObject({ ok: false, reason: "native_delivery_unavailable", deterministic: false });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("blocks both WhatsApp entry points without blocking direct Telegram, Discord, Slack, or webhook alerts", async () => {
    const cell = createCell(); cell.state.admitted = false;
    vi.stubEnv("SLACK_BOT_TOKEN", "test-slack-token");
    vi.stubEnv("ALPHACLAW_NOTIFY_WEBHOOK_URL", "https://notify.invalid/hook");
    const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const discordApi = { sendDirectMessage: vi.fn(async () => ({ ok: true })) };
    const slackApi = { postMessage: vi.fn(async () => ({ ok: true })) };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const legacy = vi.fn();
    const notifier = notifierFor(cell, { telegramApi, discordApi, slackApi, fetchImpl, clawCmd: legacy,
      getTelegramToken: () => "test-telegram-token", getDiscordToken: () => "test-discord-token",
      readChannelAllowFrom: (channel) => channel === "telegram" ? ["123"] : [] });
    const fanout = await notifier.notify(kMessage.message);
    expect(fanout).toMatchObject({ ok: true, channels: { whatsapp: { sent: 0, failed: 1 },
      telegram: { sent: 1 }, webhook: { sent: 1 } }, failures: [{ channel: "whatsapp", deterministic: false }] });
    expect(await notifier.sendToTarget({ channel: "whatsapp", target: kMessage.target }, "m"))
      .toMatchObject({ ok: false, deterministic: false, reason: "native_delivery_boot_unadmitted" });
    for (const [channel, target] of [["telegram", "123"], ["discord", "234"], ["slack", "U_TEST"]]) {
      expect(await notifier.sendToTarget({ channel, target }, "HTTP alert")).toEqual({ ok: true });
    }
    expect(legacy).not.toHaveBeenCalled();
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(telegramApi.sendMessage).toHaveBeenCalled();
    expect(discordApi.sendDirectMessage).toHaveBeenCalledOnce();
    expect(slackApi.postMessage).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back from blocked preferred WhatsApp to an HTTP target without making the native refusal terminal", async () => {
    const cell = createCell(); cell.state.admitted = false;
    const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const notifier = notifierFor(cell, { telegramApi, getTelegramToken: () => "test-token" });
    const routed = createUpgradeNotifier({ notifier, logger, shouldSend: () => ({ ok: true }),
      outbox: createNotifyOutbox({ openclawDir: temp(), logger }),
      operatorsStore: { read: () => ({ notifications: { preferredChannel: "whatsapp", adminTargets: [
        { channel: "whatsapp", target: kMessage.target }, { channel: "telegram", target: "123" },
      ] } }) } });
    notifiers.push(routed);
    const result = await routed.deliverEvent({ id: "blocked", message: kMessage.message, eventType: "health", createdAt: Date.now() });
    expect(result).toMatchObject({ ok: true, fallback: true, sent: 1, failed: 1,
      failures: [{ channel: "whatsapp", deterministic: false }] });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(telegramApi.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps blocked WhatsApp in the real outbox and delivers it after later boot admission", async () => {
    const cell = createCell(); cell.state.admitted = false;
    let now = Date.now();
    const outbox = createNotifyOutbox({ openclawDir: temp(), logger, nowFn: () => now, backoffBaseMs: 10 });
    const routed = createUpgradeNotifier({ notifier: notifierFor(cell), outbox, logger, shouldSend: () => ({ ok: true }),
      operatorsStore: { read: () => ({ notifications: { adminTargets: [{ channel: "whatsapp", target: kMessage.target }] } }) } });
    notifiers.push(routed);
    await routed.notify(kMessage.message, { id: "boot-alert", eventType: "health" });
    const blocked = await routed.flush();
    expect(blocked).toMatchObject({ delivered: 0, abandoned: 0, pending: 1 });
    const queued = outbox.listEvents()[0];
    expect(queued.deliveredAt).toBeNull();
    expect(queued.abandonedAt).toBeNull();
    expect(cell.runStreamed).not.toHaveBeenCalled();
    cell.state.admitted = true;
    now = queued.nextAttemptAt + 1;
    expect(await routed.flush()).toMatchObject({ delivered: 1, abandoned: 0, pending: 0 });
    expect(cell.runStreamed).toHaveBeenCalledOnce();
    expect(outbox.listEvents()[0].deliveredAt).toBe(now);
  });
});

describe("native notification real executing-build adapter", () => {
  it.each(["installed", "missing"])("resolves the %s pinned package without invoking a real WhatsApp send", async (kind) => {
    const root = temp();
    const packageDir = path.join(root, "node_modules/openclaw");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.9.5" } }));
    if (kind === "installed") {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.5", bin: "openclaw.mjs" }));
      fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), 'throw new Error("must never execute in this test");');
    }
    const runtime = createOpenclawRuntime({ packageRoot: root, resolveInstallDir: () => root, openclawDir: path.join(root, ".openclaw"),
      openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: path.join(root, ".openclaw") }), logger });
    const cell = createCell({ getExecutingBuild: () => runtime.getExecutingBuild() });
    const result = await cell.deliver(kMessage);
    if (kind === "installed") {
      expect(result).toEqual({ ok: true });
      expect(cell.runStreamed.mock.calls[0][0].args[0]).toBe(path.join(packageDir, "openclaw.mjs"));
    } else {
      expect(result).toMatchObject({ ok: false, reason: "native_delivery_build_unverified" });
      expect(cell.runStreamed).not.toHaveBeenCalled();
    }
    expect(cell.lock.getActiveOperation()).toBeNull();
  });
});
