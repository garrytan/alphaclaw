const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createNativeNotificationDelivery } = require("../../lib/server/native-notification-delivery");
const { createWatchdogNotifier } = require("../../lib/server/watchdog-notify");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
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
  const state = { admitted: true, quiet: false, applying: false, info: { gatewayHold: null, stateCorrupted: false, installedDiverged: false } };
  const lock = createGatewayLifecycleLock({ logger });
  const runStreamed = vi.fn(async () => ({ ok: true }));
  const assessCompatibility = vi.fn(async () => ({ compatible: true, migrationRequired: false, executingBuild: kBuild }));
  const getExecutingBuild = vi.fn(async () => kBuild);
  const tryAcquire = vi.fn((options) => lock.tryAcquire("native_notification", options));
  const getEnv = vi.fn(() => ({ PATH: process.env.PATH }));
  const deliver = createNativeNotificationDelivery({
    isBootAdmitted: () => state.admitted,
    tryAcquire,
    getChannelInfo: () => state.info,
    isApplyInProgress: () => state.applying,
    isQuiet: () => state.quiet,
    assessCompatibility,
    getExecutingBuild,
    getEnv,
    runStreamed,
    ...overrides,
  });
  return { state, lock, runStreamed, assessCompatibility, getExecutingBuild, getEnv, tryAcquire, deliver };
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
  it("wires production WhatsApp delivery to late-bound boot, channel, lease and compatibility admission", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../lib/server.js"), "utf8");
    const start = source.indexOf("const watchdogNotifier = createWatchdogNotifier({");
    const block = source.slice(start, source.indexOf("\n});", start));
    expect(block).toContain('createNativeNotificationDelivery({');
    expect(block).toContain('getBootPhase().phase === "ready"');
    expect(block).toContain("!gatewayQuiesceAbort.signal.aborted");
    expect(block).toContain('gatewayLifecycleLock.tryAcquire("native_notification", options)');
    expect(block).toContain("openclawChannelService.assessInstalledLaunchCompatibility");
    expect(block).toContain("openclawChannelService.isApplyInProgress()");
    expect(block).toContain("openclawChannelService.getExecutingBuild()");
  });

  it.each([
    ["boot", "native_delivery_boot_unadmitted"], ["quiet", "native_delivery_state_db_quiet"],
    ["apply", "native_delivery_apply_in_progress"], ["held", "native_delivery_gateway_held"],
    ["corrupt", "native_delivery_state_unreadable"], ["diverged", "native_delivery_build_diverged"],
  ])("refuses %s state before any native process or compatibility read", async (kind, reason) => {
    const cell = createCell();
    if (kind === "boot") cell.state.admitted = false;
    if (kind === "quiet") cell.state.quiet = true;
    if (kind === "apply") cell.state.applying = true;
    if (kind === "held") cell.state.info.gatewayHold = { reason: "recovery_choice_required" };
    if (kind === "corrupt") cell.state.info.stateCorrupted = true;
    if (kind === "diverged") cell.state.info.installedDiverged = true;
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false, reason });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.assessCompatibility).not.toHaveBeenCalled();
    expect(cell.tryAcquire).not.toHaveBeenCalled();
  });

  it.each(["boot", "apply_commit", "repair"])("never queues behind an existing %s lease", async (kind) => {
    const cell = createCell();
    const owner = cell.lock.tryAcquire(kind);
    const acquire = vi.spyOn(cell.lock, "acquire");
    try {
      expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_lifecycle_busy", deterministic: false });
      expect(acquire).not.toHaveBeenCalled();
      expect(cell.lock.owns(owner)).toBe(true);
      expect(cell.assessCompatibility).not.toHaveBeenCalled();
      expect(cell.runStreamed).not.toHaveBeenCalled();
    } finally { await owner(); }
  });

  it("refuses boot-time outbox drain before touching late-bound channel dependencies", async () => {
    const getChannelInfo = vi.fn(() => { throw new ReferenceError("channel service is not initialized"); });
    const cell = createCell({ getChannelInfo }); cell.state.admitted = false;
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(getChannelInfo).not.toHaveBeenCalled();
    expect(cell.tryAcquire).not.toHaveBeenCalled();
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("refuses a fresh outbox drain after shutdown even if boot had reached ready", async () => {
    const shutdown = new AbortController();
    shutdown.abort("shutdown");
    const cell = createCell({ isBootAdmitted: () => !shutdown.signal.aborted });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(cell.tryAcquire).not.toHaveBeenCalled();
    expect(cell.assessCompatibility).not.toHaveBeenCalled();
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("does not launch if shutdown begins while compatibility verification is awaiting a result", async () => {
    const shutdown = new AbortController();
    const cell = createCell({ isBootAdmitted: () => !shutdown.signal.aborted });
    cell.assessCompatibility.mockImplementation(async () => {
      await Promise.resolve();
      shutdown.abort("shutdown");
      return { compatible: true, migrationRequired: false, executingBuild: kBuild };
    });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_boot_unadmitted", deterministic: false });
    expect(cell.tryAcquire).toHaveBeenCalledOnce();
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it.each([null, {}, { compatible: null, migrationRequired: false }, { compatible: false, migrationRequired: false },
    { compatible: true, migrationRequired: true }, { compatible: true, migrationRequired: null }])("refuses unproved native compatibility %j", async (verdict) => {
    const cell = createCell({ assessCompatibility: async () => verdict });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_compatibility_unverified", deterministic: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("runs the exact verified build with argv isolation, an owned lease, and a cancellable process-group runner", async () => {
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
    expect(cell.assessCompatibility).toHaveBeenCalledOnce();
    expect(cell.getExecutingBuild).toHaveBeenCalledOnce();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("rechecks a hold established during the fresh compatibility read", async () => {
    const cell = createCell();
    cell.assessCompatibility.mockImplementation(async () => {
      cell.state.info.gatewayHold = { reason: "recovery_choice_required" };
      return { compatible: true, migrationRequired: false, executingBuild: kBuild };
    });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_gateway_held" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("rechecks an apply that starts during the executing-build read", async () => {
    const cell = createCell();
    cell.getExecutingBuild.mockImplementation(async () => { cell.state.applying = true; return kBuild; });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_apply_in_progress" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("checks quiet admission again immediately before spawning, after environment resolution", async () => {
    const cell = createCell();
    cell.getEnv.mockImplementation(() => { cell.state.quiet = true; return {}; });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_state_db_quiet" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("refuses a different executing build instead of using a previously verified PATH binary", async () => {
    const cell = createCell({ getExecutingBuild: async () => ({ ...kBuild, buildId: "2026.9.6" }) });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, reason: "native_delivery_build_changed" });
    expect(cell.runStreamed).not.toHaveBeenCalled();
  });

  it("does not launch after its lease is revoked while compatibility is being read", async () => {
    const cell = createCell();
    let hold;
    const acquire = cell.tryAcquire.getMockImplementation();
    cell.tryAcquire.mockImplementation((options) => { hold = acquire(options); return hold; });
    cell.assessCompatibility.mockImplementation(async () => {
      await hold();
      return { compatible: true, migrationRequired: false, executingBuild: kBuild };
    });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false });
    expect(cell.runStreamed).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("bounds an unresponsive compatibility read and ignores its eventual safe verdict", async () => {
    let resolveCompatibility;
    const cell = createCell({ compatibilityTimeoutMs: 10,
      assessCompatibility: () => new Promise((resolve) => { resolveCompatibility = resolve; }) });
    expect(await cell.deliver(kMessage)).toMatchObject({ ok: false, deterministic: false });
    resolveCompatibility({ compatible: true, migrationRequired: false, executingBuild: kBuild });
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
    expect(cell.lock.tryAcquire("apply_commit")).toBeNull();
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
      assessCompatibility: async () => ({ compatible: true, migrationRequired: false, executingBuild: build }),
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

  it("does not send a notification which expires during compatibility discovery", async () => {
    let current = true;
    const cell = createCell({ assessCompatibility: async () => {
      current = false; return { compatible: true, migrationRequired: false, executingBuild: kBuild };
    } });
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
    const cell = createCell(); cell.state.info.gatewayHold = { reason: "recovery_choice_required" };
    const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const notifier = notifierFor(cell, { telegramApi, getTelegramToken: () => "test-token" });
    const routed = createUpgradeNotifier({ notifier, logger, shouldSend: () => ({ ok: true }),
      outbox: createNotifyOutbox({ openclawDir: temp(), logger }),
      operatorsStore: { read: () => ({ notifications: { preferredChannel: "whatsapp", adminTargets: [
        { channel: "whatsapp", target: kMessage.target }, { channel: "telegram", target: "123" },
      ] } }) } });
    notifiers.push(routed);
    const result = await routed.deliverEvent({ id: "held", message: kMessage.message, eventType: "health", createdAt: Date.now() });
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

describe("native notification real compatibility adapter", () => {
  it.each(["corrupt", "migration", "same-schema"])("checks %s SQLite without invoking a real WhatsApp send", async (kind) => {
    const root = temp();
    const state = path.join(root, ".openclaw");
    const packageDir = path.join(root, "node_modules/openclaw");
    fs.mkdirSync(path.join(state, "state"), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "dist/extensions"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.9.5" } }));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.5", bin: "openclaw.mjs",
      openclaw: { schemaVersions: { state: 17, agent: 21 } } }));
    fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), 'throw new Error("must never execute in this test");');
    fs.writeFileSync(path.join(packageDir, "dist/thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];\n");
    fs.writeFileSync(path.join(state, "openclaw.json"), "{}");
    const databasePath = path.join(state, "state/openclaw.sqlite");
    if (kind === "corrupt") fs.writeFileSync(databasePath, "not a database");
    else {
      const version = kind === "migration" ? 16 : 17;
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA user_version=${version}; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES('primary','global',${version},NULL);`);
      database.close();
    }
    const before = fs.readFileSync(databasePath);
    const store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir: state, logger });
    store.writeSentinel({ installDir: root, version: "2026.9.5" });
    const sync = createOpenclawChannelSync({ rootDir: root, openclawDir: state, packageRoot: root,
      store, resolveInstallDir: () => root, isOnboarded: () => true,
      openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: state }), logger });
    const cell = createCell({ getChannelInfo: () => sync.getChannelInfo(), isApplyInProgress: () => sync.isApplyInProgress(),
      assessCompatibility: () => sync.assessInstalledLaunchCompatibility(), getExecutingBuild: () => sync.getExecutingBuild() });
    const result = await cell.deliver(kMessage);
    expect(result.ok).toBe(kind === "same-schema");
    expect(cell.runStreamed).toHaveBeenCalledTimes(kind === "same-schema" ? 1 : 0);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(cell.lock.getActiveOperation()).toBeNull();
  });
});
