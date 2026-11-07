import { h } from "preact";
import htm from "htm";
import { useState } from "preact/hooks";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { DevicePairings } from "../device-pairings.js";
import { UpdateModal } from "../update-modal.js";
import { UpgradeAlert } from "../upgrade-alert/index.js";
import { deriveStatusChip } from "../status-chip.js";
import { useGatewayShell } from "../restart-progress-card.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { useVisibleInterval } from "../../hooks/use-visible-interval.js";
import {
  fetchChannelAccounts,
  fetchCronJobs,
  fetchOpenclawCapabilities,
  fetchRelayStatus,
  fetchUpgradeStatus,
  fetchUsageSummary,
  fetchWatchdogIncidents,
} from "../../lib/api.js";
import { formatLocaleTime } from "../../lib/format.js";
import { getDoctorWarningMessage, shouldShowDoctorWarning } from "../doctor/helpers.js";
import { kUpgradeStatusKey } from "../upgrade-alert/model.js";
import { getOpenclawPinWarning } from "../general/openclaw-pin-warning.js";
import { buildHardeningCardModel, HardeningSignalRow } from "../general/hardening-card.js";
import { getHardeningBadgeModel } from "../general/hardening-badge.js";
import { useGeneralTab } from "../general/use-general-tab.js";
import { WhatsNextCard } from "../general/whats-next-card.js";
import { BackupsCard } from "../general/backups-card.js";
import { SyncSettings } from "../general/sync-status.js";
import {
  buildAgentRows,
  buildChannelRows,
  buildComingUp,
  buildHomeHeadline,
  buildRelayRow,
  buildStripCells,
  kHomeIncidentLimit,
  orderAttentionItems,
  summarizeRecentIncidents,
} from "./model.js";

const html = htm.bind(h);

// The reads Home adds to General's (status stream, capabilities, pairings,
// devices, channel accounts, upgrade status, backups, Google accounts): the
// incidents, usage, cron and relay reads its cards show. The fetched-URL set
// is held by tests/frontend/home-tab.test.js.
export const kHomeReadKeys = {
  incidents: "/api/watchdog/incidents?limit=" + kHomeIncidentLimit,
  usage: "/api/usage/summary?days=30",
  cron: "/api/cron/jobs?sortBy=nextRunAtMs&sortDir=asc",
  relay: "/api/relay/status",
  channelAccounts: "/api/channels/accounts",
  capabilities: "/api/openclaw/capabilities",
};

// The strip, Coming up and Relay reads refresh about once a minute; a read
// that failed retries on the same tick.
export const kHomeRefreshMs = 60_000;
const kGlyphWord = { warn: "Warning", bad: "Problem" };
const kRowDot = { ok: "running", bad: "down", warn: "degraded" };

const StatusDot = ({ state }) =>
  html`<span class=${"status-chip-dot status-chip-dot--" + state} aria-hidden="true"></span>`;

export const StatusStrip = ({ cells = [] }) => html`
  <ul class="home-strip" aria-label="Box status">
    ${cells.map(
      (cell) => html`
        <li
          key=${cell.key}
          class="home-strip-cell"
          data-cell=${cell.key}
          data-state=${cell.loading ? "loading" : cell.error ? "error" : "loaded"}
        >
          <a href=${cell.href} class="home-strip-link">
            <span class="home-strip-label">${cell.label}</span>
            <span class="home-strip-value">
              ${cell.dot ? html`<${StatusDot} state=${cell.dot} />` : null}
              <span>${cell.value}</span>
            </span>
            <span class="home-strip-detail">
              ${cell.error ? html`<${StatusDot} state="degraded" />` : null}
              <span>${cell.detail || " "}</span>
            </span>
          </a>
        </li>
      `,
    )}
  </ul>
`;

