// Browser-frame handlers + gateway-event routing for the chat bridge.
//
// Lifecycle contract (D7/D8/D9):
//   - ONE active browser run per session; a second send gets `session_busy`
//     (retryable) and queues client-side.
//   - Every terminal path funnels through finalizeAndEmit — the atomic
//     registry.finalize decides the single winner, which emits the ONE
//     terminal frame and writes the durable store row. A run that STARTED
//     terminates with a `done`; a record that never started settles with a
//     `send-failed` (v2) or plain error frame (legacy bundle).
//   - Ambiguous outcomes are UNKNOWN: an RPC failure after the chat.send
//     frame reached the gateway socket (rpcWritten) finalizes as `unknown`,
//     never as a retryable failure — the gateway may have accepted it.
const crypto = require("node:crypto");
const {
  validateMessageFrame,
  isValidId,
  isValidOptionalId,
  kMaxLiveRecordsPerBrowser,
  kStopConfirmTimeoutMs,
  kRunStallMs,
  kDedupeTerminalWindowMs,
} = require("./protocol");
const { classifyError, toStoredErrorText } = require("./errors");
const {
  collectTextFromUnknownShape,
  extractToolCallFromUnknownShape,
  extractToolResultFromUnknownShape,
} = require("./history");
const { kGatewayReqTimeoutMs } = require("./gateway-client");

const resolveRunIdFromPayload = (payload = {}) =>
  String(
    payload?.runId ||
      payload?.run?.id ||
      payload?.data?.runId ||
      payload?.data?.run?.id ||
      payload?.meta?.runId ||
      "",
  ).trim();

const resolveSessionKeyFromPayload = (payload = {}) =>
  String(
    payload?.sessionKey ||
      payload?.session?.key ||
      payload?.data?.sessionKey ||
      payload?.data?.session?.key ||
      payload?.meta?.sessionKey ||
      "",
  ).trim();

const kInterruptedDisconnectDetail =
  "Connection to the agent was lost — the agent may have kept working.";
// Copy derives from the ACTUAL stall threshold so a timing override can
// never desynchronize the user-facing wording from the behavior.
const stallDetailFor = (stallMs) =>
  `No output for ${Math.max(1, Math.round(stallMs / 60000))}+ minutes — the run may still be executing.`;
const kUnknownOutcomeMessage =
  "This message may have been sent — check the transcript before retrying.";

