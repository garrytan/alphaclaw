const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerRelayRoutes } = require("../../lib/server/routes/relay");
const { relayPaths } = require("../../lib/server/relay/constants");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { resolveRelayTrust, isAttestedDelegateMessage, ownerThreadBasisOf } = require("../../lib/plugin/relay-guard/trust");
const { setup, capyEnv, expectHeldWithTap } = require("./helpers/relay-attested-harness");

// GST-2323 PR3: the owner pins relay bindings on
// ALPHACLAW_RELAY_TRUSTED_BINDINGS (deployment env only). A pinned binding
// that is a live delegate through a live grant of its own is trusted like
// the owner's own attested thread: no confirmation row, link or notice, the
// owner-thread tools open, and a gateway restart runs through AlphaClaw's
// ladder with source relay:<agent>. It is recorded as attested:false with
// reason pinned_binding, since no identity is checked. The trust anchor and
// the relay's own files stay refused. Every other sender keeps today's
// policy.
const kPinned = "capy-25cf4e98b5b6";
const kOther = "capy-0a1b2c3d4e5f";
const kSecret = "a".repeat(64);
const other = (box) => box.oauthDelegate(kOther, { threadId: "jam_B" });
const pinnedEnv = (extra = {}) => ({ ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned, ...extra });

const ownerCalls = [
  ["message without an approval", "message", { action: "send", channel: "telegram", target: "123", message: "the deploy finished" }],
  ["cron add", "cron", { action: "add", job: { name: "nightly", prompt: "summarize the day" } }],
  ["plugins install", "plugins", { action: "install", source: "official", pluginId: "voice-call" }],
  ["secrets list", "secrets", { action: "list" }],
  ["gateway config.get", "gateway", { action: "config.get", path: "gateway.bind" }],
];

const expectAnchor = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toContain("would change what decides relay trust on this box");
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

