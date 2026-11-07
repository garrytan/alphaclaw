import { formatDurationCompactMs, formatUsd, formatInteger, toLocalDayKey } from "../../lib/format.js";
import { kRelayPhaseCopy } from "../relay-tab/model.js";

// Pure view-models for Home (ALPH-69 PR 3a). Every input comes from a read
// General already made or one of the incidents, usage, cron and relay reads
// the spec names; nothing here fetches.

const kDayMs = 24 * 60 * 60 * 1000;
export const kHomeIncidentLimit = 50;
export const kHomeComingUpLimit = 5;

const pluralNeeds = (count) => (count === 1 ? "One thing needs you." : count + " things need you.");

// The headline: one sentence under the page header that agrees with the
// strip's Gateway cell. "chip" is deriveStatusChip's result, so the words come
// from the same status stream as the sidebar chip.
export const buildHomeHeadline = ({ chip = null, attentionCount = 0 } = {}) => {
  const key = chip?.key || "connecting";
  if (key === "offline") return { tone: "bad", text: "AlphaClaw is not answering. Retrying…" };
  if (key === "connecting") return { tone: "neutral", text: "Loading…" };
  if (key === "restarting" || key === "starting") {
    return { tone: "accent", text: "The gateway is restarting. This page updates when it is back." };
  }
  if (key === "down" || key === "degraded") {
    return {
      tone: key === "down" ? "bad" : "warn",
      text: "The gateway is " + key + ".",
      healthLink: "Health has what to do next.",
    };
  }
  const count = Math.max(0, Number(attentionCount) || 0);
  return {
    tone: count > 0 ? "warn" : "ok",
    text: "Your box is running. " + (count > 0 ? pluralNeeds(count) : "Nothing needs you."),
  };
};

const formatUptime = (ms) => {
  const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (totalMinutes < 1) return "under 1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
};

const errorText = (error) => String(error?.message || error || "Could not load").trim();

const isWithinDays = (value, days, nowMs) => {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && nowMs - at <= days * kDayMs;
};

// Incidents opened in the last 7 days, newest first, from one page of 50.
export const summarizeRecentIncidents = (incidents = [], nowMs = Date.now()) => {
  const list = Array.isArray(incidents) ? incidents : [];
  const recent = list.filter((incident) => isWithinDays(incident?.openedAt, 7, nowMs));
  const recovered = recent.filter(
    (incident) => incident?.status !== "open" && incident?.summary?.outcome === "recovered",
  );
  const durations = recovered
    .map((incident) => Number(incident?.summary?.durationMs))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .slice(0, 2)
    .map(formatDurationCompactMs);
  return {
    count: recent.length,
    countLabel:
      list.length >= kHomeIncidentLimit && recent.length === list.length
        ? kHomeIncidentLimit + "+"
        : String(recent.length),
    recoveredCount: recovered.length,
    durations,
    open: recent.some((incident) => incident?.status === "open"),
  };
};

const sumLastDays = (daily = [], days, nowMs) => {
  const since = toLocalDayKey(new Date(nowMs - days * kDayMs));
  return (Array.isArray(daily) ? daily : []).reduce(
    (total, row) => (String(row?.date || "") >= since ? total + Number(row?.totalCost || 0) : total),
    0,
  );
};

const kLoadingCell = { value: "—", detail: "", tone: "neutral", loading: true };

const gatewayCell = ({ chip, watchdog }) => {
  const key = chip?.key || "connecting";
  if (key === "connecting") return { ...kLoadingCell, value: "—" };
  const pid = watchdog?.servingPid || watchdog?.gatewayPid || null;
  const uptimeMs = Number(watchdog?.uptimeMs || 0);
  let detail = "";
  if (key === "running") {
    detail = [pid ? "PID " + pid : "", uptimeMs > 0 ? "up " + formatUptime(uptimeMs) : ""]
      .filter(Boolean)
      .join(" · ");
  } else if (key === "down" || key === "degraded") {
    detail = "Open Health for the next step";
  } else if (key === "offline") {
    detail = "AlphaClaw is not answering";
  } else {
    detail = chip?.title || "";
  }
  return { value: chip.word, detail, tone: key, dot: key };
};

const watchdogCell = ({ watchdog, incidents }) => {
  if (!watchdog) return { ...kLoadingCell };
  const repairing =
    Boolean(watchdog.operationInProgress) ||
    String(watchdog.health || "") === "repairing" ||
    String(watchdog.lifecycle || "") === "repairing";
  const off = watchdog.autoRepair === false || String(watchdog.lifecycle || "") === "stopped";
  const value = repairing ? "Repairing" : off ? "Off" : "On";
  const dot = repairing ? "restarting" : off ? "connecting" : "running";
  let detail = "—";
  if (incidents?.error) detail = "";
  else if (incidents?.summary) detail = incidents.summary.recoveredCount + " recovered in 7 days";
  return { value, detail, tone: dot, dot };
};

const incidentsCell = ({ incidents }) => {
  if (incidents?.error) return { value: "—", detail: errorText(incidents.error), tone: "warn", error: true };
  if (!incidents?.summary) return { ...kLoadingCell };
  const summary = incidents.summary;
  return {
    value: summary.countLabel,
    detail: summary.count === 0 ? "None in 7 days" : summary.durations.join(" · ") || (summary.open ? "One is open" : ""),
    tone: summary.open ? "warn" : "neutral",
    mono: summary.durations.length > 0,
  };
};

