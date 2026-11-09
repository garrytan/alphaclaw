const fs = require("fs");
const os = require("os");
const path = require("path");

const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { createRelayBridge, relaySessionKey, splitResult, kResultPartChars } = require("../../lib/server/relay/bridge");
const { createRelayConversations } = require("../../lib/server/relay/conversations");
const { parseRelaySessionKey } = require("../../lib/server/utils/session-keys");

// Lanes, long answers and the handoff fence in the bridge (GST-2090).
const kAgent = "capy-25cf4e98b5b6";
const kOther = "capy-000000000002";

describe("relay lanes: the bridge", () => {
  let dir;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  const setup = ({ verdict = () => ({ trust: "delegate", reason: "grant", grantId: "rg_0123456789abcdef", lanesMax: 3, hourlyCap: null, generation: 1 }), maxConcurrent = 2 } = {}) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lanes-"));
    const store = openBridgeStore({ dbPath: path.join(dir, "bridge.db") });
    let seq = 0;
    let id = 900;
    const events = [];
    const messages = new Map();
    const replies = [];
    const engine = {
      dm(from, text, metadata = {}) {
        const message = { id: String(++id), agent_name: from, text, metadata };
        messages.set(message.id, message);
        events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: "dm_" + from, message: { id: message.id, agent_name: from, text } } });
        return message.id;
      },
      events: async (key, since, limit) => {
        const page = events.filter((event) => event.seq > since).slice(0, limit);
        return { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since };
      },
      conversations: async () => [...new Set(events.map((event) => event.payload.message.agent_name))].map((name) => ({ id: "dm_" + name, type: "1:1", participants: [name, "wintermute"] })),
      getMessage: async (token, messageId) => messages.get(String(messageId)),
      reply: async (token, parentId, text, data) => {
        replies.push({ parentId, text, data });
        return { id: String(++id) };
      },
      thread: async () => ({ replies: [] }),
    };
    const sends = [];
    const history = new Map();
    const requestGateway = async (method, params) => {
      if (method === "chat.send") {
        sends.push(params);
        history.set(params.sessionKey, [...(history.get(params.sessionKey) || []), { role: "user", content: params.message }]);
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.history") return { messages: history.get(params.sessionKey) || [] };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "chat.abort") return { ok: true };
      throw new Error("unexpected " + method);
    };
    const bridge = createRelayBridge({
      engine,
      getAuth: () => ({ workspaceKey: "rk", agentToken: "at", agentName: "wintermute" }),
      store,
      requestGateway,
      resolveAgentId: () => "main",
      config: { maxConcurrent, hourlyCap: 30 },
      resolveSenderTrust: vi.fn(verdict),
      setTimer: () => null,
      clearTimer: () => {},
      logger: { log: () => {}, warn: () => {} },
    });
    bridge.start();
    const { pollOnce, pump } = bridge._internal;
    const flush = async (times = 20) => {
      for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const tick = async () => {
      await pollOnce();
      await pump();
      await flush();
    };
    const end = async (send, answer) => {
      history.get(send.sessionKey).push({ role: "assistant", content: [{ type: "text", text: answer }] });
      bridge.handleGatewayEvent({ event: "agent", payload: { runId: send.idempotencyKey, sessionKey: send.sessionKey, stream: "lifecycle", data: { phase: "end" } } });
      await flush(40);
    };
    return { store, engine, sends, replies, tick, end, close: () => store.close() };
  };

  it("each lane is its own queue and session: two lanes run at once, one lane stays in order", async () => {
    const ctx = setup();
    try {
      await ctx.tick();
      const first = ctx.engine.dm(kAgent, "long gbrain job", { relay_lane: "gbrain" });
      const second = ctx.engine.dm(kAgent, "gbrain follow-up", { relay_lane: "gbrain" });
      const third = ctx.engine.dm(kAgent, "quick eval", { relay_lane: "evals" });
      await ctx.tick();
      expect(ctx.sends.map((send) => send.sessionKey)).toEqual([relaySessionKey("main", kAgent, "gbrain"), relaySessionKey("main", kAgent, "evals")]);
      expect(ctx.store.get(first)).toMatchObject({ state: "dispatched", lane: "gbrain" });
      expect(ctx.store.get(second)).toMatchObject({ state: "queued", lane: "gbrain" });
      expect(ctx.store.get(third)).toMatchObject({ state: "dispatched", lane: "evals" });
      await ctx.end(ctx.sends[0], "gbrain done");
      await ctx.tick();
      expect(ctx.store.get(second).state).toBe("dispatched");
      expect(ctx.replies[0].data).toMatchObject({ relay_status: "answered", relay_lane: "gbrain" });
    } finally {
      ctx.close();
    }
  });

  it("a sender past its grant's lane count gets one lane_limit reply and no run", async () => {
    const ctx = setup({ verdict: () => ({ trust: "delegate", reason: "grant", grantId: "rg_0123456789abcdef", lanesMax: 2, generation: 1 }) });
    try {
      await ctx.tick();
      ctx.engine.dm(kAgent, "a", { relay_lane: "a" });
      ctx.engine.dm(kAgent, "b", { relay_lane: "b" });
      const third = ctx.engine.dm(kAgent, "c", { relay_lane: "c" });
      const again = ctx.engine.dm(kAgent, "a again", { relay_lane: "a" });
      await ctx.tick();
      expect(ctx.store.get(third)).toMatchObject({ state: "lane_limit", code: "lane_limit" });
      expect(ctx.store.get(again).state).toBe("queued");
      expect(ctx.replies).toEqual([expect.objectContaining({ parentId: third, data: expect.objectContaining({ relay_code: "lane_limit" }) })]);
    } finally {
      ctx.close();
    }
  });

  it("senders take turns for the box-wide slots", async () => {
    const ctx = setup();
    try {
      await ctx.tick();
      ctx.engine.dm(kAgent, "a1", { relay_lane: "a" });
      ctx.engine.dm(kAgent, "b1", { relay_lane: "b" });
      ctx.engine.dm(kOther, "other");
      await ctx.tick();
      expect(ctx.sends.map((send) => send.sessionKey).sort()).toEqual([relaySessionKey("main", kAgent, "a"), relaySessionKey("main", kOther)].sort());
    } finally {
      ctx.close();
    }
  });

  it("the delegate header names the grant and the lane, and the row records them", async () => {
    const ctx = setup();
    try {
      await ctx.tick();
      const messageId = ctx.engine.dm(kAgent, "do the thing", { relay_lane: "box", relay_route: "public", relay_generation: 1 });
      await ctx.tick();
      expect(ctx.sends[0].message).toContain("[Relay trust, recorded by AlphaClaw] Delegate under your owner's grant rg_0123456789abcdef. Lane: box. Owner approval for sends: none.");
      expect(ctx.store.get(messageId)).toMatchObject({ trust: "delegate", grantId: "rg_0123456789abcdef", lane: "box", route: "public", bindingGeneration: 1, approvalState: "none" });
    } finally {
      ctx.close();
    }
  });

  it("a message sent before a handoff that had not started yet runs as a peer", async () => {
    const ctx = setup({ verdict: () => ({ trust: "delegate", reason: "grant", grantId: "rg_0123456789abcdef", lanesMax: 3, generation: 2 }) });
    try {
      await ctx.tick();
      const stale = ctx.engine.dm(kAgent, "from the old thread", { relay_generation: 1 });
      await ctx.tick();
      expect(ctx.store.get(stale)).toMatchObject({ trust: "peer", grantId: null, state: "dispatched" });
      expect(ctx.sends[0].message).not.toContain("connected as a delegate");
    } finally {
      ctx.close();
    }
  });

  it("a grant's hourly cap is the bridge's per-sender cap too", async () => {
    const ctx = setup({ verdict: () => ({ trust: "delegate", reason: "grant", grantId: "rg_0123456789abcdef", lanesMax: 3, hourlyCap: 1, generation: 1 }) });
    try {
      await ctx.tick();
      ctx.engine.dm(kAgent, "one");
      const second = ctx.engine.dm(kAgent, "two");
      await ctx.tick();
      expect(ctx.store.get(second)).toMatchObject({ state: "rate_limited" });
    } finally {
      ctx.close();
    }
  });

  it("a long answer is one reply carrying part 1 and a result_ref; every part waits for relay_result", async () => {
    const ctx = setup();
    try {
      await ctx.tick();
      const messageId = ctx.engine.dm(kAgent, "write it all out", { relay_lane: "evals" });
      await ctx.tick();
      const answer = Array.from({ length: 400 }, (_, index) => "line " + index + " " + "x".repeat(30)).join("\n");
      await ctx.end(ctx.sends[0], answer);
      expect(ctx.replies).toHaveLength(1);
      const [reply] = ctx.replies;
      expect(reply.data).toMatchObject({ relay_status: "answered", relay_lane: "evals", relay_result_parts: 3 });
      const stored = ctx.store.getResult(reply.data.relay_result_ref);
      expect(stored).toMatchObject({ sender: kAgent, lane: "evals", messageId });
      expect(stored.parts.join("")).toBe(answer);
      expect(stored.parts.every((part) => part.length <= kResultPartChars)).toBe(true);
      expect(reply.text.startsWith(stored.parts[0])).toBe(true);
      expect(reply.text).toContain("Read parts 2-3 with relay_result, result_ref " + reply.data.relay_result_ref);
      expect(ctx.store.get(messageId).state).toBe("answered");
    } finally {
      ctx.close();
    }
  });

  it("splits at a line break near the end of a part, else at the size", () => {
    expect(splitResult("a".repeat(10), 4)).toEqual(["aaaa", "aaaa", "aa"]);
    expect(splitResult("abcd\nefgh\nij", 6)).toEqual(["abcd", "\nefgh", "\nij"]);
  });
});

