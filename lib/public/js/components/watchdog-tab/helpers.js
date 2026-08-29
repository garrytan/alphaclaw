import {
  formatDurationLongMs,
  formatRelativeTime,
} from "../../lib/format.js";

export const kWatchdogConsoleTabLogs = "logs";
export const kWatchdogConsoleTabTerminal = "terminal";
export const kWatchdogConsoleTabUiSettingKey = "watchdogConsoleTab";
export const kWatchdogLogsPanelHeightUiSettingKey = "watchdogLogsPanelHeightPx";
export const kWatchdogLogsPanelDefaultHeightPx = 320;
export const kWatchdogLogsPanelMinHeightPx = 160;
export const kXtermCssUrl = "/css/vendor/xterm.css";
export const kWatchdogTerminalWsPath = "/api/watchdog/terminal/ws";

let xtermModulesPromise = null;

export const loadXtermModules = () => {
  if (!xtermModulesPromise) {
    xtermModulesPromise = Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([xtermModule, fitAddonModule]) => {
        const Terminal =
          xtermModule?.Terminal || xtermModule?.default?.Terminal || null;
        const FitAddon =
          fitAddonModule?.FitAddon || fitAddonModule?.default?.FitAddon || null;
        if (typeof Terminal !== "function") {
          throw new Error("Xterm Terminal export not found");
        }
        if (typeof FitAddon !== "function") {
          throw new Error("Xterm FitAddon export not found");
        }
        return { Terminal, FitAddon };
      },
    );
  }
  return xtermModulesPromise;
};

export const ensureXtermStylesheet = () => {
  if (typeof document === "undefined") return;
  if (document.getElementById("ac-xterm-css")) return;
  const link = document.createElement("link");
  link.id = "ac-xterm-css";
  link.rel = "stylesheet";
  link.href = kXtermCssUrl;
  document.head.appendChild(link);
};

export const fitTerminalWhenVisible = ({
  panel = null,
  fitAddon = null,
  minWidthPx = 120,
  minHeightPx = 80,
} = {}) => {
  if (!panel || !fitAddon) return false;
  const panelWidth = Number(panel.clientWidth || 0);
  const panelHeight = Number(panel.clientHeight || 0);
  if (panelWidth < minWidthPx || panelHeight < minHeightPx) return false;
  fitAddon.fit();
  return true;
};

export const normalizeWatchdogConsoleTab = (value) =>
  value === kWatchdogConsoleTabTerminal
    ? kWatchdogConsoleTabTerminal
    : kWatchdogConsoleTabLogs;

export const clampWatchdogLogsPanelHeight = (value) => {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed)
    ? Math.round(parsed)
    : kWatchdogLogsPanelDefaultHeightPx;
  return Math.max(kWatchdogLogsPanelMinHeightPx, normalized);
};

export const readCssHeightPx = (element) => {
  if (!element) return 0;
  const computedHeight = Number.parseFloat(
    window.getComputedStyle(element).height || "0",
  );
  return Number.isFinite(computedHeight) ? computedHeight : 0;
};

// Deliberately NOT lib/format.js formatBytes: this tab's display policy is
// whole-number units ("3 MB") and an em dash for missing values, where the
// shared helper renders adaptive precision ("3.00 MB") and "0 B".
export const formatBytes = (bytes) => {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// Hardcoded display thresholds for resource bars (warn ≥80%, crit ≥90%).
// Display-only: the watchdog never acts on resource levels.
export const resourceLevel = (percent) => {
  if (percent == null || percent === "") return "unknown";
  const value = Number(percent);
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 90) return "crit";
  if (value >= 80) return "warn";
  return "ok";
};

export const crashWindowLabel = (status = {}) => {
  const count = Number(status?.crashCountInWindow);
  const threshold = Number(status?.crashLoopThreshold);
  if (!Number.isFinite(count) || !Number.isFinite(threshold) || threshold <= 0)
    return null;
  const windowMs = Number(status?.crashLoopWindowMs);
  const windowLabel =
    Number.isFinite(windowMs) && windowMs > 0
      ? ` (${Math.round(windowMs / 60000)}-min window)`
      : "";
  return `${count} of ${threshold}${windowLabel}`;
};

