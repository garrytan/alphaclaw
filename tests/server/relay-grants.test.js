const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { resolveGrant, normalizeLane } = require("../../lib/plugin/relay-guard/grants");
const { resolveRelayTrust } = require("../../lib/plugin/relay-guard/trust");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { openRemoteStore, sha256 } = require("../../lib/server/relay/remote-store");
const { createRemoteRelayTools } = require("../../lib/server/relay/remote-tools");
const { createRelayRemote } = require("../../lib/server/relay/remote");
const { registerRelayRemoteRoutes } = require("../../lib/server/routes/relay-remote");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { relayPaths } = require("../../lib/server/relay/constants");

// Relay trust v2 (GST-2090): grants in remote.db decide who acts as the
// owner; a revoked grant is a tombstone the env list cannot undo.
const kClient = "d1df4e9e-8f1b-4520-98f6-2db9ab5d035f";
const kAgent = "capy-25cf4e98b5b6";
const kHour = 60 * 60 * 1000;
const live = { agent: kAgent, clientId: kClient, until: Date.now() + kHour, deadAt: null };
const consented = { consentedAt: 1, revokedAt: null };
const grant = (fields = {}) => ({ tier: "delegate", createdAt: 1, revokedAt: null, ...fields, id: "rg_" + (fields.id || "a") });
const quiet = { log: () => {}, warn: () => {} };

describe("relay grants: the classifier", () => {
  const decide = (fields) => resolveGrant({ binding: live, client: consented, now: Date.now(), ...fields });

  it.each([
    ["a live delegate grant", { grants: [grant()] }, "delegate", "grant"],
    ["no grant and not on the env list", { grants: [], fallbackAgents: [] }, "peer", "no_grant"],
    ["no grant row at all and on the env list", { grants: [], fallbackAgents: [kAgent] }, "delegate", "env_fallback"],
    ["a revoked grant and on the env list", { grants: [grant({ revokedAt: 5 })], fallbackAgents: [kAgent] }, "peer", "grant_revoked"],
    ["a revoked grant and a later re-grant", { grants: [grant({ revokedAt: 5 }), grant({ id: "b", createdAt: 6 })] }, "delegate", "grant"],
    ["overlapping live peer and delegate grants", { grants: [grant(), grant({ id: "b", tier: "peer" })] }, "peer", "grant_peer"],
    ["a caller list that names someone else", { grants: [grant()], narrowTo: ["capy-other"] }, "peer", "agent_not_delegate"],
    ["a caller list that is empty", { grants: [grant()], narrowTo: [] }, "peer", "delegates_off"],
  ])("%s", (_label, fields, trust, reason) => {
    expect(decide(fields)).toMatchObject({ trust, reason });
  });

  it("a caller list can only narrow: it never makes an ungranted agent a delegate", () => {
    expect(decide({ grants: [], fallbackAgents: [], narrowTo: [kAgent] })).toMatchObject({ trust: "peer", reason: "no_grant" });
  });

  it("the newest of two live delegate grants decides, with its limits", () => {
    const verdict = decide({ grants: [grant({ lanesMax: 2 }), grant({ id: "b", createdAt: 9, lanesMax: 5, hourlyCap: 12 })] });
    expect(verdict).toMatchObject({ trust: "delegate", grantId: "rg_b", lanesMax: 5, hourlyCap: 12, requireRoute: "any" });
  });

  it("a dead, expired or revoked binding is a peer whatever the grants say", () => {
    expect(decide({ grants: [grant()], binding: { ...live, deadAt: 1 } }).reason).toBe("binding_dead");
    expect(decide({ grants: [grant()], binding: { ...live, until: 1 } }).reason).toBe("binding_expired");
    expect(decide({ grants: [grant()], client: { consentedAt: 1, revokedAt: 2 } }).reason).toBe("client_revoked");
    expect(decide({ grants: [grant()], binding: null }).reason).toBe("not_bound");
  });

  it("a lane is a short slug or the default lane, never a guess", () => {
    expect(normalizeLane(undefined)).toBeNull();
    expect(normalizeLane("")).toBeNull();
    expect(normalizeLane("GBrain")).toBe("gbrain");
    expect(() => normalizeLane("../x")).toThrow(/lane must be/);
    expect(() => normalizeLane("a".repeat(25))).toThrow(/lane must be/);
  });
});

