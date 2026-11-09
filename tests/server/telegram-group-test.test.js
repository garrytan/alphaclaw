const { runGroupTest } = require("../../lib/server/telegram-group-test");
const { buildOwnedKeys } = require("../../lib/server/telegram-groups");
const { applyGroupGuardEntry } = require("../../lib/server/telegram-group-guard-entry");

const kGarry = "6167919517";
const kGarry2 = "8756803657";
const kHarj = "8793019333";
const kSylvia = "8771141478";
const kAlfredBot = "8460266606";
const kMossab = "435921418";
const kAlfredGroup = "-1004458560180";
const kSecurity = "-1003864658058";

const cfgWith = (groups, extra = {}) => {
  const cfg = {
    commands: { ownerAllowFrom: ["telegram:" + kGarry, "telegram:" + kGarry2] },
    channels: { telegram: { groupPolicy: "allowlist", allowFrom: [kGarry, kGarry2], groupAllowFrom: [kGarry, kGarry2], groups } },
    ...extra,
  };
  applyGroupGuardEntry(cfg, { rootDir: "/data/.alphaclaw", log: () => {} });
  return cfg;
};
const stateWith = (groups = {}, blockedSenders = []) => ({ owners: [kGarry, kGarry2], groups, blockedSenders, seen: {} });
const bySender = (result) => Object.fromEntries(result.senders.map((sender) => [sender.id ?? "anyone", sender]));

describe("test this group", () => {
  it("Approved: the owner replies with every tool, a guest bot and anyone else reply with no tool, a blocked person is silent", async () => {
    const owners = [kGarry, kGarry2];
    const entry = { requireMention: false, ...buildOwnedKeys({ mode: "approved", owners, trusted: [] }) };
    const result = await runGroupTest({
      cfg: cfgWith({ [kAlfredGroup]: entry }, { plugins: { entries: { "wm-guards": { enabled: true } } } }),
      state: stateWith({ [kAlfredGroup]: { mode: "approved", trusted: [] } }, [{ id: kMossab, label: "Mossab" }]),
      groupId: kAlfredGroup,
      senderIds: [kAlfredBot],
    });
    const senders = bySender(result);
    expect(senders[kGarry]).toMatchObject({ reply: "always", actions: "all", roles: ["owner", "tools_by_sender", "account_group_allow_from"] });
    expect(senders[kAlfredBot]).toMatchObject({ reply: "always", actions: "none", roles: ["asked"] });
    expect(senders.anyone).toMatchObject({ reply: "always", actions: "none", label: "Anyone else" });
    expect(senders[kMossab]).toMatchObject({ reply: "never", reason: "blocked_sender" });
    expect(result.notModelled).toEqual(["wm-guards"]);
    expect(senders[kGarry].layers.at(-1)).toEqual({ layer: "box.plugins", source: "not modelled", plugins: ["wm-guards"] });
    expect(senders[kGarry].layers.find((layer) => layer.layer === "openclaw.tools").source).toBe("resolveChannelGroupToolsPolicy");
  });

  it("Trusted people: the owner and the trusted person are heard, everyone else is silent at ingress", async () => {
    const owners = [kGarry, kGarry2];
    const trusted = [{ id: kHarj, scope: "actions" }];
    const result = await runGroupTest({
      cfg: cfgWith({ [kSecurity]: { requireMention: false, ...buildOwnedKeys({ mode: "trusted", owners, trusted }) } }),
      state: stateWith({ [kSecurity]: { mode: "trusted", trusted } }),
      groupId: kSecurity,
      senderIds: [kSylvia],
    });
    const senders = bySender(result);
    expect(senders[kGarry]).toMatchObject({ reply: "always", actions: "all" });
    expect(senders[kHarj]).toMatchObject({ reply: "always", actions: "all" });
    expect(senders[kSylvia]).toMatchObject({ reply: "never", reason: "group-override-unauthorized" });
    expect(senders.anyone).toMatchObject({ reply: "never", reason: "group-override-unauthorized" });
  });

  it("Silent and an unlisted group are silent for everyone, the owner included", async () => {
    const silent = await runGroupTest({ cfg: cfgWith({ [kSecurity]: { enabled: false } }), state: stateWith({ [kSecurity]: { mode: "silent" } }), groupId: kSecurity });
    expect(bySender(silent)[kGarry]).toMatchObject({ reply: "never", reason: "group-disabled" });
    const unlisted = await runGroupTest({ cfg: cfgWith({ [kSecurity]: { enabled: false } }), state: stateWith(), groupId: "-1009876543210" });
    expect(bySender(unlisted)[kGarry]).toMatchObject({ reply: "never", reason: "group-chat-not-allowed" });
  });

  it("applies a group's rule only to its exact chat id: the other id form (-N / -100N) is unlisted", async () => {
    const approved = buildOwnedKeys({ mode: "approved", owners: [kGarry, kGarry2], trusted: [] });
    const superRule = await runGroupTest({ cfg: cfgWith({ "-1005297954291": approved }), state: stateWith({ "-1005297954291": { mode: "approved" } }), groupId: "-5297954291" });
    expect(superRule.rules).toBeNull();
    expect(superRule.senders.every((sender) => sender.reply === "never" && sender.reason === "group-chat-not-allowed")).toBe(true);
    const basicRule = await runGroupTest({ cfg: cfgWith({ "-5297954291": approved }), state: stateWith({ "-5297954291": { mode: "approved" } }), groupId: "-1005297954291" });
    expect(basicRule.rules).toBeNull();
    expect(basicRule.senders.every((sender) => sender.reply === "never" && sender.reason === "group-chat-not-allowed")).toBe(true);
    const blockedBasic = await runGroupTest({ cfg: cfgWith({ "-1005297954291": approved, "-5297954291": { enabled: false } }), state: stateWith({ "-5297954291": { mode: "blocked" } }), groupId: "-1005297954291" });
    expect(bySender(blockedBasic).anyone).toMatchObject({ reason: null });
    expect(bySender(blockedBasic).anyone.reply).not.toBe("never");
  });

  it("reports mention gating from OpenClaw's resolver", async () => {
    const owners = [kGarry];
    const result = await runGroupTest({ cfg: cfgWith({ [kAlfredGroup]: { requireMention: true, ...buildOwnedKeys({ mode: "approved", owners, trusted: [] }) } }), state: stateWith(), groupId: kAlfredGroup });
    expect(result.requireMention).toBe(true);
    expect(bySender(result)[kGarry].reply).toBe("when_mentioned");
  });

  it("refuses a bad group id or sender list", async () => {
    await expect(runGroupTest({ cfg: cfgWith({}), state: stateWith(), groupId: "nope" })).rejects.toMatchObject({ code: "invalid_group_id" });
    await expect(runGroupTest({ cfg: cfgWith({}), state: stateWith(), groupId: kSecurity, senderIds: ["@harj"] })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
