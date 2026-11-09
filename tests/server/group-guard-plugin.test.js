const fs = require("fs");
const os = require("os");
const path = require("path");

const groupGuard = require("../../lib/plugin/group-guard");
const { applyGroupGuardEntry, kGroupGuardPluginPath } = require("../../lib/server/telegram-group-guard-entry");

const kGarry = "6167919517";
const kMossab = "435921418";
const kAlfredGroup = "-1004458560180";
const kTestChat = "-5235086834";

const makeRoot = (rules) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "group-guard-"));
  if (rules) {
    fs.mkdirSync(path.join(rootDir, "telegram"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "telegram", "group-rules.json"), JSON.stringify(rules));
  }
  return rootDir;
};

const register = (rootDir, pluginConfig = {}) => {
  const handlers = {};
  const lines = [];
  groupGuard.register({
    pluginConfig: { rootDir, ...pluginConfig },
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });
  return { dispatch: (event, ctx) => handlers.before_dispatch(event, ctx), handlers, lines };
};

const kRules = {
  owners: [kGarry],
  blockedSenders: [{ id: kMossab, label: "Mossab" }, { id: kGarry }],
  groups: { [kTestChat]: { mode: "blocked" }, [kAlfredGroup]: { mode: "approved" } },
};

const groupTurn = (senderId, groupId, thread = "") => [
  { channel: "telegram", senderId, isGroup: true, content: "hi", sessionKey: "agent:main:telegram:group:" + groupId + thread },
  { channelId: "telegram", senderId, conversationId: groupId + thread },
];

describe("group guard plugin", () => {
  let rootDir;
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it("registers only a before_dispatch hook", () => {
    rootDir = makeRoot(kRules);
    expect(Object.keys(register(rootDir).handlers)).toEqual(["before_dispatch"]);
  });

  it("drops a blocked sender with handled:true and no reply text, in a group and in a DM", () => {
    rootDir = makeRoot(kRules);
    const { dispatch, lines } = register(rootDir);
    expect(dispatch(...groupTurn(kMossab, kAlfredGroup))).toEqual({ handled: true });
    expect(dispatch({ channel: "telegram", senderId: kMossab, content: "hi" }, { channelId: "telegram", senderId: kMossab, conversationId: kMossab })).toEqual({ handled: true });
    expect(lines.filter((line) => line.includes("dropped"))).toEqual(["[group-guard] dropped a turn reason=blocked_sender sender=" + kMossab]);
  });

  it("drops every turn in a blocked group, under its basic and supergroup ids and in any topic", () => {
    rootDir = makeRoot(kRules);
    const { dispatch } = register(rootDir);
    expect(dispatch(...groupTurn("7100000777", kTestChat))).toEqual({ handled: true });
    expect(dispatch(...groupTurn("7100000777", "-1005235086834"))).toEqual({ handled: true });
    expect(dispatch(...groupTurn("7100000777", kTestChat, ":topic:12"))).toEqual({ handled: true });
  });

  it("drops a group whose block is still being saved", () => {
    rootDir = makeRoot({ groups: { [kAlfredGroup]: { mode: "approved", pendingBlockAt: "2026-11-09T08:00:00.000Z" } } });
    expect(register(rootDir).dispatch(...groupTurn("7100000777", kAlfredGroup))).toEqual({ handled: true });
  });

  it("never drops an owner, even one on the block list or in a blocked group", () => {
    rootDir = makeRoot(kRules);
    const { dispatch } = register(rootDir);
    expect(dispatch(...groupTurn(kGarry, kAlfredGroup))).toBeUndefined();
    expect(dispatch(...groupTurn(kGarry, kTestChat))).toBeUndefined();
    const configOwner = register(makeRoot({ blockedSenders: [{ id: "111111" }] }), { ownerIds: ["111111"] });
    expect(configOwner.dispatch(...groupTurn("111111", kAlfredGroup))).toBeUndefined();
  });

  it("lets everyone else through, and ignores other channels", () => {
    rootDir = makeRoot(kRules);
    const { dispatch } = register(rootDir);
    expect(dispatch(...groupTurn("8460266606", kAlfredGroup))).toBeUndefined();
    expect(dispatch({ channel: "discord", senderId: kMossab }, { channelId: "discord", senderId: kMossab })).toBeUndefined();
  });

  it("picks up a new block list without a restart, and blocks nobody when the file is missing or unreadable", () => {
    rootDir = makeRoot(null);
    const { dispatch, lines } = register(rootDir);
    expect(dispatch(...groupTurn(kMossab, kAlfredGroup))).toBeUndefined();
    fs.mkdirSync(path.join(rootDir, "telegram"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "telegram", "group-rules.json"), JSON.stringify(kRules));
    expect(dispatch(...groupTurn(kMossab, kAlfredGroup))).toEqual({ handled: true });
    fs.writeFileSync(path.join(rootDir, "telegram", "group-rules.json"), "{not json");
    expect(dispatch(...groupTurn(kMossab, kAlfredGroup))).toBeUndefined();
    expect(lines.some((line) => line.includes("cannot read the block list"))).toBe(true);
  });
});

describe("group guard plugin entry", () => {
  const telegramCfg = () => ({ commands: { ownerAllowFrom: ["telegram:" + kGarry] }, channels: { telegram: { enabled: true, groupPolicy: "allowlist" } } });

  it("adds the plugin with conversation access on a box with Telegram, and is a no-op the second time", () => {
    const cfg = telegramCfg();
    expect(applyGroupGuardEntry(cfg, { rootDir: "/data", log: () => {} }).changed).toBe(true);
    expect(cfg.plugins.allow).toContain("group-guard");
    expect(cfg.plugins.load.paths).toContain(kGroupGuardPluginPath);
    expect(cfg.plugins.entries["group-guard"]).toEqual({
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: { _alphaclawManaged: "telegram-groups", rootDir: "/data", ownerIds: [kGarry] },
    });
    expect(applyGroupGuardEntry(cfg, { rootDir: "/data", log: () => {} }).changed).toBe(false);
  });

  it("leaves a box without Telegram and an entry someone else owns alone", () => {
    const bare = {};
    expect(applyGroupGuardEntry(bare, { rootDir: "/data", log: () => {} })).toEqual({ changed: false, conflict: false });
    expect(bare.plugins).toBeUndefined();
    const foreign = { ...telegramCfg(), plugins: { entries: { "group-guard": { enabled: true, config: {} } } } };
    expect(applyGroupGuardEntry(foreign, { rootDir: "/data", log: () => {} })).toEqual({ changed: false, conflict: true });
  });

  it("replaces a load path left by another install location", () => {
    const cfg = { ...telegramCfg(), plugins: { load: { paths: ["/old/node_modules/alphaclaw/lib/plugin/group-guard"] } } };
    applyGroupGuardEntry(cfg, { rootDir: "/data", log: () => {} });
    expect(cfg.plugins.load.paths).toEqual([kGroupGuardPluginPath]);
  });
});
