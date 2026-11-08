const path = require("path");
const { spawnSync } = require("child_process");

const kModulePath = "../../lib/server/login-client-ip";
const kTrustProxyHopsEnvKey = "TRUST_PROXY_HOPS";
const loadResolver = () => {
  delete require.cache[require.resolve("../../lib/server/constants")];
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

// Boots the way bin/alphaclaw.js does: constants.js (and Express's trust
// proxy) is read before .env is loaded, then the .env overlay lands in
// process.env and the sign-in limiter is required. Returns the limiter's key
// for a public peer that sends a forged X-Forwarded-For.
const keyAfterEnvFileLoad = (envFileText) => {
  const root = path.join(__dirname, "..", "..", "lib", "server");
  const script = `
    const express = require("express");
    const { kTrustProxyHops } = require(${JSON.stringify(path.join(root, "constants.js"))});
    const { parseEnvFileContent } = require(${JSON.stringify(path.join(root, "utils", "env-file-format.js"))});
    const { resolveEnvFileOverlay } = require(${JSON.stringify(path.join(root, "deployment-only-env.js"))});
    const entries = parseEnvFileContent(${JSON.stringify(envFileText)}).map(({ key, value }) => ({ key, value }));
    for (const [key, value] of resolveEnvFileOverlay(entries)) process.env[key] = value;
    const { resolveLoginClientIp } = require(${JSON.stringify(path.join(root, "login-client-ip.js"))});
    const app = express();
    app.set("trust proxy", kTrustProxyHops);
    const req = Object.create(app.request);
    req.app = app;
    req.headers = { "x-forwarded-for": "203.0.113.9" };
    req.socket = req.connection = { remoteAddress: "198.51.100.7" };
    process.stdout.write(resolveLoginClientIp(req));
  `;
  const env = { ...process.env };
  delete env[kTrustProxyHopsEnvKey];
  const run = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
};

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

  it("a TRUST_PROXY_HOPS that is not a whole number counts as not set", () => {
    for (const value of ["yes", "-1", "1.5"]) {
      process.env[kTrustProxyHopsEnvKey] = value;
      const resolve = loadResolver();
      expect(resolve(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" })), value).toBe("198.51.100.7");
    }
    process.env[kTrustProxyHopsEnvKey] = "2";
    expect(loadResolver()(fakeRequest({ peer: "198.51.100.7", ip: "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("a TRUST_PROXY_HOPS set only in .env does not make the limiter trust a forged X-Forwarded-For", () => {
    expect(keyAfterEnvFileLoad("TRUST_PROXY_HOPS=0\n")).toBe("198.51.100.7");
    expect(keyAfterEnvFileLoad("TRUST_PROXY_HOPS=2\n")).toBe("198.51.100.7");
    expect(keyAfterEnvFileLoad("")).toBe("198.51.100.7");
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
    expect(loginLimiterKey("::1")).toBe("0:0:0:0:0:0:0:1");
    expect(loginLimiterKey("64:ff9b:2::192.0.2.1")).toBe("64:ff9b:2:0::/64");
    expect(loginLimiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(loginLimiterKey("198.51.100.7")).toBe("198.51.100.7");
    expect(loginLimiterKey("unknown")).toBe("unknown");
  });

  it("keys addresses inside ::/64 one by one instead of as one network", () => {
    const { loginLimiterKey } = require(kModulePath);
    const keys = ["::", "::1", "::192.0.2.1", "::192.0.2.2", "::1:2"].map(loginLimiterKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(loginLimiterKey("::192.0.2.1")).toBe(loginLimiterKey("0:0:0:0:0:0:c000:201"));
  });

  it("keys an IPv4-mapped or NAT64 address on its embedded IPv4", () => {
    const { loginLimiterKey } = require(kModulePath);
    for (const notation of [
      "198.51.100.7",
      "::ffff:198.51.100.7",
      "::ffff:c633:6407",
      "::FFFF:C633:6407",
      "0000:0000:0000:0000:0000:ffff:c633:6407",
      "0:0:0:0:0:FFFF:198.51.100.7",
      "64:ff9b::198.51.100.7",
      "64:FF9B::C633:6407",
      "0064:ff9b:0000:0000:0000:0000:c633:6407",
      "64:ff9b:1::198.51.100.7",
    ]) {
      expect(loginLimiterKey(notation), notation).toBe("198.51.100.7");
    }
    expect(loginLimiterKey("64:ff9b:1:102:3:400::")).toBe("64:ff9b:1:102::/64");
    expect(loginLimiterKey("64:ff9b:1:abcd::c633:6407")).toBe("64:ff9b:1:abcd::/64");
    for (const prefix of ["::ffff:", "64:ff9b::", "64:ff9b:1::"]) {
      expect(loginLimiterKey(prefix + "198.51.100.7")).not.toBe(loginLimiterKey(prefix + "198.51.100.8"));
      expect(loginLimiterKey(prefix + "198.51.100.7")).not.toBe(loginLimiterKey(prefix + "203.0.113.7"));
    }
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
    expect(warnings()[0]).toContain(
      "set TRUST_PROXY_HOPS=0 if nothing sits in front; set it to the number of proxies otherwise",
    );

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
