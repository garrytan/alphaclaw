import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { getBrowserTimeZone } from "../../../lib/format.js";
import { FileCopyLineIcon } from "../../icons.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import {
  kWatchdogConsoleTabLogs,
  kWatchdogConsoleTabTerminal,
  localizeLogTimestamps,
} from "../helpers.js";
import { WatchdogTerminal } from "../terminal/index.js";

const html = htm.bind(h);

export const WatchdogConsoleCard = ({
  activeConsoleTab = kWatchdogConsoleTabLogs,
  stickToBottom = true,
  onSetStickToBottom = () => {},
  onSelectConsoleTab = () => {},
  connectingTerminal = false,
  terminalConnected = false,
  terminalEnded = false,
  terminalStatusText = "",
  terminalUiSettling = false,
  onRestartTerminalSession = () => {},
  logsRef = null,
  logs = "",
  logsError = null,
  loadingLogs = true,
  copyingAll = false,
  terminalPanelRef = null,
  terminalHostRef = null,
  terminalInstanceRef = null,
  logsPanelHeightPx = 320,
  onCopyAll = () => {},
}) => {
  // Display-only localization of the leading per-line ISO stamps, keyed on the
  // logs string (input is bounded by the server's 64KB log tail). Loading and
  // empty placeholders never pass through the localizer.
  const localizedLogs = useMemo(
    () => (logs ? localizeLogTimestamps(logs) : logs),
    [logs],
  );
  return html`
  <div class="bg-surface border border-border rounded-xl p-4">
    <div class="flex items-center justify-between gap-2 mb-3">
      <div
        class="inline-flex items-center rounded-lg border border-border bg-field p-0.5"
      >
        <button
          type="button"
          class=${`px-2.5 py-1 text-xs rounded-md ${activeConsoleTab === kWatchdogConsoleTabLogs ? "bg-surface text-bright" : "text-fg-muted hover:text-body"}`}
          onClick=${() => onSelectConsoleTab(kWatchdogConsoleTabLogs)}
        >
          Logs
        </button>
        <button
          type="button"
          class=${`px-2.5 py-1 text-xs rounded-md ${activeConsoleTab === kWatchdogConsoleTabTerminal ? "bg-surface text-bright" : "text-fg-muted hover:text-body"}`}
          onClick=${() => onSelectConsoleTab(kWatchdogConsoleTabTerminal)}
        >
          Terminal
        </button>
      </div>
      <div class="flex items-center gap-2">
        ${activeConsoleTab === kWatchdogConsoleTabLogs
          ? html`
              <label class="inline-flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked=${stickToBottom}
                  onchange=${(event) =>
                    onSetStickToBottom(!!event.currentTarget?.checked)}
                />
                Stick to bottom
              </label>
            `
          : html`
              <div class="flex items-center gap-2 pr-1">
                ${terminalUiSettling
                  ? null
                  : html`
                      <span class="text-xs text-fg-muted">
                        ${connectingTerminal
                          ? "Connecting..."
                          : terminalEnded
                            ? "Session ended"
                            : terminalConnected
                              ? "Connected"
                              : terminalStatusText || "Disconnected"}
                      </span>
                      ${connectingTerminal || terminalConnected
                        ? null
                        : html`
                            <button
                              type="button"
                              class="ac-btn-secondary text-xs px-2.5 py-1 rounded-lg"
                              onClick=${onRestartTerminalSession}
                            >
                              New session
                            </button>
                          `}
                    `}
              </div>
            `}
      </div>
    </div>
    <div class=${activeConsoleTab === kWatchdogConsoleTabLogs ? "" : "hidden"}>
      <pre
        ref=${logsRef}
        class="watchdog-logs-panel bg-field border border-border rounded-lg p-3 overflow-auto text-xs text-body whitespace-pre-wrap break-words"
        style=${{ height: `${logsPanelHeightPx}px` }}
      >
${loadingLogs ? "Loading logs..." : localizedLogs || (logsError ? "" : "No logs yet.")}</pre
      >
      ${!loadingLogs && logsError
        ? html`
            <div class="mt-2">
              <${InlineErrorChip}
                error=${logsError}
                headline=${logs
                  ? "Couldn't refresh logs — showing the last loaded output; retrying automatically."
                  : "Couldn't load logs — retrying automatically."}
              />
            </div>
          `
        : null}
      <div class="mt-3 flex flex-wrap items-center gap-2 justify-end">
        <span class="mr-auto text-xs text-fg-muted">
          Line timestamps shown in ${getBrowserTimeZone() || "local time"}
        </span>
        <button
          type="button"
          class=${`ac-btn-secondary text-xs px-2.5 py-1 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap ${copyingAll ? "opacity-50 cursor-not-allowed" : ""}`}
          onClick=${onCopyAll}
          disabled=${copyingAll}
        >
          <${FileCopyLineIcon} className="w-3.5 h-3.5" />
          ${copyingAll ? "Copying..." : "Copy diagnostics (UTC)"}
        </button>
      </div>
    </div>
    <div
      class=${activeConsoleTab === kWatchdogConsoleTabTerminal
        ? "space-y-2"
        : "hidden"}
    >
      <${WatchdogTerminal}
        panelRef=${terminalPanelRef}
        hostRef=${terminalHostRef}
        terminalInstanceRef=${terminalInstanceRef}
        panelHeightPx=${logsPanelHeightPx}
      />
    </div>
  </div>
`;
};