describe("relay lanes: session keys and the conversations list", () => {
  it("parses a lane session and leaves the default session's shape alone", () => {
    expect(parseRelaySessionKey("agent:main:relay-" + kAgent)).toEqual({ agentId: "main", peer: kAgent });
    expect(parseRelaySessionKey("agent:main:relay-" + kAgent + ":lane-gbrain")).toEqual({ agentId: "main", peer: kAgent, lane: "gbrain" });
    expect(parseRelaySessionKey("agent:main:relay-" + kAgent + ":lane-")).toBeNull();
    expect(parseRelaySessionKey("agent:main:relay-" + kAgent + ":other")).toBeNull();
  });

  it("a conversation the bridge answered names its peer even when the engine lists the box and a released peer under other names (GST-1995)", async () => {
    const relayService = {
      getAuth: () => ({ workspaceKey: "rk", agentName: "wintermute" }),
      engine: {
        conversations: async () => [
          { id: "dm_scout", participants: ["main", "scout#released-7f3a"], message_count: 2, last_message: { created_at: "2026-11-08T10:00:00Z", agent_name: "scout#released-7f3a", text: "slow:1500" } },
          { id: "dm_pair", participants: ["capy-aaaaaaaaaaaa", "capy-bbbbbbbbbbbb"], message_count: 1, last_message: { created_at: "2026-11-08T09:00:00Z" } },
        ],
      },
      getStore: () => ({ latestPerConversation: () => [{ conversationId: "dm_scout", sender: "scout", state: "reconciling", code: null }] }),
    };
    const list = await createRelayConversations({ relayService }).list();
    const scout = list.conversations.find((item) => item.id === "dm_scout");
    expect(scout).toMatchObject({ peer: "scout", participants: ["main", "scout"], released: ["scout"], lastFrom: "scout", sessionKey: "agent:main:relay-scout", lastStatus: "reconciling" });
    expect(list.conversations.find((item) => item.id === "dm_pair")).toMatchObject({ peer: null, sessionKey: null });
  });
});