const makeBox = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-grants-"));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const bridge = openBridgeStore({ dbPath: paths.bridgeDb });
  const remote = openRemoteStore({ dbPath: paths.remoteDb });
  remote.clients.insert({ client_id: kClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
  remote.clients.markConsented(kClient);
  remote.bindings.upsert({ agent: kAgent, threadId: "jam_A", clientId: kClient, webhookUrl: "https://api.capy.ai/w/x", until: Date.now() + kHour, capabilityHash: sha256("arcap_test"), agentToken: "at_capy" });
  const running = ({ id, lane = null, grantId = null }) => {
    const sessionKey = "agent:main:relay-" + kAgent + (lane ? ":lane-" + lane : "");
    bridge.insert({ messageId: id, sender: kAgent, conversationId: "dm_1", threadRoot: id, sessionKey, state: "queued", lane });
    bridge.update(id, { state: "dispatched", runId: "relay-" + id, trust: "delegate", grantId, dispatchedAt: Date.now() });
    return { sessionKey, runId: "relay-" + id };
  };
  return { rootDir, paths, bridge, remote, running, cleanup: () => { bridge.close(); remote.close(); fs.rmSync(rootDir, { recursive: true, force: true }); } };
};

describe("relay grants: the store and the shared trust lookup", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("the env-list import adds a grant once, and never for an agent with a revoked grant", () => {
    box = makeBox();
    const [imported] = box.remote.grants.importAgents([kAgent]);
    expect(imported).toMatchObject({ tier: "delegate", createdBy: "env:ALPHACLAW_RELAY_DELEGATE_AGENTS", principal: { agent: kAgent } });
    expect(box.remote.grants.importAgents([kAgent])).toEqual([]);
    box.remote.grants.revoke(imported.id, "admin");
    expect(box.remote.grants.importAgents([kAgent])).toEqual([]);
    expect(box.remote.grants.forAgent(kAgent)).toHaveLength(1);
    expect(box.remote.recentAudit(5).map((row) => row.event)).toEqual(["grant_imported"]);
  });

  it("the wm-guards call shape answers delegate for an imported grant, and peer on every lane after a revoke", () => {
    box = makeBox();
    const [imported] = box.remote.grants.importAgents([kAgent]);
    const gbrain = box.running({ id: "700", lane: "gbrain", grantId: imported.id });
    const evals = box.running({ id: "701", lane: "evals", grantId: imported.id });
    for (const run of [gbrain, evals]) {
      expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId })).toMatchObject({
        tier: "delegate",
        sender: kAgent,
        grantId: imported.id,
        approvalState: "none",
      });
    }
    expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: gbrain.sessionKey, runId: gbrain.runId }).lane).toBe("gbrain");
    box.remote.grants.revoke(imported.id, "admin");
    for (const run of [gbrain, evals]) {
      expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId })).toMatchObject({ tier: "peer", reason: "grant_revoked" });
      // The relay guard passes the env list as its fallback: a revoke still wins.
      expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId, fallbackAgents: [kAgent] })).toMatchObject({ tier: "peer", reason: "grant_revoked" });
    }
  });

  it("a row stamped under a revoked grant stays a peer even when a new grant is added", () => {
    box = makeBox();
    const first = box.remote.grants.create({ agent: kAgent, createdBy: "admin" });
    const run = box.running({ id: "710", grantId: first.id });
    box.remote.grants.revoke(first.id, "admin");
    box.remote.grants.create({ agent: kAgent, createdBy: "admin" });
    expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId })).toMatchObject({ tier: "peer", reason: "grant_revoked" });
  });

  it("the relay guard's env list alone does not make an ungranted agent a delegate once grants exist", () => {
    box = makeBox();
    const run = box.running({ id: "720" });
    expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId, fallbackAgents: [] })).toMatchObject({ tier: "peer", reason: "no_grant" });
    expect(resolveRelayTrust({ rootDir: box.rootDir, sessionKey: run.sessionKey, runId: run.runId, fallbackAgents: [kAgent] })).toMatchObject({ tier: "delegate" });
  });
});

