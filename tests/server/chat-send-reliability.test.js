// Send-reliability suite for the chat bridge (protocol v2): ack-before-RPC,
// idempotency keys, live + terminal dedupe, session/browser caps, honest
// failure classification (retryable vs confirmed vs unknown), and store
// hygiene. Every hardening test carries an allow-legit twin so the guards
// provably do not break normal traffic.
const { WebSocketServer } = require("ws");

const {
  createChatBridgeTestKit,
  waitUntil,
} = require("./helpers/chat-gateway-harness");

const kUnknownOutcomeMessage =
  "This message may have been sent — check the transcript before retrying.";

describe("server/chat send reliability", () => {
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
      } catch {
        // best-effort cleanup
      }
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
  });

  // Recording chat-runs store: arrays capture every call's args;
  // findRecentTerminal returns null unless a test supplies dedupe rows.
  const createRecordingStore = ({ findRecentTerminal = () => null } = {}) => {
    const calls = {
      recordSend: [],
      markRunning: [],
      markStopRequested: [],
      markTerminal: [],
    };
    return {
      calls,
      store: {
        recordSend: (row) => calls.recordSend.push(row),
        markRunning: (row) => calls.markRunning.push(row),
        markStopRequested: (row) => calls.markStopRequested.push(row),
        markTerminal: (row) => calls.markTerminal.push(row),
        findRecentTerminal,
        listMarkers: () => [],
      },
    };
  };

  it("acks before the gateway responds and uses clientMsgId as the idempotency key", async () => {
    const harness = await kit.startGatewayHarness();
    let heldSend = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSend = frame;
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    const hello = await browser.waitFor((m) => m.type === "hello", "hello");
    expect(browser.messages[0]).toBe(hello);
    expect(hello).toMatchObject({ protocolVersion: 2, maxContentBytes: 1048576 });

    browser.send({
      type: "message",
      clientMsgId: "cm-ack",
      sessionKey: "s-ack",
      content: "hello agent",
    });
    const ack = await browser.waitFor((m) => m.type === "ack", "ack");
    expect(ack).toMatchObject({ clientMsgId: "cm-ack", sessionKey: "s-ack" });
    await waitUntil(() => heldSend !== null, "held chat.send");
    // The RPC is still unanswered — the ack must not have waited for it.
    expect(browser.messages.some((m) => m.type === "started")).toBe(false);

    harness.respond(heldSend.id, { runId: "r1" });
    const started = await browser.waitFor((m) => m.type === "started", "started");
    expect(started).toMatchObject({
      clientMsgId: "cm-ack",
      sessionKey: "s-ack",
      runId: "r1",
      seq: 1,
    });
    expect(started.messageId).toBeTruthy();
    expect(heldSend.params.idempotencyKey).toBe("cm-ack");
    expect(heldSend.params.message).toBe("hello agent");
  });

  it("re-acks a duplicate clientMsgId while the send is live without a second chat.send", async () => {
    const harness = await kit.startGatewayHarness();
    let heldSend = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSend = frame;
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    const messageFrame = {
      type: "message",
      clientMsgId: "cm-dup",
      sessionKey: "s-dup",
      content: "once",
    };
    browser.send(messageFrame);
    browser.send(messageFrame);
    await waitUntil(
      () => browser.messages.filter((m) => m.type === "ack").length === 2,
      "two acks",
    );
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(1);

    harness.respond(heldSend.id, { runId: "r-dup" });
    await browser.waitFor((m) => m.type === "started", "started");
    expect(browser.messages.filter((m) => m.type === "started")).toHaveLength(1);

    // Allow-legit twin: once the run ends, a NEW clientMsgId in the same
    // session dispatches a real second chat.send.
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId: "r-dup", stream: "lifecycle", data: { phase: "end" } },
    });
    await browser.waitFor((m) => m.type === "done", "done");
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: "r-dup-2" });
    };
    browser.send({ ...messageFrame, clientMsgId: "cm-fresh", content: "again" });
    await browser.waitFor(
      (m) => m.type === "started" && m.clientMsgId === "cm-fresh",
      "fresh started",
    );
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(2);
  });

  it("replays the stored terminal on a duplicate of a terminal send", async () => {
    const terminalRows = {
      "cm-stopped": {
        sessionKey: "s-replay",
        clientMsgId: "cm-stopped",
        runId: "r-old",
        messageId: "m-old",
        lastSeq: 7,
        status: "stopped",
        confidence: "confirmed",
        stopConfirmed: 1,
      },
      "cm-unknown": {
        sessionKey: "s-replay",
        clientMsgId: "cm-unknown",
        status: "unknown",
      },
    };
    const { store } = createRecordingStore({
      findRecentTerminal: ({ clientMsgId }) => terminalRows[clientMsgId] || null,
    });
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness, { chatRunsStore: store });
    const browser = await kit.openBrowser(service);

    browser.send({
      type: "message",
      clientMsgId: "cm-stopped",
      sessionKey: "s-replay",
      content: "retry me",
    });
    const done = await browser.waitFor((m) => m.type === "done", "replayed done");
    expect(done).toMatchObject({
      sessionKey: "s-replay",
      runId: "r-old",
      messageId: "m-old",
      reason: "stopped",
      stopped: true,
      confidence: "confirmed",
      seq: 7,
    });
    const ackIndex = browser.messages.findIndex(
      (m) => m.type === "ack" && m.clientMsgId === "cm-stopped",
    );
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(browser.messages.indexOf(done));

    // A stored UNKNOWN outcome replays as a non-retryable send-failed.
    browser.send({
      type: "message",
      clientMsgId: "cm-unknown",
      sessionKey: "s-replay",
      content: "retry me too",
    });
    await browser.waitFor(
      (m) => m.type === "ack" && m.clientMsgId === "cm-unknown",
      "unknown ack",
    );
    const failed = await browser.waitFor(
      (m) => m.type === "send-failed",
      "unknown replay",
    );
    expect(failed).toMatchObject({
      clientMsgId: "cm-unknown",
      sessionKey: "s-replay",
      code: "unknown_outcome",
      retryable: false,
    });
    // Both replays settled from the store alone — the gateway never saw a send.
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(0);
  });

  it("a duplicate of a FAILED send is a fresh attempt, not a replayed failure", async () => {
    // A confirmed pre-write failure writes an `error` terminal row and tells
    // the client it is retryable. The retry keeps the clientMsgId by design —
    // replaying the stored failure here would silently disable the entire
    // retry path for the 10-minute dedupe window.
    const { store } = createRecordingStore({
      findRecentTerminal: ({ clientMsgId }) =>
        clientMsgId === "cm-errored"
          ? {
              sessionKey: "s-retry",
              clientMsgId: "cm-errored",
              status: "error",
              errorCode: "gateway_unavailable",
            }
          : null,
    });
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: "r-retry" });
    };
    const service = kit.createService(harness, { chatRunsStore: store });
    const browser = await kit.openBrowser(service);

    browser.send({
      type: "message",
      clientMsgId: "cm-errored",
      sessionKey: "s-retry",
      content: "try again",
    });
    const started = await browser.waitFor((m) => m.type === "started", "fresh started");
    expect(started).toMatchObject({ clientMsgId: "cm-errored", runId: "r-retry" });
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(1);
  });

  it("a session-routed lifecycle end never finalizes an unstarted record", async () => {
    // A foreign run finishing on the same session during our send window must
    // not fail the pending send (and then orphan-abort our own run when the
    // RPC resolves).
    const harness = await kit.startGatewayHarness();
    let heldSend = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSend = frame;
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    browser.send({
      type: "message",
      clientMsgId: "cm-pending-guard",
      sessionKey: "s-guard",
      content: "hold",
    });
    await browser.waitFor((m) => m.type === "ack", "ack");
    await waitUntil(() => heldSend !== null, "send reached gateway");

    // Foreign lifecycle end routed by session key while our record is pending.
    harness.emit({
      type: "event",
      event: "agent",
      payload: { sessionKey: "s-guard", stream: "lifecycle", data: { phase: "end" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(browser.messages.some((m) => m.type === "send-failed")).toBe(false);
    expect(browser.messages.some((m) => m.type === "done")).toBe(false);

    // Our own RPC then resolves normally — the run starts and completes.
    harness.respond(heldSend.id, { runId: "r-guard" });
    await browser.waitFor((m) => m.type === "started", "started");
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId: "r-guard", stream: "lifecycle", data: { phase: "end" } },
    });
    const done = await browser.waitFor((m) => m.type === "done", "done");
    expect(done.reason).toBe("complete");
  });

  it("rejects a second concurrent send in the same session with session_busy", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    await kit.startRun({
      harness,
      browser,
      sessionKey: "busy-s",
      runId: "r-b",
      clientMsgId: "cm-1",
    });

    browser.send({
      type: "message",
      clientMsgId: "cm-2",
      sessionKey: "busy-s",
      content: "second",
    });
    const busy = await browser.waitFor((m) => m.type === "send-failed", "session busy");
    expect(busy).toMatchObject({
      clientMsgId: "cm-2",
      sessionKey: "busy-s",
      code: "session_busy",
      retryable: true,
    });
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(1);

    // Allow-legit twin: once the active run ends, the same message sends fine.
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId: "r-b", stream: "lifecycle", data: { phase: "end" } },
    });
    await browser.waitFor((m) => m.type === "done", "done");
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: "r-b2" });
    };
    browser.send({
      type: "message",
      clientMsgId: "cm-2",
      sessionKey: "busy-s",
      content: "second",
    });
    await browser.waitFor(
      (m) => m.type === "started" && m.runId === "r-b2",
      "retry started",
    );
  });

  it("accepts old-bundle frames without clientMsgId", async () => {
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") harness.respond(frame.id, { runId: "r-legacy" });
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    browser.send({ type: "message", sessionKey: "s-legacy", content: "old bundle" });
    const started = await browser.waitFor((m) => m.type === "started", "started");
    expect(started).toMatchObject({ sessionKey: "s-legacy", runId: "r-legacy" });
    // The bridge mints an idempotency key when the bundle sends none.
    const sendFrame = harness.requests.find((f) => f.method === "chat.send");
    expect(typeof sendFrame.params.idempotencyKey).toBe("string");
    expect(sendFrame.params.idempotencyKey.length).toBeGreaterThan(0);
    expect(sendFrame.params.message).toBe("old bundle");
  });

  // Allow-legit twin for validation: valid v2 frames flow end-to-end in the
  // ack/idempotency test above.
  it("validates frames per protocol", async () => {
    const service = kit.createService(0);
    const browser = await kit.openBrowser(service);

    // v2 frame (clientMsgId present) with empty content → structured failure.
    browser.send({
      type: "message",
      clientMsgId: "cm-bad",
      sessionKey: "s-v",
      content: "",
    });
    const failed = await browser.waitFor((m) => m.type === "send-failed", "send-failed");
    expect(failed).toMatchObject({
      clientMsgId: "cm-bad",
      sessionKey: "s-v",
      code: "protocol_invalid",
      retryable: false,
    });

    // Legacy frame (no clientMsgId) missing content → plain error frame.
    browser.send({ type: "message", sessionKey: "s-v" });
    const legacyError = await browser.waitFor((m) => m.type === "error", "legacy error");
    expect(legacyError.message).toBe("sessionKey and content are required");
  });

  it("fails oversized content honestly and keeps the socket alive", async () => {
    const harness = await kit.startGatewayHarness();
    harness.onRequest = kit.respondEmptyHistory(harness);
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    // Over the 1MB content cap but under the 2MB frame cap, so the frame is
    // parsed and rejected by the validator instead of killing the socket.
    browser.send({
      type: "message",
      clientMsgId: "cm-big",
      sessionKey: "s",
      content: "x".repeat(1_100_000),
    });
    const failed = await browser.waitFor((m) => m.type === "send-failed", "too large");
    expect(failed).toMatchObject({
      clientMsgId: "cm-big",
      sessionKey: "s",
      code: "payload_too_large",
    });

    // Allow-legit twin: the same socket still serves history afterwards.
    browser.send({ type: "history", sessionKey: "s" });
    const history = await browser.waitFor((m) => m.type === "history", "history");
    expect(history.messages).toEqual([]);
  });

  it("caps live records per browser with too_many_pending", async () => {
    const harness = await kit.startGatewayHarness();
    const heldSends = [];
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSends.push(frame);
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    for (let index = 0; index < 32; index += 1) {
      browser.send({
        type: "message",
        clientMsgId: `cm-${index}`,
        sessionKey: `session-${index}`,
        content: "go",
      });
    }
    await waitUntil(
      () => browser.messages.filter((m) => m.type === "ack").length === 32,
      "32 acks",
    );

    browser.send({
      type: "message",
      clientMsgId: "cm-32",
      sessionKey: "session-32",
      content: "one too many",
    });
    const failed = await browser.waitFor((m) => m.type === "send-failed", "cap hit");
    expect(failed).toMatchObject({
      clientMsgId: "cm-32",
      sessionKey: "session-32",
      code: "too_many_pending",
      retryable: true,
    });

    // Allow-legit twin: all 32 held sends were real — each resolves into a
    // started run (and settling them keeps teardown quiet).
    await waitUntil(() => heldSends.length === 32, "32 held chat.sends");
    for (const [index, frame] of heldSends.entries()) {
      harness.respond(frame.id, { runId: `r-cap-${index}` });
    }
    await waitUntil(
      () => browser.messages.filter((m) => m.type === "started").length === 32,
      "32 started",
    );
  });

  it("never persists raw gateway error text in the store", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, calls } = createRecordingStore();
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") {
        harness.fail(frame.id, { message: "kaboom sk-SECRET-TOKEN path=/etc/shadow" });
      }
    };
    const service = kit.createService(harness, { chatRunsStore: store });
    const browser = await kit.openBrowser(service);

    browser.send({
      type: "message",
      clientMsgId: "cm-secret",
      sessionKey: "s-secret",
      content: "hi",
    });
    const failed = await browser.waitFor((m) => m.type === "send-failed", "send-failed");
    expect(failed.message).not.toContain("sk-SECRET-TOKEN");

    expect(calls.markTerminal).toHaveLength(1);
    const terminal = calls.markTerminal[0];
    expect(terminal.status).toBe("error");
    // The raw text mentions "token", so it classifies as auth — the stored
    // row carries only that canned copy, never the gateway's own message.
    expect(terminal.error).toBe(
      "Gateway authentication failed. Verify OPENCLAW_GATEWAY_TOKEN matches the gateway.",
    );
    expect(terminal.error).not.toContain("sk-SECRET-TOKEN");
    expect(terminal.error).not.toContain("/etc/shadow");
    errorSpy.mockRestore();
  });

  it("classifies pre-write failures as retryable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => probe.once("listening", resolve));
    const deadPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const service = kit.createService(deadPort);
    const browser = await kit.openBrowser(service);

    browser.send({
      type: "message",
      clientMsgId: "cm-dead",
      sessionKey: "s-dead",
      content: "hi",
    });
    const failed = await browser.waitFor((m) => m.type === "send-failed", "send-failed");
    expect(failed).toMatchObject({
      clientMsgId: "cm-dead",
      sessionKey: "s-dead",
      code: "gateway_unavailable",
      retryable: true,
    });
    errorSpy.mockRestore();
  });

  it("treats a post-write disconnect as unknown, but an explicit rejection as a confirmed failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // (a) The gateway socket dies AFTER the chat.send frame was written — the
    // gateway may have accepted it, so the outcome is honestly unknown.
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame, socket) => {
      if (frame.method === "chat.send") socket.close(1000, "bye");
    };
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    browser.send({
      type: "message",
      clientMsgId: "cm-unk",
      sessionKey: "s-unk",
      content: "hi",
    });
    const unknown = await browser.waitFor((m) => m.type === "send-failed", "unknown");
    expect(unknown).toMatchObject({
      clientMsgId: "cm-unk",
      code: "unknown_outcome",
      retryable: false,
      message: kUnknownOutcomeMessage,
    });

    // (b) An explicit ok:false response means the gateway answered: a
    // CONFIRMED failure with the generic classification, never unknown_outcome.
    const harness2 = await kit.startGatewayHarness();
    harness2.onRequest = (frame) => {
      if (frame.method === "chat.send") {
        harness2.fail(frame.id, { message: "some inexplicable kaboom" });
      }
    };
    const service2 = kit.createService(harness2);
    const browser2 = await kit.openBrowser(service2);
    browser2.send({
      type: "message",
      clientMsgId: "cm-conf",
      sessionKey: "s-conf",
      content: "hi",
    });
    const confirmed = await browser2.waitFor(
      (m) => m.type === "send-failed",
      "confirmed failure",
    );
    expect(confirmed).toMatchObject({
      clientMsgId: "cm-conf",
      code: "unknown",
      retryable: false,
    });
    errorSpy.mockRestore();
  });
});
