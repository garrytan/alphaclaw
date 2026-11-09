import { useCallback } from "preact/hooks";
import { useAuthBootstrap } from "./app-shell-controller/use-auth-bootstrap.js";
import { useConnectivity } from "./app-shell-controller/use-connectivity.js";
import { useStatusFeed } from "./app-shell-controller/use-status-feed.js";
import { useUpgradeAlert } from "./app-shell-controller/use-upgrade-alert.js";
import { useRestartOperation } from "./app-shell-controller/use-restart-operation.js";
import { useAlphaclawUpdate } from "./app-shell-controller/use-alphaclaw-update.js";
import { useGatewayShellPublisher } from "./app-shell-controller/use-gateway-shell-publisher.js";

export { kFailedOutcomeRetireAfterRunningMs } from "./app-shell-controller/restart-operation-model.js";

// The app shell's state and actions, composed from the hooks in
// app-shell-controller/ (one per concern). It also publishes the
// gateway-facing slice to gatewayShellStore for the Gateway card and banner.
export const useAppShellController = ({ location = "" } = {}) => {
  const auth = useAuthBootstrap();
  const { onboarded, identityRole } = auth;
  const connectivity = useConnectivity({ onboarded });
  const statusFeed = useStatusFeed({ location, onboarded, connectivity });
  const { sharedStatus, refreshSharedStatuses } = statusFeed;
  const upgradeAlert = useUpgradeAlert({ onboarded });
  const restart = useRestartOperation({
    location,
    onboarded,
    sharedStatus,
    refreshSharedStatuses,
    refreshUpgradeStatus: upgradeAlert.refreshUpgradeStatus,
  });
  const update = useAlphaclawUpdate({
    onboarded,
    identityRole,
    beginAlphaclawReconnect: connectivity.beginAlphaclawReconnect,
  });

  const handleRetryConnect = useCallback(() => {
    if (!connectivity.retry()) statusFeed.reconnect();
  }, [connectivity.retry, statusFeed.reconnect]);

  useGatewayShellPublisher(() => ({
    actions: {
      restart: restart.handleGatewayRestart,
      refresh: async () => {
        refreshSharedStatuses();
        await restart.refreshRestartStatus();
      },
      resumeChannels: statusFeed.handleResumeChannels,
      dismissOutcome: restart.dismissRestartOutcome,
      dismissRestartBanner: restart.dismissRestartBanner,
      scheduleRestart: restart.scheduleRestart,
      cancelScheduledRestart: restart.cancelScheduledRestart,
      loadEvidence: restart.loadRestartEvidence,
      retryConnect: handleRetryConnect,
      openSetup: auth.handleOpenSetup,
      retryUpgrade: restart.handleUpgradeRetry,
      confirmWorkspaceMove: restart.handleConfirmWorkspaceMove,
      refreshUpgradeStatus: upgradeAlert.refreshUpgradeStatus,
    },
    state: {
      hasStatus: !!sharedStatus,
      statusState: sharedStatus?.state || null,
      legacyGatewayStatus: sharedStatus?.gateway || null,
      watchdogStatus: statusFeed.sharedWatchdogStatus,
      restartOperation: restart.restartOperation,
      restartNotice: restart.restartNotice,
      restartRequired: restart.isAnyRestartRequired,
      restartReasons: restart.restartReasons,
      restartSchedule: restart.restartSchedule,
      identityRole,
      upgradeAlert: upgradeAlert.upgradeAlert,
      bootProgress: sharedStatus?.bootProgress || null,
      bootReconnect: connectivity.bootReconnect,
      connectivityMode: connectivity.connectivityMode,
      lastFrameAtMs: statusFeed.lastStatusFrameAtRef.current || 0,
      statusFreshness: statusFeed.statusFreshness,
    },
  }));

  return {
    state: {
      acHasUpdate: update.acHasUpdate,
      acLatest: update.acLatest,
      acLatestOpenclawVersion: update.acLatestOpenclawVersion,
      acCurrentOpenclawVersion: update.acCurrentOpenclawVersion,
      acUpdateStrategy: update.acUpdateStrategy,
      acManagedUpdate: update.acManagedUpdate,
      acUpdating: update.acUpdating,
      acVersion: update.acVersion,
      authEnabled: auth.authEnabled,
      connectivityMode: connectivity.connectivityMode,
      gatewayRestartSignal: restart.gatewayRestartSignal,
      identityRole,
      isAnyRestartRequired: restart.isAnyRestartRequired,
      onboarded,
      restartOperation: restart.restartOperation,
      restartReasons: restart.restartReasons,
      restartingGateway: restart.restartingGateway,
      sharedDoctorStatus: statusFeed.sharedDoctorStatus,
      statusFreshness: statusFeed.statusFreshness,
      sharedStatus,
      sharedWatchdogStatus: statusFeed.sharedWatchdogStatus,
    },
    actions: {
      handleAcUpdate: update.handleAcUpdate,
      handleGatewayRestart: restart.handleGatewayRestart,
      handleOnboardingComplete: auth.handleOnboardingComplete,
      handleRetryConnect,
      refreshSharedStatuses,
      dismissRestartBanner: restart.dismissRestartBanner,
      dismissRestartOutcome: restart.dismissRestartOutcome,
      setRestartRequired: restart.setRestartRequired,
    },
  };
};
