const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");
const httpProxy = require("http-proxy-3");

const {
  kLiveEnabled,
  mkTemp,
  openclawCliUsable,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");

// LIVE tier, REAL browser: the Control UI must connect and chat on EVERY
// hostname an install is reached by, not only the one origin boot pinned.
//
//   boot pins ONE origin ──▶ gateway.controlUi.allowedOrigins = [http://127.0.0.1:<port>]
//   Chromium ── http://claw.example.test:<port>  (second hostname, e.g. a custom domain or the VPS IP)
//   Chromium ── http://edge.example.test:<edge>  ──▶ edge proxy rewrites Host, sets X-Forwarded-Host
//              (Railway/Render-style ingress)          ──▶ AlphaClaw ──▶ real gateway
//
// Before the fix every connect on those hostnames was answered
// CONTROL_UI_ORIGIN_NOT_ALLOWED ("Browser origin not allowed"): AlphaClaw's
// proxy rewrites Host to the gateway's loopback address, so the gateway's
// same-host rule never matched and only the pinned origin worked. Each
// hostname must now reach hello-ok AND complete a chat turn against a mock
// OpenAI-compatible model (a rendered shell with a dead socket is the bug).
// The pinned allowlist is asserted unchanged so a green run proves the
// proxy-side fix, not a config workaround.
//
// Run: OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/control-ui-hostnames.e2e.test.js --no-file-parallelism
const describeLive = kLiveEnabled ? describe : describe.skip;

const kBootTimeoutMs = 4 * 60 * 1000;
const kTestTimeoutMs = 4 * 60 * 1000;
const kSetupPassword = "live-control-ui-hostnames-pass";
const kSecondHost = "claw.example.test";
const kEdgeHost = "edge.example.test";
const kOriginRejectedCode = "CONTROL_UI_ORIGIN_NOT_ALLOWED";

const resolveChromeExecutable = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const found = execFileSync("which", ["google-chrome"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found) return found;
  } catch {}
  return undefined;
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Minimal OpenAI-compatible chat model: streams "pong <nonce>" back for the
// last "ping-xxxxxx" token in the request.
const startMockModel = async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const nonces = body.match(/ping-[a-z0-9]{6}/g);
      const reply = `pong ${nonces ? nonces[nonces.length - 1] : "hello"}`;
      let stream = false;
      try {
        stream = JSON.parse(body || "{}").stream === true;
      } catch {}
      const id = "chatcmpl-live";
      if (!stream) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            model: "echo",
            choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finishReason = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model: "echo",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: reply }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  const port = await listen(server);
  return { server, port };
};

