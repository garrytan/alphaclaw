const {
  applyProxyIdentity,
  buildIdentityHeaders,
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
  });
});
