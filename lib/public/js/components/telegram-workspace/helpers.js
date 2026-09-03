// Pure view-model helpers for the Manage Topics UI. Kept DOM-free so the
// badge/health/deleted-section logic is testable without preact.

import { formatRelativeTime } from "../../lib/format.js";

export const kTopicQuietThresholdMs = 30 * 24 * 60 * 60 * 1000;

export const kTopicRegistryErrorCodes = [
  "TOPIC_REGISTRY_UNREADABLE",
  "OPENCLAW_CONFIG_UNREADABLE",
];

// The registry stores 0 for never-seen topics — that sentinel stays a local
// "never" guard; actual rendering rides the shared relative-time core.
export const formatRelativeTimestamp = (valueMs, nowMs = Date.now()) => {
  const value = Number(valueMs || 0);
  if (!Number.isFinite(value) || value <= 0) return "never";
  return formatRelativeTime(value, { nowMs });
};

// One registry row (GET /api/telegram/topics) → everything the row needs to
// render: badges, health column, deleted metadata. `accountsMode` gates the
// "no account attributed" warning (only meaningful for named-account setups).
export const buildTopicRowModel = (
  topic = {},
  { nowMs = Date.now(), accountsMode = false } = {},
) => {
  const threadId = String(topic?.threadId ?? "").trim();
  const name = String(topic?.name || "").trim();
  const deleted = !!topic?.deleted;
  const lastSeenAt = Number(topic?.lastSeenAt || 0);
  const hasLastSeen = Number.isFinite(lastSeenAt) && lastSeenAt > 0;
  const quiet = hasLastSeen && nowMs - lastSeenAt > kTopicQuietThresholdMs;
  const seenAgentId = String(topic?.seenAgentId || "").trim();
  // Names enriched from openclaw's topic-name cache carry last-access (not
  // freshness) timestamps — label them "last seen by openclaw" (plan §4).
  const nameFromOpenclawCache =
    String(topic?.nameSource || "").trim().toLowerCase() === "cache";
  return {
    groupId: String(topic?.groupId ?? "").trim(),
    threadId,
    name,
    displayName: name || `Topic ${threadId}`,
    discovered: !deleted && !!topic?.discovered,
    stale: !deleted && !!topic?.stale,
    deleted,
    deletedAt: Number(topic?.deletedAt || 0) || null,
    unattributed: !!accountsMode && topic?.accountId == null,
    health: {
      hasLastSeen,
      lastSeenLabel: hasLastSeen
        ? `${nameFromOpenclawCache ? "last seen by openclaw" : "last seen"} ${formatRelativeTimestamp(lastSeenAt, nowMs)}`
        : "—",
      quiet,
      seenByLabel: seenAgentId ? `seen by agent ${seenAgentId}` : "",
    },
  };
};

// Split registry rows into the three UI sections: tombstoned topics go to
// "deleted" (restorable), unnamed discovered topics get the inline-rename
// section, everything else backs the main table's health/badge columns.
export const splitTopicRows = (rows = [], opts = {}) => {
  const sections = { active: [], discovered: [], deleted: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const model = buildTopicRowModel(row, opts);
    if (!model.threadId) continue;
    if (model.deleted) sections.deleted.push(model);
    else if (model.discovered && !model.name) sections.discovered.push(model);
    else sections.active.push(model);
  }
  sections.deleted.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  return sections;
};

export const buildDiscoveryStatusModel = (
  discovery = null,
  { nowMs = Date.now() } = {},
) => {
  if (!discovery || typeof discovery !== "object") return null;
  const enabled = !!discovery.enabled;
  const lastSweepAt = Number(discovery.lastSweepAt || 0);
  const lastResult =
    discovery.lastResult && typeof discovery.lastResult === "object"
      ? discovery.lastResult
      : null;
  const resultLabel =
    lastResult && !lastResult.skipped
      ? `${Number(lastResult.discovered) || 0} discovered, ${Number(lastResult.named) || 0} named`
      : "";
  return {
    enabled,
    enabledLabel: enabled ? "on" : "off",
    lastSweepLabel:
      lastSweepAt > 0 ? formatRelativeTimestamp(lastSweepAt, nowMs) : "never",
    resultLabel,
  };
};

// Degraded-state banner (fail-closed registry/config reads). Returns null
// unless the payload carries one of the known unreadable codes.
export const buildRegistryErrorBanner = (payload = null) => {
  if (!payload || payload.ok !== false) return null;
  const code = String(payload.code || "").trim();
  if (!kTopicRegistryErrorCodes.includes(code)) return null;
  return {
    code,
    title:
      code === "OPENCLAW_CONFIG_UNREADABLE"
        ? "OpenClaw config is unreadable"
        : "Topic registry is unreadable",
    text:
      String(payload.error || "").trim() ||
      "Topic data cannot be read right now. Registry writes are paused to avoid data loss.",
  };
};

// Inline-rename state machine for discovered topics. A failed save keeps the
// typed value so the operator can edit and retry (recoverable error state).
export const createTopicRenameState = (threadId, initialValue = "") => ({
  threadId: String(threadId ?? ""),
  value: String(initialValue || ""),
  saving: false,
  error: null,
});

export const topicRenameStateWithValue = (state, value) => ({
  ...createTopicRenameState(state?.threadId),
  ...state,
  value: String(value ?? ""),
  error: null,
});

export const topicRenameStateSaving = (state) => ({
  ...state,
  saving: true,
  error: null,
});

export const topicRenameStateFailed = (state, error) => ({
  ...state,
  saving: false,
  error:
    String(error?.message || error || "").trim() || "Failed to save topic name",
});

// Apply a "verify now" response (endpoint status: "ok" | "stale") to the raw
// registry rows without a refetch.
export const applyVerifyResult = (rows = [], groupId, threadId, status) =>
  (Array.isArray(rows) ? rows : []).map((row) =>
    String(row?.groupId) === String(groupId) &&
    String(row?.threadId) === String(threadId)
      ? { ...row, stale: status === "stale" }
      : row,
  );

// Apply a successful restore to the raw registry rows without a refetch.
export const applyRestoreResult = (rows = [], groupId, threadId) =>
  (Array.isArray(rows) ? rows : []).map((row) =>
    String(row?.groupId) === String(groupId) &&
    String(row?.threadId) === String(threadId)
      ? { ...row, deleted: false, deletedAt: 0 }
      : row,
  );
