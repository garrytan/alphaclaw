const { decideRelayToolCall, kOwnerThreadGbrainIoTools } = require("../../lib/plugin/relay-guard/policy");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2788: Wintermute's gbrain.io MCP server, gbrain_io, reaches the owner's
// own gbrain.io account through two tools, shared_search and shared_call. The
// owner's own Capy thread over relay (an attested owner thread or a pinned
// binding) is the owner, so it gets both. Every other delegate and every peer
// stays refused, and no operator entry can open the server to them.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const delegate = { tier: "delegate" };
const kTools = ["gbrain_io__shared_search", "gbrain_io__shared_call"];

describe("relay guard: gbrain.io for the owner's own thread (GST-2788)", () => {
  it("names the two tools exactly", () => {
    expect([...(kOwnerThreadGbrainIoTools || [])].sort()).toEqual([...kTools].sort());
  });

  it("allows them for an owner-thread delegate", () => {
    for (const toolName of kTools) {
      expect(decideRelayToolCall({ toolName, params: { query: "x" }, trust: delegate, ownerThread: true }), toolName).toEqual({ allow: true });
    }
  });

  it("refuses them for a delegate that is not the owner's thread, and for a peer", () => {
    for (const toolName of kTools) {
      expect(decideRelayToolCall({ toolName, trust: delegate, ownerThread: false }).allow, toolName).toBe(false);
      expect(decideRelayToolCall({ toolName, trust: { tier: "peer" }, ownerThread: true }).allow, toolName).toBe(false);
    }
  });

  it("refuses another gbrain_io tool and a look-alike name, even for the owner's thread", () => {
    for (const toolName of ["gbrain_io__shared_write", "gbrain_io__", "gbrain_io__shared_search_v2", "GBRAIN_IO__shared_search", "gbrain_io__SHARED_CALL", "gbrain_io-2__shared_call", "gbrain_iox__shared_search", " gbrain_io__shared_search_x"]) {
      expect(decideRelayToolCall({ toolName, trust: delegate, ownerThread: true }).allow, toolName).toBe(false);
    }
  });

  it("never lets an operator's delegate tool list open the gbrain.io server to another delegate", () => {
    const delegateTools = ["gbrain_io__*", "gbrain_io__shared_search", "gbrain_io__shared_call", "gbrain_io-2__*"];
    for (const toolName of [...kTools, "gbrain_io-2__shared_call"]) {
      expect(decideRelayToolCall({ toolName, trust: delegate, delegateTools, ownerThread: false }).allow, toolName).toBe(false);
    }
    expect(decideRelayToolCall({ toolName: "gbrain_io__shared_call", trust: delegate, delegateTools, ownerThread: true })).toEqual({ allow: true });
  });

  describe("through the plugin entry", () => {
    let ctx;
    afterEach(() => {
      ctx?.cleanup();
      ctx = null;
    });

    it("admits the pinned owner thread's gbrain.io calls and refuses an unlisted one", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
      expect(await ctx.call(run, "gbrain_io__shared_search", { query: "x" })).toEqual({});
      expect(await ctx.call(run, "gbrain_io__shared_call", { tool: "x" })).toEqual({});
      expect((await ctx.call(run, "GBRAIN_IO__shared_search", { query: "x" })).block).toBe(true);
      expect((await ctx.call(run, "gbrain_io__shared_write", { query: "x" })).block).toBe(true);
    });

    it("refuses them for a delegate on a binding that is not pinned", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
      for (const toolName of kTools) {
        const result = await ctx.call(run, toolName, { query: "x" });
        expect(result.block, toolName).toBe(true);
        expect(result.blockReason, toolName).toContain("is not available to a delegate relay session");
      }
    });
  });
});
