const fs = require("fs");
const path = require("path");
const { resolveRelayTrust } = require("./trust");

// The relay guard's policy, kept apart from the plugin entry so it can be
// tested without OpenClaw. A relay call is one OpenClaw runs for a relay
// peer: session key agent:<id>:relay-<peer>, or the bridge's run id
// relay-<message id> (bridge.js relayRunId).
//
// Two tiers (GST-1982), decided by trust.js from the bridge's row:
//
//   peer      messaging-only. The agent answers from the conversation and
//             may use only session_status (its own session, never with a
//             model change, since the model param patches the session) and
//             agents_list. Every other tool is refused, and so is any tool
//             this list does not name, including tools a later OpenClaw adds.
//   delegate  a Capy thread whose relay agent the operator listed in
//             ALPHACLAW_RELAY_DELEGATE_AGENTS. It works as the owner's hands:
//             the named file, shell, web and memory tools below, plus the
//             operator's ALPHACLAW_RELAY_DELEGATE_TOOLS. It never gets the
//             tools that reach other people, spawn sessions this guard cannot
//             follow, schedule work, or change the gateway, plugins or
//             secrets. The one exception: a message that carries the owner's
//             approval lets that run send with the message tool, only to the
//             targets the approval names, once per target.
//
// The delegate tier is owner-equivalent on the box (exec runs as the
// gateway's user), so its withheld list is friction, not a wall; the gates
// are the operator's delegate list and a revoke that aborts the running turn.
//
// No path tool is offered to peers (read, ls, glob, grep were removed in
// ALPH-71 PR 1 after four review rounds). A guard that admits a path has to
// resolve it exactly as OpenClaw will, and OpenClaw kept choosing differently
// after the hook: file:// and media:// references, ".." through a symlink,
// filename repairs, a look-alike file when the exact name is missing, a run
// cwd from agents.entries, and sandbox.workspaceDir as the coding root. Do not
// add a path tool back for peers without a fresh adversarial table against the
// pinned OpenClaw's tools; the last one is in commit 1de9cd52
// (tests/server/relay-guard-plugin.test.js, tests/live/relay-guard.e2e.test.js)
// and docs/designs/agent-relay.md records why it was not enough. Delegates
// get paths without a path guard because they are owner-equivalent.
const kRelayAllowedTools = Object.freeze(["session_status", "agents_list"]);
// Names from OpenClaw 2026.10.9's core tool catalog, plus the memory
// plugin's two tools. tests/server/relay-guard-plugin.test.js fails when a
// core name here is missing from the pinned catalog.
const kDelegateCoreTools = Object.freeze([
  "read",
  "write",
  "edit",
  "ls",
  "apply_patch",
  "exec",
  "process",
  "view_image",
  "pdf",
  "web_search",
  "web_fetch",
  "structured_output",
  "session_status",
  "agents_list",
  "sessions_list",
]);
// OpenClaw's deferred-tool catalog: the wrapper calls are allowed because
// the tool each one reaches runs through this hook again under its own name
// (tool-search: wrapToolWithBeforeToolCallHook on every catalog entry).
const kDelegateCatalogTools = Object.freeze(["tool_search", "tool_describe", "tool_call"]);
const kDelegatePluginTools = Object.freeze(["memory_search", "memory_get"]);
const kDelegateAllowedTools = Object.freeze([...kDelegateCoreTools, ...kDelegateCatalogTools, ...kDelegatePluginTools]);

// ALPHACLAW_RELAY_DELEGATE_TOOLS entries: exact names, or a prefix ending in
// "*" (for example "nori__*" for one MCP server's tools).
const operatorAllows = (delegateTools, name) =>
  Array.isArray(delegateTools) && delegateTools.some((entry) => (entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name));
const kApprovedSendActions = Object.freeze(["send", "reply", "thread-reply", "sendattachment"]);
const kRelaySessionPattern = /^agent:[^:]+:relay-/i;
const kRelayRunPrefix = "relay-";
const kActiveRelayStates = ["dispatched", "completing", "reconciling"];

