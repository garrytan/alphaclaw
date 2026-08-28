// Real-process lifecycle e2e: boots the ACTUAL lib/server.js (the proven
// responsiveness-harness contract — SETUP_PASSWORD/PORT/ALPHACLAW_ROOT_DIR in
// a tmpdir) and asserts the whole-server boot contract, login → session
// cookie → authed status, real SSE framing on a real socket, graceful SIGTERM
// drain with an open SSE connection (installCrashGuards + lil-http-terminator
// + exit 0 + port release), and the bounded EADDRINUSE listen-retry give-up
// path while the port owner stays healthy. No mocks, no replicas: a syntax
// error or middleware re-ordering in lib/server.js fails this file.
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const kServerEntry = path.join(__dirname, "..", "..", "lib", "server.js");
const kPassword = "e2e-lifecycle-pass";
// Random base per run avoids cross-file collisions (other e2e files use the
// 19xxx range, supertest uses OS-ephemeral 32768+); fixed offsets from the
// base avoid intra-file collisions between the instances this file boots.
const kBasePort = 21000 + Math.floor(Math.random() * 8000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms: ${label}`)),
        ms,
      );
      timer.unref?.();
    }),
  ]);

const httpRequest = ({ port, path: reqPath, method = "GET", headers = {}, body = null }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method, headers },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: responseBody }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const waitForHealth = async (port, attempts = 150) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await httpRequest({ port, path: "/health" });
      if (res.status === 200) return res;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server on :${port} never answered /health`);
};

const makeRootDir = (tmpDirs) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-e2e-lifecycle-"));
  tmpDirs.push(base);
  const rootDir = path.join(base, "root");
  // The agent workspace lives under <root>/.openclaw/workspace per the boot
  // contract; pre-create it like the responsiveness harness does.
  fs.mkdirSync(path.join(rootDir, ".openclaw", "workspace"), { recursive: true });
  return rootDir;
};

const spawnRealServer = ({ port, rootDir }) => {
  const child = spawn(
    process.execPath,
    ["-e", `require(${JSON.stringify(kServerEntry)});`],
    {
      env: {
        ...process.env,
        SETUP_PASSWORD: kPassword,
        PORT: String(port),
        ALPHACLAW_ROOT_DIR: rootDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, port, log: () => Buffer.concat(chunks).toString("utf8") };
};

const reap = async (handle) => {
  if (!handle) return;
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGKILL");
  }
  await withTimeout(handle.exited, 5000, "child process reap");
};

const login = async (port) => {
  const body = JSON.stringify({ password: kPassword });
  const response = await httpRequest({
    port,
    path: "/api/auth/login",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body).ok).toBe(true);
  const setCookie = response.headers["set-cookie"] || [];
  const sessionCookie = setCookie
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith("setup_token="));
  expect(sessionCookie).toBeTruthy();
  return sessionCookie;
};

// Raw SSE client (no EventSource dependency): resolves with handles for the
// first complete frame and for socket close, and keeps the connection open
// until destroy() — exactly what the SIGTERM drain test needs.
const openSse = (port, cookie) =>
  new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/events/status",
      headers: { cookie, accept: "text/event-stream" },
    });
    let settled = false;
    req.on("error", (error) => {
      // Post-response socket teardown (server shutdown) is expected; only a
      // failure to establish the stream should reject.
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    req.on("response", (res) => {
      settled = true;
      res.on("error", () => {});
      let buffered = "";
      let resolveFirstFrame;
      const firstFrame = new Promise((resolveFrame) => {
        resolveFirstFrame = resolveFrame;
      });
      res.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        const frameEnd = buffered.indexOf("\n\n");
        if (frameEnd !== -1) resolveFirstFrame(buffered.slice(0, frameEnd));
      });
      const closed = new Promise((resolveClose) => res.on("close", resolveClose));
      resolve({
        status: res.statusCode,
        headers: res.headers,
        firstFrame,
        closed,
        destroy: () => req.destroy(),
      });
    });
    req.end();
  });

const expectConnectionRefused = async (port) => {
  let outcome = "connected";
  try {
    await httpRequest({ port, path: "/health" });
  } catch (error) {
    outcome = error?.code || String(error);
  }
  expect(["ECONNREFUSED", "ECONNRESET"]).toContain(outcome);
};

