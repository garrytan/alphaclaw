const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// The image's ENTRYPOINT (CSO ALPH-71 M-1): tini keeps its starting
// environment for the life of the container, so the launcher before it
// moves the deployment secrets into a handoff file that AlphaClaw consumes.
describe("bin/container-entrypoint.js", () => {
  const entrypoint = path.resolve(__dirname, "..", "..", "bin", "container-entrypoint.js");
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-entrypoint-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeProbe = (name) => {
    const probe = path.join(tmpDir, name);
    fs.writeFileSync(
      probe,
      "#!" + process.execPath + "\n" +
        "const fs = require('fs');\n" +
        "const handoff = process.env.ALPHACLAW_DEPLOYMENT_SECRETS_FILE || '';\n" +
        "console.log(JSON.stringify({ args: process.argv.slice(2), environ: fs.readFileSync('/proc/self/environ', 'utf8').split('\\0').filter(Boolean).map((line) => line.split('=')[0]).sort(), handoff: handoff ? JSON.parse(fs.readFileSync(handoff, 'utf8')) : null, mode: handoff ? (fs.statSync(handoff).mode & 0o777) : null }));\n",
      { mode: 0o755 },
    );
    return probe;
  };

  it("execs an AlphaClaw command with the deployment secrets only in a 0600 handoff file", () => {
    if (process.platform !== "linux") return;
    const probe = writeProbe("alphaclaw");
    const result = spawnSync(process.execPath, [entrypoint, probe, "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-7", RAILWAY_TOKEN: "fake-railway-7" },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.args).toEqual(["start"]);
    expect(report.environ).toEqual(["ALPHACLAW_DEPLOYMENT_SECRETS_FILE", "PATH"]);
    expect(report.handoff).toEqual({ SETUP_PASSWORD: "fake-setup-pass-7", RAILWAY_TOKEN: "fake-railway-7" });
    expect(report.mode).toBe(0o600);
  });

  it("recognizes AlphaClaw behind a shell-form start command or a node launch", () => {
    if (process.platform !== "linux") return;
    const shellProbe = writeProbe("alphaclaw");
    const nodeProbe = writeProbe("alphaclaw.js");
    for (const argv of [
      ["/bin/sh", "-c", shellProbe + " start --port 3000"],
      [process.execPath, nodeProbe, "start"],
    ]) {
      const result = spawnSync(process.execPath, [entrypoint, ...argv], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-9" },
      });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim());
      expect(report.environ).not.toContain("SETUP_PASSWORD");
      expect(report.handoff).toEqual({ SETUP_PASSWORD: "fake-setup-pass-9" });
      expect(report.mode).toBe(0o600);
    }
  });

  it("leaves any other command's environment unchanged, so no handoff is left behind", () => {
    if (process.platform !== "linux") return;
    const probe = writeProbe("diagnose-shell");
    const result = spawnSync(process.execPath, [entrypoint, probe], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-8" },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.environ).toEqual(["PATH", "SETUP_PASSWORD"]);
    expect(report.handoff).toBeNull();
  });
});
