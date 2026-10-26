const { createModelFailureWatch } = require("../../lib/server/model-failure-watch");

// Lines as OpenClaw 2026.10.7 prints them in the gateway output (ANSI kept):
// the session-override note, then the fallback decision for the model.
const kOverride =
  "\u001b[90m2026-10-26T14:34:45.406+00:00\u001b[39m \u001b[33m[agent/embedded]\u001b[39m \u001b[33m[model-fallback] configured fallbacks disabled by user model override run=fdbc288f session=sha256:a4df18c3dcca\u001b[39m";
const decision = (ref, next = "none", detail = "404 The requested model was not found.") =>
  `\u001b[90m2026-10-26T14:34:48.090+00:00\u001b[39m \u001b[34m[model-fallback/decision]\u001b[39m \u001b[33mmodel fallback decision: decision=candidate_failed requested=${ref} candidate=${ref} reason=model_not_found next=${next} detail=${detail}\u001b[39m`;

describe("server/model-failure-watch", () => {
  let clock;
  let notify;
  let insertEvent;
  let checkRef;
  let watch;
  beforeEach(() => {
    clock = Date.parse("2026-10-26T14:34:45.000Z");
    notify = vi.fn(async () => ({ ok: true }));
    insertEvent = vi.fn();
    checkRef = vi.fn(async (ref) => ({
      ref,
      status: "wrong_api",
      severity: "error",
      reason: 'meta answered 404 "The requested model was not found." for muse-wonder-1.0 on openai-completions, but accepted it on openai-responses.',
      fix: 'Set models.providers.meta.api to "openai-responses".',
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    watch = createModelFailureWatch({
      notify,
      insertEvent,
      checkRef,
      readDefaultModel: () => "anthropic/claude-opus-5-5",
      getSecrets: () => ["sk-secret-value-123456"],
      now: () => clock,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("tells the owner which model failed, what the provider said, what the /model override did, and the fix", async () => {
    watch.observeGatewayOutput(`${kOverride}\n`);
    clock += 2600;
    watch.observeGatewayOutput(`${decision("meta/muse-wonder-1.0")}\n`);
    await watch.settled();
    expect(checkRef).toHaveBeenCalledWith("meta/muse-wonder-1.0");
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("A reply failed: model meta/muse-wonder-1.0 was not found");
    expect(message).toContain("OpenClaw reported: 404 The requested model was not found.");
    expect(message).toContain("a /model choice turns off the configured fallbacks");
    expect(message).toContain("Send /model default in that chat to go back to anthropic/claude-opus-5-5.");
    expect(message).toContain('Fix: Set models.providers.meta.api to "openai-responses".');
    expect(opts.eventType).toBe("model_not_found");
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "model_not_found",
      source: "model_watch",
      status: "failed",
      details: expect.objectContaining({ model: "meta/muse-wonder-1.0", override: true, checkStatus: "wrong_api" }),
    }));
    expect(watch.getState().failures[0]).toMatchObject({ model: "meta/muse-wonder-1.0", override: true, check: { status: "wrong_api" } });
  });

  it("alerts once per model per six hours, and again after", async () => {
    watch.observeGatewayOutput(`${decision("fx/a")}\n${decision("fx/a")}\n`);
    clock += 60_000;
    watch.observeGatewayOutput(`${decision("fx/b")}\n`);
    await watch.settled();
    expect(notify.mock.calls.map(([message]) => message.split("\n")[1])).toEqual([
      "⚠️ A reply failed: model fx/a was not found",
      "⚠️ A reply failed: model fx/b was not found",
    ]);
    clock += 6 * 60 * 60 * 1000;
    watch.observeGatewayOutput(`${decision("fx/a")}\n`);
    await watch.settled();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(watch.getState().failures).toHaveLength(4);
  });

  it("says when OpenClaw fell back, leaves out the override sentence without an override, and redacts secrets", async () => {
    watch.observeGatewayOutput(`${decision("fx/a", "anthropic/claude-opus-5-5", "401 bad key sk-secret-value-123456 not found model")}\n`);
    await watch.settled();
    const [message] = notify.mock.calls[0];
    expect(message).toContain("Model fx/a was not found, so OpenClaw answered with anthropic/claude-opus-5-5 instead");
    expect(message).not.toContain("/model default");
    expect(message).not.toContain("sk-secret-value-123456");
    expect(insertEvent.mock.calls[0][0]).toMatchObject({ status: "fell_back", details: { override: false } });
  });

  it("an override note older than two minutes does not mark a later failure, and split chunks still parse", async () => {
    watch.observeGatewayOutput(`${kOverride}\n`);
    clock += 3 * 60_000;
    const line = decision("fx/a");
    watch.observeGatewayOutput(line.slice(0, 40));
    watch.observeGatewayOutput(`${line.slice(40)}\n`);
    await watch.settled();
    expect(watch.getState().failures[0].override).toBe(false);
  });

  it("still tells the owner when the check fails", async () => {
    checkRef.mockRejectedValueOnce(new Error("boom"));
    watch.observeGatewayOutput(`${decision("fx/a")}\n`);
    await watch.settled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).not.toContain("Fix:");
  });
});