// Railway/Render-style ingress: Host becomes an internal name, the public one
// travels in X-Forwarded-Host.
const startEdge = async (targetPort) => {
  const proxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${targetPort}`, ws: true });
  const stamp = (proxyReq, req) => {
    proxyReq.setHeader("x-forwarded-host", req.headers.host);
    proxyReq.setHeader("x-forwarded-proto", "http");
    proxyReq.setHeader("host", "internal-svc:8080");
  };
  proxy.on("proxyReq", stamp);
  proxy.on("proxyReqWs", stamp);
  proxy.on("error", (_err, _req, res) => {
    try {
      res.destroy?.();
    } catch {}
  });
  const server = http.createServer((req, res) => proxy.web(req, res));
  server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));
  const port = await listen(server);
  return { server, proxy, port };
};

describeLive("live: the Control UI connects and chats on every hostname (real browser)", () => {
  const cliUsable = openclawCliUsable();
  const itLive = cliUsable ? it : it.skip;

  let rootDir;
  let openclawConfigPath;
  let port;
  let serverChild;
  let serverLog = "";
  let mockModel;
  let edge;
  let browser = null;
  let browserSkipReason = null;

  const logTail = (chars = 1500) => serverLog.slice(-chars);
  const readOpenclawJson = () => JSON.parse(fs.readFileSync(openclawConfigPath, "utf8"));

  beforeAll(async () => {
    if (!cliUsable) return;
    rootDir = mkTemp("alphaclaw-live-control-ui-hostnames-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const workspaceDir = path.join(rootDir, "workspace");
    openclawConfigPath = path.join(openclawDir, "openclaw.json");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    port = await findFreePort();
    const gatewayPort = await findFreePort();

    const onboard = spawnSync(
      process.execPath,
      [
        repoOpenclawBin(),
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--flow",
        "quickstart",
        "--gateway-bind",
        "loopback",
        "--gateway-port",
        String(gatewayPort),
        "--gateway-auth",
        "token",
        "--gateway-token",
        `live-hostnames-${Date.now().toString(36)}-token`,
        "--no-install-daemon",
        "--skip-health",
        "--workspace",
        workspaceDir,
        "--auth-choice",
        "skip",
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...scrubTestRunnerEnv(),
          HOME: rootDir,
          OPENCLAW_HOME: rootDir,
          OPENCLAW_CONFIG_PATH: openclawConfigPath,
          OPENCLAW_STATE_DIR: openclawDir,
          XDG_CONFIG_HOME: openclawDir,
          OPENCLAW_NO_AUTO_UPDATE: "1",
        },
      },
    );
    if (onboard.status !== 0) {
      throw new Error(
        `openclaw onboard failed (${onboard.status}): ${String(onboard.stderr || onboard.stdout || "").slice(-500)}`,
      );
    }

    // A chat turn needs a model: point the default agent at the mock.
    mockModel = await startMockModel();
    const cfg = readOpenclawJson();
    cfg.models = {
      ...(cfg.models || {}),
      providers: {
        ...(cfg.models?.providers || {}),
        mock: {
          baseUrl: `http://127.0.0.1:${mockModel.port}/v1`,
          apiKey: "mock-key",
          api: "openai-completions",
          models: [
            {
              id: "echo",
              name: "Echo",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
              compat: { supportsTools: false },
            },
          ],
        },
      },
    };
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = { ...(cfg.agents.defaults || {}), model: { primary: "mock/echo" } };
    fs.writeFileSync(openclawConfigPath, JSON.stringify(cfg, null, 2));
    fs.writeFileSync(
      path.join(rootDir, "onboarded.json"),
      JSON.stringify({ onboarded: true, reason: "live_e2e", markedAt: new Date().toISOString() }),
    );

    serverChild = spawn(process.execPath, [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"], {
      env: {
        ...scrubTestRunnerEnv(),
        ALPHACLAW_ROOT_DIR: rootDir,
        SETUP_PASSWORD: kSetupPassword,
        PORT: String(port),
        // The ONE origin boot pins into gateway.controlUi.allowedOrigins.
        ALPHACLAW_SETUP_URL: `http://127.0.0.1:${port}`,
        PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverChild.stdout.on("data", (d) => {
      serverLog += String(d);
    });
    serverChild.stderr.on("data", (d) => {
      serverLog += String(d);
    });
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.status !== 200) return false;
          const body = await res.json();
          return body?.gateway === "running" || body?.gateway === "up";
        } catch {
          return false;
        }
      },
      kBootTimeoutMs,
      `alphaclaw + real gateway healthy on :${port} (log tail: ${logTail(400)})`,
    );
    edge = await startEdge(port);

    const { chromium } = require("playwright");
    const executablePath = resolveChromeExecutable();
    try {
      browser = await chromium.launch({
        executablePath,
        args: [
          "--no-sandbox",
          `--host-resolver-rules=MAP ${kSecondHost} 127.0.0.1, MAP ${kEdgeHost} 127.0.0.1`,
        ],
      });
    } catch (error) {
      const detail = String(error?.message || error).split("\n")[0];
      if (process.env.CI) {
        throw new Error(`[live] no Chromium could be launched in CI: ${detail}`);
      }
      browserSkipReason = detail;
      // eslint-disable-next-line no-console
      console.warn(`[live] no Chromium could be launched: ${detail} — control-ui-hostnames browser steps SKIPPED`);
    }
  }, kBootTimeoutMs + 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    try {
      edge?.proxy.close();
      edge?.server.close();
    } catch {}
    try {
      mockModel?.server.close();
    } catch {}
    if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            serverChild.kill("SIGKILL");
          } catch {}
          resolve();
        }, 15_000);
        serverChild.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        serverChild.kill("SIGTERM");
      });
    }
  }, 90_000);

  // One browser journey on one hostname: login page → launcher → hello-ok →
  // a chat turn round-trips through the real gateway to the mock model.
  const connectAndChat = async (ctx, base) => {
    if (!browser) {
      ctx.skip(`browser unavailable: ${browserSkipReason || "not launched"}`);
      return;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const frames = [];
      page.on("websocket", (ws) => {
        ws.on("framereceived", ({ payload }) => {
          frames.push(typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8"));
        });
      });
      await page.goto(`${base}/login.html`, { waitUntil: "load" });
      const loginStatus = await page.evaluate(
        async (password) =>
          (
            await fetch("/api/auth/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ password }),
            })
          ).status,
        kSetupPassword,
      );
      expect(loginStatus).toBe(200);

      await page.goto(`${base}/gateway/launch`, { waitUntil: "load" });
      const evidence = () =>
        `frames: ${JSON.stringify(frames.filter((f) => f.includes('"ok":false')).slice(0, 3))}\nlog tail: ${logTail()}`;
      await waitFor(
        () => frames.some((f) => f.includes("hello-ok") || f.includes(kOriginRejectedCode)),
        60_000,
        `a connect answer on ${base}`,
      );
      expect(frames.filter((f) => f.includes(kOriginRejectedCode)), evidence()).toEqual([]);
      expect(frames.some((f) => f.includes("hello-ok")), evidence()).toBe(true);

      await page.goto(`${base}/openclaw/chat`, { waitUntil: "load" });
      const nonce = `ping-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      const composer = page.getByPlaceholder(/^Message /).first();
      await composer.waitFor({ state: "visible", timeout: 60_000 });
      await composer.fill(`Reply to ${nonce}`);
      await composer.press("Enter");
      await page.waitForFunction((text) => document.body.innerText.includes(text), `pong ${nonce}`, {
        timeout: 90_000,
      });
    } finally {
      await context.close().catch(() => {});
    }
  };

  itLive(
    "boot pinned exactly one origin (so the hostnames below are NOT allowlisted)",
    () => {
      const allowed = readOpenclawJson()?.gateway?.controlUi?.allowedOrigins || [];
      expect(allowed).toContain(`http://127.0.0.1:${port}`);
      expect(allowed.some((origin) => origin.includes(kSecondHost) || origin.includes(kEdgeHost))).toBe(false);
    },
    kTestTimeoutMs,
  );

  itLive(
    "a second hostname (custom domain / VPS address) connects and completes a chat turn",
    (ctx) => connectAndChat(ctx, `http://${kSecondHost}:${port}`),
    kTestTimeoutMs,
  );

  itLive(
    "behind an ingress that rewrites Host (X-Forwarded-Host carries the public host) it connects and chats",
    (ctx) => connectAndChat(ctx, `http://${kEdgeHost}:${edge.port}`),
    kTestTimeoutMs,
  );
});