const createSendService = ({
  registry,
  requestGateway,
  store,
  sendJson,
  sendStream,
  sendControl,
  insertWatchdogEvent = null,
  now = () => Date.now(),
  log = (line) => console.log(line),
  // Timing overrides exist for tests only (short real-time waits instead of
  // fake-timer gymnastics against live sockets); production uses the
  // protocol.js constants.
  stopConfirmMs = kStopConfirmTimeoutMs,
  stallMs = kRunStallMs,
}) => {
  const logTransition = (record, transition, extra = "") => {
    log(
      `[alphaclaw] chat-run ${record.clientMsgId} ${record.runId || "-"} ${record.sessionKey} ${transition}${extra ? ` ${extra}` : ""}`,
    );
  };

  const sendSendFailure = (
    ws,
    { legacy, clientMsgId, sessionKey, messageId },
    classified,
  ) => {
    if (legacy) {
      // Old bundles only understand plain error frames.
      sendJson(ws, {
        type: "error",
        message: classified.message,
        messageId,
        ...(sessionKey ? { sessionKey } : {}),
      });
      return;
    }
    sendJson(ws, {
      type: "send-failed",
      clientMsgId,
      sessionKey,
      code: classified.code,
      retryable: classified.retryable === true,
      message: classified.message,
    });
  };

  /**
   * The single terminal path (D8). Returns true when this caller won the
   * finalize race — the winner writes the store row and emits exactly one
   * terminal frame: `done` for started runs (and stop terminals), a
   * send-failed / legacy error frame for records that never started.
   */
  const finalizeAndEmit = (
    record,
    reason,
    confidence,
    {
      detail = "",
      errorCode = "",
      stopConfirmed = null,
      legacyErrorMessage = "",
      retryable = false,
      storeStatus = "",
    } = {},
  ) => {
    if (!registry.finalize(record)) return false;
    const status = storeStatus || (reason === "complete" ? "done" : reason);
    logTransition(record, `terminal:${status}`, `(${confidence})`);
    store.markTerminal({
      sessionKey: record.sessionKey,
      clientMsgId: record.clientMsgId,
      status,
      confidence,
      stopConfirmed,
      errorCode,
      error: detail,
      lastSeq: record.lastSeq,
      messageId: record.messageId,
      runId: record.runId,
    });
    if (legacyErrorMessage) {
      // Old-bundle compat: chat-error events used to surface as a plain error
      // frame; keep that alongside the structured terminal.
      sendControl(record, {
        type: "error",
        message: legacyErrorMessage,
        messageId: record.messageId,
        sessionKey: record.sessionKey,
      });
    }
    const emitDone = Boolean(record.runId) || reason === "stopped";
    if (emitDone) {
      sendStream(record, {
        type: "done",
        sessionKey: record.sessionKey,
        ...(record.runId ? { runId: record.runId } : {}),
        messageId: record.messageId,
        reason,
        confidence,
        ...(reason === "stopped" ? { stopped: true } : {}),
        ...(detail ? { detail } : {}),
      });
    } else {
      // Never-started record: the outbox item settles via a failure frame,
      // fanned to every attached socket (unknown ids no-op in other tabs).
      for (const ws of record.sockets) {
        sendSendFailure(
          ws,
          {
            legacy: record.legacy === true && !legacyErrorMessage,
            clientMsgId: record.clientMsgId,
            sessionKey: record.sessionKey,
            messageId: record.messageId,
          },
          {
            code: errorCode || "run_failed",
            retryable,
            message: detail || "Something went wrong. Please try again.",
          },
        );
      }
    }
    return true;
  };

  const replayTerminalFromRow = (ws, row) => {
    const status = String(row?.status || "");
    if (status === "error" || status === "unknown") {
      sendJson(ws, {
        type: "send-failed",
        clientMsgId: row.clientMsgId,
        sessionKey: row.sessionKey,
        code:
          status === "unknown" ? "unknown_outcome" : row.errorCode || "run_failed",
        retryable: false,
        message:
          status === "unknown"
            ? kUnknownOutcomeMessage
            : row.error || "The previous attempt for this message failed.",
      });
      return;
    }
    sendJson(ws, {
      type: "done",
      sessionKey: row.sessionKey,
      ...(row.runId ? { runId: row.runId } : {}),
      messageId: row.messageId || "",
      reason: status === "done" ? "complete" : status,
      confidence: row.confidence || "confirmed",
      ...(status === "stopped" ? { stopped: true } : {}),
      seq: Number(row.lastSeq) || 0,
    });
  };

  const abortSession = (sessionKey) =>
    requestGateway("chat.abort", { sessionKey }, kGatewayReqTimeoutMs);

  const armStopConfirmTimer = (record) => {
    if (record.stopConfirmTimer || record.finalized) return;
    record.stopConfirmTimer = setTimeout(() => {
      record.stopConfirmTimer = null;
      // Abort RPC succeeded but no lifecycle:end arrived — terminal, honestly
      // unconfirmed (stop_confirmed=0).
      finalizeAndEmit(record, "stopped", "unconfirmed", { stopConfirmed: 0 });
    }, stopConfirmMs);
    if (typeof record.stopConfirmTimer?.unref === "function") {
      record.stopConfirmTimer.unref();
    }
  };

  const performAbort = async (record) => {
    try {
      await abortSession(record.sessionKey);
    } catch (err) {
      const classified = classifyError(err);
      // A lifecycle end that won the race already emitted the terminal — the
      // late abort failure is swallowed (never mutate a finalized record).
      if (record.finalized) return;
      record.state = record.runId ? "running" : "pending";
      record.stopRequested = false;
      sendControl(record, {
        type: "stop-failed",
        sessionKey: record.sessionKey,
        ...(record.runId ? { runId: record.runId } : {}),
        code: classified.code,
        message: "Couldn't stop the run — try again.",
      });
      return;
    }
    if (record.finalized) return;
    armStopConfirmTimer(record);
  };

  const handleMessage = async ({ ws, payload }) => {
    const legacy = !payload?.clientMsgId;
    const messageId = crypto.randomUUID();
    const sessionKey = String(payload?.sessionKey || "").trim();
    const validation = validateMessageFrame(payload);
    if (!validation.ok) {
      sendSendFailure(
        ws,
        {
          legacy,
          clientMsgId: String(payload?.clientMsgId || ""),
          sessionKey,
          messageId,
        },
        {
          code: validation.code || "protocol_invalid",
          retryable: false,
          message: validation.message,
        },
      );
      return;
    }
    const content = String(payload?.content || "").trim();
    const clientMsgId = String(payload?.clientMsgId || "") || crypto.randomUUID();

    // Dedupe (D4): a live record re-acks (and re-announces the run); a recent
    // TERMINAL row re-acks AND replays the stored terminal so a retried
    // outbox item always settles — never a second chat.send.
    const existing = registry.getByKey(sessionKey, clientMsgId);
    if (existing) {
      // A retry from a fresh socket (another tab / post-reconnect) wants the
      // live stream too.
      registry.attachSocket(existing, ws);
      sendJson(ws, { type: "ack", clientMsgId, sessionKey });
      if (existing.runId) {
        sendJson(ws, {
          type: "started",
          clientMsgId,
          sessionKey,
          runId: existing.runId,
          messageId: existing.messageId,
          seq: 1,
        });
      }
      return;
    }
    const terminalRow = store.findRecentTerminal({
      sessionKey,
      clientMsgId,
      windowMs: kDedupeTerminalWindowMs,
      now: now(),
    });
    if (terminalRow) {
      sendJson(ws, { type: "ack", clientMsgId, sessionKey });
      replayTerminalFromRow(ws, terminalRow);
      return;
    }

    // One active run per session (D7): attribution stays unambiguous and a
    // session-scoped chat.abort is effectively run-scoped for browser traffic.
    if (registry.getActiveForSession(sessionKey)) {
      sendSendFailure(
        ws,
        { legacy, clientMsgId, sessionKey, messageId },
        {
          code: "session_busy",
          retryable: true,
          message: "Another message is still running in this session.",
        },
      );
      return;
    }
    if (registry.countForBrowser(ws) >= kMaxLiveRecordsPerBrowser) {
      sendSendFailure(
        ws,
        { legacy, clientMsgId, sessionKey, messageId },
        {
          code: "too_many_pending",
          retryable: true,
          message: "Too many messages are in flight from this window.",
        },
      );
      return;
    }

    // Register BEFORE the RPC: a stop arriving during the send window finds
    // the record instead of missing the run entirely.
    const record = registry.createRecord({
      clientMsgId,
      sessionKey,
      ws,
      messageId,
      now: now(),
    });
    record.legacy = legacy;
    store.recordSend({ sessionKey, clientMsgId, messageId });
    logTransition(record, "accepted->pending");
    sendJson(ws, { type: "ack", clientMsgId, sessionKey });

    let result;
    try {
      result = await requestGateway(
        "chat.send",
        {
          sessionKey,
          message: content,
          idempotencyKey: clientMsgId,
        },
        kGatewayReqTimeoutMs,
        {
          onFrameWritten: () => {
            record.rpcWritten = true;
          },
        },
      );
    } catch (err) {
      const classified = classifyError(err);
      if (record.finalized) return;
      if (record.rpcWritten && err?.gatewayResponded !== true) {
        // Post-write ambiguity (timeout / disconnect mid-RPC — NOT an explicit
        // gateway rejection): the gateway may have accepted the send. Never
        // auto-retry (D9b) — surface as unknown with manual Retry/Discard.
        finalizeAndEmit(record, "error", "unconfirmed", {
          storeStatus: "unknown",
          errorCode: "unknown_outcome",
          detail: kUnknownOutcomeMessage,
          retryable: false,
        });
        return;
      }
      finalizeAndEmit(record, "error", "confirmed", {
        errorCode: classified.code,
        detail: toStoredErrorText(classified),
        retryable: classified.retryable === true,
      });
      return;
    }

    const runId = String(result?.runId || "").trim();
    if (record.finalized) {
      // A stop (or timer) won while chat.send was in flight — the run must
      // not survive as an orphan: abort it and never announce it.
      if (runId) abortSession(sessionKey).catch(() => {});
      return;
    }
    if (!runId) {
      finalizeAndEmit(record, "error", "confirmed", {
        errorCode: "run_failed",
        detail: "Something went wrong connecting to the agent.",
      });
      return;
    }
    registry.promote(record, runId);
    store.markRunning({ sessionKey, clientMsgId, runId });
    logTransition(record, "pending->running");
    sendStream(record, {
      type: "started",
      clientMsgId,
      sessionKey,
      runId,
      messageId,
    });
    for (const buffered of registry.drainBufferedEvents(runId)) {
      handleGatewayEvent(buffered);
    }
    if (record.stopRequested && !record.finalized) {
      await performAbort(record).catch(() => {});
    }
  };

  const handleStop = async ({ ws, payload }) => {
    const sessionKey = String(payload?.sessionKey || "").trim();
    if (!sessionKey) {
      sendJson(ws, {
        type: "error",
        message: "sessionKey is required",
      });
      return;
    }
    // Same trust boundary as message frames: client-supplied ids never reach
    // gateway RPCs unvalidated.
    if (!isValidId(sessionKey) || !isValidOptionalId(payload?.runId)) {
      sendJson(ws, { type: "error", message: "sessionKey is invalid" });
      return;
    }
    const requestedRunId = String(payload?.runId || "").trim();
    let record = requestedRunId ? registry.getByRunId(requestedRunId) : null;
    if (!record) record = registry.getActiveForSession(sessionKey);
    if (record && record.sessionKey !== sessionKey) record = null;

    if (!record) {
      // No tracked browser run — still honor the stop session-wide (a foreign
      // or already-forgotten run may be live gateway-side).
      await abortSession(sessionKey);
      sendJson(ws, { type: "done", sessionKey, reason: "stopped", stopped: true });
      return;
    }

    record.stopRequested = true;
    record.state = "stopping";
    store.markStopRequested({
      sessionKey: record.sessionKey,
      clientMsgId: record.clientMsgId,
    });
    logTransition(record, "->stopping");
    sendControl(record, {
      type: "stopping",
      sessionKey: record.sessionKey,
      ...(record.runId ? { runId: record.runId } : {}),
    });
    await performAbort(record);
  };

  const handleGatewayEvent = (eventPayload = {}) => {
    const eventName = String(eventPayload.event || "");
    const payload = eventPayload.payload || {};
    const resolveTargetRecord = () => {
      const runId = resolveRunIdFromPayload(payload);
      if (runId) {
        const record = registry.getByRunId(runId);
        if (record) return record;
        // Explicit-but-unknown runId: NEVER fall through to session routing —
        // a finalized run's late output would attach to the next run. Buffer
        // for the chat.send race (H13 caps) instead.
        registry.bufferEvent(runId, eventPayload);
        return null;
      }
      const sessionKey = resolveSessionKeyFromPayload(payload);
      if (sessionKey) {
        return registry.getActiveForSession(sessionKey);
      }
      // Solo-browser fallback ONLY for id-less events: an event that carries a
      // runId/sessionKey which matched nothing above belongs to a foreign run
      // (Telegram/Slack/Discord) — routing it to the one browser would bleed
      // another conversation's output into the chat and, on lifecycle:end,
      // truncate the browser's own reply (H16).
      return registry.soloStartedRecord();
    };

    if (eventName === "agent") {
      const record = resolveTargetRecord();
      if (!record) return;
      record.lastEventAt = now();
      const stream = String(payload?.stream || "");
      const data = payload?.data || {};
      if (stream === "tool") {
        const toolPhase = String(data?.phase || "");
        const toolName = String(data?.name || "unknown");
        const toolCallId = String(data?.toolCallId || "");
        if (toolPhase === "start") {
          sendStream(record, {
            type: "tool",
            phase: "call",
            messageId: record.messageId,
            sessionKey: record.sessionKey,
            ...(record.runId ? { runId: record.runId } : {}),
            timestamp: Number(payload?.ts) || now(),
            toolCall: {
              id: toolCallId,
              name: toolName,
              arguments: data?.args || null,
              partialJson: "",
            },
            toolResult: null,
            rawEvent: eventPayload || null,
          });
        } else if (toolPhase === "result") {
          const resultText = collectTextFromUnknownShape(data?.result);
          sendStream(record, {
            type: "tool",
            phase: "result",
            messageId: record.messageId,
            sessionKey: record.sessionKey,
            ...(record.runId ? { runId: record.runId } : {}),
            timestamp: Number(payload?.ts) || now(),
            toolCall: null,
            toolResult: {
              role: "toolResult",
              toolCallId,
              toolName,
              content: resultText ? [{ type: "text", text: resultText }] : [],
              isError: data?.isError === true,
            },
            rawEvent: eventPayload || null,
          });
        }
        return;
      }
      // Fast path: a plain-text assistant delta is the hottest event (token
      // rate) — skip four recursive unknown-shape scans ONLY when every key
      // is a known scalar (an exotic event embedding a tool shape anywhere
      // must keep the full scanner path).
      const kPlainDeltaKeys = new Set([
        "delta",
        "text",
        "runId",
        "run",
        "ts",
        "sessionKey",
        "session",
      ]);
      const isPlainDelta =
        stream === "assistant" &&
        (typeof data?.delta === "string" || typeof data?.text === "string") &&
        payload?.content === undefined &&
        payload?.part === undefined &&
        payload?.item === undefined &&
        payload?.message === undefined &&
        payload?.value === undefined &&
        data &&
        Object.keys(data).every((key) => kPlainDeltaKeys.has(key));
      if (isPlainDelta) {
        const fastDelta = String(
          (data?.delta == null || data?.delta === "" ? data?.text : data?.delta) ||
            "",
        );
        if (fastDelta) {
          sendStream(record, {
            type: "chunk",
            messageId: record.messageId,
            content: fastDelta,
            sessionKey: record.sessionKey,
            ...(record.runId ? { runId: record.runId } : {}),
          });
        }
        return;
      }
      const toolCall =
        extractToolCallFromUnknownShape(payload) ||
        extractToolCallFromUnknownShape(data);
      if (toolCall) {
        sendStream(record, {
          type: "tool",
          phase: "call",
          messageId: record.messageId,
          sessionKey: record.sessionKey,
          ...(record.runId ? { runId: record.runId } : {}),
          timestamp: now(),
          toolCall,
          toolResult: null,
          rawEvent: eventPayload || null,
        });
      }
      const toolResult =
        extractToolResultFromUnknownShape(payload) ||
        extractToolResultFromUnknownShape(data);
      if (toolResult) {
        sendStream(record, {
          type: "tool",
          phase: "result",
          messageId: record.messageId,
          sessionKey: record.sessionKey,
          ...(record.runId ? { runId: record.runId } : {}),
          timestamp: Number(toolResult?.timestamp) || now(),
          toolCall: null,
          toolResult,
          rawEvent: eventPayload || null,
        });
      }
      if (stream === "assistant") {
        const rawDelta =
          data?.delta == null || data?.delta === "" ? data?.text : data?.delta;
        const delta = String(rawDelta || "");
        if (!delta) return;
        sendStream(record, {
          type: "chunk",
          messageId: record.messageId,
          content: delta,
          sessionKey: record.sessionKey,
          ...(record.runId ? { runId: record.runId } : {}),
        });
        return;
      }
      if (stream === "lifecycle" && String(data?.phase || "") === "end") {
        if (record.state === "stopping") {
          finalizeAndEmit(record, "stopped", "confirmed", { stopConfirmed: 1 });
        } else {
          finalizeAndEmit(record, "complete", "confirmed");
        }
      }
      return;
    }
    if (eventName === "chat") {
      const record = resolveTargetRecord();
      if (!record) return;
      record.lastEventAt = now();
      if (String(payload?.state || "") === "error") {
        finalizeAndEmit(record, "error", "confirmed", {
          errorCode: "run_failed",
          detail: "Something went wrong connecting to the agent.",
          legacyErrorMessage: "Something went wrong connecting to the agent.",
        });
      }
    }
  };

  // Gateway disconnect (restart/crash): every STARTED record gets an honest
  // interrupted terminal — the fix for "UI streams forever". Pending records
  // settle through their own chat.send rejection (rpcWritten decides
  // retryable vs unknown).
  const onGatewayDisconnect = () => {
    for (const record of registry.startedRecords()) {
      finalizeAndEmit(record, "interrupted", "unconfirmed", {
        detail: kInterruptedDisconnectDetail,
      });
    }
    registry.clearAllBuffers();
  };

  // Run stall sweeper: a run that stops emitting events without a lifecycle
  // end is terminalized honestly instead of leaving the UI streaming forever.
  const sweepStalledRuns = () => {
    const nowMs = now();
    for (const record of registry.startedRecords()) {
      if (nowMs - record.lastEventAt <= stallMs) continue;
      const silentForMs = nowMs - record.lastEventAt;
      const won = finalizeAndEmit(record, "interrupted", "unconfirmed", {
        detail: stallDetailFor(stallMs),
      });
      if (won && typeof insertWatchdogEvent === "function") {
        try {
          // Chat-domain telemetry riding the general ops event stream (the
          // notification_abandoned precedent) — info severity, never creates
          // or escalates a gateway-health incident.
          insertWatchdogEvent({
            eventType: "chat_run_stall_interrupted",
            source: "chat",
            status: "info",
            details: {
              sessionKey: record.sessionKey,
              runId: record.runId,
              clientMsgId: record.clientMsgId,
              silentForMs,
            },
          });
        } catch {}
      }
    }
  };

  // Phase 5 resume: re-attach a (typically hard-refreshed) socket to a live
  // run and replay buffered stream frames past the client's cursor. The
  // client sends `resume` BEFORE `history` on the same socket — FIFO frame
  // processing guarantees replay-before-history with zero server-side gating.
  const handleResume = ({ ws, payload }) => {
    const sessionKey = String(payload?.sessionKey || "").trim();
    const runId = String(payload?.runId || "").trim();
    const afterSeq = Math.max(0, Number(payload?.afterSeq) || 0);
    if (!isValidId(sessionKey) || !isValidId(runId)) {
      sendJson(ws, {
        type: "resume-failed",
        sessionKey,
        runId,
        code: "unknown_run",
      });
      return;
    }
    const record = registry.getByRunId(runId);
    if (
      !record ||
      record.sessionKey !== sessionKey ||
      record.resumable === false
    ) {
      // Finalized between hello and resume (or grace expired): the terminal
      // went to the dead pre-refresh socket — history is the fallback, the
      // client must never hang in a streaming state.
      sendJson(ws, {
        type: "resume-failed",
        sessionKey,
        runId,
        code: "unknown_run",
      });
      return;
    }
    registry.attachSocket(record, ws);
    const buffered = record.replay.filter((entry) => entry.seq > afterSeq);
    for (const entry of buffered) {
      sendJson(ws, entry.framed);
    }
    const firstSeq = buffered.length ? buffered[0].seq : null;
    // gap: the requested range predates what the byte-capped buffer retained
    // — the client refetches history to fill the hole.
    const gap =
      firstSeq !== null ? firstSeq > afterSeq + 1 : record.lastSeq > afterSeq;
    sendJson(ws, {
      type: "resumed",
      sessionKey,
      runId,
      fromSeq: firstSeq === null ? afterSeq + 1 : firstSeq,
      toSeq: record.lastSeq,
      gap: gap === true,
    });
  };

  return {
    handleMessage,
    handleStop,
    handleResume,
    handleGatewayEvent,
    onGatewayDisconnect,
    sweepStalledRuns,
  };
};

module.exports = { createSendService };
