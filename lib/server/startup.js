const { setBootPhase } = require("./boot-phase");
const { kOpenclawBootMigrationLeaseMs } = require("./constants");
const lockContention = require("./openclaw-lock-contention");
const { createRepairOperation } = require("./repair-operation");

// Runs in the background after listen(): the server must answer requests
// while channels sync and the gateway launches (previously this chain of
// blocking spawns froze the event loop for up to minutes right after a
// restart — exactly when users ask "is it back?"). Callers fire-and-forget;
// boot progress is reported via boot-phase in the status snapshot.
const runOnboardedBootSequence = async ({
  onboarded = true,
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
  // Issue #76 A7: a restart-op record from a previous process never survives
  // a boot. Runs from the LISTENING path (the port bind proved single-
  // instance) — never at module scope, where a doomed second instance could
  // close a live sibling's record.
  reconcileRestartOperationAtBoot = null,
  // Issue #76 A1: the server half of boot-report.json. recordBootReportServerPhase
  // merges the state-DB / schema / config facts first; finalizeBootReport
  // receives the migration outcome, computes the verdict, pins the incident
  // report and replays the `boot` watchdog event.
  recordBootReportServerPhase = null,
  finalizeBootReport = null,
  // Pre-onboarding-safe config normalization (#121), under the boot lease.
  normalizeBootConfig = null,
  // ({ operation }) → { status, ran, reason }: `openclaw doctor --fix` once
  // per pinned OpenClaw version (openclaw-boot-migration.js), strictly
  // before startGateway. A failure is reported and the gateway starts anyway.
  runBootMigration = null,
  runBootNativeMaintenance = null,
  signal = null,
}) => {
  setBootPhase("starting_gateway");
  let release = null;
  const bootOperation = createRepairOperation({ signal, isCurrent: () => release?.isValid?.() !== false });
  // Boot mutates the same gateway/channel state the API routes do; hold the
  // lifecycle lock so an early API write cannot race the boot sequence. The
  // migration step can run doctor for up to 30 min; the default 10-min lease
  // would force-release mid-migration and hand the gateway to a queued
  // restart against half-migrated DBs.
  release =
    typeof acquireLifecycleLock === "function"
      ? await acquireLifecycleLock("boot", {
          leaseMs: kOpenclawBootMigrationLeaseMs,
          cleanup: bootOperation.cleanup,
        })
      : null;
  bootOperation.start(kOpenclawBootMigrationLeaseMs, release?.expiresAt ?? Infinity);
  let bootError = null;
  let gatewayChild = null;
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
    // Boot order: (1) restart-op closer → (2) boot-report server phase →
    // (3) config normalization → (4) doctor migration for a new pin →
    //   [config ensure steps] → (5) finalizeBootReport → (6) startGateway
    const runBootStep = async (label, step, args = undefined) => {
      if (typeof step !== "function") return null;
      try {
        return await step(args);
      } catch (error) {
        console.error(`[alphaclaw] Boot ${label} failed: ${error.message}`);
        return null;
      }
    };
    await runBootStep("restart-operation reconcile", reconcileRestartOperationAtBoot);
    await runBootStep("report server phase", recordBootReportServerPhase);
    // Only a lost boot lease (or shutdown) holds the gateway: another owner
    // now runs the lifecycle.
    let gatewayHeld = false;
    const checkBootOwnership = () => {
      if ((release?.isValid && !release.isValid()) || signal?.aborted || bootOperation.signal.aborted) {
        gatewayHeld = true;
      }
      return !gatewayHeld;
    };
    if (typeof normalizeBootConfig === "function" && checkBootOwnership()) {
      try {
        await bootOperation.runWriter(() => normalizeBootConfig({ hold: release, assertLease: () => bootOperation.assertActive() }));
      } catch (error) {
        console.error(`[alphaclaw] Boot config normalization failed: ${error.message}`);
      }
    }
    let migration = null;
    if (onboarded && typeof runBootMigration === "function" && checkBootOwnership()) {
      try {
        migration = await bootOperation.runWriter(() => runBootMigration({ operation: bootOperation }));
      } catch (error) {
        migration = { status: "error", reason: String(error?.message || error) };
        console.error(`[alphaclaw] Boot doctor migration failed: ${error.message}`);
      }
    }
    checkBootOwnership();
    if (!onboarded) {
      if (typeof finalizeBootReport === "function") {
        await runBootStep("report finalize", () => finalizeBootReport({ migration, gatewayHeld }));
      }
      return;
    }
    if (typeof runBootNativeMaintenance === "function" && checkBootOwnership()) {
      try {
        await bootOperation.runWriter(() => runBootNativeMaintenance({ hold: release, signal: bootOperation.signal }));
        bootOperation.assertActive();
      } catch (error) {
        gatewayHeld = true;
        bootError = new Error("Boot native maintenance did not complete safely");
        console.error("[alphaclaw] Boot native maintenance did not complete safely; gateway held");
      }
    }
    if (checkBootOwnership()) {
      if (typeof applyResourceAutotuneOnBoot === "function") {
        try {
          await applyResourceAutotuneOnBoot();
        } catch (error) {
          console.error(
            `[alphaclaw] Resource autotune boot apply failed: ${error.message}`,
          );
        }
      }
    }
    if (checkBootOwnership()) {
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
    }
    if (checkBootOwnership()) {
      try {
        ensureUsageTrackerPluginConfig();
      } catch (error) {
        console.error(
          `[alphaclaw] Failed to ensure usage-tracker plugin config on boot: ${error.message}`,
        );
      }
    }
    if (checkBootOwnership()) {
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
    }
    if (checkBootOwnership()) {
      // Every pre-gateway step is swallow-and-log (F008): a throw here used to
      // fall through to the outer catch and skip startGateway() entirely — the
      // one boot path with no watchdog self-heal — e.g. an unwritable gogcli
      // dir inside doSyncPromptFiles → ensureOpenclawRuntimeArtifacts.
      try {
        doSyncPromptFiles();
      } catch (error) {
        console.error(`[alphaclaw] Boot prompt-file sync failed: ${error.message}`);
      }
    }
    if (checkBootOwnership()) {
      try {
        reloadEnv();
      } catch (error) {
        console.error(`[alphaclaw] Boot env reload failed: ${error.message}`);
      }
    }
    if (checkBootOwnership()) {
      // A channel-sync failure is logged but never aborts the boot — the
      // gateway can run on its prior channel config.
      try {
        await syncChannelConfig(readEnvFile());
      } catch (error) {
        console.error(`[alphaclaw] Boot channel sync failed: ${error.message}`);
      }
    }
    if (checkBootOwnership()) {
      try {
        ensureGatewayProxyConfig(resolveSetupUrl());
      } catch (error) {
        console.error(`[alphaclaw] Boot gateway proxy config failed: ${error.message}`);
      }
    }
    // The migration's { status, reason } is threaded into the report.
    checkBootOwnership();
    if (typeof finalizeBootReport === "function") {
      await runBootStep("report finalize", () => finalizeBootReport({ migration, gatewayHeld }));
    }
    checkBootOwnership();
    // A gateway that fails to start marks the boot failed (the reducer's
    // boot_failed headline with Retry) — but supervision still starts below:
    // recovering a down gateway is the watchdog's whole job.
    if (!gatewayHeld) {
      try {
        gatewayChild = await startGateway();
      } catch (error) {
        bootError = error;
        console.error(`[alphaclaw] Boot gateway start failed: ${error.message}`);
      }
    }
  } catch (error) {
    bootError = error;
    console.error(`[alphaclaw] Boot sequence failed: ${error.message}`);
  } finally {
    await bootOperation.cleanup.wait();
    await release?.();
    if (!onboarded && !signal?.aborted) {
      setBootPhase(bootError ? "failed" : "ready", { error: bootError });
    }
  }
  if (signal?.aborted) return;
  watchdog.start({ child: gatewayChild });
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
