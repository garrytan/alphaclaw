const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");

const {
  kLiveEnabled,
  mkTemp,
  repoOpenclawBin,
  repoBinDir,
  waitFor,
} = require("./live-helpers");

// LIVE tier: prove the dashboard launcher's CREDENTIAL CHAIN end to end
// against a REAL AlphaClaw server supervising a REAL OpenClaw gateway:
//
//   login (setup password) ──► GET /gateway/launch?to=dashboards
//        └─► 302, empty body, Location: /openclaw/dashboards#token=<T>
//                └─► ws://<alphaclaw>/ connect handshake with T ──► hello-ok
//                    (and a WRONG token ──► rejected)
//
// This is the protocol-level twin of the browser click-through QA (which
// additionally proved the beta Control UI consumes the fragment and renders
// the dashboards page connected). It runs on the repo-PINNED OpenClaw line —
// the launcher chain is version-independent; only the sidebar entry point is
// version-gated. Excluded from `npm test`; run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/dashboard-launch.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kBootTimeoutMs = 4 * 60 * 1000;
const kTestTimeoutMs = 6 * 60 * 1000;
const kSetupPassword = "live-dashboard-launch-pass";
// Mirrors lib/server/chat-ws.js kGatewayProtocolVersion / bridge scopes — the
// same connect frame AlphaClaw's own gateway client sends.
const kGatewayProtocol = 4;
const kOperatorScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

// The pinned CLI enforces its Node engines at runtime (the vitest process may
// satisfy AlphaClaw's floor but not OpenClaw's). Preflight it so an
// incompatible runner skips loudly instead of failing on a boot timeout.
const openclawCliUsable = () => {
  try {
    const res = spawnSync(process.execPath, [repoOpenclawBin(), "--version"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

const httpGet = async (url, { cookie, redirect = "manual" } = {}) => {
  const res = await fetch(url, {
    redirect,
    headers: cookie ? { cookie } : {},
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.text(),
  };
};

// Challenge → connect → hello-ok, exactly like lib/server/chat-ws.js but
// through the ALPHACLAW proxy (the path a browser Control UI actually uses),
// not the gateway port directly.
const gatewayConnect = ({ wsUrl, token, timeoutMs = 30_000 }) =>
  new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const requestId = `live-launch-${Math.random().toString(36).slice(2)}`;
    const finish = (result) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "timeout waiting for connect result" }),
      timeoutMs,
    );
    ws.on("message", (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw || ""));
      } catch {
        return;
      }
      if (payload?.type === "event" && payload.event === "connect.challenge") {
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: "connect",
            params: {
              minProtocol: kGatewayProtocol,
              maxProtocol: kGatewayProtocol,
              client: {
                id: "gateway-client",
                version: "0.1.0",
                platform: process.platform,
                mode: "backend",
              },
              role: "operator",
              scopes: kOperatorScopes,
              caps: [],
              commands: [],
              permissions: {},
              auth: { token },
              locale: "en-US",
              userAgent: "alphaclaw-live-launch-test/0.1.0",
            },
          }),
        );
        return;
      }
      if (payload?.type === "res" && String(payload.id || "") === requestId) {
        if (payload.ok && payload?.payload?.type === "hello-ok") {
          finish({ ok: true, hello: payload.payload });
        } else {
          finish({
            ok: false,
            error:
              payload?.error?.message || payload?.error?.code || "connect rejected",
          });
        }
      }
    });
    ws.on("error", (err) => finish({ ok: false, error: String(err?.message || err) }));
    ws.on("close", () =>
      finish({ ok: false, error: "socket closed before connect result" }),
    );
  });

