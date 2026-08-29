const express = require("express");
const request = require("supertest");
const https = require("https");
const { EventEmitter } = require("events");

const { registerSystemRoutes } = require("../../lib/server/routes/system");

// readAlphaclawConfig serves identical re-reads from a module-level
// mtime/size cache; a strictly increasing mtime per stat keeps every test
// reading through its own readFileSync mock instead of a stale cached copy.
let statMtimeCounter = 0;

const createSystemDeps = () => {
  const deps = {
    fs: {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => {
        throw new Error("no config");
      }),
      statSync: vi.fn(() => {
        statMtimeCounter += 1;
        return { mtimeMs: statMtimeCounter, size: statMtimeCounter };
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    },
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(() => true),
    kKnownVars: [
      {
        key: "OPENAI_API_KEY",
        label: "OpenAI API Key",
        group: "ai",
        hint: "",
        features: ["Models", "Embeddings", "TTS", "STT"],
      },
      {
        key: "ANTHROPIC_TOKEN",
        label: "Anthropic Setup Token",
        group: "ai",
        hint: "",
        features: ["Models"],
        visibleInEnvars: false,
      },
      { key: "GITHUB_TOKEN", label: "GitHub Access Token", group: "github", hint: "" },
    ],
    kKnownKeys: new Set(["OPENAI_API_KEY", "ANTHROPIC_TOKEN", "GITHUB_TOKEN"]),
    kSystemVars: new Set(["PORT", "SETUP_PASSWORD"]),
    syncChannelConfig: vi.fn(),
    isGatewayRunning: vi.fn(async () => true),
    isOnboarded: vi.fn(() => true),
    getChannelStatus: vi.fn(() => ({ telegram: "ready" })),
    openclawVersionService: {
      readOpenclawVersion: vi.fn(() => "1.2.3"),
      getVersionStatus: vi.fn(async () => ({ ok: true, current: "1.2.3" })),
      updateOpenclaw: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    },
    alphaclawVersionService: {
      readAlphaclawVersion: vi.fn(() => "0.1.5"),
      getVersionStatus: vi.fn(async () => ({
        ok: true,
        currentVersion: "0.1.5",
        currentOpenclawVersion: "1.2.3",
        latestVersion: "0.2.0",
        latestOpenclawVersion: "1.3.0",
        hasUpdate: true,
        updateStrategy: {
          action: "self-update",
          provider: "self-hosted",
          label: "This install",
          description: "Update in place",
          steps: [],
          primaryActionLabel: "Update now",
        },
      })),
      updateAlphaclaw: vi.fn(async () => ({
        status: 200,
        body: { ok: true, previousVersion: "0.1.5", restarting: true },
      })),
      restartProcess: vi.fn(),
    },
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
    restartGateway: vi.fn(),
    restartRequiredState: {
      markRequired: vi.fn(),
      getSnapshot: vi.fn(async () => ({
        restartRequired: false,
        restartInProgress: false,
        gatewayRunning: true,
      })),
      markRestartInProgress: vi.fn(),
      clearRequired: vi.fn(),
      markRestartComplete: vi.fn(),
    },
    topicRegistry: {
      getGroup: vi.fn(() => null),
    },
    authProfiles: {
      listApiKeyProviders: vi.fn(() => ["openai"]),
      getEnvVarForApiKeyProvider: vi.fn((provider) =>
        provider === "openai" ? "OPENAI_API_KEY" : "",
      ),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      removeApiKeyProfileForEnvVar: vi.fn(),
    },
    OPENCLAW_DIR: "/tmp/openclaw",
    ensureGatewayProxyConfig: vi.fn(() => false),
    getBaseUrl: vi.fn(() => "https://setup.example.com"),
    kAlphaclawGithubReleasesBaseUrl:
      "https://api.github.com/repos/garrytan/alphaclaw/releases",
  };
  return deps;
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerSystemRoutes({
    app,
    ...deps,
  });
  return app;
};

// Captures raw route handlers so long-lived handlers (SSE) can be driven with
// hand-rolled req/res doubles under fake timers.
const captureRoutes = (deps) => {
  const routes = { get: new Map(), put: new Map(), post: new Map() };
  const app = {
    get: (routePath, handler) => routes.get.set(routePath, handler),
    put: (routePath, handler) => routes.put.set(routePath, handler),
    post: (routePath, handler) => routes.post.set(routePath, handler),
  };
  registerSystemRoutes({ app, ...deps });
  return routes;
};

const mockHttpsGetResponse = ({ statusCode = 200, body = "" } = {}) =>
  vi.spyOn(https, "get").mockImplementation((url, options, callback) => {
    const requestObject = new EventEmitter();
    requestObject.destroy = (err) => {
      if (err) process.nextTick(() => requestObject.emit("error", err));
    };
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.setEncoding = vi.fn();
      callback(response);
      process.nextTick(() => {
        if (body) response.emit("data", body);
        response.emit("end");
      });
    });
    return requestObject;
  });

