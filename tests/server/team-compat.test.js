// Compat matrix: with team mode OFF (the default), nothing observable changes.
// - No identity headers are injected at either proxy boundary.
// - Internal token clients resolve the same token as before.
// - openclaw.json stays byte-for-byte identical across a no-op boot.
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  registerProxyRoutes,
  __testing: proxyTesting,
} = require("../../lib/server/routes/proxy");
const {
  applyGatewayAuthEnv,
  getGatewayCredential,
} = require("../../lib/server/gateway-credential");
const { createTeamService } = require("../../lib/server/team-service");
const { readTeamConfig } = require("../../lib/server/alphaclaw-config");
const { kIdentityUserHeader } = require("../../lib/server/proxy-identity");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-compat-test-"));

const createProxyApp = ({ resolveProxyIdentity }) => {
  const seenHeaders = [];
  const proxy = {
    web: vi.fn((req, res) => {
      seenHeaders.push({ url: req.url, headers: { ...req.headers } });
      res.status(200).json({ proxied: true });
    }),
  };
  const app = express();
  app.use(express.json());
  registerProxyRoutes({
    app,
    proxy,
    getGatewayUrl: () => "http://127.0.0.1:18789",
    getGatewayToken: () => "token",
    isOpenAiCompatApiEnabled: () => false,
    SETUP_API_PREFIXES: ["/api/auth"],
    requireAuth: (_req, _res, next) => next(),
    oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
    webhookMiddleware: (_req, res) => res.status(204).end(),
    resolveProxyIdentity,
  });
  return { app, proxy, seenHeaders };
};

describe("team mode compat matrix (default off)", () => {
  it("injects no identity headers and strips spoofed ones with team off", async () => {
    const { app, seenHeaders } = createProxyApp({
      resolveProxyIdentity: () => null,
    });

    const res = await request(app)
      .get("/openclaw/dashboard")
      .set("x-alphaclaw-user", "attacker")
      .set("x-forwarded-user", "attacker@example.com")
      .set("Cookie", "setup_token=session; theme=dark");
    expect(res.status).toBe(200);
    expect(seenHeaders).toHaveLength(1);
    const forwarded = seenHeaders[0].headers;
    expect(forwarded[kIdentityUserHeader]).toBeUndefined();
    expect(forwarded["x-forwarded-user"]).toBeUndefined();
    expect(forwarded.cookie).toBe("theme=dark");
  });

  it("injects the operator identity on the catch-all /api proxy with team on", async () => {
    const { app, seenHeaders } = createProxyApp({
      resolveProxyIdentity: () => ({ id: "garry" }),
    });

    const res = await request(app)
      .get("/api/some/gateway/path")
      .set("x-alphaclaw-user", "attacker");
    expect(res.status).toBe(200);
    expect(seenHeaders[0].headers[kIdentityUserHeader]).toBe("garry");
  });

  it("keeps requests flowing when identity resolution throws", async () => {
    const { app, seenHeaders } = createProxyApp({
      resolveProxyIdentity: () => {
        throw new Error("boom");
      },
    });
    const res = await request(app).get("/assets/app.css");
    expect(res.status).toBe(200);
    expect(seenHeaders[0].headers[kIdentityUserHeader]).toBeUndefined();
  });

  it("OpenAI-compat gateway headers drop identity and forwarded-evidence headers", () => {
    const headers = proxyTesting.createGatewayProxyHeaders({
      reqHeaders: {
        host: "public.example.com",
        authorization: "Bearer client-token",
        "x-alphaclaw-user": "attacker",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.9",
        cookie: "setup_token=abc; theme=dark",
        accept: "application/json",
      },
      bodyBuffer: Buffer.alloc(0),
    });
    expect(headers["x-alphaclaw-user"]).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["x-forwarded-proto"]).toBeUndefined();
    expect(headers["x-real-ip"]).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.accept).toBe("application/json");
    expect(headers.authorization).toBe("Bearer client-token");
  });

  it("leaves openclaw.json byte-identical across a no-op boot with team off", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    // Deliberately quirky formatting: byte-equality catches any rewrite.
    const originalBytes = `{
  "gateway": {
    "auth": { "token": "\${OPENCLAW_GATEWAY_TOKEN}" },
    "port":   18789
  },
  "channels": {"telegram": {"enabled": true}}
}
`;
    fs.writeFileSync(configPath, originalBytes);
    const env = { OPENCLAW_GATEWAY_TOKEN: "boot-token" };

    // Everything Milestone B added to the boot/request path:
    expect(readTeamConfig({ openclawDir }).enabled).toBe(false);
    applyGatewayAuthEnv({ ...env }, { openclawDir });
    const credential = getGatewayCredential({ openclawDir, env });
    const teamService = createTeamService({ fsModule: fs, openclawDir, env });
    expect(teamService.isTeamEnabled()).toBe(false);
    expect(teamService.listOperators()).toEqual([]);
    expect(teamService.resolveOperatorForSession({ sub: "x", opsv: 1 })).toBeNull();
    expect(teamService.getLoginInfo()).toEqual({
      teamEnabled: false,
      operators: [],
    });

    // Token clients untouched.
    expect(credential).toEqual({ mode: "token", value: "boot-token" });
    // Gateway env untouched.
    expect(applyGatewayAuthEnv({ ...env }, { openclawDir })).toEqual(env);
    // openclaw.json byte-equal.
    expect(fs.readFileSync(configPath, "utf8")).toBe(originalBytes);
  });
});
