// Per-session run-state reducer — the replacement for the old chat-route's
// three GLOBAL booleans (sending/streaming/assistantStreamStarted) whose
// cross-session bleed was the root of most stop/send nondeterminism.
//
//   idle → pendingSend → running → idle
//              │            ├→ stopping → idle        (done reason:stopped)
//              │            │       └→ running        (stop-failed)
//              │            └→ idle                   (done any reason / error)
//              └→ idle                                (send-failed / ack-timeout)
//   DONE for a runId ≠ activeRunId is IGNORED (kills the late-done race).
//   SOCKET_CLOSED: pendingSend → idle (item back to outbox);
//                  running/stopping → interruptedLocal (reconnect history reconciles).
//   RESUME_ATTACH(runId, seq): idle|interruptedLocal → running   (Phase 5)
//   RESUME_FAILED(runId):      running → idle                    (Phase 5)
//
// Ambiguity gating (D5/D9): a terminal with reason "interrupted" or an
// unknown-outcome send failure sets `holdFlush` — queued outbox items must
// NOT auto-send into a possibly-still-live run; the user confirms explicitly.
// Pure module: no preact, no globals — node-env unit tests drive it directly.

export const kIdle = "idle";
export const kPendingSend = "pendingSend";
export const kRunning = "running";
export const kStopping = "stopping";
export const kInterruptedLocal = "interruptedLocal";

export const createSessionRunState = () => ({
  phase: kIdle,
  activeClientMsgId: "",
  activeRunId: "",
  activeMessageId: "",
  assistantStreamStarted: false,
  holdFlush: false,
  lastTerminal: null, // { reason, confidence } | { failureCode }
});

const toIdle = (state, lastTerminal) => ({
  ...state,
  phase: kIdle,
  activeClientMsgId: "",
  activeRunId: "",
  activeMessageId: "",
  assistantStreamStarted: false,
  lastTerminal: lastTerminal || state.lastTerminal,
});

/**
 * reduceRunState(state, event) → next state. Events:
 *  {type:"OUTBOX_INFLIGHT", clientMsgId}
 *  {type:"STARTED", clientMsgId, runId, messageId}
 *  {type:"CHUNK"} / {type:"TOOL"}
 *  {type:"STOP_CLICKED"} / {type:"STOPPING"} / {type:"STOP_FAILED"}
 *  {type:"DONE", runId, reason, confidence}
 *  {type:"SEND_FAILED", clientMsgId, code}
 *  {type:"SOCKET_CLOSED"}
 *  {type:"CONFIRM_FLUSH"}   user explicitly released held queued items
 *  {type:"RESUME_ATTACH", runId, messageId, seq} / {type:"RESUME_FAILED", runId}
 */
