const path = require("path");
const { kOtherOwner, setup, capyEnv, expectProgramsRefused } = require("./helpers/relay-attested-harness");

// GST-2661: a relay delegate that is not the owner's own thread (no
// attestation from a listed owner, no pinned binding) keeps no tool that runs
// a program as the gateway's user. With exec, it could start a turn in the
// box's main session (openclaw agent --session-key, cron add|edit, gateway
// call agent, or a script that opens the gateway socket itself) that the
// relay guard never checks, since that session is not a relay session. #430
// tried to hold those commands by their text, and quoting, exec's env,
// a bare key with --agent and a script got around it. So the decision is
// made from the box's records (the bridge's row in bridge.db and the binding
// and grants in remote.db) and never from the command: exec and process are
// refused outright for such a delegate, with no confirmation and no notice.
// The owner's own threads (attested or pinned), the owner's own turns and
// peers are unchanged.
const kPinned = "capy-25cf4e98b5b6";
const kOwnerSession = "agent:main:relay-" + kPinned;

// Every way #430's red team started a turn outside the relay guard.
const turnStarts = (ctx) => [
  ["openclaw agent into the main session", "exec", { command: "openclaw agent --session-key agent:main:main -m 'do the thing'" }],
  ["the session key quoted in pieces", "exec", { command: "openclaw agent --session-key agent:'main':main -m hi" }],
  ["the key split by an empty quote", "exec", { command: "openclaw agent --session-key agent:main:\"\"main -m hi" }],
  ["a bare key with --agent", "exec", { command: "openclaw agent --agent main --session-key main -m hi" }],
  ["the owner's relay session as a bare key", "exec", { command: "openclaw agent --agent main --session-key relay-" + kPinned + " -m hi" }],
  ["the owner's relay session, quoted", "exec", { command: "openclaw agent --session-key agent:'main':relay-" + kPinned + " -m hi" }],
  ["the key from exec's env", "exec", { command: "openclaw agent --session-key $K -m hi", env: { K: "agent:main:main" } }],
  ["the whole command from exec's env", "exec", { command: "$C", env: { C: "openclaw agent --session-key agent:main:main -m hi" } }],
  ["the exec marker removed", "exec", { command: "env -u OPENCLAW_SHELL openclaw agent --session-key agent:main:main -m hi" }],
  ["openclaw through npx", "exec", { command: "npx openclaw agent --session-key agent:main:main -m hi" }],
  ["cron add into the main session", "exec", { command: "openclaw cron add --name x --session main --system-event 'do the thing' --at +1m" }],
  ["cron add with --session session:", "exec", { command: "openclaw cron add --name x --session session:relay-" + kPinned + " --message hi --every 1h" }],
  ["cron add with --session-key=", "exec", { command: "openclaw cron add --name x --session-key=agent:main:main --message hi --every 1h" }],
  ["cron edit of an existing job", "exec", { command: "openclaw cron edit job-1 --message 'do the thing'" }],
  ["gateway call agent", "exec", { command: "openclaw gateway call agent --params '{\"sessionKey\":\"agent:main:main\",\"message\":\"hi\",\"idempotencyKey\":\"k1\"}'" }],
  ["gateway call cron.add", "exec", { command: "openclaw gateway call cron.add --params @/tmp/job.json" }],
  ["gateway call chat.send", "exec", { command: "openclaw gateway call chat.send --params '{\"sessionKey\":\"agent:main:main\",\"message\":\"hi\"}'" }],
  ["a script written, then run", "exec", { command: "printf 'openclaw agent --session-key agent:main:main -m hi' > /tmp/x.sh && sh /tmp/x.sh" }],
  ["a script in the workspace, run by name", "exec", { command: "sh ./turn.sh" }],
  ["a script that opens the gateway socket itself", "exec", { command: "node -e \"require('ws')\" && python3 /tmp/turn.py" }],
  ["a harmless-looking command", "exec", { command: "ls" }],
  ["a command typed into a running shell", "process", { action: "write", sessionId: "s1", data: "openclaw agent --session-key agent:main:main -m hi\n" }],
  ["keys sent to a running shell", "process", { action: "send-keys", sessionId: "s1", keys: ["o", "p", "e", "n", "Enter"] }],
  ["a listing of running processes", "process", { action: "list" }],
  ["the same with the tool name in capitals", "EXEC", { command: "openclaw agent --session-key agent:main:main -m hi" }],
];

