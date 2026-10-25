const { buildSidecarEnv, parseEnvFileText, resolveSidecarUser } = require("../../lib/server/sidecars/env");

const entry = (overrides = {}) => ({ name: "s", env: {}, envUnset: [], inheritEnv: false, envFile: null, ...overrides });

describe("sidecar env", () => {
  const baseEnv = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: "/root",
    SETUP_PASSWORD: "admin-secret",
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_BASE_URL: "b",
    OPENAI_API_KEY: "o",
  };

  it("starts from a minimal base: no AlphaClaw secrets unless inheritEnv", () => {
    const { env } = buildSidecarEnv(entry(), { baseEnv });
    expect(env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/root", ALPHACLAW_SIDECAR_NAME: "s" });
  });

  it("inheritEnv + envUnset prefix + HOME override reproduce `env -u … HOME=…`", () => {
    const { env } = buildSidecarEnv(
      entry({ inheritEnv: true, envUnset: ["ANTHROPIC_*", "OPENAI_API_KEY"], env: { HOME: "/srv" } }),
      { baseEnv },
    );
    expect(env.HOME).toBe("/srv");
    expect(env.SETUP_PASSWORD).toBe("admin-secret");
    expect(Object.keys(env).filter((key) => key.startsWith("ANTHROPIC_") || key === "OPENAI_API_KEY")).toEqual([]);
  });

  it("merges envFile, then env, then removes envUnset", () => {
    const readFileSync = () => "# comment\nexport DB_URL='postgres://x'\nTOKEN=\"t\"\nKEEP=1\nbad line\n";
    const { env } = buildSidecarEnv(
      entry({ envFile: "/srv/.env", env: { KEEP: "2" }, envUnset: ["TOKEN"] }),
      { baseEnv, readFileSync },
    );
    expect(env).toMatchObject({ DB_URL: "postgres://x", KEEP: "2" });
    expect(env.TOKEN).toBeUndefined();
  });

  it("fails with a readable reason when the envFile is missing", () => {
    const readFileSync = () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    expect(buildSidecarEnv(entry({ envFile: "/srv/.env" }), { baseEnv, readFileSync })).toEqual({
      ok: false,
      error: "envFile /srv/.env could not be read (ENOENT)",
    });
  });

  it("sets HOME, USER and LOGNAME from the resolved user", () => {
    const { env } = buildSidecarEnv(entry(), { baseEnv, identity: { uid: 1000, gid: 1000, name: "kb", home: "/home/kb" } });
    expect(env).toMatchObject({ HOME: "/home/kb", USER: "kb", LOGNAME: "kb" });
  });

  it("parses KEY=VALUE files the way an operator writes them", () => {
    expect(parseEnvFileText("A=1\nexport B=\"two words\"\n=x\n1BAD=y\nC=a=b\n")).toEqual({ A: "1", B: "two words", C: "a=b" });
  });

  describe("user resolution", () => {
    const passwd = () => "root:x:0:0:root:/root:/bin/bash\nkb:x:1000:1000::/home/kb:/bin/bash\n";

    it("resolves a name to uid, gid and home when running as root", () => {
      expect(resolveSidecarUser("kb", { readFileSync: passwd, getuid: () => 0 })).toEqual({
        ok: true,
        identity: { uid: 1000, gid: 1000, name: "kb", home: "/home/kb" },
      });
    });

    it("refuses another user when AlphaClaw is not root, and an unknown name", () => {
      expect(resolveSidecarUser("kb", { readFileSync: passwd, getuid: () => 1001 })).toEqual({
        ok: false,
        error: "running as kb needs AlphaClaw to run as root",
      });
      expect(resolveSidecarUser("nobody-here", { readFileSync: passwd, getuid: () => 0 }).ok).toBe(false);
    });

    it("runs as AlphaClaw's own identity when no user is set", () => {
      expect(resolveSidecarUser(null)).toEqual({ ok: true, identity: null });
    });
  });
});
