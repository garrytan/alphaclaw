const { decideRelayToolCall, kOwnerThreadBrainTools } = require("../../lib/plugin/relay-guard/policy");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2476 gate B1: Wintermute reads the owner's private brain pages through
// an owner-bound gbrain MCP server, gbrain_owner. The owner's own Capy thread
// over relay (an attested owner thread or a pinned binding) is the owner, so
// it gets that server's 19 named read tools. A delegate that is not the
// owner's thread, a peer, and any gbrain_owner tool not on the list stay
// refused.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const delegate = { tier: "delegate" };

describe("relay guard: the owner's brain connector for the owner's own thread (GST-2476 B1)", () => {
  it("names the 19 read tools one by one, with no wildcard", () => {
    expect(kOwnerThreadBrainTools).toHaveLength(19);
    expect(kOwnerThreadBrainTools.every((name) => /^gbrain_owner__[a-z_]+$/.test(name))).toBe(true);
    expect(kOwnerThreadBrainTools).toEqual(expect.arrayContaining(["gbrain_owner__search", "gbrain_owner__get_page", "gbrain_owner__whoami"]));
  });

  it("allows the listed reads for an owner-thread delegate", () => {
    for (const toolName of kOwnerThreadBrainTools) {
      expect(decideRelayToolCall({ toolName, params: { query: "x" }, trust: delegate, ownerThread: true }), toolName).toEqual({ allow: true });
    }
  });

  it("refuses them for a delegate that is not the owner's thread, and for a peer", () => {
    for (const toolName of kOwnerThreadBrainTools) {
      expect(decideRelayToolCall({ toolName, trust: delegate, ownerThread: false }).allow, toolName).toBe(false);
      expect(decideRelayToolCall({ toolName, trust: { tier: "peer" }, ownerThread: true }).allow, toolName).toBe(false);
    }
  });

  it("refuses a gbrain_owner tool that is not on the list, even for the owner's thread", () => {
    for (const toolName of ["gbrain_owner__think", "gbrain_owner__synthesize", "gbrain_owner__put_page", "gbrain_owner__request_tools", "gbrain_owner__", "gbrain_owner__search_v2"]) {
      const decision = decideRelayToolCall({ toolName, trust: delegate, ownerThread: true });
      expect(decision.allow, toolName).toBe(false);
      expect(decision.reason, toolName).toContain("is not available to a delegate relay session");
    }
  });

  describe("through the plugin entry", () => {
    let ctx;
    afterEach(() => {
      ctx?.cleanup();
      ctx = null;
    });

    it("admits the pinned owner thread's brain reads and refuses an unlisted one", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
      expect(await ctx.call(run, "gbrain_owner__search", { query: "x" })).toEqual({});
      expect(await ctx.call(run, "gbrain_owner__get_page", { slug: "x" })).toEqual({});
      expect((await ctx.call(run, "gbrain_owner__think", { question: "x" })).block).toBe(true);
    });

    it("refuses them for a delegate on a binding that is not pinned", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
      for (const toolName of ["gbrain_owner__search", "gbrain_owner__get_page"]) {
        const result = await ctx.call(run, toolName, { query: "x" });
        expect(result.block, toolName).toBe(true);
        expect(result.blockReason, toolName).toContain("is not available to a delegate relay session");
      }
    });
  });
});
