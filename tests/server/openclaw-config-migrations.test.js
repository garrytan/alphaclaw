const {
  ensureLegacyCompatibilityDefaults,
  migrateLegacyTelegramStreamingConfig,
  detectAgentsShape,
  readAgentsEntries,
  agentsArrayToKeyed,
  normalizeAgentsShapeForRead,
  withAgentsShapeForWrite,
  hasLegacyAgentsRoster,
  resolveDefaultAgentId,
  describeOnDiskAgents,
  canonicalizeAgentsForWrite,
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

  it("MIXED file (both agents.list and agents.entries): entries wins, stale list dropped", () => {
    // A half-migrated config can carry both keys — the keyed entries are the
    // beta's source of truth; the stale list must not resurrect old agents.
    const cfg = normalizeAgentsShapeForRead({
      agents: {
        list: [{ id: "stale-agent", name: "Stale" }],
        entries: {
          main: { name: "Main" },
          ops: { name: "Ops" },
        },
      },
    });
    expect(cfg.agents.entries).toBeUndefined();
    expect(cfg.agents.list.map((agent) => agent.id).sort()).toEqual([
      "main",
      "ops",
    ]);
    expect(cfg.agents.list.some((agent) => agent.id === "stale-agent")).toBe(
      false,
    );
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

  it("preserves a keyed roster produced by boot reconciliation before the write adapter runs", () => {
    const input = { agents: { entries: { main: { name: "Main" }, work: { name: "Work" } } } };
    const normalized = normalizeAgentsShapeForRead(structuredClone(input));
    normalized.agents.entries = agentsArrayToKeyed(normalized.agents.list);
    delete normalized.agents.list;
    expect(withAgentsShapeForWrite(normalized, "entries")).toEqual(input);
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

// OpenClaw 2026.10.1+ refuses `agents.list` and every boolean
// `agents.entries.*.default` marker (legacy-*.mjs LEGACY_AGENT_ROSTER_RULES),
// and a multi-agent roster needs `agents.ownership: "explicit"`. These cases
// mirror 10.2's own applyAgentConfig/pruneAgentConfig roster transitions.
describe("server/openclaw-config-migrations canonical 2026.10 roster", () => {
  const onDisk = (raw) => describeOnDiskAgents(raw);

  it("detects legacy rosters the 2026.10 validator refuses", () => {
    expect(hasLegacyAgentsRoster({ agents: { list: [] } })).toBe(true);
    expect(hasLegacyAgentsRoster({ agents: { entries: { main: { default: false } } } })).toBe(true);
    expect(hasLegacyAgentsRoster({ agents: { entries: { main: { default: true } } } })).toBe(true);
    expect(hasLegacyAgentsRoster({ agents: { entries: { main: {} } } })).toBe(false);
    expect(hasLegacyAgentsRoster({})).toBe(false);
  });

  it("resolves the default from a marker, then the recorded system agent, the sole agent, main, the first", () => {
    expect(resolveDefaultAgentId({ agents: { list: [{ id: "main" }, { id: "ops", default: true }] } })).toBe("ops");
    expect(resolveDefaultAgentId({ agents: { defaults: { systemAgent: { agentId: "ops" } }, list: [{ id: "main" }, { id: "ops" }] } })).toBe("ops");
    expect(resolveDefaultAgentId({ agents: { defaults: { systemAgent: { agentId: "gone" } }, list: [{ id: "a" }, { id: "main" }] } })).toBe("main");
    expect(resolveDefaultAgentId({ agents: { list: [{ id: "alex" }] } })).toBe("alex");
    expect(resolveDefaultAgentId({ agents: { list: [{ id: "a" }, { id: "b" }] } })).toBe("a");
    expect(resolveDefaultAgentId({})).toBe("main");
  });

  it("writes a single agent as keyed entries with no marker and no ownership", () => {
    const out = canonicalizeAgentsForWrite(
      { agents: { list: [{ id: "main", default: true, workspace: "/w" }] } },
      onDisk({}),
    );
    expect(out.agents).toEqual({ entries: { main: { workspace: "/w" } } });
  });

  it("stamps explicit ownership and records the prior sole agent when a roster grows past one", () => {
    const out = canonicalizeAgentsForWrite(
      { agents: { list: [{ id: "main", default: true }, { id: "ops", default: false }] } },
      onDisk({ agents: { entries: { main: {} } } }),
    );
    expect(out.agents).toEqual({
      entries: { main: {}, ops: {} },
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" }, heartbeat: { agentId: "main" } },
    });
    expect(out.talk).toEqual({ agentId: "main" });
    expect(out.bindings).toBeUndefined();
  });

  it("hands the prior agent a channel-wide binding for each enabled unbound channel when a roster grows", () => {
    const config = {
      channels: {
        defaults: { groupPolicy: "open" },
        telegram: { botToken: "x" },
        discord: { enabled: false },
        slack: {},
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "work" } },
        { agentId: "main", match: { channel: "slack", accountId: "*" } },
      ],
      session: { store: "/data/sessions.json" },
      talk: { voice: "x" },
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    };
    const out = canonicalizeAgentsForWrite(config, onDisk({ agents: { entries: { main: {} } } }));
    expect(out.bindings).toEqual([
      ...config.bindings,
      { agentId: "main", match: { channel: "telegram", accountId: "*" } },
    ]);
    expect(out.talk).toEqual({ voice: "x", agentId: "main" });
    expect(out.agents.defaults).toEqual({
      heartbeat: { every: "30m" },
      systemAgent: { agentId: "main" },
      sessionStore: { agentId: "main" },
    });
  });

  it("pins the inherited-auth owner when a non-main sole agent becomes a fleet", () => {
    const out = canonicalizeAgentsForWrite(
      { agents: { list: [{ id: "alex", default: true }, { id: "main" }] } },
      onDisk({ agents: { entries: { alex: {} } } }),
    );
    expect(out.agents.defaults).toEqual({
      systemAgent: { agentId: "alex" },
      heartbeat: { agentId: "alex" },
      authInheritance: { agentId: "alex" },
    });
  });

  it("moves the system agent on an explicit fleet only when the marker moved", () => {
    const disk = { agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" }, heartbeat: { agentId: "main" } }, entries: { main: {}, ops: {} } } };
    const unchanged = canonicalizeAgentsForWrite(
      { agents: { ...disk.agents, entries: undefined, list: [{ id: "main", default: true }, { id: "ops", default: false }] } },
      onDisk(disk),
    );
    expect(unchanged.agents.defaults).toEqual(disk.agents.defaults);
    expect(unchanged.agents.ownership).toBe("explicit");
    const moved = canonicalizeAgentsForWrite(
      { agents: { ...disk.agents, entries: undefined, list: [{ id: "main", default: false }, { id: "ops", default: true }] } },
      onDisk(disk),
    );
    expect(moved.agents.defaults).toEqual({ systemAgent: { agentId: "ops" }, heartbeat: { agentId: "main" } });
    expect(moved.agents.entries).toEqual({ main: {}, ops: {} });
  });

  it("leaves an explicit fleet's defaults alone when the caller carries no marker", () => {
    const disk = { agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "ops" } }, entries: { main: {}, ops: {} } } };
    const out = canonicalizeAgentsForWrite({ agents: { ...disk.agents, entries: undefined, list: [{ id: "main" }, { id: "ops" }] } }, onDisk(disk));
    expect(out.agents).toEqual(disk.agents);
  });

  it("drops ownership and pins the fleet's auth owner when a fleet collapses to one agent", () => {
    const disk = { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } };
    const toMain = canonicalizeAgentsForWrite({ agents: { ownership: "explicit", list: [{ id: "main", default: true }] } }, onDisk(disk));
    expect(toMain.agents).toEqual({ entries: { main: {} } });
    const diskAlex = { agents: { ownership: "explicit", entries: { alex: {}, ops: {} } } };
    const toAlex = canonicalizeAgentsForWrite({ agents: { ownership: "explicit", list: [{ id: "alex", default: true }] } }, onDisk(diskAlex));
    expect(toAlex.agents).toEqual({ entries: { alex: {} }, defaults: { authInheritance: { agentId: "main" } } });
  });

  it("writes keyed entries even when the file has no roster yet", () => {
    const out = canonicalizeAgentsForWrite({ agents: { list: [{ id: "main", default: true }] } }, onDisk({ gateway: {} }));
    expect(out.agents).toEqual({ entries: { main: {} } });
  });

  it("keeps a not-yet-migrated legacy roster in its legacy shape for doctor --fix", () => {
    const listInput = { agents: { list: [{ id: "main", default: true }, { id: "ops" }] } };
    expect(canonicalizeAgentsForWrite(listInput, onDisk({ agents: { list: [{ id: "main", default: true }] } }))).toBe(listInput);
    const entriesInput = { agents: { list: [{ id: "main", default: true }, { id: "ops", default: false }] } };
    expect(canonicalizeAgentsForWrite(entriesInput, onDisk({ agents: { entries: { main: { default: true } } } })).agents).toEqual({
      entries: { main: { default: true }, ops: { default: false } },
    });
  });

  it("never mutates the caller's config", () => {
    const input = { agents: { list: [{ id: "main", default: true }, { id: "ops" }] } };
    const snapshot = structuredClone(input);
    canonicalizeAgentsForWrite(input, onDisk({ agents: { entries: { main: {} } } }));
    expect(input).toEqual(snapshot);
  });
});