describe("relay grants: remote tools", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  const toolsFor = ({ delegateAgents = [] } = {}) => {
    const sent = [];
    const engine = {
      sendDm: async (token, to, text, metadata) => {
        sent.push({ to, text, metadata });
        return { conversation_id: "dm_1", message: { id: String(1000 + sent.length) } };
      },
      inbox: async () => ({ unread_dms: [] }),
      dmConversations: async () => [],
      dmMessages: async () => [],
    };
    const set = createRemoteRelayTools({
      engine,
      store: box.remote,
      getWorkspaceKey: () => "rk",
      getConfig: () => ({ hourlyCap: 30, maxBindingsPerClient: 20, wakeHosts: ["api.capy.ai"], delegateAgents }),
      getResult: (ref) => box.bridge.getResult(ref),
      logger: quiet,
    });
    const call = async (name, args = {}, route = "public") => {
      const result = await set.call({ clientId: kClient, name, args: { as: kAgent, capability: "arcap_test", ...args }, route });
      return { result, body: JSON.parse(result.content[0].text) };
    };
    return { sent, call };
  };

  it("a grant's hourly cap counts per grant, and the send carries lane, route and generation", async () => {
    box = makeBox();
    box.remote.grants.create({ agent: kAgent, hourlyCap: 2, createdBy: "admin" });
    const { sent, call } = toolsFor();
    expect((await call("relay_send", { to: "wintermute", text: "one", lane: "gbrain" })).body).toMatchObject({ trust: "delegate", reason: "grant", lane: "gbrain" });
    expect(sent[0].metadata).toEqual({ relay_route: "public", relay_generation: 1, relay_lane: "gbrain", relay_hop: 0 });
    await call("relay_send", { to: "wintermute", text: "two" });
    const third = await call("relay_send", { to: "wintermute", text: "three" });
    expect(third.body).toMatchObject({ error: "rate_limited" });
    expect((await call("relay_send", { to: "wintermute", text: "x", lane: "Not a lane!" })).body).toMatchObject({ error: "invalid_input" });
  });

  it("a grant that requires the tailnet refuses every call of its binding on the public route, reads and renewals included", async () => {
    box = makeBox();
    box.remote.grants.create({ agent: kAgent, requireRoute: "tailnet", createdBy: "admin" });
    const { sent, call } = toolsFor();
    for (const [name, args] of [
      ["relay_send", { to: "wintermute", text: "hi" }],
      ["relay_inbox", {}],
      ["relay_history", { with: "wintermute" }],
      ["relay_result", { result_ref: "rr_" + "a".repeat(24) }],
      ["relay_handoff", { successor_thread: "jam_B" }],
      ["relay_unbind", {}],
      ["relay_bind", { thread_id: "jam_A", webhook_url: "https://api.capy.ai/w/y", capability: "arcap_test" }],
    ]) {
      expect((await call(name, args)).body, name).toMatchObject({ error: "route_required" });
    }
    expect(sent).toEqual([]);
    expect(box.remote.bindings.get(kAgent).webhookUrl).toBe("https://api.capy.ai/w/x");
  });

  it("relay_result returns a stored part to the agent it answered only", async () => {
    box = makeBox();
    box.bridge.saveResult({ ref: "rr_" + "b".repeat(24), messageId: "800", sender: kAgent, lane: "evals", parts: ["one", "two", "three"] });
    box.bridge.saveResult({ ref: "rr_" + "c".repeat(24), messageId: "801", sender: "capy-000000000002", parts: ["x", "y"] });
    const { call } = toolsFor();
    expect((await call("relay_result", { result_ref: "rr_" + "b".repeat(24) })).body).toEqual({ result_ref: "rr_" + "b".repeat(24), part: 2, parts: 3, lane: "evals", text: "two" });
    expect((await call("relay_result", { result_ref: "rr_" + "b".repeat(24), part: 3 })).body.text).toBe("three");
    expect((await call("relay_result", { result_ref: "rr_" + "b".repeat(24), part: 4 })).body).toMatchObject({ error: "invalid_input" });
    expect((await call("relay_result", { result_ref: "rr_" + "c".repeat(24) })).body).toMatchObject({ error: "result_not_found" });
    expect((await call("relay_result", { result_ref: "nope" })).body).toMatchObject({ error: "result_not_found" });
  });
});

