const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const {
  kNamespacePrefix,
  kSidecarSuffix,
  normalizeOpenclawAgentId,
  resolveOpenclawStorePath,
  resolveTopicNameCacheNamespace,
  readTopicNameCache,
} = require("../../lib/server/topic-name-cache");

describe("server/topic-name-cache", () => {
  let openclawDir = "";

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-name-cache-"));
  });

  afterEach(() => {
    if (openclawDir) fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  const kEmptyEnv = {};

  const defaultStorePath = () =>
    resolveOpenclawStorePath({
      store: undefined,
      agentId: "default",
      openclawDir,
      env: kEmptyEnv,
    });

  const createStateDb = (rows = []) => {
    const databasePath = path.join(openclawDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(
      `CREATE TABLE plugin_state_entries (
         plugin_id TEXT NOT NULL DEFAULT 'telegram',
         namespace TEXT NOT NULL,
         entry_key TEXT NOT NULL,
         value_json TEXT NOT NULL
       )`,
    );
    const insert = db.prepare(
      "INSERT INTO plugin_state_entries (namespace, entry_key, value_json) VALUES (?, ?, ?)",
    );
    for (const [namespace, entryKey, value] of rows) {
      insert.run(namespace, entryKey, JSON.stringify(value));
    }
    db.close();
  };

  describe("normalizeOpenclawAgentId", () => {
    it.each([
      ["Main Agent", "main-agent"],
      ["default", "default"],
      ["", "main"],
      ["   ", "main"],
      [null, "main"],
      ["UPPER", "upper"],
      ["a@@b!!c", "a-b-c"],
      ["--weird--", "weird"],
      ["@@@", "main"],
      ["under_score-ok", "under_score-ok"],
    ])("normalizes %j to %j", (input, expected) => {
      expect(normalizeOpenclawAgentId(input)).toBe(expected);
    });

    it("caps normalized ids at 64 chars", () => {
      expect(normalizeOpenclawAgentId("a".repeat(70))).toBe("a".repeat(64));
      expect(normalizeOpenclawAgentId(`${"b".repeat(70)}!!!`)).toBe(
        "b".repeat(64),
      );
    });
  });

  describe("resolveOpenclawStorePath", () => {
    it("defaults to <stateDir>/agents/<id>/sessions/sessions.json", () => {
      expect(defaultStorePath()).toBe(
        path.join(openclawDir, "agents", "default", "sessions", "sessions.json"),
      );
    });

    it("normalizes the agent id inside the default path", () => {
      expect(
        resolveOpenclawStorePath({
          store: "",
          agentId: "Main Agent",
          openclawDir,
          env: kEmptyEnv,
        }),
      ).toBe(
        path.join(openclawDir, "agents", "main-agent", "sessions", "sessions.json"),
      );
    });

    it("honors the OPENCLAW_STATE_DIR override with ~ expansion", () => {
      const homeDir = path.join(openclawDir, "home");
      expect(
        resolveOpenclawStorePath({
          store: "",
          agentId: "default",
          openclawDir,
          env: { OPENCLAW_STATE_DIR: "~/state" },
          homeDir,
        }),
      ).toBe(
        path.join(homeDir, "state", "agents", "default", "sessions", "sessions.json"),
      );
    });

    it("expands {agentId} templates and ~ in explicit store paths", () => {
      const homeDir = path.join(openclawDir, "home");
      expect(
        resolveOpenclawStorePath({
          store: "~/stores/{agentId}/sessions.json",
          agentId: "Work Bot",
          openclawDir,
          env: kEmptyEnv,
          homeDir,
        }),
      ).toBe(path.join(homeDir, "stores", "work-bot", "sessions.json"));
    });

    it("resolves absolute explicit store paths as-is", () => {
      expect(
        resolveOpenclawStorePath({
          store: "/var/data/sessions.json",
          agentId: "default",
          openclawDir,
          env: kEmptyEnv,
        }),
      ).toBe(path.resolve("/var/data/sessions.json"));
    });
  });

  describe("resolveTopicNameCacheNamespace", () => {
    it("is byte-exact: prefix + sha256(storePath)[:16]", () => {
      const storePath = defaultStorePath();
      const namespace = resolveTopicNameCacheNamespace(storePath);
      // Independent derivation with node:crypto locks the exact bytes.
      const expectedHash = createHash("sha256")
        .update(storePath)
        .digest("hex")
        .slice(0, 16);
      expect(namespace).toBe(`telegram.topic-name-cache.${expectedHash}`);
      expect(kNamespacePrefix).toBe("telegram.topic-name-cache");
    });
  });

  describe("readTopicNameCache", () => {
    it("loads entries from a real sqlite fixture under the computed namespace", () => {
      const storePath = defaultStorePath();
      const namespace = resolveTopicNameCacheNamespace(storePath);
      // Hard-assert the namespace bytes independently before seeding the db.
      expect(namespace).toBe(
        `telegram.topic-name-cache.${createHash("sha256")
          .update(storePath)
          .digest("hex")
          .slice(0, 16)}`,
      );
      createStateDb([
        [namespace, "-100123:42", { name: "Deploys", iconColor: 7322096, updatedAt: 1730000000000 }],
        [namespace, "-100123:43", { name: "Standups", updatedAt: 1730000001000 }],
        // Malformed rows are skipped, never fatal.
        [namespace, "no-separator", { name: "Bad Key", updatedAt: 1 }],
        [namespace, "-100123:44", { notAName: true }],
      ]);

      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.source).toBe("sqlite");
      expect(result.namespace).toBe(namespace);
      expect(result.storePath).toBe(storePath);
      expect(result.diagnostic).toBe("");
      expect(result.entries.size).toBe(2);
      expect(result.entries.get("-100123:42")).toEqual({
        chatId: "-100123",
        threadId: "42",
        name: "Deploys",
        iconColor: 7322096,
        updatedAt: 1730000000000,
      });
      expect(result.entries.get("-100123:43").name).toBe("Standups");
    });

    it("diagnoses namespace_mismatch when entries live under other scopes", () => {
      createStateDb([
        [
          `${kNamespacePrefix}.deadbeefdeadbeef`,
          "-100123:42",
          { name: "Wrong Scope", updatedAt: 1 },
        ],
      ]);
      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.entries.size).toBe(0);
      expect(result.source).toBeNull();
      expect(result.diagnostic).toBe(
        "namespace_mismatch:1_entries_under_other_scopes",
      );
    });

    it("diagnoses cache_empty when the table has no cache entries at all", () => {
      createStateDb([]);
      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.entries.size).toBe(0);
      expect(result.diagnostic).toBe("cache_empty");
    });

    it("diagnoses no_plugin_state_table when the db exists without the table", () => {
      const databasePath = path.join(openclawDir, "state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const db = new DatabaseSync(databasePath);
      db.exec("CREATE TABLE something_else (id TEXT)");
      db.close();

      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.diagnostic).toBe("no_plugin_state_table");
    });

    it("diagnoses no_state_db and falls back to the JSON sidecar", () => {
      const storePath = defaultStorePath();
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        `${storePath}${kSidecarSuffix}`,
        JSON.stringify({
          "-100999:7": { name: "Sidecar Topic", updatedAt: 1730000002000 },
          "bad-key": { name: "Skipped", updatedAt: 1 },
        }),
      );

      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.diagnostic).toBe("no_state_db");
      expect(result.source).toBe("sidecar");
      expect(result.entries.size).toBe(1);
      expect(result.entries.get("-100999:7").name).toBe("Sidecar Topic");
    });

    it("fails silent with empty entries when nothing exists", () => {
      const result = readTopicNameCache({
        openclawDir,
        cfg: {},
        accountId: "default",
        env: kEmptyEnv,
      });
      expect(result.entries.size).toBe(0);
      expect(result.source).toBeNull();
      expect(result.diagnostic).toBe("no_state_db");
    });

    it("scopes the namespace by the configured session store and account", () => {
      const cfg = { session: { store: "/tmp/custom/{agentId}/sessions.json" } };
      const storePath = resolveOpenclawStorePath({
        store: cfg.session.store,
        agentId: "work",
        openclawDir,
        env: kEmptyEnv,
      });
      const namespace = resolveTopicNameCacheNamespace(storePath);
      createStateDb([
        [namespace, "-1:5", { name: "Scoped", updatedAt: 5 }],
      ]);

      const result = readTopicNameCache({
        openclawDir,
        cfg,
        accountId: "work",
        env: kEmptyEnv,
      });
      expect(result.namespace).toBe(namespace);
      expect(result.entries.get("-1:5").name).toBe("Scoped");
    });
  });
});
