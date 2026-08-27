const path = require("path");
const { kRootDir } = require("../../lib/server/constants");
const {
  ensureOpenclawStartupEnv,
  withOpenclawStartupEnv,
} = require("../../lib/server/openclaw-runtime-env");

describe("server/openclaw-runtime-env", () => {
  it("defaults OpenClaw CLI startup settings to the stable AlphaClaw root", () => {
    const env = withOpenclawStartupEnv({ FOO: "bar" });

    expect(env).toEqual(
      expect.objectContaining({
        FOO: "bar",
        NODE_COMPILE_CACHE: path.join(
          kRootDir,
          "cache",
          "openclaw-compile-cache",
        ),
        OPENCLAW_NO_RESPAWN: "1",
      }),
    );
  });

  it("preserves explicit OpenClaw startup settings", () => {
    const env = withOpenclawStartupEnv({
      NODE_COMPILE_CACHE: "/custom/cache",
      OPENCLAW_NO_RESPAWN: "0",
    });

    expect(env.NODE_COMPILE_CACHE).toBe("/custom/cache");
    expect(env.OPENCLAW_NO_RESPAWN).toBe("0");
  });

  it("declares the external supervisor contract by default", () => {
    const env = withOpenclawStartupEnv({ FOO: "bar" });

    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
  });

  it("neutralizes both supervisor variables when the escape hatch is set", () => {
    for (const sentinel of ["off", "none", "OFF", "None"]) {
      const env = withOpenclawStartupEnv({
        OPENCLAW_SUPERVISOR_MODE: sentinel,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      });

      // The sentinel itself must never reach the child — OpenClaw does not
      // accept a literal "off" as a supervisor mode.
      expect("OPENCLAW_SUPERVISOR_MODE" in env).toBe(false);
      expect("OPENCLAW_SERVICE_REPAIR_POLICY" in env).toBe(false);
    }
  });

  it("respects an explicit service repair policy while defaulting supervisor mode", () => {
    const env = withOpenclawStartupEnv({
      OPENCLAW_SERVICE_REPAIR_POLICY: "internal",
    });

    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("internal");
  });

  it("mirrors the supervisor contract onto process env and clears the escape-hatch sentinel", () => {
    const fsModule = { mkdirSync: vi.fn() };
    const armed = { OPENCLAW_SUPERVISOR_MODE: "" };
    ensureOpenclawStartupEnv({ fsModule, env: armed, logger: { warn: vi.fn() } });
    expect(armed.OPENCLAW_SUPERVISOR_MODE).toBe("external");
    expect(armed.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");

    const hatched = { OPENCLAW_SUPERVISOR_MODE: "off" };
    ensureOpenclawStartupEnv({ fsModule, env: hatched, logger: { warn: vi.fn() } });
    expect("OPENCLAW_SUPERVISOR_MODE" in hatched).toBe(false);
    expect("OPENCLAW_SERVICE_REPAIR_POLICY" in hatched).toBe(false);
  });

  it("creates the compile cache directory and backfills missing process env values", () => {
    const fsModule = { mkdirSync: vi.fn() };
    const logger = { warn: vi.fn() };
    const env = {};

    const result = ensureOpenclawStartupEnv({ fsModule, env, logger });

    expect(fsModule.mkdirSync).toHaveBeenCalledWith(result.NODE_COMPILE_CACHE, {
      recursive: true,
    });
    expect(env.NODE_COMPILE_CACHE).toBe(result.NODE_COMPILE_CACHE);
    expect(env.OPENCLAW_NO_RESPAWN).toBe("1");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