describe("server/openclaw-config-migrations legacy compatibility defaults", () => {
  it("fills the pre-2026.9.3 defaults into an empty config", () => {
    const cfg = {};
    expect(ensureLegacyCompatibilityDefaults(cfg)).toBe(true);
    expect(cfg).toEqual({
      tools: { sessions: { visibility: "tree" }, swarm: false },
      gateway: { cliAgents: { enabled: false } },
      agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
    });
    expect(ensureLegacyCompatibilityDefaults(cfg)).toBe(false);
  });

  it("never overrides a value the operator set, including OpenClaw's wider defaults", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" }, swarm: true },
      gateway: { cliAgents: { enabled: true } },
      agents: { list: [{ id: "main" }], defaults: { subagents: { maxSpawnDepth: 5 } } },
    };
    const snapshot = structuredClone(cfg);
    expect(ensureLegacyCompatibilityDefaults(cfg)).toBe(false);
    expect(cfg).toEqual(snapshot);
  });

  it("treats a Swarm limits object as the operator's choice", () => {
    const cfg = { tools: { swarm: { maxConcurrent: 4 } } };
    ensureLegacyCompatibilityDefaults(cfg);
    expect(cfg.tools.swarm).toEqual({ maxConcurrent: 4 });
  });

  it("fills only the missing keys beside existing siblings", () => {
    const cfg = {
      tools: { profile: "full", sessions: { visibility: "self" } },
      gateway: { port: 18789, cliAgents: {} },
      agents: { entries: { main: {} }, defaults: { model: { primary: "anthropic/claude-opus-5-5" } } },
    };
    expect(ensureLegacyCompatibilityDefaults(cfg)).toBe(true);
    expect(cfg.tools).toEqual({ profile: "full", sessions: { visibility: "self" }, swarm: false });
    expect(cfg.gateway).toEqual({ port: 18789, cliAgents: { enabled: false } });
    expect(cfg.agents.defaults).toEqual({
      model: { primary: "anthropic/claude-opus-5-5" },
      subagents: { maxSpawnDepth: 1 },
    });
    expect(cfg.agents.entries).toEqual({ main: {} });
  });

  it("leaves a non-object value on the path for OpenClaw's validator", () => {
    const cfg = { tools: { sessions: "broken" }, gateway: { cliAgents: true } };
    ensureLegacyCompatibilityDefaults(cfg);
    expect(cfg.tools.sessions).toBe("broken");
    expect(cfg.gateway.cliAgents).toBe(true);
    expect(cfg.tools.swarm).toBe(false);
  });
});
