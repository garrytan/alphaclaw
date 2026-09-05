const { EventEmitter } = require("events");

const {
  createWatchdogTerminalWsBridge,
} = require("../../lib/server/watchdog-terminal-ws");
const { kIdentityUserHeader } = require("../../lib/server/proxy-identity");

const createBridge = ({
  resolveProxyIdentity,
  isAuthorizedRequest = vi.fn(() => true),
}) => {
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
    isAuthorizedRequest,
    watchdogTerminal: { createOrReuseSession: () => null, subscribe: () => ({}) },
    chatWsService: null,
    resolveProxyIdentity,
  });
  return { server, proxy, proxied, isAuthorizedRequest };
};

const createSocket = (overrides = {}) => ({
  write: vi.fn(),
  destroy: vi.fn(),
  on: vi.fn(),
  ...overrides,
});

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

// Fix wave F009/F204: the upgrade handler runs pre-auth for every client on
// the network. A malformed Host header or request-target used to throw
// ERR_INVALID_URL out of the 'upgrade' listener — an uncaughtException that
// gracefulExit(1)'d the whole server.
describe("server/watchdog-terminal-ws malformed upgrade requests (pre-auth crash)", () => {
  const malformed = [
    ["Host with a space", { url: "/openclaw/ws", headers: { host: "a b" } }],
    ["unterminated IPv6 Host", { url: "/openclaw/ws", headers: { host: "[::1" } }],
    ["protocol-relative bad request-target", { url: "//[", headers: { host: "localhost" } }],
  ];

  for (const [label, req] of malformed) {
    it(`answers 400 and destroys the socket instead of throwing (${label})`, () => {
      const { server, proxy, isAuthorizedRequest } = createBridge({
        resolveProxyIdentity: () => null,
      });
      const socket = createSocket();
      expect(() => server.emit("upgrade", req, socket, Buffer.alloc(0))).not.toThrow();
      expect(socket.write).toHaveBeenCalledTimes(1);
      expect(String(socket.write.mock.calls[0][0])).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(proxy.ws).not.toHaveBeenCalled();
      // Rejected BEFORE any auth work: the auth hook never sees the request.
      expect(isAuthorizedRequest).not.toHaveBeenCalled();
    });
  }

  it("attaches a socket error listener before anything else (EPIPE is no longer fatal)", () => {
    const { server } = createBridge({ resolveProxyIdentity: () => null });
    const socket = createSocket();
    server.emit(
      "upgrade",
      { url: "/openclaw/ws", headers: { host: "localhost" } },
      socket,
      Buffer.alloc(0),
    );
    expect(socket.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(() => socket.on.mock.calls[0][1](new Error("EPIPE"))).not.toThrow();
  });

  it("does not throw when the 400 write itself fails on a dead socket", () => {
    const { server } = createBridge({ resolveProxyIdentity: () => null });
    const socket = createSocket({
      write: vi.fn(() => {
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
      }),
    });
    expect(() =>
      server.emit("upgrade", { url: "/ws", headers: { host: "a b" } }, socket, Buffer.alloc(0)),
    ).not.toThrow();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it("still proxies a well-formed upgrade (control)", () => {
    const { server, proxy } = createBridge({ resolveProxyIdentity: () => null });
    const socket = createSocket();
    server.emit(
      "upgrade",
      { url: "/openclaw/ws", headers: { host: "example.com:3000" } },
      socket,
      Buffer.alloc(0),
    );
    expect(proxy.ws).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
