const express = require("express");
const request = require("supertest");

const {
  createDashboardUrlService,
} = require("../../lib/server/gateway-dashboard-url");
const {
  registerDashboardLaunchRoutes,
} = require("../../lib/server/routes/dashboard-launch");

// Stubbed openclaw secret runtime: coerceSecretRef(null) makes every token
// fall through to the literal/${ENV}/env-fallback branches, mirroring the
// real runtime's behavior for plain string tokens without paying the >5s
// plugin-sdk dynamic import per worker (routes-system.test.js and the proxy
// e2e cover the real import path).
const kStubSecretRuntime = () =>
  Promise.resolve([
    { coerceSecretRef: () => null },
    { resolveSecretRefValues: async () => new Map() },
  ]);

const createLaunchHarness = ({
  isAdmin = true,
  onboarded = true,
  importSecretRuntime = kStubSecretRuntime,
} = {}) => {
  const deps = {
    fs: {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => {
        throw new Error("no config");
      }),
      statSync: vi.fn(() => ({ mtimeMs: 1, size: 1 })),
    },
    readEnvFile: vi.fn(() => []),
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
  };
  const dashboardUrlService = createDashboardUrlService({
    fsModule: deps.fs,
    openclawDir: "/tmp/openclaw",
    readEnvFile: deps.readEnvFile,
    clawCmd: deps.clawCmd,
    importSecretRuntime,
  });
  const isAdminRequest = vi.fn(() => isAdmin);
  const isOnboarded = vi.fn(() => onboarded);
  const app = express();
  registerDashboardLaunchRoutes({
    app,
    // Auth is exercised for real by e2e-proxy-gateway.test.js (login-page
    // redirect, bearer exclusion); this harness tests the handler behind it.
    requireAuth: (req, res, next) => next(),
    isAdminRequest,
    isOnboarded,
    dashboardUrlService,
    fsModule: deps.fs,
    openclawDir: "/tmp/openclaw",
    readEnvFile: deps.readEnvFile,
  });
  return { app, deps, dashboardUrlService, isAdminRequest, isOnboarded };
};

const mockOpenclawConfig = (deps, config) => {
  deps.fs.readFileSync.mockImplementation((filePath) => {
    if (String(filePath).endsWith("openclaw.json")) {
      return JSON.stringify(config);
    }
    throw new Error("unexpected file");
  });
};

const getAuditLines = (logSpy) =>
  logSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("gateway launch:"));

