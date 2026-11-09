const { decideGatewayPublicOrigin } = require("../../lib/server/gateway-public-origin");
const { resolveConfiguredOrigin } = require("../../lib/server/public-origin");

describe("gateway.publicOrigin decision", () => {
  it("writes an https setup origin when none is set", () => {
    expect(decideGatewayPublicOrigin({ gateway: {} }, "https://box.example.com")).toEqual({ write: "https://box.example.com", reason: null });
  });

  it("writes http only for a literal loopback host", () => {
    expect(decideGatewayPublicOrigin({}, "http://localhost:3000").write).toBe("http://localhost:3000");
    expect(decideGatewayPublicOrigin({}, "http://127.0.0.1:3000").write).toBe("http://127.0.0.1:3000");
    expect(decideGatewayPublicOrigin({}, "http://[::1]:3000").write).toBe("http://[::1]:3000");
    const lan = decideGatewayPublicOrigin({}, "http://192.168.1.20:3000");
    expect(lan.write).toBeNull();
    expect(lan.reason).toMatch(/not https/);
  });

  it("skips when no setup URL is configured", () => {
    const decision = decideGatewayPublicOrigin({ gateway: {} }, "");
    expect(decision.write).toBeNull();
    expect(decision.reason).toMatch(/no setup URL/);
    expect(resolveConfiguredOrigin({})).toBeFalsy();
  });

  it("never overwrites a value already there", () => {
    expect(decideGatewayPublicOrigin({ gateway: { publicOrigin: "https://other.example.com" } }, "https://box.example.com")).toEqual({ write: null, reason: "already_set" });
  });

  it("skips a setup URL with a path, and one under the portal ingress domain", () => {
    expect(decideGatewayPublicOrigin({}, "https://example.com/alphaclaw").reason).toMatch(/path/);
    const cfg = { gateway: { portals: { ingress: { domain: "Portals.Example.com", port: 8443 } } } };
    expect(decideGatewayPublicOrigin(cfg, "https://box.portals.example.com").reason).toMatch(/portals.ingress/);
    expect(decideGatewayPublicOrigin(cfg, "https://portals.example.com").write).toBeNull();
    expect(decideGatewayPublicOrigin(cfg, "https://box.example.com").write).toBe("https://box.example.com");
  });

  it("reads the configured setup URL from the environment, not a request", () => {
    expect(resolveConfiguredOrigin({ ALPHACLAW_SETUP_URL: "https://box.example.com/" })).toBe("https://box.example.com");
  });
});