describe("server/routes/system", () => {
  // boot-phase is a module singleton whose process default is
  // "starting_gateway"; the reducer (and the legacy projection derived from
  // it) gate on it, so every test starts from a settled boot. Tests that
  // need a failed boot set it explicitly and this reset un-leaks it.
  beforeEach(() => {
    require("../../lib/server/boot-phase").setBootPhase("ready");
  });

  it("merges known vars and custom vars on GET /api/env", async () => {
    const deps = createSystemDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "OPENAI_API_KEY", value: "abc" },
      { key: "PORT", value: "3000" },
      { key: "CUSTOM_FLAG", value: "1" },
    ]);
    const app = createApp(deps);

    const res = await request(app).get("/api/env");

    expect(res.status).toBe(200);
    expect(res.body.vars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "OPENAI_API_KEY",
          value: "abc",
          features: ["Models", "Embeddings", "TTS", "STT"],
          source: "env_file",
        }),
        expect.objectContaining({
          key: "GITHUB_TOKEN",
          value: "",
          source: "unset",
        }),
        expect.objectContaining({
          key: "CUSTOM_FLAG",
          value: "1",
          group: "custom",
        }),
      ]),
    );
    expect(res.body.vars.some((entry) => entry.key === "PORT")).toBe(false);
    expect(res.body.vars.some((entry) => entry.key === "ANTHROPIC_TOKEN")).toBe(false);
    expect(res.body.vars.some((entry) => entry.key === "GITHUB_WORKSPACE_REPO")).toBe(
      false,
    );
    expect(res.body.reservedKeys).toEqual(
      expect.arrayContaining([
        "PORT",
        "SETUP_PASSWORD",
        "GITHUB_WORKSPACE_REPO",
        "GOG_KEYRING_PASSWORD",
      ]),
    );
    expect(res.body.restartRequired).toBe(false);
  });

  it("rejects reserved vars on PUT /api/env", async () => {
    const deps = createSystemDeps();
    deps.reloadEnv.mockReturnValue(true);
    deps.readEnvFile.mockReturnValue([
      { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
    ]);
    const app = createApp(deps);

    const payload = {
      vars: [
        { key: "OPENAI_API_KEY", value: "abc" },
        { key: "PORT", value: "3000" },
        { key: "GITHUB_WORKSPACE_REPO", value: "changed/repo" },
      ],
    };

    const res = await request(app).put("/api/env").send(payload);

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("Reserved environment variables cannot be edited");
    expect(res.body.error).toContain("PORT");
    expect(res.body.error).toContain("GITHUB_WORKSPACE_REPO");
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();
    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  it("rejects gog keyring password edits on PUT /api/env", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({
      vars: [{ key: "GOG_KEYRING_PASSWORD", value: "changed" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("GOG_KEYRING_PASSWORD");
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
    expect(deps.syncChannelConfig).not.toHaveBeenCalled();
  });

  it("does not restart gateway when env is unchanged", async () => {
    const deps = createSystemDeps();
    deps.reloadEnv.mockReturnValue(false);
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "same" }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, changed: false, restartRequired: false });
    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  it("preserves hidden known vars on PUT /api/env", async () => {
    const deps = createSystemDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "ANTHROPIC_TOKEN", value: "hidden-token" },
    ]);
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "same" }],
    });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "OPENAI_API_KEY", value: "same" },
      { key: "ANTHROPIC_TOKEN", value: "hidden-token" },
    ]);
  });

  it("hides and preserves managed slack channel tokens on /api/env", async () => {
    const deps = createSystemDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "SLACK_BOT_TOKEN", value: "xoxb-hidden" },
      { key: "SLACK_APP_TOKEN", value: "xapp-hidden" },
    ]);
    const app = createApp(deps);

    const getRes = await request(app).get("/api/env");
    expect(getRes.status).toBe(200);
    expect(getRes.body.vars.some((entry) => entry.key === "SLACK_BOT_TOKEN")).toBe(
      false,
    );
    expect(getRes.body.vars.some((entry) => entry.key === "SLACK_APP_TOKEN")).toBe(
      false,
    );

    const putRes = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "same" }],
    });
    expect(putRes.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "OPENAI_API_KEY", value: "same" },
      { key: "SLACK_BOT_TOKEN", value: "xoxb-hidden" },
      { key: "SLACK_APP_TOKEN", value: "xapp-hidden" },
    ]);
  });

  it("hides and preserves WHATSAPP_OWNER_NUMBER on /api/env", async () => {
    const deps = createSystemDeps();
    deps.readEnvFile.mockReturnValue([
      { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
    ]);
    const app = createApp(deps);

    const getRes = await request(app).get("/api/env");
    expect(getRes.status).toBe(200);
    expect(
      getRes.body.vars.some((entry) => entry.key === "WHATSAPP_OWNER_NUMBER"),
    ).toBe(false);

    const putRes = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "same" }],
    });
    expect(putRes.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "OPENAI_API_KEY", value: "same" },
      { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
    ]);
  });

  it("syncs API-key auth profiles from known env vars on save", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "sk-test-123" }],
    });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.getEnvVarForApiKeyProvider).toHaveBeenCalledWith("openai");
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "openai",
      "sk-test-123",
    );
  });

  it("removes mirrored auth profile when synced env var is cleared", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "" }],
    });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.removeApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "openai",
    );
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).not.toHaveBeenCalled();
  });

  it("keeps restartRequired true until gateway restart", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const firstSave = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "abc" }],
    });
    expect(firstSave.status).toBe(200);
    expect(firstSave.body.restartRequired).toBe(true);

    deps.reloadEnv.mockReturnValue(false);
    const secondSave = await request(app).put("/api/env").send({
      vars: [{ key: "OPENAI_API_KEY", value: "abc" }],
    });
    expect(secondSave.status).toBe(200);
    expect(secondSave.body).toEqual({
      ok: true,
      changed: false,
      restartRequired: true,
    });

    const envBeforeRestart = await request(app).get("/api/env");
    expect(envBeforeRestart.status).toBe(200);
    expect(envBeforeRestart.body.restartRequired).toBe(true);

    const restart = await request(app).post("/api/gateway/restart");
    expect(restart.status).toBe(200);
    expect(restart.body).toEqual(
      expect.objectContaining({ ok: true, restartRequired: false }),
    );
    expect(deps.restartGateway).toHaveBeenCalledTimes(1);

    const envAfterRestart = await request(app).get("/api/env");
    expect(envAfterRestart.status).toBe(200);
    expect(envAfterRestart.body.restartRequired).toBe(false);
  });

  it("returns 400 when vars payload is missing", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).put("/api/env").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Missing vars array" });
  });

  it("reports running gateway status on GET /api/status", async () => {
    const deps = createSystemDeps();
    deps.fs.existsSync.mockReturnValue(true);
    deps.isGatewayRunning.mockResolvedValue(true);
    const app = createApp(deps);

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        gateway: "running",
        configExists: true,
        openclawVersion: "1.2.3",
        alphaclaw: {
          features: {
            openaiCompatApi: {
              enabled: false,
            },
          },
          updates: {
            openclaw: {
              releaseChannel: "stable",
              overseer: { enabled: false },
            },
          },
          team: {
            enabled: false,
            disableLegacyLogin: false,
          },
        },
        openclawChannel: null,
        syncCron: expect.objectContaining({
          enabled: true,
          schedule: "0 * * * *",
        }),
      }),
    );
  });

  it("returns tokenized dashboard URL when OpenClaw CLI prints a token", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/#token=abc123",
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw/#token=abc123" });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
    // The first dashboard test in a worker pays the openclaw plugin-sdk
    // dynamic-import cost, which can exceed the default 5s timeout.
  }, 30000);

  it("falls back to plain configured gateway token for dashboard URL", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockResolvedValueOnce({
      ok: true,
      stdout: "Dashboard URL: http://127.0.0.1:18789/",
    });
    deps.fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).endsWith("openclaw.json")) {
        return JSON.stringify({ gateway: { auth: { token: "cfg-token+value" } } });
      }
      throw new Error("unexpected file");
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/gateway/dashboard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      url: "/openclaw/#token=cfg-token%2Bvalue",
      source: "config",
    });
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN from env file for dashboard URL", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      deps.readEnvFile.mockReturnValue([
        { key: "OPENCLAW_GATEWAY_TOKEN", value: "env-token" },
      ]);
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: "/openclaw/#token=env-token",
        source: "config",
      });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("resolves configured OPENCLAW_GATEWAY_TOKEN env refs for dashboard URL", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "real-env-token+value";
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
          });
        }
        throw new Error("unexpected file");
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: "/openclaw/#token=real-env-token%2Bvalue",
        source: "config",
      });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("resolves configured OPENCLAW_GATEWAY_TOKEN env refs from env file for dashboard URL", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
          });
        }
        throw new Error("unexpected file");
      });
      deps.readEnvFile.mockReturnValue([
        { key: "OPENCLAW_GATEWAY_TOKEN", value: "env-file-token" },
      ]);
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: "/openclaw/#token=env-file-token",
        source: "config",
      });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("resolves configured object SecretRefs for dashboard URL", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "object-ref-token+value";
    try {
      const deps = createSystemDeps();
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: {
              auth: {
                token: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_GATEWAY_TOKEN",
                },
              },
            },
          });
        }
        throw new Error("unexpected file");
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: "/openclaw/#token=object-ref-token%2Bvalue",
        source: "config",
      });
      expect(deps.clawCmd).not.toHaveBeenCalled();
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("marks dashboard URL as needing auth when no token can be resolved", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw", needsAuth: true });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("never emits a token fragment in trusted-proxy mode, even with a configured token", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-should-not-leak";
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValueOnce({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      // Team mode: the gateway rejects shared tokens under trusted-proxy
      // auth, so a stale gateway.auth.token must not be resurrected into a
      // #token= URL — it would carry a dead credential.
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: {
              auth: { mode: "trusted-proxy", token: "stale-config-token" },
            },
          });
        }
        throw new Error("unexpected file");
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw", needsAuth: true });
      expect(res.body.url).not.toContain("token=");
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  });

  it("returns sync cron status on GET /api/sync-cron", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockReturnValueOnce(
      JSON.stringify({ enabled: false, schedule: "*/30 * * * *" }),
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/sync-cron");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        enabled: false,
        schedule: "*/30 * * * *",
      }),
    );
  });

  it("updates sync cron config on PUT /api/sync-cron", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockReturnValueOnce(
      JSON.stringify({ enabled: true, schedule: "0 * * * *" }),
    );
    const app = createApp(deps);

    const res = await request(app).put("/api/sync-cron").send({
      enabled: true,
      schedule: "*/15 * * * *",
    });

    expect(res.status).toBe(200);
    expect(deps.fs.mkdirSync).toHaveBeenCalledWith("/tmp/openclaw/cron", {
      recursive: true,
    });
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/openclaw/cron/system-sync.json",
      expect.stringContaining('"schedule": "*/15 * * * *"'),
    );
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/etc/cron.d/openclaw-hourly-sync",
      expect.stringContaining('*/15 * * * * root bash "/tmp/openclaw/.alphaclaw/hourly-git-sync.sh"'),
      expect.objectContaining({ mode: 0o644 }),
    );
    expect(res.body.ok).toBe(true);
  });

  it("updates sync cron config without touching system cron when disabled by runtime env", async () => {
    const previousValue = process.env.ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL;
    process.env.ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL = "true";
    try {
      const deps = createSystemDeps();
      deps.fs.readFileSync.mockReturnValueOnce(
        JSON.stringify({ enabled: true, schedule: "0 * * * *" }),
      );
      const app = createApp(deps);

      const res = await request(app).put("/api/sync-cron").send({
        enabled: true,
        schedule: "*/15 * * * *",
      });

      expect(res.status).toBe(200);
      expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/openclaw/cron/system-sync.json",
        expect.stringContaining('"schedule": "*/15 * * * *"'),
      );
      expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
        "/etc/cron.d/openclaw-hourly-sync",
        expect.anything(),
        expect.anything(),
      );
      expect(deps.fs.rmSync).not.toHaveBeenCalledWith(
        "/etc/cron.d/openclaw-hourly-sync",
        expect.anything(),
      );
    } finally {
      if (previousValue === undefined) {
        delete process.env.ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL;
      } else {
        process.env.ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL = previousValue;
      }
    }
  });

  it("returns AlphaClaw config on GET /api/alphaclaw/config", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === "/tmp/openclaw/alphaclaw.json") {
        return JSON.stringify({
          features: { openaiCompatApi: { enabled: true } },
        });
      }
      throw new Error("no config");
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/config");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      config: {
        features: {
          openaiCompatApi: {
            enabled: true,
          },
        },
        updates: {
          openclaw: {
            releaseChannel: "stable",
            overseer: { enabled: false },
          },
        },
        team: {
          enabled: false,
          disableLegacyLogin: false,
        },
      },
    });
  });

  it("persists the OpenAI-compatible API feature toggle", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/alphaclaw/config/features/openai-compat-api")
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        changed: true,
        gatewayConfigChanged: false,
        config: {
          features: {
            openaiCompatApi: {
              enabled: true,
            },
          },
          updates: {
            openclaw: {
              releaseChannel: "stable",
              overseer: { enabled: false },
            },
          },
          team: {
            enabled: false,
            disableLegacyLogin: false,
          },
        },
      }),
    );
    expect(deps.fs.mkdirSync).toHaveBeenCalledWith("/tmp/openclaw", {
      recursive: true,
    });
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/openclaw/alphaclaw.json",
      expect.stringContaining('"enabled": true'),
    );
    expect(deps.ensureGatewayProxyConfig).toHaveBeenCalledWith(
      "https://setup.example.com",
    );
  });

  it("marks restart required when enabling API changes OpenClaw gateway config", async () => {
    const deps = createSystemDeps();
    deps.ensureGatewayProxyConfig.mockReturnValue(true);
    deps.restartRequiredState.getSnapshot.mockResolvedValueOnce({
      restartRequired: true,
      restartInProgress: false,
      gatewayRunning: true,
    });
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/alphaclaw/config/features/openai-compat-api")
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.restartRequired).toBe(true);
    expect(res.body.gatewayConfigChanged).toBe(true);
    expect(deps.restartRequiredState.markRequired).toHaveBeenCalledWith(
      "openai_compat_api_enabled",
    );
  });

  it("rejects non-boolean OpenAI-compatible API feature updates", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/alphaclaw/config/features/openai-compat-api")
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "enabled must be a boolean",
    });
    expect(deps.fs.writeFileSync).not.toHaveBeenCalledWith(
      "/tmp/openclaw/alphaclaw.json",
      expect.any(String),
    );
  });

  it("returns alphaclaw version status on GET /api/alphaclaw/version", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/version");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        currentVersion: "0.1.5",
        currentOpenclawVersion: "1.2.3",
        latestVersion: "0.2.0",
        latestOpenclawVersion: "1.3.0",
        hasUpdate: true,
        updateStrategy: expect.objectContaining({
          action: "self-update",
          provider: "self-hosted",
        }),
      }),
    );
    expect(deps.alphaclawVersionService.getVersionStatus).toHaveBeenCalledWith(false);
  });

  it("passes refresh flag to alphaclaw version service", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    await request(app).get("/api/alphaclaw/version?refresh=1");

    expect(deps.alphaclawVersionService.getVersionStatus).toHaveBeenCalledWith(true);
  });

  it("returns update result and schedules restart on POST /api/alphaclaw/update", async () => {
    vi.useFakeTimers();
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/alphaclaw/update");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      previousVersion: "0.1.5",
      restarting: true,
    });
    expect(deps.alphaclawVersionService.updateAlphaclaw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.alphaclawVersionService.restartProcess).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not schedule a local restart for managed updates", async () => {
    vi.useFakeTimers();
    const deps = createSystemDeps();
    deps.alphaclawVersionService.updateAlphaclaw.mockResolvedValue({
      status: 200,
      body: {
        ok: true,
        previousVersion: "0.1.5",
        latestVersion: "0.2.0",
        latestOpenclawVersion: "1.3.0",
        restarting: true,
        managedUpdate: true,
      },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/alphaclaw/update");

    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.alphaclawVersionService.restartProcess).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns error status when alphaclaw update fails", async () => {
    const deps = createSystemDeps();
    deps.alphaclawVersionService.updateAlphaclaw.mockResolvedValue({
      status: 500,
      body: { ok: false, error: "npm install failed" },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/alphaclaw/update");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "npm install failed" });
  });

  it("returns 409 when alphaclaw update is already in progress", async () => {
    const deps = createSystemDeps();
    deps.alphaclawVersionService.updateAlphaclaw.mockResolvedValue({
      status: 409,
      body: { ok: false, error: "AlphaClaw update already in progress" },
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/alphaclaw/update");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: "AlphaClaw update already in progress",
    });
  });

  it("returns 409 on POST /api/alphaclaw/update while an OpenClaw channel apply is in flight", async () => {
    const deps = createSystemDeps();
    deps.openclawChannelService = {
      isApplyInProgress: vi.fn(() => true),
      getChannelInfo: vi.fn(() => null),
    };
    const app = createApp(deps);

    const res = await request(app).post("/api/alphaclaw/update");

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("OpenClaw version change is in progress");
    // A restartProcess() mid-overlay-write would corrupt the channel store:
    // the update must not even start.
    expect(deps.alphaclawVersionService.updateAlphaclaw).not.toHaveBeenCalled();
    expect(deps.alphaclawVersionService.restartProcess).not.toHaveBeenCalled();
  });

  it("runs the alphaclaw update normally when no OpenClaw channel apply is in flight", async () => {
    vi.useFakeTimers();
    try {
      const deps = createSystemDeps();
      deps.openclawChannelService = {
        isApplyInProgress: vi.fn(() => false),
        getChannelInfo: vi.fn(() => null),
      };
      const app = createApp(deps);

      const res = await request(app).post("/api/alphaclaw/update");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        previousVersion: "0.1.5",
        restarting: true,
      });
      expect(deps.openclawChannelService.isApplyInProgress).toHaveBeenCalled();
      expect(deps.alphaclawVersionService.updateAlphaclaw).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(deps.alphaclawVersionService.restartProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes a populated openclawChannel summary on GET /api/status", async () => {
    const deps = createSystemDeps();
    deps.openclawChannelService = {
      getChannelInfo: vi.fn(() => ({
        releaseChannel: "beta",
        installedVersion: "2026.8.1",
        pinVersion: "2026.7.1-2",
        applied: {
          channel: "beta",
          version: "2026.8.1",
          sha: null,
          at: 1,
          acceptedAt: null,
          acceptedSource: null,
        },
        appliedId: "2026.8.1",
        isPin: false,
        acceptedAt: null,
        inStabilizationWindow: true,
        lastKnownGood: { package: null, dev: null },
        blocklist: [],
        lastUpdateRun: null,
        lastBoot: null,
      })),
      isApplyInProgress: vi.fn(() => true),
    };
    const app = createApp(deps);

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    // The summary is a fixed projection of getChannelInfo() plus the live
    // apply flag — exact equality locks the shape.
    expect(res.body.openclawChannel).toEqual({
      releaseChannel: "beta",
      installedVersion: "2026.8.1",
      pinVersion: "2026.7.1-2",
      appliedId: "2026.8.1",
      isPin: false,
      acceptedAt: null,
      inStabilizationWindow: true,
      applyInProgress: true,
    });
  });

  it("degrades openclawChannel to null on GET /api/status when getChannelInfo throws", async () => {
    // The status endpoint feeds the whole dashboard shell (and its 2s SSE
    // mirror): a broken channel store must degrade the summary, never take
    // down /api/status with it.
    const deps = createSystemDeps();
    deps.openclawChannelService = {
      getChannelInfo: vi.fn(() => {
        throw new Error("channel state unreadable");
      }),
      isApplyInProgress: vi.fn(() => false),
    };
    const app = createApp(deps);

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.openclawChannel).toBeNull();
    expect(deps.openclawChannelService.getChannelInfo).toHaveBeenCalled();
  });

  it("returns raw session metadata on GET /api/agent/sessions", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === "/tmp/openclaw/openclaw.json") {
        return JSON.stringify({
          channels: {
            telegram: {
              accounts: {
                default: { name: "Tester" },
                mac: { name: "Mac" },
              },
            },
          },
          bindings: [
            { agentId: "main", match: { channel: "telegram", accountId: "default" } },
            { agentId: "morpheus", match: { channel: "telegram", accountId: "mac" } },
          ],
        });
      }
      throw new Error(`unexpected read: ${targetPath}`);
    });
    deps.topicRegistry.getGroup.mockImplementation((groupId) =>
      String(groupId) === "-1003709908795"
        ? {
            name: "AlphaClaw",
            topics: {
              "4011": { name: "Rosebud" },
            },
          }
        : null,
    );
    deps.clawCmd.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        sessions: [
          { key: "agent:main:main", sessionId: "main-session", updatedAt: 10 },
          {
            key: "agent:morpheus:telegram:direct:1050",
            sessionId: "morpheus-direct-session",
            updatedAt: 11,
          },
          { key: "agent:main:hook:abc", sessionId: "hook-session", updatedAt: 9 },
          { key: "agent:main:cron:abc", sessionId: "cron-session", updatedAt: 8 },
          { key: "agent:main:doctor:42", sessionId: "doctor-session", updatedAt: 7 },
          {
            key: "agent:main:telegram:direct:1050",
            sessionId: "",
            updatedAt: 6,
          },
          {
            key: "agent:main:telegram:group:-1003709908795:topic:4011",
            sessionId: "topic-session",
            updatedAt: 5,
          },
        ],
      }),
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/agent/sessions");

    expect(res.status).toBe(200);
    expect(deps.clawCmd).toHaveBeenCalledWith(
      "sessions --json --all-agents",
      { quiet: true },
    );
    expect(res.body.ok).toBe(true);
    expect(res.body.sessions).toEqual([
      {
        key: "agent:morpheus:telegram:direct:1050",
        sessionId: "morpheus-direct-session",
        updatedAt: 11,
        agentId: "morpheus",
        agentLabel: "Morpheus Agent",
        channel: "telegram",
        groupName: "",
        topicName: "",
        replyChannel: "telegram",
        replyTo: "1050",
      },
      {
        key: "agent:main:main",
        sessionId: "main-session",
        updatedAt: 10,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "",
        groupName: "",
        topicName: "",
        replyChannel: "",
        replyTo: "",
      },
      {
        key: "agent:main:hook:abc",
        sessionId: "hook-session",
        updatedAt: 9,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "",
        groupName: "",
        topicName: "",
        replyChannel: "",
        replyTo: "",
      },
      {
        key: "agent:main:cron:abc",
        sessionId: "cron-session",
        updatedAt: 8,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "",
        groupName: "",
        topicName: "",
        replyChannel: "",
        replyTo: "",
      },
      {
        key: "agent:main:doctor:42",
        sessionId: "doctor-session",
        updatedAt: 7,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "",
        groupName: "",
        topicName: "",
        replyChannel: "",
        replyTo: "",
      },
      {
        key: "agent:main:telegram:direct:1050",
        sessionId: "",
        updatedAt: 6,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "telegram",
        groupName: "",
        topicName: "",
        replyChannel: "telegram",
        replyTo: "1050",
      },
      {
        key: "agent:main:telegram:group:-1003709908795:topic:4011",
        sessionId: "topic-session",
        updatedAt: 5,
        agentId: "main",
        agentLabel: "Main Agent",
        channel: "telegram",
        groupName: "AlphaClaw",
        topicName: "Rosebud",
        replyChannel: "telegram",
        replyTo: "-1003709908795:4011",
      },
    ]);
  });

  it("reports starting and not_onboarded gateway states on GET /api/status", async () => {
    const deps = createSystemDeps();
    deps.isGatewayRunning.mockResolvedValue(false);
    deps.alphaclawVersionService = {};
    const app = createApp(deps);

    const startingRes = await request(app).get("/api/status");
    expect(startingRes.status).toBe(200);
    expect(startingRes.body.gateway).toBe("starting");
    expect(startingRes.body.alphaclawVersion).toBeNull();

    // /api/status serves a shared snapshot with a short freshness window, so
    // a config change is observed by a fresh service, not the same instance.
    const notOnboardedDeps = createSystemDeps();
    notOnboardedDeps.isGatewayRunning.mockResolvedValue(false);
    notOnboardedDeps.alphaclawVersionService = {};
    notOnboardedDeps.fs.existsSync.mockReturnValue(false);
    const notOnboardedApp = createApp(notOnboardedDeps);
    const notOnboardedRes = await request(notOnboardedApp).get("/api/status");
    expect(notOnboardedRes.body.gateway).toBe("not_onboarded");
    expect(notOnboardedRes.body.configExists).toBe(false);
  });

  it("streams status events with watchdog and doctor payloads", async () => {
    vi.useFakeTimers();
    try {
      const deps = createSystemDeps();
      deps.watchdog = { getStatus: vi.fn(() => ({ lifecycle: "running" })) };
      deps.doctorService = {
        buildStatus: vi.fn(() => ({
          ok: true,
          checks: [],
          bootstrapContext: {
            // Heavy per-file listings stay on /api/doctor/status; frames only
            // carry what the shell's truncation warnings read.
            files: [{ path: "a.md", rawChars: 999999 }],
            activeFiles: [{ path: "a.md", rawChars: 999999 }],
            inactiveTruncatedFiles: [{ path: "b.md" }],
            truncationGuidance: "very long guidance text",
            hasActiveTruncation: true,
            activeTruncatedFiles: [{ path: "a.md", rawChars: 10, injectedChars: 5 }],
            activeNearLimitFiles: [],
          },
        })),
      };
      const routes = captureRoutes(deps);
      const handler = routes.get.get("/api/events/status");
      const req = new EventEmitter();
      const res = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        // A healthy client socket: write() returns true, otherwise the SSE
        // backpressure guard would count every write as backed up and
        // destroy the connection after 5 writes.
        write: vi.fn(() => true),
        destroy: vi.fn(),
        end: vi.fn(),
      };

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream",
      );
      expect(res.flushHeaders).toHaveBeenCalled();
      const firstData = res.write.mock.calls
        .map((call) => String(call[0]))
        .find((chunk) => chunk.startsWith("data: "));
      const parsed = JSON.parse(firstData.slice("data: ".length).trimEnd());
      expect(parsed.watchdogStatus).toEqual({ lifecycle: "running" });
      expect(parsed.doctorStatus).toEqual(
        expect.objectContaining({ ok: true, checks: [] }),
      );
      expect(parsed.doctorStatus.bootstrapContext).toEqual({
        hasActiveTruncation: true,
        activeTruncatedFiles: [{ path: "a.md", rawChars: 10, injectedChars: 5 }],
        activeNearLimitFiles: [],
      });
      expect(parsed.status.gateway).toBe("running");

      // Identical payloads are deduplicated by the shared snapshot: the next
      // 2s tick sends nothing new.
      res.write.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        res.write.mock.calls.some((call) =>
          String(call[0]).startsWith("event: status"),
        ),
      ).toBe(false);

      // A real change is streamed on the next tick.
      deps.watchdog.getStatus.mockReturnValue({ lifecycle: "restarting" });
      res.write.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(res.write).toHaveBeenCalledWith("event: status\n");
      const changedData = res.write.mock.calls
        .map((call) => String(call[0]))
        .find((chunk) => chunk.startsWith("data: "));
      expect(JSON.parse(changedData.slice("data: ".length)).watchdogStatus).toEqual(
        { lifecycle: "restarting" },
      );

      // A gateway-probe failure degrades to "no observation": the reducer
      // reports unknown honestly (and streams the change) instead of failing
      // the whole compute and freezing the last-good payload forever.
      deps.isGatewayRunning.mockRejectedValue(new Error("gateway probe failed"));
      res.write.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      const probeFailData = res.write.mock.calls
        .map((call) => String(call[0]))
        .find((chunk) => chunk.startsWith("data: "));
      expect(probeFailData).toBeTruthy();
      expect(
        JSON.parse(probeFailData.slice("data: ".length)).status.state.state,
      ).toBe("unknown");

      // Keepalives flow every 15s, and the ≥1-frame/10s heartbeat re-sends
      // the (unchanged) snapshot as a liveness signal.
      deps.isGatewayRunning.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(11000);
      expect(res.write).toHaveBeenCalledWith(": keepalive\n\n");
      expect(res.write).toHaveBeenCalledWith("event: status\n");

      req.emit("close");
      expect(res.end).toHaveBeenCalled();
      res.write.mockClear();
      await vi.advanceTimersByTimeAsync(30000);
      expect(res.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams status events without optional watchdog/doctor services", async () => {
    const deps = createSystemDeps();
    const routes = captureRoutes(deps);
    const handler = routes.get.get("/api/events/status");
    const req = new EventEmitter();
    const res = {
      setHeader: vi.fn(),
      write: vi.fn(() => true),
      destroy: vi.fn(),
      end: vi.fn(),
    };

    await handler(req, res);
    req.emit("close");

    const firstData = res.write.mock.calls
      .map((call) => String(call[0]))
      .find((chunk) => chunk.startsWith("data: "));
    const parsed = JSON.parse(firstData.slice("data: ".length));
    expect(parsed.watchdogStatus).toBeNull();
    expect(parsed.doctorStatus).toBeNull();
    expect(res.end).toHaveBeenCalled();
  });

  const createSseClient = () => {
    const req = new EventEmitter();
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => true),
      destroy: vi.fn(),
      end: vi.fn(),
    };
    return { req, res };
  };

  const firstStatusPayload = (res) => {
    const firstData = res.write.mock.calls
      .map((call) => String(call[0]))
      .find((chunk) => chunk.startsWith("data: "));
    return JSON.parse(firstData.slice("data: ".length).trimEnd());
  };

  it("shares the doctor-status throttle across SSE connections", async () => {
    vi.useFakeTimers();
    try {
      const deps = createSystemDeps();
      deps.doctorService = { buildStatus: vi.fn(() => ({ ok: true, checks: [] })) };
      const routes = captureRoutes(deps);
      const handler = routes.get.get("/api/events/status");
      const first = createSseClient();
      const second = createSseClient();

      await handler(first.req, first.res);
      await handler(second.req, second.res);

      // Both connections opened inside one 30s window: ONE buildStatus
      // computation served both initial events (the throttle is shared, not
      // per-connection).
      expect(deps.doctorService.buildStatus).toHaveBeenCalledTimes(1);
      expect(firstStatusPayload(first.res).doctorStatus).toEqual({
        ok: true,
        checks: [],
      });
      expect(firstStatusPayload(second.res).doctorStatus).toEqual({
        ok: true,
        checks: [],
      });

      // 2s ticks inside the window keep serving the shared cached value.
      await vi.advanceTimersByTimeAsync(4000);
      expect(deps.doctorService.buildStatus).toHaveBeenCalledTimes(1);

      // Once the 30s window elapses, the next tick recomputes exactly once.
      await vi.advanceTimersByTimeAsync(28000);
      expect(deps.doctorService.buildStatus).toHaveBeenCalledTimes(2);

      first.req.emit("close");
      second.req.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys an SSE connection after five consecutive backpressured writes", async () => {
    vi.useFakeTimers();
    try {
      const deps = createSystemDeps();
      const routes = captureRoutes(deps);
      const handler = routes.get.get("/api/events/status");
      const req = new EventEmitter();
      const res = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        // A permanently backed-up client socket: every write reports
        // backpressure.
        write: vi.fn(() => false),
        end: vi.fn(),
      };
      res.destroy = vi.fn(() => {
        res.destroyed = true;
      });

      // The snapshot service writes two chunks per frame plus keepalives;
      // the guard counts consecutive backpressured WRITES. A permanently
      // backed-up socket must be destroyed within a bounded window rather
      // than buffering frames forever.
      await handler(req, res); // first frame: writes 1-2 backpressured
      expect(res.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20000); // heartbeats + keepalives
      expect(res.destroy).toHaveBeenCalled();

      req.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the SSE backpressure counter after a successful write", async () => {
    vi.useFakeTimers();
    try {
      const deps = createSystemDeps();
      const routes = captureRoutes(deps);
      const handler = routes.get.get("/api/events/status");
      const req = new EventEmitter();
      // Four backpressured writes, then the socket drains: the counter must
      // reset instead of counting toward the destroy threshold of 5.
      const writeResults = [false, false, false, false, true];
      let writeCalls = 0;
      const res = {
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(() => {
          const flushed = writeCalls < writeResults.length ? writeResults[writeCalls] : true;
          writeCalls += 1;
          return flushed;
        }),
        destroy: vi.fn(),
        end: vi.fn(),
      };

      // Connect frame = 2 writes (event + data), both backpressured (#1-#2).
      await handler(req, res);
      expect(res.destroy).not.toHaveBeenCalled();

      // Heartbeat at ~10s adds #3-#4 (backpressured, counter 4 — still under
      // the threshold of 5); the 15s keepalive (#5) drains → counter resets;
      // later heartbeats keep streaming on the recovered socket.
      await vi.advanceTimersByTimeAsync(26000);
      expect(res.destroy).not.toHaveBeenCalled();
      expect(res.write.mock.calls.length).toBeGreaterThan(5);

      req.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default schedule when the cron config is invalid", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === "/tmp/openclaw/cron/system-sync.json") {
        return JSON.stringify({ enabled: false, schedule: "every hour" });
      }
      throw new Error("no config");
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/sync-cron");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        enabled: false,
        schedule: "0 * * * *",
      }),
    );
  });

  it("rejects invalid sync cron updates", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const badEnabled = await request(app)
      .put("/api/sync-cron")
      .send({ enabled: "yes" });
    expect(badEnabled.status).toBe(400);
    expect(badEnabled.body.error).toBe("enabled must be a boolean");

    const badSchedule = await request(app)
      .put("/api/sync-cron")
      .send({ schedule: "not-cron" });
    expect(badSchedule.status).toBe(400);
    expect(badSchedule.body.error).toBe("schedule must be a 5-field cron string");
    expect(deps.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("removes the system cron file when sync cron is disabled", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).put("/api/sync-cron").send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // No schedule provided: the current (default) schedule is preserved.
    expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/openclaw/cron/system-sync.json",
      expect.stringContaining('"schedule": "0 * * * *"'),
    );
    expect(deps.fs.rmSync).toHaveBeenCalledWith("/etc/cron.d/openclaw-hourly-sync", {
      force: true,
    });
  });

  it("returns 500 when persisting the OpenAI-compatible API toggle fails", async () => {
    const deps = createSystemDeps();
    deps.fs.writeFileSync.mockImplementation((targetPath) => {
      if (String(targetPath).endsWith("alphaclaw.json")) {
        throw new Error("disk full");
      }
    });
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/alphaclaw/config/features/openai-compat-api")
      .send({ enabled: true });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "disk full" });
  });

  it("disables the OpenAI-compatible API without touching gateway config", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState = { markRequired: vi.fn() };
    const app = createApp(deps);

    const res = await request(app)
      .put("/api/alphaclaw/config/features/openai-compat-api")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        gatewayConfigChanged: false,
        restartRequired: false,
      }),
    );
    expect(deps.ensureGatewayProxyConfig).not.toHaveBeenCalled();
  });

  it("rejects invalid release tags", async () => {
    const httpsSpy = mockHttpsGetResponse();
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get(
      `/api/alphaclaw/release-notes?tag=${encodeURIComponent("../evil")}`,
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Invalid release tag" });
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it("fetches and caches latest release notes from GitHub", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const httpsSpy = mockHttpsGetResponse({
        statusCode: 200,
        body: JSON.stringify({
          tag_name: "v0.2.0",
          name: "AlphaClaw 0.2.0",
          body: "release notes body",
          html_url: "https://github.com/garrytan/alphaclaw/releases/tag/v0.2.0",
          published_at: "2026-07-01T00:00:00Z",
        }),
      });
      const deps = createSystemDeps();
      const app = createApp(deps);

      const res = await request(app).get("/api/alphaclaw/release-notes");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        tag: "v0.2.0",
        name: "AlphaClaw 0.2.0",
        body: "release notes body",
        htmlUrl: "https://github.com/garrytan/alphaclaw/releases/tag/v0.2.0",
        publishedAt: "2026-07-01T00:00:00Z",
      });
      expect(httpsSpy).toHaveBeenCalledTimes(1);
      expect(httpsSpy.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/garrytan/alphaclaw/releases/latest",
      );
      expect(httpsSpy.mock.calls[0][1].headers.Authorization).toBeUndefined();

      // A second request within the TTL is served from cache.
      const cachedRes = await request(app).get("/api/alphaclaw/release-notes");
      expect(cachedRes.status).toBe(200);
      expect(cachedRes.body.tag).toBe("v0.2.0");
      expect(httpsSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it("fetches tagged release notes with GitHub auth and empty bodies", async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-token";
    try {
      const httpsSpy = mockHttpsGetResponse({ statusCode: 200, body: "" });
      const deps = createSystemDeps();
      const app = createApp(deps);

      const res = await request(app).get("/api/alphaclaw/release-notes?tag=v1.2.3");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        tag: "v1.2.3",
        name: "",
        body: "",
        htmlUrl: "",
        publishedAt: "",
      });
      expect(httpsSpy.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/garrytan/alphaclaw/releases/tags/v1.2.3",
      );
      expect(httpsSpy.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer gh-token",
      );
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
    }
  });

  it("propagates GitHub error statuses for release notes", async () => {
    mockHttpsGetResponse({
      statusCode: 404,
      body: JSON.stringify({ message: "Not Found" }),
    });
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/release-notes");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "Not Found" });
  });

  it("falls back to a generic message for unparsable GitHub errors", async () => {
    mockHttpsGetResponse({ statusCode: 500, body: "upstream html error page" });
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/release-notes");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: "GitHub release lookup failed with status 500",
    });
  });

  it("returns 502 when the GitHub release request errors", async () => {
    vi.spyOn(https, "get").mockImplementation(() => {
      const requestObject = new EventEmitter();
      requestObject.destroy = (err) => {
        if (err) process.nextTick(() => requestObject.emit("error", err));
      };
      process.nextTick(() =>
        requestObject.emit("error", new Error("socket hang up")),
      );
      return requestObject;
    });
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/release-notes");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "socket hang up" });
  });

  it("returns 502 when the GitHub release request times out", async () => {
    vi.spyOn(https, "get").mockImplementation(() => {
      const requestObject = new EventEmitter();
      requestObject.destroy = (err) => {
        if (err) process.nextTick(() => requestObject.emit("error", err));
      };
      process.nextTick(() => requestObject.emit("timeout"));
      return requestObject;
    });
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/release-notes");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      ok: false,
      error: "GitHub release request timed out",
    });
  });

  it("uses a fallback error message for release-note failures without details", async () => {
    vi.spyOn(https, "get").mockImplementation(() => {
      const requestObject = new EventEmitter();
      requestObject.destroy = (err) => {
        if (err) process.nextTick(() => requestObject.emit("error", err));
      };
      process.nextTick(() => requestObject.emit("error", new Error("")));
      return requestObject;
    });
    const deps = createSystemDeps();
    const app = createApp(deps);

    const res = await request(app).get("/api/alphaclaw/release-notes");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      ok: false,
      error: "Could not fetch release notes",
    });
  });

  it("returns 502 when listing agent sessions fails", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockResolvedValue({ ok: false, stderr: "gateway offline" });
    const app = createApp(deps);

    const res = await request(app).get("/api/agent/sessions");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "gateway offline" });
  });

  it("uses a fallback error when session listing fails without stderr", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockResolvedValue({ ok: false, stderr: "" });
    const app = createApp(deps);

    const res = await request(app).get("/api/agent/sessions");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "Could not load agent sessions" });
  });

  it("tolerates noisy or empty sessions CLI output", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    deps.clawCmd.mockResolvedValueOnce({ ok: true, stdout: "" });
    const emptyRes = await request(app).get("/api/agent/sessions");
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body.sessions).toEqual([]);

    deps.clawCmd.mockResolvedValueOnce({ ok: true, stdout: "no json here at all" });
    const garbageRes = await request(app).get("/api/agent/sessions");
    expect(garbageRes.status).toBe(200);
    expect(garbageRes.body.sessions).toEqual([]);

    deps.clawCmd.mockResolvedValueOnce({
      ok: true,
      stdout: `warning: sync skipped\n{"items":[{"key":"agent:main:main","id":"row-id","lastActivityAt":7}]}`,
    });
    const lineScanRes = await request(app).get("/api/agent/sessions");
    expect(lineScanRes.status).toBe(200);
    expect(lineScanRes.body.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:main",
        sessionId: "row-id",
        updatedAt: 7,
        agentLabel: "Main Agent",
      }),
    ]);

    deps.clawCmd.mockResolvedValueOnce({
      ok: true,
      stdout: `Result: {"sessions":[{"key":"agent:main:discord:chan","sessionId":"d1"}]} trailing text`,
    });
    const embeddedRes = await request(app).get("/api/agent/sessions");
    expect(embeddedRes.status).toBe(200);
    expect(embeddedRes.body.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:discord:chan",
        channel: "discord",
      }),
    ]);

    deps.clawCmd.mockResolvedValueOnce({
      ok: true,
      stdout: `[{"sessionKey":"agent:main:slack:chan","sessionId":"s1"}]`,
    });
    const arrayRes = await request(app).get("/api/agent/sessions");
    expect(arrayRes.status).toBe(200);
    expect(arrayRes.body.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:slack:chan",
        channel: "slack",
      }),
    ]);
  });

  it("labels sessions from configured agents and tolerates topic lookup failures", async () => {
    const deps = createSystemDeps();
    deps.fs.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === "/tmp/openclaw/openclaw.json") {
        return JSON.stringify({
          agents: {
            list: [
              { id: "zeta", name: "Zeta Bot" },
              { id: "beta-two", identity: { name: "Beta" } },
              { id: "gamma" },
            ],
          },
        });
      }
      throw new Error(`unexpected read: ${targetPath}`);
    });
    deps.topicRegistry.getGroup.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    deps.clawCmd.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        sessions: [
          { key: "agent:zeta:main", sessionId: "z1", updatedAt: 9 },
          { key: "agent:beta-two:main", sessionId: "b1", updatedAt: 8 },
          { key: "agent:gamma:main", sessionId: "g1", updatedAt: 7 },
          { key: "agent:___:main", sessionId: "u1", updatedAt: 6 },
          { key: "task:main:cron", sessionId: "t1", updatedAt: 5 },
          {
            key: "agent:main:telegram:group:-100999:topic:42",
            sessionId: "topic1",
            updatedAt: 4,
          },
          {},
        ],
      }),
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/agent/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((row) => [row.key, row.agentLabel])).toEqual([
      ["agent:zeta:main", "Zeta Bot"],
      ["agent:beta-two:main", "Beta"],
      ["agent:gamma:main", "Gamma Agent"],
      ["agent:___:main", "___ Agent"],
      ["task:main:cron", "Agent"],
      ["agent:main:telegram:group:-100999:topic:42", "Main Agent"],
    ]);
    const topicSession = res.body.sessions.find((row) =>
      row.key.includes(":topic:"),
    );
    expect(topicSession.groupName).toBe("");
    expect(topicSession.topicName).toBe("");
    expect(topicSession.replyTo).toBe("-100999:42");
  });

  it("validates agent messages before dispatching", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const missingRes = await request(app).post("/api/agent/message").send({});
    expect(missingRes.status).toBe(400);
    expect(missingRes.body).toEqual({ ok: false, error: "message is required" });

    const tooLongRes = await request(app)
      .post("/api/agent/message")
      .send({ message: "x".repeat(4001) });
    expect(tooLongRes.status).toBe(400);
    expect(tooLongRes.body).toEqual({
      ok: false,
      error: "message must be 4000 characters or fewer",
    });
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("sends shell-escaped agent messages without a session", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockResolvedValue({ ok: true, stdout: "queued" });
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/agent/message")
      .send({ message: "it's ready" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stdout: "queued" });
    expect(deps.clawCmd).toHaveBeenCalledWith(
      `agent --agent main --message 'it'\\''s ready'`,
      { quiet: true },
    );
  });

  it("returns 502 when the agent message dispatch fails", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockResolvedValue({ ok: false, stderr: "agent unreachable" });
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/agent/message")
      .send({ message: "hello" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "agent unreachable" });

    deps.clawCmd.mockResolvedValue({ ok: false, stderr: "" });
    const fallbackRes = await request(app)
      .post("/api/agent/message")
      .send({ message: "hello again" });
    expect(fallbackRes.status).toBe(502);
    expect(fallbackRes.body).toEqual({
      ok: false,
      error: "Could not send message to agent",
    });
  });

  it("routes session-targeted messages via deliver or session id", async () => {
    const deps = createSystemDeps();
    const sessionsPayload = JSON.stringify({
      sessions: [
        {
          key: "agent:main:telegram:direct:1050",
          sessionId: "tg-session",
          updatedAt: 10,
        },
        { key: "agent:main:main", sessionId: "main-session", updatedAt: 9 },
        { key: "agent:main:hook:x", sessionId: "", updatedAt: 8 },
      ],
    });
    deps.clawCmd.mockImplementation(async (command) => {
      if (command === "sessions --json --all-agents") {
        return { ok: true, stdout: sessionsPayload };
      }
      return { ok: true, stdout: "sent" };
    });
    const app = createApp(deps);

    const deliverRes = await request(app).post("/api/agent/message").send({
      message: "reply here",
      sessionKey: "agent:main:telegram:direct:1050",
    });
    expect(deliverRes.status).toBe(200);
    expect(deps.clawCmd).toHaveBeenCalledWith(
      `agent --agent main --message 'reply here' --deliver --reply-channel 'telegram' --reply-to '1050'`,
      { quiet: true },
    );

    const sessionIdRes = await request(app).post("/api/agent/message").send({
      message: "to main",
      sessionKey: "agent:main:main",
    });
    expect(sessionIdRes.status).toBe(200);
    expect(deps.clawCmd).toHaveBeenCalledWith(
      `agent --agent main --message 'to main' --session-id 'main-session'`,
      { quiet: true },
    );

    const bareRes = await request(app).post("/api/agent/message").send({
      message: "plain",
      sessionKey: "agent:main:hook:x",
    });
    expect(bareRes.status).toBe(200);
    expect(deps.clawCmd).toHaveBeenCalledWith(
      `agent --agent main --message 'plain'`,
      { quiet: true },
    );
  });

  it("rejects messages for unknown sessions and failed session lookups", async () => {
    const deps = createSystemDeps();
    deps.clawCmd.mockImplementation(async (command) => {
      if (command === "sessions --json --all-agents") {
        return { ok: true, stdout: JSON.stringify({ sessions: [] }) };
      }
      return { ok: true, stdout: "" };
    });
    const app = createApp(deps);

    const unknownRes = await request(app).post("/api/agent/message").send({
      message: "hello",
      sessionKey: "agent:main:missing",
    });
    expect(unknownRes.status).toBe(400);
    expect(unknownRes.body).toEqual({
      ok: false,
      error: "Selected session was not found",
    });

    deps.clawCmd.mockResolvedValue({ ok: false, stderr: "sessions broke" });
    const lookupFailRes = await request(app).post("/api/agent/message").send({
      message: "hello",
      sessionKey: "agent:main:missing",
    });
    expect(lookupFailRes.status).toBe(502);
    expect(lookupFailRes.body).toEqual({ ok: false, error: "sessions broke" });
  });

  it("returns the plain dashboard when not onboarded", async () => {
    const deps = createSystemDeps();
    deps.isOnboarded.mockReturnValue(false);
    const app = createApp(deps);

    const res = await request(app).get("/api/gateway/dashboard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, url: "/openclaw" });
    expect(deps.clawCmd).not.toHaveBeenCalled();
  });

  it("strips wrapping quotes from configured dashboard tokens", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: { auth: { token: '"quoted-token"' } },
          });
        }
        throw new Error("unexpected file");
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: "/openclaw/#token=quoted-token",
        source: "config",
      });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  }, 30000);

  it("falls back to the CLI when a configured env ref cannot be resolved", async () => {
    const previousEnvToken = process.env.ALPHACLAW_TEST_UNSET_TOKEN;
    delete process.env.ALPHACLAW_TEST_UNSET_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.readEnvFile.mockReturnValue([
        { key: "  ", value: "ignored empty key" },
        { key: "SOME_OTHER_VAR", value: '"quoted-env-value"' },
      ]);
      deps.fs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).endsWith("openclaw.json")) {
          return JSON.stringify({
            gateway: { auth: { token: "${ALPHACLAW_TEST_UNSET_TOKEN}" } },
          });
        }
        throw new Error("unexpected file");
      });
      deps.clawCmd.mockResolvedValue({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/",
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw", needsAuth: true });
      expect(deps.clawCmd).toHaveBeenCalledWith("dashboard --no-open");
    } finally {
      if (previousEnvToken === undefined) {
        delete process.env.ALPHACLAW_TEST_UNSET_TOKEN;
      } else {
        process.env.ALPHACLAW_TEST_UNSET_TOKEN = previousEnvToken;
      }
    }
  }, 30000);

  it("marks the dashboard as needing auth when the CLI fails", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValue({ ok: false, stdout: "", stderr: "boom" });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw", needsAuth: true });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  }, 30000);

  it("keeps raw CLI dashboard tokens that fail URI decoding", async () => {
    const previousEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      const deps = createSystemDeps();
      deps.clawCmd.mockResolvedValue({
        ok: true,
        stdout: "Dashboard URL: http://127.0.0.1:18789/#token=%E0%A4",
      });
      const app = createApp(deps);

      const res = await request(app).get("/api/gateway/dashboard");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        url: `/openclaw/#token=${encodeURIComponent("%E0%A4")}`,
      });
    } finally {
      if (previousEnvToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = previousEnvToken;
    }
  }, 30000);

  it("runs an async restart as a streamed operation with human step labels", async () => {
    const { setBootPhase, getBootPhase } = require("../../lib/server/boot-phase");
    // A stale failed boot phase must be cleared by a verified restart.
    setBootPhase("failed", { error: new Error("boot exploded") });
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-1",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.updateRestartOperation = vi.fn();
    deps.restartRequiredState.completeRestart = vi.fn();
    deps.operationEvents = {
      createOperation: vi.fn(() => ({ operationId: "op-1" })),
      publish: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    deps.watchdog = {
      getStatus: vi.fn(() => ({ lifecycle: "running" })),
      onExpectedRestart: vi.fn(),
      onExpectedRestartSettled: vi.fn(),
    };
    let releaseCalled = false;
    deps.gatewayLifecycleLock = {
      acquire: vi.fn(async () => () => {
        releaseCalled = true;
      }),
      getActiveOperation: vi.fn(() => null),
    };
    let resolveRestart;
    deps.restartGateway = vi.fn(({ onStep }) => {
      onStep({ step: "preparing_plugins", status: "skipped" });
      onStep({ step: "stopping", status: "running" });
      return new Promise((resolve) => {
        resolveRestart = () => resolve({ durationMs: 1234 });
      });
    });
    const app = createApp(deps);

    const res = await request(app).post("/api/gateway/restart?async=1");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, operationId: "op-1" });
    expect(deps.operationEvents.createOperation).toHaveBeenCalledWith({
      type: "gateway_restart",
      operationId: "op-1",
    });
    // Steps stream with public labels, never bare internal ids.
    expect(deps.operationEvents.publish).toHaveBeenCalledWith("op-1", {
      event: "step",
      data: expect.objectContaining({
        name: "stopping",
        label: "Stopping gateway",
        status: "running",
      }),
    });
    expect(deps.watchdog.onExpectedRestart).toHaveBeenCalled();
    expect(deps.watchdog.onExpectedRestartSettled).not.toHaveBeenCalled();

    resolveRestart();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        ok: true,
        durationMs: 1234,
      }),
    );
    expect(deps.operationEvents.complete).toHaveBeenCalledWith(
      "op-1",
      expect.objectContaining({
        ok: true,
        durationMs: 1234,
      }),
    );
    expect(releaseCalled).toBe(true);
    // The watchdog's expected-restart window closes the moment the operation
    // settles — a dead gateway must not sit suppressed until lease expiry.
    expect(deps.watchdog.onExpectedRestartSettled).toHaveBeenCalledTimes(1);
    // A verified-ready gateway supersedes a failed boot: the boot_failed
    // headline's own Retry action must be able to clear it.
    expect(getBootPhase().phase).toBe("ready");
  });

  it("attaches concurrent restart requests to the active operation", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-2",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.completeRestart = vi.fn();
    let resolveRestart;
    deps.restartGateway = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRestart = () => resolve({ durationMs: 5 });
        }),
    );
    const app = createApp(deps);

    const first = request(app).post("/api/gateway/restart?async=1");
    const firstRes = await first;
    expect(firstRes.status).toBe(202);

    const second = await request(app).post("/api/gateway/restart?async=1");
    expect(second.status).toBe(202);
    expect(second.body).toEqual({
      ok: true,
      attached: true,
      operationId: "op-2",
    });
    expect(deps.restartGateway).toHaveBeenCalledTimes(1);
    resolveRestart();
  });

  it("rejects a restart while a channel apply is in progress", async () => {
    const deps = createSystemDeps();
    deps.openclawChannelService = {
      getChannelInfo: vi.fn(() => null),
      isApplyInProgress: vi.fn(() => true),
    };
    const app = createApp(deps);

    const res = await request(app).post("/api/gateway/restart");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("apply_in_progress");
    expect(deps.restartGateway).not.toHaveBeenCalled();
  });

  it("surfaces redacted failure evidence when a restart never becomes ready", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-3",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.completeRestart = vi.fn();
    deps.operationEvents = {
      createOperation: vi.fn(),
      publish: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const previousSecret = process.env.TEST_RESTART_SECRET;
    process.env.TEST_RESTART_SECRET = "super-secret-token";
    try {
      const failure = Object.assign(
        new Error("Gateway did not become ready within 120s"),
        {
          evidence: {
            stderrTail: ["boom with super-secret-token inside", "second line"],
            timeoutMs: 120000,
          },
        },
      );
      deps.restartGateway = vi.fn(async () => {
        throw failure;
      });
      const app = createApp(deps);

      const res = await request(app).post("/api/gateway/restart");
      expect(res.status).toBe(500);
      expect(res.body.error).toContain("did not become ready");
      expect(res.body.evidence).toContain("boom with *** inside");
      expect(res.body.evidence).not.toContain("super-secret-token");
      expect(deps.restartRequiredState.completeRestart).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "op-3", ok: false }),
      );
      expect(deps.operationEvents.fail).toHaveBeenCalled();

      // The evidence stays retrievable by reference on /api/restart-status.
      deps.restartRequiredState.getLastRestartOperation = vi.fn(() => ({
        operationId: "op-3",
        status: "failed",
      }));
      const statusRes = await request(app).get("/api/restart-status");
      expect(statusRes.body.lastOperation.evidence).toContain("boom with ***");
    } finally {
      if (previousSecret === undefined) delete process.env.TEST_RESTART_SECRET;
      else process.env.TEST_RESTART_SECRET = previousSecret;
    }
  });

  it("reports restart status and surfaces snapshot failures", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const okRes = await request(app).get("/api/restart-status");
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({
      ok: true,
      restartRequired: false,
      restartInProgress: false,
      gatewayRunning: true,
      reasons: [],
      activeOperation: null,
      lastOperation: null,
    });

    deps.restartRequiredState.getSnapshot.mockRejectedValueOnce(
      new Error("state store offline"),
    );
    const errRes = await request(app).get("/api/restart-status");
    expect(errRes.status).toBe(500);
    expect(errRes.body).toEqual({ ok: false, error: "state store offline" });
  });

  it("dismisses restart-required state and surfaces failures", async () => {
    const deps = createSystemDeps();
    const app = createApp(deps);

    const okRes = await request(app).post("/api/restart-status/dismiss");
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({
      ok: true,
      restartRequired: false,
      restartInProgress: false,
      gatewayRunning: true,
    });
    expect(deps.restartRequiredState.clearRequired).toHaveBeenCalledTimes(1);

    deps.restartRequiredState.getSnapshot.mockRejectedValueOnce(
      new Error("dismiss failed"),
    );
    const errRes = await request(app).post("/api/restart-status/dismiss");
    expect(errRes.status).toBe(500);
    expect(errRes.body).toEqual({ ok: false, error: "dismiss failed" });
  });

  it("rejects gateway restarts before onboarding and surfaces failures", async () => {
    const deps = createSystemDeps();
    deps.isOnboarded.mockReturnValue(false);
    const app = createApp(deps);

    const notOnboardedRes = await request(app).post("/api/gateway/restart");
    expect(notOnboardedRes.status).toBe(400);
    expect(notOnboardedRes.body).toEqual({ ok: false, error: "Not onboarded" });
    expect(deps.restartGateway).not.toHaveBeenCalled();

    deps.isOnboarded.mockReturnValue(true);
    deps.restartGateway.mockRejectedValueOnce(new Error("restart blew up"));
    const failRes = await request(app).post("/api/gateway/restart");
    expect(failRes.status).toBe(500);
    expect(failRes.body).toEqual(
      expect.objectContaining({ ok: false, error: "restart blew up" }),
    );
    expect(deps.restartRequiredState.markRestartInProgress).toHaveBeenCalled();
    expect(deps.restartRequiredState.markRestartComplete).toHaveBeenCalled();

    // A snapshot failure after a successful restart also surfaces as a 500.
    deps.restartRequiredState.getSnapshot.mockRejectedValueOnce(
      new Error("snapshot store offline"),
    );
    const snapshotFailRes = await request(app).post("/api/gateway/restart");
    expect(snapshotFailRes.status).toBe(500);
    expect(snapshotFailRes.body).toEqual(
      expect.objectContaining({
      ok: false,
      error: "snapshot store offline",
    }),
    );
  });

  it("returns the failure as a 500 to a synchronous request attached to an in-flight restart", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-attach-fail",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.completeRestart = vi.fn();
    let rejectRestart;
    deps.restartGateway = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectRestart = () => reject(new Error("gateway never came back"));
        }),
    );
    // Raw handlers (not supertest) so the second request deterministically
    // attaches BEFORE the in-flight operation fails.
    const routes = captureRoutes(deps);
    const handler = routes.post.get("/api/gateway/restart");
    const createRes = () => {
      const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
          res.statusCode = code;
          return res;
        },
        json(payload) {
          res.body = payload;
          return res;
        },
      };
      return res;
    };

    const firstRes = createRes();
    await handler({ query: { async: "1" } }, firstRes);
    expect(firstRes.statusCode).toBe(202);

    // A second synchronous click joins the active restart (never a competing
    // one) and must surface that operation's failure as its own 500.
    const secondRes = createRes();
    const secondPending = handler({ query: {} }, secondRes);
    rejectRestart();
    await secondPending;

    expect(secondRes.statusCode).toBe(500);
    expect(secondRes.body).toEqual({
      ok: false,
      attached: true,
      operationId: "op-attach-fail",
      error: "gateway never came back",
    });
    expect(deps.restartGateway).toHaveBeenCalledTimes(1);
  });

  it("pins the legacy gateway field as a pure projection of the reduced state", async () => {
    const { setBootPhase } = require("../../lib/server/boot-phase");
    // The documented compat contract: port-up states -> "running",
    // pre-onboarding -> "not_onboarded", everything else -> "starting".
    const project = (state) => {
      if (state === "not_onboarded") return "not_onboarded";
      return ["running", "degraded", "safe_mode", "flapping"].includes(state)
        ? "running"
        : "starting";
    };
    const cases = [
      {
        expectState: "not_onboarded",
        mutate: (deps) => deps.fs.existsSync.mockReturnValue(false),
      },
      { expectState: "running", mutate: () => {} },
      {
        expectState: "degraded",
        mutate: (deps) => {
          deps.watchdog = { getStatus: () => ({ health: "degraded" }) };
        },
      },
      {
        expectState: "safe_mode",
        mutate: (deps) => {
          deps.watchdog = {
            getStatus: () => ({ health: "healthy", safeMode: true }),
          };
        },
      },
      {
        expectState: "flapping",
        mutate: (deps) => {
          deps.watchdog = { getStatus: () => ({ crashCountInWindow: 2 }) };
        },
      },
      {
        expectState: "down",
        mutate: (deps) => deps.isGatewayRunning.mockResolvedValue(false),
      },
      {
        expectState: "starting",
        mutate: (deps) => {
          deps.isGatewayRunning.mockResolvedValue(false);
          deps.watchdog = { getStatus: () => ({ lifecycle: "restarting" }) };
        },
      },
      { expectState: "boot_failed", boot: ["failed", { error: "boom" }] },
      { expectState: "booting", boot: ["starting_gateway"] },
      {
        expectState: "unknown",
        mutate: (deps) =>
          deps.isGatewayRunning.mockRejectedValue(new Error("probe broke")),
      },
    ];

    for (const testCase of cases) {
      setBootPhase(...(testCase.boot || ["ready"]));
      // Fresh deps + app per case: /api/status serves a shared snapshot with
      // a freshness window, so state changes need a fresh service.
      const deps = createSystemDeps();
      testCase.mutate?.(deps);
      const app = createApp(deps);

      const res = await request(app).get("/api/status");

      expect(res.status).toBe(200);
      expect(res.body.state.state).toBe(testCase.expectState);
      // The legacy field must ALWAYS equal the projection of the reduced
      // state — never an independent computation that can disagree.
      expect(res.body.gateway).toBe(project(testCase.expectState));
    }
    setBootPhase("ready");
  });

  it("maps the lifecycle-lock active operation onto the status badge", async () => {
    const badgeFor = async (active) => {
      const deps = createSystemDeps();
      deps.gatewayLifecycleLock = {
        acquire: vi.fn(),
        getActiveOperation: vi.fn(() => active),
      };
      const app = createApp(deps);
      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      return res.body.state.operation;
    };

    // Boot is expressed through bootPhase, never through the badge.
    expect(await badgeFor({ kind: "boot", startedAt: 111 })).toBeNull();
    expect(await badgeFor({ kind: "repair", startedAt: 222 })).toEqual({
      kind: "repair",
      label: "Repairing",
      startedAt: 222,
    });
    // Unknown kinds still render a generic badge, never a bare internal id.
    expect(await badgeFor({ kind: "compact", startedAt: 333 })).toEqual({
      kind: "compact",
      label: "Working…",
      startedAt: 333,
    });
  });

  it("records watchdog operation events for both restart outcomes", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-ok",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.completeRestart = vi.fn();
    deps.watchdog = {
      getStatus: vi.fn(() => ({})),
      onExpectedRestart: vi.fn(),
      onExpectedRestartSettled: vi.fn(),
      recordOperationEvent: vi.fn(),
    };
    deps.restartGateway = vi.fn(async () => ({ durationMs: 900, downtimeMs: 350 }));
    const app = createApp(deps);

    const okRes = await request(app).post("/api/gateway/restart");
    expect(okRes.status).toBe(200);
    expect(deps.watchdog.recordOperationEvent).toHaveBeenCalledWith({
      kind: "gateway_restart",
      status: "ok",
      details: {
        operationId: "op-ok",
        trigger: "manual",
        durationMs: 900,
        downtimeMs: 350,
      },
    });

    const previousSecret = process.env.TEST_RESTART_EVENT_SECRET;
    process.env.TEST_RESTART_EVENT_SECRET = "hush-hush-value";
    try {
      deps.restartRequiredState.beginRestart.mockReturnValue({
        operationId: "op-bad",
        reasonsSnapshot: [],
      });
      deps.restartGateway.mockRejectedValueOnce(
        new Error("bind failed for token hush-hush-value"),
      );

      const failRes = await request(app).post("/api/gateway/restart");
      expect(failRes.status).toBe(500);
      // The failure event carries the REDACTED message, never the secret.
      expect(deps.watchdog.recordOperationEvent).toHaveBeenCalledWith({
        kind: "gateway_restart",
        status: "failed",
        details: {
          operationId: "op-bad",
          trigger: "manual",
          error: "bind failed for token ***",
        },
      });
    } finally {
      if (previousSecret === undefined) {
        delete process.env.TEST_RESTART_EVENT_SECRET;
      } else {
        process.env.TEST_RESTART_EVENT_SECRET = previousSecret;
      }
    }
  });

  it("forwards the active restart operation's real expiresAt to the watchdog", async () => {
    const deps = createSystemDeps();
    deps.restartRequiredState.beginRestart = vi.fn(() => ({
      operationId: "op-lease",
      reasonsSnapshot: [],
    }));
    deps.restartRequiredState.completeRestart = vi.fn();
    const expiresAt = Date.now() + 123456;
    deps.restartRequiredState.getActiveRestartOperation = vi.fn(() => ({
      operationId: "op-lease",
      expiresAt,
    }));
    deps.watchdog = {
      getStatus: vi.fn(() => ({})),
      onExpectedRestart: vi.fn(),
      onExpectedRestartSettled: vi.fn(),
    };
    deps.restartGateway = vi.fn(async () => ({ durationMs: 1 }));
    const app = createApp(deps);

    const res = await request(app).post("/api/gateway/restart");

    expect(res.status).toBe(200);
    // The suppression window forwarded to the watchdog is the operation
    // record's OWN lease, not a value invented by the route.
    expect(deps.watchdog.onExpectedRestart).toHaveBeenCalledWith({ expiresAt });
    expect(deps.watchdog.onExpectedRestartSettled).toHaveBeenCalledTimes(1);
  });
});
