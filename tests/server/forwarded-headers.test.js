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

describe("server/utils/forwarded-headers identity injection (4.3)", () => {
  const {
    resolveWsClientIp,
    applyIdentityProxyHeaders,
  } = require("../../lib/server/utils/forwarded-headers");

  const makeProxyReq = () => {
    const headers = {};
    return {
      headers,
      setHeader: (name, value) => {
        headers[String(name).toLowerCase()] = value;
      },
      removeHeader: (name) => {
        delete headers[String(name).toLowerCase()];
      },
    };
  };

  it("resolves the WS client IP with Express trust-proxy hop semantics (C5)", () => {
    // No trusted hops: the socket peer is the client; XFF is untrusted noise.
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "6.6.6.6",
        trustProxyHops: 0,
      }),
    ).toBe("10.0.0.9");
    // One trusted hop (Render/Railway ingress): rightmost XFF entry is real.
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "203.0.113.7",
        trustProxyHops: 1,
      }),
    ).toBe("203.0.113.7");
    // Attacker-prepended entries beyond the trusted hops are never read.
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "6.6.6.6, 203.0.113.7",
        trustProxyHops: 1,
      }),
    ).toBe("203.0.113.7");
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "6.6.6.6, 198.51.100.4, 203.0.113.7",
        trustProxyHops: 2,
      }),
    ).toBe("198.51.100.4");
    // More trusted hops than entries → leftmost available; empty XFF → socket.
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "203.0.113.7",
        trustProxyHops: 5,
      }),
    ).toBe("203.0.113.7");
    expect(
      resolveWsClientIp({
        remoteAddress: "10.0.0.9",
        xForwardedFor: "",
        trustProxyHops: 2,
      }),
    ).toBe("10.0.0.9");
  });

  it("injects the identity header + rebuilt XFF for member identities only", () => {
    const proxyReq = makeProxyReq();
    const injected = applyIdentityProxyHeaders({
      proxyReq,
      identity: { kind: "member", email: "m@example.com", role: "member" },
      clientIp: "203.0.113.7",
    });
    expect(injected).toBe(true);
    expect(proxyReq.headers["x-alphaclaw-user"]).toBe("m@example.com");
    expect(proxyReq.headers["x-forwarded-for"]).toBe("203.0.113.7");

    // Legacy sessions inject nothing — pre-team behavior exactly.
    const legacyReq = makeProxyReq();
    expect(
      applyIdentityProxyHeaders({
        proxyReq: legacyReq,
        identity: { kind: "legacy", role: "admin", email: null },
        clientIp: "203.0.113.7",
      }),
    ).toBe(false);
    expect(legacyReq.headers).toEqual({});

    expect(
      applyIdentityProxyHeaders({ proxyReq: makeProxyReq(), identity: null }),
    ).toBe(false);
  });

  it("tolerates a proxyReq whose headers were already flushed", () => {
    const proxyReq = {
      setHeader: () => {
        throw new Error("Cannot set headers after they are sent");
      },
    };
    expect(
      applyIdentityProxyHeaders({
        proxyReq,
        identity: { kind: "member", email: "m@example.com" },
        clientIp: "1.2.3.4",
      }),
    ).toBe(false);
  });
});
