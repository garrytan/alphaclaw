// Real-process e2e for the gateway proxy path (http-proxy-3 swap).
//
// Spawns the REAL lib/server.js (the proven harness boot contract: node -e
// require(server.js) with SETUP_PASSWORD/PORT/ALPHACLAW_ROOT_DIR) against a
// REAL in-test fake gateway whose port is declared via
// <ALPHACLAW_ROOT_DIR>/.openclaw/openclaw.json before boot. This executes the
// production proxy wiring that the routes-proxy.test.js replica cannot:
// server.js's parser-skip middleware ordering, the real createProxyServer
// (ws:true, env-read proxyTimeout), the proxyReq timeout/response hooks
// (__gatewayTimedOut marker + post-header idle relaxation), and the
// crash-proof error handler running inside a real process.
//
// ALPHACLAW_PROXY_TIMEOUT_MS=800 exists exactly so this suite can prove the
// hung-gateway 504 path without waiting out the 30s default.
//
// The fake gateway also speaks the Control UI contract (control-ui-mount.js):
// it answers /openclaw/{,assets,fonts,themes,sw.js,__openclaw,avatar,
// dashboards} the way a gateway with gateway.controlUi.basePath=/openclaw
// does, so the suite can prove AlphaClaw forwards those paths VERBATIM and
// passes status, content-type, content-encoding and CSP through untouched.
// The harness never onboards, so ensureGatewayProxyConfig short-circuits —
// these cases prove transport and routing selection, not the config
// migration (gateway.test.js, control-ui-mount.test.js and the live tier do).

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const kRepoRoot = path.resolve(__dirname, "..", "..");
const kServerPath = path.join(kRepoRoot, "lib", "server.js");
const kPassword = "e2e-proxy-pass";
const kProxyTimeoutMs = 800;

// Streamed-cap leg: kProxiedBodyMaxBytes is 50MB. Phase 1 blasts exactly the
// cap (does not trip `streamedBytes > maxBytes`), phase 2 trickles small
// chunks past it — the trip happens with almost nothing in flight, so the
// flushed 413 reaches the client as data + FIN instead of being clobbered by
// the RST that req.destroy() emits when unread inbound bytes remain.
const kProxiedBodyCapBytes = 50 * 1024 * 1024;
const kChunkBytes = 1024 * 1024;
const kTrickleChunkBytes = 64 * 1024;
const kTrickleMaxChunks = 96; // up to ~6MB past the cap

// ── Control UI fixtures served by the fake gateway ──────────────────────────
//
// The document is what a basePath=/openclaw gateway stamps; the test asserts
// the attribute survives the proxy byte-for-byte (nothing rewrites HTML).
const kControlUiHtml =
  '<!doctype html><html data-openclaw-control-ui-base-path="/openclaw" data-openclaw-control-ui-build-id="b1"><head></head><body><openclaw-app></openclaw-app></body></html>';
const kControlUiCsp = "default-src 'self'; style-src 'self' 'unsafe-inline'";
// The stylesheet starts with the sentinel the UI's banner detector reads,
// then carries hash-salted rules. Two sizes matter: the IDENTITY body must
// exceed compression's 1 KB threshold so the gzip case really compresses, and
// the BROTLI body must exceed it too — a repeated string would brotli down to
// a few dozen bytes and the middleware would skip it for "size below
// threshold", never reaching the "already encoded" rule this suite pins.
const kCssSource = [":root{--openclaw-css-ok:1}"]
  .concat(
    Array.from({ length: 150 }, (_, i) => {
      const digest = crypto
        .createHash("sha256")
        .update(`css-${i}`)
        .digest("hex");
      return `.ac-${digest.slice(0, 16)}{--openclaw-css-ok:1;--h:${digest.slice(16, 48)}}`;
    }),
  )
  .join("\n");
const kCssBrotli = zlib.brotliCompressSync(Buffer.from(kCssSource, "utf8"));
const kImmutableCacheControl = "public, max-age=31536000, immutable";

const acquirePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const httpRequest = (port, options = {}, body = null) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path || "/",
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });

// Writes request bytes over a bare TCP socket and returns the full response
// text. Used where the request-target must reach the server UNMODIFIED:
// browsers, the ws client (`new URL(address)`) and most HTTP clients collapse
// `..` (and `\`) out of a URL before sending — exactly what a traversal probe
// must not do. Every request carries `Connection: close`, so the server's FIN
// ends the read.
const rawRequest = (port, requestText) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error("no raw response within 10s"));
    }, 10000);
    const finish = () => {
      clearTimeout(guard);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", finish);
    socket.on("error", (err) => {
      // A reset after the status line already arrived is still a readable
      // answer; only a reset with nothing received is a failure.
      if (chunks.length) return;
      clearTimeout(guard);
      reject(err);
    });
    socket.on("connect", () => socket.write(requestText));
  });

