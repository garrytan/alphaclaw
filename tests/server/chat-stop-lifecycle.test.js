const {
  createChatBridgeTestKit,
  waitUntil,
} = require("./helpers/chat-gateway-harness");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createRecordingStore = () => {
  const captured = [];
  return {
    captured,
    chatRunsStore: {
      recordSend() {},
      markRunning() {},
      markStopRequested() {},
      markTerminal(call) {
        captured.push(call);
      },
      findRecentTerminal() {
        return null;
      },
      listMarkers() {
        return [];
      },
    },
  };
};

describe("server/chat stop lifecycle", () => {
  let originalGatewayToken;
  let cleanups;
  let kit;

  beforeEach(() => {
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    cleanups = [];
    kit = createChatBridgeTestKit({ cleanups });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  const abortRequests = (harness) =>
    harness.requests.filter((frame) => frame.method === "chat.abort");

  const emitLifecycleEnd = (harness, runId) => {
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId, stream: "lifecycle", data: { phase: "end" } },
    });
  };

  it("confirms a stop through the gateway lifecycle end", async () => {
    const harness = await kit.startGatewayHarness();
    const { captured, chatRunsStore } = createRecordingStore();
    const service = kit.createService(harness, { chatRunsStore });
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "st-1", runId: "r1" });

    harness.onRequest = (frame) => {
      if (frame.method === "chat.abort") harness.respond(frame.id, {});
    };
    browser.send({ type: "stop", sessionKey: "st-1" });
    const stopping = await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-1",
      "stopping frame",
    );
    expect(stopping.runId).toBe("r1");

    await waitUntil(
      () => abortRequests(harness).length >= 1,
      "chat.abort request",
    );
    expect(abortRequests(harness)[0].params).toEqual({ sessionKey: "st-1" });

    emitLifecycleEnd(harness, "r1");
    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-1",
      "stopped done",
    );
    expect(done).toMatchObject({
      reason: "stopped",
      stopped: true,
      confidence: "confirmed",
      runId: "r1",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      sessionKey: "st-1",
      runId: "r1",
      status: "stopped",
      confidence: "confirmed",
      stopConfirmed: 1,
    });
  });

  it("synthesizes an unconfirmed stop when no lifecycle end arrives, and never emits a second done", async () => {
    const harness = await kit.startGatewayHarness();
    const { captured, chatRunsStore } = createRecordingStore();
    const service = kit.createService(harness, {
      chatRunsStore,
      timings: { stopConfirmMs: 120 },
    });
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "st-2", runId: "r2" });

    harness.onRequest = (frame) => {
      if (frame.method === "chat.abort") harness.respond(frame.id, {});
    };
    const stopSentAt = Date.now();
    browser.send({ type: "stop", sessionKey: "st-2" });
    await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-2",
      "stopping frame",
    );

    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-2",
      "unconfirmed done",
    );
    expect(done).toMatchObject({
      reason: "stopped",
      stopped: true,
      confidence: "unconfirmed",
      runId: "r2",
    });
    expect(Date.now() - stopSentAt).toBeGreaterThanOrEqual(100);

    emitLifecycleEnd(harness, "r2");
    await sleep(150);
    expect(browser.messages.filter((m) => m.type === "done")).toHaveLength(1);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      status: "stopped",
      confidence: "unconfirmed",
      stopConfirmed: 0,
    });
  });

  it("reports stop-failed honestly when the abort fails, and the run keeps streaming (allow-legit twin)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "st-3", runId: "r3" });

    harness.onRequest = (frame) => {
      if (frame.method === "chat.abort") {
        harness.fail(frame.id, { message: "abort exploded" });
      }
    };
    browser.send({ type: "stop", sessionKey: "st-3" });
    await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-3",
      "stopping frame",
    );
    const stopFailed = await browser.waitFor(
      (m) => m.type === "stop-failed",
      "stop-failed frame",
    );
    expect(stopFailed).toMatchObject({ sessionKey: "st-3", runId: "r3" });
    expect(typeof stopFailed.code).toBe("string");
    expect(stopFailed.code.length).toBeGreaterThan(0);
    expect(browser.messages.some((m) => m.type === "done")).toBe(false);

    harness.emit({
      type: "event",
      event: "agent",
      payload: {
        runId: "r3",
        stream: "assistant",
        data: { delta: "still alive" },
      },
    });
    const chunk = await browser.waitFor((m) => m.type === "chunk", "chunk");
    expect(chunk.content).toBe("still alive");
    expect(chunk.runId).toBe("r3");

    harness.onRequest = (frame) => {
      if (frame.method === "chat.abort") harness.respond(frame.id, {});
    };
    browser.send({ type: "stop", sessionKey: "st-3" });
    await waitUntil(
      () => browser.messages.filter((m) => m.type === "stopping").length >= 2,
      "second stopping frame",
    );
    emitLifecycleEnd(harness, "r3");
    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-3",
      "stopped done",
    );
    expect(done).toMatchObject({
      reason: "stopped",
      stopped: true,
      confidence: "confirmed",
    });
  });

  it("a stop during the send window aborts after started, and a timer-finalized stop kills a late run as an orphan", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness, {
      timings: { stopConfirmMs: 100 },
    });
    const browser = await kit.openBrowser(service);

    // (a) chat.send response wins the race: the run starts, the deferred stop
    // re-aborts after `started`, and the timer terminalizes the run as stopped.
    let heldSend = null;
    const heldAborts = [];
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSend = frame;
      if (frame.method === "chat.abort") heldAborts.push(frame);
    };
    browser.send({
      type: "message",
      clientMsgId: "cm-a",
      sessionKey: "st-4",
      content: "go",
    });
    await browser.waitFor(
      (m) => m.type === "ack" && m.sessionKey === "st-4",
      "ack st-4",
    );
    await waitUntil(() => heldSend !== null, "held chat.send");

    browser.send({ type: "stop", sessionKey: "st-4" });
    const stopping = await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-4",
      "stopping st-4",
    );
    expect(stopping.runId).toBeUndefined();
    await waitUntil(() => heldAborts.length >= 1, "pre-start abort");

    harness.respond(heldSend.id, { runId: "r4" });
    const started = await browser.waitFor(
      (m) => m.type === "started" && m.sessionKey === "st-4",
      "started st-4",
    );
    expect(started.runId).toBe("r4");
    expect(
      browser.messages.some((m) => m.type === "done" && m.sessionKey === "st-4"),
    ).toBe(false);
    await waitUntil(() => heldAborts.length >= 2, "deferred abort after started");
    for (const frame of heldAborts.splice(0)) harness.respond(frame.id, {});

    const doneA = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-4",
      "stopped done st-4",
    );
    expect(doneA).toMatchObject({
      reason: "stopped",
      stopped: true,
      runId: "r4",
    });
    // A late lifecycle end loses to the already-finalized record: still one done.
    emitLifecycleEnd(harness, "r4");
    await sleep(120);
    expect(
      browser.messages.filter(
        (m) => m.type === "done" && m.sessionKey === "st-4",
      ),
    ).toHaveLength(1);

    // (b) the stop-confirm timer wins while chat.send is still pending: the
    // late run is never announced and gets killed as an orphan.
    let heldLateSend = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldLateSend = frame;
      if (frame.method === "chat.abort") harness.respond(frame.id, {});
    };
    browser.send({
      type: "message",
      clientMsgId: "cm-b",
      sessionKey: "st-5",
      content: "go",
    });
    await browser.waitFor(
      (m) => m.type === "ack" && m.sessionKey === "st-5",
      "ack st-5",
    );
    await waitUntil(() => heldLateSend !== null, "held late chat.send");

    browser.send({ type: "stop", sessionKey: "st-5" });
    await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-5",
      "stopping st-5",
    );
    const doneB = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-5",
      "timer-finalized done st-5",
    );
    expect(doneB).toMatchObject({
      reason: "stopped",
      stopped: true,
      confidence: "unconfirmed",
    });
    expect(doneB.runId).toBeUndefined();

    const abortsBeforeLateRun = abortRequests(harness).length;
    harness.respond(heldLateSend.id, { runId: "r5-late" });
    await waitUntil(
      () => abortRequests(harness).length > abortsBeforeLateRun,
      "orphan-kill abort",
    );
    expect(abortRequests(harness).at(-1).params).toEqual({
      sessionKey: "st-5",
    });
    await sleep(100);
    expect(
      browser.messages.some(
        (m) => m.type === "started" && m.sessionKey === "st-5",
      ),
    ).toBe(false);
    expect(browser.messages.some((m) => m.runId === "r5-late")).toBe(false);
  });

  it("swallows an abort failure that loses the race to a natural completion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "st-6", runId: "r6" });

    let heldAbort = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.abort") heldAbort = frame;
    };
    browser.send({ type: "stop", sessionKey: "st-6" });
    await browser.waitFor(
      (m) => m.type === "stopping" && m.sessionKey === "st-6",
      "stopping frame",
    );
    await waitUntil(() => heldAbort !== null, "held chat.abort");

    // The record is in "stopping" when the natural end lands, so the terminal
    // still records as stopped/confirmed — documented residual.
    emitLifecycleEnd(harness, "r6");
    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "st-6",
      "done",
    );
    expect(done).toMatchObject({
      reason: "stopped",
      stopped: true,
      confidence: "confirmed",
    });

    harness.fail(heldAbort.id, { message: "abort exploded late" });
    await sleep(100);
    expect(browser.messages.some((m) => m.type === "stop-failed")).toBe(false);
  });
});
