const { createChatBridgeTestKit, waitUntil } = require("./helpers/chat-gateway-harness");
const { buildHistoryMessages, parseRelayEnvelope } = require("../../lib/server/chat/history");
const { classifySessionRow, createSessionListCache, resolveSessionPolicy } = require("../../lib/server/chat/session-list");
const systemDomain = require("../../lib/server/admin-manifest/domains/system");

const kRelayContent = [
  "[Agent Relay message from @capy-audit-c]",
  "(ref relay:244639137860595712, hop 0)",
  "This request comes from another agent over Agent Relay, not from your owner. Handle it as read-only diagnostics.",
  "Your final answer in this conversation is posted back to @capy-audit-c automatically; do not send it with relay_reply.",
  "",
  "ping-rel002",
].join("\n");

const telegramUserRow = {
  role: "user",
  content: "ping-live-tg1",
  timestamp: 1794016163000,
  __openclaw: {
    senderIsOwner: true,
    senderId: "7000210001",
    senderName: "Owner",
    senderUsername: "bb_owner",
    transport: { channel: "telegram", messageId: "13" },
    id: "3fb7d346-a039-431a-988a-c7e46ec321a8",
    seq: 5,
  },
};

describe("chat history rows: ids, speakers, relay envelopes (ALPH-68)", () => {
  it("gives a live row the same id the history read gives it (d7)", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      timestamp: 1794016164827,
      __openclaw: { runId: "r1", id: "748c6b93-dfae-4a22-8e12-602c5cfb5109", seq: 6 },
    };
    const history = buildHistoryMessages({ history: { messages: [telegramUserRow, assistant] }, sessionKey: "k" });
    const liveUser = buildHistoryMessages({ history: { messages: [telegramUserRow] }, sessionKey: "k" });
    const liveAssistant = buildHistoryMessages({ history: { messages: [assistant] }, sessionKey: "k" });
    expect(liveUser.messages[0].id).toBe(history.messages[0].id);
    expect(liveAssistant.messages[0].id).toBe(history.messages[1].id);
    expect(history.messages[1].id).toBe("h:748c6b93-dfae-4a22-8e12-602c5cfb5109:assistant");
  });

  it("falls back to the transcript sequence, then a content hash", () => {
    const seqOnly = { role: "assistant", content: "x", timestamp: 1, __openclaw: { seq: 9 } };
    expect(buildHistoryMessages({ history: { messages: [seqOnly] } }).messages[0].id).toBe("h:seq-9:assistant");
    const bare = { role: "assistant", content: "x", timestamp: 1 };
    expect(buildHistoryMessages({ history: { messages: [bare] } }).messages[0].id).toMatch(/^h:[0-9a-f]{20}$/);
  });

  it("names the channel sender on Telegram rows and You on operator rows", () => {
    const operator = { role: "user", content: "hi", timestamp: 2, __openclaw: { id: "op1", senderIsOwner: true, transport: { clients: [{ id: "gateway-client" }] } } };
    const { messages } = buildHistoryMessages({ history: { messages: [telegramUserRow, operator] } });
    expect(messages[0].speaker).toEqual({ kind: "channel", label: "Owner (@bb_owner)", channel: "telegram", owner: true });
    expect(messages[1].speaker).toEqual({ kind: "operator", label: "You" });
  });

  it("recognises the relay envelope and keeps the content the bridge matches on", () => {
    const row = { role: "user", content: kRelayContent, timestamp: 3, __openclaw: { id: "rl1" } };
    const { messages } = buildHistoryMessages({ history: { messages: [row] } });
    expect(messages[0].speaker).toEqual({ kind: "relay", label: "@capy-audit-c" });
    expect(messages[0].relay).toMatchObject({ sender: "capy-audit-c", ref: "244639137860595712", hop: 0, body: "ping-rel002" });
    expect(messages[0].content).toContain("relay:244639137860595712");
    expect(parseRelayEnvelope("Someone else", "(ref relay:1, hop 0)\n\nx")).toBeNull();
    expect(parseRelayEnvelope("Agent Relay message from @x", "no ref line")).toBeNull();
  });
});