const statusLineOf = (responseText) => responseText.split("\r\n")[0];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fake gateway (shared by every server child in this file) ───────────────
//
// Lives at file scope because the legacy-mount describe below boots a SECOND
// AlphaClaw child against the SAME gateway port: the mount mode decides what
// path the gateway sees, so both children must talk to one recorder.
let gatewayServer = null;
let gatewayPort = 0;

// Per-request recording so tests can assert what the gateway actually saw.
const gatewayState = {
  requests: [],
  sink: { bytes: 0, ended: false },
  wsConnections: 0,
};
const resetGatewayState = () => {
  gatewayState.requests = [];
  gatewayState.sink = { bytes: 0, ended: false };
  gatewayState.wsConnections = 0;
};

const pathnameOf = (url) => String(url).split(/[?#]/)[0];

// Control UI contract of a gateway running with basePath=/openclaw. Matched on
// the pathname (query stripped) but recorded with the FULL url so tests can
// pin that `?v=b1` cache busters survive the proxy. Returns false when the
// path is not a Control UI resource (the default echo route answers then).
const serveControlUi = (req, res) => {
  const pathname = pathnameOf(req.url);
  const record = () =>
    gatewayState.requests.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.alloc(0),
    });
  const send = (headers, body) => {
    record();
    res.writeHead(200, { "x-fake-gateway": "yes", ...headers });
    // Node drops the body of a HEAD response itself; being explicit keeps the
    // fixture honest about what a real gateway writes.
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (pathname === "/openclaw/" || pathname === "/openclaw/dashboards") {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    send(
      {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(kControlUiHtml)),
        "content-security-policy": kControlUiCsp,
        "cache-control": "no-cache",
      },
      kControlUiHtml,
    );
    return true;
  }
  if (req.method !== "GET") return false;
  if (pathname === "/openclaw/assets/index-abc.css") {
    send(
      {
        "content-type": "text/css; charset=utf-8",
        "content-encoding": "br",
        "content-length": String(kCssBrotli.length),
        "cache-control": kImmutableCacheControl,
      },
      kCssBrotli,
    );
    return true;
  }
  if (
    pathname === "/openclaw/fonts/jetbrains-mono.css" ||
    pathname === "/openclaw/themes/dash.css"
  ) {
    send({ "content-type": "text/css; charset=utf-8" }, kCssSource);
    return true;
  }
  if (pathname === "/openclaw/sw.js") {
    send(
      { "content-type": "text/javascript; charset=utf-8" },
      "self.addEventListener('fetch', () => {});",
    );
    return true;
  }
  if (pathname === "/openclaw/__openclaw/control-ui-config.json") {
    send(
      { "content-type": "application/json; charset=utf-8" },
      JSON.stringify({ basePath: "/openclaw" }),
    );
    return true;
  }
  if (pathname === "/openclaw/avatar/main") {
    send(
      { "content-type": "image/svg+xml" },
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    return true;
  }
  return false;
};

const startFakeGateway = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.on("error", () => {});
      req.on("error", () => {});
      // Hung gateway: accept the connection, never respond.
      if (req.url.endsWith("/hang")) return;
      // Post-header slow stream: headers + first chunk, pause 2x the
      // pre-header proxy timeout, then finish.
      if (req.url.endsWith("/slow-stream")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first-chunk|");
        setTimeout(() => res.end("second-chunk"), kProxyTimeoutMs * 2);
        return;
      }
      // Over-cap sink: count bytes, record whether the body ever completed.
      if (req.url.endsWith("/big-sink")) {
        req.on("data", (chunk) => {
          gatewayState.sink.bytes += chunk.length;
        });
        req.on("end", () => {
          gatewayState.sink.ended = true;
          res.writeHead(200);
          res.end("sunk");
        });
        return;
      }
      if (serveControlUi(req, res)) return;
      // Default echo: record the exact bytes + headers received.
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        gatewayState.requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body,
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-fake-gateway": "yes",
        });
        res.end(
          JSON.stringify({
            path: req.url,
            length: body.length,
            sha256: crypto.createHash("sha256").update(body).digest("hex"),
          }),
        );
      });
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
      // Counted so the traversal case can prove the upgrade never arrived —
      // a rejected handshake and "no connection" are different facts.
      gatewayState.wsConnections += 1;
      socket.on("error", () => {});
      socket.on("message", (message) =>
        socket.send(`echo:${message}:path=${req.url}`),
      );
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

// ── AlphaClaw child lifecycle (shared by both describes) ───────────────────

