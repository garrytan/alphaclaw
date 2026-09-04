const path = require("path");

const {
  createWatchdogNotifier,
  resolveTelegramBotToken,
  sendTelegramRendered,
  formatSlackMessage,
  kTelegramTargetSourcePairing,
  kTelegramTargetSourceAllowFrom,
  kTelegramTargetSourceAdmin,
} = require("../../lib/server/watchdog-notify");

// Telegram API errors as telegram-api.js throws them (error_code attached).
const telegramError = (message, errorCode) =>
  Object.assign(new Error(message), { telegramErrorCode: errorCode });
const kParseError = () =>
  telegramError(
    "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12",
    400,
  );
const kPlainOpts = { disableWebPagePreview: true };
const kHtmlOpts = { parseMode: "HTML", disableWebPagePreview: true };

// `entries` = pairing files under <openclawDir>/credentials; `openclawJson`
// (object or raw string, for unparseable-config cases) is served as
// <openclawDir>/openclaw.json for the allowFrom/token fallback reads.
const buildCredentialsFsMock = (entries = {}, { openclawJson } = {}) => {
  const openclawDir = "/tmp/openclaw";
  const credentialsDir = path.join(openclawDir, "credentials");
  const files = new Map(
    Object.entries(entries).map(([fileName, allowFrom]) => [
      path.join(credentialsDir, fileName),
      JSON.stringify({ allowFrom }),
    ]),
  );
  if (openclawJson !== undefined) {
    files.set(
      path.join(openclawDir, "openclaw.json"),
      typeof openclawJson === "string"
        ? openclawJson
        : JSON.stringify(openclawJson),
    );
  }

  return {
    existsSync: vi.fn((targetPath) => {
      const normalizedTargetPath = String(targetPath || "");
      return normalizedTargetPath === credentialsDir || files.has(normalizedTargetPath);
    }),
    readdirSync: vi.fn((targetPath) => {
      if (String(targetPath || "") !== credentialsDir) return [];
      return Array.from(files.keys())
        .filter((filePath) => path.dirname(filePath) === credentialsDir)
        .map((filePath) => path.basename(filePath));
    }),
    readFileSync: vi.fn((targetPath) => {
      const normalizedTargetPath = String(targetPath || "");
      const value = files.get(normalizedTargetPath);
      if (value === undefined) {
        throw new Error(`Unexpected read: ${normalizedTargetPath}`);
      }
      return value;
    }),
  };
};

const buildSlackApiFactory = () => {
  const clientsByToken = new Map();
  const countersByToken = new Map();
  const createSlackApi = vi.fn((getToken) => {
    const token = typeof getToken === "function" ? getToken() : getToken;
    if (clientsByToken.has(token)) {
      return clientsByToken.get(token);
    }
    const client = {
      postMessage: vi.fn(async (_userId, _text, _opts = {}) => {
        const nextCount = Number(countersByToken.get(token) || 0) + 1;
        countersByToken.set(token, nextCount);
        return {
          ts: `${token}-ts-${nextCount}`,
          channel: `dm-${token}`,
        };
      }),
      addReaction: vi.fn(async () => ({ ok: true })),
    };
    clientsByToken.set(token, client);
    return client;
  });

  return {
    createSlackApi,
    clientsByToken,
  };
};

