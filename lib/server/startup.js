const { setBootPhase } = require("./boot-phase");
const { kOpenclawReconcileLifecycleLeaseMs } = require("./constants");
const lockContention = require("./openclaw-lock-contention");

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
  // Injectable for ordering tests; the default logs live openclaw processes
  // present BEFORE this boot spawns anything (read-only diagnostic).
  reportLockContentionAtBoot = () => {
    const report = lockContention.describeLockContention({ site: "boot" });
    // Only the interesting case is worth a boot line: an orphan from a
    // killed previous boot is exactly what a later "owns state-lifecycle"
    // refusal points at.
    if (report.live.length > 0) {
      for (const line of report.lines) console.log(line);
    }
    return report;
  },
  primeStatusCaches = () => {},
  // Issue #20: fail-closed config/DB reconciliation for the just-activated
  // OpenClaw build. Runs INSIDE the boot lock, strictly before startGateway;
  // a returned hold means the gateway must not start on this config.
  reconcileBootConfig = null,
}) => {
  setBootPhase("starting_gateway");
  // Boot mutates the same gateway/channel state the API routes do; hold the
  // lifecycle lock so an early API write cannot race the boot sequence. The
  // reconcile step can run a sized doctor migration (up to 30 min); the
  // default 10-min lease would force-release mid-migration and hand the
  // gateway to a queued restart against half-migrated DBs.
  const release =
    typeof acquireLifecycleLock === "function"
      ? await acquireLifecycleLock("boot", {
          leaseMs: kOpenclawReconcileLifecycleLeaseMs,
        })
      : null;
  let bootError = null;
  try {
    // FIRST inside the boot lock, before ANY step that can spawn the openclaw
    // CLI: on openclaw >= 2026.9.1 every CLI invocation serializes on the
    // state-lifecycle coordinator (an exclusive SQLite transaction held by a
    // LIVE process). A previous instance still alive from a killed boot
    // (incident 2026-09-01) is what a later "owns state-lifecycle" refusal
    // points at — name it here while the evidence is fresh. Read-only.
    try {
      reportLockContentionAtBoot();
    } catch (error) {
      console.warn(
        `[alphaclaw] boot lock-contention report failed: ${error.message}`,
      );
    }
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
      // Async since the era-aware rework (issue #23): backend resolution can
      // probe the openclaw CLI. Awaited so the swallow-and-log contract below
      // still catches its failures.
      await ensureManagedExecDefaults();
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
