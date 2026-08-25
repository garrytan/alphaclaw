const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveOpenclawConfigPath,
  OpenclawConfigReadError,
  readOpenclawConfig,
  readOpenclawConfigForWrite,
  updateOpenclawConfig,
  writeOpenclawConfig,
} = require("../../lib/server/openclaw-config");

// A config only openclaw itself can parse (JSON5 comments, trailing commas,
// ${ENV} substitution). alphaclaw must refuse to rewrite it — anything else
// would wipe the operator's config (E2).
const kJson5Fixture = `{
  // operator-maintained config
  gateway: {
    auth: { token: "\${GATEWAY_AUTH_TOKEN}" },
  },
  channels: {
    telegram: { botToken: "\${TELEGRAM_BOT_TOKEN}", },
  },
}
`;

describe("server/openclaw-config", () => {
  let openclawDir = "";

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-config-"));
  });

  afterEach(() => {
    if (openclawDir) fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  const configPath = () => resolveOpenclawConfigPath({ openclawDir });

  describe("readOpenclawConfigForWrite", () => {
    it("treats a missing file as a legitimate empty config", () => {
      expect(readOpenclawConfigForWrite({ openclawDir })).toEqual({});
    });

    it("throws OpenclawConfigReadError on a JSON5-style file and leaves it untouched", () => {
      fs.writeFileSync(configPath(), kJson5Fixture);
      let caught = null;
      try {
        readOpenclawConfigForWrite({ openclawDir });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpenclawConfigReadError);
      expect(caught.code).toBe("OPENCLAW_CONFIG_UNREADABLE");
      expect(caught.configPath).toBe(configPath());
      expect(fs.readFileSync(configPath(), "utf8")).toBe(kJson5Fixture);
    });

    it("throws when the root is not an object", () => {
      fs.writeFileSync(configPath(), "[1, 2]");
      expect(() => readOpenclawConfigForWrite({ openclawDir })).toThrow(
        OpenclawConfigReadError,
      );
      fs.writeFileSync(configPath(), '"just a string"');
      expect(() => readOpenclawConfigForWrite({ openclawDir })).toThrow(
        OpenclawConfigReadError,
      );
    });

    it("wraps non-ENOENT read errors in OpenclawConfigReadError", () => {
      const fsModule = {
        readFileSync: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      };
      expect(() =>
        readOpenclawConfigForWrite({ fsModule, openclawDir }),
      ).toThrow(OpenclawConfigReadError);
    });

    it("parses a valid config", () => {
      fs.writeFileSync(configPath(), JSON.stringify({ channels: {} }));
      expect(readOpenclawConfigForWrite({ openclawDir })).toEqual({
        channels: {},
      });
    });
  });

  describe("readOpenclawConfig (legacy read-only fallback)", () => {
    it("returns the fallback on parse failure instead of throwing", () => {
      fs.writeFileSync(configPath(), kJson5Fixture);
      expect(readOpenclawConfig({ openclawDir })).toEqual({});
      expect(readOpenclawConfig({ openclawDir, fallback: { a: 1 } })).toEqual({
        a: 1,
      });
    });

    it("returns the fallback when the file is missing", () => {
      expect(readOpenclawConfig({ openclawDir })).toEqual({});
    });

    it("returns the parsed config when readable", () => {
      fs.writeFileSync(configPath(), '{"x": 2}');
      expect(readOpenclawConfig({ openclawDir })).toEqual({ x: 2 });
    });
  });

  describe("updateOpenclawConfig", () => {
    it("writes atomically and returns the mutate result", () => {
      fs.writeFileSync(configPath(), JSON.stringify({ keep: true }));
      const result = updateOpenclawConfig({
        openclawDir,
        mutate: (cfg) => {
          cfg.added = "yes";
          return { custom: 42 };
        },
      });
      expect(result.custom).toBe(42);
      expect(result.configPath).toBe(configPath());
      expect(result.config).toEqual({ keep: true, added: "yes" });

      const written = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      expect(written).toEqual({ keep: true, added: "yes" });
      // No torn temp files or leftover locks.
      const leftovers = fs
        .readdirSync(openclawDir)
        .filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
      expect(leftovers).toEqual([]);
    });

    it("bootstraps a missing config through the mutate callback", () => {
      const result = updateOpenclawConfig({
        openclawDir,
        mutate: (cfg) => {
          cfg.fresh = true;
        },
      });
      expect(result.config).toEqual({ fresh: true });
      expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({
        fresh: true,
      });
    });

    it("fails closed on an unparseable config: throws and never writes", () => {
      fs.writeFileSync(configPath(), kJson5Fixture);
      const mutate = vi.fn();
      expect(() => updateOpenclawConfig({ openclawDir, mutate })).toThrow(
        OpenclawConfigReadError,
      );
      expect(mutate).not.toHaveBeenCalled();
      // Byte-identical: nothing was wiped or rewritten.
      expect(fs.readFileSync(configPath(), "utf8")).toBe(kJson5Fixture);
      // The lock is released even on failure.
      expect(fs.existsSync(`${configPath()}.lock`)).toBe(false);
    });
  });

  describe("writeOpenclawConfig", () => {
    it("writes the config atomically with default spacing", () => {
      writeOpenclawConfig({ openclawDir, config: { a: 1 } });
      expect(fs.readFileSync(configPath(), "utf8")).toBe(
        JSON.stringify({ a: 1 }, null, 2),
      );
      const leftovers = fs
        .readdirSync(openclawDir)
        .filter((name) => name.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });
});
