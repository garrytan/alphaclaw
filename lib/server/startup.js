const { setBootPhase } = require("./boot-phase");

// Runs in the background after listen(): the server must answer requests
// while channels sync and the gateway launches (previously this chain of
// blocking spawns froze the event loop for up to minutes right after a
// restart — exactly when users ask "is it back?"). Callers fire-and-forget;
// boot progress is reported via boot-phase in the status snapshot.
const runOnboardedBootSequence = async ({
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
  acquireLifecycleLock = null,
}) => {
  setBootPhase("starting_gateway");
  // Boot mutates the same gateway/channel state the API routes do; hold the
  // lifecycle lock so an early API write cannot race the boot sequence.
  const release =
    typeof acquireLifecycleLock === "function"
      ? await acquireLifecycleLock("boot")
      : null;
  try {
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
    await syncChannelConfig(readEnvFile());
    ensureGatewayProxyConfig(resolveSetupUrl());
    await startGateway();
    watchdog.start();
    gmailWatchService.start();
    setBootPhase("ready");
  } catch (error) {
    setBootPhase("failed", { error });
    console.error(`[alphaclaw] Boot sequence failed: ${error.message}`);
  } finally {
    release?.();
  }
};

module.exports = {
  runOnboardedBootSequence,
};
