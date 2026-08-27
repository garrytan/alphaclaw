const {
  kStrippedInboundHeaders,
  stripInboundForwardedHeaders,
  stripForwardedHeadersFromProxyReq,
} = require("../../lib/server/utils/forwarded-headers");

describe("server/utils/forwarded-headers", () => {
  it("strips all forwarding and identity headers, keeps the rest", () => {
    const out = stripInboundForwardedHeaders({
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      forwarded: "for=1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "x-alphaclaw-user": "attacker@example.com",
      "x-openclaw-scopes": "operator.admin",
      "content-type": "application/json",
      authorization: "Bearer keep-me",
    });
    expect(out).toEqual({
      "content-type": "application/json",
      authorization: "Bearer keep-me",
    });
  });

  it("is case-insensitive on header names", () => {
    const out = stripInboundForwardedHeaders({
      "X-Forwarded-For": "1.2.3.4",
      "X-Alphaclaw-User": "attacker@example.com",
      "Content-Type": "text/plain",
    });
    expect(out).toEqual({ "Content-Type": "text/plain" });
  });

  it("blocks the identity spoof header specifically", () => {
    expect(kStrippedInboundHeaders).toContain("x-alphaclaw-user");
    expect(kStrippedInboundHeaders).toContain("x-openclaw-scopes");
  });

  it("removes every stripped header from an http.ClientRequest-like object", () => {
    const removed = [];
    const proxyReq = { removeHeader: (name) => removed.push(name) };
    stripForwardedHeadersFromProxyReq(proxyReq);
    for (const name of kStrippedInboundHeaders) {
      expect(removed).toContain(name);
    }
  });

  it("is a no-op on a malformed proxyReq", () => {
    expect(() => stripForwardedHeadersFromProxyReq(null)).not.toThrow();
    expect(() => stripForwardedHeadersFromProxyReq({})).not.toThrow();
  });
});
