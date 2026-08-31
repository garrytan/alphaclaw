// In-memory run registry for the chat bridge.
//
//   registry = LIVE ROUTING TRUTH (which browser socket gets which run's
//   frames, right now); db/chat-runs = DURABLE OUTCOME TRUTH (what happened
//   to every send, across restarts). Never conflate the two.
//
// One RunRecord per accepted browser send. ONE active record per session
// (D7) — a second concurrent send gets `session_busy` and queues client-side.
// Dedupe keys bind the session (`sessionKey|clientMsgId`): clientMsgId is
// client-controlled and must never collide across sessions.
//
// finalize() is the atomic compare-and-finalize (D8): its first act flips
// record.finalized (single-threaded Node makes that a CAS) — the winner emits
// the ONE terminal frame + store write; every later terminal path (lifecycle
// end, stop timer, stall sweeper, RPC rejection, gateway disconnect,
// stop-failed) no-ops. Browser-socket close does NOT finalize a run: the
// record persists to its real terminal; frames to closed sockets drop and
// reconnect history reconciles.

// Bound the buffer: foreign (Telegram/Slack/cron) runs get events buffered
// here but never a matching browser chat.send, so without caps a single
// foreign run grows unboundedly and the map accumulates forever (H13).
const kMaxBufferedRuns = 64;
const kMaxEventsPerRun = 200;

const recordKey = (sessionKey, clientMsgId) =>
  `${String(sessionKey || "")}\n${String(clientMsgId || "")}`;