// Phase → operator copy. Keys MUST stay in sync with kWatchdogPhases in
// lib/server/watchdog-phase.js (no shared constants module exists between
// lib/server CJS and this browser ESM bundle) — the sync test in
// tests/frontend/watchdog-narrative.test.js pins the two together.
export const kWatchdogPhaseCopy = {
  healthy: {
    tone: "success",
    emoji: "🟢",
    headline: "Gateway healthy",
  },
  unknown_bootstrap: {
    tone: "info",
    emoji: "⏳",
    headline: "Checking gateway health",
    detail: "Watchdog is establishing first contact (checks every 5s).",
  },
  startup_grace: {
    tone: "info",
    emoji: "⏳",
    headline: "Gateway starting up",
    detail: "Probe failures are expected during the startup grace window.",
  },
  expected_restart: {
    tone: "info",
    emoji: "🔄",
    headline: "Gateway restarting (planned)",
    detail: "A deliberate restart is in progress; health probes are paused.",
  },
  safe_mode: {
    tone: "warning",
    emoji: "🟡",
    headline: "Gateway in safe mode",
    detail:
      "Channel autostart was suppressed by the gateway's crash-loop breaker. Use Resume channels when the cause is fixed.",
  },
  degraded_retrying: {
    tone: "warning",
    emoji: "🟡",
    headline: "Gateway degraded",
    detail: "Health probes are failing. Retrying every 5s.",
  },
  degraded_pre_rollback: {
    tone: "warning",
    emoji: "🟡",
    headline: "Gateway degraded — rollback armed",
    detail:
      "This build is in its stabilization window: unattended repair is paused and auto-rollback owns recovery.",
  },
  degraded_repairing: {
    tone: "warning",
    emoji: "🛠️",
    headline: "Repair in progress",
    detail: "Running OpenClaw doctor repair, then relaunching the gateway.",
  },
  awaiting_repair_recovery: {
    tone: "danger",
    emoji: "🔴",
    headline: "Auto-repair paused",
    detail:
      "Repairs ran but health has not recovered. Manual action required — the Repair button forces another attempt.",
  },
  crash_backoff: {
    tone: "danger",
    emoji: "🔴",
    headline: "Gateway crashed",
    detail: "Relaunching with exponential backoff.",
  },
  crash_loop_repair_ladder: {
    tone: "danger",
    emoji: "🔴",
    headline: "Crash loop detected",
    detail: "Repeated crashes in the window; running doctor repair.",
  },
  crash_loop_rollback: {
    tone: "danger",
    emoji: "🔴",
    headline: "Crash loop — rolling back",
    detail:
      "This build crash-looped inside its stabilization window. Rolling back to the last known good build.",
  },
  config_error_latched: {
    tone: "danger",
    emoji: "⛔",
    headline: "Configuration error — automation paused",
    detail:
      "OpenClaw exited with EX_CONFIG (exit 78). Automatic recovery is paused until you fix the configuration or force a repair.",
  },
  managed_operation: {
    tone: "info",
    emoji: "🔄",
    headline: "Version operation in progress",
    detail:
      "A managed update or version switch is restarting the gateway; crash accounting is suspended.",
  },
  stopped: {
    tone: "neutral",
    emoji: "⚪",
    headline: "Watchdog stopped",
    detail: "Gateway monitoring is not running.",
  },
};

