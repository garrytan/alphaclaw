import { h, render } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { Router, useLocation } from "wouter-preact";
import { logout } from "./lib/api.js";
import { Welcome } from "./components/welcome/index.js";
import { ThemeToggle } from "./components/theme-toggle.js";
import { ToastContainer } from "./components/toast.js";
import { GlobalRestartBanner } from "./components/global-restart-banner.js";
import { Gateway } from "./components/gateway.js";
import { LoadingSpinner } from "./components/loading-spinner.js";
import { AppSidebar } from "./components/sidebar.js";
import { StatusChip } from "./components/status-chip.js";
import {
  AgentsRoute,
  BrowseRoute,
  ChannelsRoute,
  ChatRoute,
  CronRoute,
  DoctorRoute,
  EnvarsRoute,
  HomeRoute,
  IntegrationsRoute,
  ModelsRoute,
  NodesRoute,
  RelayRoute,
  RouteRedirect,
  TeamRoute,
  TelegramRoute,
  UsageRoute,
  WatchdogRoute,
  WebhooksRoute,
} from "./components/routes/index.js";
import { useAgents } from "./components/agents-tab/use-agents.js";
import { useAppShellController } from "./hooks/use-app-shell-controller.js";
import { useAppShellUi } from "./hooks/use-app-shell-ui.js";
import { useBrowseNavigation } from "./hooks/use-browse-navigation.js";
import { useAgentSessions } from "./hooks/useAgentSessions.js";
import { useOpenclawFeatures } from "./hooks/use-openclaw-features.js";
import { useClaudeCodeLauncher } from "./hooks/use-claude-code-launcher.js";
import { ClaudeCodeConfirmModal } from "./components/claude-code-confirm-modal.js";
import {
  buildNavSections,
  filterNavSectionsForRole,
} from "./lib/app-navigation.js";
import {
  getHashRouterPath,
  getHashRouterQuery,
  useHashLocation,
  useHashQuery,
} from "./hooks/use-hash-location.js";
import { readUiSettings, writeUiSettings } from "./lib/ui-settings.js";
import { resolveRoute } from "./lib/routes.js";
import { kCreateAgentEvent } from "./lib/ui-events.js";
import {
  classifySessionKey,
  getAgentIdFromSessionKey,
  getSessionRowKey,
  isReadOnlySessionKind,
} from "./lib/session-keys.js";
import { kAgentDetailTabIds } from "./components/agents-tab/agent-detail-model.js";
import { randomUuid } from "./lib/random-uuid.js";

const html = htm.bind(h);
const kDoctorWarningDismissedUntilUiSettingKey =
  "doctorWarningDismissedUntilMs";
const kOneWeekMs = 7 * 24 * 60 * 60 * 1000;
const kPendingCreateAgentWindowFlag = "__alphaclawPendingCreateAgent";

