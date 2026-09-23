const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const {
  kLiveEnabled,
  mkTemp,
  repoOpenclawBin,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");
const {
  startGatewayCapture,
  stopGatewayCapture,
} = require("./memory-gateway");

const kPeerToken = "live-a2a-peer-token";
const kGatewayToken = "live-a2a-gateway-token";
const kSetupPassword = "live-a2a-setup-password";
const kReply = "Local A2A fixture completed.";
const describeLive = kLiveEnabled ? describe : describe.skip;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

describeLive("A2A through AlphaClaw and the real pinned gateway", () => {
  let gateway;
  let alpha;
  let modelServer;
  let baseUrl;
  let gatewayUrl;
  let configPath;
  let alphaConfigPath;
  let modelRequests = [];
  let cookie;

  const call = async (pathname, { body, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };

  beforeAll(async () => {
    const installedPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(repoOpenclawBin())), "package.json"), "utf8"));
    expect(installedPackage.version).toBe(require("../../package.json").dependencies.openclaw);
    const root = mkTemp("alphaclaw-live-a2a-");
    const gatewayHome = path.join(root, "gateway-home");
    const gatewayState = path.join(gatewayHome, ".openclaw");
    const alphaRoot = path.join(root, "alpha");
    const alphaState = path.join(alphaRoot, ".openclaw");
    fs.mkdirSync(path.join(gatewayState, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(alphaState, "workspace"), { recursive: true });
    const gatewayPort = await freePort();
    const alphaPort = await freePort();
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    baseUrl = `http://127.0.0.1:${alphaPort}`;
    modelServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({
          id: "a2a-fixture-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { role: "assistant", content: kReply }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "a2a-fixture-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    configPath = path.join(gatewayState, "openclaw.json");
    const a2a = {
      enabled: true,
      advertisedUrl: baseUrl,
      peers: { fixture: { token: kPeerToken } },
      exposeAgents: ["main"],
    };
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: {
        mode: "local",
        port: gatewayPort,
        bind: "loopback",
        auth: { mode: "token", token: kGatewayToken },
        controlUi: { basePath: "/openclaw" },
      },
      agents: {
        defaults: {
          workspace: path.join(gatewayState, "workspace"),
          model: { primary: "fixture/fixture" },
        },
      },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "Local fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      plugins: { entries: { a2a: { enabled: true } } },
      channels: { a2a },
    }));
    alphaConfigPath = path.join(alphaState, "openclaw.json");
    fs.writeFileSync(alphaConfigPath, JSON.stringify({
      gateway: { port: gatewayPort, auth: { mode: "token", token: kGatewayToken } },
      channels: { a2a },
    }));
    gateway = startGatewayCapture({
      bin: repoOpenclawBin(),
      port: gatewayPort,
      env: {
        ...scrubTestRunnerEnv(),
        HOME: gatewayHome,
        OPENCLAW_HOME: gatewayHome,
        OPENCLAW_STATE_DIR: gatewayState,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_AUTO_UPDATE: "1",
      },
    });
    await waitFor(async () => {
      if (gateway.didExit || gateway.spawnError) throw new Error(`Gateway failed: ${gateway.output.slice(-8000)}`);
      try {
        const res = await fetch(`${gatewayUrl}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(2000) });
        return res.ok && (await res.json()).supportedInterfaces?.[0]?.protocolBinding === "JSONRPC";
      } catch { return false; }
    }, 150000, "real A2A plugin discovery");
    const env = {
      ...scrubTestRunnerEnv(),
      HOME: alphaRoot,
      ALPHACLAW_ROOT_DIR: alphaRoot,
      ALPHACLAW_SETUP_URL: "https://must-not-replace-operator-url.example.test",
      SETUP_PASSWORD: kSetupPassword,
      PORT: String(alphaPort),
    };
    delete env.ALPHACLAW_CONTROL_UI_MOUNT;
    const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(path.resolve(__dirname, "../../lib/server.js"))})`], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    alpha = { child, output: "", didExit: false };
    child.stdout.on("data", (chunk) => { alpha.output = (alpha.output + chunk).slice(-8000); });
    child.stderr.on("data", (chunk) => { alpha.output = (alpha.output + chunk).slice(-8000); });
    alpha.exited = new Promise((resolve) => {
      child.once("exit", () => { alpha.didExit = true; resolve(); });
      child.once("error", (error) => { alpha.spawnError = error; resolve(); });
    });
    await waitFor(async () => {
      if (alpha.didExit || alpha.spawnError) throw new Error(`AlphaClaw failed: ${alpha.output}`);
      try { return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok; }
      catch { return false; }
    }, 30000, "AlphaClaw /health");
    const login = await call("/api/auth/login", { body: JSON.stringify({ password: kSetupPassword }) });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie").split(";")[0];
  }, 210000);

  afterAll(async () => {
    await stopGatewayCapture(alpha);
    await stopGatewayCapture(gateway);
    if (modelServer) {
      modelServer.closeAllConnections();
      await new Promise((resolve) => modelServer.close(resolve));
    }
  }, 20000);

  it.each(["/.well-known/agent-card.json", "/.well-known/agent.json"])(
    "serves the public card at %s with the reachable operator-configured origin",
    async (pathname) => {
      const res = await call(pathname);
      expect(res.status).toBe(200);
      expect(res.body.supportedInterfaces).toEqual([{
        url: `${baseUrl}/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: "1.0",
      }]);
      expect(res.body.skills.map(({ id }) => id)).toEqual(["main"]);
      expect(JSON.parse(fs.readFileSync(configPath)).channels.a2a.advertisedUrl).toBe(baseUrl);
      expect(JSON.parse(fs.readFileSync(alphaConfigPath)).channels.a2a.advertisedUrl).toBe(baseUrl);
    },
  );

  it.each(["missing", "invalid", "gateway-token", "browser-cookie"])(
    "preserves the gateway peer-auth 401 for %s credentials",
    async (kind) => {
      const headers = kind === "browser-cookie" ? { cookie } : kind === "missing" ? {} : {
        authorization: `Bearer ${kind === "gateway-token" ? kGatewayToken : "invalid-peer"}`,
      };
      const res = await call("/a2a/v1", { headers, body: '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"missing"}}' });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("configure channels.a2a.peers");
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it("completes a valid peer task through the advertised endpoint with no browser session", async () => {
    const text = "A2A exact body: café 雪, spaces and a newline\nsecond line";
    const body = JSON.stringify({
      jsonrpc: "2.0", id: "request-雪", method: "SendMessage",
      params: { message: {
        messageId: "message-1", role: "ROLE_USER", contextId: "context-1",
        parts: [{ text }],
      } },
    }, null, 2) + "\n";
    const res = await call("/a2a/v1", {
      headers: { authorization: `Bearer ${kPeerToken}` }, body,
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("request-雪");
    expect(res.body.error).toBeUndefined();
    expect(res.body.result.task.contextId).toBe("context-1");
    expect(res.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(res.body.result.task.artifacts.flatMap(({ parts }) => parts).map(({ text }) => text)).toContain(kReply);
    expect(JSON.stringify(modelRequests)).toContain(JSON.stringify(text).slice(1, -1));
    const polled = await call("/a2a/v1", {
      headers: { authorization: `Bearer ${kPeerToken}`, cookie },
      body: JSON.stringify({ jsonrpc: "2.0", id: "poll", method: "GetTask", params: { id: res.body.result.task.id } }),
    });
    expect(polled.status).toBe(200);
    expect(polled.body.result).toEqual(res.body.result.task);
  }, 45000);

  it("leaves malformed JSON validation to the real gateway", async () => {
    const res = await call("/a2a/v1", {
      headers: { authorization: `Bearer ${kPeerToken}` }, body: "{invalid JSON",
    });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32700);
  });

  it("preserves the gateway's stricter 1 MiB request limit", async () => {
    const res = await call("/a2a/v1", {
      headers: { authorization: `Bearer ${kPeerToken}` },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toContain("1 MiB");
  });
});
