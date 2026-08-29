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
});