describe("relay pinned binding (GST-2323 PR3): trusted like the owner's own thread", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("admits the pinned binding's high-risk calls with zero rows and zero notices, and opens the owner-thread tools", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const sent = ctx.admin.sends.at(-1).message;
    expect(sent).toContain("Your owner pinned this relay connection as trusted like their own thread");
    expect(sent).not.toContain("Capy attestation was verified");
    expect(ctx.bridgeLogs.some((line) => line.includes("from=" + kPinned) && line.includes("pinned_binding=yes"))).toBe(true);
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(run, toolName, params), label).toEqual({});
    for (const [label, toolName, params] of ownerCalls) expect(await ctx.call(run, toolName, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    expect(ctx.guardLogs.filter((line) => line.includes("pinned binding call admitted"))).toHaveLength(ctx.highRiskCalls.length);
    expect(ctx.guardLogs.some((line) => line.includes("attested delegate call admitted"))).toBe(false);
    expect(ctx.call(run, "sessions_spawn", { task: "x" }).block).toBe(true);
  });

  it("records no identity check: attested stays false, the reason is pinned_binding, and requireTrustedOwner keeps the delegate tier", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const expected = { tier: "delegate", attested: false, attestationReason: "pinned_binding", ownerThread: true, pinnedBinding: kPinned };
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject(expected);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject(expected);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kPinned, messageId: run.messageId })).toBe("pinned_binding");
    expect(isAttestedDelegateMessage({ rootDir: ctx.rootDir, sender: kPinned, messageId: run.messageId })).toBe(true);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ pinnedBinding: kPinned, attestedOrg: null, attestedOwner: null });
  });

  it("keeps an unpinned delegate on today's taps and a peer a peer, on the same box", async () => {
    ctx = setup({ env: pinnedEnv() });
    ctx.oauthDelegate(kPinned);
    const unpinned = await ctx.deliver(other(ctx).agent);
    expect(ctx.admin.sends.at(-1).message).toContain("needs your owner's one-tap confirmation");
    expectHeldWithTap(ctx, unpinned, "write", { path: ctx.openclawJson, content: "{}" });
    for (const [label, toolName, params] of ownerCalls) expect((await ctx.call(unpinned, toolName, params)).block, label).toBe(true);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...unpinned.ctx })).toMatchObject({ tier: "delegate", ownerThread: false, pinnedBinding: null, attestationReason: "not_attested" });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...unpinned.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
    const peer = await ctx.deliver("lupe");
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(peer, toolName, params).block, label).toBe(true);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...peer.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", ownerThread: false });
    expect(ctx.confirmationCount()).toBe(1);
  });

  it("does nothing for a pinned name with no binding, or a binding with no delegate grant", async () => {
    ctx = setup({ env: pinnedEnv() });
    const removed = await ctx.deliver(kPinned);
    expect(ctx.bridgeStore.get(removed.messageId)).toMatchObject({ trust: "peer", pinnedBinding: null });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...removed.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer" });
    expect(ctx.call(removed, "write", { path: ctx.openclawJson, content: "{}" }).block).toBe(true);
    ctx.oauthDelegate(kPinned, { grant: false });
    const ungranted = await ctx.deliver(kPinned);
    expect(ctx.bridgeStore.get(ungranted.messageId)).toMatchObject({ trust: "peer", pinnedBinding: null });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...ungranted.ctx, fallbackAgents: [kPinned] })).toMatchObject({ tier: "peer", ownerThread: false });
    expect(ctx.call(ungranted, "write", { path: ctx.openclawJson, content: "{}" }).block).toBe(true);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("never pins through the env-list fallback, only through a live grant", () => {
    const { pinnedOfRun } = require("../../lib/plugin/relay-guard/trust");
    const binding = { generation: 1 };
    const row = { pinned_binding: kPinned, binding_generation: 1 };
    expect(pinnedOfRun(row, binding, { trust: "delegate", reason: "grant", grantId: "rg_1" }, kPinned)).toBe(true);
    expect(pinnedOfRun(row, binding, { trust: "delegate", reason: "env_fallback", grantId: null }, kPinned)).toBe(false);
    expect(pinnedOfRun(row, { generation: 2 }, { trust: "delegate", reason: "grant", grantId: "rg_1" }, kPinned)).toBe(false);
    expect(pinnedOfRun({ ...row, pinned_binding: kOther }, binding, { trust: "delegate", reason: "grant", grantId: "rg_1" }, kPinned)).toBe(false);
  });

  it("does nothing while the list is empty, the default", async () => {
    ctx = setup({ env: {} });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
  });

  it.each([
    ["a revoked grant", (box) => box.relayRemote.revokeGrant({ id: box.store().grants.forAgent(kPinned)[0].id, actor: "legacy" })],
    ["a removed binding", (box) => box.relayRemote.removeBinding({ agent: kPinned, actor: "legacy" })],
    ["a revoked client", (box) => box.relayRemote.revokeClient({ clientId: box.store().bindings.get(kPinned).clientId, actor: "legacy" })],
  ])("loses the owner's trust on the next call after %s, without the bridge's demote", async (label, end) => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    end(ctx);
    expect((await ctx.call(run, "secrets", { action: "list" })).block, label).toBe(true);
    expect(ctx.call(run, "write", { path: ctx.openclawJson, content: "{}" }).block, label).toBe(true);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kPinned, messageId: run.messageId }), label).toBe(null);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true }).tier, label).toBe("peer");
  });

  it("follows a handoff: the running turn loses the pin at the new generation, and the successor's next message is pinned", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    const binding = ctx.store().bindings.get(kPinned);
    ctx.store().bindings.claim({ agent: kPinned, generation: binding.generation, threadId: "jam_successor", clientId: binding.clientId, webhookUrl: binding.webhookUrl, capabilityHash: "c".repeat(64), priorUntil: binding.until });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kPinned, messageId: run.messageId })).toBe(null);
    const successor = await ctx.deliver(kPinned);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kPinned, messageId: successor.messageId })).toBe("pinned_binding");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("ends the owner-thread stamp of a running turn once the pin is taken off the list, and keeps it a delegate", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    ctx.setConfig({});
    await ctx.tick();
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null });
    expect(ctx.bridgeLogs.some((line) => line.includes("owner thread ended reason=unpinned"))).toBe(true);
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
  });

  it("ends an attested thread's owner stamp the same way once its owner is taken off ALPHACLAW_RELAY_CAPY_OWNERS", async () => {
    ctx = setup();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    ctx.setConfig(capyEnv({ owners: "user_9" }));
    await ctx.tick();
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null, attestedOwner: null });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("refuses the pinned binding's changes to the trust anchor and its reads of the relay's keys, with no row", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    for (const [label, toolName, params] of [
      ["the pin list into .env", "exec", { command: "echo ALPHACLAW_RELAY_TRUSTED_BINDINGS=capy-ffffffffffff >> " + ctx.dotEnv }],
      ["the pin list through an edit", "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=1\nALPHACLAW_RELAY_TRUSTED_BINDINGS=capy-ffffffffffff" }],
      ["the relay guard's plugin entry", "exec", { command: "openclaw config set plugins.entries.relay-guard.enabled false" }],
      ["remote.db", "exec", { command: "sqlite3 " + path.join(ctx.rootDir, "relay", "remote.db") + " 'DELETE FROM relay_grants'" }],
    ]) {
      expectAnchor(await ctx.call(run, toolName, params), label);
    }
    for (const [label, toolName, params] of [
      ["read the relay's keys", "read", { path: path.join(ctx.rootDir, "relay", "secrets.json") }],
      ["cat the bridge database", "exec", { command: "cat " + path.join(ctx.rootDir, "relay", "bridge.db") }],
    ]) {
      const result = await ctx.call(run, toolName, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("is refused in every relay session");
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("still asks the owner when an unpinned delegate names the pin list", async () => {
    ctx = setup({ env: pinnedEnv() });
    const run = await ctx.deliver(other(ctx).agent);
    expectHeldWithTap(ctx, run, "exec", { command: "echo ALPHACLAW_RELAY_TRUSTED_BINDINGS=" + kOther + " >> " + ctx.dotEnv });
  });

  it("serves a box with both paths configured: an attested thread keeps its basis beside the pinned binding", async () => {
    ctx = setup({ env: { ...capyEnv(), ...pinnedEnv() } });
    const attested = await ctx.deliver((await ctx.attestedAgent()).agent);
    const pinned = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const sender = (run) => ctx.bridgeStore.get(run.messageId).sender;
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: sender(attested), messageId: attested.messageId })).toBe("attested");
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kPinned, messageId: pinned.messageId })).toBe("pinned_binding");
  });
});

