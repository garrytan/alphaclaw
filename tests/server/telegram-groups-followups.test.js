const fs = require("fs");
const os = require("os");
const path = require("path");

const groupGuard = require("../../lib/plugin/group-guard");
const { createTelegramGroups, buildOwnedKeys, readState, resolveStatePaths } = require("../../lib/server/telegram-groups");
const { createTelegramJoinWatch } = require("../../lib/server/telegram-join-watch");
const { runGroupTest } = require("../../lib/server/telegram-group-test");
const { applyGroupGuardEntry } = require("../../lib/server/telegram-group-guard-entry");

// GST-1975 PR 2 follow-ups. Placeholder Telegram ids only.
const kOwner = "100000001";
const kOtherOwner = "100000002";
const kBlocked = "200000001";
const kGuest = "300000001";
const kGroup = "-1001111111111";
const kBlockedGroup = "-1002222222222";

const joinLine = (groupId, reason = "room-not-allowed") =>
  JSON.stringify({ 0: "channel room join introduction settled", 1: { channel: "telegram", accountId: "default", conversationId: groupId, kind: "skipped", reason }, time: "2026-11-09T07:00:00.000Z" });

const makeBox = ({ config, rules } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-followups-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const logDir = path.join(rootDir, "logs");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const cfg = config || {
    logging: { file: path.join(logDir, "openclaw.log") },
    commands: { ownerAllowFrom: ["telegram:" + kOwner] },
    channels: { telegram: { groupPolicy: "allowlist", allowFrom: [kOwner], groups: { [kGroup]: { requireMention: false } } } },
  };
  const configPath = path.join(openclawDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const statePath = resolveStatePaths(rootDir).statePath;
  if (rules !== undefined) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, typeof rules === "string" ? rules : JSON.stringify(rules));
  }
  const telegramApi = { leaveChat: vi.fn(async () => true) };
  const groups = createTelegramGroups({ openclawDir, rootDir, telegramApi, validatePatch: async () => ({ ok: true }), sleep: async () => {}, log: () => {} });
  return { rootDir, openclawDir, logDir, configPath, statePath, groups, telegramApi };
};

const touchLater = (file) => {
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
};

const registerPlugin = (rootDir, { config = null, runtimeConfig = null } = {}) => {
  const handlers = {};
  const lines = [];
  groupGuard.register({
    pluginConfig: { rootDir },
    config: config || {},
    ...(runtimeConfig ? { runtime: { config: { current: () => runtimeConfig } } } : {}),
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    on: (name, handler) => (handlers[name] = handler),
  });
  const dispatch = (senderId, { groupId = kGroup, dm = false } = {}) =>
    handlers.before_dispatch(
      dm
        ? { channel: "telegram", senderId, content: "hi" }
        : { channel: "telegram", senderId, isGroup: true, content: "hi", sessionKey: "agent:main:telegram:group:" + groupId },
      { channelId: "telegram", senderId, conversationId: dm ? senderId : groupId },
    );
  return { dispatch, lines };
};

let box;
afterEach(() => {
  if (box) fs.rmSync(box.rootDir, { recursive: true, force: true });
  box = null;
});

describe("group guard on a fresh gateway over a damaged rules file", () => {
  const ownerConfig = { commands: { ownerAllowFrom: ["telegram:" + kOwner] }, channels: { telegram: { allowFrom: [kOwner] } } };

  it("drops every non-owner Telegram turn and still serves the owner, in groups and DMs", () => {
    box = makeBox({ rules: "{ not json" });
    const { dispatch, lines } = registerPlugin(box.rootDir, { runtimeConfig: ownerConfig });
    expect(dispatch(kBlocked)).toEqual({ handled: true });
    expect(dispatch(kGuest)).toEqual({ handled: true });
    expect(dispatch(kBlocked, { dm: true })).toEqual({ handled: true });
    expect(dispatch(kOwner)).toBeUndefined();
    expect(dispatch(kOwner, { dm: true })).toBeUndefined();
    expect(lines.filter((line) => line.includes("cannot read the block list"))).toHaveLength(1);
  });

  it("reads the owners from the config the plugin was loaded with when no runtime config is offered", () => {
    box = makeBox({ rules: JSON.stringify(["not", "an", "object"]) });
    const { dispatch } = registerPlugin(box.rootDir, { config: { channels: { telegram: { accounts: { work: { allowFrom: [kOtherOwner] } } } } } });
    expect(dispatch(kOtherOwner)).toBeUndefined();
    expect(dispatch(kBlocked)).toEqual({ handled: true });
  });

  it("goes back to the saved rules once the file is fixed", () => {
    box = makeBox({ rules: "{ not json" });
    const { dispatch } = registerPlugin(box.rootDir, { runtimeConfig: ownerConfig });
    expect(dispatch(kGuest)).toEqual({ handled: true });
    fs.writeFileSync(box.statePath, JSON.stringify({ owners: [kOwner], blockedSenders: [{ id: kBlocked }], groups: {} }));
    touchLater(box.statePath);
    expect(dispatch(kGuest)).toBeUndefined();
    expect(dispatch(kBlocked)).toEqual({ handled: true });
  });

  it("keeps the last good rules when the file breaks after a good read", () => {
    box = makeBox({ rules: { owners: [kOwner], blockedSenders: [{ id: kBlocked }], groups: {} } });
    const { dispatch } = registerPlugin(box.rootDir, { runtimeConfig: ownerConfig });
    expect(dispatch(kGuest)).toBeUndefined();
    fs.writeFileSync(box.statePath, "{ broken");
    touchLater(box.statePath);
    expect(dispatch(kBlocked)).toEqual({ handled: true });
    expect(dispatch(kGuest)).toBeUndefined();
  });
});

