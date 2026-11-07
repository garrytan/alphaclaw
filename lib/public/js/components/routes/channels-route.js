import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Channels } from "../channels.js";
import { ChannelOperationsPanel } from "../channel-operations-panel.js";
import { DevicePairings } from "../device-pairings.js";
import { Pairings } from "../pairings.js";
import { RoutePageHeader } from "../page-header.js";
import { WhatsAppIcon } from "../icons.js";
import { useGeneralTab } from "../general/use-general-tab.js";
import { kOpenWhatsappQrEvent } from "../../lib/ui-events.js";

const html = htm.bind(h);

export const kChannelsEmptyCopy =
  "No channels yet. Connect Telegram, Discord or another channel so people can reach your agents.";

const openWhatsAppQrModal = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(kOpenWhatsappQrEvent));
};

// Who may talk to the agents: chat pairing requests (or the WhatsApp QR
// prompt while an account waits to be linked).
export const ChannelPairingsSection = ({ state = {}, actions = {} }) => {
  const whatsappStatus = state.channels?.whatsapp || null;
  const whatsappAccounts =
    whatsappStatus?.accounts && typeof whatsappStatus.accounts === "object" ? whatsappStatus.accounts : {};
  const hasWhatsAppAwaitingPairing =
    Object.keys(whatsappAccounts).length > 0
      ? Object.values(whatsappAccounts).some((account) => account && account.status !== "paired")
      : String(whatsappStatus?.status || "").trim() === "configured";
  const pending = Array.isArray(state.pending) ? state.pending : [];
  if (
    state.hasUnpaired &&
    !state.pairingStatusRefreshing &&
    pending.length === 0 &&
    hasWhatsAppAwaitingPairing
  ) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <h2 class="card-label mb-3">Pending pairings</h2>
        <div class="text-center py-4 space-y-3">
          <${WhatsAppIcon} className="w-10 h-10 mx-auto" />
          <p class="text-body text-sm font-medium">WhatsApp needs to be linked</p>
          <p class="text-fg-dim text-xs">Scan the QR code to finish pairing this channel.</p>
          <${ActionButton} onClick=${openWhatsAppQrModal} tone="primary" size="sm" idleLabel="Open QR code" />
        </div>
      </div>
    `;
  }
  return html`
    <${Pairings}
      pending=${pending}
      channels=${state.channels}
      visible=${state.hasUnpaired || pending.length > 0 || state.pairingStatusRefreshing}
      pollingInFlight=${state.pairingsPolling}
      statusRefreshing=${state.pairingStatusRefreshing}
      onApprove=${actions.handleApprove}
      onReject=${actions.handleReject}
    />
  `;
};

export const DeviceApprovalsCard = ({ pending = [], onApprove, onReject }) => html`
  <div class="bg-surface border border-border rounded-xl p-4">
    <h2 class="card-label">Device approvals</h2>
    ${pending.length > 0
      ? html`<${DevicePairings} pending=${pending} onApprove=${onApprove} onReject=${onReject} approveTone="secondary" embedded=${true} />`
      : html`<p class="text-sm text-fg-muted mt-2">
          No devices are waiting. A browser or CLI that opens the OpenClaw dashboard asks for approval here.
        </p>`}
  </div>
`;

export const ChannelsRoute = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  agents = [],
  onRefreshStatuses = () => {},
  onNavigate = () => {},
  onRestartGateway = () => {},
  restartSignal = 0,
}) => {
  const [addMenuSlot, setAddMenuSlot] = useState(null);
  const { state, actions } = useGeneralTab({
    statusData,
    watchdogData,
    doctorStatusData,
    onRefreshStatuses,
    isActive: true,
    restartSignal,
    keepPollingDevices: true,
  });
  return html`
    <div class="pt-4 space-y-4">
      <${RoutePageHeader}
        routeId="channels"
        actions=${html`<div class="ac-page-header-slot" ref=${setAddMenuSlot}></div>`}
      />
      <div class="ac-page-grid">
        <div class="ac-page-col">
          <${ChannelOperationsPanel}
            channelsSection=${html`
              <${Channels}
                channels=${state.channels}
                agents=${agents}
                onNavigate=${onNavigate}
                onRefreshStatuses=${onRefreshStatuses}
                onRestartGateway=${onRestartGateway}
                addMenuSlot=${addMenuSlot}
                emptyLabel=${kChannelsEmptyCopy}
              />
            `}
          />
        </div>
        <div class="ac-page-col">
          <${ChannelPairingsSection} state=${state} actions=${actions} />
          <${DeviceApprovalsCard}
            pending=${Array.isArray(state.devicePending) ? state.devicePending : []}
            onApprove=${actions.handleDeviceApprove}
            onReject=${actions.handleDeviceReject}
          />
        </div>
      </div>
    </div>
  `;
};