describe("relay pinned binding (GST-2323 PR3): a gateway restart runs through AlphaClaw's ladder as relay:<agent>", () => {
  let ctx;
  let alphaclaw;
  const savedPort = process.env.PORT;
  afterEach(async () => {
    await alphaclaw?.close();
    alphaclaw = null;
    ctx?.cleanup();
    ctx = null;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  const startAlphaclaw = async (box) => {
    fs.writeFileSync(path.join(box.rootDir, "relay", "internal.secret"), kSecret, { mode: 0o600 });
    const asked = [];
    const app = express();
    app.use(express.json());
    registerRelayRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      relayService: { config: { enabled: true }, paths: relayPaths(box.rootDir), isInternalSecret: (value) => value === kSecret, isReady: () => true },
      requestGatewayRestart: (options) => {
        asked.push(options);
        return { operationId: "abcd1234-5678-op" };
      },
    });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    return { app, asked, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
  };

  it("restarts for the pinned binding's running turn only, recorded as relay:<agent>", async () => {
    ctx = setup({ env: pinnedEnv() });
    alphaclaw = await startAlphaclaw(ctx);
    process.env.PORT = String(alphaclaw.port);
    const pinned = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const unpinned = await ctx.deliver(other(ctx).agent);
    const post = (messageId) => request(alphaclaw.app).post("/relay/internal/gateway-restart").set("Authorization", "Bearer " + kSecret).send({ message_id: messageId });
    expect((await post(unpinned.messageId)).body).toMatchObject({ ok: false, code: "not_owner_thread" });
    expect(alphaclaw.asked).toEqual([]);
    const result = await ctx.call(pinned, "exec", { command: "openclaw gateway restart" });
    expect(result.blockReason).toContain("recorded as relay:" + kPinned);
    expect(alphaclaw.asked).toEqual([expect.objectContaining({ actor: "relay", source: "relay:" + kPinned, reason: "relay_message=" + pinned.messageId })]);
  });
});

describe("relay pinned binding (GST-2323 PR3): ALPHACLAW_RELAY_TRUSTED_BINDINGS", () => {
  it("is read from the deployment env only, empty by default, and keeps only capy-* names", () => {
    expect(readRelayConfig({ env: {} }).trustedBindings).toEqual([]);
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: " CAPY-25cf4e98b5b6, lupe,capy-25cf4e98b5b6,, __proto__" } })).toMatchObject({
      trustedBindings: [kPinned],
      trustedBindingsRejected: 2,
    });
    expect(require("../../lib/server/deployment-only-env").kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_RELAY_TRUSTED_BINDINGS");
  });

  it("says on the Doctor card when a pin entry did not fit, so a typo never looks like a pin", () => {
    const { buildRelayCards } = require("../../lib/server/relay/doctor-card");
    const [card] = buildRelayCards({ enabled: true, phase: "ready", settings: { delegateAgents: [], trustedBindingsRejected: 1 } });
    expect(card.summary).toContain("1 entry in ALPHACLAW_RELAY_TRUSTED_BINDINGS or ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS did not fit, so nothing is pinned for it.");
  });
});
