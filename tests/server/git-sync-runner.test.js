const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  runGitSyncCli,
  normalizeSyncMessage,
  parseGitSyncResult,
  describeCallerSyncWarning,
  createCallerGitSync,
} = require("../../lib/server/git-sync-runner");

// Issue #140: server callers (the dashboard Sync button) run the shared
// engine through `alphaclaw git-sync --json` and read its one result line.
describe("git-sync runner", () => {
  it("keeps the commit message on one line, bounded, and never flag-shaped", () => {
    expect(normalizeSyncMessage("fix\nthings\tnow")).toBe("fix things now");
    expect(normalizeSyncMessage("--help")).toBe("sync: --help");
    expect(normalizeSyncMessage("")).toBe("sync changes");
    expect(normalizeSyncMessage("x".repeat(500))).toHaveLength(200);
  });

  it("reads the last gitSync line and ignores anything else on stdout", () => {
    expect(parseGitSyncResult('noise\n{"gitSync":{"outcome":"ok","code":"ok"}}\n')).toEqual({ outcome: "ok", code: "ok" });
    expect(parseGitSyncResult("not json")).toBeNull();
  });

  it("passes argv (no shell), the manual trigger and the root derived from the managed dir", async () => {
    const execFileImpl = vi.fn((file, args, opts, callback) =>
      callback(null, '{"gitSync":{"outcome":"ok","code":"ok","message":"No changes to sync"}}\n', ""));
    const result = await runGitSyncCli({ message: "sync", openclawDir: "/data/.openclaw", execFileImpl });
    expect(result).toEqual({ outcome: "ok", code: "ok", message: "No changes to sync" });
    const [file, args, opts] = execFileImpl.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args.slice(1)).toEqual(["git-sync", "--json", "--trigger", "manual", "-m", "sync"]);
    expect(opts.env.ALPHACLAW_ROOT_DIR).toBe("/data");
  });

  it("lets a caller scope the commit to one file", async () => {
    const execFileImpl = vi.fn((file, args, opts, callback) => callback(null, '{"gitSync":{"outcome":"ok","code":"ok"}}', ""));
    await runGitSyncCli({ message: "models: update config", file: "openclaw.json", trigger: "caller", openclawDir: "/data/.openclaw", execFileImpl });
    expect(execFileImpl.mock.calls[0][1].slice(1)).toEqual([
      "git-sync", "--json", "--trigger", "caller", "-m", "models: update config", "-f", "openclaw.json",
    ]);
  });

  it("turns a caller's result into a syncWarning sentence, never raw stderr", async () => {
    expect(describeCallerSyncWarning({ outcome: "ok", code: "ok" })).toBeNull();
    expect(describeCallerSyncWarning({ outcome: "refused", code: "lock_timeout", message: "x" })).toMatch(/^Backup push deferred: another git writer was busy/);
    expect(describeCallerSyncWarning({ outcome: "failed", code: "deadline_exceeded" })).toMatch(/^Backup push deferred/);
    expect(describeCallerSyncWarning({ outcome: "refused", code: "conflict", message: "Git sync refused: conflict" })).toBe("Git sync refused: conflict");
    const runGitSync = vi.fn(async () => ({ outcome: "failed", code: "push_failed", message: "Git sync could not push to GitHub" }));
    const gitSync = createCallerGitSync({ openclawDir: "/data/.openclaw", runGitSync });
    await expect(gitSync({ message: "webhooks: create a" })).resolves.toBe("Git sync could not push to GitHub");
    expect(runGitSync).toHaveBeenCalledWith({ message: "webhooks: create a", file: "", trigger: "caller", openclawDir: "/data/.openclaw" });
  });

  it("turns a killed or unparseable run into a failure the route can show", async () => {
    const killed = await runGitSyncCli({
      message: "sync",
      openclawDir: "/data/.openclaw",
      execFileImpl: (file, args, opts, callback) => callback(Object.assign(new Error("killed"), { killed: true }), "", ""),
    });
    expect(killed).toMatchObject({ outcome: "failed", code: "deadline_exceeded", pushed: false });
    const crashed = await runGitSyncCli({
      message: "sync",
      openclawDir: "/data/.openclaw",
      execFileImpl: (file, args, opts, callback) => callback(new Error("exit 1"), "", "[alphaclaw] boom\n"),
    });
    expect(crashed).toMatchObject({ outcome: "failed", code: "failed", message: "Git sync failed: boom" });
  });

  it("gets a parseable result from the real CLI even when it refuses early", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-runner-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-runner-home-"));
    try {
      const openclawDir = path.join(rootDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", openclawDir]);
      const env = { ...process.env, HOME: homeDir };
      delete env.GITHUB_TOKEN;
      delete env.GITHUB_WORKSPACE_REPO;
      const result = await runGitSyncCli({ message: "sync", openclawDir, env });
      expect(result).toMatchObject({ outcome: "failed", code: "not_configured" });
      expect(result.message).toContain("Missing GITHUB_TOKEN");
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
