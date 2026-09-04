const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-telegram-routes-"));
process.env.ALPHACLAW_ROOT_DIR = tmpRoot;

const {
  registerTelegramRoutes,
  buildTelegramGitSyncCommand,
} = require("../../lib/server/routes/telegram");
const { OPENCLAW_DIR, WORKSPACE_DIR } = require("../../lib/server/constants");
const topicRegistry = require("../../lib/server/topic-registry");

const kOpenclawJsonPath = path.join(OPENCLAW_DIR, "openclaw.json");

const writeOpenclawJson = (config) => {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.writeFileSync(kOpenclawJsonPath, JSON.stringify(config, null, 2));
};

const readOpenclawJson = () =>
  JSON.parse(fs.readFileSync(kOpenclawJsonPath, "utf8"));

const writeRegistryFile = (registry) => {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(
    topicRegistry.kRegistryPath,
    JSON.stringify(registry, null, 2),
  );
};

const readRegistryFile = () =>
  JSON.parse(fs.readFileSync(topicRegistry.kRegistryPath, "utf8"));

const makeTelegramApi = (overrides = {}) => ({
  getMe: vi.fn(async () => ({ id: 42, username: "alphabot" })),
  getChat: vi.fn(async () => ({
    id: -100,
    title: "Group Title",
    type: "supergroup",
    is_forum: true,
  })),
  getChatMember: vi.fn(async () => ({
    status: "administrator",
    can_manage_topics: true,
  })),
  getChatAdministrators: vi.fn(async () => [
    { status: "administrator", user: { id: 42, is_bot: true } },
    { status: "administrator", user: { id: 8, is_bot: false } },
    { status: "creator", user: { id: 7, is_bot: false } },
  ]),
  createForumTopic: vi.fn(async (chatId, name) => ({
    message_thread_id: 5,
    name,
    icon_color: 7322096,
  })),
  deleteForumTopic: vi.fn(async () => ({})),
  editForumTopic: vi.fn(async () => ({})),
  sendChatAction: vi.fn(async () => true),
  sendMessage: vi.fn(async () => ({})),
  ...overrides,
});

const createApp = ({
  telegramApi,
  syncPromptFiles,
  shellCmd,
  omitShellCmd,
  topicDiscovery,
} = {}) => {
  const app = express();
  app.use(express.json());
  const deps = {
    app,
    telegramApi: telegramApi || makeTelegramApi(),
    syncPromptFiles: syncPromptFiles || vi.fn(),
    shellCmd: shellCmd || vi.fn(async () => ({ ok: true })),
    ...(topicDiscovery ? { topicDiscovery } : {}),
  };
  if (omitShellCmd) delete deps.shellCmd;
  registerTelegramRoutes(deps);
  return { app, ...deps };
};

