const fs = require("fs");
const path = require("path");

// The relay guard's policy, kept apart from the plugin entry so it can be
// tested without OpenClaw. A relay call is one OpenClaw runs for a relay
// peer: session key agent:<id>:relay-<peer>, or the bridge's run id
// relay-<message id> (bridge.js relayRunId). Relay sessions are
// messaging-only: the agent answers from the conversation and may use only
// session_status (its own session, never with a model change, since the
// model param patches the session) and agents_list. Every other tool is
// refused, and so is any tool this list does not name, including tools a
// later OpenClaw adds.
//
// No path tool is offered (read, ls, glob, grep were removed in ALPH-71 PR 1
// after four review rounds). A guard that admits a path has to resolve it
// exactly as OpenClaw will, and OpenClaw kept choosing differently after the
// hook: file:// and media:// references, ".." through a symlink, filename
// repairs, a look-alike file when the exact name is missing, a run cwd from
// agents.entries, and sandbox.workspaceDir as the coding root. Do not add a
// path tool back without a fresh adversarial table against the pinned
// OpenClaw's tools; the last one is in commit 1de9cd52
// (tests/server/relay-guard-plugin.test.js, tests/live/relay-guard.e2e.test.js)
// and docs/designs/agent-relay.md records why it was not enough.
const kRelayAllowedTools = Object.freeze(["session_status", "agents_list"]);
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

// { allow: true } or { allow: false, reason }. Throws only on a bug; the
// plugin turns a throw into a deny for relay calls.
const decideRelayToolCall = ({ toolName, params = {}, sessionKey }) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (!kRelayAllowedTools.includes(name)) return { allow: false, reason: name + " is not available in a relay session" };
  if (name === "agents_list") return { allow: true };
  if (params?.model !== undefined && params?.model !== null) return { allow: false, reason: "changing the model is not allowed in a relay session" };
  const target = params?.sessionKey;
  if (target === undefined || target === null || target === "") return { allow: true };
  const own = typeof sessionKey === "string" ? sessionKey.trim().toLowerCase() : "";
  if (own && typeof target === "string" && target.trim().toLowerCase() === own) return { allow: true };
  return { allow: false, reason: "session_status of another session is not allowed in a relay session" };
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
  classifyCall,
  decideRelayToolCall,
  relayRunActive,
};
