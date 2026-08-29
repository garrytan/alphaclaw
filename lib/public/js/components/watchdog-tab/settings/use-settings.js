import { useEffect, useState } from "preact/hooks";
import { useSavedSetting } from "../../../hooks/use-saved-setting.js";
import {
  fetchWatchdogSettings,
  resumeWatchdogChannels,
  triggerWatchdogRepair,
  updateWatchdogSettings,
} from "../../../lib/api.js";
import { showToast } from "../../toast.js";

export const kWatchdogSettingsCacheKey = "/api/watchdog/settings";
export const kAutoRepairContext = "autoRepair";
export const kNotificationsContext = "notifications";

const kWatchdogSettingsDefaults = {
  autoRepair: false,
  notificationsEnabled: true,
};

// Server omissions fall back to the documented defaults; a FAILED load never
// reaches this (the hook surfaces loadError instead of a fabricated doc).
const normalizeWatchdogSettings = (doc) => ({
  ...kWatchdogSettingsDefaults,
  ...(doc || {}),
});

// Chip headlines after a failed/unconfirmed save — the hook reconciles with a
// fresh GET, so the copy promises server truth rather than asserting a state.
export const describeAutoRepairSaveError = (attempted) =>
  `Couldn't confirm ${attempted?.autoRepair ? "enabling" : "disabling"} auto-repair — showing the server's current state.`;

export const describeNotificationsSaveError = (attempted) =>
  `Couldn't confirm ${attempted?.notificationsEnabled ? "enabling" : "disabling"} notifications — showing the server's current state.`;

export const useWatchdogSettings = ({
  watchdogStatus = null,
  onRefreshStatuses = () => {},
  onRefreshIncidents = () => {},
} = {}) => {
  // ONE document-level hook: auto-repair and notifications share a single
  // GET/PUT settings doc, so each toggle commits a merged doc tagged with its
  // own context (never one hook per field against the same endpoint).
  const settingsDoc = useSavedSetting({
    cacheKey: kWatchdogSettingsCacheKey,
    // The GET envelope is unwrapped here so select stays identity — the
    // hook's value IS the settings document both controls share.
    load: async () =>
      normalizeWatchdogSettings((await fetchWatchdogSettings())?.settings),
    select: (doc) => doc,
    selectSaved: (response) =>
      response?.settings ? normalizeWatchdogSettings(response.settings) : undefined,
    // The settings PUT patches per-field server-side, so each save sends ONLY
    // the field its context changed — a stale local copy of the sibling field
    // (second tab, CLI) is never written back. selectSaved then adopts the
    // returned full doc, converging the sibling to server truth too.
    save: (next, { context } = {}) =>
      updateWatchdogSettings(
        context === kAutoRepairContext
          ? { autoRepair: next.autoRepair }
          : context === kNotificationsContext
            ? { notificationsEnabled: next.notificationsEnabled }
            : next,
      ),
    onSaved: () => onRefreshStatuses(),
    label: "watchdog settings",
  });
  // Optimistic display of a just-saved auto-repair value: beats a stale
  // (≤2s old) SSE frame until the stream agrees (see below).
  const [pendingAutoRepair, setPendingAutoRepair] = useState(null);
  const [repairing, setRepairing] = useState(false);
  const [resumingChannels, setResumingChannels] = useState(false);
  const isRepairInProgress =
    repairing || !!(watchdogStatus || {})?.operationInProgress;

  const onToggleAutoRepair = async (nextValue) => {
    setPendingAutoRepair(nextValue === true);
    const outcome = await settingsDoc.commit(
      (current) => ({
        ...normalizeWatchdogSettings(current),
        autoRepair: nextValue === true,
      }),
      { context: kAutoRepairContext },
    );
    // Failure feedback is the SavedToggle's inline chip (loud revert +
    // reconcile) — toasts are for successes only.
    if (outcome.ok) {
      showToast(`Auto-repair ${nextValue ? "enabled" : "disabled"}`, "success");
    } else {
      // Revert with the doc — the display must snap back with the chip.
      setPendingAutoRepair(null);
    }
  };

  const onToggleNotifications = async (nextValue) => {
    const outcome = await settingsDoc.commit(
      (current) => ({
        ...normalizeWatchdogSettings(current),
        notificationsEnabled: nextValue === true,
      }),
      { context: kNotificationsContext },
    );
    if (outcome.ok) {
      showToast(
        `Notifications ${nextValue ? "enabled" : "disabled"}`,
        "success",
      );
    }
  };

  const onRepair = async () => {
    if (isRepairInProgress) return;
    setRepairing(true);
    try {
      const data = await triggerWatchdogRepair();
      if (!data.ok) throw new Error(data.error || "Repair failed");
      showToast("Repair triggered", "success");
      setTimeout(() => {
        onRefreshStatuses();
        onRefreshIncidents();
      }, 800);
    } catch (error) {
      showToast(error.message || "Could not run repair", "error");
    } finally {
      setRepairing(false);
    }
  };

  const onResumeChannels = async () => {
    if (resumingChannels) return;
    setResumingChannels(true);
    try {
      const data = await resumeWatchdogChannels();
      if (!data.ok) throw new Error(data.error || "Resume failed");
      showToast("Channels resuming", "success");
      setTimeout(() => {
        onRefreshStatuses();
        onRefreshIncidents();
      }, 800);
    } catch (error) {
      showToast(error.message || "Could not resume channels", "error");
    } finally {
      setResumingChannels(false);
    }
  };

  // The SSE status carries the live autoRepair value every 2s; prefer it over
  // the one-shot mount fetch so an env change or second browser tab can't
  // leave the toggle showing stale state. notificationsEnabled is not in the
  // status payload, so it stays from the settings fetch. A just-saved value
  // wins over a stale SSE frame (up to ~2s old) until the stream agrees —
  // otherwise the toggle visibly snaps back right after a successful save.
  const sseAutoRepair =
    typeof watchdogStatus?.autoRepair === "boolean"
      ? watchdogStatus.autoRepair
      : null;
  useEffect(() => {
    if (pendingAutoRepair !== null && sseAutoRepair === pendingAutoRepair) {
      setPendingAutoRepair(null);
    }
  }, [pendingAutoRepair, sseAutoRepair]);
  // `settings` stays {} until hydrated — consumers gate on settingsHydrated
  // instead of ever treating the defaults as fact. autoRepair display order:
  // just-saved value > live SSE frame > the fetched doc.
  const settingsValue = settingsDoc.value || {};
  const settings = {
    ...settingsValue,
    autoRepair:
      pendingAutoRepair !== null
        ? pendingAutoRepair
        : sseAutoRepair !== null
          ? sseAutoRepair
          : settingsValue.autoRepair,
  };

  return {
    settings,
    settingsHydrated: settingsDoc.hydrated,
    savingSettings: settingsDoc.saving,
    savingSettingsContext: settingsDoc.savingContext,
    settingsSaveError: settingsDoc.saveError,
    settingsLoadError: settingsDoc.loadError,
    onRetryLoadSettings: settingsDoc.retryLoad,
    isRepairInProgress,
    onToggleAutoRepair,
    onToggleNotifications,
    onRepair,
    onResumeChannels,
    resumingChannels,
  };
};