describe("join watcher with an openclaw.json AlphaClaw cannot parse for a write", () => {
  it("still records a join, keeping the owners and block list as they are", () => {
    box = makeBox({ rules: { owners: [kOwner], groups: { [kBlockedGroup]: { mode: "blocked" } }, blockedSenders: [{ id: kBlocked }], seen: {} } });
    fs.writeFileSync(box.configPath, fs.readFileSync(box.configPath, "utf8").replace("{", "{\n  // OpenClaw accepts JSON5 comments"));
    expect(box.groups.noteSeen(kBlockedGroup, { lastJoinAt: "2026-11-09T07:00:00.000Z" })).toMatchObject({ lastJoinAt: "2026-11-09T07:00:00.000Z" });
    expect(readState({ rootDir: box.rootDir })).toMatchObject({ owners: [kOwner], blockedSenders: [{ id: kBlocked }], seen: { [kBlockedGroup]: { lastJoinAt: "2026-11-09T07:00:00.000Z" } } });
    expect(() => box.groups.syncOwners()).toThrow(expect.objectContaining({ code: "OPENCLAW_CONFIG_UNREADABLE" }));
  });

  it("keeps a join in its pending queue until it is recorded, so a failed record is retried", async () => {
    box = makeBox({ rules: { owners: [kOwner], groups: { [kBlockedGroup]: { mode: "blocked" } }, blockedSenders: [], seen: {} } });
    const logFile = path.join(box.logDir, "openclaw.log");
    let fail = true;
    const groups = {
      ...box.groups,
      noteSeen: (...args) => {
        if (fail) throw new Error("disk full");
        return box.groups.noteSeen(...args);
      },
    };
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups, log: () => {} });
    fs.writeFileSync(logFile, joinLine(kBlockedGroup) + "\n");
    await expect(watch.check()).rejects.toThrow("disk full");
    const pendingPath = path.join(path.dirname(box.statePath), "join-watch-pending.json");
    expect(JSON.parse(fs.readFileSync(pendingPath, "utf8")).map((join) => join.groupId)).toEqual([kBlockedGroup]);
    fail = false;
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "left" }]);
  });
});

