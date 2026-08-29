const {
  createClaudeCodeService,
  kRoutineBetaHeader,
} = require("../../lib/server/claude-code-service");

const kToken = "sk-ant-oat01-abc123";
const kTrigId = "trig_01ABCDEF";
const kFireUrl = `https://api.anthropic.com/v1/claude_code/routines/${kTrigId}/fire`;
const kSessionId = "session_01HJKLMNOPQRSTUVWXYZ";
const kSessionUrl = `https://claude.ai/code/${kSessionId}`;

const okResponse = (body = {}, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  json: async () => body,
});

const fireBody = {
  type: "routine_fire",
  claude_code_session_id: kSessionId,
  claude_code_session_url: kSessionUrl,
};

const createService = (overrides = {}) => {
  const fetchImpl = overrides.fetchImpl ?? vi.fn(async () => okResponse(fireBody));
  const logger = { info: vi.fn(), error: vi.fn() };
  let now = 1_000_000;
  const service = createClaudeCodeService({
    env: { CLAUDE_CODE_ROUTINE_URL: kFireUrl, CLAUDE_CODE_ROUTINE_TOKEN: kToken },
    fetchImpl,
    logger,
    nowFn: () => now,
    ...overrides,
    ...(overrides.env ? { env: overrides.env } : {}),
  });
  return { service, fetchImpl, logger, advance: (ms) => (now += ms) };
};

