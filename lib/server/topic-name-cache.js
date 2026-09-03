const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { openReadonlyOpenclawStateDb, hasTable } = require("./openclaw-state-db");

// Read-only mirror of openclaw's telegram topic-name cache
// (extensions/telegram/src/topic-name-cache.ts). openclaw keys the cache by
// namespace `telegram.topic-name-cache.<sha256(storePath)[:16]>` where
// storePath = resolveStorePath(cfg.session?.store, { agentId: <telegram
// accountId> }). The helpers below replicate that derivation byte-for-byte —
// tests/server/topic-name-cache.test.js locks them against fixtures.
// NOTE: entry `updatedAt` is bumped on every openclaw READ of the entry, so
// it means "last seen by openclaw", not name freshness (E4.19).

const kNamespacePrefix = "telegram.topic-name-cache";
const kSidecarSuffix = ".telegram-topic-names.json";
const kDefaultOpenclawAgentId = "main";

const kValidAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Mirror of openclaw's normalizeAgentId (session-key chunk): lowercase,
// invalid runs → "-", trim dashes, cap 64, fallback "main".
const normalizeOpenclawAgentId = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return kDefaultOpenclawAgentId;
  const normalized = trimmed.toLowerCase();
  if (kValidAgentIdPattern.test(trimmed)) return normalized;
  return (
    normalized
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || kDefaultOpenclawAgentId
  );
};

const expandHomePrefix = (value, { homeDir }) => {
  const raw = String(value || "");
  if (!raw.startsWith("~")) return raw;
  return path.join(homeDir, raw.slice(1).replace(/^[/\\]/, ""));
};

// Mirror of openclaw's resolveStorePath(store, { agentId }). The state dir
// honors OPENCLAW_STATE_DIR and otherwise is the openclaw dir alphaclaw
// already manages (~/.openclaw).
const resolveOpenclawStorePath = ({
  store,
  agentId,
  openclawDir,
  env = process.env,
  homeDir = os.homedir(),
}) => {
  const id = normalizeOpenclawAgentId(agentId ?? kDefaultOpenclawAgentId);
  const stateDir = String(env.OPENCLAW_STATE_DIR || "").trim()
    ? path.resolve(expandHomePrefix(env.OPENCLAW_STATE_DIR.trim(), { homeDir }))
    : openclawDir;
  const raw = String(store || "").trim();
  if (!raw) return path.join(stateDir, "agents", id, "sessions", "sessions.json");
  const expanded = raw.includes("{agentId}") ? raw.replaceAll("{agentId}", id) : raw;
  return path.resolve(expandHomePrefix(expanded, { homeDir }));
};

const resolveTopicNameCacheNamespace = (storePath) => {
  const hash = createHash("sha256").update(String(storePath)).digest("hex").slice(0, 16);
  return `${kNamespacePrefix}.${hash}`;
};

const isTopicNameEntry = (value) =>
  !!value &&
  typeof value === "object" &&
  typeof value.name === "string" &&
  value.name.length > 0 &&
  Number.isFinite(Number(value.updatedAt));

const parseCacheKey = (key) => {
  // openclaw cache keys are `${chatId}:${threadId}`.
  const raw = String(key || "");
  const separatorIndex = raw.lastIndexOf(":");
  if (separatorIndex <= 0) return null;
  const chatId = raw.slice(0, separatorIndex).trim();
  const threadId = raw.slice(separatorIndex + 1).trim();
  if (!chatId || !threadId) return null;
  return { chatId, threadId };
};

// Fail-silent read (missing db/table/sidecar are normal on fresh installs);
// `diagnostic` distinguishes an empty cache from a wrong-namespace miss
// (E4.6) so the startup log can say which one happened.
const readTopicNameCache = ({
  openclawDir,
  cfg = {},
  accountId = "default",
  env = process.env,
  fsModule = fs,
} = {}) => {
  const storePath = resolveOpenclawStorePath({
    store: cfg?.session?.store,
    agentId: accountId,
    openclawDir,
    env,
  });
  const namespace = resolveTopicNameCacheNamespace(storePath);
  const result = {
    entries: new Map(),
    source: null,
    namespace,
    storePath,
    diagnostic: "",
  };

  try {
    const handle = openReadonlyOpenclawStateDb({ openclawDir });
    if (!handle) {
      result.diagnostic = "no_state_db";
    } else {
      const { db } = handle;
      try {
        if (!hasTable(db, "plugin_state_entries")) {
          result.diagnostic = "no_plugin_state_table";
        } else {
          const rows = db
            .prepare(
              "SELECT entry_key, value_json FROM plugin_state_entries WHERE namespace = ?",
            )
            .all(namespace);
          for (const row of rows) {
            let value = null;
            try {
              value = JSON.parse(String(row.value_json || ""));
            } catch {}
            const parsedKey = parseCacheKey(row.entry_key);
            if (!parsedKey || !isTopicNameEntry(value)) continue;
            result.entries.set(`${parsedKey.chatId}:${parsedKey.threadId}`, {
              chatId: parsedKey.chatId,
              threadId: parsedKey.threadId,
              name: value.name,
              iconColor: value.iconColor,
              updatedAt: Number(value.updatedAt),
            });
          }
          if (result.entries.size > 0) {
            result.source = "sqlite";
          } else {
            const prefixRow = db
              .prepare(
                "SELECT COUNT(*) AS n FROM plugin_state_entries WHERE namespace LIKE ?",
              )
              .get(`${kNamespacePrefix}.%`);
            result.diagnostic = Number(prefixRow?.n) > 0
              ? `namespace_mismatch:${Number(prefixRow.n)}_entries_under_other_scopes`
              : "cache_empty";
          }
        }
      } finally {
        db.close();
      }
    }
  } catch (error) {
    result.diagnostic = `sqlite_error:${error.message}`;
  }

  if (result.entries.size === 0) {
    try {
      const sidecar = JSON.parse(
        fsModule.readFileSync(`${storePath}${kSidecarSuffix}`, "utf8"),
      );
      for (const [key, value] of Object.entries(sidecar || {})) {
        const parsedKey = parseCacheKey(key);
        if (!parsedKey || !isTopicNameEntry(value)) continue;
        result.entries.set(`${parsedKey.chatId}:${parsedKey.threadId}`, {
          chatId: parsedKey.chatId,
          threadId: parsedKey.threadId,
          name: value.name,
          iconColor: value.iconColor,
          updatedAt: Number(value.updatedAt),
        });
      }
      if (result.entries.size > 0) result.source = "sidecar";
    } catch {}
  }

  return result;
};

module.exports = {
  kNamespacePrefix,
  kSidecarSuffix,
  normalizeOpenclawAgentId,
  resolveOpenclawStorePath,
  resolveTopicNameCacheNamespace,
  readTopicNameCache,
};
