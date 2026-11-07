const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRelayBridge, findAnswerInHistory, relaySessionKey, kHopLimit, stripHostNotices } = require("../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { createRelayMasker } = require("../../lib/server/relay/mask");

// A fake relay engine: a workspace event log, messages with metadata, 1:1
// conversations and the replies the bridge posts.
const createFakeEngine = ({ boxAgent = "wintermute" } = {}) => {
  let seq = 0;
  let id = 1000;
  const events = [];
  const messages = new Map();
  const conversations = new Map();
  const replies = [];
  const convFor = (a, b) => {
    const key = [a, b].sort().join("|");
    if (!conversations.has(key)) conversations.set(key, { id: "dm_" + conversations.size, type: "1:1", participants: [a, b] });
    return conversations.get(key);
  };
  const engine = {
    replies,
    dm(from, text, metadata = {}) {
      const conv = convFor(from, boxAgent);
      const message = { id: String(++id), agent_name: from, text, metadata, created_at: new Date().toISOString() };
      messages.set(message.id, message);
      events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: conv.id, message: { id: message.id, agent_name: from, text } } });
      return message.id;
    },
    threadReply(from, parentId, text, metadata = {}) {
      const conv = convFor(from, boxAgent);
      const message = { id: String(++id), agent_name: from, text, metadata, thread_id: parentId, created_at: new Date().toISOString() };
      messages.set(message.id, message);
      events.push({ seq: ++seq, type: "thread.reply", payload: { conversation_id: conv.id, parent_id: parentId, message: { id: message.id, agent_name: from, text } } });
      return message.id;
    },
    events: async (key, since, limit) => {
      const page = events.filter((event) => event.seq > since).slice(0, limit);
      return { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since };
    },
    conversations: async () => [...conversations.values()],
    getMessage: async (token, messageId) => {
      const message = messages.get(String(messageId));
      if (!message) throw Object.assign(new Error("not found"), { engineStatus: 404 });
      return message;
    },
    reply: async (token, parentId, text, data) => {
      const message = { id: String(++id), agent_name: boxAgent, text, metadata: data || {}, thread_id: parentId, created_at: new Date().toISOString() };
      messages.set(message.id, message);
      replies.push({ parentId, text, data: data || {} });
      events.push({ seq: ++seq, type: "thread.reply", payload: { conversation_id: "x", parent_id: parentId, message: { id: message.id, agent_name: boxAgent, text } } });
      return message;
    },
    thread: async (token, parentId) => ({ replies: [...messages.values()].filter((message) => message.thread_id === parentId) }),
  };
  return engine;
};

// A fake gateway: chat.send starts a run per call; the test decides when it
// ends. chat.history answers from a per-session transcript.
const createFakeGateway = () => {
  const sends = [];
  const history = new Map();
  const active = new Set();
  let failNext = null;
  let runSeq = 0;
  const gateway = {
    sends,
    history,
    active,
    failNextSend: (error) => { failNext = error; },
    requestGateway: async (method, params, timeoutMs, { onFrameWritten } = {}) => {
      if (method === "chat.send") {
        if (failNext) {
          const error = failNext;
          failNext = null;
          if (error.written) onFrameWritten?.();
          throw error;
        }
        onFrameWritten?.();
        const runId = "run-" + ++runSeq;
        sends.push({ ...params, runId });
        history.set(params.sessionKey, [...(history.get(params.sessionKey) || []), { role: "user", content: params.message }]);
        active.add(params.sessionKey);
        gateway.beforeReturn?.({ ...params, runId });
        return { runId, status: "started" };
      }
      if (method === "chat.history") return { messages: history.get(params.sessionKey) || [] };
      if (method === "sessions.list") return { sessions: [...active].map((key) => ({ key, hasActiveRun: true })) };
      throw new Error("unexpected method " + method);
    },
    answer(send, text) {
      history.get(send.sessionKey).push({ role: "assistant", content: [{ type: "text", text }] });
      active.delete(send.sessionKey);
    },
  };
  return gateway;
};

const flush = async (times = 5) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

