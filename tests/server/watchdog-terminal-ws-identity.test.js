const { EventEmitter } = require("events");

const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");
const { kIdentityUserHeader } = require("../../lib/server/proxy-identity");

const createBridge = ({ resolveProxyIdentity }) => {
  const server = new EventEmitter();
  const proxied = [];
  const proxy = {
    ws: vi.fn((req) => {
      proxied.push({ url: req.url, headers: { ...req.headers } });
    }),
  };
  createWatchdogTerminalWsBridge({
    server,
    proxy,
    getGatewayUrl: () => "http://127.0.0.1:18789",
    isAuthorizedRequest: () => true,
    watchdogTerminal: { createOrReuseSession: () => null, subscribe: () => ({}) },
    chatWsService: null,
    resolveProxyIdentity,
  });
  return { server, proxy, proxied };
};

const createSocket = () => ({ write: vi.fn(), destroy: vi.fn() });

describe("server/watchdog-terminal-ws catch-all proxy identity", () => {
  it("always strips inbound identity headers and the setup_token cookie", () => {
    const { server, proxied } = createBridge({
      resolveProxyIdentity: () => null,
    });
    const req = {
      url: "/some/gateway/ws",
      headers: {
        host: "localhost",
        [kIdentityUserHeader]: "attacker",
        "x-forwarded-user": "attacker@example.com",
        cookie: "setup_token=abc; theme=dark",
      },
    };
    server.emit("upgrade", req, createSocket(), Buffer.alloc(0));
    expect(proxied).toHaveLength(1);
    expect(proxied[0].headers[kIdentityUserHeader]).toBeUndefined();
    expect(proxied[0].headers["x-forwarded-user"]).toBeUndefined();
    expect(proxied[0].headers.cookie).toBe("theme=dark");
  });

  it("injects the operator identity when the session resolves", () => {
    const { server, proxied } = createBridge({
      resolveProxyIdentity: () => ({ id: "garry" }),
    });
    const req = {
      url: "/openclaw/ws",
      headers: {
        host: "localhost",
        cookie: "setup_token=abc",
        [kIdentityUserHeader]: "attacker",
      },
    };
    server.emit("upgrade", req, createSocket(), Buffer.alloc(0));
    expect(proxied).toHaveLength(1);
    expect(proxied[0].headers[kIdentityUserHeader]).toBe("garry");
    expect(proxied[0].headers.cookie).toBeUndefined();
  });

  it("still proxies when identity resolution throws", () => {
    const { server, proxied } = createBridge({
      resolveProxyIdentity: () => {
        throw new Error("boom");
      },
    });
    server.emit(
      "upgrade",
      { url: "/ws", headers: { host: "localhost" } },
      createSocket(),
      Buffer.alloc(0),
    );
    expect(proxied).toHaveLength(1);
    expect(proxied[0].headers[kIdentityUserHeader]).toBeUndefined();
  });
});
