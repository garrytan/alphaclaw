const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const {
  buildCatalogEntry,
  loadThinkingModule,
  normalizeThinkingDefaultValue,
  resolveThinkingModulePath,
  resolveThinkingOptionsForModel,
  splitModelKey,
} = require("../../lib/server/openclaw-thinking");

describe("server/openclaw-thinking coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("splits model keys without a provider prefix", () => {
    expect(splitModelKey("gpt-5.6-sol")).toEqual({
      provider: "",
      model: "gpt-5.6-sol",
    });
    expect(splitModelKey("/model")).toEqual({ provider: "", model: "/model" });
    expect(splitModelKey()).toEqual({ provider: "", model: "" });
    expect(splitModelKey("openai/gpt")).toEqual({
      provider: "openai",
      model: "gpt",
    });
  });

  it("builds catalog entries with optional reasoning and compat", () => {
    expect(buildCatalogEntry()).toBeNull();
    expect(buildCatalogEntry({ provider: "openai" })).toBeNull();
    expect(buildCatalogEntry({ model: "gpt" })).toBeNull();
    expect(buildCatalogEntry({ provider: " openai ", model: " gpt " })).toEqual({
      provider: "openai",
      id: "gpt",
    });
    expect(
      buildCatalogEntry({
        provider: "openai",
        model: "gpt",
        reasoning: true,
        compat: { supportsThinking: true },
      }),
    ).toEqual({
      provider: "openai",
      id: "gpt",
      reasoning: true,
      compat: { supportsThinking: true },
    });
    expect(
      buildCatalogEntry({ provider: "openai", model: "gpt", compat: "bogus" }),
    ).toEqual({ provider: "openai", id: "gpt" });
  });

  it("returns empty thinking options for model keys without a provider", async () => {
    await expect(
      resolveThinkingOptionsForModel({ modelKey: "plain" }),
    ).resolves.toEqual({ levels: [], modelDefault: "off" });
    await expect(resolveThinkingOptionsForModel()).resolves.toEqual({
      levels: [],
      modelDefault: "off",
    });
  });

  it("normalizes empty, invalid, and valid thinking defaults", async () => {
    await expect(normalizeThinkingDefaultValue("")).resolves.toBeNull();
    await expect(normalizeThinkingDefaultValue(null)).resolves.toBeNull();
    await expect(normalizeThinkingDefaultValue(undefined)).resolves.toBeNull();
    await expect(normalizeThinkingDefaultValue("bogus")).resolves.toBeNull();
    await expect(normalizeThinkingDefaultValue("medium")).resolves.toBe(
      "medium",
    );
  });

  it("resolves and loads a candidate's .mjs thinking API while rejecting unrelated chunks", async () => {
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-thinking-mjs-"));
    try {
      const source = "export const listThinkingLevelOptions = () => [{ id: 'off', label: 'Off' }];";
      fs.writeFileSync(path.join(distDir, "thinking-api.mjs"), source);
      fs.writeFileSync(path.join(distDir, "thinking-policy.mjs"), source);
      fs.writeFileSync(path.join(distDir, "thinking-noop.mjs"), "export const unrelated = true;");
      expect(() => resolveThinkingModulePath(distDir)).toThrow("OpenClaw thinking module not found");
      const modulePath = path.join(distDir, "thinking-runtime.mjs");
      fs.writeFileSync(modulePath, source);
      expect(resolveThinkingModulePath(distDir)).toBe(modulePath);
      const loaded = await import(pathToFileURL(modulePath).href);
      expect(loaded.listThinkingLevelOptions()).toEqual([{ id: "off", label: "Off" }]);
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it("throws when no OpenClaw thinking module can be resolved, then recovers", async () => {
    const realReadFileSync = fs.readFileSync;
    const readdirSpy = vi
      .spyOn(fs, "readdirSync")
      .mockReturnValue([
        "thinking-api.js",
        "thinking-policy.js",
        "thinking-noop.js",
        "other.js",
      ]);
    const readFileSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((targetPath, ...rest) => {
        if (String(targetPath).includes("thinking-noop.js")) {
          return "module.exports = {};";
        }
        return realReadFileSync(targetPath, ...rest);
      });

    await expect(loadThinkingModule()).rejects.toThrow(
      "OpenClaw thinking module not found",
    );

    readdirSpy.mockRestore();
    readFileSpy.mockRestore();

    // The module promise is only cached on success, so the real installed
    // openclaw module still resolves afterwards.
    const mod = await loadThinkingModule();
    expect(mod).toBeTruthy();

    const options = await resolveThinkingOptionsForModel({
      modelKey: "anthropic/claude-opus-4-7",
    });
    expect(options.levels.length).toBeGreaterThan(0);
  });
});
