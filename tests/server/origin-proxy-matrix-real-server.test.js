const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");

// GST-1796: the browser-origin rule compares scheme and port, and must still
// accept the box's own dashboard behind every common proxy shape. This drives
// the real lib/server.js behind real nginx and Caddy processes and a
// Cloudflare Flexible SSL edge (https at the edge, plain http to the origin,
// X-Forwarded-Proto and CF-Visitor set the way Cloudflare sets them). Every
// case sends a cookie-authenticated POST /api/watchdog/events, which answers
// 405 when the origin check lets it through and 403 origin_mismatch when it
// refuses. nginx and Caddy cases skip with a notice when the binary is not
// installed (ALPHACLAW_TEST_NGINX / ALPHACLAW_TEST_CADDY point at one).

const kRepoRoot = path.resolve(__dirname, "..", "..");
const kServerPath = path.join(kRepoRoot, "lib", "server.js");
const kPassword = "origin-matrix-pass";
const kBoxHost = "box.example";

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

const findBinary = (envKey, name, fallbacks) => {
  const candidates = [process.env[envKey], ...fallbacks].filter(Boolean);
  const which = spawnSync("which", [name], { encoding: "utf8" });
  if (which.status === 0) candidates.push(which.stdout.trim());
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
};

const kNginx = findBinary("ALPHACLAW_TEST_NGINX", "nginx", ["/usr/sbin/nginx"]);
const kCaddy = findBinary("ALPHACLAW_TEST_CADDY", "caddy", []);
const kOpenssl = findBinary("ALPHACLAW_TEST_OPENSSL", "openssl", ["/usr/bin/openssl"]);
if (!kNginx) console.warn("[origin-proxy-matrix] nginx not installed: nginx cases skipped");
if (!kCaddy) console.warn("[origin-proxy-matrix] caddy not installed: Caddy cases skipped");
if (!kOpenssl) console.warn("[origin-proxy-matrix] openssl not installed: TLS cases skipped");

let tmpDir = "";
let appPort = 0;
let signIn = "";
let tlsKey = "";
let tlsCert = "";
const processes = [];
const servers = [];

const startProcess = (label, command, args, options = {}) => {
  const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  proc.output = "";
  proc.stdout.on("data", (data) => {
    proc.output += data;
  });
  proc.stderr.on("data", (data) => {
    proc.output += data;
  });
  proc.label = label;
  processes.push(proc);
  return proc;
};

const waitForPort = async (port, proc) => {
  for (let i = 0; i < 200; i += 1) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    if (proc && proc.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`${proc ? proc.label : "listener"} never listened on ${port}. Output:\n${proc ? proc.output : ""}`);
};

const send = ({ port, tls, host, origin }) =>
  new Promise((resolve, reject) => {
    const body = "{}";
    const req = (tls ? https : http).request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/watchdog/events",
        servername: tls ? kBoxHost : undefined,
        rejectUnauthorized: false,
        headers: {
          host,
          origin,
          cookie: signIn,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, text, server: res.headers.server || "" }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout via port ${port}`)));
    req.end(body);
  });

const expectOrigins = async ({ target, host, own, refused, via }) => {
  const accepted = await send({ ...target, host, origin: own });
  expect(accepted.status, `${own} must pass`).toBe(405);
  if (via) expect(accepted.server, "the request went through the proxy").toMatch(via);
  for (const origin of refused) {
    const res = await send({ ...target, host, origin });
    expect(res.status, `${origin} must be refused`).toBe(403);
    expect(res.text).toContain("origin_mismatch");
  }
};

const downgradesOf = (port) => [
  ...(port ? [`http://${kBoxHost}:${port}`] : []),
  `http://${kBoxHost}`,
  `http://${kBoxHost}:443`,
  `https://${kBoxHost}:80`,
];

const startCloudflareFlexibleEdge = async (innerPort) => {
  const port = await acquirePort();
  const edge = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: innerPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          "x-forwarded-proto": "https",
          "cf-visitor": '{"scheme":"https"}',
          "cf-connecting-ip": "10.20.30.40",
          "x-forwarded-for": "10.20.30.40",
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => edge.listen(port, "127.0.0.1", resolve));
  servers.push(edge);
  return port;
};

