// Every sink an env value can reach redacts it (key names only for the env
// change line, credential masking everywhere else): watchdog events, chat
// notifications and the out-of-band webhook, the durable outbox, Doctor card
// text, exec failures that echo argv, the onboarding command log and the boot
// report. One credential URL (the shape that leaked: a database URL whose key
// name announces nothing) and one token shape per sink.
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kDbUrl = "postgres://app:hunter2-db-password@db.internal:5432/app";
const kMaskedDbUrl = "postgres://***@db.internal:5432/app";
const kSecretFragment = "hunter2-db-password";

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const kSilentLogger = { log() {}, warn() {}, error() {} };

describe("env value redaction across sinks", () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });

  it("watchdog events store redacted details, object or JSON string", () => {
    const modulePath = require.resolve("../../lib/server/db/watchdog");
    delete require.cache[modulePath];
    const db = require(modulePath);
    const rootDir = mkTemp("alphaclaw-redact-events-");
    db.initWatchdogDb({ rootDir, pruneDays: 30 });
    cleanups.push(() => {
      db.closeWatchdogDb();
      fs.rmSync(rootDir, { recursive: true, force: true });
    });

    db.insertWatchdogEvent({
      eventType: "crash",
      source: "gateway",
      status: "failed",
      details: { stderrTail: "connect " + kDbUrl + " refused", env: [{ key: "APP_DB_URL", value: "x" }] },
    });
    db.insertWatchdogEvent({
      eventType: "crash",
      source: "gateway",
      status: "failed",
      details: JSON.stringify({ message: "auth xoxb-1234567890-abcdefghijkl", url: kDbUrl }),
    });
    const stored = JSON.stringify(db.getRecentEvents({ limit: 10, includeRoutine: true }));
    expect(stored).not.toContain(kSecretFragment);
    expect(stored).not.toContain("xoxb-1234567890");
    expect(stored).toContain(kMaskedDbUrl);
  });

  it("watchdog event reads mask rows written before insert-time redaction", () => {
    const { DatabaseSync } = require("node:sqlite");
    const modulePath = require.resolve("../../lib/server/db/watchdog");
    delete require.cache[modulePath];
    const db = require(modulePath);
    const rootDir = mkTemp("alphaclaw-redact-events-old-");
    const { path: dbPath } = db.initWatchdogDb({ rootDir, pruneDays: 30 });
    cleanups.push(() => {
      db.closeWatchdogDb();
      fs.rmSync(rootDir, { recursive: true, force: true });
    });
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare("INSERT INTO watchdog_events (event_type, source, status, details) VALUES (?, ?, ?, ?)")
      .run("crash", "gateway", "failed", JSON.stringify({ stderrTail: "connect " + kDbUrl }));
    raw.close();
    const read = JSON.stringify(db.getRecentEvents({ limit: 10, includeRoutine: true }));
    expect(read).toContain(kMaskedDbUrl);
    expect(read).not.toContain(kSecretFragment);
  });

  it("the out-of-band webhook posts redacted text", async () => {
    const { postNotifyWebhookDirect } = require("../../lib/server/notify-webhook");
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await postNotifyWebhookDirect("boot failed: " + kDbUrl, {
      fetchImpl,
      env: { ALPHACLAW_NOTIFY_WEBHOOK_URL: "https://hooks.example/notify" },
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ text: "boot failed: " + kMaskedDbUrl });
  });

  it("chat notifications are redacted on both the fan-out and the admin-target path", async () => {
    const { createWatchdogNotifier } = require("../../lib/server/watchdog-notify");
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    cleanups.push(() => {
      if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previous;
    });
    const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
    const notifier = createWatchdogNotifier({
      telegramApi,
      fsImpl: {
        existsSync: () => false,
        readdirSync: () => [],
        readFileSync: () => {
          throw new Error("unexpected read");
        },
      },
      openclawDir: "/tmp/openclaw",
    });
    await notifier.sendToTarget({ channel: "telegram", target: "12345" }, "db down: " + kDbUrl);
    expect(telegramApi.sendMessage.mock.calls[0][1]).toBe("db down: " + kMaskedDbUrl);

    const nativeDelivery = vi.fn(async () => ({ ok: true }));
    const fanout = createWatchdogNotifier({
      nativeDelivery,
      readEnvFile: () => [{ key: "WHATSAPP_OWNER_NUMBER", value: "+15550000000" }],
      fsImpl: { existsSync: () => false, readdirSync: () => [], readFileSync: () => "{}" },
      openclawDir: "/tmp/openclaw",
      getTelegramToken: () => "",
      getDiscordToken: () => "",
      fetchImpl: vi.fn(async () => ({ ok: true })),
    });
    await fanout.notify("db down: " + kDbUrl);
    expect(nativeDelivery.mock.calls[0][0].message).toBe("db down: " + kMaskedDbUrl);
  });

  it("the durable outbox never persists the raw message", async () => {
    const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
    const { createUpgradeNotifier } = require("../../lib/server/upgrade-notifier");
    const openclawDir = mkTemp("alphaclaw-redact-outbox-");
    cleanups.push(() => fs.rmSync(openclawDir, { recursive: true, force: true }));
    const outbox = createNotifyOutbox({ openclawDir, nowFn: () => 1_000_000, logger: kSilentLogger });
    const fanout = vi.fn(async () => ({ ok: true, sent: 1 }));
    const notifier = createUpgradeNotifier({
      notifier: { notify: fanout, sendToTarget: vi.fn() },
      outbox,
      operatorsStore: { read: () => ({ notifications: { preferredChannel: null, adminTargets: [] } }) },
      logger: kSilentLogger,
    });
    await notifier.notify("restart failed: " + kDbUrl, { id: "e1", eventType: "info" });
    await notifier.flush();
    expect(fanout.mock.calls[0][0]).toBe("restart failed: " + kMaskedDbUrl);
    expect(fs.readFileSync(outbox.outboxPath, "utf8")).not.toContain(kSecretFragment);
  });

  it("Doctor card text masks a credential URL under a key name that announces nothing", () => {
    const { createDoctorTextSanitizer } = require("../../lib/server/doctor/sanitize");
    const { sanitize } = createDoctorTextSanitizer({ env: {} });
    expect(sanitize("skill reads " + kDbUrl)).toBe("skill reads " + kMaskedDbUrl);
  });

  it("the stream redactor collects connection strings from the env whatever the key", () => {
    const { collectSecretValues, createRedactor } = require("../../lib/server/utils/secret-redactor");
    const values = collectSecretValues({ env: { APP_DATABASE_URL: kDbUrl, HOME: "/home/app" } });
    expect(values).toEqual([kDbUrl]);
    expect(createRedactor(values).scrub("npm ERR " + kDbUrl + "\n")).toBe("npm ERR [redacted]\n");
  });

  it("execFile failures drop secret flag values and credential URLs from err.message", async () => {
    const original = childProcess.execFile;
    const modulePath = require.resolve("../../lib/server/commands");
    childProcess.execFile = vi.fn((file, args, opts, callback) =>
      callback(Object.assign(new Error("Command failed: " + file + " " + args.join(" ")), { code: 1 }), "", "boom"),
    );
    cleanups.push(() => {
      childProcess.execFile = original;
      delete require.cache[modulePath];
    });
    delete require.cache[modulePath];
    const { createCommands } = require(modulePath);
    const { execFileCmd } = createCommands({ gatewayEnv: () => ({}) });
    const error = await execFileCmd("openclaw", [
      "channels",
      "add",
      "--bot-token",
      "plain-bot-token-value",
      "--url",
      kDbUrl,
    ]).catch((err) => err);
    expect(error.message).not.toContain("plain-bot-token-value");
    expect(error.message).not.toContain(kSecretFragment);
    expect(error.message).toContain(kMaskedDbUrl);
  });

  it("the onboarding command log and its failure line mask credential URLs", async () => {
    const original = childProcess.exec;
    const modulePath = require.resolve("../../lib/server/commands");
    childProcess.exec = vi.fn((cmd, opts, callback) =>
      callback(Object.assign(new Error("Command failed: " + cmd), { code: 1 }), "", ""),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => {
      childProcess.exec = original;
      logSpy.mockRestore();
      errorSpy.mockRestore();
      delete require.cache[modulePath];
    });
    delete require.cache[modulePath];
    const { createCommands } = require(modulePath);
    const { shellCmd } = createCommands({ gatewayEnv: () => ({}) });
    const error = await shellCmd("openclaw config set db.url " + kDbUrl).catch((err) => err);
    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls].map(([line]) => String(line)).join("\n");
    expect(printed).toContain(kMaskedDbUrl);
    expect(printed).not.toContain(kSecretFragment);
    expect(error.message).not.toContain(kSecretFragment);
    expect(error.cmd).not.toContain(kSecretFragment);
  });

  it("the boot report is written with git and CLI output redacted", () => {
    const { buildBinPhaseReport, createBootReportWriter } = require("../../lib/server/boot-report");
    const managedDir = path.join(mkTemp("alphaclaw-redact-boot-"), ".alphaclaw");
    cleanups.push(() => fs.rmSync(path.dirname(managedDir), { recursive: true, force: true }));
    const writer = createBootReportWriter({ managedDir, bootId: "40:1700000000000", nowFn: () => 1, logger: kSilentLogger });
    const written = writer.writeBinPhase(
      buildBinPhaseReport({
        bootId: "40:1700000000000",
        at: 1,
        bootSync: {
          action: "synced",
          reason: "ok",
          warnings: ["fetch https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r failed"],
        },
      }),
    );
    const onDisk = fs.readFileSync(writer.reportPath, "utf8");
    expect(onDisk).not.toContain("ghp_");
    expect(onDisk).toContain("https://***@github.com/o/r");
    expect(JSON.parse(onDisk)).toEqual(written);
  });
});
