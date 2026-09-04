const fs = require("fs");
const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");

let tmpDir;
let ap;

const readJson = (relPath) =>
  JSON.parse(
    fs.readFileSync(path.join(tmpDir, ".openclaw", relPath), "utf8"),
  );

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-auth-test-"));
  process.env.ALPHACLAW_ROOT_DIR = tmpDir;

  const openclawDir = path.join(tmpDir, ".openclaw");
  const agentDir = path.join(openclawDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        gateway: { port: 18789 },
      },
      null,
      2,
    ),
  );

  const { createAuthProfiles } = require("../../lib/server/auth-profiles");
  ap = createAuthProfiles();
});

beforeEach(() => {
  const openclawDir = path.join(tmpDir, ".openclaw");
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-6" },
            models: { "anthropic/claude-opus-4-6": {} },
          },
        },
        gateway: { port: 18789 },
      },
      null,
      2,
    ),
  );
  const storePath = path.join(
    openclawDir,
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  const databasePath = path.join(
    openclawDir,
    "agents",
    "main",
    "agent",
    "openclaw-agent.sqlite",
  );
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
});

afterAll(() => {
  delete process.env.ALPHACLAW_ROOT_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server/auth-profiles", () => {
  it("reads and updates Codex OAuth credentials in the SQLite auth store", () => {
    const databasePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        "primary",
        JSON.stringify({
          version: 1,
          profiles: {
            "openai:codex-cli": {
              type: "oauth",
              provider: "openai",
              access: "sqlite-access",
              refresh: "sqlite-refresh",
              expires: 123,
            },
          },
        }),
        1,
      );
    database
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("primary", JSON.stringify({ version: 1 }), 1);
    database.close();

    expect(ap.getCodexProfile()).toMatchObject({
      profileId: "openai:codex-cli",
      provider: "openai",
      access: "sqlite-access",
      refresh: "sqlite-refresh",
    });

    ap.upsertCodexProfile({
      access: "updated-access",
      refresh: "updated-refresh",
      expires: 456,
      accountId: "account-1",
    });

    const updatedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const row = updatedDatabase
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    updatedDatabase.close();
    const updated = JSON.parse(row.store_json);
    expect(updated.profiles["openai:codex-cli"]).toMatchObject({
      access: "updated-access",
      refresh: "updated-refresh",
      expires: 456,
      accountId: "account-1",
    });
    expect(fs.existsSync(path.join(path.dirname(databasePath), "auth-profiles.json"))).toBe(
      false,
    );
  });

  it("upserts an api_key profile and syncs openclaw.json", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test-key",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.version).toBe(1);
    expect(store.profiles["anthropic:default"]).toEqual({
      type: "api_key",
      provider: "anthropic",
      key: "sk-ant-test-key",
    });

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("upserts a token profile and syncs config mode", () => {
    ap.upsertProfile("anthropic:manual", {
      type: "token",
      provider: "anthropic",
      token: "sk-ant-oat01-test",
      expires: 9999999999999,
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["anthropic:manual"].type).toBe("token");
    expect(store.profiles["anthropic:manual"].token).toBe("sk-ant-oat01-test");

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["anthropic:manual"].mode).toBe("token");
  });

  it("upserts an oauth profile and syncs config", () => {
    ap.upsertProfile("openai-codex:codex-cli", {
      type: "oauth",
      provider: "openai-codex",
      access: "jwt-access",
      refresh: "rt-refresh",
      expires: 9999999999999,
      accountId: "test-account",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["openai-codex:codex-cli"].type).toBe("oauth");

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["openai-codex:codex-cli"].mode).toBe("oauth");
  });

  it("removes a profile and cleans config reference", () => {
    ap.upsertProfile("google:default", {
      type: "api_key",
      provider: "google",
      key: "AItest",
    });

    let config = readJson("openclaw.json");
    expect(config.auth.profiles["google:default"]).toBeDefined();

    ap.removeProfile("google:default");

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["google:default"]).toBeUndefined();

    config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["google:default"]).toBeUndefined();
  });

  it("preserves order, lastGood, and usageStats on write", () => {
    const storePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "existing",
          },
        },
        order: { anthropic: ["anthropic:default"] },
        lastGood: { anthropic: "anthropic:default" },
        usageStats: { total: 42 },
      }),
    );

    ap.upsertProfile("google:default", {
      type: "api_key",
      provider: "google",
      key: "AItest",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.order).toEqual({ anthropic: ["anthropic:default"] });
    expect(store.lastGood).toEqual({ anthropic: "anthropic:default" });
    expect(store.usageStats).toEqual({ total: 42 });
    expect(store.profiles["anthropic:default"].key).toBe("existing");
    expect(store.profiles["google:default"].key).toBe("AItest");
  });

  it("normalizes secrets (strips whitespace and line breaks)", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "  sk-ant-key\r\n  ",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["anthropic:default"].key).toBe("sk-ant-key");
  });

  it("preserves existing config keys when writing openclaw.json", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "test",
    });

    const config = readJson("openclaw.json");
    expect(config.agents.defaults.model.primary).toBe(
      "anthropic/claude-opus-4-6",
    );
    expect(config.agents.defaults.models).toEqual({
      "anthropic/claude-opus-4-6": {},
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("setModelConfig writes primary and configuredModels", () => {
    ap.setModelConfig({
      primary: "openai/gpt-5.1-codex",
      configuredModels: {
        "openai/gpt-5.1-codex": {},
        "anthropic/claude-opus-4-6": {},
      },
    });

    const config = readJson("openclaw.json");
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5.1-codex");
    expect(config.agents.defaults.models).toEqual({
      "openai/gpt-5.1-codex": {},
      "anthropic/claude-opus-4-6": {},
    });
    expect(config.gateway.port).toBe(18789);
  });

  it("preserves the Codex runtime marker when model settings are saved", () => {
    ap.upsertCodexProfile({
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });

    ap.setModelConfig({
      primary: "openai/gpt-5.5",
      configuredModels: {
        "openai/gpt-5.5": {},
        "anthropic/claude-opus-4-6": {},
      },
    });

    expect(ap.getModelConfig().configuredModels).toEqual({
      "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
      "anthropic/claude-opus-4-6": {},
    });
    const config = readJson("openclaw.json");
    expect(config.plugins.allow).toContain("codex");
    expect(config.plugins.entries.codex).toEqual({ enabled: true });
  });

  it("enables the Codex plugin without replacing existing plugin config", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const config = readJson("openclaw.json");
    config.plugins = {
      allow: ["telegram", "usage-tracker"],
      entries: {
        telegram: { enabled: true },
        codex: { config: { appServer: { transport: "stdio" } } },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    ap.setModelConfig({
      primary: "openai/gpt-5.6-sol",
      configuredModels: {
        "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
      },
    });

    const updated = readJson("openclaw.json");
    expect(updated.plugins.allow).toEqual([
      "telegram",
      "usage-tracker",
      "codex",
    ]);
    expect(updated.plugins.entries.telegram).toEqual({ enabled: true });
    expect(updated.plugins.entries.codex).toEqual({
      enabled: true,
      config: { appServer: { transport: "stdio" } },
    });
  });

  it("legacy upsertCodexProfile writes oauth and syncs config", () => {
    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["openai:codex-cli"]).toEqual({
      type: "oauth",
      provider: "openai",
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["openai:codex-cli"].mode).toBe("oauth");
  });

  it("legacy removeCodexProfiles removes all codex profiles", () => {
    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 1,
    });

    let store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["openai:codex-cli"]).toBeDefined();

    ap.removeCodexProfiles();

    store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["openai:codex-cli"]).toBeUndefined();

    const config = readJson("openclaw.json");
    expect(config.auth?.profiles?.["openai:codex-cli"]).toBeUndefined();
  });

  it("maps api key providers to env vars and default profile ids", () => {
    const { getEnvVarForApiKeyProvider } = require("../../lib/server/auth-profiles");

    expect(getEnvVarForApiKeyProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getEnvVarForApiKeyProvider(" groq ")).toBe("GROQ_API_KEY");
    expect(getEnvVarForApiKeyProvider("unknown-provider")).toBe("");
    expect(getEnvVarForApiKeyProvider("")).toBe("");
    expect(ap.getEnvVarForApiKeyProvider("openai")).toBe("OPENAI_API_KEY");
    expect(ap.listApiKeyProviders()).toEqual(
      expect.arrayContaining(["anthropic", "openai", "groq"]),
    );
    expect(ap.getDefaultProfileIdForApiKeyProvider("groq")).toBe("groq:default");
    expect(ap.getDefaultProfileIdForApiKeyProvider("  ")).toBe("");
  });

  it("lists profiles by provider and fetches single profiles", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "k1",
    });
    ap.upsertProfile("groq:default", {
      type: "api_key",
      provider: "groq",
      key: "k2",
    });

    expect(ap.listProfilesByProvider("anthropic")).toEqual([
      { id: "anthropic:default", type: "api_key", provider: "anthropic", key: "k1" },
    ]);
    expect(ap.getProfile("groq:default")).toEqual({
      id: "groq:default",
      type: "api_key",
      provider: "groq",
      key: "k2",
    });
    expect(ap.getProfile("missing:default")).toBeNull();
  });

  it("persists per-provider auth ordering", () => {
    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "k1",
    });
    ap.upsertProfile("anthropic:backup", {
      type: "api_key",
      provider: "anthropic",
      key: "k2",
    });

    ap.setAuthOrder("anthropic", ["anthropic:backup", "anthropic:default"]);

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.order).toEqual({
      anthropic: ["anthropic:backup", "anthropic:default"],
    });
  });

  it("syncs stored profiles into openclaw.json and skips malformed entries", () => {
    const storePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "k1",
          },
          "broken:profile": { note: "missing type and provider" },
        },
      }),
    );

    ap.syncConfigAuthReferencesForAgent();

    const config = readJson("openclaw.json");
    expect(config.auth.profiles["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.auth.profiles["broken:profile"]).toBeUndefined();
  });

  it("skips config sync entirely before onboarding completes", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { port: 18789 } }, null, 2),
    );
    const storePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "k1",
          },
        },
      }),
    );

    ap.syncConfigAuthReferencesForAgent();

    const config = readJson("openclaw.json");
    expect(config.auth).toBeUndefined();
  });

  it("manages default api key profiles for env vars", () => {
    expect(ap.upsertApiKeyProfileForEnvVar("groq", "")).toBe(false);
    expect(ap.upsertApiKeyProfileForEnvVar("", "value")).toBe(false);

    expect(ap.upsertApiKeyProfileForEnvVar("groq", "  gsk-key\r\n")).toBe(true);
    expect(ap.getProfile("groq:default")).toEqual({
      id: "groq:default",
      type: "api_key",
      provider: "groq",
      key: "gsk-key",
    });

    expect(ap.removeApiKeyProfileForEnvVar("")).toBe(false);
    expect(ap.removeApiKeyProfileForEnvVar("mistral")).toBe(false);

    ap.upsertProfile("zai:default", {
      type: "token",
      provider: "zai",
      token: "session-token",
    });
    expect(ap.removeApiKeyProfileForEnvVar("zai")).toBe(false);
    expect(ap.getProfile("zai:default")).not.toBeNull();

    expect(ap.removeApiKeyProfileForEnvVar("groq")).toBe(true);
    expect(ap.getProfile("groq:default")).toBeNull();
    expect(ap.removeProfile("groq:default")).toBe(false);
  });

  it("tolerates an unreadable openclaw.json", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.writeFileSync(configPath, "definitely not json");

    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "k1",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["anthropic:default"].key).toBe("k1");
    expect(fs.readFileSync(configPath, "utf8")).toBe("definitely not json");

    const modelConfig = ap.getModelConfig();
    expect(modelConfig.primary).toBeNull();
    expect(modelConfig.configuredModels).toEqual({});
  });

  it("marks openai gpt models with the Codex runtime when reading model config", () => {
    ap.upsertCodexProfile({
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 3_600_000,
    });
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const config = readJson("openclaw.json");
    config.agents.defaults.models = {
      "openai/gpt-5.5": {},
      "anthropic/claude-opus-4-6": {},
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const modelConfig = ap.getModelConfig();

    expect(modelConfig.primary).toBe("anthropic/claude-opus-4-6");
    expect(modelConfig.configuredModels).toEqual({
      "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
      "anthropic/claude-opus-4-6": {},
    });
    const updated = readJson("openclaw.json");
    expect(updated.agents.defaults.models["openai/gpt-5.5"]).toEqual({
      agentRuntime: { id: "codex" },
    });
    expect(updated.plugins.entries.codex).toEqual({ enabled: true });
  });

  it("falls back to the JSON store when the sqlite auth db lacks tables", () => {
    const databasePath = path.join(
      tmpDir,
      ".openclaw",
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE placeholder (id INTEGER PRIMARY KEY)");
    database.close();

    expect(ap.listProfiles()).toEqual([]);

    ap.upsertProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "fallback-key",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["anthropic:default"].key).toBe("fallback-key");
    expect(ap.getProfile("anthropic:default")).toMatchObject({
      key: "fallback-key",
    });
  });

  it("does not write auth refs into incomplete pre-onboarding config", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".openclaw", "openclaw.json"),
      JSON.stringify(
        {
          auth: {
            profiles: {},
          },
          gateway: { port: 18789 },
        },
        null,
        2,
      ),
    );

    ap.upsertCodexProfile({
      access: "jwt",
      refresh: "rt",
      expires: 9999999999999,
      accountId: "acct",
    });

    const store = readJson("agents/main/agent/auth-profiles.json");
    expect(store.profiles["openai:codex-cli"]).toBeDefined();

    const config = readJson("openclaw.json");
    expect(config.auth?.profiles || {}).toEqual({});
    expect(config.gateway.port).toBe(18789);
  });
});

