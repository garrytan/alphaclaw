const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createChatRunsStore } = require("../../lib/server/db/chat-runs");
const { createChatBridgeTestKit, waitUntil } = require("./helpers/chat-gateway-harness");
const { createRunRegistry } = require("../../lib/server/chat/run-registry");

const kMessage = { type: "message", sessionKey: "s", clientMsgId: "c", content: "do work" };

describe("chat durable admission", () => {
  let rootDir, store, raw, cleanups, kit;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-admission-"));
    store = createChatRunsStore();
    const { path: file } = store.initChatRunsDb({ rootDir, markInterruptedRuns: false });
    raw = new DatabaseSync(file);
    cleanups = [];
    kit = createChatBridgeTestKit({ cleanups });
  });
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
    await new Promise((resolve) => setImmediate(resolve));
    raw.close();
    store.closeChatRunsDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const claim = (overrides = {}) => store.claimSend({ ...kMessage, messageId: "m", ...overrides });

  it("atomically consumes non-submission evidence and never reclaims a live or started-error row", () => {
    expect(claim()).toEqual({ claimed: true });
    expect(claim({ retry: true }).claimed).toBe(false);
    store.markTerminal({ ...kMessage, status: "error", notSubmitted: true });
    expect(store.findRun(kMessage).submissionState).toBe("not_submitted");
    expect(claim({ retry: true })).toEqual({ claimed: true });
    expect(store.findRun(kMessage)).toMatchObject({ status: "pending", submissionState: "possibly_submitted" });
    const other = createChatRunsStore();
    other.initChatRunsDb({ rootDir, markInterruptedRuns: false });
    try { expect(other.claimSend(kMessage).claimed).toBe(false); } finally { other.closeChatRunsDb(); }
    store.markRunning({ ...kMessage, runId: "r" });
    store.markTerminal({ ...kMessage, status: "error", notSubmitted: true });
    expect(store.findRun(kMessage).submissionState).toBe("submitted");
    expect(claim().claimed).toBe(false);
    expect(claim({ clientMsgId: "missing", retry: true })).toEqual({ claimed: false, reason: "unknown_outcome" });
  });

  it("failed conditional claim leaves the safe row intact and dispatches nothing", async () => {
    claim();
    store.markTerminal({ ...kMessage, status: "error", notSubmitted: true });
    raw.exec("CREATE TRIGGER reject_claim BEFORE UPDATE ON chat_runs WHEN NEW.status = 'pending' BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    const harness = await kit.startGatewayHarness();
    const browser = await kit.openBrowser(kit.createService(harness, { chatRunsStore: store }));
    browser.send({ ...kMessage, retry: true });
    expect(await browser.waitFor((m) => m.type === "send-failed")).toMatchObject({ code: "unknown_outcome", notSubmitted: false });
    expect(harness.requests).toHaveLength(0);
    expect(store.findRun(kMessage)).toMatchObject({ status: "error", submissionState: "not_submitted" });
    raw.exec("DROP TRIGGER reject_claim");
    harness.onRequest = (frame) => {
      expect(store.findRun(kMessage).submissionState).toBe("possibly_submitted");
      harness.respond(frame.id, { runId: "r" });
    };
    browser.send({ ...kMessage, retry: true });
    await browser.waitFor((m) => m.type === "started");
    expect(harness.requests.filter((f) => f.method === "chat.send")).toHaveLength(1);
  });

  it.each(["done", "error"])("replays %s after eleven minutes and across service restart without redispatch", async (status) => {
    claim();
    store.markRunning({ ...kMessage, runId: "old-run" });
    store.markTerminal({ ...kMessage, status, confidence: "confirmed" });
    const harness = await kit.startGatewayHarness();
    for (let index = 0; index < 2; index++) {
      const browser = await kit.openBrowser(kit.createService(harness, {
        chatRunsStore: store, now: () => Date.now() + 11 * 60_000,
      }));
      browser.send({ ...kMessage, retry: true });
      expect(await browser.waitFor((m) => m.type === "done")).toMatchObject({
        runId: "old-run", reason: status === "done" ? "complete" : "error",
      });
    }
    expect(harness.requests).toHaveLength(0);
  });

  it("missing evidence, including a lost admission refusal, stays unknown", async () => {
    const harness = await kit.startGatewayHarness();
    const browser = await kit.openBrowser(kit.createService(harness, { chatRunsStore: store }));
    browser.send({ ...kMessage, retry: true });
    expect(await browser.waitFor((m) => m.type === "send-failed")).toMatchObject({ code: "unknown_outcome", notSubmitted: false });
    expect(harness.requests).toHaveLength(0);
    // A positively received refusal lets the browser declare this unsent;
    // a genuinely fresh ID still works normally.
    harness.onRequest = (frame) => harness.respond(frame.id, { runId: "new-run" });
    browser.send({ ...kMessage, clientMsgId: "fresh" });
    await browser.waitFor((m) => m.type === "started");
    expect(harness.requests).toHaveLength(1);
  });

  it("terminal persistence failure never advertises non-submission", async () => {
    const harness = await kit.startGatewayHarness();
    const broken = { ...store, markTerminal: () => { throw new Error("disk failure"); } };
    harness.onRequest = (frame) => harness.fail(frame.id, { message: "gateway request failed" });
    const service = kit.createService(harness, { chatRunsStore: broken });
    const browser = await kit.openBrowser(service);
    browser.send(kMessage);
    expect(await browser.waitFor((m) => m.type === "send-failed")).toMatchObject({ code: "unknown_outcome", notSubmitted: false });
    expect(store.findRun(kMessage)).toMatchObject({ status: "pending", submissionState: "possibly_submitted" });
    browser.send({ ...kMessage, retry: true });
    await waitUntil(() => browser.messages.filter((m) => m.type === "send-failed").length === 2);
    expect(harness.requests).toHaveLength(1);
    expect(service.getChatStats().storeFailures).toBe(1);
  });

  it("pruning preserves old active evidence and admission enforces session and global caps", () => {
    const insert = raw.prepare("INSERT INTO chat_runs(session_key,client_msg_id,status,created_at) VALUES (?,?,?,'2020-01-01')");
    raw.exec("BEGIN");
    for (let i = 0; i < 5000; i++) insert.run(i < 200 ? "full" : `s${i}`, `c${i}`, i % 2 ? "pending" : "running");
    insert.run("old-terminal", "old", "done");
    raw.exec("COMMIT");
    store.pruneChatRuns();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM chat_runs").get().n).toBe(5000);
    expect(claim({ sessionKey: "full" })).toEqual({ claimed: false, reason: "too_many_pending" });
    expect(claim()).toEqual({ claimed: false, reason: "too_many_pending" });
    expect(store.findRun({ sessionKey: "full", clientMsgId: "c0" }).status).toBe("running");
    store.markTerminal({ sessionKey: "full", clientMsgId: "c0", status: "done" });
    expect(claim()).toEqual({ claimed: true });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM chat_runs").get().n).toBe(5000);
  });

  it("legacy error rows default to unknown submission evidence", () => {
    raw.prepare("INSERT INTO chat_runs(session_key,client_msg_id,status) VALUES ('legacy','id','error')").run();
    expect(store.findRun({ sessionKey: "legacy", clientMsgId: "id" }).submissionState).toBe("unknown");
    expect(claim({ sessionKey: "legacy", clientMsgId: "id" }).claimed).toBe(false);
  });

  it("bounds live records across browsers while allowing reattachment at capacity", async () => {
    const harness = await kit.startGatewayHarness();
    harness.onRequest = (frame) => harness.respond(frame.id, { runId: frame.params.idempotencyKey });
    const service = kit.createService(harness, { chatRunsStore: store });
    for (let tab = 0; tab < 4; tab++) {
      const browser = await kit.openBrowser(service);
      for (let i = 0; i < 32; i++) browser.send({ ...kMessage, clientMsgId: `c-${tab}-${i}`, sessionKey: `s-${tab}-${i}` });
      await waitUntil(() => browser.messages.filter((m) => m.type === "started").length === 32);
    }
    const next = await kit.openBrowser(service);
    next.send({ ...kMessage, sessionKey: "s-0-0", clientMsgId: "c-0-0", retry: true });
    await next.waitFor((m) => m.type === "started");
    expect(service.getChatStats().registry.live).toBe(128);
    next.send(kMessage);
    expect(await next.waitFor((m) => m.type === "send-failed")).toMatchObject({ code: "too_many_pending", notSubmitted: true });
    expect(harness.requests).toHaveLength(128);
    harness.emit({ type: "event", event: "agent", payload: { runId: "c-0-0", stream: "lifecycle", data: { phase: "end" } } });
    await next.waitFor((m) => m.type === "done");
    next.send(kMessage);
    await next.waitFor((m) => m.type === "started" && m.clientMsgId === "c");
    expect(harness.requests).toHaveLength(129);
    expect(service.getChatStats().registry.replayBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it("finalization releases replay data even while another callback retains the record", () => {
    const registry = createRunRegistry();
    const record = registry.createRecord({ ...kMessage, ws: {}, messageId: "m", now: Date.now() });
    record.replay = [{ framed: { content: "a".repeat(200_000) } }];
    record.replayBytes = 200_000;
    expect(registry.finalize(record)).toBe(true);
    expect(record).toMatchObject({ replay: [], replayBytes: 0, resumable: false });
  });
});
