const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

const { createChatWsService } = require("../../lib/server/chat-ws");

const waitForListening = (server) =>
  new Promise((resolve) => {
    server.once("listening", resolve);
  });

const closeWsServer = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe("server/chat-ws", () => {
  let originalGatewayToken;
  let tempDir;
  let gatewayServer;
  let gatewaySocket;

  beforeEach(() => {
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-chat-ws-"));
  });

  afterEach(async () => {
    if (gatewaySocket && gatewaySocket.readyState === 1) {
      gatewaySocket.close();
    }
    if (gatewayServer) {
      await closeWsServer(gatewayServer);
      gatewayServer = null;
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("connects as the direct-local backend client that preserves operator scopes", async () => {
    const captured = {
      connectParams: null,
      headers: null,
      historyParams: null,
    };
    gatewayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForListening(gatewayServer);

    gatewayServer.on("connection", (socket, request) => {
      gatewaySocket = socket;
      captured.headers = request.headers;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
      socket.on("message", (rawData) => {
        const frame = JSON.parse(String(rawData || ""));
        if (frame.method === "connect") {
          captured.connectParams = frame.params;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok" },
            }),
          );
          return;
        }
        if (frame.method === "chat.history") {
          captured.historyParams = frame.params;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { messages: [] },
            }),
          );
        }
      });
    });

    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "bridge-token";

    const service = createChatWsService({
      fs,
      openclawDir: tempDir,
      getGatewayPort: () => gatewayServer.address().port,
    });

    const history = await service.fetchHistory("agent:main:main");

    expect(history).toEqual({
      messages: [],
      rawHistory: { messages: [] },
      markers: [],
      truncated: false,
    });
    expect(captured.headers.origin).toBeUndefined();
    expect(captured.connectParams).toMatchObject({
      client: {
        id: "gateway-client",
        mode: "backend",
      },
      role: "operator",
      auth: { token: "bridge-token" },
    });
    expect(captured.connectParams.scopes).toEqual(
      expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
    );
    expect(captured.historyParams).toEqual({
      sessionKey: "agent:main:main",
      limit: 201,
    });
  });

  it("authenticates with the internal password when team mode has the gateway in trusted-proxy auth", async () => {
    const originalGatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    const captured = { connectParams: null };
    gatewayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await waitForListening(gatewayServer);

    gatewayServer.on("connection", (socket) => {
      gatewaySocket = socket;
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
      socket.on("message", (rawData) => {
        const frame = JSON.parse(String(rawData || ""));
        if (frame.method === "connect") {
          captured.connectParams = frame.params;
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok" },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { messages: [] },
          }),
        );
      });
    });

    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { mode: "trusted-proxy" } } }),
    );
    // enableTeamMode derives the internal password from the previous shared
    // token, so the token env var still holds the right secret here.
    process.env.OPENCLAW_GATEWAY_TOKEN = "bridge-token";
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;

    try {
      const service = createChatWsService({
        fs,
        openclawDir: tempDir,
        getGatewayPort: () => gatewayServer.address().port,
      });

      await service.fetchHistory("agent:main:main");

      expect(captured.connectParams.auth).toEqual({ password: "bridge-token" });
    } finally {
      if (originalGatewayPassword === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = originalGatewayPassword;
      }
    }
  });
});
