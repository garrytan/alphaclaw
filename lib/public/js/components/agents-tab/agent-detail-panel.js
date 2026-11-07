import { h } from "preact";
import { useState, useCallback, useMemo } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { Tabs, getTabPanelProps } from "../tabs.js";
import { PopActions } from "../pop-actions.js";
import { OverflowMenu, OverflowMenuItem } from "../overflow-menu.js";
import { ChannelOperationsPanel } from "../channel-operations-panel.js";
import { AgentOverview } from "./agent-overview/index.js";
import { useWorkspaceCard } from "./agent-overview/use-workspace-card.js";
import { AgentToolsPanel } from "./agent-tools/index.js";
import { useAgentTools } from "./agent-tools/use-agent-tools.js";
import { AgentSessionsList } from "./agent-sessions-list.js";
import {
  answersRelay,
  describeAgent,
  getAgentChannelAccounts,
  getAgentSessions,
  kAgentDetailTabIds,
} from "./agent-detail-model.js";
import { useModels } from "../models-tab/use-models.js";
import { buildSyntheticModelEntry, getModelDisplayLabel } from "../models-tab/model-picker.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { fetchChannelAccounts } from "../../lib/api/channels.js";
import { fetchRelayStatus } from "../../lib/api/relay.js";
import { formatBytes } from "../../lib/format.js";

const html = htm.bind(h);

const resolveAgentModel = (model) => {
  if (!model) return "";
  if (typeof model === "string") return model.trim();
  return String(model.primary || "").trim();
};

const WorkspaceMeta = ({ agent, onOpenWorkspace }) => {
  const { loadingWorkspaceSize, workspaceSizeBytes, workspaceSizeExists } = useWorkspaceCard({ agent });
  const size = loadingWorkspaceSize
    ? "calculating size…"
    : workspaceSizeBytes != null
      ? formatBytes(workspaceSizeBytes)
      : workspaceSizeExists
        ? "size unavailable"
        : "directory not found";
  return html`
    <p class="agents-detail-meta">
      <span>id ${agent.id}</span>
      <span aria-hidden="true"> · </span>
      ${agent.workspace
        ? html`<span>
            ${"workspace "}<button
              type="button"
              class="agents-detail-meta-link"
              title="Open workspace"
              onclick=${() => onOpenWorkspace(agent.workspace)}
            >${agent.workspace}</button>${" (" + size + ")"}
          </span>`
        : html`<span>no workspace configured</span>`}
    </p>
  `;
};