const spendCell = ({ usage, nowMs }) => {
  if (usage?.error) return { value: "—", detail: errorText(usage.error), tone: "warn", error: true };
  if (!usage?.data) return { ...kLoadingCell };
  const totals = usage.data.totals || {};
  const weekCost = sumLastDays(usage.data.daily, 7, nowMs);
  const turns = Number(totals.turnCount || 0);
  return {
    value: formatUsd(totals.totalCost || 0),
    detail: formatUsd(weekCost) + " last 7 days · " + formatInteger(turns) + " turn" + (turns === 1 ? "" : "s"),
    tone: "neutral",
  };
};

// The four strip cells in the order a message travels through the box.
// incidents: { summary } | { error } | null (loading); usage: { data } |
// { error } | null (loading).
export const buildStripCells = ({
  chip = null,
  watchdog = null,
  incidents = null,
  usage = null,
  nowMs = Date.now(),
} = {}) => [
  { key: "gateway", label: "Gateway", href: "#/health", ...gatewayCell({ chip, watchdog }) },
  { key: "watchdog", label: "Watchdog", href: "#/health", ...watchdogCell({ watchdog, incidents }) },
  { key: "incidents", label: "Incidents 7d", href: "#/health", ...incidentsCell({ incidents }) },
  { key: "spend", label: "Spend 30d", href: "#/usage", ...spendCell({ usage, nowMs }) },
];

// The next enabled jobs by next run time.
export const buildComingUp = ({ jobs = [], agents = [], limit = kHomeComingUpLimit } = {}) => {
  const names = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent.name || agent.id]));
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.enabled !== false && Number(job?.state?.nextRunAtMs) > 0)
    .sort((a, b) => Number(a.state.nextRunAtMs) - Number(b.state.nextRunAtMs))
    .slice(0, limit)
    .map((job) => ({
      id: String(job.id || ""),
      name: String(job.name || job.id || ""),
      nextRunAtMs: Number(job.state.nextRunAtMs),
      agentName: job.agentId ? names.get(job.agentId) || job.agentId : "",
    }));
};

const modelRef = (model) => (typeof model === "string" ? model : model?.primary || "");

export const buildAgentRows = (agents = []) =>
  (Array.isArray(agents) ? agents : []).map((agent) => ({
    id: agent.id,
    name: agent.name || agent.id,
    isDefault: agent.default === true,
    model: modelRef(agent.model),
  }));

const kChannelLabels = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  whatsapp: "WhatsApp",
  signal: "Signal",
  buzz: "Buzz",
  clickclack: "ClickClack",
};

// One summary line per channel: accounts, who they are bound to and paired
// senders, from /api/channels/accounts and the status stream's channels.
export const buildChannelRows = ({ accounts = [], channels = null, agents = [] } = {}) => {
  const names = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent.name || agent.id]));
  const defaultAgent = (Array.isArray(agents) ? agents : []).find((agent) => agent.default) || null;
  return (Array.isArray(accounts) ? accounts : [])
    .map((entry) => {
      const channel = String(entry?.channel || "").trim();
      const list = Array.isArray(entry?.accounts) ? entry.accounts : [];
      if (!channel || list.length === 0) return null;
      const info = channels?.[channel] || null;
      let paired = 0;
      let awaiting = 0;
      const owners = new Set();
      for (const account of list) {
        const id = String(account?.id || "").trim() || "default";
        const statusInfo = info?.accounts?.[id] || info || null;
        const status = String(statusInfo?.status || account?.status || "configured");
        if (status !== "paired") awaiting += 1;
        paired += Number(statusInfo?.paired ?? account?.paired ?? 0) || 0;
        const owner = String(account?.boundAgentId || "").trim() || (id === "default" ? defaultAgent?.id || "" : "");
        if (owner) owners.add(names.get(owner) || owner);
      }
      const kind = channel === "telegram" || channel === "discord" ? "bot" : "account";
      const parts = [
        list.length + " " + kind + (list.length === 1 ? "" : "s") + (owners.size ? " bound to " + [...owners].join(", ") : ""),
      ];
      if (paired > 0) parts.push(paired + " paired sender" + (paired === 1 ? "" : "s"));
      if (awaiting > 0) parts.push(awaiting + " waiting to pair");
      return {
        key: channel,
        label: kChannelLabels[channel] || channel,
        detail: parts.join(" · "),
        href: channel === "telegram" && awaiting === 0 ? "#/telegram/default" : "#/channels",
        tone: awaiting > 0 ? "warn" : "ok",
      };
    })
    .filter(Boolean);
};

export const buildRelayRow = (relay = null) => {
  if (!relay || typeof relay !== "object") return null;
  const phase = relay.phase || (relay.enabled === false ? "off" : "idle");
  const copy = kRelayPhaseCopy[phase] || kRelayPhaseCopy.idle;
  const peers = Array.isArray(relay.agents) ? relay.agents.length : 0;
  return {
    key: "relay",
    label: "Relay",
    detail: phase === "ready" ? copy.label + " · " + peers + " peer agent" + (peers === 1 ? "" : "s") : copy.label,
    href: "#/relay",
    tone: phase === "ready" ? "ok" : phase === "failed" ? "bad" : "neutral",
  };
};

// Attention rows: rows that carry an action come first, so row 1's action
// is the page's one solid button.
export const orderAttentionItems = (items = []) => {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  return [...list.filter((item) => item.actionable), ...list.filter((item) => !item.actionable)];
};
