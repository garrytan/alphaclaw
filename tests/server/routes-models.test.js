const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  createModelCatalogCache,
  kModelCatalogBootstrapSource,
  kModelCatalogLoadTimeoutMs,
} = require("../../lib/server/model-catalog-cache");
const { registerModelRoutes } = require("../../lib/server/routes/models");
const { kFallbackOnboardingModels } = require("../../lib/server/constants");

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const createModelDeps = () => {
  const deps = {
    shellCmd: vi.fn(),
    execFileCmd: vi.fn(),
    gatewayEnv: vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" })),
    parseJsonFromNoisyOutput: vi.fn(() => ({})),
    normalizeOnboardingModels: vi.fn(() => []),
    readOpenclawVersion: vi.fn(() => "2026.4.15"),
    isOnboarded: vi.fn(() => true),
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(() => true),
    authProfiles: {
      getModelConfig: vi.fn(() => ({ primary: null, configuredModels: {} })),
      listProfiles: vi.fn(() => []),
      loadAuthStore: vi.fn(() => ({ profiles: {}, order: {} })),
      setModelConfig: vi.fn(),
      upsertProfile: vi.fn(),
      getEnvVarForApiKeyProvider: vi.fn((provider) =>
        provider === "openai" ? "OPENAI_API_KEY" : "",
      ),
      listApiKeyProviders: vi.fn(() => ["openai"]),
      getDefaultProfileIdForApiKeyProvider: vi.fn((provider) =>
        provider ? `${provider}:default` : "",
      ),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      removeApiKeyProfileForEnvVar: vi.fn(),
      setAuthOrder: vi.fn(),
      syncConfigAuthReferencesForAgent: vi.fn(),
      removeProfile: vi.fn(),
    },
  };
  return deps;
};

// Every createApp() call mints a temp root; without cleanup a full run leaks
// one directory per test into os.tmpdir() (upstream #123/#71).
const kTempDirs = [];
afterEach(() => {
  while (kTempDirs.length) {
    fs.rmSync(kTempDirs.pop(), { recursive: true, force: true });
  }
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "alphaclaw-routes-models-"),
  );
  kTempDirs.push(tempRoot);
  const modelCatalogCache = createModelCatalogCache({
    cachePath: path.join(tempRoot, "cache", "model-catalog.json"),
    shellCmd: deps.shellCmd,
    gatewayEnv: deps.gatewayEnv,
    parseJsonFromNoisyOutput: deps.parseJsonFromNoisyOutput,
    normalizeOnboardingModels: deps.normalizeOnboardingModels,
    readOpenclawVersion: deps.readOpenclawVersion,
    shouldStartDynamicRefresh: deps.isOnboarded,
  });
  registerModelRoutes({
    app,
    ...deps,
    modelCatalogCache,
  });
  return app;
};

