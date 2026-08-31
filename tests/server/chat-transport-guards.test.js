const { createChatBridgeTestKit, waitUntil } = require("./helpers/chat-gateway-harness");
const {
  validateMessageFrame,
  kMaxInboundFramesPerWindow,
} = require("../../lib/server/chat/protocol");

describe("server/chat transport guards", () => {
  let originalGatewayToken;
  let cleanups;
  let kit;

  beforeEach(() => {
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    cleanups = [];
    kit = createChatBridgeTestKit({ cleanups });
  });

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try {
        await fn();
      } catch {}
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
  });

  it("closes a flooding socket with 1008 (allow-legit twin: a realistic burst survives)", async () => {
    const harness = await kit.startGatewayHarness();
    harness.onRequest = kit.respondEmptyHistory(harness);
    const service = kit.createService(harness);

    const flooder = await kit.openBrowser(service);
    const closeCode = new Promise((resolve) => flooder.client.once("close", resolve));
    for (let index = 0; index <= kMaxInboundFramesPerWindow; index += 1) {
      flooder.send({ type: "ping", ts: index });
    }
    expect(await closeCode).toBe(1008);

    // Twin: a realistic reconnect burst (a handful of sends across sessions,
    // history requests, pings) stays comfortably under the cap.
    const legit = await kit.openBrowser(service);
    harness.onRequest = (frame) => {
      if (frame.method === "chat.history") harness.respond(frame.id, { messages: [] });
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: `r-${frame.id}` });
    };
    for (let index = 0; index < 5; index += 1) {
      legit.send({
        type: "message",
        clientMsgId: `burst-${index}`,
        sessionKey: `burst-s${index}`,
        content: "go",
      });
      legit.send({ type: "history", sessionKey: `burst-s${index}` });
      legit.send({ type: "ping", ts: index });
    }
    const history = await legit.waitFor(
      (m) => m.type === "history" && m.sessionKey === "burst-s4",
      "burst history",
    );
    expect(history.messages).toEqual([]);
    expect(legit.client.readyState).toBe(1);
  });

  it("a throwing chat-runs store never blocks a send, warns once, and is counted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingStore = new Proxy(
      {},
      {
        get:
          () =>
          () => {
            throw new Error("db exploded");
          },
      },
    );
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: "r-store" });
    };
    const service = kit.createService(harness, { chatRunsStore: throwingStore });
    const browser = await kit.openBrowser(service);
    browser.send({
      type: "message",
      clientMsgId: "cm-store",
      sessionKey: "s-store",
      content: "hi",
    });
    await browser.waitFor((m) => m.type === "ack", "ack");
    await browser.waitFor((m) => m.type === "started", "started");
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId: "r-store", stream: "lifecycle", data: { phase: "end" } },
    });
    await browser.waitFor((m) => m.type === "done", "done");

    // Best-effort contract held end to end; degradation is loud-once and
    // visible in the ops stats.
    const storeWarnings = warnSpy.mock.calls.filter(([line]) =>
      String(line).includes("chat-runs store unavailable"),
    );
    expect(storeWarnings).toHaveLength(1);
    expect(service.getChatStats().storeFailures).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it("validateMessageFrame enforces id and content bounds", () => {
    const long = "x".repeat(129);
    expect(
      validateMessageFrame({ sessionKey: long, content: "hi" }).ok,
    ).toBe(false);
    expect(
      validateMessageFrame({ sessionKey: "s", clientMsgId: long, content: "hi" }).ok,
    ).toBe(false);
    // Boundary 128-char ids and absent clientMsgId (legacy) are valid.
    expect(
      validateMessageFrame({ sessionKey: "x".repeat(128), content: "hi" }).ok,
    ).toBe(true);
    expect(
      validateMessageFrame({
        sessionKey: "s",
        clientMsgId: "x".repeat(128),
        content: "hi",
      }).ok,
    ).toBe(true);
    // Control characters are rejected: the registry's composite key is
    // newline-delimited (an id containing \n could collide two records) and
    // ids are echoed into structured log lines.
    expect(
      validateMessageFrame({ sessionKey: "a\nb", content: "hi" }).ok,
    ).toBe(false);
    expect(
      validateMessageFrame({
        sessionKey: "s",
        clientMsgId: "cm\u0000x",
        content: "hi",
      }).ok,
    ).toBe(false);
    const oversized = validateMessageFrame({
      sessionKey: "s",
      content: "y".repeat(1_100_000),
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.code).toBe("payload_too_large");
  });

  it("rejects junk ids on stop and resume frames before any gateway RPC", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    browser.send({ type: "stop", sessionKey: "x".repeat(200) });
    await browser.waitFor(
      (m) => m.type === "error" && m.message === "sessionKey is invalid",
      "invalid stop",
    );
    browser.send({ type: "resume", sessionKey: "s", runId: "r".repeat(200), afterSeq: 0 });
    await browser.waitFor(
      (m) => m.type === "resume-failed" && m.code === "unknown_run",
      "invalid resume",
    );
    // No junk ever reached the gateway.
    await waitUntil(() => true, "noop");
    expect(
      harness.requests.filter(
        (frame) => frame.method === "chat.abort" || frame.method === "chat.history",
      ),
    ).toHaveLength(0);
  });
});
