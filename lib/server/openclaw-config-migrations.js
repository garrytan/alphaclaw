const isRecord = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

// --- agents shape adapters -------------------------------------------------
//
// OpenClaw <=2026.7 stores agents as `agents.list` (an array of entries each with an
// `id`). OpenClaw 2026.8 migrates this to `agents.entries` — a KEYED OBJECT (agent id
// -> entry). AlphaClaw's ~20 readers all expect `agents.list`, so we normalize to the
// list shape on read and preserve the on-disk shape on write, keeping every call site
// unchanged. A checked-in fact: `agents.entries` is an object, not an array, so an
// `Array.isArray(agents.entries)` probe would never match (docs/gateway/doctor.md:322).

const detectAgentsShape = (cfg) => {
  const agents = isRecord(cfg?.agents) ? cfg.agents : null;
  if (!agents) return "none";
  if (isRecord(agents.entries)) return "entries";
  if (Array.isArray(agents.list)) return "list";
  return "none";
};

// Canonical in-memory array regardless of on-disk shape. Keyed entries inject the
// object key as the id (an explicit `id` inside the entry still wins).
const readAgentsEntries = (cfg) => {
  const agents = isRecord(cfg?.agents) ? cfg.agents : {};
  if (isRecord(agents.entries)) {
    return Object.entries(agents.entries).map(([id, entry]) =>
      isRecord(entry) ? { id, ...entry } : { id },
    );
  }
  return Array.isArray(agents.list)
    ? agents.list.filter(isRecord).map((entry) => ({ ...entry }))
    : [];
};

const agentsArrayToKeyed = (list) => {
  const entries = {};
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isRecord(entry)) continue;
    const { id, ...rest } = entry;
    const key = String(id ?? "").trim();
    if (!key) continue;
    entries[key] = rest;
  }
  return entries;
};

// Normalize a freshly parsed config so every reader sees `agents.list`. Mutates in
// place. On a mixed file (both keys), `entries` wins and the stale `list` is dropped.
const normalizeAgentsShapeForRead = (cfg) => {
  if (!isRecord(cfg) || !isRecord(cfg.agents)) return cfg;
  if (isRecord(cfg.agents.entries)) {
    cfg.agents.list = readAgentsEntries(cfg);
    delete cfg.agents.entries;
  }
  return cfg;
};

// Return a config serialized in the requested on-disk agents shape WITHOUT mutating
// the caller's (list-shaped) object. Used at the write boundary to preserve whatever
// shape the file already had.
const withAgentsShapeForWrite = (config, shape) => {
  if (shape !== "entries" || !isRecord(config?.agents)) return config;
  const list = Array.isArray(config.agents.list) ? config.agents.list : [];
  const nextAgents = { ...config.agents };
  delete nextAgents.list;
  nextAgents.entries = agentsArrayToKeyed(list);
  return { ...config, agents: nextAgents };
};

// Env vars moved from `env.<VAR>` to `env.vars.<VAR>` in beta. AlphaClaw does not
// write env into openclaw.json today; this adapter is a guard for future writers.
const getEnvVarsContainer = (cfg) => {
  if (!isRecord(cfg?.env)) return null;
  return isRecord(cfg.env.vars) ? cfg.env.vars : cfg.env;
};

// Discord thread bindings moved to the canonical `session.threadBindings` in beta.
// No AlphaClaw writer exists yet; this picks the right target under beta shapes.
const getThreadBindingsTarget = (cfg) => {
  if (isRecord(cfg?.session) || isRecord(cfg?.agents?.entries)) {
    return "session.threadBindings";
  }
  return "channels.discord.threadBindings";
};

const parseStreamingMode = (value) => {
  if (typeof value === "boolean") return value ? "partial" : "off";
  const normalized = String(value || "").trim().toLowerCase();
  return ["off", "partial", "block", "progress"].includes(normalized)
    ? normalized
    : null;
};

const migrateLegacyTelegramStreamingEntry = (entry) => {
  if (!isRecord(entry)) return false;

  const legacyStreaming = entry.streaming;
  const hasLegacyStreaming =
    typeof legacyStreaming === "boolean" || typeof legacyStreaming === "string";
  const hasLegacyFields =
    entry.streamMode !== undefined ||
    entry.chunkMode !== undefined ||
    entry.blockStreaming !== undefined ||
    entry.blockStreamingCoalesce !== undefined ||
    entry.draftChunk !== undefined;
  if (!hasLegacyStreaming && !hasLegacyFields) return false;

  const streaming = isRecord(legacyStreaming) ? { ...legacyStreaming } : {};
  const resolvedMode =
    parseStreamingMode(isRecord(legacyStreaming) ? legacyStreaming.mode : legacyStreaming) ||
    parseStreamingMode(entry.streamMode) ||
    "partial";
  if (streaming.mode === undefined) streaming.mode = resolvedMode;

  if (entry.chunkMode !== undefined && streaming.chunkMode === undefined) {
    streaming.chunkMode = entry.chunkMode;
  }
  if (entry.draftChunk !== undefined) {
    const preview = isRecord(streaming.preview) ? { ...streaming.preview } : {};
    if (preview.chunk === undefined) preview.chunk = entry.draftChunk;
    streaming.preview = preview;
  }
  if (entry.blockStreaming !== undefined || entry.blockStreamingCoalesce !== undefined) {
    const block = isRecord(streaming.block) ? { ...streaming.block } : {};
    if (entry.blockStreaming !== undefined && block.enabled === undefined) {
      block.enabled = entry.blockStreaming;
    }
    if (entry.blockStreamingCoalesce !== undefined && block.coalesce === undefined) {
      block.coalesce = entry.blockStreamingCoalesce;
    }
    streaming.block = block;
  }

  entry.streaming = streaming;
  delete entry.streamMode;
  delete entry.chunkMode;
  delete entry.blockStreaming;
  delete entry.blockStreamingCoalesce;
  delete entry.draftChunk;
  return true;
};

const migrateLegacyTelegramStreamingConfig = (cfg = {}) => {
  const telegram = cfg.channels?.telegram;
  if (!isRecord(telegram)) return false;

  let changed = migrateLegacyTelegramStreamingEntry(telegram);
  if (isRecord(telegram.accounts)) {
    for (const account of Object.values(telegram.accounts)) {
      if (migrateLegacyTelegramStreamingEntry(account)) changed = true;
    }
  }
  return changed;
};

module.exports = {
  migrateLegacyTelegramStreamingConfig,
  migrateLegacyTelegramStreamingEntry,
  detectAgentsShape,
  readAgentsEntries,
  agentsArrayToKeyed,
  normalizeAgentsShapeForRead,
  withAgentsShapeForWrite,
  getEnvVarsContainer,
  getThreadBindingsTarget,
};