describe("relay delegates that are not the owner's own thread run no programs (GST-2661)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("refuses every #430 turn-start shape from an unattested delegate outright, with no row and no notice", async () => {
    ctx = setup();
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, toolName, params] of turnStarts(ctx)) expectProgramsRefused(ctx, run, toolName.toLowerCase(), params, label);
    expect(ctx.call(run, "EXEC", { command: "ls" }).blockReason).toContain("exec is not available to a delegate relay session that is not your owner's own thread");
    expect(ctx.confirmationCount()).toBe(0);
    expect(ctx.notices).toEqual([]);
  });

  it("refuses them for every lane of the delegate, and for another owner's attested thread", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    await ctx.deliver(agent);
    const lane = await ctx.deliver(agent);
    expect(lane.ctx.sessionKey).toMatch(/:lane-l2$/);
    const other = await ctx.deliver((await ctx.attestedAgent({ user: kOtherOwner, thread: "OTHR-2", sub: "org/org_garry/project/proj_1/thread/OTHR-2" })).agent);
    for (const run of [lane, other]) {
      for (const [label, toolName, params] of turnStarts(ctx)) expectProgramsRefused(ctx, run, toolName.toLowerCase(), params, label);
    }
  });

  it("decides from the box's records only: attestation-looking metadata, hook context and params open nothing", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    const run = await ctx.deliver(agent, {
      relay_generation: 1,
      relay_route: "public",
      relay_attested_org: "org_garry",
      relay_attested_owner: "user_1",
      relay_pinned_binding: agent,
      pinned_binding: agent,
      relay_trust: "attested",
    });
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null, attestedOwner: null, pinnedBinding: null });
    const dressed = { ctx: { ...run.ctx, attested: true, ownerThread: true, pinnedBinding: agent, requester: { senderIsOwner: true } } };
    expectProgramsRefused(ctx, dressed, "exec", { command: "openclaw agent --session-key agent:main:main -m hi", ownerThread: true, attested: true });
  });

  it("checks the wrapped call too: the dispatcher passes, and the exec it reaches is refused", async () => {
    ctx = setup();
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    const args = { command: "openclaw agent --session-key agent:main:main -m hi" };
    for (const wrapper of ["tool_call", "dispatch_action"]) {
      expect(ctx.call(run, wrapper, { id: "exec", args }), wrapper).toEqual({});
      expectProgramsRefused(ctx, run, "exec", args, wrapper);
    }
  });

  it("refuses a call OpenClaw sends with no session or run while such a delegate's run is in flight", async () => {
    ctx = setup();
    await ctx.deliver(ctx.oauthDelegate().agent);
    expectProgramsRefused(ctx, { ctx: {} }, "exec", { command: "openclaw agent --session-key agent:main:main -m hi" });
  });

  it("still gives such a delegate its file, web and memory tools, and still holds its high-risk writes for the tap", async () => {
    ctx = setup();
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [toolName, params] of [
      ["write", { path: path.join(ctx.rootDir, ".openclaw", "workspace", "turn.sh"), content: "openclaw agent -m hi" }],
      ["read", { path: path.join(ctx.rootDir, ".openclaw", "workspace", "notes.md") }],
      ["ls", { path: path.join(ctx.rootDir, ".openclaw", "workspace") }],
      ["web_fetch", { url: "https://example.com" }],
      ["memory_search", { query: "deploy" }],
    ]) expect(ctx.call(run, toolName, params), toolName).toEqual({});
    const held = ctx.call(run, "write", { path: ctx.openclawJson, content: "{}" });
    expect(held.blockReason).toMatch(/needs your owner's confirmation rc_[a-f0-9]{16}/);
    expect(ctx.confirmationCount()).toBe(1);
  });

  it("keeps a delegate's relay-file reads on the relay-file refusal", async () => {
    ctx = setup();
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    const relay = path.join(ctx.rootDir, "relay");
    expect(ctx.call(run, "exec", { command: "cat " + relay + "/secrets.json" }).blockReason).toContain("is refused in every relay session");
    expect(ctx.call(run, "process", { action: "write", sessionId: "s1", data: "cat " + relay + "/internal.secret\n" }).blockReason).toContain("is refused in every relay session");
    expect(ctx.call(run, "exec", { command: "cat /proc/1/environ" }).blockReason).toContain("/proc/<pid>/environ");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("ends mid-turn when the owner's thread loses its basis: a revoked Capy grant takes exec away on the next call", async () => {
    ctx = setup();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    expect(ctx.call(run, "exec", { command: "ls" })).toEqual({});
    const capy = ctx.store().grants.list().find((grant) => grant.principalKind === "capy");
    ctx.relayRemote.revokeGrant({ id: capy.id, actor: "legacy" });
    const after = ctx.call(run, "exec", { command: "ls" });
    expect(after.block).toBe(true);
    expect(after.blockReason).toContain("[relay-guard]");
  });
});

