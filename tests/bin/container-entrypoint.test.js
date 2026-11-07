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

  // #342 round 4: a failed handoff write used to put the values back into the
  // init's environment silently. The box must still boot, so the fallback
  // stays, but it says where the values are now and why (never the values).
  it("when the handoff cannot be written, keeps the secrets in the env and warns that PID 1 holds them", () => {
    if (process.platform !== "linux") return;
    const probe = writeProbe("alphaclaw");
    const result = spawnSync(process.execPath, [entrypoint, probe, "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, TMPDIR: path.join(tmpDir, "missing"), SETUP_PASSWORD: "fake-setup-pass-10" },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.environ).toEqual(["PATH", "SETUP_PASSWORD", "TMPDIR"]);
    expect(report.handoff).toBeNull();
    const warnings = result.stderr.split("\n").filter(Boolean);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("handoff could not be written (ENOENT)");
    expect(warnings[0]).toContain("PID 1's environment");
    expect(result.stderr).not.toContain("fake-setup-pass-10");
  });

  it("hands off only when the program the init runs is alphaclaw, as the image's CMD does", () => {
    if (process.platform !== "linux") return;
    const init = writeProbe("init");
    const result = spawnSync(process.execPath, [entrypoint, init, "--", "alphaclaw", "start"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-9" },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.args).toEqual(["--", "alphaclaw", "start"]);
    expect(report.environ).toEqual(["ALPHACLAW_DEPLOYMENT_SECRETS_FILE", "PATH"]);
    expect(report.handoff).toEqual({ SETUP_PASSWORD: "fake-setup-pass-9" });
    expect(result.stderr).toBe("");
  });

  // /ship round 2 on #342: matching any word named alphaclaw handed off for
  // `grep alphaclaw` (secrets stripped, a handoff nobody consumes) and spent
  // the one-shot handoff on `alphaclaw --version && alphaclaw start`.
  it("keeps a shell-form or unrelated start command's environment, with one warning and no handoff", () => {
    if (process.platform !== "linux") return;
    const init = writeProbe("init");
    for (const argv of [
      [init, "--", "/bin/sh", "-c", "alphaclaw start --port 3000"],
      [init, "--", "grep", "alphaclaw", "notes.txt"],
      [init, "--", "/bin/sh", "-c", "alphaclaw --version && alphaclaw start"],
      [init, "alphaclaw"],
    ]) {
      const result = spawnSync(process.execPath, [entrypoint, ...argv], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SETUP_PASSWORD: "fake-setup-pass-9" },
      });
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim());
      expect(report.environ, argv.join(" ")).toEqual(["PATH", "SETUP_PASSWORD"]);
      expect(report.handoff).toBeNull();
      expect(result.stderr).toContain("the deployment secrets stay in this container's environment");
      expect(result.stderr).not.toContain("fake-setup-pass-9");
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
