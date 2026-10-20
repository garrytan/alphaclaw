const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kScriptPath = path.resolve(__dirname, "../../lib/scripts/check-node-runtime.js");

const runScript = (preloadVersion) => {
  const args = [];
  let tempDir = "";
  if (preloadVersion) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-node-runtime-"));
    const preload = path.join(tempDir, "fake-version.cjs");
    fs.writeFileSync(
      preload,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(preloadVersion)} });\n`,
    );
    args.push("-r", preload);
  }
  try {
    return childProcess.spawnSync(process.execPath, [...args, kScriptPath], {
      encoding: "utf8",
    });
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

describe("lib/scripts/check-node-runtime (npm preinstall)", () => {
  it("is wired as the package preinstall script", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    );
    expect(pkg.scripts.preinstall).toBe("node lib/scripts/check-node-runtime.js");
  });

  it("passes on the Node running the suite", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it.each(["22.12.0", "25.2.0", "24.15.1"])("refuses Node %s with an upgrade hint", (version) => {
    const result = runScript(version);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[alphaclaw]");
    expect(result.stderr).toContain("Upgrade Node before installing this AlphaClaw release.");
  });
});
