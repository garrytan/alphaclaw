// LIVE TIER — AlphaClaw's /secret command plugin (lib/plugin/secret-drop,
// GST-1956 PR 2) inside the REAL pinned OpenClaw gateway:
//   - ensureGatewayProxyConfig writes the managed plugins.entries["secret-drop"]
//     and `openclaw plugins inspect secret-drop --runtime --json` loads it from
//     that entry and lists the "secret" command;
//   - the running gateway lists /secret in commands.list and reports the
//     plugin active in plugins.list;
//   - "/secret GITHUB_TOKEN" from a gateway client without operator.admin
//     (the CLI's least-privilege chat.send) is refused by OpenClaw itself;
//   - from an operator.admin client it is answered by the plugin with the link
//     a stand-in AlphaClaw (the real secret-drop routes) mints;
//   - "/secret GITHUB_TOKEN <value>" gets the link plus a line that the value
//     was not saved, reaches the model provider with the next message unless
//     /new is sent first, and the message should be deleted, and never echoes
//     it; "/secret <value>" alone mints nothing;
//   - the model never runs for any of them;
//   - known, accepted behaviour: the session keeps the line, so the next plain
//     message sends the value to the model provider; after /new it does not;
//   - no loaded plugin registers a hook that makes OpenClaw skip restart-safe
//     chat admission (before_message_write, before_dispatch, before_agent_run,
//     reply_dispatch: RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS in the
//     pinned chat-send handler). OpenClaw keeps the /secret line, value
//     included, in openclaw-agent.sqlite; that is accepted and documented.
// Run: OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/secret-drop-command.e2e.test.js
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");

const liveHelpers = require("./live-helpers");
// PORT is read once when lib/server/constants loads, so the stand-in
// AlphaClaw's port is chosen before anything requires it.
const kAlphaclawPort = 19600 + Math.floor(Math.random() * 90);
process.env.PORT = String(kAlphaclawPort);
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-secret-drop-command-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
delete process.env.ALPHACLAW_SECRET_DROP_COMMAND;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { spawn } = require("child_process");
const { kLiveEnabled, waitFor, readDeclaredPin, runCliJson, repoOpenclawBin, scrubTestRunnerEnv } = liveHelpers;
const describeLive = kLiveEnabled && process.platform === "linux" ? describe : describe.skip;

