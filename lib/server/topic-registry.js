const fs = require("fs");
const { WORKSPACE_DIR } = require("./constants");
const { normalizeAccountId } = require("./utils/channels");
const { writeFileAtomic, withFileLockSync } = require("./utils/safe-file");

const kRegistryPath = `${WORKSPACE_DIR}/topic-registry.json`;
const kDefaultAgentId = "default";
const kRegistryVersion = 2;
const kMaxLabelLength = 64;
const kRenderTopicsPerGroup = 50;
const kRenderDiscoveredPerGroup = 10;

// Corrupt registry file: mutations must fail closed (never wipe topic data by
// writing `{}` back); render degrades to a note instead.
class TopicRegistryReadError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "TopicRegistryReadError";
    this.code = "TOPIC_REGISTRY_UNREADABLE";
    if (cause) this.cause = cause;
  }
}

const normalizeGroupAgentId = (value) =>
  String(value || "").trim() || kDefaultAgentId;

// Chokepoint for every registry-sourced string that reaches TOOLS.md or the
// openclaw config: strip control chars, collapse whitespace, cap length.
const sanitizeLabel = (value, { maxLength = kMaxLabelLength } = {}) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
};

// Markdown-table cell: sanitized label with pipes escaped so a hostile topic
// name cannot add columns or break out of the table.
const toTableCell = (value) => sanitizeLabel(value).replace(/\|/g, "\\|");

const emptyRegistry = () => ({
  version: kRegistryVersion,
  meta: { sweepWatermark: 0 },
  groups: {},
});

const normalizeRegistryShape = (parsed) => {
  const registry = parsed && typeof parsed === "object" ? parsed : {};
  const groups =
    registry.groups && typeof registry.groups === "object" ? registry.groups : {};
  const meta =
    registry.meta && typeof registry.meta === "object" ? registry.meta : {};
  return {
    version: kRegistryVersion,
    meta: {
      ...meta,
      sweepWatermark: Number(meta.sweepWatermark) || 0,
    },
    groups,
  };
};

