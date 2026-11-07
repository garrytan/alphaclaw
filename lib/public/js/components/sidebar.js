import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  AddLineIcon,
  AlarmLineIcon,
  BarChartLineIcon,
  Brain2LineIcon,
  BracesLineIcon,
  Chat4LineIcon,
  ChevronDownIcon,
  ComputerLineIcon,
  DashboardLineIcon,
  DownloadLineIcon,
  EyeLineIcon,
  FolderLineIcon,
  GroupLineIcon,
  HomeLineIcon,
  PulseLineIcon,
  RobotLineIcon,
  SignalTowerLineIcon,
  ChatVoiceLineIcon,
  TeamLineIcon,
  TerminalFillIcon,
} from "./icons.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { FileTree } from "./file-tree.js";
import { OverflowMenu, OverflowMenuItem } from "./overflow-menu.js";
import { UpdateActionButton } from "./update-action-button.js";
import { SidebarGitPanel } from "./sidebar-git-panel.js";
import { UpdateModal } from "./update-modal.js";
import {
  readUiSettings,
  updateUiSettings,
  writeUiSettings,
} from "../lib/ui-settings.js";
import { kChannelRegistry } from "../lib/channel-registry.js";
import {
  getAgentIdFromSessionKey,
  getChatSessionLabel,
  getSessionChannelForIcon,
  getSessionRowKey,
  getSessionRowKind,
  isReadOnlySession,
} from "../lib/session-keys.js";
import { formatRelativeTime } from "../lib/format.js";
import { useNowMs } from "../hooks/use-now-ms.js";
import { sanitizeAgentEmoji } from "../lib/agent-identity.js";
import { ThemeToggle } from "./theme-toggle.js";

const html = htm.bind(h);
const kBrowseBottomPanelUiSettingKey = "browseBottomPanelHeightPx";
const kBrowsePanelMinHeightPx = 120;
const kBrowseBottomMinHeightPx = 120;
const kBrowseResizerHeightPx = 6;
const kDefaultBrowseBottomPanelHeightPx = 260;
const kChatSidebarCollapsedAgentIdsKey = "chatSidebarCollapsedAgentIds";
// Derived from the shared channel registry (5.0) so new providers land once.
const kChatChannelIconById = Object.fromEntries(
  kChannelRegistry
    .filter((entry) => entry.icon)
    .map((entry) => [entry.id, entry.icon]),
);
const kChatSectionVisibleRows = 30;
const kChatSections = [
  { id: "chats", label: "", collapsible: false },
  { id: "cron", label: "Scheduled", collapsible: true },
  { id: "other", label: "Other", collapsible: true },
];
const getChatSectionId = (row) => {
  const kind = getSessionRowKind(row);
  if (row?.isMain === true) return "chats";
  if (kind === "cron") return "cron";
  if (kind === "other") return "other";
  return "chats";
};
const readChatSidebarCollapsedAgentIds = () => {
  const raw = readUiSettings()[kChatSidebarCollapsedAgentIdsKey];
  return Array.isArray(raw) ? raw : [];
};
const kSidebarNavIconsById = {
  cron: AlarmLineIcon,
  usage: BarChartLineIcon,
  doctor: PulseLineIcon,
  watchdog: EyeLineIcon,
  models: Brain2LineIcon,
  envars: BracesLineIcon,
  webhooks: SignalTowerLineIcon,
  relay: ChatVoiceLineIcon,
  nodes: ComputerLineIcon,
  team: TeamLineIcon,
  upgrade: DownloadLineIcon,
  dashboards: DashboardLineIcon,
  "claude-code": TerminalFillIcon,
};

const readStoredBrowseBottomPanelHeight = () => {
  try {
    const settings = readUiSettings();
    const fromSharedSettings = Number.parseInt(
      String(settings?.[kBrowseBottomPanelUiSettingKey] || ""),
      10,
    );
    if (Number.isFinite(fromSharedSettings) && fromSharedSettings > 0) {
      return fromSharedSettings;
    }
    return kDefaultBrowseBottomPanelHeightPx;
  } catch {
    return kDefaultBrowseBottomPanelHeightPx;
  }
};

