const express = require("express");
const request = require("supertest");
const { registerRelayRoutes } = require("../../lib/server/routes/relay");
const { findOp } = require("../../lib/server/admin-manifest");

const createRelayService = ({ ready = true, enabled = true } = {}) => ({
  config: { enabled },
  isReady: () => ready,
  getStatus: () => ({ enabled, phase: ready ? "ready" : "provisioning", agentName: "wintermute", engine: { version: "12.8.0" } }),
  getAuth: () => ({ workspaceKey: "rk_live_secret", agentToken: "at_live_secret", agentName: "wintermute" }),
  dbSizes: () => ({ engine: 4096, bridge: 1024 }),
  engine: {
    listAgents: async () => [{ name: "wintermute", status: "active", last_seen: "2026-11-06T10:00:00Z" }, { name: "capy-1" }],
    presence: async () => [{ agent_name: "capy-1", status: "online" }],
    consoleMessages: async (key, query) => [
      { id: "900", message_id: "77", agent_name: "capy-1", delivery_kind: "dm", text: "secret plans", metadata: { target_agent: "wintermute" }, created_at: "2026-11-06T10:00:00Z" },
    ].slice(0, query.limit),
  },
  getStore: () => ({
    counts: () => ({ answered: 1 }),
    recent: () => [{ messageId: "77", sender: "capy-1", state: "answered", code: null, hop: 0, attempts: 1, receivedAt: 1, dispatchedAt: 2, endedAt: 3, replyMessageId: "78", sessionKey: "agent:main:relay-capy-1" }],
  }),
});

const appWith = (relayService) => {
  const app = express();
  registerRelayRoutes({ app, requireAuth: (req, res, next) => next(), relayService });
  return app;
};

describe("relay routes", () => {
  it("status carries the roster and sizes, shows the box agent online while the relay is ready, and never a key or token", async () => {
    const res = await request(appWith(createRelayService())).get("/api/relay/status");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([
      { name: "wintermute", online: true, lastSeen: "2026-11-06T10:00:00Z", createdAt: null },
      { name: "capy-1", online: true, lastSeen: null, createdAt: null },
    ]);
    expect(res.body.dbBytes).toEqual({ engine: 4096, bridge: 1024 });
    expect(JSON.stringify(res.body)).not.toMatch(/rk_live|at_live/);
  });

  it("messages pages the audit log and validates the cursor", async () => {
    const app = appWith(createRelayService());
    const res = await request(app).get("/api/relay/messages?limit=1");
    expect(res.body.messages).toEqual([
      expect.objectContaining({ id: "900", messageId: "77", from: "capy-1", to: "wintermute", text: "secret plans" }),
    ]);
    expect(res.body.nextBefore).toBe("900");
    const bad = await request(app).get("/api/relay/messages?before=abc");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_input");
  });

  it("messages answers a coded problem while the relay is not ready or off", async () => {
    expect((await request(appWith(createRelayService({ ready: false }))).get("/api/relay/messages")).body.code).toBe("provisioning_pending");
    const off = await request(appWith(createRelayService({ ready: false, enabled: false }))).get("/api/relay/messages");
    expect(off.status).toBe(503);
    expect(off.body.code).toBe("relay_disabled");
  });

  it("runs lists bridged states", async () => {
    const res = await request(appWith(createRelayService())).get("/api/relay/runs");
    expect(res.body.runs[0]).toMatchObject({ messageId: "77", from: "capy-1", state: "answered", sessionKey: "agent:main:relay-capy-1" });
  });

  it("the agent actor reads every relay op but never a message body", () => {
    for (const id of ["relay.status", "relay.messages", "relay.runs"]) {
      expect(findOp("GET", "/api/relay/" + id.split(".")[1])?.tier).toBe("safe");
    }
    const op = findOp("GET", "/api/relay/messages");
    const redacted = op.redactResponse({ ok: true, messages: [{ id: "1", from: "a", text: "secret plans" }] });
    expect(redacted).toEqual({ ok: true, bodiesHidden: true, messages: [{ id: "1", from: "a", textChars: 12 }] });
  });
});