const readRegistryRaw = () => {
  let raw;
  try {
    raw = fs.readFileSync(kRegistryPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { registry: emptyRegistry(), missing: true, legacy: false };
    }
    throw new TopicRegistryReadError(
      `Cannot read ${kRegistryPath}: ${error.message}`,
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TopicRegistryReadError(
      `Refusing to touch ${kRegistryPath}: file exists but is not valid JSON (${error.message})`,
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TopicRegistryReadError(
      `Refusing to touch ${kRegistryPath}: root is not an object`,
    );
  }
  const legacy = Number(parsed.version) !== kRegistryVersion;
  return { registry: normalizeRegistryShape(parsed), missing: false, legacy };
};

// Read-only consumers degrade to an empty registry marked `unavailable` so
// label lookups and renders survive a corrupt file without masking it.
const readRegistry = () => {
  try {
    return readRegistryRaw().registry;
  } catch {
    return { ...emptyRegistry(), unavailable: true };
  }
};

const logRegistryEvent = ({ status = "ok", source = "", details = null }) => {
  try {
    const { insertWatchdogEvent } = require("./db/watchdog");
    insertWatchdogEvent({
      eventType: "topic_registry",
      source: String(source || "unknown"),
      status,
      details,
    });
  } catch {}
};

// Every mutation funnels through here: lock, fail-closed read, mutate,
// atomic write, audit event. A v1 file gets a `.bak` copy before the first
// v2 write so migration is recoverable.
// Lock waits are capped at 1s (not the 5s default): this sync lock busy-waits
// ON the event loop, so a CLI/git-sync holder must degrade to a fast, retryable
// error instead of freezing every request for 5 seconds. (Full async-lock
// migration deferred: it cascades through every telegram route call site.)
const kRegistryLockTimeoutMs = 1000;

const mutateRegistry = (mutate, { source = "unknown", event = null } = {}) =>
  withFileLockSync(kRegistryPath, () => {
    let readResult;
    try {
      readResult = readRegistryRaw();
    } catch (error) {
      logRegistryEvent({
        status: "failed",
        source,
        details: { error: error.message },
      });
      throw error;
    }
    const { registry, missing, legacy } = readResult;
    if (legacy && !missing) {
      try {
        fs.copyFileSync(kRegistryPath, `${kRegistryPath}.bak`);
      } catch {}
    }
    const result = mutate(registry);
    writeFileAtomic(kRegistryPath, JSON.stringify(registry, null, 2));
    logRegistryEvent({ status: "ok", source, details: event });
    return result === undefined ? registry : result;
  }, { timeoutMs: kRegistryLockTimeoutMs });

// Exposed for the reset flow; still validated + locked + atomic.
const writeRegistry = (registry) =>
  withFileLockSync(kRegistryPath, () => {
    const normalized = normalizeRegistryShape(registry);
    writeFileAtomic(kRegistryPath, JSON.stringify(normalized, null, 2));
    logRegistryEvent({ status: "ok", source: "write_registry" });
    return normalized;
  }, { timeoutMs: kRegistryLockTimeoutMs });

const isTombstoned = (topic) => topic?.deleted === true;

const ensureGroup = (registry, groupId) => {
  if (!registry.groups[groupId]) {
    registry.groups[groupId] = { channel: "telegram", name: groupId, topics: {} };
  }
  const group = registry.groups[groupId];
  if (!group.topics || typeof group.topics !== "object") group.topics = {};
  return group;
};

// Naming a topic is the discovered→registered transition (E4.14): a
// non-empty name clears the `discovered` flag unless the patch pins it.
const normalizeTopicPatch = (patch = {}) => {
  const next = { ...patch };
  if (Object.prototype.hasOwnProperty.call(next, "name")) {
    next.name = sanitizeLabel(next.name);
    if (next.name && !Object.prototype.hasOwnProperty.call(patch, "discovered")) {
      next.discovered = false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(next, "systemInstructions")) {
    next.systemInstructions = String(next.systemInstructions ?? "");
  }
  return next;
};

const getGroup = (groupId) => {
  const registry = readRegistry();
  return registry.groups[groupId] || null;
};

const setGroup = (groupId, groupData) =>
  mutateRegistry(
    (registry) => {
      const existingGroup = registry.groups[groupId] || {
        channel: "telegram",
        name: groupId,
        topics: {},
      };
      registry.groups[groupId] = {
        ...existingGroup,
        ...groupData,
        ...(groupData && Object.prototype.hasOwnProperty.call(groupData, "name")
          ? { name: sanitizeLabel(groupData.name) || groupId }
          : {}),
        topics: existingGroup.topics || {},
      };
      return registry;
    },
    { source: "set_group", event: { groupId } },
  );

const getGroupsForAccount = (accountId) => {
  const registry = readRegistry();
  const normalizedAccountId = normalizeAccountId(accountId);
  const groups = registry.groups && typeof registry.groups === "object"
    ? registry.groups
    : {};
  return Object.fromEntries(
    Object.entries(groups).filter(([, group]) => {
      const groupAccountId = normalizeAccountId(group?.accountId);
      return groupAccountId === normalizedAccountId;
    }),
  );
};

const addTopic = (groupId, threadId, topicData, { source = "ui" } = {}) =>
  mutateRegistry(
    (registry) => {
      const group = ensureGroup(registry, groupId);
      group.topics[String(threadId)] = normalizeTopicPatch(topicData);
      return registry;
    },
    { source, event: { groupId, threadId: String(threadId), action: "add" } },
  );

const updateTopic = (groupId, threadId, topicData, { source = "ui" } = {}) =>
  mutateRegistry(
    (registry) => {
      const group = ensureGroup(registry, groupId);
      const existing = group.topics[String(threadId)] || {};
      const patch = normalizeTopicPatch(topicData);
      const merged = { ...existing, ...patch };
      // Name provenance: cache enrichment passes nameSource:"cache"; any other
      // naming (operator/agent) drops a stale cache attribution.
      if (
        Object.prototype.hasOwnProperty.call(patch, "name") &&
        !Object.prototype.hasOwnProperty.call(patch, "nameSource")
      ) {
        delete merged.nameSource;
      }
      group.topics[String(threadId)] = merged;
      return registry;
    },
    { source, event: { groupId, threadId: String(threadId), action: "update" } },
  );

// Deletion tombstones instead of removing (E1): discovery must never
// resurrect an operator-deleted topic. Restore clears the tombstone.
const removeTopic = (groupId, threadId, { source = "ui" } = {}) =>
  mutateRegistry(
    (registry) => {
      const group = registry.groups[groupId];
      const topic = group?.topics?.[String(threadId)];
      if (topic) {
        group.topics[String(threadId)] = {
          ...topic,
          deleted: true,
          deletedAt: Date.now(),
          stale: false,
        };
      }
      return registry;
    },
    { source, event: { groupId, threadId: String(threadId), action: "delete" } },
  );

const restoreTopic = (groupId, threadId, { source = "ui" } = {}) =>
  mutateRegistry(
    (registry) => {
      const topic = registry.groups[groupId]?.topics?.[String(threadId)];
      if (topic) {
        delete topic.deleted;
        delete topic.deletedAt;
      }
      return registry;
    },
    { source, event: { groupId, threadId: String(threadId), action: "restore" } },
  );

// Reset flow: "reset" keeps tombstones so rediscovery stays blocked;
// "reset + rediscover" clears them so the next sweep can repopulate.
const clearTombstones = ({ source = "ui" } = {}) =>
  mutateRegistry(
    (registry) => {
      for (const group of Object.values(registry.groups)) {
        const topics = group?.topics || {};
        for (const [threadId, topic] of Object.entries(topics)) {
          if (isTombstoned(topic)) delete topics[threadId];
        }
      }
      return registry;
    },
    { source, event: { action: "clear_tombstones" } },
  );

const getTotalTopicCount = () => {
  const registry = readRegistry();
  let count = 0;
  for (const group of Object.values(registry.groups)) {
    count += Object.values(group.topics || {}).filter(
      (topic) => !isTombstoned(topic),
    ).length;
  }
  return count;
};

// Concurrency auto-scale input (E4.4): only named, live topics count.
const getActiveTopicCount = () => {
  const registry = readRegistry();
  let count = 0;
  for (const group of Object.values(registry.groups)) {
    for (const topic of Object.values(group.topics || {})) {
      if (isTombstoned(topic) || topic?.stale === true) continue;
      if (!String(topic?.name || "").trim()) continue;
      count += 1;
    }
  }
  return count;
};

const getSweepWatermark = () => {
  const registry = readRegistry();
  return Number(registry.meta?.sweepWatermark) || 0;
};

const setSweepWatermark = (value, { source = "discovery" } = {}) =>
  mutateRegistry(
    (registry) => {
      registry.meta.sweepWatermark = Number(value) || 0;
      return registry;
    },
    { source, event: { action: "watermark", value: Number(value) || 0 } },
  );

// Discovery upsert (poller + label-path bonus). Skips tombstones, never
// touches names/routing; `seenAgentId` is informational only (E3).
// Returns { discovered: bool } — discovered=true only for topics new to the
// registry, so callers can batch digest notifications.
const recordDiscoveredTopic = (
  { groupId, threadId, agentId = "", accountId = null, seenAtMs = Date.now() },
  { source = "discovery" } = {},
) => {
  const gid = String(groupId || "").trim();
  const tid = String(threadId || "").trim();
  if (!gid || !tid) return { discovered: false };
  return mutateRegistry(
    (registry) => {
      const group = ensureGroup(registry, gid);
      if (accountId && !String(group.accountId || "").trim()) {
        group.accountId = normalizeAccountId(accountId);
      }
      const existing = group.topics[tid];
      if (existing && isTombstoned(existing)) return { discovered: false };
      const seenAgentId = sanitizeLabel(agentId);
      if (existing) {
        existing.lastSeenAt = Math.max(Number(existing.lastSeenAt) || 0, seenAtMs);
        if (seenAgentId) existing.seenAgentId = seenAgentId;
        return { discovered: false };
      }
      group.topics[tid] = {
        name: "",
        discovered: true,
        lastSeenAt: seenAtMs,
        ...(seenAgentId ? { seenAgentId } : {}),
      };
      return { discovered: true };
    },
    { source, event: { groupId: gid, threadId: tid, action: "discover" } },
  );
};

const getTopicsForAgent = (agentId) => {
  const registry = readRegistry();
  const groups = registry.groups && typeof registry.groups === "object"
    ? registry.groups
    : {};
  const normalizedAgentId = normalizeGroupAgentId(agentId);
  const rows = [];
  for (const [groupId, group] of Object.entries(groups)) {
    const groupAgentId = normalizeGroupAgentId(group?.agentId);
    const groupName = String(group?.name || "").trim() || groupId;
    const topics = group?.topics && typeof group.topics === "object"
      ? group.topics
      : {};
    const isGroupOwner = groupAgentId === normalizedAgentId;
    for (const [threadId, topic] of Object.entries(topics)) {
      if (isTombstoned(topic)) continue;
      const topicAgentId = String(topic?.agentId || "").trim();
      if (!isGroupOwner && topicAgentId !== normalizedAgentId) continue;
      rows.push({
        groupName,
        groupId,
        topicName: topic?.name,
        threadId,
        groupAgentId,
        topicAgentId,
        discovered: topic?.discovered === true,
        stale: topic?.stale === true,
        lastSeenAt: Number(topic?.lastSeenAt) || 0,
      });
    }
  }
  return rows;
};

// Flat listing for the UI, CLI `topics list`, and digests.
const listTopics = ({ groupId = "" } = {}) => {
  const registry = readRegistry();
  const rows = [];
  for (const [gid, group] of Object.entries(registry.groups || {})) {
    if (groupId && String(groupId) !== gid) continue;
    const groupName = String(group?.name || "").trim() || gid;
    for (const [threadId, topic] of Object.entries(group?.topics || {})) {
      rows.push({
        groupId: gid,
        groupName,
        accountId: String(group?.accountId || "").trim() || null,
        groupAgentId: normalizeGroupAgentId(group?.agentId),
        threadId,
        name: String(topic?.name || "").trim(),
        nameSource: String(topic?.nameSource || "").trim(),
        agentId: String(topic?.agentId || "").trim(),
        discovered: topic?.discovered === true,
        stale: topic?.stale === true,
        deleted: isTombstoned(topic),
        deletedAt: Number(topic?.deletedAt) || 0,
        lastSeenAt: Number(topic?.lastSeenAt) || 0,
        seenAgentId: String(topic?.seenAgentId || "").trim(),
      });
    }
  }
  return rows;
};

const selectRenderRows = (rows) => {
  // Operator/agent-registered topics (named, not flagged discovered) always
  // render (E4.15); discovered-but-named fill remaining slots by recency.
  const named = rows.filter((r) => r.name && !r.deleted && !r.stale);
  const always = named.filter((r) => !r.discovered);
  const rest = named
    .filter((r) => r.discovered)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const capped = always.concat(
    rest.slice(0, Math.max(0, kRenderTopicsPerGroup - always.length)),
  );
  return {
    rendered: capped,
    omitted: named.length - capped.length,
  };
};

// Render the topic registry as a markdown section for TOOLS.md
const renderTopicRegistryMarkdown = ({
  includeSyncGuidance = false,
  agentId = "",
  telegramEnabled = includeSyncGuidance,
  topicCreateActionActive = false,
} = {}) => {
  let registry;
  try {
    registry = readRegistryRaw().registry;
  } catch {
    return [
      "",
      "## Topic Registry",
      "",
      "The topic registry file is currently unreadable, so topic mappings are unavailable.",
      "Do not guess thread IDs. Ask the operator to repair it in the AlphaClaw dashboard (Telegram tab).",
      "",
    ].join("\n");
  }
  if (!telegramEnabled) return "";

  const groups = registry.groups && typeof registry.groups === "object"
    ? registry.groups
    : {};
  const normalizedAgentId = String(agentId || "").trim();
  const allRows = listTopics().filter((row) => {
    if (!normalizedAgentId) return true;
    const isGroupOwner = row.groupAgentId === normalizeGroupAgentId(normalizedAgentId);
    return isGroupOwner || row.agentId === normalizedAgentId;
  });

  const lines = ["", "## Topic Registry", ""];

  const groupIds = [...new Set(allRows.map((r) => r.groupId))];
  const namedLines = [];
  const discoveredLines = [];
  let omittedTotal = 0;
  for (const gid of groupIds) {
    const groupRows = allRows.filter((r) => r.groupId === gid);
    const { rendered, omitted } = selectRenderRows(groupRows);
    omittedTotal += omitted;
    for (const r of rendered) {
      namedLines.push(
        `| ${toTableCell(r.groupName)} (${toTableCell(r.groupId)}) | ${toTableCell(r.name)} | ${toTableCell(r.threadId)} |`,
      );
    }
    const discovered = groupRows
      .filter((r) => !r.deleted && !r.stale && !r.name)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const r of discovered.slice(0, kRenderDiscoveredPerGroup)) {
      discoveredLines.push(
        `- ${toTableCell(r.groupName)} (${toTableCell(r.groupId)}), thread ${toTableCell(r.threadId)}` +
          (r.seenAgentId ? ` — last seen by agent ${toTableCell(r.seenAgentId)}` : ""),
      );
    }
    omittedTotal += Math.max(0, discovered.length - kRenderDiscoveredPerGroup);
  }

  if (namedLines.length > 0) {
    lines.push(
      "When sending messages to group topics, use these thread IDs:",
      "",
      "| Group | Topic | Thread ID |",
      "| ----- | ----- | --------- |",
      ...namedLines,
    );
  } else {
    lines.push(
      "No topics are registered yet. Discover them from real activity or create them (see Sync Rules).",
    );
  }

  if (discoveredLines.length > 0) {
    lines.push(
      "",
      "### Discovered (unnamed) topics",
      "",
      "These threads have real activity but no registered name yet. Infer the topic's name from",
      "its messages when possible, or ask the user what to call it, then register it:",
      "",
      ...discoveredLines,
    );
  }

  if (omittedTotal > 0) {
    lines.push(
      "",
      `(${omittedTotal} more topic${omittedTotal === 1 ? "" : "s"} not shown — run \`alphaclaw telegram topics list\` for the full set.)`,
    );
  }

  lines.push(
    "",
    "### Sync Rules",
    "",
    "Keep topic mappings in sync with real Telegram activity:",
    "",
    "- To send into a topic, pass its thread ID as `message_thread_id`.",
    "- If a message arrives in an unregistered or unnamed Telegram topic, infer a name from context or ask the user, then register it.",
    '- When adding or naming a topic run `alphaclaw telegram topic add --group <groupId> --thread <threadId> --name "<topicName>"` immediately, no confirmation needed.',
    '- To create a brand-new Telegram topic AND register it in one step, run `alphaclaw telegram topic create --group <groupId> --name "<topicName>"`.',
    ...(topicCreateActionActive
      ? [
        "- The native `createForumTopic` action is enabled — you may also create topics directly through the channel action, then register them with `topic add`.",
      ]
      : []),
    "- Run `alphaclaw telegram topics list` to see every registered, discovered, and stale topic.",
    "- Never edit `hooks/bootstrap/TOOLS.md` directly for topic changes",
    "",
  );

  // Keep legacy callers (no explicit telegramEnabled) rendering nothing when
  // there is genuinely nothing to say and guidance was not requested.
  if (
    !includeSyncGuidance &&
    namedLines.length === 0 &&
    discoveredLines.length === 0 &&
    Object.keys(groups).length === 0
  ) {
    return "";
  }

  return lines.join("\n");
};

module.exports = {
  kRegistryPath,
  TopicRegistryReadError,
  sanitizeLabel,
  readRegistry,
  writeRegistry,
  mutateRegistry,
  getGroup,
  setGroup,
  getGroupsForAccount,
  addTopic,
  updateTopic,
  removeTopic,
  restoreTopic,
  clearTombstones,
  getTotalTopicCount,
  getActiveTopicCount,
  getSweepWatermark,
  setSweepWatermark,
  recordDiscoveredTopic,
  getTopicsForAgent,
  listTopics,
  renderTopicRegistryMarkdown,
};