describeLive("live: dashboard launcher credential chain", () => {
  const cliUsable = openclawCliUsable();
  const itLive = cliUsable ? it : it.skip;
  if (kLiveEnabled && !cliUsable) {
    // eslint-disable-next-line no-console
    console.warn(
      "[live] pinned openclaw CLI cannot run on this Node " +
        `(${process.version}) — dashboard-launch live suite skipped. ` +
        "Run vitest with a Node satisfying openclaw's engines.",
    );
  }

  let rootDir;
  let port;
  let gatewayPort;
  let baseUrl;
  let serverChild;
  let gatewayToken;
  let serverLog = "";

  beforeAll(async () => {
    if (!cliUsable) return;
    rootDir = mkTemp("alphaclaw-live-launch-root-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const workspaceDir = path.join(rootDir, "workspace");
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    port = await findFreePort();
    // A UNIQUE gateway port per run: on the default 18789 a concurrently
    // running gateway (another checkout, an operator instance) wins the
    // healthy-incumbent step-aside race and this suite would silently
    // handshake with the WRONG gateway — observed as token_mismatch.
    gatewayPort = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    // Real onboarding, exactly the args AlphaClaw's onboarding service passes
    // (lib/server/onboarding/openclaw.js buildOnboardArgs), no provider auth.
    gatewayToken = `live-launch-${Date.now().toString(36)}-token`;
    const onboardEnv = {
      ...process.env,
      HOME: rootDir,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: openclawDir,
      XDG_CONFIG_HOME: openclawDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
    };
    delete onboardEnv.NODE_OPTIONS;
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
      { encoding: "utf8", env: onboardEnv, timeout: 120_000 },
    );
    if (onboard.status !== 0) {
      throw new Error(
        `openclaw onboard failed (${onboard.status}): ${String(
          onboard.stderr || onboard.stdout || "",
        ).slice(-500)}`,
      );
    }
    fs.writeFileSync(
      path.join(rootDir, "onboarded.json"),
      JSON.stringify(
        { onboarded: true, reason: "live_e2e", markedAt: new Date().toISOString() },
        null,
        2,
      ),
    );

    // Boot the REAL server: it supervises the real gateway as a child.
    const serverEnv = {
      ...process.env,
      ALPHACLAW_ROOT_DIR: rootDir,
      SETUP_PASSWORD: kSetupPassword,
      PORT: String(port),
      ALPHACLAW_SETUP_URL: baseUrl,
      PATH: `${repoBinDir()}${path.delimiter}${process.env.PATH || ""}`,
    };
    delete serverEnv.NODE_OPTIONS;
    serverChild = spawn(
      process.execPath,
      [path.resolve(__dirname, "../../bin/alphaclaw.js"), "start"],
      { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    serverChild.stdout.on("data", (d) => {
      serverLog += String(d);
    });
    serverChild.stderr.on("data", (d) => {
      serverLog += String(d);
    });

    await waitFor(
      async () => {
        try {
          const res = await fetch(`${baseUrl}/health`);
          if (res.status !== 200) return false;
          const body = await res.json();
          return body?.gateway === "running" || body?.gateway === "up";
        } catch {
          return false;
        }
      },
      kBootTimeoutMs,
      `alphaclaw + real gateway healthy on :${port} (log tail: ${serverLog.slice(-300)})`,
    );
  }, kBootTimeoutMs + 60_000);

  afterAll(async () => {
    if (serverChild && !serverChild.killed) {
      serverChild.kill("SIGTERM");
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            serverChild.kill("SIGKILL");
          } catch {}
          resolve();
        }, 15_000);
        serverChild.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }, 60_000);

  const login = async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: kSetupPassword }),
    });
    expect(res.status).toBe(200);
    const cookie = String(res.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toMatch(/^setup_token=/);
    return cookie;
  };

  itLive(
    "302s an authenticated launch to the tokened dashboards URL with an empty body",
    async () => {
      const cookie = await login();
      const res = await httpGet(`${baseUrl}/gateway/launch?to=dashboards`, {
        cookie,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.body).toBe("");
      const location = String(res.headers.get("location") || "");
      expect(location).toBe(
        `/openclaw/dashboards#token=${encodeURIComponent(gatewayToken)}`,
      );
    },
    kTestTimeoutMs,
  );

  itLive(
    "the launcher-issued token authenticates a real gateway connect THROUGH the proxy",
    async () => {
      const cookie = await login();
      const res = await httpGet(`${baseUrl}/gateway/launch?to=dashboards`, {
        cookie,
      });
      const fragment = String(res.headers.get("location") || "").split("#token=")[1];
      const token = decodeURIComponent(fragment || "");
      expect(token).toBe(gatewayToken);

      // The Control UI's actual WS path: the ALPHACLAW origin, root path,
      // proxied by the catch-all upgrade to the loopback gateway.
      const result = await gatewayConnect({
        wsUrl: `ws://127.0.0.1:${port}/`,
        token,
      });
      expect(result.ok, `connect failed: ${result.error || ""}`).toBe(true);
      expect(result.hello?.type).toBe("hello-ok");
    },
    kTestTimeoutMs,
  );

  itLive(
    "a wrong token is rejected by the gateway through the same proxied path",
    async () => {
      const result = await gatewayConnect({
        wsUrl: `ws://127.0.0.1:${port}/`,
        token: "definitely-not-the-gateway-token",
      });
      expect(result.ok).toBe(false);
    },
    kTestTimeoutMs,
  );

  itLive(
    "an unauthenticated launch never reaches the tokened redirect",
    async () => {
      const res = await httpGet(`${baseUrl}/gateway/launch?to=dashboards`);
      expect(res.status).toBe(302);
      expect(String(res.headers.get("location") || "")).toContain("/login.html");
      expect(String(res.headers.get("location") || "")).not.toContain("token=");
    },
    kTestTimeoutMs,
  );

  itLive(
    "the proxied Control UI shell serves on the dashboards sub-path",
    async () => {
      const cookie = await login();
      const res = await httpGet(`${baseUrl}/openclaw/dashboards`, {
        cookie,
        redirect: "follow",
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<html");
    },
    kTestTimeoutMs,
  );
});