describe("join watcher during a rules-file outage", () => {
  it("logs one failure per outage, keeps the joins it read past its read window, and handles them once the file is fixed", async () => {
    box = makeBox({ rules: "{ broken" });
    const logFile = path.join(box.logDir, "openclaw.log");
    const lines = [];
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups: box.groups, log: (line) => lines.push(line), notify: async () => ({ ok: true }), maxReadBytes: 4096 });
    fs.writeFileSync(logFile, joinLine(kBlockedGroup) + "\n");
    await watch.tick();
    await watch.tick();
    fs.appendFileSync(logFile, ("x".repeat(200) + "\n").repeat(100));
    await watch.tick();
    expect(lines.filter((line) => line.includes("join watch failed")).map((line) => line.split(": ")[1])).toEqual(["joins", "owners"]);
    fs.writeFileSync(box.statePath, JSON.stringify({ owners: [kOwner], groups: { [kBlockedGroup]: { mode: "blocked" } }, blockedSenders: [], seen: {} }));
    expect((await watch.tick()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "left" }]);
    expect(lines.filter((line) => line.includes("join watch recovered"))).toEqual(["[alphaclaw] telegram join watch recovered: joins", "[alphaclaw] telegram join watch recovered: owners"]);
    expect((await watch.tick()).outcomes || []).toEqual([]);
  });

  it("retries a failed leave on the next checks and gives up after three", async () => {
    box = makeBox({ rules: { owners: [kOwner], groups: { [kBlockedGroup]: { mode: "blocked" } }, blockedSenders: [], seen: {} } });
    const logFile = path.join(box.logDir, "openclaw.log");
    const lines = [];
    let leaves = 0;
    const groups = { ...box.groups, leaveGroup: async () => ({ ok: ++leaves > 1 && leaves !== 2 ? leaves === 5 : false, error: "forbidden" }) };
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups, log: (line) => lines.push(line) });
    fs.writeFileSync(logFile, joinLine(kBlockedGroup) + "\n");
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "leave_failed" }]);
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "leave_failed" }]);
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "leave_failed" }]);
    expect(lines.some((line) => line.includes("group=" + kBlockedGroup + " leave_failed after 3 checks; giving up"))).toBe(true);
    expect(await watch.check()).toEqual({ joins: 0 });
    fs.appendFileSync(logFile, joinLine(kBlockedGroup) + "\n");
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "leave_failed" }]);
    expect((await watch.check()).outcomes).toEqual([{ groupId: kBlockedGroup, action: "left" }]);
    expect(await watch.check()).toEqual({ joins: 0 });
  });

  it("retries a notice that failed to send on the next check", async () => {
    box = makeBox({ rules: { owners: [kOwner], groups: {}, blockedSenders: [], seen: {} } });
    const logFile = path.join(box.logDir, "openclaw.log");
    const notify = vi.fn(async () => ({ ok: notify.mock.calls.length > 1 }));
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups: box.groups, notify, log: () => {} });
    fs.writeFileSync(logFile, joinLine("-1003333333333") + "\n");
    expect((await watch.check()).outcomes).toEqual([{ groupId: "-1003333333333", action: "notify_failed" }]);
    expect((await watch.check()).outcomes).toEqual([{ groupId: "-1003333333333", action: "notified" }]);
    expect(await watch.check()).toEqual({ joins: 0 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("logs a join failure and an owner failure each once when it starts and once when it clears", async () => {
    box = makeBox({ rules: "{ broken" });
    const logFile = path.join(box.logDir, "openclaw.log");
    const lines = [];
    let ownersFail = true;
    const groups = {
      ...box.groups,
      syncOwners: () => {
        if (ownersFail) throw new Error("owners down");
        return false;
      },
    };
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups, log: (line) => lines.push(line), notify: async () => ({ ok: true }) });
    await watch.tick();
    fs.writeFileSync(logFile, joinLine(kBlockedGroup) + "\n");
    await watch.tick();
    await watch.tick();
    fs.writeFileSync(box.statePath, JSON.stringify({ owners: [kOwner], groups: { [kBlockedGroup]: { mode: "blocked" } }, blockedSenders: [], seen: {} }));
    await watch.tick();
    ownersFail = false;
    await watch.tick();
    await watch.tick();
    expect(lines.filter((line) => line.includes("join watch failed") || line.includes("join watch recovered"))).toEqual([
      "[alphaclaw] telegram join watch failed: owners: owners down",
      expect.stringMatching(/^\[alphaclaw\] telegram join watch failed: joins: /),
      "[alphaclaw] telegram join watch recovered: joins",
      "[alphaclaw] telegram join watch recovered: owners",
    ]);
  });

  it("keeps one pending join per group and at most the newest 500", async () => {
    box = makeBox({ rules: "{ broken" });
    const logFile = path.join(box.logDir, "openclaw.log");
    const lines = [];
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups: box.groups, log: (line) => lines.push(line) });
    const ids = Array.from({ length: 501 }, (_, index) => "-100" + String(3000000000 + index));
    fs.writeFileSync(logFile, [...ids, ids[0]].map((id) => joinLine(id)).join("\n") + "\n");
    await watch.tick();
    const pending = JSON.parse(fs.readFileSync(path.join(path.dirname(box.statePath), "join-watch-pending.json"), "utf8")).map((join) => join.groupId);
    expect(pending).toHaveLength(500);
    expect(new Set(pending).size).toBe(500);
    expect(pending).not.toContain(ids[1]);
    expect(pending[pending.length - 1]).toBe(ids[0]);
    expect(lines).toContain("[alphaclaw] telegram join watch: dropped 1 old pending joins");
  });
});

