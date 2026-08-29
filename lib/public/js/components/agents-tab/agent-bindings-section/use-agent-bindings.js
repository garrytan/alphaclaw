import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  deleteChannelAccount,
  fetchChannelAccounts,
  fetchStatus,
  updateChannelAccount,
} from "../../../lib/api.js";
import { createChannelAccountWithProgress } from "../../../lib/channel-create-operation.js";
import { showToast } from "../../toast.js";
import { announceBindingsChanged, announceRestartRequired } from "./helpers.js";

export const useAgentBindings = ({ agent = {}, agents = [] }) => {
  const [channels, setChannels] = useState([]);
  const [channelStatus, setChannelStatus] = useState({});
  // `loading` covers only the initial fetch (nothing rendered yet); later
  // fetches set `refreshing` so the list never unmounts on a refetch.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pendingBindKey, setPendingBindKey] = useState("");
  const loadRequestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const [createLoadingLabel, setCreateLoadingLabel] = useState("Creating...");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createProvider, setCreateProvider] = useState("");
  const [menuOpenId, setMenuOpenId] = useState("");
  const [editingAccount, setEditingAccount] = useState(null);
  const [deletingAccount, setDeletingAccount] = useState(null);
  const [pendingBindAccount, setPendingBindAccount] = useState(null);

  const agentId = String(agent?.id || "").trim();
  const isDefaultAgent = !!agent?.default;
  const defaultAgentId = useMemo(
    () => String(agents.find((entry) => entry?.default)?.id || "").trim(),
    [agents],
  );
  const agentNameMap = useMemo(
    () =>
      new Map(
        agents.map((entry) => [
          String(entry?.id || "").trim(),
          String(entry?.name || "").trim() || String(entry?.id || "").trim(),
        ]),
      ),
    [agents],
  );

  const load = useCallback(
    async ({ includeStatus = true } = {}) => {
      // Latest-request-wins: overlapping loads (pairing events, post-mutation
      // refreshes) must not let a slow older response clobber newer channels.
      const requestId = ++loadRequestIdRef.current;
      if (hasLoadedRef.current) setRefreshing(true);
      else setLoading(true);
      try {
        const requests = [
          fetchChannelAccounts(),
          includeStatus ? fetchStatus() : Promise.resolve(null),
        ];
        const [channelsResult, statusResult] = await Promise.all(requests);
        if (loadRequestIdRef.current !== requestId) return;
        setChannels(
          Array.isArray(channelsResult?.channels) ? channelsResult.channels : [],
        );
        if (includeStatus && statusResult) {
          setChannelStatus(statusResult?.channels || {});
        }
        setLoadError(null);
        hasLoadedRef.current = true;
      } catch (error) {
        // Keep last-known-good channels; callers render a retryable error
        // instead of a confident empty list.
        if (loadRequestIdRef.current === requestId) setLoadError(error);
      } finally {
        if (loadRequestIdRef.current === requestId) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  const retryLoad = useCallback(
    () => load({ includeStatus: true }),
    [load],
  );

  useEffect(() => {
    if (!agentId) return;
    load().catch(() => {});
  }, [agentId, load]);

  useEffect(() => {
    const handlePairingsChanged = (event) => {
      const changedAgentId = String(event?.detail?.agentId || "").trim();
      if (changedAgentId && changedAgentId !== agentId) return;
      load({ includeStatus: true }).catch(() => {});
    };
    window.addEventListener("alphaclaw:pairings-changed", handlePairingsChanged);
    return () => {
      window.removeEventListener(
        "alphaclaw:pairings-changed",
        handlePairingsChanged,
      );
    };
  }, [agentId, load]);

  const configuredChannels = useMemo(
    () =>
      channels.filter(
        (entry) =>
          String(entry?.channel || "").trim() &&
          Array.isArray(entry?.accounts) &&
          entry.accounts.length > 0,
      ),
    [channels],
  );

  const configuredChannelMap = useMemo(
    () =>
      new Map(
        configuredChannels.map((entry) => [
          String(entry.channel || "").trim(),
          entry,
        ]),
      ),
    [configuredChannels],
  );

  const openCreateChannelModal = (channelId = "") => {
    setMenuOpenId("");
    setCreateProvider(String(channelId || "").trim());
    setShowCreateModal(true);
  };

  const openEditChannelModal = (account) => {
    setMenuOpenId("");
    setEditingAccount(account);
  };

  const openDeleteChannelDialog = (account) => {
    setMenuOpenId("");
    setDeletingAccount(account);
  };

  const handleCreateChannel = async (payload) => {
    setSaving(true);
    setCreateLoadingLabel("Creating...");
    try {
      const result = await createChannelAccountWithProgress({
        payload,
        onPhase: (label) => {
          setCreateLoadingLabel(String(label || "").trim() || "Creating...");
        },
      });
      announceBindingsChanged(
        String(result?.binding?.agentId || payload.agentId || "").trim(),
      );
      showToast("Channel added", "success");
      await load({ includeStatus: false });
      setShowCreateModal(false);
      setCreateProvider("");
    } catch (error) {
      showToast(error.message || "Could not add channel", "error");
    } finally {
      setSaving(false);
      setCreateLoadingLabel("Creating...");
    }
  };

  const handleUpdateChannel = async (payload) => {
    setSaving(true);
    try {
      const result = await updateChannelAccount(payload);
      setEditingAccount(null);
      announceBindingsChanged(String(payload.agentId || "").trim());
      showToast("Channel updated", "success");
      if (result?.restartRequired) {
        announceRestartRequired();
      }
      await load();
    } catch (error) {
      showToast(error.message || "Could not update channel", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteChannel = async () => {
    if (!deletingAccount) return;
    setSaving(true);
    try {
      await deleteChannelAccount({
        provider: deletingAccount.provider,
        accountId: deletingAccount.id,
      });
      setDeletingAccount(null);
      announceBindingsChanged(agentId);
      showToast("Channel deleted", "success");
      await load({ includeStatus: false });
    } catch (error) {
      showToast(error.message || "Could not delete channel", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleQuickBind = async (account) => {
    if (!account || saving) return;
    setSaving(true);
    setPendingBindKey(
      `${String(account.provider || "").trim()}:${String(account.id || "").trim() || "default"}`,
    );
    try {
      await updateChannelAccount({
        provider: account.provider,
        accountId: account.id,
        name: account.name,
        agentId,
      });
      setMenuOpenId("");
      setPendingBindAccount(null);
      announceBindingsChanged(agentId);
      showToast("Channel bound", "success");
      await load();
    } catch (error) {
      showToast(error.message || "Could not bind channel", "error");
    } finally {
      setSaving(false);
      setPendingBindKey("");
    }
  };

  const requestBindAccount = (account) => {
    if (!account) return;
    const ownerAgentId = String(account?.ownerAgentId || "").trim();
    const ownerAgentName = String(account?.ownerAgentName || "").trim();
    if (ownerAgentId && ownerAgentId !== agentId && ownerAgentName) {
      setMenuOpenId("");
      setPendingBindAccount(account);
      return;
    }
    handleQuickBind(account);
  };

  return {
    agentId,
    agentNameMap,
    channelStatus,
    channels,
    configuredChannelMap,
    configuredChannels,
    createLoadingLabel,
    createProvider,
    defaultAgentId,
    deletingAccount,
    editingAccount,
    handleCreateChannel,
    handleDeleteChannel,
    handleQuickBind,
    handleUpdateChannel,
    isDefaultAgent,
    loadError,
    loading,
    menuOpenId,
    openCreateChannelModal,
    openDeleteChannelDialog,
    openEditChannelModal,
    pendingBindAccount,
    pendingBindKey,
    refreshing,
    requestBindAccount,
    retryLoad,
    saving,
    setCreateProvider,
    setDeletingAccount,
    setEditingAccount,
    setMenuOpenId,
    setPendingBindAccount,
    setShowCreateModal,
    showCreateModal,
  };
};
