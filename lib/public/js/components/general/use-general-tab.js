import { useEffect, useRef, useState } from "preact/hooks";
import {
  approveDevice,
  approvePairing,
  fetchDashboardUrl,
  fetchDevicePairings,
  fetchPairings,
  rejectDevice,
  rejectPairing,
  triggerWatchdogRepair,
  updateOpenAiCompatApiFeature,
  updateSyncCron,
} from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  kOpenAiCompatApiFeatureCacheKey,
} from "../../lib/storage-keys.js";
import { showToast } from "../toast.js";
import { ALL_CHANNELS } from "../channels.js";

const kDefaultSyncCronSchedule = "0 * * * *";
// After a successful API-toggle save, ignore disagreeing status frames for
// this long — an SSE/poll frame generated pre-PUT can land post-success and
// would otherwise clobber the committed value.
const kOpenAiCompatApiConfirmWindowMs = 5000;

const readCachedOpenAiCompatApi = () => {
  try {
    const rawValue = window.localStorage.getItem(kOpenAiCompatApiFeatureCacheKey);
    if (rawValue === "true") return { enabled: true, hydrated: true };
    if (rawValue === "false") return { enabled: false, hydrated: true };
  } catch {}
  return { enabled: false, hydrated: false };
};

const writeCachedOpenAiCompatApi = (enabled) => {
  try {
    window.localStorage.setItem(
      kOpenAiCompatApiFeatureCacheKey,
      enabled ? "true" : "false",
    );
  } catch {}
};