describe("owners on a multi-account box", () => {
  const multiAccount = () => ({
    channels: {
      telegram: {
        groupPolicy: "allowlist",
        accounts: {
          default: { groupPolicy: "allowlist", allowFrom: [kOwner], groups: { [kGroup]: {} } },
          work: { groupPolicy: "allowlist", allowFrom: [kOtherOwner], groups: { [kBlockedGroup]: {} } },
        },
      },
    },
  });

  it("never blocks the owner of another account", () => {
    box = makeBox({ config: multiAccount() });
    expect(() => box.groups.setBlockedSenders({ senders: [{ id: kOtherOwner }] })).toThrow(expect.objectContaining({ code: "owner_protected" }));
    box.groups.setBlockedSenders({ senders: [{ id: kBlocked }] });
    expect(readState({ rootDir: box.rootDir }).owners).toEqual([kOwner, kOtherOwner]);
    const { dispatch } = registerPlugin(box.rootDir);
    expect(dispatch(kOtherOwner)).toBeUndefined();
    expect(dispatch(kBlocked)).toEqual({ handled: true });
  });

  it("takes another account's owner off a block list saved before they were known", () => {
    box = makeBox({ config: multiAccount(), rules: { owners: [kOwner], groups: {}, blockedSenders: [{ id: kOtherOwner }, { id: kBlocked }], seen: {} } });
    expect(box.groups.syncOwners()).toBe(true);
    expect(readState({ rootDir: box.rootDir }).blockedSenders.map((entry) => entry.id)).toEqual([kBlocked]);
  });
});

describe("block list input checks", () => {
  it("answers a malformed id with invalid_input even while no owner id is known", () => {
    box = makeBox({ config: { channels: { telegram: { groupPolicy: "allowlist", groups: { [kGroup]: {} } } } } });
    expect(() => box.groups.setBlockedSenders({ senders: [{ id: "abc" }] })).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => box.groups.setBlockedSenders({ senders: [{ id: kBlocked }] })).toThrow(expect.objectContaining({ code: "owner_required" }));
  });
});

describe("test this group agrees with the guard plugin", () => {
  const withGuard = (cfg) => {
    applyGroupGuardEntry(cfg, { rootDir: "/root", log: () => {} });
    return cfg;
  };
  const approvedCfg = (ownerAllowFrom) => ({
    commands: { ownerAllowFrom },
    channels: { telegram: { groupPolicy: "allowlist", allowFrom: [kOwner], groups: { [kGroup]: { requireMention: false, ...buildOwnedKeys({ mode: "approved", owners: [kOwner], trusted: [] }) } } } },
  });
  const state = () => ({ owners: [kOwner], groups: { [kGroup]: { mode: "approved" } }, blockedSenders: [{ id: kBlocked }], seen: {} });

  it("decides the owner exemption from the owners the plugin trusts", async () => {
    const result = await runGroupTest({ cfg: withGuard(approvedCfg([kOwner, kBlocked])), state: state(), groupId: kGroup });
    expect(result.senders.find((sender) => sender.id === kBlocked)).toMatchObject({ reply: "never", reason: "blocked_sender" });
  });

  it("says a block is not enforced when the group guard entry is missing or not AlphaClaw's", async () => {
    const missing = await runGroupTest({ cfg: approvedCfg([kOwner]), state: state(), groupId: kGroup });
    expect(missing.groupGuard).toEqual({ enforced: false, reason: "missing" });
    const blocked = missing.senders.find((sender) => sender.id === kBlocked);
    expect(blocked.reply).toBe("always");
    expect(blocked.layers.find((layer) => layer.layer === "alphaclaw.group-guard")).toMatchObject({ allowed: true, enforced: false, reason: "guard_not_enforced" });
    const foreignCfg = approvedCfg([kOwner]);
    foreignCfg.plugins = { entries: { "group-guard": { enabled: true, config: {} } } };
    expect((await runGroupTest({ cfg: foreignCfg, state: state(), groupId: kGroup })).groupGuard).toEqual({ enforced: false, reason: "foreign" });
    const enforced = await runGroupTest({ cfg: withGuard(approvedCfg([kOwner])), state: state(), groupId: kGroup });
    expect(enforced.groupGuard).toEqual({ enforced: true, reason: null });
    expect(enforced.senders.find((sender) => sender.id === kBlocked)).toMatchObject({ reply: "never", reason: "blocked_sender" });
  });

  it("compares plugin ids in plugins.allow and plugins.deny trimmed and lowercased, as OpenClaw does", async () => {
    const allowed = withGuard(approvedCfg([kOwner]));
    allowed.plugins.allow = [" Group-Guard ", "telegram"];
    expect((await runGroupTest({ cfg: allowed, state: state(), groupId: kGroup })).groupGuard).toEqual({ enforced: true, reason: null });
    const denied = withGuard(approvedCfg([kOwner]));
    denied.plugins.deny = ["GROUP-GUARD"];
    expect((await runGroupTest({ cfg: denied, state: state(), groupId: kGroup })).groupGuard).toEqual({ enforced: false, reason: "disabled" });
  });

  it("reads an empty plugins.allow as no allowlist, as OpenClaw does", async () => {
    const cfg = withGuard(approvedCfg([kOwner]));
    cfg.plugins.allow = [];
    const result = await runGroupTest({ cfg, state: state(), groupId: kGroup });
    expect(result.groupGuard).toEqual({ enforced: true, reason: null });
    expect(result.senders.find((sender) => sender.id === kBlocked)).toMatchObject({ reply: "never", reason: "blocked_sender" });
  });

  it.each([
    ["plugins are switched off", (plugins) => (plugins.enabled = false)],
    ["the entry is switched off", (plugins) => (plugins.entries["group-guard"].enabled = false)],
    ["its conversation hook is off", (plugins) => (plugins.entries["group-guard"].hooks.allowConversationAccess = false)],
    ["the allowlist leaves it out", (plugins) => (plugins.allow = ["telegram"])],
    ["the denylist names it", (plugins) => (plugins.deny = ["group-guard"])],
    ["no load path names it", (plugins) => (plugins.load.paths = [])],
  ])("says the guard is disabled when %s", async (_label, switchOff) => {
    const cfg = withGuard(approvedCfg([kOwner]));
    switchOff(cfg.plugins);
    expect((await runGroupTest({ cfg, state: state(), groupId: kGroup })).groupGuard).toEqual({ enforced: false, reason: "disabled" });
  });
});

