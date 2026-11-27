const { decideRelayToolCall, kDelegateNeverTools, kDelegateAllowedTools, kOwnerThreadSessionTools } = require("../../lib/plugin/relay-guard/policy");
const { setup } = require("./helpers/relay-attested-harness");

// GST-4062: OpenClaw 2026.11.4's sessions_list returns every session the
// agent can see (tools.sessions.visibility defaults to "all"): the owner's
// chats with their keys, senders, status and token counts, and with
// messageLimit up to 20 of each session's latest messages. Only the owner's
// own thread (attested or a pinned binding) lists sessions; every other
// delegate and every peer is refused, and no operator entry opens it.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const delegate = { tier: "delegate" };
const kListCalls = [{}, { messageLimit: 20 }, { messageLimit: 1, includeLastMessage: true, includeDerivedTitles: true }, { agentId: "main", limit: 200 }];

describe("relay guard: sessions_list for the owner's own thread only (GST-4062)", () => {
  it("is on the never list and off the delegate list", () => {
    expect(kOwnerThreadSessionTools).toEqual(["sessions_list"]);
    expect(kDelegateNeverTools).toContain("sessions_list");
    expect(kDelegateAllowedTools).not.toContain("sessions_list");
  });

  it("allows it for an owner-thread delegate", () => {
    for (const params of kListCalls) expect(decideRelayToolCall({ toolName: "sessions_list", params, trust: delegate, ownerThread: true }), JSON.stringify(params)).toEqual({ allow: true });
  });

  it("refuses it for any other delegate and for a peer, whatever the operator's tool list says", () => {
    for (const delegateTools of [[], ["sessions_list"], ["s*"]]) {
      for (const params of kListCalls) {
        expect(decideRelayToolCall({ toolName: "sessions_list", params, trust: delegate, delegateTools, ownerThread: false }).allow, JSON.stringify(params)).toBe(false);
        expect(decideRelayToolCall({ toolName: "sessions_list", params, trust: { tier: "peer" }, delegateTools, ownerThread: true }).allow, JSON.stringify(params)).toBe(false);
      }
    }
  });

  it("refuses a look-alike name, even for the owner's thread", () => {
    for (const toolName of ["sessions_listx", "sessions_list_v2", "sessions-list", "session_list"]) {
      expect(decideRelayToolCall({ toolName, params: {}, trust: delegate, ownerThread: true }).allow, toolName).toBe(false);
    }
  });

  describe("through the plugin entry", () => {
    let ctx;
    afterEach(() => {
      ctx?.cleanup();
      ctx = null;
    });
    // The dispatcher's own call passes, and the tool it reaches runs through
    // the hook again under its own name in the same relay session.
    const viaDispatcher = async (run, params) => {
      for (const wrapper of ["dispatch_action", "tool_call"]) expect(await ctx.call(run, wrapper, { id: "openclaw:core:sessions_list", args: params }), wrapper).toEqual({});
      return ctx.call(run, "sessions_list", params);
    };

    it("admits the pinned owner thread's listing, directly and through the dispatcher, with no confirmation", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
      for (const params of kListCalls) {
        expect(await ctx.call(run, "sessions_list", params), JSON.stringify(params)).toEqual({});
        expect(await viaDispatcher(run, params), JSON.stringify(params)).toEqual({});
      }
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("admits the attested owner thread's listing, directly and through the dispatcher", async () => {
      ctx = setup();
      const run = await ctx.deliver((await ctx.attestedAgent()).agent);
      for (const params of kListCalls) {
        expect(await ctx.call(run, "sessions_list", params), JSON.stringify(params)).toEqual({});
        expect(await viaDispatcher(run, params), JSON.stringify(params)).toEqual({});
      }
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("refuses a delegate on a binding that is not pinned, directly and through the dispatcher", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
      for (const params of kListCalls) {
        for (const result of [await ctx.call(run, "sessions_list", params), await viaDispatcher(run, params)]) {
          expect(result.block, JSON.stringify(params)).toBe(true);
          expect(result.blockReason).toContain("sessions_list is not available to a delegate relay session");
        }
      }
      expect(ctx.confirmationCount()).toBe(0);
    });

    it("refuses a peer", async () => {
      ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
      const run = await ctx.deliver(ctx.oauthDelegate(kOther, { grant: false, threadId: "jam_B" }).agent);
      for (const params of kListCalls) {
        const result = await ctx.call(run, "sessions_list", params);
        expect(result.block, JSON.stringify(params)).toBe(true);
        expect(result.blockReason).toContain("sessions_list is not available in a relay session");
      }
    });
  });
});
