describe("frontend/model-catalog", () => {
  it("returns catalog models when the payload is valid", async () => {
    const { getModelCatalogModels } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getModelCatalogModels({
        models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
    ).toEqual([{ key: "openai/gpt-5.4", label: "GPT-5.4" }]);
    expect(getModelCatalogModels(null)).toEqual([]);
  });

  it("preserves an existing onboarding selection", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [{ key: "openai-codex/gpt-5.4", label: "GPT-5.4" }],
        currentModelKey: "anthropic/claude-opus-4-6",
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("defaults to Claude Opus 4.8 when it is in the catalog", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [
          { key: "openai-codex/gpt-5.4", label: "GPT-5.4" },
          { key: "anthropic/claude-opus-4-7", label: "Opus 4.7" },
          { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
        ],
      }),
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("falls back to the first featured model when Opus 4.8 is unavailable", async () => {
    const { getInitialOnboardingModelKey } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(
      getInitialOnboardingModelKey({
        catalog: [
          { key: "openai-codex/gpt-5.4", label: "GPT-5.4" },
          { key: "anthropic/claude-opus-4-7", label: "Opus 4.7" },
          { key: "anthropic/claude-opus-4-6", label: "Opus 4.6" },
        ],
      }),
    ).toBe("anthropic/claude-opus-4-7");
  });

  it("reports whether the catalog is still refreshing", async () => {
    const { isModelCatalogRefreshing } = await import(
      "../../lib/public/js/lib/model-catalog.js"
    );

    expect(isModelCatalogRefreshing({ refreshing: true })).toBe(true);
    expect(isModelCatalogRefreshing({ refreshing: false })).toBe(false);
  });

  it("forces a real fetch when preloading the onboarding model catalog", async () => {
    vi.resetModules();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
      }),
    });

    const {
      getCached,
      invalidateCache,
      setCached,
    } = await import("../../lib/public/js/lib/api-cache.js");
    const {
      kModelCatalogCacheKey,
      preloadModelCatalog,
    } = await import("../../lib/public/js/lib/model-catalog.js");

    invalidateCache(kModelCatalogCacheKey);
    setCached(kModelCatalogCacheKey, {
      models: [{ key: "fallback/model", label: "Fallback" }],
    });

    const result = await preloadModelCatalog();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/models",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(result).toEqual({
      models: [{ key: "openai/gpt-5.4", label: "GPT-5.4" }],
    });
    expect(getCached(kModelCatalogCacheKey)).toEqual(result);
  });

  describe("resolveOnboardingModelDefault (GPT-5.6 defaults)", () => {
    const load = () => import("../../lib/public/js/lib/model-catalog.js");
    const withGpt56 = [
      { key: "openai/gpt-5.6" },
      { key: "openai/gpt-5.6-sol" },
      { key: "anthropic/claude-opus-4-8" },
    ];

    it("defaults a fresh API-key OpenAI setup to the gpt-5.6 alias when listed", async () => {
      const { resolveOnboardingModelDefault } = await load();
      expect(
        resolveOnboardingModelDefault({ catalog: withGpt56, authProvider: "openai" }),
      ).toBe("openai/gpt-5.6");
    });

    it("defaults a fresh Codex OAuth setup to the exact gpt-5.6-sol when listed", async () => {
      const { resolveOnboardingModelDefault } = await load();
      expect(
        resolveOnboardingModelDefault({
          catalog: withGpt56,
          authProvider: "openai-codex",
        }),
      ).toBe("openai/gpt-5.6-sol");
    });

    it("never preselects a beta-only default absent from the catalog", async () => {
      const { resolveOnboardingModelDefault } = await load();
      // Stable-pin catalog: no gpt-5.6. Falls back to the catalog-gated default.
      const stableCatalog = [{ key: "anthropic/claude-opus-4-8" }];
      expect(
        resolveOnboardingModelDefault({
          catalog: stableCatalog,
          authProvider: "openai",
        }),
      ).toBe("anthropic/claude-opus-4-8");
    });

    it("respects an already-chosen model", async () => {
      const { resolveOnboardingModelDefault } = await load();
      expect(
        resolveOnboardingModelDefault({
          catalog: withGpt56,
          authProvider: "openai",
          currentModelKey: "anthropic/claude-opus-4-8",
        }),
      ).toBe("anthropic/claude-opus-4-8");
    });
  });
});
