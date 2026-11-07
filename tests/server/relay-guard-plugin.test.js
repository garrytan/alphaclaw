const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const relayGuard = require("../../lib/plugin/relay-guard");
const policy = require("../../lib/plugin/relay-guard/policy");

// A box root laid out like AlphaClaw's: the agent workspace and the log dir
// are the only places a relay session may read; relay/, .env, auth profiles
// and databases are private wherever they are.
const makeRoot = () => {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-guard-")));
  const workspace = path.join(rootDir, ".openclaw", "workspace");
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes", "status.md"), "all good\n");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# agent\n");
  fs.mkdirSync(path.join(workspace, "data"));
  fs.writeFileSync(path.join(workspace, "data", "cache.db"), "sqlite");
  fs.writeFileSync(path.join(workspace, "data", ".env"), "SECRET=dummy-value\n");
  fs.mkdirSync(path.join(rootDir, "logs", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "logs", "openclaw", "gateway.log"), "started\n");
  fs.mkdirSync(path.join(rootDir, "relay"));
  fs.writeFileSync(path.join(rootDir, "relay", "secrets.json"), JSON.stringify({ workspaceKey: "rk_live_dummy" }));
  fs.writeFileSync(path.join(rootDir, ".env"), "SETUP_PASSWORD=dummy-password\n");
  fs.mkdirSync(path.join(rootDir, ".openclaw", "agents", "main", "agent"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"), "{}");
  fs.writeFileSync(path.join(rootDir, ".openclaw", "openclaw.json"), "{}");
  return { rootDir, workspace };
};

const createApi = ({ rootDir, workspace }, overrides = {}) => {
  const handlers = {};
  const warnings = [];
  const api = {
    id: "relay-guard",
    config: { agents: { defaults: { workspace } } },
    pluginConfig: { rootDir, logDirs: [path.join(rootDir, "logs")] },
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
    expect(policy.kRelayAllowedTools).toEqual(["read", "ls", "glob", "grep", "session_status", "agents_list"]);
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

  it("a main session keeps exec when the guard's path code throws (F6), and a relay call is denied instead", () => {
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

  it("contains read and ls to the agent workspace and the log dirs", () => {
    expect(call("read", { path: "notes/status.md" })).toEqual({});
    expect(call("read", { path: path.join(root.workspace, "AGENTS.md") })).toEqual({});
    expect(blocked(call("read", { path: "@notes/status.md" }))).toBe(true);
    expect(call("read", { path: path.join(root.rootDir, "logs", "openclaw", "gateway.log") })).toEqual({});
    expect(call("ls", {})).toEqual({});
    expect(call("ls", { path: "notes" })).toEqual({});
    expect(blocked(call("read", { path: path.join(root.rootDir, ".openclaw", "openclaw.json") }))).toBe(true);
    expect(blocked(call("read", { path: "../openclaw.json" }))).toBe(true);
    expect(blocked(call("read", { path: "~/.ssh/id_rsa" }))).toBe(true);
    expect(blocked(call("read", { path: "/etc/passwd" }))).toBe(true);
    expect(blocked(call("ls", { path: root.rootDir }))).toBe(true);
    expect(blocked(call("read", {}))).toBe(true);
  });

  it("always denies /proc, /sys, the root .env, relay/, auth profiles and databases", () => {
    expect(blocked(call("read", { path: "/proc/" + process.pid + "/environ" }))).toBe(true);
    expect(blocked(call("read", { path: "/proc/self/environ" }))).toBe(true);
    expect(blocked(call("read", { path: "/sys/class/net" }))).toBe(true);
    expect(blocked(call("read", { path: path.join(root.rootDir, ".env") }))).toBe(true);
    expect(blocked(call("read", { path: path.join(root.rootDir, "relay", "secrets.json") }))).toBe(true);
    expect(blocked(call("ls", { path: path.join(root.rootDir, "relay") }))).toBe(true);
    expect(blocked(call("read", { path: path.join(root.rootDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json") }))).toBe(true);
    expect(blocked(call("read", { path: "data/cache.db" }))).toBe(true);
    expect(blocked(call("read", { path: "data/.env" }))).toBe(true);
  });

  it("refuses a symlink in the workspace that escapes it, and one that points at /proc", () => {
    fs.symlinkSync(path.join(root.rootDir, "relay"), path.join(root.workspace, "innocent"));
    fs.symlinkSync("/proc/self/environ", path.join(root.workspace, "env.txt"));
    fs.symlinkSync(path.join(root.rootDir, ".openclaw", "openclaw.json"), path.join(root.workspace, "notes", "config.json"));
    expect(blocked(call("read", { path: "innocent/secrets.json" }))).toBe(true);
    expect(blocked(call("ls", { path: "innocent" }))).toBe(true);
    expect(blocked(call("read", { path: "env.txt" }))).toBe(true);
    expect(blocked(call("read", { path: "notes/config.json" }))).toBe(true);
    expect(call("read", { path: "notes/status.md" })).toEqual({});
  });

  it("resolves glob and grep roots, and refuses a root holding an escaping symlink or a private file", () => {
    expect(call("glob", { pattern: "notes/*.md" })).toEqual({});
    expect(call("grep", { pattern: "good", path: "notes" })).toEqual({});
    expect(blocked(call("glob", { pattern: "../**/*.json" }))).toBe(true);
    expect(blocked(call("glob", { pattern: "{..,x}/{..,x}/etc/*" }))).toBe(true);
    expect(blocked(call("glob", { pattern: "{a,/etc}/*" }))).toBe(true);
    expect(blocked(call("glob", { pattern: path.join(root.rootDir, "relay", "*") }))).toBe(true);
    expect(blocked(call("grep", { pattern: "x", path: "/proc" }))).toBe(true);
    expect(blocked(call("grep", { pattern: "PASSWORD", path: "data" }))).toBe(true);
    expect(blocked(call("grep", { pattern: "PASSWORD", path: "." }))).toBe(true);
    fs.symlinkSync(path.join(root.rootDir, "relay"), path.join(root.workspace, "notes", "link"));
    expect(blocked(call("glob", { pattern: "*.md", path: "notes" }))).toBe(true);
    expect(blocked(call("grep", { pattern: "good", path: "notes" }))).toBe(true);
  });

  it("refuses file URLs, which OpenClaw turns into real paths, in every path tool and glob pattern", () => {
    expect(blocked(call("read", { path: "file:///etc/hostname" }))).toBe(true);
    expect(blocked(call("read", { path: "file:///proc/self/environ" }))).toBe(true);
    expect(blocked(call("read", { path: "@file://" + path.join(root.rootDir, ".openclaw", "openclaw.json") }))).toBe(true);
    expect(blocked(call("read", { path: "FILE:///etc/hostname" }))).toBe(true);
    expect(blocked(call("read", { path: "file://" + path.join(root.workspace, "AGENTS.md") }))).toBe(true);
    expect(blocked(call("ls", { path: "file:///" }))).toBe(true);
    expect(blocked(call("grep", { pattern: "root", path: "file:///etc" }))).toBe(true);
    expect(blocked(call("glob", { pattern: "file:///etc/*" }))).toBe(true);
    expect(call("read", { path: "notes/status.md" })).toEqual({});
  });

  it("refuses any reference with a URI scheme or a MEDIA: prefix, so only plain paths reach the path check", () => {
    const references = [
      "media://inbound/fake-id.png",
      "MEDIA:media://inbound/fake-id.png",
      "media: media://inbound/fake-id.png",
      "MEDIA :notes/status.md",
      "@media://inbound/fake-id.png",
      "@ media://inbound/fake-id.png",
      "http://example.invalid/x",
      "https://example.invalid/x",
      "data:text/plain;base64,ZmFrZQ==",
      "foo:bar",
      "@foo:notes/status.md",
      "C:\\fake\\file.txt",
    ];
    for (const reference of references) {
      expect(blocked(call("read", { path: reference })), "read " + reference).toBe(true);
      expect(blocked(call("ls", { path: reference })), "ls " + reference).toBe(true);
      expect(blocked(call("grep", { pattern: "x", path: reference })), "grep " + reference).toBe(true);
      expect(blocked(call("glob", { pattern: reference })), "glob " + reference).toBe(true);
      expect(blocked(call("glob", { pattern: "*.png", path: reference })), "glob path " + reference).toBe(true);
    }
    expect(blocked(call("glob", { pattern: "media://inbound/*" }))).toBe(true);
    expect(blocked(call("read", { path: "@ /etc/hostname" }))).toBe(true);
    expect(call("read", { path: "notes/status.md" })).toEqual({});
    expect(call("read", { path: path.join(root.workspace, "notes", "status.md") })).toEqual({});
    expect(call("glob", { pattern: "notes/*.md" })).toEqual({});
  });

  it("fails closed on relative paths when a run cwd is configured, since OpenClaw resolves them there", () => {
    const configs = {
      defaultsCwd: { agents: { defaults: { workspace: root.workspace, cwd: path.join(root.rootDir, ".openclaw") } } },
      agentCwd: { agents: { defaults: { workspace: root.workspace }, list: [{ id: "main", cwd: path.join(root.rootDir, ".openclaw") }] } },
    };
    for (const [label, config] of Object.entries(configs)) {
      const local = createApi(root, { config });
      relayGuard.register(local.api);
      const localCall = (toolName, params) => local.handlers.before_tool_call({ toolName, params }, kRelaySession);
      expect(blocked(localCall("read", { path: "openclaw.json" })), label).toBe(true);
      expect(blocked(localCall("read", { path: "notes/status.md" })), label).toBe(true);
      expect(blocked(localCall("ls", {})), label).toBe(true);
      expect(blocked(localCall("grep", { pattern: "x" })), label).toBe(true);
      expect(blocked(localCall("glob", { pattern: "*.json" })), label).toBe(true);
      expect(localCall("read", { path: path.join(root.workspace, "notes", "status.md") }), label).toEqual({});
      expect(localCall("glob", { pattern: path.join(root.workspace, "notes", "*.md") }), label).toEqual({});
      expect(blocked(localCall("read", { path: path.join(root.rootDir, ".openclaw", "openclaw.json") })), label).toBe(true);
    }
    expect(call("read", { path: "notes/status.md" })).toEqual({});
    expect(call("ls", {})).toEqual({});
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
  // before symlinks were resolved, but the kernel follows the symlink first.
  it("refuses .. through a workspace symlink, which the kernel resolves outside the workspace", () => {
    const outside = path.join(root.rootDir, "outside");
    fs.mkdirSync(path.join(outside, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(outside, "leak.txt"), "outside-the-workspace\n");
    fs.symlinkSync(path.join(outside, "pkg"), path.join(root.workspace, "node_modules"));
    expect(fs.readdirSync(path.join(root.workspace, "node_modules") + "/..")).toContain("leak.txt");
    expect(blocked(call("ls", { path: "node_modules/.." }))).toBe(true);
    expect(blocked(call("read", { path: "node_modules/../leak.txt" }))).toBe(true);
    expect(blocked(call("ls", { path: root.workspace + "/node_modules/.." }))).toBe(true);
    expect(blocked(call("grep", { pattern: "outside", path: "node_modules/.." }))).toBe(true);
    expect(blocked(call("glob", { pattern: "*.txt", path: "node_modules/.." }))).toBe(true);
    expect(blocked(call("glob", { pattern: "node_modules/../*.txt" }))).toBe(true);
  });

  // Probe 2: OpenClaw repairs a path after before_tool_call, so the guard
  // checked "data/.env</arg_value>>>" and the tool opened "data/.env".
  it("refuses a path OpenClaw repairs after the hook, so a repair can never turn it into a private file", () => {
    expect(blocked(call("read", { path: "data/.env</arg_value>>>" }))).toBe(true);
    expect(blocked(call("read", { path: "data/cache.db</arg_value>>" }))).toBe(true);
    expect(blocked(call("read", { path: path.join(root.rootDir, "relay", "secrets.json") + "</arg_value>>" }))).toBe(true);
    expect(blocked(call("ls", { path: "data</arg_value>>" }))).toBe(true);
    expect(blocked(call("grep", { pattern: "x", path: "data/.env</arg_value>>" }))).toBe(true);
    expect(blocked(call("read", { path: "notes/report.docodex" }))).toBe(true);
    expect(call("read", { path: "notes/status.md" })).toEqual({});
  });

  // The path the guard checks must be the path the tool opens: every form
  // OpenClaw or the kernel would rewrite is refused, whatever it points at.
  it("refuses every non-plain path form in every path tool (adversarial table)", () => {
    fs.symlinkSync(root.rootDir, path.join(root.workspace, "up"));
    const forms = [
      "notes/../AGENTS.md",
      "./notes/status.md",
      "notes/./status.md",
      "notes//status.md",
      "..",
      "../.env",
      "notes/..",
      "up/../.env",
      root.workspace + "/../.env",
      root.workspace + "/./AGENTS.md",
      "@notes/status.md",
      "@@notes/status.md",
      "@" + path.join(root.rootDir, ".env"),
      "~",
      "~/.env",
      " notes/status.md",
      "notes/status.md ",
      "notes/status.md\n",
      "\tnotes/status.md",
      "notes/\u200bstatus.md",
      "notes/status.md\u00a0",
      "\ufeffnotes/status.md",
      "notes\\status.md",
      "notes/status.md</arg_value>>",
      "data/.env</arg_value>>>",
      "data/report.xlsxodex",
      "file:///etc/passwd",
      "FILE:" + path.join(root.rootDir, ".env"),
      "media://inbound/x.png",
      "MEDIA:notes/status.md",
      "data:text/plain,x",
      "C:\\x",
    ];
    for (const form of forms) {
      for (const [tool, params] of [
        ["read", { path: form }],
        ["ls", { path: form }],
        ["grep", { pattern: "x", path: form }],
        ["glob", { pattern: "*", path: form }],
        ["glob", { pattern: form + "/*" }],
        ["read", { path: "notes/status.md", file_path: form }],
      ]) {
        expect(blocked(call(tool, params)), tool + " " + JSON.stringify(params)).toBe(true);
      }
    }
    for (const plain of ["notes/status.md", "AGENTS.md", "notes", "notes/", path.join(root.workspace, "notes", "status.md")]) {
      expect(call("read", { path: plain }), "read " + plain).toEqual({});
    }
    for (const missing of ["notes/%2e%2e", "notes/missing.md", "missing/status.md"]) {
      expect(blocked(call("read", { path: missing })), "read " + missing).toBe(true);
      expect(blocked(call("ls", { path: missing })), "ls " + missing).toBe(true);
    }
    expect(call("ls", {})).toEqual({});
    expect(call("ls", { path: "." })).toEqual({});
    expect(call("glob", { pattern: "notes/*.md" })).toEqual({});
  });

  // Pins the guard to the installed OpenClaw: for every form, the path the
  // real tool code would open (its repair, then its input resolution) is the
  // string the guard checked, or the guard refuses the call.
  it("checks exactly the path the pinned OpenClaw opens, or refuses (contract with the installed dist)", async () => {
    const dist = path.join(__dirname, "..", "..", "node_modules", "openclaw", "dist");
    const findExport = async (functionName) => {
      const file = fs.readdirSync(dist).find((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(dist, name), "utf8").includes("\nfunction " + functionName + "("));
      expect(file, functionName + " in the OpenClaw dist").toBeTruthy();
      const mod = await import(path.join(dist, file));
      const fn = Object.values(mod).find((value) => typeof value === "function" && value.name === functionName);
      expect(fn, functionName + " exported").toBeTruthy();
      return fn;
    };
    const repair = await findExport("normalizeFileToolPathParam");
    const resolveInput = await findExport("resolveSandboxInputPath");
    const opened = (raw) => path.normalize(resolveInput(repair(raw), root.workspace));
    const forms = [
      "notes/status.md", "AGENTS.md", "notes", path.join(root.workspace, "AGENTS.md"),
      "data/.env</arg_value>>>", "data/cache.db</arg_value>>", "notes/x.docodex", "notes/x.PPTXCODEX",
      "@notes/status.md", "@@notes/status.md", "~/x", "~", "notes/../AGENTS.md", "./AGENTS.md", "notes//status.md",
      "notes/status.md/", root.workspace + "/../.env",
    ];
    let refusedRewrites = 0;
    for (const raw of forms) {
      // A trailing slash names the same directory to the kernel and to path.resolve.
      const checked = (path.isAbsolute(raw) ? raw : path.join(root.workspace, raw)).replace(/(.)\/$/, "$1");
      if (opened(raw) === checked && !raw.includes("..") && !raw.startsWith("./") && !raw.includes("//")) continue;
      refusedRewrites += 1;
      expect(blocked(call("read", { path: raw })), "read " + raw + " opens " + opened(raw)).toBe(true);
    }
    expect(refusedRewrites).toBeGreaterThanOrEqual(10);
  });

  // gpt-6.1-sol on #336 (c0b4dcc0): when the exact read path is missing,
  // OpenClaw opens a look-alike name instead (path-utils.ts
  // collectReadPathVariants), after the hook.
  it("refuses a missing read path whose look-alike name OpenClaw would open instead", () => {
    fs.symlinkSync(path.join(root.workspace, "data", ".env"), path.join(root.workspace, "owner\u2019s.txt"));
    expect(blocked(call("read", { path: "owner's.txt" }))).toBe(true);
    fs.writeFileSync(path.join(root.workspace, "cafe\u0301.md"), "nfd\n");
    expect(blocked(call("read", { path: "caf\u00e9.md" }))).toBe(true);
    fs.writeFileSync(path.join(root.workspace, "Screen Shot 1 at 10.00.00\u202fAM.png"), "png");
    expect(blocked(call("read", { path: "Screen Shot 1 at 10.00.00 AM.png" }))).toBe(true);
  });

  it("refuses a name with a look-alike beside it, even when the exact name exists", () => {
    fs.writeFileSync(path.join(root.workspace, "owner's.txt"), "benign\n");
    expect(call("read", { path: "owner's.txt" })).toEqual({});
    fs.symlinkSync(path.join(root.workspace, "data", ".env"), path.join(root.workspace, "owner\u2018s.txt"));
    expect(blocked(call("read", { path: "owner's.txt" }))).toBe(true);
    expect(blocked(call("ls", { path: "owner's.txt" }))).toBe(true);
  });

  it("walks into a symlinked folder that stays inside the workspace when grep or glob checks a tree", () => {
    fs.symlinkSync(path.join(root.workspace, "data"), path.join(root.workspace, "notes", "link"));
    expect(blocked(call("grep", { pattern: "SECRET", path: "notes" }))).toBe(true);
    fs.rmSync(path.join(root.workspace, "notes", "link"));
    fs.mkdirSync(path.join(root.workspace, "loop"));
    fs.symlinkSync(path.join(root.workspace, "loop"), path.join(root.workspace, "loop", "self"));
    expect(call("grep", { pattern: "x", path: "loop" })).toEqual({});
  });

  it("a relay call whose agent workspace cannot be resolved is denied, never allowed", () => {
    const local = createApi(root, { config: {}, pluginConfig: { rootDir: path.join(root.rootDir, "missing") } });
    relayGuard.register(local.api);
    expect(local.handlers.before_tool_call({ toolName: "read", params: { path: "AGENTS.md" } }, kRelaySession).block).toBe(true);
  });
});