describe("claude-code-service config resolution", () => {
  const cases = [
    [{ }, "not_configured"],
    [{ CLAUDE_CODE_ROUTINE_URL: kFireUrl }, "invalid_config"],
    [{ CLAUDE_CODE_ROUTINE_TOKEN: kToken }, "invalid_config"],
    [
      { CLAUDE_CODE_ROUTINE_URL: `https://evil.com/v1/claude_code/routines/${kTrigId}/fire`, CLAUDE_CODE_ROUTINE_TOKEN: kToken },
      "invalid_config",
    ],
    [
      { CLAUDE_CODE_ROUTINE_URL: `http://api.anthropic.com/v1/claude_code/routines/${kTrigId}/fire`, CLAUDE_CODE_ROUTINE_TOKEN: kToken },
      "invalid_config",
    ],
    [
      { CLAUDE_CODE_ROUTINE_URL: kFireUrl, CLAUDE_CODE_ROUTINE_TOKEN: "sk-ant-api03-nope" },
      "invalid_config",
    ],
  ];

  for (const [env, reason] of cases) {
    it(`reports ${reason} for env ${JSON.stringify(env)}`, () => {
      const { service } = createService({ env });
      expect(service.getAvailability()).toEqual(
        expect.objectContaining({ available: false, reason }),
      );
    });
  }

  it("reports available with a valid full fire URL", () => {
    const { service } = createService();
    expect(service.getAvailability()).toEqual({ available: true });
  });

  it("expands a bare trig_ id into the Anthropic fire URL", async () => {
    const { service, fetchImpl } = createService({
      env: { CLAUDE_CODE_ROUTINE_URL: kTrigId, CLAUDE_CODE_ROUTINE_TOKEN: kToken },
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(kFireUrl, expect.any(Object));
  });
});

describe("claude-code-service consent handshake", () => {
  it("refuses without confirmed:true and never touches the network", async () => {
    const { service, fetchImpl } = createService();
    for (const confirmed of [undefined, false, "true", 1]) {
      const result = await service.createSession({ confirmed });
      expect(result).toEqual(
        expect.objectContaining({ ok: false, code: "confirm_required" }),
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not consume the cooldown on a confirm_required probe", async () => {
    const { service } = createService();
    await service.createSession({});
    const result = await service.createSession({ confirmed: true });
    expect(result.ok).toBe(true);
  });
});

describe("claude-code-service createSession", () => {
  it("fires with the exact headers and no body, and returns the session", async () => {
    const { service, fetchImpl, logger } = createService();
    const result = await service.createSession({ confirmed: true });
    expect(result).toEqual({ ok: true, sessionId: kSessionId, sessionUrl: kSessionUrl });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(kFireUrl);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({
      Authorization: `Bearer ${kToken}`,
      "anthropic-beta": kRoutineBetaHeader,
      "anthropic-version": "2023-06-01",
    });
    expect(options.body).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(kSessionId));
  });

  it("maps upstream errors to upstream_<status> with bounded detail", async () => {
    const { service, logger } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse(
          { type: "error", error: { type: "invalid_request_error", message: "routine paused ".repeat(60) } },
          { status: 400 },
        ),
      ),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("upstream_400");
    expect(result.detail.length).toBeLessThanOrEqual(300);
    expect(logger.error).toHaveBeenCalled();
  });

  it("parses Retry-After on upstream 429", async () => {
    const { service } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse({ type: "error", error: {} }, { status: 429, headers: { "retry-after": "42" } }),
      ),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result).toEqual(
      expect.objectContaining({ code: "upstream_429", retryAfterSec: 42 }),
    );
  });

  it("classifies network failures", async () => {
    const { service } = createService({
      fetchImpl: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
      }),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.code).toBe("network");
  });

  it("classifies aborts as timeout via the signal, extends the cooldown to 30s, and says the session may exist", async () => {
    const { service, advance } = createService({
      timeoutMs: 5,
      fetchImpl: vi.fn(
        (url, { signal }) =>
          new Promise((resolve, reject) => {
            // undici surfaces a body-read abort as TypeError: terminated —
            // the service must trust the signal, not the error name.
            signal.addEventListener("abort", () => reject(new TypeError("terminated")));
          }),
      ),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.code).toBe("timeout");
    expect(result.message).toMatch(/may still have been created/i);

    advance(10_000);
    const retry = await service.createSession({ confirmed: true });
    expect(retry.code).toBe("cooldown");
    advance(25_000);
    const later = await service.createSession({ confirmed: true });
    expect(later.code).not.toBe("cooldown");
  });

  const badSuccessBodies = [
    ["missing url", { claude_code_session_id: kSessionId }],
    ["wrong origin", { claude_code_session_id: kSessionId, claude_code_session_url: `https://claude.ai.evil.com/code/${kSessionId}` }],
    ["non-session path", { claude_code_session_id: kSessionId, claude_code_session_url: "https://claude.ai/settings" }],
    ["malformed session id", { claude_code_session_id: "sess-123", claude_code_session_url: kSessionUrl }],
    ["appended query string", { claude_code_session_id: kSessionId, claude_code_session_url: `${kSessionUrl}?next=evil` }],
    ["id/url mismatch", { claude_code_session_id: kSessionId, claude_code_session_url: "https://claude.ai/code/session_OTHER" }],
  ];
  for (const [name, body] of badSuccessBodies) {
    it(`rejects a 200 with ${name} as bad_upstream_response`, async () => {
      const { service } = createService({ fetchImpl: vi.fn(async () => okResponse(body)) });
      const result = await service.createSession({ confirmed: true });
      expect(result.code).toBe("bad_upstream_response");
    });
  }

  it("treats unparseable 200 JSON as bad_upstream_response", async () => {
    const { service } = createService({
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.code).toBe("bad_upstream_response");
  });

  it("single-flights concurrent fires (second gets busy)", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { service } = createService({
      fetchImpl: vi.fn(async () => {
        await gate;
        return okResponse(fireBody);
      }),
    });
    const first = service.createSession({ confirmed: true });
    const second = await service.createSession({ confirmed: true });
    expect(second.code).toBe("busy");
    release();
    expect((await first).ok).toBe(true);
  });

  it("enforces the post-fire cooldown", async () => {
    const { service, advance } = createService();
    expect((await service.createSession({ confirmed: true })).ok).toBe(true);
    const again = await service.createSession({ confirmed: true });
    expect(again.code).toBe("cooldown");
    expect(again.retryAfterSec).toBeGreaterThan(0);
    advance(6_000);
    expect((await service.createSession({ confirmed: true })).ok).toBe(true);
  });

  it("never logs the token, and keeps log lines single-line", async () => {
    const { service, logger } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse(
          { type: "error", error: { message: `bad bearer ${kToken}\nline two` } },
          { status: 401 },
        ),
      ),
    });
    await service.createSession({ confirmed: true });
    const logged = logger.error.mock.calls.flat().join(" ");
    expect(logged).not.toContain(kToken);
    expect(logged).not.toContain("\n");
  });
});

