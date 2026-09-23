const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const request = require("supertest");
const { kLiveEnabled, mkTemp, repoOpenclawBin, repoBinDir, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const run = promisify(execFile);
const describeLive = kLiveEnabled ? describe : describe.skip;
const qaChromiumPath = process.env.ALPHACLAW_AUTH_QA_DIR
  ? process.env.CHROME_BIN || require("playwright").chromium.executablePath()
  : undefined;
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});

describeLive("live: pinned auth connect, runtime read, gateway activation and restart", () => {
  let root;
  let stateDir;
  let configPath;
  let env;
  let ap;
  let runtime;
  let server;
  let provider;
  let base;
  let logs = "";
  const requests = [];
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 20_000);
      server.once("exit", () => { clearTimeout(timer); resolve(); });
      server.kill("SIGTERM");
    });
  };
  const boot = async () => {
    server = spawn(process.execPath, [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (data) => { logs += data; });
    server.stderr.on("data", (data) => { logs += data; });
    try {
      await waitFor(async () => {
        if (server.exitCode !== null) throw new Error(`AlphaClaw exited ${server.exitCode}`);
        try { const res = await fetch(`${base}/health`); const body = await res.json(); return res.ok && ["running", "up"].includes(body.gateway); } catch { return false; }
      }, 180_000, "AlphaClaw and pinned gateway readiness");
    } catch (error) { throw new Error(`${error.message}\n${logs.slice(-8000)}`); }
  };
  beforeAll(async () => {
    root = mkTemp("alphaclaw-live-auth-");
    stateDir = path.join(root, ".openclaw");
    configPath = path.join(stateDir, "openclaw.json");
    fs.mkdirSync(stateDir, { recursive: true });
    provider = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push({ authorization: req.headers.authorization, path: req.url });
        const parsed = JSON.parse(body || "{}");
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of [
            { choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic auth proof." }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
          ]) res.write(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "auth-test", ...chunk })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", model: "auth-test", choices: [{ index: 0, message: { role: "assistant", content: "Synthetic auth proof." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      });
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = await freePort();
    const gatewayPort = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = { ...scrubTestRunnerEnv(), HOME: root, ALPHACLAW_ROOT_DIR: root, OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, XDG_CONFIG_HOME: stateDir,
      OPENCLAW_NO_AUTO_UPDATE: "1", OPENCLAW_SKIP_CHANNELS: "1", ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "1", ALPHACLAW_SKIP_PROFILE_ENV: "1",
      PORT: String(port), OPENCLAW_GATEWAY_TOKEN: "synthetic-gateway-token", SETUP_PASSWORD: "synthetic-setup-password", ALPHACLAW_ALLOW_LEGACY_LOGIN: "1", ALPHACLAW_SETUP_URL: base,
      PATH: `${repoBinDir()}:${process.env.PATH}` };
    delete env.OPENCLAW_GIT_DIR;
    const config = {
      gateway: { mode: "local", bind: "loopback", port: gatewayPort, auth: { mode: "token", token: "synthetic-gateway-token" } },
      agents: { entries: { authprobe: { name: "Auth probe", workspace: path.join(stateDir, "workspace-authprobe") } }, defaults: { workspace: path.join(stateDir, "workspace"), model: { primary: "auth-probe/auth-test" }, models: { "auth-probe/auth-test": {} } } },
      models: { providers: { "auth-probe": { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", models: [{ id: "auth-test", name: "Synthetic auth test", contextWindow: 128000, maxTokens: 64 }] } } },
      plugins: { allow: [] },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    await run(process.execPath, [repoOpenclawBin(), "config", "validate"], { env, timeout: 30_000 });
    fs.writeFileSync(path.join(root, "onboarded.json"), JSON.stringify({ onboarded: true }));
    Object.assign(process.env, { HOME: root, ALPHACLAW_ROOT_DIR: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: env.OPENCLAW_GATEWAY_TOKEN });
    const { createAuthProfiles } = require("../../lib/server/auth-profiles");
    ap = createAuthProfiles();
    const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("../../lib/server/openclaw-codex-migration-runtime");
    const build = resolveCodexMigrationBuild({ configPath, env });
    expect(build.version).toBe(require("../../package.json").dependencies.openclaw);
    runtime = await loadOpenclawMigrationApi({ build, prefix: "store-runtime", functionNames: ["loadAuthProfileStoreForRuntime", "createAuthProfileStoreReadScope"] });
  }, 120_000);
  afterAll(async () => { await stop(); if (provider) await new Promise((resolve) => provider.close(resolve)); }, 60_000);

  it("fresh OAuth completion is usable immediately, gateway reads edits, and a full restart preserves auth", { timeout: 420_000, retry: 0 }, async () => {
    const { registerCodexRoutes } = require("../../lib/server/routes/codex");
    const app = express();
    app.use(express.json());
    registerCodexRoutes({ app, authProfiles: ap, createPkcePair: () => ({ verifier: "synthetic-verifier", challenge: "synthetic-challenge" }),
      parseCodexAuthorizationInput: (input) => Object.fromEntries(new URL(input).searchParams), getCodexAccountId: () => "synthetic-account" });
    require("../../lib/server/routes/models").registerModelRoutes({ app, authProfiles: ap, readEnvFile: () => [], modelCatalogCache: { markStale() {} } });
    const start = await request(app).get("/auth/codex/start");
    const oauthState = new URL(start.headers.location).searchParams.get("state");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 }) });
    try {
      const exchange = await request(app).post("/api/codex/exchange").send({ input: `http://localhost/callback?code=synthetic-code&state=${oauthState}` });
      expect(exchange.status).toBe(200);
      expect(exchange.body.ok).toBe(true);
    } finally { fetchSpy.mockRestore(); }
    expect((await request(app).get("/api/codex/status")).body.connected).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "agents/main/agent/auth-profiles.json"))).toBe(false);
    expect(Object.values(runtime.loadAuthProfileStoreForRuntime(undefined, { readOnly: true }).profiles).some((profile) => profile.access === "synthetic-access")).toBe(true);
    const scope = runtime.createAuthProfileStoreReadScope(undefined, JSON.parse(fs.readFileSync(configPath, "utf8")));
    ap.upsertCodexProfile({ access: "synthetic-edited", refresh: "synthetic-refresh", expires: Date.now() + 3600_000 });
    expect(Object.values(scope.read().profiles).some((profile) => profile.access === "synthetic-edited")).toBe(true);
    ap.upsertProfile("auth-probe:default", { type: "api_key", provider: "auth-probe", key: "synthetic-key-one" });
    expect(Object.keys(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.entries)).toContain("authprobe");
    await boot();
    expect(Object.keys(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.entries)).toContain("authprobe");
    const agentArgs = [repoOpenclawBin(), "agent", "--agent", "authprobe", "--message", "Reply briefly.", "--timeout", "30"];
    const first = await run(process.execPath, agentArgs, { env, timeout: 90_000 });
    expect(first.stdout).toContain("Synthetic auth proof");
    expect(requests.at(-1).authorization).toBe("Bearer synthetic-key-one");
    const edit = await request(app).put("/api/models/auth/auth-probe:default").send({ type: "api_key", provider: "auth-probe", key: "synthetic-key-two" });
    expect(edit.status).toBe(200);
    expect(edit.body.authRuntimeRefreshed).toBe(true);
    const { beginStateDbQuiet, getStateDbHandleCount } = require("../../lib/server/state-db-quiet");
    const refreshing = ap.refreshGatewayAuth();
    expect(getStateDbHandleCount()).toBe(1);
    const quiet = beginStateDbQuiet({ owner: "live-auth-refresh", maxMs: 30_000 });
    expect((await refreshing).authRuntimeRefreshed).toBe(true);
    const { token } = await quiet;
    expect(getStateDbHandleCount()).toBe(0);
    token.release();
    const second = await run(process.execPath, agentArgs, { env, timeout: 90_000 });
    expect(second.stdout).toContain("Synthetic auth proof");
    expect(requests.at(-1).authorization).toBe("Bearer synthetic-key-two");
    await stop();
    await boot();
    expect(ap.getCodexProfile().access).toBe("synthetic-edited");
    const third = await run(process.execPath, agentArgs, { env, timeout: 90_000 });
    expect(third.stdout).toContain("Synthetic auth proof");
    expect(requests.at(-1).authorization).toBe("Bearer synthetic-key-two");
    expect(logs).not.toContain("AUTH_PROFILE_MIGRATION_REQUIRED");
    expect(logs).not.toContain("synthetic-edited");
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins?.entries?.codex?.enabled).not.toBe(true);
    if (process.env.ALPHACLAW_AUTH_QA_DIR) {
      const { chromium } = require("playwright");
      const browser = await chromium.launch({ executablePath: qaChromiumPath, args: ["--no-sandbox"] });
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      const original = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get().value_json;
      try {
        const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
        const login = await context.request.post(`${base}/api/auth/login`, { data: { password: "synthetic-setup-password" } });
        expect(login.status()).toBe(200);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}/#/models`);
        await page.getByText("Connected", { exact: true }).first().waitFor();
        fs.mkdirSync(process.env.ALPHACLAW_AUTH_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ALPHACLAW_AUTH_QA_DIR, "auth-connected.png"), fullPage: true });
        db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'").run("{");
        await page.reload();
        await page.getByText(/Credential store unavailable/).first().waitFor();
        expect(await page.getByText("Not configured", { exact: true }).count()).toBe(0);
        expect(await page.getByText("Unavailable during backup", { exact: true }).count()).toBe(0);
        await page.screenshot({ path: path.join(process.env.ALPHACLAW_AUTH_QA_DIR, "auth-unavailable.png"), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'").run(original);
        db.close();
        await browser.close();
      }
    }
  });

  it("does not bypass the boot migration guard to initialize auth on an older state schema", async () => {
    const oldRoot = mkTemp("alphaclaw-live-auth-old-schema-");
    const oldState = path.join(oldRoot, ".openclaw");
    const databasePath = path.join(oldState, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(path.join(oldState, "openclaw.json"), "{}");
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA user_version = 16; CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)");
    db.close();
    const before = fs.readFileSync(databasePath);
    await expect(run(process.execPath, [path.resolve(__dirname, "../../lib/scripts/initialize-openclaw-auth.js"), "main"], {
      env: { ...env, ALPHACLAW_ROOT_DIR: oldRoot, OPENCLAW_STATE_DIR: oldState, OPENCLAW_CONFIG_PATH: path.join(oldState, "openclaw.json") }, timeout: 15_000,
    })).rejects.toMatchObject({ code: 1 });
    expect(fs.readFileSync(databasePath)).toEqual(before);
    expect(fs.existsSync(path.join(oldState, "agents/main/agent/auth-profiles.json"))).toBe(false);
  });
});
