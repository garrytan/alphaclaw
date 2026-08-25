import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { showToast } from "../toast.js";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { Badge } from "../badge.js";
import * as api from "../../lib/telegram-api.js";
import {
  fetchAgents,
  getTelegramTopics,
  restoreTelegramTopic,
  verifyTelegramTopic,
  sweepTopicDiscovery,
} from "../../lib/api.js";
import { formatLocaleDateTime } from "../../lib/format.js";
import {
  splitTopicRows,
  buildDiscoveryStatusModel,
  buildRegistryErrorBanner,
  createTopicRenameState,
  topicRenameStateWithValue,
  topicRenameStateSaving,
  topicRenameStateFailed,
  applyVerifyResult,
  applyRestoreResult,
} from "./helpers.js";

const html = htm.bind(h);

const QuietDot = () => html`
  <span
    class="inline-block w-1.5 h-1.5 rounded-full bg-gray-500/70 shrink-0"
    title="No activity in over 30 days"
  ></span>
`;

const TopicHealthCell = ({ model }) => html`
  <td class="px-3 py-2 text-fg-muted w-44">
    ${model
      ? html`
          <div class="flex items-center gap-1.5">
            ${model.health.quiet && html`<${QuietDot} />`}
            <span>${model.health.lastSeenLabel}</span>
          </div>
          ${model.health.seenByLabel &&
          html`
            <p class="text-[11px] text-fg-dim mt-0.5">
              ${model.health.seenByLabel}
            </p>
          `}
        `
      : html`<span class="text-fg-dim">—</span>`}
  </td>
`;

const AgentSelect = ({ value, agents, onChange, className = "" }) => html`
  <select
    value=${value}
    onChange=${(e) => onChange(e.target.value)}
    class="bg-field border border-border rounded-lg px-2 py-1.5 text-xs text-body focus:outline-none focus:border-fg-muted ${className}"
  >
    <option value="">Default</option>
    ${agents.map(
      (a) => html`<option value=${a.id}>${a.name || a.id}</option>`,
    )}
  </select>
`;

