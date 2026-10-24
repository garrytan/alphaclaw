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

describe("server/utils/redact env and credential backstop", () => {
  const {
    collectSecretArgValues,
    collectSecretValues: collect,
    isSecretEnvKey,
    redactCommandLine,
    redactEnvValue,
    redactSecretText,
    redactSecretsDeep,
  } = require("../../lib/server/utils/redact");

  it("treats credential-bearing env key names as secret, ordinary ones as not", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "SETUP_PASSWORD",
      "APP_DATABASE_URL",
      "ANALYTICS_DB_URL",
      "SENTRY_DSN",
      "PG_CONNECTION_STRING",
      "AWS_SECRET_ACCESS_KEY",
      "SSH_KEY",
    ]) {
      expect(isSecretEnvKey(key), key).toBe(true);
    }
    for (const key of ["PORT", "NODE_ENV", "TZ", "OPENCLAW_STATE_DIR", "MONKEY_MODE"]) {
      expect(isSecretEnvKey(key), key).toBe(false);
    }
  });

  it("redactEnvValue masks secret-named keys whole and credentials inside any other value", () => {
    expect(redactEnvValue("OPENAI_API_KEY", "anything-at-all")).toBe("***");
    expect(redactEnvValue("APP_DATABASE_URL", "postgres://h/db")).toBe("***");
    expect(redactEnvValue("CACHE", "redis://default:hunter2@cache:6379/0")).toBe(
      "redis://***@cache:6379/0",
    );
    expect(redactEnvValue("CALLBACK", "https://example.com/hook?password=hunter2&x=1")).toBe(
      "https://example.com/hook?password=***&x=1",
    );
    expect(redactEnvValue("TZ", "America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(redactEnvValue("ANYTHING", "")).toBe("");
  });

  it("masks well-known token shapes in free text", () => {
    const samples = [
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv",
      "glpat-abcdefghij0123456789",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "hf_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk_live_abcdefghij0123456789",
      "xapp-1-A0123456789-0123456789-abcdef",
      "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
    ];
    for (const sample of samples) {
      const redacted = redactSecretText(`value=${sample} end`);
      expect(redacted, sample).not.toContain(sample);
      expect(redacted, sample).toContain("***");
    }
    expect(redactSecretText("restart op=1a2b3c4d ready pid count=2")).toBe(
      "restart op=1a2b3c4d ready pid count=2",
    );
  });

  it("collects a process.env value carrying URL userinfo whatever its key is called", () => {
    const secrets = collect({
      env: {
        APP_DATABASE_URL: "postgres://app:hunter2@db.internal/app",
        HOME: "/home/app",
        PUBLIC_URL: "https://example.com/",
      },
    });
    expect(secrets.has("postgres://app:hunter2@db.internal/app")).toBe(true);
    expect(secrets.has("/home/app")).toBe(false);
    expect(secrets.has("https://example.com/")).toBe(false);
  });

  it("redactSecretsDeep masks string leaves without breaking JSON and applies the env rule to {key, value}", () => {
    const input = {
      cmd: "git push https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r",
      note: "token=abc123secret",
      vars: [
        { key: "APP_DB_URL", value: "postgres://h/db" },
        { key: "TZ", value: "UTC" },
      ],
      count: 3,
      nested: { deeper: ["mysql://root:pw@db/app"] },
    };
    const out = redactSecretsDeep(input);
    const text = JSON.stringify(out);
    expect(JSON.parse(text)).toEqual(out);
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("abc123secret");
    expect(out.vars).toEqual([
      { key: "APP_DB_URL", value: "***" },
      { key: "TZ", value: "UTC" },
    ]);
    expect(out.nested.deeper).toEqual(["mysql://***@db/app"]);
    expect(out.count).toBe(3);
    expect(input.vars[0].value).toBe("postgres://h/db");
  });

  it("redactCommandLine masks secret flag values and credential URLs", () => {
    expect(
      redactCommandLine(
        "openclaw channels add --bot-token 'xyz-secret' --url postgres://u:pw@db/x --name main",
      ),
    ).toBe("openclaw channels add --bot-token *** --url postgres://***@db/x --name main");
    expect(redactCommandLine("config set --password=hunter2 --name a")).toBe(
      "config set --password=*** --name a",
    );
  });

  it("collectSecretArgValues reads both flag forms", () => {
    expect(
      collectSecretArgValues(["channels", "add", "--bot-token", "t-1", "--api-key=k-2", "--name", "n"]),
    ).toEqual(["t-1", "k-2"]);
    expect(collectSecretArgValues(null)).toEqual([]);
  });
});

