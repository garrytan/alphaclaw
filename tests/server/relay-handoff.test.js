const fs = require("fs");
const os = require("os");
const path = require("path");

const { openRemoteStore, sha256 } = require("../../lib/server/relay/remote-store");
const { createRemoteRelayTools } = require("../../lib/server/relay/remote-tools");
const { createWakeDelivery } = require("../../lib/server/relay/wake");

// Thread rotation (GST-2090): a binding moves to its successor thread through
// relay_handoff and relay_claim, fenced by a generation.
const kClient = "d1df4e9e-8f1b-4520-98f6-2db9ab5d035f";
const kOtherClient = "0b5c8f2e-2a4d-4f63-9c1a-7d2e9a6b1c40";
const kAgent = "capy-25cf4e98b5b6";
const kHour = 60 * 60 * 1000;
const kOldHook = "https://api.capy.ai/w/old";
const kNewHook = "https://api.capy.ai/w/new";
const quiet = { log: () => {}, warn: () => {} };

describe("relay handoff", () => {
  let dir;
  let store;
  let clock;
  afterEach(() => {
    store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const setup = ({ inbox = async () => ({ unread_dms: [] }) } = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handoff-"));
    clock = Date.now();
    const now = () => clock;
    store = openRemoteStore({ dbPath: path.join(dir, "remote.db"), now });
    for (const id of [kClient, kOtherClient]) {
      store.clients.insert({ client_id: id, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
      store.clients.markConsented(id);
    }
    store.bindings.upsert({ agent: kAgent, threadId: "jam_OLD", clientId: kClient, webhookUrl: kOldHook, until: clock + 7 * 24 * kHour, capabilityHash: sha256("arcap_old"), agentToken: "at_capy" });
    const engine = { inbox, dmConversations: async () => [], dmMessages: async () => [] };
    const tools = createRemoteRelayTools({
      engine,
      store,
      getWorkspaceKey: () => "rk",
      getConfig: () => ({ hourlyCap: 30, maxBindingsPerClient: 20, wakeHosts: ["api.capy.ai"], delegateAgents: [] }),
      now,
      logger: quiet,
    });
    const call = async (clientId, name, args) => {
      const result = await tools.call({ clientId, name, args });
      return JSON.parse(result.content[0].text);
    };
    return { tools, call };
  };

  it("the successor claims the binding with the one-time code and a fresh capability; the holder's stops working", async () => {
    const { call } = setup();
    const handed = await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" });
    expect(handed).toMatchObject({ agent: kAgent, successor_thread: "jam_NEW" });
    expect(handed.handoff_code).toMatch(/^arho_/);
    expect(JSON.stringify(store.handoffs.listPending())).not.toContain(handed.handoff_code);
    const claimed = await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: handed.handoff_code, thread_id: "jam_NEW", webhook_url: kNewHook });
    expect(claimed).toMatchObject({ agent: kAgent, generation: 2 });
    expect(claimed.capability).toMatch(/^arcap_/);
    expect(store.bindings.get(kAgent)).toMatchObject({ threadId: "jam_NEW", clientId: kOtherClient, webhookUrl: kNewHook, generation: 2 });
    expect(await call(kClient, "relay_inbox", { as: kAgent, capability: "arcap_old" })).toMatchObject({ error: "prefix_denied" });
    expect(await call(kOtherClient, "relay_inbox", { as: kAgent, capability: claimed.capability })).toEqual({ unread_dms: [] });
    expect(await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: handed.handoff_code, thread_id: "jam_NEW", webhook_url: kNewHook })).toMatchObject({ error: "handoff_invalid" });
    expect(store.recentAudit(10).map((row) => row.event)).toEqual(expect.arrayContaining(["handoff_created", "binding_claimed"]));
  });

  it("on one Capy connection (every thread shares the client) the holder's old capability stops working too", async () => {
    const { call } = setup();
    const code = (await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).handoff_code;
    const claimed = await call(kClient, "relay_claim", { as: kAgent, handoff_code: code, thread_id: "jam_NEW", webhook_url: kNewHook });
    expect(await call(kClient, "relay_inbox", { as: kAgent, capability: claimed.capability })).toEqual({ unread_dms: [] });
    expect(await call(kClient, "relay_inbox", { as: kAgent, capability: "arcap_old" })).toMatchObject({ error: "binding_capability_invalid" });
    expect(await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_X" })).toMatchObject({ error: "binding_capability_invalid" });
  });

  it("a claim whose answer was lost: the holder can hand off again until the successor's first call", async () => {
    const { call } = setup();
    const first = await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" });
    const lost = await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: first.handoff_code, thread_id: "jam_NEW", webhook_url: kNewHook });
    expect(lost.generation).toBe(2);
    const again = await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" });
    expect(again.handoff_code).toMatch(/^arho_/);
    const claimed = await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: again.handoff_code, thread_id: "jam_NEW", webhook_url: kNewHook });
    expect(claimed.generation).toBe(3);
    expect(claimed.capability).not.toBe(lost.capability);
    expect(await call(kOtherClient, "relay_inbox", { as: kAgent, capability: lost.capability })).toMatchObject({ error: "binding_capability_invalid" });
    expect(await call(kOtherClient, "relay_inbox", { as: kAgent, capability: claimed.capability })).toEqual({ unread_dms: [] });
    // The successor's first call ended the holder's re-issue right.
    expect(await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).toMatchObject({ error: "prefix_denied" });
  });

  it("the re-issue right ends after an hour even if the successor never calls", async () => {
    const { call } = setup();
    const first = await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" });
    await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: first.handoff_code, thread_id: "jam_NEW", webhook_url: kNewHook });
    clock += kHour + 1;
    expect(await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).toMatchObject({ error: "prefix_denied" });
  });

  it("refuses a code for another successor, an expired code, a stale generation and a successor that has its own binding", async () => {
    const { call } = setup();
    const code = (await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).handoff_code;
    expect(await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: code, thread_id: "jam_OTHER", webhook_url: kNewHook })).toMatchObject({ error: "handoff_invalid" });
    store.bindings.upsert({ agent: "capy-000000000002", threadId: "jam_NEW", clientId: kOtherClient, webhookUrl: kNewHook, until: clock + kHour, capabilityHash: "h", agentToken: "t" });
    expect(await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: code, thread_id: "jam_NEW", webhook_url: kNewHook })).toMatchObject({ error: "handoff_conflict" });
    store.bindings.remove("capy-000000000002");
    store.db.prepare("UPDATE relay_bindings SET generation = generation + 1 WHERE agent = ?").run(kAgent);
    expect(await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: code, thread_id: "jam_NEW", webhook_url: kNewHook })).toMatchObject({ error: "generation_stale" });
    const fresh = (await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).handoff_code;
    clock += kHour + 1;
    expect(await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: fresh, thread_id: "jam_NEW", webhook_url: kNewHook })).toMatchObject({ error: "handoff_invalid" });
    expect(store.bindings.get(kAgent)).toMatchObject({ threadId: "jam_OLD", clientId: kClient });
  });

  it("a renew that was in flight when the binding was claimed is refused and does not move the wakes back", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let calls = 0;
    const { call } = setup({
      inbox: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { unread_dms: [] };
      },
    });
    const renew = call(kClient, "relay_bind", { thread_id: "jam_OLD", webhook_url: "https://api.capy.ai/w/renewed", capability: "arcap_old" });
    await new Promise((resolve) => setImmediate(resolve));
    const code = (await call(kClient, "relay_handoff", { as: kAgent, capability: "arcap_old", successor_thread: "jam_NEW" })).handoff_code;
    await call(kOtherClient, "relay_claim", { as: kAgent, handoff_code: code, thread_id: "jam_NEW", webhook_url: kNewHook });
    release();
    expect(await renew).toMatchObject({ error: "generation_stale" });
    expect(store.bindings.get(kAgent)).toMatchObject({ webhookUrl: kNewHook, generation: 2 });
  });

  it("a wake whose binding was claimed during the lookup waits and then goes to the successor", async () => {
    setup();
    const posts = [];
    let claimDuringLookup = null;
    const wake = createWakeDelivery({
      store,
      getConfig: () => ({ wakeHosts: ["api.capy.ai"] }),
      now: () => clock,
      lookup: async () => {
        if (claimDuringLookup) {
          claimDuringLookup();
          claimDuringLookup = null;
        }
        return [{ address: "34.120.1.1", family: 4 }];
      },
      requestImpl: (options, onResponse) => {
        const { EventEmitter } = require("events");
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = (body) => {
          posts.push({ path: options.path, body: JSON.parse(body) });
          const res = new EventEmitter();
          res.statusCode = 202;
          res.resume = () => {};
          setImmediate(() => {
            onResponse(res);
            res.emit("end");
          });
        };
        return req;
      },
      logger: quiet,
    });
    claimDuringLookup = () =>
      store.bindings.claim({ agent: kAgent, generation: 1, threadId: "jam_NEW", clientId: kOtherClient, webhookUrl: kNewHook, capabilityHash: "h2", priorUntil: clock + kHour });
    wake.enqueue({ agent: kAgent, message: { id: "900", agent_name: "wintermute", text: "done", metadata: { relay_lane: "gbrain" } } });
    wake.start();
    for (let index = 0; index < 40 && posts.length < 1; index += 1) await new Promise((resolve) => setImmediate(resolve));
    wake.stop();
    expect(posts).toEqual([expect.objectContaining({ path: "/w/new", body: expect.objectContaining({ message_id: "900", lane: "gbrain", generation: 2 }) })]);
  });
});
