// LIVE TIER — AlphaClaw's relay guard plugin (lib/plugin/relay-guard,
// ALPH-71 H-1) inside the REAL pinned OpenClaw gateway. A local model fixture
// asks for one tool call per turn ("CALL <tool> <json args>") and echoes the
// tool result back, so each case reads what the gateway actually did:
//   - plugins.list reports relay-guard active;
//   - an agent:main:relay-* session is denied exec, an MCP tool, exec through
//     the tool_call wrapper, and reads of relay/secrets.json and
//     /proc/self/environ, and may still read its workspace;
//   - a main session keeps exec and the MCP tool.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-relay-guard-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
const kCandidateBinDir = process.env.OPENCLAW_CONTRACT_INSTALL_DIR
  ? path.resolve(process.env.OPENCLAW_CONTRACT_INSTALL_DIR, "node_modules", ".bin")
  : null;
process.env.PATH = [kCandidateBinDir, liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled && process.platform === "linux" ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive("LIVE relay guard plugin against the " + (kCandidateBinDir ? "candidate" : readDeclaredPin()) + " pin", () => {
  let gateway;
  let model;
  let port;
  let call;
  let workspace;
  const offered = new Map();

  const readyzOk = async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).status === 200;
    } catch {
      return false;
    }
  };

  // One turn: the model asks for the tool call, then answers "RESULT: <tool
  // result>" (or "NOT-OFFERED <tool>" when the gateway did not offer it).
  let turn = 0;
  const runTurn = async (sessionKey, toolName, args) => {
    turn += 1;
    const tag = "gt-" + turn + "-" + Math.random().toString(36).slice(2, 8);
    const sent = await call("chat.send", {
      sessionKey,
      message: "case " + tag + " CALL " + toolName + " " + JSON.stringify(args) + " END",
      idempotencyKey: tag,
      deliver: false,
    });
    expect(sent.body?.status, sent.stderr).toBe("started");
    let answer = "";
    await waitFor(async () => {
      const history = (await call("chat.history", { sessionKey, limit: 40 })).body?.messages || [];
      const start = history.map((m) => m.role === "user" && textOf(m.content).includes(tag)).lastIndexOf(true);
      if (start < 0) return false;
      const final = history.slice(start + 1).reverse().find((m) => m.role === "assistant" && /^(RESULT|NOT-OFFERED)/.test(textOf(m.content).trim()));
      answer = final ? textOf(final.content).trim() : "";
      return Boolean(final);
    }, 180_000, sessionKey + " " + toolName + " turn " + tag);
    return answer;
  };

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {}
        const messages = payload.messages || [];
        const last = messages[messages.length - 1] || {};
        const names = (payload.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean);
        // A new session's first turn carries OpenClaw's own startup rows after
        // ours, so the directive is read from the newest user row holding one.
        const userText = textOf([...messages].reverse().find((m) => m.role === "user" && /CALL \S+ \{/.test(textOf(m.content)))?.content);
        const chunk = (delta, finish = null) =>
          "data: " + JSON.stringify({ id: "relay-guard-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A new session's first turn appends OpenClaw's startup context after
        // the message, so the directive ends at its own END marker.
        const directive = /CALL (\S+) (\{.*?\}) END/s.exec(userText);
        if (!directive && userText) console.log("[live] fixture saw no directive: " + userText.slice(-300).replace(/\s+/g, " "));
        let reply = "pong";
        let toolCall = null;
        if (last.role === "tool") reply = "RESULT: " + textOf(last.content).replace(/\s+/g, " ").slice(0, 600);
        else if (directive) {
          const wanted = directive[1];
          const name = names.find((n) => n === wanted) || names.find((n) => n.endsWith(wanted)) || null;
          const caseTag = (/case (gt-\S+)/.exec(userText) || [])[1];
          if (!offered.size) console.log("[live] relay-guard offered tools: " + JSON.stringify(names));
          offered.set(caseTag, names);
          if (name) toolCall = { index: 0, id: "call_" + Date.now(), type: "function", function: { name, arguments: directive[2] } };
          else reply = "NOT-OFFERED " + wanted;
        }
        if (toolCall) {
          res.write(chunk({ role: "assistant", content: null, tool_calls: [toolCall] }));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: reply }));
          res.write(chunk({}, "stop"));
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19400 + Math.floor(Math.random() * 90);
    const token = "live-relay-guard-token-0000000000000000";
    workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes.txt"), "workspace-ok-7731\n");
    fs.mkdirSync(path.join(kRootDir, "relay"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(kRootDir, "relay", "secrets.json"), JSON.stringify({ workspaceKey: "rk_live_dummy_value_for_the_guard_test" }), { mode: 0o600 });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { applyRelayGuardEntry, buildRelayGuardEntry } = require("../../lib/server/relay/guard-entry");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      mcp: { servers: { guardfixture: { command: process.execPath, args: [path.join(__dirname, "fixtures", "guard-touch-mcp.js")] } } },
      channels: {},
    });
    applyRelayGuardEntry(config, buildRelayGuardEntry({ rootDir: kRootDir }), { log: () => {} });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
    const { shellEscapeArg } = require("../../lib/server/agents/shared");
    call = async (method, params) => {
      const result = await clawCmd("gateway call " + shellEscapeArg(method) + " --params " + shellEscapeArg(JSON.stringify(params)) + " --json", { quiet: true, timeoutMs: 30_000 });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {}
      return { body: parsed, stderr: String(result.stderr || "") };
    };
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
  }, 6 * 60 * 1000);

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    model?.close();
  });

  it(
    "loads as active, keeps a relay session read-only and inside its workspace, and leaves a main session's exec and MCP tools alone",
    async () => {
      const listed = await call("plugins.list", {});
      const guard = (listed.body?.plugins || []).find((plugin) => plugin.id === "relay-guard");
      expect(guard?.runtime, listed.stderr).toMatchObject({ state: "active" });

      const relay = "agent:main:relay-capy-guardlive";
      const execMarker = path.join(kRootDir, "relay-exec.marker");
      const execAnswer = await runTurn(relay, "exec", { command: "touch " + execMarker + " && echo ran" });
      expect(execAnswer).toContain("[relay-guard]");
      expect(fs.existsSync(execMarker)).toBe(false);

      const secretsAnswer = await runTurn(relay, "read", { path: path.join(kRootDir, "relay", "secrets.json") });
      expect(secretsAnswer).toContain("[relay-guard]");
      expect(secretsAnswer).not.toContain("rk_live_dummy_value");

      const environAnswer = await runTurn(relay, "read", { path: "/proc/self/environ" });
      expect(environAnswer).toContain("[relay-guard]");
      expect(environAnswer).not.toContain("OPENCLAW_GATEWAY_TOKEN");

      const workspaceAnswer = await runTurn(relay, "read", { path: path.join(workspace, "notes.txt") });
      expect(workspaceAnswer).toContain("workspace-ok-7731");
      expect(workspaceAnswer).not.toContain("[relay-guard]");

      // The pin defers MCP tools behind tool_search, so a deferred one is
      // called through the tool_call wrapper.
      const mcpCall = async (sessionKey, marker) => {
        const direct = await runTurn(sessionKey, "touch_marker", { path: marker });
        return direct.startsWith("NOT-OFFERED") ? { via: "tool_call", answer: await runTurn(sessionKey, "tool_call", { id: "guardfixture__touch_marker", args: { path: marker } }) } : { via: "direct", answer: direct };
      };
      const mcpMarker = path.join(kRootDir, "relay-mcp.marker");
      const mcpRelay = await mcpCall(relay, mcpMarker);
      console.log("[live] relay-guard MCP case (" + mcpRelay.via + "): " + mcpRelay.answer.slice(0, 200));
      expect(mcpRelay.answer).toContain("[relay-guard]");
      expect(fs.existsSync(mcpMarker)).toBe(false);

      const wrappedMarker = path.join(kRootDir, "relay-wrapped.marker");
      const wrappedAnswer = await runTurn(relay, "tool_call", { id: "exec", args: { command: "touch " + wrappedMarker } });
      console.log("[live] relay-guard tool_call case: " + wrappedAnswer.slice(0, 200));
      if (!wrappedAnswer.startsWith("NOT-OFFERED")) expect(wrappedAnswer).toContain("[relay-guard]");
      expect(fs.existsSync(wrappedMarker)).toBe(false);

      const main = "agent:main:guard-main";
      const mainMarker = path.join(kRootDir, "main-exec.marker");
      const mainAnswer = await runTurn(main, "exec", { command: "touch " + mainMarker + " && echo main-ran" });
      expect(mainAnswer).not.toContain("[relay-guard]");
      await waitFor(async () => fs.existsSync(mainMarker), 30_000, "main session exec ran");
      const mainMcpMarker = path.join(kRootDir, "main-mcp.marker");
      const mainMcp = await mcpCall(main, mainMcpMarker);
      console.log("[live] main MCP case (" + mainMcp.via + "): " + mainMcp.answer.slice(0, 200));
      expect(mainMcp.answer).not.toContain("[relay-guard]");
      await waitFor(async () => fs.existsSync(mainMcpMarker), 30_000, "main session MCP tool ran");
    },
    kTestTimeoutMs,
  );

  // The adversarial path forms from #336's cross-family reads, against the
  // real pinned tools: the guard must refuse every form OpenClaw or the
  // kernel would turn into another path, and no private byte may come back.
  it(
    "refuses every rewritten path form against the real read and ls tools (grep and glob when the pin offers them)",
    async () => {
      const relay = "agent:main:relay-capy-guardforms";
      const outside = path.join(kRootDir, "outside");
      fs.mkdirSync(path.join(outside, "pkg"), { recursive: true });
      fs.writeFileSync(path.join(outside, "leak.txt"), "outside-leak-5521\n");
      fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "data", ".env"), "ENV_SECRET=env-secret-5521\n");
      fs.writeFileSync(path.join(workspace, "data", "cache.db"), "db-secret-5521\n");
      fs.rmSync(path.join(workspace, "node_modules"), { force: true });
      fs.symlinkSync(path.join(outside, "pkg"), path.join(workspace, "node_modules"));
      // A missing name whose look-alike exists: OpenClaw's read would open the look-alike.
      fs.writeFileSync(path.join(workspace, "owner\u2019s.txt"), "variant-leak-5521\n");
      const cases = [
        ["read", { path: "data/.env</arg_value>>>" }],
        ["read", { path: "data/cache.db</arg_value>>" }],
        ["read", { path: path.join(workspace, "data", ".env") + "</arg_value>>" }],
        ["ls", { path: "node_modules/.." }],
        ["read", { path: "node_modules/../leak.txt" }],
        ["read", { path: workspace + "/node_modules/../leak.txt" }],
        ["grep", { pattern: "leak", path: "node_modules/.." }],
        ["glob", { pattern: "node_modules/../*.txt" }],
        ["read", { path: "@data/.env" }],
        ["read", { path: "@node_modules/../leak.txt" }],
        ["read", { path: " node_modules/../leak.txt" }],
        ["read", { path: "data/.env\u200b" }],
        ["read", { path: "file://" + path.join(workspace, "data", ".env") }],
        ["read", { path: "./node_modules/../leak.txt" }],
        ["read", { path: "owner's.txt" }],
        ["ls", { path: "missing-folder" }],
      ];
      const leaks = ["outside-leak-5521", "env-secret-5521", "db-secret-5521", "leak.txt", "variant-leak-5521"];
      for (const [toolName, args] of cases) {
        const answer = await runTurn(relay, toolName, args);
        const label = toolName + " " + JSON.stringify(args);
        console.log("[live] relay-guard form " + label + ": " + answer.slice(0, 160));
        for (const leak of leaks) expect(answer, label).not.toContain(leak);
        // The pin's default tool profile may not offer grep or glob; a tool
        // that is not offered cannot read anything. read and ls always are.
        if (answer.startsWith("NOT-OFFERED")) {
          expect(["grep", "glob"], label).toContain(toolName);
          continue;
        }
        expect(answer, label).toContain("[relay-guard]");
      }
      const plain = await runTurn(relay, "read", { path: "notes.txt" });
      expect(plain).toContain("workspace-ok-7731");
    },
    kTestTimeoutMs,
  );
});