const renderNavItem = ({
  item,
  selectedNavId,
  onSelectNavItem,
  onExternalNavClick,
  claudeCode,
}) => {
  const NavIcon = kSidebarNavIconsById[item.id] || null;
  // Claude Code launcher: an action item wearing the external-link shape. The
  // real href keeps keyboard focus and modifier-click semantics; the handler
  // intercepts plain clicks to fire the routine (or fall back to the href
  // destination). Special-cased for the single item — generalize to
  // item.onAction only if a second action item ever appears.
  if (item.id === "claude-code" && claudeCode) {
    return html`
      <a
        href=${item.href}
        class=${claudeCode.launching ? "is-launching" : ""}
        aria-busy=${claudeCode.launching ? "true" : undefined}
        aria-disabled=${claudeCode.launching ? "true" : undefined}
        onclick=${claudeCode.onOpen}
        title=${claudeCode.tooltip}
      >
        ${claudeCode.launching
          ? html`<${LoadingSpinner} className="sidebar-nav-icon" />`
          : NavIcon
            ? html`<${NavIcon} className="sidebar-nav-icon" />`
            : null}
        <span>${item.label}</span>
        ${claudeCode.liveDot === true || claudeCode.configured === true
          ? html`<span
              class="sidebar-claude-live-dot"
              aria-hidden="true"
              title=${claudeCode.liveDotTitle ||
              "Routine configured — a click starts a session"}
            ></span>`
          : null}
        ${claudeCode.launching
          ? html`<span class="sr-only" role="status">Starting Claude Code…</span>`
          : null}
      </a>
    `;
  }
  // External items (item.href, e.g. the gated OpenClaw Dashboards link) open
  // in a new tab instead of routing inside the SPA. The click handler only
  // notifies the shell (mobile drawer close) — never preventDefault, so
  // native navigation and modifier-clicks keep working.
  if (item.href) {
    return html`
      <a
        href=${item.href}
        target="_blank"
        rel="noreferrer"
        title=${item.title || undefined}
        aria-label=${item.title ? `${item.label} (opens in a new tab)` : undefined}
        onclick=${() => onExternalNavClick()}
      >
        ${NavIcon ? html`<${NavIcon} className="sidebar-nav-icon" />` : null}
        <span>${item.label}</span>
      </a>
    `;
  }
  return html`
    <a
      class=${selectedNavId === item.id ? "active" : ""}
      onclick=${() => onSelectNavItem(item.id)}
    >
      ${NavIcon ? html`<${NavIcon} className="sidebar-nav-icon" />` : null}
      <span>${item.label}</span>
    </a>
  `;
};

const getAgentIdentityEmoji = (agent) => sanitizeAgentEmoji(agent?.identity?.emoji);

