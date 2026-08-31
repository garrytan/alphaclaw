// Gateway-disconnect lifecycle suite for the chat bridge: honest terminals on
// gateway drop, unknown-outcome settlement for in-flight sends, the stall
// sweeper (+ watchdog telemetry), browser keepalive, close-code error
// classification, and a deterministic chaos run.
const { WebSocket } = require("ws");

const { classifyError } = require("../../lib/server/chat/errors");
const {
  createChatBridgeTestKit,
  waitUntil,
} = require("./helpers/chat-gateway-harness");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentEvent = (runId, payload) => ({
  type: "event",
  event: "agent",
  payload: { runId, ...payload },
});
const assistantDelta = (runId, text) =>
  agentEvent(runId, { stream: "assistant", data: { delta: text } });
const lifecycleEnd = (runId) =>
  agentEvent(runId, { stream: "lifecycle", data: { phase: "end" } });

describe("server/chat gateway disconnect lifecycle", () => {
  let cleanups;
  let kit;

  beforeEach(() => {
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
  });

  it("terminalizes every started run when the gateway drops, and recovers on reconnect", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "d-1", runId: "r1" });
    await kit.startRun({ harness, browser, sessionKey: "d-2", runId: "r2" });

    harness.socket.close(1000, "bye");

    const doneFirst = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "d-1",
      "d-1 interrupted done",
    );
    const doneSecond = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "d-2",
      "d-2 interrupted done",
    );
    expect(doneFirst).toMatchObject({
      runId: "r1",
      reason: "interrupted",
      confidence: "unconfirmed",
    });
    expect(doneFirst.detail).toBeTruthy();
    expect(doneSecond).toMatchObject({
      runId: "r2",
      reason: "interrupted",
      confidence: "unconfirmed",
    });
    expect(browser.messages.filter((m) => m.type === "done")).toHaveLength(2);

    // Lazy reconnect: the harness wss keeps listening, so the next chat.send
    // dials a fresh gateway connection. kit.startRun's own waitFor may match
    // the pre-disconnect started frame for d-1, so the real recovery proof is
    // the second connect plus the fresh r3 started below (registry cleaned,
    // session not stuck busy).
    await kit.startRun({ harness, browser, sessionKey: "d-1", runId: "r3" });
    await waitUntil(() => harness.connectCount === 2, "second gateway connect");
    const restarted = await browser.waitFor(
      (m) => m.type === "started" && m.sessionKey === "d-1" && m.runId === "r3",
      "restarted r3",
    );
    expect(restarted.runId).toBe("r3");
    expect(
      browser.messages.some(
        (m) => m.type === "send-failed" || m.type === "error",
      ),
    ).toBe(false);
  });

  it("settles an in-flight send as unknown when the gateway dies mid-RPC", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);

    // Capture the chat.send but never respond — the RPC stays in flight with
    // the frame already written (rpcWritten), so a disconnect is ambiguous.
    let heldSendFrame = null;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send") heldSendFrame = frame;
    };
    browser.send({
      type: "message",
      sessionKey: "u-1",
      content: "hi",
      clientMsgId: "cm-1",
    });
    await browser.waitFor(
      (m) => m.type === "ack" && m.clientMsgId === "cm-1",
      "ack",
    );
    await waitUntil(() => heldSendFrame !== null, "held chat.send frame");

    harness.socket.close(1000, "bye");

    const failed = await browser.waitFor((m) => m.type === "send-failed", "send-failed");
    expect(failed).toMatchObject({
      clientMsgId: "cm-1",
      sessionKey: "u-1",
      code: "unknown_outcome",
      retryable: false,
    });
    expect(failed.message).toBeTruthy();
    errorSpy.mockRestore();
  });

  it("sweeps a silent run as interrupted and records the watchdog event (plus allow-legit twin)", async () => {
    const watchdogEvents = [];
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness, {
      timings: { stallMs: 400, sweepIntervalMs: 40 },
      insertWatchdogEvent: (event) => watchdogEvents.push(event),
    });
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "sw-1", runId: "rs1" });

    harness.emit(assistantDelta("rs1", "first"));
    await browser.waitFor(
      (m) => m.type === "chunk" && m.content === "first",
      "first chunk",
    );

    // Go silent: no lifecycle end ever arrives; the sweeper must terminalize.
    const sweepStartedAt = Date.now();
    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "sw-1",
      "swept done",
    );
    expect(Date.now() - sweepStartedAt).toBeLessThan(2000);
    expect(done.reason).toBe("interrupted");
    expect(done.confidence).toBe("unconfirmed");
    expect(watchdogEvents).toHaveLength(1);
    expect(watchdogEvents[0]).toMatchObject({
      eventType: "chat_run_stall_interrupted",
      source: "chat",
      status: "info",
    });
    expect(watchdogEvents[0].details).toMatchObject({
      sessionKey: "sw-1",
      runId: "rs1",
    });

    // Allow-legit twin: a run older than stallMs that KEEPS emitting output is
    // never swept — liveness is measured from the last event, not run start.
    const twinHarness = await kit.startGatewayHarness();
    const twinService = kit.createService(twinHarness, {
      // Wide margin (15x the emit cadence): a loaded CI runner stalling the
      // event loop for a few hundred ms must not sweep a healthy run.
      timings: { stallMs: 1500, sweepIntervalMs: 40 },
    });
    const twinBrowser = await kit.openBrowser(twinService);
    await kit.startRun({
      harness: twinHarness,
      browser: twinBrowser,
      sessionKey: "sw-2",
      runId: "rs2",
    });
    for (let tick = 0; tick < 7; tick += 1) {
      twinHarness.emit(assistantDelta("rs2", `tick-${tick}`));
      await sleep(100);
    }
    twinHarness.emit(lifecycleEnd("rs2"));
    const twinDone = await twinBrowser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "sw-2",
      "twin done",
    );
    expect(twinDone.reason).toBe("complete");
    await sleep(150);
    expect(twinBrowser.messages.filter((m) => m.type === "done")).toHaveLength(1);
  });

  it("keepalive pings do not disturb a healthy browser connection", async () => {
    const harness = await kit.startGatewayHarness();
    harness.onRequest = kit.respondEmptyHistory(harness);
    const service = kit.createService(harness, {
      timings: { pingIntervalMs: 40 },
    });
    const browser = await kit.openBrowser(service);

    // ~6 ping cycles; the ws client answers WS-protocol pings automatically,
    // so missedPongs never reaches the two-strike termination threshold.
    await sleep(250);
    expect(browser.client.readyState).toBe(WebSocket.OPEN);

    browser.send({ type: "history", sessionKey: "k-1" });
    const history = await browser.waitFor(
      (m) => m.type === "history" && m.sessionKey === "k-1",
      "history after ping cycles",
    );
    expect(history.messages).toEqual([]);

    browser.send({ type: "ping", ts: 123 });
    const pong = await browser.waitFor((m) => m.type === "pong", "pong");
    expect(pong.ts).toBe(123);
  });

  it("classifies disconnect close-codes as gateway_unavailable", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const disconnect = classifyError(new Error("Gateway disconnected (code 1006)"));
    expect(disconnect.code).toBe("gateway_unavailable");
    expect(disconnect.retryable).toBe(true);
    const mystery = classifyError(new Error("some inexplicable kaboom"));
    expect(mystery.code).toBe("unknown");
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it("chaos: shuffled, duplicated, and dropped run events still produce exactly one terminal", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    await kit.startRun({ harness, browser, sessionKey: "cx-1", runId: "rcx" });

    const events = [
      ...Array.from({ length: 8 }, (_, i) => assistantDelta("rcx", `d${i}`)),
      assistantDelta("rcx", "d3"), // duplicate delta
      agentEvent("rcx", {
        stream: "tool",
        data: { phase: "start", name: "exec", toolCallId: "t1", args: { cmd: "ls" } },
      }),
      agentEvent("rcx", {
        stream: "tool",
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "t1",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        },
      }),
      lifecycleEnd("rcx"),
      lifecycleEnd("rcx"),
      assistantDelta("rcx", "post-end"), // delta after the ends (pre-shuffle)
    ];

    // Deterministic Fisher-Yates using a tiny seeded LCG (Numerical Recipes
    // constants) so the chaos ordering reproduces run-to-run — no Math.random.
    let lcgState = 20260831;
    const nextRandom = () => {
      lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
      return lcgState / 2 ** 32;
    };
    for (let i = events.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextRandom() * (i + 1));
      [events[i], events[j]] = [events[j], events[i]];
    }
    // Force at least one lifecycle:end to land before the final event, so the
    // run finalizes with later events still incoming. (With two ends one is
    // always not-last; this guard keeps the invariant explicit.)
    const isEnd = (e) => e.payload.stream === "lifecycle";
    if (!events.slice(0, -1).some(isEnd)) {
      const lastIndex = events.length - 1;
      [events[2], events[lastIndex]] = [events[lastIndex], events[2]];
    }

    for (const event of events) harness.emit(event);

    const done = await browser.waitFor(
      (m) => m.type === "done" && m.sessionKey === "cx-1",
      "chaos done",
    );
    expect(done.reason).toBe("complete");
    // Post-terminal events must neither crash the bridge nor emit a second
    // terminal (they are dropped or buffered under the H13 caps).
    await sleep(200);
    expect(
      browser.messages.filter((m) => m.type === "done" && m.sessionKey === "cx-1"),
    ).toHaveLength(1);

    harness.onRequest = kit.respondEmptyHistory(harness);
    browser.send({ type: "history", sessionKey: "cx-1" });
    const history = await browser.waitFor(
      (m) => m.type === "history" && m.sessionKey === "cx-1",
      "history after chaos",
    );
    expect(history.messages).toEqual([]);
  });
});
