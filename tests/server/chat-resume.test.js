// Phase-5 resume-streaming suite for the chat bridge: hello advertises
// resumable runs, {type:"resume"} replays the per-run buffer to the new
// socket (then `resumed`), live frames fan out to every attached socket,
// finalized/unknown/expired runs fail cleanly with `unknown_run`, grace
// expiry drops the buffer ONLY (never a synthetic terminal), and buffer
// overflow reports an honest gap. Hardening tests carry allow-legit twins.
const {
  createChatBridgeTestKit,
  waitUntil,
} = require("./helpers/chat-gateway-harness");

const kStreamFrameTypes = ["started", "chunk", "tool", "done"];

describe("server/chat resume streaming", () => {
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

  const emitDelta = (harness, runId, text) =>
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId, stream: "assistant", data: { delta: text } },
    });

  const emitLifecycleEnd = (harness, runId) =>
    harness.emit({
      type: "event",
      event: "agent",
      payload: { runId, stream: "lifecycle", data: { phase: "end" } },
    });

  // Close the browser socket and wait for the server side to observe it
  // (detachSocket runs on the server's close event, a beat later).
  const closeBrowser = async (browser) => {
    browser.close();
    await waitUntil(() => browser.client.readyState === 3, "closed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const streamFrames = (browser) =>
    browser.messages.filter(
      (m) => kStreamFrameTypes.includes(m.type) && typeof m.seq === "number",
    );

  it("a hard-refreshed tab resumes the live stream from the buffer", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");

    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-1",
      runId: "run-r1",
      clientMsgId: "cm-r1",
    });
    emitDelta(harness, "run-r1", "alpha");
    emitDelta(harness, "run-r1", "beta");
    await waitUntil(
      () => browserA.messages.filter((m) => m.type === "chunk").length === 2,
      "two chunks on A",
    );

    // Hard refresh: the old tab's socket goes away; the run stays live.
    await closeBrowser(browserA);

    const browserB = await kit.openBrowser(service);
    const hello = await browserB.waitFor((m) => m.type === "hello", "hello B");
    expect(hello).toMatchObject({ protocolVersion: 2 });
    const advertised = (hello.activeRuns || []).find(
      (run) => run.runId === "run-r1",
    );
    expect(advertised).toBeTruthy();
    expect(advertised.sessionKey).toBe("rs-1");
    expect(advertised.seq).toBeGreaterThanOrEqual(3);

    browserB.send({
      type: "resume",
      sessionKey: "rs-1",
      runId: "run-r1",
      afterSeq: 0,
    });
    const resumed = await browserB.waitFor(
      (m) => m.type === "resumed" && m.runId === "run-r1",
      "resumed",
    );
    expect(resumed).toMatchObject({ sessionKey: "rs-1", gap: false });
    expect(resumed.toSeq).toBeGreaterThanOrEqual(3);

    // Replay arrived before `resumed`: started (seq 1) then both chunks in order.
    const replayed = streamFrames(browserB);
    expect(replayed[0]).toMatchObject({
      type: "started",
      sessionKey: "rs-1",
      runId: "run-r1",
      seq: 1,
    });
    const replayedChunks = replayed.filter((m) => m.type === "chunk");
    expect(replayedChunks.map((m) => m.content)).toEqual(["alpha", "beta"]);
    expect(replayedChunks[0].seq).toBeLessThan(replayedChunks[1].seq);

    // The re-attached socket now gets live frames.
    emitDelta(harness, "run-r1", "gamma");
    const gamma = await browserB.waitFor(
      (m) => m.type === "chunk" && m.content === "gamma",
      "live gamma on B",
    );
    expect(gamma.runId).toBe("run-r1");

    emitLifecycleEnd(harness, "run-r1");
    const done = await browserB.waitFor(
      (m) => m.type === "done" && m.runId === "run-r1",
      "done on B",
    );
    expect(done.reason).toBe("complete");

    // Replay + live must never hand the client the same seq twice.
    const seqs = streamFrames(browserB).map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("a second tab attaches while the first stays live — both receive fan-out", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");

    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-2",
      runId: "run-r2",
      clientMsgId: "cm-r2",
    });

    const browserB = await kit.openBrowser(service);
    await browserB.waitFor((m) => m.type === "hello", "hello B");
    browserB.send({
      type: "resume",
      sessionKey: "rs-2",
      runId: "run-r2",
      afterSeq: 0,
    });
    const resumed = await browserB.waitFor(
      (m) => m.type === "resumed" && m.runId === "run-r2",
      "resumed on B",
    );
    expect(resumed.gap).toBe(false);
    expect(
      browserB.messages.some((m) => m.type === "started" && m.seq === 1),
    ).toBe(true);

    emitDelta(harness, "run-r2", "shared");
    const chunkA = await browserA.waitFor(
      (m) => m.type === "chunk" && m.content === "shared",
      "chunk on A",
    );
    const chunkB = await browserB.waitFor(
      (m) => m.type === "chunk" && m.content === "shared",
      "chunk on B",
    );
    expect(chunkA.seq).toBe(chunkB.seq);

    emitLifecycleEnd(harness, "run-r2");
    const doneA = await browserA.waitFor(
      (m) => m.type === "done" && m.runId === "run-r2",
      "done on A",
    );
    const doneB = await browserB.waitFor(
      (m) => m.type === "done" && m.runId === "run-r2",
      "done on B",
    );
    expect(doneA.reason).toBe("complete");
    expect(doneB.seq).toBe(doneA.seq);
  });

  it("resume for a finalized or unknown run fails cleanly", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");

    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-3",
      runId: "run-r3",
      clientMsgId: "cm-r3",
    });
    emitLifecycleEnd(harness, "run-r3");
    await browserA.waitFor(
      (m) => m.type === "done" && m.runId === "run-r3",
      "done on A",
    );

    const browserB = await kit.openBrowser(service);
    const hello = await browserB.waitFor((m) => m.type === "hello", "hello B");
    expect(
      (hello.activeRuns || []).some((run) => run.runId === "run-r3"),
    ).toBe(false);

    // (a) Finalized run: the record is gone from the registry.
    browserB.send({
      type: "resume",
      sessionKey: "rs-3",
      runId: "run-r3",
      afterSeq: 0,
    });
    const failedFinalized = await browserB.waitFor(
      (m) => m.type === "resume-failed" && m.runId === "run-r3",
      "resume-failed for finalized run",
    );
    expect(failedFinalized).toMatchObject({
      sessionKey: "rs-3",
      code: "unknown_run",
    });

    // (b) Never-existing run.
    browserB.send({
      type: "resume",
      sessionKey: "rs-3",
      runId: "run-never-existed",
      afterSeq: 0,
    });
    const failedUnknown = await browserB.waitFor(
      (m) => m.type === "resume-failed" && m.runId === "run-never-existed",
      "resume-failed for unknown run",
    );
    expect(failedUnknown.code).toBe("unknown_run");
  });

  it("grace expiry drops the buffer and stops advertising the run", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness, {
      timings: { resumeGraceMs: 80 },
    });
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");

    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-4",
      runId: "run-r4",
      clientMsgId: "cm-r4",
    });
    emitDelta(harness, "run-r4", "buffered");
    await browserA.waitFor(
      (m) => m.type === "chunk" && m.content === "buffered",
      "chunk on A",
    );

    // Last attached socket closes → grace window arms → expires at 80ms.
    await closeBrowser(browserA);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const browserB = await kit.openBrowser(service);
    const hello = await browserB.waitFor((m) => m.type === "hello", "hello B");
    expect(
      (hello.activeRuns || []).find((run) => run.runId === "run-r4"),
    ).toBeUndefined();

    browserB.send({
      type: "resume",
      sessionKey: "rs-4",
      runId: "run-r4",
      afterSeq: 0,
    });
    const failed = await browserB.waitFor(
      (m) => m.type === "resume-failed" && m.runId === "run-r4",
      "resume-failed after grace expiry",
    );
    expect(failed.code).toBe("unknown_run");

    // Honesty check: expiry dropped the buffer ONLY — the record was never
    // terminalized, so the REAL lifecycle end still lands without crashing
    // (no sockets remain to receive the done). The bridge keeps serving.
    emitLifecycleEnd(harness, "run-r4");
    harness.onRequest = kit.respondEmptyHistory(harness);
    browserB.send({ type: "history", sessionKey: "rs-4" });
    const history = await browserB.waitFor(
      (m) => m.type === "history" && m.sessionKey === "rs-4",
      "history round-trip after expiry + lifecycle end",
    );
    expect(history.messages).toEqual([]);
  });

  it("buffer overflow reports a gap", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");

    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-5",
      runId: "run-r5",
      clientMsgId: "cm-r5",
    });
    // ~40 × ~10KB frames ≈ 400KB > the 256KB replay cap → drop-oldest.
    const bigDelta = "x".repeat(10_000);
    for (let i = 0; i < 40; i += 1) emitDelta(harness, "run-r5", bigDelta);
    await waitUntil(
      () => browserA.messages.filter((m) => m.type === "chunk").length === 40,
      "all 40 chunks on A",
    );

    const browserB = await kit.openBrowser(service);
    await browserB.waitFor((m) => m.type === "hello", "hello B");
    browserB.send({
      type: "resume",
      sessionKey: "rs-5",
      runId: "run-r5",
      afterSeq: 0,
    });
    const resumed = await browserB.waitFor(
      (m) => m.type === "resumed" && m.runId === "run-r5",
      "resumed on B",
    );
    expect(resumed.gap).toBe(true);
    expect(resumed.toSeq).toBe(41); // started + 40 chunks

    // Oldest frames (started seq 1 and early chunks) were evicted.
    const replayed = streamFrames(browserB);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed[0].seq).toBeGreaterThan(1);
    expect(resumed.fromSeq).toBe(replayed[0].seq);
  });

  // Allow-legit twin for run advertising: no live runs → nothing advertised.
  it("a cursor beyond the run's own seq reports a gap (per-run seq vs stale session cursor)", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browserA = await kit.openBrowser(service);
    await browserA.waitFor((m) => m.type === "hello", "hello A");
    await kit.startRun({
      harness,
      browser: browserA,
      sessionKey: "rs-stale",
      runId: "run-stale",
      clientMsgId: "cm-stale",
    });
    emitDelta(harness, "run-stale", "one");
    await browserA.waitFor((m) => m.type === "chunk", "chunk on A");

    // A client whose per-session cursor carried over from an earlier, longer
    // run asks past this run's end: an empty replay must NOT read as
    // "complete" — frames may have been missed during the disconnect.
    const browserB = await kit.openBrowser(service);
    await browserB.waitFor((m) => m.type === "hello", "hello B");
    browserB.send({
      type: "resume",
      sessionKey: "rs-stale",
      runId: "run-stale",
      afterSeq: 99,
    });
    const resumed = await browserB.waitFor(
      (m) => m.type === "resumed" && m.runId === "run-stale",
      "resumed with gap",
    );
    expect(resumed.gap).toBe(true);
    expect(streamFrames(browserB)).toHaveLength(0);
  });

  it("a browser connecting while no runs are live gets an empty activeRuns list", async () => {
    const harness = await kit.startGatewayHarness();
    const service = kit.createService(harness);
    const browser = await kit.openBrowser(service);
    const hello = await browser.waitFor((m) => m.type === "hello", "hello");
    expect(hello.activeRuns).toEqual([]);
  });
});