describe("server/routes/models", () => {
  it("bootstraps with the bundled catalog, then returns normalized models from openclaw output", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("noise");
    deps.parseJsonFromNoisyOutput.mockReturnValue({
      models: [{ key: "openai/gpt-5.1-codex", name: "GPT" }],
    });
    deps.normalizeOnboardingModels.mockReturnValue([
      { key: "openai/gpt-5.1-codex", provider: "openai", label: "GPT" },
    ]);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
    });
    expect(deps.shellCmd).toHaveBeenCalledWith("openclaw models list --all --json", {
      env: { OPENCLAW_GATEWAY_TOKEN: "token" },
      timeout: kModelCatalogLoadTimeoutMs,
    });

    await flushPromises();

    const refreshed = await request(app).get("/api/models");

    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toEqual(
      expect.objectContaining({
        ok: true,
        source: "openclaw",
        stale: false,
        refreshing: false,
        fetchedAt: expect.any(Number),
        models: [{ key: "openai/gpt-5.1-codex", provider: "openai", label: "GPT" }],
      }),
    );
  });

  it("serves the bundled catalog while a dynamic refresh resolves empty", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("{}");
    deps.parseJsonFromNoisyOutput.mockReturnValue({ models: [] });
    deps.normalizeOnboardingModels.mockReturnValue([]);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
    });
  });

  it("serves the bundled catalog when the dynamic refresh command throws", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockRejectedValue(new Error("boom"));
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: true,
      models: kFallbackOnboardingModels,
    });
  });

  it("serves the bundled catalog without launching openclaw before onboarding", async () => {
    const deps = createModelDeps();
    deps.isOnboarded.mockReturnValue(false);
    const app = createApp(deps);

    const res = await request(app).get("/api/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      source: kModelCatalogBootstrapSource,
      fetchedAt: null,
      stale: true,
      refreshing: false,
      models: kFallbackOnboardingModels,
    });
    expect(deps.shellCmd).not.toHaveBeenCalled();
  });

  it("returns thinking options for a model key on GET /api/models/thinking-options", async () => {
    const deps = createModelDeps();
    const app = createApp(deps);

    const res = await request(app).get(
      "/api/models/thinking-options?modelKey=anthropic/claude-opus-4-7",
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.modelKey).toBe("anthropic/claude-opus-4-7");
    expect(Array.isArray(res.body.levels)).toBe(true);
    expect(res.body.levels.length).toBeGreaterThan(1);
    expect(res.body.levels.some((entry) => entry.id === "off")).toBe(true);
    expect(typeof res.body.modelDefault).toBe("string");
    expect(typeof res.body.inheritedDefault).toBe("string");
  });

  it("returns model status payload on GET /api/models/status", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("{}");
    deps.parseJsonFromNoisyOutput.mockReturnValue({
      resolvedDefault: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
    const app = createApp(deps);

    const res = await request(app).get("/api/models/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      modelKey: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
  });

  it("recovers model status payload from failed command output", async () => {
    const deps = createModelDeps();
    const err = new Error("plugin load failed");
    err.stdout =
      'prefix\n{"resolvedDefault":"openai/gpt-5.1-codex","fallbacks":["anthropic/claude-opus-4-6"],"imageModel":"google/gemini-3.1-pro-preview"}\n';
    err.stderr =
      '[plugins] google failed to load from /app/node_modules/openclaw/dist/extensions/google/index.js';
    deps.shellCmd.mockRejectedValue(err);
    deps.parseJsonFromNoisyOutput.mockImplementation((raw) =>
      String(raw).includes("resolvedDefault")
        ? {
            resolvedDefault: "openai/gpt-5.1-codex",
            fallbacks: ["anthropic/claude-opus-4-6"],
            imageModel: "google/gemini-3.1-pro-preview",
          }
        : null,
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/models/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      modelKey: "openai/gpt-5.1-codex",
      fallbacks: ["anthropic/claude-opus-4-6"],
      imageModel: "google/gemini-3.1-pro-preview",
    });
  });

  it("validates modelKey on POST /api/models/set", async () => {
    const deps = createModelDeps();
    const app = createApp(deps);

    const res = await request(app).post("/api/models/set").send({ modelKey: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "Missing modelKey" });
    expect(deps.execFileCmd).not.toHaveBeenCalled();
  });

  it("sets model when modelKey is valid (argv form, no shell)", async () => {
    const deps = createModelDeps();
    deps.execFileCmd.mockResolvedValue("");
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "openai/gpt-5.1-codex" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.execFileCmd).toHaveBeenCalledWith(
      "openclaw",
      ["models", "set", "--", "openai/gpt-5.1-codex"],
      {
        env: { OPENCLAW_GATEWAY_TOKEN: "token" },
        timeout: 30000,
      },
    );
  });

  it("passes a nested provider/vendor/model id through unharmed (allow-legit)", async () => {
    const deps = createModelDeps();
    deps.execFileCmd.mockResolvedValue("");
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: "openrouter/vendor/model" });

    expect(res.status).toBe(200);
    expect(deps.execFileCmd).toHaveBeenCalledWith(
      "openclaw",
      ["models", "set", "--", "openrouter/vendor/model"],
      expect.any(Object),
    );
  });

  it("never shell-interprets an injection payload in modelKey (C1)", async () => {
    const deps = createModelDeps();
    deps.execFileCmd.mockResolvedValue("");
    const app = createApp(deps);

    const payload = "a/b$(touch /tmp/pwn)";
    const res = await request(app)
      .post("/api/models/set")
      .send({ modelKey: payload });

    // The payload is passed as a single inert argv element — never through /bin/sh.
    expect(res.status).toBe(200);
    expect(deps.shellCmd).not.toHaveBeenCalled();
    expect(deps.execFileCmd).toHaveBeenCalledWith(
      "openclaw",
      ["models", "set", "--", payload],
      expect.any(Object),
    );
  });

  it("re-syncs auth references on PUT /api/models/config", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    const app = createApp(deps);

    const res = await request(app).put("/api/models/config").send({
      primary: "openai-codex/gpt-5.3-codex",
      configuredModels: {
        "openai-codex/gpt-5.3-codex": {},
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deps.authProfiles.setModelConfig).toHaveBeenCalledWith({
      primary: "openai-codex/gpt-5.3-codex",
      configuredModels: {
        "openai-codex/gpt-5.3-codex": {},
      },
    });
    expect(deps.authProfiles.syncConfigAuthReferencesForAgent).toHaveBeenCalledWith(
      undefined,
    );
    expect(deps.shellCmd).toHaveBeenCalledWith(
      'alphaclaw git-sync -m "models: update config" -f "openclaw.json"',
      { timeout: 30000 },
    );
  });

  it("prefills default api-key auth profiles from env vars on GET /api/models/config", async () => {
    const deps = createModelDeps();
    deps.readEnvFile.mockReturnValue([{ key: "GEMINI_API_KEY", value: "AI-live-123" }]);
    deps.authProfiles.listApiKeyProviders.mockReturnValue(["google"]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation((provider) =>
      provider === "google" ? "GEMINI_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app).get("/api/models/config");

    expect(res.status).toBe(200);
    expect(res.body.authProfiles).toEqual([
      {
        id: "google:default",
        type: "api_key",
        provider: "google",
        key: "AI-live-123",
      },
    ]);
  });

  it("writes API-key model auth changes back to env vars", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([{ key: "OPENAI_API_KEY", value: "" }]);
    const app = createApp(deps);

    const res = await request(app).put("/api/models/config").send({
      profiles: [
        {
          id: "openai:default",
          type: "api_key",
          provider: "openai",
          key: "sk-live-123",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "OPENAI_API_KEY", value: "sk-live-123" },
    ]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("removes API-key env vars when profile key is cleared", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([{ key: "OPENAI_API_KEY", value: "sk-live-123" }]);
    const app = createApp(deps);

    const res = await request(app).put("/api/models/config").send({
      profiles: [
        {
          id: "openai:default",
          type: "api_key",
          provider: "openai",
          key: "",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("writes newly supported provider API keys back to env vars", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation((provider) =>
      provider === "zai" ? "ZAI_API_KEY" : "",
    );
    deps.readEnvFile.mockReturnValue([{ key: "ZAI_API_KEY", value: "" }]);
    const app = createApp(deps);

    const res = await request(app).put("/api/models/config").send({
      profiles: [
        {
          id: "zai:default",
          type: "api_key",
          provider: "zai",
          key: "zai-live-123",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(deps.writeEnvFile).toHaveBeenCalledWith([
      { key: "ZAI_API_KEY", value: "zai-live-123" },
    ]);
    expect(deps.reloadEnv).toHaveBeenCalledTimes(1);
  });

  it("syncs env-backed api-key profiles into auth storage on PUT /api/models/config", async () => {
    const deps = createModelDeps();
    deps.shellCmd.mockResolvedValue("");
    deps.readEnvFile.mockReturnValue([{ key: "GEMINI_API_KEY", value: "AI-live-123" }]);
    deps.authProfiles.listApiKeyProviders.mockReturnValue(["google"]);
    deps.authProfiles.getEnvVarForApiKeyProvider.mockImplementation((provider) =>
      provider === "google" ? "GEMINI_API_KEY" : "",
    );
    const app = createApp(deps);

    const res = await request(app).put("/api/models/config").send({
      primary: "google/gemini-3.1-pro-preview",
      configuredModels: {
        "google/gemini-3.1-pro-preview": {},
      },
    });

    expect(res.status).toBe(200);
    expect(deps.authProfiles.upsertApiKeyProfileForEnvVar).toHaveBeenCalledWith(
      "google",
      "AI-live-123",
      undefined,
    );
  });
});

describe("server/routes/models state-DB quiet period", () => {
  const { StateDbQuietError } = require("../../lib/server/state-db-quiet");

  const expectBackupInProgress = (res) => {
    expect(res.status).toBe(409);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.body).toEqual({
      ok: false,
      code: "backup_in_progress",
      error: "A backup is in progress; retry in about two minutes.",
    });
  };

  it("PUT /api/models/auth/:profileId maps a quiet-period write to 409 backup_in_progress", async () => {
    const deps = createModelDeps();
    deps.authProfiles.upsertProfile.mockImplementation(() => {
      throw new StateDbQuietError();
    });
    const app = createApp(deps);
    const res = await request(app)
      .put("/api/models/auth/openai:default")
      .send({ type: "api_key", provider: "openai", key: "sk-1" });
    expectBackupInProgress(res);
    expect(deps.writeEnvFile).not.toHaveBeenCalled();
  });

  it("DELETE /api/models/auth/:profileId maps a quiet-period write to 409", async () => {
    const deps = createModelDeps();
    deps.authProfiles.removeProfile.mockImplementation(() => {
      throw new StateDbQuietError();
    });
    const app = createApp(deps);
    const res = await request(app).delete("/api/models/auth/openai:default");
    expectBackupInProgress(res);
  });

  it("PUT /api/models/config maps a quiet-period profile write to 409 and never runs the git sync", async () => {
    const deps = createModelDeps();
    deps.authProfiles.upsertProfile.mockImplementation(() => {
      throw new StateDbQuietError();
    });
    const app = createApp(deps);
    const res = await request(app)
      .put("/api/models/config")
      .send({
        primary: "openai/gpt-5.1-codex",
        profiles: [{ id: "openai:default", type: "api_key", provider: "openai", key: "sk-1" }],
      });
    expectBackupInProgress(res);
    expect(deps.shellCmd).not.toHaveBeenCalledWith(expect.stringMatching(/git/));
  });

  it("other auth-store failures keep their 500 mapping", async () => {
    const deps = createModelDeps();
    deps.authProfiles.upsertProfile.mockImplementation(() => {
      throw new Error("schema drift");
    });
    const app = createApp(deps);
    const res = await request(app)
      .put("/api/models/auth/openai:default")
      .send({ type: "api_key", provider: "openai", key: "sk-1" });
    expect(res.status).toBe(500);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.body).toEqual({ ok: false, error: "schema drift" });
  });
});