const App = () => {
  const [location, setLocation] = useLocation();
  // The router keeps the query out of `location` (route matching); browse deep
  // links (`?view=diff`, `?line=`) read it from here (fix wave F138).
  const hashQuery = useHashQuery();
  const [doctorWarningDismissedUntilMs, setDoctorWarningDismissedUntilMs] =
    useState(() => {
      const settings = readUiSettings();
      return Number(settings[kDoctorWarningDismissedUntilUiSettingKey] || 0);
    });

  const { state: controllerState, actions: controllerActions } =
    useAppShellController({
      location,
    });
  const {
    refs: shellRefs,
    state: shellState,
    actions: shellActions,
  } = useAppShellUi();
  const {
    state: browseState,
    actions: browseActions,
  } = useBrowseNavigation({
    location,
    hashQuery,
    setLocation,
    onCloseMobileSidebar: shellActions.closeMobileSidebar,
  });

  const {
    state: agentsState,
    actions: agentsActions,
  } = useAgents();

  // OpenClaw feature map (empty if the fetch fails): drives the gated
  // sidebar Dashboards link; with the feature map empty nothing changes.
  const { features: openclawFeatures } = useOpenclawFeatures({
    enabled: controllerState.onboarded === true,
  });

  // Sidebar Claude Code launcher (admin-only; members never see the item and
  // are 403'd server-side anyway). Closing the mobile drawer before the tab
  // opens mirrors handleSelectNavItem's behavior for internal items.
  const claudeCodeLauncher = useClaudeCodeLauncher({
    enabled:
      controllerState.onboarded === true &&
      controllerState.identityRole !== "member",
    onBeforeOpen: shellActions.closeMobileSidebar,
  });

  const {
    route: currentRoute,
    params: routeParams,
    redirectTo: routeRedirectTo,
  } = resolveRoute(
    getHashRouterQuery() ? `${location}?${getHashRouterQuery()}` : location,
  );
  const routeId = routeRedirectTo ? "" : currentRoute.id;
  const isPaneRoute = currentRoute?.shell === "pane" && !routeRedirectTo;
  const isAgentsRoute = routeId === "agents";
  const selectedAgentId =
    isAgentsRoute && routeParams.agentId
      ? decodeURIComponent(routeParams.agentId)
      : "";
  const agentDetailTab =
    isAgentsRoute && routeParams.agentId && kAgentDetailTabIds.includes(routeParams.tab)
      ? routeParams.tab
      : "overview";
  const selectedCronJobId =
    routeId === "schedules" && routeParams.jobId
      ? decodeURIComponent(routeParams.jobId)
      : "";
  const {
    sessions: chatSessions,
    selectedSessionKey: selectedChatSessionKey,
    setSelectedSessionKey: setSelectedChatSessionKey,
    refreshSessions: refreshChatSessions,
    addLocalSession: addLocalChatSession,
  } = useAgentSessions({
    enabled: controllerState.onboarded === true,
  });
  const deepLinkedChatSessionKey = (() => {
    if (routeId !== "chat" || !routeParams.sessionKey) return "";
    try {
      return decodeURIComponent(routeParams.sessionKey).trim();
    } catch {
      return "";
    }
  })();
  useEffect(() => {
    if (!/^agent:[^:]+:\S/.test(deepLinkedChatSessionKey)) return;
    const kind = classifySessionKey(deepLinkedChatSessionKey);
    addLocalChatSession({
      key: deepLinkedChatSessionKey,
      agentId: getAgentIdFromSessionKey(deepLinkedChatSessionKey),
      kind,
      readOnly: isReadOnlySessionKind(kind),
    });
    setSelectedChatSessionKey(deepLinkedChatSessionKey);
  }, [deepLinkedChatSessionKey]);
  const openChatSession = (sessionKey) => {
    setSelectedChatSessionKey(sessionKey);
    shellActions.closeMobileSidebar();
    setLocation(`/chat/${encodeURIComponent(sessionKey)}`);
  };
  const openNewChatSession = (agentId, agentLabel = "") => {
    const id = String(agentId || "main");
    const key = `agent:${id}:dashboard:${randomUuid()}`;
    addLocalChatSession({
      key,
      agentId: id,
      agentLabel,
      kind: "direct",
      label: "New chat",
      readOnly: false,
      isMain: false,
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    openChatSession(key);
  };
  const versionLine = (() => {
    const openclawVersion = String(
      controllerState.acCurrentOpenclawVersion || "",
    ).trim();
    const openclawLabel = openclawVersion ? `OpenClaw ${openclawVersion}` : "";
    const alphaclawVersion = String(controllerState.acVersion || "").trim();
    if (openclawLabel && alphaclawVersion) {
      return `${openclawLabel} / AlphaClaw ${alphaclawVersion}`;
    }
    if (openclawLabel) {
      return openclawLabel;
    }
    if (alphaclawVersion) {
      return `AlphaClaw ${alphaclawVersion}`;
    }
    return null;
  })();

  useEffect(() => {
    if (routeRedirectTo) return;
    document.title = currentRoute ? `${currentRoute.title} · AlphaClaw` : "AlphaClaw";
  }, [currentRoute, routeRedirectTo]);

  useEffect(() => {
    if (!isAgentsRoute) return;
    if (window[kPendingCreateAgentWindowFlag]) return;
    if (selectedAgentId) return;
    if (agentsState.loading || agentsState.agents.length === 0) return;
    // Auto-select is a redirect: replace, never push (fix wave F140).
    setLocation(`/agents/${encodeURIComponent(agentsState.agents[0].id)}`, { replace: true });
  }, [isAgentsRoute, selectedAgentId, agentsState.loading, agentsState.agents, setLocation]);

  useEffect(() => {
    if (!isAgentsRoute) return;
    if (!window[kPendingCreateAgentWindowFlag]) return;
    window[kPendingCreateAgentWindowFlag] = false;
    window.setTimeout(() => {
      window.dispatchEvent(new Event(kCreateAgentEvent));
    }, 0);
  }, [isAgentsRoute]);

  useEffect(() => {
    const settings = readUiSettings();
    settings[kDoctorWarningDismissedUntilUiSettingKey] =
      doctorWarningDismissedUntilMs;
    writeUiSettings(settings);
  }, [doctorWarningDismissedUntilMs]);

  const handleSidebarLogout = async () => {
    shellActions.setMenuOpen(false);
    // A failed POST (network drop, proxy HTML error) used to close the menu and
    // silently do nothing (fix wave F144): say so and keep the session state.
    try {
      const result = await logout();
      if (result && result.ok === false) {
        throw new Error(result.error || "Logout failed");
      }
    } catch (error) {
      showToast(`Could not log out: ${error?.message || "request failed"}`, "error");
      return;
    }
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {}
    window.location.href = "/login.html";
  };

  if (controllerState.onboarded === null) {
    return html`
      <div
        class="min-h-screen flex flex-col items-center justify-center gap-4 px-4"
        style="position: relative; z-index: 1"
      >
        <${LoadingSpinner}
          className="h-6 w-6"
          style="color: var(--text-muted)"
        />
        <div class="w-full max-w-2xl"><${Gateway} /></div>
      </div>
      <${ToastContainer} />
    `;
  }

  if (!controllerState.onboarded) {
    return html`
      <div
        class="min-h-screen flex flex-col items-center pt-12 pb-8 px-4"
        style="position: relative; z-index: 1"
      >
        <div style="position: fixed; top: 16px; right: 16px; z-index: 50;">
          <${ThemeToggle} />
        </div>
        <div class="w-full max-w-2xl mb-6"><${Gateway} setupRequired=${true} /></div>
        <div id="gateway-setup" tabIndex="-1" class="w-full max-w-lg">
          <${Welcome}
            onComplete=${controllerActions.handleOnboardingComplete}
            acVersion=${controllerState.acVersion}
          />
        </div>
      </div>
      <${ToastContainer} />
    `;
  }

  const openCreateAgent = () => {
    if (isAgentsRoute) {
      window.dispatchEvent(new Event(kCreateAgentEvent));
      return;
    }
    window[kPendingCreateAgentWindowFlag] = true;
    setLocation("/agents");
  };

  const decodeOptionalParam = (value) =>
    value === undefined ? undefined : decodeURIComponent(value);

  const renderColumnRoute = () => {
    if (routeRedirectTo) {
      return html`<${RouteRedirect} to=${routeRedirectTo} />`;
    }
    switch (routeId) {
      case "home":
        return html`
          <${HomeRoute}
            statusData=${controllerState.sharedStatus}
            watchdogData=${controllerState.sharedWatchdogStatus}
            doctorStatusData=${controllerState.sharedDoctorStatus}
            agents=${agentsState.agents}
            doctorWarningDismissedUntilMs=${doctorWarningDismissedUntilMs}
            onRefreshStatuses=${controllerActions.refreshSharedStatuses}
            onSetLocation=${setLocation}
            onAddAgent=${openCreateAgent}
            restartSignal=${controllerState.gatewayRestartSignal}
            onDismissDoctorWarning=${() =>
              setDoctorWarningDismissedUntilMs(Date.now() + kOneWeekMs)}
            update=${{
              hasUpdate: controllerState.acHasUpdate,
              version: controllerState.acVersion,
              currentOpenclawVersion: controllerState.acCurrentOpenclawVersion,
              latest: controllerState.acLatest,
              latestOpenclawVersion: controllerState.acLatestOpenclawVersion,
              strategy: controllerState.acUpdateStrategy,
              managed: controllerState.acManagedUpdate,
              updating: controllerState.acUpdating,
              onUpdate: controllerActions.handleAcUpdate,
            }}
          />
        `;
      case "channels":
        return html`
          <${ChannelsRoute}
            statusData=${controllerState.sharedStatus}
            watchdogData=${controllerState.sharedWatchdogStatus}
            doctorStatusData=${controllerState.sharedDoctorStatus}
            agents=${agentsState.agents}
            onRefreshStatuses=${controllerActions.refreshSharedStatuses}
            onNavigate=${browseActions.navigateToSubScreen}
            onRestartGateway=${controllerActions.handleGatewayRestart}
            restartSignal=${controllerState.gatewayRestartSignal}
          />
        `;
      case "integrations":
        return html`
          <${IntegrationsRoute}
            statusData=${controllerState.sharedStatus}
            watchdogData=${controllerState.sharedWatchdogStatus}
            doctorStatusData=${controllerState.sharedDoctorStatus}
            onRefreshStatuses=${controllerActions.refreshSharedStatuses}
            onSetLocation=${setLocation}
            onRestartRequired=${controllerActions.setRestartRequired}
            restartSignal=${controllerState.gatewayRestartSignal}
          />
        `;
      case "doctor":
        return html`<${DoctorRoute} onNavigateToBrowseFile=${browseActions.navigateToBrowseFile} />`;
      case "telegram":
        return html`
          <${TelegramRoute}
            accountId=${decodeURIComponent(routeParams.accountId || "default")}
            onBack=${browseActions.exitSubScreen}
          />
        `;
      case "health":
        return html`
          <${WatchdogRoute}
            statusData=${controllerState.sharedStatus}
            watchdogStatus=${controllerState.sharedWatchdogStatus}
            onRefreshStatuses=${controllerActions.refreshSharedStatuses}
            restartingGateway=${controllerState.restartingGateway}
            onRestartGateway=${controllerActions.handleGatewayRestart}
            restartSignal=${controllerState.gatewayRestartSignal}
          />
        `;
      case "team":
        return html`
          <${TeamRoute} onRefreshStatuses=${controllerActions.refreshSharedStatuses} />
        `;
      case "usage":
        return html`
          <${UsageRoute}
            sessionId=${decodeOptionalParam(routeParams.sessionId)}
            onSetLocation=${setLocation}
          />
        `;
      case "relay":
        return html`<${RelayRoute} />`;
      case "webhooks":
        return html`
          <${WebhooksRoute}
            hookName=${decodeOptionalParam(routeParams.hookName)}
            routeHistoryRef=${browseState.routeHistoryRef}
            getCurrentPath=${getHashRouterPath}
            onSetLocation=${setLocation}
            onRestartRequired=${controllerActions.setRestartRequired}
            onNavigateToBrowseFile=${browseActions.navigateToBrowseFile}
          />
        `;
      default:
        return null;
    }
  };

  return html`
    <div
      class="app-shell"
      ref=${shellRefs.appShellRef}
      style=${{ "--sidebar-width": `${shellState.sidebarWidthPx}px` }}
    >
      <a
        class="skip-link"
        href="#main-content"
        onclick=${(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <${GlobalRestartBanner}
        visible=${controllerState.isAnyRestartRequired}
        restarting=${controllerState.restartingGateway}
        onRestart=${controllerActions.handleGatewayRestart}
        onDismiss=${controllerActions.dismissRestartBanner}
      />
      <${ClaudeCodeConfirmModal}
        visible=${claudeCodeLauncher.confirmOpen}
        mode=${claudeCodeLauncher.confirmMode}
        permissionMode=${claudeCodeLauncher.confirmPermissionMode}
        onStart=${claudeCodeLauncher.confirmStart}
        onCancel=${claudeCodeLauncher.confirmCancel}
      />
      <${AppSidebar}
        mobileSidebarOpen=${shellState.mobileSidebarOpen}
        authEnabled=${controllerState.authEnabled}
        menuRef=${shellRefs.menuRef}
        menuOpen=${shellState.menuOpen}
        onToggleMenu=${shellActions.onToggleMenu}
        onCloseMenu=${shellActions.onCloseMenu}
        onLogout=${handleSidebarLogout}
        versionLine=${versionLine}
        showAgents=${controllerState.identityRole !== "member"}
        statusLinksToHealth=${controllerState.identityRole !== "member"}
        sidebarTab=${browseState.sidebarTab}
        onSelectSidebarTab=${browseActions.handleSelectSidebarTab}
        navSections=${filterNavSectionsForRole(
          buildNavSections({ features: openclawFeatures }),
          controllerState.identityRole,
        )}
        selectedNavId=${browseState.selectedNavId}
        onSelectNavItem=${browseActions.handleSelectNavItem}
        onExternalNavClick=${shellActions.closeMobileSidebar}
        claudeCode=${{
          configured: claudeCodeLauncher.configured,
          tooltip: claudeCodeLauncher.tooltip,
          liveDot: claudeCodeLauncher.liveDot,
          liveDotTitle: claudeCodeLauncher.liveDotTitle,
          launching: claudeCodeLauncher.launching,
          onOpen: claudeCodeLauncher.openClaudeCode,
        }}
        selectedBrowsePath=${browseState.selectedBrowsePath}
        onSelectBrowseFile=${browseActions.navigateToBrowseFile}
        onPreviewBrowseFile=${browseActions.handleBrowsePreviewFile}
        acHasUpdate=${controllerState.acHasUpdate}
        acVersion=${controllerState.acVersion}
        acCurrentOpenclawVersion=${controllerState.acCurrentOpenclawVersion}
        acLatest=${controllerState.acLatest}
        acLatestOpenclawVersion=${controllerState.acLatestOpenclawVersion}
        acUpdateStrategy=${controllerState.acUpdateStrategy}
        acManagedUpdate=${controllerState.acManagedUpdate}
        acUpdating=${controllerState.acUpdating}
        onAcUpdate=${controllerActions.handleAcUpdate}
        agents=${agentsState.agents}
        selectedAgentId=${selectedAgentId}
        onSelectAgent=${(agentId) => setLocation(`/agents/${encodeURIComponent(agentId)}`)}
        onAddAgent=${openCreateAgent}
        chatSessions=${chatSessions}
        selectedChatSessionKey=${selectedChatSessionKey}
        onSelectChatSession=${openChatSession}
        onNewChatSession=${openNewChatSession}
      />
      <div
        class=${`sidebar-resizer ${shellState.isResizingSidebar ? "is-resizing" : ""}`}
        onpointerdown=${shellActions.onSidebarResizerPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      ></div>

      <div
        class=${`mobile-sidebar-overlay ${shellState.mobileSidebarOpen ? "active" : ""}`}
        onclick=${shellActions.closeMobileSidebar}
      />

      <main class="app-content" id="main-content" tabindex="-1">
        <div
          class=${`mobile-topbar ${shellState.mobileTopbarScrolled ? "is-scrolled" : ""}`}
        >
          <button
            class="mobile-topbar-menu"
            onclick=${() =>
              shellActions.setMobileSidebarOpen((open) => !open)}
            aria-label="Open menu"
            aria-expanded=${shellState.mobileSidebarOpen ? "true" : "false"}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path
                d="M2 3.75a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 8zm0 4.25a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z"
              />
            </svg>
          </button>
          <span class="mobile-topbar-title ac-wordmark">
            <span style="color: var(--accent)">alpha</span>claw
          </span>
          <${StatusChip}
            className="mobile-topbar-chip"
            linkToHealth=${controllerState.identityRole !== "member"}
          />
        </div>
        ${routeId === "browse"
          ? html`
              <div class="app-content-pane browse-pane">
                <h1 class="sr-only">Browse</h1>
                <${BrowseRoute}
                  activeBrowsePath=${browseState.activeBrowsePath}
                  browseView=${browseState.browseViewerMode}
                  lineTarget=${browseState.browseLineTarget}
                  lineEndTarget=${browseState.browseLineEndTarget}
                  selectedBrowsePath=${browseState.selectedBrowsePath}
                  onNavigateToBrowseFile=${browseActions.navigateToBrowseFile}
                  onEditSelectedBrowseFile=${() =>
                    setLocation(
                      browseActions.buildBrowseRoute(browseState.selectedBrowsePath, {
                        view: "edit",
                      }),
                    )}
                  onClearSelection=${() => {
                    browseActions.clearBrowsePreview();
                    setLocation("/browse");
                  }}
                />
              </div>
            `
          : null}
        ${isAgentsRoute
          ? html`
              <div class="app-content-pane agents-pane">
                <${AgentsRoute}
                  agents=${agentsState.agents}
                  loading=${agentsState.loading}
                  saving=${agentsState.saving}
                  agentsActions=${agentsActions}
                  selectedAgentId=${selectedAgentId}
                  activeTab=${agentDetailTab}
                  onSelectAgent=${(agentId) =>
                    setLocation(`/agents/${encodeURIComponent(agentId)}`)}
                  onSelectTab=${(tab) => {
                    const safePath = tab && tab !== "overview"
                      ? `/agents/${encodeURIComponent(selectedAgentId)}/${tab}`
                      : `/agents/${encodeURIComponent(selectedAgentId)}`;
                    setLocation(safePath);
                  }}
                  onNavigateToBrowseFile=${browseActions.navigateToBrowseFile}
                  onSetLocation=${setLocation}
                  sessions=${chatSessions}
                  onOpenChat=${(agent) => {
                    const mainKey = `agent:${agent.id}:main`;
                    if (chatSessions.some((row) => getSessionRowKey(row) === mainKey)) openChatSession(mainKey);
                    else openNewChatSession(agent.id, agent.name || agent.id);
                  }}
                />
              </div>
            `
          : null}
        ${routeId === "chat"
          ? html`
              <div class="app-content-pane chat-pane">
                <h1 class="sr-only">Chat</h1>
                <${ChatRoute}
                  sessions=${chatSessions}
                  selectedSessionKey=${selectedChatSessionKey}
                  onRunStarted=${refreshChatSessions}
                  onSessionsChanged=${refreshChatSessions}
                />
              </div>
            `
          : null}
        ${routeId === "schedules"
          ? html`
              <div class="app-content-pane ac-fixed-header-pane">
                <${CronRoute}
                  jobId=${selectedCronJobId}
                  agents=${agentsState.agents}
                  onSetLocation=${setLocation}
                />
              </div>
            `
          : null}
        ${routeId === "environment"
          ? html`
              <div class="app-content-pane ac-fixed-header-pane">
                <${EnvarsRoute}
                  onRestartRequired=${controllerActions.setRestartRequired}
                />
              </div>
            `
          : null}
        ${routeId === "models"
          ? html`
              <div class="app-content-pane ac-fixed-header-pane">
                <${ModelsRoute}
                  onRestartRequired=${controllerActions.setRestartRequired}
                  agents=${agentsState.agents}
                />
              </div>
            `
          : null}
        ${routeId === "nodes"
          ? html`
              <div class="app-content-pane">
                <${NodesRoute}
                  onRestartRequired=${controllerActions.setRestartRequired}
                />
              </div>
            `
          : null}
        ${isPaneRoute
          ? null
          : html`
              <div
                class="app-content-pane"
                onscroll=${shellActions.handlePaneScroll}
              >
          <div class=${currentRoute?.layout === "console" || currentRoute?.wide ? "max-w-content w-full" : "max-w-2xl w-full mx-auto"}>
            ${renderColumnRoute()}
          </div>
              </div>
            `}
        <${ToastContainer}
          className="fixed top-4 right-4 z-[60] space-y-2 pointer-events-none"
        />
      </main>
    </div>
  `;
};

const rootElement = document.getElementById("app");
if (rootElement) {
  const appBootCounter = "__alphaclawSetupAppBootCount";
  window[appBootCounter] = Number(window[appBootCounter] || 0) + 1;
  // Defensive: clear root so duplicate bootstraps cannot stack full app shells.
  render(null, rootElement);
  rootElement.replaceChildren();
  render(
    html`
      <${Router} hook=${useHashLocation}>
        <${App} />
      </${Router}>
    `,
    rootElement,
  );
}
