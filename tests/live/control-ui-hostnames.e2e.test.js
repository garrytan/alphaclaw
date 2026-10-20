const httpProxy = require("http-proxy-3");
const http = require("http");

const { kLiveEnabled, openclawCliUsable, waitFor } = require("./live-helpers");
const {
  kBootTimeoutMs,
  listen,
  startControlUiInstall,
  launchChromium,
  loginInPage,
  chatRoundTrip,
} = require("./control-ui-live");

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

const kTestTimeoutMs = 4 * 60 * 1000;
const kSetupPassword = "live-control-ui-hostnames-pass";
const kSecondHost = "claw.example.test";
const kEdgeHost = "edge.example.test";
const kOriginRejectedCode = "CONTROL_UI_ORIGIN_NOT_ALLOWED";

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

  let install;
  let edge;
  let browser = null;
  let browserSkipReason = null;

  beforeAll(async () => {
    if (!cliUsable) return;
    install = await startControlUiInstall({
      label: "control-ui-hostnames",
      setupPassword: kSetupPassword,
      gatewayToken: `live-hostnames-${Date.now().toString(36)}-token`,
      // The ONE origin boot pins into gateway.controlUi.allowedOrigins.
      extraEnv: (port) => ({ ALPHACLAW_SETUP_URL: `http://127.0.0.1:${port}` }),
    });
    edge = await startEdge(install.port);
    ({ browser = null, skipReason: browserSkipReason = null } = await launchChromium({
      label: "control-ui-hostnames",
      args: [`--host-resolver-rules=MAP ${kSecondHost} 127.0.0.1, MAP ${kEdgeHost} 127.0.0.1`],
    }));
  }, kBootTimeoutMs + 120_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } catch {}
    try {
      edge?.proxy.close();
      edge?.server.close();
    } catch {}
    await install?.stop();
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
      expect(await loginInPage(page, base, kSetupPassword)).toBe(200);

      await page.goto(`${base}/gateway/launch`, { waitUntil: "load" });
      const evidence = () =>
        `frames: ${JSON.stringify(frames.filter((f) => f.includes('"ok":false')).slice(0, 3))}\nlog tail: ${install.logTail()}`;
      await waitFor(
        () => frames.some((f) => f.includes("hello-ok") || f.includes(kOriginRejectedCode)),
        60_000,
        `a connect answer on ${base}`,
      );
      expect(frames.filter((f) => f.includes(kOriginRejectedCode)), evidence()).toEqual([]);
      expect(frames.some((f) => f.includes("hello-ok")), evidence()).toBe(true);

      await page.goto(`${base}/openclaw/chat`, { waitUntil: "load" });
      await chatRoundTrip(page);
    } finally {
      await context.close().catch(() => {});
    }
  };

  itLive(
    "boot pinned exactly one origin (so the hostnames below are NOT allowlisted)",
    () => {
      const allowed = install.readOpenclawJson()?.gateway?.controlUi?.allowedOrigins || [];
      expect(allowed).toContain(`http://127.0.0.1:${install.port}`);
      expect(allowed.some((origin) => origin.includes(kSecondHost) || origin.includes(kEdgeHost))).toBe(false);
    },
    kTestTimeoutMs,
  );

  itLive(
    "a second hostname (custom domain / VPS address) connects and completes a chat turn",
    (ctx) => connectAndChat(ctx, `http://${kSecondHost}:${install.port}`),
    kTestTimeoutMs,
  );

  itLive(
    "behind an ingress that rewrites Host (X-Forwarded-Host carries the public host) it connects and chats",
    (ctx) => connectAndChat(ctx, `http://${kEdgeHost}:${edge.port}`),
    kTestTimeoutMs,
  );
});
