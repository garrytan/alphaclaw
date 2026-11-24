const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createRelayBridge, locateAnswerInHistory } = require("../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");

// GST-3677: outside cron, OpenClaw runs image_generate (and video_generate,
// music_generate) as a background task (shouldDetachMediaGenerationTask).
// The relay turn ends with "Background task started ..." and the finished
// media arrives later as its own turn in the same session. For the owner's
// own thread the bridge posts that later turn's answer as the one reply.

const kAgent = "capy-alph-167";
const kStarted = "Background task started for image generation (task_01). Do not call image_generate again for this request. The finished media is delivered in a later message.";

const flush = async (times = 40) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

const createFakeEngine = ({ boxAgent = "wintermute" } = {}) => {
  let seq = 0;
  let id = 1000;
  const events = [];
  const messages = new Map();
  const replies = [];
  const engine = {
    replies,
    dm(from, text, metadata = {}) {
      const message = { id: String(++id), agent_name: from, text, metadata, created_at: new Date().toISOString() };
      messages.set(message.id, message);
      events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: "dm_" + from, message: { id: message.id, agent_name: from, text } } });
      return message.id;
    },
    events: async (key, since, limit) => {
      const page = events.filter((event) => event.seq > since).slice(0, limit);
      return { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since };
    },
    conversations: async () => [...new Set(events.map((event) => event.payload.message.agent_name))].map((name) => ({ id: "dm_" + name, type: "1:1", participants: [name, boxAgent] })),
    getMessage: async (token, messageId) => {
      const message = messages.get(String(messageId));
      if (!message) throw Object.assign(new Error("not found"), { engineStatus: 404 });
      return message;
    },
    reply: async (token, parentId, text, data) => {
      const message = { id: String(++id), agent_name: boxAgent, text, metadata: data || {}, thread_id: parentId, created_at: new Date().toISOString() };
      messages.set(message.id, message);
      replies.push({ parentId, text, data: data || {} });
      return message;
    },
    thread: async () => ({ replies: [] }),
  };
  return engine;
};

const createFakeGateway = () => {
  const sends = [];
  const history = new Map();
  const active = new Set();
  const reads = [];
  return {
    sends,
    history,
    active,
    reads,
    requestGateway: async (method, params, timeoutMs, { onFrameWritten } = {}) => {
      if (method === "chat.send") {
        onFrameWritten?.();
        sends.push({ ...params });
        history.set(params.sessionKey, [...(history.get(params.sessionKey) || []), { role: "user", content: params.message }]);
        active.add(params.sessionKey);
        return { runId: params.idempotencyKey, status: "started" };
      }
      if (method === "chat.history") {
        reads.push(params.sessionKey);
        return { messages: history.get(params.sessionKey) || [] };
      }
      if (method === "sessions.list") return { sessions: [...active].map((key) => ({ key, hasActiveRun: true })) };
      if (method === "chat.abort") return { ok: true };
      throw new Error("unexpected method " + method);
    },
  };
};

// The relay turn: image_generate detaches and the agent acknowledges.
const mediaTurn = (tool = "image_generate", started = kStarted, t0 = 1) => [
  { role: "assistant", content: [{ type: "toolCall", id: "img1", name: tool, arguments: { prompt: "a lighthouse at dusk" } }], timestamp: t0 },
  { role: "toolResult", toolCallId: "img1", toolName: tool, content: [{ type: "text", text: started }], timestamp: t0 + 1 },
  { role: "assistant", content: [{ type: "text", text: "Started the image; it comes back in a moment." }], timestamp: t0 + 2 },
];

// The completion turn OpenClaw starts when the task finishes.
// Its user row is OpenClaw's runtime prompt (formatTaskCompletionEvent).
const completionTurn = (t0 = 100, task = "task_01", text = "Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png") => [
  { role: "user", content: "[Internal task completion event]\nsource: image_generation\nsession_key: image_generate:" + task + "\nsession_id: " + task + "\ntype: image generation task\nstatus: completed", timestamp: t0 },
  { role: "assistant", content: [{ type: "text", text }], timestamp: t0 + 1 },
];

