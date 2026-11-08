const { probeGatewayReadiness } = require("./gateway-readiness");
const { kGatewayRestartReadyTimeoutMs } = require("./constants");

const kReadyPollMs = 1000;

// Clears the restart-required reasons a managed gateway launch already
// applied, once that launch answers /readyz ready. Every launch (boot, crash
// relaunch, watchdog repair, cold restart) spawns `gateway run` from the
// config and env as they are at spawn, so a reason recorded before the spawn
// is live once that same child is ready. Adopted and detached gateways carry
// no spawn time and clear nothing: AlphaClaw cannot tell what they started
// from. A launch that never reaches ready, or is replaced or exits first,
// clears nothing.
const createRestartRequiredLaunchClear = ({
  restartRequiredState,
  resolveReadyzUrl = () => "",
  isLaunchCurrent = () => true,
  insertEvent = null,
  probeReadiness = probeGatewayReadiness,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now = () => Date.now(),
  readyTimeoutMs = kGatewayRestartReadyTimeoutMs,
} = {}) => {
  let jobSeq = 0;
  let pendingJob = null;
  let reachedReady = false;
  let latestGeneration = null;

  const onGatewayLaunch = ({ generation = null, launchedAt = null, supervision = "managed" } = {}) => {
    const spawnedAt = Number(launchedAt);
    if (supervision !== "managed" || generation == null || !Number.isFinite(spawnedAt) || spawnedAt <= 0) {
      return null;
    }
    // A managed cold restart notifies its launch twice (the "listening"
    // line, then /readyz ready): the second notice joins the first wait.
    if (pendingJob?.seq === jobSeq && pendingJob.generation === generation) return pendingJob.promise;
    if (latestGeneration != null && generation < latestGeneration) return null;
    latestGeneration = generation;
    const seq = ++jobSeq;
    const isCurrent = () => seq === jobSeq && isLaunchCurrent(generation);
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (!isCurrent()) return { skipped: "superseded" };
        const observation = await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null);
        if (observation?.ok && observation.kind === "ready") break;
        if (now() >= deadline) return { skipped: "not_ready" };
        await sleep(kReadyPollMs);
      }
      if (!isCurrent()) return { skipped: "superseded" };
      const by = reachedReady ? "gateway_launch" : "boot_launch";
      reachedReady = true;
      const cleared = restartRequiredState.markAppliedByLaunch({ by, launchedAt: spawnedAt, at: now() });
      if (!cleared) return { cleared: null };
      console.log(
        `[alphaclaw] restart-required cleared by=${cleared.by} generation=${generation} reasons=${cleared.codes.join(",")}`,
      );
      try {
        insertEvent?.({
          eventType: "restart_required",
          source: cleared.by,
          status: "cleared",
          details: { by: cleared.by, generation, launchedAt: cleared.launchedAt, reasons: cleared.codes },
        });
      } catch {}
      return { cleared };
    })().catch((error) => {
      console.warn(`[alphaclaw] restart-required launch clear failed: ${error?.message || error}`);
      return { skipped: "error" };
    });
    pendingJob = { seq, generation, promise };
    return promise;
  };

  return { onGatewayLaunch };
};

module.exports = { createRestartRequiredLaunchClear };
