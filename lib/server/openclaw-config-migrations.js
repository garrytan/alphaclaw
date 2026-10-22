const { isNonArrayObject } = require("./utils/object");

// --- agents shape adapters -------------------------------------------------
//
// OpenClaw <=2026.7 stores agents as `agents.list` (an array of entries each with an
// `id`). OpenClaw 2026.8 migrates this to `agents.entries` — a KEYED OBJECT (agent id
// -> entry). AlphaClaw's ~20 readers all expect `agents.list`, so we normalize to the
// list shape on read and preserve the on-disk shape on write, keeping every call site
// unchanged. A checked-in fact: `agents.entries` is an object, not an array, so an
// `Array.isArray(agents.entries)` probe would never match (docs/gateway/doctor.md:322).

const detectAgentsShape = (cfg) => {
  const agents = isNonArrayObject(cfg?.agents) ? cfg.agents : null;
  if (!agents) return "none";
  if (isNonArrayObject(agents.entries)) return "entries";
  if (Array.isArray(agents.list)) return "list";
  return "none";
};

// Canonical in-memory array regardless of on-disk shape. Keyed entries inject the
// object key as the id (an explicit `id` inside the entry still wins).
const readAgentsEntries = (cfg) => {
  const agents = isNonArrayObject(cfg?.agents) ? cfg.agents : {};
  if (isNonArrayObject(agents.entries)) {
    return Object.entries(agents.entries).map(([id, entry]) =>
      isNonArrayObject(entry) ? { id, ...entry } : { id },
    );
  }
  return Array.isArray(agents.list)
    ? agents.list.filter(isNonArrayObject).map((entry) => ({ ...entry }))
    : [];
};

const agentsArrayToKeyed = (list) => {
  const entries = {};
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isNonArrayObject(entry)) continue;
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
  if (!isNonArrayObject(cfg) || !isNonArrayObject(cfg.agents)) return cfg;
  if (isNonArrayObject(cfg.agents.entries)) {
    cfg.agents.list = readAgentsEntries(cfg);
    delete cfg.agents.entries;
  }
  return cfg;
};

// Return a config serialized in the requested on-disk agents shape WITHOUT mutating
// the caller's (list-shaped) object. Used at the write boundary to preserve whatever
// shape the file already had.
const withAgentsShapeForWrite = (config, shape) => {
  if (shape !== "entries" || !isNonArrayObject(config?.agents)) return config;
  if (!Array.isArray(config.agents.list) && isNonArrayObject(config.agents.entries)) return config;
  const list = Array.isArray(config.agents.list) ? config.agents.list : [];
  const nextAgents = { ...config.agents };
  delete nextAgents.list;
  nextAgents.entries = agentsArrayToKeyed(list);
  return { ...config, agents: nextAgents };
};

// --- canonical agents roster (OpenClaw 2026.10.x) ---------------------------
//
// 2026.10.1 turned two roster shapes 2026.9.x still migrated in memory into
// blocking config errors (legacy-*.mjs LEGACY_AGENT_ROSTER_RULES): any
// `agents.list`, and any boolean `agents.entries.*.default` marker (false
// included). A multi-agent roster must carry `agents.ownership: "explicit"`
// and has no default; the agent AlphaClaw shows as "default" is OpenClaw's
// recorded `agents.defaults.systemAgent.agentId`. The gateway exits 78 on
// either legacy shape and every CLI command refuses until doctor --fix runs.
//
// AlphaClaw keeps `default` as an in-memory marker for its readers and
// writes the roster the way 10.2's own `openclaw agents add/delete`
// (agents.config-*.mjs applyAgentConfig/pruneAgentConfig) does.

const kImplicitAgentId = "main";

const trimmedId = (value) => String(value ?? "").trim();

