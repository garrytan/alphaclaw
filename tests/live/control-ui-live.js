const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const {
  mkTemp,
  repoOpenclawBin,
  repoBinDir,
  scrubTestRunnerEnv,
  waitFor,
} = require("./live-helpers");

// Shared by the Control UI live tests: a real onboarded install (AlphaClaw +
// the pinned gateway) whose default agent talks to a mock OpenAI-compatible
// model, and a real Chromium.

const kBootTimeoutMs = 4 * 60 * 1000;

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

// Streams "pong <nonce>" back for the last "ping-xxxxxx" token in the request.
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

const startControlUiInstall = async ({ label, setupPassword, gatewayToken, extraEnv = {} }) => {
  const rootDir = mkTemp(`alphaclaw-live-${label}-`);
  const openclawDir = path.join(rootDir, ".openclaw");
  const workspaceDir = path.join(rootDir, "workspace");
  const openclawConfigPath = path.join(openclawDir, "openclaw.json");
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const port = await findFreePort();
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
      gatewayToken,
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

  const mockModel = await startMockModel();
  const readOpenclawJson = () => JSON.parse(fs.readFileSync(openclawConfigPath, "utf8"));
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

  let serverLog = "";
  const serverChild = spawn(process.execPath, [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"], {
    env: {
      ...scrubTestRunnerEnv(),
      ALPHACLAW_ROOT_DIR: rootDir,
      SETUP_PASSWORD: setupPassword,
      PORT: String(port),
      PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH || ""}`,
      ...extraEnv(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild.stdout.on("data", (d) => {
    serverLog += String(d);
  });
  serverChild.stderr.on("data", (d) => {
    serverLog += String(d);
  });
  const logTail = (chars = 1500) => serverLog.slice(-chars);
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

  const stop = async () => {
    try {
      mockModel.server.close();
    } catch {}
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) return;
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
  };

  return { port, rootDir, readOpenclawJson, logTail, getServerLog: () => serverLog, stop };
};

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

// Returns { browser } or { skipReason }; in CI a missing Chromium is a failure.
const launchChromium = async ({ args = [], label }) => {
  const { chromium } = require("playwright");
  try {
    return {
      browser: await chromium.launch({
        executablePath: resolveChromeExecutable(),
        args: ["--no-sandbox", ...args],
      }),
    };
  } catch (error) {
    const detail = String(error?.message || error).split("\n")[0];
    if (process.env.CI) {
      throw new Error(`[live] no Chromium could be launched in CI: ${detail}`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[live] no Chromium could be launched: ${detail} — ${label} browser steps SKIPPED`);
    return { skipReason: detail };
  }
};

const loginInPage = async (page, base, password) => {
  await page.goto(`${base}/login.html`, { waitUntil: "load" });
  return page.evaluate(
    async (pw) =>
      (
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: pw }),
        })
      ).status,
    password,
  );
};

// Sends a nonce through the open chat view and waits for the mock's reply.
const chatRoundTrip = async (page) => {
  const nonce = `ping-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
  const composer = page.getByPlaceholder(/^Message /).first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  await composer.fill(`Reply to ${nonce}`);
  await composer.press("Enter");
  await page.waitForFunction((text) => document.body.innerText.includes(text), `pong ${nonce}`, {
    timeout: 90_000,
  });
};

module.exports = {
  kBootTimeoutMs,
  listen,
  startControlUiInstall,
  launchChromium,
  loginInPage,
  chatRoundTrip,
};
