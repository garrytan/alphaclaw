import { getChannelMeta } from "../../lib/channel-registry.js";
import { isImplicitDefaultAccount } from "../../lib/channel-accounts.js";
import { getAgentIdFromSessionKey, getSessionRowKey } from "../../lib/session-keys.js";
import { formatChartBucketLabel, toLocalDayKey } from "../../lib/format.js";

// Pure view-models for Agent detail. Nothing here fetches.

export const kAgentDetailTabIds = ["overview", "tools", "channels", "sessions"];

export const formatNameList = (items = []) => {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join("");
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
};

// The channel accounts this agent answers: bound to it, or the unbound
// "default" account when it is the default agent (the bindings section's
// ownership rule).
export const getAgentChannelAccounts = ({ agent = null, channels = [] } = {}) => {
  const agentId = String(agent?.id || "").trim();
  if (!agentId) return [];
  const owned = [];
  for (const entry of Array.isArray(channels) ? channels : []) {
    const channel = String(entry?.channel || "").trim();
    if (!channel) continue;
    for (const account of Array.isArray(entry?.accounts) ? entry.accounts : []) {
      const accountId = String(account?.id || "").trim() || "default";
      const boundAgentId = String(account?.boundAgentId || "").trim();
      const mine = boundAgentId === agentId || (!!agent.default && isImplicitDefaultAccount({ accountId, boundAgentId }));
      if (mine) owned.push({ channel, accountId, label: getChannelMeta(channel).label });
    }
  }
  return owned;
};

// The relay bridge answers through the box's default agent, so only that
// agent answers relay messages, and only while the relay is ready.
export const answersRelay = ({ agent = null, relayStatus = null } = {}) =>
  !!agent?.default && relayStatus?.phase === "ready";

// channelsKnown false (the accounts read failed or has not answered): the
// sentence names the model only, never "no channels".
export const describeAgent = ({
  name = "",
  channelLabels = [],
  relay = false,
  modelLabel = "",
  channelsKnown = true,
} = {}) => {
  const who = String(name || "").trim() || "This agent";
  if (!modelLabel) return who + " has no model yet.";
  if (!channelsKnown) return who + " uses " + modelLabel + ".";
  const sources = [...new Set(channelLabels.filter(Boolean))];
  if (relay) sources.push("relay");
  if (sources.length === 0) return who + " has no channels yet. Chat with it here or add a channel.";
  return who + " answers " + formatNameList(sources) + " messages using " + modelLabel + ".";
};

export const getAgentSessions = ({ sessions = [], agentId = "" } = {}) =>
  (Array.isArray(sessions) ? sessions : []).filter((row) => {
    const own = String(row?.agentId || "").trim() || getAgentIdFromSessionKey(getSessionRowKey(row));
    return own === agentId;
  });

// Chat accepts a deep link to any agent:<id>:<rest> session key.
export const canOpenSessionInChat = (sessionKey = "") => /^agent:[^:]+:\S/.test(String(sessionKey || ""));

// Seven calendar days ending today (setDate, so a DST day still counts as
// one day), each with this agent's turns and cost from daily[].agents.
export const buildAgentActivity = ({ summary = null, agentId = "", nowMs = Date.now() } = {}) => {
  const byDate = new Map((Array.isArray(summary?.daily) ? summary.daily : []).map((row) => [String(row?.date || ""), row]));
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(nowMs);
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    const date = toLocalDayKey(day);
    const row = (byDate.get(date)?.agents || []).find((entry) => entry?.agent === agentId) || null;
    days.push({
      date,
      label: formatChartBucketLabel(date, { range: "7d", valueType: "day-key" }),
      turns: Number(row?.turnCount) || 0,
      cost: Number(row?.totalCost) || 0,
    });
  }
  return {
    days,
    totalTurns: days.reduce((total, day) => total + day.turns, 0),
    totalCost: days.reduce((total, day) => total + day.cost, 0),
    maxTurns: Math.max(0, ...days.map((day) => day.turns)),
  };
};
