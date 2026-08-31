import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createConnectionMonitor,
  kClientPingIntervalMs,
  kHelloTimeoutMs,
} from "./connection.js";
import { buildPingFrame } from "./chat-protocol.js";

// Owns the browser WebSocket to /api/ws/chat and drives the pure
// connection-policy module: unlimited jittered reconnects with a visible
// Retry-now affordance, hello/legacy detection, app-level ping staleness, and
// the MW5-safe HTTP-fallback latch (only when the upgrade endpoint is
// genuinely unavailable — never while a socket is CONNECTING/OPEN; any
// successful open clears it).
export const useChatConnection = ({
  enabled = true,
  onFrame,
  onOpen,
  onClosed,
  // Fired ONCE per connection when the protocol level is known: with the
  // hello payload (v2 server) or null (legacy — no hello within the window).
  // Resume + initial history ordering hangs off this, not onOpen.
  onReady,
}) => {
  const [status, setStatus] = useState({ mode: "connecting", legacy: false, attempts: 0 });
  const [hello, setHello] = useState(null);
  const wsRef = useRef(null);
  const monitorRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const helloTimerRef = useRef(null);
  const disposedRef = useRef(false);
  const onFrameRef = useRef(onFrame);
  const onOpenRef = useRef(onOpen);
  const onClosedRef = useRef(onClosed);
  const onReadyRef = useRef(onReady);
  const readyFiredRef = useRef(false);
  onFrameRef.current = onFrame;
  onOpenRef.current = onOpen;
  onClosedRef.current = onClosed;
  onReadyRef.current = onReady;

  if (!monitorRef.current) monitorRef.current = createConnectionMonitor();
  const monitor = monitorRef.current;

  const syncStatus = useCallback(() => {
    setStatus({
      mode: monitor.getMode(),
      legacy: monitor.isLegacy(),
      attempts: monitor.getAttempts(),
    });
  }, [monitor]);

  const connectRef = useRef(() => {});
  useEffect(() => {
    if (!enabled) return undefined;
    disposedRef.current = false;

    const clearTimers = () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (helloTimerRef.current) clearTimeout(helloTimerRef.current);
      reconnectTimerRef.current = null;
      helloTimerRef.current = null;
    };

    const scheduleReconnect = () => {
      if (disposedRef.current || monitor.getMode() === "httpFallback") return;
      if (reconnectTimerRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, monitor.nextDelayMs());
    };

    const connect = () => {
      if (disposedRef.current || monitor.getMode() === "httpFallback") return;
      monitor.recordConnecting();
      syncStatus();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws/chat`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposedRef.current || wsRef.current !== ws) return;
        readyFiredRef.current = false;
        monitor.recordOpen();
        syncStatus();
        onOpenRef.current?.();
        // Arm the hello/legacy timer from OPEN, not from connect(): a slow
        // TLS/remote handshake must not eat the detection window — an armed-
        // too-early timer would silently skip legacy mode and let the outbox
        // auto-retry against a dedupe-less old server (duplicate turns).
        if (helloTimerRef.current) clearTimeout(helloTimerRef.current);
        helloTimerRef.current = setTimeout(() => {
          if (wsRef.current !== ws) return;
          if (monitor.checkHelloTimeout()) {
            syncStatus();
            if (!readyFiredRef.current) {
              readyFiredRef.current = true;
              onReadyRef.current?.(null);
            }
          }
        }, kHelloTimeoutMs + 100);
      };
      ws.onclose = () => {
        if (disposedRef.current || wsRef.current !== ws) return;
        wsRef.current = null;
        monitor.recordClose();
        syncStatus();
        onClosedRef.current?.();
        scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose follows; policy lives there.
      };
      ws.onmessage = (event) => {
        if (disposedRef.current) return;
        let payload = null;
        try {
          payload = JSON.parse(String(event?.data || ""));
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;
        monitor.recordFrame();
        if (payload.type === "hello") {
          monitor.recordHello();
          setHello(payload);
          syncStatus();
          if (!readyFiredRef.current) {
            readyFiredRef.current = true;
            onReadyRef.current?.(payload);
          }
          return;
        }
        if (payload.type === "pong") return;
        onFrameRef.current?.(payload);
      };
    };
    connectRef.current = connect;
    connect();

    const pingTimer = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify(buildPingFrame({ now: Date.now() })));
        } catch {}
        // A LEGACY server answers no pings and sends no keepalives — a
        // frame-silent idle socket is its normal state, not a zombie.
        if (monitor.isStale() && !monitor.isLegacy()) {
          // No frames (not even pongs) for the staleness window: the socket is
          // a zombie — close it so the reconnect loop takes over.
          try {
            ws.close();
          } catch {}
        }
      }
    }, kClientPingIntervalMs);

    return () => {
      disposedRef.current = true;
      clearTimers();
      clearInterval(pingTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const sendFrame = useCallback((payload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const retryNow = useCallback(() => {
    monitor.leaveHttpFallback();
    monitor.retryNow();
    syncStatus();
    const ws = wsRef.current;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close();
      } catch {}
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connectRef.current();
  }, [monitor, syncStatus]);

  // MW5-safe fallback latch: only when HTTP history worked while the socket
  // was GENUINELY down (never CONNECTING/OPEN — readyState 0/1).
  const noteHttpHistoryWorked = useCallback(() => {
    const ws = wsRef.current;
    const wsConnectingOrOpen = ws && (ws.readyState === 0 || ws.readyState === 1);
    if (wsConnectingOrOpen) return;
    if (monitor.getMode() === "online") return;
    monitor.enterHttpFallback();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    syncStatus();
  }, [monitor, syncStatus]);

  const isOpen = useCallback(() => wsRef.current?.readyState === 1, []);
  // Live (non-render-state) reads: flush decisions must not act on a stale
  // React snapshot of legacy/readiness during the post-open detection window.
  const isLegacy = useCallback(() => monitor.isLegacy(), [monitor]);
  const isReady = useCallback(() => readyFiredRef.current, []);

  return {
    status,
    hello,
    sendFrame,
    retryNow,
    noteHttpHistoryWorked,
    isOpen,
    isLegacy,
    isReady,
  };
};
