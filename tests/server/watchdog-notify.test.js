const path = require("path");

const {
  createWatchdogNotifier,
  resolveTelegramBotToken,
} = require("../../lib/server/watchdog-notify");

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
    });
    expect(defaultClient.postMessage.mock.calls[1][2]).toEqual({
      thread_ts: "xoxb-default-ts-1",
      mrkdwn: true,
    });
    expect(alertsClient.postMessage.mock.calls[0][2]).toEqual({
      thread_ts: null,
      mrkdwn: true,
    });
    expect(alertsClient.postMessage.mock.calls[1][2]).toEqual({
      thread_ts: "xoxb-alerts-ts-1",
      mrkdwn: true,
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
    });
    expect(telegramApi.sendMessage).toHaveBeenCalledWith(
      "100",
      "*Gateway crashed*",
      { parseMode: "Markdown" },
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[watchdog] telegram notification failed for 200: blocked by user",
    );
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
        telegram: { sent: 0, failed: 0, skipped: true, targets: 0 },
        discord: { sent: 0, failed: 0, skipped: true, targets: 0 },
        slack: { sent: 0, failed: 0, skipped: true, targets: 0 },
        whatsapp: { sent: 0, failed: 0, skipped: true, targets: 0 },
        webhook: { sent: 0, failed: 0, skipped: true, targets: 0 },
      },
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
        { parseMode: "Markdown" },
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
        { parseMode: "Markdown" },
      );

      delete process.env.TELEGRAM_BOT_TOKEN;
      const unconfigured = await notifier.sendToTarget(
        { channel: "telegram", target: "12345" },
        "Upgrade failed",
      );
      expect(unconfigured).toEqual({ ok: false, reason: "telegram_unconfigured" });
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
        { mrkdwn: true },
      );

      const missing = await notifier.sendToTarget(
        { channel: "slack", target: "U_ADMIN", accountId: "ops" },
        "Upgrade failed",
      );
      expect(missing).toEqual({ ok: false, reason: "missing SLACK_BOT_TOKEN_OPS" });
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
      );

      delete process.env.DISCORD_BOT_TOKEN;
      const unconfigured = await notifier.sendToTarget(
        { channel: "discord", target: "999" },
        "Upgrade failed",
      );
      expect(unconfigured).toEqual({ ok: false, reason: "discord_unconfigured" });
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
      });
      expect(createSlackApi).not.toHaveBeenCalled();
    });

    it("rejects invalid and unsupported targets with stable reasons", async () => {
      const notifier = createWatchdogNotifier({
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });

      expect(await notifier.sendToTarget({ channel: "telegram" }, "m")).toEqual({
        ok: false,
        reason: "invalid_target",
      });
      expect(await notifier.sendToTarget({}, "m")).toEqual({
        ok: false,
        reason: "invalid_target",
      });
      expect(
        await notifier.sendToTarget({ channel: "smoke", target: "x" }, "m"),
      ).toEqual({ ok: false, reason: "unsupported channel smoke" });
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
      expect(failed).toEqual({ ok: false, reason: "no session" });

      const unconfigured = createWatchdogNotifier({
        fsImpl: kEmptyFsMock,
        openclawDir: "/tmp/openclaw",
      });
      expect(
        await unconfigured.sendToTarget(
          { channel: "whatsapp", target: "+15550001111" },
          "m",
        ),
      ).toEqual({ ok: false, reason: "whatsapp_unconfigured" });
    });

    it("a thrown provider error becomes { ok:false, reason } instead of rejecting", async () => {
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
      expect(result).toEqual({ ok: false, reason: "discord down" });
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
      expect(failed).toEqual({ ok: false, reason: "blocked by user" });
      expect(notifier.getLastDeliveredAt()).toBe(stamped);
    });
  });
});
