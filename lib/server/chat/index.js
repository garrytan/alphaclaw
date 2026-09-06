// Chat bridge service: browser WebSockets (/api/ws/chat) ⇄ one shared
// OpenClaw gateway socket, with protocol v2 (acks, run-scoped lifecycle,
// exactly-one-terminal), durable run outcomes (db/chat-runs, best-effort),
// keepalives, flood/backpressure guards, and a stall sweeper.
//
// Decomposition:
//   protocol.js       frame constants + validators (browser mirror pinned by test)
//   errors.js         classifyError (code + retryable + safe copy)
//   history.js        transcript normalizers + stable ids + markers
//   gateway-client.js the ONE multiplexed gateway socket + RPC
//   run-registry.js   live routing truth (records, atomic finalize)
//   send-service.js   browser frames + gateway events + sweeper
//   index.js          composition, socket lifecycle, public surface
//
// lib/server/chat-ws.js is a thin re-export shim over this module.
const crypto = require("node:crypto");
const {
  kProtocolVersion,
  kMaxContentBytes,
  kMaxPayloadBytes,
  kMaxInboundFramesPerWindow,
  kInboundFloodWindowMs,
  kMaxBufferedAmountBytes,
  kRunStallSweepIntervalMs,
  kBrowserPingIntervalMs,
  kReplayBufferMaxBytes,
  kResumeGraceMs,
  isValidId,
} = require("./protocol");
const { classifyError } = require("./errors");
const { buildHistoryMessages, toMarkers } = require("./history");
const { createGatewayClient } = require("./gateway-client");
const { createRunRegistry } = require("./run-registry");
const { createSendService } = require("./send-service");

const kWsOpen = 1;
const kHistoryLimit = 200;
const kHistoryTimeoutMs = 12000;

// Store writes are best-effort: a DB failure must never block a send. The
// wrapper warns ONCE and counts failures (visible in the debug stats) —
// markers/dedupe-across-restart degrade, live behavior does not.
const createNullStore = () => ({
  recordSend: () => {},
  markRunning: () => {},
  markStopRequested: () => {},
  markTerminal: () => {},
  findRecentTerminal: () => null,
  listMarkers: () => [],
});

const wrapStoreSafe = (rawStore) => {
  if (!rawStore) return { store: createNullStore(), getFailureCount: () => 0 };
  let warned = false;
  let failureCount = 0;
  const guard =
    (name, fallbackValue) =>
    (...args) => {
      try {
        return rawStore[name](...args);
      } catch (err) {
        failureCount += 1;
        if (!warned) {
          warned = true;
          console.warn(
            `[alphaclaw] chat-runs store unavailable (${err.message}) — run markers and cross-restart dedupe degrade until it recovers`,
          );
        }
        return fallbackValue;
      }
    };
  return {
    store: {
      recordSend: guard("recordSend", undefined),
      markRunning: guard("markRunning", undefined),
      markStopRequested: guard("markStopRequested", undefined),
      markTerminal: guard("markTerminal", undefined),
      findRecentTerminal: guard("findRecentTerminal", null),
      listMarkers: guard("listMarkers", []),
    },
    getFailureCount: () => failureCount,
  };
};