const hasLegacyAgentsRoster = (cfg) => {
  const agents = isNonArrayObject(cfg?.agents) ? cfg.agents : null;
  if (!agents) return false;
  if (Object.prototype.propertyIsEnumerable.call(agents, "list")) return true;
  return (
    isNonArrayObject(agents.entries) &&
    Object.values(agents.entries).some(
      (entry) => isNonArrayObject(entry) && typeof entry.default === "boolean",
    )
  );
};

const listInMemoryAgents = (agents) => {
  if (Array.isArray(agents?.list)) return agents.list.filter(isNonArrayObject);
  if (isNonArrayObject(agents?.entries)) {
    return Object.entries(agents.entries).map(([id, entry]) =>
      isNonArrayObject(entry) ? { id, ...entry } : { id },
    );
  }
  return [];
};

// The agent AlphaClaw labels "default" on a list-shaped in-memory config: a
// legacy marker when one is still present, else OpenClaw's recorded system
// agent, else the sole agent, else `main`, else the first entry.
const resolveDefaultAgentId = (cfg) => {
  const agents = isNonArrayObject(cfg?.agents) ? cfg.agents : {};
  const list = listInMemoryAgents(agents);
  const ids = list.map((entry) => trimmedId(entry.id)).filter(Boolean);
  const marked = list.find((entry) => entry.default === true);
  if (marked && trimmedId(marked.id)) return trimmedId(marked.id);
  const recorded = trimmedId(agents.defaults?.systemAgent?.agentId);
  if (recorded && ids.includes(recorded)) return recorded;
  if (ids.length === 1) return ids[0];
  if (ids.includes(kImplicitAgentId)) return kImplicitAgentId;
  return ids[0] || kImplicitAgentId;
};

// Roster facts about the file as it is on disk, captured before a write.
const describeOnDiskAgents = (raw) => {
  const shape = detectAgentsShape(raw);
  const list = readAgentsEntries(raw);
  const markedId = trimmedId(list.find((entry) => entry.default === true)?.id);
  return {
    shape,
    legacy: hasLegacyAgentsRoster(raw),
    count: list.length,
    soleAgentId: list.length === 1 ? trimmedId(list[0].id) : "",
    markedId,
    authInheritanceAgentId: trimmedId(raw?.agents?.defaults?.authInheritance?.agentId),
  };
};

const kChannelConfigMetadataKeys = new Set(["defaults", "modelByChannel"]);

