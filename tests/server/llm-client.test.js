const { createFrontierLlmClient } = require("../../lib/server/llm-client");

// The frontier chain contract: most capable model first, gated on which
// provider keys exist, falling through on provider/model failures — and the
// exact wire shapes each provider requires (these are the drift points).

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

const anthropicBody = (text, stopReason = "end_turn") => ({
  content: [{ type: "text", text }],
  stop_reason: stopReason,
});

describe("server/llm-client", () => {
  it("reports unavailable with no provider key, available with one", () => {
    const none = createFrontierLlmClient({ env: {} });
    expect(none.getAvailability()).toMatchObject({
      available: false,
      reason: "no_api_key",
    });

    const withKey = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
    });
    expect(withKey.getAvailability()).toMatchObject({
      available: true,
      provider: "anthropic",
      model: "claude-fable-5",
    });

    // Anthropic outranks the others even when every key is present.
    const all = createFrontierLlmClient({
      env: {
        ANTHROPIC_API_KEY: "a",
        OPENAI_API_KEY: "b",
        GEMINI_API_KEY: "c",
      },
    });
    expect(all.getAvailability().provider).toBe("anthropic");
  });

  it("sends the documented Anthropic request shape for claude-fable-5", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(anthropicBody("hello")));
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      fetchImpl,
    });

    const result = await client.complete({ system: "sys", prompt: "p" });
    expect(result).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "claude-fable-5",
      text: "hello",
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBe("sk-ant-x");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");
    // Fable 5 carries the server-side refusal fallback (scalar form).
    expect(options.headers["anthropic-beta"]).toBe(
      "server-side-fallback-2026-07-01",
    );
    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-fable-5");
    expect(body.fallbacks).toBe("default");
    // Thinking is always on for Fable 5 — the param must be omitted.
    expect("thinking" in body).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "p" }]);
  });

  it("falls through a whole-chain refusal to claude-opus-5 on the same key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(anthropicBody("", "refusal")))
      .mockResolvedValueOnce(jsonResponse(anthropicBody("rescued")));
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p" });
    expect(result).toMatchObject({ ok: true, model: "claude-opus-5" });
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondBody.model).toBe("claude-opus-5");
    // Opus requests carry neither the fallback param nor its beta header.
    expect("fallbacks" in secondBody).toBe(false);
    expect(
      "anthropic-beta" in (fetchImpl.mock.calls[1][1].headers || {}),
    ).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });

  it("skips a provider's remaining models after a 401 and moves to the next provider", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "bad key" } }, { ok: false, status: 401 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: "from openai" } }] }),
      );
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "bad", OPENAI_API_KEY: "sk-oai" },
      fetchImpl,
    });

    const result = await client.complete({ system: "sys", prompt: "p" });
    expect(result).toMatchObject({
      ok: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      text: "from openai",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(options.headers.authorization).toBe("Bearer sk-oai");
    const body = JSON.parse(options.body);
    // gpt-5.x rejects max_tokens; the param is max_completion_tokens.
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect("max_tokens" in body).toBe(false);
  });

  it("reaches Gemini with the key in a header, never the URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "from " }, { text: "gemini" }] } }],
      }),
    );
    const client = createFrontierLlmClient({
      env: { GEMINI_API_KEY: "g-key" },
      fetchImpl,
    });

    const result = await client.complete({ system: "sys", prompt: "p" });
    expect(result).toMatchObject({ ok: true, provider: "google", text: "from gemini" });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(url).not.toContain("g-key");
    expect(options.headers["x-goog-api-key"]).toBe("g-key");
  });

  it("treats a 403 as model-scoped: claude-opus-5 still runs on the same key", async () => {
    // Anthropic returns 403 permission_error for model allowlist/beta gating
    // with a perfectly valid key — only a 401 condemns the whole provider.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { type: "permission_error", message: "model not allowed" } },
          { ok: false, status: 403 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(anthropicBody("from opus")));
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "sk-ant-x" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p" });
    expect(result).toMatchObject({ ok: true, model: "claude-opus-5", text: "from opus" });
  });

  it("keeps the abort timer armed through the response-body read", async () => {
    // Headers can arrive and the body then stall forever — the body read must
    // be covered by the same timeout, or complete() hangs unbounded while the
    // watchdog holds the gateway lifecycle lock.
    const fetchImpl = vi.fn(async (url, { signal }) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }));
    const client = createFrontierLlmClient({
      env: { GEMINI_API_KEY: "g" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p", timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.attempts[0].error).toMatch(/timed out after 20ms/);
  });

  it("returns a per-candidate attempt trail when every candidate fails", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p", timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(3); // fable, opus, gemini
    expect(result.attempts[0].error).toMatch(/timed out/);
  });

  it("labels an undici-style body abort (TypeError: terminated) as a timeout", async () => {
    // undici wraps a body-read abort in TypeError, not AbortError — the
    // signal state is the truth.
    const fetchImpl = vi.fn(async (url, { signal }) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new TypeError("terminated")));
        }),
    }));
    const client = createFrontierLlmClient({
      env: { GEMINI_API_KEY: "g" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p", timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.attempts[0].error).toMatch(/timed out after 20ms/);
  });

  it("fails with the no-key error when no provider key is configured", async () => {
    const fetchImpl = vi.fn();
    const client = createFrontierLlmClient({ env: {}, fetchImpl });

    const result = await client.complete({ prompt: "p" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no frontier-model API key configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats an empty content array as a failed candidate, not a success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: [], stop_reason: "end_turn" }))
      .mockResolvedValueOnce(jsonResponse(anthropicBody("recovered")));
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "a" },
      fetchImpl,
    });

    const result = await client.complete({ prompt: "p" });
    expect(result).toMatchObject({ ok: true, model: "claude-opus-5", text: "recovered" });
    expect(result.attempts[0].error).toBe("empty completion");
  });

  it("stops trying candidates once the overall deadline is spent", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => {
      now += 10_000;
      return jsonResponse({ error: {} }, { ok: false, status: 500 });
    });
    const client = createFrontierLlmClient({
      env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" },
      fetchImpl,
      nowFn: () => now,
    });

    const result = await client.complete({ prompt: "p", deadlineMs: 10_000 });
    expect(result.ok).toBe(false);
    // First candidate consumed the whole deadline; the rest never ran.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