export const useGeneralTab = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  onRefreshStatuses = () => {},
  isActive = false,
  restartSignal = 0,
} = {}) => {
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [repairingWatchdog, setRepairingWatchdog] = useState(false);
  const [syncCronEnabled, setSyncCronEnabled] = useState(true);
  const [syncCronSchedule, setSyncCronSchedule] = useState(kDefaultSyncCronSchedule);
  const [savingSyncCron, setSavingSyncCron] = useState(false);
  const [syncCronChoice, setSyncCronChoice] = useState(kDefaultSyncCronSchedule);
  const [syncCronError, setSyncCronError] = useState(null);
  const [cachedOpenAiCompatApi] = useState(readCachedOpenAiCompatApi);
  const [openAiCompatApiEnabled, setOpenAiCompatApiEnabled] = useState(
    cachedOpenAiCompatApi.enabled,
  );
  const [openAiCompatApiHydrated, setOpenAiCompatApiHydrated] = useState(
    cachedOpenAiCompatApi.hydrated,
  );
  const [savingOpenAiCompatApi, setSavingOpenAiCompatApi] = useState(false);
  const [openAiCompatApiError, setOpenAiCompatApiError] = useState(null);
  const [pairingStatusRefreshing, setPairingStatusRefreshing] = useState(false);
  const [devicePollingEnabled, setDevicePollingEnabled] = useState(false);
  const [cliAutoApproveComplete, setCliAutoApproveComplete] = useState(false);
  const pairingRefreshTimerRef = useRef(null);
  // Sync effects must not clobber an in-flight optimistic write; refs (not
  // state) so the effects read the live value without widening their deps.
  const savingSyncCronRef = useRef(false);
  const savingOpenAiCompatApiRef = useRef(false);
  // { value, untilMs } — set after a successful API-toggle save; cleared once
  // a status frame confirms the value or the window lapses.
  const openAiCompatApiConfirmRef = useRef(null);

  const status = statusData;
  const watchdogStatus = watchdogData;
  const doctorStatus = doctorStatusData;
  const gatewayStatus = status?.gateway ?? null;
  const channels = status?.channels ?? null;
  const repo = status?.repo || null;
  const syncCron = status?.syncCron || null;
  const openAiCompatApi = status?.alphaclaw?.features?.openaiCompatApi || null;
  const hasOpenAiCompatApiStatus = typeof openAiCompatApi?.enabled === "boolean";
  const openclawVersion = status?.openclawVersion || null;

  const hasUnpaired = ALL_CHANNELS.some((channel) => {
    const info = channels?.[channel];
    if (!info) return false;
    const accounts =
      info.accounts && typeof info.accounts === "object" ? info.accounts : {};
    if (Object.keys(accounts).length > 0) {
      return Object.values(accounts).some(
        (acc) => acc && acc.status !== "paired",
      );
    }
    return info.status !== "paired";
  });
  const hasConfiguredPairingChannel = ALL_CHANNELS.some((channel) =>
    Boolean(channels?.[channel]),
  );

  const pairingsPoll = usePolling(
    async () => {
      const data = await fetchPairings();
      return data.pending || [];
    },
    3000,
    {
      enabled: hasConfiguredPairingChannel && gatewayStatus === "running",
      cacheKey: "/api/pairings",
      dedupeInFlight: true,
    },
  );
  const pending = pairingsPoll.data || [];
  const shouldPollDevices =
    gatewayStatus === "running" && (devicePollingEnabled || !cliAutoApproveComplete);

  const devicePoll = usePolling(
    async () => {
      const data = await fetchDevicePairings();
      setCliAutoApproveComplete(data?.cliAutoApproveComplete === true);
      return data.pending || [];
    },
    5000,
    {
      enabled: shouldPollDevices,
      cacheKey: "/api/devices",
    },
  );
  const devicePending = devicePoll.data || [];

  // Refs so the restart burst reads live flags inside its timeouts without
  // the effect depending on them — polling-flag flips must not refire (or
  // truncate) an already-handled burst.
  const shouldPollDevicesRef = useRef(shouldPollDevices);
  shouldPollDevicesRef.current = shouldPollDevices;
  const onRefreshStatusesRef = useRef(onRefreshStatuses);
  onRefreshStatusesRef.current = onRefreshStatuses;
  const lastHandledRestartSignalRef = useRef(0);

  useEffect(() => {
    if (!restartSignal || !isActive) return;
    if (lastHandledRestartSignalRef.current === restartSignal) return;
    lastHandledRestartSignalRef.current = restartSignal;
    const refreshBurst = ({ force = false } = {}) => {
      onRefreshStatusesRef.current();
      pairingsPoll.refresh(force ? { force: true } : undefined);
      if (shouldPollDevicesRef.current) {
        devicePoll.refresh();
      }
    };
    refreshBurst({ force: true });
    const t1 = setTimeout(() => refreshBurst(), 1200);
    const t2 = setTimeout(() => refreshBurst(), 3500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [devicePoll.refresh, isActive, pairingsPoll.refresh, restartSignal]);

  useEffect(() => {
    if (!syncCron) return;
    // A status frame arriving mid-save must not clobber the optimistic value.
    if (savingSyncCronRef.current) return;
    setSyncCronEnabled(syncCron.enabled !== false);
    setSyncCronSchedule(syncCron.schedule || kDefaultSyncCronSchedule);
    setSyncCronChoice(
      syncCron.enabled === false ? "disabled" : syncCron.schedule || kDefaultSyncCronSchedule,
    );
  }, [syncCron?.enabled, syncCron?.schedule]);

  useEffect(() => {
    if (!hasOpenAiCompatApiStatus) return;
    if (savingOpenAiCompatApiRef.current) return;
    const nextEnabled = openAiCompatApi.enabled === true;
    const confirm = openAiCompatApiConfirmRef.current;
    if (confirm) {
      if (nextEnabled !== confirm.value && Date.now() < confirm.untilMs) {
        // Pre-PUT frame landing post-success — keep the committed value.
        return;
      }
      openAiCompatApiConfirmRef.current = null;
    }
    setOpenAiCompatApiEnabled(nextEnabled);
    setOpenAiCompatApiHydrated(true);
    writeCachedOpenAiCompatApi(nextEnabled);
  }, [hasOpenAiCompatApiStatus, openAiCompatApi?.enabled]);

  useEffect(
    () => () => {
      if (pairingRefreshTimerRef.current) {
        clearTimeout(pairingRefreshTimerRef.current);
      }
    },
    [],
  );

  const refreshAfterPairingAction = () => {
    setPairingStatusRefreshing(true);
    if (pairingRefreshTimerRef.current) {
      clearTimeout(pairingRefreshTimerRef.current);
    }
    pairingRefreshTimerRef.current = setTimeout(() => {
      setPairingStatusRefreshing(false);
      pairingRefreshTimerRef.current = null;
    }, 2800);
    onRefreshStatuses();
    pairingsPoll.refresh({ force: true });
    setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 700);
    setTimeout(() => {
      onRefreshStatuses();
      pairingsPoll.refresh();
    }, 1800);
  };

  const handleSyncCronChoiceChange = async (nextChoice) => {
    if (savingSyncCron) return;
    const previous = {
      enabled: syncCronEnabled,
      schedule: syncCronSchedule,
      choice: syncCronChoice,
    };
    const nextEnabled = nextChoice !== "disabled";
    const nextSchedule = nextEnabled ? nextChoice : syncCronSchedule;
    setSyncCronError(null);
    setSyncCronChoice(nextChoice);
    setSyncCronEnabled(nextEnabled);
    setSyncCronSchedule(nextSchedule);
    savingSyncCronRef.current = true;
    setSavingSyncCron(true);
    try {
      const data = await updateSyncCron({
        enabled: nextEnabled,
        schedule: nextSchedule,
      });
      if (!data.ok) {
        throw new Error(data.error || "Could not save sync settings");
      }
      showToast("Sync schedule updated", "success");
      onRefreshStatuses();
    } catch (err) {
      // Loud revert: restore ALL pre-optimistic values, not just the choice.
      setSyncCronEnabled(previous.enabled);
      setSyncCronSchedule(previous.schedule);
      setSyncCronChoice(previous.choice);
      setSyncCronError(err);
    } finally {
      savingSyncCronRef.current = false;
      setSavingSyncCron(false);
    }
  };

  const handleOpenAiCompatApiToggle = async (enabled) => {
    if (savingOpenAiCompatApi) return;
    const previousEnabled = openAiCompatApiEnabled;
    setOpenAiCompatApiError(null);
    setOpenAiCompatApiEnabled(enabled);
    savingOpenAiCompatApiRef.current = true;
    setSavingOpenAiCompatApi(true);
    try {
      const data = await updateOpenAiCompatApiFeature(enabled);
      if (!data.ok) {
        throw new Error(data.error || "Could not save API setting");
      }
      writeCachedOpenAiCompatApi(enabled);
      setOpenAiCompatApiHydrated(true);
      // Re-assert the confirmed value and hold off disagreeing status frames
      // until one confirms it (or the window lapses).
      setOpenAiCompatApiEnabled(enabled);
      openAiCompatApiConfirmRef.current = {
        value: enabled,
        untilMs: Date.now() + kOpenAiCompatApiConfirmWindowMs,
      };
      showToast(`API ${enabled ? "enabled" : "disabled"}`, "success");
      onRefreshStatuses();
    } catch (err) {
      setOpenAiCompatApiEnabled(previousEnabled);
      setOpenAiCompatApiError({ attempted: enabled, error: err });
    } finally {
      savingOpenAiCompatApiRef.current = false;
      setSavingOpenAiCompatApi(false);
    }
  };

  const handleApprove = async (id, channel, accountId = "") => {
    try {
      const result = await approvePairing(id, channel, accountId);
      if (!result.ok) throw new Error(result.error || "Could not approve pairing");
      refreshAfterPairingAction();
    } catch (err) {
      showToast(err.message || "Could not approve pairing", "error");
      throw err;
    }
  };

  const handleReject = async (id, channel, accountId = "") => {
    try {
      await rejectPairing(id, channel, accountId);
      refreshAfterPairingAction();
    } catch (err) {
      showToast(err.message || "Could not reject pairing", "error");
      throw err;
    }
  };

  const handleDeviceApprove = async (id) => {
    try {
      await approveDevice(id);
      showToast("Device pairing approved", "success");
      setTimeout(devicePoll.refresh, 500);
      setTimeout(devicePoll.refresh, 2000);
    } catch (err) {
      showToast(err.message || "Could not approve device pairing", "error");
      throw err;
    }
  };

  const handleDeviceReject = async (id) => {
    try {
      await rejectDevice(id);
      showToast("Device pairing rejected", "info");
      setTimeout(devicePoll.refresh, 500);
      setTimeout(devicePoll.refresh, 2000);
    } catch (err) {
      showToast(err.message || "Could not reject device pairing", "error");
      throw err;
    }
  };

  const handleWatchdogRepair = async () => {
    if (repairingWatchdog) return;
    setRepairingWatchdog(true);
    try {
      const data = await triggerWatchdogRepair();
      if (!data.ok) throw new Error(data.error || "Repair failed");
      showToast("Repair triggered", "success");
      setTimeout(() => {
        onRefreshStatuses();
      }, 800);
    } catch (err) {
      showToast(err.message || "Could not run repair", "error");
    } finally {
      setRepairingWatchdog(false);
    }
  };

  const handleOpenDashboard = async () => {
    if (dashboardLoading) return;
    setDevicePollingEnabled(true);
    setDashboardLoading(true);
    try {
      const data = await fetchDashboardUrl();
      if (data.needsAuth) {
        showToast(
          "OpenClaw dashboard token is missing from the AlphaClaw server environment",
          "warning",
        );
      }
      window.open(data.url || "/openclaw", "_blank");
    } catch (err) {
      showToast(err.message || "Could not open OpenClaw dashboard", "error");
      window.open("/openclaw", "_blank");
    } finally {
      setDashboardLoading(false);
    }
  };

  return {
    state: {
      channels,
      dashboardLoading,
      devicePending,
      doctorStatus,
      gatewayStatus,
      hasUnpaired,
      openclawVersion,
      openAiCompatApi: {
        ...(openAiCompatApi || {}),
        enabled: openAiCompatApiEnabled,
        hydrated: openAiCompatApiHydrated,
      },
      openAiCompatApiError,
      pending,
      pairingsPolling: pairingsPoll.isPolling,
      pairingStatusRefreshing,
      repairingWatchdog,
      repo,
      savingSyncCron,
      savingOpenAiCompatApi,
      syncCron,
      syncCronChoice,
      syncCronError,
      syncCronEnabled,
      syncCronSchedule,
      syncCronStatusText: syncCronEnabled ? "Enabled" : "Disabled",
      watchdogStatus,
    },
    actions: {
      handleApprove,
      handleDeviceApprove,
      handleDeviceReject,
      handleOpenDashboard,
      handleOpenAiCompatApiToggle,
      handleReject,
      handleSyncCronChoiceChange,
      handleWatchdogRepair,
    },
  };
};