export const AgentDetailPanel = ({
  agent = null,
  agents = [],
  sessions = [],
  activeTab = "overview",
  saving = false,
  onUpdateAgent = async () => {},
  onSetLocation = () => {},
  onSelectTab = () => {},
  onEdit = () => {},
  onDelete = () => {},
  onSetDefault = () => {},
  onOpenWorkspace = () => {},
  onOpenChat = () => {},
}) => {
  const tools = useAgentTools({ agent: agent || {} });
  // The tools panel locks while a save is in flight: markSaved (and the
  // agent-prop refresh that follows) rebase local state onto the response, so
  // mid-flight edits would be silently discarded.
  const [savingTools, setSavingTools] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { catalog, primary: defaultPrimaryModel, ready: modelsReady } = useModels();
  const channelsRead = useCachedFetch("/api/channels/accounts", fetchChannelAccounts, { maxAgeMs: 30000 });
  const relayRead = useCachedFetch("/api/relay/status", fetchRelayStatus, {
    maxAgeMs: 30000,
    enabled: !!agent?.default,
  });

  const handleSaveTools = useCallback(async () => {
    if (!agent) return;
    setSavingTools(true);
    try {
      const nextAgent = await onUpdateAgent(
        agent.id,
        { tools: tools.toolsConfig },
        "Tool access updated",
      );
      tools.markSaved(nextAgent?.tools || tools.toolsConfig);
    } catch {
      // toast handled by parent
    } finally {
      setSavingTools(false);
    }
  }, [agent, tools.toolsConfig, tools.markSaved, onUpdateAgent]);

  const isSaving = saving || savingTools;

  const toolsSummary = useMemo(() => ({
    profile: tools.profile,
    enabledCount: (tools.toolStates || []).filter((t) => t.enabled).length,
    totalCount: (tools.toolStates || []).length,
  }), [tools.profile, tools.toolStates]);

  if (!agent) {
    return html`
      <div class="agents-detail-panel">
        <div class="agents-empty-state">
          <span class="text-sm">Select an agent to view details</span>
        </div>
      </div>
    `;
  }

  const name = agent.name || agent.id;
  const modelKey = resolveAgentModel(agent.model) || defaultPrimaryModel || "";
  const modelEntry = modelKey ? catalog.find((entry) => entry?.key === modelKey) || buildSyntheticModelEntry(modelKey) : null;
  const modelLabel = modelEntry ? getModelDisplayLabel(modelEntry) : "";
  const channelsKnown = !!channelsRead.data && !channelsRead.error;
  const channelAccounts = channelsKnown
    ? getAgentChannelAccounts({ agent, channels: channelsRead.data?.channels })
    : [];
  const relayKnown = !agent.default || (!!relayRead.data && !relayRead.error);
  const relay = relayKnown && answersRelay({ agent, relayStatus: relayRead.data });
  const description = !modelsReady && !modelKey
    ? ""
    : describeAgent({
        name,
        modelLabel,
        channelsKnown: channelsKnown && relayKnown,
        channelLabels: channelAccounts.map((account) => account.label),
        relay,
      });
  const agentSessions = getAgentSessions({ sessions, agentId: agent.id });
  const isMain = String(agent.id || "") === "main";
  const tab = kAgentDetailTabIds.includes(activeTab) ? activeTab : "overview";
  const detailTabs = [
    { label: "Overview", value: "overview" },
    { label: "Tools " + toolsSummary.enabledCount, value: "tools" },
    {
      label: channelsKnown && relayKnown ? "Channels " + (channelAccounts.length + (relay ? 1 : 0)) : "Channels",
      value: "channels",
    },
    { label: "Sessions " + agentSessions.length, value: "sessions" },
  ];

  return html`
    <div class="agents-detail-panel">
      <div class="agents-detail-header-area">
        <div class="agents-detail-header-area-inner">
          <div class="agents-detail-header">
            <div class="agents-detail-heading">
              <div class="flex items-center gap-2 min-w-0">
                <h1 class="agents-detail-header-title">${name}</h1>
                ${agent.default ? html`<${Badge} tone="cyan">Default</${Badge}>` : null}
              </div>
              ${description ? html`<p class="agents-detail-description">${description}</p>` : null}
              <${WorkspaceMeta} agent=${agent} onOpenWorkspace=${onOpenWorkspace} />
            </div>
            <div class="agents-detail-actions">
              <${PopActions} visible=${tools.dirty}>
                <${ActionButton}
                  onClick=${tools.reset}
                  disabled=${isSaving}
                  tone="secondary"
                  size="sm"
                  idleLabel="Cancel"
                  className="text-xs"
                />
                <${ActionButton}
                  onClick=${handleSaveTools}
                  disabled=${isSaving}
                  loading=${isSaving}
                  loadingMode="inline"
                  tone="primary"
                  size="sm"
                  idleLabel="Save changes"
                  loadingLabel="Saving…"
                  className="text-xs"
                />
              </${PopActions}>
              <${ActionButton}
                onClick=${() => onOpenChat(agent)}
                tone=${tools.dirty ? "secondary" : "solid"}
                size="sm"
                idleLabel="Open chat"
                className="agents-detail-open-chat"
              />
              <${OverflowMenu}
                open=${menuOpen}
                ariaLabel=${"More actions for " + name}
                onClose=${() => setMenuOpen(false)}
                onToggle=${() => setMenuOpen((open) => !open)}
              >
                <${OverflowMenuItem}
                  onClick=${() => {
                    setMenuOpen(false);
                    onEdit(agent);
                  }}
                >
                  Edit
                </${OverflowMenuItem}>
                ${!agent.default
                  ? html`<${OverflowMenuItem}
                      disabled=${saving}
                      onClick=${() => {
                        setMenuOpen(false);
                        onSetDefault(agent.id);
                      }}
                    >
                      Set as default
                    </${OverflowMenuItem}>`
                  : null}
                ${!isMain
                  ? html`<${OverflowMenuItem}
                      disabled=${saving}
                      className="text-status-error-muted"
                      onClick=${() => {
                        setMenuOpen(false);
                        onDelete(agent);
                      }}
                    >
                      Delete
                    </${OverflowMenuItem}>`
                  : null}
              </${OverflowMenu}>
            </div>
          </div>
          <${Tabs}
            tabs=${detailTabs}
            activeTab=${tab}
            onSelectTab=${onSelectTab}
            idBase="agent-detail"
            ariaLabel="Agent sections"
            className="agents-detail-tabs"
          />
        </div>
      </div>
      <div class="agents-detail-body">
        <div class="agents-detail-content" ...${getTabPanelProps("agent-detail", tab)}>
          ${tab === "overview"
            ? html`
                <${AgentOverview}
                  agent=${agent}
                  saving=${saving}
                  toolsSummary=${toolsSummary}
                  channelAccounts=${channelAccounts}
                  channelsKnown=${channelsKnown}
                  channelsError=${channelsRead.error}
                  relay=${relay}
                  sessions=${agentSessions}
                  onUpdateAgent=${onUpdateAgent}
                  onSwitchToModels=${() => onSetLocation("/models")}
                  onSelectTab=${onSelectTab}
                />
              `
            : tab === "tools"
              ? html`
                  <${AgentToolsPanel}
                    agent=${agent}
                    tools=${tools}
                    disabled=${isSaving}
                  />
                `
              : tab === "channels"
                ? html`
                    ${relay
                      ? html`<p class="agents-detail-relay-note">
                          ${name + " also answers relay messages. "}<a href="#/relay" class="agents-detail-meta-link">Open Relay</a>
                        </p>`
                      : null}
                    <${ChannelOperationsPanel}
                      agent=${agent}
                      agents=${agents}
                      onSetLocation=${onSetLocation}
                    />
                  `
                : html`<${AgentSessionsList} sessions=${agentSessions} />`}
        </div>
      </div>
    </div>
  `;
};