const startCaddy = async ({ trusted }) => {
  const dir = fs.mkdtempSync(path.join(tmpDir, trusted ? "caddy-trusted-" : "caddy-"));
  const httpPort = await acquirePort();
  const httpsPort = await acquirePort();
  const caddyfile = [
    "{",
    "  admin off",
    "  skip_install_trust",
    "  auto_https disable_redirects",
    `  http_port ${httpPort}`,
    `  https_port ${httpsPort}`,
    `  storage file_system ${path.join(dir, "data")}`,
    ...(trusted ? ["  servers {", "    trusted_proxies static 127.0.0.1/32", "  }"] : []),
    "}",
    `https://${kBoxHost} {`,
    "  tls internal",
    `  reverse_proxy 127.0.0.1:${appPort}`,
    "}",
    `http://${kBoxHost} {`,
    `  reverse_proxy 127.0.0.1:${appPort}`,
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "Caddyfile"), caddyfile);
  const proc = startProcess(trusted ? "caddy (trusted_proxies)" : "caddy", kCaddy, ["run", "--config", path.join(dir, "Caddyfile"), "--adapter", "caddyfile"], {
    env: { ...process.env, HOME: dir, XDG_DATA_HOME: path.join(dir, "xdg-data"), XDG_CONFIG_HOME: path.join(dir, "xdg-config") },
  });
  await waitForPort(httpPort, proc);
  await waitForPort(httpsPort, proc);
  for (let i = 0; i < 100; i += 1) {
    try {
      await send({ port: httpsPort, tls: true, host: kBoxHost, origin: `https://${kBoxHost}` });
      break;
    } catch {
      await sleep(100);
    }
  }
  return { httpPort, httpsPort };
};

const startNginx = async () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "nginx-"));
  fs.mkdirSync(path.join(dir, "temp"));
  const [httpPort, httpsPort, httpsHostPortPort] = [await acquirePort(), await acquirePort(), await acquirePort()];
  const location = (hostHeader) => [
    "    location / {",
    `      proxy_pass http://127.0.0.1:${appPort};`,
    `      proxy_set_header Host ${hostHeader};`,
    "      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "      proxy_set_header X-Forwarded-Proto $scheme;",
    "    }",
  ];
  const tls = [`    ssl_certificate ${path.join(tmpDir, "cert.pem")};`, `    ssl_certificate_key ${path.join(tmpDir, "key.pem")};`];
  const conf = [
    "daemon off;",
    "master_process off;",
    `pid ${path.join(dir, "nginx.pid")};`,
    "error_log stderr warn;",
    "events {}",
    "http {",
    "  access_log off;",
    ...["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].map(
      (kind) => `  ${kind}_temp_path ${path.join(dir, "temp", kind)};`,
    ),
    `  server {\n    listen 127.0.0.1:${httpPort};`,
    ...location("$host"),
    "  }",
    `  server {\n    listen 127.0.0.1:${httpsPort} ssl;`,
    ...tls,
    ...location("$host"),
    "  }",
    `  server {\n    listen 127.0.0.1:${httpsHostPortPort} ssl;`,
    ...tls,
    ...location("$http_host"),
    "  }",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "nginx.conf"), conf);
  const proc = startProcess("nginx", kNginx, ["-p", `${dir}/`, "-c", path.join(dir, "nginx.conf"), "-e", "stderr"]);
  for (const port of [httpPort, httpsPort, httpsHostPortPort]) await waitForPort(port, proc);
  return { httpPort, httpsPort, httpsHostPortPort };
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-origin-matrix-"));
  const rootDir = path.join(tmpDir, "root");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({ gateway: { port: await acquirePort() } }));
  appPort = await acquirePort();
  const app = startProcess("alphaclaw", process.execPath, ["-e", `require(${JSON.stringify(kServerPath)})`], {
    env: { ...process.env, SETUP_PASSWORD: kPassword, PORT: String(appPort), ALPHACLAW_ROOT_DIR: rootDir },
  });
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`http://127.0.0.1:${appPort}/health`)).status === 200;
    } catch {}
    if (!healthy) await sleep(100);
  }
  if (!healthy) throw new Error(`server never became healthy. Output:\n${app.output}`);
  const login = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: kPassword }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}. Output:\n${app.output}`);
  signIn = String(login.headers.get("set-cookie") || "").split(";")[0];
  if (kOpenssl) {
    const made = spawnSync(
      kOpenssl,
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", path.join(tmpDir, "key.pem"), "-out", path.join(tmpDir, "cert.pem"),
        "-subj", `/CN=${kBoxHost}`, "-addext", `subjectAltName=DNS:${kBoxHost}`,
      ],
      { encoding: "utf8" },
    );
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
    tlsKey = fs.readFileSync(path.join(tmpDir, "key.pem"));
    tlsCert = fs.readFileSync(path.join(tmpDir, "cert.pem"));
  }
}, 40000);

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  for (const proc of processes) {
    if (proc.exitCode !== null) continue;
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => proc.once("exit", () => resolve(true))),
      sleep(10000).then(() => false),
    ]);
    if (!exited) proc.kill("SIGKILL");
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("browser origin behind a direct connection (real server)", () => {
  it("accepts the box's own http origin and refuses origins on another port or scheme default", async () => {
    const target = { port: appPort, tls: false };
    await expectOrigins({
      target,
      host: `127.0.0.1:${appPort}`,
      own: `http://127.0.0.1:${appPort}`,
      refused: [`http://127.0.0.1:${appPort + 1}`, "http://127.0.0.1", "http://127.0.0.1:443"],
    });
    await expectOrigins({
      target,
      host: kBoxHost,
      own: `http://${kBoxHost}`,
      refused: [`https://${kBoxHost}:80`, `http://${kBoxHost}:443`],
    });
  });
});

