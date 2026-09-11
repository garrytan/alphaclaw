const {
  kA2aPathPattern,
  kAgentCardPathPattern,
  createIsProxiedPath,
} = require("../../lib/server/routes/proxy");

// The gateway listens on container loopback only, so the front-door proxy is
// the sole route to an enabled A2A channel. These paths must both match a
// forwarding route and be treated as proxied paths, or the body parser
// consumes the JSON-RPC request and the gateway hangs on an empty stream.
describe("A2A proxy paths", () => {
  const isProxiedPath = createIsProxiedPath(["/api/setup"]);
  const proxied = (path) => isProxiedPath({ path });

  it("matches the documented JSON-RPC endpoint", () => {
    expect(kA2aPathPattern.test("/a2a/v1")).toBe(true);
    expect(proxied("/a2a/v1")).toBe(true);
  });

  it("matches both Agent Card discovery spellings", () => {
    // docs/channels/a2a.md serves the modern name and keeps agent.json for
    // older A2A clients.
    expect(kAgentCardPathPattern.test("/.well-known/agent-card.json")).toBe(true);
    expect(kAgentCardPathPattern.test("/.well-known/agent.json")).toBe(true);
    expect(proxied("/.well-known/agent-card.json")).toBe(true);
    expect(proxied("/.well-known/agent.json")).toBe(true);
  });

  // Negative controls: the patterns must not widen the proxied surface.
  it("does not match a bare or look-alike a2a path", () => {
    expect(kA2aPathPattern.test("/a2a")).toBe(false);
    expect(kA2aPathPattern.test("/a2away/v1")).toBe(false);
    expect(proxied("/a2a")).toBe(false);
  });

  it("does not match other well-known paths", () => {
    expect(kAgentCardPathPattern.test("/.well-known/openid-configuration")).toBe(
      false,
    );
    expect(kAgentCardPathPattern.test("/.well-known/agent-card.json.bak")).toBe(
      false,
    );
    expect(proxied("/.well-known/openid-configuration")).toBe(false);
  });

  it("leaves the existing predicate behaviour intact", () => {
    expect(proxied("/openclaw")).toBe(true);
    expect(proxied("/openclaw/anything")).toBe(true);
    expect(proxied("/assets/app.js")).toBe(true);
    expect(proxied("/api/gateway/restart")).toBe(true);
    expect(proxied("/api/setup/status")).toBe(false);
    expect(proxied("/login.html")).toBe(false);
  });
});