// legacy-*.mjs listUnboundAmbientChannelIds/isChannelWideBinding: enabled
// configured channels with no `{ channel, accountId: "*" }` binding.
const listUnboundChannelIds = (config, bindings) => {
  const channels = isNonArrayObject(config?.channels) ? config.channels : {};
  const isChannelWide = (binding, channel) => {
    const match = isNonArrayObject(binding) && binding.type !== "acp" ? binding.match : null;
    return (
      isNonArrayObject(match) &&
      trimmedId(match.channel).toLowerCase() === channel &&
      trimmedId(match.accountId) === "*" &&
      match.peer === undefined &&
      !trimmedId(match.guildId) &&
      !trimmedId(match.teamId) &&
      (!Array.isArray(match.roles) || match.roles.length === 0)
    );
  };
  return Object.entries(channels)
    .filter(([id, value]) => !kChannelConfigMetadataKeys.has(id.trim()) && (!isNonArrayObject(value) || value.enabled !== false))
    .map(([id]) => id.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .filter((channel) => !bindings.some((binding) => isChannelWide(binding, channel)));
};

const withDefaultsKey = (defaults, key, agentId) => ({
  ...defaults,
  [key]: { ...(isNonArrayObject(defaults[key]) ? defaults[key] : {}), agentId },
});

// A file that still holds a legacy roster keeps that shape: `openclaw doctor --fix` materializes channel bindings and
// heartbeat/Talk/auth owners from the legacy marker, which a markerless
// rewrite would destroy. AlphaClaw's boot migration runs Doctor once per
// pin, so on a migrated box this branch never runs.
const canonicalizeAgentsForWrite = (config, onDisk = {}) => {
  if (!isNonArrayObject(config?.agents)) return config;
  if (onDisk.legacy) return withAgentsShapeForWrite(config, onDisk.shape);
  const list = listInMemoryAgents(config.agents);
  const markedId = trimmedId(list.find((entry) => entry.default === true)?.id);
  const entries = {};
  for (const entry of list) {
    const { id, default: _marker, ...rest } = entry;
    const key = trimmedId(id);
    if (key) entries[key] = rest;
  }
  const ids = Object.keys(entries);
  const { list: _list, ownership, ...agentsRest } = config.agents;
  const nextAgents = { ...agentsRest, entries };
  let defaults = isNonArrayObject(nextAgents.defaults) ? { ...nextAgents.defaults } : null;
  const recordedSystemAgent = trimmedId(defaults?.systemAgent?.agentId);
  const authOwner = trimmedId(defaults?.authInheritance?.agentId);
  const extra = {};
  if (ids.length > 1) {
    nextAgents.ownership = "explicit";
    if (ownership !== "explicit") {
      // An explicit fleet has no default (docs/gateway/config-agents.md), so a
      // roster growing past one agent hands every surface the prior agent
      // served implicitly to that agent, as Doctor's
      // materializeLegacyDefaultAgentRoles does: system agent, heartbeat,
      // Talk, a non-per-agent session store, a channel-wide binding for each
      // enabled channel without one, and (applyAgentConfig) the
      // inherited-auth owner.
      const owner = markedId || onDisk.soleAgentId || resolveDefaultAgentId({ agents: { ...nextAgents, list } });
      if (!recordedSystemAgent) defaults = withDefaultsKey(defaults || {}, "systemAgent", owner);
      if ((onDisk.count ?? 0) <= 1) {
        if (defaults?.heartbeat === undefined && !list.some((entry) => entry.heartbeat)) {
          defaults = withDefaultsKey(defaults || {}, "heartbeat", owner);
        }
        const sessionStore = trimmedId(config.session?.store);
        if (sessionStore && !sessionStore.includes("{agentId}") && !trimmedId(defaults?.sessionStore?.agentId)) {
          defaults = withDefaultsKey(defaults || {}, "sessionStore", owner);
        }
        const sourceAuthOwner = authOwner || owner;
        const targetAuthOwner = authOwner || kImplicitAgentId;
        if (sourceAuthOwner !== targetAuthOwner) {
          defaults = withDefaultsKey(defaults || {}, "authInheritance", sourceAuthOwner);
        }
        if (config.talk === undefined || (isNonArrayObject(config.talk) && !Object.hasOwn(config.talk, "agentId"))) {
          extra.talk = { ...(isNonArrayObject(config.talk) ? config.talk : {}), agentId: owner };
        }
        const bindings = config.bindings === undefined ? [] : config.bindings;
        if (Array.isArray(bindings)) {
          const added = listUnboundChannelIds(config, bindings).map((channel) => ({
            agentId: owner,
            match: { channel, accountId: "*" },
          }));
          if (added.length > 0) extra.bindings = [...bindings, ...added];
        }
      }
    } else if (markedId) {
      const current = resolveDefaultAgentId({ agents: { ...nextAgents, list: ids.map((id) => ({ id })) } });
      if (markedId !== current) defaults = withDefaultsKey(defaults || {}, "systemAgent", markedId);
    }
  } else if ((onDisk.count ?? 0) > 1 && ids.length === 1) {
    // pruneAgentConfig: collapsing to one agent pins the inherited-auth owner
    // the fleet had (explicit fleets fall back to `main`).
    const sourceAuthOwner = onDisk.authInheritanceAgentId || kImplicitAgentId;
    const targetAuthOwner = authOwner || ids[0];
    if (sourceAuthOwner !== targetAuthOwner) {
      defaults = withDefaultsKey(defaults || {}, "authInheritance", sourceAuthOwner);
    }
  }
  if (defaults) nextAgents.defaults = defaults;
  return { ...config, ...extra, agents: nextAgents };
};

const parseStreamingMode = (value) => {
  if (typeof value === "boolean") return value ? "partial" : "off";
  const normalized = String(value || "").trim().toLowerCase();
  return ["off", "partial", "block", "progress"].includes(normalized)
    ? normalized
    : null;
};

const migrateLegacyTelegramStreamingEntry = (entry) => {
  if (!isNonArrayObject(entry)) return false;

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

  const streaming = isNonArrayObject(legacyStreaming) ? { ...legacyStreaming } : {};
  const resolvedMode =
    parseStreamingMode(isNonArrayObject(legacyStreaming) ? legacyStreaming.mode : legacyStreaming) ||
    parseStreamingMode(entry.streamMode) ||
    "partial";
  if (streaming.mode === undefined) streaming.mode = resolvedMode;

  if (entry.chunkMode !== undefined && streaming.chunkMode === undefined) {
    streaming.chunkMode = entry.chunkMode;
  }
  if (entry.draftChunk !== undefined) {
    const preview = isNonArrayObject(streaming.preview) ? { ...streaming.preview } : {};
    if (preview.chunk === undefined) preview.chunk = entry.draftChunk;
    streaming.preview = preview;
  }
  if (entry.blockStreaming !== undefined || entry.blockStreamingCoalesce !== undefined) {
    const block = isNonArrayObject(streaming.block) ? { ...streaming.block } : {};
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
  if (!isNonArrayObject(telegram)) return false;

  let changed = migrateLegacyTelegramStreamingEntry(telegram);
  if (isNonArrayObject(telegram.accounts)) {
    for (const account of Object.values(telegram.accounts)) {
      if (migrateLegacyTelegramStreamingEntry(account)) changed = true;
    }
  }
  return changed;
};

// --- legacy compatibility defaults -------------------------------------------
//
// OpenClaw 2026.9.3 widened several defaults: session tools reach every session
// on the Gateway (`tools.sessions.visibility: "all"`), Swarm is on, the Control
// UI offers CLI agents (`gateway.cliAgents.enabled`), and sub-agents nest five
// deep. AlphaClaw pins the narrower pre-9.3 behavior. Only absent values are
// filled, so an operator's explicit choice (including opting back into the new
// OpenClaw defaults) always survives. A non-object value already sitting on a
// path is left for OpenClaw's validator, never replaced.

const kLegacySessionVisibility = "tree";
const kLegacySubagentSpawnDepth = 1;

const kLegacyCompatibilityDefaults = [
  [["tools", "sessions", "visibility"], kLegacySessionVisibility],
  [["tools", "swarm"], false],
  [["gateway", "cliAgents", "enabled"], false],
  [["agents", "defaults", "subagents", "maxSpawnDepth"], kLegacySubagentSpawnDepth],
];

const fillDefaultAt = (cfg, keys, value) => {
  let node = cfg;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === undefined) node[key] = {};
    if (!isNonArrayObject(node[key])) return false;
    node = node[key];
  }
  const leaf = keys[keys.length - 1];
  if (node[leaf] !== undefined) return false;
  node[leaf] = value;
  return true;
};

const ensureLegacyCompatibilityDefaults = (cfg = {}) => {
  let changed = false;
  for (const [keys, value] of kLegacyCompatibilityDefaults) {
    if (fillDefaultAt(cfg, keys, value)) changed = true;
  }
  return changed;
};

module.exports = {
  ensureLegacyCompatibilityDefaults,
  kLegacySessionVisibility,
  kLegacySubagentSpawnDepth,
  migrateLegacyTelegramStreamingConfig,
  migrateLegacyTelegramStreamingEntry,
  detectAgentsShape,
  readAgentsEntries,
  agentsArrayToKeyed,
  normalizeAgentsShapeForRead,
  withAgentsShapeForWrite,
  hasLegacyAgentsRoster,
  resolveDefaultAgentId,
  describeOnDiskAgents,
  canonicalizeAgentsForWrite,
};
