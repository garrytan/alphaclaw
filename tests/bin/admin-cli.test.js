const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { runAdminCommand } = require("../../lib/cli/admin");

const tokenPath = (rootDir) =>
  path.join(rootDir, ".openclaw", ".alphaclaw", "agent-admin-token");

const writeToken = (rootDir, token = "tok-123") => {
  fs.mkdirSync(path.dirname(tokenPath(rootDir)), { recursive: true });
  fs.writeFileSync(tokenPath(rootDir), token);
};

// A tiny real HTTP server so the CLI's out-of-process http client has something
// to talk to. Captures every received request for header/hit assertions.
const startStub = (handler) =>
  new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handler(req, res, received);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, received });
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => server.close(() => resolve()));

const jsonHandler = (status, payload) => (_req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

describe("cli/admin runAdminCommand", () => {
  let rootDir;
  let servers;
  let writes;
  const origPort = process.env.PORT;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-admin-cli-"));
    servers = [];
    writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers) await closeServer(server);
    if (origPort === undefined) delete process.env.PORT;
    else process.env.PORT = origPort;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const stdout = () => writes.join("");
  const stdoutJson = () => JSON.parse(stdout().trim());

  // Starts a live stub and points the CLI at it via process.env.PORT.
  const useStub = async (handler) => {
    const stub = await startStub(handler);
    servers.push(stub.server);
    process.env.PORT = String(stub.port);
    return stub;
  };

  // Reserves a port then closes it, so the CLI hits a refused connection.
  const useClosedPort = async () => {
    const stub = await startStub(() => {});
    await closeServer(stub.server);
    process.env.PORT = String(stub.port);
  };

  it("fails with agent_admin_disabled when no token file exists", async () => {
    const code = await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });
    expect(code).toBe(1);
    expect(stdoutJson().code).toBe("agent_admin_disabled");
  });

  it("reports server_unreachable when the port is closed", async () => {
    writeToken(rootDir);
    await useClosedPort();

    const code = await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });
    expect(code).toBe(1);
    expect(stdoutJson().code).toBe("server_unreachable");
  });

  it("returns exit 0 and the JSON body on a successful GET", async () => {
    writeToken(rootDir);
    await useStub(jsonHandler(200, { ok: true, gateway: "running" }));

    const code = await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });
    expect(code).toBe(0);
    expect(stdoutJson().ok).toBe(true);
  });

  it("renders a human digest with --summary", async () => {
    writeToken(rootDir);
    await useStub(jsonHandler(200, { ok: true, gateway: "running" }));

    const code = await runAdminCommand({
      argv: ["GET", "/api/status", "--summary"],
      rootDir,
    });
    expect(code).toBe(0);
    expect(stdout()).toContain("gateway: running");
  });

  it("renders the machine line in --summary when the status carries one", async () => {
    writeToken(rootDir);
    await useStub(
      jsonHandler(200, {
        ok: true,
        gateway: "running",
        machine: {
          tier: "medium",
          memoryGb: 4,
          cores: 2,
          gpu: { present: true, name: "NVIDIA A10G" },
          autotune: { enabled: true, agentConcurrencyCap: 32 },
        },
      }),
    );

    const code = await runAdminCommand({
      argv: ["GET", "/api/status", "--summary"],
      rootDir,
    });
    expect(code).toBe(0);
    expect(stdout()).toContain("machine: 2 vCPU / 4 GB (medium), gpu · autotune on");

    // No machine block (older server) → no machine line.
    writes.length = 0;
    await useStub(jsonHandler(200, { ok: true, gateway: "running" }));
    await runAdminCommand({ argv: ["GET", "/api/status", "--summary"], rootDir });
    expect(stdout()).not.toContain("machine:");
  });

  it("rejects invalid --data JSON before sending a request (exit 2)", async () => {
    writeToken(rootDir);
    const stub = await useStub(jsonHandler(200, { ok: true }));

    const code = await runAdminCommand({
      argv: ["POST", "/api/agents", "--data", "{not json"],
      rootDir,
    });
    expect(code).toBe(2);
    expect(stdoutJson().code).toBe("invalid_json");
    expect(stub.received).toHaveLength(0); // never left the CLI
  });

  it("treats a 2xx body carrying an error as failure (exit 1)", async () => {
    writeToken(rootDir);
    await useStub(jsonHandler(200, { error: "nope" }));

    const code = await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });
    expect(code).toBe(1);
  });

  it("forwards --confirm as the X-AlphaClaw-Confirm header", async () => {
    writeToken(rootDir);
    const stub = await useStub(jsonHandler(200, { ok: true }));

    await runAdminCommand({
      argv: ["DELETE", "/api/agents/foo", "--confirm", "ABCD-2345"],
      rootDir,
    });

    expect(stub.received).toHaveLength(1);
    expect(stub.received[0].headers["x-alphaclaw-confirm"]).toBe("ABCD-2345");
  });

  it("falls back to the static manifest when the live server is down", async () => {
    writeToken(rootDir); // present, so `manifest` tries live first
    await useClosedPort();

    const code = await runAdminCommand({ argv: ["manifest"], rootDir });
    expect(code).toBe(0);
    expect(stdoutJson().source).toBe("fallback");
  });

  it("reads the request body from stdin with --data-stdin", async () => {
    writeToken(rootDir);
    const stub = await useStub(jsonHandler(200, { ok: true }));
    const bodyJson = JSON.stringify({ vars: [{ key: "FOO", value: "bar" }] });
    // Only fd 0 is redirected; the token-store's own file reads pass through.
    const realReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === 0) return bodyJson;
      return realReadFileSync(target, ...rest);
    });

    const code = await runAdminCommand({
      argv: ["PUT", "/api/env", "--data-stdin"],
      rootDir,
    });

    expect(code).toBe(0);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0].body).toBe(bodyJson);
  });

  it("emits exactly one JSON line on stdout with --json", async () => {
    writeToken(rootDir);
    await useStub(jsonHandler(200, { ok: true, gateway: "running" }));

    const code = await runAdminCommand({
      argv: ["GET", "/api/status", "--json"],
      rootDir,
    });

    expect(code).toBe(0);
    const out = stdout();
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, gateway: "running" });
  });

  it("prints a raw non-JSON 2xx body and exits 0 (A28)", async () => {
    writeToken(rootDir);
    await useStub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
    });

    const code = await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });
    expect(code).toBe(0);
    expect(stdout().trim()).toBe("pong");
  });

  it("prefers --port over the inherited PORT env var (B8)", async () => {
    writeToken(rootDir);
    const stub = await startStub(jsonHandler(200, { ok: true }));
    servers.push(stub.server);
    // PORT points at a CLOSED port; --port must win and reach the live stub.
    const closed = await startStub(() => {});
    const closedPort = closed.port;
    await closeServer(closed.server);
    process.env.PORT = String(closedPort);

    const code = await runAdminCommand({
      argv: ["GET", "/api/status", "--port", String(stub.port)],
      rootDir,
    });

    expect(code).toBe(0);
    expect(stub.received).toHaveLength(1);
  });

  it("never leaks a __port pseudo-header to the server", async () => {
    writeToken(rootDir);
    const stub = await useStub(jsonHandler(200, { ok: true }));

    await runAdminCommand({ argv: ["GET", "/api/status"], rootDir });

    expect(stub.received).toHaveLength(1);
    // Port travels in the http.request options now, never as a forged header.
    expect(stub.received[0].headers).not.toHaveProperty("__port");
    expect(
      Object.keys(stub.received[0].headers).some((name) => name === "__port"),
    ).toBe(false);
  });
});