describe("real-server lifecycle e2e", () => {
  const tmpDirs = [];
  const extraServers = [];
  // Instance A: shared by the read-only probes (health/login/status/SSE) and
  // by the EADDRINUSE leg as the port owner. Never signalled until afterAll.
  let serverA = null;

  beforeAll(async () => {
    serverA = spawnRealServer({ port: kBasePort, rootDir: makeRootDir(tmpDirs) });
    await waitForHealth(serverA.port);
  }, 25000);

  afterEach(async () => {
    while (extraServers.length) {
      await reap(extraServers.pop());
    }
  });

  afterAll(async () => {
    await reap(serverA);
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("serves /health 200 with the pre-onboarding status body", async () => {
    const health = await httpRequest({ port: serverA.port, path: "/health" });
    expect(health.status).toBe(200);
    expect(health.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(health.body);
    // Fresh tmpdir root = not onboarded = the coarse "starting" state.
    expect(body).toEqual({ status: "starting", gateway: "starting" });
  });

  it("logs in with the setup password and reads authed /api/status", async () => {
    const cookie = await login(serverA.port);
    const status = await httpRequest({
      port: serverA.port,
      path: "/api/status",
      headers: { cookie },
    });
    expect(status.status).toBe(200);
    expect(status.headers["content-type"]).toContain("application/json");
    const payload = JSON.parse(status.body);
    expect(payload.gateway).toBe("not_onboarded");
    expect(payload.alphaclawVersion).toBeTruthy();
  });

  it("streams a status event over a real SSE socket", async () => {
    const cookie = await login(serverA.port);
    const sse = await openSse(serverA.port, cookie);
    try {
      expect(sse.status).toBe(200);
      expect(sse.headers["content-type"]).toContain("text/event-stream");
      const frame = await withTimeout(sse.firstFrame, 10000, "first SSE status frame");
      // Single-write framing: the event name and data land as one frame.
      expect(frame.startsWith("event: status\ndata: ")).toBe(true);
      const data = JSON.parse(frame.slice("event: status\ndata: ".length));
      expect(data.status.gateway).toBe("not_onboarded");
      expect(data.timestamp).toBeTruthy();
    } finally {
      sse.destroy();
    }
  });

  it("drains an open SSE connection on SIGTERM: exit 0, shutdown log, port released", async () => {
    const server = spawnRealServer({ port: kBasePort + 1, rootDir: makeRootDir(tmpDirs) });
    extraServers.push(server);
    await waitForHealth(server.port);
    const cookie = await login(server.port);
    const sse = await openSse(server.port, cookie);
    await withTimeout(sse.firstFrame, 10000, "SSE frame before shutdown");

    server.child.kill("SIGTERM");
    // Hard bound: drain grace is 3s and the shutdown deadline is 10s; a clean
    // drain must exit 0 (the deadline path would flip the code to 1).
    const outcome = await withTimeout(server.exited, 12000, "server exit after SIGTERM");
    expect(outcome).toEqual({ code: 0, signal: null });

    const log = server.log();
    expect(log).toContain(`[alphaclaw] Express listening on :${server.port}`);
    expect(log).toContain("[alphaclaw] Shutting down: SIGTERM");
    expect(log).not.toContain("Shutdown deadline exceeded");

    // The held SSE socket must have been torn down by the terminator (or the
    // process exit), and the port must actually be free again.
    await withTimeout(sse.closed, 3000, "SSE socket close after drain");
    await expectConnectionRefused(server.port);
  });

  it(
    "EADDRINUSE: a second instance retries 5x then exits 1 while the owner stays healthy",
    async () => {
      const probeOwner = () => httpRequest({ port: serverA.port, path: "/health" });
      expect((await probeOwner()).status).toBe(200);

      const contender = spawnRealServer({
        port: serverA.port,
        rootDir: makeRootDir(tmpDirs),
      });
      extraServers.push(contender);

      // Poll the owner's /health for the contender's whole lifetime
      // (~1-2s boot + 5 retries x 3s = ~16-17s). Collect results instead of
      // throwing so a failed probe cannot become an unhandled rejection.
      let contenderDone = false;
      const probeResults = [];
      const probeLoop = (async () => {
        while (!contenderDone) {
          try {
            probeResults.push((await probeOwner()).status);
          } catch (error) {
            probeResults.push(`error:${error?.code || error}`);
          }
          await sleep(1000);
        }
      })();

      let outcome;
      try {
        outcome = await withTimeout(contender.exited, 23000, "contender exit after retries");
      } finally {
        contenderDone = true;
      }
      await probeLoop;

      expect(outcome).toEqual({ code: 1, signal: null });
      const log = contender.log();
      expect(log).toContain(`[alphaclaw] Port ${serverA.port} in use — retry 1/5 in 3s`);
      expect(log).toContain(`[alphaclaw] Port ${serverA.port} in use — retry 5/5 in 3s`);
      expect(log).toContain(`[alphaclaw] Server failed to listen on :${serverA.port}`);

      // The owner answered every probe during the contender's retry storm...
      expect(probeResults.length).toBeGreaterThanOrEqual(5);
      expect(probeResults.every((status) => status === 200)).toBe(true);
      // ...and is still the process bound to the port afterwards.
      expect((await probeOwner()).status).toBe(200);
    },
    25000,
  );
});
