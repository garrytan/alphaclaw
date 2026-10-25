// Gateway downtime note (ALPH-39): after an outage (a crash, a crash loop, a
// watchdog repair) or a restart that kept the gateway away for longer than
// kDowntimeNoteThresholdMs, the agent gets ONE short system note on its next
// turn: how long the gateway was down, that messages queued meanwhile may be
// stale (each inbound envelope already carries the provider's send time), and
// what AlphaClaw ran meanwhile (restarts, launches, a Doctor run). OpenClaw
// 2026.10.7 has no supported read of the inbound backlog (health's
// ingressPressure lists only stuck lanes) and no hook that rewrites an inbound
// message, so the note carries no count and marks no message.
//
// Delivery is OpenClaw's own system-event queue: `openclaw system event
// --text <t> --mode next-heartbeat` (the gateway's `wake` RPC). It enqueues
// the text on the default agent's main session without starting a turn; the
// next turn there (an inbound message or a heartbeat) drains it once into its
// prompt as a `System: [<time>] <text>` line. The queue lives in the gateway's
// memory, so the note is sent only once the new gateway is serving.
//
// "Down" is measured from AlphaClaw's own facts: the last time /readyz
// answered as serving (stamped every kServingStampIntervalMs and persisted, so
// a replaced container still knows) to the first serving answer after the
// next launch. A crash or a restart request opens the episode; it closes
// once, at that first serving answer, whatever the duration.
const fs = require("fs");
const { probeGatewayReadiness, kReadinessTransitionalReasons } = require("./gateway-readiness");
const { kGatewayRestartReadyTimeoutMs, kGatewayRestartOperationBudgetMs } = require("./constants");
const { shellEscapeArg } = require("./agents/shared");
const { writeFileAtomic } = require("./utils/safe-file");

const kDowntimeNoteThresholdMs = 120_000;
const kServingStampIntervalMs = 30_000;
const kReadyPollMs = 1_000;
const kCliTimeoutMs = 20_000;
const kMaxRestarts = 10;

const kDowntimeCauses = Object.freeze({
  CRASH: "crash",
  RESTART: "restart",
  REPAIR: "repair",
  MEMORY: "memory",
});

const kCauseCopy = {
  [kDowntimeCauses.CRASH]: "after a crash",
  [kDowntimeCauses.RESTART]: "during a restart",
  [kDowntimeCauses.REPAIR]: "during a watchdog repair",
  [kDowntimeCauses.MEMORY]: "during a restart to free memory",
};

const causeFromRestartSource = (source) => {
  const value = String(source || "");
  if (value === "watchdog:memory_mitigation") return kDowntimeCauses.MEMORY;
  if (value.startsWith("watchdog:")) return kDowntimeCauses.REPAIR;
  return kDowntimeCauses.RESTART;
};

// Serving: the gateway answers and takes turns. A failing channel component
// still counts; starting, draining and an explicit refusal do not.
const isServingObservation = (observation) =>
  observation?.ok === true &&
  !kReadinessTransitionalReasons.has(observation.status) &&
  (observation.kind === "ready" || observation.unreadyReason === "components");

const formatDuration = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

const formatWindow = (fromMs, toMs) => {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  if (from.slice(0, 10) === to.slice(0, 10)) return `${from.slice(11, 16)}–${to.slice(11, 16)} UTC`;
  return `${from.slice(0, 10)} ${from.slice(11, 16)} – ${to.slice(0, 10)} ${to.slice(11, 16)} UTC`;
};

const kSourcePattern = /^[a-z][a-z_:-]{0,40}$/;
const sourceLabel = (value) => (kSourcePattern.test(String(value || "")) ? String(value) : "unknown");

// What AlphaClaw itself did while the gateway was away: the restarts it was
// asked for (by attributed source), every launch when there was more than one
// (a crash loop), and the newest Doctor --fix run inside the window.
const describeOperations = ({ restarts = [], launches = 0, doctor = null }) => {
  const parts = [];
  if (restarts.length) {
    parts.push(`${restarts.length === 1 ? "1 restart" : `${restarts.length} restarts`} (${[...new Set(restarts.map(sourceLabel))].join(", ")})`);
  }
  if (launches > 1) parts.push(`${launches} gateway launches`);
  if (doctor) parts.push(`Doctor --fix (${sourceLabel(doctor.source)}, ${doctor.status === "ok" ? "ok" : "failed"})`);
  return parts.length ? ` AlphaClaw ran during it: ${parts.join(", ")}.` : "";
};

