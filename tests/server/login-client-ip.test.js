const kModulePath = "../../lib/server/login-client-ip";
const loadResolver = () => require(kModulePath).resolveLoginClientIp;

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

  it("falls back to the peer when a proxy hop sent no forwarded address, and to unknown without a peer", () => {
    const resolveLoginClientIp = loadResolver();
    expect(resolveLoginClientIp(fakeRequest({ peer: "10.0.0.2", ip: "" }))).toBe("10.0.0.2");
    expect(resolveLoginClientIp(fakeRequest({ peer: "", ip: "203.0.113.9" }))).toBe("unknown");
    expect(resolveLoginClientIp({})).toBe("unknown");
  });
});
