const { resolveRelayTrust, ownerThreadSessionBasisOf } = require("../../lib/plugin/relay-guard/trust");
const { checkConfirmation } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2656: a turn the box itself starts in a relay session (a cron job, a
// wake) has no relay message in flight, so the guard used to give it the
// peer policy, even in the owner's own thread's session: the hourly job in
// that session could not reach message through tool_call. Such a turn now
// gets the owner-thread decision when the newest message dispatched into the
// session was, and still is, the owner's own thread's, re-checked per call
// against remote.db. A revoked grant, a handoff, a removed binding, an
// unpinned delegate and a peer keep the peer policy. The trust anchor and
// the relay's own files stay refused for every turn.
const kPinned = "capy-25cf4e98b5b6";
const kUnpinned = "capy-0a1b2c3d4e5f";
const pinnedEnv = () => ({ ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned });
const send = { action: "send", channel: "telegram", target: "123", message: "hourly report" };

// The message the bridge dispatched ends; a later turn in the same session
// runs under a run id of the box's own.
const endAndStartBoxTurn = (ctx, run, runId = "cron-hourly-1") => {
  ctx.bridgeStore.update(run.messageId, { state: "answered" });
  return { messageId: null, ctx: { agentId: "main", sessionKey: run.ctx.sessionKey, runId } };
};

const expectPeer = (result, toolName, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toContain(toolName + " is not available in a relay session");
};

describe("relay owner threads: a turn the box starts in the owner's thread's relay session (GST-2656)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("gives a pinned binding's box turn the owner-thread decision, through tool_call and directly, with no rows or notices", async () => {
    ctx = setup({ env: pinnedEnv() });
    const turn = endAndStartBoxTurn(ctx, await ctx.deliver(ctx.oauthDelegate(kPinned).agent));
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...turn.ctx, ownerSessionTurns: true })).toMatchObject({
      tier: "delegate",
      reason: "owner_thread_session",
      ownerThread: true,
      boxTurn: true,
      messageId: null,
      approval: null,
      pinnedBinding: kPinned,
    });
    expect(ownerThreadSessionBasisOf({ rootDir: ctx.rootDir, sender: kPinned, sessionKey: turn.ctx.sessionKey })).toBe("pinned_binding");
    for (const wrapper of ["tool_call", "dispatch_action"]) expect(await ctx.call(turn, wrapper, { id: "message", args: send }), wrapper).toEqual({});
    expect(await ctx.call(turn, "message", send)).toEqual({});
    expect(await ctx.call(turn, "cron", { action: "add", job: { name: "nightly", prompt: "summarize the day" } })).toEqual({});
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(turn, toolName, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    expect(ctx.guardLogs.filter((line) => line.includes("pinned binding call admitted"))).toHaveLength(ctx.highRiskCalls.length);
    for (const [label, toolName, params] of [
      ["sessions_spawn", "sessions_spawn", { task: "x" }],
      ["the relay's own MCP tools", "relay__relay_send", { to: "x", text: "y" }],
      ["secrets delete", "secrets", { action: "delete", name: "STRIPE_KEY" }],
    ]) {
      const result = await ctx.call(turn, toolName, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("[relay-guard]");
    }
  });

  it("keeps the anchor, the relay's files and the restart route closed to a box turn", async () => {
    ctx = setup({ env: pinnedEnv() });
    const turn = endAndStartBoxTurn(ctx, await ctx.deliver(ctx.oauthDelegate(kPinned).agent));
    const anchor = await ctx.call(turn, "exec", { command: "openclaw config set plugins.entries.relay-guard.enabled false" });
    expect(anchor.block).toBe(true);
    expect(anchor.blockReason).toContain("would change what decides relay trust on this box");
    const keyRead = await ctx.call(turn, "read", { path: require("path").join(ctx.rootDir, "relay", "secrets.json") });
    expect(keyRead.block).toBe(true);
    expect(keyRead.blockReason).toContain("is refused in every relay session");
    const restart = await ctx.call(turn, "gateway", { action: "restart" });
    expect(restart.block).toBe(true);
    expect(restart.blockReason).toContain("this turn was started on the box");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("gives an attested owner thread's box turn the same decision", async () => {
    ctx = setup();
    const turn = endAndStartBoxTurn(ctx, await ctx.deliver((await ctx.attestedAgent()).agent));
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...turn.ctx, ownerSessionTurns: true })).toMatchObject({ tier: "delegate", ownerThread: true, attested: true, boxTurn: true });
    expect(await ctx.call(turn, "tool_call", { id: "message", args: send })).toEqual({});
    expect(await ctx.call(turn, "message", send)).toEqual({});
  });

  it("falls back to the peer policy when the grant is revoked, the binding is handed off or removed", async () => {
    ctx = setup({ env: pinnedEnv() });
    const { agent } = ctx.oauthDelegate(kPinned);
    const turn = endAndStartBoxTurn(ctx, await ctx.deliver(agent));
    expect(await ctx.call(turn, "tool_call", { id: "message", args: send })).toEqual({});
    const grant = ctx.store().grants.forAgent(agent).find((row) => !row.revokedAt);
    ctx.relayRemote.revokeGrant({ id: grant.id, actor: "legacy" });
    expectPeer(await ctx.call(turn, "tool_call", { id: "message", args: send }), "tool_call", "revoked grant");
    expectPeer(await ctx.call(turn, "message", send), "message", "revoked grant");
    expect(ownerThreadSessionBasisOf({ rootDir: ctx.rootDir, sender: kPinned, sessionKey: turn.ctx.sessionKey })).toBeNull();
    expect(checkConfirmation({ rootDir: ctx.rootDir, sender: kPinned, sessionKey: turn.ctx.sessionKey, kind: "high", action: "write openclaw.json", target: "openclaw.json" })).toMatchObject({ admitted: false, state: "unavailable" });

    ctx.cleanup();
    ctx = setup({ env: pinnedEnv() });
    ctx.oauthDelegate(kPinned);
    const handedOff = endAndStartBoxTurn(ctx, await ctx.deliver(kPinned));
    const binding = ctx.store().bindings.get(kPinned);
    ctx.store().bindings.claim({ agent: kPinned, generation: binding.generation, threadId: "jam_successor", clientId: binding.clientId, webhookUrl: binding.webhookUrl, capabilityHash: "c".repeat(64), priorUntil: binding.until });
    expectPeer(await ctx.call(handedOff, "tool_call", { id: "message", args: send }), "tool_call", "handoff");

    ctx.store().bindings.remove(kPinned);
    expect(ctx.store().bindings.get(kPinned)).toBeFalsy();
    expectPeer(await ctx.call(handedOff, "tool_call", { id: "message", args: send }), "tool_call", "removed binding");
  });

  it("keeps an unpinned delegate's and a peer's box turns on the peer policy, as today", async () => {
    ctx = setup({ env: pinnedEnv() });
    ctx.oauthDelegate(kPinned);
    const unpinned = endAndStartBoxTurn(ctx, await ctx.deliver(ctx.oauthDelegate(kUnpinned, { threadId: "jam_B" }).agent));
    const peer = endAndStartBoxTurn(ctx, await ctx.deliver("lupe"));
    for (const turn of [unpinned, peer]) {
      expectPeer(await ctx.call(turn, "tool_call", { id: "message", args: send }), "tool_call", turn.ctx.sessionKey);
      expectPeer(await ctx.call(turn, "message", send), "message", turn.ctx.sessionKey);
      expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...turn.ctx, ownerSessionTurns: true })).toMatchObject({ tier: "peer", reason: "no_run" });
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("decides only from the box's rows: a relay run id with no row, and callers that do not opt in, stay peer", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const turn = endAndStartBoxTurn(ctx, run);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...turn.ctx })).toMatchObject({ tier: "peer", reason: "no_run" });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...turn.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "no_run" });
    const unknownRelayRun = { messageId: null, ctx: { agentId: "main", sessionKey: run.ctx.sessionKey, runId: "relay-999999" } };
    expectPeer(await ctx.call(unknownRelayRun, "tool_call", { id: "message", args: send }), "tool_call", "relay run id with no row");
    expect(ownerThreadSessionBasisOf({ rootDir: ctx.rootDir, sender: kUnpinned, sessionKey: turn.ctx.sessionKey })).toBeNull();
  });
});
