import { useEffect, useRef, useState } from "preact/hooks";
import { fetchWatchdogLogs, fetchWatchdogLogsDelta } from "../../../lib/api.js";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import { readUiSettings, writeUiSettings } from "../../../lib/ui-settings.js";
import { showToast } from "../../toast.js";
import {
  clampWatchdogLogsPanelHeight,
  formatWatchdogCopyAllText,
  kWatchdogConsoleTabLogs,
  kWatchdogConsoleTabTerminal,
  kWatchdogConsoleTabUiSettingKey,
  kWatchdogLogsPanelHeightUiSettingKey,
  normalizeWatchdogConsoleTab,
  readCssHeightPx,
} from "../helpers.js";
import { useWatchdogTerminal } from "../terminal/use-terminal.js";

const kWatchdogLogsPollIntervalMs = 3000;
const kWatchdogLogsInitialTailBytes = 65536;
// Cap the in-memory pane text; appended deltas trim the front on a line
// boundary so the oldest visible line stays whole.
const kWatchdogLogsMaxTextChars = 262144;

export const capWatchdogLogsText = (text = "") => {
  const normalized = String(text || "");
  if (normalized.length <= kWatchdogLogsMaxTextChars) return normalized;
  const sliced = normalized.slice(normalized.length - kWatchdogLogsMaxTextChars);
  const newlineIndex = sliced.indexOf("\n");
  if (newlineIndex >= 0 && newlineIndex < sliced.length - 1) {
    return sliced.slice(newlineIndex + 1);
  }
  return sliced;
};