export const ManageTelegramWorkspace = ({
  accountId,
  groupId,
  groupName,
  initialTopics,
  configAgentMaxConcurrent,
  configSubagentMaxConcurrent,
  debugEnabled,
  onResetOnboarding,
}) => {
  const [topics, setTopics] = useState(initialTopics || {});
  const [newTopicName, setNewTopicName] = useState("");
  const [newTopicInstructions, setNewTopicInstructions] = useState("");
  const [newTopicAgentId, setNewTopicAgentId] = useState("");
  const [showCreateTopic, setShowCreateTopic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [editingTopicId, setEditingTopicId] = useState("");
  const [editingTopicName, setEditingTopicName] = useState("");
  const [editingTopicInstructions, setEditingTopicInstructions] = useState("");
  const [editingTopicAgentId, setEditingTopicAgentId] = useState("");
  const [renamingTopicId, setRenamingTopicId] = useState("");
  const [error, setError] = useState(null);
  const [deleteTopicConfirm, setDeleteTopicConfirm] = useState(null);
  const [agents, setAgents] = useState([]);
  const [registryRows, setRegistryRows] = useState([]);
  const [registryDiscovery, setRegistryDiscovery] = useState(null);
  const [registryError, setRegistryError] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [renameDrafts, setRenameDrafts] = useState({});
  const [verifyingTopicId, setVerifyingTopicId] = useState("");
  const [restoringTopicId, setRestoringTopicId] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [resetConfirmVisible, setResetConfirmVisible] = useState(false);
  const [resetMode, setResetMode] = useState("keep");
  const [resetting, setResetting] = useState(false);

  const loadTopics = async () => {
    const data = await api.listTopics(groupId, { accountId });
    if (data.ok) setTopics(data.topics || {});
  };

  const loadRegistry = async () => {
    try {
      const data = await getTelegramTopics();
      if (data?.ok) {
        setRegistryError(null);
        setRegistryRows(
          (Array.isArray(data.topics) ? data.topics : []).filter(
            (row) => String(row?.groupId) === String(groupId),
          ),
        );
        setRegistryDiscovery(data.discovery || null);
        return;
      }
      const banner = buildRegistryErrorBanner(data);
      if (banner) setRegistryError(banner);
    } catch {}
  };

  useEffect(() => {
    loadTopics();
    loadRegistry();
  }, [groupId]);
  useEffect(() => {
    if (initialTopics && Object.keys(initialTopics).length > 0) {
      setTopics(initialTopics);
    }
  }, [initialTopics]);

  useEffect(() => {
    fetchAgents()
      .then((data) => setAgents(Array.isArray(data?.agents) ? data.agents : []))
      .catch(() => {});
  }, []);

  const createSingle = async () => {
    const name = newTopicName.trim();
    const systemInstructions = newTopicInstructions.trim();
    const agentId = newTopicAgentId.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api.createTopicsBulk(groupId, [
        {
          name,
          ...(systemInstructions ? { systemInstructions } : {}),
          ...(agentId ? { agentId } : {}),
        },
      ], { accountId });
      if (!data.ok)
        throw new Error(data.results?.[0]?.error || "Failed to create topic");
      const failed = data.results.filter((r) => !r.ok);
      if (failed.length > 0) throw new Error(failed[0].error);
      setNewTopicName("");
      setNewTopicInstructions("");
      setNewTopicAgentId("");
      setShowCreateTopic(false);
      await loadTopics();
      showToast(`Created topic: ${name}`, "success");
    } catch (e) {
      setError(e.message);
    }
    setCreating(false);
  };

  const handleDelete = async (topicId, topicName) => {
    setDeleting(topicId);
    try {
      const data = await api.deleteTopic(groupId, topicId, { accountId });
      if (!data.ok) throw new Error(data.error);
      await loadTopics();
      if (data.removedFromRegistryOnly) {
        showToast(`Removed stale topic from registry: ${topicName}`, "success");
      } else {
        showToast(`Deleted topic: ${topicName}`, "success");
      }
    } catch (e) {
      showToast(`Failed to delete: ${e.message}`, "error");
    }
    setDeleting(null);
  };

  const startRename = (topicId, topicName, topicInstructions = "", topicAgentId = "") => {
    setEditingTopicId(String(topicId));
    setEditingTopicName(String(topicName || ""));
    setEditingTopicInstructions(String(topicInstructions || ""));
    setEditingTopicAgentId(String(topicAgentId || ""));
  };

  const cancelRename = () => {
    setEditingTopicId("");
    setEditingTopicName("");
    setEditingTopicInstructions("");
    setEditingTopicAgentId("");
  };

  const saveRename = async (topicId) => {
    const nextName = editingTopicName.trim();
    const nextSystemInstructions = editingTopicInstructions.trim();
    const nextAgentId = editingTopicAgentId.trim();
    if (!nextName) {
      setError("Topic name is required");
      return;
    }
    setRenamingTopicId(String(topicId));
    setError(null);
    try {
      const data = await api.updateTopic(groupId, topicId, {
        name: nextName,
        systemInstructions: nextSystemInstructions,
        agentId: nextAgentId,
      }, { accountId });
      if (!data.ok) throw new Error(data.error || "Failed to update topic");
      await loadTopics();
      showToast(`Updated topic: ${nextName}`, "success");
      cancelRename();
    } catch (e) {
      setError(e.message);
    }
    setRenamingTopicId("");
  };

  const setRenameDraftValue = (threadId, value) =>
    setRenameDrafts((drafts) => ({
      ...drafts,
      [threadId]: topicRenameStateWithValue(
        drafts[threadId] || createTopicRenameState(threadId),
        value,
      ),
    }));

  // Naming a discovered topic registers it via the existing update endpoint.
  // Failure keeps the typed value in the draft so the operator can retry.
  const saveDiscoveredName = async (threadId) => {
    const draft = renameDrafts[threadId] || createTopicRenameState(threadId);
    const name = draft.value.trim();
    if (!name || draft.saving) return;
    setRenameDrafts((drafts) => ({
      ...drafts,
      [threadId]: topicRenameStateSaving(
        drafts[threadId] || createTopicRenameState(threadId, name),
      ),
    }));
    try {
      const data = await api.updateTopic(groupId, threadId, { name }, { accountId });
      if (!data.ok) throw new Error(data.error || "Failed to name topic");
      setRenameDrafts((drafts) => {
        const next = { ...drafts };
        delete next[threadId];
        return next;
      });
      await Promise.all([loadTopics(), loadRegistry()]);
      showToast(`Registered topic: ${name}`, "success");
    } catch (e) {
      setRenameDrafts((drafts) => ({
        ...drafts,
        [threadId]: topicRenameStateFailed(
          drafts[threadId] || createTopicRenameState(threadId, name),
          e,
        ),
      }));
    }
  };

  const handleVerify = async (threadId) => {
    setVerifyingTopicId(String(threadId));
    try {
      const data = await verifyTelegramTopic(groupId, threadId);
      if (!data.ok) throw new Error(data.error || "Failed to verify topic");
      setRegistryRows((rows) =>
        applyVerifyResult(rows, groupId, threadId, data.status),
      );
      showToast(
        data.status === "ok"
          ? "Topic verified: reachable"
          : "Topic is still unreachable (stale)",
        data.status === "ok" ? "success" : "warning",
      );
    } catch (e) {
      showToast(`Verify failed: ${e.message}`, "error");
    }
    setVerifyingTopicId("");
  };

  const handleRestore = async (threadId) => {
    setRestoringTopicId(String(threadId));
    try {
      const data = await restoreTelegramTopic(groupId, threadId);
      if (!data.ok) throw new Error(data.error || "Failed to restore topic");
      setRegistryRows((rows) => applyRestoreResult(rows, groupId, threadId));
      await Promise.all([loadTopics(), loadRegistry()]);
      showToast("Topic restored", "success");
    } catch (e) {
      showToast(`Restore failed: ${e.message}`, "error");
    }
    setRestoringTopicId("");
  };

  const handleSweep = async () => {
    setSweeping(true);
    try {
      const data = await sweepTopicDiscovery();
      if (!data.ok) throw new Error(data.error || "Failed to run sweep");
      await loadRegistry();
      showToast("Discovery sweep complete", "success");
    } catch (e) {
      showToast(`Sweep failed: ${e.message}`, "error");
    }
    setSweeping(false);
  };

  const accountsMode =
    !!String(accountId || "").trim() &&
    String(accountId || "").trim() !== "default";
  const nowMs = Date.now();
  const topicSections = splitTopicRows(registryRows, { nowMs, accountsMode });
  const registryByThreadId = new Map(
    topicSections.active.map((model) => [model.threadId, model]),
  );
  const deletedThreadIds = new Set(
    topicSections.deleted.map((model) => model.threadId),
  );
  const discoveryStatus = buildDiscoveryStatusModel(registryDiscovery, {
    nowMs,
  });
  const hasRegistryData = registryRows.length > 0;

  const topicEntries = Object.entries(topics || {}).filter(
    ([id]) => !deletedThreadIds.has(String(id)),
  );
  const topicCount = topicEntries.length;
  const computedMaxConcurrent = Math.max(topicCount * 3, 8);
  const computedSubagentMaxConcurrent = Math.max(computedMaxConcurrent - 2, 4);
  const maxConcurrent = Number.isFinite(configAgentMaxConcurrent)
    ? configAgentMaxConcurrent
    : computedMaxConcurrent;
  const subagentMaxConcurrent = Number.isFinite(configSubagentMaxConcurrent)
    ? configSubagentMaxConcurrent
    : computedSubagentMaxConcurrent;

  return html`
    <div class="space-y-4">
      ${registryError &&
      html`
        <div class="bg-red-500/10 border border-red-500/40 rounded-xl p-4">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            <span class="text-sm font-medium">${registryError.title}</span>
          </div>
          <p class="mt-1 text-sm text-status-error-muted">
            ${registryError.text}
          </p>
        </div>
      `}
      ${debugEnabled &&
      html`
        <div class="flex justify-end">
          <button
            onclick=${() => {
              setResetMode("keep");
              setResetConfirmVisible(true);
            }}
            class="text-xs px-3 py-1.5 rounded-lg border border-border text-fg-muted hover:text-body hover:border-fg-muted transition-colors"
          >
            Reset onboarding
          </button>
        </div>
      `}
      <div class="bg-field border border-border rounded-lg p-3 space-y-1">
        <p class="text-sm text-body font-medium">${groupName || groupId}</p>
        <p class="text-xs text-fg-muted font-mono">${groupId}</p>
      </div>

      <div class="space-y-2">
        <h2 class="card-label mb-3">Existing Topics</h2>
        ${topicEntries.length > 0
          ? html`
              <div
                class="bg-field border border-border rounded-lg overflow-hidden"
              >
                <table class="w-full text-xs table-fixed">
                  <thead>
                    <tr class="border-b border-border">
                      <th class="text-left px-3 py-2 text-fg-muted font-medium">
                        Topic
                      </th>
                      <th
                        class="text-left px-3 py-2 text-fg-muted font-medium w-36"
                      >
                        Thread ID
                      </th>
                      ${agents.length > 0 &&
                      html`
                        <th
                          class="text-left px-3 py-2 text-fg-muted font-medium w-32"
                        >
                          Agent
                        </th>
                      `}
                      ${hasRegistryData &&
                      html`
                        <th
                          class="text-left px-3 py-2 text-fg-muted font-medium w-44"
                        >
                          Health
                        </th>
                      `}
                      <th class="px-3 py-2 w-28" />
                    </tr>
                  </thead>
                  <tbody>
                    ${topicEntries.map(([id, topic]) => {
                      const rowModel = registryByThreadId.get(String(id));
                      return html`
                        ${editingTopicId === String(id)
                          ? html`
                              <tr
                                class="border-b border-border last:border-0 align-top"
                              >
                                <td
                                  class="px-3 py-2"
                                  colspan=${3 +
                                  (agents.length > 0 ? 1 : 0) +
                                  (hasRegistryData ? 1 : 0)}
                                >
                                  <div class="space-y-2">
                                    <input
                                      type="text"
                                      value=${editingTopicName}
                                      onInput=${(e) =>
                                        setEditingTopicName(e.target.value)}
                                      onKeyDown=${(e) => {
                                        if (e.key === "Enter") saveRename(id);
                                        if (e.key === "Escape") cancelRename();
                                      }}
                                      class="w-full bg-field border border-border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
                                    />
                                    <textarea
                                      value=${editingTopicInstructions}
                                      onInput=${(e) =>
                                        setEditingTopicInstructions(
                                          e.target.value,
                                        )}
                                      placeholder="System instructions (optional)"
                                      rows="6"
                                      class="w-full bg-field border border-border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted resize-y"
                                    />
                                    ${agents.length > 0 &&
                                    html`
                                      <div class="flex items-center gap-2">
                                        <label class="text-xs text-fg-muted">Agent:</label>
                                        <${AgentSelect}
                                          value=${editingTopicAgentId}
                                          agents=${agents}
                                          onChange=${setEditingTopicAgentId}
                                        />
                                      </div>
                                    `}
                                    <div class="flex items-center gap-2">
                                      <button
                                        onclick=${() => saveRename(id)}
                                        disabled=${renamingTopicId ===
                                        String(id)}
                                        class="text-xs px-2 py-1 rounded transition-all ac-btn-cyan ${renamingTopicId ===
                                        String(id)
                                          ? "opacity-50 cursor-not-allowed"
                                          : ""}"
                                      >
                                        Save
                                      </button>
                                      <button
                                        onclick=${cancelRename}
                                        class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            `
                          : html`
                              <tr
                                class="border-b border-border last:border-0 align-middle"
                              >
                                <td class="px-3 py-2 text-body">
                                  <div class="flex items-center gap-2 flex-wrap">
                                    <span>${topic.name}</span>
                                    ${rowModel?.discovered &&
                                    html`<${Badge} tone="info">discovered</${Badge}>`}
                                    ${rowModel?.stale &&
                                    html`<${Badge} tone="warning">stale</${Badge}>`}
                                    ${rowModel?.unattributed &&
                                    html`<${Badge} tone="warning">no account attributed</${Badge}>`}
                                    <button
                                      onclick=${() =>
                                        startRename(
                                          id,
                                          topic.name,
                                          topic.systemInstructions,
                                          topic.agentId,
                                        )}
                                      class="inline-flex items-center justify-center text-white/80 hover:text-white transition-colors"
                                      title="Edit topic"
                                      aria-label="Edit topic"
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="currentColor"
                                        aria-hidden="true"
                                      >
                                        <path
                                          d="M11.854 1.146a.5.5 0 00-.708 0L3 9.293V13h3.707l8.146-8.146a.5.5 0 000-.708l-3-3zM3.5 12.5v-2.793l7-7L13.793 6l-7 7H3.5z"
                                        />
                                      </svg>
                                    </button>
                                  </div>
                                  ${topic.systemInstructions &&
                                  html`
                                    <p
                                      class="text-[11px] text-fg-muted mt-1 line-clamp-1"
                                    >
                                      ${topic.systemInstructions}
                                    </p>
                                  `}
                                </td>
                                <td
                                  class="px-3 py-2 text-fg-muted font-mono w-36"
                                >
                                  ${id}
                                </td>
                                ${agents.length > 0 &&
                                html`
                                  <td class="px-3 py-2 text-fg-muted w-32">
                                    ${topic.agentId
                                      ? html`<span class="text-body">${agents.find((a) => a.id === topic.agentId)?.name || topic.agentId}</span>`
                                      : html`<span class="text-fg-dim">default</span>`}
                                  </td>
                                `}
                                ${hasRegistryData &&
                                html`<${TopicHealthCell} model=${rowModel} />`}
                                <td class="px-3 py-2">
                                  <div
                                    class="flex items-center gap-2 justify-end"
                                  >
                                    ${rowModel?.stale &&
                                    html`
                                      <button
                                        onclick=${() => handleVerify(id)}
                                        disabled=${verifyingTopicId ===
                                        String(id)}
                                        class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted ${verifyingTopicId ===
                                        String(id)
                                          ? "opacity-50 cursor-not-allowed"
                                          : ""}"
                                        title="Check whether this topic is still reachable"
                                      >
                                        ${verifyingTopicId === String(id)
                                          ? "Verifying..."
                                          : "Verify now"}
                                      </button>
                                    `}
                                    <button
                                      onclick=${() =>
                                        setDeleteTopicConfirm({
                                          id: String(id),
                                          name: String(topic.name || ""),
                                        })}
                                      disabled=${deleting === id}
                                      class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-status-error hover:border-red-500 ${deleting ===
                                      id
                                        ? "opacity-50 cursor-not-allowed"
                                        : ""}"
                                      title="Delete topic"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            `}
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="text-xs text-fg-muted">No topics yet.</p>`}
      </div>

      ${topicSections.discovered.length > 0 &&
      html`
        <div class="space-y-2">
          <h2 class="card-label mb-3">Discovered Topics</h2>
          <p class="text-xs text-fg-muted">
            Seen in agent activity but not yet named. Naming a topic registers
            it.
          </p>
          <div
            class="bg-field border border-border rounded-lg divide-y divide-border"
          >
            ${topicSections.discovered.map((model) => {
              const draft =
                renameDrafts[model.threadId] ||
                createTopicRenameState(model.threadId);
              return html`
                <div key=${model.threadId} class="px-3 py-2 space-y-2">
                  <div class="flex items-center gap-2 flex-wrap text-xs">
                    <${Badge} tone="info">discovered</${Badge}>
                    ${model.stale &&
                    html`<${Badge} tone="warning">stale</${Badge}>`}
                    ${model.unattributed &&
                    html`<${Badge} tone="warning">no account attributed</${Badge}>`}
                    <span class="text-fg-muted font-mono"
                      >thread ${model.threadId}</span
                    >
                    ${model.health.quiet && html`<${QuietDot} />`}
                    <span class="text-fg-muted"
                      >${model.health.lastSeenLabel}</span
                    >
                    ${model.health.seenByLabel &&
                    html`
                      <span class="text-fg-dim">${model.health.seenByLabel}</span>
                    `}
                  </div>
                  <div class="flex items-center gap-2">
                    <input
                      type="text"
                      value=${draft.value}
                      onInput=${(e) =>
                        setRenameDraftValue(model.threadId, e.target.value)}
                      onKeyDown=${(e) => {
                        if (e.key === "Enter")
                          saveDiscoveredName(model.threadId);
                      }}
                      placeholder="Name this topic to register it"
                      class="flex-1 bg-field border border-border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
                    />
                    <button
                      onclick=${() => saveDiscoveredName(model.threadId)}
                      disabled=${draft.saving || !draft.value.trim()}
                      class="text-xs px-2 py-1 rounded transition-all ac-btn-cyan ${draft.saving ||
                      !draft.value.trim()
                        ? "opacity-50 cursor-not-allowed"
                        : ""}"
                    >
                      ${draft.saving ? "Saving..." : "Save name"}
                    </button>
                  </div>
                  ${draft.error &&
                  html`
                    <p class="text-xs text-status-error-muted">
                      ${draft.error} — edit the name and try again.
                    </p>
                  `}
                </div>
              `;
            })}
          </div>
        </div>
      `}
      ${topicSections.deleted.length > 0 &&
      html`
        <div class="space-y-2">
          <button
            onclick=${() => setShowDeleted((v) => !v)}
            class="flex items-center gap-1.5 text-xs text-fg-muted hover:text-body transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              class="transition-transform ${showDeleted ? "rotate-90" : ""}"
              aria-hidden="true"
            >
              <path
                d="M5.646 3.646a.5.5 0 000 .708L9.293 8l-3.647 3.646a.5.5 0 00.708.708l4-4a.5.5 0 000-.708l-4-4a.5.5 0 00-.708 0z"
              />
            </svg>
            Deleted topics (${topicSections.deleted.length})
          </button>
          ${showDeleted &&
          html`
            <div
              class="bg-field border border-border rounded-lg divide-y divide-border"
            >
              ${topicSections.deleted.map(
                (model) => html`
                  <div
                    key=${model.threadId}
                    class="px-3 py-2 flex items-center justify-between gap-2"
                  >
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap text-xs">
                        <span class="text-body">${model.displayName}</span>
                        <span class="text-fg-muted font-mono"
                          >thread ${model.threadId}</span
                        >
                      </div>
                      <p class="text-[11px] text-fg-dim mt-0.5">
                        deleted
                        ${formatLocaleDateTime(model.deletedAt, {
                          valueIsEpochMs: true,
                        })}
                      </p>
                    </div>
                    <button
                      onclick=${() => handleRestore(model.threadId)}
                      disabled=${restoringTopicId === model.threadId}
                      class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted ${restoringTopicId ===
                      model.threadId
                        ? "opacity-50 cursor-not-allowed"
                        : ""}"
                    >
                      ${restoringTopicId === model.threadId
                        ? "Restoring..."
                        : "Restore"}
                    </button>
                  </div>
                `,
              )}
            </div>
          `}
        </div>
      `}

      ${showCreateTopic &&
      html`
        <div class="space-y-2 bg-field border border-border rounded-lg p-3">
          <label class="text-xs text-fg-muted">Create new topic</label>
          <div class="space-y-2">
            <input
              type="text"
              value=${newTopicName}
              onInput=${(e) => setNewTopicName(e.target.value)}
              onKeyDown=${(e) => {
                if (e.key === "Enter") createSingle();
              }}
              placeholder="Topic name"
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
            />
            <textarea
              value=${newTopicInstructions}
              onInput=${(e) => setNewTopicInstructions(e.target.value)}
              placeholder="System instructions (optional)"
              rows="5"
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted resize-y"
            />
            ${agents.length > 0 &&
            html`
              <div class="flex items-center gap-2">
                <label class="text-xs text-fg-muted">Agent:</label>
                <${AgentSelect}
                  value=${newTopicAgentId}
                  agents=${agents}
                  onChange=${setNewTopicAgentId}
                />
              </div>
            `}
            <div class="flex justify-end">
              <${ActionButton}
                onClick=${createSingle}
                disabled=${creating || !newTopicName.trim()}
                loading=${creating}
                tone="secondary"
                size="lg"
                idleLabel="Add topic"
                loadingLabel="Creating..."
              />
            </div>
          </div>
        </div>
      `}
      ${error &&
      html`
        <div class="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <p class="text-sm text-status-error-muted">${error}</p>
        </div>
      `}

      <div class="flex items-center justify-start">
        <button
          onclick=${() => setShowCreateTopic((v) => !v)}
          class="${showCreateTopic
            ? "w-auto text-sm font-medium px-4 py-2 rounded-xl transition-all border border-border text-body hover:border-fg-muted"
            : "w-auto text-sm font-medium px-4 py-2 rounded-xl transition-all ac-btn-cyan"}"
        >
          ${showCreateTopic ? "Close create topic" : "Create topic"}
        </button>
      </div>

      <div class="border-t border-white/10" />

      ${discoveryStatus &&
      html`
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs text-fg-muted">
            Topic discovery is
            <span class="text-body">${discoveryStatus.enabledLabel}</span> ·
            last sweep
            <span class="text-body">${discoveryStatus.lastSweepLabel}</span>
            ${discoveryStatus.resultLabel &&
            html`<span class="text-fg-dim">
              (${discoveryStatus.resultLabel})</span
            >`}
          </p>
          <button
            onclick=${handleSweep}
            disabled=${sweeping || !discoveryStatus.enabled}
            class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted ${sweeping ||
            !discoveryStatus.enabled
              ? "opacity-50 cursor-not-allowed"
              : ""}"
          >
            ${sweeping ? "Sweeping..." : "Sweep now"}
          </button>
        </div>
      `}

      <p class="text-xs text-fg-muted">
        Concurrency is auto-scaled to support your group:
        <span class="text-body"> agent ${maxConcurrent}</span>,
        <span class="text-body"> subagent ${subagentMaxConcurrent}</span>
        <span class="text-fg-dim"> (${topicCount} topics)</span>.
      </p>
      <p class="text-[11px] text-fg-muted">
        This registry can drift if topics are created, renamed, or removed
        outside this page. Your agent will update the registry if it notices a
        discrepancy.
      </p>
      <${ConfirmDialog}
        visible=${resetConfirmVisible}
        title="Reset Telegram onboarding?"
        message="This restarts workspace onboarding for this account. Choose what happens to your topic deletion history:"
        details=${html`
          <div class="space-y-2 text-sm">
            <label class="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="telegram-reset-mode"
                checked=${resetMode === "keep"}
                onChange=${() => setResetMode("keep")}
                class="mt-0.5"
              />
              <span class="text-fg-muted">
                <span class="text-body">Keep deletion history</span> — topics
                you deleted stay deleted and will not be rediscovered.
              </span>
            </label>
            <label class="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="telegram-reset-mode"
                checked=${resetMode === "rediscover"}
                onChange=${() => setResetMode("rediscover")}
                class="mt-0.5"
              />
              <span class="text-fg-muted">
                <span class="text-body">Reset and rediscover</span> — clears
                deletion tombstones so previously removed topics can be
                rediscovered on the next sweep.
              </span>
            </label>
          </div>
        `}
        confirmLabel="Reset onboarding"
        confirmLoadingLabel="Resetting..."
        confirmTone="warning"
        confirmLoading=${resetting}
        cancelLabel="Cancel"
        onCancel=${() => {
          if (resetting) return;
          setResetConfirmVisible(false);
        }}
        onConfirm=${async () => {
          setResetting(true);
          try {
            await onResetOnboarding(resetMode);
          } finally {
            setResetting(false);
            setResetConfirmVisible(false);
          }
        }}
      />
      <${ConfirmDialog}
        visible=${!!deleteTopicConfirm}
        title="Delete topic?"
        message=${deleteTopicConfirm
          ? `This will delete "${deleteTopicConfirm.name}" (thread ${deleteTopicConfirm.id}) from your Telegram workspace.`
          : "This will delete this topic from your Telegram workspace."}
        confirmLabel="Delete topic"
        confirmLoadingLabel="Deleting..."
        confirmTone="warning"
        confirmLoading=${!!deleting}
        cancelLabel="Cancel"
        onCancel=${() => {
          if (deleting) return;
          setDeleteTopicConfirm(null);
        }}
        onConfirm=${async () => {
          if (!deleteTopicConfirm) return;
          const pendingDelete = deleteTopicConfirm;
          setDeleteTopicConfirm(null);
          await handleDelete(pendingDelete.id, pendingDelete.name);
        }}
      />
    </div>
  `;
};
