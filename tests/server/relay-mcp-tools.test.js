const { createRelayTools, kToolDefinitions } = require("../../lib/server/relay/mcp-tools");
const { createRelayMcpServer } = require("../../lib/server/relay/mcp-stdio");

const parse = (result) => JSON.parse(result.content[0].text);

const createEngine = () => ({
  sendDm: vi.fn(async (token, to) => {
    if (to === "ghost") throw Object.assign(new Error("agent_not_found"), { engineStatus: 404 });
    return { conversation_id: "dm_1", message: { id: "11" } };
  }),
  reply: vi.fn(async () => ({ id: "12" })),
  inbox: vi.fn(async () => ({ unread_dms: [] })),
  dmConversations: vi.fn(async () => [
    { id: "dm_1", participants: [{ agent_name: "wintermute" }, { agent_name: "capy-1" }] },
    { id: "grp", participants: [{ agent_name: "wintermute" }, { agent_name: "capy-1" }, { agent_name: "x" }] },
  ]),
  dmMessages: vi.fn(async () => [
    { id: "20", agent_name: "capy-1", text: "second", created_at: "2026-11-06T10:00:01Z" },
    { id: "19", agent_name: "wintermute", text: "first", created_at: "2026-11-06T10:00:00Z", metadata: { relay_status: "answered" } },
  ]),
  listAgents: vi.fn(async () => [{ name: "wintermute" }, { name: "capy-1" }]),
  presence: vi.fn(async () => [{ agent_name: "capy-1", status: "online" }]),
});

const auth = () => ({ workspaceKey: "rk_live_x", agentToken: "at_live_x", agentName: "wintermute" });

describe("relay tools", () => {
  it("is exactly the messaging set: no workspace, key, agent removal, webhook or spawn tool", () => {
    expect(kToolDefinitions.map((tool) => tool.name)).toEqual(["relay_send", "relay_reply", "relay_inbox", "relay_history", "relay_agents"]);
    for (const tool of kToolDefinitions) {
      expect(tool.name).not.toMatch(/workspace|key|remove|delete|webhook|spawn|register|rotate/);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("relay_send sends as the box agent with a fresh hop count", async () => {
    const engine = createEngine();
    const tools = createRelayTools({ engine, getAuth: auth });
    expect(parse(await tools.call("relay_send", { to: "Capy-1", text: "hi" }))).toEqual({ message_id: "11", to: "capy-1", conversation_id: "dm_1" });
    expect(engine.sendDm).toHaveBeenCalledWith("at_live_x", "capy-1", "hi", { relay_hop: 0 });
  });

  it("validates input and maps engine errors to relay codes", async () => {
    const tools = createRelayTools({ engine: createEngine(), getAuth: auth });
    const codeOf = async (name, args) => JSON.parse((await tools.call(name, args)).content[0].text).error;
    expect(await codeOf("relay_send", { to: "bad name!", text: "x" })).toBe("invalid_input");
    expect(await codeOf("relay_send", { to: "capy-1", text: "" })).toBe("invalid_input");
    expect(await codeOf("relay_send", { to: "capy-1", text: "x".repeat(16001) })).toBe("invalid_input");
    expect(await codeOf("relay_send", { to: "wintermute", text: "me" })).toBe("invalid_input");
    expect(await codeOf("relay_send", { to: "ghost", text: "x" })).toBe("recipient_unknown");
    expect(await codeOf("relay_reply", { message_id: "../x", text: "x" })).toBe("invalid_input");
    expect(await codeOf("workspace_create", {})).toBe("invalid_input");
  });

  it("relay_history reads the 1:1 conversation only, oldest first", async () => {
    const engine = createEngine();
    const tools = createRelayTools({ engine, getAuth: auth });
    const history = parse(await tools.call("relay_history", { with: "capy-1", limit: 500 }));
    expect(engine.dmMessages).toHaveBeenCalledWith("at_live_x", "dm_1", { limit: 100 });
    expect(history.messages.map((message) => message.text)).toEqual(["first", "second"]);
    expect(history.messages[0].relay_status).toBe("answered");
  });

  it("relay_agents merges presence", async () => {
    const tools = createRelayTools({ engine: createEngine(), getAuth: auth });
    expect(parse(await tools.call("relay_agents", {}))).toEqual({
      agents: [{ name: "wintermute", status: "offline" }, { name: "capy-1", status: "online" }],
    });
  });

  it("answers provisioning_pending until the relay is provisioned", async () => {
    const tools = createRelayTools({
      engine: createEngine(),
      getAuth: () => {
        throw Object.assign(new (require("../../lib/server/relay/errors").RelayError)("provisioning_pending"));
      },
    });
    expect(JSON.parse((await tools.call("relay_inbox", {})).content[0].text).error).toBe("provisioning_pending");
  });

  it("the stdio server builds against a relay directory with no secrets yet", () => {
    const server = createRelayMcpServer({ relayDir: "/nonexistent/relay", port: 18787 });
    expect(typeof server.connect).toBe("function");
  });
});


describe("relay tools: hop propagation (ALPH-63)", () => {
  it("a message sent during a relay run carries that run's hop + 1, and a reply at least its parent's hop + 1", async () => {
    const engine = createEngine();
    engine.getMessage = vi.fn(async () => ({ id: "30", metadata: { relay_hop: 2 } }));
    let next = 3;
    const tools = createRelayTools({ engine, getAuth: auth, nextHop: () => next });
    await tools.call("relay_send", { to: "capy-1", text: "forwarding" });
    expect(engine.sendDm).toHaveBeenLastCalledWith("at_live_x", "capy-1", "forwarding", { relay_hop: 3 });
    next = 0;
    await tools.call("relay_reply", { message_id: "30", text: "answer" });
    expect(engine.reply).toHaveBeenLastCalledWith("at_live_x", "30", "answer", { relay_hop: 3 });
    next = 5;
    await tools.call("relay_reply", { message_id: "30", text: "answer" });
    expect(engine.reply).toHaveBeenLastCalledWith("at_live_x", "30", "answer", { relay_hop: 5 });
  });

  it("the box agent's server reads the next hop from the relay runs in flight", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
    const { readNextHop } = require("../../lib/server/relay/mcp-stdio");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hop-"));
    try {
      const dbPath = path.join(dir, "bridge.db");
      expect(readNextHop(dbPath)).toBe(0);
      const store = openBridgeStore({ dbPath });
      store.insert({ messageId: "1", sender: "a", conversationId: "dm", threadRoot: "1", sessionKey: "agent:main:relay-a", hop: 1, state: "answered" });
      expect(readNextHop(dbPath)).toBe(0);
      store.insert({ messageId: "2", sender: "b", conversationId: "dm", threadRoot: "2", sessionKey: "agent:main:relay-b", hop: 2, state: "dispatched" });
      expect(readNextHop(dbPath)).toBe(3);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