describe("server/routes/telegram", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    fs.rmSync(kOpenclawJsonPath, { force: true });
    fs.rmSync(topicRegistry.kRegistryPath, { force: true });
    delete process.env.TELEGRAM_BOT_TOKEN_WORK;
    delete process.env.TELEGRAM_BOT_TOKEN_WORK_2;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN_WORK;
    delete process.env.TELEGRAM_BOT_TOKEN_WORK_2;
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("buildTelegramGitSyncCommand", () => {
    it("quotes git-sync commit messages as a single shell arg", () => {
      const command = buildTelegramGitSyncCommand("rename-topic", "topic's name");
      expect(command).toBe(
        "alphaclaw git-sync -m 'telegram workspace: rename-topic topic'\"'\"'s name'",
      );
    });

    it("normalizes whitespace and keeps message content literal", () => {
      const command = buildTelegramGitSyncCommand(
        "create-topic",
        "line one\nline\t two  $(touch /tmp/pwned)  `uname -a`",
      );
      expect(command).toContain("$(touch /tmp/pwned)");
      expect(command).toContain("`uname -a`");
      expect(command).not.toContain("\n");
      expect(command).not.toContain("\t");
      expect(command.startsWith("alphaclaw git-sync -m '")).toBe(true);
      expect(command.endsWith("'")).toBe(true);
    });
  });

  describe("GET /api/telegram/bot", () => {
    it("verifies the default bot token", async () => {
      const { app, telegramApi } = createApp();
      const res = await request(app).get("/api/telegram/bot");
      expect(res.body).toEqual({
        ok: true,
        bot: { id: 42, username: "alphabot" },
        accountId: "default",
      });
      expect(telegramApi.getMe).toHaveBeenCalled();
    });

    it("falls back to the default api when the account env token is missing", async () => {
      const { app, telegramApi } = createApp();
      const res = await request(app).get("/api/telegram/bot?accountId=work");
      expect(res.body.ok).toBe(true);
      expect(res.body.accountId).toBe("work");
      expect(telegramApi.getMe).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("TELEGRAM_BOT_TOKEN_WORK not found"),
      );
    });

    it("uses a per-account token from the environment when present", async () => {
      process.env.TELEGRAM_BOT_TOKEN_WORK_2 = "account-token";
      global.fetch = vi.fn(async () => ({
        json: async () => ({ ok: true, result: { id: 99, username: "workbot" } }),
      }));
      const { app, telegramApi } = createApp();

      const res = await request(app).get("/api/telegram/bot?accountId=work-2");

      expect(res.body).toEqual({
        ok: true,
        bot: { id: 99, username: "workbot" },
        accountId: "work-2",
      });
      expect(telegramApi.getMe).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.telegram.org/botaccount-token/getMe",
        expect.any(Object),
      );
    });

    it("reports errors from the telegram api", async () => {
      const telegramApi = makeTelegramApi({
        getMe: vi.fn(async () => {
          throw new Error("unauthorized");
        }),
      });
      const { app } = createApp({ telegramApi });
      const res = await request(app).get("/api/telegram/bot");
      expect(res.body).toEqual({ ok: false, error: "unauthorized" });
    });
  });

  describe("POST /api/telegram/groups/verify", () => {
    it("requires a group id", async () => {
      const { app } = createApp();
      const res = await request(app).post("/api/telegram/groups/verify").send();
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "groupId is required" });
    });

    it("verifies group membership using the chatId alias", async () => {
      const { app, telegramApi } = createApp();
      const res = await request(app)
        .post("/api/telegram/groups/verify")
        .send({ chatId: -100123 });

      expect(res.body).toEqual({
        ok: true,
        chat: {
          id: -100,
          title: "Group Title",
          type: "supergroup",
          isForum: true,
        },
        bot: { status: "administrator", isAdmin: true, canManageTopics: true },
        suggestedUserId: "7",
      });
      expect(telegramApi.getChat).toHaveBeenCalledWith("-100123");
      expect(telegramApi.getChatMember).toHaveBeenCalledWith("-100123", 42);
    });

    it("reports a non-admin bot and no suggested user when only bots administer", async () => {
      const telegramApi = makeTelegramApi({
        getChat: vi.fn(async () => ({
          id: -100,
          title: "Plain",
          type: "group",
        })),
        getChatMember: vi.fn(async () => ({ status: "member" })),
        getChatAdministrators: vi.fn(async () => [
          { status: "administrator", user: { id: 42, is_bot: true } },
        ]),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .post("/api/telegram/groups/verify")
        .send({ groupId: "-100123" });

      expect(res.body.chat.isForum).toBe(false);
      expect(res.body.bot).toEqual({
        status: "member",
        isAdmin: false,
        canManageTopics: false,
      });
      expect(res.body.suggestedUserId).toBeNull();
    });

    it("falls back to the first human admin when there is no creator", async () => {
      const telegramApi = makeTelegramApi({
        getChatAdministrators: vi.fn(async () => [
          { status: "administrator", user: { id: 11, is_bot: false } },
          { status: "administrator", user: { id: 12, is_bot: false } },
        ]),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .post("/api/telegram/groups/verify")
        .send({ groupId: "-100123" });

      expect(res.body.suggestedUserId).toBe("11");
    });

    it("reports telegram errors", async () => {
      const telegramApi = makeTelegramApi({
        getChat: vi.fn(async () => {
          throw new Error("chat not found");
        }),
      });
      const { app } = createApp({ telegramApi });
      const res = await request(app)
        .post("/api/telegram/groups/verify")
        .send({ groupId: "-100123" });
      expect(res.body).toEqual({ ok: false, error: "chat not found" });
    });
  });

  describe("GET /api/telegram/groups/:groupId/topics", () => {
    it("lists topics for known groups and empty maps for unknown groups", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Ops" } } } },
      });
      const { app } = createApp();

      const known = await request(app).get("/api/telegram/groups/-100/topics");
      expect(known.body).toEqual({ ok: true, topics: { 5: { name: "Ops" } } });

      const unknown = await request(app).get("/api/telegram/groups/-404/topics");
      expect(unknown.body).toEqual({ ok: true, topics: {} });
    });
  });

  describe("POST /api/telegram/groups/:groupId/topics", () => {
    it("requires a name", async () => {
      const { app } = createApp();
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "name is required" });
    });

    it("creates a topic, updates the registry and syncs config", async () => {
      const { app, telegramApi, syncPromptFiles, shellCmd } = createApp();

      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({
          name: "Ops",
          iconColor: "7322096",
          systemPrompt: "Be helpful",
          agentId: "scout",
        });

      expect(res.body).toEqual({
        ok: true,
        topic: {
          threadId: 5,
          name: "Ops",
          iconColor: 7322096,
          agentId: "scout",
        },
        syncWarning: null,
      });
      expect(telegramApi.createForumTopic).toHaveBeenCalledWith("-100", "Ops", {
        iconColor: 7322096,
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        iconColor: 7322096,
        systemInstructions: "Be helpful",
        agentId: "scout",
        discovered: false,
      });
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram.groups["-100"]).toEqual({
        requireMention: false,
        topics: { 5: { systemPrompt: "Be helpful", agentId: "scout" } },
      });
      expect(cfg.agents.defaults.maxConcurrent).toBe(8);
      expect(cfg.agents.defaults.subagents.maxConcurrent).toBe(6);
      expect(syncPromptFiles).toHaveBeenCalled();
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: create-topic Ops'",
        { timeout: 30000 },
      );
    });

    it("ignores invalid icon colors and empty agent ids", async () => {
      const { app, telegramApi } = createApp();

      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({ name: "Ops", iconColor: "not-a-number", agentId: "" });

      expect(res.body.ok).toBe(true);
      expect(res.body.topic).toEqual({
        threadId: 5,
        name: "Ops",
        iconColor: 7322096,
        agentId: "",
      });
      expect(telegramApi.createForumTopic).toHaveBeenCalledWith("-100", "Ops", {
        iconColor: undefined,
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        iconColor: 7322096,
        agentId: undefined,
        discovered: false,
      });
    });

    it("surfaces git-sync failures as syncWarning", async () => {
      const shellCmd = vi.fn(async () => {
        throw new Error("git sync exploded");
      });
      const { app } = createApp({ shellCmd });
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({ name: "Ops" });
      expect(res.body.ok).toBe(true);
      expect(res.body.syncWarning).toBe("git sync exploded");
    });

    it("uses a fallback git-sync warning when the error has no message", async () => {
      const shellCmd = vi.fn(async () => {
        throw { code: 1 };
      });
      const { app } = createApp({ shellCmd });
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({ name: "Ops" });
      expect(res.body.syncWarning).toBe("alphaclaw git-sync failed");
    });

    it("skips git-sync when no shell command is provided", async () => {
      const { app } = createApp({ omitShellCmd: true });
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({ name: "Ops" });
      expect(res.body.ok).toBe(true);
      expect(res.body.syncWarning).toBeNull();
    });

    it("reports topic creation errors", async () => {
      const telegramApi = makeTelegramApi({
        createForumTopic: vi.fn(async () => {
          throw new Error("not a forum");
        }),
      });
      const { app } = createApp({ telegramApi });
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics")
        .send({ name: "Ops" });
      expect(res.body).toEqual({ ok: false, error: "not a forum" });
    });
  });

  describe("POST /api/telegram/groups/:groupId/topics/bulk", () => {
    it("requires a non-empty topics array", async () => {
      const { app } = createApp();
      const res = await request(app)
        .post("/api/telegram/groups/-100/topics/bulk")
        .send({ topics: [] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "topics array is required" });
    });

    it("creates topics in bulk with per-topic results", async () => {
      let nextThread = 10;
      const telegramApi = makeTelegramApi({
        createForumTopic: vi.fn(async (chatId, name) => {
          if (name === "Broken") throw new Error("flood control");
          nextThread += 1;
          return { message_thread_id: nextThread, name, icon_color: 1 };
        }),
      });
      const { app, syncPromptFiles, shellCmd } = createApp({ telegramApi });

      const res = await request(app)
        .post("/api/telegram/groups/-100/topics/bulk")
        .send({
          topics: [
            {},
            {
              name: "Ops",
              iconColor: 3,
              systemInstructions: "sys",
              agentId: "scout",
            },
            { name: "Broken" },
          ],
        });

      expect(res.body.ok).toBe(true);
      expect(res.body.results).toEqual([
        { name: undefined, ok: false, error: "name is required" },
        { name: "Ops", threadId: 11, ok: true },
        { name: "Broken", ok: false, error: "flood control" },
      ]);
      expect(res.body.syncWarning).toBeNull();
      expect(readRegistryFile().groups["-100"].topics["11"]).toEqual({
        name: "Ops",
        iconColor: 1,
        systemInstructions: "sys",
        agentId: "scout",
        discovered: false,
      });
      expect(syncPromptFiles).toHaveBeenCalled();
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: bulk-create-topics -100'",
        { timeout: 30000 },
      );
    });
  });

  describe("DELETE /api/telegram/groups/:groupId/topics/:topicId", () => {
    it("deletes a topic from telegram and tombstones the registry entry", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Ops" } } } },
      });
      const { app, telegramApi, syncPromptFiles } = createApp();

      const res = await request(app).delete("/api/telegram/groups/-100/topics/5");

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      expect(telegramApi.deleteForumTopic).toHaveBeenCalledWith("-100", 5);
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        deleted: true,
        deletedAt: expect.any(Number),
        stale: false,
      });
      expect(syncPromptFiles).toHaveBeenCalled();
    });

    it("reports unexpected telegram errors", async () => {
      const telegramApi = makeTelegramApi({
        deleteForumTopic: vi.fn(async () => {
          throw new Error("rights required");
        }),
      });
      const { app, syncPromptFiles } = createApp({ telegramApi });
      const res = await request(app).delete("/api/telegram/groups/-100/topics/5");
      expect(res.body).toEqual({ ok: false, error: "rights required" });
      expect(syncPromptFiles).not.toHaveBeenCalled();
    });

    it("tombstones stale registry entries when the topic is already gone", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Ops" } } } },
      });
      const telegramApi = makeTelegramApi({
        deleteForumTopic: vi.fn(async () => {
          throw new Error("Bad Request: message thread not found");
        }),
      });
      const { app, shellCmd } = createApp({ telegramApi });

      const res = await request(app).delete("/api/telegram/groups/-100/topics/5");

      expect(res.body).toEqual({
        ok: true,
        removedFromRegistryOnly: true,
        warning:
          "Topic no longer exists in Telegram; removed stale registry entry.",
        syncWarning: null,
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        deleted: true,
        deletedAt: expect.any(Number),
        stale: false,
      });
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: delete-stale-topic 5'",
        { timeout: 30000 },
      );
    });
  });

  describe("POST /api/telegram/groups/:groupId/topics/:topicId/restore", () => {
    it("clears the tombstone and re-syncs prompt files", async () => {
      writeRegistryFile({
        groups: {
          "-100": {
            name: "G",
            topics: { 5: { name: "Ops", deleted: true, deletedAt: 123 } },
          },
        },
      });
      const { app, syncPromptFiles } = createApp();

      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/5/restore",
      );

      expect(res.body).toEqual({ ok: true });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
      });
      expect(syncPromptFiles).toHaveBeenCalled();
    });

    it("fails closed with a 503 when the registry file is corrupt", async () => {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      fs.writeFileSync(topicRegistry.kRegistryPath, "{not json");
      const { app, syncPromptFiles } = createApp();

      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/5/restore",
      );

      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe("TOPIC_REGISTRY_UNREADABLE");
      expect(res.body.error).toContain("not valid JSON");
      // Fail closed: the corrupt file must never be rewritten.
      expect(fs.readFileSync(topicRegistry.kRegistryPath, "utf8")).toBe(
        "{not json",
      );
      expect(syncPromptFiles).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/telegram/groups/:groupId/topics/:topicId/verify", () => {
    it("requires a numeric topic id", async () => {
      const { app } = createApp();
      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/abc/verify",
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "topicId must be numeric" });
    });

    it("marks the topic live and updates lastSeenAt when the probe succeeds", async () => {
      writeRegistryFile({
        groups: {
          "-100": { name: "G", topics: { 5: { name: "Ops", stale: true } } },
        },
      });
      const { app, telegramApi } = createApp();

      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/5/verify",
      );

      expect(res.body).toEqual({ ok: true, status: "ok" });
      expect(telegramApi.sendChatAction).toHaveBeenCalledWith("-100", "typing", {
        messageThreadId: 5,
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        stale: false,
        lastSeenAt: expect.any(Number),
      });
    });

    it("marks the topic stale when telegram reports the thread missing", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Ops" } } } },
      });
      const telegramApi = makeTelegramApi({
        sendChatAction: vi.fn(async () => {
          throw new Error("Bad Request: message thread not found");
        }),
      });
      const { app, syncPromptFiles } = createApp({ telegramApi });

      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/5/verify",
      );

      expect(res.body).toEqual({ ok: true, status: "stale" });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
        stale: true,
      });
      expect(syncPromptFiles).toHaveBeenCalled();
    });

    it("returns 502 without marking stale on other telegram failures", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Ops" } } } },
      });
      const telegramApi = makeTelegramApi({
        sendChatAction: vi.fn(async () => {
          throw new Error("Too Many Requests: retry after 5");
        }),
      });
      const { app, syncPromptFiles } = createApp({ telegramApi });

      const res = await request(app).post(
        "/api/telegram/groups/-100/topics/5/verify",
      );

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        ok: false,
        error: "Too Many Requests: retry after 5",
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Ops",
      });
      expect(syncPromptFiles).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/telegram/groups/:groupId/topics/:topicId", () => {
    it("requires a name", async () => {
      const { app } = createApp();
      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "   " });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "name is required" });
    });

    it("requires a numeric topic id", async () => {
      const { app } = createApp();
      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/abc")
        .send({ name: "Ops" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "topicId must be numeric" });
    });

    it("renames a topic and updates instructions and agent routing", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Old" } } } },
      });
      const { app, telegramApi, shellCmd } = createApp();

      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "New", systemInstructions: "sys", agentId: "scout" });

      expect(res.body).toEqual({
        ok: true,
        topic: {
          threadId: 5,
          name: "New",
          systemInstructions: "sys",
          agentId: "scout",
        },
        syncWarning: null,
      });
      expect(telegramApi.editForumTopic).toHaveBeenCalledWith("-100", 5, {
        name: "New",
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "New",
        systemInstructions: "sys",
        agentId: "scout",
        discovered: false,
      });
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: update-topic New'",
        { timeout: 30000 },
      );
    });

    it("skips the telegram rename when the name is unchanged", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Same" } } } },
      });
      const { app, telegramApi } = createApp();

      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "Same" });

      expect(res.body.ok).toBe(true);
      expect(res.body.topic).toEqual({ threadId: 5, name: "Same" });
      expect(telegramApi.editForumTopic).not.toHaveBeenCalled();
    });

    it("tolerates TOPIC_NOT_MODIFIED errors from telegram", async () => {
      const telegramApi = makeTelegramApi({
        editForumTopic: vi.fn(async () => {
          throw new Error("Bad Request: TOPIC_NOT_MODIFIED");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "Fresh" });

      expect(res.body.ok).toBe(true);
      expect(readRegistryFile().groups["-100"].topics["5"].name).toBe("Fresh");
    });

    it("reports other rename failures", async () => {
      const telegramApi = makeTelegramApi({
        editForumTopic: vi.fn(async () => {
          throw new Error("TOPIC_EDIT_FORBIDDEN");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "Fresh" });

      expect(res.body).toEqual({ ok: false, error: "TOPIC_EDIT_FORBIDDEN" });
    });

    it("lazily marks the topic stale when renaming into a missing thread", async () => {
      writeRegistryFile({
        groups: { "-100": { name: "G", topics: { 5: { name: "Old" } } } },
      });
      const telegramApi = makeTelegramApi({
        editForumTopic: vi.fn(async () => {
          throw new Error("Bad Request: message thread not found");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .put("/api/telegram/groups/-100/topics/5")
        .send({ name: "New" });

      expect(res.body).toEqual({
        ok: false,
        error: "Bad Request: message thread not found",
      });
      expect(readRegistryFile().groups["-100"].topics["5"]).toEqual({
        name: "Old",
        stale: true,
      });
    });
  });

  describe("POST /api/telegram/groups/:groupId/configure", () => {
    it("configures a group with a preferred user and bound agent", async () => {
      writeOpenclawJson({
        bindings: [
          null,
          {
            agentId: "skip-scoped",
            match: { channel: "telegram", accountId: "work", peer: "p1" },
          },
          { agentId: "skip-channel", match: { channel: "discord", accountId: "work" } },
          { agentId: "skip-account", match: { channel: "telegram", accountId: "other" } },
          { agentId: "", match: { channel: "telegram", accountId: "work" } },
          { agentId: "alpha", match: { channel: "telegram", accountId: "work" } },
        ],
      });
      const { app, telegramApi, syncPromptFiles, shellCmd } = createApp();

      const res = await request(app)
        .post("/api/telegram/groups/-100/configure?accountId=work")
        .send({ userId: " 99 ", groupName: "My Group", requireMention: "true" });

      expect(res.body).toEqual({ ok: true, userId: "99", syncWarning: null });
      expect(telegramApi.getChatAdministrators).not.toHaveBeenCalled();
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram.groups["-100"]).toEqual({
        requireMention: true,
      });
      expect(cfg.channels.telegram.groupAllowFrom).toEqual(["99"]);
      expect(readRegistryFile().groups["-100"]).toEqual({
        channel: "telegram",
        name: "My Group",
        topics: {},
        accountId: "work",
        agentId: "alpha",
      });
      expect(syncPromptFiles).toHaveBeenCalled();
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: configure-group -100'",
        { timeout: 30000 },
      );
    });

    it("resolves the allow-from user from group admins for default account", async () => {
      const { app, telegramApi } = createApp();

      const res = await request(app)
        .post("/api/telegram/groups/-100/configure")
        .send({});

      expect(res.body).toEqual({ ok: true, userId: "7", syncWarning: null });
      expect(telegramApi.getChatAdministrators).toHaveBeenCalledWith("-100");
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram.groupAllowFrom).toEqual(["7"]);
      expect(readRegistryFile().groups["-100"]).toEqual({
        channel: "telegram",
        name: "-100",
        topics: {},
        accountId: "default",
        agentId: "default",
      });
    });

    it("returns a null user when no human admins exist", async () => {
      const telegramApi = makeTelegramApi({
        getChatAdministrators: vi.fn(async () => [
          { status: "administrator", user: { id: 42, is_bot: true } },
        ]),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .post("/api/telegram/groups/-100/configure?accountId=work")
        .send({});

      expect(res.body).toEqual({ ok: true, userId: null, syncWarning: null });
      expect(readRegistryFile().groups["-100"]).toEqual({
        channel: "telegram",
        name: "-100",
        topics: {},
        accountId: "work",
      });
    });

    it("reports errors while resolving the allow-from user", async () => {
      const telegramApi = makeTelegramApi({
        getChatAdministrators: vi.fn(async () => {
          throw new Error("admins unavailable");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app)
        .post("/api/telegram/groups/-100/configure")
        .send({});

      expect(res.body).toEqual({ ok: false, error: "admins unavailable" });
    });
  });

  describe("GET /api/telegram/topic-registry", () => {
    it("returns the normalized registry", async () => {
      writeRegistryFile({ groups: { "-100": { name: "G", topics: {} } } });
      const { app } = createApp();
      const res = await request(app).get("/api/telegram/topic-registry");
      expect(res.body).toEqual({
        ok: true,
        registry: {
          version: 2,
          meta: { sweepWatermark: 0 },
          groups: { "-100": { name: "G", topics: {} } },
        },
      });
    });
  });

  describe("GET /api/telegram/topics", () => {
    it("returns flat topic rows and a null discovery status without the service", async () => {
      writeRegistryFile({
        groups: {
          "-100": {
            name: "G",
            accountId: "work",
            agentId: "alpha",
            topics: {
              5: { name: "Ops", agentId: "scout", lastSeenAt: 111 },
              6: { name: "", discovered: true, seenAgentId: "scout" },
              7: { name: "Old", stale: true, deleted: true, deletedAt: 999 },
            },
          },
        },
      });
      const { app } = createApp();

      const res = await request(app).get("/api/telegram/topics");

      expect(res.body).toEqual({
        ok: true,
        discovery: null,
        topics: [
          {
            groupId: "-100",
            groupName: "G",
            accountId: "work",
            groupAgentId: "alpha",
            threadId: "5",
            name: "Ops",
            nameSource: "",
            agentId: "scout",
            discovered: false,
            stale: false,
            deleted: false,
            deletedAt: 0,
            lastSeenAt: 111,
            seenAgentId: "",
          },
          {
            groupId: "-100",
            groupName: "G",
            accountId: "work",
            groupAgentId: "alpha",
            threadId: "6",
            name: "",
            nameSource: "",
            agentId: "",
            discovered: true,
            stale: false,
            deleted: false,
            deletedAt: 0,
            lastSeenAt: 0,
            seenAgentId: "scout",
          },
          {
            groupId: "-100",
            groupName: "G",
            accountId: "work",
            groupAgentId: "alpha",
            threadId: "7",
            name: "Old",
            nameSource: "",
            agentId: "",
            discovered: false,
            stale: true,
            deleted: true,
            deletedAt: 999,
            lastSeenAt: 0,
            seenAgentId: "",
          },
        ],
      });
    });

    it("includes the discovery status when the service is available", async () => {
      const topicDiscovery = {
        sweep: vi.fn(),
        getStatus: vi.fn(() => ({
          enabled: true,
          running: true,
          lastSweepAt: 42,
          lastResult: { discovered: 1 },
        })),
      };
      const { app } = createApp({ topicDiscovery });

      const res = await request(app).get("/api/telegram/topics");

      expect(res.body).toEqual({
        ok: true,
        topics: [],
        discovery: {
          enabled: true,
          running: true,
          lastSweepAt: 42,
          lastResult: { discovered: 1 },
        },
      });
    });
  });

  describe("telegram discovery endpoints", () => {
    it("runs a sweep on demand", async () => {
      const topicDiscovery = {
        sweep: vi.fn(async () => ({ firstSweep: false, discovered: 2, named: 1 })),
        getStatus: vi.fn(),
      };
      const { app } = createApp({ topicDiscovery });

      const res = await request(app).post("/api/telegram/discovery/sweep");

      expect(res.body).toEqual({
        ok: true,
        result: { firstSweep: false, discovered: 2, named: 1 },
      });
      expect(topicDiscovery.sweep).toHaveBeenCalled();
    });

    it("reports sweep failures", async () => {
      const topicDiscovery = {
        sweep: vi.fn(async () => {
          throw new Error("usage db exploded");
        }),
        getStatus: vi.fn(),
      };
      const { app } = createApp({ topicDiscovery });

      const res = await request(app).post("/api/telegram/discovery/sweep");

      expect(res.body).toEqual({ ok: false, error: "usage db exploded" });
    });

    it("returns the discovery status", async () => {
      const topicDiscovery = {
        sweep: vi.fn(),
        getStatus: vi.fn(() => ({ enabled: false, running: false })),
      };
      const { app } = createApp({ topicDiscovery });

      const res = await request(app).get("/api/telegram/discovery/status");

      expect(res.body).toEqual({
        ok: true,
        status: { enabled: false, running: false },
      });
    });

    it("responds 503 for sweep and status when the service is absent", async () => {
      const { app } = createApp();

      const sweep = await request(app).post("/api/telegram/discovery/sweep");
      expect(sweep.status).toBe(503);
      expect(sweep.body).toEqual({
        ok: false,
        error: "topic discovery service unavailable",
      });

      const status = await request(app).get("/api/telegram/discovery/status");
      expect(status.status).toBe(503);
      expect(status.body).toEqual({
        ok: false,
        error: "topic discovery service unavailable",
      });
    });
  });

  describe("GET /api/telegram/workspace", () => {
    it("reports unconfigured when no groups exist anywhere", async () => {
      const { app } = createApp();
      const res = await request(app).get("/api/telegram/workspace");
      expect(res.body).toEqual({
        ok: true,
        configured: false,
        groups: [],
        debugEnabled: false,
      });
    });

    it("falls back to registry groups when config has none", async () => {
      writeRegistryFile({
        groups: {
          "-100": { name: "Reg Group", topics: { 5: { name: "Ops" } } },
          "-200": { name: "Other Account", accountId: "work", topics: {} },
        },
      });
      const { app, telegramApi } = createApp();

      const res = await request(app).get("/api/telegram/workspace");

      expect(res.body.ok).toBe(true);
      expect(res.body.configured).toBe(true);
      expect(res.body.groups).toEqual([
        {
          groupId: "-100",
          groupName: "Group Title",
          topics: { 5: { name: "Ops" } },
        },
      ]);
      expect(res.body.groupId).toBe("-100");
      expect(res.body.groupName).toBe("Group Title");
      expect(res.body.topics).toEqual({ 5: { name: "Ops" } });
      expect(res.body.concurrency).toEqual({
        agentMaxConcurrent: null,
        subagentMaxConcurrent: null,
        computedMaxConcurrent: 8,
        computedSubagentMaxConcurrent: 6,
        resourceCap: 64,
        resourceCapSource: "legacy",
      });
      expect(telegramApi.getChatAdministrators).not.toHaveBeenCalled();
    });

    it("returns configured groups without repair when allow-from exists", async () => {
      writeOpenclawJson({
        channels: {
          telegram: {
            groups: { "-100": { requireMention: false } },
            groupAllowFrom: ["7"],
          },
        },
        agents: { defaults: { maxConcurrent: 12, subagents: { maxConcurrent: 10 } } },
      });
      const telegramApi = makeTelegramApi({
        getChat: vi.fn(async () => {
          throw new Error("unreachable");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app).get("/api/telegram/workspace");

      expect(res.body.ok).toBe(true);
      expect(res.body.configured).toBe(true);
      expect(res.body.groups).toEqual([
        { groupId: "-100", groupName: "-100", topics: {} },
      ]);
      expect(res.body.concurrency).toEqual({
        agentMaxConcurrent: 12,
        subagentMaxConcurrent: 10,
        computedMaxConcurrent: 8,
        computedSubagentMaxConcurrent: 6,
        resourceCap: 64,
        resourceCapSource: "legacy",
      });
      expect(telegramApi.getChatAdministrators).not.toHaveBeenCalled();
    });

    it("repairs missing group allow-from entries before responding", async () => {
      writeOpenclawJson({
        channels: {
          telegram: { groups: { "-100": { requireMention: true } } },
        },
      });
      const { app, telegramApi, shellCmd } = createApp();

      const res = await request(app).get("/api/telegram/workspace");

      expect(res.body.ok).toBe(true);
      expect(res.body.configured).toBe(true);
      expect(res.body.groups).toEqual([
        { groupId: "-100", groupName: "Group Title", topics: {} },
      ]);
      expect(res.body.concurrency).toEqual({
        agentMaxConcurrent: 8,
        subagentMaxConcurrent: 6,
        computedMaxConcurrent: 8,
        computedSubagentMaxConcurrent: 6,
        resourceCap: 64,
        resourceCapSource: "legacy",
      });
      expect(telegramApi.getChatAdministrators).toHaveBeenCalledWith("-100");
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram.groupAllowFrom).toEqual(["7"]);
      expect(cfg.channels.telegram.groups["-100"].requireMention).toBe(true);
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: repair-group-allow-from -100'",
        { timeout: 30000 },
      );
    });

    it("scopes workspace lookups to the requested account entry", async () => {
      writeOpenclawJson({
        channels: {
          telegram: {
            accounts: {
              work: {
                groups: { "-200": { requireMention: false } },
                groupAllowFrom: ["9"],
              },
            },
          },
        },
      });
      const { app } = createApp();

      const res = await request(app).get("/api/telegram/workspace?accountId=work");

      expect(res.body.ok).toBe(true);
      expect(res.body.configured).toBe(true);
      expect(res.body.groups).toEqual([
        { groupId: "-200", groupName: "Group Title", topics: {} },
      ]);
    });

    it("reports unconfigured for an unknown account in accounts mode", async () => {
      writeOpenclawJson({
        channels: {
          telegram: {
            accounts: {
              other: { groups: { "-300": {} }, groupAllowFrom: ["1"] },
            },
          },
        },
      });
      const { app } = createApp();

      const res = await request(app).get("/api/telegram/workspace?accountId=work");

      expect(res.body).toEqual({
        ok: true,
        configured: false,
        groups: [],
        debugEnabled: false,
      });
    });

    it("reports errors raised while repairing groups", async () => {
      writeOpenclawJson({
        channels: { telegram: { groups: { "-100": {} } } },
      });
      const telegramApi = makeTelegramApi({
        getChatAdministrators: vi.fn(async () => {
          throw new Error("admins boom");
        }),
      });
      const { app } = createApp({ telegramApi });

      const res = await request(app).get("/api/telegram/workspace");

      expect(res.body).toEqual({ ok: false, error: "admins boom" });
    });
  });

  describe("POST /api/telegram/workspace/reset", () => {
    it("returns early when no telegram config exists", async () => {
      const { app, syncPromptFiles } = createApp();
      const res = await request(app).post("/api/telegram/workspace/reset");
      expect(res.body).toEqual({ ok: true, syncWarning: null });
      expect(syncPromptFiles).not.toHaveBeenCalled();
    });

    it("clears single-account telegram config and matching registry groups", async () => {
      writeOpenclawJson({
        channels: {
          telegram: {
            enabled: true,
            groups: { "-100": { requireMention: false } },
            groupAllowFrom: ["7"],
          },
        },
      });
      writeRegistryFile({
        groups: {
          "-100": { name: "Reset Me", topics: {} },
          "-999": { name: "Keep Me", topics: {} },
        },
      });
      const { app, syncPromptFiles, shellCmd } = createApp();

      const res = await request(app).post("/api/telegram/workspace/reset");

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram).toEqual({ enabled: true });
      expect(readRegistryFile().groups).toEqual({
        "-999": { name: "Keep Me", topics: {} },
      });
      expect(syncPromptFiles).toHaveBeenCalled();
      expect(shellCmd).toHaveBeenCalledWith(
        "alphaclaw git-sync -m 'telegram workspace: reset-workspace telegram'",
        { timeout: 30000 },
      );
    });

    it("clears only the requested account entry in accounts mode", async () => {
      writeOpenclawJson({
        channels: {
          telegram: {
            accounts: {
              work: { groups: { "-200": {} }, groupAllowFrom: ["9"] },
              other: { groups: { "-300": {} }, groupAllowFrom: ["1"] },
            },
          },
        },
      });
      writeRegistryFile({
        groups: { "-200": { name: "Work", accountId: "work", topics: {} } },
      });
      const { app } = createApp();

      const res = await request(app).post(
        "/api/telegram/workspace/reset?accountId=work",
      );

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      const cfg = readOpenclawJson();
      expect(cfg.channels.telegram.accounts.work).toEqual({});
      expect(cfg.channels.telegram.accounts.other).toEqual({
        groups: { "-300": {} },
        groupAllowFrom: ["1"],
      });
      expect(readRegistryFile().groups).toEqual({});
    });

    it("falls back to registry groups when the account entry has none", async () => {
      writeOpenclawJson({
        channels: { telegram: { accounts: { other: { groups: { "-300": {} } } } } },
      });
      writeRegistryFile({
        groups: {
          "-400": { name: "Work Reg", accountId: "work", topics: {} },
          "-300": { name: "Other Reg", accountId: "other", topics: {} },
        },
      });
      const { app } = createApp();

      const res = await request(app).post(
        "/api/telegram/workspace/reset?accountId=work",
      );

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      expect(readRegistryFile().groups).toEqual({
        "-300": { name: "Other Reg", accountId: "other", topics: {} },
      });
    });

    it("normalizes a registry that has no groups container", async () => {
      writeOpenclawJson({
        channels: { telegram: { groups: { "-100": {} } } },
      });
      writeRegistryFile({ groups: null });
      const { app } = createApp();

      const res = await request(app).post("/api/telegram/workspace/reset");

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      // The write path normalizes the shape: groups is always an object.
      expect(readRegistryFile().groups).toEqual({});
    });

    it("keeps tombstones by default so discovery cannot resurrect them", async () => {
      writeOpenclawJson({
        channels: { telegram: { groups: { "-100": {} } } },
      });
      writeRegistryFile({
        groups: {
          "-999": {
            name: "Keep Me",
            topics: {
              9: { name: "Gone", deleted: true, deletedAt: 123 },
              10: { name: "Live" },
            },
          },
        },
      });
      const { app } = createApp();

      const res = await request(app)
        .post("/api/telegram/workspace/reset")
        .send({ mode: "keep" });

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      expect(readRegistryFile().groups["-999"].topics).toEqual({
        9: { name: "Gone", deleted: true, deletedAt: 123 },
        10: { name: "Live" },
      });
    });

    it("clears tombstones in rediscover mode", async () => {
      writeOpenclawJson({
        channels: { telegram: { groups: { "-100": {} } } },
      });
      writeRegistryFile({
        groups: {
          "-999": {
            name: "Keep Me",
            topics: {
              9: { name: "Gone", deleted: true, deletedAt: 123 },
              10: { name: "Live" },
            },
          },
        },
      });
      const { app } = createApp();

      const res = await request(app)
        .post("/api/telegram/workspace/reset")
        .send({ mode: "rediscover" });

      expect(res.body).toEqual({ ok: true, syncWarning: null });
      expect(readRegistryFile().groups["-999"].topics).toEqual({
        10: { name: "Live" },
      });
    });

    it("reports reset failures", async () => {
      writeOpenclawJson({
        channels: { telegram: { groups: { "-100": {} } } },
      });
      const syncPromptFiles = vi.fn(() => {
        throw new Error("prompt sync failed");
      });
      const { app } = createApp({ syncPromptFiles });

      const res = await request(app).post("/api/telegram/workspace/reset");

      expect(res.body).toEqual({ ok: false, error: "prompt sync failed" });
    });
  });
});

// Fix wave F084: accountId is a config KEY (channels.telegram.accounts[id])
// and a path segment; `__proto__` made Object.prototype the write target.
describe("server/routes/telegram accountId boundary", () => {
  it("rejects a prototype-key accountId on every telegram route and leaves Object.prototype clean", async () => {
    const { app } = createApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOpenclawJson({ channels: { telegram: { accounts: { default: {} } } } });
    const viaQuery = await request(app).get("/api/telegram/bot?accountId=__proto__");
    expect(viaQuery.status).toBe(400);
    expect(viaQuery.body).toEqual({ ok: false, error: "Invalid account id" });
    const viaBody = await request(app)
      .post("/api/telegram/groups/verify")
      .send({ groupId: "-100", accountId: "constructor" });
    expect(viaBody.status).toBe(400);
    const viaConfigure = await request(app)
      .post("/api/telegram/groups/-100/configure")
      .send({ accountId: "__proto__", userId: "1" });
    expect(viaConfigure.status).toBe(400);
    expect(({}).groups).toBeUndefined();
    expect(({}).groupPolicy).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "groups")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("field=accountId reason=invalid_shape"));
  });

  it("rejects malformed account ids (uppercase, spaces, slashes) but accepts slugs and the default", async () => {
    const { app } = createApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["Work", "a b", "a/b", "..", "a_b"]) {
      const res = await request(app).get(`/api/telegram/bot?accountId=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
    for (const good of ["work", "work-2", "default"]) {
      const res = await request(app).get(`/api/telegram/bot?accountId=${good}`);
      expect(res.status, good).not.toBe(400);
    }
  });
});