// Fake values with no token shape, so OpenClaw's own transcript masking
// leaves them as typed and a copy in a model request is visible.
const kCanary = "plainvalue-" + Math.random().toString(36).slice(2, 12);
const kLoneCanary = "lonevalue-" + Math.random().toString(36).slice(2, 12);
const kRestartUnsafeHooks = ["before_message_write", "before_dispatch", "before_agent_run", "reply_dispatch"];
const kFakeAgentToken = "c".repeat(64);
const kOrigin = "https://box.example.com";

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive("LIVE /secret command plugin against the " + readDeclaredPin() + " pin", () => {
  let gateway;
  let model;
  let alphaclaw;
  let port;
  let call;
  let adminCall;
  let OPENCLAW_DIR;
  let modelRequests = 0;
  const modelBodies = [];
  const minted = [];

  const readyzOk = async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).status === 200;
    } catch {
      return false;
    }
  };

  // Sends a chat line through `send` and returns the first non-user message
  // the session gains after it. chat.history masks secret-shaped text in the
  // user row ("ghp_li…9Rt7"), so the reply is found by position, not by text.
  let turn = 0;
  const readHistory = async (sessionKey) => (await call("chat.history", { sessionKey, limit: 40 })).body?.messages || [];
  const sendCommand = async (send, sessionKey, message) => {
    turn += 1;
    const before = (await readHistory(sessionKey)).length;
    const sent = await send("chat.send", { sessionKey, message, idempotencyKey: "sd-" + turn + "-" + Date.now(), deliver: false });
    expect(sent.body, sent.stderr).toBeTruthy();
    let reply = "";
    let history = [];
    try {
      await waitFor(async () => {
        history = await readHistory(sessionKey);
        const after = history.slice(before).filter((m) => m.role !== "user" && textOf(m.content).trim());
        reply = after.length ? textOf(after[0].content).trim() : "";
        return Boolean(reply);
      }, 60_000, "reply to turn " + turn);
    } catch (error) {
      console.log("[live] history at timeout: " + JSON.stringify(history.map((m) => [m.role, textOf(m.content).slice(0, 120)])).split(kCanary).join("<canary>"));
      throw error;
    }
    return reply;
  };

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      modelRequests += 1;
      const body = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        modelBodies.push(Buffer.concat(body).toString("utf8"));
        const chunk = (delta, finish = null) =>
          "data: " + JSON.stringify({ id: "secret-drop-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "MODEL-RAN" }));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));

    const { createSecretDropRequests } = require("../../lib/server/secret-drop/requests");
    const { registerSecretDropRoutes } = require("../../lib/server/routes/secret-drop");
    const app = express();
    app.use(express.json());
    registerSecretDropRoutes({
      app,
      requireAuth: (req, res, next) => {
        minted.push({ authorization: req.get("authorization"), body: req.body });
        if (req.get("authorization") !== "Bearer " + kFakeAgentToken) return res.status(401).json({ error: "Unauthorized" });
        req.alphaclawActor = { type: "agent" };
        return next();
      },
      resolveRequestIdentity: () => null,
      requests: createSecretDropRequests(),
      applier: { apply: async () => ({ status: "failed" }) },
      resolveSetupUrl: () => kOrigin,
      logger: liveHelpers.kSilentLogger,
    });
    alphaclaw = await new Promise((resolve) => {
      const server = app.listen(kAlphaclawPort, "127.0.0.1", () => resolve(server));
    });

    const constants = require("../../lib/server/constants");
    OPENCLAW_DIR = constants.OPENCLAW_DIR;
    port = 19500 + Math.floor(Math.random() * 90);
    const token = "live-secret-drop-gateway-token-000000000";
    const workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(OPENCLAW_DIR, ".alphaclaw"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(OPENCLAW_DIR, ".alphaclaw", "agent-admin-token"), kFakeAgentToken + "\n", { mode: 0o600 });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(constants.kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    expect(gateway.ensureGatewayProxyConfig(undefined)).toBe(true);
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
    const fixture = path.join(__dirname, "fixtures", "gateway-admin-call.mjs");
    adminCall = (method, params) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [fixture, method, JSON.stringify(params)], {
          env: scrubTestRunnerEnv({ ...gateway.gatewayEnv(), PATH: process.env.PATH, OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:" + port, OPENCLAW_GATEWAY_TOKEN: token }),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(stdout.trim().split("\n").pop());
          } catch {}
          resolve({ body: parsed, stderr });
        });
      });
  }, 3 * 60 * 1000);

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    try {
      gateway?.killManagedGatewayChildNow?.();
    } catch {}
    model?.close();
    alphaclaw?.close();
  });

  it("loads from the managed entry ensureGatewayProxyConfig wrote and lists the secret command", () => {
    const written = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), "utf8"));
    expect(written.plugins.entries["secret-drop"]).toEqual({
      enabled: true,
      config: { _alphaclawManaged: "secret-drop", openclawDir: OPENCLAW_DIR, port: kAlphaclawPort },
    });
    expect(written.plugins.allow).toContain("secret-drop");
    const env = scrubTestRunnerEnv({
      ...gateway.gatewayEnv(),
      PATH: process.env.PATH,
    });
    const inspected = runCliJson(repoOpenclawBin(), ["plugins", "inspect", "secret-drop", "--runtime", "--json"], { env, label: "plugins inspect secret-drop" });
    expect(inspected.plugin).toMatchObject({ id: "secret-drop", status: "loaded", enabled: true, rootDir: path.resolve(__dirname, "../../lib/plugin/secret-drop") });
    expect(inspected.commands).toEqual(["secret"]);
    expect(inspected.diagnostics).toEqual([]);
    expect(inspected.typedHooks).toEqual([]);

    const everyPlugin = runCliJson(repoOpenclawBin(), ["plugins", "inspect", "--all", "--runtime", "--json"], { env, label: "plugins inspect --all" });
    const loaded = everyPlugin.filter((report) => report.plugin?.status === "loaded");
    expect(loaded.map((report) => report.plugin.id)).toContain("secret-drop");
    const restartUnsafe = loaded.flatMap((report) =>
      (report.typedHooks || []).filter((hook) => kRestartUnsafeHooks.includes(hook.name)).map((hook) => report.plugin.id + ":" + hook.name),
    );
    expect(restartUnsafe).toEqual([]);
  }, 180_000);

  it("the running gateway lists /secret and answers it without the model, with a value in chat or without", async () => {
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");

    const plugins = await call("plugins.list", {});
    const entry = (plugins.body?.plugins || []).find((plugin) => plugin.id === "secret-drop");
    expect(entry?.runtime, plugins.stderr).toMatchObject({ state: "active" });
    const commands = await call("commands.list", { scope: "text", includeArgs: false });
    const secret = (commands.body?.commands || []).find((command) => command.name === "secret");
    expect(secret, JSON.stringify((commands.body?.commands || []).map((command) => command.name))).toBeTruthy();
    console.log("[live] commands.list secret: " + JSON.stringify(secret));

    const session = "agent:main:secret-drop-live";
    const refused = await sendCommand(call, session, "/secret GITHUB_TOKEN");
    expect(refused).toContain("This command requires gateway scope: operator.admin");
    expect(minted).toEqual([]);

    const linkReply = await sendCommand(adminCall, session, "/secret GITHUB_TOKEN");
    console.log("[live] /secret reply: " + linkReply.replace(/\/secret\/[A-Za-z0-9_-]{43}/, "/secret/<token>"));
    expect(linkReply).toMatch(new RegExp(kOrigin + "/secret/[A-Za-z0-9_-]{43}"));
    expect(linkReply).toContain("It works once, for 15 minutes.");
    expect(minted).toEqual([{ authorization: "Bearer " + kFakeAgentToken, body: { name: "GITHUB_TOKEN", reason: "requested with /secret" } }]);

    const valueReply = await sendCommand(adminCall, session, "/secret GITHUB_TOKEN " + kCanary);
    console.log("[live] /secret with a value reply: " + valueReply.replace(/\/secret\/[A-Za-z0-9_-]{43}/, "/secret/<token>"));
    expect(valueReply).toMatch(new RegExp(kOrigin + "/secret/[A-Za-z0-9_-]{43}"));
    expect(valueReply).toContain("Values never go in chat: what you typed after GITHUB_TOKEN was not saved.");
    expect(valueReply).toContain("it will reach the model provider with your next message unless you send /new first to start a new session");
    expect(valueReply).toContain("Delete that message now (Telegram: long-press it, then Delete).");
    expect(valueReply).not.toContain(kCanary);
    expect(minted).toHaveLength(2);

    const loneReply = await sendCommand(adminCall, session, "/secret " + kLoneCanary);
    expect(loneReply).toContain("That is not a variable name");
    expect(loneReply).toContain("it will reach the model provider with your next message unless you send /new first");
    expect(loneReply).not.toContain(kLoneCanary);
    expect(minted).toHaveLength(2);
    expect(modelRequests).toBe(0);
  }, 6 * 60 * 1000);

  it("known, accepted: a value typed after /secret NAME reaches the model provider with the next plain message, and not after /new", async () => {
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
    const attempt = Date.now().toString(36);
    const canary = "plainvalue-" + attempt + Math.random().toString(36).slice(2, 8);
    const kept = "agent:main:secret-drop-followup-" + attempt;
    minted.length = 0;
    modelBodies.length = 0;

    const valueReply = await sendCommand(adminCall, kept, "/secret GITHUB_TOKEN " + canary);
    expect(valueReply).toContain("unless you send /new first");
    expect(modelBodies).toEqual([]);
    expect(await sendCommand(call, kept, "hello after the secret")).toContain("MODEL-RAN");
    expect(modelBodies.length).toBeGreaterThan(0);
    expect(modelBodies.some((body) => body.includes(canary))).toBe(true);

    const fresh = "agent:main:secret-drop-new-" + attempt;
    const freshCanary = "plainvalue-" + attempt + Math.random().toString(36).slice(2, 8);
    await sendCommand(adminCall, fresh, "/secret GITHUB_TOKEN " + freshCanary);
    modelBodies.length = 0;
    const sent = await adminCall("chat.send", { sessionKey: fresh, message: "/new", idempotencyKey: "sd-new-" + attempt, deliver: false });
    expect(sent.body, sent.stderr).toBeTruthy();
    let afterNew = [];
    try {
      await waitFor(async () => {
        afterNew = await readHistory(fresh);
        return !afterNew.some((m) => textOf(m.content).includes(freshCanary));
      }, 60_000, "/new drops the old history");
    } catch (error) {
      console.log("[live] /new send: " + JSON.stringify(sent.body).slice(0, 400) + " history: " + JSON.stringify(afterNew.map((m) => [m.role, textOf(m.content).slice(0, 160)])).split(freshCanary).join("<canary>"));
      throw error;
    }
    expect(await sendCommand(call, fresh, "hello after /new")).toContain("MODEL-RAN");
    expect(modelBodies.length).toBeGreaterThan(0);
    expect(modelBodies.some((body) => body.includes(freshCanary))).toBe(false);
  }, 6 * 60 * 1000);
});
