const express = require("express");
const request = require("supertest");
const {
  buildSetupUiCsp,
  isSetupUiPageRequest,
  setupUiSecurityHeaders,
} = require("../../lib/server/setup-ui-headers");

describe("setup-ui-headers", () => {
  it("allows this host's sockets and nothing a forged Host could smuggle in", () => {
    expect(buildSetupUiCsp({ host: "claw.example.com" })).toContain(
      "connect-src 'self' ws://claw.example.com wss://claw.example.com https://api.github.com",
    );
    expect(buildSetupUiCsp({ host: "[::1]:3000" })).toContain("ws://[::1]:3000 wss://[::1]:3000");
    for (const host of ["evil; script-src *", "a b", "x/y", "", "host'"]) {
      const csp = buildSetupUiCsp({ host });
      expect(csp, host).toContain("connect-src 'self' https://api.github.com");
      expect(csp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("script-src"))).toEqual([
        "script-src 'self'",
      ]);
    }
  });

  it("matches the Setup UI pages the way Express routes them, and nothing else", () => {
    const page = (method, path) => isSetupUiPageRequest({ method, path });
    for (const path of ["/", "/setup", "/setup/", "/SETUP", "/setup.html", "/login.html", "/Login.HTML"]) {
      expect(page("GET", path), path).toBe(true);
    }
    expect(page("HEAD", "/login.html")).toBe(true);
    for (const path of ["/openclaw", "/openclaw/", "/relay/oauth/consent", "/gateway/attach", "/auth/google/callback", "/api/auth/status", "/js/login.js", "/rescue/abc"]) {
      expect(page("GET", path), path).toBe(false);
    }
    expect(page("POST", "/login.html")).toBe(false);
  });

  it("matches the decoded, slash-collapsed path express.static serves", () => {
    const page = (path) => isSetupUiPageRequest({ method: "GET", path });
    for (const path of [
      "/%73etup.html",
      "/%6cogin.html",
      "/%6Cogin.HTML",
      "//setup.html",
      "///login.html",
      "/js/%2e%2e/setup.html",
      "/%2e/login.html",
      "/setup%2ehtml",
      "/%73etup/",
      "//setup",
    ]) {
      expect(page(path), path).toBe(true);
    }
    for (const path of ["/%6apenclaw", "//openclaw/", "/js/%2e%2e/js/login.js"]) {
      expect(page(path), path).toBe(false);
    }
  });

  it("does not throw on a malformed encoding", () => {
    for (const path of ["/%E0%A4%A", "/%", "/setup%zz.html", "/%c0%af"]) {
      expect(() => isSetupUiPageRequest({ method: "GET", path }), path).not.toThrow();
    }
  });

  it("sets the headers only on page responses", async () => {
    const app = express();
    app.use(setupUiSecurityHeaders);
    app.get("/login.html", (req, res) => res.send("<html></html>"));
    app.get("/relay/oauth/consent", (req, res) => {
      res.set("Content-Security-Policy", "default-src 'none'");
      res.send("consent");
    });
    const loginPage = await request(app).get("/login.html").set("Host", "box.test");
    expect(loginPage.headers["content-security-policy"]).toBe(buildSetupUiCsp({ host: "box.test" }));
    expect(loginPage.headers["x-frame-options"]).toBe("DENY");
    const consent = await request(app).get("/relay/oauth/consent");
    expect(consent.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(consent.headers["x-frame-options"]).toBeUndefined();
  });
});
