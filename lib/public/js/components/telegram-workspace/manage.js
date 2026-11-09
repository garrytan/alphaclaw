import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { Badge } from "../badge.js";
import { TooltipBadge } from "../tooltip-badge.js";
import { formatLocaleDateTime } from "../../lib/format.js";
import {
  splitTopicRows,
  buildDiscoveryStatusModel,
  createTopicRenameState,
} from "./helpers.js";
import { useTelegramTopics } from "./use-telegram-topics.js";
import { buildResourceCapModel } from "./resource-cap-model.js";
import { TopicTable } from "./topic-table.js";
import {
  AgentSelect,
  QuietDot,
  kStaleDiscoveredTooltip,
  kUnattributedTooltip,
} from "./topic-row.js";

const html = htm.bind(h);

export const ManageTelegramWorkspace = ({
  accountId,
  groupId,
  groupName,
  initialTopics,
  configAgentMaxConcurrent,
  configSubagentMaxConcurrent,
  // Server-computed concurrency from the workspace status response:
  // { computedMaxConcurrent, computedSubagentMaxConcurrent, resourceCap,
  // resourceCapSource: "machine" | "legacy" }. Absent on older servers.
  concurrency = null,
  debugEnabled,
  onResetOnboarding,
}) => {
  const {
    topics,
    topicsError,
    loadTopics,
    agents,
    registryRows,
    registryDiscovery,
    registryError,
    newTopicName,
    setNewTopicName,
    newTopicInstructions,
    setNewTopicInstructions,
    newTopicAgentId,
    setNewTopicAgentId,
    showCreateTopic,
    setShowCreateTopic,
    creating,
    error,
    createSingle,
    deleting,
    handleDelete,
    editingTopicId,
    editingTopicName,
    setEditingTopicName,
    editingTopicInstructions,
    setEditingTopicInstructions,
    editingTopicAgentId,
    setEditingTopicAgentId,
    renamingTopicId,
    editSaveError,
    startRename,
    cancelRename,
    saveRename,
    renameDrafts,
    setRenameDraftValue,
    saveDiscoveredName,
    verifyingTopicId,
    handleVerify,
    restoringTopicId,
    handleRestore,
    sweeping,
    handleSweep,
  } = useTelegramTopics({ accountId, groupId, initialTopics });
  const [deleteTopicConfirm, setDeleteTopicConfirm] = useState(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [resetConfirmVisible, setResetConfirmVisible] = useState(false);
  const [resetMode, setResetMode] = useState("keep");
  const [resetting, setResetting] = useState(false);

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
  const {
    maxConcurrent,
    subagentMaxConcurrent,
    resourceCap,
    resourceCapFromMachine,
  } = buildResourceCapModel({
    topicCount,
    configAgentMaxConcurrent,
    configSubagentMaxConcurrent,
    concurrency,
  });

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
        <h2 class="card-label mb-3">Existing topics</h2>
        ${topicsError &&
        html`
          <${InlineErrorChip}
            error=${topicsError}
            headline="Couldn't load topics."
            onRetry=${loadTopics}
          />
        `}
        ${topicEntries.length > 0
          ? html`
              <${TopicTable}
                entries=${topicEntries}
                agents=${agents}
                hasRegistryData=${hasRegistryData}
                registryByThreadId=${registryByThreadId}
                edit=${{
                  topicId: editingTopicId,
                  name: editingTopicName,
                  setName: setEditingTopicName,
                  instructions: editingTopicInstructions,
                  setInstructions: setEditingTopicInstructions,
                  agentId: editingTopicAgentId,
                  setAgentId: setEditingTopicAgentId,
                  savingTopicId: renamingTopicId,
                  error: editSaveError,
                  save: saveRename,
                  cancel: cancelRename,
                }}
                verifyingTopicId=${verifyingTopicId}
                deletingTopicId=${deleting}
                onEdit=${startRename}
                onVerify=${handleVerify}
                onDelete=${setDeleteTopicConfirm}
              />
            `
          : !topicsError &&
            html`<p class="text-xs text-fg-muted">No topics yet.</p>`}
      </div>

      ${topicSections.discovered.length > 0 &&
      html`
        <div class="space-y-2">
          <h2 class="card-label mb-3">Discovered topics</h2>
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
                    html`<${TooltipBadge}
                      tone="warning"
                      label="stale"
                      text=${kStaleDiscoveredTooltip}
                    />`}
                    ${model.unattributed &&
                    html`<${TooltipBadge}
                      tone="warning"
                      label="no account attributed"
                      text=${kUnattributedTooltip}
                    />`}
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
                      class="flex-1 bg-field border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
                    />
                    <button
                      onclick=${() => saveDiscoveredName(model.threadId)}
                      disabled=${draft.saving || !draft.value.trim()}
                      class="text-xs px-2 py-1 rounded transition-all ac-btn-cyan ${draft.saving ||
                      !draft.value.trim()
                        ? "opacity-50 cursor-not-allowed"
                        : ""}"
                    >
                      ${draft.saving ? "Saving…" : "Save name"}
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
                      <p class="text-xs text-fg-dim mt-0.5">
                        deleted${" "}${formatLocaleDateTime(model.deletedAt, {
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
                        ? "Restoring…"
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
              class="w-full bg-field border rounded-lg px-3 py-2 text-sm text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
            />
            <textarea
              value=${newTopicInstructions}
              onInput=${(e) => setNewTopicInstructions(e.target.value)}
              placeholder="System instructions (optional)"
              rows="5"
              class="w-full bg-field border rounded-lg px-3 py-2 text-sm text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted resize-y"
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
                loadingLabel="Creating…"
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
            Topic discovery is${" "}<span class="text-body"
              >${discoveryStatus.enabledLabel}</span
            >${" · last sweep "}<span class="text-body"
              >${discoveryStatus.lastSweepLabel}</span
            >${discoveryStatus.resultLabel &&
            html` <span class="text-fg-dim">(${discoveryStatus.resultLabel})</span>`}
          </p>
          <button
            onclick=${handleSweep}
            disabled=${sweeping || !discoveryStatus.enabled}
            class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted ${sweeping ||
            !discoveryStatus.enabled
              ? "opacity-50 cursor-not-allowed"
              : ""}"
          >
            ${sweeping ? "Sweeping…" : "Sweep now"}
          </button>
        </div>
      `}

      <p class="text-xs text-fg-muted">
        Concurrency is auto-scaled to support your group:
        <span class="text-body"> agent ${maxConcurrent}</span>,
        <span class="text-body"> subagent ${subagentMaxConcurrent}</span>
        <span class="text-fg-dim"> (${topicCount} topics)</span>${resourceCapFromMachine
          ? html`<span
              >, capped by machine size at${" "}
              <span class="text-body">${resourceCap}</span></span
            >`
          : ""}.
      </p>
      <p class="text-xs text-fg-muted">
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
        confirmLoadingLabel="Resetting…"
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
        confirmLoadingLabel="Deleting…"
        confirmTone="warning"
        confirmLoading=${!!deleting}
        cancelLabel="Cancel"
        onCancel=${() => {
          if (deleting) return;
          setDeleteTopicConfirm(null);
        }}
        onConfirm=${async () => {
          if (!deleteTopicConfirm || deleting) return;
          const pendingDelete = deleteTopicConfirm;
          // Dialog stays open (confirmLoading) until the delete resolves.
          await handleDelete(pendingDelete.id, pendingDelete.name);
          setDeleteTopicConfirm(null);
        }}
      />
    </div>
  `;
};