const HomeCard = ({ title, href = "", actions = null, children }) => html`
  <section class="home-card">
    <div class="home-card-head">
      <h2 class="home-card-title">
        ${href ? html`<a href=${href} class="home-card-link">${title}</a>` : title}
      </h2>
      ${actions}
    </div>
    ${children}
  </section>
`;

// Numbered rows (Home C): the warn or bad glyph plus its word, the title,
// one line of detail and the row's existing action. Only row 1's action is
// solid; renderBody gets { solid } for rows whose actions live in a reused
// component (the upgrade alert, device approvals).
export const AttentionCard = ({ items = [] }) => {
  if (items.length === 0) return null;
  return html`
    <${HomeCard} title="Attention">
      <ol class="home-attention">
        ${items.map(
          (item, index) => html`
            <li key=${item.key} class="home-attention-row" data-attention=${item.key}>
              <span class="home-attention-num" aria-hidden="true">${index + 1}</span>
              <div class="home-attention-main">
                <p class="home-attention-title">
                  <span class=${"home-attention-tone home-attention-tone--" + item.tone}>
                    <${StatusDot} state=${item.tone === "bad" ? "down" : "degraded"} />
                    ${kGlyphWord[item.tone] || kGlyphWord.warn}
                  </span>
                  <span>${item.title}</span>
                </p>
                ${item.detail ? html`<p class="home-attention-detail">${item.detail}</p>` : null}
                ${item.renderBody ? item.renderBody({ solid: index === 0 }) : null}
              </div>
              ${item.action
                ? html`<div class="home-attention-actions">
                    <${ActionButton}
                      onClick=${item.action.onClick}
                      tone=${index === 0 ? "solid" : "secondary"}
                      idleLabel=${item.action.label}
                    />
                    ${item.secondaryAction
                      ? html`<${ActionButton}
                          onClick=${item.secondaryAction.onClick}
                          tone="ghost"
                          idleLabel=${item.secondaryAction.label}
                        />`
                      : null}
                  </div>`
                : null}
            </li>
          `,
        )}
      </ol>
    </${HomeCard}>
  `;
};

export const ComingUpCard = ({ rows = [], loading = false, error = null }) => html`
  <${HomeCard}
    title="Coming up"
    href="#/schedules"
    actions=${html`<a href="#/schedules" class="home-card-more">All schedules</a>`}
  >
    ${error
      ? html`<p class="home-empty">Couldn't load schedules. ${error.message || ""}</p>`
      : loading
        ? html`<p class="home-empty">Loading…</p>`
        : rows.length === 0
          ? html`<p class="home-empty">
              Nothing scheduled. Agents add schedules when you ask them to run something on a timetable.
            </p>`
          : html`<ul class="home-list">
              ${rows.map(
                (row) => html`<li key=${row.id} class="home-list-row">
                  <span class="home-mono home-list-time">${formatLocaleTime(row.nextRunAtMs, { fallback: "—" })}</span>
                  <a href=${"#/schedules/" + encodeURIComponent(row.id)} class="home-list-name">${row.name}</a>
                  ${row.agentName ? html`<span class="home-list-meta home-list-end">${row.agentName}</span>` : null}
                </li>`,
              )}
            </ul>`}
  </${HomeCard}>
`;

export const AgentsCard = ({ rows = [], onAddAgent = () => {} }) => html`
  <${HomeCard} title="Agents" href="#/agents">
    ${rows.length === 0
      ? html`<div class="home-empty-block">
          <p class="home-empty">No agents yet.</p>
          <${ActionButton} onClick=${onAddAgent} tone="secondary" idleLabel="Add agent" />
        </div>`
      : html`<ul class="home-list">
          ${rows.map(
            (row) => html`<li key=${row.id} class="home-list-row">
              <a href=${"#/agents/" + encodeURIComponent(row.id)} class="home-list-name">${row.name}</a>
              ${row.isDefault ? html`<${Badge} tone="neutral">Default</${Badge}>` : null}
              <span class=${(row.model ? "home-mono" : "home-list-meta") + " home-list-end"}>
                ${row.model || "Default model"}
              </span>
            </li>`,
          )}
        </ul>`}
  </${HomeCard}>
