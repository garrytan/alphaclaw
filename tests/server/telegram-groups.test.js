const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-telegram-groups-"));
process.env.ALPHACLAW_ROOT_DIR = tmpRoot;

const { OPENCLAW_DIR, kRootDir } = require("../../lib/server/constants");
const {
  createTelegramGroups,
  assertSafeGroups,
  buildOwnedKeys,
  readState,
  resolveStatePaths,
} = require("../../lib/server/telegram-groups");
const { kTelegramGroupErrors } = require("../../lib/server/telegram-groups-errors");
const { registerTelegramGroupRoutes } = require("../../lib/server/routes/telegram-groups");
const { syncConfigForTelegram } = require("../../lib/server/telegram-workspace");

// Garry's box, as of 2026-11-09: six approved groups, one silent, TEST CHAT
// blocked; owners 6167919517 and 8756803657; Harj and Sylvia trusted, Alfred's
// bot a guest, Mossab blocked.
const kGarry = "6167919517";
const kGarry2 = "8756803657";
const kHarj = "8793019333";
const kSylvia = "8771141478";
const kAlfredBot = "8460266606";
const kMossab = "435921418";
const kAlfredGroup = "-1004458560180";
const kSecurity = "-1003864658058";
const kGarrysAgents = "-1003972409126";
const kTestChat = "-5235086834";
const kHomeTeam = "-5297954291";

const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");

const boxConfig = (overrides = {}) => ({
  commands: { ownerAllowFrom: ["telegram:" + kGarry, "telegram:" + kGarry2] },
  channels: {
    telegram: {
      enabled: true,
      botToken: "123456:fake-token",
      dmPolicy: "allowlist",
      allowFrom: [kGarry, kGarry2],
      groupPolicy: "allowlist",
      groupAllowFrom: [kGarry, kGarry2, kHarj],
      groups: {
        "-1003883767414": { requireMention: false },
        "-1004452154104": { requireMention: false },
        [kSecurity]: { requireMention: false, groupPolicy: "open", allowFrom: [kGarry, kGarry2, "8773094438"] },
        "-1003762652083": { requireMention: false },
        [kHomeTeam]: { requireMention: false },
        [kAlfredGroup]: { requireMention: false, systemPrompt: "Be brief." },
        [kGarrysAgents]: { requireMention: false, topics: { 7: { systemPrompt: "agents" } } },
      },
      ...overrides,
    },
  },
});

const writeConfig = (config) => {
  fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.writeFileSync(kConfigPath, JSON.stringify(config, null, 2));
};
const readConfig = () => JSON.parse(fs.readFileSync(kConfigPath, "utf8"));
const groupEntry = (id) => readConfig().channels.telegram.groups[id];

const makeGroups = (overrides = {}) => {
  const telegramApi = { leaveChat: vi.fn(async () => true) };
  const validatePatch = vi.fn(async () => ({ ok: true, errors: [] }));
  const groups = createTelegramGroups({
    openclawDir: OPENCLAW_DIR,
    rootDir: kRootDir,
    telegramApi,
    validatePatch,
    sleep: async () => {},
    log: () => {},
    ...overrides,
  });
  return { groups, telegramApi, validatePatch };
};

const revisionOf = (groups, groupId) =>
  groups.list().groups.find((group) => group.groupId === groupId)?.revision || groups.plan({ groupId, body: { mode: "silent", convert: true } }).revision;

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code });
};

