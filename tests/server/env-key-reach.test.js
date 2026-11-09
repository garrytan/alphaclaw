const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifyEnvKeyReach, stateDirEnvIsEnvFile } = require("../../lib/server/env-key-reach");
const { describeEnvSavedWithoutRestart } = require("../../lib/server/routes/env");

describe("where a saved .env key is usable", () => {
  it("an admitted key reaches the gateway environment", () => {
    expect(classifyEnvKeyReach("OPENAI_API_KEY", { stateDirEnvLinked: false })).toBe("gateway_env");
    expect(classifyEnvKeyReach("GITHUB_TOKEN", { stateDirEnvLinked: true })).toBe("gateway_env");
  });

  it("a withheld key reaches the gateway only through a linked state-dir .env", () => {
    expect(classifyEnvKeyReach("MYSVC_SECRET", { stateDirEnvLinked: true })).toBe("next_gateway_start");
    expect(classifyEnvKeyReach("MYSVC_SECRET", { stateDirEnvLinked: false })).toBe("never");
    expect(classifyEnvKeyReach("SETUP_PASSWORD", { stateDirEnvLinked: true })).toBe("never");
  });

  it("detects the managed state-dir .env link", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-reach-"));
    const envFilePath = path.join(dir, ".env");
    const openclawDir = path.join(dir, ".openclaw");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(envFilePath, "A=1\n");
    expect(stateDirEnvIsEnvFile({ openclawDir, envFilePath })).toBe(false);
    fs.symlinkSync(envFilePath, path.join(openclawDir, ".env"));
    expect(stateDirEnvIsEnvFile({ openclawDir, envFilePath })).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the save note names each key by where it is usable", () => {
    const reach = { A_KEY: "next_gateway_start", B_KEY: "never", C_KEY: "never" };
    expect(describeEnvSavedWithoutRestart(["A_KEY", "B_KEY", "C_KEY"], (key) => reach[key])).toBe(
      "Saved. AlphaClaw and scripts that read .env see the change now. The gateway sees A_KEY only after its next start, when OpenClaw loads its .env. The gateway's environment never gets B_KEY, C_KEY.",
    );
  });
});
