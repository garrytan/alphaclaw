const fs = require("fs");
const path = require("path");
const { decideRelayToolCall } = require("../../lib/plugin/relay-guard/policy");
const { classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-3257: the owner's own Capy thread over relay (an attested owner thread
// or a pinned binding) edits the box's learned skills with OpenClaw's
// skill_workshop tool, the way the owner does. Every other delegate and every
// peer stays refused, and a skill write that would land in the relay's trust
// anchor is refused even for the owner's thread.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const delegate = { tier: "delegate" };
const kPatch = { action: "patch", name: "slack-dm-access", old_text: "a", new_text: "b", reason: "fix the DM steps" };
const kCalls = [
  { action: "list" },
  { action: "view", name: "slack-dm-access" },
  kPatch,
  { action: "create", name: "new-skill", content: "---\nname: new-skill\ndescription: x\n---\nsteps" },
  { action: "write_file", name: "slack-dm-access", file_path: "references/steps.md", content: "x" },
  { action: "remove_file", name: "slack-dm-access", file_path: "references/old.md" },
  { action: "archive", name: "slack-dm-access", reason: "merged" },
  { action: "restore", name: "slack-dm-access" },
  { action: "update", target: "personal", skill_id: "s1", expected_revision: "a".repeat(64), proposal_content: "x" },
];
const expectAnchorRefusal = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toContain("would change what decides relay trust on this box");
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

describe("relay guard: skill_workshop for the owner's own thread (GST-3257)", () => {
  it("allows every skill_workshop action for an owner-thread delegate", () => {
    for (const params of kCalls) expect(decideRelayToolCall({ toolName: "skill_workshop", params, trust: delegate, ownerThread: true }), params.action).toEqual({ allow: true });
  });

  it("refuses an action OpenClaw 2026.11.4 does not have, even for the owner's thread", () => {
    expect(decideRelayToolCall({ toolName: "skill_workshop", params: { action: "publish" }, trust: delegate, ownerThread: true }).allow).toBe(false);
    expect(decideRelayToolCall({ toolName: "skill_workshop", params: {}, trust: delegate, ownerThread: true }).allow).toBe(false);
  });

  it("refuses it for a delegate that is not the owner's thread and for a peer, whatever the operator's tool list says", () => {
    for (const delegateTools of [[], ["skill_workshop"]]) {
      expect(decideRelayToolCall({ toolName: "skill_workshop", params: kPatch, trust: delegate, delegateTools, ownerThread: false }).allow).toBe(false);
      expect(decideRelayToolCall({ toolName: "skill_workshop", params: kPatch, trust: { tier: "peer" }, delegateTools, ownerThread: true }).allow).toBe(false);
    }
  });

  it("reads a workshop write's landing from the agent's agentDir and leaves the personal library alone", () => {
    const rootDir = "/srv/alphaclaw";
    expect(classifyAnchor({ toolName: "skill_workshop", params: kPatch, rootDir, agentId: "main" })).toBeNull();
    expect(classifyAnchor({ toolName: "skill_workshop", params: { ...kPatch, name: "relay-guard" }, rootDir, agentId: "main" })).toMatchObject({ action: expect.stringContaining("skill_workshop patch") });
    expect(classifyAnchor({ toolName: "skill_workshop", params: { action: "view", name: "relay-guard" }, rootDir, agentId: "main" })).toBeNull();
    expect(classifyAnchor({ toolName: "skill_workshop", params: { action: "remove", target: "personal", skill_id: "relay-guard" }, rootDir, agentId: "main" })).toBeNull();
  });

  describe("through the plugin entry", () => {
    let ctx;
    afterEach(() => {
      ctx?.cleanup();
      ctx = null;
    });

    it("admits the pinned owner thread's skill edits with no confirmation", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
      for (const params of kCalls) expect(await ctx.call(run, "skill_workshop", params), params.action).toEqual({});
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("admits the attested owner thread's skill edits with no confirmation", async () => {
      ctx = setup();
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      for (const params of kCalls) expect(await ctx.call(run, "skill_workshop", params), params.action).toEqual({});
      expect(ctx.confirmationCount()).toBe(0);
      ctx.confirmations.tick();
      expect(ctx.notices).toEqual([]);
    });

    it("refuses a delegate on a binding that is not pinned, with no confirmation row", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
      const result = await ctx.call(run, "skill_workshop", kPatch);
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("skill_workshop is not available to a delegate relay session");
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("refuses a peer", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { grant: false, threadId: "jam_B" }).agent);
      const result = await ctx.call(run, "skill_workshop", kPatch);
      expect(result.block).toBe(true);
      expect(result.blockReason).toContain("skill_workshop is not available in a relay session");
    });

    it("refuses the owner's thread a skill write that lands in the trust anchor", async () => {
      ctx = setup();
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      expectAnchorRefusal(await ctx.call(run, "skill_workshop", { action: "create", name: "relay-guard", content: "x" }), "a skill named after the guard");
      expectAnchorRefusal(await ctx.call(run, "skill_workshop", { action: "write_file", name: "notes", file_path: "scripts/go.sh", content: "export ALPHACLAW_RELAY_DELEGATE_AGENTS=x" }), "a script naming a trust env name");
      expect(await ctx.call(run, "skill_workshop", { action: "write_file", name: "notes", file_path: "references/env.md", content: "ALPHACLAW_RELAY_DELEGATE_AGENTS lists delegates" }), "a note naming it").toEqual({});
      const config = JSON.parse(fs.readFileSync(ctx.openclawJson, "utf8"));
      config.agents = { list: [{ id: "main", agentDir: path.join(ctx.rootDir, "relay", "agent") }] };
      fs.writeFileSync(ctx.openclawJson, JSON.stringify(config));
      expectAnchorRefusal(await ctx.call(run, "skill_workshop", kPatch), "an agentDir inside the relay's directory");
      expect(await ctx.call(run, "skill_workshop", { action: "view", name: "slack-dm-access" }), "a read there").toEqual({});
      expect(ctx.confirmationCount()).toBe(0);
    });
  });
});