describe("relay conversations (ALPH-68)", () => {
  const conversationService = () => {
    const service = createRelayService();
    service.resolveAgentId = () => "main";
    service.engine.conversations = async () => [
      { id: "dm_a", type: "1:1", participants: ["wintermute", "capy-1"], message_count: 2, last_message: { text: "pong", agent_name: "wintermute", created_at: "2026-11-06T10:00:05Z" } },
      { id: "dm_b", type: "1:1", participants: ["capy-2", "capy-3"], message_count: 1, last_message: { text: "between peers", agent_name: "capy-2", created_at: "2026-11-05T09:00:00Z" } },
    ];
    service.engine.consoleMessages = async (key, query) => {
      const rows = [
        { id: "901", message_id: "77", agent_name: "capy-1", conversation_id: "dm_a", text: "ping about deploys", metadata: { target_agent: "wintermute" }, created_at: "2026-11-06T10:00:00Z" },
        { id: "800", message_id: "66", agent_name: "capy-2", conversation_id: "dm_b", text: "between peers", metadata: {}, created_at: "2026-11-05T09:00:00Z" },
      ];
      return rows.filter((row) => !query.conversation_id || row.conversation_id === query.conversation_id).slice(0, query.limit);
    };
    service.engine.thread = async (key, id) =>
      id === "77"
        ? { replies: [{ id: "78", agent_name: "wintermute", thread_id: "77", text: "pong", metadata: { relay_status: "answered", relay_in_reply_to: "77" }, created_at: "2026-11-06T10:00:05Z" }] }
        : { replies: [] };
    const baseStore = service.getStore();
    const bridgeRow = { messageId: "77", sender: "capy-1", conversationId: "dm_a", state: "answered", code: null, hop: 0, sessionKey: "agent:main:relay-capy-1", receivedAt: 1, endedAt: 2 };
    service.getStore = () => ({ ...baseStore, listByConversation: (id) => (id === "dm_a" ? [bridgeRow] : []), latestPerConversation: () => [bridgeRow] });
    return service;
  };
  const appWithSessions = (service, sessions) => {
    const app = express();
    registerRelayRoutes({ app, requireAuth: (req, res, next) => next(), relayService: service, listSessionRows: async () => sessions });
    return app;
  };

  it("lists conversations by agent pair, newest first, with the bridge status and the box's relay session", async () => {
    const res = await request(appWithSessions(conversationService(), [
      { key: "agent:main:relay-capy-old", updatedAt: Date.parse("2026-10-01T00:00:00Z") },
      { key: "agent:main:relay-capy-1", updatedAt: Date.parse("2026-11-06T10:00:05Z") },
      { key: "agent:main:main", updatedAt: 5 },
    ])).get("/api/relay/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((item) => item.id)).toEqual(["dm_a", "dm_b", "session:agent:main:relay-capy-old"]);
    expect(res.body.conversations[0]).toMatchObject({ peer: "capy-1", messageCount: 2, lastStatus: "answered", sessionKey: "agent:main:relay-capy-1", lastText: "pong" });
    expect(res.body.conversations[1]).toMatchObject({ participants: ["capy-2", "capy-3"], peer: null, sessionKey: null });
    expect(res.body.conversations[2]).toMatchObject({ sessionOnly: true, peer: "capy-old", sessionKey: "agent:main:relay-capy-old" });
    expect(JSON.stringify(res.body)).not.toMatch(/rk_live|at_live/);
  });

  it("filters by agent, text and date, pages with a cursor, and validates its inputs", async () => {
    const app = appWithSessions(conversationService(), []);
    expect((await request(app).get("/api/relay/conversations?agent=capy-3")).body.conversations.map((item) => item.id)).toEqual(["dm_b"]);
    expect((await request(app).get("/api/relay/conversations?q=deploys")).body.conversations.map((item) => item.id)).toEqual(["dm_a"]);
    expect((await request(app).get("/api/relay/conversations?from=2026-11-06")).body.conversations.map((item) => item.id)).toEqual(["dm_a"]);
    expect((await request(app).get("/api/relay/conversations?from=2026-11-06&to=2026-11-06")).body.conversations.map((item) => item.id)).toEqual(["dm_a"]);
    const first = (await request(app).get("/api/relay/conversations?limit=1")).body;
    expect(first.conversations.map((item) => item.id)).toEqual(["dm_a"]);
    const next = (await request(app).get("/api/relay/conversations?limit=1&before=" + encodeURIComponent(first.nextBefore))).body;
    expect(next.conversations.map((item) => item.id)).toEqual(["dm_b"]);
    expect((await request(app).get("/api/relay/conversations?agent=bad%20name")).status).toBe(400);
    expect((await request(app).get("/api/relay/conversations?from=yesterday")).status).toBe(400);
    expect((await request(appWith(createRelayService({ ready: false }))).get("/api/relay/conversations")).body.code).toBe("provisioning_pending");
  });

  it("returns one conversation's transcript, both sides, oldest first, with relay status and bridge state", async () => {
    const app = appWithSessions(conversationService(), []);
    const res = await request(app).get("/api/relay/conversations/dm_a");
    expect(res.status).toBe(200);
    expect(res.body.sessionKey).toBe("agent:main:relay-capy-1");
    expect(res.body.messages).toEqual([
      expect.objectContaining({ id: "77", from: "capy-1", text: "ping about deploys", bridge: expect.objectContaining({ state: "answered" }) }),
      expect.objectContaining({ id: "78", from: "wintermute", text: "pong", relayStatus: "answered", inReplyTo: "77" }),
    ]);
    expect((await request(app).get("/api/relay/conversations/..%2Fx")).status).toBe(400);
  });

  it("refuses a text search from the agent actor, which never receives the text it would test for", async () => {
    const app = express();
    registerRelayRoutes({
      app,
      requireAuth: (req, res, next) => {
        req.alphaclawActor = { type: "agent" };
        next();
      },
      relayService: conversationService(),
      listSessionRows: async () => [],
    });
    const searched = await request(app).get("/api/relay/conversations?q=deploys");
    expect(searched.status).toBe(400);
    expect(JSON.stringify(searched.body)).not.toContain("dm_a");
    expect((await request(app).get("/api/relay/conversations")).status).toBe(200);
  });

  it("the agent actor reads conversations as metadata only: no text, no session key", () => {
    const list = findOp("GET", "/api/relay/conversations");
    const one = findOp("GET", "/api/relay/conversations/dm_a");
    expect(list?.tier).toBe("safe");
    expect(one?.tier).toBe("safe");
    const redactedList = list.redactResponse({ ok: true, conversations: [{ id: "dm_a", participants: ["a", "b"], lastText: "secret plans", sessionKey: "agent:main:relay-b", lastStatus: "answered" }] });
    expect(redactedList.conversations).toEqual([{ id: "dm_a", participants: ["a", "b"], lastStatus: "answered", lastTextChars: 12 }]);
    const redactedOne = one.redactResponse({
      ok: true,
      sessionKey: "agent:main:relay-b",
      messages: [{ id: "1", from: "a", text: "secret plans", bridge: { state: "answered", code: null, hop: 0, sessionKey: "agent:main:relay-b", receivedAt: null, endedAt: null } }],
    });
    expect(redactedOne).not.toHaveProperty("sessionKey");
    expect(JSON.stringify(redactedOne)).not.toMatch(/secret plans|relay-b/);
    expect(redactedOne.messages[0].textChars).toBe(12);
  });
});


describe("relay brain archive route (ALPH-68 PR3)", () => {
  const archiveService = () => {
    const service = createRelayService();
    service.retryArchive = vi.fn(() => ({ retried: 2 }));
    service.getStatus = () => ({ enabled: true, phase: "ready", archive: { enabled: true, phase: "ready", code: null, parked: [] } });
    return service;
  };

  it("Retry is for signed-in people: a human retries, the agent actor is refused and the op is not in the manifest", async () => {
    const service = archiveService();
    const human = await request(appWith(service)).post("/api/relay/archive/retry");
    expect(human.status).toBe(200);
    expect(human.body).toMatchObject({ ok: true, retried: 2, archive: { phase: "ready" } });
    const app = express();
    app.use((req, res, next) => {
      req.alphaclawActor = { type: "agent" };
      next();
    });
    registerRelayRoutes({ app, requireAuth: (req, res, next) => next(), relayService: service });
    const agent = await request(app).post("/api/relay/archive/retry");
    expect(agent.status).toBe(403);
    expect(agent.body.code).toBe("admin_required");
    expect(service.retryArchive).toHaveBeenCalledTimes(1);
    expect(findOp("POST", "/api/relay/archive/retry")).toBeFalsy();
  });

  it("Retry before the relay is ready answers a coded problem", async () => {
    const service = createRelayService({ ready: false });
    service.retryArchive = () => null;
    const res = await request(appWith(service)).post("/api/relay/archive/retry");
    expect(res.body.code).toBe("provisioning_pending");
  });
});
