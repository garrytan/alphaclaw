import { h } from "preact";
import {
  useCallback,
  useMemo,
  useState,
} from "preact/hooks";
import { createPortal } from "preact/compat";
import htm from "htm";
import { AddChannelMenu } from "../add-channel-menu.js";
import { ChannelAccountStatusBadge } from "../channel-account-status-badge.js";
import { ChannelLoginModal } from "../channel-login-modal.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { OverflowMenu, OverflowMenuItem } from "../overflow-menu.js";
import {
  deleteChannelAccount,
  fetchBuzzSetup,
  fetchChannelAccounts,
  fetchOpenclawCapabilities,
  runBuzzSetupAction,
  updateChannelAccount,
} from "../../lib/api.js";
import { BuzzWizard, BuzzPendingCard } from "./buzz-wizard.js";
import { ChannelsCard } from "./channels-card.js";
import { useChannelLogin } from "./use-channel-login.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import {
  isImplicitDefaultAccount,
  resolveChannelAccountLabel,
} from "../../lib/channel-accounts.js";
import { createChannelAccountWithProgress } from "../../lib/channel-create-operation.js";
import { describeChannelDeleteOutcome } from "../../lib/channel-delete-outcome.js";
import { isChannelProviderDisabledForAdd } from "../../lib/channel-provider-availability.js";
import {
  kAllChannelIds,
  kCreatableChannelIds,
  getChannelMeta,
  kChannelMeta,
} from "../../lib/channel-registry.js";
import { CreateChannelModal } from "../agents-tab/create-channel-modal.js";
import { showToast } from "../toast.js";
import { kRestartRequiredEvent } from "../../lib/ui-events.js";

const html = htm.bind(h);

// Derived from the shared registry (5.0) so new providers land once.
const ALL_CHANNELS = kAllChannelIds;
// Add-channel menus only offer channels with a create flow (excludes external
// channels like signal, which are configured out-of-band).
const CREATABLE_CHANNELS = kCreatableChannelIds;
const announceRestartRequired = () =>
  window.dispatchEvent(new CustomEvent(kRestartRequiredEvent));

