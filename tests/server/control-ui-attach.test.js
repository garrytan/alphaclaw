const express = require("express");
const request = require("supertest");

const {
  kControlUiAttachCookie,
  computeAttachMarker,
  hasCurrentAttachMarker,
  createControlUiAttachRedirect,
  isControlUiDocumentNavigation,
  resolveAttachTarget,
  buildAttachRedirect,
  renderAttachPage,
} = require("../../lib/server/control-ui-attach");
const {
  registerControlUiAttachRoutes,
} = require("../../lib/server/routes/control-ui-attach");
const { registerProxyRoutes } = require("../../lib/server/routes/proxy");
const { sanitizeProxyHeaders } = require("../../lib/server/proxy-identity");

const kSession = "payload.signature";
const kToken = "gw-token-0123456789abcdef";
const kNavigate = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
const sessionCookie = (extra = "") =>
  `setup_token=${kSession}${extra ? `; ${extra}` : ""}`;
const markerCookie = () =>
  `${kControlUiAttachCookie}=${computeAttachMarker(kSession)}`;

const navReq = (overrides = {}) => ({
  method: "GET",
  originalUrl: "/openclaw/chat/main?draft=1",
  headers: { ...kNavigate, cookie: sessionCookie() },
  ...overrides,
});

describe("control-ui-attach: the redirect decision", () => {
  const decide = (opts = {}) =>
    createControlUiAttachRedirect({
      isAdminRequest: () => opts.admin ?? true,
      isOnboarded: () => opts.onboarded ?? true,
      isTokenlessGateway: () => opts.tokenless ?? false,
    });

  it("detours a signed-in admin's first top-level navigation, keeping path and query", () => {
    expect(decide()(navReq())).toBe(
      "/gateway/attach?to=%2Fopenclaw%2Fchat%2Fmain%3Fdraft%3D1",
    );
  });

  it("never detours once this session's marker is presented", () => {
    const req = navReq({ headers: { ...kNavigate, cookie: sessionCookie(markerCookie()) } });
    expect(decide()(req)).toBeNull();
  });

  it("detours again after a new login: a marker from another session does not count", () => {
    const stale = `${kControlUiAttachCookie}=${computeAttachMarker("old-session.sig")}`;
    const req = navReq({ headers: { ...kNavigate, cookie: sessionCookie(stale) } });
    expect(decide()(req)).toMatch(/^\/gateway\/attach\?to=/);
  });

  it("accepts only this session's exact marker: truncated, extended, altered and empty markers do not count", () => {
    const marker = computeAttachMarker(kSession);
    const withMarker = (value, session = sessionCookie()) => ({
      headers: { cookie: `${session}; ${kControlUiAttachCookie}=${value}` },
    });
    expect(hasCurrentAttachMarker(withMarker(marker))).toBe(true);
    const altered = `${marker.slice(0, -1)}${marker.endsWith("A") ? "B" : "A"}`;
    for (const value of [marker.slice(0, -1), `${marker}A`, altered, ""]) {
      expect(hasCurrentAttachMarker(withMarker(value)), value).toBe(false);
    }
    expect(hasCurrentAttachMarker({ headers: { cookie: sessionCookie() } })).toBe(false);
    expect(hasCurrentAttachMarker(withMarker(marker, "setup_token="))).toBe(false);
    expect(hasCurrentAttachMarker(withMarker("", "setup_token="))).toBe(false);
  });

  it("leaves subresources, fetches, iframes, WebSocket upgrades and non-GETs alone", () => {
    const d = decide();
    expect(d(navReq({ headers: { cookie: sessionCookie() } }))).toBeNull();
    expect(d(navReq({ headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", cookie: sessionCookie() } }))).toBeNull();
    expect(d(navReq({ headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", cookie: sessionCookie() } }))).toBeNull();
    expect(d(navReq({ method: "POST" }))).toBeNull();
    expect(isControlUiDocumentNavigation({ method: "GET", headers: { upgrade: "websocket" } })).toBe(false);
  });

  it("does not detour members, a pre-onboarding install or a tokenless gateway", () => {
    expect(decide({ admin: false })(navReq())).toBeNull();
    expect(decide({ onboarded: false })(navReq())).toBeNull();
    expect(decide({ tokenless: true })(navReq())).toBeNull();
  });
});

describe("control-ui-attach: target and page", () => {
  it("only ever returns a same-origin /openclaw path", () => {
    expect(resolveAttachTarget("/openclaw/agents")).toBe("/openclaw/agents");
    expect(resolveAttachTarget("/openclaw?x=1")).toBe("/openclaw?x=1");
    for (const bad of ["//evil.example/openclaw", "https://evil.example/", "/openclawx", "/openclaw/../v1/models", "/openclaw/%2e%2e/v1", "/openclaw\\..\\v1", "/openclaw/a b", "", undefined, ["/openclaw/x"]]) {
      expect(resolveAttachTarget(bad)).toBe("/openclaw");
    }
    expect(buildAttachRedirect("javascript:alert(1)")).toBe("/gateway/attach?to=%2Fopenclaw");
  });

  it("renders no token and cannot be broken out of by the target", () => {
    const html = renderAttachPage("/openclaw/</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("</script><img");
    expect(html).toContain("openclaw.control.token.v1:");
    expect(html).toContain('"x-alphaclaw-attach":"1"');
  });
});

describe("control-ui-attach: routes", () => {
  const createHarness = ({ admin = true, authorized = true, onboarded = true, token = kToken } = {}) => {
    const app = express();
    const resolveDashboardToken = vi.fn(async () => ({ token, source: token ? "config" : "" }));
    registerControlUiAttachRoutes({
      app,
      requireAuth: (req, res, next) => (authorized ? next() : res.redirect("/login.html")),
      isAuthorizedRequest: () => authorized,
      isAdminRequest: () => admin,
      isOnboarded: () => onboarded,
      dashboardUrlService: { resolveDashboardToken },
    });
    return { app, resolveDashboardToken };
  };

  it("serves the attach page to an admin: no-store, marker cookie on /openclaw, no token in the body", async () => {
    const { app, resolveDashboardToken } = createHarness();
    const res = await request(app)
      .get("/gateway/attach?to=%2Fopenclaw%2Fchat")
      .set("Cookie", sessionCookie());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toContain(kToken);
    expect(res.text).toContain('"/openclaw/chat"');
    const cookie = res.headers["set-cookie"].join("\n");
    expect(cookie).toContain(`${kControlUiAttachCookie}=${computeAttachMarker(kSession)}`);
    expect(cookie).toMatch(/Path=\/openclaw/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(resolveDashboardToken).not.toHaveBeenCalled();
  });

  it("sends a member straight on to the target, still marking the session so it cannot loop", async () => {
    const { app } = createHarness({ admin: false });
    const res = await request(app).get("/gateway/attach?to=%2F%2Fevil.example").set("Cookie", sessionCookie());
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw");
    expect(res.headers["set-cookie"].join("\n")).toContain(kControlUiAttachCookie);
  });

  it("answers the token to a same-origin admin POST only, never cacheable, never logged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { app } = createHarness();
      const res = await request(app)
        .post("/gateway/attach")
        .set("Cookie", sessionCookie())
        .set("x-alphaclaw-attach", "1")
        .set("sec-fetch-site", "same-origin");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ token: kToken });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(log.mock.calls.flat().join(" ")).not.toContain(kToken);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a signed-out POST with 401 (never a redirect) and a cross-site or header-less POST with 403", async () => {
    const signedOut = await request(createHarness({ authorized: false }).app)
      .post("/gateway/attach")
      .set("x-alphaclaw-attach", "1");
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.location).toBeUndefined();
    const { app, resolveDashboardToken } = createHarness();
    const noHeader = await request(app).post("/gateway/attach").set("Cookie", sessionCookie());
    expect(noHeader.status).toBe(403);
    const crossSite = await request(app)
      .post("/gateway/attach")
      .set("Cookie", sessionCookie())
      .set("x-alphaclaw-attach", "1")
      .set("sec-fetch-site", "cross-site");
    expect(crossSite.status).toBe(403);
    expect(resolveDashboardToken).not.toHaveBeenCalled();
  });

  it("gives a member no token and never resolves one", async () => {
    const { app, resolveDashboardToken } = createHarness({ admin: false });
    const res = await request(app)
      .post("/gateway/attach")
      .set("Cookie", sessionCookie())
      .set("x-alphaclaw-attach", "1");
    expect(res.body).toEqual({ token: "" });
    expect(resolveDashboardToken).not.toHaveBeenCalled();
  });
});

describe("control-ui-attach: /openclaw wiring", () => {
  const createApp = (resolveControlUiAttachRedirect) => {
    const app = express();
    const web = vi.fn((_req, res) => res.status(200).send("gateway"));
    registerProxyRoutes({
      app,
      proxy: { web },
      getGatewayUrl: () => "http://127.0.0.1:1",
      getGatewayToken: () => "",
      SETUP_API_PREFIXES: [],
      requireAuth: (_req, _res, next) => next(),
      oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
      webhookMiddleware: (_req, res) => res.status(204).end(),
      resolveControlUiAttachRedirect,
    });
    return { app, web };
  };

  it("302s the detour without touching the gateway, and forwards everything else", async () => {
    const decide = createControlUiAttachRedirect({
      isAdminRequest: () => true,
      isOnboarded: () => true,
      isTokenlessGateway: () => false,
    });
    const { app, web } = createApp(decide);
    const detour = await request(app).get("/openclaw/chat").set(kNavigate).set("Cookie", sessionCookie());
    expect(detour.status).toBe(302);
    expect(detour.headers.location).toBe("/gateway/attach?to=%2Fopenclaw%2Fchat");
    expect(detour.headers["cache-control"]).toBe("no-store");
    expect(web).not.toHaveBeenCalled();
    const attached = await request(app)
      .get("/openclaw/chat")
      .set(kNavigate)
      .set("Cookie", sessionCookie(markerCookie()));
    expect(attached.status).toBe(200);
    const asset = await request(app).get("/openclaw/sw.js").set("Cookie", sessionCookie());
    expect(asset.status).toBe(200);
    expect(web).toHaveBeenCalledTimes(2);
  });

  it("never forwards the attach marker to the gateway", () => {
    expect(sanitizeProxyHeaders({ cookie: `a=1; ${markerCookie()}; setup_token=x` }).cookie).toBe("a=1");
  });
});