// ── Relocated shared auth store (openclaw >= 2026.9.1-beta.1) ────────────────
// After doctor --fix flips config_machine_state auth.sharedStore to
// { location: "state-db" }, the main agent's store lives in
// state/openclaw.sqlite (auth_profile_stores/auth_profile_state, key
// 'shared') and the agent db rows are deleted — writes must follow the flag
// or openclaw silently ignores every saved credential.
describe("server/auth-profiles shared state-db store", () => {
  const stateDbPath = () =>
    path.join(tmpDir, ".openclaw", "state", "openclaw.sqlite");

  const createSharedStateDb = ({ flag = "state-db", withAuthTables = true } = {}) => {
    fs.mkdirSync(path.dirname(stateDbPath()), { recursive: true });
    const db = new DatabaseSync(stateDbPath());
    db.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0)",
    );
    if (flag) {
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json) VALUES ('auth.sharedStore', ?)",
      ).run(JSON.stringify({ location: flag }));
    }
    if (withAuthTables) {
      db.exec(
        "CREATE TABLE auth_profile_stores (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.exec(
        "CREATE TABLE auth_profile_state (store_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      );
    }
    db.close();
  };

  const readSharedRow = (table, column) => {
    const db = new DatabaseSync(stateDbPath(), { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT ${column} FROM ${table} WHERE store_key = 'shared'`)
        .get();
      return row ? JSON.parse(row[column]) : null;
    } finally {
      db.close();
    }
  };

  afterEach(() => {
    fs.rmSync(path.join(tmpDir, ".openclaw", "state"), {
      recursive: true,
      force: true,
    });
  });

  it("reads and writes the shared 'shared' rows once the flag is state-db, leaving the agent db alone", () => {
    createSharedStateDb();
    const db = new DatabaseSync(stateDbPath());
    db.prepare(
      "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES ('shared', ?, 1)",
    ).run(
      JSON.stringify({
        version: 1,
        profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-1" } },
      }),
    );
    db.close();

    const profiles = ap.listProfiles();
    expect(profiles).toEqual([
      { id: "anthropic:default", type: "api_key", provider: "anthropic", key: "sk-1" },
    ]);

    ap.upsertProfile("openai:default", {
      type: "api_key",
      provider: "openai",
      key: "sk-2",
    });
    const stored = readSharedRow("auth_profile_stores", "store_json");
    expect(Object.keys(stored.profiles).sort()).toEqual([
      "anthropic:default",
      "openai:default",
    ]);
    // The relocated era must not resurrect agent-db/JSON stores.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      ),
    ).toBe(false);

    ap.setAuthOrder("openai", ["openai:default"]);
    const state = readSharedRow("auth_profile_state", "state_json");
    expect(state.order).toEqual({ openai: ["openai:default"] });
  });

  it("fails closed on writes when the shared store schema is unusable — never falls back to legacy stores", () => {
    createSharedStateDb({ withAuthTables: false });
    expect(() =>
      ap.upsertProfile("openai:default", {
        type: "api_key",
        provider: "openai",
        key: "sk-2",
      }),
    ).toThrow(/shared OpenClaw auth store/);
    // No silent legacy fallback: neither the JSON store nor agent db appears.
    expect(
      fs.existsSync(
        path.join(tmpDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      ),
    ).toBe(false);
  });

  it("fails writes closed (but keeps reads working) when the flag is unreadable", () => {
    fs.mkdirSync(path.dirname(stateDbPath()), { recursive: true });
    fs.writeFileSync(stateDbPath(), "not a database", "utf8");
    // Reads fall back to the (empty) legacy stores — stale beats broken.
    expect(ap.listProfiles()).toEqual([]);
    expect(() =>
      ap.upsertProfile("openai:default", {
        type: "api_key",
        provider: "openai",
        key: "sk-2",
      }),
    ).toThrow(/auth store location/);
  });

  it("never wipes the shared store when a read fails: mutators throw instead of saving a near-empty store", () => {
    // A transient lock/corruption on the READ handle used to read as an
    // empty store; the next upsert's load→mutate→save would then persist
    // {profiles:{one entry}} and wipe every shared credential.
    createSharedStateDb();
    const db = new DatabaseSync(stateDbPath());
    db.prepare(
      "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES ('shared', ?, 1)",
    ).run(
      JSON.stringify({
        version: 1,
        profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-1" } },
      }),
    );
    // Break the READ path only: drop the state table so the schema guard
    // fails the load, while the flag row itself stays readable.
    db.exec("DROP TABLE auth_profile_state");
    db.close();

    // Lenient (display) read degrades to empty…
    expect(ap.listProfiles()).toEqual([]);
    // …but a mutator refuses to build a save from that failed read.
    expect(() =>
      ap.upsertProfile("openai:default", {
        type: "api_key",
        provider: "openai",
        key: "sk-2",
      }),
    ).toThrow(/shared OpenClaw auth store/);
    // The original credential is still intact in the store.
    const readBack = new DatabaseSync(stateDbPath(), { readOnly: true });
    try {
      const row = readBack
        .prepare("SELECT store_json FROM auth_profile_stores WHERE store_key = 'shared'")
        .get();
      expect(JSON.parse(row.store_json).profiles["anthropic:default"].key).toBe("sk-1");
    } finally {
      readBack.close();
    }
  });

  it("keeps the legacy path when the flag says legacy", () => {
    createSharedStateDb({ flag: "legacy" });
    ap.upsertProfile("openai:default", {
      type: "api_key",
      provider: "openai",
      key: "sk-2",
    });
    // Written to the legacy JSON store (no agent db in this fixture).
    const stored = readJson("agents/main/agent/auth-profiles.json");
    expect(stored.profiles["openai:default"].key).toBe("sk-2");
    const sharedRow = readSharedRow("auth_profile_stores", "store_json");
    expect(sharedRow).toBe(null);
  });
});

describe("server/auth-profiles state-DB quiet period", () => {
  const {
    StateDbQuietError,
    beginStateDbQuiet,
    resetStateDbQuietForTests,
  } = require("../../lib/server/state-db-quiet");

  const agentDbPath = () =>
    path.join(tmpDir, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
  const jsonStorePath = () =>
    path.join(tmpDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json");

  const createAgentDb = () => {
    const database = new DatabaseSync(agentDbPath());
    database.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        "primary",
        JSON.stringify({
          version: 1,
          profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-old" } },
        }),
        1,
      );
    database.close();
  };

  let token = null;

  beforeEach(() => {
    resetStateDbQuietForTests();
  });

  afterEach(() => {
    token?.release();
    token = null;
    resetStateDbQuietForTests();
    fs.rmSync(path.join(tmpDir, ".openclaw", "state"), { recursive: true, force: true });
  });

  it("every mutator throws StateDbQuietError while quiet and nothing is written (agent db AND json paths)", async () => {
    createAgentDb();
    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));

    const mutations = [
      () => ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "sk-new" }),
      () => ap.removeProfile("openai:default"),
      () => ap.setAuthOrder("openai", ["openai:default"]),
      () => ap.upsertCodexProfile({ access: "a", refresh: "r", expires: 1 }),
      () => ap.removeCodexProfiles(),
      () => ap.upsertApiKeyProfileForEnvVar("openai", "sk-env"),
    ];
    for (const mutate of mutations) {
      expect(mutate).toThrow(StateDbQuietError);
    }
    let caught = null;
    try {
      ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "sk-new" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "backup_in_progress",
      message: "A backup is in progress; retry in about two minutes.",
    });

    // Lenient reads say "store unavailable" while the barrier holds — never a
    // bare empty list that would render as "no credentials" for the whole
    // backup — and touch nothing.
    expect(ap.loadAuthStore()).toEqual({
      version: 1,
      profiles: {},
      unavailable: true,
      reason: "backup_in_progress",
    });
    expect(ap.listProfiles()).toEqual([]);
    expect(fs.existsSync(jsonStorePath())).toBe(false);

    // A non-main agent has no state-db store at all — still refused, since the
    // agent tree is inside the backup's snapshot.
    expect(() =>
      ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "x" }, "sidekick"),
    ).toThrow(StateDbQuietError);
    expect(fs.existsSync(path.join(tmpDir, ".openclaw", "agents", "sidekick"))).toBe(false);

    token.release();
    token = null;
    ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "sk-new" });
    expect(ap.getProfile("openai:default").key).toBe("sk-new");
  });

  // R8: routes whose response shape cannot carry the lenient read's marker
  // (getCodexProfile() → null reads as "disconnected") ask this in-memory
  // question instead — no fs/sqlite behind it.
  it("getAuthStoreAvailability is the in-memory unavailable marker while the barrier holds", async () => {
    expect(ap.getAuthStoreAvailability()).toEqual({ unavailable: false, reason: null });
    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
    expect(ap.getAuthStoreAvailability()).toEqual({
      unavailable: true,
      reason: "backup_in_progress",
    });
    token.release();
    token = null;
    expect(ap.getAuthStoreAvailability()).toEqual({ unavailable: false, reason: null });
  });

  it("the agent-db writer arms busy_timeout = 3000 (parity with the state-db writer)", () => {
    createAgentDb();
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec");
    ap.upsertProfile("openai:default", { type: "api_key", provider: "openai", key: "sk-new" });
    expect(execSpy.mock.calls.map(([sql]) => sql)).toContain("PRAGMA busy_timeout = 3000;");
    expect(ap.getProfile("openai:default").key).toBe("sk-new");
  });

  // ── Readers open TRACKED (counted + busy_timeout 2000) ──────────────────
  // Observed from inside the read: DatabaseSync.prototype.prepare runs
  // between the tracked open and its close, so the handle count it sees is
  // the count DURING the read, and the busy_timeout it reads is the one the
  // statement runs under.
  const { getStateDbHandleCount } = require("../../lib/server/state-db-quiet");
  const observeStoreReads = (fn, { sqlFilter = /./ } = {}) => {
    const originalPrepare = DatabaseSync.prototype.prepare;
    const observed = [];
    const prepareSpy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (sql) {
        if (!/PRAGMA/.test(sql) && sqlFilter.test(sql)) {
          observed.push({
            handles: getStateDbHandleCount(),
            busyTimeout: originalPrepare.call(this, "PRAGMA busy_timeout").get().timeout,
          });
        }
        return originalPrepare.call(this, sql);
      });
    try {
      return { result: fn(), observed };
    } finally {
      prepareSpy.mockRestore();
    }
  };

  const createSharedStateDbWithProfile = () => {
    const stateDbPath = path.join(tmpDir, ".openclaw", "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL DEFAULT 0)",
    );
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json) VALUES ('auth.sharedStore', ?)",
    ).run(JSON.stringify({ location: "state-db" }));
    db.exec(
      "CREATE TABLE auth_profile_stores (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE TABLE auth_profile_state (store_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare(
      "INSERT INTO auth_profile_stores (store_key, store_json, updated_at) VALUES ('shared', ?, 1)",
    ).run(
      JSON.stringify({
        version: 1,
        profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-1" } },
      }),
    );
    db.close();
  };

  it("the agent-db store reader opens TRACKED with the pinned read busy_timeout (2000): the handle is counted while the read is in flight", () => {
    createAgentDb();
    expect(getStateDbHandleCount()).toBe(0);
    const { result, observed } = observeStoreReads(() => ap.listProfiles(), {
      sqlFilter: /auth_profile_store\b/,
    });
    expect(result.map((profile) => profile.id)).toEqual(["openai:default"]);
    expect(observed).toEqual([{ handles: 1, busyTimeout: 2000 }]);
    expect(getStateDbHandleCount()).toBe(0);
  });

  it("the shared (state-db) store reader opens TRACKED with busy_timeout 2000 too (was an untracked 3000)", () => {
    createSharedStateDbWithProfile();
    const { result, observed } = observeStoreReads(() => ap.listProfiles(), {
      sqlFilter: /auth_profile_stores\b/,
    });
    expect(result.map((profile) => profile.id)).toEqual(["anthropic:default"]);
    expect(observed).toEqual([{ handles: 1, busyTimeout: 2000 }]);
    expect(getStateDbHandleCount()).toBe(0);
  });

  it("on a migrated box the lenient read during quiet is the unavailable marker — never the stale/empty agent db — and recovers on release", async () => {
    createSharedStateDbWithProfile();
    expect(ap.listProfiles().map((profile) => profile.id)).toEqual(["anthropic:default"]);

    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
    expect(ap.loadAuthStore()).toEqual({
      version: 1,
      profiles: {},
      unavailable: true,
      reason: "backup_in_progress",
    });
    expect(ap.listProfiles()).toEqual([]);
    expect(() => ap.loadAuthStore("main", { strict: true })).toThrow(StateDbQuietError);
    expect(getStateDbHandleCount()).toBe(0);

    token.release();
    token = null;
    const recovered = ap.loadAuthStore();
    expect(recovered.unavailable).toBeUndefined();
    expect(Object.keys(recovered.profiles)).toEqual(["anthropic:default"]);
  });
});

// Fix wave F074: the path builder is the last line before path.join —
// it fails closed on anything that is not an agent-id slug.
describe("auth-profiles agent id boundary", () => {
  it("refuses a traversal agentId on every store operation and writes nothing", () => {
    for (const bad of ["../../escape", "__proto__", "Main", "a/b", ""]) {
      expect(() => ap.upsertProfile("p1", { type: "api_key", key: "k" }, bad), bad).toThrow(/Invalid agent id/);
      expect(() => ap.listProfiles(bad), bad).toThrow(/Invalid agent id/);
      expect(() => ap.loadAuthStore(bad), bad).toThrow(/Invalid agent id/);
    }
    expect(fs.existsSync(path.join(tmpDir, "escape"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".openclaw", "agents", "escape"))).toBe(false);
  });

  it("still accepts slug agent ids", () => {
    expect(() => ap.listProfiles("ops-2")).not.toThrow();
  });
});
