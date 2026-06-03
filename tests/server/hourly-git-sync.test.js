const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kScriptPath = path.resolve(__dirname, "../../lib/setup/hourly-git-sync.sh");

describe("hourly-git-sync managed script", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-hourly-sync-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const installScript = () => {
    const internalDir = path.join(tmpDir, ".alphaclaw");
    const target = path.join(internalDir, "hourly-git-sync.sh");
    fs.mkdirSync(internalDir, { recursive: true });
    fs.copyFileSync(kScriptPath, target);
    fs.chmodSync(target, 0o755);
    return target;
  };

  it("exits without git-sync when system sync is disabled", () => {
    const script = installScript();
    fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "cron", "system-sync.json"),
      JSON.stringify({ enabled: false, schedule: "0 * * * *" }),
    );

    const output = execFileSync("bash", [script], {
      cwd: tmpDir,
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    expect(output).toContain("hourly-git-sync: disabled by cron/system-sync.json");
  });

  it("runs alphaclaw git-sync when system sync is enabled", () => {
    const script = installScript();
    const binDir = path.join(tmpDir, "bin");
    const markerPath = path.join(tmpDir, "alphaclaw-called");
    fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "cron", "system-sync.json"),
      JSON.stringify({ enabled: true, schedule: "0 * * * *" }),
    );
    fs.writeFileSync(
      path.join(binDir, "alphaclaw"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" > "${markerPath}"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    execFileSync("bash", [script], {
      cwd: tmpDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });

    expect(fs.readFileSync(markerPath, "utf8")).toContain("git-sync -m Auto-commit hourly sync");
  });
});
