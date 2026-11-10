const { readRelayConfig } = require("../../lib/server/relay/config");
const { resolveRelayTrust, ownerThreadBasisOf } = require("../../lib/plugin/relay-guard/trust");
const { setup, capyEnv, kOwner, kOauthClient, kWebhook, expectHeldWithTap } = require("./helpers/relay-attested-harness");

// GST-2323 PR4: with ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION on,
// owner trust needs both a pin and a live Capy attestation for an owner on
// ALPHACLAW_RELAY_CAPY_OWNERS. A pinned binding with no attestation, and an
// attested thread that is not pinned, are plain delegates and tap. A handoff
// to an attested successor keeps the agent name, so the pin carries over.
const kRequire = { ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION: "true" };
const combined = (pins) => ({ ...capyEnv(), ALPHACLAW_RELAY_TRUSTED_BINDINGS: pins, ...kRequire });
const ownerCalls = [
  ["secrets list", "secrets", { action: "list" }],
  ["cron add", "cron", { action: "add", job: { name: "nightly", prompt: "x" } }],
];

describe("relay pinned binding with attestation required (GST-2323 PR4)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("trusts a pinned binding whose message is attested for the owner: zero rows, zero notices, the owner-thread tools", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ pinnedBinding: agent, pinRequiresAttestation: true, attestedOwner: kOwner });
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(run, toolName, params), label).toEqual({});
    for (const [label, toolName, params] of ownerCalls) expect(await ctx.call(run, toolName, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "delegate", attested: true, ownerThread: true, pinnedBinding: agent });
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: agent, messageId: run.messageId })).toBe("attested");
  });

  it("keeps a pinned binding with no attestation a plain delegate that taps", async () => {
    ctx = setup({ env: combined("capy-25cf4e98b5b6") });
    const run = await ctx.deliver(ctx.oauthDelegate("capy-25cf4e98b5b6").agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null, attestedOrg: null });
    expect(ctx.admin.sends.at(-1).message).toContain("needs your owner's one-tap confirmation");
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
    for (const [label, toolName, params] of ownerCalls) expect((await ctx.call(run, toolName, params)).block, label).toBe(true);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
  });

  it("keeps an attested thread of the same owner that is not pinned a plain delegate that taps", async () => {
    ctx = setup({ env: combined("capy-000000000000") });
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null, attestedOrg: null });
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("ends the pin on the next call once the Capy grant is revoked, even though the agent is still pinned", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    const run = await ctx.deliver(agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    const capy = ctx.store().grants.list().find((grant) => grant.principalKind === "capy");
    ctx.relayRemote.revokeGrant({ id: capy.id, actor: "legacy" });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: agent, messageId: run.messageId })).toBe(null);
  });

  it("refuses the pin once the same call's attestation fails, even with the pin stamp and the delegate grant still live", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    const run = await ctx.deliver(agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    ctx.bridgeStore.update(run.messageId, { attestedOrg: null, attestedOwner: null });
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ pinnedBinding: agent, pinRequiresAttestation: true, trust: "delegate" });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", ownerThread: false, pinnedBinding: null });
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: agent, messageId: run.messageId })).toBe(null);
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("ends both stamps of a running turn at the next sweep once the pin is taken off the list", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    const run = await ctx.deliver(agent);
    ctx.setConfig(combined("capy-000000000000"));
    await ctx.tick();
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null, attestedOrg: null, attestedOwner: null });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("keeps the name and the pin across an attested rotation, and refuses a successor of another owner", async () => {
    ctx = setup();
    const { agent, capability, token } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    expect(await ctx.tool(token, "relay_handoff", { as: agent, capability, successor_thread: "ALPH-99" })).toMatchObject({ successor_thread: "ALPH-99" });
    const stranger = await ctx.access({ thread: "ALPH-99", user: "user_2", sub: "org/org_garry/project/proj_1/thread/ALPH-99" });
    const refused = stranger ? await ctx.tool(stranger, "relay_claim", { as: agent, webhook_url: kWebhook }) : null;
    expect(refused?.agent).toBeUndefined();
    expect(ctx.store().bindings.get(agent)).toMatchObject({ generation: 1, threadCode: "ALPH-85" });
    const successor = await ctx.access({ thread: "ALPH-99", sub: "org/org_garry/project/proj_1/thread/ALPH-99" });
    expect(await ctx.tool(successor, "relay_claim", { as: agent, webhook_url: kWebhook })).toMatchObject({ agent, generation: 2 });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ pinnedBinding: agent, pinRequiresAttestation: true });
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    expect(ctx.store().bindings.get(agent)).toMatchObject({ threadCode: "ALPH-99" });
  });

  it("moves an unattested pinned binding to attestation with its handoff code, keeping its name and pin", async () => {
    ctx = setup();
    const agent = "capy-25cf4e98b5b6";
    ctx.oauthDelegate(agent);
    ctx.setConfig(combined(agent));
    const before = await ctx.deliver(agent);
    expect((await ctx.call(before, "secrets", { action: "list" })).block).toBe(true);
    ctx.relayRemote.createCapyGrant({ project: "proj_1", user: kOwner, actor: "legacy" });
    const tools = ctx.relayRemote.ensureOpen().tools;
    const handed = JSON.parse((await tools.call({ clientId: kOauthClient, name: "relay_handoff", args: { as: agent, capability: "arcap_" + agent, successor_thread: "ALPH-85" } })).content[0].text);
    expect(handed.handoff_code).toMatch(/^arho_/);
    const machine = await ctx.access({});
    expect(await ctx.tool(machine, "relay_claim", { as: agent, handoff_code: handed.handoff_code, webhook_url: kWebhook })).toMatchObject({ agent, generation: 2, thread_id: "ALPH-85" });
    const after = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(after.messageId)).toMatchObject({ pinnedBinding: agent, attestedOwner: kOwner });
    expect(await ctx.call(after, "secrets", { action: "list" })).toEqual({});
    expect(JSON.parse((await tools.call({ clientId: kOauthClient, name: "relay_inbox", args: { as: agent, capability: "arcap_" + agent } })).content[0].text).error).toBeTruthy();
  });

  it("refuses the pinned owner's change to the new setting and keeps the anchor", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(combined(agent));
    const run = await ctx.deliver(agent);
    const result = await ctx.call(run, "exec", { command: "echo ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION=false >> " + ctx.dotEnv });
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("would change what decides relay trust on this box");
    expect(ctx.confirmationCount()).toBe(0);
  });
});

describe("ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION", () => {
  it("is off by default, on only for an on value, and deployment env only", () => {
    expect(readRelayConfig({ env: {} }).trustedBindingsRequireAttestation).toBe(false);
    expect(readRelayConfig({ env: { ...kRequire } }).trustedBindingsRequireAttestation).toBe(true);
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION: "maybe" } }).trustedBindingsRequireAttestation).toBe(false);
    expect(require("../../lib/server/deployment-only-env").kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_RELAY_TRUSTED_BINDINGS_REQUIRE_ATTESTATION");
  });
});
