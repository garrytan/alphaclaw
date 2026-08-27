const {
  migrateLegacyTelegramStreamingConfig,
  detectAgentsShape,
  readAgentsEntries,
  agentsArrayToKeyed,
  normalizeAgentsShapeForRead,
  withAgentsShapeForWrite,
  getEnvVarsContainer,
  getThreadBindingsTarget,
} = require("../../lib/server/openclaw-config-migrations");

describe("server/openclaw-config-migrations agents shape adapters", () => {
  it("detects list, keyed-entries, and absent shapes", () => {
    expect(detectAgentsShape({ agents: { list: [{ id: "main" }] } })).toBe("list");
    expect(detectAgentsShape({ agents: { entries: { main: {} } } })).toBe("entries");
    expect(detectAgentsShape({ agents: {} })).toBe("none");
    expect(detectAgentsShape({})).toBe("none");
  });

  it("reads keyed entries into an array injecting the id from the key", () => {
    const list = readAgentsEntries({
      agents: { entries: { main: { model: { id: "opus" } }, work: {} } },
    });
    expect(list).toEqual([
      { id: "main", model: { id: "opus" } },
      { id: "work" },
    ]);
  });

  it("prefers an explicit id inside a keyed entry over the object key", () => {
    const list = readAgentsEntries({
      agents: { entries: { legacyKey: { id: "canonical" } } },
    });
    expect(list).toEqual([{ id: "canonical" }]);
  });

  it("round-trips array -> keyed -> array", () => {
    const list = [
      { id: "main", model: { id: "opus" }, default: true },
      { id: "work", model: { id: "sonnet" } },
    ];
    const keyed = agentsArrayToKeyed(list);
    expect(keyed).toEqual({
      main: { model: { id: "opus" }, default: true },
      work: { model: { id: "sonnet" } },
    });
    expect(readAgentsEntries({ agents: { entries: keyed } })).toEqual(list);
  });

  it("normalizes keyed entries to a list on read and drops the entries key", () => {
    const cfg = normalizeAgentsShapeForRead({
      agents: { entries: { main: { model: {} } }, defaults: { model: {} } },
    });
    expect(Array.isArray(cfg.agents.list)).toBe(true);
    expect(cfg.agents.list[0].id).toBe("main");
    expect("entries" in cfg.agents).toBe(false);
    // Sibling keys are preserved.
    expect(cfg.agents.defaults).toEqual({ model: {} });
  });

  it("leaves a list-shaped config untouched on read", () => {
    const cfg = normalizeAgentsShapeForRead({ agents: { list: [{ id: "main" }] } });
    expect(cfg.agents.list).toEqual([{ id: "main" }]);
    expect("entries" in cfg.agents).toBe(false);
  });

  it("serializes back to entries without mutating the list-shaped input", () => {
    const input = { agents: { list: [{ id: "main", model: {} }] }, gateway: {} };
    const out = withAgentsShapeForWrite(input, "entries");
    expect(out.agents.entries).toEqual({ main: { model: {} } });
    expect("list" in out.agents).toBe(false);
    // input is untouched (still list-shaped).
    expect(input.agents.list).toEqual([{ id: "main", model: {} }]);
    expect(out.gateway).toBe(input.gateway);
  });

  it("leaves the config list-shaped when the target shape is list/none", () => {
    const input = { agents: { list: [{ id: "main" }] } };
    expect(withAgentsShapeForWrite(input, "list")).toBe(input);
    expect(withAgentsShapeForWrite(input, "none")).toBe(input);
  });

  it("resolves the env vars container across the beta rename", () => {
    expect(getEnvVarsContainer({ env: { vars: { A: "1" } } })).toEqual({ A: "1" });
    expect(getEnvVarsContainer({ env: { A: "1" } })).toEqual({ A: "1" });
    expect(getEnvVarsContainer({})).toBe(null);
  });

  it("targets the canonical thread-bindings key under beta shapes", () => {
    expect(getThreadBindingsTarget({ agents: { entries: {} } })).toBe(
      "session.threadBindings",
    );
    expect(getThreadBindingsTarget({ session: {} })).toBe("session.threadBindings");
    expect(getThreadBindingsTarget({ agents: { list: [] } })).toBe(
      "channels.discord.threadBindings",
    );
  });
});

describe("server/openclaw-config-migrations", () => {
  it("migrates legacy Telegram streaming fields to the OpenClaw 2026.6 shape", () => {
    const cfg = {
      channels: {
        telegram: {
          streaming: true,
          streamMode: "block",
          chunkMode: "newline",
          blockStreaming: true,
          blockStreamingCoalesce: { minChars: 200, maxChars: 800 },
          draftChunk: { minChars: 100, maxChars: 400 },
        },
      },
    };

    expect(migrateLegacyTelegramStreamingConfig(cfg)).toBe(true);
    expect(cfg.channels.telegram).toEqual({
      streaming: {
        mode: "partial",
        chunkMode: "newline",
        preview: { chunk: { minChars: 100, maxChars: 400 } },
        block: {
          enabled: true,
          coalesce: { minChars: 200, maxChars: 800 },
        },
      },
    });
  });

  it("migrates account-level config and maps disabled streaming to off", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            personal: {
              streaming: false,
              draftChunk: { breakPreference: "sentence" },
            },
          },
        },
      },
    };

    expect(migrateLegacyTelegramStreamingConfig(cfg)).toBe(true);
    expect(cfg.channels.telegram.accounts.personal).toEqual({
      streaming: {
        mode: "off",
        preview: { chunk: { breakPreference: "sentence" } },
      },
    });
  });

  it("preserves explicit modern values while removing stale aliases", () => {
    const cfg = {
      channels: {
        telegram: {
          streaming: {
            mode: "progress",
            chunkMode: "length",
            block: { enabled: false },
          },
          streamMode: "partial",
          chunkMode: "newline",
          blockStreaming: true,
        },
      },
    };

    expect(migrateLegacyTelegramStreamingConfig(cfg)).toBe(true);
    expect(cfg.channels.telegram).toEqual({
      streaming: {
        mode: "progress",
        chunkMode: "length",
        block: { enabled: false },
      },
    });
  });

  it("is idempotent for already-modern config", () => {
    const cfg = {
      channels: { telegram: { streaming: { mode: "partial" } } },
    };

    expect(migrateLegacyTelegramStreamingConfig(cfg)).toBe(false);
    expect(migrateLegacyTelegramStreamingConfig(cfg)).toBe(false);
  });
});