export const AppSidebar = ({
  mobileSidebarOpen = false,
  authEnabled = false,
  menuRef = null,
  menuOpen = false,
  onToggleMenu = () => {},
  onCloseMenu = () => {},
  onLogout = () => {},
  sidebarTab = "menu",
  onSelectSidebarTab = () => {},
  navSections = [],
  claudeCode = null,
  selectedNavId = "",
  onSelectNavItem = () => {},
  onExternalNavClick = () => {},
  selectedBrowsePath = "",
  onSelectBrowseFile = () => {},
  onPreviewBrowseFile = () => {},
  acHasUpdate = false,
  acVersion = "",
  acCurrentOpenclawVersion = "",
  acLatest = "",
  acLatestOpenclawVersion = "",
  acUpdateStrategy = null,
  acManagedUpdate = null,
  acUpdating = false,
  onAcUpdate = () => {},
  agents = [],
  selectedAgentId = "",
  onSelectAgent = () => {},
  onAddAgent = () => {},
  chatSessions = [],
  selectedChatSessionKey = "",
  onSelectChatSession = () => {},
  onNewChatSession = () => {},
}) => {
  const browseLayoutRef = useRef(null);
  const browseBottomPanelRef = useRef(null);
  const browseResizeStartRef = useRef({ startY: 0, startHeight: 0 });
  const [browseBottomPanelHeightPx, setBrowseBottomPanelHeightPx] = useState(
    readStoredBrowseBottomPanelHeight,
  );
  const [isResizingBrowsePanels, setIsResizingBrowsePanels] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [collapsedChatAgentIds, setCollapsedChatAgentIds] = useState(() =>
    readChatSidebarCollapsedAgentIds(),
  );

  const [chatSessionQuery, setChatSessionQuery] = useState("");
  const [expandedChatSections, setExpandedChatSections] = useState([]);
  const toggleChatSection = (sectionKey) =>
    setExpandedChatSections((previous) =>
      previous.includes(sectionKey)
        ? previous.filter((entry) => entry !== sectionKey)
        : [...previous, sectionKey],
    );
  const chatNowMs = useNowMs(60_000, { enabled: sidebarTab === "chat" });

  const chatSessionGroups = useMemo(() => {
    const query = chatSessionQuery.trim().toLowerCase();
    const rows = (Array.isArray(chatSessions) ? chatSessions : []).filter(
      (row) =>
        !query ||
        row.isMain === true ||
        getChatSessionLabel(row).toLowerCase().includes(query) ||
        getSessionRowKey(row).toLowerCase().includes(query),
    );
    const order = [];
    const byAgent = new Map();
    for (const row of rows) {
      const aid = String(
        row.agentId ||
          getAgentIdFromSessionKey(getSessionRowKey(row)) ||
          "unknown",
      );
      if (!byAgent.has(aid)) {
        byAgent.set(aid, {
          agentId: aid,
          agentLabel: String(row.agentLabel || "").trim() || aid,
          sessions: [],
        });
        order.push(aid);
      }
      byAgent.get(aid).sessions.push(row);
    }
    const groups = order.map((aid) => byAgent.get(aid));
    const activityOf = (row) =>
      Number(row?.lastActivityAt || row?.updatedAt || 0);
    for (const group of groups) {
      group.sessions.sort((a, b) => {
        if ((a.isMain === true) !== (b.isMain === true)) return a.isMain ? -1 : 1;
        return activityOf(b) - activityOf(a);
      });
      group.sections = kChatSections.map((section) => ({
        ...section,
        rows: group.sessions.filter((row) => getChatSectionId(row) === section.id),
      }));
    }
    groups.sort((a, b) => {
      if (a.agentId === "main" && b.agentId !== "main") return -1;
      if (b.agentId === "main" && a.agentId !== "main") return 1;
      return a.agentLabel.localeCompare(b.agentLabel);
    });
    return groups;
  }, [chatSessions, chatSessionQuery]);

  const renderChatSessionRow = (sessionRow) => {
    const displayLabel = getChatSessionLabel(sessionRow);
    const isRelay = getSessionRowKind(sessionRow) === "relay";
    const readOnly = isReadOnlySession(sessionRow);
    const activityMs = Number(
      sessionRow.lastActivityAt || sessionRow.updatedAt || 0,
    );
    const channelIcon =
      kChatChannelIconById[
        String(
          getSessionChannelForIcon(sessionRow) || "",
        ).toLowerCase()
      ] || null;
    return html`
      <button
        key=${sessionRow.key}
        class=${`sidebar-chat-session-item ${selectedChatSessionKey === sessionRow.key ? "active" : ""}`}
        onclick=${() =>
          onSelectChatSession(sessionRow.key)}
        title=${readOnly ? `${displayLabel} (read-only here)` : displayLabel}
        data-session-kind=${getSessionRowKind(sessionRow)}
      >
        ${channelIcon
          ? html`<${channelIcon}
              className="sidebar-chat-session-channel-icon"
            />`
          : null}
        <span class="sidebar-chat-session-name"
          >${displayLabel}</span
        >
        ${sessionRow.running
          ? html`<span
              class="sidebar-chat-session-running"
              title="Running"
              aria-label="Running"
            ></span>`
          : null}
        ${isRelay
          ? html`<span class="sidebar-chat-session-badge">relay</span>`
          : null}
        ${activityMs > 0
          ? html`<span class="sidebar-chat-session-time"
              >${formatRelativeTime(activityMs, {
                nowMs: chatNowMs,
                style: "unit",
              })}</span
            >`
          : null}
      </button>
    `;
  };

  const toggleChatAgentCollapsed = (agentId) => {
    const id = String(agentId || "");
    setCollapsedChatAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const arr = Array.from(next);
      updateUiSettings((s) => ({
        ...s,
        [kChatSidebarCollapsedAgentIdsKey]: arr,
      }));
      return arr;
    });
  };

  useEffect(() => {
    const settings = readUiSettings();
    settings[kBrowseBottomPanelUiSettingKey] = browseBottomPanelHeightPx;
    writeUiSettings(settings);
  }, [browseBottomPanelHeightPx]);

  const getClampedBrowseBottomPanelHeight = (value) => {
    const layoutElement = browseLayoutRef.current;
    if (!layoutElement) return value;
    const layoutRect = layoutElement.getBoundingClientRect();
    const maxHeight = Math.max(
      kBrowseBottomMinHeightPx,
      layoutRect.height - kBrowsePanelMinHeightPx - kBrowseResizerHeightPx,
    );
    return Math.max(
      kBrowseBottomMinHeightPx,
      Math.min(maxHeight, value),
    );
  };

  const resizeBrowsePanelWithClientY = (clientY) => {
    const { startY, startHeight } = browseResizeStartRef.current;
    const proposedHeight = startHeight + (startY - clientY);
    setBrowseBottomPanelHeightPx(getClampedBrowseBottomPanelHeight(proposedHeight));
  };

  useEffect(() => {
    const layoutElement = browseLayoutRef.current;
    if (!layoutElement || typeof ResizeObserver === "undefined") return () => {};
    const observer = new ResizeObserver(() => {
      const layoutRect = layoutElement.getBoundingClientRect();
      if (layoutRect.height <= 0) return;
      setBrowseBottomPanelHeightPx((currentHeight) =>
        getClampedBrowseBottomPanelHeight(currentHeight),
      );
    });
    observer.observe(layoutElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isResizingBrowsePanels) return () => {};
    const handlePointerMove = (event) => resizeBrowsePanelWithClientY(event.clientY);
    const handlePointerUp = () => setIsResizingBrowsePanels(false);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingBrowsePanels]);

  const onBrowsePanelResizerPointerDown = (event) => {
    event.preventDefault();
    const measuredHeight =
      browseBottomPanelRef.current?.getBoundingClientRect().height ||
      browseBottomPanelHeightPx;
    browseResizeStartRef.current = {
      startY: event.clientY,
      startHeight: measuredHeight,
    };
    setBrowseBottomPanelHeightPx(getClampedBrowseBottomPanelHeight(measuredHeight));
    setIsResizingBrowsePanels(true);
  };

  const setupSection = navSections.find((section) => section.label === "Setup") || null;
  const remainingSections = navSections.filter((section) => section.label !== "Setup");

  return html`
    <div class=${`app-sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
    <div class="sidebar-brand">
      <span
        class="ac-logo-mark"
        style="--ac-logo-width: 20px; --ac-logo-height: 20px;"
        aria-hidden="true"
      ></span>
      <span><span style="color: var(--accent)">alpha</span>claw</span>
      <span style="margin-left: auto; display: inline-flex; align-items: center; gap: 4px;">
        <${ThemeToggle} />
      ${authEnabled && html`
        <${OverflowMenu}
          open=${menuOpen}
          onToggle=${onToggleMenu}
          onClose=${onCloseMenu}
          ariaLabel="Menu"
          title="Menu"
          menuRef=${menuRef}
        >
          <${OverflowMenuItem} onClick=${() => onLogout()}>
            Log out
          </${OverflowMenuItem}>
        </${OverflowMenu}>
      `}
      </span>
    </div>
    <div class="sidebar-tabs">
      <button
        class=${`sidebar-tab ${sidebarTab === "menu" ? "active" : ""}`}
        aria-label="Menu tab"
        title="Menu"
        onclick=${() => onSelectSidebarTab("menu")}
      >
        <${HomeLineIcon} className="sidebar-tab-icon" />
      </button>
      <button
        class=${`sidebar-tab ${sidebarTab === "browse" ? "active" : ""}`}
        aria-label="Browse tab"
        title="Browse"
        onclick=${() => onSelectSidebarTab("browse")}
      >
        <${FolderLineIcon} className="sidebar-tab-icon" />
      </button>
      <button
        class=${`sidebar-tab ${sidebarTab === "chat" ? "active" : ""}`}
        aria-label="Chat tab"
        title="Chat"
        onclick=${() => onSelectSidebarTab("chat")}
      >
        <${Chat4LineIcon} className="sidebar-tab-icon" />
      </button>
    </div>
    <div
      style=${{
        display: sidebarTab === "menu" ? "flex" : "none",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
      }}
    >
      ${setupSection
        ? html`
            <div class="sidebar-label">Menu</div>
            <nav class="sidebar-nav">
              ${setupSection.items.map((item) =>
                renderNavItem({
                  item,
                  selectedNavId,
                  onSelectNavItem,
                  onExternalNavClick,
                  claudeCode,
                }),
              )}
            </nav>
          `
        : null}
      <div class="sidebar-agents-header">
        <div class="sidebar-label sidebar-agents-label">Agents</div>
        <button
          type="button"
          class="sidebar-agents-add-button"
          onclick=${onAddAgent}
          title="Add agent"
          aria-label="Add agent"
        >
          <${AddLineIcon} className="sidebar-agents-add-icon" />
        </button>
      </div>
      <div class="sidebar-agents-list">
        ${agents.map(
          (agent) => {
            const identityEmoji = getAgentIdentityEmoji(agent);
            return html`
              <button
                key=${agent.id}
                class=${`sidebar-agent-item ${selectedAgentId === agent.id ? "active" : ""}`}
                onclick=${() => onSelectAgent(agent.id)}
              >
                ${identityEmoji
                  ? html`<span class="sidebar-agent-emoji" aria-hidden="true">${identityEmoji}</span>`
                  : html`<${RobotLineIcon} className="sidebar-agent-icon" />`}
                <span class="sidebar-agent-name">${agent.name || agent.id}</span>
              </button>
            `;
          },
        )}
      </div>
      ${remainingSections.map(
        (section) => html`
          <div class="sidebar-label">${section.label}</div>
          <nav class="sidebar-nav">
            ${section.items.map((item) =>
              renderNavItem({
                item,
                selectedNavId,
                onSelectNavItem,
                onExternalNavClick,
                claudeCode,
              }),
            )}
          </nav>
        `,
      )}
      <div class="sidebar-footer">
        ${acHasUpdate || acManagedUpdate?.blocked || acManagedUpdate?.error
          ? html`
              <${UpdateActionButton}
                onClick=${() => setUpdateModalOpen(true)}
                loading=${acUpdating}
                warning=${true}
                idleLabel=${acManagedUpdate?.blocked ? "Deployment status" : acManagedUpdate?.error ? "Update status unavailable" : "Update available"}
                loadingLabel="Updating..."
                className="w-full justify-center"
              />
            `
          : null}
      </div>
    </div>
    <div
      style=${{
        display: sidebarTab === "chat" ? "flex" : "none",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
      }}
    >
      <div class="sidebar-chat-header">
        <div class="sidebar-label sidebar-chat-label">Sessions</div>
      </div>
      ${chatSessions.length > 6
        ? html`<div class="sidebar-chat-search">
            <input
              type="search"
              class="sidebar-chat-search-input"
              placeholder="Filter sessions"
              aria-label="Filter sessions"
              value=${chatSessionQuery}
              oninput=${(event) => setChatSessionQuery(event.target.value)}
            />
          </div>`
        : null}
      <div class="sidebar-chat-sessions-list">
        ${chatSessions.length === 0
          ? html`<div class="sidebar-chat-empty">No sessions found</div>`
          : chatSessionGroups.map(
              (group) => html`
                <div key=${group.agentId} class="sidebar-chat-agent-group">
                  <div class="sidebar-chat-agent-header">
                    <button
                      type="button"
                      class="sidebar-chat-agent-toggle"
                      onclick=${() => toggleChatAgentCollapsed(group.agentId)}
                      aria-expanded=${!collapsedChatAgentIds.includes(
                        group.agentId,
                      )}
                    >
                      <span
                        class=${`sidebar-chat-agent-chevron ${collapsedChatAgentIds.includes(group.agentId) ? "is-collapsed" : ""}`}
                        aria-hidden="true"
                      >
                        <${ChevronDownIcon} className="sidebar-chat-agent-chevron-icon" />
                      </span>
                      <span class="sidebar-chat-agent-label">${group.agentLabel}</span>
                    </button>
                    <button
                      type="button"
                      class="sidebar-chat-new-session"
                      onclick=${() => onNewChatSession(group.agentId, group.agentLabel)}
                      title=${`New chat with ${group.agentLabel}`}
                      aria-label=${`New chat with ${group.agentLabel}`}
                    >
                      <${AddLineIcon} className="sidebar-chat-new-session-icon" />
                    </button>
                  </div>
                  ${collapsedChatAgentIds.includes(group.agentId)
                    ? null
                    : html`
                        <div class="sidebar-chat-agent-sessions">
                          ${group.sections.map((section) => {
                            if (section.rows.length === 0) return null;
                            const sectionKey = `${group.agentId}:${section.id}`;
                            const isFiltering = chatSessionQuery.trim() !== "";
                            const holdsSelection = section.rows.some(
                              (row) => row.key === selectedChatSessionKey,
                            );
                            const expanded =
                              !section.collapsible ||
                              isFiltering ||
                              holdsSelection ||
                              expandedChatSections.includes(sectionKey);
                            const showAll =
                              isFiltering || expandedChatSections.includes(`${sectionKey}:all`);
                            const visibleRows = !expanded
                              ? []
                              : showAll
                                ? section.rows
                                : section.rows.slice(0, kChatSectionVisibleRows);
                            const hiddenCount = section.rows.length - visibleRows.length;
                            return html`
                              ${section.collapsible
                                ? html`<button
                                    type="button"
                                    class="sidebar-chat-section-toggle"
                                    onclick=${() => toggleChatSection(sectionKey)}
                                    aria-expanded=${expanded}
                                  >
                                    <span
                                      class=${`sidebar-chat-agent-chevron ${expanded ? "" : "is-collapsed"}`}
                                      aria-hidden="true"
                                    >
                                      <${ChevronDownIcon} className="sidebar-chat-agent-chevron-icon" />
                                    </span>
                                    ${section.label} (${section.rows.length})
                                  </button>`
                                : null}
                              ${visibleRows.map((sessionRow) => renderChatSessionRow(sessionRow))}
                              ${expanded && hiddenCount > 0
                                ? html`<button
                                    type="button"
                                    class="sidebar-chat-show-more"
                                    onclick=${() => toggleChatSection(`${sectionKey}:all`)}
                                  >
                                    Show ${hiddenCount} more
                                  </button>`
                                : null}
                            `;
                          })}
                        </div>
                      `}
                </div>
              `,
            )}
      </div>
    </div>
    <div
      style=${{
        display: sidebarTab === "browse" ? "flex" : "none",
        flexDirection: "column",
        flex: "1 1 auto",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div class="sidebar-browse-layout" ref=${browseLayoutRef}>
        <div
          class="sidebar-browse-panel"
        >
          <${FileTree}
            onSelectFile=${onSelectBrowseFile}
            selectedPath=${selectedBrowsePath}
            onPreviewFile=${onPreviewBrowseFile}
            isActive=${sidebarTab === "browse"}
          />
        </div>
        <div
          class=${`sidebar-browse-resizer ${isResizingBrowsePanels ? "is-resizing" : ""}`}
          onpointerdown=${onBrowsePanelResizerPointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize browse and git panels"
        ></div>
        <div class="sidebar-browse-bottom">
          <div
            class="sidebar-browse-bottom-inner"
            ref=${browseBottomPanelRef}
            style=${{ height: `${browseBottomPanelHeightPx}px` }}
          >
          <${SidebarGitPanel}
            onSelectFile=${onSelectBrowseFile}
            isActive=${sidebarTab === "browse"}
          />
          </div>
        </div>
      </div>
    </div>
    <${UpdateModal}
      visible=${updateModalOpen}
      onClose=${() => {
        if (acUpdating) return;
        setUpdateModalOpen(false);
      }}
      currentVersion=${acVersion}
      currentOpenclawVersion=${acCurrentOpenclawVersion}
      version=${acLatest}
      latestOpenclawVersion=${acLatestOpenclawVersion}
      updateStrategy=${acUpdateStrategy}
      managedUpdate=${acManagedUpdate}
      onUpdate=${onAcUpdate}
      updating=${acUpdating}
    />
  </div>
`;
};