const setup = ({ maxConcurrent = 2, hourlyCap = 30, nowRef = { value: Date.now() }, onRelayMessage, maskText } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-"));
  const store = openBridgeStore({ dbPath: path.join(dir, "bridge.db"), now: () => nowRef.value });
  const engine = createFakeEngine();
  const gateway = createFakeGateway();
  const logger = { log: () => {}, warn: () => {} };
  const bridge = createRelayBridge({
    engine,
    getAuth: () => ({ workspaceKey: "rk", agentToken: "at", agentName: "wintermute" }),
    store,
    requestGateway: (...args) => gateway.requestGateway(...args),
    resolveAgentId: () => "main",
    config: { maxConcurrent, hourlyCap },
    ...(onRelayMessage ? { onRelayMessage } : {}),
    ...(maskText ? { maskText } : {}),
    now: () => nowRef.value,
    setTimer: () => null,
    clearTimer: () => {},
    logger,
  });
  bridge.start();
  const { pollOnce, pump, reconcile } = bridge._internal;
  const tick = async () => {
    await pollOnce();
    await pump();
    await flush();
  };
  const end = async (send, text) => {
    gateway.answer(send, text);
    bridge.handleGatewayEvent({ event: "agent", payload: { runId: send.runId, sessionKey: send.sessionKey, stream: "lifecycle", data: { phase: "end" } } });
    await flush(20);
  };
  return { dir, store, engine, gateway, bridge, tick, end, reconcile, nowRef, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

describe("relay bridge", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("starts at the engine's current position and never replays older history", async () => {
    ctx = setup();
    ctx.engine.dm("capy-old", "before the bridge existed");
    await ctx.tick();
    await ctx.tick();
    expect(ctx.gateway.sends).toEqual([]);
  });

  it("dispatches a DM into the sender's own relay session, never the main session, and posts exactly one answer", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-a1b2", "what is your uptime?");
    await ctx.tick();
    expect(ctx.gateway.sends).toHaveLength(1);
    const [send] = ctx.gateway.sends;
    expect(send.sessionKey).toBe("agent:main:relay-capy-a1b2");
    expect(send.sessionKey).not.toMatch(/:main$/);
    expect(send.idempotencyKey).toBe("relay-" + messageId);
    expect(send.message).toContain("[Agent Relay message from @capy-a1b2]");
    expect(send.message).toContain("ref relay:" + messageId);
    expect(send.message).toMatch(/approval id relay-[0-9a-f]{8}/);
    expect(send.message).toContain("what is your uptime?");
    await ctx.end(send, "Up 3 days.");
    expect(ctx.engine.replies).toEqual([
      { parentId: messageId, text: "Up 3 days.", data: { relay_status: "answered", relay_in_reply_to: messageId, relay_hop: 1 } },
    ]);
    expect(ctx.store.get(messageId).state).toBe("answered");
    // A late duplicate end changes nothing.
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: send.runId, stream: "lifecycle", data: { phase: "end" } } });
    await flush(20);
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("buffers events that arrive before chat.send returns the run id", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-fast", "quick one");
    ctx.gateway.beforeReturn = (send) => {
      ctx.gateway.answer(send, "done fast");
      ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: send.runId, sessionKey: send.sessionKey, stream: "lifecycle", data: { phase: "end" } } });
    };
    await ctx.tick();
    await flush(20);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["done fast"]);
    expect(ctx.store.get(messageId).state).toBe("answered");
  });

  it("ignores gateway events for runs it did not start, even in a relay session", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-x", "hello");
    await ctx.tick();
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: "foreign", sessionKey: "agent:main:relay-capy-x", stream: "lifecycle", data: { phase: "end" } } });
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { sessionKey: "agent:main:relay-capy-x", stream: "lifecycle", data: { phase: "end" } } });
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("dispatched");
    expect(ctx.engine.replies).toEqual([]);
  });

  it("never answers its own messages or another bridge's terminal replies (no ping-pong)", async () => {
    ctx = setup();
    await ctx.tick();
    ctx.engine.dm("wintermute", "self");
    ctx.engine.dm("other-box", "Relay: answered", { relay_status: "answered", relay_hop: 1 });
    await ctx.tick();
    expect(ctx.gateway.sends).toEqual([]);
  });

  it("refuses a message past the hop limit with a coded failure reply and no run", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("loop-bot", "again", { relay_hop: kHopLimit });
    await ctx.tick();
    expect(ctx.gateway.sends).toEqual([]);
    expect(ctx.store.get(messageId).state).toBe("hop_limit");
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0].data).toMatchObject({ relay_status: "failed", relay_code: "hop_limit", relay_in_reply_to: messageId });
    expect(ctx.engine.replies[0].text).toContain("(code hop_limit)");
  });

  it("caps one sender per hour and lets the next hour through", async () => {
    const nowRef = { value: Date.parse("2026-11-06T10:00:00Z") };
    ctx = setup({ hourlyCap: 2, nowRef, maxConcurrent: 4 });
    await ctx.tick();
    const first = ctx.engine.dm("chatty", "1");
    const second = ctx.engine.dm("chatty", "2");
    const third = ctx.engine.dm("chatty", "3");
    const otherSender = ctx.engine.dm("quiet", "hi");
    await ctx.tick();
    expect(ctx.store.get(first).state).not.toBe("rate_limited");
    expect(ctx.store.get(second).state).not.toBe("rate_limited");
    expect(ctx.store.get(third).state).toBe("rate_limited");
    expect(ctx.store.get(otherSender).state).toBe("dispatched");
    expect(ctx.engine.replies.find((reply) => reply.parentId === third).data.relay_code).toBe("rate_limited");
    nowRef.value += 61 * 60 * 1000;
    const later = ctx.engine.dm("chatty", "4");
    await ctx.tick();
    expect(ctx.store.get(later).state).not.toBe("rate_limited");
  });

  it("keeps one sender in order and holds the box to maxConcurrent runs", async () => {
    ctx = setup({ maxConcurrent: 2 });
    await ctx.tick();
    const a1 = ctx.engine.dm("alpha", "a1");
    const a2 = ctx.engine.dm("alpha", "a2");
    const b1 = ctx.engine.dm("beta", "b1");
    const c1 = ctx.engine.dm("gamma", "c1");
    await ctx.tick();
    expect(ctx.gateway.sends.map((send) => send.sessionKey)).toEqual(["agent:main:relay-alpha", "agent:main:relay-beta"]);
    expect(ctx.store.get(a2).state).toBe("queued");
    expect(ctx.store.get(c1).state).toBe("queued");
    await ctx.end(ctx.gateway.sends[0], "a1 done");
    await ctx.tick();
    expect(ctx.gateway.sends.map((send) => send.message.split("\n").pop())).toEqual(["a1", "b1", "a2"]);
    expect(ctx.store.get(a1).state).toBe("answered");
    expect(ctx.store.get(b1).state).toBe("dispatched");
  });

  it("a chat error ends the message with run_failed", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-e", "fail please");
    await ctx.tick();
    ctx.bridge.handleGatewayEvent({ event: "chat", payload: { runId: ctx.gateway.sends[0].runId, state: "error" } });
    await flush(20);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "failed", code: "run_failed" });
    expect(ctx.engine.replies[0].data.relay_code).toBe("run_failed");
  });

  it("a send that never reached the gateway is retried, not failed", async () => {
    const nowRef = { value: Date.now() };
    ctx = setup({ nowRef });
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-r", "retry me");
    ctx.gateway.failNextSend(new Error("OpenClaw gateway is not connected"));
    await ctx.tick();
    expect(ctx.store.get(messageId).state).toBe("queued");
    expect(ctx.engine.replies).toEqual([]);
    nowRef.value += 11000;
    await ctx.tick();
    expect(ctx.store.get(messageId).state).toBe("dispatched");
  });

  it("an ambiguous send (written, no answer) is reconciled from history, and ends outcome_unknown when there is none", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-u", "maybe");
    ctx.gateway.failNextSend(Object.assign(new Error("OpenClaw chat.send request timed out"), { written: true }));
    await ctx.tick();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "reconciling", code: "outcome_unknown" });
    ctx.nowRef.value += 3 * 60 * 1000;
    await ctx.reconcile();
    await flush(20);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "unknown", code: "outcome_unknown" });
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.gateway.sends).toHaveLength(0);
  });

  it("after a gateway restart it reconciles instead of re-sending: the answer if the run finished, run_interrupted if not", async () => {
    ctx = setup({ maxConcurrent: 2 });
    await ctx.tick();
    const done = ctx.engine.dm("one", "finishes during the restart");
    const cut = ctx.engine.dm("two", "is cut off");
    await ctx.tick();
    const [sendDone, sendCut] = ctx.gateway.sends;
    ctx.bridge.onGatewayDisconnect();
    expect(ctx.store.get(done).state).toBe("reconciling");
    ctx.gateway.answer(sendDone, "finished anyway");
    ctx.gateway.active.delete(sendCut.sessionKey);
    ctx.nowRef.value += 3 * 60 * 1000;
    await ctx.reconcile();
    await flush(20);
    expect(ctx.store.get(done).state).toBe("answered");
    expect(ctx.store.get(cut)).toMatchObject({ state: "interrupted", code: "run_interrupted" });
    expect(ctx.gateway.sends).toHaveLength(2);
    expect(ctx.engine.replies.map((reply) => reply.data.relay_status).sort()).toEqual(["answered", "failed"]);
  });

  it("a session still running after a restart is left alone until it ends", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("slow", "long job");
    await ctx.tick();
    ctx.bridge.onGatewayDisconnect();
    await ctx.reconcile();
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    expect(ctx.engine.replies).toEqual([]);
  });

  it("skips its own post when the agent already replied in the thread during the run", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-s", "reply yourself");
    await ctx.tick();
    await ctx.engine.reply("at", messageId, "I replied with relay_reply", null);
    ctx.engine.replies.length = 0;
    await ctx.end(ctx.gateway.sends[0], "final text");
    expect(ctx.engine.replies).toEqual([]);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "answered", code: "replied_by_agent" });
  });

  it("a thread reply from the sender continues in the same session and is answered in that thread", async () => {
    ctx = setup();
    await ctx.tick();
    const root = ctx.engine.dm("capy-t", "first");
    await ctx.tick();
    await ctx.end(ctx.gateway.sends[0], "answer one");
    const followUp = ctx.engine.threadReply("capy-t", root, "follow-up");
    await ctx.tick();
    expect(ctx.gateway.sends[1].sessionKey).toBe("agent:main:relay-capy-t");
    await ctx.end(ctx.gateway.sends[1], "answer two");
    expect(ctx.engine.replies.map((reply) => [reply.parentId, reply.data.relay_in_reply_to])).toEqual([[root, root], [root, followUp]]);
  });
});