beforeEach(() => {
  fs.rmSync(path.join(kRootDir, "telegram"), { recursive: true, force: true });
  writeConfig(boxConfig());
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("telegram group rules: mapping onto OpenClaw's group entry", () => {
  it("Approved opens the group to members, gives the owners every tool and denies every tool to anyone else", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) });
    expect(groupEntry(kAlfredGroup)).toEqual({
      requireMention: false,
      systemPrompt: "Be brief.",
      enabled: true,
      groupPolicy: "open",
      toolsBySender: { ["id:" + kGarry]: {}, ["id:" + kGarry2]: {}, "*": { deny: ["*"] } },
    });
    expect(groups.list().groups.find((group) => group.groupId === kAlfredGroup).mode).toBe("approved");
  });

  it("a guest in an Approved group gets no tool at all, by OpenClaw's own resolver; the owner keeps every tool", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true, trusted: [{ id: kHarj, scope: "actions" }] }, ifMatch: revisionOf(groups, kAlfredGroup) });
    const { resolveChannelGroupToolsPolicy } = await import("openclaw/plugin-sdk/channel-policy");
    const cfg = readConfig();
    const policyFor = (senderId) => resolveChannelGroupToolsPolicy({ cfg, channel: "telegram", groupId: kAlfredGroup, senderId, messageProvider: "telegram" });
    expect(policyFor(kAlfredBot)).toEqual({ deny: ["*"] });
    expect(policyFor("7100000777")).toEqual({ deny: ["*"] });
    expect(policyFor(kGarry)).toEqual({});
    expect(policyFor(kHarj)).toEqual({});
  });

  it("Trusted people writes the owners into the group's allowFrom with the named people, and nobody else", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({
      groupId: kSecurity,
      body: { mode: "trusted", convert: true, trusted: [{ id: kHarj, scope: "actions", label: "Harj" }, { id: kSylvia }] },
      ifMatch: revisionOf(groups, kSecurity),
    });
    const entry = groupEntry(kSecurity);
    expect(entry.groupPolicy).toBe("allowlist");
    expect(entry.allowFrom).toEqual([kGarry, kGarry2, kSylvia, kHarj]);
    expect(entry.toolsBySender).toEqual({ ["id:" + kGarry]: {}, ["id:" + kGarry2]: {}, ["id:" + kHarj]: {}, ["id:" + kSylvia]: { deny: ["*"] }, "*": { deny: ["*"] } });
    expect(entry.allowFrom).not.toContain("8773094438");
  });

  it("Silent keeps the entry and the operator's keys, sets enabled:false and clears the other owned keys", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kSecurity, body: { mode: "silent", convert: true }, ifMatch: revisionOf(groups, kSecurity) });
    expect(groupEntry(kSecurity)).toEqual({ requireMention: false, enabled: false });
    expect(Object.keys(readConfig().channels.telegram.groups)).toContain(kSecurity);
  });

  it("every mode change clears all five owned keys before writing the new shape", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kSecurity, body: { mode: "trusted", convert: true, trusted: [{ id: kHarj }] }, ifMatch: revisionOf(groups, kSecurity) });
    await groups.setPolicy({ groupId: kSecurity, body: { mode: "approved" }, ifMatch: revisionOf(groups, kSecurity) });
    expect(groupEntry(kSecurity).allowFrom).toBeUndefined();
    expect(groupEntry(kSecurity).groupPolicy).toBe("open");
  });

  it("refuses a save when no owner id is known (owner_required)", async () => {
    const config = boxConfig({ allowFrom: [] });
    delete config.commands;
    writeConfig(config);
    const { groups } = makeGroups();
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "trusted", convert: true, trusted: [{ id: kHarj }] }, ifMatch: revisionOf(groups, kAlfredGroup) }), "owner_required");
    expect(groupEntry(kAlfredGroup)).toEqual({ requireMention: false, systemPrompt: "Be brief." });
  });

  it("reads the owners from the bot's DM allowFrom when commands.ownerAllowFrom is unset", async () => {
    const config = boxConfig();
    delete config.commands;
    writeConfig(config);
    const { groups } = makeGroups();
    expect(groups.list().owners).toEqual([kGarry, kGarry2]);
  });

  it("never lets a trusted list drop an owner: owners stay in allowFrom with every tool", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kSecurity, body: { mode: "trusted", convert: true, trusted: [{ id: kGarry, scope: "conversation" }] }, ifMatch: revisionOf(groups, kSecurity) });
    const entry = groupEntry(kSecurity);
    expect(entry.allowFrom).toEqual([kGarry, kGarry2]);
    expect(entry.toolsBySender["id:" + kGarry]).toEqual({});
  });

  it("refuses a write that would leave the groups map empty or the account policy not allowlist", () => {
    expect(() => assertSafeGroups({ groups: {}, accountPolicy: "allowlist" })).toThrow(expect.objectContaining({ code: "empty_groups" }));
    expect(() => assertSafeGroups({ groups: { "*": { requireMention: true } }, accountPolicy: "allowlist" })).toThrow(expect.objectContaining({ code: "empty_groups" }));
    expect(() => assertSafeGroups({ groups: { [kAlfredGroup]: {} }, accountPolicy: "open" })).toThrow(expect.objectContaining({ code: "account_policy" }));
    expect(() => assertSafeGroups({ groups: { [kAlfredGroup]: {} }, accountPolicy: "allowlist" })).not.toThrow();
  });

  it("refuses every mode while the account groupPolicy is not allowlist", async () => {
    writeConfig(boxConfig({ groupPolicy: "open" }));
    const { groups } = makeGroups();
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) }), "account_policy");
  });

  it("shows rules the page did not write as read-only Custom, and refuses to replace them without convert", async () => {
    const { groups } = makeGroups();
    const listed = groups.list().groups.find((group) => group.groupId === kSecurity);
    expect(listed).toMatchObject({ mode: "custom", readOnly: true });
    await expectCode(groups.setPolicy({ groupId: kSecurity, body: { mode: "approved" }, ifMatch: listed.revision }), "custom_config");
  });

  it("refuses to approve a group whose topics override its rules unless normalizeTopics is set, then strips the overrides", async () => {
    const config = boxConfig();
    config.channels.telegram.groups[kAlfredGroup].topics = { 3: { groupPolicy: "open", systemPrompt: "kept" } };
    writeConfig(config);
    const { groups } = makeGroups();
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) }), "topic_override");
    await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true, normalizeTopics: true }, ifMatch: revisionOf(groups, kAlfredGroup) });
    expect(groupEntry(kAlfredGroup).topics).toEqual({ 3: { systemPrompt: "kept" } });
  });

  it("refuses Approved while group replies go through an unrestricted message tool", async () => {
    writeConfig({ ...boxConfig(), messages: { groupChat: { visibleReplies: "message_tool" } } });
    const { groups } = makeGroups();
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) }), "message_tool_replies");
    writeConfig({ ...boxConfig(), messages: { groupChat: { visibleReplies: "message_tool" } }, tools: { message: { crossContext: { allowWithinProvider: false } } } });
    await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "approved", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) });
    expect(groupEntry(kAlfredGroup).groupPolicy).toBe("open");
  });

  it("needs the group's revision, refuses a stale one, and treats a repeat of a saved change as done", async () => {
    const { groups } = makeGroups();
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true } }), "revision_required");
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, ifMatch: "0000000000000000" }), "revision_mismatch");
    const first = await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, ifMatch: '"' + revisionOf(groups, kAlfredGroup) + '"' });
    expect(first.changed).toBe(true);
    const again = await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, ifMatch: "stale" });
    expect(again.changed).toBe(false);
  });

  it("validates the exact group entry with OpenClaw before saving, and saves nothing when it is rejected", async () => {
    const validatePatch = vi.fn(async () => ({ ok: false, errors: ["channels.telegram.groups.x: bad"] }));
    const { groups } = makeGroups({ validatePatch });
    await expectCode(groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, ifMatch: revisionOf(groups, kAlfredGroup) }), "config_invalid");
    expect(validatePatch).toHaveBeenCalledWith({
      patch: { channels: { telegram: { groups: { [kAlfredGroup]: { requireMention: false, systemPrompt: "Be brief.", enabled: false } } } } },
      replacePaths: ['channels.telegram.groups["' + kAlfredGroup + '"]'],
    });
    expect(groupEntry(kAlfredGroup).enabled).toBeUndefined();
  });

  it("previews without writing on dryRun", async () => {
    const { groups } = makeGroups();
    const result = await groups.setPolicy({ groupId: kAlfredGroup, body: { mode: "silent", convert: true }, dryRun: true });
    expect(result.preview).toEqual({ before: {}, after: { enabled: false }, topicsNormalized: false });
    expect(groupEntry(kAlfredGroup).enabled).toBeUndefined();
  });

  it("backs up the previous block before each save", async () => {
    const { groups } = makeGroups();
    const result = await groups.setPolicy({ groupId: kSecurity, body: { mode: "silent", convert: true }, ifMatch: revisionOf(groups, kSecurity) });
    const backup = JSON.parse(fs.readFileSync(path.join(resolveStatePaths(kRootDir).backupsDir, result.backup), "utf8"));
    expect(backup.entry).toEqual(boxConfig().channels.telegram.groups[kSecurity]);
  });

  it("Blocked writes the block list first, then the config, then leaves the group", async () => {
    const order = [];
    const telegramApi = {
      leaveChat: vi.fn(async () => {
        order.push(["leave", readState({ rootDir: kRootDir }).groups[kTestChat]?.mode, groupEntry(kTestChat)?.enabled]);
        return true;
      }),
    };
    const config = boxConfig();
    config.channels.telegram.groups[kTestChat] = { requireMention: false };
    writeConfig(config);
    const { groups } = makeGroups({ telegramApi });
    const result = await groups.setPolicy({ groupId: kTestChat, body: { mode: "blocked", convert: true }, ifMatch: revisionOf(groups, kTestChat) });
    expect(order).toEqual([["leave", "blocked", false]]);
    expect(result.leave).toEqual({ ok: true });
    expect(groupEntry(kTestChat)).toEqual({ requireMention: false, enabled: false });
  });

  it("keeps the block in force when the config write fails, and says the outcome is partial", async () => {
    const { setOpenclawConfigWriteGate } = require("../../lib/server/openclaw-config");
    const { groups, telegramApi } = makeGroups();
    const revision = revisionOf(groups, kTestChat);
    setOpenclawConfigWriteGate("an agent delete is in progress");
    try {
      await expect(groups.setPolicy({ groupId: kTestChat, body: { mode: "blocked" }, ifMatch: revision })).rejects.toMatchObject({ code: "config_busy", sideEffects: "partial" });
    } finally {
      setOpenclawConfigWriteGate(null);
    }
    expect(readState({ rootDir: kRootDir }).groups[kTestChat].pendingBlockAt).toEqual(expect.any(String));
    expect(telegramApi.leaveChat).not.toHaveBeenCalled();
    const retry = await groups.setPolicy({ groupId: kTestChat, body: { mode: "blocked" }, ifMatch: revision });
    expect(retry).toMatchObject({ changed: true, mode: "blocked", leave: { ok: true } });
    expect(readState({ rootDir: kRootDir }).groups[kTestChat].pendingBlockAt).toBeUndefined();
  });

  it("reports a failed leave as a partial outcome, and a retry leaves without writing again", async () => {
    const telegramApi = { leaveChat: vi.fn(async () => { throw new Error("Bad Gateway"); }) };
    const { groups } = makeGroups({ telegramApi });
    await expect(groups.setPolicy({ groupId: kTestChat, body: { mode: "blocked" }, ifMatch: revisionOf(groups, kTestChat) })).rejects.toMatchObject({ code: "leave_failed", sideEffects: "partial" });
    expect(telegramApi.leaveChat).toHaveBeenCalledTimes(3);
    expect(groupEntry(kTestChat)).toEqual({ enabled: false });
    telegramApi.leaveChat.mockImplementation(async () => true);
    const retry = await groups.setPolicy({ groupId: kTestChat, body: { mode: "blocked" }, ifMatch: "stale" });
    expect(retry).toMatchObject({ changed: false, leave: { ok: true } });
  });

  it("refuses to block an owner and keeps the block list sorted and deduplicated", () => {
    const { groups } = makeGroups();
    expect(() => groups.setBlockedSenders({ senders: [{ id: kGarry2 }] })).toThrow(expect.objectContaining({ code: "owner_protected" }));
    const result = groups.setBlockedSenders({ senders: [{ id: kMossab, label: "Mossab" }, { id: kMossab }] });
    expect(result.blockedSenders.map((entry) => entry.id)).toEqual([kMossab]);
    expect(readState({ rootDir: kRootDir })).toMatchObject({ owners: [kGarry, kGarry2], blockedSenders: [{ id: kMossab }] });
  });

  it("syncConfigForTelegram keeps the five keys this module owns", async () => {
    const { groups } = makeGroups();
    await groups.setPolicy({ groupId: kSecurity, body: { mode: "trusted", convert: true, trusted: [{ id: kHarj, scope: "actions" }] }, ifMatch: revisionOf(groups, kSecurity) });
    const before = groupEntry(kSecurity);
    const topicRegistry = { getGroup: () => ({ topics: {} }), getActiveTopicCount: () => 0, getTotalTopicCount: () => 0 };
    syncConfigForTelegram({ fs, openclawDir: OPENCLAW_DIR, topicRegistry, groupId: kSecurity, requireMention: false });
    const after = groupEntry(kSecurity);
    for (const key of ["enabled", "groupPolicy", "allowFrom", "tools", "toolsBySender"]) expect(after[key]).toEqual(before[key]);
    expect(groups.list().groups.find((group) => group.groupId === kSecurity).mode).toBe("trusted");
  });

  it("buildOwnedKeys gives the documented shape for every mode", () => {
    const owners = [kGarry];
    expect(buildOwnedKeys({ mode: "silent", owners, trusted: [] })).toEqual({ enabled: false });
    expect(buildOwnedKeys({ mode: "blocked", owners, trusted: [] })).toEqual({ enabled: false });
    expect(buildOwnedKeys({ mode: "approved", owners, trusted: [] }).toolsBySender["*"]).toEqual({ deny: ["*"] });
  });
});

