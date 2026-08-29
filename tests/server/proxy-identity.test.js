const {
  applyProxyIdentity,
  buildIdentityHeaders,
  kForwardedEvidenceHeaders,
  kIdentityUserHeader,
  sanitizeProxyHeaders,
  stripSessionCookie,
} = require("../../lib/server/proxy-identity");

describe("server/proxy-identity", () => {
  describe("sanitizeProxyHeaders", () => {
    it("strips identity headers regardless of team mode", () => {
      const sanitized = sanitizeProxyHeaders({
        host: "example.com",
        "x-alphaclaw-user": "spoofed",
        "x-forwarded-user": "spoofed@example.com",
        "x-auth-request-email": "spoofed@example.com",
        "x-pomerium-claim-email": "spoofed@example.com",
        "x-pomerium-jwt-assertion": "jwt",
        "x-openclaw-scopes": "operator.admin",
        accept: "application/json",
      });
      expect(sanitized).toEqual({
        host: "example.com",
        accept: "application/json",
      });
    });

    it("strips mixed-case identity header names", () => {
      const sanitized = sanitizeProxyHeaders({
        "X-AlphaClaw-User": "spoofed",
        "X-Forwarded-User": "spoofed",
        accept: "*/*",
      });
      expect(sanitized).toEqual({ accept: "*/*" });
    });

    it("removes the cookie header entirely when setup_token is the only cookie", () => {
      const sanitized = sanitizeProxyHeaders({
        cookie: "setup_token=abc.def",
        accept: "*/*",
      });
      expect(sanitized).toEqual({ accept: "*/*" });
    });

    it("keeps other cookies intact when removing setup_token", () => {
      const sanitized = sanitizeProxyHeaders({
        cookie: "theme=dark; setup_token=abc.def; other=1",
      });
      expect(sanitized.cookie).toBe("theme=dark; other=1");
    });

    it("leaves a cookie header without setup_token untouched", () => {
      const sanitized = sanitizeProxyHeaders({ cookie: "theme=dark; a=b" });
      expect(sanitized.cookie).toBe("theme=dark; a=b");
    });

    it("does not mutate the input headers object", () => {
      const original = {
        "x-alphaclaw-user": "spoofed",
        cookie: "setup_token=abc",
      };
      sanitizeProxyHeaders(original);
      expect(original["x-alphaclaw-user"]).toBe("spoofed");
      expect(original.cookie).toBe("setup_token=abc");
    });

    it("tolerates missing/invalid input", () => {
      expect(sanitizeProxyHeaders()).toEqual({});
      expect(sanitizeProxyHeaders(null)).toEqual({});
    });

    it("is identity-only: leaves forwarded-evidence and other headers intact", () => {
      const sanitized = sanitizeProxyHeaders({
        "x-alphaclaw-user": "spoofed",
        "x-openclaw-scopes": "operator.admin",
        "x-forwarded-for": "203.0.113.7",
        forwarded: "for=203.0.113.7",
        "x-real-ip": "203.0.113.7",
        "user-agent": "test-agent",
        accept: "application/json",
      });
      expect(sanitized).toEqual({
        "x-forwarded-for": "203.0.113.7",
        forwarded: "for=203.0.113.7",
        "x-real-ip": "203.0.113.7",
        "user-agent": "test-agent",
        accept: "application/json",
      });
    });
  });

  describe("kForwardedEvidenceHeaders", () => {
    it("is exported and includes the forwarded-evidence header names", () => {
      expect(Array.isArray(kForwardedEvidenceHeaders)).toBe(true);
      expect(kForwardedEvidenceHeaders).toContain("x-forwarded-for");
      expect(kForwardedEvidenceHeaders).toContain("forwarded");
      expect(kForwardedEvidenceHeaders).toContain("x-real-ip");
    });

    it("pins the full evidence list, including x-forwarded-server/-port/-host (merge resolution)", () => {
      expect([...kForwardedEvidenceHeaders].sort()).toEqual([
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
        "x-forwarded-server",
        "x-real-ip",
      ]);
    });
  });

  describe("stripSessionCookie", () => {
    it("keeps cookies whose value contains setup_token-like text", () => {
      expect(stripSessionCookie("note=setup_token; setup_token=x")).toBe(
        "note=setup_token",
      );
    });
    it("returns empty string for empty input", () => {
      expect(stripSessionCookie("")).toBe("");
      expect(stripSessionCookie(undefined)).toBe("");
    });
  });

  describe("buildIdentityHeaders", () => {
    it("returns the user header for an operator", () => {
      expect(buildIdentityHeaders({ id: "garry" })).toEqual({
        [kIdentityUserHeader]: "garry",
      });
    });

    it("prefers the member EMAIL over the id — allowUsers/identityScopes are keyed by email", () => {
      expect(
        buildIdentityHeaders({ email: "garry@example.com", id: "m_1" }),
      ).toEqual({ [kIdentityUserHeader]: "garry@example.com" });
      // An absent email falls back to the id (transition probes pass { id }).
      expect(buildIdentityHeaders({ email: "", id: "m_1" })).toEqual({
        [kIdentityUserHeader]: "m_1",
      });
    });

    it("returns no headers without an operator", () => {
      expect(buildIdentityHeaders(null)).toEqual({});
      expect(buildIdentityHeaders({})).toEqual({});
      expect(buildIdentityHeaders({ id: "  " })).toEqual({});
    });
  });

  describe("applyProxyIdentity", () => {
    it("injects identity only when an operator is resolved", () => {
      const req = { headers: { accept: "*/*" } };
      applyProxyIdentity(req, { id: "op-1" });
      expect(req.headers[kIdentityUserHeader]).toBe("op-1");
    });

    it("does not inject identity for anonymous sessions (team off or unresolved)", () => {
      const req = { headers: { accept: "*/*" } };
      applyProxyIdentity(req, null);
      expect(req.headers[kIdentityUserHeader]).toBeUndefined();
    });

    it("never lets a spoofed inbound identity header pass through (regression)", () => {
      const req = {
        headers: {
          [kIdentityUserHeader]: "attacker",
          "x-forwarded-user": "attacker@example.com",
          cookie: "setup_token=session-token",
        },
      };
      applyProxyIdentity(req, null);
      expect(req.headers[kIdentityUserHeader]).toBeUndefined();
      expect(req.headers["x-forwarded-user"]).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
    });

    it("replaces a spoofed identity header with the resolved operator", () => {
      const req = { headers: { [kIdentityUserHeader]: "attacker" } };
      applyProxyIdentity(req, { id: "real-operator" });
      expect(req.headers[kIdentityUserHeader]).toBe("real-operator");
    });

    it("ALWAYS strips client-supplied forwarded-evidence, member or not (1.10)", () => {
      for (const member of [null, { email: "m@example.com" }]) {
        const req = {
          headers: {
            "x-forwarded-for": "203.0.113.7",
            forwarded: "for=203.0.113.7",
            "x-real-ip": "203.0.113.7",
            "x-forwarded-host": "evil.example.com",
            accept: "*/*",
          },
        };
        applyProxyIdentity(req, member, member ? "198.51.100.9" : "");
        expect(req.headers.forwarded).toBeUndefined();
        expect(req.headers["x-real-ip"]).toBeUndefined();
        expect(req.headers["x-forwarded-host"]).toBeUndefined();
        expect(req.headers.accept).toBe("*/*");
      }
    });

    it("rebuilds X-Forwarded-For from the resolved client IP for a member (4.3/C5)", () => {
      const req = { headers: { "x-forwarded-for": "203.0.113.7" } };
      applyProxyIdentity(req, { email: "m@example.com" }, "198.51.100.9");
      // Client-supplied XFF is dropped; the trusted, resolved IP is injected.
      expect(req.headers["x-forwarded-for"]).toBe("198.51.100.9");
      expect(req.headers[kIdentityUserHeader]).toBe("m@example.com");
    });

    it("does not inject X-Forwarded-For for an anonymous (local-direct) request", () => {
      const req = { headers: { "x-forwarded-for": "203.0.113.7" } };
      applyProxyIdentity(req, null, "198.51.100.9");
      // Anonymous → gateway sees a clean loopback local-direct caller.
      expect(req.headers["x-forwarded-for"]).toBeUndefined();
    });
  });

  describe("resolveWsClientIp", () => {
    const { resolveWsClientIp } = require("../../lib/server/proxy-identity");

    it("returns remoteAddress when there is no forwarded chain", () => {
      expect(
        resolveWsClientIp({ remoteAddress: "10.0.0.1", xForwardedFor: "" }),
      ).toBe("10.0.0.1");
    });

    it("walks the chain past the trusted hop count", () => {
      // client -> ingress(trusted 1 hop). XFF = "client, ingress"; remote =
      // the local proxy. With 1 trusted hop the client is the last-but-one.
      expect(
        resolveWsClientIp({
          remoteAddress: "127.0.0.1",
          xForwardedFor: "203.0.113.7, 198.51.100.9",
          trustProxyHops: 1,
        }),
      ).toBe("198.51.100.9");
    });

    it("returns the leftmost when hops exceed the chain length", () => {
      expect(
        resolveWsClientIp({
          remoteAddress: "127.0.0.1",
          xForwardedFor: "203.0.113.7",
          trustProxyHops: 9,
        }),
      ).toBe("203.0.113.7");
    });
  });
});
