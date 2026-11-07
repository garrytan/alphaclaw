import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { authFetch } from "../../lib/api.js";
import { kChatSendOutboxStorageKey } from "../../lib/storage-keys.js";
import { showToast } from "../toast.js";
import { useChatConnection } from "./use-chat-connection.js";
import { createSendOutbox, kAwaitingHistoryMaxMs } from "./send-outbox.js";
import {
  createSessionRunState,
  reduceRunState,
  canAutoFlush,
  isRunActive,
  kIdle,
  kInterruptedLocal,
} from "./run-state.js";
import {
  mergeHistory,
  composeVisibleMessages,
  applyChunk,
  applyTool,
  appendSessionRows,
  attachSessionToolResult,
  applyForeignChunk,
  keepSlidRows,
} from "./transcript-store.js";
import {
  buildMessageFrame,
  buildStopFrame,
  buildHistoryFrame,
  buildWatchFrame,
  buildUnwatchFrame,
} from "./chat-protocol.js";
import { useVisibleInterval } from "../../hooks/use-visible-interval.js";
import { randomUuid } from "../../lib/random-uuid.js";

// Page-scoped outbox registry (fix wave F125). Handlers are per mount (they
// close over the current mount's setState); the outbox instance is not.
const kSharedOutboxes = new Map();
const acquireSharedOutbox = ({ storage, storageKey, onPersistError, onChange }) => {
  let entry = kSharedOutboxes.get(storageKey);
  if (!entry) {
    entry = { handlers: { onPersistError, onChange }, outbox: null };
    entry.outbox = createSendOutbox({
      storage,
      storageKey,
      onPersistError: (...args) => entry.handlers.onPersistError?.(...args),
      onChange: (...args) => entry.handlers.onChange?.(...args),
    });
    entry.outbox.restoreOnLoad();
    kSharedOutboxes.set(storageKey, entry);
    return entry.outbox;
  }
  entry.handlers = { onPersistError, onChange };
  return entry.outbox;
};
export const resetSharedChatOutboxesForTests = () => kSharedOutboxes.clear();

const kHistoryDedupeMs = 2000;
const kFlushTickMs = 1000;
const kDebugEventCap = 30;

