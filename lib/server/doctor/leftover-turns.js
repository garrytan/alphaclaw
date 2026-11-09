const { callGateway } = require("../gateway-call");

// A Doctor run is one agent turn in agent:main:doctor:<runId>, driven by an
// `openclaw gateway call agent` that AlphaClaw waits on. When AlphaClaw or
// the gateway restarts mid-run (a deploy, a crash, Render replacing the
// instance), AlphaClaw marks the run failed and nobody waits on that turn any
// more, but OpenClaw's restart recovery starts the interrupted turn again a
// few seconds after the new gateway is ready, after a SIGKILL too ("started
// interrupted main session: agent:main:doctor:N"). Nov 9: a Doctor run filled
// Render's /tmp, Render killed the instance, and the resumed turn filled the
// fresh /tmp again.
//
// So after every gateway launch, once it is ready, this stops (chat.abort) a
// running turn only in the sessions of runs AlphaClaw itself recorded as
// abandoned: cut off at boot, or failed before their turn ended. Recovery
// starts about 4-5 s after ready on 2026.10.9 and later when OpenClaw holds
// it back, so it looks again over the first five minutes, and a turn
// chat.abort did not stop is tried again at the next look. Once a launch's
// looks are done, those sessions are forgotten, so a person who later uses
// one of them is never interrupted. sessions.list and chat.abort are the only
// calls; it never reads OpenClaw's files or databases.

const kDoctorSessionKeyPattern = /^agent:main:doctor:\d+$/;
const kCheckOffsetsMs = Object.freeze([0, 5_000, 10_000, 20_000, 45_000, 90_000, 180_000, 300_000]);
const kReadyPollMs = 2_000;
const kReadyTimeoutMs = 5 * 60_000;
const kListLimit = 200;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

const createLeftoverDoctorTurnStop = ({
  clawCmd,
  listAbandonedSessionKeys = () => [],
  forget = () => {},
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

  const stopLeftovers = async (watched) => {
    if (!watched.size) return [];
    const { ok, body } = await callGateway(clawCmd, "sessions.list", { activeOnly: true, limit: kListLimit, rowMode: "compact" });
    if (!ok || !Array.isArray(body?.sessions)) return [];
    const stopped = [];
    for (const row of body.sessions) {
      const key = typeof row?.key === "string" ? row.key : "";
      if (row?.hasActiveRun !== true || !kDoctorSessionKeyPattern.test(key) || !watched.has(key)) continue;
      const result = await callGateway(clawCmd, "chat.abort", { sessionKey: key });
      const aborted = result.ok && result.body?.aborted !== false;
      logger.log?.(`[alphaclaw] doctor: ${aborted ? "stopped" : "could not stop"} the leftover Doctor turn ${key} the gateway picked up again after a restart`);
      try {
        insertEvent?.({ eventType: "doctor", source: "doctor", status: aborted ? "ok" : "warning", details: { kind: "leftover_turn_stopped", sessionKey: key, ok: aborted } });
      } catch {}
      if (!aborted) continue;
      watched.delete(key);
      stopped.push(key);
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
      const initial = new Set(listAbandonedSessionKeys());
      const watched = new Set(initial);
      const stopped = [];
      let waitedMs = 0;
      for (const offsetMs of checkOffsetsMs) {
        await sleep(Math.max(0, offsetMs - waitedMs));
        waitedMs = offsetMs;
        if (!isCurrent()) return { skipped: "superseded", stopped };
        stopped.push(...await stopLeftovers(watched).catch(() => []));
      }
      for (const key of initial) forget(key);
      return { stopped };
    })();
    pending = { generation, promise };
    return promise;
  };

  return { onGatewayLaunch };
};

module.exports = { createLeftoverDoctorTurnStop, kDoctorSessionKeyPattern };