describe("server/routes/dashboard-launch", () => {
  let previousEnvToken;

  beforeEach(() => {
    // Tokenless expectations must not be poisoned by a host env token.
    previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
  });

  it("302s an admin with a config token to the dashboards sub-path, token in the fragment only", async () => {
    const { app, deps } = createLaunchHarness();
    mockOpenclawConfig(deps, {
      gateway: { auth: { token: "cfg-token+value" } },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "/openclaw/dashboards#token=cfg-token%2Bvalue",
    );
    expect(res.headers["cache-control"]).toBe("no-store");
    // Empty-body 302: res.redirect() would write the tokened URL into an
    // HTML body that body-capture middleware could log.
    expect(res.text || "").toBe("");
    expect(deps.clawCmd).not.toHaveBeenCalled();
    const auditLines = getAuditLines(logSpy);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain("identity=admin");
    expect(auditLines[0]).toContain("target=dashboards");
    expect(auditLines[0]).toContain("outcome=tokened-config");
    expect(auditLines[0]).not.toContain("cfg-token");
  });

  it("302s ?to=secrets to the settings sub-path before the fragment", async () => {
    const { app, deps } = createLaunchHarness();
    mockOpenclawConfig(deps, { gateway: { auth: { token: "cfg-token" } } });

    const res = await request(app).get("/gateway/launch?to=secrets");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "/openclaw/settings/secrets#token=cfg-token",
    );
  });

  it("falls back to the byte-identical legacy root URL for every non-allowlisted target", async () => {
    const { app, deps } = createLaunchHarness();
    mockOpenclawConfig(deps, { gateway: { auth: { token: "cfg-token" } } });

    // Missing, prototype-shaped, open-redirect-shaped, traversal-shaped, and
    // array-form (?to=a&to=b) inputs all land on the root — raw query input
    // never reaches the Location header.
    const attempts = [
      "/gateway/launch",
      "/gateway/launch?to=constructor",
      "/gateway/launch?to=__proto__",
      "/gateway/launch?to=//evil.com",
      "/gateway/launch?to=..%2F..",
      "/gateway/launch?to=dashboards&to=secrets",
    ];
    for (const attempt of attempts) {
      const res = await request(app).get(attempt);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/openclaw/#token=cfg-token");
    }
  });

  it("redirects members tokenless without spawning the CLI", async () => {
    const { app, deps } = createLaunchHarness({ isAdmin: false });
    mockOpenclawConfig(deps, { gateway: { auth: { token: "cfg-token" } } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(res.headers.location).not.toContain("token=");
    expect(deps.clawCmd).not.toHaveBeenCalled();
    const auditLines = getAuditLines(logSpy);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain("identity=member");
    expect(auditLines[0]).toContain("outcome=tokenless");
  });

  it("redirects tokenless before onboarding without spawning the CLI", async () => {
    const { app, deps } = createLaunchHarness({ onboarded: false });
    mockOpenclawConfig(deps, { gateway: { auth: { token: "cfg-token" } } });

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("never emits a token in trusted-proxy mode and never spawns the CLI, even with a stale token + env token", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-should-not-leak";
    const { app, deps } = createLaunchHarness();
    // Team mode: the gateway rejects shared tokens under trusted-proxy auth —
    // a stale gateway.auth.token must not be resurrected into a #token= URL,
    // and tokenless is the success path (no CLI spawn just to discard it).
    mockOpenclawConfig(deps, {
      gateway: { auth: { mode: "trusted-proxy", token: "stale-config-token" } },
    });

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(res.headers.location).not.toContain("token=");
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("never emits a token in password mode (stale token + env token stay out of the fragment) and never spawns the CLI", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-should-not-leak";
    const { app, deps } = createLaunchHarness();
    // Password mode is mutually exclusive with token auth upstream: a stale
    // gateway.auth.token would ride the fragment as a dead credential and
    // burn the gateway's failed-auth budget on every click.
    mockOpenclawConfig(deps, {
      gateway: { auth: { mode: "password", token: "stale-config-token" } },
    });

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(res.headers.location).not.toContain("token=");
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("degrades a hung token resolution to a tokenless 302 within the resolve bound — a tab never hangs, and the memo self-clears", async () => {
    // A SecretRef exec provider with no timeout of its own: the secret
    // runtime import never settles, so the resolution hangs inside the
    // service. The service's own bound must fire (the launcher has no race
    // of its own), and the single-flight memo must self-clear so the NEXT
    // launch retries fresh instead of joining the wedged flight.
    let importAttempts = 0;
    const importSecretRuntime = () => {
      importAttempts += 1;
      return new Promise(() => {});
    };
    const deps = {
      fs: {
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() =>
          JSON.stringify({
            gateway: { auth: { token: { source: "env", provider: "p", id: "gw" } } },
          }),
        ),
        statSync: vi.fn(() => ({ mtimeMs: 1, size: 1 })),
      },
      readEnvFile: vi.fn(() => []),
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
    };
    const dashboardUrlService = createDashboardUrlService({
      fsModule: deps.fs,
      openclawDir: "/tmp/openclaw",
      readEnvFile: deps.readEnvFile,
      clawCmd: deps.clawCmd,
      importSecretRuntime,
    });
    const app = express();
    registerDashboardLaunchRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      isAdminRequest: () => true,
      isOnboarded: () => true,
      dashboardUrlService,
      fsModule: deps.fs,
      openclawDir: "/tmp/openclaw",
      readEnvFile: deps.readEnvFile,
      resolveTimeoutMs: 50,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    const timeoutWarns = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("dashboard_token_resolve_timeout"));
    expect(timeoutWarns).toHaveLength(1);

    // Flight memo self-cleared: the next resolution starts a FRESH flight
    // (config re-read, its own timeout warn) instead of joining the wedged
    // promise forever. The hung IMPORT stays memoized by design — perpetual
    // bounded degradation until the provider settles, never a hang.
    const configReadsAfterFirst = deps.fs.readFileSync.mock.calls.length;
    const second = await dashboardUrlService.resolveDashboardToken({
      timeoutMs: 50,
    });
    expect(second).toEqual({ token: "", source: "" });
    expect(deps.fs.readFileSync.mock.calls.length).toBeGreaterThan(
      configReadsAfterFirst,
    );
    expect(importAttempts).toBe(1);
    expect(
      warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("dashboard_token_resolve_timeout")),
    ).toHaveLength(2);
  });

  it("redirects tokenless when no token can be resolved anywhere", async () => {
    const { app, deps } = createLaunchHarness();
    deps.clawCmd.mockResolvedValue({
      ok: true,
      stdout: "Dashboard URL: http://127.0.0.1:18789/",
    });

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    expect(deps.clawCmd).toHaveBeenCalledWith("dashboard --no-open");
  });

  it("uses a CLI-scraped token when config resolves nothing", async () => {
    const { app, deps } = createLaunchHarness();
    deps.clawCmd.mockResolvedValue({
      ok: true,
      stdout: "Dashboard URL: http://127.0.0.1:18789/#token=abc123",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards#token=abc123");
    const auditLines = getAuditLines(logSpy);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain("outcome=tokened-cli");
    expect(auditLines[0]).not.toContain("abc123");
  }, 30000);

  it("shares one CLI spawn between concurrent launches (single-flight)", async () => {
    const { app, deps, dashboardUrlService } = createLaunchHarness();
    const pendingCli = [];
    deps.clawCmd.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingCli.push(resolve);
        }),
    );
    const resolveSpy = vi.spyOn(dashboardUrlService, "resolveDashboardToken");

    const first = request(app)
      .get("/gateway/launch?to=dashboards")
      .then((res) => res);
    const second = request(app)
      .get("/gateway/launch?to=secrets")
      .then((res) => res);
    // Both requests must be inside the resolver before the CLI settles, or
    // the memo would legitimately have been cleared between them.
    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(2));
    expect(pendingCli).toHaveLength(1);
    pendingCli[0]({
      ok: true,
      stdout: "Dashboard URL: http://127.0.0.1:18789/#token=cli-shared",
    });

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(deps.clawCmd).toHaveBeenCalledTimes(1);
    expect(firstRes.headers.location).toBe("/openclaw/dashboards#token=cli-shared");
    expect(secondRes.headers.location).toBe(
      "/openclaw/settings/secrets#token=cli-shared",
    );
  });

  it("degrades a resolver throw to a tokenless 302 with a redacted error log — never a 500", async () => {
    process.env.ALPHACLAW_TEST_LEAKY_SECRET = "bare-env-secret-value";
    try {
      const { app, deps } = createLaunchHarness();
      deps.clawCmd.mockRejectedValue(
        new Error(
          "spawn failed for http://127.0.0.1:18789/#token=super-secret-token-value with bare-env-secret-value",
        ),
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await request(app).get("/gateway/launch?to=dashboards");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/openclaw/dashboards");
      expect(res.text || "").toBe("");
      const errorLines = errorSpy.mock.calls.map((call) => String(call[0]));
      const launchErrors = errorLines.filter((line) =>
        line.includes("gateway_launch_resolve_failed"),
      );
      expect(launchErrors).toHaveLength(1);
      // Neither the token-shaped URL fragment nor the env-known secret value
      // may reach the log verbatim.
      expect(launchErrors[0]).not.toContain("super-secret-token-value");
      expect(launchErrors[0]).not.toContain("bare-env-secret-value");
      expect(launchErrors[0]).toContain("#token=***");
    } finally {
      delete process.env.ALPHACLAW_TEST_LEAKY_SECRET;
    }
  });

  it("redacts env-file and config-literal tokens plus bootstrapToken shapes from the error log", async () => {
    const { app, deps } = createLaunchHarness();
    // Tokens sourced from the two places collectSecretValues({env}) alone
    // cannot see: the env FILE and an openclaw.json literal.
    deps.readEnvFile.mockReturnValue([
      { key: "SOME_UNRELATED_TOKEN", value: "env-file-secret-value" },
    ]);
    mockOpenclawConfig(deps, {
      gateway: { auth: { token: "config-literal-secret" } },
      channels: { pairingSecret: "config-nested-secret" },
    });
    // A stub service throws directly — the redactor (not the resolver) is
    // under test, fed by the same fs/env-file mocks the harness service uses.
    const throwingService = {
      buildDashboardUrl: (token, subPath = "") =>
        `/openclaw${subPath}${token ? `#token=${encodeURIComponent(token)}` : ""}`,
      resolveDashboardToken: vi.fn(async () => {
        throw new Error(
          "cli echoed http://127.0.0.1:18789/#bootstrapToken=one-time-handoff&bootstrapProfile=owner " +
            "plus config-literal-secret and env-file-secret-value and config-nested-secret",
        );
      }),
    };
    const failingApp = require("express")();
    registerDashboardLaunchRoutes({
      app: failingApp,
      requireAuth: (req, res, next) => next(),
      isAdminRequest: () => true,
      isOnboarded: () => true,
      dashboardUrlService: throwingService,
      fsModule: deps.fs,
      openclawDir: "/tmp/openclaw",
      readEnvFile: deps.readEnvFile,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(failingApp).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    const launchErrors = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gateway_launch_resolve_failed"));
    expect(launchErrors).toHaveLength(1);
    expect(launchErrors[0]).not.toContain("one-time-handoff");
    expect(launchErrors[0]).toContain("#bootstrapToken=***");
    expect(launchErrors[0]).not.toContain("config-literal-secret");
    expect(launchErrors[0]).not.toContain("env-file-secret-value");
    expect(launchErrors[0]).not.toContain("config-nested-secret");
  });

  it("clears the single-flight memo on settle: a later launch re-resolves fresh state", async () => {
    const { app, deps } = createLaunchHarness();
    deps.clawCmd
      .mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/#token=first-token",
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/#token=second-token",
      });

    const first = await request(app).get("/gateway/launch?to=dashboards");
    const second = await request(app).get("/gateway/launch?to=dashboards");

    // Sequential launches each resolve fresh (the memo only spans in-flight
    // concurrency) — a rotated token is picked up, never cached until restart.
    expect(deps.clawCmd).toHaveBeenCalledTimes(2);
    expect(first.headers.location).toBe("/openclaw/dashboards#token=first-token");
    expect(second.headers.location).toBe("/openclaw/dashboards#token=second-token");
  });

  it("fails closed when redaction itself breaks: only the fixed error code is logged", async () => {
    const throwingService = {
      buildDashboardUrl: (token, subPath = "") =>
        `/openclaw${subPath}${token ? `#token=${encodeURIComponent(token)}` : ""}`,
      resolveDashboardToken: vi.fn(async () => {
        throw new Error("resolver failure quoting secret-that-must-not-log");
      }),
    };
    const app = express();
    registerDashboardLaunchRoutes({
      app,
      requireAuth: (req, res, next) => next(),
      isAdminRequest: () => true,
      isOnboarded: () => true,
      dashboardUrlService: throwingService,
      fsModule: { readFileSync: () => "{}" },
      openclawDir: "/tmp/openclaw",
      // The redactor reads the env file to collect secrets; if that read
      // throws, redaction fails closed to an empty message.
      readEnvFile: () => {
        throw new Error("env file unreadable");
      },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/gateway/launch?to=dashboards");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards");
    const launchErrors = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("gateway_launch_resolve_failed"));
    expect(launchErrors).toHaveLength(1);
    // Fixed code only — the resolver message never reaches the log when the
    // redactor cannot vouch for it.
    expect(launchErrors[0]).toBe("[alphaclaw] gateway_launch_resolve_failed: ");
    expect(launchErrors[0]).not.toContain("secret-that-must-not-log");
  });

  it("logs a tokenless audit outcome after a resolver throw (exactly one audit line)", async () => {
    const { app, deps } = createLaunchHarness();
    deps.clawCmd.mockRejectedValue(new Error("boom"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app).get("/gateway/launch?to=dashboards");

    const auditLines = getAuditLines(logSpy);
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain("outcome=tokenless");
  });

  it("recovers the secret-runtime memo after a failed-then-successful import", async () => {
    let importAttempts = 0;
    const importSecretRuntime = vi.fn(() => {
      importAttempts += 1;
      if (importAttempts === 1) {
        return Promise.reject(new Error("transient loader failure"));
      }
      return Promise.resolve([
        {
          coerceSecretRef: (value) =>
            value && typeof value === "object" && value.id
              ? { source: "env", provider: "default", id: value.id }
              : null,
        },
        {
          resolveSecretRefValues: async (refs, { env }) =>
            new Map(
              refs.map((ref) => [
                `${ref.source}:${ref.provider}:${ref.id}`,
                env[ref.id],
              ]),
            ),
        },
      ]);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, dashboardUrlService } = createLaunchHarness({
      importSecretRuntime,
    });
    mockOpenclawConfig(deps, {
      gateway: {
        auth: {
          token: { source: "env", provider: "default", id: "MY_DASHBOARD_TOKEN" },
        },
      },
    });
    // Env-file-only value: the trailing OPENCLAW_GATEWAY_TOKEN env fallback
    // cannot mask whether the secret-ref runtime actually resolved.
    deps.readEnvFile.mockReturnValue([
      { key: "MY_DASHBOARD_TOKEN", value: "secret-ref-token" },
    ]);

    // First pass: the import rejects, secret-ref resolution degrades to "".
    expect(await dashboardUrlService.getDashboardTokenFromConfig()).toBe("");
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "secret-ref runtime unavailable",
    );
    // The rejection was NOT cached: the next call retries the import and
    // resolves the SecretRef.
    expect(await dashboardUrlService.getDashboardTokenFromConfig()).toBe(
      "secret-ref-token",
    );
    expect(importSecretRuntime).toHaveBeenCalledTimes(2);
    // A successful import IS memoized.
    expect(await dashboardUrlService.getDashboardTokenFromConfig()).toBe(
      "secret-ref-token",
    );
    expect(importSecretRuntime).toHaveBeenCalledTimes(2);
  });

  it("serves the exact launch path the frontend nav emits (contract pin)", async () => {
    const { kDashboardLaunchUrl } = await import(
      "../../lib/public/js/lib/app-navigation.js"
    );
    const { app, deps } = createLaunchHarness();
    mockOpenclawConfig(deps, { gateway: { auth: { token: "pin-token" } } });

    const res = await request(app).get(`${kDashboardLaunchUrl}?to=dashboards`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/openclaw/dashboards#token=pin-token");
  });

  describe("buildDashboardUrl unit pins", () => {
    const service = createDashboardUrlService({
      fsModule: { readFileSync: () => "{}" },
      openclawDir: "/tmp/openclaw",
      readEnvFile: () => [],
      clawCmd: async () => ({ ok: true, stdout: "" }),
      importSecretRuntime: kStubSecretRuntime,
    });

    it("keeps the no-subPath outputs byte-identical to the legacy shapes", () => {
      expect(service.buildDashboardUrl("abc123")).toBe("/openclaw/#token=abc123");
      expect(service.buildDashboardUrl("")).toBe("/openclaw");
      expect(service.buildDashboardUrl("cfg-token+value")).toBe(
        "/openclaw/#token=cfg-token%2Bvalue",
      );
    });

    it("places the sub-path before the fragment and encodes the token", () => {
      expect(service.buildDashboardUrl("abc123", "/dashboards")).toBe(
        "/openclaw/dashboards#token=abc123",
      );
      expect(service.buildDashboardUrl("", "/dashboards")).toBe(
        "/openclaw/dashboards",
      );
      expect(service.buildDashboardUrl("a b/c", "/settings/secrets")).toBe(
        "/openclaw/settings/secrets#token=a%20b%2Fc",
      );
    });
  });
});
