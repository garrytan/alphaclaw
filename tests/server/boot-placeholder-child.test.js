const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const kChildPath = path.join(__dirname, "..", "..", "lib", "boot-placeholder-child.js");

const httpGet = (port, options = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path || "/health",
        headers: options.headers || {},
        // Fresh connection per request: Node >=19 keep-alives the global
        // agent, and pooled sockets to a just-closed blocker server would
        // surface as confusing ECONNRESETs in the bind-retry test.
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForServer = async (port, attempts = 50, intervalMs = 100) => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await httpGet(port);
    } catch {
      await sleep(intervalMs);
    }
  }
  throw new Error("placeholder child never started listening");
};

describe("bin boot placeholder child process", () => {
  let child = null;
  let blocker = null;
  let orphanPid = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    child = null;
    if (blocker) {
      try {
        blocker.closeAllConnections?.();
      } catch {}
      await new Promise((resolve) => blocker.close(() => resolve()));
      blocker = null;
    }
    if (orphanPid) {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {}
      orphanPid = null;
    }
  });

  it("serves updating health and 503s, then exits promptly on SIGTERM", async () => {
    const port = 19000 + Math.floor(Math.random() * 500);
    child = spawn(process.execPath, [kChildPath], {
      env: { ...process.env, ALPHACLAW_PLACEHOLDER_PORT: String(port) },
      stdio: "ignore",
    });

    const health = await waitForServer(port);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "updating", gateway: "starting" });

    const browser = await httpGet(port, { path: "/", headers: { accept: "text/html" } });
    expect(browser.status).toBe(503);
    expect(browser.headers["retry-after"]).toBe("5");
    expect(browser.body).toContain("AlphaClaw is updating");

    const api = await httpGet(port, { path: "/api/status" });
    expect(api.status).toBe(503);
    expect(JSON.parse(api.body).status).toBe("updating");

    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);
    expect(code).not.toBe("timeout");
  });

  // Restart-overlap: a predecessor process holds the port (its ≤10s drain
  // window) — the placeholder must stay alive on the 2s bind-retry cadence
  // and take the port over once it frees. Regression: the retry timer used
  // to be unref()'d, so a failed listen() drained the event loop and the
  // child exited 0 in ~50ms, leaving no placeholder for exactly this window.
  it("retries the bind while the port is occupied and serves once it frees", async () => {
    const port = 19600 + Math.floor(Math.random() * 500);
    blocker = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("blocker-owns-port");
    });
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "0.0.0.0", resolve);
    });

    child = spawn(process.execPath, [kChildPath], {
      env: { ...process.env, ALPHACLAW_PLACEHOLDER_PORT: String(port) },
      stdio: "ignore",
    });

    // While blocked: the child stays alive (retry pending) and the blocker
    // still owns the port.
    const raced = await Promise.race([
      new Promise((resolve) => child.on("exit", () => resolve("exited"))),
      new Promise((resolve) => setTimeout(() => resolve("still-alive"), 2500)),
    ]);
    expect(raced).toBe("still-alive");
    expect(child.exitCode).toBeNull();
    const blocked = await httpGet(port);
    expect(blocked.body).toBe("blocker-owns-port");

    // Release the port: the next 2s retry tick must bind and serve.
    await new Promise((resolve) => {
      blocker.closeAllConnections?.();
      blocker.close(() => resolve());
    });
    blocker = null;

    const health = await waitForServer(port, 40, 100);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "updating", gateway: "starting" });
    expect(child.exitCode).toBeNull();
  });

  it("flips /health to 503 after ALPHACLAW_PLACEHOLDER_MAX_UPDATING_MS elapses", async () => {
    const port = 20200 + Math.floor(Math.random() * 500);
    child = spawn(process.execPath, [kChildPath], {
      env: {
        ...process.env,
        ALPHACLAW_PLACEHOLDER_PORT: String(port),
        ALPHACLAW_PLACEHOLDER_MAX_UPDATING_MS: "300",
      },
      stdio: "ignore",
    });

    // The 300ms window starts at handler creation inside the child, a tick
    // before it starts listening — poll fast so the first observed response
    // lands well inside the window (control: the knob-less spawn in the
    // first test asserts /health stays 200).
    const first = await waitForServer(port, 300, 25);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ status: "updating", gateway: "starting" });

    // 500ms after a response that was already inside the window guarantees
    // the 300ms window has expired.
    await sleep(500);
    const flipped = await httpGet(port);
    expect(flipped.status).toBe(503);
    expect(JSON.parse(flipped.body)).toEqual({ status: "updating", gateway: "starting" });

    // Non-health paths keep their usual 503 shape and the child stays up
    // (the flip is a health signal, not a crash).
    const api = await httpGet(port, { path: "/api/status" });
    expect(api.status).toBe(503);
    expect(child.exitCode).toBeNull();
  });

  it("self-exits via the orphan check when its parent dies", async () => {
    const port = 20800 + Math.floor(Math.random() * 500);
    // Intermediate parent: spawns the placeholder child detached, prints its
    // pid, then exits as soon as the child accepts a TCP connection. The
    // child captures process.ppid synchronously in the same module eval that
    // calls listen(), so "child is listening" guarantees it recorded THIS
    // parent's pid before the parent died.
    const parentScript = [
      "const { spawn } = require('child_process');",
      "const net = require('net');",
      "const childPath = process.argv[1];",
      "const port = Number(process.argv[2]);",
      "const child = spawn(process.execPath, [childPath], {",
      "  detached: true,",
      "  stdio: 'ignore',",
      "  env: { ...process.env, ALPHACLAW_PLACEHOLDER_PORT: String(port) },",
      "});",
      "child.unref();",
      "console.log(String(child.pid));",
      "const probe = () => {",
      "  const sock = net.connect({ host: '127.0.0.1', port }, () => {",
      "    sock.destroy();",
      "    process.exit(0);",
      "  });",
      "  sock.on('error', () => { sock.destroy(); setTimeout(probe, 50); });",
      "};",
      "probe();",
      "setTimeout(() => process.exit(1), 5000);",
    ].join("\n");

    const parent = spawn(process.execPath, ["-e", parentScript, kChildPath, String(port)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    parent.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const parentCode = await new Promise((resolve) => parent.on("exit", resolve));
    expect(parentCode).toBe(0);
    orphanPid = Number.parseInt(stdout.trim(), 10);
    expect(Number.isInteger(orphanPid) && orphanPid > 0).toBe(true);

    // Orphan check polls ppid every 2s, then shutdown exits within 1s —
    // the child must be gone well inside ~5s of the parent's death.
    const deadline = Date.now() + 5500;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(orphanPid, 0);
      } catch {
        gone = true;
        break;
      }
      await sleep(150);
    }
    expect(gone).toBe(true);
    orphanPid = null;
  });
});
