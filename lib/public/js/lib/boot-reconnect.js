// Reconnect handoff while AlphaClaw itself restarts (honest boot status,
// PR 3). Liveness and progress are separate questions:
//
//   liveness  does anything answer /boot-progress.json? (the placeholder
//             before listen, the real server after it)
//   progress  does the SAME boot keep advancing? Only a changed stage or a
//             changed activity sequence counts — never elapsed time, a
//             response arriving, or a growing "quiet for" age.
//
// The outage deadline (kReconnectBudgetMs from the first failure) is kept
// across bootId changes: a fresh boot is not progress. A non-stuck
// placeholder answering counts as alive (its own stuck verdict is the
// deadline: pre-listen work such as a pending self-update install can take
// minutes). Host-recovery advice ("restart AlphaClaw from your host's
// dashboard") belongs to exactly three states: nothing answers past the
// budget (unreachable), a responder reports stuck, or the restart loop.
//
// Boot identity: the placeholder and the real server carry different
// bootIds, and a placeholder → server handoff is ONE boot (the first identity
// a page sees was already running and is not counted). More than
// kBootLoopThreshold fresh boots inside kBootLoopWindowMs is the restart
// loop ("AlphaClaw keeps restarting"), unless the current boot reached
// verified readiness.
export const kBootLoopWindowMs = 10 * 60 * 1000;
export const kBootLoopThreshold = 3;
// A probe answer older than this no longer proves liveness.
export const kAnswerFreshMs = 10 * 1000;

export const createBootReconnectTracker = ({ budgetMs = 120000, now = () => Date.now() } = {}) => {
  let outageStartedAt = null;
  let lastAnswerAt = null;
  let lastProgressAt = null;
  let current = null;
  let lastBootId = null;
  let lastSource = null;
  let bootStarts = [];

  const recordIdentity = (frame) => {
    const id = frame?.bootId;
    if (!id || id === lastBootId) return false;
    // The first identity this page sees was already running: not a fresh boot.
    const handoff = lastBootId == null || (lastSource === "placeholder" && frame.source === "server");
    if (!handoff) bootStarts = [...bootStarts, now()].filter((at) => now() - at <= kBootLoopWindowMs);
    lastBootId = id;
    lastSource = frame.source || null;
    return true;
  };

  return {
    // A status frame from the authenticated feed: the feed is healthy, so
    // the outage ends; the frame's boot identity still feeds the loop count.
    recordStatusFrame: (bootProgress = null) => {
      outageStartedAt = null;
      lastProgressAt = null;
      if (bootProgress?.bootId) {
        recordIdentity({ ...bootProgress, source: "server" });
        current = { ...bootProgress, source: "server" };
      }
    },
    recordOutage: () => {
      if (outageStartedAt == null) outageStartedAt = now();
    },
    // One /boot-progress.json probe during an outage: a frame, or null when
    // nothing answered.
    recordProbe: (frame = null) => {
      if (!frame || typeof frame !== "object" || !frame.source) return;
      lastAnswerAt = now();
      const previous = current;
      const fresh = recordIdentity(frame);
      if (
        !fresh &&
        previous?.bootId === frame.bootId &&
        (previous.stage !== frame.stage || Number(previous.activitySeq) !== Number(frame.activitySeq))
      ) {
        lastProgressAt = now();
      }
      current = frame;
    },
    getState: () => {
      const t = now();
      const loopCount = bootStarts.filter((at) => t - at <= kBootLoopWindowMs).length;
      if (loopCount > kBootLoopThreshold && current?.outcome !== "ready") {
        return { mode: "restart_loop", count: loopCount, frame: current };
      }
      if (outageStartedAt == null) return { mode: "online", frame: current };
      const answering = lastAnswerAt != null && t - lastAnswerAt < kAnswerFreshMs && lastAnswerAt >= outageStartedAt;
      if (answering && current?.stuck) return { mode: "stuck", frame: current };
      if (answering && current?.source === "placeholder") return { mode: "preparing", frame: current };
      if (answering) {
        const base = Math.max(outageStartedAt, lastProgressAt || 0);
        return { mode: t - base >= budgetMs ? "stalled" : "booting", frame: current };
      }
      const base = Math.max(outageStartedAt, lastAnswerAt || 0);
      return { mode: t - base >= budgetMs ? "unreachable" : "reconnecting", frame: current };
    },
  };
};

// The public stage label of a frame ("Preparing", "Starting the gateway" …).
export const stageLabelOf = (frame) => {
  if (!frame) return null;
  if (frame.source === "placeholder") return "Preparing";
  const stage = (Array.isArray(frame.stages) ? frame.stages : []).find((entry) => entry.id === frame.stage);
  return stage?.label || null;
};