describe("relay bridge helpers", () => {
  it("relaySessionKey lowercases the sender under the relay- prefix", () => {
    expect(relaySessionKey("main", "Capy-AB")).toBe("agent:main:relay-capy-ab");
  });

  it("findAnswerInHistory returns the last assistant text after the marked message only", () => {
    const history = {
      messages: [
        { role: "user", content: "[Agent Relay message from @capy]\n(ref relay:1, hop 0)\nolder" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
        { role: "user", content: "[Agent Relay message from @capy]\n(ref relay:2, hop 0)\nnew" },
        { role: "assistant", content: [{ type: "text", text: "thinking" }] },
        { role: "assistant", content: [{ type: "text", text: "final" }] },
      ],
    };
    expect(findAnswerInHistory(history, "2")).toBe("final");
    expect(findAnswerInHistory(history, "1")).toBe("old answer");
    expect(findAnswerInHistory(history, "3")).toBeNull();
  });

  it("findAnswerInHistory reads past OpenClaw's restart recovery prompt to the resumed answer (shape seen live on the pinned gateway)", () => {
    const history = {
      messages: [
        { role: "user", content: "[Agent Relay message from @capy]\n(ref relay:7, hop 0)\nslow one" },
        { role: "user", content: "[System] Your previous turn was interrupted while OpenClaw was waiting on tool/model work. This can happen after a Gateway restart or a tool execution timeout." },
        { role: "assistant", content: [{ type: "text", text: "resumed answer" }] },
      ],
    };
    expect(findAnswerInHistory(history, "7")).toBe("resumed answer");
    expect(findAnswerInHistory({ messages: history.messages.slice(0, 2) }, "7")).toBeNull();
  });
});


describe("relay bridge: wake hook ordering (ALPH-63)", () => {
  it("does not move its event cursor past a message until the wake hook has finished with it", async () => {
    let finishHook;
    const ctx = setup({ onRelayMessage: () => new Promise((resolve) => { finishHook = resolve; }) });
    try {
      await ctx.tick();
      const before = ctx.store.getCursor();
      ctx.engine.dm("capy-q", "for a bound thread");
      const polling = ctx.bridge._internal.pollOnce();
      await vi.waitFor(() => expect(finishHook).toBeTypeOf("function"));
      expect(ctx.store.getCursor()).toBe(before);
      finishHook();
      await polling;
      expect(ctx.store.getCursor()).toBeGreaterThan(before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("relay bridge: ship review fixes (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("a reply the engine did not take parks the row as replying, and reconcile posts it later", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-r", "status?");
    await ctx.tick();
    const realReply = ctx.engine.reply;
    ctx.engine.reply = async () => {
      throw new Error("engine restarting");
    };
    await ctx.end(ctx.gateway.sends[0], "all good");
    expect(ctx.store.get(messageId)).toMatchObject({ state: "replying", replyMessageId: null });
    expect(ctx.engine.replies).toEqual([]);
    ctx.engine.reply = realReply;
    await ctx.reconcile();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "answered", pendingReply: null });
    expect(ctx.store.get(messageId).replyMessageId).toBeTruthy();
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0]).toMatchObject({ text: "all good", data: { relay_status: "answered" } });
  });

  it("fails closed when a message's metadata cannot be read: the event is read again, then dropped unrun", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("other-box", "Relay: answered", { relay_status: "answered", relay_hop: 4 });
    const realGet = ctx.engine.getMessage;
    let reads = 0;
    ctx.engine.getMessage = async () => {
      reads += 1;
      throw new Error("engine busy");
    };
    const cursorBefore = ctx.store.getCursor();
    await expect(ctx.bridge._internal.pollOnce()).rejects.toThrow("engine busy");
    expect(ctx.store.getCursor()).toBe(cursorBefore);
    expect(ctx.store.get(messageId)).toBeNull();
    ctx.engine.getMessage = realGet;
    await ctx.tick();
    expect(ctx.store.get(messageId)).toBeNull();
    expect(ctx.gateway.sends).toEqual([]);
    const second = ctx.engine.dm("capy-z", "hello");
    ctx.engine.getMessage = async () => {
      throw new Error("gone");
    };
    for (let attempt = 1; attempt < 5; attempt += 1) await expect(ctx.bridge._internal.pollOnce()).rejects.toThrow("gone");
    await ctx.bridge._internal.pollOnce();
    expect(ctx.store.get(second)).toBeNull();
    expect(ctx.gateway.sends).toEqual([]);
    expect(reads).toBe(1);
  });

  it("a sender whose oldest message is backing off keeps its later messages waiting (per-sender order)", async () => {
    ctx = setup({ maxConcurrent: 2 });
    await ctx.tick();
    const first = ctx.engine.dm("capy-o", "first");
    ctx.gateway.failNextSend(Object.assign(new Error("gateway busy"), { gatewayResponded: true, gatewayRetryable: true }));
    await ctx.tick();
    expect(ctx.store.get(first)).toMatchObject({ state: "queued", attempts: 1 });
    const second = ctx.engine.dm("capy-o", "second");
    await ctx.tick();
    expect(ctx.store.get(second).state).toBe("queued");
    expect(ctx.gateway.sends).toEqual([]);
    ctx.nowRef.value += 10 * 60 * 1000;
    await ctx.tick();
    expect(ctx.gateway.sends.map((send) => send.idempotencyKey)).toEqual(["relay-" + first]);
  });

  it("a dispatch whose message body cannot be read gives up with run_failed instead of retrying forever", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-b", "body purged");
    await ctx.tick();
    ctx.store.update(messageId, { state: "queued", runId: null, dispatchedAt: null });
    ctx.gateway.sends.length = 0;
    ctx.engine.getMessage = async () => {
      throw new Error("not found");
    };
    for (let round = 0; round < 10; round += 1) {
      ctx.nowRef.value += 2 * 60 * 1000;
      await ctx.bridge._internal.pump();
      await flush();
    }
    expect(ctx.store.get(messageId)).toMatchObject({ state: "failed", code: "run_failed" });
    expect(ctx.gateway.sends).toEqual([]);
  });

  it("finds the answer of a tool-heavy run whose relay message fell out of the default history window", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-t", "check everything");
    await ctx.tick();
    const [send] = ctx.gateway.sends;
    const rows = ctx.gateway.history.get(send.sessionKey);
    for (let index = 0; index < 80; index += 1) rows.push({ role: "assistant", content: [{ type: "text", text: "step " + index }] });
    const realRequest = ctx.gateway.requestGateway;
    const limits = [];
    ctx.gateway.requestGateway = async (method, params, ...rest) => {
      if (method === "chat.history") {
        limits.push(params.limit);
        const all = ctx.gateway.history.get(params.sessionKey) || [];
        return { messages: all.slice(-params.limit) };
      }
      return realRequest(method, params, ...rest);
    };
    ctx.bridge.onGatewayDisconnect();
    ctx.gateway.answer(send, "the real final answer");
    ctx.nowRef.value += 3 * 60 * 1000;
    await ctx.reconcile();
    expect(limits).toEqual([60, 1000]);
    expect(ctx.store.get(messageId).state).toBe("answered");
    expect(ctx.engine.replies[0].text).toBe("the real final answer");
  });

  it("after a restart it waits for OpenClaw's recovery before settling, and a missing marker is outcome_unknown, never interrupted", async () => {
    ctx = setup();
    await ctx.tick();
    const resumed = ctx.engine.dm("capy-w", "resume me");
    const lost = ctx.engine.dm("capy-x", "history lost");
    await ctx.tick();
    const [sendResumed, sendLost] = ctx.gateway.sends;
    ctx.bridge.onGatewayDisconnect();
    ctx.gateway.active.clear();
    ctx.gateway.history.get(sendResumed.sessionKey).push({ role: "assistant", content: [{ type: "text", text: "Let me check the logs first." }] });
    ctx.gateway.history.set(sendLost.sessionKey, []);
    await ctx.reconcile();
    expect(ctx.store.get(resumed).state).toBe("reconciling");
    const realRequest = ctx.gateway.requestGateway;
    ctx.gateway.requestGateway = async (method, params, ...rest) =>
      method === "sessions.list"
        ? { sessions: [{ key: sendResumed.sessionKey, hasActiveRun: false, abortedLastRun: true }] }
        : realRequest(method, params, ...rest);
    ctx.nowRef.value += 3 * 60 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(resumed).state).toBe("reconciling");
    expect(ctx.store.get(lost)).toMatchObject({ state: "unknown", code: "outcome_unknown" });
    ctx.gateway.requestGateway = realRequest;
    ctx.gateway.history.get(sendResumed.sessionKey).push({ role: "assistant", content: [{ type: "text", text: "Logs are clean." }] });
    await ctx.reconcile();
    expect(ctx.store.get(resumed).state).toBe("answered");
    expect(ctx.engine.replies.find((reply) => reply.parentId === resumed).text).toBe("Logs are clean.");
  });

  it("a reconciling row whose history read keeps failing gives up with outcome_unknown and frees its slot", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-h", "x");
    await ctx.tick();
    ctx.bridge.onGatewayDisconnect();
    ctx.gateway.active.clear();
    const realRequest = ctx.gateway.requestGateway;
    ctx.gateway.requestGateway = async (method, params, ...rest) => {
      if (method === "chat.history") throw new Error("history unavailable");
      return realRequest(method, params, ...rest);
    };
    ctx.nowRef.value += 3 * 60 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    ctx.nowRef.value += 61 * 60 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "unknown", code: "outcome_unknown" });
  });
});



