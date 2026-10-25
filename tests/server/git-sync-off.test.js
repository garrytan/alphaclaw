const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isGitSyncOff } = require("../../lib/cli/git-sync");
const { recordGitSyncRun, readGitSyncStatus, resolveGitSyncStatusPath } = require("../../lib/cli/git-sync-status");
const { describeCallerSyncWarning } = require("../../lib/server/git-sync-runner");

// ALPHACLAW_GIT_SYNC=off (ALPH-36): the CLI every caller runs returns before
// touching git, exits 0 and records a `disabled` run.
const kBin = path.resolve(__dirname, "../../bin/alphaclaw.js");
const kGitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

describe("ALPHACLAW_GIT_SYNC=off", () => {
  it("reads off, false, 0, no and disabled as off, anything else as on", () => {
    for (const value of ["off", "OFF", " false ", "0", "no", "disabled"]) {
      expect(isGitSyncOff({ ALPHACLAW_GIT_SYNC: value })).toBe(true);
    }
    for (const value of [undefined, "", "on", "true", "1", "paths"]) {
      expect(isGitSyncOff({ ALPHACLAW_GIT_SYNC: value })).toBe(false);
    }
  });

  it("gives a save no sync warning", () => {
    expect(describeCallerSyncWarning({ outcome: "disabled", code: "disabled", message: "Git sync is off (ALPHACLAW_GIT_SYNC=off)" })).toBeNull();
  });

  describe("the git-sync CLI", () => {
    let root;
    let openclawDir;
    const runCli = (trigger) =>
      spawnSync(process.execPath, [kBin, "git-sync", "--json", "--trigger", trigger, "-m", "hourly sync"], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: root,
          ALPHACLAW_ROOT_DIR: root,
          ALPHACLAW_GIT_SHIM_PATH: path.join(root, "shim", "git"),
          ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(root, "shim", "openclaw"),
          ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(root, "shim", "profile.sh"),
          ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
          ...kGitEnv,
        },
      });

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-off-")));
      openclawDir = path.join(root, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", openclawDir], { env: { ...process.env, ...kGitEnv } });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
      fs.writeFileSync(path.join(root, ".env"), "ALPHACLAW_GIT_SYNC=off\n");
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.each(["scheduled", "manual", "caller"])("%s: exits 0 from .env alone, touches no git, records a disabled run", (trigger) => {
      recordGitSyncRun({ openclawDir, trigger: "scheduled", result: { code: "merge_conflict", detail: "conflict in a.md" } });
      const before = readGitSyncStatus({ statusPath: resolveGitSyncStatusPath(openclawDir) });
      expect(before).toMatchObject({ outcome: "refused", consecutiveFailures: 1 });

      const result = runCli(trigger);

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout.trim().split("\n").pop()).gitSync;
      expect(json).toMatchObject({ outcome: "disabled", code: "disabled", committed: false, pushed: false, message: "Git sync is off (ALPHACLAW_GIT_SYNC=off)" });
      expect(result.stderr).toContain("[alphaclaw] Git sync is off (ALPHACLAW_GIT_SYNC=off); nothing was committed or pushed");
      expect(execFileSync("git", ["-C", openclawDir, "status", "--porcelain"], { encoding: "utf8" })).toContain("?? openclaw.json");
      expect(() => execFileSync("git", ["-C", openclawDir, "rev-parse", "HEAD"], { stdio: "pipe" })).toThrow();
      expect(readGitSyncStatus({ statusPath: resolveGitSyncStatusPath(openclawDir) })).toMatchObject({
        outcome: "disabled",
        code: "disabled",
        trigger,
        lock: "none",
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastSuccessAt: null,
      });
    });

    it("runs again once the key is removed", () => {
      fs.writeFileSync(path.join(root, ".env"), "\n");
      const result = runCli("manual");
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout.trim().split("\n").pop()).gitSync).toMatchObject({ code: "not_configured" });
    });
  });
});
