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
});