// Fresh <tmp>/root with .openclaw/openclaw.json declaring the fake gateway as
// the proxy target — written BEFORE boot because getGatewayUrl() reads it.
const createServerRoot = (prefix) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tmpDir, "root");
  const openclawDir = path.join(rootDir, ".openclaw");
  fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });
  const openclawConfigPath = path.join(openclawDir, "openclaw.json");
  fs.writeFileSync(
    openclawConfigPath,
    JSON.stringify({ gateway: { port: gatewayPort } }),
  );
  return { tmpDir, rootDir, openclawConfigPath };
};

const spawnServerChild = ({ rootDir, port, env: extraEnv = {} }) => {
  const env = {
    ...process.env,
    SETUP_PASSWORD: kPassword,
    PORT: String(port),
    ALPHACLAW_ROOT_DIR: rootDir,
    ALPHACLAW_PROXY_TIMEOUT_MS: String(kProxyTimeoutMs),
  };
  // The default-mount child must exercise the DEFAULT: an operator shell
  // that happens to export the kill switch would otherwise turn the whole
  // basepath describe into a second legacy run.
  delete env.ALPHACLAW_CONTROL_UI_MOUNT;
  Object.assign(env, extraEnv);
  const child = spawn(
    process.execPath,
    ["-e", `require(${JSON.stringify(kServerPath)})`],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const handle = { child, output: "", exit: null };
  child.stdout.on("data", (data) => {
    handle.output += data;
  });
  child.stderr.on("data", (data) => {
    handle.output += data;
  });
  handle.exit = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return handle;
};

const waitForHealthy = async (port, handle) => {
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i += 1) {
    try {
      const res = await httpRequest(port, { path: "/health" });
      healthy = res.status === 200;
    } catch {
      await sleep(100);
    }
  }
  if (!healthy) {
    throw new Error(`server never became healthy. Output:\n${handle.output}`);
  }
};

const loginForCookie = async (port) => {
  const login = await httpRequest(
    port,
    {
      path: "/api/auth/login",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
    JSON.stringify({ password: kPassword }),
  );
  expect(login.status).toBe(200);
  const setCookie = String(login.headers["set-cookie"] || "");
  const cookie = setCookie.split(";")[0];
  expect(cookie).toMatch(/^setup_token=/);
  return cookie;
};

// SIGTERM, wait up to 10s, SIGKILL fallback. Returns the exit result (or
// "timeout") so the caller can pin the graceful-drain contract.
const stopServerChild = async (handle) => {
  if (!handle || handle.child.exitCode !== null) return null;
  handle.child.kill("SIGTERM");
  const exitResult = await Promise.race([
    handle.exit,
    sleep(10000).then(() => "timeout"),
  ]);
  if (exitResult === "timeout") {
    handle.child.kill("SIGKILL");
    await handle.exit;
  }
  return exitResult;
};

const removeTmpDir = async (tmpDir) => {
  if (!tmpDir) return;
  // The real gateway grandchild can outlive the server's SIGTERM by a
  // beat, still flushing its V8 compile cache into tmpDir (observed as
  // ENOTEMPTY on CI). Retry, then tolerate a leaked temp dir rather than
  // failing the whole suite on teardown.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
      break;
    } catch {
      await sleep(300);
    }
  }
};

beforeAll(async () => {
  gatewayServer = await startFakeGateway();
  gatewayPort = gatewayServer.address().port;
});

afterAll(async () => {
  if (gatewayServer) {
    gatewayServer.closeAllConnections?.();
    await new Promise((resolve) => gatewayServer.close(resolve));
  }
});

beforeEach(() => {
  resetGatewayState();
});