describe.skipIf(!kOpenssl)("browser origin behind Cloudflare Flexible SSL (real server)", () => {
  it("accepts https://box.example and refuses the http downgrades when Cloudflare talks to AlphaClaw directly", async () => {
    const port = await startCloudflareFlexibleEdge(appPort);
    await expectOrigins({ target: { port, tls: true }, host: kBoxHost, own: `https://${kBoxHost}`, refused: downgradesOf() });
  });
});

describe.skipIf(!kNginx || !kOpenssl)("browser origin behind nginx with X-Forwarded-Proto $scheme (real server)", () => {
  let nginx;
  beforeAll(async () => {
    nginx = await startNginx();
  }, 30000);

  it("accepts the https dashboard on the default port and refuses the downgrades", async () => {
    await expectOrigins({
      target: { port: nginx.httpsPort, tls: true },
      host: kBoxHost,
      own: `https://${kBoxHost}`,
      refused: downgradesOf(),
      via: /nginx/,
    });
  });

  it("accepts the https dashboard on a custom port when nginx forwards $http_host", async () => {
    const custom = 8443;
    await expectOrigins({
      target: { port: nginx.httpsHostPortPort, tls: true },
      host: `${kBoxHost}:${custom}`,
      own: `https://${kBoxHost}:${custom}`,
      refused: downgradesOf(custom),
      via: /nginx/,
    });
  });

  it("accepts a plain-http dashboard and refuses origins whose port fits the other scheme", async () => {
    await expectOrigins({
      target: { port: nginx.httpPort, tls: false },
      host: kBoxHost,
      own: `http://${kBoxHost}`,
      refused: [`https://${kBoxHost}:80`, `http://${kBoxHost}:443`],
      via: /nginx/,
    });
  });

  it("accepts https://box.example behind Cloudflare Flexible SSL in front of nginx, whose X-Forwarded-Proto says http", async () => {
    const port = await startCloudflareFlexibleEdge(nginx.httpPort);
    await expectOrigins({ target: { port, tls: true }, host: kBoxHost, own: `https://${kBoxHost}`, refused: downgradesOf() });
  });
});

for (const trusted of [false, true]) {
  const label = trusted ? "Caddy with trusted_proxies" : "Caddy without trusted_proxies";
  describe.skipIf(!kCaddy || !kOpenssl)(`browser origin behind ${label} (real server)`, () => {
    let caddy;
    beforeAll(async () => {
      caddy = await startCaddy({ trusted });
    }, 30000);

    it("accepts the https dashboard on the default port and on a custom port, and refuses the downgrades", async () => {
      const target = { port: caddy.httpsPort, tls: true };
      await expectOrigins({ target, host: kBoxHost, own: `https://${kBoxHost}`, refused: downgradesOf(), via: /Caddy/ });
      await expectOrigins({
        target,
        host: `${kBoxHost}:8443`,
        own: `https://${kBoxHost}:8443`,
        refused: downgradesOf(8443),
        via: /Caddy/,
      });
    });

    it("accepts https://box.example behind Cloudflare Flexible SSL in front of Caddy's http site", async () => {
      const port = await startCloudflareFlexibleEdge(caddy.httpPort);
      await expectOrigins({ target: { port, tls: true }, host: kBoxHost, own: `https://${kBoxHost}`, refused: downgradesOf() });
    });
  });
}