describe("server/watchdog-notify", () => {
  let consoleErrorSpy = null;
  const kManagedEnvKeys = [
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "WHATSAPP_OWNER_NUMBER",
    "ALPHACLAW_NOTIFY_WEBHOOK_URL",
  ];
  const kOriginalEnv = new Map(
    kManagedEnvKeys.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    for (const key of kManagedEnvKeys) {
      const original = kOriginalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("sends Slack watchdog notifications across default and named accounts with isolated threads", async () => {
    const fsMock = buildCredentialsFsMock({
      "slack-default-allowFrom.json": ["U_SHARED_THREAD"],
      "slack-alerts-allowFrom.json": ["U_SHARED_THREAD"],
    });
    const { createSlackApi, clientsByToken } = buildSlackApiFactory();
    const notifier = createWatchdogNotifier({
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [
        { key: "SLACK_BOT_TOKEN", value: "xoxb-default" },
        { key: "SLACK_BOT_TOKEN_ALERTS", value: "xoxb-alerts" },
      ],
      createSlackApi,
    });

    const crashResult = await notifier.notify("Crash detected", {
      eventType: "crash",
    });
    const recoveryResult = await notifier.notify("Recovered", {
      eventType: "recovery",
    });

    expect(crashResult.channels.slack).toEqual({
      sent: 2,
      failed: 0,
      skipped: false,
      targets: 2,
    });
    expect(recoveryResult.channels.slack).toEqual({
      sent: 2,
      failed: 0,
      skipped: false,
      targets: 2,
    });

    const defaultClient = clientsByToken.get("xoxb-default");
    const alertsClient = clientsByToken.get("xoxb-alerts");
    expect(defaultClient.postMessage.mock.calls[0][2]).toEqual({
      thread_ts: null,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(defaultClient.postMessage.mock.calls[1][2]).toEqual({
      thread_ts: "xoxb-default-ts-1",
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(alertsClient.postMessage.mock.calls[0][2]).toEqual({
      thread_ts: null,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(alertsClient.postMessage.mock.calls[1][2]).toEqual({
      thread_ts: "xoxb-alerts-ts-1",
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("reports partial Slack delivery failure when one account is missing a bot token", async () => {
    const fsMock = buildCredentialsFsMock({
      "slack-default-allowFrom.json": ["U_DEFAULT_OK"],
      "slack-alerts-allowFrom.json": ["U_ALERTS_MISSING"],
    });
    const { createSlackApi, clientsByToken } = buildSlackApiFactory();
    const notifier = createWatchdogNotifier({
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
      createSlackApi,
    });

    const result = await notifier.notify("Health check", {
      eventType: "health",
    });

    expect(result.channels.slack).toEqual({
      sent: 1,
      failed: 1,
      skipped: false,
      targets: 2,
    });
    expect(createSlackApi).toHaveBeenCalledTimes(1);
    expect(Array.from(clientsByToken.keys())).toEqual(["xoxb-default"]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] slack notification failed for alerts/U_ALERTS_MISSING: missing SLACK_BOT_TOKEN_ALERTS",
    );
  });

  it("delivers whatsapp watchdog notices via clawCmd message send for owner self chat", async () => {
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "sent", stderr: "" }));
    const notifier = createWatchdogNotifier({
      clawCmd,
      readEnvFile: () => [
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
      ],
    });

    const result = await notifier.notify("Gateway healthy again");

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(1);
    expect(result.channels.whatsapp).toEqual({
      sent: 1,
      failed: 0,
      skipped: false,
      targets: 1,
    });
    expect(clawCmd).toHaveBeenCalledWith(
      expect.stringContaining("message send --channel whatsapp"),
      expect.objectContaining({ quiet: true, timeoutMs: 30000 }),
    );
    expect(clawCmd).toHaveBeenCalledWith(
      expect.stringContaining(
        '--target "+15551234567" --message "Gateway healthy again"',
      ),
      expect.any(Object),
    );
  });

  it("records the last successful delivery timestamp", async () => {
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "sent", stderr: "" }));
    const notifier = createWatchdogNotifier({
      clawCmd,
      readEnvFile: () => [
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
      ],
    });

    expect(notifier.getLastDeliveredAt()).toBeNull();
    await notifier.notify("Gateway running again");
    const deliveredAt = notifier.getLastDeliveredAt();
    expect(typeof deliveredAt).toBe("string");
    expect(Number.isNaN(Date.parse(deliveredAt))).toBe(false);
  });

  it("does not record a delivery timestamp when every channel fails", async () => {
    const clawCmd = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "No active WhatsApp Web listener",
      code: 1,
    }));
    const notifier = createWatchdogNotifier({
      clawCmd,
      readEnvFile: () => [
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
      ],
    });

    await notifier.notify("Gateway running again");
    expect(notifier.getLastDeliveredAt()).toBeNull();
  });

  it("counts whatsapp watchdog notices as failed when clawCmd returns ok false", async () => {
    const clawCmd = vi.fn(async () => ({
      ok: false,
      stdout: "",
      stderr: "No active WhatsApp Web listener",
      code: 1,
    }));
    const notifier = createWatchdogNotifier({
      clawCmd,
      readEnvFile: () => [
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
      ],
    });

    const result = await notifier.notify("Gateway healthy again");

    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.channels.whatsapp).toEqual({
      sent: 0,
      failed: 1,
      skipped: false,
      targets: 1,
    });
  });

  it("sends telegram notifications to paired chats and counts per-chat failures", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    const fsMock = buildCredentialsFsMock({
      "telegram-default-allowFrom.json": ["100", null, "  ", "200"],
    });
    const telegramApi = {
      sendMessage: vi.fn(async (chatId) => {
        if (chatId === "200") throw new Error("blocked by user");
        return { ok: true };
      }),
    };
    const notifier = createWatchdogNotifier({
      telegramApi,
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
    });

    const result = await notifier.notify("*Gateway crashed*");

    expect(result.channels.telegram).toEqual({
      sent: 1,
      failed: 1,
      skipped: false,
      targets: 2,
      formatFallback: 0,
    });
    // The house format is rendered to Telegram HTML at the transport
    // (WI-3.1) — never parse_mode=Markdown, whose entity parser died on every
    // runtime value in #54.
    expect(telegramApi.sendMessage).toHaveBeenCalledWith(
      "100",
      "<b>Gateway crashed</b>",
      { parseMode: "HTML", disableWebPagePreview: true },
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] telegram notification failed for 200: blocked by user",
    );
    // A generic throw (no telegramErrorCode) is a transient failure record.
    expect(result.failures).toEqual([
      {
        channel: "telegram",
        target: "200",
        reason: "blocked by user",
        errorCode: null,
        deterministic: false,
      },
    ]);
  });

  it("sends discord DMs with bold markdown conversion and counts failures", async () => {
    process.env.DISCORD_BOT_TOKEN = "dc-token";
    const fsMock = buildCredentialsFsMock({
      "discord-default-allowFrom.json": ["D1", "D2"],
    });
    const discordApi = {
      sendDirectMessage: vi.fn(async (userId) => {
        if (userId === "D2") throw new Error("cannot DM");
        return { ok: true };
      }),
    };
    const notifier = createWatchdogNotifier({
      discordApi,
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
    });

    const result = await notifier.notify("*Gateway healthy* again");

    expect(result.channels.discord).toEqual({
      sent: 1,
      failed: 1,
      skipped: false,
      targets: 2,
    });
    expect(discordApi.sendDirectMessage).toHaveBeenCalledWith(
      "D1",
      "**Gateway healthy** again",
      { suppressEmbeds: true },
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] discord notification failed for D2: cannot DM",
    );
  });

  it("reuses the ambient slack client for the default account token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-ambient";
    const fsMock = buildCredentialsFsMock({
      "slack-default-allowFrom.json": ["U_AMBIENT"],
    });
    const slackApi = {
      postMessage: vi.fn(async () => ({ ts: "ambient-ts", channel: "dm-ambient" })),
      addReaction: vi.fn(async () => ({ ok: true })),
    };
    const { createSlackApi } = buildSlackApiFactory();
    const notifier = createWatchdogNotifier({
      slackApi,
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-ambient" }],
      createSlackApi,
    });

    const result = await notifier.notify("Crash detected", { eventType: "crash" });

    expect(result.channels.slack).toEqual({
      sent: 1,
      failed: 0,
      skipped: false,
      targets: 1,
    });
    expect(createSlackApi).not.toHaveBeenCalled();
    expect(slackApi.postMessage).toHaveBeenCalledTimes(1);
    expect(slackApi.addReaction).toHaveBeenCalledWith("dm-ambient", "ambient-ts", "x");
  });

  it("tolerates slack post and reaction failures and accounts without targets", async () => {
    const fsMock = buildCredentialsFsMock({
      "slack-default-allowFrom.json": ["U_OK", "U_POST_FAIL", "U_NO_TS"],
      "slack-empty-allowFrom.json": [],
    });
    const slackClient = {
      postMessage: vi.fn(async (userId) => {
        if (userId === "U_POST_FAIL") throw new Error("channel_not_found");
        if (userId === "U_NO_TS") return {};
        return { ts: `ts-${userId}`, channel: `dm-${userId}` };
      }),
      addReaction: vi.fn(async () => {
        throw new Error("reaction rejected");
      }),
    };
    const createSlackApi = vi.fn(() => slackClient);
    const notifier = createWatchdogNotifier({
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
      createSlackApi,
    });

    const result = await notifier.notify("Recovered", { eventType: "recovery" });

    expect(result.channels.slack).toEqual({
      sent: 2,
      failed: 1,
      skipped: false,
      targets: 3,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] slack notification failed for default/U_POST_FAIL: channel_not_found",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] slack reaction failed for default/U_OK: reaction rejected",
    );
  });

  it("adds a heart reaction for health notifications", async () => {
    const fsMock = buildCredentialsFsMock({
      "slack-default-allowFrom.json": ["U_HEALTH"],
    });
    const slackClient = {
      postMessage: vi.fn(async () => ({ ts: "ts-h", channel: "dm-h" })),
      addReaction: vi.fn(async () => ({ ok: true })),
    };
    const notifier = createWatchdogNotifier({
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
      createSlackApi: () => slackClient,
    });

    await notifier.notify("Health check ok", { eventType: "health" });

    expect(slackClient.addReaction).toHaveBeenCalledWith("dm-h", "ts-h", "heart");
  });

  it("logs credential read failures and reports no delivered channels", async () => {
    const credentialsDir = path.join("/tmp/openclaw", "credentials");
    const fsMock = {
      existsSync: vi.fn((targetPath) => String(targetPath) === credentialsDir),
      readdirSync: vi.fn(() => ["telegram-default-allowFrom.json"]),
      readFileSync: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
    };
    const notifier = createWatchdogNotifier({
      telegramApi: { sendMessage: vi.fn() },
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
    });

    const result = await notifier.notify("hello");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not resolve telegram allowFrom IDs"),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        sent: 0,
        reason: "no_channels_delivered",
      }),
    );
  });

  it("skips every channel when nothing is paired or configured", async () => {
    const fsMock = {
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => {
        throw new Error("unexpected read");
      }),
    };
    const notifier = createWatchdogNotifier({
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
      readEnvFile: null,
    });

    const result = await notifier.notify("hello");

    expect(result).toEqual({
      ok: false,
      sent: 0,
      failed: 0,
      reason: "no_channels_delivered",
      channels: {
        telegram: { sent: 0, failed: 0, skipped: true, targets: 0, formatFallback: 0 },
        discord: { sent: 0, failed: 0, skipped: true, targets: 0 },
        slack: { sent: 0, failed: 0, skipped: true, targets: 0 },
        whatsapp: { sent: 0, failed: 0, skipped: true, targets: 0 },
        webhook: { sent: 0, failed: 0, skipped: true, targets: 0 },
      },
      // Zero resolvable targets = zero failures: the routing layer keeps this
      // TRANSIENT (pairing/tokens may appear later) — never terminal.
      failures: [],
    });
  });

  it("resolves the whatsapp owner number from process env", async () => {
    process.env.WHATSAPP_OWNER_NUMBER = "+15550001111";
    const fsMock = {
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => {
        throw new Error("unexpected read");
      }),
    };
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "sent" }));
    const notifier = createWatchdogNotifier({
      clawCmd,
      fsImpl: fsMock,
      openclawDir: "/tmp/openclaw",
    });

    const result = await notifier.notify("Ping");

    expect(result.channels.whatsapp).toEqual({
      sent: 1,
      failed: 0,
      skipped: false,
      targets: 1,
    });
    expect(clawCmd).toHaveBeenCalledWith(
      expect.stringContaining('--target "+15550001111"'),
      expect.any(Object),
    );
  });

  // Deliverability fallbacks (#21 Bug 7): the box whose only channel config
  // lives in openclaw.json must still receive "your upgrade failed".
  describe("telegram allowFrom + token fallback", () => {
    it("falls back to openclaw.json channels.telegram.allowFrom when no pairing files exist, numeric chat IDs only", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const fsMock = buildCredentialsFsMock(
        {},
        {
          openclawJson: {
            channels: {
              telegram: {
                allowFrom: ["123456", -100987, "@someuser", "*", "nick", "123456"],
              },
            },
          },
        },
      );
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("Upgrade failed");

      // Usernames and "*" are authorization identities, not chat_ids: skipped.
      expect(result.channels.telegram).toEqual({
        sent: 2,
        failed: 0,
        skipped: false,
        targets: 2,
        formatFallback: 0,
      });
      expect(telegramApi.sendMessage.mock.calls.map((call) => call[0])).toEqual(
        ["123456", "-100987"],
      );
    });

    it("prefers pairing files over the allowFrom fallback when both exist", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const fsMock = buildCredentialsFsMock(
        { "telegram-default-allowFrom.json": ["111"] },
        {
          openclawJson: {
            channels: { telegram: { allowFrom: ["999999"] } },
          },
        },
      );
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      await notifier.notify("hello");

      expect(telegramApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(telegramApi.sendMessage.mock.calls[0][0]).toBe("111");
    });

    it("resolves the bot token from openclaw.json when the env token is missing", async () => {
      const fsMock = buildCredentialsFsMock(
        { "telegram-default-allowFrom.json": ["111"] },
        {
          openclawJson: {
            channels: { telegram: { botToken: "123:from-config" } },
          },
        },
      );

      // Shared resolver (what lib/server.js wires into both createTelegramApi
      // and the notifier): env wins, then the literal config token; the
      // "${TELEGRAM_BOT_TOKEN}" placeholder written by config imports is an
      // env reference, not a token.
      expect(
        resolveTelegramBotToken({
          env: {},
          fsImpl: fsMock,
          openclawDir: "/tmp/openclaw",
        }),
      ).toBe("123:from-config");
      expect(
        resolveTelegramBotToken({
          env: { TELEGRAM_BOT_TOKEN: "env-token" },
          fsImpl: fsMock,
          openclawDir: "/tmp/openclaw",
        }),
      ).toBe("env-token");
      const placeholderFsMock = buildCredentialsFsMock(
        {},
        {
          openclawJson: {
            channels: { telegram: { botToken: "${TELEGRAM_BOT_TOKEN}" } },
          },
        },
      );
      expect(
        resolveTelegramBotToken({
          env: {},
          fsImpl: placeholderFsMock,
          openclawDir: "/tmp/openclaw",
        }),
      ).toBe("");

      // Wired into the notifier, delivery works with NO env token at all.
      delete process.env.TELEGRAM_BOT_TOKEN;
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
        getTelegramToken: () =>
          resolveTelegramBotToken({
            env: {},
            fsImpl: fsMock,
            openclawDir: "/tmp/openclaw",
          }),
      });
      const result = await notifier.notify("Upgrade failed");
      expect(result.channels.telegram.sent).toBe(1);
      expect(telegramApi.sendMessage).toHaveBeenCalledWith(
        "111",
        "Upgrade failed",
        { parseMode: "HTML", disableWebPagePreview: true },
      );
    });

    it("an unparseable openclaw.json degrades gracefully — env/pairing delivery still runs", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const fsMock = buildCredentialsFsMock(
        { "telegram-default-allowFrom.json": ["111"] },
        { openclawJson: "{ this is not JSON !!!" },
      );
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("Upgrade failed");

      expect(result.ok).toBe(true);
      expect(result.channels.telegram.sent).toBe(1);
      expect(
        resolveTelegramBotToken({
          env: {},
          fsImpl: fsMock,
          openclawDir: "/tmp/openclaw",
        }),
      ).toBe("");
    });

    it("a broken config read with no pairing files yields zero fallback targets, not a crash", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const fsMock = buildCredentialsFsMock(
        {},
        { openclawJson: "{ this is not JSON !!!" },
      );
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("hello");

      expect(result.channels.telegram).toEqual({
        sent: 0,
        failed: 0,
        skipped: true,
        targets: 0,
        formatFallback: 0,
      });
      expect(telegramApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("webhook fan-out channel (ALPHACLAW_NOTIFY_WEBHOOK_URL)", () => {
    it("POSTs {text: message} JSON to the configured webhook URL", async () => {
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL = "https://hooks.example/notify";
      const fetchImpl = vi.fn(async () => ({ ok: true }));
      const notifier = createWatchdogNotifier({
        fsImpl: buildCredentialsFsMock(),
        openclawDir: "/tmp/openclaw",
        fetchImpl,
      });

      const result = await notifier.notify("🔴 Upgrade failed");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://hooks.example/notify");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({ text: "🔴 Upgrade failed" });
      expect(result.ok).toBe(true);
      expect(result.channels.webhook).toEqual({
        sent: 1,
        failed: 0,
        skipped: false,
        targets: 1,
      });
    });

    it("a webhook failure never breaks the other channels", async () => {
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL = "https://hooks.example/notify";
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const fetchImpl = vi.fn(async () => {
        throw new Error("connection refused");
      });
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: buildCredentialsFsMock({
          "telegram-default-allowFrom.json": ["111"],
        }),
        openclawDir: "/tmp/openclaw",
        fetchImpl,
      });

      const result = await notifier.notify("Upgrade failed");

      expect(result.ok).toBe(true);
      expect(result.channels.telegram.sent).toBe(1);
      expect(result.channels.webhook).toEqual({
        sent: 0,
        failed: 1,
        skipped: false,
        targets: 1,
      });
    });

    it("counts a non-2xx webhook response as a per-channel failure", async () => {
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL = "https://hooks.example/notify";
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
      const notifier = createWatchdogNotifier({
        fsImpl: buildCredentialsFsMock(),
        openclawDir: "/tmp/openclaw",
        fetchImpl,
      });

      const result = await notifier.notify("hello");

      expect(result.channels.webhook.failed).toBe(1);
      expect(result.ok).toBe(false);
    });
  });

  // sendToTarget is the real delivery layer under the upgrade-notifier's
  // preferred-channel routing (which mocks it) — cover the per-channel
  // dispatch and every { ok:false, reason } shape here.
  describe("sendToTarget (admin-target delivery)", () => {
    const kEmptyFsMock = {
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => {
        throw new Error("unexpected read");
      }),
    };

    it("delivers to a telegram target and reports unconfigured without a bot token", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const sent = await notifier.sendToTarget(
        { channel: "telegram", target: "12345" },
        "Upgrade failed",
      );
      expect(sent).toEqual({ ok: true });
      expect(telegramApi.sendMessage).toHaveBeenCalledWith(
        "12345",
        "Upgrade failed",
        { parseMode: "HTML", disableWebPagePreview: true },
      );

      delete process.env.TELEGRAM_BOT_TOKEN;
      const unconfigured = await notifier.sendToTarget(
        { channel: "telegram", target: "12345" },
        "Upgrade failed",
      );
      expect(unconfigured).toEqual({
        ok: false,
        reason: "telegram_unconfigured",
        errorCode: null,
        deterministic: false,
      });
    });

    it("derives the named-account Slack env key and reports it when missing", async () => {
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_BOT_TOKEN_ALERTS;
      const { createSlackApi, clientsByToken } = buildSlackApiFactory();
      const notifier = createWatchdogNotifier({
        readEnvFile: () => [{ key: "SLACK_BOT_TOKEN_ALERTS", value: "xoxb-alerts" }],
        createSlackApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const sent = await notifier.sendToTarget(
        { channel: "slack", target: "U_ADMIN", accountId: "alerts" },
        "Upgrade failed",
      );
      expect(sent).toEqual({ ok: true });
      expect(clientsByToken.get("xoxb-alerts").postMessage).toHaveBeenCalledWith(
        "U_ADMIN",
        "Upgrade failed",
        { mrkdwn: true, unfurl_links: false, unfurl_media: false },
      );

      const missing = await notifier.sendToTarget(
        { channel: "slack", target: "U_ADMIN", accountId: "ops" },
        "Upgrade failed",
      );
      expect(missing).toEqual({
        ok: false,
        reason: "missing SLACK_BOT_TOKEN_OPS",
        errorCode: null,
        deterministic: false,
      });
    });

    it("delivers to a discord target and reports unconfigured without a bot token", async () => {
      process.env.DISCORD_BOT_TOKEN = "dc-token";
      const discordApi = { sendDirectMessage: vi.fn(async () => ({ ok: true })) };
      const notifier = createWatchdogNotifier({
        discordApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const sent = await notifier.sendToTarget(
        { channel: "discord", target: "999" },
        "Upgrade *failed*",
      );
      expect(sent).toEqual({ ok: true });
      // Discord delivery bolds the single-asterisk emphasis markers.
      expect(discordApi.sendDirectMessage).toHaveBeenCalledWith(
        "999",
        "Upgrade **failed**",
        { suppressEmbeds: true },
      );

      delete process.env.DISCORD_BOT_TOKEN;
      const unconfigured = await notifier.sendToTarget(
        { channel: "discord", target: "999" },
        "Upgrade failed",
      );
      expect(unconfigured).toEqual({
        ok: false,
        reason: "discord_unconfigured",
        errorCode: null,
        deterministic: false,
      });
    });

    it("uses the injected slackApi for the default-account token", async () => {
      process.env.SLACK_BOT_TOKEN = "xoxb-default";
      const slackApi = { postMessage: vi.fn(async () => ({ ts: "1" })) };
      const { createSlackApi } = buildSlackApiFactory();
      const notifier = createWatchdogNotifier({
        slackApi,
        createSlackApi,
        readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const sent = await notifier.sendToTarget(
        { channel: "slack", target: "U_ADMIN" },
        "Upgrade failed",
      );
      expect(sent).toEqual({ ok: true });
      expect(slackApi.postMessage).toHaveBeenCalledWith("U_ADMIN", "Upgrade failed", {
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
      expect(createSlackApi).not.toHaveBeenCalled();
    });

    it("rejects invalid and unsupported targets with stable reasons", async () => {
      const notifier = createWatchdogNotifier({
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      // Every failure carries the uniform shape (errorCode + deterministic)
      // so the routing layer never has to special-case a reason string.
      const kTransient = { ok: false, errorCode: null, deterministic: false };
      expect(await notifier.sendToTarget({ channel: "telegram" }, "m")).toEqual({
        ...kTransient,
        reason: "invalid_target",
      });
      expect(await notifier.sendToTarget({}, "m")).toEqual({
        ...kTransient,
        reason: "invalid_target",
      });
      expect(
        await notifier.sendToTarget({ channel: "smoke", target: "x" }, "m"),
      ).toEqual({ ...kTransient, reason: "unsupported channel smoke" });
    });

    it("routes whatsapp through clawCmd with a quoted target and surfaces failures", async () => {
      const clawCmd = vi.fn(async () => ({ ok: true, stdout: "sent" }));
      const notifier = createWatchdogNotifier({
        clawCmd,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const sent = await notifier.sendToTarget(
        { channel: "whatsapp", target: "+15550001111" },
        "Upgrade failed",
      );
      expect(sent).toEqual({ ok: true });
      expect(clawCmd).toHaveBeenCalledWith(
        expect.stringContaining('--target "+15550001111"'),
        expect.objectContaining({ quiet: true }),
      );

      clawCmd.mockResolvedValueOnce({ ok: false, stderr: "no session" });
      const failed = await notifier.sendToTarget(
        { channel: "whatsapp", target: "+15550001111" },
        "Upgrade failed",
      );
      expect(failed).toEqual({
        ok: false,
        reason: "no session",
        errorCode: null,
        deterministic: false,
      });

      const unconfigured = createWatchdogNotifier({
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });
      expect(
        await unconfigured.sendToTarget(
          { channel: "whatsapp", target: "+15550001111" },
          "m",
        ),
      ).toEqual({
        ok: false,
        reason: "whatsapp_unconfigured",
        errorCode: null,
        deterministic: false,
      });
    });

    it("a thrown provider error becomes { ok:false, reason, errorCode } instead of rejecting", async () => {
      process.env.DISCORD_BOT_TOKEN = "dc-token";
      const discordApi = {
        sendDirectMessage: vi.fn(async () => {
          throw new Error("discord down");
        }),
      };
      const notifier = createWatchdogNotifier({
        discordApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.sendToTarget(
        { channel: "discord", target: "999" },
        "Upgrade failed",
      );
      expect(result).toEqual({
        ok: false,
        reason: "discord down",
        errorCode: null,
        deterministic: false,
      });

      // discord-api.js attaches the HTTP status as discordStatusCode — it
      // rides along as errorCode but never makes a Discord failure terminal.
      const rateLimited = Object.assign(new Error("You are being rate limited."), {
        discordStatusCode: 429,
      });
      discordApi.sendDirectMessage.mockRejectedValueOnce(rateLimited);
      expect(
        await notifier.sendToTarget({ channel: "discord", target: "999" }, "m"),
      ).toEqual({
        ok: false,
        reason: "You are being rate limited.",
        errorCode: 429,
        deterministic: false,
      });
    });

    it("stamps getLastDeliveredAt on every channel's successful delivery", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      process.env.DISCORD_BOT_TOKEN = "dc-token";
      process.env.SLACK_BOT_TOKEN = "xoxb-default";
      const buildNotifier = () =>
        createWatchdogNotifier({
          telegramApi: { sendMessage: vi.fn(async () => ({ ok: true })) },
          discordApi: { sendDirectMessage: vi.fn(async () => ({ ok: true })) },
          slackApi: { postMessage: vi.fn(async () => ({ ts: "1" })) },
          clawCmd: vi.fn(async () => ({ ok: true, stdout: "sent" })),
          readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
          fsImpl: kEmptyFsMock,
          openclawDir: "/tmp/openclaw",
        });

      const kTargets = [
        { channel: "telegram", target: "12345" },
        { channel: "discord", target: "999" },
        { channel: "slack", target: "U_ADMIN" },
        { channel: "whatsapp", target: "+15550001111" },
      ];
      for (const target of kTargets) {
        const notifier = buildNotifier();
        expect(notifier.getLastDeliveredAt(), target.channel).toBeNull();
        const result = await notifier.sendToTarget(target, "Upgrade failed");
        expect(result, target.channel).toEqual({ ok: true });
        const deliveredAt = notifier.getLastDeliveredAt();
        expect(typeof deliveredAt, target.channel).toBe("string");
        expect(Number.isNaN(Date.parse(deliveredAt)), target.channel).toBe(false);
      }
    });

    it("leaves getLastDeliveredAt unchanged on failed or unconfigured sends", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "tg-token";
      delete process.env.DISCORD_BOT_TOKEN;
      const telegramApi = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const clawCmd = vi.fn(async () => ({ ok: false, stderr: "no session" }));
      const notifier = createWatchdogNotifier({
        telegramApi,
        clawCmd,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      // Failures before any success leave the stamp null.
      await notifier.sendToTarget({ channel: "discord", target: "999" }, "m");
      await notifier.sendToTarget(
        { channel: "whatsapp", target: "+15550001111" },
        "m",
      );
      expect(notifier.getLastDeliveredAt()).toBeNull();

      await notifier.sendToTarget({ channel: "telegram", target: "1" }, "m");
      const stamped = notifier.getLastDeliveredAt();
      expect(Number.isNaN(Date.parse(stamped))).toBe(false);

      // A later thrown provider error must not move the stamp.
      telegramApi.sendMessage.mockRejectedValueOnce(new Error("blocked by user"));
      const failed = await notifier.sendToTarget(
        { channel: "telegram", target: "1" },
        "m",
      );
      expect(failed).toEqual({
        ok: false,
        reason: "blocked by user",
        errorCode: null,
        deterministic: false,
      });
      expect(notifier.getLastDeliveredAt()).toBe(stamped);
    });
  });
});

// ── sqlite pairing store union (openclaw >= 2026.9.1-beta.1) ─────────────────
// The beta imports *-allowFrom.json into channel_pairing_allow_entries and
// DELETES the files at gateway startup — without the sqlite read, watchdog
// incident notifications silently lose all pairing-derived targets.
describe("watchdog-notify sqlite pairing store", () => {
  const fs = require("fs");
  const os = require("os");
  const { DatabaseSync } = require("node:sqlite");
  const {
    getPairedTargetsByAccount,
  } = require("../../lib/server/watchdog-notify");

  const createStateDirWithAllowEntries = (rows) => {
    const openclawDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "alphaclaw-notify-sqlite-"),
    );
    const databasePath = path.join(openclawDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE channel_pairing_allow_entries (channel_key TEXT NOT NULL, account_id TEXT NOT NULL, entry TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_key, account_id, entry))",
    );
    const insert = db.prepare(
      "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry) VALUES (?, ?, ?)",
    );
    for (const [channel, accountId, entry] of rows) insert.run(channel, accountId, entry);
    db.close();
    return openclawDir;
  };

  it("resolves targets from the state db when the pairing files are gone (post-import beta box)", () => {
    const openclawDir = createStateDirWithAllowEntries([
      ["telegram", "default", "111"],
      ["telegram", "alerts", "222"],
      ["discord", "default", "999"],
    ]);
    const targets = getPairedTargetsByAccount({ channel: "telegram", openclawDir });
    expect(new Map(targets)).toEqual(
      new Map([
        ["default", ["111"]],
        ["alerts", ["222"]],
      ]),
    );
  });

  it("unions sqlite entries with remaining pairing files and dedupes ids", () => {
    const openclawDir = createStateDirWithAllowEntries([
      ["telegram", "default", "111"],
    ]);
    const credentialsDir = path.join(openclawDir, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, "telegram-default-allowFrom.json"),
      JSON.stringify({ allowFrom: ["111", "333"] }),
    );
    const targets = getPairedTargetsByAccount({ channel: "telegram", openclawDir });
    expect(Array.from(targets.get("default")).sort()).toEqual(["111", "333"]);
  });

  it("keeps working from files alone on a file-era box (no state db)", () => {
    const openclawDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "alphaclaw-notify-file-"),
    );
    const credentialsDir = path.join(openclawDir, "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, "telegram-default-allowFrom.json"),
      JSON.stringify({ allowFrom: ["444"] }),
    );
    const targets = getPairedTargetsByAccount({ channel: "telegram", openclawDir });
    expect(targets.get("default")).toEqual(["444"]);
  });
});

// ── Telegram HTML transport (WI-3.1/3.2) ─────────────────────────────────────
// The #54 operator never saw an alert: parse_mode=Markdown rejected every
// message carrying a runtime value. The ONE send helper renders the house
// format to HTML, falls back to plain text on a parse 400, and classifies
// every failure with errorCode + deterministic for the routing layer.
describe("watchdog-notify telegram HTML transport", () => {
  let consoleWarnSpy = null;
  let consoleErrorSpy = null;
  const kOriginalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const kEmptyFsMock = {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => {
      throw new Error("unexpected read");
    }),
  };

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (kOriginalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = kOriginalTelegramToken;
  });

  describe("sendTelegramRendered", () => {
    const kNotice =
      "🐺 *AlphaClaw Watchdog*\n🔴 Backup failed - [View logs](https://claw.example/#/watchdog)\nError: `lease migration.legacy-audit/filesystem-sqlite-boundary was lost`";
    const kNoticeHtml =
      '🐺 <b>AlphaClaw Watchdog</b>\n🔴 Backup failed - <a href="https://claw.example/#/watchdog">View logs</a>\nError: <code>lease migration.legacy-audit/filesystem-sqlite-boundary was lost</code>';

    it("sends the HTML render with parse_mode=HTML and no link preview", async () => {
      const api = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const result = await sendTelegramRendered({ api, chatId: "100", text: kNotice });
      expect(result).toEqual({ ok: true, formatFallback: false });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith("100", kNoticeHtml, kHtmlOpts);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("a parse 400 resends the SAME house-format text with no parse_mode — delivered, formatFallback", async () => {
      const api = {
        sendMessage: vi.fn(async (_chatId, _text, opts) => {
          if (opts?.parseMode) throw kParseError();
          return { ok: true };
        }),
      };
      const result = await sendTelegramRendered({ api, chatId: "100", text: kNotice });
      expect(result).toEqual({ ok: true, formatFallback: true });
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(api.sendMessage.mock.calls[0]).toEqual(["100", kNoticeHtml, kHtmlOpts]);
      expect(api.sendMessage.mock.calls[1]).toEqual(["100", kNotice, kPlainOpts]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("rejected the HTML render for 100"),
      );
    });

    it.each([
      ["can't parse entities", "Bad Request: can't parse entities: unexpected end"],
      ["unsupported start tag", 'Bad Request: unsupported start tag "x" at byte offset 3'],
      ["can't find end of the entity", "Bad Request: can't find end of the entity starting at byte offset 1"],
    ])("treats a 400 mentioning %s as a parse rejection", async (_label, message) => {
      const api = {
        sendMessage: vi.fn(async (_chatId, _text, opts) => {
          if (opts?.parseMode) throw telegramError(message, 400);
          return { ok: true };
        }),
      };
      const result = await sendTelegramRendered({ api, chatId: "1", text: "*x*" });
      expect(result).toEqual({ ok: true, formatFallback: true });
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("a non-parse 400 fails once with its errorCode and stays transient (no plain resend)", async () => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Bad Request: message is too long", 400);
        }),
      };
      const result = await sendTelegramRendered({ api, chatId: "100", text: "*x*" });
      expect(result).toEqual({
        ok: false,
        reason: "Bad Request: message is too long",
        errorCode: 400,
        deterministic: false,
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("403 (bot blocked/kicked) is deterministic", async () => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Forbidden: bot was blocked by the user", 403);
        }),
      };
      expect(await sendTelegramRendered({ api, chatId: "100", text: "x" })).toEqual({
        ok: false,
        reason: "Forbidden: bot was blocked by the user",
        errorCode: 403,
        deterministic: true,
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    // Adversarial review (e): a bare 403 used to be deterministic. Only the
    // descriptions that need a human on the Telegram side qualify.
    it.each([
      "Forbidden: bot was blocked by the user",
      "Forbidden: bot was kicked from the group chat",
      "Forbidden: bot was kicked from the supergroup chat",
      "Forbidden: user is deactivated",
    ])("403 %s is deterministic (never retried)", async (message) => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw telegramError(message, 403);
        }),
      };
      expect(await sendTelegramRendered({ api, chatId: "100", text: "x" })).toMatchObject({
        ok: false,
        errorCode: 403,
        deterministic: true,
      });
    });

    it.each([
      "Forbidden: bot can't initiate conversation with a user",
      "Forbidden: bot is not a member of the supergroup chat",
      "Forbidden: bot can't send messages to bots",
      "Forbidden",
    ])("403 %s stays TRANSIENT (pairing/starting the bot can fix it)", async (message) => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw telegramError(message, 403);
        }),
      };
      expect(await sendTelegramRendered({ api, chatId: "100", text: "x" })).toEqual({
        ok: false,
        reason: message,
        errorCode: 403,
        deterministic: false,
      });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    // C30 (source-aware chat-not-found): Telegram answers `400 chat not
    // found` both for a dead chat AND for a numeric id the bot has never
    // exchanged a message with. Only a pairing-store target has a proven
    // prior interaction, so only there is the shape final.
    describe("400 chat not found is deterministic ONLY for a pairing-store target", () => {
      const kChatNotFoundApi = () => ({
        sendMessage: vi.fn(async () => {
          throw telegramError("Bad Request: chat not found", 400);
        }),
      });

      it("pairing target → deterministic (the chat is gone)", async () => {
        const api = kChatNotFoundApi();
        expect(
          await sendTelegramRendered({
            api,
            chatId: "100",
            text: "x",
            source: kTelegramTargetSourcePairing,
          }),
        ).toEqual({
          ok: false,
          reason: "Bad Request: chat not found",
          errorCode: 400,
          deterministic: true,
        });
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      it.each([
        ["allowFrom-fallback", kTelegramTargetSourceAllowFrom],
        ["admin", kTelegramTargetSourceAdmin],
        ["omitted (unproven)", undefined],
      ])(
        "%s target → RETRYABLE (the user may simply never have messaged the bot)",
        async (_label, source) => {
          const api = kChatNotFoundApi();
          expect(
            await sendTelegramRendered({ api, chatId: "100", text: "x", source }),
          ).toEqual({
            ok: false,
            reason: "Bad Request: chat not found",
            errorCode: 400,
            deterministic: false,
          });
          // No plain resend: this is not a parse rejection.
          expect(api.sendMessage).toHaveBeenCalledTimes(1);
        },
      );

      it("provenance never softens a 403 blocked/kicked/deactivated verdict", async () => {
        for (const source of [
          kTelegramTargetSourceAllowFrom,
          kTelegramTargetSourceAdmin,
          undefined,
        ]) {
          const api = {
            sendMessage: vi.fn(async () => {
              throw telegramError("Forbidden: bot was blocked by the user", 403);
            }),
          };
          expect(
            await sendTelegramRendered({ api, chatId: "100", text: "x", source }),
          ).toMatchObject({ ok: false, errorCode: 403, deterministic: true });
        }
      });

      it("a 403 whose description says chat not found is NOT proven deterministic (no longer in the 403 pattern)", async () => {
        const api = {
          sendMessage: vi.fn(async () => {
            throw telegramError("Forbidden: chat not found", 403);
          }),
        };
        expect(
          await sendTelegramRendered({
            api,
            chatId: "100",
            text: "x",
            source: kTelegramTargetSourceAdmin,
          }),
        ).toMatchObject({ ok: false, errorCode: 403, deterministic: false });
      });
    });

    it.each([
      ["pairing", kTelegramTargetSourcePairing],
      ["allowFrom", kTelegramTargetSourceAllowFrom],
      ["admin", kTelegramTargetSourceAdmin],
      ["omitted", undefined],
    ])(
      "a parse 400 that survives the plain-text fallback is deterministic (source %s)",
      async (_label, source) => {
        const api = {
          sendMessage: vi.fn(async () => {
            throw kParseError();
          }),
        };
        const result = await sendTelegramRendered({ api, chatId: "100", text: "*x*", source });
        expect(result).toEqual({
          ok: false,
          reason: expect.stringContaining("can't parse entities"),
          errorCode: 400,
          deterministic: true,
        });
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
        expect(api.sendMessage.mock.calls[1][2]).toEqual(kPlainOpts);
      },
    );

    it("a plain-text fallback that fails transiently (429) stays transient with its errorCode", async () => {
      const api = {
        sendMessage: vi.fn(async (_chatId, _text, opts) => {
          if (opts?.parseMode) throw kParseError();
          throw telegramError("Too Many Requests: retry after 7", 429);
        }),
      };
      expect(await sendTelegramRendered({ api, chatId: "100", text: "*x*" })).toEqual({
        ok: false,
        reason: "Too Many Requests: retry after 7",
        errorCode: 429,
        deterministic: false,
      });
    });

    it("a 5xx / network error (no error_code) is transient with errorCode null", async () => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw new Error("fetch failed");
        }),
      };
      expect(await sendTelegramRendered({ api, chatId: "100", text: "x" })).toEqual({
        ok: false,
        reason: "fetch failed",
        errorCode: null,
        deterministic: false,
      });
    });

    it("a render the local validator rejects goes out as plain text only (formatFallback)", async () => {
      const api = { sendMessage: vi.fn(async () => ({ ok: true })) };
      const render = vi.fn((text) => ({ html: null, plain: text }));
      const result = await sendTelegramRendered({ api, chatId: "100", text: "*x*", render });
      expect(result).toEqual({ ok: true, formatFallback: true });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith("100", "*x*", kPlainOpts);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed local validation"),
      );
    });

    it("a plain-only send that fails is classified like any other failure", async () => {
      const api = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Forbidden: bot was kicked from the group chat", 403);
        }),
      };
      const render = (text) => ({ html: null, plain: text });
      expect(await sendTelegramRendered({ api, chatId: "-1", text: "x", render })).toEqual({
        ok: false,
        reason: "Forbidden: bot was kicked from the group chat",
        errorCode: 403,
        deterministic: true,
      });
    });
  });

  describe("both send sites use the helper", () => {
    it("fan-out: a parse 400 falls back to plain text, counts as sent, and tallies formatFallback", async () => {
      const fsMock = buildCredentialsFsMock({
        "telegram-default-allowFrom.json": ["100", "200"],
      });
      const telegramApi = {
        sendMessage: vi.fn(async (chatId, _text, opts) => {
          if (chatId === "200" && opts?.parseMode) throw kParseError();
          return { ok: true };
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("*Backup failed*: `lease_lost`");

      expect(result.ok).toBe(true);
      expect(result.channels.telegram).toEqual({
        sent: 2,
        failed: 0,
        skipped: false,
        targets: 2,
        formatFallback: 1,
      });
      expect(result.failures).toEqual([]);
      expect(telegramApi.sendMessage).toHaveBeenCalledTimes(3);
      expect(telegramApi.sendMessage.mock.calls[0]).toEqual([
        "100",
        "<b>Backup failed</b>: <code>lease_lost</code>",
        kHtmlOpts,
      ]);
      expect(telegramApi.sendMessage.mock.calls[2]).toEqual([
        "200",
        "*Backup failed*: `lease_lost`",
        kPlainOpts,
      ]);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("fan-out: deterministic failures ride the failures list with errorCode (pairing-store targets — chat not found IS final here)", async () => {
      const fsMock = buildCredentialsFsMock({
        "telegram-default-allowFrom.json": ["100", "200"],
      });
      const telegramApi = {
        sendMessage: vi.fn(async (chatId) => {
          if (chatId === "100") throw telegramError("Forbidden: bot was blocked by the user", 403);
          throw telegramError("Bad Request: chat not found", 400);
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("Upgrade failed");

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no_channels_delivered");
      expect(result.channels.telegram).toEqual({
        sent: 0,
        failed: 2,
        skipped: false,
        targets: 2,
        formatFallback: 0,
      });
      expect(result.failures).toEqual([
        {
          channel: "telegram",
          target: "100",
          reason: "Forbidden: bot was blocked by the user",
          errorCode: 403,
          deterministic: true,
        },
        {
          channel: "telegram",
          target: "200",
          reason: "Bad Request: chat not found",
          errorCode: 400,
          deterministic: true,
        },
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[watchdog] telegram notification failed for 100: Forbidden: bot was blocked by the user",
      );
    });

    // C30: the allowFrom fallback hands the send helper ids copied into
    // openclaw.json by hand — Telegram says "chat not found" for any of them
    // the user has not yet messaged. That is fixable (the user opens the
    // bot), so the outbox must keep retrying instead of abandoning on the
    // first flush. A 403 blocked stays final regardless.
    it("fan-out: allowFrom-fallback targets keep 400 chat not found RETRYABLE (403 blocked stays deterministic)", async () => {
      const fsMock = buildCredentialsFsMock(
        {},
        { openclawJson: { channels: { telegram: { allowFrom: ["100", "200"] } } } },
      );
      const telegramApi = {
        sendMessage: vi.fn(async (chatId) => {
          if (chatId === "100") throw telegramError("Forbidden: bot was blocked by the user", 403);
          throw telegramError("Bad Request: chat not found", 400);
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: fsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.notify("Upgrade failed");

      expect(result.ok).toBe(false);
      expect(result.channels.telegram).toMatchObject({ sent: 0, failed: 2, targets: 2 });
      expect(result.failures).toEqual([
        {
          channel: "telegram",
          target: "100",
          reason: "Forbidden: bot was blocked by the user",
          errorCode: 403,
          deterministic: true,
        },
        {
          channel: "telegram",
          target: "200",
          reason: "Bad Request: chat not found",
          errorCode: 400,
          deterministic: false,
        },
      ]);
    });

    it("fan-out: the webhook failure record never carries the (secret-bearing) URL", async () => {
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL = "https://hooks.example/secret-path";
      try {
        const notifier = createWatchdogNotifier({
          fsImpl: kEmptyFsMock,
          openclawDir: "/tmp/openclaw",
          fetchImpl: vi.fn(async () => ({ ok: false, status: 500 })),
        });
        const result = await notifier.notify("hello");
        expect(result.failures).toEqual([
          {
            channel: "webhook",
            target: null,
            reason: "webhook POST did not succeed",
            errorCode: null,
            deterministic: false,
          },
        ]);
      } finally {
        delete process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL;
      }
    });

    it("sendToTarget: a parse 400 falls back to plain text and reports ok", async () => {
      const telegramApi = {
        sendMessage: vi.fn(async (_chatId, _text, opts) => {
          if (opts?.parseMode) throw kParseError();
          return { ok: true };
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.sendToTarget(
        { channel: "telegram", target: "12345" },
        "*Upgrade failed* - [View](https://claw.example/#/upgrade)",
      );

      expect(result).toEqual({ ok: true });
      expect(notifier.getLastDeliveredAt()).not.toBeNull();
      expect(telegramApi.sendMessage.mock.calls).toEqual([
        [
          "12345",
          '<b>Upgrade failed</b> - <a href="https://claw.example/#/upgrade">View</a>',
          kHtmlOpts,
        ],
        ["12345", "*Upgrade failed* - [View](https://claw.example/#/upgrade)", kPlainOpts],
      ]);
    });

    // C30: an admin target is operator-typed — never proven to have messaged
    // the bot — so its chat-not-found stays on the retry ladder.
    it("sendToTarget: an admin target's 400 chat not found fails RETRYABLE with errorCode and does not stamp delivery", async () => {
      const telegramApi = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Bad Request: chat not found", 400);
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      const result = await notifier.sendToTarget(
        { channel: "telegram", target: "12345" },
        "Upgrade failed",
      );

      expect(result).toEqual({
        ok: false,
        reason: "Bad Request: chat not found",
        errorCode: 400,
        deterministic: false,
      });
      expect(telegramApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(notifier.getLastDeliveredAt()).toBeNull();
    });

    it("sendToTarget: a caller that vouches source=pairing gets the deterministic chat-not-found verdict", async () => {
      const telegramApi = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Bad Request: chat not found", 400);
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });
      expect(
        await notifier.sendToTarget(
          { channel: "telegram", target: "12345", source: kTelegramTargetSourcePairing },
          "Upgrade failed",
        ),
      ).toMatchObject({ ok: false, errorCode: 400, deterministic: true });
    });

    it("sendToTarget: an admin target's 403 blocked stays deterministic", async () => {
      const telegramApi = {
        sendMessage: vi.fn(async () => {
          throw telegramError("Forbidden: bot was blocked by the user", 403);
        }),
      };
      const notifier = createWatchdogNotifier({
        telegramApi,
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });
      expect(
        await notifier.sendToTarget({ channel: "telegram", target: "12345" }, "Upgrade failed"),
      ).toMatchObject({ ok: false, errorCode: 403, deterministic: true });
    });
  });

  // WI-3.6: Slack mrkdwn spells links <url|label>; bold is already shared.
  describe("slack link rendering", () => {
    it("formatSlackMessage rewrites http(s) house links only", () => {
      expect(
        formatSlackMessage(
          "🔴 Crash loop - [View logs](https://claw.example/#/watchdog) see [docs](ftp://x/y) and *bold*",
        ),
      ).toBe(
        "🔴 Crash loop - <https://claw.example/#/watchdog|View logs> see [docs](ftp://x/y) and *bold*",
      );
      expect(formatSlackMessage("")).toBe("");
      expect(formatSlackMessage(null)).toBe("");
    });

    // Adversarial review P3 (10): the Slack renderer duplicated the link regex
    // and truncated at the first `)` exactly like Telegram did. Both now share
    // renderHouseLinks.
    it("a url with balanced parentheses renders whole; a trailing `)` outside the link stays text", () => {
      expect(formatSlackMessage("[X](https://a.b/c_(paren)_d) tail")).toBe(
        "<https://a.b/c_(paren)_d|X> tail",
      );
      expect(formatSlackMessage("(see [X](https://a.b/c))")).toBe("(see <https://a.b/c|X>)");
      expect(formatSlackMessage("(see [X](https://a.b/c_(p)))")).toBe(
        "(see <https://a.b/c_(p)|X>)",
      );
    });

    // Adversarial review (f): Slack mrkdwn escapes & < > in text, and `|`
    // ends the url part of <url|label>.
    it("escapes & < > in the minted label and percent-encodes | < > in the url", () => {
      expect(formatSlackMessage("[a<b&c>d](https://x.y/p)")).toBe(
        "<https://x.y/p|a&lt;b&amp;c&gt;d>",
      );
      expect(formatSlackMessage("[label](https://x.y/p|q)")).toBe(
        "<https://x.y/p%7Cq|label>",
      );
      expect(formatSlackMessage("[label](https://x.y/?a=<1>&b=2)")).toBe(
        "<https://x.y/?a=%3C1%3E&b=2|label>",
      );
      // Literal runs outside links are the compose site's text — untouched.
      expect(formatSlackMessage("a & b < c [x](https://y.z)")).toBe(
        "a & b < c <https://y.z|x>",
      );
      // Non-http targets stay exactly as authored (no escaping either).
      expect(formatSlackMessage("[a<b](ftp://x|y)")).toBe("[a<b](ftp://x|y)");
    });

    it("fan-out and sendToTarget both post the Slack-rendered link", async () => {
      const kOriginalSlackToken = process.env.SLACK_BOT_TOKEN;
      process.env.SLACK_BOT_TOKEN = "xoxb-default";
      try {
        const slackApi = {
          postMessage: vi.fn(async () => ({ ts: "1", channel: "dm" })),
          addReaction: vi.fn(async () => ({ ok: true })),
        };
        const fsMock = buildCredentialsFsMock({
          "slack-default-allowFrom.json": ["U_ADMIN"],
        });
        const notifier = createWatchdogNotifier({
          slackApi,
          fsImpl: fsMock,
          openclawDir: "/tmp/openclaw",
          readEnvFile: () => [{ key: "SLACK_BOT_TOKEN", value: "xoxb-default" }],
        });
        const message = "🔴 Crash loop - [View logs](https://claw.example/#/watchdog)";

        await notifier.notify(message, { eventType: "crash" });
        await notifier.sendToTarget({ channel: "slack", target: "U_ADMIN" }, message);

        expect(slackApi.postMessage).toHaveBeenCalledTimes(2);
        for (const call of slackApi.postMessage.mock.calls) {
          expect(call[1]).toBe(
            "🔴 Crash loop - <https://claw.example/#/watchdog|View logs>",
          );
        }
      } finally {
        if (kOriginalSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
        else process.env.SLACK_BOT_TOKEN = kOriginalSlackToken;
      }
    });
  });
});