export const useWatchdogConsole = ({
} = {}) => {
  const [logs, setLogs] = useState("");
  const [logsError, setLogsError] = useState(null);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [copyingAll, setCopyingAll] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [activeConsoleTab, setActiveConsoleTab] = useState(() => {
    const settings = readUiSettings();
    return normalizeWatchdogConsoleTab(settings?.[kWatchdogConsoleTabUiSettingKey]);
  });
  const [logsPanelHeightPx, setLogsPanelHeightPx] = useState(() => {
    const settings = readUiSettings();
    return clampWatchdogLogsPanelHeight(
      settings?.[kWatchdogLogsPanelHeightUiSettingKey],
    );
  });
  const logsRef = useRef(null);
  const terminalPanelRef = useRef(null);
  const terminalHostRef = useRef(null);
  // Delta cursor {gen, offset} persists across tab switches so returning to
  // the Logs tab resumes from where the poll left off (rotation → reset).
  const logsCursorRef = useRef(null);
  const initialTailLoadedRef = useRef(false);
  const terminal = useWatchdogTerminal({
    active: activeConsoleTab === kWatchdogConsoleTabTerminal,
    panelRef: terminalPanelRef,
    hostRef: terminalHostRef,
  });

  useEffect(() => {
    const settings = readUiSettings();
    settings[kWatchdogConsoleTabUiSettingKey] =
      normalizeWatchdogConsoleTab(activeConsoleTab);
    writeUiSettings(settings);
  }, [activeConsoleTab]);

  // Logs poll: paused entirely while the Terminal tab is active (switching
  // back re-runs this effect and resumes from the delta cursor). The first
  // fetch is the full tail for an instant paint; every poll after that asks
  // only for the bytes appended past {gen, offset}.
  useEffect(() => {
    if (activeConsoleTab !== kWatchdogConsoleTabLogs) return undefined;
    let active = true;
    let timer = null;
    const pollLogsDelta = async () => {
      try {
        const payload = await fetchWatchdogLogsDelta(logsCursorRef.current || {});
        if (!active) return;
        if (payload?.reset) {
          setLogs(capWatchdogLogsText(payload?.data || ""));
        } else if (payload?.data) {
          setLogs((currentLogs) =>
            capWatchdogLogsText(`${currentLogs}${payload.data}`),
          );
        }
        const gen = Number(payload?.gen);
        const offset = Number(payload?.offset);
        if (Number.isFinite(gen) && Number.isFinite(offset)) {
          logsCursorRef.current = { gen, offset };
        }
        setLogsError(null);
        setLoadingLogs(false);
      } catch (error) {
        if (!active) return;
        // Rendered in the pane (never "No logs yet."); the 3s poll keeps
        // retrying, and the next success clears it.
        setLogsError(error);
        setLoadingLogs(false);
      }
      if (!active) return;
      timer = setTimeout(pollLogsDelta, kWatchdogLogsPollIntervalMs);
    };
    const startPolling = async () => {
      if (!initialTailLoadedRef.current) {
        try {
          const text = await fetchWatchdogLogs(kWatchdogLogsInitialTailBytes);
          if (!active) return;
          setLogs(capWatchdogLogsText(text || ""));
          setLogsError(null);
          initialTailLoadedRef.current = true;
        } catch (error) {
          // Rendered in the pane (never a silent empty "No logs yet."); the
          // delta poll below keeps retrying and clears it on the next success.
          if (!active) return;
          setLogsError(error);
        }
        if (!active) return;
        setLoadingLogs(false);
        timer = setTimeout(pollLogsDelta, kWatchdogLogsPollIntervalMs);
        return;
      }
      // Returning to the Logs tab: catch up immediately, then keep polling.
      pollLogsDelta();
    };
    startPolling();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [activeConsoleTab]);

  useEffect(() => {
    const logsElement = logsRef.current;
    if (!logsElement || !stickToBottom) return;
    logsElement.scrollTop = logsElement.scrollHeight;
  }, [logs, stickToBottom]);

  useEffect(() => {
    const panelElement =
      activeConsoleTab === kWatchdogConsoleTabLogs
        ? logsRef.current
        : terminalPanelRef.current;
    if (!panelElement || typeof ResizeObserver === "undefined") return () => {};
    let saveTimer = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[0];
      const nextHeight = clampWatchdogLogsPanelHeight(
        readCssHeightPx(entry?.target),
      );
      setLogsPanelHeightPx((currentValue) =>
        Math.abs(currentValue - nextHeight) >= 1 ? nextHeight : currentValue,
      );
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const settings = readUiSettings();
        settings[kWatchdogLogsPanelHeightUiSettingKey] = nextHeight;
        writeUiSettings(settings);
      }, 120);
      if (activeConsoleTab === kWatchdogConsoleTabTerminal) {
        window.requestAnimationFrame(() => {
          terminal.fitNow();
        });
      }
    });
    observer.observe(panelElement);
    return () => {
      observer.disconnect();
      if (saveTimer) window.clearTimeout(saveTimer);
    };
  }, [activeConsoleTab]);

  const handleSelectConsoleTab = (nextTab = kWatchdogConsoleTabLogs) => {
    const normalizedTab = normalizeWatchdogConsoleTab(nextTab);
    if (normalizedTab === kWatchdogConsoleTabTerminal) {
      terminal.prepareForActivate();
    } else {
      terminal.clearSettling();
    }
    setActiveConsoleTab(normalizedTab);
  };

  const onRestartTerminalSession = () => {
    terminal.restartSession();
    setActiveConsoleTab(kWatchdogConsoleTabTerminal);
  };

  const handleCopyAll = async () => {
    if (copyingAll) return;
    setCopyingAll(true);
    try {
      const text = formatWatchdogCopyAllText({
        logs,
      });
      const copied = await copyTextToClipboard(text);
      if (!copied) {
        throw new Error("Could not copy watchdog export");
      }
      showToast("Copied watchdog logs", "success");
    } catch (error) {
      showToast(error.message || "Could not copy watchdog export", "error");
    } finally {
      setCopyingAll(false);
    }
  };

  return {
    logs,
    logsError,
    loadingLogs,
    copyingAll,
    stickToBottom,
    setStickToBottom,
    activeConsoleTab,
    handleSelectConsoleTab,
    logsPanelHeightPx,
    logsRef,
    terminalPanelRef,
    terminalHostRef,
    onRestartTerminalSession,
    onCopyAll: handleCopyAll,
    ...terminal,
  };
};