export const reduceRunState = (state = createSessionRunState(), event = {}) => {
  const type = String(event?.type || "");
  switch (type) {
    case "OUTBOX_INFLIGHT":
      return {
        ...state,
        phase: kPendingSend,
        activeClientMsgId: String(event.clientMsgId || ""),
        activeRunId: "",
        activeMessageId: "",
        assistantStreamStarted: false,
      };
    case "STARTED": {
      // Accept from pendingSend (normal) and idle (an ack/start race after a
      // reconnect re-send) — but never resurrect a session that is stopping.
      if (state.phase === kStopping) {
        return { ...state, activeRunId: String(event.runId || "") };
      }
      return {
        ...state,
        phase: kRunning,
        activeClientMsgId: String(event.clientMsgId || state.activeClientMsgId),
        activeRunId: String(event.runId || ""),
        activeMessageId: String(event.messageId || ""),
      };
    }
    case "CHUNK":
    case "TOOL":
      if (state.phase !== kRunning && state.phase !== kStopping) return state;
      // Identity-stable after the first frame: token-rate events must not
      // churn the state object (it feeds memoized components).
      if (state.assistantStreamStarted) return state;
      return { ...state, assistantStreamStarted: true };
    case "STOP_CLICKED":
    case "STOPPING":
      if (state.phase !== kRunning && state.phase !== kPendingSend) return state;
      return { ...state, phase: kStopping };
    case "STOP_FAILED":
      if (state.phase !== kStopping) return state;
      return { ...state, phase: state.activeRunId ? kRunning : kPendingSend };
    case "DONE": {
      const runId = String(event.runId || "");
      const reason = String(event.reason || "complete");
      // A stop terminal settles a stopping session even without a runId (a
      // pre-started stop has none). Anything else must match the active run —
      // a late done from a previous run must never clear the new one.
      const stopSettles = state.phase === kStopping && reason === "stopped";
      if (!stopSettles && runId && state.activeRunId && runId !== state.activeRunId) {
        return state;
      }
      if (!stopSettles && !runId && state.phase === kIdle) return state;
      const ambiguous =
        reason === "interrupted" ||
        String(event.confidence || "") === "unconfirmed";
      return {
        ...toIdle(state, { reason, confidence: String(event.confidence || "") }),
        // Only an interruption holds the queue: an unconfirmed STOP still
        // means the user asked for it — flushing after it is expected.
        holdFlush: reason === "interrupted" ? true : state.holdFlush && ambiguous,
      };
    }
    case "SEND_FAILED": {
      const clientMsgId = String(event.clientMsgId || "");
      if (
        state.activeClientMsgId &&
        clientMsgId &&
        clientMsgId !== state.activeClientMsgId
      ) {
        return state;
      }
      if (state.phase === kIdle) return state;
      const code = String(event.code || "");
      return {
        ...toIdle(state, { failureCode: code }),
        holdFlush: code === "unknown_outcome" ? true : state.holdFlush,
      };
    }
    case "SOCKET_CLOSED":
      if (state.phase === kPendingSend) return toIdle(state, null);
      if (state.phase === kRunning || state.phase === kStopping) {
        return { ...state, phase: kInterruptedLocal, holdFlush: true };
      }
      return state;
    case "CONFIRM_FLUSH":
      return { ...state, holdFlush: false };
    case "RESUME_ATTACH": {
      const messageId = String(event.messageId || "");
      const runId = String(event.runId || "");
      // Already attached to this run (fix wave F126): a late `resumed` frame
      // may bring the messageId the hello-time attach lacked — fill it in,
      // never clear a known one.
      if (state.phase === kRunning && state.activeRunId === runId) {
        if (!messageId || state.activeMessageId === messageId) return state;
        return { ...state, activeMessageId: messageId };
      }
      if (state.phase !== kIdle && state.phase !== kInterruptedLocal) return state;
      return {
        ...state,
        phase: kRunning,
        activeRunId: runId,
        activeMessageId: messageId || String(state.activeMessageId || ""),
        assistantStreamStarted: true,
      };
    }
    // Ack timeout on the in-flight send (fix wave F124): the outbox requeues
    // the item; the session must leave pendingSend or canAutoFlush never
    // re-sends it and the UI shows "Queued" + typing dots until Stop.
    case "ACK_TIMEOUT": {
      if (state.phase !== kPendingSend) return state;
      const clientMsgId = String(event.clientMsgId || "");
      if (state.activeClientMsgId && clientMsgId && clientMsgId !== state.activeClientMsgId) {
        return state;
      }
      return toIdle(state, { failureCode: "ack_timeout" });
    }
    case "RESUME_FAILED": {
      const runId = String(event.runId || "");
      if (state.phase !== kRunning && state.phase !== kInterruptedLocal) return state;
      if (runId && state.activeRunId && runId !== state.activeRunId) return state;
      return toIdle(state, null);
    }
    default:
      return state;
  }
};

// Queued outbox items auto-send only from a settled, unambiguous idle.
export const canAutoFlush = (state) =>
  state?.phase === kIdle && state?.holdFlush !== true;

export const isRunActive = (state) =>
  state?.phase === kPendingSend ||
  state?.phase === kRunning ||
  state?.phase === kStopping;
