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
  it("status carries the roster and sizes and never a key or token", async () => {
    const res = await request(appWith(createRelayService())).get("/api/relay/status");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([
      { name: "wintermute", online: false, lastSeen: "2026-11-06T10:00:00Z", createdAt: null },
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
