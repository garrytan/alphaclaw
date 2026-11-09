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
// plugin's two tools. tests/server/relay-delegate.test.js fails when a
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
// OpenClaw 2026.11.2 calls the dispatcher dispatch_action (#169552);
// tool_call is its 2026.10.9 name, kept for a rollback to that pin.
const kDelegateCatalogTools = Object.freeze(["tool_search", "tool_describe", "dispatch_action", "tool_call"]);
const kDelegatePluginTools = Object.freeze(["memory_search", "memory_get"]);
const kDelegateAllowedTools = Object.freeze([...kDelegateCoreTools, ...kDelegateCatalogTools, ...kDelegatePluginTools]);

// Never available to a delegate, whatever ALPHACLAW_RELAY_DELEGATE_TOOLS
// says: the tools that reach other people, start or steer other sessions,
// schedule work, or change the gateway, plugins, secrets or the owner's
// instructions, and the relay's own MCP server. The message tool is reached
// only through an approval (decideApprovedSend).
const kDelegateNeverTools = Object.freeze([
  "message",
  "conversations_send",
  "conversations_turn",
  "conversations_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "sessions_history",
  "sessions_search",
  "subagents",
  "automations",
  "cron",
  "gateway",
  "plugins",
  "secrets",
  "ask_user",
  "nodes",
  "computer",
  "screen",
  "terminal",
  "portal",
  "mobile_ui",
  "openclaw",
  "intent",
  "personal_instructions",
  "browser",
  "skill_workshop",
  "github_publish",
]);
const kRelayMcpPrefix = "relay__";
const isNeverTool = (name) => kDelegateNeverTools.includes(name) || name.startsWith(kRelayMcpPrefix) || name.startsWith("conversations_");
// ALPHACLAW_RELAY_DELEGATE_TOOLS entries: exact names, or one MCP server's
// tools as "<server>__*". A shorter prefix ("m*", "s*") is not honoured: it
// would reach core tools by accident.
const kServerPrefixPattern = /^[a-z0-9][a-z0-9_-]{0,60}__\*$/;
const operatorAllows = (delegateTools, name) =>
  !isNeverTool(name) &&
  Array.isArray(delegateTools) &&
  delegateTools.some((entry) => (entry.endsWith("*") ? kServerPrefixPattern.test(entry) && name.startsWith(entry.slice(0, -1)) : entry === name));
const kApprovedSendActions = Object.freeze(["send", "reply", "sendattachment"]);
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

// The message tool's parameters an approved send may carry. Anything else
// is refused: OpenClaw 2026.10.9 (normalizeMessageActionInput) takes the
// recipient from to, channelId, roomId or chatId when target is empty, from
// a channel plugin's own delivery aliases, and ignores targets for a send,
// so a check of target alone could approve one recipient and deliver to
// another. gatewayUrl and gatewayToken would send through another gateway,
// and accountId through another account of the channel (a second Slack
// workspace's #finance is someone else), so all three are refused.
const kApprovedSendParams = new Set([
  "action",
  "channel",
  "target",
  "message",
  "text",
  "caption",
  "replyTo",
  "silent",
  "attachments",
  "media",
  "mediaUrl",
  "mediaUrls",
  "media_urls",
  "filePath",
  "fileUrl",
  "filename",
  "mimeType",
  "contentType",
  "asDocument",
  "forceDocument",
  "gifPlayback",
  "image",
  "path",
  "buffer",
  "base64",
  "presentation",
  "interactive",
  "idempotencyKey",
  "dryRun",
  "bestEffort",
  "json",
  "timeoutMs",
]);

// An approved send: the message tool with a send action, exactly one
// string target that the approval names (exactly, or as channel:target, and
// a channel-qualified approval only on that channel), no other recipient
// field, and no recipient sent to twice in the run. Returns the matched
// recipient to spend.
const decideApprovedSend = ({ params = {}, approval, used = new Set() }) => {
  const action = String(params.action || "").trim().toLowerCase();
  if (!kApprovedSendActions.includes(action)) return { allow: false, reason: "the owner's approval covers sending only, not message action " + (action || "(none)") };
  const extra = Object.keys(params || {}).filter((key) => !kApprovedSendParams.has(key));
  if (extra.length) return { allow: false, reason: "an approved send takes one target and no " + extra.slice(0, 3).join(", ") + " field" };
  if (typeof params.target !== "string" || !params.target.trim()) return { allow: false, reason: "name the one recipient in target: the owner's approval lists who to send to" };
  // Recipient ids are opaque (a Matrix room id is case-sensitive), so they
  // are compared exactly. A listed "<channel>:<id>" also matches target <id>
  // on that channel, the channel name compared without case. Any other
  // listed string ("@lupe", Discord's "channel:123") must equal target.
  const channel = typeof params.channel === "string" ? params.channel.trim().toLowerCase() : "";
  const target = params.target.trim();
  const match = approval.targets
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .find((entry) => {
      if (entry === target) return true;
      const colon = entry.indexOf(":");
      return Boolean(channel) && colon > 0 && entry.slice(0, colon).toLowerCase() === channel && entry.slice(colon + 1) === target;
    });
  if (!match) return { allow: false, reason: params.target.trim().slice(0, 80) + " is not a recipient the owner's approval names" };
  if (used.has(match)) return { allow: false, reason: "the owner's approval was already used for " + params.target.trim().slice(0, 80) };
  return { allow: true, spend: [match] };
};

// { allow: true, spend? } or { allow: false, reason }. trust is
// resolveRelayTrust's answer; anything but a delegate gets the peer policy.
// Throws only on a bug; the plugin turns a throw into a deny for relay calls.
const decideRelayToolCall = ({ toolName, params = {}, sessionKey, trust = null, delegateTools = [], usedTargets }) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (trust?.tier === "delegate") {
    if (name === "session_status") return decideSessionStatus({ params, sessionKey });
    if (!isNeverTool(name) && (kDelegateAllowedTools.includes(name) || operatorAllows(delegateTools, name))) return { allow: true };
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
  kDelegateNeverTools,
  classifyCall,
  decideRelayToolCall,
  decideApprovedSend,
  relayRunActive,
  resolveTrust: resolveRelayTrust,
};
