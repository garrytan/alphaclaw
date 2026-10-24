const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { acquireWriterLock } = require("../../lib/cli/git-writer-lock");

// `alphaclaw git-sync` CLI wiring for issue #140: the writer lock, trigger
// budgets and the status file the server turns into notifications.
describe("bin/alphaclaw git-sync (issue #140)", () => {
  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
  let rootDir;
  let homeDir;
  let openclawDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-cli-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-home-"));
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", openclawDir]);
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const runCli = (args, env = {}) => {
    const baseEnv = { ...process.env };
    delete baseEnv.GITHUB_TOKEN;
    delete baseEnv.GITHUB_WORKSPACE_REPO;
    delete baseEnv.ALPHACLAW_GIT_SYNC_PATHS;
    delete baseEnv.ALPHACLAW_GIT_LOCK_TIMEOUT_SECONDS;
    return spawnSync(process.execPath, [binPath, "git-sync", ...args], {
      encoding: "utf8",
      env: { ...baseEnv, ALPHACLAW_ROOT_DIR: rootDir, HOME: homeDir, ...env },
    });
  };
  const statusPath = () => path.join(openclawDir, ".alphaclaw", "git-sync-status.json");
  const hasFlock = spawnSync("flock", ["--version"]).status === 0;

  it.runIf(hasFlock)("waits for alphaclaw-writer.lock, then exits 75 with lock_timeout naming the holder and touches nothing", () => {
    const lockPath = path.join(openclawDir, ".git", "alphaclaw-writer.lock");
    const lock = acquireWriterLock({ lockPath, waitSeconds: 1, trigger: "scheduled" });
    expect(lock.status).toBe("acquired");
    try {
      const result = runCli(["-m", "sync", "--lock-wait", "1"], {
        GITHUB_TOKEN: "ghp_test",
        GITHUB_WORKSPACE_REPO: "owner/repo",
      });
      expect(result.status).toBe(75);
      expect(result.stderr).toContain("(lock_timeout)");
      expect(result.stderr).toContain(`pid ${process.pid} (scheduled sync)`);
      const status = JSON.parse(fs.readFileSync(statusPath(), "utf8"));
      expect(status).toMatchObject({
        code: "lock_timeout",
        outcome: "refused",
        lock: "timeout",
        trigger: "caller",
        consecutiveFailures: 1,
      });
      expect(fs.statSync(statusPath()).mode & 0o777).toBe(0o600);
      expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: openclawDir }).status).not.toBe(0);
    } finally {
      lock.release();
    }
  });

  it("records not_configured for the scheduled run only", () => {
    const caller = runCli(["-m", "sync"]);
    expect(caller.status).toBe(1);
    expect(caller.stderr).toContain("Missing GITHUB_TOKEN");
    expect(fs.existsSync(statusPath())).toBe(false);

    const scheduled = runCli(["-m", "sync", "--trigger", "scheduled"]);
    expect(scheduled.status).toBe(1);
    expect(JSON.parse(fs.readFileSync(statusPath(), "utf8"))).toMatchObject({
      code: "not_configured",
      outcome: "failed",
      trigger: "scheduled",
    });
  });

  it("syncs 15,000 new files through the CLI's own git runner, whose status listing is over 1 MiB", () => {
    const remote = path.join(rootDir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["-C", openclawDir, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    const dir = path.join(openclawDir, "workspace", "imported-notes-from-a-long-running-agent-session");
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 15_000; index += 1) {
      fs.writeFileSync(path.join(dir, `note-${String(index).padStart(5, "0")}-captured-by-the-agent.md`), `${index}\n`);
    }

    const result = runCli(["-m", "bulk import", "--json"], {
      GITHUB_TOKEN: "ghp_test",
      GITHUB_WORKSPACE_REPO: "owner/repo",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/owner/repo.git",
    });

    expect(JSON.parse(result.stdout.trim())).toEqual({
      gitSync: expect.objectContaining({ outcome: "ok", code: "ok", committed: true, pushed: true }),
    });
    const pushed = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "main"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(pushed.trim().split("\n")).toHaveLength(15_001);
  }, 120_000);

  it("rejects an unknown trigger and non-numeric budgets as usage errors (exit 2)", () => {
    expect(runCli(["-m", "sync", "--trigger", "cron"]).status).toBe(2);
    expect(runCli(["-m", "sync", "--lock-wait", "soon"]).status).toBe(2);
  });

  it("refuses an ALPHACLAW_GIT_SYNC_PATHS entry outside the managed directory", () => {
    const result = runCli(["-m", "sync", "--trigger", "scheduled"], {
      GITHUB_TOKEN: "ghp_test",
      GITHUB_WORKSPACE_REPO: "owner/repo",
      ALPHACLAW_GIT_SYNC_PATHS: "openclaw.json,../outside",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ALPHACLAW_GIT_SYNC_PATHS entry");
  });

  it("--json prints exactly one JSON document on stdout, and a message spelled --json stays a message", () => {
    const result = runCli(["-m", "--json", "--trigger", "scheduled"]);
    expect(result.stdout).not.toContain("{\"gitSync\"");
    const json = runCli(["--json", "-m", "--json"]);
    expect(json.status).toBe(1);
    const lines = json.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      gitSync: expect.objectContaining({ outcome: "failed", code: "not_configured", committed: false, pushed: false }),
    });
    expect(json.stderr).toContain("Missing GITHUB_TOKEN");
  });
});