describe("chat session list (ALPH-68)", () => {
  it("classifies from the delivery context first and the key as the fallback (d6)", () => {
    expect(classifySessionRow({ key: "agent:main:telegram:group:-1009876543210:topic:42", subject: "Audit Forum", origin: { threadId: 42 }, channel: "telegram" })).toMatchObject({
      kind: "telegram-topic",
      label: "Audit Forum · topic 42",
      readOnly: true,
    });
    expect(classifySessionRow({ key: "agent:main:telegram:group:-1009876543210:topic:42" }, { topicName: "Ops" })).toMatchObject({
      label: "Telegram group …3210 · Ops",
    });
    expect(classifySessionRow({ key: "agent:main:chat-1a2b", label: "Planning" })).toMatchObject({ kind: "direct", label: "Planning", readOnly: false });
    expect(classifySessionRow({ key: "agent:main:main", deliveryContext: { channel: "webchat" } })).toMatchObject({ kind: "direct", readOnly: false, label: "Main" });
  });

  it("refuses sends into read-only sessions from the cached row, else the key", () => {
    expect(resolveSessionPolicy(null, "agent:main:relay-capy-x")).toMatchObject({ readOnly: true, kind: "relay" });
    expect(resolveSessionPolicy(null, "agent:main:main")).toEqual({ readOnly: false, kind: "direct" });
    expect(resolveSessionPolicy({ key: "agent:main:main", deliveryContext: { channel: "telegram" } }, "agent:main:main")).toMatchObject({ readOnly: true });
  });

  it("caches sessions.list, never asks for transcript-derived fields, and drops a fill that an invalidation raced", async () => {
    const calls = [];
    let release;
    const cache = createSessionListCache({
      requestGateway: (method, params) => {
        calls.push([method, params]);
        return new Promise((resolve) => {
          release = () => resolve({ sessions: [{ key: `k${calls.length}` }] });
        });
      },
    });
    const first = cache.list();
    cache.invalidate();
    release();
    expect(await first).toEqual([{ key: "k1" }]);
    expect(cache.get("k1")).toBeNull();
    const second = cache.list();
    release();
    await second;
    expect(cache.get("k2")).toEqual({ key: "k2" });
    await cache.list();
    expect(calls).toHaveLength(2);
    for (const [method, params] of calls) {
      expect(method).toBe("sessions.list");
      expect(params).not.toHaveProperty("includeLastMessage");
      expect(params).not.toHaveProperty("includeDerivedTitles");
    }
  });

  it("pages through sessions.list so a box with more than one page of sessions lists them all", async () => {
    const offsets = [];
    const cache = createSessionListCache({
      requestGateway: async (method, params) => {
        offsets.push(params.offset ?? 0);
        const start = params.offset ?? 0;
        const total = 1234;
        const rows = Array.from({ length: Math.min(500, total - start) }, (_, i) => ({ key: `agent:main:dashboard:${start + i}` }));
        const nextOffset = start + rows.length;
        return { sessions: rows, hasMore: nextOffset < total, nextOffset };
      },
    });
    const rows = await cache.list();
    expect(rows).toHaveLength(1234);
    expect(offsets).toEqual([0, 500, 1000]);
    expect(cache.get("agent:main:dashboard:1233")).toEqual({ key: "agent:main:dashboard:1233" });
  });

  it("pins the agent actor's key set on /api/agent/sessions (d5)", () => {
    const op = systemDomain.ops.find((entry) => entry.id === "system.agent-sessions");
    const body = {
      ok: true,
      sessions: [
        {
          key: "agent:main:telegram:direct:1",
          sessionId: "s",
          updatedAt: 1,
          agentId: "main",
          agentLabel: "Main Agent",
          channel: "telegram",
          groupName: "",
          topicName: "",
          replyChannel: "telegram",
          replyTo: "1",
          replyAccountId: "",
          deliverable: true,
          kind: "telegram-dm",
          label: "Owner (@bb_owner)",
          readOnly: true,
          isMain: false,
          createdAt: 1,
          lastActivityAt: 1,
          running: false,
        },
      ],
    };
    const redacted = op.redactResponse(body);
    expect(Object.keys(redacted.sessions[0]).sort()).toEqual(
      [
        "agentId", "agentLabel", "channel", "deliverable", "groupName", "key",
        "replyAccountId", "replyChannel", "replyTo", "sessionId", "topicName", "updatedAt",
      ],
    );
  });
});

