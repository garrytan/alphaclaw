const {
  collectSecretValues,
  redactSecrets,
  scrubTokenParams,
} = require("../../lib/server/utils/redact");

describe("server/utils/redact", () => {
  it("collects env and env-file values above the minimum length", () => {
    const secrets = collectSecretValues({
      env: { API_TOKEN: "supersecrettoken123", SHORT: "abc" },
      envFileVars: [
        { key: "BOT_TOKEN", value: "another-secret-value" },
        { key: "EMPTY", value: "" },
      ],
    });
    expect(secrets.has("supersecrettoken123")).toBe(true);
    expect(secrets.has("another-secret-value")).toBe(true);
    expect(secrets.has("abc")).toBe(false);
  });

  it("collects inline secrets from config objects by key name", () => {
    const secrets = collectSecretValues({
      env: {},
      envFileVars: [],
      configObjects: [
        {
          channels: {
            telegram: {
              botToken: "raw-inline-telegram-token",
              // ${ENV} references resolve through env collection; the raw
              // reference text is not a secret.
              apiKey: "${TELEGRAM_API_KEY}",
              chatId: "123456789",
            },
          },
          gateway: {
            auth: { token: "gateway-auth-token-value" },
            port: 18789,
          },
          agents: {
            defaults: { model: { primary: "openai/gpt-5.1-codex" } },
          },
        },
      ],
    });
    expect(secrets.has("raw-inline-telegram-token")).toBe(true);
    expect(secrets.has("gateway-auth-token-value")).toBe(true);
    expect(secrets.has("${TELEGRAM_API_KEY}")).toBe(false);
    // Non-secret keys are never collected, even with long string values.
    expect(secrets.has("openai/gpt-5.1-codex")).toBe(false);
    expect(secrets.has("123456789")).toBe(false);
  });

  it("survives null/cyclic/deep config objects", () => {
    const cyclic = { auth: { token: "cyclic-config-token" } };
    cyclic.self = cyclic;
    const secrets = collectSecretValues({
      env: {},
      envFileVars: [],
      configObjects: [null, undefined, cyclic],
    });
    expect(secrets.has("cyclic-config-token")).toBe(true);
  });

  it("masks every occurrence of every secret", () => {
    const secrets = new Set(["supersecrettoken123", "other-secret-99"]);
    const text = [
      "auth failed for token supersecrettoken123",
      "retrying with supersecrettoken123 and other-secret-99",
    ].join("\n");
    const redacted = redactSecrets(text, { secrets });
    expect(redacted).not.toContain("supersecrettoken123");
    expect(redacted).not.toContain("other-secret-99");
    expect(redacted).toContain("***");
  });

  it("scrubs token params by shape across #, ?, and & separators", () => {
    expect(
      scrubTokenParams(
        "open http://127.0.0.1:18789/#token=leaky-one then ?token=leaky-two&other=1 and &token=leaky-three",
      ),
    ).toBe(
      "open http://127.0.0.1:18789/#token=*** then ?token=***&other=1 and &token=***",
    );
    expect(
      scrubTokenParams("handoff #bootstrapToken=one-time&bootstrapProfile=owner"),
    ).toBe("handoff #bootstrapToken=***&bootstrapProfile=owner");
  });

  it("scrubs token params case-insensitively and coerces non-string input", () => {
    expect(scrubTokenParams("url #TOKEN=Leaky ?BootstrapToken=Leaky2")).toBe(
      "url #TOKEN=*** ?BootstrapToken=***",
    );
    expect(scrubTokenParams(null)).toBe("");
    expect(scrubTokenParams(undefined)).toBe("");
    // Values without a token-shaped param pass through untouched.
    expect(scrubTokenParams("plain stderr: bad flag")).toBe(
      "plain stderr: bad flag",
    );
  });
});
