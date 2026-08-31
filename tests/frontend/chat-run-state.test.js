import { describe, expect, it } from "vitest";
import {
  canAutoFlush,
  createSessionRunState,
  isRunActive,
  kIdle,
  kInterruptedLocal,
  kPendingSend,
  kRunning,
  kStopping,
  reduceRunState,
} from "../../lib/public/js/components/chat/run-state.js";

const reduceAll = (events, initial = createSessionRunState()) =>
  events.reduce((state, event) => reduceRunState(state, event), initial);

describe("frontend/chat run-state reducer", () => {
  it("happy path: inflight → started → chunk → done(complete) → idle + auto-flush", () => {
    let state = createSessionRunState();
    expect(state.phase).toBe(kIdle);
    expect(isRunActive(state)).toBe(false);
    expect(canAutoFlush(state)).toBe(true);

    state = reduceRunState(state, { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" });
    expect(state.phase).toBe(kPendingSend);
    expect(state.activeClientMsgId).toBe("m1");
    expect(isRunActive(state)).toBe(true);
    expect(canAutoFlush(state)).toBe(false);

    state = reduceRunState(state, {
      type: "STARTED",
      clientMsgId: "m1",
      runId: "run-1",
      messageId: "msg-1",
    });
    expect(state.phase).toBe(kRunning);
    expect(state.activeRunId).toBe("run-1");
    expect(state.activeMessageId).toBe("msg-1");
    expect(state.activeClientMsgId).toBe("m1");
    expect(state.assistantStreamStarted).toBe(false);

    state = reduceRunState(state, { type: "CHUNK" });
    expect(state.assistantStreamStarted).toBe(true);
    expect(state.phase).toBe(kRunning);

    state = reduceRunState(state, {
      type: "DONE",
      runId: "run-1",
      reason: "complete",
      confidence: "confirmed",
    });
    expect(state.phase).toBe(kIdle);
    expect(state.activeClientMsgId).toBe("");
    expect(state.activeRunId).toBe("");
    expect(state.activeMessageId).toBe("");
    expect(state.assistantStreamStarted).toBe(false);
    expect(state.holdFlush).toBe(false);
    expect(state.lastTerminal).toEqual({ reason: "complete", confidence: "confirmed" });
    expect(canAutoFlush(state)).toBe(true);
    expect(isRunActive(state)).toBe(false);
  });

  it("late-done race: a DONE carrying the OLD runId never clears the NEW run", () => {
    // Run 1 completes normally.
    let state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
      { type: "DONE", runId: "run-1", reason: "complete" },
    ]);
    expect(state.phase).toBe(kIdle);

    // Run 2 starts.
    state = reduceAll(
      [
        { type: "OUTBOX_INFLIGHT", clientMsgId: "m2" },
        { type: "STARTED", clientMsgId: "m2", runId: "run-2", messageId: "msg-2" },
        { type: "CHUNK" },
      ],
      state,
    );
    expect(state.phase).toBe(kRunning);
    expect(state.activeRunId).toBe("run-2");

    // A straggler DONE for run-1 arrives: MUST be ignored — this was the
    // wipe-the-new-send bug.
    const next = reduceRunState(state, {
      type: "DONE",
      runId: "run-1",
      reason: "complete",
    });
    expect(next).toBe(state);
    expect(next.phase).toBe(kRunning);
    expect(next.activeRunId).toBe("run-2");
    expect(next.assistantStreamStarted).toBe(true);

    // The genuine terminal for run-2 still settles it.
    const settled = reduceRunState(next, {
      type: "DONE",
      runId: "run-2",
      reason: "complete",
    });
    expect(settled.phase).toBe(kIdle);
  });

  it("stop flow: stop-failed returns to running when a runId exists", () => {
    let state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
      { type: "STOP_CLICKED" },
    ]);
    expect(state.phase).toBe(kStopping);
    expect(isRunActive(state)).toBe(true);

    state = reduceRunState(state, { type: "STOP_FAILED" });
    expect(state.phase).toBe(kRunning);
    expect(state.activeRunId).toBe("run-1");
  });

  it("stop flow: stop-failed falls back to pendingSend when no run has started", () => {
    let state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STOP_CLICKED" },
    ]);
    expect(state.phase).toBe(kStopping);
    expect(state.activeRunId).toBe("");

    state = reduceRunState(state, { type: "STOP_FAILED" });
    expect(state.phase).toBe(kPendingSend);
  });

  it("stop flow: stopping + DONE(reason stopped) settles to idle even WITHOUT a runId", () => {
    let state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
      { type: "STOP_CLICKED" },
    ]);
    expect(state.phase).toBe(kStopping);

    state = reduceRunState(state, { type: "DONE", reason: "stopped" });
    expect(state.phase).toBe(kIdle);
    expect(state.activeRunId).toBe("");
    // A stop the user asked for is unambiguous: the queue is not held.
    expect(state.holdFlush).toBe(false);
    expect(canAutoFlush(state)).toBe(true);
    expect(state.lastTerminal).toEqual({ reason: "stopped", confidence: "" });
  });

  it("ambiguity gating: DONE(interrupted) holds the flush until CONFIRM_FLUSH", () => {
    let state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
      { type: "DONE", runId: "run-1", reason: "interrupted" },
    ]);
    expect(state.phase).toBe(kIdle);
    expect(state.holdFlush).toBe(true);
    expect(canAutoFlush(state)).toBe(false);

    state = reduceRunState(state, { type: "CONFIRM_FLUSH" });
    expect(state.holdFlush).toBe(false);
    expect(canAutoFlush(state)).toBe(true);

    // A later clean completion must not re-set the hold.
    state = reduceAll(
      [
        { type: "OUTBOX_INFLIGHT", clientMsgId: "m2" },
        { type: "STARTED", clientMsgId: "m2", runId: "run-2", messageId: "msg-2" },
        { type: "DONE", runId: "run-2", reason: "complete" },
      ],
      state,
    );
    expect(state.phase).toBe(kIdle);
    expect(state.holdFlush).toBe(false);
    expect(canAutoFlush(state)).toBe(true);
  });

  it("ambiguity gating: SEND_FAILED unknown_outcome holds the flush", () => {
    const state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "SEND_FAILED", clientMsgId: "m1", code: "unknown_outcome" },
    ]);
    expect(state.phase).toBe(kIdle);
    expect(state.holdFlush).toBe(true);
    expect(canAutoFlush(state)).toBe(false);
    expect(state.lastTerminal).toEqual({ failureCode: "unknown_outcome" });
  });

  it("ambiguity gating: SEND_FAILED session_busy for the ACTIVE clientMsgId settles without a hold", () => {
    const state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "SEND_FAILED", clientMsgId: "m1", code: "session_busy" },
    ]);
    expect(state.phase).toBe(kIdle);
    expect(state.holdFlush).toBe(false);
    expect(canAutoFlush(state)).toBe(true);
    expect(state.lastTerminal).toEqual({ failureCode: "session_busy" });
  });

  it("ambiguity gating: SEND_FAILED for a DIFFERENT clientMsgId is ignored", () => {
    const state = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
    ]);
    const next = reduceRunState(state, {
      type: "SEND_FAILED",
      clientMsgId: "m-other",
      code: "unknown_outcome",
    });
    expect(next).toBe(state);
    expect(next.phase).toBe(kRunning);
    expect(next.holdFlush).toBe(false);
  });

  it("SOCKET_CLOSED: pendingSend → idle, running → interruptedLocal + hold, idle unchanged", () => {
    // pendingSend: the item goes back to the outbox — settled idle.
    const pending = reduceAll([{ type: "OUTBOX_INFLIGHT", clientMsgId: "m1" }]);
    const afterPending = reduceRunState(pending, { type: "SOCKET_CLOSED" });
    expect(afterPending.phase).toBe(kIdle);
    expect(afterPending.holdFlush).toBe(false);

    // running: the run may still be live server-side — hold the queue.
    const running = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
    ]);
    const afterRunning = reduceRunState(running, { type: "SOCKET_CLOSED" });
    expect(afterRunning.phase).toBe(kInterruptedLocal);
    expect(afterRunning.holdFlush).toBe(true);
    expect(canAutoFlush(afterRunning)).toBe(false);
    expect(isRunActive(afterRunning)).toBe(false);

    // idle: nothing to do.
    const idle = createSessionRunState();
    expect(reduceRunState(idle, { type: "SOCKET_CLOSED" })).toBe(idle);
  });

  it("purity: reduceRunState never mutates its input (frozen inputs stay intact)", () => {
    const frozenIdle = Object.freeze(createSessionRunState());
    const idleSnapshot = { ...frozenIdle };

    const pending = reduceRunState(frozenIdle, {
      type: "OUTBOX_INFLIGHT",
      clientMsgId: "m1",
    });
    expect(pending).not.toBe(frozenIdle);
    expect(frozenIdle).toEqual(idleSnapshot);

    const frozenRunning = Object.freeze(
      reduceRunState(
        Object.freeze(pending),
        Object.freeze({ type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" }),
      ),
    );
    const runningSnapshot = { ...frozenRunning };

    // Every state-changing event must produce a NEW object, leaving the
    // frozen input untouched (a mutation on a frozen object would throw in
    // strict mode and fail this test).
    for (const event of [
      Object.freeze({ type: "CHUNK" }),
      Object.freeze({ type: "TOOL" }),
      Object.freeze({ type: "STOP_CLICKED" }),
      Object.freeze({ type: "DONE", runId: "run-1", reason: "complete" }),
      Object.freeze({ type: "SOCKET_CLOSED" }),
      Object.freeze({ type: "CONFIRM_FLUSH" }),
      Object.freeze({ type: "SEND_FAILED", clientMsgId: "m1", code: "session_busy" }),
    ]) {
      const next = reduceRunState(frozenRunning, event);
      expect(next).not.toBe(frozenRunning);
      expect(frozenRunning).toEqual(runningSnapshot);
    }
  });

  it("Phase 5: RESUME_ATTACH from idle attaches as running with the stream already started", () => {
    const state = reduceRunState(Object.freeze(createSessionRunState()), {
      type: "RESUME_ATTACH",
      runId: "run-9",
      messageId: "msg-9",
      seq: 12,
    });
    expect(state.phase).toBe(kRunning);
    expect(state.activeRunId).toBe("run-9");
    expect(state.activeMessageId).toBe("msg-9");
    expect(state.assistantStreamStarted).toBe(true);
    expect(isRunActive(state)).toBe(true);
  });

  it("Phase 5: RESUME_ATTACH from interruptedLocal reattaches; from running it is ignored", () => {
    const interrupted = reduceAll([
      { type: "OUTBOX_INFLIGHT", clientMsgId: "m1" },
      { type: "STARTED", clientMsgId: "m1", runId: "run-1", messageId: "msg-1" },
      { type: "SOCKET_CLOSED" },
    ]);
    expect(interrupted.phase).toBe(kInterruptedLocal);

    const reattached = reduceRunState(interrupted, {
      type: "RESUME_ATTACH",
      runId: "run-1",
      messageId: "msg-1",
      seq: 4,
    });
    expect(reattached.phase).toBe(kRunning);
    expect(reattached.activeRunId).toBe("run-1");
    expect(reattached.assistantStreamStarted).toBe(true);

    // Already running: a resume-attach must not disturb the live run.
    const ignored = reduceRunState(reattached, {
      type: "RESUME_ATTACH",
      runId: "run-other",
      messageId: "msg-other",
      seq: 1,
    });
    expect(ignored).toBe(reattached);
    expect(ignored.activeRunId).toBe("run-1");
  });

  it("Phase 5: RESUME_FAILED settles only the matching runId", () => {
    const running = reduceRunState(createSessionRunState(), {
      type: "RESUME_ATTACH",
      runId: "run-9",
      messageId: "msg-9",
      seq: 2,
    });
    expect(running.phase).toBe(kRunning);

    // Different runId: ignored.
    const ignored = reduceRunState(running, {
      type: "RESUME_FAILED",
      runId: "run-other",
    });
    expect(ignored).toBe(running);
    expect(ignored.phase).toBe(kRunning);

    // Matching runId: back to idle.
    const settled = reduceRunState(running, {
      type: "RESUME_FAILED",
      runId: "run-9",
    });
    expect(settled.phase).toBe(kIdle);
    expect(settled.activeRunId).toBe("");
  });
});