describe("claude-code-service failure-path cooldowns", () => {
  // bad_upstream_response is a DEFINITELY-billed outcome (the fire returned
  // 200), so it gets the long timeout-class window; the others get the short
  // one.
  const failureFetches = [
    // 4xx = clear refusal, short window; 5xx/network/definitely-billed get
    // the long maybe-billed window.
    ["upstream 4xx error", async () => okResponse({ type: "error", error: {} }, { status: 400 }), 6_000],
    ["upstream 5xx error", async () => okResponse({ type: "error", error: {} }, { status: 503 }), 31_000],
    ["bad_upstream_response", async () => okResponse({ claude_code_session_id: "nope" }), 31_000],
    [
      "network failure",
      async () => {
        throw new Error("read ECONNRESET");
      },
      31_000,
    ],
  ];
  for (const [name, impl, releaseAfterMs] of failureFetches) {
    it(`arms the cooldown after a ${name} (rapid retries stay throttled)`, async () => {
      const { service, advance } = createService({ fetchImpl: vi.fn(impl) });
      const first = await service.createSession({ confirmed: true });
      expect(first.ok).toBe(false);
      const retry = await service.createSession({ confirmed: true });
      expect(retry.code).toBe("cooldown");
      advance(releaseAfterMs);
      const later = await service.createSession({ confirmed: true });
      expect(later.code).not.toBe("cooldown");
    });
  }

  it("honors upstream Retry-After (delta-seconds) in its own cooldown, bounded", async () => {
    const { service, advance } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse({ type: "error", error: {} }, { status: 429, headers: { "retry-after": "42" } }),
      ),
    });
    const first = await service.createSession({ confirmed: true });
    expect(first.retryAfterSec).toBe(42);
    advance(41_000);
    expect((await service.createSession({ confirmed: true })).code).toBe("cooldown");
    advance(2_000);
    expect((await service.createSession({ confirmed: true })).code).not.toBe("cooldown");
  });

  it("parses the HTTP-date form of Retry-After", async () => {
    // nowFn starts at 1,000,000ms epoch; a date 60s later.
    const httpDate = new Date(1_000_000 + 60_000).toUTCString();
    const { service } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse({ type: "error", error: {} }, { status: 429, headers: { "retry-after": httpDate } }),
      ),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(59);
    expect(result.retryAfterSec).toBeLessThanOrEqual(61);
  });

  it("still redacts the request's own token after a mid-flight rotation", async () => {
    const env = { CLAUDE_CODE_ROUTINE_URL: kFireUrl, CLAUDE_CODE_ROUTINE_TOKEN: kToken };
    const { service, logger } = createService({
      env,
      fetchImpl: vi.fn(async () => {
        // Operator rotates the token while the fire is in flight; upstream
        // echoes the OLD credential in its error prose.
        env.CLAUDE_CODE_ROUTINE_TOKEN = "sk-ant-oat01-rotated";
        return okResponse(
          { type: "error", error: { message: `bad bearer ${kToken}` } },
          { status: 401 },
        );
      }),
    });
    await service.createSession({ confirmed: true });
    const logged = logger.error.mock.calls.flat().join(" ");
    expect(logged).not.toContain(kToken);
  });

  it("refuses redirects on the fire request", async () => {
    const { service, fetchImpl } = createService();
    await service.createSession({ confirmed: true });
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.redirect).toBe("error");
  });

  it("tells the user the session exists on a bad_upstream_response", async () => {
    const { service } = createService({
      fetchImpl: vi.fn(async () => okResponse({ claude_code_session_id: "nope" })),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.code).toBe("bad_upstream_response");
    expect(result.message).toContain("claude.ai/code");
  });
});

describe("claude-code-service upstream detail handling", () => {
  it("classifies a non-200 with unparseable JSON as upstream_<status>", async () => {
    const { service } = createService({
      fetchImpl: vi.fn(async () => ({
        ok: false,
        status: 502,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    });
    const result = await service.createSession({ confirmed: true });
    expect(result.code).toBe("upstream_502");
  });

  it("redacts a token that would straddle the 300-char truncation boundary", async () => {
    // Redaction must run BEFORE the slice: if the raw prose is cut first,
    // the surviving token fragment no longer matches the full value.
    const padded = "x".repeat(290) + kToken + " trailing";
    const { service, logger } = createService({
      fetchImpl: vi.fn(async () =>
        okResponse({ type: "error", error: { message: padded } }, { status: 401 }),
      ),
    });
    await service.createSession({ confirmed: true });
    const logged = logger.error.mock.calls.flat().join(" ");
    expect(logged).not.toContain("oat01");
  });
});