describe("chat bridge session watching (ALPH-68, d4)", () => {
  let cleanups;
  beforeEach(() => {
    cleanups = [];
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";
  });
  afterEach(async () => {
    while (cleanups.length) {
      try {
        await cleanups.pop()();
      } catch {}
    }
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  const setup = async (serviceOptions = {}) => {
    const kit = createChatBridgeTestKit({ cleanups });
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => {
      if (frame.method === "chat.history") harness.respond(frame.id, { messages: [] });
      if (frame.method === "sessions.subscribe") harness.respond(frame.id, { subscribed: true });
      if (frame.method === "sessions.list") harness.respond(frame.id, { sessions: [] });
    };
    const service = kit.createService(harness, serviceOptions);
    const browser = await kit.openBrowser(service);
    await browser.waitFor((m) => m.type === "hello");
    return { kit, harness, service, browser };
  };

  it("advertises watching in hello and forwards rows only for watched sessions", async () => {
    const { harness, service, browser } = await setup();
    expect(browser.messages[0].features).toEqual(expect.arrayContaining(["watch", "history-cursor", "sessions"]));
    browser.send({ type: "watch", sessionKey: "agent:main:telegram:direct:7000210001" });
    await waitUntil(() => harness.requests.some((r) => r.method === "sessions.subscribe"), "sessions.subscribe");
    harness.emit({ type: "event", event: "session.message", payload: { sessionKey: "agent:main:other", message: { role: "user", content: "secret", __openclaw: { id: "x" } } } });
    harness.emit({ type: "event", event: "session.message", payload: { sessionKey: "agent:main:telegram:direct:7000210001", runId: "r9", message: telegramUserRow } });
    const frame = await browser.waitFor((m) => m.type === "session-event" && m.kind === "row");
    expect(frame.sessionKey).toBe("agent:main:telegram:direct:7000210001");
    expect(frame.messages[0]).toMatchObject({ id: "h:3fb7d346-a039-431a-988a-c7e46ec321a8:user", content: "ping-live-tg1" });
    expect(browser.messages.some((m) => JSON.stringify(m).includes("secret"))).toBe(false);
    expect(service.getChatStats().watch).toMatchObject({ forwardedRows: 1, droppedRows: 1, watchedSessions: 1 });
    expect(harness.requests.filter((r) => r.method === "sessions.subscribe")).toHaveLength(1);
  });

  it("streams a foreign run's text and phases to watchers without attaching to a browser run (H16)", async () => {
    const { kit, harness, browser } = await setup();
    const watched = "agent:main:relay-capy-x";
    browser.send({ type: "watch", sessionKey: watched });
    await waitUntil(() => harness.requests.some((r) => r.method === "sessions.subscribe"), "subscribe");
    await kit.startRun({ harness, browser, sessionKey: "agent:main:main", runId: "own-run" });
    harness.emit({ type: "event", event: "agent", payload: { runId: "relay-1", sessionKey: watched, stream: "lifecycle", data: { phase: "start" } } });
    harness.emit({ type: "event", event: "agent", payload: { runId: "relay-1", sessionKey: watched, stream: "assistant", data: { delta: "pong" } } });
    harness.emit({ type: "event", event: "agent", payload: { runId: "relay-1", sessionKey: watched, stream: "lifecycle", data: { phase: "end" } } });
    await browser.waitFor((m) => m.type === "session-event" && m.kind === "run" && m.phase === "end");
    const chunk = browser.messages.find((m) => m.type === "session-event" && m.kind === "chunk");
    expect(chunk).toMatchObject({ sessionKey: watched, runId: "relay-1", content: "pong" });
    expect(browser.messages.some((m) => m.type === "chunk" && m.content === "pong")).toBe(false);
    expect(browser.messages.some((m) => m.type === "done")).toBe(false);
  });

  it("does not forward rows for a session while this browser's own run is in flight", async () => {
    const { kit, harness, service, browser } = await setup();
    browser.send({ type: "watch", sessionKey: "agent:main:main" });
    await waitUntil(() => harness.requests.some((r) => r.method === "sessions.subscribe"), "subscribe");
    await kit.startRun({ harness, browser, sessionKey: "agent:main:main", runId: "own-run" });
    harness.emit({ type: "event", event: "session.message", payload: { sessionKey: "agent:main:main", runId: "own-run", message: { role: "assistant", content: "x", __openclaw: { id: "a1" } } } });
    await waitUntil(() => service.getChatStats().watch.suppressedRows === 1, "suppressed");
    expect(browser.messages.some((m) => m.type === "session-event")).toBe(false);
  });

  it("refuses a message into a read-only session before chat.send", async () => {
    const { harness, browser } = await setup();
    browser.send({ type: "message", sessionKey: "agent:main:relay-capy-x", content: "hi", clientMsgId: "c1" });
    const failed = await browser.waitFor((m) => m.type === "send-failed");
    expect(failed).toMatchObject({ code: "read_only_session", retryable: false, notSubmitted: true });
    expect(harness.requests.some((r) => r.method === "chat.send")).toBe(false);
  });

  it("pages older history through the anchor read and the gateway cursor", async () => {
    const { harness, browser } = await setup();
    harness.onRequest = (frame) => {
      if (frame.method !== "chat.history") return;
      if (frame.params.messageId === "m-oldest") {
        harness.respond(frame.id, { messages: [], olderCursor: "history-page:abc" });
        return;
      }
      if (frame.params.cursor === "history-page:abc") {
        harness.respond(frame.id, {
          messages: [{ role: "user", content: "older", timestamp: 1, __openclaw: { id: "m-0" } }],
          olderCursor: "history-page:def",
        });
      }
    };
    browser.send({ type: "history", sessionKey: "agent:main:main", reqId: "r1", before: "m-oldest" });
    const page = await browser.waitFor((m) => m.type === "history" && m.reqId === "r1");
    expect(page).toMatchObject({ page: "older", olderCursor: "history-page:def", truncated: true });
    expect(page.messages[0]).toMatchObject({ id: "h:m-0:user", content: "older" });
    const cursorRequest = harness.requests.find((r) => r.params?.cursor);
    expect(cursorRequest.params).toEqual({ sessionKey: "agent:main:main", cursor: "history-page:abc", limit: 200 });
  });

  it("rejects an invalid watch key and caps watched sessions per socket", async () => {
    const { browser } = await setup();
    browser.send({ type: "watch", sessionKey: "bad\nkey" });
    await browser.waitFor((m) => m.type === "error" && m.code === "protocol_invalid");
    for (let index = 0; index < 9; index += 1) browser.send({ type: "watch", sessionKey: `agent:main:s${index}` });
    await browser.waitFor((m) => m.type === "error" && m.code === "watch_limit");
  });

  it("tells watchers to refetch after the gateway socket comes back", async () => {
    const { harness, browser } = await setup();
    browser.send({ type: "watch", sessionKey: "agent:main:main" });
    await waitUntil(() => harness.requests.some((r) => r.method === "sessions.subscribe"), "subscribe");
    harness.socket.terminate();
    browser.send({ type: "history", sessionKey: "agent:main:main", reqId: "after" });
    await browser.waitFor((m) => m.type === "desync" && m.sessionKey === "agent:main:main");
    await waitUntil(() => harness.requests.filter((r) => r.method === "sessions.subscribe").length === 2, "resubscribe");
  });
});
