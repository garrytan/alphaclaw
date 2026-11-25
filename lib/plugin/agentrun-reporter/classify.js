// Session classes for AlphaClaw's AgentRun reporter (GST-2907). Pure and
// shared by the OpenClaw plugin (which decides whether a turn's assistant text
// is written to the spool at all) and the AlphaClaw server (which decides
// again before anything is sent). Only an isolated cron session may ever carry
// contents; every other class, and anything that does not parse, is metadata
// only. Incognito sessions are not recorded at all.
const kIncognitoPattern = /^\s*agent:[^:]+:(?:dashboard|subagent|internal-session-effects):incognito-[^:]*[^\s:]\s*$/i;
const kCronPattern = /^agent:([^:]+):cron:([^:]+)(?::run:[^:]+)?$/;
const kAgentPattern = /^agent:([^:]+):(.+)$/;
const kDirectScopes = new Set(["direct", "dm"]);
const kGroupScopes = new Set(["group", "channel"]);

const kClasses = ["cron", "dm", "group", "main", "heartbeat", "relay", "hook", "subagent", "unknown"];

const isIncognitoSessionKey = (sessionKey) => kIncognitoPattern.test(String(sessionKey || ""));

// { class, agentId, jobId, channel }. jobId only for class "cron"; channel
// only for chat classes (dm, group).
const classifySession = ({ sessionKey, trigger, jobId } = {}) => {
  const key = String(sessionKey || "").trim();
  const agentMatch = kAgentPattern.exec(key);
  const agentId = agentMatch ? agentMatch[1] : "";
  const base = { class: "unknown", agentId, jobId: "", channel: "" };
  if (!agentMatch) return base;
  const rest = agentMatch[2].split(":");
  const head = String(rest[0] || "").toLowerCase();
  if (String(trigger || "") === "heartbeat") return { ...base, class: "heartbeat" };
  const cron = kCronPattern.exec(key);
  if (cron) {
    const keyJob = cron[2];
    const ctxJob = String(jobId || "").trim();
    if (String(trigger || "") !== "cron" || (ctxJob && ctxJob !== keyJob)) return base;
    return { ...base, class: "cron", jobId: keyJob };
  }
  if (head === "main") return { ...base, class: "main" };
  if (head.startsWith("relay-")) return { ...base, class: "relay" };
  if (head === "hook") return { ...base, class: "hook" };
  if (head === "subagent" || head === "spawn") return { ...base, class: "subagent" };
  if (head === "cron") return base;
  const second = String(rest[1] || "").toLowerCase();
  const third = String(rest[2] || "").toLowerCase();
  if (kDirectScopes.has(second) || kDirectScopes.has(third)) return { ...base, class: "dm", channel: head };
  if (kGroupScopes.has(second)) return { ...base, class: "group", channel: head };
  return base;
};

// A turn that used a Google Workspace tool (GST-3848) never carries
// contents: its text can quote the owner's mail, calendar or files.
const kGoogleWorkspaceToolPattern = /^gw_/i;
const usedGoogleWorkspace = (tools = []) => tools.some((tool) => kGoogleWorkspaceToolPattern.test(String(tool?.name ?? tool ?? "")));
const mayCarryContents = (sessionClass, tools = []) => sessionClass === "cron" && !usedGoogleWorkspace(tools);

// The Google tool one after_tool_call reports, or null. A call through
// OpenClaw's dispatcher (dispatch_action on 2026.11.4, tool_call on
// 2026.10.9) is reported under the dispatcher's name, so its target is read
// from the params: id, toolId or name, at the top or under args or input, as
// the bare name or a catalog id "openclaw:google-workspace:<name>".
const kDispatchers = new Set(["dispatch_action", "tool_call"]);
const kSelectorKeys = Object.freeze(["id", "toolId", "name", "tool", "toolName", "tool_name"]);
const googleToolOf = (toolName, params) => {
  const name = String(toolName || "").trim();
  if (kGoogleWorkspaceToolPattern.test(name)) return name;
  if (!kDispatchers.has(name.toLowerCase())) return null;
  const records = [params, params?.args, params?.input].filter((record) => record && typeof record === "object" && !Array.isArray(record));
  for (const record of records) {
    for (const key of kSelectorKeys) {
      const inner = typeof record[key] === "string" ? record[key].trim().split(":").pop() : "";
      if (kGoogleWorkspaceToolPattern.test(inner)) return inner;
    }
  }
  return null;
};

module.exports = { kClasses, classifySession, isIncognitoSessionKey, mayCarryContents, usedGoogleWorkspace, googleToolOf };
