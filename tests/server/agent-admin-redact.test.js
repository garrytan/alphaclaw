const {
  kMask,
  maskSecretFields,
  summarizeParams,
  applyOpRedaction,
  isSensitiveKey,
} = require("../../lib/server/agent-admin/redact");

describe("server/agent-admin/redact", () => {
  describe("maskSecretFields", () => {
    it("masks string leaves matching a vars.* pattern, leaving others intact", () => {
      const body = {
        vars: { API_KEY: "sk-live-123", flag: true, count: 7 },
        name: "keep-me",
      };
      const masked = maskSecretFields(body, ["vars.*"]);
      expect(masked).toEqual({
        vars: { API_KEY: kMask, flag: true, count: 7 },
        name: "keep-me",
      });
      expect(kMask).toBe("••• (set)");
    });

    it("does not mutate the original body", () => {
      const body = { vars: { API_KEY: "sk-live-123" } };
      maskSecretFields(body, ["vars.*"]);
      expect(body.vars.API_KEY).toBe("sk-live-123");
    });

    it("returns the body unchanged when secretFields is empty or absent", () => {
      const body = { vars: { API_KEY: "sk-live-123" } };
      expect(maskSecretFields(body, [])).toBe(body);
      expect(maskSecretFields(body, undefined)).toBe(body);
    });

    it("matches exactly one path segment per '*' (a.* does not match a.b.c)", () => {
      const body = { a: { b: { c: "deep-secret" } } };
      expect(maskSecretFields(body, ["a.*"])).toEqual({
        a: { b: { c: "deep-secret" } },
      });
      // The fully-qualified path still matches.
      expect(maskSecretFields(body, ["a.b.c"])).toEqual({
        a: { b: { c: kMask } },
      });
    });

    it("walks arrays, masking matching object leaves inside them", () => {
      const body = { list: [{ token: "aaa" }, { token: "bbb", note: "ok" }] };
      // Array indices don't add a path segment, so list.token targets elements.
      expect(maskSecretFields(body, ["list.token"])).toEqual({
        list: [{ token: kMask }, { token: kMask, note: "ok" }],
      });
    });

    it("leaves booleans and non-matching string leaves intact", () => {
      const body = { enabled: true, label: "public", vars: { X: "hidden" } };
      expect(maskSecretFields(body, ["vars.*"])).toEqual({
        enabled: true,
        label: "public",
        vars: { X: kMask },
      });
    });
  });

  describe("applyOpRedaction", () => {
    it("runs op.redactResponse first, then maskSecretFields on its output", () => {
      const op = {
        redactResponse: (body) => ({ ...body, extra: "added" }),
        secretFields: ["vars.*"],
      };
      const out = applyOpRedaction(op, { vars: { KEY: "secret" }, keep: 1 });
      expect(out).toEqual({
        vars: { KEY: kMask },
        keep: 1,
        extra: "added",
      });
    });

    it("masks without a redactResponse transform", () => {
      const op = { secretFields: ["vars.*"] };
      expect(applyOpRedaction(op, { vars: { KEY: "secret" } })).toEqual({
        vars: { KEY: kMask },
      });
    });

    it("passes the body through untouched when op has no redaction config", () => {
      const body = { anything: "here" };
      expect(applyOpRedaction(null, body)).toBe(body);
    });

    it("fails CLOSED when redactResponse throws, never leaking the body", () => {
      const op = {
        redactResponse: () => {
          throw new Error("redactor bug");
        },
        secretFields: ["vars.*"],
      };
      const out = applyOpRedaction(op, { secretValue: "should-not-leak" });
      expect(out).toEqual({ ok: true, redactionFailed: true });
      expect(JSON.stringify(out)).not.toContain("should-not-leak");
    });
  });

  describe("summarizeParams", () => {
    it("returns body keys only with a redacted flag", () => {
      expect(summarizeParams({ a: 1, b: "secret", c: true })).toEqual({
        keys: ["a", "b", "c"],
        redacted: true,
      });
    });

    it("caps the key list at 32 entries", () => {
      const body = {};
      for (let i = 0; i < 40; i += 1) body[`k${i}`] = i;
      const summary = summarizeParams(body);
      expect(summary.redacted).toBe(true);
      expect(summary.keys).toHaveLength(32);
    });

    it("returns null for non-objects", () => {
      expect(summarizeParams(null)).toBeNull();
      expect(summarizeParams(undefined)).toBeNull();
      expect(summarizeParams("string")).toBeNull();
      expect(summarizeParams(42)).toBeNull();
    });
  });

  describe("isSensitiveKey (re-export)", () => {
    it("flags a secret-shaped key and ignores a plain one", () => {
      expect(isSensitiveKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSensitiveKey("FOO")).toBe(false);
    });
  });
});

describe("sanitizeAgentErrorBody (agent-visible error hygiene, PR 3)", () => {
  const {
    sanitizeAgentErrorBody,
    kGenericServerError,
  } = require("../../lib/server/agent-admin/redact");

  it("replaces a 5xx error message with the fixed sentence, keeping code and hint", () => {
    const body = {
      ok: false,
      error:
        "Command failed: /usr/bin/openclaw status --json\n/root/.openclaw/openclaw.json: ENOENT",
      code: "status_failed",
      hint: "Check the Watchdog tab.",
    };
    const out = sanitizeAgentErrorBody(body, 500);
    expect(out).toEqual({
      ok: false,
      error: kGenericServerError,
      code: "status_failed",
      hint: "Check the Watchdog tab.",
    });
    expect(out.error).not.toMatch(/openclaw|\/root\//);
    // Not mutated in place — the dashboard path still sees the raw message.
    expect(body.error).toMatch(/Command failed/);
  });

  it("keeps a 4xx message as validation feedback but scrubs secret shapes, token params, and control chars", () => {
    const out = sanitizeAgentErrorBody(
      {
        ok: false,
        error:
          "Invalid key sk-live-abcdefghijklmnop for https://x.test/?token=abc123 with Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl[31m!",
      },
      400,
    );
    expect(out.error).not.toMatch(/sk-live-abcdefghijklmnop|abc123|eyJ|/);
    expect(out.error).toMatch(/^Invalid key \*\*\* for https:\/\/x\.test\/\?token=\*\*\* with \*\*\*/);
  });

  it("clamps an oversized 4xx message", () => {
    const out = sanitizeAgentErrorBody({ ok: false, error: "x".repeat(2000) }, 422);
    expect(out.error).toHaveLength(400);
  });

  it("leaves success bodies, non-string errors, arrays and primitives untouched", () => {
    const ok = { ok: true, error: "not an error field" };
    expect(sanitizeAgentErrorBody(ok, 200)).toBe(ok);
    const objErr = { ok: false, error: { code: "x" } };
    expect(sanitizeAgentErrorBody(objErr, 500)).toBe(objErr);
    const arr = [{ error: "a" }];
    expect(sanitizeAgentErrorBody(arr, 500)).toBe(arr);
    expect(sanitizeAgentErrorBody("oops", 500)).toBe("oops");
    expect(sanitizeAgentErrorBody(null, 500)).toBeNull();
  });

  it("treats a missing status as success (never rewrites a body it cannot classify)", () => {
    const body = { ok: false, error: "raw" };
    expect(sanitizeAgentErrorBody(body, undefined)).toBe(body);
  });
});