`;

export const ChannelsSummaryCard = ({ rows = [], relayRow = null, loading = false, onAddChannel = () => {} }) => {
  const list = [...rows, ...(relayRow ? [relayRow] : [])];
  return html`
    <${HomeCard} title="Channels" href="#/channels">
      ${rows.length === 0
        ? loading
          ? html`<p class="home-empty">Loading…</p>`
          : html`<div class="home-empty-block">
              <p class="home-empty">
                No channels yet. Connect Telegram, Discord or another channel so people can reach your agents.
              </p>
              <${ActionButton} onClick=${onAddChannel} tone="secondary" idleLabel="Add channel" />
            </div>`
        : null}
      ${list.length > 0
        ? html`<ul class="home-list">
            ${list.map(
              (row) => html`<li key=${row.key} class="home-list-row">
                <${StatusDot} state=${kRowDot[row.tone] || "connecting"} />
                <a href=${row.href} class="home-list-name">${row.label}</a>
                <span class="home-list-meta home-list-end">${row.detail}</span>
              </li>`,
            )}
          </ul>`
        : null}
    </${HomeCard}>
  `;
};

const describeHardening = (doctorStatus, hardeningModel) => {
  if (hardeningModel) return hardeningModel.tone === "danger" ? "Not reaching the agent" : "Partly cut";
  const badge = getHardeningBadgeModel(doctorStatus);
  if (!badge) return "—";
  return badge.tone === "success" ? "Injected" : "Unknown";
};

export const ThisBoxCard = ({
  statusData = null,
  state = {},
  actions = {},
  update = {},
  hardening = "—",
  isActive = false,
}) => {
  const [updateOpen, setUpdateOpen] = useState(false);
  const showUpdate = update.hasUpdate || update.managed?.blocked || update.managed?.error;
  return html`
    <${HomeCard} title="This box">
      <dl class="home-facts">
        <div class="home-fact">
          <dt>OpenClaw</dt>
          <dd>
            <span class="home-mono">${statusData?.openclawVersion || "—"}</span>
            <${ActionButton} onClick=${actions.handleOpenDashboard} tone="secondary" idleLabel="Open dashboard" />
          </dd>
        </div>
        <div class="home-fact">
          <dt>AlphaClaw</dt>
          <dd>
            <span class="home-mono">${update.version || statusData?.alphaclawVersion || "—"}</span>
            ${showUpdate
              ? html`<${ActionButton}
                  onClick=${() => setUpdateOpen(true)}
                  tone="secondary"
                  loading=${update.updating}
                  loadingLabel="Updating…"
                  idleLabel=${update.managed?.blocked
                    ? "Deployment status"
                    : update.managed?.error
                      ? "Update status unavailable"
                      : "Update"}
                />`
              : null}
          </dd>
        </div>
        <div class="home-fact">
          <dt>Hardening</dt>
          <dd>${hardening}</dd>
        </div>
      </dl>
      <${BackupsCard} isActive=${isActive} compact=${true} />
      ${state.repo ? html`<${SyncSettings} state=${state} actions=${actions} />` : null}
      <${UpdateModal}
        visible=${updateOpen}
        onClose=${() => {
          if (update.updating) return;
          setUpdateOpen(false);
        }}
        currentVersion=${update.version}
        currentOpenclawVersion=${update.currentOpenclawVersion}
        version=${update.latest}
        latestOpenclawVersion=${update.latestOpenclawVersion}
        updateStrategy=${update.strategy}
        managedUpdate=${update.managed}
        onUpdate=${update.onUpdate}
        updating=${update.updating}
      />
    </${HomeCard}>
  `;
};

const readResult = (read, pick) => {
  if (read.error && !read.data) return { error: read.error };
  if (read.data === null || read.data === undefined) return null;
  return pick(read.data);
};

export const HomeTab = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  agents = [],
  doctorWarningDismissedUntilMs = 0,
  onRefreshStatuses = () => {},
  onSwitchTab = () => {},
  onAddAgent = () => {},
  isActive = false,
  restartSignal = 0,
  onDismissDoctorWarning = () => {},
  update = {},
  nowMs = Date.now(),
}) => {
  const { state, actions } = useGeneralTab({
    statusData,
    watchdogData,
    doctorStatusData,
    onRefreshStatuses,
    isActive,
    restartSignal,
  });
  const chip = deriveStatusChip(useGatewayShell());
  // D14: the Finish-setting-up Team row needs an OpenClaw with trusted-proxy
  // team access.
  const { data: capsPayload } = useCachedFetch(kHomeReadKeys.capabilities, fetchOpenclawCapabilities, {
    maxAgeMs: 5 * 60_000,
    enabled: isActive,
  });
  const upgradeRead = useCachedFetch(kUpgradeStatusKey, fetchUpgradeStatus, { enabled: isActive, maxAgeMs: 30_000 });
  const incidentsRead = useCachedFetch(
    kHomeReadKeys.incidents,
    () => fetchWatchdogIncidents({ limit: kHomeIncidentLimit }),
    { enabled: isActive, maxAgeMs: 30_000 },
  );
  const usageRead = useCachedFetch(kHomeReadKeys.usage, () => fetchUsageSummary(30), {
    enabled: isActive,
    maxAgeMs: 60_000,
  });
  const cronRead = useCachedFetch(
    kHomeReadKeys.cron,
    () => fetchCronJobs({ sortBy: "nextRunAtMs", sortDir: "asc" }),
    { enabled: isActive, maxAgeMs: 30_000 },
  );
  const relayRead = useCachedFetch(kHomeReadKeys.relay, fetchRelayStatus, { enabled: isActive, maxAgeMs: 30_000 });
  const accountsRead = useCachedFetch(kHomeReadKeys.channelAccounts, fetchChannelAccounts, {
    enabled: isActive,
    maxAgeMs: 30_000,
  });
  useVisibleInterval(
    () => Promise.allSettled([incidentsRead, usageRead, cronRead, relayRead].map((read) => read.refresh({ force: true }))),
    kHomeRefreshMs,
    { enabled: isActive },
  );

  const doctorStatus = state.doctorStatus;
  const hardeningModel = buildHardeningCardModel(doctorStatus);
  const pinWarning = getOpenclawPinWarning(state.openclawPin);
  const upgradeAlert = upgradeRead.data?.alert || null;
  const devicePending = Array.isArray(state.devicePending) ? state.devicePending : [];
  const syncOff = Boolean(state.repo) && state.syncCron?.enabled === false;

  const attention = orderAttentionItems([
    pinWarning && { key: "pin", tone: "warn", title: pinWarning.title, detail: pinWarning.body },
    upgradeAlert && {
      key: "upgrade",
      tone: upgradeAlert.tone === "error" ? "bad" : "warn",
      title: "OpenClaw data upgrade",
      actionable: true,
      renderBody: ({ solid }) =>
        html`<${UpgradeAlert} isActive=${isActive} embedded=${true} primaryTone=${solid ? "solid" : "secondary"} />`,
    },
    hardeningModel && {
      key: "hardening",
      tone: hardeningModel.tone === "danger" ? "bad" : "warn",
      title: hardeningModel.anchor,
      detail: hardeningModel.detail,
      actionable: true,
      action: { label: "Open Drift Doctor", onClick: () => onSwitchTab("doctor?focus=context") },
      renderBody: () => html`
        <details class="home-attention-more">
          <summary>Show the affected files</summary>
          <ul class="space-y-2 mt-2">
            ${[...hardeningModel.signals, ...hardeningModel.collapsedSignals].map(
              (signal) => html`<${HardeningSignalRow} key=${signal.key} signal=${signal} />`,
            )}
          </ul>
        </details>
      `,
    },
    !hardeningModel &&
      shouldShowDoctorWarning(doctorStatus, doctorWarningDismissedUntilMs) && {
        key: "doctor",
        tone: "warn",
        title: "Drift Doctor",
        detail: getDoctorWarningMessage(doctorStatus),
        actionable: true,
        action: { label: "Open Drift Doctor", onClick: () => onSwitchTab("doctor") },
        secondaryAction: { label: "Dismiss for 1 week", onClick: onDismissDoctorWarning },
      },
    devicePending.length > 0 && {
      key: "devices",
      tone: "warn",
      title:
        devicePending.length === 1
          ? "A device is waiting for approval"
          : devicePending.length + " devices are waiting for approval",
      actionable: true,
      renderBody: ({ solid }) => html`<${DevicePairings}
        pending=${devicePending}
        onApprove=${actions.handleDeviceApprove}
        onReject=${actions.handleDeviceReject}
        approveTone=${solid ? "solid" : "secondary"}
        embedded=${true}
      />`,
    },
    syncOff && {
      key: "sync",
      tone: "warn",
      title: "Workspace sync is off",
      detail: "Workspace changes are not pushed to " + state.repo + ". Turn auto-sync on under This box.",
    },
  ]);

  const headline = buildHomeHeadline({ chip, attentionCount: attention.length });
  const cells = buildStripCells({
    chip,
    watchdog: state.watchdogStatus,
    incidents: readResult(incidentsRead, (data) => ({ summary: summarizeRecentIncidents(data?.incidents, nowMs) })),
    usage: readResult(usageRead, (data) => ({ data: data?.summary || {} })),
    nowMs,
  });

  return html`
    <div class="home">
      <p class=${"home-headline home-headline--" + headline.tone} aria-live="polite">
        ${headline.text}
        ${headline.healthLink ? html` <a href="#/health" class="home-headline-link">${headline.healthLink}</a>` : null}
      </p>
      <${StatusStrip} cells=${cells} />
      <div class="home-grid">
        <div class="home-col">
          <div class="home-slot home-slot--attention"><${AttentionCard} items=${attention} /></div>
          <div class="home-slot home-slot--setup">
            <${WhatsNextCard}
              channels=${state.channels}
              onSwitchTab=${onSwitchTab}
              teamSupported=${capsPayload?.capabilities?.trustedProxyTeam === true}
              teamEnabled=${statusData?.alphaclaw?.team?.enabled === true}
            />
          </div>
          <div class="home-slot home-slot--coming">
            <${ComingUpCard}
              rows=${buildComingUp({ jobs: cronRead.data?.jobs, agents })}
              loading=${cronRead.loading && !cronRead.data}
              error=${cronRead.error && !cronRead.data ? cronRead.error : null}
            />
          </div>
        </div>
        <div class="home-col">
          <div class="home-slot home-slot--agents">
            <${AgentsCard} rows=${buildAgentRows(agents)} onAddAgent=${onAddAgent} />
          </div>
          <div class="home-slot home-slot--channels">
            <${ChannelsSummaryCard}
              rows=${buildChannelRows({ accounts: accountsRead.data?.channels, channels: state.channels, agents })}
              relayRow=${buildRelayRow(relayRead.data)}
              loading=${accountsRead.loading && !accountsRead.data}
              onAddChannel=${() => onSwitchTab("channels")}
            />
          </div>
          <div class="home-slot home-slot--box">
            <${ThisBoxCard}
              statusData=${statusData}
              state=${state}
              actions=${actions}
              update=${update}
              hardening=${describeHardening(doctorStatus, hardeningModel)}
              isActive=${isActive}
            />
          </div>
        </div>
      </div>
    </div>
  `;
};
