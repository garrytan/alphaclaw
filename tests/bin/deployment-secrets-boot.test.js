const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// CSO ALPH-71 M-1: an agent shell runs as AlphaClaw's uid, and
// /proc/<pid>/environ needs only same-uid read access. A start boot must
// leave SETUP_PASSWORD in no environ block it owns: its own (after the
// re-exec), the boot placeholder's, or any child's, while the server still
// gets the value from the deployment-secrets module.
describe("bin/alphaclaw.js start keeps deployment secrets out of every environ", () => {
  const binPath = path.resolve(__dirname, "..", "..", "bin", "alphaclaw.js");
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-secrets-boot-")));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("no /proc/*/environ holds SETUP_PASSWORD when the server loads, and the server still reads it", () => {
    if (process.platform !== "linux") return;
    const marker = "fake-setup-pass-" + Math.random().toString(36).slice(2, 10);
    const capturePath = path.join(tmpDir, "capture.json");
    fs.writeFileSync(capturePath + ".marker", marker);
    const preloadPath = path.join(tmpDir, "capture-at-server-load.js");
    fs.writeFileSync(
      preloadPath,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const Module = require('module');",
        "const realLoad = Module._load;",
        "Module._load = function (request, parent) {",
        "  if (typeof request === 'string' && /lib[\\\\/]server(\\.js)?$/.test(request) && String(parent?.filename || '').endsWith(path.join('bin', 'alphaclaw.js'))) {",
        "    const capturePath = process.env.ALPHACLAW_CAPTURE_ENV_PATH;",
        "    const marker = fs.readFileSync(capturePath + '.marker', 'utf8');",
        "    const holders = [];",
        "    for (const pid of fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name))) {",
        "      try { if (fs.readFileSync('/proc/' + pid + '/environ', 'utf8').includes(marker)) holders.push(pid); } catch {}",
        "    }",
        "    const secrets = realLoad.call(this, path.join(path.dirname(parent.filename), '..', 'lib', 'server', 'deployment-secrets.js'), parent, false);",
        "    fs.writeFileSync(capturePath, JSON.stringify({ pid: process.pid, holders, inProcessEnv: Object.values(process.env).some((v) => String(v).includes(marker)), served: secrets.getDeploymentSecret('SETUP_PASSWORD') === marker }));",
        "    process.exit(0);",
        "  }",
        "  return realLoad.apply(this, arguments);",
        "};",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["--require=" + preloadPath, binPath, "start"], {
      encoding: "utf8",
      timeout: 120000,
      env: {
        PATH: process.env.PATH,
        SETUP_PASSWORD: marker,
        ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
        ALPHACLAW_ROOT_DIR: tmpDir,
        ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(tmpDir, "wrapper-openclaw.sh"),
        ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(tmpDir, "profile-openclaw.sh"),
        ALPHACLAW_GIT_SHIM_PATH: path.join(tmpDir, "git-shim"),
        ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
        HOME: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, ".config"),
        PORT: String(39000 + Math.floor(Math.random() * 900)),
      },
    });
    expect(fs.existsSync(capturePath), result.stderr + result.stdout).toBe(true);
    const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    expect(capture.pid).toBe(result.pid);
    expect(capture.holders).toEqual([]);
    expect(capture.inProcessEnv).toBe(false);
    expect(capture.served).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(marker);
  });
});