// Deterministic narrator: turns the SSE watchdogStatus into "what is going on
// right now / why / what happens next / what you can do". Pure — `nowMs` is
// the caller's current SERVER-time estimate (client clock + serverNow offset),
// so countdowns stay correct under clock skew in both directions.
export const buildWatchdogNarrative = (status = null, nowMs = Date.now()) => {
  if (!status || typeof status !== "object" || !status.phase) return null;
  const copy = kWatchdogPhaseCopy[status.phase] || {
    tone: "neutral",
    emoji: "❔",
    headline: `Watchdog: ${String(status.phase)}`,
  };
  const detailParts = [];
  const countdowns = [];
  const chips = [];
  const budgets = [];

  if (
    status.phase === "degraded_retrying" ||
    status.phase === "degraded_pre_rollback" ||
    status.phase === "degraded_repairing"
  ) {
    if (status.degradedSince) {
      const sinceMs = Date.parse(status.degradedSince);
      if (Number.isFinite(sinceMs)) {
        detailParts.push(
          `Degraded for ${formatDurationLongMs(Math.max(0, nowMs - sinceMs))}.`,
        );
      }
    }
    if (status.degradedReason) {
      detailParts.push(`Probe said: ${status.degradedReason}.`);
    }
  }
  if (status.phase === "degraded_repairing") {
    const limit = Number(status.repairAttemptLimit) || 0;
    const attempt = Math.min(Number(status.repairAttempts) + 1, limit || 99);
    detailParts.push(
      limit ? `Attempt ${attempt} of ${limit}.` : `Attempt ${attempt}.`,
    );
  }
  if (status.phase === "crash_backoff" && status.lastExit) {
    const exitLabel =
      status.lastExit.code != null
        ? `exit code ${status.lastExit.code}`
        : status.lastExit.signal
          ? `signal ${status.lastExit.signal}`
          : null;
    if (exitLabel) detailParts.push(`Last exit: ${exitLabel}.`);
    if (status.backoff?.attempt) {
      detailParts.push(`Relaunch attempt ${status.backoff.attempt}.`);
    }
  }
  if (status.phase === "safe_mode" && status.suppressedChannels?.length) {
    detailParts.push(`Suppressed: ${status.suppressedChannels.join(", ")}.`);
  }
  if (copy.detail) detailParts.push(copy.detail);

  if (status.phase === "startup_grace" && status.startupGraceUntil) {
    countdowns.push({
      key: "startup_grace",
      label: "Grace window ends",
      endsAt: status.startupGraceUntil,
    });
  }
  if (status.phase === "expected_restart" && status.expectedRestartUntil) {
    countdowns.push({
      key: "expected_restart",
      label: "Restart window ends",
      endsAt: status.expectedRestartUntil,
    });
  }
  if (status.phase === "crash_backoff" && status.backoff?.active) {
    countdowns.push({
      key: "backoff",
      label: "Next relaunch",
      endsAt: new Date(Number(status.backoff.untilMs)).toISOString(),
    });
  }
  if (
    (status.phase === "degraded_pre_rollback" ||
      status.phase === "degraded_retrying") &&
    status.rollbackDeadlineAt
  ) {
    countdowns.push({
      key: "rollback",
      label: "Auto-rollback if still degraded",
      endsAt: status.rollbackDeadlineAt,
    });
  }

  if (status.doctorFixSuppressed && status.autoRepair) {
    const untilMs = status.stabilization?.until
      ? Date.parse(status.stabilization.until)
      : NaN;
    chips.push({
      key: "doctor_fix_suppressed",
      label: Number.isFinite(untilMs)
        ? `Unattended repair paused — rollback owns recovery (stabilization ends in ${formatDurationLongMs(Math.max(0, untilMs - nowMs))})`
        : "Unattended repair paused — rollback owns recovery (stabilization window)",
    });
  }

  const crashes = Number(status.crashCountInWindow) || 0;
  const crashLimit = Number(status.crashLoopThreshold) || 0;
  if (crashes > 0 && crashLimit > 0) {
    budgets.push({ key: "crashes", label: `${crashes}/${crashLimit} crashes` });
  }
  const repairs = Number(status.repairAttempts) || 0;
  const repairLimit = Number(status.repairAttemptLimit) || 0;
  if (repairs > 0 && repairLimit > 0) {
    budgets.push({ key: "repairs", label: `${repairs}/${repairLimit} repairs` });
  }

  return {
    phase: status.phase,
    tone: copy.tone,
    emoji: copy.emoji,
    headline: copy.headline,
    detail: detailParts.join(" "),
    countdowns,
    chips,
    budgets,
  };
};

// Countdown remaining time, clamped: a deadline in the past (clock skew or a
// window that just closed) renders as "imminent", never a negative duration.
export const formatCountdownRemaining = (endsAt, nowMs = Date.now()) => {
  const endsMs = Date.parse(endsAt);
  if (!Number.isFinite(endsMs)) return null;
  const remaining = endsMs - nowMs;
  if (remaining <= 0) return "imminent";
  return formatDurationLongMs(remaining);
};