const buildDowntimeNoteText = ({ downAtMs, readyAtMs, cause = null, restarts = [], launches = 0, doctor = null }) => {
  const causeText = kCauseCopy[cause] ? ` ${kCauseCopy[cause]}` : "";
  return `The gateway was down for ${formatDuration(readyAtMs - downAtMs)} (${formatWindow(downAtMs, readyAtMs)})${causeText}; messages queued during that time may be stale, and their timestamps show when they were sent.${describeOperations({ restarts, launches, doctor })}`;
};

const readStamp = (stampPath) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    const at = Number(parsed?.lastServingAt);
    return {
      lastServingAt: Number.isFinite(at) && at > 0 ? at : null,
      cause: Object.values(kDowntimeCauses).includes(parsed?.cause) ? parsed.cause : null,
      restarts: Array.isArray(parsed?.restarts) ? parsed.restarts.map(sourceLabel).slice(-kMaxRestarts) : [],
      launches: Number.isInteger(parsed?.launches) && parsed.launches > 0 ? parsed.launches : 0,
    };
  } catch {
    return { lastServingAt: null, cause: null, restarts: [], launches: 0 };
  }
};

const createGatewayDowntimeNote = ({
  clawCmd,
  stampPath,
  insertEvent = null,
  readLastDoctorRun = () => null,
  resolveReadyzUrl = () => "",
  probeReadiness = probeGatewayReadiness,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now = () => Date.now(),
  thresholdMs = kDowntimeNoteThresholdMs,
  readyTimeoutMs = kGatewayRestartReadyTimeoutMs,
  restartBudgetMs = kGatewayRestartOperationBudgetMs,
} = {}) => {
  const stored = readStamp(stampPath);
  let lastServingAt = stored.lastServingAt;
  let lastProbeServing = false;
  // This process starts inside an episode: the gateway has not served under
  // it yet. A previous process's last serving time and cause carry over.
  let episode = { cause: stored.cause, openedAt: now(), needsLaunch: false, restarts: stored.restarts, launches: stored.launches };
  let latestGeneration = null;
  let jobSeq = 0;
  let pendingJob = null;
  let timer = null;

  const log = (line) => console.log(`[alphaclaw] downtime-note ${line}`);
  const persist = () => {
    try {
      writeFileAtomic(
        stampPath,
        `${JSON.stringify({
          lastServingAt,
          cause: episode?.cause ?? null,
          restarts: episode?.restarts ?? [],
          launches: episode?.launches ?? 0,
        })}\n`,
        { durable: false },
      );
    } catch {}
  };

  const openEpisode = ({ cause, needsLaunch }) => {
    if (lastProbeServing) lastServingAt = now();
    lastProbeServing = false;
    episode = { cause, openedAt: now(), needsLaunch, restarts: [], launches: 0 };
  };

  const sendNote = async ({ downAtMs, readyAtMs, cause, restarts, launches, generation }) => {
    const downMs = readyAtMs - downAtMs;
    let doctor = null;
    try {
      const run = readLastDoctorRun();
      const at = Number(run?.at);
      if (Number.isFinite(at) && at >= downAtMs && at <= readyAtMs) doctor = run;
    } catch {}
    const fields = `down_ms=${downMs} cause=${cause || "unknown"} restarts=${restarts.length} launches=${launches} doctor=${doctor ? "yes" : "no"} generation=${generation ?? "-"}`;
    const text = buildDowntimeNoteText({ downAtMs, readyAtMs, cause, restarts, launches, doctor });
    let result = null;
    try {
      result = await clawCmd(
        `system event --text ${shellEscapeArg(text)} --mode next-heartbeat --json`,
        { quiet: true, timeoutMs: kCliTimeoutMs },
      );
    } catch {}
    const sent = !!result?.ok;
    log(sent ? `sent ${fields}` : `send failed ${fields} exit=${result?.code ?? "-"}${result?.timedOut ? " timed_out" : ""}`);
    try {
      insertEvent?.({
        eventType: "downtime_note",
        source: "downtime_note",
        status: sent ? "sent" : "failed",
        details: {
          downMs,
          downAt: new Date(downAtMs).toISOString(),
          readyAt: new Date(readyAtMs).toISOString(),
          cause: cause || null,
          restarts: restarts.map(sourceLabel),
          launches,
          doctor: doctor ? { source: sourceLabel(doctor.source), status: doctor.status === "ok" ? "ok" : "failed" } : null,
          generation,
        },
      });
    } catch {}
    return { sent, downMs, cause: cause || null };
  };

  // Closes the open episode at its first serving answer after a launch. The
  // episode is closed before the send, so it can never be noted twice.
  const settle = async ({ generation = latestGeneration } = {}) => {
    if (!episode || episode.needsLaunch) return null;
    const { cause, restarts, launches } = episode;
    const downAtMs = lastServingAt;
    const readyAtMs = now();
    episode = null;
    lastServingAt = readyAtMs;
    lastProbeServing = true;
    persist();
    if (downAtMs == null || readyAtMs - downAtMs < thresholdMs) {
      return { sent: false, downMs: downAtMs == null ? null : readyAtMs - downAtMs };
    }
    return sendNote({ downAtMs, readyAtMs, cause, restarts, launches, generation });
  };

  const probeServing = async () =>
    isServingObservation(await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null));

  // Every kServingStampIntervalMs: stamp the last serving time while no
  // episode is open, and close an episode the launch wait gave up on (a boot
  // slower than the ready budget). A restart whose launch never came (the
  // stop was refused and the old gateway kept serving) is dropped silently.
  const tick = async () => {
    const serving = await probeServing();
    if (!episode) {
      lastProbeServing = serving;
      if (serving) {
        lastServingAt = now();
        persist();
      }
      return null;
    }
    if (!serving) return null;
    if (episode.needsLaunch) {
      if (now() - episode.openedAt < restartBudgetMs) return null;
      log(`dropped reason=no_launch cause=${episode.cause || "unknown"}`);
      episode = null;
      lastServingAt = now();
      lastProbeServing = true;
      persist();
      return null;
    }
    return settle();
  };

  const onRestartRequested = ({ source = null } = {}) => {
    try {
      if (!episode) openEpisode({ cause: causeFromRestartSource(source), needsLaunch: true });
      episode.needsLaunch = true;
      episode.restarts = [...episode.restarts, sourceLabel(source)].slice(-kMaxRestarts);
      persist();
    } catch {}
  };

  // Only an unexpected exit of the current gateway opens an episode: every
  // expected exit is AlphaClaw's own stop (a restart already opened one), and
  // a late exit of an older generation says nothing about the live gateway.
  const onGatewayExit = ({ expectedExit = false, generation = null } = {}) => {
    try {
      if (expectedExit || episode) return;
      if (generation != null && latestGeneration != null && generation < latestGeneration) return;
      openEpisode({ cause: kDowntimeCauses.CRASH, needsLaunch: false });
      persist();
    } catch {}
  };

  // A managed cold restart notifies its launch twice (the "listening" line,
  // then /readyz ready): the second notice joins the first wait.
  const onGatewayLaunch = ({ generation = null } = {}) => {
    if (generation != null && pendingJob?.seq === jobSeq && pendingJob.generation === generation) {
      return pendingJob.promise;
    }
    if (generation != null) latestGeneration = generation;
    if (episode) {
      episode.needsLaunch = false;
      episode.launches += 1;
      persist();
    }
    const seq = ++jobSeq;
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (seq !== jobSeq) return { skipped: "superseded" };
        if (!episode) return { skipped: "no_episode" };
        if (await probeServing()) {
          if (seq !== jobSeq) return { skipped: "superseded" };
          return (await settle({ generation })) || { skipped: "no_episode" };
        }
        if (now() >= deadline) return { skipped: "not_ready" };
        await sleep(kReadyPollMs);
      }
    })().catch((error) => {
      log(`failed error=${String(error?.message || error).slice(0, 160)}`);
      return { skipped: "error" };
    });
    pendingJob = { seq, generation, promise };
    return promise;
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, kServingStampIntervalMs);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { onGatewayLaunch, onGatewayExit, onRestartRequested, tick, start, stop };
};

module.exports = {
  createGatewayDowntimeNote,
  buildDowntimeNoteText,
  isServingObservation,
  causeFromRestartSource,
  kDowntimeCauses,
  kDowntimeNoteThresholdMs,
  kServingStampIntervalMs,
};
