const { callGateway } = require("../gateway-call");
const { kGatewayRestartReadyTimeoutMs } = require("../constants");

// A Doctor run is one agent turn in agent:main:doctor:<runId>, sent with the
// idempotency key doctor-run-<runId> by an `openclaw gateway call agent` that
// AlphaClaw waits on. When AlphaClaw or the gateway restarts mid-run (a
// deploy, a crash, Render replacing the instance), the run is marked failed
// and nobody waits on that turn any more, but OpenClaw's restart recovery
// starts it again a few seconds after the new gateway is ready, after a
// SIGKILL too ("started interrupted main session: agent:main:doctor:N").
//
// So after every gateway launch, once it is ready, this stops the resumed
// turn, and only that turn. On OpenClaw 2026.10.9 the resume is a new run
// whose user message carries provenance { kind: "internal_system",
// sourceTool: "main_session_restart_recovery", sourceSessionKey: <key> } and
// the idempotency key "<recovery run id>:user". A turn counts as a resumed
// Doctor run only when that message is the session's latest user message and
// the user message it resumes (the last one before it that is not itself a
// recovery message) is the Doctor run's own (doctor-run-<runId>:user). A
// person's turn in the session after the Doctor run that a restart cut off
// and recovery resumes is theirs, and is never stopped. chat.abort then names that exact run id, so
// a person's own turn in the session is never stopped, whenever it starts.
// The run AlphaClaw is driving now is skipped. The post-restart session
// sweep skips a session this stopped (hasStopped), so it does not resume it. Recovery starts about 4-5 s
// after ready, so it looks again over the first five minutes. sessions.list,
// sessions.get and chat.abort are the only calls; it never reads OpenClaw's
// files or databases.

const kDoctorSessionKeyPattern = /^agent:main:doctor:(\d+)$/;
const kRecoverySourceTool = "main_session_restart_recovery";
const kCheckOffsetsMs = Object.freeze([0, 5_000, 10_000, 20_000, 45_000, 90_000, 180_000, 300_000]);
const kReadyPollMs = 2_000;
const kListLimit = 200;
const kTranscriptLimit = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

const userIdempotencyKey = (message) => {
  const key = message?.__openclaw?.idempotencyKey ?? message?.idempotencyKey;
  return typeof key === "string" && key.endsWith(":user") ? key.slice(0, -":user".length) : "";
};

// The recovery run id of the resumed Doctor turn in this transcript, or "".
const isRecoveryMessage = (message, sessionKey) =>
  message?.provenance?.kind === "internal_system" &&
  message.provenance.sourceTool === kRecoverySourceTool &&
  message.provenance.sourceSessionKey === sessionKey;

const findResumedDoctorRunId = (messages, sessionKey, runId) => {
  const userMessages = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "user");
  const latest = userMessages[userMessages.length - 1];
  if (!isRecoveryMessage(latest, sessionKey)) return "";
  const recoveryRunId = userIdempotencyKey(latest);
  const doctorKey = `doctor-run-${runId}`;
  if (!recoveryRunId || recoveryRunId === doctorKey) return "";
  const resumed = userMessages.slice(0, -1).reverse().find((message) => !isRecoveryMessage(message, sessionKey));
  return userIdempotencyKey(resumed) === doctorKey ? recoveryRunId : "";
};

const createResumedDoctorTurnStop = ({
  clawCmd,
  getActiveRunId = () => 0,
  probeReadiness,
  resolveReadyzUrl,
  insertEvent = null,
  sleep = defaultSleep,
  now = Date.now,
  checkOffsetsMs = kCheckOffsetsMs,
  readyTimeoutMs = kGatewayRestartReadyTimeoutMs,
  logger = console,
} = {}) => {
  let jobSeq = 0;
  let pending = null;
  let stoppedSessionKeys = new Set();

  const stopResumedTurns = async (stopped, missed) => {
    const { ok, body } = await callGateway(clawCmd, "sessions.list", { activeOnly: true, limit: kListLimit, rowMode: "compact" });
    if (!ok || !Array.isArray(body?.sessions)) return;
    for (const row of body.sessions) {
      const key = typeof row?.key === "string" ? row.key : "";
      const runId = Number(kDoctorSessionKeyPattern.exec(key)?.[1] || 0);
      if (row?.hasActiveRun !== true || !runId || runId === Number(getActiveRunId() || 0)) continue;
      const transcript = await callGateway(clawCmd, "sessions.get", { key, limit: kTranscriptLimit });
      if (!transcript.ok) continue;
      const recoveryRunId = findResumedDoctorRunId(transcript.body?.messages, key, runId);
      if (!recoveryRunId || stopped.has(recoveryRunId)) continue;
      const result = await callGateway(clawCmd, "chat.abort", { sessionKey: key, runId: recoveryRunId });
      const aborted = result.ok && result.body?.aborted === true && (!Array.isArray(result.body.runIds) || result.body.runIds.includes(recoveryRunId));
      if (!aborted) {
        missed.set(recoveryRunId, key);
        continue;
      }
      stopped.add(recoveryRunId);
      stoppedSessionKeys.add(key);
      missed.delete(recoveryRunId);
      logger.log?.(`[alphaclaw] doctor: stopped Doctor run ${runId}'s turn, which the gateway restarted after a restart cut it off (${key}, run ${recoveryRunId})`);
      try {
        insertEvent?.({ eventType: "doctor", source: "doctor", status: "ok", details: { kind: "resumed_turn_stopped", sessionKey: key, doctorRunId: runId, runId: recoveryRunId } });
      } catch {}
    }
  };

  // Called on every launch notice; a second notice for the same generation
  // (listening, then ready) joins the pending job.
  const onGatewayLaunch = ({ generation = null } = {}) => {
    if (generation != null && pending?.generation === generation) return pending.promise;
    const seq = ++jobSeq;
    const isCurrent = () => seq === jobSeq;
    stoppedSessionKeys = new Set();
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (!isCurrent()) return { skipped: "superseded" };
        const observation = await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null);
        if (observation?.ok && observation.kind === "ready") break;
        if (now() >= deadline) {
          logger.log?.(`[alphaclaw] doctor: the gateway was not ready within ${Math.round(readyTimeoutMs / 1000)} s, so no restarted Doctor turn was looked for`);
          return { skipped: "not_ready" };
        }
        await sleep(kReadyPollMs);
      }
      const stopped = new Set();
      const missed = new Map();
      let waitedMs = 0;
      for (const offsetMs of checkOffsetsMs) {
        await sleep(Math.max(0, offsetMs - waitedMs));
        waitedMs = offsetMs;
        if (!isCurrent()) return { skipped: "superseded", stopped: [...stopped] };
        await stopResumedTurns(stopped, missed).catch(() => {});
      }
      for (const [runId, key] of missed) {
        logger.log?.(`[alphaclaw] doctor: could not stop the restarted Doctor turn in ${key} (run ${runId}); it may have ended on its own`);
      }
      return { stopped: [...stopped], missed: [...missed.keys()] };
    })();
    pending = { generation, promise };
    return promise;
  };

  return { onGatewayLaunch, hasStopped: (sessionKey) => stoppedSessionKeys.has(sessionKey) };
};

module.exports = { createResumedDoctorTurnStop, findResumedDoctorRunId };