describe("relay bridge: a failing wake hook (ALPH-63)", () => {
  it("keeps its event cursor when the wake hook throws, and moves on once it succeeds", async () => {
    let fail = true;
    const ctx = setup({ onRelayMessage: async () => {
      if (fail) throw new Error("database is locked");
    } });
    try {
      await ctx.tick();
      const before = ctx.store.getCursor();
      ctx.engine.dm("capy-q", "for a bound thread");
      await expect(ctx.bridge._internal.pollOnce()).rejects.toThrow("database is locked");
      expect(ctx.store.getCursor()).toBe(before);
      fail = false;
      await ctx.bridge._internal.pollOnce();
      expect(ctx.store.getCursor()).toBeGreaterThan(before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("relay bridge: replies leave the box with credentials masked (ALPH-63)", () => {
  it("masks a secret-named env value and token shapes in the answer before posting it", async () => {
    const previous = process.env.RELAY_TEST_API_KEY;
    process.env.RELAY_TEST_API_KEY = "relaytestsecretvalue1234567890";
    const ctx = setup();
    try {
      await ctx.tick();
      const messageId = ctx.engine.dm("capy-leak", "print your key");
      await ctx.tick();
      const [send] = ctx.gateway.sends;
      const credentialUrl = ["https://user", "hunter2pass@db.example.com/x"].join(":");
      await ctx.end(send, "key=relaytestsecretvalue1234567890 and " + credentialUrl);
      const [reply] = ctx.engine.replies;
      expect(reply.parentId).toBe(messageId);
      expect(reply.text).not.toContain("relaytestsecretvalue1234567890");
      expect(reply.text).not.toContain("hunter2pass");
      expect(reply.text).toContain("***");
    } finally {
      if (previous === undefined) delete process.env.RELAY_TEST_API_KEY;
      else process.env.RELAY_TEST_API_KEY = previous;
      ctx.cleanup();
    }
  });
});

describe("relay bridge: the relay masker and a failing sessions.list (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("masks with the service's masker before posting and before parking the reply in bridge.db", async () => {
    ctx = setup({ maskText: (text) => String(text).split("dotenv-only-secret-42").join("***") });
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-p", "what is in .env?");
    await ctx.tick();
    const realReply = ctx.engine.reply;
    ctx.engine.reply = async () => {
      throw new Error("engine restarting");
    };
    await ctx.end(ctx.gateway.sends[0], "PLAIN=dotenv-only-secret-42");
    const parked = ctx.store.get(messageId);
    expect(parked.state).toBe("replying");
    expect(parked.pendingReply).not.toContain("dotenv-only-secret-42");
    expect(JSON.parse(parked.pendingReply).text).toBe("PLAIN=***");
    ctx.engine.reply = realReply;
    await ctx.reconcile();
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0].text).toBe("PLAIN=***");
  });

  it("posts an answer that names the product unmasked through the real relay masker, and still masks a real .env secret (ALPH-68)", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bridge-mask-"));
    try {
      fs.writeFileSync(path.join(rootDir, ".env"), "PLAIN_SETTING=dotenv-only-secret-42\n");
      ctx = setup({ maskText: createRelayMasker({ rootDir, env: { GOG_KEYRING_PASSWORD: "alphaclaw" } }) });
      await ctx.tick();
      ctx.engine.dm("capy-p", "how do I update?");
      await ctx.tick();
      await ctx.end(ctx.gateway.sends[0], "Run npm i alphaclaw@latest, then restart OpenClaw. PLAIN_SETTING=dotenv-only-secret-42");
      expect(ctx.engine.replies).toHaveLength(1);
      expect(ctx.engine.replies[0].text).toBe("Run npm i alphaclaw@latest, then restart OpenClaw. PLAIN_SETTING=***");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("a sessions.list that keeps throwing waits out each message's recovery window, then ends it with outcome_unknown, and reports the failure", async () => {
    ctx = setup();
    await ctx.tick();
    const first = ctx.engine.dm("capy-s", "x");
    const second = ctx.engine.dm("capy-t", "y");
    await ctx.tick();
    const realRequest = ctx.gateway.requestGateway;
    ctx.gateway.requestGateway = async (method, params, ...rest) => {
      if (method === "sessions.list") throw new Error("sessions.list unavailable");
      return realRequest(method, params, ...rest);
    };
    ctx.bridge.onGatewayDisconnect();
    ctx.store.update(second, { state: "dispatched" });
    for (let tick = 1; tick <= 12; tick += 1) {
      ctx.nowRef.value += 30 * 1000;
      await ctx.reconcile();
    }
    expect(ctx.store.get(first).state).toBe("reconciling");
    expect(ctx.bridge.getStatus().sessionsListFailures).toBe(12);
    expect(ctx.bridge.getStatus().failure).toContain("session list failed 12 times");
    ctx.bridge.onGatewayDisconnect();
    ctx.nowRef.value += 30 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(second).state).toBe("reconciling");
    ctx.nowRef.value += 4 * 60 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(first)).toMatchObject({ state: "unknown", code: "outcome_unknown" });
    expect(ctx.store.get(second).state).toBe("reconciling");
    expect(ctx.engine.replies.map((reply) => reply.data.relay_code)).toEqual(["outcome_unknown"]);
    ctx.nowRef.value += 6 * 60 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(second)).toMatchObject({ state: "unknown", code: "outcome_unknown" });
    await ctx.reconcile();
    expect(ctx.bridge.getStatus()).toMatchObject({ sessionsListFailures: 0, failure: null });
  });

  it("one sessions.list failure does not end a run that has been reconciling, and running, past the recovery window", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-long", "x");
    await ctx.tick();
    ctx.bridge.onGatewayDisconnect();
    for (let tick = 1; tick <= 22; tick += 1) {
      ctx.nowRef.value += 30 * 1000;
      await ctx.reconcile();
    }
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    const realRequest = ctx.gateway.requestGateway;
    ctx.gateway.requestGateway = async (method, params, ...rest) => {
      if (method === "sessions.list") throw new Error("sessions.list unavailable");
      return realRequest(method, params, ...rest);
    };
    ctx.nowRef.value += 30 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    expect(ctx.engine.replies).toHaveLength(0);
    ctx.gateway.requestGateway = realRequest;
    ctx.nowRef.value += 30 * 1000;
    await ctx.reconcile();
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    expect(ctx.bridge.getStatus().sessionsListFailures).toBe(0);
  });
});


