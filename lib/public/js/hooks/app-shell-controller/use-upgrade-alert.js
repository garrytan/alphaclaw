import { useRef } from "preact/hooks";
import { fetchUpgradeStatus } from "../../lib/api.js";
import { usePolling } from "../usePolling.js";

// The upgrade alert changes only on a Doctor run or an admin action (both
// refresh it explicitly); the poll is the slow safety net.
const kUpgradeStatusPollMs = 60_000;

// The OpenClaw data upgrade alert: one shared read (the alert, the
// Gateway card pointer and the banner all hydrate from this cache key).
export const useUpgradeAlert = ({ onboarded }) => {
  const upgradeStatusPoll = usePolling(fetchUpgradeStatus, kUpgradeStatusPollMs, {
    enabled: onboarded === true,
    cacheKey: "/api/openclaw/upgrade-status",
  });
  const upgradeAlertRef = useRef(null);
  {
    const alert = upgradeStatusPoll.data?.alert || null;
    const previous = upgradeAlertRef.current;
    if (!alert) upgradeAlertRef.current = null;
    else if (previous?.kind !== alert.kind || previous?.headline !== alert.headline) {
      upgradeAlertRef.current = { kind: alert.kind, headline: alert.headline };
    }
  }
  return {
    upgradeAlert: upgradeAlertRef.current,
    refreshUpgradeStatus: () => upgradeStatusPoll.refresh({ force: true }),
  };
};
