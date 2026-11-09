const { callGateway } = require("../gateway-call");

// A Doctor run is one agent turn in agent:<id>:doctor:<runId>, driven by an
// `openclaw gateway call agent` that AlphaClaw waits on. When AlphaClaw or
// the gateway restarts mid-run (a deploy, a crash, Render replacing the
// instance), AlphaClaw marks the run failed at boot and nobody waits on that
// turn any more, but OpenClaw's restart recovery starts the interrupted turn
// again a few seconds after the new gateway is ready, after a SIGKILL too
// ("started interrupted main session: agent:main:doctor:N"). Nov 9: a Doctor
// run filled Render's /tmp, Render killed the instance, and the resumed turn
// filled the fresh /tmp again.
//
// So after every gateway launch, once it is ready, this looks for a running
// Doctor turn that is not the run AlphaClaw is driving now and stops it with
// chat.abort. Recovery starts about 4-5 s after ready on 2026.10.9 and later
// when OpenClaw holds it back, so it looks again over the first five minutes;
// a turn chat.abort did not stop is tried again at the next look. sessions.list and chat.abort are the only calls; it never
// reads OpenClaw's files or databases.

const kDoctorSessionKeyPattern = /^agent:main:doctor:\d+$/;
const kCheckOffsetsMs = Object.freeze([0, 5_000, 10_000, 20_000, 45_000, 90_000, 180_000, 300_000]);
const kReadyPollMs = 2_000;
const kReadyTimeoutMs = 5 * 60_000;
const kListLimit = 200;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

const createLeftoverDoctorTurnStop = ({
  clawCmd,
  getActiveRunSessionKey = () => null,
  probeReadiness,
  resolveReadyzUrl,
  insertEvent = null,
  sleep = defaultSleep,
  now = Date.now,
  checkOffsetsMs = kCheckOffsetsMs,
  readyTimeoutMs = kReadyTimeoutMs,
  logger = console,
} = {}) => {
  let jobSeq = 0;
  let pending = null;

  const stopLeftovers = async () => {
    const { ok, body } = await callGateway(clawCmd, "sessions.list", { activeOnly: true, limit: kListLimit, rowMode: "compact" });
    if (!ok || !Array.isArray(body?.sessions)) return [];
    const current = getActiveRunSessionKey();
    const stopped = [];
    for (const row of body.sessions) {
      const key = typeof row?.key === "string" ? row.key : "";
      if (row?.hasActiveRun !== true || !kDoctorSessionKeyPattern.test(key) || key === current) continue;
      const result = await callGateway(clawCmd, "chat.abort", { sessionKey: key });
      const ok = result.ok && result.body?.aborted !== false;
      logger.log?.(`[alphaclaw] doctor: ${ok ? "stopped" : "could not stop"} the leftover Doctor turn ${key} the gateway picked up again after a restart`);
      try {
        insertEvent?.({ eventType: "doctor", source: "doctor", status: ok ? "ok" : "warning", details: { kind: "leftover_turn_stopped", sessionKey: key, ok } });
      } catch {}
      if (ok) stopped.push(key);
    }
    return stopped;
  };

  // Called on every launch notice; a second notice for the same generation
  // (listening, then ready) joins the pending job.
  const onGatewayLaunch = ({ generation = null } = {}) => {
    if (generation != null && pending?.generation === generation) return pending.promise;
    const seq = ++jobSeq;
    const isCurrent = () => seq === jobSeq;
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (!isCurrent()) return { skipped: "superseded" };
        const observation = await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null);
        if (observation?.ok && observation.kind === "ready") break;
        if (now() >= deadline) return { skipped: "not_ready" };
        await sleep(kReadyPollMs);
      }
      const stopped = [];
      let waitedMs = 0;
      for (const offsetMs of checkOffsetsMs) {
        await sleep(Math.max(0, offsetMs - waitedMs));
        waitedMs = offsetMs;
        if (!isCurrent()) return { skipped: "superseded", stopped };
        stopped.push(...await stopLeftovers().catch(() => []));
      }
      return { stopped };
    })();
    pending = { generation, promise };
    return promise;
  };

  return { onGatewayLaunch, stopLeftovers };
};

module.exports = { createLeftoverDoctorTurnStop, kDoctorSessionKeyPattern };