const createChatWsService = ({
  fs,
  openclawDir = "",
  getGatewayPort = () => 18789,
  chatRunsStore = null,
  insertWatchdogEvent = null,
  now = () => Date.now(),
  // Test-only timing overrides; production uses the protocol.js constants.
  timings = {},
}) => {
  let WebSocketServer = null;
  let GatewayWebSocket = null;
  try {
    const wsModule = require("ws");
    ({ WebSocketServer } = wsModule);
    GatewayWebSocket = wsModule.WebSocket || wsModule;
  } catch (err) {
    console.warn(
      `[alphaclaw] chat websocket disabled: missing ws dependency (${err.message})`,
    );
    return {
      handleUpgrade: (request, socket) => {
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nChat websocket unavailable",
        );
        socket.destroy();
      },
      fetchHistory: async () => {
        throw new Error("Chat websocket unavailable");
      },
    };
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: kMaxPayloadBytes,
  });

  const { store, getFailureCount } = wrapStoreSafe(chatRunsStore);
  const registry = createRunRegistry();

  // Per-browser-socket transport state: keepalive, flood window, drop
  // accounting for the desync signal.
  const socketState = new WeakMap();
  const getSocketState = (ws) => {
    let state = socketState.get(ws);
    if (!state) {
      state = {
        missedPongs: 0,
        frameCount: 0,
        windowStart: now(),
        desyncPending: new Set(),
        droppedFrames: 0,
      };
      socketState.set(ws, state);
    }
    return state;
  };
  let totalDroppedFrames = 0;

  const sendJson = (ws, payload = {}) => {
    if (!ws || ws.readyState !== kWsOpen) return;
    ws.send(JSON.stringify(payload));
  };

  const flushDesync = (ws) => {
    const state = socketState.get(ws);
    if (!state || state.desyncPending.size === 0) return;
    if (!ws || ws.readyState !== kWsOpen) return;
    if (ws.bufferedAmount > kMaxBufferedAmountBytes) return;
    for (const sessionKey of state.desyncPending) {
      ws.send(JSON.stringify({ type: "desync", sessionKey }));
    }
    state.desyncPending.clear();
  };

  const deliverToSocket = (ws, sessionKey, serialized, { droppable = true } = {}) => {
    if (!ws || ws.readyState !== kWsOpen) return;
    const state = getSocketState(ws);
    if (droppable && ws.bufferedAmount > kMaxBufferedAmountBytes) {
      state.droppedFrames += 1;
      totalDroppedFrames += 1;
      state.desyncPending.add(sessionKey);
      return;
    }
    flushDesync(ws);
    ws.send(serialized);
  };

  // Stream frames carry a per-run monotonic seq, are buffered for resume
  // (byte-capped; drop-oldest marks a gap), and fan out to every attached
  // socket. Backpressure: a socket whose send buffer is over the cap gets the
  // frame DROPPED (counted) and a single `desync` on drain so the client
  // refetches history — never a silent gap.
  const sendStream = (record, frame) => {
    record.lastSeq += 1;
    const framed = { ...frame, seq: record.lastSeq };
    const serialized = JSON.stringify(framed);
    if (record.resumable && Array.isArray(record.replay)) {
      // Replay copies drop the debug-only rawEvent blob: large tool results
      // would otherwise burn the 256KB budget roughly twice as fast and force
      // gap-refetches on resume.
      const replayFramed =
        framed.rawEvent !== undefined ? { ...framed, rawEvent: null } : framed;
      const replaySerialized =
        replayFramed === framed ? serialized : JSON.stringify(replayFramed);
      record.replay.push({
        seq: record.lastSeq,
        size: replaySerialized.length,
        framed: replayFramed,
      });
      record.replayBytes += replaySerialized.length;
      while (
        record.replayBytes > kReplayBufferMaxBytes &&
        record.replay.length > 0
      ) {
        const dropped = record.replay.shift();
        record.replayBytes -= dropped.size;
        record.replayGap = true;
      }
    }
    // Terminal `done` frames are NEVER dropped by backpressure: DONE is the
    // only event that settles the client run-state on a live socket — a
    // dropped terminal would strand the session in `running`.
    const droppable = frame.type !== "done";
    for (const ws of record.sockets) {
      deliverToSocket(ws, record.sessionKey, serialized, { droppable });
    }
  };

  // Control frames addressed to a run (stopping/stop-failed/legacy error/
  // send-failed terminals) reach every attached socket.
  const sendControl = (record, frame) => {
    const serialized = JSON.stringify(frame);
    for (const ws of record.sockets) {
      if (ws && ws.readyState === kWsOpen) ws.send(serialized);
    }
  };

  const gatewayClient = createGatewayClient({
    fs,
    openclawDir,
    getGatewayPort,
    WebSocketImpl: GatewayWebSocket,
    onEvent: (payload) => sendService.handleGatewayEvent(payload),
    onDisconnect: () => sendService.onGatewayDisconnect(),
  });

  const sendService = createSendService({
    registry,
    requestGateway: gatewayClient.requestGateway,
    store,
    sendJson,
    sendStream,
    sendControl,
    insertWatchdogEvent,
    now,
    ...(timings.stopConfirmMs ? { stopConfirmMs: timings.stopConfirmMs } : {}),
    ...(timings.stallMs ? { stallMs: timings.stallMs } : {}),
  });

  // Grace window (Phase 5): when a run's last attached socket closes, keep the
  // replay buffer around briefly so a refreshed tab can re-attach; expiry
  // drops the buffer ONLY — real terminals still come from lifecycle/
  // disconnect/sweeper.
  const graceMs = timings.resumeGraceMs || kResumeGraceMs;
  const armGraceWindow = (record) => {
    if (record.finalized || record.graceTimer) return;
    record.graceTimer = setTimeout(() => {
      record.graceTimer = null;
      record.resumable = false;
      record.replay = [];
      record.replayBytes = 0;
      record.replayGap = false;
    }, graceMs);
    if (typeof record.graceTimer?.unref === "function") record.graceTimer.unref();
  };

  // Browser keepalive (WS-protocol ping; terminate after two missed pongs)
  // + desync flushing once buffers drain.
  const keepaliveTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const state = getSocketState(ws);
      flushDesync(ws);
      if (state.missedPongs >= 2) {
        try {
          ws.terminate();
        } catch {}
        continue;
      }
      state.missedPongs += 1;
      try {
        ws.ping();
      } catch {}
    }
  }, timings.pingIntervalMs || kBrowserPingIntervalMs);
  if (typeof keepaliveTimer?.unref === "function") keepaliveTimer.unref();

  const sweepTimer = setInterval(() => {
    sendService.sweepStalledRuns();
  }, timings.sweepIntervalMs || kRunStallSweepIntervalMs);
  if (typeof sweepTimer?.unref === "function") sweepTimer.unref();

  wss.on("connection", (ws) => {
    const state = getSocketState(ws);
    ws.on("pong", () => {
      state.missedPongs = 0;
    });
    // A `ws` socket emits 'error' on transport failure (ECONNRESET/EPIPE/
    // maxPayload). With no listener Node throws → uncaughtException →
    // gracefulExit(1), so any browser losing wifi would restart the whole
    // server (C2). Close quietly; run records persist to their REAL terminal
    // (browser close does not finalize a run — frames to closed sockets drop
    // and reconnect history reconciles).
    ws.on("error", () => {
      try {
        ws.close();
      } catch {}
    });
    ws.on("close", () => {
      for (const record of registry.detachSocket(ws)) {
        armGraceWindow(record);
      }
    });
    sendJson(ws, {
      type: "hello",
      protocolVersion: kProtocolVersion,
      maxContentBytes: kMaxContentBytes,
      // Resumable runs (Phase 5): a hard-refreshed client has no in-memory
      // cursor, so the server advertises what can be re-attached. Exposure
      // matches team-mode v1's documented chat posture (TODOS: members can
      // already read/send to any session over this bridge): live browser-run
      // keys only — tightening belongs to the per-operator attribution work.
      activeRuns: registry
        .startedRecords()
        .filter((record) => record.resumable)
        .map((record) => ({
          sessionKey: record.sessionKey,
          runId: record.runId,
          messageId: record.messageId || "",
          seq: record.lastSeq,
        })),
    });
    ws.on("message", (rawData) => {
      // Inbound flood cap: frames per rolling window, then close 1008.
      const nowMs = now();
      if (nowMs - state.windowStart > kInboundFloodWindowMs) {
        state.windowStart = nowMs;
        state.frameCount = 0;
      }
      state.frameCount += 1;
      if (state.frameCount > kMaxInboundFramesPerWindow) {
        try {
          ws.close(1008, "too many frames");
        } catch {}
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(String(rawData || ""));
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      const type = String(payload.type || "");
      if (type === "ping") {
        sendJson(ws, { type: "pong", ts: Number(payload.ts) || now() });
        return;
      }
      const run = async () => {
        if (type === "history") {
          await handleHistory({ ws, payload });
          return;
        }
        if (type === "message") {
          await sendService.handleMessage({ ws, payload });
          return;
        }
        if (type === "stop") {
          await sendService.handleStop({ ws, payload });
          return;
        }
        if (type === "resume") {
          sendService.handleResume({ ws, payload });
        }
      };
      run().catch((err) => {
        const sessionKey = String(payload?.sessionKey || "").trim();
        const classified = classifyError(err);
        sendJson(ws, {
          type: "error",
          message: classified.message,
          code: classified.code,
          ...(sessionKey ? { sessionKey } : {}),
          messageId: crypto.randomUUID(),
        });
      });
    });
  });

  const fetchHistory = async (sessionKey = "") => {
    const normalizedSessionKey = String(sessionKey || "").trim();
    if (!normalizedSessionKey) {
      return { messages: [], rawHistory: null, markers: [], truncated: false };
    }
    // Fetch limit+1 and trim: exactly `limit` rows does not prove older rows
    // exist — a 201st row does (honest `truncated`).
    const history = await gatewayClient.requestGateway(
      "chat.history",
      {
        sessionKey: normalizedSessionKey,
        limit: kHistoryLimit + 1,
      },
      kHistoryTimeoutMs,
    );
    const { messages, truncated } = buildHistoryMessages({
      history,
      sessionKey: normalizedSessionKey,
      limit: kHistoryLimit,
    });
    return {
      messages,
      rawHistory: history || null,
      markers: toMarkers(store.listMarkers(normalizedSessionKey)),
      truncated,
    };
  };

  const handleHistory = async ({ ws, payload }) => {
    const sessionKey = String(payload?.sessionKey || "").trim();
    if (!sessionKey) {
      sendJson(ws, { type: "history", messages: [] });
      return;
    }
    // Same trust boundary as message/stop/resume frames: a client-supplied
    // sessionKey never reaches the gateway RPC unvalidated.
    if (!isValidId(sessionKey)) {
      sendJson(ws, {
        type: "error",
        message: "sessionKey is invalid",
        code: "protocol_invalid",
        sessionKey,
      });
      return;
    }
    const reqId = String(payload?.reqId || "");
    const { messages, rawHistory, markers, truncated } =
      await fetchHistory(sessionKey);
    sendJson(ws, {
      type: "history",
      sessionKey,
      ...(reqId ? { reqId } : {}),
      messages,
      markers,
      rawHistory,
      truncated,
    });
  };

  return {
    handleUpgrade: (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
    fetchHistory,
    // Diagnostic: size of the pending foreign-run event buffer. Bounded by
    // kMaxBufferedRuns / kMaxEventsPerRun (H13); exposed so ops and tests can
    // confirm the bound holds under a foreign-run flood.
    getPendingBufferStats: () => registry.bufferStats(),
    getChatStats: () => ({
      buffer: registry.bufferStats(),
      registry: registry.stats(),
      droppedFrames: totalDroppedFrames,
      storeFailures: getFailureCount(),
    }),
  };
};

module.exports = { createChatWsService };