const setup = ({ dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-media-")), nowRef = { value: Date.now() }, verdict = { trust: "delegate", pinned: true, generation: 1, grantId: "g1" } } = {}) => {
  const store = openBridgeStore({ dbPath: path.join(dir, "bridge.db"), now: () => nowRef.value });
  const engine = setup.engine || createFakeEngine();
  const gateway = setup.gateway || createFakeGateway();
  const verdictRef = { value: verdict };
  const bridge = createRelayBridge({
    engine,
    getAuth: () => ({ workspaceKey: "rk", agentToken: "at", agentName: "wintermute" }),
    store,
    requestGateway: (...args) => gateway.requestGateway(...args),
    requestPeerGateway: (...args) => gateway.requestGateway(...args),
    resolveAgentId: () => "main",
    resolveSenderTrust: () => verdictRef.value,
    config: { maxConcurrent: 2, hourlyCap: 30 },
    now: () => nowRef.value,
    setTimer: () => null,
    clearTimer: () => {},
    logger: { log: () => {}, warn: () => {} },
  });
  bridge.start();
  const { pollOnce, pump, reconcile } = bridge._internal;
  const tick = async () => {
    await pollOnce();
    await pump();
    await flush();
  };
  const end = async (send, rows) => {
    gateway.history.get(send.sessionKey).push(...rows);
    gateway.active.delete(send.sessionKey);
    bridge.handleGatewayEvent({ event: "agent", payload: { runId: send.idempotencyKey, sessionKey: send.sessionKey, stream: "lifecycle", data: { phase: "end" } } });
    await flush();
  };
  const later = async (ms) => {
    nowRef.value += ms;
    await reconcile();
    await flush();
  };
  return { dir, store, engine, gateway, bridge, tick, end, later, nowRef, verdictRef, close: () => { bridge.stop(); store.close(); } };
};

const start = async (ctx, text = "Make me an image of a lighthouse at dusk.") => {
  await ctx.tick();
  const messageId = ctx.engine.dm(kAgent, text, { relay_generation: 1 });
  await ctx.tick();
  return { messageId, send: ctx.gateway.sends.at(-1) };
};

describe("relay bridge: a background media task in the owner's own thread (GST-3677)", () => {
  let ctx;
  afterEach(() => {
    ctx?.close();
    ctx = null;
    delete setup.engine;
    delete setup.gateway;
  });

  it("waits for the media completion turn and posts its answer as the one reply", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    expect(ctx.store.get(messageId)).toMatchObject({ trust: "delegate", pinnedBinding: kAgent, state: "dispatched" });
    await ctx.end(send, mediaTurn());
    expect(ctx.engine.replies).toEqual([]);
    const held = ctx.store.get(messageId);
    expect(held.state).toBe("reconciling");
    expect(held.mediaWaitUntil).toBe(ctx.nowRef.value + 15 * 60 * 1000);
    expect(held.mediaAnswerKey).toMatch(/^[a-f0-9]{64}$/);
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    ctx.gateway.history.get(send.sessionKey).push(completionTurn()[0]);
    ctx.gateway.active.add(send.sessionKey);
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    ctx.gateway.history.get(send.sessionKey).push(completionTurn()[1]);
    ctx.gateway.active.delete(send.sessionKey);
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
    expect(ctx.engine.replies[0].data.relay_status).toBe("answered");
    expect(ctx.store.get(messageId).state).toBe("answered");
    await ctx.later(20 * 60 * 1000);
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.gateway.sends).toHaveLength(1);
  });

  it("reads history at most every 10 seconds while it waits", async () => {
    ctx = setup();
    const { send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    const before = ctx.gateway.reads.length;
    for (let step = 0; step < 4; step += 1) await ctx.later(3 * 1000);
    expect(ctx.gateway.reads.length - before).toBe(1);
  });

  it("a restart during the wait posts exactly once, from the stored wait", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    const { dir, nowRef, engine, gateway } = ctx;
    ctx.close();
    setup.engine = engine;
    setup.gateway = gateway;
    ctx = setup({ dir, nowRef });
    expect(ctx.store.get(messageId)).toMatchObject({ state: "reconciling", pinnedBinding: kAgent });
    expect(ctx.store.get(messageId).mediaWaitUntil).toBeGreaterThan(nowRef.value);
    await ctx.later(11 * 1000);
    expect(engine.replies).toEqual([]);
    gateway.history.get(send.sessionKey).push(...completionTurn());
    await ctx.later(11 * 1000);
    await ctx.later(11 * 1000);
    expect(engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
    expect(gateway.sends).toHaveLength(1);
  });

  it("a gateway restart before the run's end still holds the reply for the media", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    ctx.bridge.onGatewayDisconnect();
    ctx.gateway.history.get(send.sessionKey).push(...mediaTurn());
    ctx.gateway.active.delete(send.sessionKey);
    await ctx.later(3 * 60 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "reconciling" });
    expect(ctx.store.get(messageId).mediaWaitUntil).toBeGreaterThan(ctx.nowRef.value);
    ctx.gateway.history.get(send.sessionKey).push(...completionTurn());
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
  });

  it("posts at once when the completion turn already answered before the first read", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, [...mediaTurn(), ...completionTurn()]);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "answered", mediaWaitUntil: null });
  });

  it("after a gateway restart, a completion that already answered is posted without a wait or a note", async () => {
    ctx = setup();
    const { send } = await start(ctx);
    ctx.bridge.onGatewayDisconnect();
    ctx.gateway.history.get(send.sessionKey).push(...mediaTurn(), ...completionTurn());
    ctx.gateway.active.delete(send.sessionKey);
    await ctx.later(3 * 60 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
  });

  it("OpenClaw's restart recovery prompt is not the completion turn", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    const recovered = [
      ...mediaTurn().slice(0, 2),
      { role: "user", content: "[System] Your previous turn was interrupted while OpenClaw was waiting on tool/model work.", timestamp: 4 },
      { role: "assistant", content: [{ type: "text", text: "Resumed: the image task is running." }], timestamp: 5 },
    ];
    await ctx.end(send, recovered);
    expect(ctx.engine.replies).toEqual([]);
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    ctx.gateway.history.get(send.sessionKey).push(...completionTurn());
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the lighthouse.\nMEDIA:/data/.openclaw/media/generated/lighthouse.png"]);
  });

  it("a late completion of an earlier message's task is never this message's reply", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, [...mediaTurn("image_generate", kStarted.replace("task_01", "task_02")), ...completionTurn(100, "task_01", "Here is the OLD lighthouse.")]);
    expect(ctx.engine.replies).toEqual([]);
    expect(ctx.store.get(messageId).state).toBe("reconciling");
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    ctx.gateway.history.get(send.sessionKey).push(...completionTurn(200, "task_02", "Here is the new lighthouse."));
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Here is the new lighthouse."]);
  });

  it("the 15-minute deadline holds while a completion turn is still running", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    ctx.gateway.active.add(send.sessionKey);
    await ctx.later(14 * 60 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    await ctx.later(61 * 1000);
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0].text).toContain("[Relay: the generated media was not ready within 15 minutes");
    expect(ctx.store.get(messageId).state).toBe("answered");
  });

  it("a held row keeps its own lane waiting but frees its run slot", async () => {
    ctx = setup();
    const { send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    await ctx.tick();
    ctx.engine.dm("capy-other-a", "first", {});
    ctx.engine.dm("capy-other-b", "second", {});
    const same = ctx.engine.dm(kAgent, "and another", { relay_generation: 1 });
    await ctx.tick();
    expect(ctx.gateway.sends.map((sent) => sent.sessionKey)).toEqual([send.sessionKey, "agent:main:relay-capy-other-a", "agent:main:relay-capy-other-b"]);
    expect(ctx.store.get(same).state).toBe("queued");
  });

  it("with no completion in 15 minutes it posts the reply it has, with a note", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    await ctx.later(14 * 60 * 1000);
    expect(ctx.engine.replies).toEqual([]);
    await ctx.later(61 * 1000);
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0].text).toMatch(/^Started the image; it comes back in a moment\.\n\n\[Relay: the generated media was not ready within 15 minutes/);
    expect(ctx.store.get(messageId).state).toBe("answered");
    ctx.gateway.history.get(send.sessionKey).push(...completionTurn());
    await ctx.later(60 * 1000);
    expect(ctx.engine.replies).toHaveLength(1);
  });

  it("a thread that stops being the owner's own while it waits gets its reply at once", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    ctx.verdictRef.value = { trust: "delegate", pinned: false, generation: 1, grantId: "g1" };
    await ctx.tick();
    expect(ctx.store.get(messageId).pinnedBinding).toBe(null);
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Started the image; it comes back in a moment.\n\n[Relay: this thread stopped being the owner's own while its generated media was pending, so the relay does not send the media here.]"]);
  });

  it("a thread demoted before its completion arrived never gets the completion's media", async () => {
    ctx = setup();
    const { send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    ctx.verdictRef.value = { trust: "delegate", pinned: false, generation: 1, grantId: "g1" };
    await ctx.tick();
    ctx.gateway.history.get(send.sessionKey).push(...completionTurn());
    await ctx.later(11 * 1000);
    expect(ctx.engine.replies).toHaveLength(1);
    expect(ctx.engine.replies[0].text).not.toContain("MEDIA:");
    expect(ctx.engine.replies[0].text).toMatch(/^Started the image; it comes back in a moment\.\n\n\[Relay: this thread stopped being the owner's own/);
  });

  it("a delegate that is not the owner's own thread is answered at once, as before", async () => {
    ctx = setup({ verdict: { trust: "delegate", generation: 1, grantId: "g1" } });
    const { messageId, send } = await start(ctx);
    await ctx.end(send, mediaTurn());
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["Started the image; it comes back in a moment."]);
    expect(ctx.store.get(messageId)).toMatchObject({ state: "answered", mediaWaitUntil: null });
  });

  it("a turn with no background media task is answered at once", async () => {
    ctx = setup();
    const { messageId, send } = await start(ctx);
    await ctx.end(send, [{ role: "assistant", content: [{ type: "text", text: "It is 4pm." }], timestamp: 5 }]);
    expect(ctx.engine.replies.map((reply) => reply.text)).toEqual(["It is 4pm."]);
    expect(ctx.store.get(messageId).mediaWaitUntil).toBe(null);
  });

  it("finds the background start for each media tool, through the dispatcher too, and nothing else", () => {
    const messageId = "m1";
    const userRow = { role: "user", content: "[Agent Relay message from @capy-x]\n(ref relay:m1, hop 0)\nmake art" };
    const located = (rows) => locateAnswerInHistory({ messages: [userRow, ...rows] }, messageId);
    expect(located(mediaTurn()).mediaStarted).toBe(true);
    expect(located(mediaTurn("video_generate", "Background task started for video generation (task_02). Do not call video_generate again.")).mediaStarted).toBe(true);
    expect(located(mediaTurn("music_generate", "Background task started for music generation (task_03).")).mediaStarted).toBe(true);
    const wrapped = [
      { role: "assistant", content: [{ type: "toolCall", id: "d1", name: "dispatch_action", arguments: { id: "openclaw:core:image_generate", params: { prompt: "x" } } }] },
      { role: "toolResult", toolCallId: "d1", toolName: "dispatch_action", content: [{ type: "text", text: JSON.stringify({ tool: { id: "openclaw:core:image_generate" }, result: { text: kStarted } }) }] },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
    ];
    expect(located(wrapped).mediaStarted).toBe(true);
    expect(located(mediaTurn("image_generate", "Generated 1 image.\nMEDIA:/tmp/a.png")).mediaStarted).toBe(false);
    expect(located(mediaTurn("exec", kStarted)).mediaStarted).toBe(false);
    expect(located([{ role: "assistant", content: [{ type: "text", text: kStarted }] }]).mediaStarted).toBe(false);
  });

  it("adds the wait columns to a bridge.db from before them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-media-migrate-"));
    const dbPath = path.join(dir, "bridge.db");
    const first = openBridgeStore({ dbPath, now: () => 1 });
    first.close();
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE relay_messages DROP COLUMN media_wait_until");
    db.exec("ALTER TABLE relay_messages DROP COLUMN media_answer_key");
    db.close();
    const store = openBridgeStore({ dbPath, now: () => 1 });
    try {
      const columns = new DatabaseSync(dbPath).prepare("PRAGMA table_info(relay_messages)").all().map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["media_wait_until", "media_answer_key"]));
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
