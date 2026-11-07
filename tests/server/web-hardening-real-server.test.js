const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { buildSetupUiCsp } = require("../../lib/server/setup-ui-headers");
const { kLoginGlobalMaxAttempts, kLoginGlobalSoftDelayMs } = require("../../lib/server/constants");

// ALPH-71 PR 3 (web hardening) against the real lib/server.js, so the
// production mount order is what is tested: the Setup UI CSP on every Setup
// UI page and nowhere else, the origin check on cookie writes, the terminal
// and chat upgrades and the OAuth start, the WebSocket catch-all allowlist,
// and the login throttle's soft global delay.

const kRepoRoot = path.resolve(__dirname, "..", "..");
const kServerPath = path.join(kRepoRoot, "lib", "server.js");
const kPassword = "web-hardening-pass";
const kAgentToken = "7".repeat(64);
const kRequiredDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const acquirePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

let tmpDir = "";
let child = null;
let output = "";
let port = 0;
let base = "";
let host = "";
let cookie = "";

const call = async (method, url, { headers = {}, body } = {}) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
};

const wsUpgrade = (urlPath, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: urlPath,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    const done = (result) => {
      req.destroy();
      resolve(result);
    };
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      done({ status: 101 });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode, body }));
    });
    req.on("error", (error) => done({ status: 0, error: error.code }));
    req.setTimeout(8000, () => done({ status: -1 }));
    req.end();
  });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-web-hardening-"));
  const rootDir = path.join(tmpDir, "root");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
  const deadGatewayPort = await acquirePort();
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify({ gateway: { port: deadGatewayPort } }),
  );
  fs.writeFileSync(
    path.join(openclawDir, "alphaclaw.json"),
    JSON.stringify({ features: { agentAdmin: { enabled: true } } }),
  );
  fs.mkdirSync(path.join(openclawDir, ".alphaclaw"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(openclawDir, ".alphaclaw", "agent-admin-token"), `${kAgentToken}\n`, {
    mode: 0o600,
  });
  port = await acquirePort();
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
  child = spawn(process.execPath, ["-e", `require(${JSON.stringify(kServerPath)})`], {
    env: {
      ...process.env,
      SETUP_PASSWORD: kPassword,
      PORT: String(port),
      ALPHACLAW_ROOT_DIR: rootDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${base}/health`)).status === 200;
    } catch {}
    if (!healthy) await sleep(100);
  }
  if (!healthy) throw new Error(`server never became healthy. Output:\n${output}`);
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: kPassword }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}. Output:\n${output}`);
  cookie = String(res.headers.get("set-cookie") || "").split(";")[0];
}, 40000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(10000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Setup UI CSP (real server)", () => {
  const kPages = [
    ["/", true],
    ["/setup", true],
    ["/Setup/", true],
    ["/setup.html", false],
    ["/login.html", false],
    ["/login.html?next=%2F", false],
  ];

  for (const [url, withCookie] of kPages) {
    it(`serves ${url} with the Setup UI CSP and frame denial`, async () => {
      const res = await call("GET", url, { headers: withCookie ? { cookie } : {} });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const csp = res.headers.get("content-security-policy");
      expect(csp).toBe(buildSetupUiCsp({ host }));
      const directives = csp.split(";").map((part) => part.trim());
      for (const directive of kRequiredDirectives) expect(directives).toContain(directive);
      expect(csp).not.toContain("'unsafe-eval'");
      expect(directives.find((part) => part.startsWith("script-src"))).toBe("script-src 'self'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }

  it("redirects a signed-out / to login with the CSP already set", async () => {
    const res = await call("GET", "/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login.html");
    expect(res.headers.get("content-security-policy")).toBe(buildSetupUiCsp({ host }));
  });

  it("serves pages that run no inline script and carry no inline event handlers", async () => {
    for (const url of ["/login.html", "/setup.html"]) {
      const { text } = await call("GET", url);
      const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length, url).toBeGreaterThan(0);
      for (const [, attrs, body] of scripts) {
        expect(attrs, url).toMatch(/\bsrc="\.\/(js|dist)\//);
        expect(body.trim(), url).toBe("");
      }
      expect(text, url).not.toMatch(/\son[a-z]+\s*=/i);
      expect(text, url).not.toMatch(/javascript:/i);
    }
  });

  it("keeps the theme pre-paint a blocking classic script in <head>", async () => {
    for (const url of ["/login.html", "/setup.html"]) {
      const { text } = await call("GET", url);
      const head = text.slice(0, text.indexOf("</head>"));
      expect(head, url).toContain('<script src="./js/theme-prepaint.js"></script>');
    }
    const script = await call("GET", "/js/theme-prepaint.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
    expect(script.text).toContain('localStorage.getItem("alphaclaw.ui.theme")');
    expect(script.text).toContain("document.documentElement.dataset.theme = t;");
    expect(script.text).not.toMatch(/^\s*(import|export)\s/m);
    const login = await call("GET", "/js/login.js");
    expect(login.status).toBe(200);
    expect(login.text).toContain('fetch("/api/auth/status")');
  });

  it("leaves every other response alone: API JSON, assets, the Control UI proxy", async () => {
    for (const [url, headers] of [
      ["/api/auth/status", {}],
      ["/js/login.js", {}],
      ["/health", {}],
      ["/openclaw/", { cookie }],
      ["/openclaw/assets/app.js", { cookie }],
    ]) {
      const res = await call("GET", url, { headers });
      expect(res.headers.get("content-security-policy"), url).toBeNull();
      expect(res.headers.get("x-frame-options"), url).toBeNull();
    }
  });
});

describe("origin checks (real server)", () => {
  it("refuses a cross-origin cookie write with 403 origin_mismatch and lets the box's own through", async () => {
    const cross = await call("POST", "/api/watchdog/events", {
      headers: { cookie, origin: "https://evil.example" },
      body: {},
    });
    expect(cross.status).toBe(403);
    expect(cross.json).toEqual({ error: "Cross-origin request refused", code: "origin_mismatch" });
    expect(output).toMatch(/\[origin\] refused http POST \/api\/watchdog\/events code=origin_mismatch actor=human/);
    const same = await call("POST", "/api/watchdog/events", {
      headers: { cookie, origin: base },
      body: {},
    });
    expect(same.status).toBe(405);
    const none = await call("POST", "/api/watchdog/events", { headers: { cookie }, body: {} });
    expect(none.status).toBe(405);
  });

  it("exempts the agent bearer from the origin check", async () => {
    const res = await call("POST", "/api/watchdog/events", {
      headers: { authorization: `Bearer ${kAgentToken}`, origin: "https://evil.example" },
      body: {},
    });
    expect(res.status).toBe(405);
  });

  it("refuses a cross-origin chat or terminal upgrade and accepts the box's own", async () => {
    for (const urlPath of ["/api/ws/chat", "/api/watchdog/terminal/ws"]) {
      const cross = await wsUpgrade(urlPath, { cookie, origin: "https://evil.example" });
      expect(cross.status, urlPath).toBe(403);
      expect(cross.body, urlPath).toContain('"code":"origin_mismatch"');
    }
    const same = await wsUpgrade("/api/ws/chat", { cookie, origin: base });
    expect(same.status).toBe(101);
  });

  it("starts Codex OAuth only from a same-origin POST", async () => {
    const same = await call("POST", "/auth/codex/start", { headers: { cookie, origin: base }, body: {} });
    expect(same.status).toBe(200);
    expect(new URL(same.json.url).searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    const cross = await call("POST", "/auth/codex/start", {
      headers: { cookie, origin: "https://evil.example" },
      body: {},
    });
    expect(cross.status).toBe(403);
    expect(cross.json.code).toBe("origin_mismatch");
    const get = await call("GET", "/auth/codex/start", { headers: { cookie } });
    expect(get.status).toBe(404);
    expect(get.headers.get("location")).toBeNull();
  });
});

describe("WebSocket catch-all (real server)", () => {
  it("answers 404 for an upgrade outside the gateway's own paths and forwards the root", async () => {
    for (const urlPath of ["/random-ws", "/v1/responses", "/hooks/x"]) {
      const res = await wsUpgrade(urlPath);
      expect(res.status, urlPath).toBe(404);
    }
    const root = await wsUpgrade("/");
    expect(root.status).not.toBe(404);
  });
});

describe("login throttle (real server)", () => {
  it("slows sign-in once the global bucket is full instead of refusing it", async () => {
    for (let i = 0; i < kLoginGlobalMaxAttempts; i += 1) {
      const res = await call("POST", "/api/auth/login", {
        headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
        body: { password: "wrong" },
      });
      expect(res.status).toBe(401);
    }
    const startedAt = Date.now();
    const owner = await call("POST", "/api/auth/login", {
      headers: { "x-forwarded-for": "198.51.100.9" },
      body: { password: kPassword },
    });
    expect(owner.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(kLoginGlobalSoftDelayMs - 100);
  }, 30000);
});
