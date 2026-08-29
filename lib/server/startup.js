const { setBootPhase } = require("./boot-phase");

// Runs in the background after listen(): the server must answer requests
// while channels sync and the gateway launches (previously this chain of
// blocking spawns froze the event loop for up to minutes right after a
// restart — exactly when users ask "is it back?"). Callers fire-and-forget;
// boot progress is reported via boot-phase in the status snapshot.
const runOnboardedBootSequence = async ({
  // FIRST lock-held step, before doSyncPromptFiles: the prompt artifacts
  // (SKILL.md/TOOLS.md) render the machine profile + autotune ledger, and the
  // apply awaits the bounded GPU probe — running it later would bake a
  // profile-less machine line into every boot's artifacts.
  applyResourceAutotuneOnBoot = null,
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
  primeStatusCaches = () => {},
}) => {
  setBootPhase("starting_gateway");
  // Boot mutates the same gateway/channel state the API routes do; hold the
  // lifecycle lock so an early API write cannot race the boot sequence.
  const release =
    typeof acquireLifecycleLock === "function"
      ? await acquireLifecycleLock("boot")
      : null;
  let bootError = null;
  try {
    if (typeof applyResourceAutotuneOnBoot === "function") {
      try {
        await applyResourceAutotuneOnBoot();
      } catch (error) {
        console.error(
          `[alphaclaw] Resource autotune boot apply failed: ${error.message}`,
        );
      }
    }
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
    // A channel-sync failure is logged but never aborts the boot — the
    // gateway can run on its prior channel config.
    try {
      await syncChannelConfig(readEnvFile());
    } catch (error) {
      console.error(`[alphaclaw] Boot channel sync failed: ${error.message}`);
    }
    ensureGatewayProxyConfig(resolveSetupUrl());
    // A gateway that fails to start marks the boot failed (the reducer's
    // boot_failed headline with Retry) — but supervision still starts below:
    // recovering a down gateway is the watchdog's whole job.
    try {
      await startGateway();
    } catch (error) {
      bootError = error;
      console.error(`[alphaclaw] Boot gateway start failed: ${error.message}`);
    }
  } catch (error) {
    bootError = error;
    console.error(`[alphaclaw] Boot sequence failed: ${error.message}`);
  } finally {
    release?.();
  }
  watchdog.start();
  gmailWatchService.start();
  try {
    primeStatusCaches();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to prime status caches on boot: ${error.message}`,
    );
  }
  if (bootError) {
    setBootPhase("failed", { error: bootError });
  } else {
    setBootPhase("ready");
  }
};

module.exports = {
  runOnboardedBootSequence,
};
