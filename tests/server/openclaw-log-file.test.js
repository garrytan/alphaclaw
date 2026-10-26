const path = require("node:path");
const { kOpenclawLogDir, kRootDir } = require("../../lib/server/constants");
const {
  applyManagedOpenclawLogFile,
  kManagedOpenclawLogFile,
} = require("../../lib/server/openclaw-log-file");

describe("managed OpenClaw file log", () => {
  it("lives in its own directory under AlphaClaw's log dir with OpenClaw's rolling basename", () => {
    expect(kOpenclawLogDir).toBe(path.join(kRootDir, "logs", "openclaw"));
    expect(kManagedOpenclawLogFile).toBe(path.join(kOpenclawLogDir, "openclaw-YYYY-MM-DD.log"));
  });

  it("sets the default path when logging.file is unset", () => {
    const cfg = {};
    expect(applyManagedOpenclawLogFile(cfg)).toBe(true);
    expect(cfg).toEqual({ logging: { file: kManagedOpenclawLogFile } });
  });

  it.each([undefined, null, "", "  \t"])("treats %j as unset and keeps the other logging keys", (file) => {
    const cfg = { logging: { file, level: "debug", maxFileBytes: 5, redactSensitive: "off" } };
    expect(applyManagedOpenclawLogFile(cfg, { logFile: "/x/openclaw-YYYY-MM-DD.log" })).toBe(true);
    expect(cfg.logging).toEqual({ file: "/x/openclaw-YYYY-MM-DD.log", level: "debug", maxFileBytes: 5, redactSensitive: "off" });
  });

  it.each(["/tmp/openclaw/openclaw-YYYY-MM-DD.log", "/data/gateway.log", 42, { path: "/x" }])(
    "never replaces an operator value (%j)",
    (file) => {
      const cfg = { logging: { file } };
      expect(applyManagedOpenclawLogFile(cfg)).toBe(false);
      expect(cfg.logging.file).toEqual(file);
    },
  );

  it.each([null, "verbose", 3, ["file"]])("leaves a non-object logging value (%j) untouched", (logging) => {
    const cfg = { logging };
    expect(applyManagedOpenclawLogFile(cfg)).toBe(false);
    expect(cfg.logging).toEqual(logging);
  });
});