describe("owner changes reach the guard plugin", () => {
  it("syncs the owners on the join watcher's next check, with no rules write", async () => {
    box = makeBox({ rules: { owners: [kOwner], groups: {}, blockedSenders: [{ id: kBlocked }], seen: {} } });
    const watch = createTelegramJoinWatch({ openclawDir: box.openclawDir, rootDir: box.rootDir, groups: box.groups, log: () => {} });
    const cfg = JSON.parse(fs.readFileSync(box.configPath, "utf8"));
    cfg.commands.ownerAllowFrom.push("telegram:" + kOtherOwner);
    fs.writeFileSync(box.configPath, JSON.stringify(cfg));
    await watch.tick();
    expect(readState({ rootDir: box.rootDir }).owners).toEqual([kOwner, kOtherOwner]);
  });
});

describe("the admin skill's Telegram reference", () => {
  const reference = fs.readFileSync(path.join(__dirname, "../../lib/setup/skills/alphaclaw-admin/telegram.md"), "utf8");

  it("says only adding to the block list needs an owner id", () => {
    expect(reference).not.toContain("nobody can be blocked while no owner id is known");
    expect(reference).toContain("Adding someone to the block list needs a known owner id; shrinking or clearing the list does not.");
    expect(fs.readFileSync(path.join(__dirname, "../../CHANGELOG.md"), "utf8")).not.toContain("nobody can be blocked until AlphaClaw knows your Telegram id");
  });

  it("documents that becoming an owner ends a block for good, and the context limit", () => {
    expect(reference).toContain("Becoming an owner ends a block for good");
    expect(reference).toContain("Known limit: a blocked person's messages as context.");
  });
});

describe("anonymous admins in Trusted mode", () => {
  it("warns that anonymous admins are not heard in a Trusted group, in the preview and the list", async () => {
    box = makeBox();
    const body = { mode: "trusted", trusted: [{ id: kGuest, scope: "conversation" }], convert: true };
    const preview = await box.groups.setPolicy({ groupId: kGroup, body, dryRun: true });
    expect(preview.warnings.map((warning) => warning.code)).toEqual(["anonymous_admins"]);
    const revision = box.groups.list().groups.find((group) => group.groupId === kGroup).revision;
    await box.groups.setPolicy({ groupId: kGroup, body, ifMatch: revision });
    const listed = box.groups.list();
    expect(listed.groups.find((group) => group.groupId === kGroup).warnings.map((warning) => warning.code)).toEqual(["anonymous_admins"]);
    expect(listed.groupGuard).toEqual({ enforced: false, reason: "missing" });
  });

  it("gives Approved no warning", async () => {
    box = makeBox();
    const preview = await box.groups.setPolicy({ groupId: kGroup, body: { mode: "approved", convert: true }, dryRun: true });
    expect(preview.warnings).toEqual([]);
  });
});
