const { execFile, execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { runGitSyncCli, createCallerGitSync } = require("../../lib/server/git-sync-runner");
const { registerBrowseRoutes } = require("../../lib/server/routes/browse");
const { buildSystemCronFile } = require("../../lib/cli/system-cron");
const { resolveWriterLockPath } = require("../../lib/cli/git-writer-lock");
const { readGitSyncStatus, resolveGitSyncStatusPath } = require("../../lib/cli/git-sync-status");
const { buildManagedPaths } = require("../../lib/server/internal-files-migration");
const { warnStrayGitSyncStateDir, createGitSyncHealth } = require("../../lib/server/git-sync-health");

// A state dir that is a symlink into a subdirectory of a larger repository:
//   <base>/root/.openclaw -> <base>/outer/state   (state is its own repo)
// Every git-sync entry point must land on the configured lexical root, so the
// status file and the writer lock are the ones the server reads. Before the
// fix the Browse Sync button handed the CLI the realpath and the run used
// <base>/outer/.openclaw/.alphaclaw instead.
const kBin = path.resolve(__dirname, "../../bin/alphaclaw.js");
const kScriptTemplate = path.resolve(__dirname, "../../lib/setup/hourly-git-sync.sh");
const kGitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

describe("git sync with the state dir behind a symlink", () => {
  let base;
  let rootDir;
  let openclawDir;
  let outerDir;
  let stateDir;
  let childEnv;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-symlink-")));
    outerDir = path.join(base, "outer");
    stateDir = path.join(outerDir, "state");
    rootDir = path.join(base, "root");
    openclawDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(rootDir, { recursive: true });
    const gitEnv = { ...process.env, ...kGitEnv };
    execFileSync("git", ["init", "-q", "-b", "main", outerDir], { env: gitEnv });
    execFileSync("git", ["init", "-q", "-b", "main", stateDir], { env: gitEnv });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
    fs.symlinkSync(stateDir, openclawDir);
    fs.writeFileSync(path.join(rootDir, ".env"), "ALPHACLAW_GIT_SYNC=off\n");
    const shimDir = path.join(base, "shim");
    childEnv = {
      PATH: process.env.PATH,
      HOME: path.join(base, "home"),
      ALPHACLAW_GIT_SHIM_PATH: path.join(shimDir, "git"),
      ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(shimDir, "openclaw"),
      ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(shimDir, "profile.sh"),
      ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
      ...kGitEnv,
    };
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const statusPath = () => resolveGitSyncStatusPath(openclawDir);
  const lastTrigger = () => readGitSyncStatus({ statusPath: statusPath() })?.trigger || null;
  const strayAlphaclawDir = () => path.join(outerDir, ".openclaw", ".alphaclaw");
  // The server's own runner, pointed at this test's configured root. A caller
  // that overrides rootDir (or derives one) wins over the default and fails.
  const runner = (opts) =>
    runGitSyncCli({
      rootDir,
      env: childEnv,
      execFileImpl: (file, args, options, callback) => execFile(file, args, options, callback),
      ...opts,
    });

  it("gives every entry point the same status file and none a second one", async () => {
    const expectRun = (trigger) => {
      expect(lastTrigger()).toBe(trigger);
      expect(fs.existsSync(strayAlphaclawDir())).toBe(false);
      fs.rmSync(statusPath());
    };

    // 1. Browse sidebar Sync button.
    const app = express();
    app.use(express.json());
    registerBrowseRoutes({ app, fs, kRootDir: openclawDir, runGitSync: runner });
    const res = await request(app).post("/api/browse/git-sync").send({ message: "sync" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "disabled", code: "disabled" });
    expectRun("manual");

    // 2. Save-triggered caller sync (models, telegram, webhooks).
    await expect(createCallerGitSync({ runGitSync: runner })({ message: "models: update" })).resolves.toBeNull();
    expectRun("caller");

    // 3. Scheduled: the /etc/cron.d environment running the installed script.
    const { hourlyGitSyncPath } = buildManagedPaths({ openclawDir });
    fs.mkdirSync(path.dirname(hourlyGitSyncPath), { recursive: true });
    fs.copyFileSync(kScriptTemplate, hourlyGitSyncPath);
    const cronEnv = Object.fromEntries(
      buildSystemCronFile({ schedule: "7 * * * *", scriptPath: hourlyGitSyncPath, rootDir, openclawDir })
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(cronEnv.ALPHACLAW_ROOT_DIR).toBe(rootDir);
    const binDir = path.join(base, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "alphaclaw"), `#!/bin/sh\nexec "${process.execPath}" "${kBin}" "$@"\n`, { mode: 0o755 });
    const scheduled = spawnSync("bash", [hourlyGitSyncPath], {
      encoding: "utf8",
      env: { ...childEnv, ...cronEnv, PATH: `${binDir}:${process.env.PATH}` },
    });
    expect(scheduled.status).toBe(0);
    expectRun("scheduled");

    // 4. The CLI run by hand with the deployment's root.
    const cli = spawnSync(process.execPath, [kBin, "git-sync", "--trigger", "manual", "-m", "by hand"], {
      encoding: "utf8",
      env: { ...childEnv, ALPHACLAW_ROOT_DIR: rootDir },
    });
    expect(cli.status).toBe(0);
    expectRun("manual");
  });

  it("resolves one writer lock, in the state repository's own git dir", () => {
    const lockFor = (dir) =>
      resolveWriterLockPath({
        openclawDir: dir,
        git: (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...kGitEnv } }),
      });
    const lexical = lockFor(openclawDir);
    expect(fs.realpathSync(path.dirname(lexical))).toBe(path.join(stateDir, ".git"));
    expect(resolveGitSyncStatusPath(openclawDir)).toBe(path.join(rootDir, ".openclaw", ".alphaclaw", "git-sync-status.json"));
    // The root the old Browse path derived names a different status file.
    const realpathRoot = path.dirname(fs.realpathSync(openclawDir));
    expect(resolveGitSyncStatusPath(path.join(realpathRoot, ".openclaw"))).toBe(
      path.join(strayAlphaclawDir(), "git-sync-status.json"),
    );
  });

  it("warns once about a stray status dir from the old behavior and deletes nothing", () => {
    const logger = { warn: vi.fn() };
    expect(warnStrayGitSyncStateDir({ openclawDir, logger })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();

    fs.mkdirSync(strayAlphaclawDir(), { recursive: true });
    fs.writeFileSync(path.join(strayAlphaclawDir(), "git-sync-status.json"), "{}\n");
    const health = createGitSyncHealth({ openclawDir, logger, notify: vi.fn(), intervalMs: 60_000 });
    health.start();
    health.start();
    health.stop();
    const strayWarnings = logger.warn.mock.calls.filter(([line]) => line.includes(strayAlphaclawDir()));
    expect(strayWarnings).toHaveLength(1);
    expect(strayWarnings[0][0]).toContain("Nothing was deleted");
    expect(fs.existsSync(path.join(strayAlphaclawDir(), "git-sync-status.json"))).toBe(true);
  });

  it("stays quiet when the state dir is not a symlink", () => {
    const plainRoot = path.join(base, "plain");
    fs.mkdirSync(path.join(plainRoot, ".openclaw", ".alphaclaw"), { recursive: true });
    const logger = { warn: vi.fn() };
    expect(warnStrayGitSyncStateDir({ openclawDir: path.join(plainRoot, ".openclaw"), logger })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
