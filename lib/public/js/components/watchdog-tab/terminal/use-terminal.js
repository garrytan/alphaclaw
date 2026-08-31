import { useEffect, useRef, useState } from "preact/hooks";
import { closeWatchdogTerminalSession } from "../../../lib/api.js";
import { showToast } from "../../toast.js";
import {
  ensureXtermStylesheet,
  fitTerminalWhenVisible,
  kWatchdogTerminalWsPath,
  loadXtermModules,
} from "../helpers.js";

const waitForTerminalHost = ({
  hostRef = null,
  panelRef = null,
  maxFrames = 8,
} = {}) =>
  new Promise((resolve, reject) => {
    let framesRemaining = Math.max(1, Number(maxFrames) || 1);

    const check = () => {
      if (hostRef?.current && panelRef?.current) {
        resolve({
          hostElement: hostRef.current,
          panelElement: panelRef.current,
        });
        return;
      }
      framesRemaining -= 1;
      if (framesRemaining <= 0) {
        reject(new Error("Terminal host not ready"));
        return;
      }
      window.requestAnimationFrame(check);
    };

    check();
  });

export const useWatchdogTerminal = ({
  active = false,
  panelRef = null,
  hostRef = null,
} = {}) => {
  const [connectingTerminal, setConnectingTerminal] = useState(false);
  const [terminalConnected, setTerminalConnected] = useState(false);
  const [terminalEnded, setTerminalEnded] = useState(false);
  const [terminalStatusText, setTerminalStatusText] = useState("");
  const [terminalUiSettling, setTerminalUiSettling] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState("");
  const [terminalReconnectToken, setTerminalReconnectToken] = useState(0);
  const terminalInstanceRef = useRef(null);
  const terminalFitAddonRef = useRef(null);
  const terminalSocketRef = useRef(null);
  const terminalSessionIdRef = useRef("");

  useEffect(() => {
    terminalSessionIdRef.current = String(terminalSessionId || "");
  }, [terminalSessionId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let resizeTimer = null;
    const setupTerminal = async () => {
      try {
        setConnectingTerminal(true);
        ensureXtermStylesheet();
        const { Terminal, FitAddon } = await loadXtermModules();
        if (cancelled) return;
        const { hostElement } = await waitForTerminalHost({
          hostRef,
          panelRef,
        });
        if (cancelled) return;
        if (!terminalInstanceRef.current) {
          const terminal = new Terminal({
            cursorBlink: true,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
            fontSize: 12,
            lineHeight: 1.2,
            letterSpacing: 0,
            // Bare \n from the rare no-PTY fallback (no `script` binary on
            // the host) must not staircase; a real PTY already emits \r\n,
            // which this leaves untouched (#76 part C).
            convertEol: true,
            theme: {
              background: "rgba(0, 0, 0, 0)",
              foreground: "#d1d5db",
              cursor: "#67e8f9",
            },
          });
          const fitAddon = new FitAddon();
          terminal.loadAddon(fitAddon);
          terminal.open(hostElement);
          // Visibility-guarded (#76): a raw fit() on a hidden panel clamps
          // xterm to MINIMUM_COLS=2, which would then ride the WS URL below.
          fitTerminalWhenVisible({ panel: panelRef?.current, fitAddon });
          terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true;
            const pressedKey = String(event.key || "").toLowerCase();
            if (
              !event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.shiftKey
            ) {
              return true;
            }
            if (pressedKey !== "k") return true;
            event.preventDefault();
            terminal.clear();
            return false;
          });
          window.setTimeout(() => {
            // Same visibility guard as above: the user can tab away inside
            // this settle window, and a hidden fit clamps to 2 columns.
            fitTerminalWhenVisible({
              panel: panelRef?.current,
              fitAddon: terminalFitAddonRef.current,
            });
          }, 120);
          terminal.focus();
          terminal.onData((data) => {
            const socket = terminalSocketRef.current;
            if (!socket || socket.readyState !== 1) return;
            socket.send(
              JSON.stringify({
                type: "input",
                data,
              }),
            );
          });
          terminalInstanceRef.current = terminal;
          terminalFitAddonRef.current = fitAddon;
        }

        const existingSocket = terminalSocketRef.current;
        if (existingSocket && existingSocket.readyState <= 1) {
          setConnectingTerminal(false);
          setTerminalUiSettling(false);
          fitTerminalWhenVisible({
            panel: panelRef?.current,
            fitAddon: terminalFitAddonRef.current,
          });
          terminalInstanceRef.current?.focus();
          return;
        }

        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        // Carry the fitted size on the upgrade URL (#76): the server records
        // the LATEST connection's size and applies it at every (re)spawn —
        // a live PTY is never resized (Restart session picks the size up).
        const activeTerminal = terminalInstanceRef.current;
        const sizeQuery =
          activeTerminal && activeTerminal.cols > 0 && activeTerminal.rows > 0
            ? `?cols=${activeTerminal.cols}&rows=${activeTerminal.rows}`
            : "";
        const socket = new WebSocket(
          `${protocol}://${window.location.host}${kWatchdogTerminalWsPath}${sizeQuery}`,
        );
        terminalSocketRef.current = socket;
        socket.onopen = () => {
          if (cancelled) return;
          setConnectingTerminal(false);
          setTerminalUiSettling(false);
          setTerminalConnected(true);
          setTerminalEnded(false);
          setTerminalStatusText("Connected");
          fitTerminalWhenVisible({
            panel: panelRef?.current,
            fitAddon: terminalFitAddonRef.current,
          });
          terminalInstanceRef.current?.focus();
        };
        socket.onmessage = (event) => {
          let payload = null;
          try {
            payload = JSON.parse(String(event.data || ""));
          } catch {
            return;
          }
          const type = String(payload?.type || "");
          if (type === "session") {
            const sessionId = String(payload?.session?.id || "");
            if (sessionId) setTerminalSessionId(sessionId);
            setTerminalStatusText("Connected");
            return;
          }
          if (type === "output") {
            terminalInstanceRef.current?.write(String(payload?.data || ""));
            return;
          }
          if (type === "exit") {
            setTerminalEnded(true);
            setTerminalConnected(false);
            setTerminalStatusText("Session ended");
          }
        };
        socket.onclose = () => {
          if (cancelled) return;
          setConnectingTerminal(false);
          setTerminalUiSettling(false);
          setTerminalConnected(false);
          if (!terminalEnded) setTerminalStatusText("Disconnected");
        };
        socket.onerror = () => {
          if (cancelled) return;
          setConnectingTerminal(false);
          setTerminalUiSettling(false);
          setTerminalConnected(false);
          setTerminalStatusText("Connection error");
          showToast("Watchdog terminal connection failed", "error");
        };
      } catch (error) {
        if (cancelled) return;
        setConnectingTerminal(false);
        setTerminalUiSettling(false);
        setTerminalConnected(false);
        setTerminalStatusText(
          `Terminal failed to load — ${error?.message || "unknown error"}`,
        );
        console.error(
          `[watchdog-terminal] initialization failed: ${error?.message || "unknown error"}`,
          error,
        );
        showToast("Could not initialize terminal", "error");
      }
    };
    setupTerminal();

    const onResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fitTerminalWhenVisible({
          panel: panelRef?.current,
          fitAddon: terminalFitAddonRef.current,
        });
      }, 60);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, [active, terminalEnded, terminalReconnectToken, panelRef, hostRef]);

  useEffect(
    () => () => {
      const activeSessionId = String(terminalSessionIdRef.current || "");
      if (activeSessionId) {
        // Unmount cleanup stays fire-and-forget — there's no surface left to
        // render the failure — but it is logged, never silently swallowed.
        closeWatchdogTerminalSession(activeSessionId).catch((error) => {
          console.warn(
            `[watchdog-terminal] session close failed: ${error?.message || "unknown error"}`,
            error,
          );
        });
      }
      const socket = terminalSocketRef.current;
      if (socket && socket.readyState <= 1) socket.close();
      terminalSocketRef.current = null;
      terminalFitAddonRef.current = null;
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose();
      }
      terminalInstanceRef.current = null;
    },
    [],
  );

  const prepareForActivate = () => {
    const hasOpenSocket =
      !!terminalSocketRef.current && terminalSocketRef.current.readyState <= 1;
    if (hasOpenSocket && terminalConnected) {
      setTerminalUiSettling(false);
      setConnectingTerminal(false);
      return;
    }
    setTerminalUiSettling(true);
    setConnectingTerminal(true);
  };

  const clearSettling = () => {
    setTerminalUiSettling(false);
  };

  const restartSession = () => {
    const activeSessionId = String(terminalSessionId || "");
    if (activeSessionId) {
      // User-initiated: a leaked session is worth a notice, not just a log.
      closeWatchdogTerminalSession(activeSessionId).catch((error) => {
        console.warn(
          `[watchdog-terminal] session close failed: ${error?.message || "unknown error"}`,
          error,
        );
        showToast("Could not close the previous terminal session", "error");
      });
    }
    const socket = terminalSocketRef.current;
    if (socket && socket.readyState <= 1) socket.close();
    terminalSocketRef.current = null;
    terminalInstanceRef.current?.clear();
    setConnectingTerminal(true);
    setTerminalUiSettling(true);
    setTerminalEnded(false);
    setTerminalConnected(false);
    setTerminalSessionId("");
    setTerminalStatusText("Connecting...");
    setTerminalReconnectToken((value) => value + 1);
  };

  const fitNow = () => {
    fitTerminalWhenVisible({
      panel: panelRef?.current,
      fitAddon: terminalFitAddonRef.current,
    });
  };

  return {
    connectingTerminal,
    terminalConnected,
    terminalEnded,
    terminalStatusText,
    terminalUiSettling,
    terminalInstanceRef,
    fitNow,
    prepareForActivate,
    clearSettling,
    restartSession,
  };
};
