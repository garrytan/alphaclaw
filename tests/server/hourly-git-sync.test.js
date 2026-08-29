const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kScriptPath = path.resolve(__dirname, "../../lib/setup/hourly-git-sync.sh");
const { buildHostileEnv } = require("./fixtures/hostile-env");

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

  // Issue #26: the script used to `source` .env under `set -euo pipefail` — a
  // value with spaces (NODE_OPTIONS=--max-old-space-size=8192 --heapsnapshot-…)
  // executed its trailing tokens (exit 127, whole sync dead, one unread log
  // line), and $(…) in any value was root code execution. The parser must
  // tolerate every legitimate .env shape, never execute anything, and export
  // only the allowlist.
  it("survives spaced, quoted, and command-substitution .env values without executing anything", () => {
    const script = installScript();
    const binDir = path.join(tmpDir, "bin");
    const markerPath = path.join(tmpDir, "alphaclaw-called");
    const envDumpPath = path.join(tmpDir, "env-dump");
    const pwnedPath = path.join(tmpDir, "pwned");
    fs.mkdirSync(path.join(tmpDir, "cron"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "cron", "system-sync.json"),
      JSON.stringify({ enabled: true, schedule: "0 * * * *" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      buildHostileEnv({ pwnedPath, githubToken: "ghp_quoted_token" }),
    );
    fs.writeFileSync(
      path.join(binDir, "alphaclaw"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" > "${markerPath}"`,
        // Dump what the parser exported so the allowlist is provable.
        `printf 'GITHUB_TOKEN=%s\\nGITHUB_WORKSPACE_REPO=%s\\nOPENCLAW_STATE_DIR=%s\\nNODE_OPTIONS=%s\\nLD_PRELOAD=%s\\n' "\${GITHUB_TOKEN:-}" "\${GITHUB_WORKSPACE_REPO:-}" "\${OPENCLAW_STATE_DIR:-}" "\${NODE_OPTIONS:-}" "\${LD_PRELOAD:-}" > "${envDumpPath}"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    execFileSync("bash", [script], {
      cwd: tmpDir,
      encoding: "utf8",
      env: {
        // No inherited NODE_OPTIONS/LD_PRELOAD/GITHUB_* — everything observed
        // below came from the parser.
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });

    // The sync ran to completion despite the hostile .env…
    expect(fs.readFileSync(markerPath, "utf8")).toContain("git-sync -m Auto-commit hourly sync");
    // …nothing was executed…
    expect(fs.existsSync(pwnedPath)).toBe(false);
    // …allowlisted vars arrived (dequoted once, spaces intact), and the
    // startup-sensitive vars did NOT.
    const dump = fs.readFileSync(envDumpPath, "utf8");
    expect(dump).toContain("GITHUB_TOKEN=ghp_quoted_token\n");
    expect(dump).toContain("GITHUB_WORKSPACE_REPO=owner/repo with spaces\n");
    expect(dump).toContain("OPENCLAW_STATE_DIR=/data/.openclaw\n");
    expect(dump).toContain("NODE_OPTIONS=\n");
    expect(dump).toContain("LD_PRELOAD=\n");
  });
});