describe("telegram group rules routes", () => {
  const createApp = ({ actor = null, groupsOverrides = {} } = {}) => {
    const app = express();
    app.use(express.json());
    if (actor) app.use((req, res, next) => ((req.alphaclawActor = actor), next()));
    const { groups, telegramApi } = makeGroups(groupsOverrides);
    registerTelegramGroupRoutes({ app, telegramGroups: groups, telegramApi });
    return { app, groups };
  };

  const expectProblem = (res, code) => {
    const entry = kTelegramGroupErrors[code];
    expect(res.status).toBe(entry.status);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ code, title: entry.title, fix: entry.fix, retry: entry.retry, status: entry.status });
    expect(["none", "partial", "complete"]).toContain(res.body.sideEffects);
    expect(res.body.type).toBe("https://github.com/garrytan/alphaclaw/blob/main/lib/setup/skills/alphaclaw-admin/telegram.md#" + code);
  };

  it("lists the groups with modes, owners and revisions", async () => {
    const { app } = createApp();
    const res = await request(app).get("/api/telegram/groups");
    expect(res.status).toBe(200);
    expect(res.body.owners).toEqual([kGarry, kGarry2]);
    expect(res.body.groups.map((group) => group.groupId)).toContain(kAlfredGroup);
    expect(res.body.groups.every((group) => /^[0-9a-f]{16}$/.test(group.revision))).toBe(true);
  });

  it("sets a policy with If-Match and returns the new revision as an ETag", async () => {
    const { app, groups } = createApp();
    const res = await request(app)
      .put("/api/telegram/groups/" + kAlfredGroup + "/policy")
      .set("If-Match", '"' + revisionOf(groups, kAlfredGroup) + '"')
      .send({ mode: "approved", convert: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: true, mode: "approved" });
    expect(res.headers.etag).toBe('"' + res.body.revision + '"');
  });

  it("answers every refusal with its status and an RFC 9457 body", async () => {
    const { app, groups } = createApp();
    expectProblem(await request(app).put("/api/telegram/groups/abc/policy").send({ mode: "silent" }), "invalid_group_id");
    expectProblem(await request(app).put("/api/telegram/groups/" + kAlfredGroup + "/policy").send({ mode: "loud" }), "invalid_input");
    const missing = await request(app).put("/api/telegram/groups/" + kAlfredGroup + "/policy").send({ mode: "silent", convert: true });
    expectProblem(missing, "revision_required");
    expect(missing.body.revision).toBe(revisionOf(groups, kAlfredGroup));
    expectProblem(await request(app).put("/api/telegram/groups/" + kAlfredGroup + "/policy").set("If-Match", "nope").send({ mode: "silent", convert: true }), "revision_mismatch");
    expectProblem(await request(app).put("/api/telegram/groups/" + kSecurity + "/policy").set("If-Match", revisionOf(groups, kSecurity)).send({ mode: "approved" }), "custom_config");
    expectProblem(await request(app).put("/api/telegram/blocked-senders").send({ senders: [{ id: kGarry }] }), "owner_protected");
    expectProblem(await request(app).put("/api/telegram/blocked-senders").send({ senders: "x" }), "invalid_input");
    expectProblem(await request(app).post("/api/telegram/groups/-12/test").send({}), "invalid_group_id");
  });

  it("answers owner_required with 422", async () => {
    const config = boxConfig({ allowFrom: [] });
    delete config.commands;
    writeConfig(config);
    const { app, groups } = createApp();
    expectProblem(await request(app).put("/api/telegram/groups/" + kAlfredGroup + "/policy").set("If-Match", revisionOf(groups, kAlfredGroup)).send({ mode: "approved", convert: true }), "owner_required");
  });

  it("answers a failed leave with 502 and sideEffects partial", async () => {
    const { app, groups } = createApp({ groupsOverrides: { telegramApi: { leaveChat: async () => { throw new Error("timeout"); } } } });
    const res = await request(app).put("/api/telegram/groups/" + kTestChat + "/policy").set("If-Match", revisionOf(groups, kTestChat)).send({ mode: "blocked" });
    expectProblem(res, "leave_failed");
    expect(res.body.sideEffects).toBe("partial");
  });

  it("refuses the agent actor on every route, reads included", async () => {
    const { app } = createApp({ actor: { type: "agent" } });
    expectProblem(await request(app).get("/api/telegram/groups"), "humans_only");
    expectProblem(await request(app).put("/api/telegram/groups/" + kAlfredGroup + "/policy").send({ mode: "silent" }), "humans_only");
    expectProblem(await request(app).post("/api/telegram/groups/" + kAlfredGroup + "/test").send({}), "humans_only");
    expectProblem(await request(app).put("/api/telegram/blocked-senders").send({ senders: [] }), "humans_only");
  });

  it("documents every error code under its own heading in the telegram reference", () => {
    const doc = fs.readFileSync(path.join(__dirname, "../../lib/setup/skills/alphaclaw-admin/telegram.md"), "utf8");
    for (const code of Object.keys(kTelegramGroupErrors)) expect(doc).toContain("\n### " + code + "\n");
  });
});