describe("relay grants: the remote side and the owner's routes", () => {
  let rootDir;
  let remote;
  afterEach(() => {
    remote?.stop();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const setup = (env = {}) => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-grants-remote-"));
    const paths = relayPaths(rootDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    const demoted = [];
    const relayService = {
      config: readRelayConfig({ env }),
      paths,
      engine: {},
      isReady: () => true,
      getAuth: () => ({ workspaceKey: "rk" }),
      demoteSender: async (agent, reason) => demoted.push([agent, reason]),
    };
    remote = createRelayRemote({ relayService, getPublicUrl: () => "https://box.relay.test", logger: quiet });
    const { store } = remote.ensureOpen();
    store.clients.insert({ client_id: kClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
    store.clients.markConsented(kClient);
    store.bindings.upsert({ agent: kAgent, threadId: "jam_A", clientId: kClient, webhookUrl: "https://api.capy.ai/w/x", until: Date.now() + kHour, capabilityHash: "h", agentToken: "t" });
    let actor = { type: "human" };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.alphaclawActor = actor;
      next();
    });
    registerRelayRemoteRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      requireAdmin: (req, res, next) => next(),
      resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }),
      relayRemote: remote,
      logger: quiet,
    });
    return { app, store, demoted, setActor: (value) => (actor = value) };
  };

  it("a grant added on the Relay page makes the next message a delegate; a revoke demotes the sender and survives a reboot", async () => {
    const ctx = setup({ ALPHACLAW_RELAY_DELEGATE_AGENTS: "" });
    expect(remote.resolveDelegate(kAgent)).toMatchObject({ trust: "peer", reason: "no_grant" });
    const added = await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent });
    expect(added.status).toBe(200);
    expect(remote.resolveDelegate(kAgent)).toMatchObject({ trust: "delegate", reason: "grant", grantId: added.body.grant.id, generation: 1 });
    const status = remote.getStatus();
    expect(status.grants).toEqual([expect.objectContaining({ id: added.body.grant.id, agent: kAgent, tier: "delegate", revokedAt: null })]);
    expect(status.bindings[0]).toMatchObject({ tier: "delegate", grantId: added.body.grant.id, generation: 1 });
    const revoked = await request(ctx.app).post("/api/relay/remote/grants/" + added.body.grant.id + "/revoke");
    expect(revoked.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.demoted).toEqual([[kAgent, "grant_revoked"]]);
    remote.stop();
    // A reboot with the agent on the env list: the tombstone wins.
    remote = createRelayRemote({
      relayService: { config: readRelayConfig({ env: { ALPHACLAW_RELAY_DELEGATE_AGENTS: kAgent } }), paths: relayPaths(rootDir), engine: {}, isReady: () => true, getAuth: () => ({}) },
      getPublicUrl: () => "https://box.relay.test",
      logger: quiet,
    });
    expect(remote.resolveDelegate(kAgent)).toMatchObject({ trust: "peer", reason: "grant_revoked" });
  });

  it("a second delegate grant for a delegate is refused, so one revoke on the page makes it a peer", async () => {
    const ctx = setup({ ALPHACLAW_RELAY_DELEGATE_AGENTS: "" });
    const added = await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent });
    expect(added.status).toBe(200);
    const again = await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("invalid_input");
    expect(ctx.store.grants.forAgent(kAgent)).toHaveLength(1);
    expect((await request(ctx.app).post("/api/relay/remote/grants/" + added.body.grant.id + "/revoke")).status).toBe(200);
    expect(remote.resolveDelegate(kAgent)).toMatchObject({ trust: "peer", reason: "grant_revoked" });
    expect((await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent })).status).toBe(200);
    expect(remote.resolveDelegate(kAgent)).toMatchObject({ trust: "delegate", reason: "grant" });
  });

  it("the agent actor cannot add or revoke a grant, and bad input is refused", async () => {
    const ctx = setup();
    ctx.setActor({ type: "agent" });
    expect((await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent })).status).toBe(403);
    expect(ctx.store.grants.list()).toEqual([]);
    ctx.setActor({ type: "human" });
    expect((await request(ctx.app).post("/api/relay/remote/grants").send({ agent: "wintermute" })).status).toBe(400);
    expect((await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent, tier: "root" })).status).toBe(400);
    expect((await request(ctx.app).post("/api/relay/remote/grants").send({ agent: kAgent, lanesMax: 99 })).status).toBe(400);
    expect((await request(ctx.app).post("/api/relay/remote/grants/rg_nope/revoke")).status).toBe(400);
    expect((await request(ctx.app).post("/api/relay/remote/grants/rg_0123456789abcdef/revoke")).status).toBe(404);
  });
});