// "relay": a relay peer's call. "other": a session that is provably not a
// relay session. "unknown": OpenClaw passed neither a session key nor a run
// id (the tool_search catalog and plugin-tools MCP wrappers can do that).
const classifyCall = ({ sessionKey, runId } = {}) => {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const run = typeof runId === "string" ? runId.trim() : "";
  if (kRelaySessionPattern.test(key) || run.startsWith(kRelayRunPrefix)) return "relay";
  return key || run ? "other" : "unknown";
};

const decideSessionStatus = ({ params, sessionKey }) => {
  if (params?.model !== undefined && params?.model !== null) return { allow: false, reason: "changing the model is not allowed in a relay session" };
  const target = params?.sessionKey;
  if (target === undefined || target === null || target === "") return { allow: true };
  const own = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
  if (own && typeof target === "string" && target.trim().toLowerCase() === own) return { allow: true };
  return { allow: false, reason: "session_status of another session is not allowed in a relay session" };
};

// An approved send: the message tool with a send action, every target
// one the approval names (exactly, or as channel:target), and no target
// sent to twice in the run. Returns the matched targets to spend.
const decideApprovedSend = ({ params = {}, approval, used = new Set() }) => {
  const action = String(params.action || "").trim().toLowerCase();
  if (!kApprovedSendActions.includes(action)) return { allow: false, reason: "the owner's approval covers sending only, not message action " + (action || "(none)") };
  const raw = [params.target, ...(Array.isArray(params.targets) ? params.targets : [])].filter((entry) => entry !== undefined && entry !== null && entry !== "");
  if (!raw.length) return { allow: false, reason: "name the recipient: the owner's approval lists who to send to" };
  if (raw.some((entry) => typeof entry !== "string" || !entry.trim())) return { allow: false, reason: "message targets must be plain recipient strings" };
  if (params.targets !== undefined && !Array.isArray(params.targets)) return { allow: false, reason: "message targets must be a list" };
  const declared = approval.targets.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  const channel = typeof params.channel === "string" ? params.channel.trim().toLowerCase() : "";
  const spend = [];
  for (const entry of raw) {
    const target = entry.trim().toLowerCase();
    const match = [target, channel ? channel + ":" + target : null].find((form) => form && declared.includes(form));
    if (!match) return { allow: false, reason: entry.trim().slice(0, 80) + " is not a recipient the owner's approval names" };
    if (used.has(match) || spend.includes(match)) return { allow: false, reason: "the owner's approval was already used for " + entry.trim().slice(0, 80) };
    spend.push(match);
  }
  return { allow: true, spend };
};

// { allow: true, spend? } or { allow: false, reason }. trust is
// resolveRelayTrust's answer; anything but a delegate gets the peer policy.
// Throws only on a bug; the plugin turns a throw into a deny for relay calls.
const decideRelayToolCall = ({ toolName, params = {}, sessionKey, trust = null, delegateTools = [], usedTargets }) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (trust?.tier === "delegate") {
    if (name === "session_status") return decideSessionStatus({ params, sessionKey });
    if (kDelegateAllowedTools.includes(name) || operatorAllows(delegateTools, name)) return { allow: true };
    if (name === "message" && trust.approval) return decideApprovedSend({ params, approval: trust.approval, used: usedTargets });
    return { allow: false, reason: name + " is not available to a delegate relay session" };
  }
  if (!kRelayAllowedTools.includes(name)) return { allow: false, reason: name + " is not available in a relay session" };
  if (name === "agents_list") return { allow: true };
  return decideSessionStatus({ params, sessionKey });
};

// Whether the bridge has a relay run in flight (relay/bridge.db, read-only).
// No database means no relay on this box.
const relayRunActive = ({ rootDir, fsModule = fs }) => {
  const dbPath = path.join(rootDir, "relay", "bridge.db");
  if (!fsModule.existsSync(dbPath)) return false;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = kActiveRelayStates.map(() => "?").join(", ");
    return Boolean(db.prepare("SELECT 1 AS active FROM relay_messages WHERE state IN (" + placeholders + ") LIMIT 1").get(...kActiveRelayStates));
  } finally {
    db.close();
  }
};

module.exports = {
  kRelayAllowedTools,
  kDelegateCoreTools,
  kDelegateCatalogTools,
  kDelegateAllowedTools,
  classifyCall,
  decideRelayToolCall,
  decideApprovedSend,
  relayRunActive,
  resolveTrust: resolveRelayTrust,
};
