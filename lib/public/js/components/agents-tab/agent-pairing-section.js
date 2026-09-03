import { h } from "preact";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import htm from "htm";
import { InlineErrorChip } from "../inline-error-chip.js";
import { Pairings } from "../pairings.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  approvePairing,
  fetchAgentBindings,
  fetchChannelAccounts,
  fetchPairings,
  rejectPairing,
} from "../../lib/api.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";

const html = htm.bind(h);

const toOwnedAccountKey = (channel, accountId) => {
  const normalizedChannel = String(channel || "").trim();
  const normalizedAccountId = String(accountId || "").trim() || "default";
  return normalizedChannel ? `${normalizedChannel}:${normalizedAccountId}` : "";
};

const announcePairingsChanged = (agentId) => {
  window.dispatchEvent(
    new CustomEvent("alphaclaw:pairings-changed", {
      detail: { agentId: String(agentId || "").trim() },
    }),
  );
};


export const AgentPairingSection = ({ agent = {} }) => {
  const [pairingStatusRefreshing, setPairingStatusRefreshing] = useState(false);
  const pairingRefreshTimerRef = useRef(null);
  const pairingDelayedRefreshTimerRefs = useRef([]);
  const agentId = String(agent?.id || "").trim();
  const isDefaultAgent = !!agent?.default;
  // Stable fetcher identity: an inline lambda would churn the hook's refresh
  // identity every render.
  const fetchBindingsForAgent = useCallback(
    () => fetchAgentBindings(agentId),
    [agentId],
  );
  const {
    data: bindingsPayload,
    error: bindingsError,
    loading: bindingsLoading,
    refresh: refreshBindingsPayload,
  } = useCachedFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/bindings`,
    fetchBindingsForAgent,
    {
      enabled: Boolean(agentId),
      maxAgeMs: 30000,
    },
  );
  const {
    data: channelsPayload,
    error: channelsError,
    loading: channelsLoading,
    refresh: refreshChannelsPayload,
  } = useCachedFetch("/api/channels/accounts", fetchChannelAccounts, {
    maxAgeMs: 30000,
  });

  // Derived straight from the hooks: their latest-request-wins state IS the
  // last-known-good store, so a failed refresh keeps the card rendered
  // instead of snapping it to empty (which used to make it vanish).
  const bindings = useMemo(
    () =>
      Array.isArray(bindingsPayload?.bindings) ? bindingsPayload.bindings : [],
    [bindingsPayload],
  );
  const channels = useMemo(
    () =>
      Array.isArray(channelsPayload?.channels) ? channelsPayload.channels : [],
    [channelsPayload],
  );
  const loadingBindings = Boolean(bindingsLoading || channelsLoading);
  const loadError = bindingsError || channelsError || null;

  const loadBindings = useCallback(async () => {
    // Non-destructive refresh: failures surface via the hooks' error state
    // while last-known-good data stays rendered.
    await Promise.allSettled([
      refreshBindingsPayload({ force: true }),
      refreshChannelsPayload({ force: true }),
    ]);
  }, [refreshBindingsPayload, refreshChannelsPayload]);

  useEffect(() => {
    const handleBindingsChanged = (event) => {
      const changedAgentId = String(event?.detail?.agentId || "").trim();
      if (changedAgentId !== agentId) return;
      loadBindings();
    };
    window.addEventListener("alphaclaw:agent-bindings-changed", handleBindingsChanged);
    return () => {
      window.removeEventListener("alphaclaw:agent-bindings-changed", handleBindingsChanged);
    };
  }, [agentId, loadBindings]);
  useEffect(
    () => () => {
      if (pairingRefreshTimerRef.current) {
        clearTimeout(pairingRefreshTimerRef.current);
      }
      for (const timerId of pairingDelayedRefreshTimerRefs.current) {
        clearTimeout(timerId);
      }
      pairingDelayedRefreshTimerRefs.current = [];
    },
    [],
  );

  const ownedAccounts = useMemo(
    () => {
      const ownedAccountMap = new Map();
      for (const binding of bindings) {
        const channelId = String(binding?.match?.channel || "").trim();
        if (!channelId) continue;
        const accountId = String(binding?.match?.accountId || "").trim() || "default";
        const key = toOwnedAccountKey(channelId, accountId);
        if (!key) continue;
        ownedAccountMap.set(key, { channel: channelId, accountId });
      }
      for (const channel of channels) {
        const channelId = String(channel?.channel || "").trim();
        const accounts = Array.isArray(channel?.accounts) ? channel.accounts : [];
        const defaultAccount = accounts.find(
          (entry) => String(entry?.id || "").trim() === "default",
        );
        if (
          isDefaultAgent
          && channelId
          && defaultAccount
          && !String(defaultAccount?.boundAgentId || "").trim()
        ) {
          const key = toOwnedAccountKey(channelId, "default");
          ownedAccountMap.set(key, { channel: channelId, accountId: "default" });
        }
      }
      return Array.from(ownedAccountMap.values());
    },
    [bindings, channels, isDefaultAgent],
  );

  const boundChannels = useMemo(
    () => Array.from(new Set(ownedAccounts.map((entry) => entry.channel))).filter(Boolean),
    [ownedAccounts],
  );

  const ownedAccountKeySet = useMemo(
    () =>
      new Set(
        ownedAccounts
          .map((entry) => toOwnedAccountKey(entry.channel, entry.accountId))
          .filter(Boolean),
      ),
    [ownedAccounts],
  );

  const accountNameMap = useMemo(() => {
    const nextMap = new Map();
    for (const channel of channels) {
      const channelId = String(channel?.channel || "").trim();
      const accounts = Array.isArray(channel?.accounts) ? channel.accounts : [];
      for (const account of accounts) {
        const accountId = String(account?.id || "").trim() || "default";
        const key = toOwnedAccountKey(channelId, accountId);
        if (!key) continue;
        const configuredName = String(account?.name || "").trim();
        nextMap.set(key, configuredName || accountId);
      }
    }
    return nextMap;
  }, [channels]);

  const ownedChannelsStatus = useMemo(() => {
    const nextStatus = {};
    for (const entry of ownedAccounts) {
      const channelId = String(entry?.channel || "").trim();
      if (!channelId) continue;
      const key = toOwnedAccountKey(channelId, entry?.accountId);
      const account = channels
        .find((channel) => String(channel?.channel || "").trim() === channelId)
        ?.accounts?.find(
          (accountEntry) =>
            (String(accountEntry?.id || "").trim() || "default")
            === (String(entry?.accountId || "").trim() || "default"),
        );
      const status = String(account?.status || "").trim() || "configured";
      if (!nextStatus[channelId] || status !== "paired") {
        nextStatus[channelId] = {
          status: status === "paired" ? "paired" : "configured",
          accountName: accountNameMap.get(key) || "",
        };
      }
    }
    return nextStatus;
  }, [accountNameMap, channels, ownedAccounts]);

  const hasUnpaired = useMemo(
    () =>
      Object.values(ownedChannelsStatus).some(
        (entry) => String(entry?.status || "").trim() !== "paired",
      ),
    [ownedChannelsStatus],
  );

  const pairingsPoll = usePolling(
    async () => {
      const data = await fetchPairings();
      const pending = Array.isArray(data?.pending) ? data.pending : [];
      return pending
        .filter((entry) =>
          ownedAccountKeySet.has(
            toOwnedAccountKey(
              String(entry?.channel || "").trim(),
              String(entry?.accountId || "").trim() || "default",
            ),
          ),
        )
        .map((entry) => {
          const key = toOwnedAccountKey(entry?.channel, entry?.accountId);
          return {
            ...entry,
            accountName: accountNameMap.get(key) || "",
          };
        });
    },
    3000,
    {
      enabled: ownedAccounts.length > 0,
      cacheKey: `/api/pairings?agent=${encodeURIComponent(agentId)}`,
      dedupeInFlight: true,
    },
  );

  const pending = pairingsPoll.data || [];
  const showPairings = hasUnpaired || pending.length > 0 || pairingStatusRefreshing;

  const refreshAfterPairingAction = useCallback(() => {
    setPairingStatusRefreshing(true);
    if (pairingRefreshTimerRef.current) {
      clearTimeout(pairingRefreshTimerRef.current);
    }
    pairingRefreshTimerRef.current = setTimeout(() => {
      setPairingStatusRefreshing(false);
      pairingRefreshTimerRef.current = null;
    }, 2800);
    for (const timerId of pairingDelayedRefreshTimerRefs.current) {
      clearTimeout(timerId);
    }
    pairingDelayedRefreshTimerRefs.current = [];
    const refresh = () => {
      pairingsPoll.refresh({ force: true });
      loadBindings();
      announcePairingsChanged(agentId);
    };
    refresh();
    pairingDelayedRefreshTimerRefs.current.push(setTimeout(refresh, 500));
    pairingDelayedRefreshTimerRefs.current.push(setTimeout(refresh, 2000));
  }, [agentId, loadBindings, pairingsPoll]);

  // Failure UX lives in PairingRow (per-row inline chip + restored buttons —
  // retry is clicking again); a rejection propagating from here is what lets
  // the row reset its busy state and render the chip. A second section-level
  // chip for the same failure would double the surface.
  const handleApprove = async (id, channel, accountId = "") => {
    const result = await approvePairing(id, channel, accountId);
    if (!result.ok) throw new Error(result.error || "Could not approve pairing");
    refreshAfterPairingAction();
  };

  const handleReject = async (id, channel, accountId = "") => {
    await rejectPairing(id, channel, accountId);
    refreshAfterPairingAction();
  };

  if (loadingBindings) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4">
        <h3 class="card-label mb-3">Pairing</h3>
        <p class="text-sm text-fg-muted">Loading pairing status...</p>
      </div>
    `;
  }

  if (loadError && (!bindingsPayload || !channelsPayload)) {
    // No last-known-good data to keep showing — the error owns the card
    // instead of the section silently vanishing.
    return html`
      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <h3 class="card-label">Pairing</h3>
        <${InlineErrorChip}
          error=${loadError}
          headline="Couldn't load pairing status."
          onRetry=${loadBindings}
        />
      </div>
    `;
  }

  if (!showPairings) return null;

  return html`
    <div class="space-y-2">
      <${Pairings}
        pending=${pending}
        channels=${ownedChannelsStatus}
        visible=${showPairings}
        pollingInFlight=${pairingsPoll.isPolling}
        statusRefreshing=${pairingStatusRefreshing}
        onApprove=${handleApprove}
        onReject=${handleReject}
      />
    </div>
  `;
};
