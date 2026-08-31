const { EventEmitter } = require("events");

const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");

// Coverage gap closed: the /api/ws/chat upgrade path itself (auth gate, 503
// when the chat service is absent, dispatch into handleUpgrade). Prior suites
// exercised the bridge service directly and left this routing untested.
const createBridge = ({ isAuthorizedRequest, chatWsService }) => {
  const server = new EventEmitter();
  const proxied = [];
  const proxy = {
    ws: vi.fn((req) => {
      proxied.push({ url: req.url });
    }),
  };
  createWatchdogTerminalWsBridge({
    server,
    proxy,
    getGatewayUrl: () => "http://127.0.0.1:18789",
    isAuthorizedRequest,
    watchdogTerminal: { createOrReuseSession: () => null, subscribe: () => ({}) },
    chatWsService,
    resolveProxyIdentity: () => null,
  });
  return { server, proxied };
};

const createSocket = () => ({ write: vi.fn(), destroy: vi.fn() });

const chatUpgradeReq = () => ({
  url: "/api/ws/chat",
  headers: { host: "localhost" },
});

describe("server/watchdog-terminal-ws /api/ws/chat upgrade routing", () => {
  it("rejects an unauthorized chat upgrade with 401 and destroys the socket", () => {
    const handleUpgrade = vi.fn();
    const { server, proxied } = createBridge({
      isAuthorizedRequest: () => false,
      chatWsService: { handleUpgrade },
    });
    const socket = createSocket();
    server.emit("upgrade", chatUpgradeReq(), socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining("401 Unauthorized"),
    );
    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
    // Never falls through to the catch-all gateway proxy.
    expect(proxied).toHaveLength(0);
  });

  it("dispatches an authorized chat upgrade into the chat service", () => {
    const handleUpgrade = vi.fn();
    const { server, proxied } = createBridge({
      isAuthorizedRequest: () => true,
      chatWsService: { handleUpgrade },
    });
    const socket = createSocket();
    server.emit("upgrade", chatUpgradeReq(), socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.write).not.toHaveBeenCalled();
    expect(proxied).toHaveLength(0);
  });

  it("answers 503 when the chat service is unavailable instead of proxying", () => {
    const { server, proxied } = createBridge({
      isAuthorizedRequest: () => true,
      chatWsService: null,
    });
    const socket = createSocket();
    server.emit("upgrade", chatUpgradeReq(), socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(
      expect.stringContaining("503 Service Unavailable"),
    );
    expect(socket.destroy).toHaveBeenCalled();
    expect(proxied).toHaveLength(0);
  });
});