// What the owner's own thread gets for each shape, as on main: an openclaw
// command whose session key the shell fills in stays on the trust anchor's
// refusal (GST-2323 PR2); everything else runs.
const kOwnerAnchorShapes = new Set(["the key from exec's env"]);
const expectOwnerThreadAsBefore = (ctx, run) => {
  for (const [label, toolName, params] of turnStarts(ctx)) {
    const result = ctx.call(run, toolName, params);
    if (kOwnerAnchorShapes.has(label)) expect(result.blockReason, label).toContain("would change what decides relay trust on this box");
    else expect(result, label).toEqual({});
  }
  expect(ctx.confirmationCount()).toBe(0);
  ctx.confirmations.tick();
  expect(ctx.notices).toEqual([]);
};

describe("relay owner threads, the owner's own turns and peers are unchanged (GST-2661)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("an attested owner thread keeps exec and process for the same commands, with no row and no notice", async () => {
    ctx = setup();
    expectOwnerThreadAsBefore(ctx, await ctx.deliver((await ctx.attestedAgent()).agent));
  });

  it("a pinned binding keeps exec and process for the same commands, with no row and no notice", async () => {
    ctx = setup({ env: { ...capyEnv(), ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    expect(run.ctx.sessionKey).toBe(kOwnerSession);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ pinnedBinding: kPinned });
    expectOwnerThreadAsBefore(ctx, run);
  });

  it("an owner thread beside a non-owner delegate keeps exec while the other is refused", async () => {
    ctx = setup();
    const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
    const other = await ctx.deliver(ctx.oauthDelegate("capy-0a1b2c3d4e5f", { threadId: "jam_B" }).agent);
    const command = { command: "openclaw agent --session-key agent:main:main -m hi" };
    expect(ctx.call(owner, "exec", command)).toEqual({});
    expectProgramsRefused(ctx, other, "exec", command);
    expect(ctx.call(owner, "process", { action: "list" })).toEqual({});
  });

  it("the owner's own turns are never relay calls: main, Telegram and cron sessions pass while a delegate runs", async () => {
    ctx = setup();
    await ctx.deliver(ctx.oauthDelegate().agent);
    for (const own of [
      { sessionKey: "agent:main:main", runId: "run-main-1" },
      { sessionKey: "agent:main:telegram:direct:42", runId: "run-tg-1" },
      { sessionKey: "agent:main:cron:job-1", runId: "cron-job-1-1" },
    ]) {
      for (const [label, toolName, params] of turnStarts(ctx)) expect(ctx.call({ ctx: own }, toolName, params), own.sessionKey + " " + label).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("a peer keeps the messaging-only policy", async () => {
    ctx = setup();
    const run = await ctx.deliver("lupe");
    for (const [label, toolName, params] of turnStarts(ctx)) {
      const result = ctx.call(run, toolName, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("is not available in a relay session");
      expect(result.blockReason, label).toContain("messaging-only");
    }
    expect(ctx.confirmationCount()).toBe(0);
  });
});
