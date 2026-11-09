import { useState, useCallback } from "preact/hooks";
import { useManagedUpdateAttempt } from "../use-managed-update-attempt.js";
import { showToast } from "../../components/toast.js";

// AlphaClaw's own version and the Update action: a managed deployment is
// recorded and left to the provider; a self-update restarts AlphaClaw and
// reconnects once it answers again.
export const useAlphaclawUpdate = ({ onboarded, identityRole, beginAlphaclawReconnect }) => {
  const acManagedUpdate = useManagedUpdateAttempt({ enabled: onboarded === true, identityRole });
  const [acUpdating, setAcUpdating] = useState(false);

  const handleAcUpdate = useCallback(async () => {
    if (acUpdating || acManagedUpdate.disabled) return;
    const data = await acManagedUpdate.submit();
    if (!data) return;
    if (data.managedUpdate || data.managedUpdateAttempt) {
      showToast("Deployment request recorded — check the provider for its outcome", "info");
      return;
    }
    if (data.restarting === true) {
      setAcUpdating(true);
      showToast("AlphaClaw updated — restarting…", "success");
      beginAlphaclawReconnect({ graceMs: 5000 });
    }
  }, [acUpdating, acManagedUpdate.disabled, acManagedUpdate.submit, beginAlphaclawReconnect]);

  return {
    acHasUpdate: Boolean(acManagedUpdate.version?.hasUpdate),
    acLatest: acManagedUpdate.version?.latestVersion || null,
    acLatestOpenclawVersion: acManagedUpdate.version?.latestOpenclawVersion || null,
    acCurrentOpenclawVersion: acManagedUpdate.version?.currentOpenclawVersion || null,
    acUpdateStrategy: acManagedUpdate.version?.updateStrategy || null,
    acManagedUpdate,
    acUpdating: acUpdating || acManagedUpdate.submitting,
    acVersion: acManagedUpdate.version?.currentVersion || null,
    handleAcUpdate,
  };
};
