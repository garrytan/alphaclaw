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

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("gateway proxy real-process e2e", () => {
  let tmpDir = null;
  let serverChild = null;
  let serverExit = null;
  let serverOutput = "";
  let serverPort = 0;
  let gatewayPort = 0;
  let deadPort = 0;
  let gatewayServer = null;
  let cookie = "";
  let openclawConfigPath = "";

  // Per-request recording so tests can assert what the gateway actually saw.
  const gatewayState = {
    requests: [],
    sink: { bytes: 0, ended: false },
  };
  const resetGatewayState = () => {
    gatewayState.requests = [];
    gatewayState.sink = { bytes: 0, ended: false };
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
        socket.on("error", () => {});
        socket.on("message", (message) =>
          socket.send(`echo:${message}:path=${req.url}`),
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-proxy-e2e-"));
    const rootDir = path.join(tmpDir, "root");
    const openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(openclawDir, "workspace"), { recursive: true });

    gatewayServer = await startFakeGateway();
    gatewayPort = gatewayServer.address().port;
    deadPort = await acquirePort();
    serverPort = await acquirePort();

    // The proxy target port comes from openclaw.json, written BEFORE boot.
    openclawConfigPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      openclawConfigPath,
      JSON.stringify({ gateway: { port: gatewayPort } }),
    );

    serverChild = spawn(
      process.execPath,
      ["-e", `require(${JSON.stringify(kServerPath)})`],
      {
        env: {
          ...process.env,
          SETUP_PASSWORD: kPassword,
          PORT: String(serverPort),
          ALPHACLAW_ROOT_DIR: rootDir,
          ALPHACLAW_PROXY_TIMEOUT_MS: String(kProxyTimeoutMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    serverChild.stdout.on("data", (data) => {
      serverOutput += data;
    });
    serverChild.stderr.on("data", (data) => {
      serverOutput += data;
    });
    serverExit = new Promise((resolve) =>
      serverChild.on("exit", (code, signal) => resolve({ code, signal })),
    );

    let healthy = false;
    for (let i = 0; i < 100 && !healthy; i += 1) {
      try {
        const res = await httpRequest(serverPort, { path: "/health" });
        healthy = res.status === 200;
      } catch {
        await sleep(100);
      }
    }
    if (!healthy) {
      throw new Error(`server never became healthy. Output:\n${serverOutput}`);
    }

    const login = await httpRequest(
      serverPort,
      {
        path: "/api/auth/login",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      JSON.stringify({ password: kPassword }),
    );
    expect(login.status).toBe(200);
    const setCookie = String(login.headers["set-cookie"] || "");
    cookie = setCookie.split(";")[0];
    expect(cookie).toMatch(/^setup_token=/);
  }, 25000);

  afterAll(async () => {
    let exitResult = null;
    if (serverChild && serverChild.exitCode === null) {
      serverChild.kill("SIGTERM");
      exitResult = await Promise.race([
        serverExit,
        sleep(10000).then(() => "timeout"),
      ]);
      if (exitResult === "timeout") {
        serverChild.kill("SIGKILL");
        await serverExit;
      }
    }
    if (gatewayServer) {
      gatewayServer.closeAllConnections?.();
      await new Promise((resolve) => gatewayServer.close(resolve));
    }
    if (tmpDir) {
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
    }
    // The graceful drain contract: SIGTERM exits 0 inside the 10s deadline
    // even after this file exercised every proxy failure mode.
    if (exitResult && exitResult !== "timeout") {
      expect(exitResult.code).toBe(0);
    }
  }, 20000);

  beforeEach(() => {
    resetGatewayState();
  });

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
      // The /openclaw prefix is stripped before the gateway sees the path.
      path: "/upload/blob",
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
  });
});
