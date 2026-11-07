const kModulePath = "../../lib/server/login-client-ip";
const kTrustProxyHopsEnvKey = "TRUST_PROXY_HOPS";
const loadResolver = () => {
  delete require.cache[require.resolve(kModulePath)];
  return require(kModulePath).resolveLoginClientIp;
};

let savedTrustProxyHops;
beforeEach(() => {
  savedTrustProxyHops = process.env[kTrustProxyHopsEnvKey];
  delete process.env[kTrustProxyHopsEnvKey];
});
afterEach(() => {
  if (savedTrustProxyHops === undefined) delete process.env[kTrustProxyHopsEnvKey];
  else process.env[kTrustProxyHopsEnvKey] = savedTrustProxyHops;
});

const fakeRequest = ({ peer, ip }) => ({ socket: { remoteAddress: peer }, ip });

describe("server/login-client-ip", () => {
  it("uses the socket address and ignores a forged X-Forwarded-For when the peer is public", () => {
    const resolveLoginClientIp = loadResolver();
    expect(resolveLoginClientIp(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }))).toBe("198.51.100.7");
    expect(resolveLoginClientIp(fakeRequest({ peer: "::ffff:198.51.100.7", ip: "203.0.113.9" }))).toBe("198.51.100.7");
    expect(resolveLoginClientIp(fakeRequest({ peer: "2001:db8::5", ip: "203.0.113.9" }))).toBe("2001:db8::5");
  });

  it("takes the hop-counted req.ip when the peer is a loopback or private proxy hop", () => {
    const resolveLoginClientIp = loadResolver();
    for (const peer of [
      "127.0.0.1",
      "::1",
      "::ffff:10.1.2.3",
      "172.20.0.5",
      "192.168.1.2",
      "100.64.3.4",
      "169.254.10.1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(resolveLoginClientIp(fakeRequest({ peer, ip: "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
    }
  });

  it("does not treat public neighbours of the private ranges as proxy hops", () => {
    const resolveLoginClientIp = loadResolver();
    for (const peer of ["172.32.0.1", "172.15.255.1", "100.128.0.1", "11.0.0.1", "192.169.0.1"]) {
      expect(resolveLoginClientIp(fakeRequest({ peer, ip: "203.0.113.9" }))).toBe(peer);
    }
  });

  it("an explicitly set TRUST_PROXY_HOPS trusts the declared proxy chain from a public peer", () => {
    process.env[kTrustProxyHopsEnvKey] = "1";
    const declared = loadResolver();
    expect(declared(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }))).toBe("203.0.113.9");
    expect(declared(fakeRequest({ peer: "10.0.0.2", ip: "203.0.113.9" }))).toBe("203.0.113.9");

    delete process.env[kTrustProxyHopsEnvKey];
    const unset = loadResolver();
    expect(unset(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }))).toBe("198.51.100.7");

    process.env[kTrustProxyHopsEnvKey] = "  ";
    const blank = loadResolver();
    expect(blank(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }))).toBe("198.51.100.7");
  });

  it("keys IPv6 addresses on their /64 for the limiter and leaves IPv4 alone", () => {
    const { loginLimiterKey } = require(kModulePath);
    expect(loginLimiterKey("2001:db8:aa:bb::1")).toBe("2001:db8:aa:bb::/64");
    expect(loginLimiterKey("2001:0db8:00aa:00bb:ffff:1:2:3")).toBe("2001:db8:aa:bb::/64");
    expect(loginLimiterKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(loginLimiterKey("::1")).toBe("0:0:0:0::/64");
    expect(loginLimiterKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(loginLimiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(loginLimiterKey("198.51.100.7")).toBe("198.51.100.7");
    expect(loginLimiterKey("unknown")).toBe("unknown");
  });

  it("warns once per process when TRUST_PROXY_HOPS is unset and a public peer signs in", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warnings = () => warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("TRUST_PROXY_HOPS"));

    let resolve = loadResolver();
    resolve(fakeRequest({ peer: "10.0.0.2", ip: "203.0.113.9" }));
    expect(warnings()).toHaveLength(0);
    resolve(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }));
    resolve(fakeRequest({ peer: "198.51.100.8", ip: "203.0.113.9" }));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).not.toMatch(/198\.51\.100|203\.0\.113/);

    warn.mockClear();
    process.env[kTrustProxyHopsEnvKey] = "1";
    resolve = loadResolver();
    resolve(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }));
    expect(warnings()).toHaveLength(0);
    warn.mockRestore();
  });

  it("falls back to the peer when a proxy hop sent no forwarded address, and to unknown without a peer", () => {
    const resolveLoginClientIp = loadResolver();
    expect(resolveLoginClientIp(fakeRequest({ peer: "10.0.0.2", ip: "" }))).toBe("10.0.0.2");
    expect(resolveLoginClientIp(fakeRequest({ peer: "", ip: "203.0.113.9" }))).toBe("unknown");
    expect(resolveLoginClientIp({})).toBe("unknown");
  });
});
