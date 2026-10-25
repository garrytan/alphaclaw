// A restart OpenClaw scheduled itself and never finished (ALPH-34).
//
// OpenClaw 2026.10.7 restarts in-process: the scheduler (restart-*.mjs)
// delivers a restart with process.emit("SIGUSR2"), and a request that cannot
// complete is coalesced into the one already scheduled and emitted again after
// its 30 s cooldown. On a production box an agent-requested restart stayed
// "already scheduled" for hours and was re-emitted about once a minute; every
// attempt closed admission and, with a heap-snapshot hook on SIGUSR2, wrote a
// snapshot. The gateway's output is the only place it shows:
//   "received SIGUSR2 3 times in 5 min: another supervisor may be managing this Gateway"
//   "admission closed: restart-signal fence"
//   "restart request coalesced (already scheduled) reason=..."
//   "gateway restart already scheduled; skipping duplicate signal"
// When those lines keep coming for 10 minutes, this records one watchdog event
// and sends the owner one notice that offers the existing restart. It never
// signals or restarts anything itself. AlphaClaw's own restarts (requested
// until the next launch) and a new gateway (each launch) reset the watch.
const kLoopLinePatterns = [
  { kind: "signal_burst", pattern: /received SIGUSR[12] \d+ times in 5 min/ },
  { kind: "fence", pattern: /admission closed: restart-signal fence/ },
  { kind: "coalesced", pattern: /restart request coalesced \(already scheduled\)/ },
  { kind: "coalesced", pattern: /gateway restart already scheduled; skipping duplicate signal/ },
];
const kStuckAfterMs = 10 * 60 * 1000;
// A quiet gap this long ends an episode: one restart attempt prints its lines
// within seconds, and the loop repeats about once a minute.
const kEpisodeGapMs = 5 * 60 * 1000;
const kMinLines = 5;
// AlphaClaw's own restart pauses the watch until the next launch; a restart
// that never launches (a failed stop) resumes it after the longest restart
// operation AlphaClaw runs.
const kPauseMaxMs = 30 * 60 * 1000;
const kMaxOutputCarry = 4096;

const formatUtc = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

const createRestartLoopWatch = ({
  notify = null,
  insertEvent = null,
  now = () => Date.now(),
  stuckAfterMs = kStuckAfterMs,
  episodeGapMs = kEpisodeGapMs,
  minLines = kMinLines,
  pauseMaxMs = kPauseMaxMs,
} = {}) => {
  let episode = null;
  let pausedUntilMs = 0;
  let outputCarry = "";

  const report = (current) => {
    const minutes = Math.round((current.lastAtMs - current.firstAtMs) / 60_000);
    const details = {
      firstAt: new Date(current.firstAtMs).toISOString(),
      lastAt: new Date(current.lastAtMs).toISOString(),
      lines: current.lines,
      kinds: current.kinds,
    };
    console.warn(
      `[alphaclaw] restart-loop: OpenClaw has re-requested a scheduled restart for ${minutes} min (${current.lines} lines) without completing it`,
    );
    try {
      insertEvent?.({ eventType: "gateway_restart_loop", source: "restart_loop_watch", status: "stuck", details });
    } catch {}
    if (typeof notify !== "function") return;
    const message = [
      "🐺 *AlphaClaw Watchdog*",
      "⚠️ A gateway restart OpenClaw scheduled has not completed",
      `Since ${formatUtc(current.firstAtMs)} (about ${minutes} minutes) OpenClaw has kept re-requesting a restart it scheduled itself, for example one an agent asked for, without finishing it. ` +
        "Each attempt briefly closes the gateway to new work.",
      "AlphaClaw has not signalled or restarted anything. To finish the restart, use Restart on the Watchdog tab.",
    ].join("\n");
    void Promise.resolve()
      .then(() => notify(message, { eventType: "restart_loop", id: `restart-loop-${current.firstAtMs}` }))
      .catch(() => {});
  };

  const observeLine = (line) => {
    const match = kLoopLinePatterns.find(({ pattern }) => pattern.test(line));
    if (!match) return;
    const atMs = now();
    if (!episode || atMs - episode.lastAtMs > episodeGapMs) {
      episode = { firstAtMs: atMs, lastAtMs: atMs, lines: 0, kinds: {}, reported: false };
    }
    episode.lastAtMs = atMs;
    episode.lines += 1;
    episode.kinds[match.kind] = (episode.kinds[match.kind] || 0) + 1;
    if (!episode.reported && episode.lines >= minLines && atMs - episode.firstAtMs >= stuckAfterMs) {
      episode.reported = true;
      report(episode);
    }
  };

  const observeGatewayOutput = (text) => {
    const lines = (outputCarry + String(text ?? "")).split("\n");
    outputCarry = lines.pop().slice(-kMaxOutputCarry);
    if (now() < pausedUntilMs) return;
    for (const line of lines) observeLine(line);
  };

  const onRestartRequested = () => {
    pausedUntilMs = now() + pauseMaxMs;
    episode = null;
  };

  const onGatewayLaunch = () => {
    pausedUntilMs = 0;
    episode = null;
    outputCarry = "";
  };

  return { observeGatewayOutput, onRestartRequested, onGatewayLaunch, getEpisode: () => (episode ? { ...episode } : null) };
};

module.exports = { createRestartLoopWatch, kStuckAfterMs, kEpisodeGapMs };
