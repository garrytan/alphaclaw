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
  // Issue #76 A7: dangling records never survive a boot. Both run from the
  // LISTENING path (the port bind proved single-instance) — never at module
  // scope, where a doomed second instance could close a live sibling's run.
  //   closeDanglingRecordsAtBoot     openclawChannelService: interrupted ledger
  //                                  runs + a lastUpdateRun left running
  //   reconcileRestartOperationAtBoot restartRequiredState.reconcileOnBoot: a
  //                                  restart-op record from a previous process
  closeDanglingRecordsAtBoot = null,
  reconcileRestartOperationAtBoot = null,
  // Issue #76 A1: the server half of boot-report.json. recordBootReportServerPhase
  // merges the state-DB / schema / config facts BEFORE the compat gate;
  // finalizeBootReport receives the reconcile outcome, computes the verdict,
  // pins the incident report and replays the `boot` watchdog event.
  recordBootReportServerPhase = null,
  finalizeBootReport = null,
  // Stage 3 (C1 belt / C2, boot-launch-steps.js). Both receive the boot
  // lifecycle lease as { hold } — the lock is not re-entrant, so the
  // reconcile runs under THIS hold and never acquires its own:
  //   reconcileInstalledAtBoot        installedDiverged → activate the recorded
  //                                  build (single owner; port bind + boot lock
  //                                  make it safe)
  //   assessLaunchCompatibilityAtBoot RETURNS { compatible, hold }: a hold skips
  //                                  startGateway; a THROW is swallow-and-log
  //                                  and fails OPEN (F008) — only an explicit
  //                                  verdict may hold the gateway.
  reconcileInstalledAtBoot = null,
  assessLaunchCompatibilityAtBoot = null,
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
    // Boot order (#76 C2, all before reconcileBootConfig so no `doctor --fix`
    // can run from a wrong binary):
    //   (1) dangling closers → (2) boot-report server phase →
    //   (3) reconcileInstalled → (4) compat gate → [config ensure steps] →
    //   (5) reconcileBootConfig → (6) finalizeBootReport → (7) startGateway
    // Every step is swallow-and-log (F008): a throw inside any of them must
    // never skip the gateway launch — the one boot path with no self-heal.
    const runBootStep = async (label, step, args = undefined) => {
      if (typeof step !== "function") return null;
      try {
        return await step(args);
      } catch (error) {
        console.error(`[alphaclaw] Boot ${label} failed: ${error.message}`);
        return null;
      }
    };
    await runBootStep("dangling-record close", closeDanglingRecordsAtBoot);
    await runBootStep("restart-operation reconcile", reconcileRestartOperationAtBoot);
    await runBootStep("report server phase", recordBootReportServerPhase);
    // The boot lease rides along: reconcileInstalled({ hold }) re-checks
    // hold.isValid() after every await and never re-acquires (Codex 1).
    await runBootStep("installed-tree reconcile", reconcileInstalledAtBoot, {
      hold: release,
    });
    // Contract: the gate's RETURN decides ({ compatible, hold }); a throw is
    // logged by runBootStep and reads as "no verdict" (fail open, loudly).
    let gatewayHeld = false;
    const compat = await runBootStep(
      "launch compatibility gate",
      assessLaunchCompatibilityAtBoot,
      { hold: release },
    );
    if (compat && (compat.hold || compat.compatible === false)) {
      gatewayHeld = true;
      console.warn(
        `[alphaclaw] Gateway held: ${compat.hold?.reason || "launch compatibility gate refused"}`,
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
    // Every pre-gateway step is swallow-and-log (F008): a throw here used to
    // fall through to the outer catch and skip startGateway() entirely — the
    // one boot path with no watchdog self-heal — e.g. an unwritable gogcli
    // dir inside doSyncPromptFiles → ensureOpenclawRuntimeArtifacts.
    try {
      doSyncPromptFiles();
    } catch (error) {
      console.error(`[alphaclaw] Boot prompt-file sync failed: ${error.message}`);
    }
    try {
      reloadEnv();
    } catch (error) {
      console.error(`[alphaclaw] Boot env reload failed: ${error.message}`);
    }
    // A channel-sync failure is logged but never aborts the boot — the
    // gateway can run on its prior channel config.
    try {
      await syncChannelConfig(readEnvFile());
    } catch (error) {
      console.error(`[alphaclaw] Boot channel sync failed: ${error.message}`);
    }
    try {
      ensureGatewayProxyConfig(resolveSetupUrl());
    } catch (error) {
      console.error(`[alphaclaw] Boot gateway proxy config failed: ${error.message}`);
    }
    // Settings/DB reconciliation BEFORE the gateway can start on the newly
    // activated build (issue #20: the old fail-open path let the gateway
    // crash-loop on an un-migrated config, and the update ledger showed a
    // clean activation). Fail CLOSED: a reconcile hold skips the gateway
    // launch — the full admin UI stays up with retry actions; a reconcile
    // machinery error also holds rather than starting blind.
    let reconcile = null;
    if (typeof reconcileBootConfig === "function") {
      try {
        reconcile = (await reconcileBootConfig()) ?? null;
        if (reconcile?.status === "held") {
          gatewayHeld = true;
          console.warn(
            `[alphaclaw] Gateway held: ${reconcile.hold?.reason || "settings migration failed"}`,
          );
        }
      } catch (error) {
        gatewayHeld = true;
        reconcile = { status: "error", reason: String(error?.message || error) };
        console.error(
          `[alphaclaw] Boot config reconciliation failed (gateway held): ${error.message}`,
        );
      }
    }
    // The reconcile's { status, reason } is threaded into the report so the
    // verdict can name what the migration gate did; the compat result rides
    // along for Stage 3. Runs on EVERY reconcile outcome (ok / held / error).
    if (typeof finalizeBootReport === "function") {
      await runBootStep("report finalize", () =>
        finalizeBootReport({ reconcile, compat, gatewayHeld }),
      );
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
