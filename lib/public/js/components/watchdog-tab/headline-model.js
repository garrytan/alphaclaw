import { toLocalDayKey } from "../../lib/format.js";
import { describeDegradedReason, kWatchdogPhaseCopy } from "./helpers.js";

// Pure view-models for the Health page (ALPH-69 PR 3b). Everything comes from
// the status stream, the narrative model and the incidents list the page
// already loads; nothing here fetches or decides recovery.

const kTimes = ["", "once", "twice"];
const kCounts = ["", "One", "Two"];
const kRepairingPhases = new Set(["degraded_repairing", "crash_backoff", "crash_loop_repair_ladder"]);
const kOutOfAttemptsPhases = new Set(["awaiting_repair_recovery", "config_error_latched"]);

const firstSentence = (text) => {
  const value = String(text || "").trim();
  const match = value.match(/^.*?[.!?](?=\s|$)/);
  return match ? match[0] : value;
};

const asSentence = (text) => {
  const value = String(text || "").trim();
  if (!value) return "";
  return /[.!?…]$/.test(value) ? value : value + ".";
};

const timesWord = (count) => kTimes[count] || count + " times";

// Incidents opened on today's calendar day (local), from the page's list.
export const summarizeIncidentsToday = (incidents = [], nowMs = Date.now()) => {
  const today = toLocalDayKey(new Date(nowMs));
  const list = (Array.isArray(incidents) ? incidents : []).filter((incident) => {
    const at = Date.parse(incident?.openedAt || "");
    return Number.isFinite(at) && toLocalDayKey(new Date(at)) === today;
  });
  return {
    count: list.length,
    recovered: list.filter((incident) => incident?.status !== "open" && incident?.summary?.outcome === "recovered")
      .length,
  };
};

// The watchdog's own state word for the status line.
export const describeWatchdogState = (watchdog = null) => {
  if (!watchdog) return null;
  const lifecycle = String(watchdog.lifecycle || "");
  if (watchdog.operationInProgress || String(watchdog.health || "") === "repairing" || lifecycle === "repairing") {
    return { word: "Repairing", dot: "restarting" };
  }
  if (watchdog.autoRepair === false || lifecycle === "stopped" || watchdog.phase === "stopped") {
    return { word: "Off", dot: "connecting" };
  }
  return { word: "On", dot: "running" };
};

const repairing = { tone: "warn", text: "The gateway is down. The watchdog is repairing it." };
const kLastKnown = " Showing the last known status.";
const kOfflineCopy = {
  alphaclaw_restarting: "AlphaClaw is restarting.",
  alphaclaw_booting: "AlphaClaw is starting.",
};
const down = { tone: "bad", text: "The gateway is down. Use Repair or Restart gateway." };

// The headline: one sentence that agrees with the status line and the
// incident list. narrative is buildWatchdogNarrative's result, chipKey the
// status chip's key (deriveStatusChip), restarting true while a restart
// operation runs, incidentsToday summarizeIncidentsToday's result (null until
// the list loads).
export const buildHealthHeadline = ({
  watchdogStatus = null,
  narrative = null,
  chipKey = "connecting",
  restarting = false,
  repairing: repairRunning = false,
  connectivityMode = "online",
  stale = false,
  incidentsToday = null,
} = {}) => {
  // The status chip's precedence: this tab's own action, then AlphaClaw's
  // connection, then a stale snapshot, then the snapshot's state. A snapshot
  // that is not live never reads as a live state.
  if (restarting) return { tone: "accent", text: "Restarting the gateway." };
  if (repairRunning) return { tone: "accent", text: "Repairing the gateway." };
  const mode = connectivityMode || "online";
  if (mode !== "online" && mode !== "reconnecting") {
    return { tone: "neutral", text: (kOfflineCopy[mode] || "AlphaClaw is not answering.") + kLastKnown };
  }
  if (mode === "reconnecting") return { tone: "neutral", text: "Reconnecting to AlphaClaw." + kLastKnown };
  if (stale) return { tone: "neutral", text: "Gateway status is out of date." + kLastKnown };
  if (chipKey === "restarting") return { tone: "accent", text: "Restarting the gateway." };
  if (!narrative) return { tone: "neutral", text: "Loading…" };
  const status = watchdogStatus || {};
  const phase = String(narrative.phase || status.phase || "");
  const cleanup = String(status.lifecycleOperation?.phase || "").startsWith("cleanup");
  if (cleanup) return { tone: "warn", text: asSentence(narrative.headline) };
  if (status.recoveryPending) return repairing;
  if (phase === "safe_mode" || (phase === "healthy" && status.safeMode)) {
    return { tone: "warn", text: "Degraded. " + firstSentence(kWatchdogPhaseCopy.safe_mode.detail) };
  }
  if (phase === "degraded_retrying") {
    const reason = status.degradedReason ? describeDegradedReason(status) : kWatchdogPhaseCopy.degraded_retrying.detail;
    return { tone: "warn", text: "Degraded. " + firstSentence(reason) };
  }
  if (kRepairingPhases.has(phase)) {
    if (status.incumbentConflict && phase === "crash_loop_repair_ladder") {
      return { tone: "bad", text: asSentence(narrative.headline) };
    }
    return repairing;
  }
  if (kOutOfAttemptsPhases.has(phase)) return down;
  if (chipKey === "down" && describeWatchdogState(status)?.word === "Off") return down;
  if (phase === "healthy") {
    if (!incidentsToday) return { tone: "ok", text: "Healthy." };
    if (incidentsToday.recovered > 0) {
      return { tone: "ok", text: "Healthy. The gateway recovered on its own " + timesWord(incidentsToday.recovered) + " today." };
    }
    if (incidentsToday.count > 0) {
      const count = incidentsToday.count;
      return {
        tone: "ok",
        text: "Healthy. " + (kCounts[count] || count) + " incident" + (count === 1 ? "" : "s") + " today.",
      };
    }
    return { tone: "ok", text: "Healthy. No incidents today." };
  }
  return { tone: narrative.tone === "danger" ? "bad" : narrative.tone === "warning" ? "warn" : "neutral", text: asSentence(narrative.headline) };
};
