const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const relayGuard = require("../../lib/plugin/relay-guard");
const policy = require("../../lib/plugin/relay-guard/policy");

// A box root laid out like AlphaClaw's, with a workspace file a path tool
// could name and the relay directory the bridge keeps its database in.
const makeRoot = () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-guard-")));
  const workspace = path.join(rootDir, ".openclaw", "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# agent\n");
  fs.mkdirSync(path.join(rootDir, "relay"));
  return { rootDir, workspace };
};

const createApi = ({ rootDir, workspace }, overrides = {}) => {
  const handlers = {};
  const warnings = [];
  const api = {
    id: "relay-guard",
    config: { agents: { defaults: { workspace } } },
    pluginConfig: { rootDir },
    logger: { info: () => {}, warn: (line) => warnings.push(line), error: (line) => warnings.push(line) },
    on: (name, handler) => {
      handlers[name] = handler;
    },
    ...overrides,
  };
  return { api, handlers, warnings };
};

const kRelaySession = { agentId: "main", sessionKey: "agent:main:relay-capy-a1b2c3d4e5f6", runId: "relay-244705956220485632" };
const kMainSession = { agentId: "main", sessionKey: "agent:main:main", runId: "run-1" };

describe("relay guard plugin (ALPH-71 H-1)", () => {
  let root;
  let guard;
  beforeEach(() => {
    root = makeRoot();
    guard = createApi(root);
    relayGuard.register(guard.api);
  });
  afterEach(() => fs.rmSync(root.rootDir, { recursive: true, force: true }));

  const call = (toolName, params = {}, ctx = kRelaySession) => guard.handlers.before_tool_call({ toolName, params }, ctx);
  const blocked = (result) => result?.block === true;

  it("registers one before_tool_call hook and publishes only the tool-name allowlist", () => {
    expect(Object.keys(guard.handlers)).toEqual(["before_tool_call"]);
    expect(policy.kRelayAllowedTools).toEqual(["session_status", "agents_list"]);
  });

  it("denies every tool outside the allowlist in a relay session, matched by session key or by the bridge's run id", () => {
    for (const toolName of ["exec", "process", "write", "edit", "apply_patch", "message", "web_fetch", "web_search", "browser", "sessions_send", "sessions_spawn", "sessions_history", "sessions_list", "gateway", "automations", "relay__relay_send", "nodes"]) {
      expect(blocked(call(toolName, { command: "id" })), toolName).toBe(true);
    }
    expect(blocked(call("exec", { command: "id" }, { sessionKey: "agent:ops:relay-wintermute" }))).toBe(true);
    expect(blocked(call("exec", { command: "id" }, { runId: "relay-123" }))).toBe(true);
    expect(blocked(guard.handlers.before_tool_call({ toolName: "exec", params: {}, runId: "relay-123" }, {}))).toBe(true);
    expect(blocked(call("EXEC", { command: "id" }))).toBe(true);
    for (const toolName of ["session_status", "agents_list"]) expect(call(toolName, {})).toEqual({});
  });

  it("leaves every other session alone: a main session keeps exec, write and message", () => {
    for (const toolName of ["exec", "write", "message", "read"]) {
      expect(call(toolName, { command: "id", path: "/proc/1/environ" }, kMainSession)).toEqual({});
    }
    expect(call("exec", { command: "id" }, { sessionKey: "agent:main:telegram-123" })).toEqual({});
    expect(call("exec", { command: "id" }, { sessionKey: "agent:main:main:relay-note" })).toEqual({});
  });

  it("a main session keeps exec when the guard's policy throws (F6), and a relay call is denied instead", () => {
    const throwing = {
      ...policy,
      decideRelayToolCall: () => {
        throw new Error("boom");
      },
      relayRunActive: () => {
        throw new Error("boom");
      },
    };
    const local = createApi(root);
    relayGuard.createRelayGuardPlugin({ policy: throwing }).register(local.api);
    expect(local.handlers.before_tool_call({ toolName: "exec", params: { command: "id" } }, kMainSession)).toEqual({});
    expect(local.handlers.before_tool_call({ toolName: "read", params: { path: "AGENTS.md" } }, kMainSession)).toEqual({});
    const denied = local.handlers.before_tool_call({ toolName: "read", params: { path: "AGENTS.md" } }, kRelaySession);
    expect(denied.block).toBe(true);
    expect(denied.blockReason).toContain("[relay-guard]");
  });

  // Relay sessions are messaging-only (ALPH-71 PR 1). The adversarial path
  // table these tools once passed through is in commit 1de9cd52; the round
  // after it still found two bases OpenClaw opens from that the guard never
  // checked (a run cwd from agents.entries, sandbox.workspaceDir), so no path
  // is admitted at all.
  it("refuses every path tool in a relay session, whatever the path, including a workspace file", () => {
    const paths = [{}, { path: "AGENTS.md" }, { path: "." }, { path: root.workspace }, { path: path.join(root.workspace, "AGENTS.md") }, { file_path: "AGENTS.md" }, { pattern: "*.md" }, { pattern: "agent", path: "." }];
    for (const toolName of ["read", "ls", "glob", "grep", "find", "image", "pdf", "READ"]) {
      for (const params of paths) {
        const result = call(toolName, params);
        expect(blocked(result), toolName + " " + JSON.stringify(params)).toBe(true);
        expect(result.blockReason).toContain("[relay-guard] " + toolName.toLowerCase() + " is not available in a relay session");
        expect(result.blockReason).toContain("messaging-only");
      }
      expect(blocked(call(toolName, { path: "AGENTS.md" }, { runId: "relay-123" })), toolName).toBe(true);
    }
  });

  it("allows session_status only on the relay session itself and never with a model change", () => {
    expect(call("session_status", {})).toEqual({});
    expect(call("session_status", { sessionKey: kRelaySession.sessionKey })).toEqual({});
    expect(call("session_status", { changesSince: 3 })).toEqual({});
    expect(blocked(call("session_status", { model: "openai/gpt-5.1" }))).toBe(true);
    expect(blocked(call("session_status", { model: "" }))).toBe(true);
    expect(blocked(call("session_status", { sessionKey: kRelaySession.sessionKey, model: "x" }))).toBe(true);
    expect(blocked(call("session_status", { sessionKey: "agent:main:main" }))).toBe(true);
    expect(blocked(call("session_status", { sessionKey: "agent:main:relay-other" }))).toBe(true);
    expect(blocked(call("session_status", { sessionKey: 7 }))).toBe(true);
    expect(blocked(call("session_status", { sessionKey: "agent:main:main" }, { runId: "relay-1" }))).toBe(true);
    expect(blocked(call("sessions_list", { messageLimit: 20 }))).toBe(true);
    expect(call("session_status", { model: "x", sessionKey: "agent:main:telegram-1" }, kMainSession)).toEqual({});
  });

  it("logs each deny once per tool and session", () => {
    call("exec", { command: "id" });
    call("exec", { command: "id -u" });
    call("write", { path: "x", content: "y" });
    call("exec", { command: "id" }, { ...kRelaySession, sessionKey: "agent:main:relay-other" });
    const lines = guard.warnings.filter((line) => line.includes("[relay-guard] denied"));
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("id -u");
  });

  it("with no session key and no run id, applies the relay policy only while a relay run is in flight (F5)", () => {
    const ctxless = (toolName, params) => guard.handlers.before_tool_call({ toolName, params }, {});
    expect(ctxless("exec", { command: "id" })).toEqual({});
    const db = new DatabaseSync(path.join(root.rootDir, "relay", "bridge.db"));
    db.exec("CREATE TABLE relay_messages (message_id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    db.prepare("INSERT INTO relay_messages VALUES ('1', 'answered')").run();
    expect(ctxless("exec", { command: "id" })).toEqual({});
    db.prepare("INSERT INTO relay_messages VALUES ('2', 'dispatched')").run();
    db.close();
    expect(blocked(ctxless("exec", { command: "id" }))).toBe(true);
    expect(blocked(ctxless("read", { path: "/proc/self/environ" }))).toBe(true);
    expect(ctxless("session_status", {})).toEqual({});
    expect(guard.handlers.before_tool_call({ toolName: "exec", params: { command: "id" } }, kMainSession)).toEqual({});
  });

  // gpt-6.1-sol on #336 (6bce314e), probe 1: path.resolve collapsed ".."
});
