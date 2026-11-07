const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { buildSetupUiCsp } = require("../../lib/server/setup-ui-headers");
const { kLoginGlobalMaxAttempts } = require("../../lib/server/constants");

// ALPH-71 PR 3 (web hardening) against the real lib/server.js, so the
// production mount order is what is tested: the Setup UI CSP on every Setup
// UI page and nowhere else, the origin check on cookie writes, the terminal
// and chat upgrades and the OAuth start, the WebSocket catch-all allowlist,
// and the login throttle's box-wide lockout.

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

describe("Setup UI CSP under path encodings (real server)", () => {
  const kPublicDir = path.join(kRepoRoot, "lib", "public");
  const listHtml = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listHtml(full);
      return entry.name.endsWith(".html") ? [full] : [];
    });
  const kStaticPages = listHtml(kPublicDir).map(
    (file) => `/${path.relative(kPublicDir, file).split(path.sep).join("/")}`,
  );
  const kEntryPages = ["/", "/setup", ...kStaticPages];
  const hex = (char, upper) => {
    const code = char.charCodeAt(0).toString(16);
    return `%${upper ? code.toUpperCase() : code}`;
  };
  const encodeLetters = (urlPath, { all = false, upper = false } = {}) => {
    let done = false;
    return urlPath.replace(/[a-z]/gi, (char) => {
      if (done && !all) return char;
      done = true;
      return hex(char, upper);
    });
  };
  const mixCase = (urlPath) =>
    urlPath.replace(/[a-z]/gi, (char, index) => (index % 2 ? char.toUpperCase() : char.toLowerCase()));
  const variantsOf = (urlPath) => {
    const variants = [
      urlPath,
      encodeLetters(urlPath),
      encodeLetters(urlPath, { upper: true }),
      encodeLetters(urlPath, { all: true }),
      `/${urlPath}`,
      `//${urlPath}`,
      `/${encodeLetters(urlPath)}`,
      mixCase(urlPath),
      mixCase(encodeLetters(urlPath, { upper: true })),
      `${urlPath}/`,
      `/%2e${urlPath}`,
      `/%2E${urlPath}`,
      `/js/%2e%2e${urlPath}`,
      `/js/%2E%2E${urlPath}`,
      `/js%2f..${urlPath}`,
    ];
    if (urlPath.includes(".")) {
      const dot = urlPath.lastIndexOf(".");
      variants.push(`${urlPath.slice(0, dot)}%2e${urlPath.slice(dot + 1)}`);
      variants.push(`/${urlPath.slice(0, dot)}%2E${urlPath.slice(dot + 1)}`);
    }
    return [...new Set(variants)];
  };
  const rawGet = (urlPath) =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers: { cookie } });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on("error", (error) => resolve({ status: 0, error: error.code, headers: {} }));
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ status: -1, headers: {} });
      });
      req.end();
    });

  it("finds the static entry pages it walks", () => {
    expect(kStaticPages).toEqual(expect.arrayContaining(["/login.html", "/setup.html"]));
  });

  it("serves every entry page with the CSP and frame denial under every encoding", async () => {
    const served = [];
    const missing = [];
    for (const page of kEntryPages) {
      for (const variant of variantsOf(page)) {
        const res = await rawGet(variant);
        if (res.status !== 200 || !/text\/html/.test(String(res.headers["content-type"] || ""))) continue;
        served.push(variant);
        if (
          res.headers["content-security-policy"] !== buildSetupUiCsp({ host }) ||
          res.headers["x-frame-options"] !== "DENY"
        ) {
          missing.push(variant);
        }
      }
    }
    expect(missing).toEqual([]);
    for (const page of kStaticPages) {
      expect(served, page).toEqual(
        expect.arrayContaining([encodeLetters(page), `/${page}`, `/js/%2e%2e${page}`]),
      );
    }
  }, 30000);
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
  it("locks the whole box once parallel guesses from rotating clients fill the global bucket", async () => {
    const extra = 6;
    const results = await Promise.all(
      Array.from({ length: kLoginGlobalMaxAttempts + extra }, (_, i) =>
        call("POST", "/api/auth/login", {
          headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
          body: { password: "wrong" },
        }),
      ),
    );
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 401).length).toBe(kLoginGlobalMaxAttempts - 1);
    expect(statuses.filter((status) => status === 429).length).toBe(extra + 1);
    const fresh = await call("POST", "/api/auth/login", {
      headers: { "x-forwarded-for": "198.51.100.9" },
      body: { password: kPassword },
    });
    expect(fresh.status).toBe(429);
    expect(Number(fresh.headers.get("retry-after"))).toBeGreaterThan(0);
  }, 30000);
});