// Everything is keyed per session — the old chat-route's global
// sending/streaming booleans (and their cross-session bleed) are gone.
export const useChatStore = ({
  enabled = true,
  selectedSessionKey = "",
  onRunStarted,
  onSessionsChanged,
  debugEnabled = false,
}) => {
  const [messagesBySession, setMessagesBySession] = useState({});
  const [runStateBySession, setRunStateBySession] = useState({});
  const [historyMetaBySession, setHistoryMetaBySession] = useState({});
  const historyMetaLiveRef = useRef(historyMetaBySession);
  historyMetaLiveRef.current = historyMetaBySession;
  const [rawHistoryBySession, setRawHistoryBySession] = useState({});
  const [debugEventsBySession, setDebugEventsBySession] = useState({});
  const [stopErrorBySession, setStopErrorBySession] = useState({});
  const [outboxVersion, setOutboxVersion] = useState(0);
  const [persistWarning, setPersistWarning] = useState(false);
  const [lastActivityBySession, setLastActivityBySession] = useState({});
  // Status line of a run in this session: our own run's model retries, or a
  // run another source started (Telegram, relay, cron) that this tab watches.
  const [runNoteBySession, setRunNoteBySession] = useState({});
  // Older pages loaded with "Load older" (ALPH-68), and the newest window and
  // markers of the last history read, so either can re-merge with the other.
  const olderRowsBySessionRef = useRef({});
  const tailBySessionRef = useRef({});
  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;

  const selectedSessionKeyRef = useRef(selectedSessionKey);
  selectedSessionKeyRef.current = selectedSessionKey;
  const runStateRef = useRef({});
  runStateRef.current = runStateBySession;
  const messagesRef = useRef({});
  messagesRef.current = messagesBySession;
  const onRunStartedRef = useRef(onRunStarted);
  onRunStartedRef.current = onRunStarted;

  const latestReqIdBySessionRef = useRef({});
  const olderReqIdBySessionRef = useRef({});
  const lastFetchAtBySessionRef = useRef({});
  const scheduledRefetchBySessionRef = useRef({});
  // Resume cursor (Phase 5): highest stream seq seen per session, so a
  // same-tab reconnect replays only what it missed (a hard refresh starts
  // from 0 and the transcript merge dedupes the overlap).
  const lastSeqBySessionRef = useRef({});

  const outboxRef = useRef(null);
  if (!outboxRef.current) {
    let storage = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    // One outbox per PAGE LOAD, not per mount (fix wave F125): the chat route
    // unmounts on every navigation away from /chat, and a per-mount outbox
    // re-ran restoreOnLoad — queued messages stopped auto-sending and were
    // relabelled "pending when the page closed", acked ones flashed "Not sent".
    outboxRef.current = acquireSharedOutbox({
      storage,
      storageKey: kChatSendOutboxStorageKey,
      onPersistError: () => setPersistWarning(true),
      onChange: () => setOutboxVersion((version) => version + 1),
    });
    if (outboxRef.current.isMemoryOnly() && storage !== null) {
      setPersistWarning(true);
    }
  }
  const outbox = outboxRef.current;

  const debugEnabledRef = useRef(debugEnabled);
  debugEnabledRef.current = debugEnabled;
  const appendDebugEvent = useCallback((sessionKey, label, payload) => {
    // Token-rate frames must not churn state for a drawer nobody opened
    // (?chatDebug=1) — and the ring retains full payloads.
    if (!debugEnabledRef.current) return;
    const normalizedSessionKey = String(
      sessionKey || selectedSessionKeyRef.current || "",
    );
    if (!normalizedSessionKey) return;
    setDebugEventsBySession((currentMap) => {
      const existing = currentMap[normalizedSessionKey] || [];
      const nextList = [
        ...existing,
        { at: Date.now(), label: String(label || ""), payload: payload ?? null },
      ].slice(-kDebugEventCap);
      return { ...currentMap, [normalizedSessionKey]: nextList };
    });
  }, []);

  const applyRunEvent = useCallback((sessionKey, event) => {
    if (!sessionKey) return;
    // Socket events and explicit retry can trigger a flush in the same
    // callback, before Preact renders. Publish the state transition to the
    // live ref first so that admission never reads the previous phase/hold.
    const currentMap = runStateRef.current;
    const previous = currentMap[sessionKey] || createSessionRunState();
    const next = reduceRunState(previous, event);
    if (next === previous && currentMap[sessionKey]) return;
    const updated = { ...currentMap, [sessionKey]: next };
    runStateRef.current = updated;
    setRunStateBySession(updated);
  }, []);

  const setHistoryMeta = useCallback((sessionKey, patch) => {
    setHistoryMetaBySession((currentMap) => ({
      ...currentMap,
      [sessionKey]: { ...(currentMap[sessionKey] || {}), ...patch },
    }));
  }, []);

  const applyHistoryPayload = useCallback(
    (sessionKey, payload) => {
      const runState = runStateRef.current[sessionKey] || createSessionRunState();
      const isOlderPage = payload?.page === "older";
      const pageRows = Array.isArray(payload?.messages) ? payload.messages : [];
      if (isOlderPage) {
        const known = new Set((olderRowsBySessionRef.current[sessionKey] || []).map((row) => row.id));
        olderRowsBySessionRef.current[sessionKey] = [
          ...pageRows.filter((row) => !known.has(row.id)),
          ...(olderRowsBySessionRef.current[sessionKey] || []),
        ];
      } else {
        olderRowsBySessionRef.current[sessionKey] = keepSlidRows({
          olderRows: olderRowsBySessionRef.current[sessionKey] || [],
          previousRows: tailBySessionRef.current[sessionKey]?.rows || [],
          nextRows: pageRows,
        });
        tailBySessionRef.current[sessionKey] = {
          rows: pageRows,
          markers: Array.isArray(payload?.markers) ? payload.markers : [],
        };
      }
      const tail = tailBySessionRef.current[sessionKey] || { rows: [], markers: [] };
      setMessagesBySession((currentMap) => ({
        ...currentMap,
        [sessionKey]: mergeHistory({
          current: currentMap[sessionKey] || [],
          rows: tail.rows,
          olderRows: olderRowsBySessionRef.current[sessionKey] || [],
          markers: tail.markers,
          outboxItems: outbox.listForSession(sessionKey),
          activeMessageId: runState.activeMessageId,
          onConfirmed: (clientMsgId) => outbox.confirmDelivered(clientMsgId),
        }),
      }));
      if (isOlderPage) {
        setHistoryMeta(sessionKey, {
          loadingOlder: false,
          error: "",
          olderLoaded: true,
          hasOlder: Boolean(payload?.olderCursor),
          olderCursor: String(payload?.olderCursor || ""),
        });
        return;
      }
      setRawHistoryBySession((currentMap) => ({
        ...currentMap,
        [sessionKey]: payload?.rawHistory || null,
      }));
      setHistoryMetaBySession((currentMap) => {
        const meta = currentMap[sessionKey] || {};
        const olderLoaded = meta.olderLoaded === true;
        return {
          ...currentMap,
          [sessionKey]: {
            ...meta,
            loading: false,
            error: "",
            truncated: payload?.truncated === true,
            hasOlder: olderLoaded
              ? meta.hasOlder === true
              : payload?.truncated === true && Boolean(payload?.oldestMessageId),
            oldestMessageId: String(payload?.oldestMessageId || ""),
            lastFetchedAt: Date.now(),
          },
        };
      });
      lastFetchAtBySessionRef.current[sessionKey] = Date.now();
      // History merged: acked items it did not confirm may be re-sent (F127).
      outbox.releaseAwaitingHistory(sessionKey);
    },
    [outbox, setHistoryMeta],
  );

  const requestHistoryRef = useRef(() => {});
  const flushTickRef = useRef(() => {});

  const handleFrame = useCallback(
    (payload) => {
      const type = String(payload?.type || "");
      const sessionKey = String(payload?.sessionKey || "");
      appendDebugEvent(sessionKey, `ws:${type || "unknown"}`, payload);
      if (type === "history") {
        if (!sessionKey) return;
        if (payload.page === "older") {
          if (payload.reqId && payload.reqId !== olderReqIdBySessionRef.current[sessionKey]) return;
          applyHistoryPayload(sessionKey, payload);
          return;
        }
        const latestReqId = latestReqIdBySessionRef.current[sessionKey];
        if (payload.reqId && latestReqId && payload.reqId !== latestReqId) {
          // Latest-request-wins: a superseded response must never overwrite
          // newer state.
          return;
        }
        applyHistoryPayload(sessionKey, payload);
        return;
      }
      if (type === "sessions") {
        onSessionsChangedRef.current?.();
        return;
      }
      if (!sessionKey) return;
      if (type === "session-event") {
        const kind = String(payload?.kind || "");
        const runId = String(payload?.runId || "");
        setLastActivityBySession((map) => ({ ...map, [sessionKey]: Date.now() }));
        if (kind === "row") {
          setMessagesBySession((currentMap) => ({
            ...currentMap,
            [sessionKey]: appendSessionRows({
              current: currentMap[sessionKey] || [],
              rows: payload.messages,
              runId,
            }),
          }));
          return;
        }
        if (kind === "tool-result") {
          setMessagesBySession((currentMap) => ({
            ...currentMap,
            [sessionKey]: attachSessionToolResult({
              messages: currentMap[sessionKey] || [],
              toolCallId: payload.toolCallId,
              toolResult: payload.toolResult,
            }),
          }));
          return;
        }
        if (kind === "chunk") {
          setMessagesBySession((currentMap) => ({
            ...currentMap,
            [sessionKey]: applyForeignChunk({
              messages: currentMap[sessionKey] || [],
              runId,
              content: payload.content,
              now: Date.now(),
            }),
          }));
          setRunNoteBySession((map) => (map[sessionKey] === "working" ? map : { ...map, [sessionKey]: "working" }));
          return;
        }
        if (kind === "run") {
          const phase = String(payload?.phase || "");
          if (phase === "start") {
            setRunNoteBySession((map) => ({ ...map, [sessionKey]: "working" }));
          } else if (phase === "retrying") {
            setRunNoteBySession((map) => ({ ...map, [sessionKey]: "retrying" }));
          } else {
            setRunNoteBySession((map) => ({ ...map, [sessionKey]: "" }));
            if (phase === "error") requestHistoryRef.current(sessionKey);
          }
        }
        return;
      }
      if (type === "run-status") {
        if (String(payload?.phase || "") === "retrying") {
          setRunNoteBySession((map) => ({ ...map, [sessionKey]: "retrying" }));
        }
        return;
      }
      if (type === "chunk" || type === "tool" || type === "started") {
        setLastActivityBySession((map) => ({ ...map, [sessionKey]: Date.now() }));
      }
      if (type === "chunk" || type === "done" || type === "started") {
        setRunNoteBySession((map) => (map[sessionKey] ? { ...map, [sessionKey]: "" } : map));
      }
      const seq = Number(payload?.seq) || 0;
      if (seq > (lastSeqBySessionRef.current[sessionKey] || 0)) {
        lastSeqBySessionRef.current[sessionKey] = seq;
      }
      if (type === "resumed") {
        // Fill in the live row's stream id (F126) so the forced merge below
        // keeps the still-streaming assistant row as active, never superseded.
        if (payload.messageId) {
          applyRunEvent(sessionKey, {
            type: "RESUME_ATTACH",
            runId: String(payload.runId || ""),
            messageId: String(payload.messageId || ""),
          });
        }
        if (payload.gap === true) {
          // The replay buffer could not cover our cursor — reconcile fully.
          requestHistoryRef.current(sessionKey, { force: true });
        }
        return;
      }
      if (type === "resume-failed") {
        // The run finalized against the dead pre-refresh socket — this is the
        // ONLY exit; fall back to history, never hang in a streaming state.
        applyRunEvent(sessionKey, {
          type: "RESUME_FAILED",
          runId: String(payload.runId || ""),
        });
        lastSeqBySessionRef.current[sessionKey] = 0;
        requestHistoryRef.current(sessionKey, { force: true });
        return;
      }
      if (type === "ack") {
        outbox.markAcked(String(payload.clientMsgId || ""));
        return;
      }
      if (type === "started") {
        // seq is PER-RUN: the session cursor must restart at the new run's
        // origin, or a later resume asks past the run's end and the server
        // replays nothing while frames were actually missed. A re-announce of
        // the run we already track (dedupe re-started) must NOT reset — a
        // regressed cursor would make the next resume replay frames we
        // already applied, duplicating bubble text.
        const trackedRunId = runStateRef.current[sessionKey]?.activeRunId || "";
        const startedRunId = String(payload?.runId || "");
        if (!trackedRunId || trackedRunId !== startedRunId) {
          lastSeqBySessionRef.current[sessionKey] = Number(payload?.seq) || 1;
        }
        applyRunEvent(sessionKey, {
          type: "STARTED",
          clientMsgId: String(payload.clientMsgId || ""),
          runId: String(payload.runId || ""),
          messageId: String(payload.messageId || ""),
        });
        setStopErrorBySession((map) => ({ ...map, [sessionKey]: "" }));
        onRunStartedRef.current?.(sessionKey);
        return;
      }
      if (type === "chunk") {
        setMessagesBySession((currentMap) => ({
          ...currentMap,
          [sessionKey]: applyChunk({
            messages: currentMap[sessionKey] || [],
            messageId: payload.messageId,
            content: payload.content,
            runId: payload.runId,
            now: Date.now(),
          }),
        }));
        applyRunEvent(sessionKey, { type: "CHUNK" });
        return;
      }
      if (type === "tool") {
        setMessagesBySession((currentMap) => ({
          ...currentMap,
          [sessionKey]: applyTool({
            messages: currentMap[sessionKey] || [],
            payload,
            runId: payload.runId,
          }),
        }));
        applyRunEvent(sessionKey, { type: "TOOL" });
        return;
      }
      if (type === "done") {
        applyRunEvent(sessionKey, {
          type: "DONE",
          runId: String(payload.runId || ""),
          reason: String(payload.reason || "complete"),
          confidence: String(payload.confidence || ""),
        });
        requestHistoryRef.current(sessionKey);
        return;
      }
      if (type === "stopping") {
        applyRunEvent(sessionKey, { type: "STOPPING" });
        return;
      }
      if (type === "stop-failed") {
        applyRunEvent(sessionKey, { type: "STOP_FAILED" });
        setStopErrorBySession((map) => ({
          ...map,
          [sessionKey]: String(payload.message || "Couldn't stop the run — try again."),
        }));
        return;
      }
      if (type === "send-failed") {
        const clientMsgId = String(payload.clientMsgId || "");
        const outcome = outbox.markFailed(clientMsgId, {
          code: String(payload.code || ""),
          message: String(payload.message || ""),
          retryable: payload.retryable === true,
          notSubmitted: payload.notSubmitted === true,
        });
        applyRunEvent(sessionKey, {
          type: "SEND_FAILED",
          clientMsgId,
          code: outcome?.status === "unknown" ? "unknown_outcome" : String(payload.code || ""),
        });
        return;
      }
      if (type === "desync") {
        // Backpressure dropped stream frames for this session — reconcile.
        requestHistoryRef.current(sessionKey, { force: true });
        return;
      }
      if (type === "error") {
        // Errors are never fake assistant bubbles — toast + inline chip only.
        // A WS-path history failure must not strand "Refreshing history…"
        // forever: settle loading and surface the Retry affordance.
        setHistoryMetaBySession((currentMap) => {
          const meta = currentMap[sessionKey];
          if (!meta?.loading && !meta?.loadingOlder) return currentMap;
          return {
            ...currentMap,
            [sessionKey]: {
              ...meta,
              loading: false,
              loadingOlder: false,
              error: String(payload.message || "Could not load chat history."),
            },
          };
        });
        outbox.releaseAwaitingHistory(sessionKey, { failed: true });
        if (payload.message) showToast(String(payload.message), "error");
      }
    },
    [appendDebugEvent, applyHistoryPayload, applyRunEvent, outbox],
  );

  // The session this socket watches for rows from other sources (ALPH-68).
  // A socket's watch dies with it; the next hello re-arms it.
  const watchedKeyRef = useRef("");
  const syncWatch = useCallback(() => {
    const conn = connectionRef.current;
    if (!conn?.isOpen() || !conn.isReady() || !conn.supportsFeature?.("watch")) return;
    const target = selectedSessionKeyRef.current || "";
    const previous = watchedKeyRef.current;
    if (previous === target) return;
    if (previous) conn.sendFrame(buildUnwatchFrame({ sessionKey: previous }));
    if (target) conn.sendFrame(buildWatchFrame({ sessionKey: target }));
    watchedKeyRef.current = target;
  }, []);

  const handleClosed = useCallback(() => {
    watchedKeyRef.current = "";
    outbox.requeueAllInflight();
    // An older page asked on the closed socket never answers: re-enable Load
    // older instead of leaving it off until a page reload.
    setHistoryMetaBySession((currentMap) => {
      const stuck = Object.keys(currentMap).filter((sessionKey) => currentMap[sessionKey]?.loadingOlder);
      if (stuck.length === 0) return currentMap;
      const next = { ...currentMap };
      for (const sessionKey of stuck) next[sessionKey] = { ...next[sessionKey], loadingOlder: false };
      return next;
    });
    const states = runStateRef.current;
    for (const sessionKey of Object.keys(states)) {
      if (states[sessionKey]?.phase !== kIdle) {
        applyRunEvent(sessionKey, { type: "SOCKET_CLOSED" });
      }
    }
  }, [applyRunEvent, outbox]);

  // Ordering is client-enforced: on a hello carrying activeRuns, `resume`
  // frames go out BEFORE the history request on the same socket — the
  // bridge's FIFO frame processing then guarantees replay-before-history.
  const handleReady = useCallback(
    (hello) => {
      const conn = connectionRef.current;
      const activeRuns = Array.isArray(hello?.activeRuns) ? hello.activeRuns : [];
      for (const run of activeRuns) {
        const sessionKey = String(run?.sessionKey || "");
        const runId = String(run?.runId || "");
        if (!sessionKey || !runId) continue;
        const afterSeq = lastSeqBySessionRef.current[sessionKey] || 0;
        conn.sendFrame({ type: "resume", sessionKey, runId, afterSeq });
        applyRunEvent(sessionKey, {
          type: "RESUME_ATTACH",
          runId,
          messageId: String(run?.messageId || ""),
        });
      }
      // A run that FINISHED during the outage is absent from activeRuns — its
      // terminal went to the dead socket. Sessions still marked
      // interruptedLocal must settle here or they wedge: history merging
      // never exits that phase and the queue stays blocked forever. holdFlush
      // survives the transition, so queued items still wait for the explicit
      // "Send queued" confirm (the honest ambiguity posture).
      const advertised = new Set(
        activeRuns.map((run) => String(run?.sessionKey || "")),
      );
      const states = runStateRef.current;
      for (const staleKey of Object.keys(states)) {
        if (states[staleKey]?.phase !== kInterruptedLocal) continue;
        if (advertised.has(staleKey)) continue;
        applyRunEvent(staleKey, {
          type: "RESUME_FAILED",
          runId: states[staleKey].activeRunId,
        });
        lastSeqBySessionRef.current[staleKey] = 0;
        requestHistoryRef.current(staleKey, { force: true });
      }
      watchedKeyRef.current = "";
      syncWatch();
      const sessionKey = selectedSessionKeyRef.current;
      if (sessionKey) requestHistoryRef.current(sessionKey, { force: true });
      flushTickRef.current();
    },
    [applyRunEvent, syncWatch],
  );

  const connection = useChatConnection({
    enabled,
    onFrame: handleFrame,
    onClosed: handleClosed,
    onReady: handleReady,
  });
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const requestHistory = useCallback(
    (sessionKey, { force = false } = {}) => {
      const normalized = String(sessionKey || "").trim();
      if (!normalized) return;
      const lastAt = lastFetchAtBySessionRef.current[normalized] || 0;
      if (!force && Date.now() - lastAt < kHistoryDedupeMs) {
        // done + focus + reconnect can stack — coalesce into one delayed pull.
        if (!scheduledRefetchBySessionRef.current[normalized]) {
          scheduledRefetchBySessionRef.current[normalized] = setTimeout(() => {
            scheduledRefetchBySessionRef.current[normalized] = null;
            requestHistoryRef.current(normalized, { force: true });
          }, kHistoryDedupeMs);
        }
        return;
      }
      const reqId = randomUuid();
      latestReqIdBySessionRef.current[normalized] = reqId;
      lastFetchAtBySessionRef.current[normalized] = Date.now();
      setHistoryMeta(normalized, { loading: true, error: "" });
      const conn = connectionRef.current;
      if (conn.isOpen()) {
        conn.sendFrame(buildHistoryFrame({ sessionKey: normalized, reqId }));
        return;
      }
      // HTTP fallback: history stays readable even when the socket cannot
      // connect (read-only mode; sends keep queueing).
      (async () => {
        try {
          const response = await authFetch(
            `/api/chat/history?sessionKey=${encodeURIComponent(normalized)}`,
          );
          const payload = await response.json();
          if (latestReqIdBySessionRef.current[normalized] !== reqId) return;
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error || "Could not load chat history");
          }
          appendDebugEvent(normalized, "http:history-response", payload);
          applyHistoryPayload(normalized, payload);
          connectionRef.current.noteHttpHistoryWorked();
        } catch (err) {
          if (latestReqIdBySessionRef.current[normalized] !== reqId) return;
          setHistoryMeta(normalized, {
            loading: false,
            error: err?.message || "Could not load chat history.",
          });
          // No history to confirm against — do not strand acked items (F127).
          outbox.releaseAwaitingHistory(normalized, { failed: true });
        }
      })();
    },
    [appendDebugEvent, applyHistoryPayload, outbox, setHistoryMeta],
  );
  requestHistoryRef.current = requestHistory;

  // "Load older": one page back through the retained transcript, over the
  // socket only (the HTTP fallback serves the newest window).
  const loadOlder = useCallback(() => {
    const sessionKey = selectedSessionKeyRef.current;
    if (!sessionKey) return;
    const conn = connectionRef.current;
    if (!conn.isOpen() || !conn.supportsFeature?.("history-cursor")) return;
    const meta = historyMetaLiveRef.current[sessionKey] || {};
    if (meta.loadingOlder || meta.hasOlder !== true) return;
    const before = meta.olderLoaded ? String(meta.olderCursor || "") : String(meta.oldestMessageId || "");
    if (!before) return;
    const reqId = randomUuid();
    olderReqIdBySessionRef.current[sessionKey] = reqId;
    setHistoryMeta(sessionKey, { loadingOlder: true, error: "" });
    conn.sendFrame(buildHistoryFrame({ sessionKey, reqId, before }));
  }, [setHistoryMeta]);

  const flushItem = useCallback(
    (item) => {
      const conn = connectionRef.current;
      // Never flush before the protocol level is known: a send in the 3s
      // pre-hello window against a dedupe-less legacy server would follow the
      // v2 retry path and duplicate turns.
      if (!conn.isOpen() || !conn.isReady()) return false;
      const retry = item.possiblySubmitted === true;
      if (retry && !conn.supportsSafeRetry()) {
        outbox.markFailed(item.clientMsgId, { code: "unknown_outcome" });
        applyRunEvent(item.sessionKey, { type: "SEND_FAILED", clientMsgId: item.clientMsgId, code: "unknown_outcome" });
        return false;
      }
      const inflight = outbox.markInflight(item.clientMsgId);
      if (!inflight) return false;
      const ok = conn.sendFrame(
        buildMessageFrame({
          clientMsgId: item.clientMsgId,
          sessionKey: item.sessionKey,
          content: item.content,
          retry,
          now: Date.now(),
        }),
      );
      if (!ok) {
        outbox.requeue(item.clientMsgId, { possiblySubmitted: retry });
        return false;
      }
      applyRunEvent(item.sessionKey, {
        type: "OUTBOX_INFLIGHT",
        clientMsgId: item.clientMsgId,
      });
      appendDebugEvent(item.sessionKey, "ws:message-request", {
        clientMsgId: item.clientMsgId,
      });
      if (conn.isLegacy()) {
        // LEGACY server (no ack/dedupe): single-shot — never auto-retry.
        // Live monitor read, not render state: the status snapshot is stale
        // during the synchronous onReady → flushTick path.
        outbox.markAcked(item.clientMsgId);
      }
      return true;
    },
    [appendDebugEvent, applyRunEvent, outbox],
  );

  const flushTick = useCallback(() => {
    outbox.sweepAckTimeouts({
      // Leave pendingSend so the requeued item can flush again (F124).
      onTimeout: ({ sessionKey, clientMsgId }) =>
        applyRunEvent(sessionKey, { type: "ACK_TIMEOUT", clientMsgId }),
    });
    // A history outage parks uncertainty; a timer never authorizes dispatch.
    outbox.releaseAwaitingHistory("", { force: true, olderThanMs: kAwaitingHistoryMaxMs });
    for (const item of outbox.listAll()) {
      if (item.status === "unknown" && !item.resentAs && !item.followupsConfirmed) {
        applyRunEvent(item.sessionKey, { type: "SEND_FAILED", clientMsgId: item.clientMsgId, code: "unknown_outcome" });
      }
    }
    const queuedSessions = new Set(
      outbox
        .listAll()
        .filter((item) => item.status === "queued")
        .map((item) => item.sessionKey),
    );
    for (const sessionKey of queuedSessions) {
      const runState = runStateRef.current[sessionKey] || createSessionRunState();
      if (!canAutoFlush(runState)) continue;
      const item = outbox.nextEligible(sessionKey);
      if (!item) continue;
      flushItem(item);
    }
  }, [applyRunEvent, flushItem, outbox]);
  flushTickRef.current = flushTick;

  useVisibleInterval(() => flushTickRef.current(), kFlushTickMs, {
    enabled: Boolean(enabled),
    pauseWhenHidden: false,
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return () => {
      // Coalesced-refetch timers would otherwise fire into an unmounted store.
      for (const key of Object.keys(scheduledRefetchBySessionRef.current)) {
        const pending = scheduledRefetchBySessionRef.current[key];
        if (pending) clearTimeout(pending);
      }
      scheduledRefetchBySessionRef.current = {};
    };
  }, [enabled]);

  // History refresh triggers: session switch + window focus/visibility
  // (multi-tab staleness: run frames only reach the socket that started the
  // run, so a returning tab reconciles via a cheap merge-refetch).
  useEffect(() => {
    if (enabled) syncWatch();
  }, [enabled, selectedSessionKey, syncWatch]);

  useEffect(() => {
    if (!enabled || !selectedSessionKey) return undefined;
    requestHistory(selectedSessionKey);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        requestHistoryRef.current(selectedSessionKeyRef.current);
      }
    };
    const onFocus = () => requestHistoryRef.current(selectedSessionKeyRef.current);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, selectedSessionKey, requestHistory]);

  // Actions -----------------------------------------------------------------

  const send = useCallback(
    (text) => {
      const sessionKey = selectedSessionKeyRef.current;
      const content = String(text || "").trim();
      if (!sessionKey || !content) return false;
      const item = outbox.enqueue({ sessionKey, content });
      // Immediate flush when the session is settled; otherwise the item waits
      // visibly as "Queued" and auto-sends on the next eligible tick.
      const runState = runStateRef.current[sessionKey] || createSessionRunState();
      if (canAutoFlush(runState) && outbox.nextEligible(sessionKey) === item) flushItem(item);
      return true;
    },
    [flushItem, outbox],
  );

  const stop = useCallback(() => {
    const sessionKey = selectedSessionKeyRef.current;
    if (!sessionKey) return;
    const runState = runStateRef.current[sessionKey] || createSessionRunState();
    if (!isRunActive(runState)) return;
    const conn = connectionRef.current;
    const ok = conn.sendFrame(
      buildStopFrame({ sessionKey, runId: runState.activeRunId }),
    );
    if (!ok) {
      showToast("Not connected — can't reach the agent to stop it.", "warning");
      return;
    }
    setStopErrorBySession((map) => ({ ...map, [sessionKey]: "" }));
    applyRunEvent(sessionKey, { type: "STOP_CLICKED" });
    appendDebugEvent(sessionKey, "ws:stop-request", { runId: runState.activeRunId });
  }, [appendDebugEvent, applyRunEvent]);

  const retryItem = useCallback(
    (clientMsgId) => {
      const item = outbox
        .listAll()
        .find((entry) => entry.clientMsgId === clientMsgId);
      outbox.retry(clientMsgId);
      // Retry IS the explicit confirmation: an unknown-outcome hold must not
      // demand a second "Send queued" click after the user already said
      // "send it again".
      if (item?.sessionKey) {
        applyRunEvent(item.sessionKey, { type: "CONFIRM_FLUSH" });
      }
      flushTickRef.current();
    },
    [applyRunEvent, outbox],
  );
  const discardItem = useCallback((clientMsgId) => outbox.discard(clientMsgId), [outbox]);
  const cancelQueued = useCallback((clientMsgId) => outbox.cancel(clientMsgId), [outbox]);
  const confirmFlush = useCallback(() => {
    const sessionKey = selectedSessionKeyRef.current;
    if (!sessionKey) return;
    outbox.confirmQueued(sessionKey);
    applyRunEvent(sessionKey, { type: "CONFIRM_FLUSH" });
    setTimeout(() => flushTickRef.current(), 0);
  }, [applyRunEvent]);

  // Selected-session view ----------------------------------------------------

  const selectedRunState = useMemo(
    () => runStateBySession[selectedSessionKey] || createSessionRunState(),
    [runStateBySession, selectedSessionKey],
  );

  const selectedOutboxItems = useMemo(
    () => (selectedSessionKey ? outbox.listForSession(selectedSessionKey) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outbox, selectedSessionKey, outboxVersion],
  );

  const selectedMessages = useMemo(
    () =>
      composeVisibleMessages({
        messages: messagesBySession[selectedSessionKey] || [],
        outboxItems: selectedOutboxItems,
      }),
    [messagesBySession, selectedSessionKey, selectedOutboxItems],
  );

  // Referentially stable so memoized row components don't re-render per frame.
  const actions = useMemo(
    () => ({
      send,
      stop,
      retryItem,
      discardItem,
      cancelQueued,
      confirmFlush,
      requestHistory,
      loadOlder,
      retryConnection: connection.retryNow,
    }),
    [
      send,
      stop,
      retryItem,
      discardItem,
      cancelQueued,
      confirmFlush,
      requestHistory,
      loadOlder,
      connection.retryNow,
    ],
  );

  return {
    connection,
    messages: selectedMessages,
    runState: selectedRunState,
    outboxItems: selectedOutboxItems,
    historyMeta: historyMetaBySession[selectedSessionKey] || {},
    rawHistory: rawHistoryBySession[selectedSessionKey] || null,
    debugEvents: debugEventsBySession[selectedSessionKey] || [],
    stopError: stopErrorBySession[selectedSessionKey] || "",
    persistWarning,
    lastActivityAt: lastActivityBySession[selectedSessionKey] || 0,
    runNote: runNoteBySession[selectedSessionKey] || "",
    actions,
  };
};
