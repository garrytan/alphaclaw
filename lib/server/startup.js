const runOnboardedBootSequence = ({
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  ensureWebhookMappingIds,
  doSyncPromptFiles,
  reloadEnv,
  syncChannelConfig,
  readEnvFile,
  ensureGatewayProxyConfig,
  resolveSetupUrl,
  startGateway,
  watchdog,
  gmailWatchService,
  primeStatusCaches = () => {},
}) => {
  try {
    ensureManagedExecDefaults();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure managed exec defaults on boot: ${error.message}`,
    );
  }
  try {
    ensureUsageTrackerPluginConfig();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure usage-tracker plugin config on boot: ${error.message}`,
    );
  }
  try {
    const result = ensureWebhookMappingIds();
    if (result?.changed) {
      console.log(
        `[alphaclaw] Added IDs to webhook mappings: ${result.updatedIds.join(", ")}`,
      );
    }
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure webhook mapping IDs on boot: ${error.message}`,
    );
  }
  doSyncPromptFiles();
  reloadEnv();
  // Channel sync and gateway start both queue on the gateway lifecycle lock
  // (FIFO), so the sync completes before the gateway launches — boot ordering
  // is preserved without blocking the boot tick.
  try {
    void Promise.resolve(syncChannelConfig(readEnvFile())).catch((error) => {
      console.error(`[alphaclaw] Boot channel sync failed: ${error.message}`);
    });
  } catch (error) {
    // readEnvFile (argument evaluation) throws synchronously — must not
    // abort the rest of the boot sequence.
    console.error(`[alphaclaw] Boot channel sync failed: ${error.message}`);
  }
  ensureGatewayProxyConfig(resolveSetupUrl());
  void Promise.resolve(startGateway()).catch((error) => {
    console.error(`[alphaclaw] Boot gateway start failed: ${error.message}`);
  });
  watchdog.start();
  gmailWatchService.start();
  try {
    primeStatusCaches();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to prime status caches on boot: ${error.message}`,
    );
  }
};

module.exports = {
  runOnboardedBootSequence,
};
