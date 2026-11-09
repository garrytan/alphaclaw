const fs = require("fs");
const os = require("os");
const path = require("path");

const { createTelegramGroups } = require("../../lib/server/telegram-groups");
const { createTelegramJoinWatch, parseJoinLine, resolveLogFiles } = require("../../lib/server/telegram-join-watch");

const kTestChat = "-5235086834";
const kNewGroup = "-1009876543210";
const kApproved = "-1003883767414";

const joinLine = (groupId, reason = "room-not-allowed") =>
  JSON.stringify({ 0: "channel room join introduction settled", 1: { channel: "telegram", accountId: "default", conversationId: groupId, kind: "skipped", reason }, time: "2026-11-09T07:00:00.000Z" });
const otherLine = JSON.stringify({ 0: "gateway ready", time: "2026-11-09T07:00:00.000Z" });

const setup = ({ logging = "openclaw-YYYY-MM-DD.log" } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "join-watch-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const logDir = path.join(rootDir, "logs", "openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({
    logging: { file: path.join(logDir, logging) },
    commands: { ownerAllowFrom: ["6167919517"] },
    channels: { telegram: { groupPolicy: "allowlist", groups: { [kApproved]: { requireMention: false } } } },
  }));
  const telegramApi = { leaveChat: vi.fn(async () => true) };
  const groups = createTelegramGroups({ openclawDir, rootDir, telegramApi, validatePatch: async () => ({ ok: true }), sleep: async () => {}, log: () => {} });
  const notify = vi.fn(async () => ({ ok: true }));
  const watch = createTelegramJoinWatch({ openclawDir, rootDir, groups, notify, log: () => {} });
  return { rootDir, logDir, groups, notify, watch, telegramApi };
};

describe("telegram join watch", () => {
  let ctx;
  afterEach(() => fs.rmSync(ctx.rootDir, { recursive: true, force: true }));

  it("parses OpenClaw's join line and ignores everything else", () => {
    ctx = setup();
    expect(parseJoinLine(joinLine(kNewGroup))).toEqual({ groupId: kNewGroup, reason: "room-not-allowed", at: "2026-11-09T07:00:00.000Z" });
    expect(parseJoinLine(otherLine)).toBeNull();
    expect(parseJoinLine(joinLine(kNewGroup).replace('"telegram"', '"discord"'))).toBeNull();
  });

  it("records a new group and tells the owner once, however often the bot is added", async () => {
    ctx = setup();
    const file = path.join(ctx.logDir, "openclaw-2026-11-09.log");
    fs.writeFileSync(file, otherLine + "\n" + joinLine(kNewGroup) + "\n");
    expect((await ctx.watch.check()).outcomes).toEqual([{ groupId: kNewGroup, action: "notified" }]);
    fs.appendFileSync(file, joinLine(kNewGroup) + "\n");
    expect((await ctx.watch.check()).outcomes).toEqual([{ groupId: kNewGroup, action: "recorded" }]);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.notify.mock.calls[0][0]).toContain(kNewGroup);
    expect(ctx.notify.mock.calls[0][1]).toEqual({ eventType: "telegram_group_join", id: "telegram-group-join-" + kNewGroup });
    expect(ctx.groups.list().groups.find((group) => group.groupId === kNewGroup)).toMatchObject({ mode: "waiting", inConfig: false });
  });

  it("does not notify for a group that already has a rule", async () => {
    ctx = setup();
    fs.writeFileSync(path.join(ctx.logDir, "openclaw-2026-11-09.log"), joinLine(kApproved, "already-introduced") + "\n");
    expect((await ctx.watch.check()).outcomes).toEqual([{ groupId: kApproved, action: "recorded" }]);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("leaves a blocked group again each time it is re-added", async () => {
    ctx = setup();
    const state = ctx.groups.readState();
    state.groups[kTestChat] = { mode: "blocked" };
    fs.mkdirSync(path.join(ctx.rootDir, "telegram"), { recursive: true });
    fs.writeFileSync(path.join(ctx.rootDir, "telegram", "group-rules.json"), JSON.stringify(state));
    const file = path.join(ctx.logDir, "openclaw-2026-11-09.log");
    fs.writeFileSync(file, joinLine(kTestChat) + "\n");
    expect((await ctx.watch.check()).outcomes).toEqual([{ groupId: kTestChat, action: "left" }]);
    fs.appendFileSync(file, joinLine(kTestChat) + "\n");
    await ctx.watch.check();
    expect(ctx.telegramApi.leaveChat).toHaveBeenCalledTimes(2);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it("follows a size rotation: lines in the rotated file are read once, the new file from its start", async () => {
    ctx = setup({ logging: "gateway.log" });
    const file = path.join(ctx.logDir, "gateway.log");
    fs.writeFileSync(file, joinLine("-1001111111111") + "\n");
    expect((await ctx.watch.check()).joins).toBe(1);
    fs.appendFileSync(file, joinLine("-1002222222222") + "\n");
    fs.renameSync(file, path.join(ctx.logDir, "gateway.1.log"));
    fs.writeFileSync(file, joinLine("-1003333333333") + "\n");
    const second = await ctx.watch.check();
    expect(second.outcomes.map((outcome) => outcome.groupId).sort()).toEqual(["-1002222222222", "-1003333333333"]);
    expect((await ctx.watch.check()).joins).toBe(0);
    expect(ctx.notify).toHaveBeenCalledTimes(3);
  });

  it("reads a dated log's size-rotated siblings, and nothing older than two days", () => {
    ctx = setup();
    for (const name of ["openclaw-2026-11-09.log", "openclaw-2026-11-09.1.log", "openclaw-2026-11-01.log", "other.log"]) fs.writeFileSync(path.join(ctx.logDir, name), "x\n");
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(ctx.logDir, "openclaw-2026-11-01.log"), old, old);
    const names = resolveLogFiles({ logFile: path.join(ctx.logDir, "openclaw-YYYY-MM-DD.log") }).map(({ file }) => path.basename(file)).sort();
    expect(names).toEqual(["openclaw-2026-11-09.1.log", "openclaw-2026-11-09.log"]);
  });

  it("keeps an unfinished last line for the next read", async () => {
    ctx = setup();
    const file = path.join(ctx.logDir, "openclaw-2026-11-09.log");
    const line = joinLine(kNewGroup);
    fs.writeFileSync(file, line.slice(0, 40));
    expect((await ctx.watch.check()).joins).toBe(0);
    fs.appendFileSync(file, line.slice(40) + "\n");
    expect((await ctx.watch.check()).joins).toBe(1);
  });
});