// Pure builder for the status-detail row under the Gateway card. Every value
// here is already present in the SSE watchdogStatus payload — this renders
// fields the tab previously fetched and dropped.
export const buildWatchdogStatusDetails = (status = null, nowMs = Date.now()) => {
  if (!status || typeof status !== "object") return [];
  const details = [];
  if (status.degradedSince) {
    const sinceMs = Date.parse(status.degradedSince);
    if (Number.isFinite(sinceMs)) {
      details.push({
        key: "degraded",
        label: `Degraded for ${formatDurationLongMs(Math.max(0, nowMs - sinceMs))}`,
        tone: "warning",
      });
    }
  }
  if (status.lastHealthCheckAt) {
    details.push({
      key: "lastProbe",
      label: `Last probe ${formatRelativeTime(status.lastHealthCheckAt, { nowMs })}`,
      tone: "muted",
    });
  }
  const crashes = crashWindowLabel(status);
  if (crashes && Number(status.crashCountInWindow) > 0) {
    details.push({ key: "crashes", label: `Crashes: ${crashes}`, tone: "warning" });
  }
  if (Number(status.repairAttempts) > 0) {
    details.push({
      key: "repairs",
      label: `Repair attempts: ${status.repairAttempts}`,
      tone: "warning",
    });
  }
  if (status.operationInProgress) {
    details.push({ key: "operation", label: "Operation in progress", tone: "info" });
  }
  if (status.gatewayPid != null) {
    details.push({ key: "pid", label: `PID ${status.gatewayPid}`, tone: "muted" });
  }
  return details;
};

export const getIncidentStatusTone = (event) => {
  const eventType = String(event?.eventType || "")
    .trim()
    .toLowerCase();
  const status = String(event?.status || "")
    .trim()
    .toLowerCase();
  if (status === "failed") {
    return {
      dotClass: "bg-red-500/90",
      label: "Failed",
    };
  }
  if (status === "ok" && eventType === "health_check") {
    return {
      dotClass: "bg-green-500/90",
      label: "Healthy",
    };
  }
  if (status === "warn" || status === "warning") {
    return {
      dotClass: "bg-yellow-400/90",
      label: "Warning",
    };
  }
  return {
    dotClass: "bg-gray-500/70",
    label: "Unknown",
  };
};

// OpenClaw 2026.7.1+ can boot into control-plane-safe mode after its
// crash-loop breaker trips: the gateway reports healthy while channel
// autostart stays suppressed. Returns null when no banner should render.
export const buildSafeModeBannerModel = (watchdogStatus = null) => {
  if (!watchdogStatus?.safeMode) return null;
  const channels = Array.isArray(watchdogStatus.suppressedChannels)
    ? watchdogStatus.suppressedChannels
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    : [];
  return {
    title: "Gateway is in safe mode",
    body:
      channels.length > 0
        ? `Channel autostart was suppressed by the gateway's crash-loop breaker. Suppressed: ${channels.join(", ")}. These channels are not delivering messages.`
        : "Channel autostart was suppressed by the gateway's crash-loop breaker.",
    channels,
  };
};

export const formatWatchdogCopyAllText = ({
  logs = "",
  generatedAt = null,
  // One-paste debugging handoff: the live status snapshot and the most
  // recent incident rollups travel with the logs.
  status = null,
  incidents = [],
} = {}) => {
  const sections = [];
  const generatedAtLabel =
    generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime())
      ? generatedAt.toISOString()
      : new Date().toISOString();

  sections.push(`# AlphaClaw Watchdog Export`);
  sections.push(`Generated at: ${generatedAtLabel}`);

  if (status && typeof status === "object") {
    sections.push(`## Watchdog Status`);
    sections.push(JSON.stringify(status, null, 2));
  }

  const recentIncidents = Array.isArray(incidents) ? incidents.slice(0, 5) : [];
  if (recentIncidents.length) {
    sections.push(`## Recent Incidents`);
    sections.push(
      recentIncidents
        .map((incident) => {
          const summary =
            incident?.summary && typeof incident.summary === "object"
              ? incident.summary
              : {};
          const duration = Number.isFinite(summary.durationMs)
            ? ` · ${Math.round(summary.durationMs / 1000)}s`
            : "";
          return `- #${incident?.id} ${summary.trigger || incident?.incidentKey || "incident"} · ${summary.severity || "warning"} · ${incident?.status}${duration} · opened ${incident?.openedAt}`;
        })
        .join("\n"),
    );
  }

  sections.push(`## Gateway Logs`);
  sections.push(String(logs || "").trim() || "No logs yet.");

  return sections.join("\n\n").trim();
};
