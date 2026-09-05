const {
  normalizeOrigin,
  resolveConfiguredOrigin,
  resolveRequestOrigin,
  resolvePublicOrigin,
  requestTrustsProxy,
  isLocalhostOrigin,
} = require("../../lib/server/public-origin");

const trustedApp = { get: (key) => (key === "trust proxy fn" ? () => true : undefined) };
const untrustedApp = { get: (key) => (key === "trust proxy fn" ? () => false : undefined) };
const kEmptyEnv = {};

describe("server/public-origin (one resolver for persisted + handed-out URLs, PR 8a)", () => {
  it("normalizeOrigin keeps scheme+host(+port) and a base path, drops trailing slashes and non-http schemes", () => {
    expect(normalizeOrigin("https://claw.example.com/")).toBe("https://claw.example.com");
    expect(normalizeOrigin("https://claw.example.com:8443/alphaclaw/")).toBe(
      "https://claw.example.com:8443/alphaclaw",
    );
    expect(normalizeOrigin("http://h:1")).toBe("http://h:1");
    expect(normalizeOrigin("javascript:alert(1)")).toBe("");
    expect(normalizeOrigin("not a url")).toBe("");
    expect(normalizeOrigin("")).toBe("");
  });

  it("resolveConfiguredOrigin: explicit keys in order, then Railway variables, else empty", () => {
    expect(resolveConfiguredOrigin(kEmptyEnv)).toBe("");
    expect(
      resolveConfiguredOrigin({ URL: "https://url.example", RENDER_EXTERNAL_URL: "https://render.example" }),
    ).toBe("https://render.example");
    expect(
      resolveConfiguredOrigin({
        ALPHACLAW_SETUP_URL: "https://setup.example/",
        ALPHACLAW_BASE_URL: "https://base.example",
      }),
    ).toBe("https://setup.example");
    expect(resolveConfiguredOrigin({ RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" })).toBe(
      "https://app.up.railway.app",
    );
    expect(resolveConfiguredOrigin({ RAILWAY_STATIC_URL: "https://static.example/" })).toBe(
      "https://static.example",
    );
    // A malformed explicit value is ignored rather than persisted.
    expect(resolveConfiguredOrigin({ ALPHACLAW_SETUP_URL: "claw.example.com" })).toBe("");
  });

  it("resolveRequestOrigin ignores forwarded headers unless the peer is a trusted proxy hop", () => {
    expect(
      resolveRequestOrigin({
        headers: { host: "real.example:3000", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
        protocol: "http",
      }),
    ).toBe("http://real.example:3000");
    expect(
      resolveRequestOrigin({
        headers: { host: "real.example", "x-forwarded-host": "evil.example" },
        protocol: "http",
        app: untrustedApp,
      }),
    ).toBe("http://real.example");
    expect(
      resolveRequestOrigin({
        headers: { host: "internal:3000", "x-forwarded-host": "app.example.com, hop2.internal" },
        protocol: "https",
        app: trustedApp,
      }),
    ).toBe("https://app.example.com");
    // Bare objects without req.protocol: forwarded proto counts only when trusted.
    expect(
      resolveRequestOrigin({
        headers: { host: "h", "x-forwarded-proto": "https" },
        app: trustedApp,
      }),
    ).toBe("https://h");
    expect(resolveRequestOrigin({ headers: { host: "h", "x-forwarded-proto": "https" } })).toBe("http://h");
  });

  it("resolveRequestOrigin refuses hosts that could smuggle a path, and empty requests", () => {
    expect(resolveRequestOrigin({ headers: { host: "a.example/evil" }, protocol: "http" })).toBe("");
    expect(resolveRequestOrigin({ headers: { host: "a b" }, protocol: "http" })).toBe("");
    expect(resolveRequestOrigin({ headers: {} , protocol: "http" })).toBe("");
    expect(resolveRequestOrigin(null)).toBe("");
  });

  it("requestTrustsProxy reads Express's compiled trust function for hop 0 and never throws", () => {
    expect(requestTrustsProxy({ app: trustedApp, socket: { remoteAddress: "10.0.0.1" } })).toBe(true);
    expect(requestTrustsProxy({ app: untrustedApp })).toBe(false);
    expect(requestTrustsProxy({})).toBe(false);
    expect(
      requestTrustsProxy({
        app: {
          get: () => () => {
            throw new Error("boom");
          },
        },
      }),
    ).toBe(false);
  });

  it("resolvePublicOrigin: configured wins over any request, then the request, then localhost", () => {
    const req = { headers: { host: "req.example" }, protocol: "https" };
    expect(resolvePublicOrigin(req, { env: { ALPHACLAW_SETUP_URL: "https://canon.example" } })).toBe(
      "https://canon.example",
    );
    expect(resolvePublicOrigin(req, { env: kEmptyEnv })).toBe("https://req.example");
    expect(resolvePublicOrigin({ headers: {} }, { env: kEmptyEnv })).toMatch(/^http:\/\/localhost:\d+$/);
    expect(resolvePublicOrigin(undefined, { env: kEmptyEnv })).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("a SET but malformed explicit URL falls back to localhost (never the request) and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = { headers: { host: "req.example" }, protocol: "https" };
    const env = { ALPHACLAW_SETUP_URL: "http://[invalid" };
    expect(resolvePublicOrigin(req, { env })).toMatch(/^http:\/\/localhost:\d+$/);
    expect(resolvePublicOrigin(req, { env })).toMatch(/^http:\/\/localhost:\d+$/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/ALPHACLAW_SETUP_URL is not a valid http\(s\) URL/);
    warn.mockRestore();
  });

  it("isLocalhostOrigin", () => {
    expect(isLocalhostOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalhostOrigin("http://127.0.0.1")).toBe(true);
    expect(isLocalhostOrigin("https://localhost.example.com")).toBe(false);
    expect(isLocalhostOrigin("")).toBe(false);
  });
});
