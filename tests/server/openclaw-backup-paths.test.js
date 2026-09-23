const os = require("os");
const path = require("path");
const { resolveBackupPath } = require("../../lib/server/openclaw-backup-paths");

describe("captured OpenClaw backup storage paths", () => {
  it.each([
    ["~", { OPENCLAW_HOME: "/effective", HOME: "/os-home" }, "/effective"],
    ["~/credentials", { OPENCLAW_HOME: "/effective", HOME: "/os-home" }, "/effective/credentials"],
    ["~\\credentials", { OPENCLAW_HOME: "/effective", HOME: "/os-home" }, "/effective\\credentials"],
    ["~/credentials", { OPENCLAW_HOME: "~/app", HOME: "/os-home" }, "/os-home/app/credentials"],
    ["~", { OPENCLAW_HOME: "~", HOME: "/os-home" }, "/os-home"],
    ["~/credentials", { OPENCLAW_HOME: "undefined", HOME: "null", USERPROFILE: "/profile" }, "/profile/credentials"],
    ["~", { PREFIX: "/data/com.termux/files/usr", ANDROID_DATA: "/data" }, "/data/com.termux/files/home"],
  ])("resolves %s using the pinned effective-home precedence", (value, spawnEnv, expected) => {
    expect(resolveBackupPath(value, { spawnEnv })).toBe(path.resolve(expected));
  });

  it("retains relative paths, explicit fallbacks, and the OS-home fallback", () => {
    expect(resolveBackupPath(" relative/path ", { spawnEnv: {} })).toBe(path.resolve("relative/path"));
    expect(resolveBackupPath(undefined, { spawnEnv: {}, fallback: "./default" })).toBe(path.resolve("./default"));
    expect(resolveBackupPath("~", { spawnEnv: {} })).toBe(path.resolve(os.homedir()));
  });

  it.each([null, 0, {}, []])("refuses configured non-string storage selector %s", (value) => {
    expect(() => resolveBackupPath(value, { fallback: "/default" })).toThrow(expect.objectContaining({ stage: "inventory" }));
  });

  it.each([
    ["~/credentials/${MISSING}", { OPENCLAW_HOME: "/effective" }],
    ["~", { OPENCLAW_HOME: "${MISSING}" }],
    ["~", { HOME: "/home/${MISSING}" }],
  ])("refuses unresolved interpolation in selected storage paths and home sources", (value, spawnEnv) => {
    expect(() => resolveBackupPath(value, { spawnEnv })).toThrow(expect.objectContaining({ stage: "inventory", message: expect.stringContaining("unresolved environment") }));
  });
});