describe("gateway proxy real-process e2e", () => {
  let tmpDir = null;
  let server = null;
  let serverPort = 0;
  let deadPort = 0;
  let cookie = "";
  let openclawConfigPath = "";

  beforeAll(async () => {
    const root = createServerRoot("ac-proxy-e2e-");
    tmpDir = root.tmpDir;
    openclawConfigPath = root.openclawConfigPath;
    deadPort = await acquirePort();
    serverPort = await acquirePort();
    server = spawnServerChild({ rootDir: root.rootDir, port: serverPort });
    await waitForHealthy(serverPort, server);
    cookie = await loginForCookie(serverPort);
  }, 25000);

  afterAll(async () => {
    const exitResult = await stopServerChild(server);
    await removeTmpDir(tmpDir);
    // The graceful drain contract: SIGTERM exits 0 inside the 10s deadline
    // even after this file exercised every proxy failure mode.
    if (exitResult && exitResult !== "timeout") {
      expect(exitResult.code).toBe(0);
    }
  }, 20000);

  it("forwards an authenticated JSON POST to the gateway byte-identical and relays the response", async () => {
    const payload = JSON.stringify({ hello: "world", nested: { n: 42 } });

    // Unauthenticated first: the proxied path must 401 without touching the
    // gateway.
    const unauthed = await httpRequest(
      serverPort,
      {
        path: "/api/proxy-e2e/echo",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      payload,
    );
    expect(unauthed.status).toBe(401);
    expect(gatewayState.requests).toHaveLength(0);

    const res = await httpRequest(
      serverPort,
      {
        path: "/api/proxy-e2e/echo",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          cookie,
        },
      },
      payload,
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-fake-gateway"]).toBe("yes");
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      path: "/api/proxy-e2e/echo",
      length: Buffer.byteLength(payload),
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    });

    // The body reached the gateway byte-identical (parser skipped, stream
    // intact) with the correct content-length — the original hang regression.
    expect(gatewayState.requests).toHaveLength(1);
    const seen = gatewayState.requests[0];
    expect(seen.method).toBe("POST");
    expect(seen.body.toString("utf8")).toBe(payload);
    expect(seen.headers["content-length"]).toBe(
      String(Buffer.byteLength(payload)),
    );
    // Identity boundary: the AlphaClaw session cookie never crosses to the
    // gateway.
    expect(seen.headers.cookie).toBeUndefined();
  });

  it("streams a 6MB body through intact (parser skipped on proxied paths)", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    const expectedSha = crypto.createHash("sha256").update(big).digest("hex");

    const res = await httpRequest(
      serverPort,
      {
        path: "/openclaw/upload/blob",
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(big.length),
          cookie,
        },
      },
      big,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      path: "/openclaw/upload/blob",
      length: big.length,
      sha256: expectedSha,
    });
    expect(gatewayState.requests).toHaveLength(1);
    expect(gatewayState.requests[0].body.equals(big)).toBe(true);
  });

  it("413s a chunked body over the 50MB streamed cap; the gateway never receives the complete payload", async () => {
    const frameChunk = (chunk) =>
      Buffer.concat([
        Buffer.from(`${chunk.length.toString(16)}\r\n`),
        chunk,
        Buffer.from("\r\n"),
      ]);
    const result = await new Promise((resolve, reject) => {
      const socket = net.createConnection(serverPort, "127.0.0.1");
      const guard = setTimeout(
        () => reject(new Error("no 413 within 20s")),
        20000,
      );
      let response = "";
      let done = false;
      let sentBytes = 0;
      socket.on("data", (data) => {
        response += data;
        // enforceProxiedBodyLimit flushes the 413 body BEFORE destroying the
        // request socket — the client must see the response, not a reset.
        if (!done && response.includes("Request body too large")) {
          done = true;
          clearTimeout(guard);
          resolve({ response, sentBytes });
          socket.destroy();
        }
      });
      socket.on("error", (err) => {
        if (!done) {
          clearTimeout(guard);
          reject(err);
        }
      });
      socket.on("connect", () => {
        socket.write(
          `POST /api/proxy-e2e/big-sink HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${serverPort}\r\n` +
            `Cookie: ${cookie}\r\n` +
            `Content-Type: application/octet-stream\r\n` +
            `Transfer-Encoding: chunked\r\n\r\n`,
        );
        // Phase 1: exactly the cap, full speed (no trip: the check is
        // strictly greater-than).
        const framedBig = frameChunk(Buffer.alloc(kChunkBytes, 0x61));
        const framedSmall = frameChunk(Buffer.alloc(kTrickleChunkBytes, 0x62));
        const capChunks = kProxiedBodyCapBytes / kChunkBytes;
        let bigWritten = 0;
        let trickleWritten = 0;
        const trickleNext = () => {
          if (done || socket.destroyed || trickleWritten >= kTrickleMaxChunks) {
            return;
          }
          trickleWritten += 1;
          sentBytes += kTrickleChunkBytes;
          try {
            socket.write(framedSmall);
          } catch {
            return;
          }
          setTimeout(trickleNext, 15);
        };
        const writeNext = () => {
          if (done || socket.destroyed) return;
          if (bigWritten >= capChunks) {
            // Phase 2: creep past the cap with tiny paced chunks so the 413
            // is read from a quiet socket.
            trickleNext();
            return;
          }
          bigWritten += 1;
          sentBytes += kChunkBytes;
          let ok = false;
          try {
            ok = socket.write(framedBig);
          } catch {
            return;
          }
          if (ok) setImmediate(writeNext);
          else socket.once("drain", writeNext);
        };
        writeNext();
      });
    });

    expect(result.response).toMatch(/^HTTP\/1\.1 413 /);
    expect(result.response).toContain("Request body too large");
    // The client sent past the cap but never the chunked terminator, and the
    // server destroyed the request: prove the gateway never saw a completed
    // request body.
    expect(result.sentBytes).toBeGreaterThan(kProxiedBodyCapBytes);
    await sleep(400);
    expect(gatewayState.sink.ended).toBe(false);
    expect(gatewayState.sink.bytes).toBeLessThanOrEqual(result.sentBytes);
  });

  it("fails fast with 502 when the gateway is down, and the process survives", async () => {
    // getGatewayUrl() re-reads openclaw.json per request, so pointing it at a
    // dead port simulates a stopped gateway without rebooting the server.
    fs.writeFileSync(
      openclawConfigPath,
      JSON.stringify({ gateway: { port: deadPort } }),
    );
    try {
      const startedAt = Date.now();
      const res = await httpRequest(
        serverPort,
        {
          path: "/api/proxy-e2e/echo",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "2",
            cookie,
          },
        },
        "{}",
      );
      const elapsedMs = Date.now() - startedAt;
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body.toString("utf8"))).toEqual({
        error: "Gateway unavailable",
      });
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      fs.writeFileSync(
        openclawConfigPath,
        JSON.stringify({ gateway: { port: gatewayPort } }),
      );
    }

    // Headline property of the crash-proof error handler: the proxy error did
    // not kill the process.
    const health = await httpRequest(serverPort, { path: "/health" });
    expect(health.status).toBe(200);
  });

  it("maps a hung gateway (accepts, never responds) to 504 Gateway timed out in ~ALPHACLAW_PROXY_TIMEOUT_MS", async () => {
    const startedAt = Date.now();
    const res = await httpRequest(serverPort, {
      path: "/api/proxy-e2e/hang",
      headers: { cookie },
    });
    const elapsedMs = Date.now() - startedAt;
    // 504 (not 502) proves the proxyReq timeout listener armed the
    // __gatewayTimedOut marker through the real http-proxy-3 hook: the
    // timeout destroy carries no error code, so without the marker this
    // would surface as 502.
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      error: "Gateway timed out",
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(600);
    expect(elapsedMs).toBeLessThan(5000);

    const health = await httpRequest(serverPort, { path: "/health" });
    expect(health.status).toBe(200);
  });

  it("relaxes the idle timeout once headers arrive: a stream pausing 2x the proxy timeout completes", async () => {
    const startedAt = Date.now();
    const res = await httpRequest(serverPort, {
      path: "/api/proxy-e2e/slow-stream",
      headers: { cookie },
    });
    const elapsedMs = Date.now() - startedAt;
    // The gateway paused kProxyTimeoutMs*2 between chunks. Without the
    // post-header setTimeout relaxation the 800ms idle timeout would destroy
    // the exchange mid-stream and the second chunk would never arrive.
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe("first-chunk|second-chunk");
    expect(elapsedMs).toBeGreaterThanOrEqual(kProxyTimeoutMs * 2 - 100);
  });

  // ── Control UI transport contract (basepath mount, the default) ─────────
  //
  // The UI resolves fonts, themes, sw.js, its bootstrap config and avatars
  // from the base path the gateway stamps into the document, so every one of
  // these must reach the gateway with the /openclaw prefix intact AND the
  // query untouched (`?v=b1` is the UI's cache buster; `/openclaw/?x=1` used
  // to lose its query to the exact-match handler).
  const kControlUiTransportCases = [
    { path: "/openclaw/", contentType: "text/html; charset=utf-8" },
    { path: "/openclaw/?x=1", contentType: "text/html; charset=utf-8" },
    {
      path: "/openclaw/assets/index-abc.css",
      contentType: "text/css; charset=utf-8",
    },
    {
      path: "/openclaw/fonts/jetbrains-mono.css?v=b1",
      contentType: "text/css; charset=utf-8",
    },
    {
      path: "/openclaw/themes/dash.css?v=b1",
      contentType: "text/css; charset=utf-8",
    },
    { path: "/openclaw/sw.js", contentType: "text/javascript; charset=utf-8" },
    {
      path: "/openclaw/__openclaw/control-ui-config.json",
      contentType: "application/json; charset=utf-8",
    },
    { path: "/openclaw/avatar/main", contentType: "image/svg+xml" },
    { path: "/openclaw/dashboards", contentType: "text/html; charset=utf-8" },
  ];
  for (const { path: requestPath, contentType } of kControlUiTransportCases) {
    it(`forwards GET ${requestPath} to the gateway verbatim and passes status + content-type through`, async () => {
      const res = await httpRequest(serverPort, {
        path: requestPath,
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers["x-fake-gateway"]).toBe("yes");
      expect(res.headers["content-type"]).toBe(contentType);
      expect(gatewayState.requests).toHaveLength(1);
      const seen = gatewayState.requests[0];
      expect(seen.method).toBe("GET");
      expect(seen.url).toBe(requestPath);
      expect(seen.headers.cookie).toBeUndefined();
    });
  }

  it("forwards HEAD /openclaw/ as HEAD and relays a 200 with an empty body", async () => {
    // The UI's stale-chunk recovery probes the current URL with HEAD before
    // deciding to reload; the probe must see the gateway's answer, not a
    // synthesized one.
    const res = await httpRequest(serverPort, {
      path: "/openclaw/",
      method: "HEAD",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toHaveLength(0);
    expect(gatewayState.requests).toHaveLength(1);
    expect(gatewayState.requests[0].method).toBe("HEAD");
    expect(gatewayState.requests[0].url).toBe("/openclaw/");
  });

  it("relays an already-brotli CSS response byte-identical with content-encoding, content-length and cache-control intact", async () => {
    // accept-encoding: br is what a browser sends; compression must leave an
    // already-encoded body alone (compression@1.8.1 nocompress "already
    // encoded") instead of wrapping brotli in brotli. The fixture is larger
    // than the 1 KB threshold so that rule — not the size check — is what
    // keeps the body untouched.
    expect(kCssBrotli.length).toBeGreaterThan(1500);
    const res = await httpRequest(serverPort, {
      path: "/openclaw/assets/index-abc.css",
      headers: { cookie, "accept-encoding": "br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-length"]).toBe(String(kCssBrotli.length));
    expect(res.headers["cache-control"]).toBe(kImmutableCacheControl);
    expect(res.body.equals(kCssBrotli)).toBe(true);
    expect(zlib.brotliDecompressSync(res.body).toString("utf8")).toBe(
      kCssSource,
    );
  });

  it("may gzip an identity CSS body for a gzip-accepting client, decoding back to the source", async () => {
    // Compressing the gateway's identity responses is AlphaClaw's call (the
    // middleware runs on proxied responses too); the contract is only that
    // what arrives decodes to the bytes the gateway sent.
    expect(Buffer.byteLength(kCssSource)).toBeGreaterThan(1500);
    const res = await httpRequest(serverPort, {
      path: "/openclaw/fonts/jetbrains-mono.css?v=b1",
      headers: { cookie, "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    const decoded =
      res.headers["content-encoding"] === "gzip"
        ? zlib.gunzipSync(res.body)
        : res.body;
    expect(decoded.toString("utf8")).toBe(kCssSource);
    expect(gatewayState.requests).toHaveLength(1);
    expect(gatewayState.requests[0].url).toBe(
      "/openclaw/fonts/jetbrains-mono.css?v=b1",
    );
  });

  it("relays the Control UI document with its CSP header and stamped base path untouched", async () => {
    // The base-path attribute is the gateway's, and it is what the UI reads
    // to build every resource URL — nothing in AlphaClaw may rewrite HTML.
    const res = await httpRequest(serverPort, {
      path: "/openclaw/",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(kControlUiCsp);
    expect(res.headers["cache-control"]).toBe("no-cache");
    const html = res.body.toString("utf8");
    expect(html).toBe(kControlUiHtml);
    expect(html).toContain('data-openclaw-control-ui-base-path="/openclaw"');
  });

  // ── Unauthenticated Control UI requests (routes/auth.js rule table) ──────
  //
  // Resources get 401 JSON: a text/html login redirect is what the browser
  // rejects as a stylesheet, and the Control UI service worker caches any
  // `ok` response under the asset URL. Documents and the HEAD probe keep the
  // login redirect so a stale tab still lands on the login page.
  it("401s an unauthenticated DOCUMENT-shaped Control UI path when fetch metadata says subresource (Sec-Fetch-Dest: empty)", async () => {
    // Rule 3 in the real process: /openclaw/dashboards is not asset-shaped,
    // so only the fetch metadata can turn the redirect into a 401 — the
    // UI's own fetch() calls (bootstrap config, lazy route data) carry
    // Sec-Fetch-Dest: empty and must never be handed a login page.
    const res = await httpRequest(serverPort, {
      path: "/openclaw/dashboards",
      headers: { "sec-fetch-dest": "empty" },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      error: "Unauthorized",
    });
    expect(gatewayState.requests).toHaveLength(0);
  });

  it("401s an unauthenticated asset-shaped Control UI path with no fetch metadata at all", async () => {
    // Asset namespaces are header-independent: curl, Node and old browsers
    // send no Sec-Fetch-Dest, and a redirect is never right for a font.
    const res = await httpRequest(serverPort, {
      path: "/openclaw/fonts/jetbrains-mono.css",
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({
      error: "Unauthorized",
    });
    expect(gatewayState.requests).toHaveLength(0);
  });

  it("redirects an unauthenticated Control UI document navigation to the login page", async () => {
    const res = await httpRequest(serverPort, {
      path: "/openclaw/dashboards",
      headers: { "sec-fetch-dest": "document" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
    expect(gatewayState.requests).toHaveLength(0);
  });

  it("redirects an unauthenticated HEAD probe on /openclaw/ to the login page", async () => {
    // The UI's stale-chunk recovery HEAD-probes the current URL with
    // Sec-Fetch-Dest: empty; following the redirect to a 200 login page is
    // what makes it reload into the login screen instead of a dead banner.
    const res = await httpRequest(serverPort, {
      path: "/openclaw/",
      method: "HEAD",
      headers: { "sec-fetch-dest": "empty" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
    expect(gatewayState.requests).toHaveLength(0);
  });

  // ── Traversal guard on the gateway-UI proxies ────────────────────────────
  //
  // http-proxy-3's getPath() runs new URL(req.url) before forwarding (and the
  // gateway parses the same way), collapsing `..` AND turning `\` into `/`,
  // so any of these would leave the Control UI namespace and reach the
  // gateway's root /v1 handlers with only an AlphaClaw session cookie. Sent over a bare socket because every HTTP
  // client normalizes the attack away. Node's own parser hands all four
  // request-targets to Express unmodified (verified: a bare http.Server
  // answers 200 and echoes them), so the 404 has to come from AlphaClaw's
  // guard — a 400 here would mean Node rejected it first, which it does not.
  const kTraversalTargets = [
    "/openclaw/..\\v1/models",
    "/openclaw/../v1/models",
    "/openclaw/%2e%2e/v1/models",
    "/assets/../v1/models",
  ];
  for (const target of kTraversalTargets) {
    it(`404s an authenticated traversal request-target ${JSON.stringify(target)} and never forwards it`, async () => {
      const response = await rawRequest(
        serverPort,
        `GET ${target} HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Cookie: ${cookie}\r\n` +
          `Connection: close\r\n\r\n`,
      );
      expect(statusLineOf(response)).toMatch(/^HTTP\/1\.1 404 /);
      expect(response).toContain('{"error":"Not found"}');
      await sleep(200);
      expect(gatewayState.requests).toHaveLength(0);
    });
  }

  it("proxies a WebSocket upgrade on an /openclaw path to the gateway and echoes frames", async () => {
    const echoed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${serverPort}/openclaw/ws-echo`,
        { headers: { cookie } },
      );
      const guard = setTimeout(
        () => reject(new Error("no ws echo within 10s")),
        10000,
      );
      ws.on("open", () => ws.send("hello-ws"));
      ws.on("message", (message) => {
        clearTimeout(guard);
        resolve(String(message));
        ws.close();
      });
      ws.on("error", (err) => {
        clearTimeout(guard);
        reject(err);
      });
    });
    // Round-trip through the real server upgrade handler + http-proxy-3
    // ws:true — the biggest behavioral risk of the library swap.
    expect(echoed).toBe("echo:hello-ws:path=/openclaw/ws-echo");
    // Also proves the connection counter the traversal case relies on.
    expect(gatewayState.wsConnections).toBe(1);
  });

  it("rejects an unauthenticated WebSocket upgrade on /openclaw paths without touching the gateway", async () => {
    const outcome = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/openclaw/ws-echo`);
      const guard = setTimeout(
        () => reject(new Error("no ws rejection within 10s")),
        10000,
      );
      ws.on("open", () => {
        clearTimeout(guard);
        resolve("open");
      });
      ws.on("unexpected-response", (req, res) => {
        clearTimeout(guard);
        resolve(`status:${res.statusCode}`);
        req.destroy();
      });
      ws.on("error", (err) => {
        clearTimeout(guard);
        resolve(`error:${err.message}`);
      });
    });
    expect(outcome).toBe("status:401");
    expect(gatewayState.wsConnections).toBe(0);
  });

  it.each([
    // Backslash right after the prefix: a prefix-gated raw check would miss
    // it, and new URL() turns the backslash into "/" then collapses "..".
    ["/openclaw\\../ws-echo"],
    // Absolute-form request-target (Node's parser accepts it; new URL() would
    // route it by pathname and skip the /openclaw auth branch).
    ["http://127.0.0.1/openclaw/../ws-echo"],
  ])(
    "404s an authenticated WebSocket upgrade to %s (guard runs on every raw target)",
    async (target) => {
      const response = await rawRequest(
        serverPort,
        `GET ${target} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${serverPort}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Cookie: ${cookie}\r\n\r\n`,
      );
      expect(statusLineOf(response)).toBe("HTTP/1.1 404 Not Found");
      await sleep(200);
      expect(gatewayState.wsConnections).toBe(0);
      expect(gatewayState.requests).toHaveLength(0);
    },
  );

  it("404s an authenticated WebSocket upgrade to /openclaw/../ws-echo before it reaches the gateway", async () => {
    // The ws client runs the address through `new URL()`, which would turn
    // this into a clean /ws-echo upgrade and never exercise the guard — so
    // the handshake is written by hand over a bare socket. The upgrade
    // handler checks the RAW request-target (its own `new URL()` has already
    // collapsed the `..` out of pathname) and answers 404 without proxying.
    const response = await rawRequest(
      serverPort,
      `GET /openclaw/../ws-echo HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${serverPort}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Cookie: ${cookie}\r\n\r\n`,
    );
    expect(statusLineOf(response)).toBe("HTTP/1.1 404 Not Found");
    await sleep(200);
    expect(gatewayState.wsConnections).toBe(0);
    expect(gatewayState.requests).toHaveLength(0);
  });

  // /gateway/launch rides the non-/api auth path on purpose: expired sessions
  // get the login PAGE redirect (not 401 JSON) and the agent bearer physically
  // cannot reach it (allowBearer only applies under /api/). These three cases
  // pin that contract in the real process — the reason the route needs no
  // admin-manifest entry.
  it("redirects an unauthenticated /gateway/launch to the login page", async () => {
    const res = await httpRequest(serverPort, {
      path: "/gateway/launch?to=dashboards",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
  });

  it("redirects a bearer-only /gateway/launch to the login page (bearer never works off /api)", async () => {
    const res = await httpRequest(serverPort, {
      path: "/gateway/launch?to=dashboards",
      headers: { authorization: "Bearer some-agent-token" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
  });

  it("302s a session-cookie /gateway/launch to the dashboards sub-path with an empty body", async () => {
    const res = await httpRequest(serverPort, {
      path: "/gateway/launch?to=dashboards",
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    // This harness never onboards, so the launcher takes the tokenless branch
    // deterministically (and never spawns the CLI); the tokened branches are
    // pinned by routes-dashboard-launch.test.js.
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.toString("utf8")).toBe("");
  });
});

// ALPHACLAW_CONTROL_UI_MOUNT=legacy is the rollback switch: it must select the
// pre-basePath routing (strip the /openclaw prefix, mount the gateway's ROOT
// UI) in a process that reads the mode once at module load. A second child
// against the SAME fake gateway proves the switch picks the legacy route
// table; the migration/rollback transition itself is the live tier's job.
describe("gateway proxy real-process e2e (ALPHACLAW_CONTROL_UI_MOUNT=legacy)", () => {
  let tmpDir = null;
  let server = null;
  let serverPort = 0;
  let cookie = "";

  beforeAll(async () => {
    const root = createServerRoot("ac-proxy-e2e-legacy-");
    tmpDir = root.tmpDir;
    serverPort = await acquirePort();
    server = spawnServerChild({
      rootDir: root.rootDir,
      port: serverPort,
      env: { ALPHACLAW_CONTROL_UI_MOUNT: "legacy" },
    });
    await waitForHealthy(serverPort, server);
    cookie = await loginForCookie(serverPort);
  }, 25000);

  afterAll(async () => {
    const exitResult = await stopServerChild(server);
    await removeTmpDir(tmpDir);
    if (exitResult && exitResult !== "timeout") {
      expect(exitResult.code).toBe(0);
    }
  }, 20000);

  // Legacy paths land on the fake gateway's default echo route, which reports
  // the url it received.
  const kLegacyStripCases = [
    { requested: "/openclaw/fonts/x.css", forwarded: "/fonts/x.css" },
    { requested: "/openclaw", forwarded: "/" },
    { requested: "/openclaw/chat?tab=1", forwarded: "/chat?tab=1" },
  ];
  for (const { requested, forwarded } of kLegacyStripCases) {
    it(`strips the prefix: GET ${requested} reaches the gateway as ${forwarded}`, async () => {
      const res = await httpRequest(serverPort, {
        path: requested,
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers["x-fake-gateway"]).toBe("yes");
      expect(JSON.parse(res.body.toString("utf8")).path).toBe(forwarded);
      expect(gatewayState.requests).toHaveLength(1);
      expect(gatewayState.requests[0].url).toBe(forwarded);
      expect(gatewayState.requests[0].headers.cookie).toBeUndefined();
    });
  }
});
