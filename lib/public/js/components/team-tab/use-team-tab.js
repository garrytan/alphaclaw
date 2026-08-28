import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  approveDevice,
  createTeamInvite,
  disableTeam,
  enableTeam,
  fetchDashboardUrl,
  fetchDevicePairings,
  fetchTeam,
  fetchTeamPresence,
  rejectDevice,
  removeTeamMember,
  revokeTeamInvite,
  updateTeamMember,
} from "../../lib/api.js";
import { showToast } from "../toast.js";

const kPresencePollMs = 10_000;

export const useTeamTab = ({ onRefreshStatuses = () => {} } = {}) => {
  const [team, setTeam] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  // D4: presence renders one of roster / "No one online" / "Presence
  // unavailable" — never a hidden card that reads as "nobody here".
  const [presenceUnavailable, setPresenceUnavailable] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState(null);
  const [enableResult, setEnableResult] = useState(null);
  const [creatingInvite, setCreatingInvite] = useState(false);
  // The raw invite token is shown exactly once, straight from the create
  // response — the server only stores its hash.
  const [freshInvite, setFreshInvite] = useState(null);
  const [busyMemberId, setBusyMemberId] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchTeam();
      setTeam(data);
      setLoadError(null);
      setPresenceUnavailable(false);
      return data;
    } catch (err) {
      setLoadError(err?.message || "Could not load team status");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // 10s presence poll while the tab is mounted and team is enabled.
  useEffect(() => {
    if (!team?.enabled) return undefined;
    const timerId = setInterval(async () => {
      try {
        const data = await fetchTeamPresence();
        if (!mountedRef.current) return;
        setTeam((current) =>
          current ? { ...current, presence: data.presence || [] } : current,
        );
        setPresenceUnavailable(false);
      } catch {
        if (mountedRef.current) setPresenceUnavailable(true);
      }
    }, kPresencePollMs);
    return () => clearInterval(timerId);
  }, [team?.enabled]);

  // D6: pending device approvals surface on the Team page as an action queue
  // (admin only — /api/devices is admin-scoped by the route matrix).
  const [devicePending, setDevicePending] = useState([]);
  const isAdmin = team?.me?.role === "admin";
  const refreshDevices = useCallback(async () => {
    if (!isAdmin || !team?.enabled) return;
    try {
      const data = await fetchDevicePairings();
      if (mountedRef.current) {
        setDevicePending(Array.isArray(data?.pending) ? data.pending : []);
      }
    } catch {}
  }, [isAdmin, team?.enabled]);

  useEffect(() => {
    if (!isAdmin || !team?.enabled) return undefined;
    refreshDevices();
    const timerId = setInterval(refreshDevices, kPresencePollMs);
    return () => clearInterval(timerId);
  }, [isAdmin, team?.enabled, refreshDevices]);

  const onApproveDevice = useCallback(
    async (id) => {
      try {
        await approveDevice(id);
        showToast("Device approved inside OpenClaw", "success");
        setTimeout(refreshDevices, 500);
      } catch (err) {
        showToast(err?.message || "Could not approve the device", "error");
        throw err;
      }
    },
    [refreshDevices],
  );

  const onRejectDevice = useCallback(
    async (id) => {
      try {
        await rejectDevice(id);
        showToast("Device rejected", "success");
        setTimeout(refreshDevices, 500);
      } catch (err) {
        showToast(err?.message || "Could not reject the device", "error");
        throw err;
      }
    },
    [refreshDevices],
  );

  // Open Control UI: admins get the token-bearing dashboard URL; members use
  // the plain proxied path — trusted-proxy identity signs them in, and the
  // gateway token must never reach a member.
  const onOpenControlUi = useCallback(async () => {
    let url = "/openclaw";
    if (isAdmin) {
      try {
        const data = await fetchDashboardUrl();
        url = String(data?.url || "/openclaw");
      } catch {}
    }
    try {
      window.open(url, "_blank", "noopener");
    } catch {}
  }, [isAdmin]);

  const onEnable = useCallback(
    async (payload) => {
      setEnabling(true);
      setEnableError(null);
      try {
        const result = await enableTeam(payload);
        setEnableResult(result);
        await load();
        onRefreshStatuses();
        return result;
      } catch (err) {
        setEnableError({
          message: err?.message || "Could not enable team access",
          code: err?.code || null,
          hint: err?.hint || null,
        });
        return null;
      } finally {
        setEnabling(false);
      }
    },
    [load, onRefreshStatuses],
  );

  const closeWizard = useCallback(() => {
    setWizardOpen(false);
    setEnableError(null);
    setEnableResult(null);
  }, []);

  const onCreateInvite = useCallback(
    async ({ email, role }) => {
      setCreatingInvite(true);
      try {
        const result = await createTeamInvite({ email: email || null, role });
        setFreshInvite(result);
        await load();
      } catch (err) {
        showToast(err?.message || "Could not create the invite", "error");
      } finally {
        setCreatingInvite(false);
      }
    },
    [load],
  );

  const onRevokeInvite = useCallback(
    async (inviteId) => {
      try {
        await revokeTeamInvite(inviteId);
        setFreshInvite((current) =>
          current?.invite?.id === inviteId ? null : current,
        );
        await load();
        showToast("Invite revoked", "success");
      } catch (err) {
        showToast(err?.message || "Could not revoke the invite", "error");
      }
    },
    [load],
  );

  const onUpdateMember = useCallback(
    async (memberId, payload) => {
      setBusyMemberId(memberId);
      try {
        await updateTeamMember(memberId, payload);
        await load();
        onRefreshStatuses();
        return true;
      } catch (err) {
        showToast(err?.message || "Could not update the member", "error");
        return false;
      } finally {
        setBusyMemberId(null);
      }
    },
    [load, onRefreshStatuses],
  );

  const onRemoveMember = useCallback(
    async (memberId) => {
      setBusyMemberId(memberId);
      try {
        await removeTeamMember(memberId);
        await load();
        onRefreshStatuses();
        return true;
      } catch (err) {
        showToast(err?.message || "Could not remove the member", "error");
        return false;
      } finally {
        setBusyMemberId(null);
      }
    },
    [load, onRefreshStatuses],
  );

  const onDisableTeam = useCallback(async () => {
    try {
      await disableTeam();
      await load();
      onRefreshStatuses();
      showToast(
        "Team access disabled — the previous login mode is restored after restart",
        "success",
      );
      return true;
    } catch (err) {
      showToast(err?.message || "Could not disable team access", "error");
      return false;
    }
  }, [load, onRefreshStatuses]);

  // D10: destructive actions run through one confirm pipeline with a
  // consequence preview supplied by the caller.
  const requestConfirm = useCallback((action) => setConfirmAction(action), []);
  const cancelConfirm = useCallback(() => setConfirmAction(null), []);
  const runConfirm = useCallback(async () => {
    if (!confirmAction) return;
    setConfirmBusy(true);
    try {
      await confirmAction.run();
      setConfirmAction(null);
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmAction]);

  return {
    team,
    loading,
    loadError,
    presenceUnavailable,
    reload: load,
    wizardOpen,
    setWizardOpen,
    closeWizard,
    enabling,
    enableError,
    enableResult,
    onEnable,
    creatingInvite,
    freshInvite,
    setFreshInvite,
    onCreateInvite,
    onRevokeInvite,
    busyMemberId,
    onUpdateMember,
    onRemoveMember,
    onDisableTeam,
    confirmAction,
    confirmBusy,
    requestConfirm,
    cancelConfirm,
    runConfirm,
    devicePending,
    onApproveDevice,
    onRejectDevice,
    onOpenControlUi,
  };
};
