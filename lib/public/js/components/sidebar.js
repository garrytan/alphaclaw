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
  FolderLineIcon,
  HashtagIcon,
  HomeLineIcon,
  HospitalLineIcon,
  PulseLineIcon,
  RobotLineIcon,
  SignalTowerLineIcon,
  ChatVoiceLineIcon,
  TeamLineIcon,
  TerminalFillIcon,
  Database2LineIcon,
} from "./icons.js";
import { Badge } from "./badge.js";
import { StatusChip } from "./status-chip.js";
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
  getChatSidebarSection,
  getSessionChannelForIcon,
  getSessionRowKey,
  getSessionRowKind,
  getSessionSourceChannel,
  isReadOnlySession,
  parseRelaySessionKey,
} from "../lib/session-keys.js";
import { formatRelativeTime } from "../lib/format.js";
import { useNowMs } from "../hooks/use-now-ms.js";
import { sanitizeAgentEmoji } from "../lib/agent-identity.js";
import { kThemeOptions, useThemePreference } from "./theme-toggle.js";

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
const kChatChannelLabelById = Object.fromEntries(
  kChannelRegistry.map((entry) => [entry.id, entry.label]),
);
const kChatSectionVisibleRows = 30;
const kChatSections = [
  { id: "chats", label: "", collapsible: false },
  { id: "relays", label: "Relays", collapsible: true },
  { id: "channels", label: "Channels", collapsible: true },
  { id: "cron", label: "Scheduled", collapsible: true },
  { id: "other", label: "Other", collapsible: true },
];
const readChatSidebarCollapsedAgentIds = () => {
  const raw = readUiSettings()[kChatSidebarCollapsedAgentIdsKey];
  return Array.isArray(raw) ? raw : [];
};
const kSidebarNavIconsById = {
  home: HomeLineIcon,
  chat: Chat4LineIcon,
  health: PulseLineIcon,
  doctor: HospitalLineIcon,
  schedules: AlarmLineIcon,
  usage: BarChartLineIcon,
  channels: HashtagIcon,
  integrations: Database2LineIcon,
  models: Brain2LineIcon,
  environment: BracesLineIcon,
  webhooks: SignalTowerLineIcon,
  relay: ChatVoiceLineIcon,
  nodes: ComputerLineIcon,
  team: TeamLineIcon,
  upgrade: DownloadLineIcon,
  dashboards: DashboardLineIcon,
  "claude-code": TerminalFillIcon,
};

const kFooterLinks = [
  { label: "Docs", href: "https://docs.openclaw.ai" },
  { label: "Discord", href: "https://discord.com/invite/clawd" },
  { label: "GitHub", href: "https://github.com/openclaw/openclaw" },
];