const createRunRegistry = () => {
  const byKey = new Map(); // `${sessionKey}\n${clientMsgId}` -> record
  const byRunId = new Map(); // runId -> record
  const activeBySession = new Map(); // sessionKey -> record
  const browserRecords = new WeakMap(); // ws -> Set<record>
  const pendingAgentEventsByRunId = new Map(); // runId -> [eventPayload]

  const countForBrowser = (ws) => browserRecords.get(ws)?.size || 0;

  const createRecord = ({ clientMsgId, sessionKey, ws, messageId, now }) => {
    const record = {
      clientMsgId: String(clientMsgId || ""),
      sessionKey: String(sessionKey || ""),
      // Attached sockets (Phase 5 resume): the originator plus any tab that
      // resumed onto this run. Live frames fan out to every attached socket;
      // close removes one; the grace window starts when the set empties.
      sockets: new Set([ws]),
      messageId: String(messageId || ""),
      runId: "",
      state: "pending", // pending | running | stopping
      rpcWritten: false,
      finalized: false,
      stopRequested: false,
      stopConfirmTimer: null,
      createdAt: Number(now) || Date.now(),
      startedAt: 0,
      lastEventAt: Number(now) || Date.now(),
      lastSeq: 0,
      // Replay buffer for resume: stream frames with their seq, byte-capped
      // (drop-oldest sets replayGap so a resume knows to refetch history).
      replay: [],
      replayBytes: 0,
      replayGap: false,
      resumable: true,
      graceTimer: null,
    };
    byKey.set(recordKey(record.sessionKey, record.clientMsgId), record);
    activeBySession.set(record.sessionKey, record);
    const set = browserRecords.get(ws);
    if (set) set.add(record);
    else browserRecords.set(ws, new Set([record]));
    return record;
  };

  const promote = (record, runId) => {
    record.runId = String(runId || "");
    // A stop that arrived during the send window already moved the record to
    // "stopping" — promotion must not clobber it, or a racing lifecycle:end
    // would record the user's stop as a natural completion.
    if (record.state !== "stopping") record.state = "running";
    if (record.runId) byRunId.set(record.runId, record);
  };

  /**
   * Atomic compare-and-finalize. Returns true exactly once per record — the
   * caller that wins emits the terminal frame and writes the store row.
   */
  const finalize = (record) => {
    if (!record || record.finalized) return false;
    record.finalized = true;
    if (record.stopConfirmTimer) {
      clearTimeout(record.stopConfirmTimer);
      record.stopConfirmTimer = null;
    }
    if (record.graceTimer) {
      clearTimeout(record.graceTimer);
      record.graceTimer = null;
    }
    byKey.delete(recordKey(record.sessionKey, record.clientMsgId));
    if (record.runId && byRunId.get(record.runId) === record) {
      byRunId.delete(record.runId);
    }
    if (activeBySession.get(record.sessionKey) === record) {
      activeBySession.delete(record.sessionKey);
    }
    for (const ws of record.sockets) {
      const set = browserRecords.get(ws);
      if (set) {
        set.delete(record);
        if (set.size === 0) browserRecords.delete(ws);
      }
    }
    // No live send anywhere → buffered early events can never flush (H13
    // hygiene, same purge point as the old last-browser-disconnect clear).
    if (byKey.size === 0) pendingAgentEventsByRunId.clear();
    return true;
  };

  // A browser socket closed: detach it from every record it was attached to.
  // Closing NEVER finalizes a run — the record lives to its real terminal.
  // Returns the records whose socket set just emptied (grace-window
  // candidates for the caller to arm).
  const detachSocket = (ws) => {
    const emptied = [];
    for (const record of byKey.values()) {
      if (!record.sockets.has(ws)) continue;
      record.sockets.delete(ws);
      if (record.sockets.size === 0) emptied.push(record);
    }
    browserRecords.delete(ws);
    return emptied;
  };

  const attachSocket = (record, ws) => {
    if (record.finalized) return;
    record.sockets.add(ws);
    if (record.graceTimer) {
      clearTimeout(record.graceTimer);
      record.graceTimer = null;
    }
    const set = browserRecords.get(ws);
    if (set) set.add(record);
    else browserRecords.set(ws, new Set([record]));
  };

  const bufferEvent = (runId, eventPayload) => {
    const normalizedRunId = String(runId || "");
    if (!normalizedRunId || byRunId.has(normalizedRunId)) return;
    const list = pendingAgentEventsByRunId.get(normalizedRunId) || [];
    if (list.length < kMaxEventsPerRun) list.push(eventPayload);
    pendingAgentEventsByRunId.set(normalizedRunId, list);
    // FIFO-evict the oldest buffered run once over the global cap so a
    // stream of distinct foreign runIds can't grow the map forever (H13).
    if (pendingAgentEventsByRunId.size > kMaxBufferedRuns) {
      const oldestRunId = pendingAgentEventsByRunId.keys().next().value;
      if (oldestRunId !== normalizedRunId) {
        pendingAgentEventsByRunId.delete(oldestRunId);
      }
    }
  };

  const drainBufferedEvents = (runId) => {
    const list = pendingAgentEventsByRunId.get(String(runId || ""));
    if (!list || list.length === 0) return [];
    pendingAgentEventsByRunId.delete(String(runId || ""));
    return list;
  };

  // H16 solo fallback: exactly one STARTED record in the whole registry.
  const soloStartedRecord = () => {
    if (byRunId.size !== 1) return null;
    return byRunId.values().next().value || null;
  };

  return {
    createRecord,
    promote,
    finalize,
    detachSocket,
    attachSocket,
    countForBrowser,
    getByKey: (sessionKey, clientMsgId) =>
      byKey.get(recordKey(sessionKey, clientMsgId)) || null,
    getByRunId: (runId) => byRunId.get(String(runId || "")) || null,
    getActiveForSession: (sessionKey) =>
      activeBySession.get(String(sessionKey || "")) || null,
    hasRunId: (runId) => byRunId.has(String(runId || "")),
    liveRecords: () => Array.from(byKey.values()),
    startedRecords: () => Array.from(byRunId.values()),
    soloStartedRecord,
    bufferEvent,
    drainBufferedEvents,
    clearAllBuffers: () => pendingAgentEventsByRunId.clear(),
    bufferStats: () => ({
      runs: pendingAgentEventsByRunId.size,
      events: Array.from(pendingAgentEventsByRunId.values()).reduce(
        (total, list) => total + list.length,
        0,
      ),
    }),
    stats: () => ({
      live: byKey.size,
      started: byRunId.size,
      sessions: activeBySession.size,
    }),
  };
};

module.exports = { createRunRegistry, kMaxBufferedRuns, kMaxEventsPerRun };