describe("relay bridge: latency and single-finisher fixes (ALPH-68)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  const runStartedDespiteTimeout = (messageId, sessionKey, answer) => {
    ctx.gateway.history.set(sessionKey, [
      { role: "user", content: "[Agent Relay message from @capy-t]\n(ref relay:" + messageId + ", hop 0)\npolicy\n\nslow one" },
      ...(answer ? [{ role: "assistant", content: [{ type: "text", text: answer }] }] : []),
    ]);
  };

  it("a send that timed out still ends through its run's lifecycle end, with one reply (the ALPH-64 timeline)", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-t", "slow one");
    ctx.gateway.failNextSend(Object.assign(new Error("OpenClaw chat.send request timed out"), { written: true }));
    await ctx.tick();
    const row = ctx.store.get(messageId);
    expect(row).toMatchObject({ state: "reconciling", code: "outcome_unknown", runId: "relay-" + messageId });
    ctx.nowRef.value += 8000;
    runStartedDespiteTimeout(messageId, row.sessionKey, "Here is the slow answer.");
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: "relay-" + messageId, sessionKey: row.sessionKey, stream: "lifecycle", data: { phase: "end" } } });
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("answered");
    expect(ctx.engine.replies).toEqual([expect.objectContaining({ parentId: messageId, text: "Here is the slow answer." })]);
    await ctx.reconcile();
    await flush(20);
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("an ambiguous send that lost its events with a gateway restart keeps the whole grace from the disconnect, so a pass never posts the text before a tool call", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-t", "slow one");
    ctx.gateway.failNextSend(Object.assign(new Error("OpenClaw chat.send request timed out"), { written: true }));
    await ctx.tick();
    ctx.bridge.onGatewayDisconnect();
    const { sessionKey } = ctx.store.get(messageId);
    runStartedDespiteTimeout(messageId, sessionKey, null);
    ctx.gateway.active.add(sessionKey);
    ctx.gateway.answer({ sessionKey }, "Let me check the logs first.");
    ctx.nowRef.value += 60 * 1000;
    await ctx.reconcile();
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    expect(ctx.engine.replies).toEqual([]);
    ctx.gateway.answer({ sessionKey }, "The logs are clean.");
    ctx.nowRef.value += 2 * 60 * 1000;
    await ctx.reconcile();
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("answered");
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("an ambiguous send still tracked on a live connection is left to its lifecycle end, so a pass never posts the text before a tool call", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-t", "slow one");
    ctx.gateway.failNextSend(Object.assign(new Error("OpenClaw chat.send request timed out"), { written: true }));
    await ctx.tick();
    const { sessionKey } = ctx.store.get(messageId);
    runStartedDespiteTimeout(messageId, sessionKey, "Let me check the logs first.");
    ctx.nowRef.value += 10000;
    await ctx.reconcile();
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    expect(ctx.engine.replies).toEqual([]);
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: "relay-" + messageId, sessionKey, stream: "assistant", data: { delta: "The logs are clean." } } });
    ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: "relay-" + messageId, sessionKey, stream: "lifecycle", data: { phase: "end" } } });
    await flush(20);
    expect(ctx.store.get(messageId).state).toBe("answered");
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("two reconcile triggers and a lifecycle end racing for one message post exactly one reply", async () => {
    ctx = setup();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-t", "slow one");
    ctx.gateway.failNextSend(Object.assign(new Error("OpenClaw chat.send request timed out"), { written: true }));
    await ctx.tick();
    const { sessionKey } = ctx.store.get(messageId);
    runStartedDespiteTimeout(messageId, sessionKey, "Only once.");
    ctx.nowRef.value += 3 * 60 * 1000;
    await Promise.all([
      ctx.reconcile(),
      ctx.reconcile(),
      Promise.resolve().then(() =>
        ctx.bridge.handleGatewayEvent({ event: "agent", payload: { runId: "relay-" + messageId, sessionKey, stream: "lifecycle", data: { phase: "end" } } }),
      ),
    ]);
    await flush(30);
    expect(ctx.store.get(messageId).state).toBe("answered");
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("strips OpenClaw's verbose host notices from the start of an answer before it leaves the box", async () => {
    expect(stripHostNotices("🧭 New session: 0c1d-sess\n🧹 Auto-compaction complete (count 2).\n\nThe answer.")).toBe("The answer.");
    expect(stripHostNotices("The answer mentions 🧭 New session: x later.")).toBe("The answer mentions 🧭 New session: x later.");
    ctx = setup();
    await ctx.tick();
    ctx.engine.dm("capy-v", "hi");
    await ctx.tick();
    await ctx.end(ctx.gateway.sends[0], "🧭 New session: 6f1e2c3d-box-session\n\nHello from the box.");
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Hello from the box."]);
  });

  it("claims a row only from the states it names", () => {
    ctx = setup();
    ctx.store.insert({ messageId: "m1", sender: "s", conversationId: "c", threadRoot: "m1", sessionKey: "agent:main:relay-s", state: "reconciling" });
    expect(ctx.store.claim("m1", ["dispatched", "reconciling"], "completing")).toBe(true);
    expect(ctx.store.claim("m1", "reconciling", "completing")).toBe(false);
    expect(ctx.store.get("m1").state).toBe("completing");
  });
});