// A plain click routes inside the app; a modifier click keeps the link's
// native behaviour (open in a new tab).
const isPlainClick = (event) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

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
  const active = selectedNavId === item.id;
  return html`
    <a
      href=${`#${item.path}`}
      class=${active ? "active" : ""}
      aria-current=${active ? "page" : undefined}
      data-nav-id=${item.id}
      onclick=${(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onSelectNavItem(item);
      }}
    >
      ${NavIcon ? html`<${NavIcon} className="sidebar-nav-icon" />` : null}
      <span>${item.label}</span>
    </a>
  `;
};

const getAgentIdentityEmoji = (agent) => sanitizeAgentEmoji(agent?.identity?.emoji);

export const AppSidebar = ({
  statusLinksToHealth = true,
  mobileSidebarOpen = false,
  authEnabled = false,
  menuRef = null,
  menuOpen = false,
  onToggleMenu = () => {},
  onCloseMenu = () => {},
  onLogout = () => {},
  versionLine = null,
  showAgents = true,
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
  const [themePreference, selectThemePreference] = useThemePreference();
  const [collapsedChatAgentIds, setCollapsedChatAgentIds] = useState(() =>
    readChatSidebarCollapsedAgentIds(),
  );

  const [chatSessionQuery, setChatSessionQuery] = useState("");
  const [expandedChatSections, setExpandedChatSections] = useState([]);
  const chatSessionsListRef = useRef(null);
  const revealedChatSessionKeyRef = useRef("");
  const [chatScrollTargetKey, setChatScrollTargetKey] = useState("");
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
        rows: group.sessions.filter((row) => getChatSidebarSection(row) === section.id),
      }));
    }
    groups.sort((a, b) => {
      if (a.agentId === "main" && b.agentId !== "main") return -1;
      if (b.agentId === "main" && a.agentId !== "main") return 1;
      return a.agentLabel.localeCompare(b.agentLabel);
    });
    return groups;
  }, [chatSessions, chatSessionQuery]);

  const renderChatSessionRow = (sessionRow, sectionId) => {
    const displayLabel = getChatSessionLabel(sessionRow);
    const isRelayRow = sectionId === "relays";
    const relayPeer = isRelayRow
      ? parseRelaySessionKey(getSessionRowKey(sessionRow))?.peer || ""
      : "";
    const rowLabel = relayPeer ? `@${relayPeer}` : displayLabel;
    const sourceChannel =
      sectionId === "channels" ? getSessionSourceChannel(sessionRow) : "";
    const sourceLabel = sourceChannel
      ? kChatChannelLabelById[sourceChannel] || sourceChannel
      : "";
    const readOnly = isReadOnlySession(sessionRow);
    const isActive = selectedChatSessionKey === sessionRow.key;
    const activityMs = Number(
      sessionRow.lastActivityAt || sessionRow.updatedAt || 0,
    );
    const channelIcon =
      kChatChannelIconById[
        String(
          getSessionChannelForIcon(sessionRow) || "",
        ).toLowerCase()
      ] || null;
    const statusLabel = sessionRow.running ? "Running" : "Idle";
    return html`
      <button
        type="button"
        key=${sessionRow.key}
        class=${`sidebar-chat-session-item ${isActive ? "active" : ""}`}
        onclick=${() =>
          onSelectChatSession(sessionRow.key)}
        title=${readOnly ? `${rowLabel} (read-only here)` : rowLabel}
        aria-current=${isActive ? "true" : undefined}
        data-session-kind=${getSessionRowKind(sessionRow)}
        data-session-key=${sessionRow.key}
      >
        ${channelIcon
          ? html`<${channelIcon}
              className="sidebar-chat-session-channel-icon"
            />`
          : null}
        <span class="sidebar-chat-session-name"
          >${rowLabel}</span
        >
        ${isRelayRow
          ? html`<span
              class=${`sidebar-chat-status-dot ${sessionRow.running ? "is-running" : "is-idle"}`}
              role="img"
              aria-label=${statusLabel}
              title=${statusLabel}
            ></span>`
          : sessionRow.running
            ? html`<span
                class="sidebar-chat-session-running"
                title="Running"
                aria-label="Running"
              ></span>`
            : null}
        ${sourceLabel
          ? html`<span class="sidebar-chat-session-badge">${sourceLabel}</span>`
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

  // Selecting a session (a sidebar click, a #/chat/<key> deep link, a
  // reload) reveals it: its agent group and section open, every row of a
  // long section shows, and the list scrolls it into view. A reveal holds
  // for the row's place (agent, section, inside or past the first rows), so
  // a deep link revealed on app.js's lone placeholder row is revealed again
  // once the real list puts the row somewhere else. The operator can
  // collapse the section again afterwards.
  useEffect(() => {
    const key = String(selectedChatSessionKey || "");
    if (!key) return;
    for (const group of chatSessionGroups) {
      for (const section of group.sections) {
        const index = section.rows.findIndex((row) => row.key === key);
        if (index < 0) continue;
        const place = [
          key,
          group.agentId,
          section.id,
          index >= kChatSectionVisibleRows ? "all" : "top",
        ].join("\n");
        if (revealedChatSessionKeyRef.current === place) return;
        revealedChatSessionKeyRef.current = place;
        if (collapsedChatAgentIds.includes(group.agentId)) {
          toggleChatAgentCollapsed(group.agentId);
        }
        const sectionKey = `${group.agentId}:${section.id}`;
        const wanted = [
          ...(section.collapsible ? [sectionKey] : []),
          ...(index >= kChatSectionVisibleRows ? [`${sectionKey}:all`] : []),
        ];
        setExpandedChatSections((previous) => {
          const additions = wanted.filter((entry) => !previous.includes(entry));
          return additions.length ? [...previous, ...additions] : previous;
        });
        setChatScrollTargetKey(key);
        return;
      }
    }
  }, [selectedChatSessionKey, chatSessionGroups]);

  // One scroll attempt per reveal once the chat tab shows: the target is
  // cleared whether or not the row could be scrolled to, so a later section
  // toggle never jumps the list.
  useEffect(() => {
    if (!chatScrollTargetKey || sidebarTab !== "chat") return;
    setChatScrollTargetKey("");
    const list = chatSessionsListRef.current;
    if (!list) return;
    const target = Array.from(list.querySelectorAll("[data-session-key]")).find(
      (node) => node.getAttribute("data-session-key") === chatScrollTargetKey,
    );
    if (!target) return;
    const listRect = list.getBoundingClientRect();
    if (listRect.height <= 0) return;
    const targetRect = target.getBoundingClientRect();
    if (targetRect.top < listRect.top || targetRect.bottom > listRect.bottom) {
      list.scrollTop +=
        targetRect.top - listRect.top - (listRect.height - targetRect.height) / 2;
    }
  }, [chatScrollTargetKey, sidebarTab]);

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

  const renderNavGroup = (section) => html`
    <div class="sidebar-group" key=${section.id}>
      ${section.label ? html`<div class="sidebar-label">${section.label}</div>` : null}
      <div class="sidebar-nav">
        ${section.items.map((item) =>
          renderNavItem({
            item,
            selectedNavId,
            onSelectNavItem,
            onExternalNavClick,
            claudeCode,
          }),
        )}
      </div>
    </div>
  `;

  const renderAgentsGroup = () => html`
    <div class="sidebar-group">
      <div class="sidebar-label">Agents</div>
      <div class="sidebar-nav">
        ${agents.map((agent) => {
          const identityEmoji = getAgentIdentityEmoji(agent);
          const active = selectedAgentId === agent.id;
          return html`
            <a
              key=${agent.id}
              href=${`#/agents/${encodeURIComponent(agent.id)}`}
              class=${`sidebar-agent-item ${active ? "active" : ""}`}
              aria-current=${active ? "page" : undefined}
              onclick=${(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onSelectAgent(agent.id);
              }}
            >
              ${identityEmoji
                ? html`<span class="sidebar-agent-emoji" aria-hidden="true">${identityEmoji}</span>`
                : html`<${RobotLineIcon} className="sidebar-nav-icon" />`}
              <span class="sidebar-agent-name">${agent.name || agent.id}</span>
              ${agent.default ? html`<${Badge} tone="neutral">Default</${Badge}>` : null}
            </a>
          `;
        })}
        <button type="button" class="sidebar-agent-add" onclick=${onAddAgent}>
          <${AddLineIcon} className="sidebar-nav-icon" />
          <span>Add agent</span>
        </button>
      </div>
    </div>
  `;

  const startSection = navSections.find((section) => section.id === "start") || null;
  const otherSections = navSections.filter((section) => section.id !== "start");

  return html`
    <div class=${`app-sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}>
    <div class="sidebar-brand">
      <span
        class="ac-logo-mark"
        style="--ac-logo-width: 20px; --ac-logo-height: 20px;"
        aria-hidden="true"
      ></span>
      <span class="ac-wordmark"><span style="color: var(--accent)">alpha</span>claw</span>
    </div>
    <div class="sidebar-status">
      <${StatusChip} linkToHealth=${statusLinksToHealth} onClick=${() => onExternalNavClick()} />
    </div>
    <div class="sidebar-tabs">
      <button
        type="button"
        class=${`sidebar-tab ${sidebarTab === "menu" ? "active" : ""}`}
        aria-label="Menu tab"
        title="Menu"
        onclick=${() => onSelectSidebarTab("menu")}
      >
        <${HomeLineIcon} className="sidebar-tab-icon" />
      </button>
      <button
        type="button"
        class=${`sidebar-tab ${sidebarTab === "browse" ? "active" : ""}`}
        aria-label="Browse tab"
        title="Browse"
        onclick=${() => onSelectSidebarTab("browse")}
      >
        <${FolderLineIcon} className="sidebar-tab-icon" />
      </button>
      <button
        type="button"
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
        overflowY: "auto",
      }}
    >
      <nav class="sidebar-main-nav" aria-label="Main">
        ${startSection ? renderNavGroup(startSection) : null}
        ${showAgents ? renderAgentsGroup() : null}
        ${otherSections.map(renderNavGroup)}
      </nav>
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
      <div class="sidebar-chat-sessions-list" ref=${chatSessionsListRef}>
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
                            const expanded =
                              !section.collapsible ||
                              isFiltering ||
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
                              ${visibleRows.map((sessionRow) => renderChatSessionRow(sessionRow, section.id))}
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
    <div class="sidebar-foot">
      <span class="sidebar-version" title=${versionLine || undefined}>
        ${String(versionLine || "")
          .split(" / ")
          .reverse()
          .map((part) => html`<span class="sidebar-version-line">${part}</span>`)}
      </span>
      <${OverflowMenu}
        open=${menuOpen}
        onToggle=${onToggleMenu}
        onClose=${onCloseMenu}
        ariaLabel="More"
        title="Links, theme and log out"
        menuRef=${menuRef}
      >
        ${kFooterLinks.map(
          (link) => html`
            <a class="brand-dropdown-item" href=${link.href} target="_blank" rel="noreferrer">
              ${link.label}
            </a>
          `,
        )}
        <div class="brand-dropdown-divider" role="separator"></div>
        ${kThemeOptions.map(
          (option) => html`
            <${OverflowMenuItem}
              className=${themePreference === option.id ? "is-selected" : ""}
              icon=${option.Icon}
              onClick=${() => selectThemePreference(option.id)}
            >
              ${option.label} theme
            </${OverflowMenuItem}>
          `,
        )}
        ${authEnabled
          ? html`
              <div class="brand-dropdown-divider" role="separator"></div>
              <${OverflowMenuItem} onClick=${() => onLogout()}>Log out</${OverflowMenuItem}>
            `
          : null}
      </${OverflowMenu}>
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