export const Channels = ({
  channels = null,
  agents = [],
  onNavigate = () => {},
  onRefreshStatuses = () => {},
  onRestartGateway = async () => ({ ok: false }),
  // The Channels page puts the add menu in its page header (a DOM node) as
  // the page's solid primary button.
  addMenuSlot = null,
  emptyLabel = "No channels configured",
}) => {
  const [saving, setSaving] = useState(false);
  const [createLoadingLabel, setCreateLoadingLabel] = useState("Creating…");
  const [menuOpenId, setMenuOpenId] = useState("");
  const [editingAccount, setEditingAccount] = useState(null);
  const [deletingAccount, setDeletingAccount] = useState(null);
  const {
    data: channelAccountsPayload,
    loading: loadingAccounts,
    refresh: refreshChannelAccounts,
  } = useCachedFetch("/api/channels/accounts", fetchChannelAccounts, {
    maxAgeMs: 30000,
  });
  const channelAccounts = Array.isArray(channelAccountsPayload?.channels)
    ? channelAccountsPayload.channels
    : [];
  // Buzz (5.2): capability-gated menu entry + resumable wizard state.
  const [buzzWizardOpen, setBuzzWizardOpen] = useState(false);
  const { data: capsPayload } = useCachedFetch(
    "/api/openclaw/capabilities",
    fetchOpenclawCapabilities,
    { maxAgeMs: 5 * 60_000 },
  );
  const buzzSupported = capsPayload?.capabilities?.buzzChannel === true;
  const { data: buzzSetupPayload, refresh: refreshBuzzSetup } = useCachedFetch(
    "/api/channels/buzz/setup",
    fetchBuzzSetup,
    { maxAgeMs: 30000, enabled: buzzSupported },
  );
  const buzzSetupState = buzzSetupPayload?.state || null;
  // Set when a post-mutation list refresh fails: the mutation itself
  // succeeded, but the rows on screen may be stale.
  const [listRefreshError, setListRefreshError] = useState(null);

  const loadChannelAccounts = useCallback(async () => {
    try {
      await refreshChannelAccounts({ force: true });
      setListRefreshError(null);
    } catch (error) {
      setListRefreshError(error);
    }
  }, [refreshChannelAccounts]);

  const configuredChannelMap = useMemo(
    () =>
      new Map(
        channelAccounts.map((entry) => [
          String(entry?.channel || "").trim(),
          entry,
        ]),
      ),
    [channelAccounts],
  );

  const agentNameMap = useMemo(
    () =>
      new Map(
        agents.map((agent) => [
          String(agent?.id || "").trim(),
          String(agent?.name || "").trim() || String(agent?.id || "").trim(),
        ]),
      ),
    [agents],
  );

  const defaultAgentId = useMemo(
    () => String(agents.find((entry) => entry?.default)?.id || "").trim(),
    [agents],
  );
  const showAgentBadge = agents.length > 0;

  const {
    loginAccount,
    loginOutput,
    loginError,
    loginRunning,
    loginLinked,
    loginRestartingGateway,
    loginRestartedGateway,
    openLogin,
    closeLogin,
    handleRunChannelLogin,
  } = useChannelLogin({
    channelAccounts,
    defaultAgentId,
    loadChannelAccounts,
    onRefreshStatuses,
    onRestartGateway,
  });

  const handleUpdateChannel = async (payload) => {
    setSaving(true);
    try {
      const result = await updateChannelAccount(payload);
      setEditingAccount(null);
      showToast("Channel updated", "success");
      if (result?.restartRequired) {
        announceRestartRequired();
      }
      await Promise.all([
        loadChannelAccounts(),
        Promise.resolve(onRefreshStatuses?.()),
      ]);
    } catch (error) {
      showToast(error.message || "Could not update channel", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleCreateChannel = async (payload) => {
    setSaving(true);
    setCreateLoadingLabel("Creating…");
    try {
      const result = await createChannelAccountWithProgress({
        payload,
        onPhase: (label) => {
          setCreateLoadingLabel(String(label || "").trim() || "Creating…");
        },
      });
      setEditingAccount(null);
      showToast("Channel configured", "success");
      if (result?.restartRequired) {
        announceRestartRequired();
      }
      await Promise.all([
        loadChannelAccounts(),
        Promise.resolve(onRefreshStatuses?.()),
      ]);
    } catch (error) {
      showToast(error.message || "Could not configure channel", "error");
    } finally {
      setSaving(false);
      setCreateLoadingLabel("Creating…");
    }
  };

  const handleDeleteChannel = async () => {
    if (!deletingAccount) return;
    setSaving(true);
    try {
      const result = await deleteChannelAccount({
        provider: deletingAccount.provider,
        accountId: deletingAccount.id,
      });
      setDeletingAccount(null);
      // The delete succeeded, but the pairing-row clear or the restart may
      // have failed: the toast says so instead of a clean "Channel deleted".
      const outcome = describeChannelDeleteOutcome(result);
      showToast(outcome.message, outcome.level);
      if (outcome.restartRequired) {
        announceRestartRequired();
      }
      await Promise.all([
        loadChannelAccounts(),
        Promise.resolve(onRefreshStatuses?.()),
      ]);
    } catch (error) {
      showToast(error.message || "Could not delete channel", "error");
    } finally {
      setSaving(false);
    }
  };
  const openCreateChannelModal = (provider) => {
    setMenuOpenId("");
    // Buzz runs a resumable guided wizard, never the create-channel modal.
    if (provider === "buzz") {
      setBuzzWizardOpen(true);
      return;
    }
    setEditingAccount({
      id: "default",
      provider,
      name: getChannelMeta(provider).label,
      ownerAgentId: defaultAgentId,
      mode: "create",
    });
  };
  const items = useMemo(
    () => {
      // Rows render as soon as the accounts list is loaded; per-account
      // status badges fall back to account-level status until the (separate,
      // slower) statuses fetch lands.
      if (loadingAccounts) return [];
      const channelOrderMap = new Map(
        channelAccounts.map((entry, index) => [
          String(entry?.channel || "").trim(),
          index,
        ]),
      );
      const accountOrderMap = new Map(
        channelAccounts.flatMap((entry) =>
          (Array.isArray(entry?.accounts) ? entry.accounts : []).map(
            (account, accountIndex) => [
              `${String(entry?.channel || "").trim()}:${String(account?.id || "").trim() || "default"}`,
              accountIndex,
            ],
          ),
        ),
      );
      return Array.from(
        new Set([
          ...channelAccounts.map((entry) =>
            String(entry?.channel || "").trim(),
          ),
        ]),
      )
            .filter(Boolean)
            .flatMap((channelId) => {
              const info = channels?.[channelId];
              const configuredChannel = configuredChannelMap.get(channelId);
              const accounts = Array.isArray(configuredChannel?.accounts)
                ? configuredChannel.accounts
                : [];
              if (!configuredChannel) return [];

              return accounts.map((account) => {
                const accountId = String(account?.id || "").trim() || "default";
                const accountStatusInfo =
                  info?.accounts?.[accountId] || info || null;
                const accountStatus = String(
                  accountStatusInfo?.status || account?.status || "configured",
                ).trim();
                const pairedCount = Number(
                  accountStatusInfo?.paired ??
                    account?.paired ??
                    info?.paired ??
                    0,
                );
                const isClickable =
                  channelId === "telegram" &&
                  accountStatus === "paired" &&
                  onNavigate;
                const boundAgentId = String(account?.boundAgentId || "").trim();
                const ownerAgentId =
                  boundAgentId ||
                  (isImplicitDefaultAccount({ accountId, boundAgentId })
                    ? defaultAgentId
                    : "");
                const ownerAgentName =
                  agentNameMap.get(ownerAgentId) || ownerAgentId || "";
                const accountData = {
                  id: accountId,
                  provider: channelId,
                  name: resolveChannelAccountLabel({
                    channelId,
                    account,
                    providerLabel: getChannelMeta(channelId).label || "Channel",
                  }),
                  ownerAgentId,
                  envKey: String(account?.envKey || "").trim(),
                  token: String(account?.token || "").trim(),
                };

                const trailing = html`
                  <div class="flex items-center gap-1.5">
                    ${
                      showAgentBadge &&
                      ownerAgentName &&
                      accountStatus === "paired"
                        ? html`<${ChannelAccountStatusBadge}
                            status=${accountStatus}
                            ownerAgentName=${ownerAgentName}
                            showAgentBadge=${showAgentBadge}
                            channelId=${channelId}
                            pairedCount=${pairedCount}
                          />`
                        : null
                    }
                    ${
                      accountStatus === "paired"
                        ? showAgentBadge && ownerAgentName
                          ? null
                          : html`<${ChannelAccountStatusBadge}
                              status=${accountStatus}
                              ownerAgentName=""
                              showAgentBadge=${false}
                              channelId=${channelId}
                              pairedCount=${pairedCount}
                            />`
                        : html`<${ChannelAccountStatusBadge}
                            status=${accountStatus}
                            ownerAgentName=""
                            showAgentBadge=${false}
                            channelId=${channelId}
                            pairedCount=${pairedCount}
                          />`
                    }
                    <${OverflowMenu}
                      open=${menuOpenId === `${channelId}:${accountId}`}
                      ariaLabel="Open channel actions"
                      title="Open channel actions"
                      onClose=${() => setMenuOpenId("")}
                      onToggle=${() =>
                        setMenuOpenId((current) =>
                          current === `${channelId}:${accountId}`
                            ? ""
                            : `${channelId}:${accountId}`,
                        )}
                    >
                      <${OverflowMenuItem}
                        onClick=${() => {
                          setMenuOpenId("");
                          setEditingAccount(accountData);
                        }}
                      >
                        Edit
                      </${OverflowMenuItem}>
                      ${channelId === "whatsapp"
                        ? html`
                            <${OverflowMenuItem}
                              onClick=${() => {
                                setMenuOpenId("");
                                openLogin(accountData);
                              }}
                            >
                              Link WhatsApp (QR)
                            </${OverflowMenuItem}>
                          `
                        : null}
                      <${OverflowMenuItem}
                        className="text-status-error hover:text-status-error"
                        onClick=${() => {
                          setMenuOpenId("");
                          setDeletingAccount(accountData);
                        }}
                      >
                        Delete
                      </${OverflowMenuItem}>
                    </${OverflowMenu}>
                  </div>
                `;

                return {
                  id: `${channelId}:${accountId}`,
                  channel: channelId,
                  channelOrder: Number(channelOrderMap.get(channelId) ?? 9999),
                  accountOrder: Number(
                    accountOrderMap.get(`${channelId}:${accountId}`) ?? 9999,
                  ),
                  label: resolveChannelAccountLabel({
                    channelId,
                    account,
                    providerLabel: getChannelMeta(channelId).label || "Channel",
                  }),
                  isAwaitingPairing: accountStatus !== "paired",
                  detailText: isClickable ? "Workspace" : "",
                  detailChevron: isClickable,
                  clickable: isClickable,
                  onClick: isClickable
                    ? () =>
                        onNavigate(`telegram/${encodeURIComponent(accountId)}`)
                    : undefined,
                  trailing,
                };
              });
            })
            .sort((a, b) => {
              const awaitingDiff =
                Number(!!a?.isAwaitingPairing) - Number(!!b?.isAwaitingPairing);
              if (awaitingDiff !== 0) return awaitingDiff;
              const channelOrderDiff =
                Number(a?.channelOrder ?? 9999) - Number(b?.channelOrder ?? 9999);
              if (channelOrderDiff !== 0) return channelOrderDiff;
              const accountOrderDiff =
                Number(a?.accountOrder ?? 9999) - Number(b?.accountOrder ?? 9999);
              if (accountOrderDiff !== 0) return accountOrderDiff;
              return String(a?.label || "").localeCompare(String(b?.label || ""));
            })
        ;
    },
    [
      agentNameMap,
      agents.length,
      channelAccounts,
      channels,
      configuredChannelMap,
      defaultAgentId,
      loadingAccounts,
      menuOpenId,
      onNavigate,
      showAgentBadge,
    ],
  );

  const renderAddChannelMenu = (triggerLabel = "") => html`
    <${AddChannelMenu}
      triggerLabel=${triggerLabel}
      open=${menuOpenId === "__create_channel"}
      onClose=${() => setMenuOpenId("")}
      onToggle=${() =>
        setMenuOpenId((current) =>
          current === "__create_channel" ? "" : "__create_channel",
        )}
      triggerDisabled=${saving || loadingAccounts}
      channelIds=${CREATABLE_CHANNELS}
      getChannelMeta=${(channelId) =>
        channelId === "buzz" && !buzzSupported
          ? {
              ...getChannelMeta(channelId),
              label: "Buzz — needs OpenClaw 2026.8+",
            }
          : getChannelMeta(channelId)}
      isChannelDisabled=${(channelId) =>
        channelId === "buzz"
          ? !buzzSupported
          : isChannelProviderDisabledForAdd({
              configuredChannelMap,
              provider: channelId,
            })}
      onSelectChannel=${openCreateChannelModal}
    />
  `;

  return html`
    <div class="space-y-3">
      <${ChannelsCard}
        title="Channels"
        items=${items}
        loadingLabel=${loadingAccounts
          ? "Loading…"
          : emptyLabel}
        actions=${addMenuSlot ? null : renderAddChannelMenu()}
      />
      ${addMenuSlot ? createPortal(renderAddChannelMenu("Add channel"), addMenuSlot) : null}
      ${listRefreshError &&
      html`
        <${InlineErrorChip}
          error=${listRefreshError}
          headline="Saved, but the list could not refresh — reload to see changes."
          onRetry=${loadChannelAccounts}
          retryLabel="Refresh"
        />
      `}
      <${BuzzPendingCard}
        state=${buzzSetupState}
        onResume=${() => setBuzzWizardOpen(true)}
        onCancel=${async () => {
          try {
            await runBuzzSetupAction("cancel", {});
            refreshBuzzSetup();
            showToast(
              "Buzz setup paused — the plugin and bot identity stay installed",
              "info",
            );
          } catch (err) {
            showToast(err?.message || "Could not pause Buzz setup", "error");
          }
        }}
      />
      <${BuzzWizard}
        visible=${buzzWizardOpen}
        onClose=${() => {
          setBuzzWizardOpen(false);
          refreshBuzzSetup();
        }}
        onFinished=${() => {
          refreshBuzzSetup();
          refreshChannelAccounts();
          onRefreshStatuses();
        }}
      />
      <${CreateChannelModal}
        visible=${!!editingAccount}
        loading=${saving}
        createLoadingLabel=${createLoadingLabel}
        agents=${agents}
        existingChannels=${channelAccounts}
        mode=${editingAccount?.mode === "create" ? "create" : "edit"}
        account=${editingAccount}
        initialAgentId=${String(editingAccount?.ownerAgentId || "").trim()}
        initialProvider=${String(editingAccount?.provider || "").trim()}
        onClose=${() => setEditingAccount(null)}
        onSubmit=${editingAccount?.mode === "create"
          ? handleCreateChannel
          : handleUpdateChannel}
      />
      <${ConfirmDialog}
        visible=${!!deletingAccount}
        title="Delete channel?"
        message=${`Remove ${String(deletingAccount?.name || "this channel").trim()} from your configured channels?`}
        confirmLabel="Delete"
        confirmLoadingLabel="Deleting…"
        confirmTone="warning"
        confirmLoading=${saving}
        onConfirm=${handleDeleteChannel}
        onCancel=${() => {
          if (saving) return;
          setDeletingAccount(null);
        }}
      />
      <${ChannelLoginModal}
        visible=${!!loginAccount}
        loading=${loginRunning || loginRestartingGateway}
        title=${`Link ${String(loginAccount?.name || "WhatsApp").trim()} via QR`}
        output=${loginOutput}
        error=${loginError}
        onRun=${handleRunChannelLogin}
        onClose=${closeLogin}
        runDisabled=${loginRunning || loginRestartingGateway || loginRestartedGateway}
        runLabel=${loginLinked
          ? loginRestartingGateway
            ? "Restarting gateway…"
            : loginRestartedGateway
              ? "Linked"
              : "Awaiting restart…"
          : "Generate QR"}
        runLoadingLabel=${loginRestartingGateway ? "Restarting gateway…" : "Running…"}
        closeLabel=${loginRestartedGateway ? "Done" : "Close"}
      />
    </div>
  `;
};

export { ALL_CHANNELS, CREATABLE_CHANNELS, ChannelsCard, getChannelMeta, kChannelMeta };
