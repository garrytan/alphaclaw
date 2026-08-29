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
  primeStatusCaches = () => {},
  // Issue #20: fail-closed config/DB reconciliation for the just-activated
  // OpenClaw build. Runs INSIDE the boot lock, strictly before startGateway;
  // a returned hold means the gateway must not start on this config.
  reconcileBootConfig = null,
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
    // Settings/DB reconciliation BEFORE the gateway can start on the newly
    // activated build (issue #20: the old fail-open path let the gateway
    // crash-loop on an un-migrated config, and the update ledger showed a
    // clean activation). Fail CLOSED: a reconcile hold skips the gateway
    // launch — the full admin UI stays up with retry actions; a reconcile
    // machinery error also holds rather than starting blind.
    let gatewayHeld = false;
    if (typeof reconcileBootConfig === "function") {
      try {
        const reconcile = await reconcileBootConfig();
        if (reconcile?.status === "held") {
          gatewayHeld = true;
          console.warn(
            `[alphaclaw] Gateway held: ${reconcile.hold?.reason || "settings migration failed"}`,
          );
        }
      } catch (error) {
        gatewayHeld = true;
        console.error(
          `[alphaclaw] Boot config reconciliation failed (gateway held): ${error.message}`,
        );
      }
    }
    // A gateway that fails to start marks the boot failed (the reducer's
    // boot_failed headline with Retry) — but supervision still starts below:
    // recovering a down gateway is the watchdog's whole job.
    if (!gatewayHeld) {
      try {
        await startGateway();
      } catch (error) {
        bootError = error;
        console.error(`[alphaclaw] Boot gateway start failed: ${error.message}`);
      }
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
