const { execFileSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { performGitSync } = require("../../lib/cli/git-sync");
const {
  acquireWriterLock,
  resolveWriterLockPath,
} = require("../../lib/cli/git-writer-lock");

// Issue #140, against real git: the sync shares the checkout with other
// writers, so it must commit only its own candidates, integrate a moved
// remote without touching the working tree, and leave no in-tree state on a
// conflict.
const kGitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const sh = (cwd, args, opts = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...kGitEnv },
    ...opts,
  });

const createRunner = (cwd) => (args, { input, literalPathspecs = false, timeoutMs } = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...(input !== undefined ? { input } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeout: Math.floor(timeoutMs) } : {}),
    env: {
      ...process.env,
      ...kGitEnv,
      ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
    },
  });

const write = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

describe("git-sync against real git (issue #140)", () => {
  let root;
  let remote;
  let live;
  let other;

  const sync = (overrides = {}) =>
    performGitSync({
      git: createRunner(live),
      openclawDir: live,
      githubRepo: "owner/repo",
      originUrl: remote,
      commitMessage: "hourly sync",
      log: () => {},
      error: () => {},
      ...overrides,
    });

  const pushFromOther = (rel, content, message = "upstream") => {
    sh(other, ["pull", "-q", "--ff-only", "origin", "main"]);
    write(other, rel, content);
    sh(other, ["add", "-A"]);
    sh(other, ["commit", "-qm", message]);
    sh(other, ["push", "-q", "origin", "main"]);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-real-"));
    remote = path.join(root, "remote.git");
    live = path.join(root, "live");
    other = path.join(root, "other");
    sh(root, ["init", "-q", "-b", "main", "--bare", remote]);
    sh(root, ["init", "-q", "-b", "main", live]);
    sh(live, ["remote", "add", "origin", remote]);
    write(live, "openclaw.json", "{}\n");
    write(live, "workspace/notes.md", "a\n");
    sh(live, ["add", "-A"]);
    sh(live, ["commit", "-qm", "init"]);
    sh(live, ["push", "-q", "origin", "main"]);
    sh(root, ["clone", "-q", remote, other]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("commits only working-tree changes and leaves another writer's staged-only file staged", () => {
    write(live, "workspace/notes.md", "b\n");
    write(live, "workspace/new.md", "new\n");
    write(live, "staged-by-other.txt", "theirs\n");
    sh(live, ["add", "staged-by-other.txt"]);

    const result = sync();

    expect(result.exitCode).toBe(0);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.skippedStaged).toBe(1);
    const committed = sh(live, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").sort();
    expect(committed).toEqual(["workspace/new.md", "workspace/notes.md"]);
    expect(sh(live, ["status", "--porcelain"])).toBe("A  staged-by-other.txt\n");
    expect(sh(remote, ["rev-parse", "main"])).toBe(sh(live, ["rev-parse", "HEAD"]));
  });

  it("integrates a moved remote with a merge commit, keeps other writers' dirty files, never rebases", () => {
    pushFromOther("workspace/up.md", "upstream\n");
    write(live, "openclaw.json", '{"x":1}\n');
    write(live, "workspace/half-written.md", "HALF");
    sh(live, ["add", "-N", "workspace/half-written.md"]);
    write(live, "workspace/half-written.md", "HALF, still writing");

    const result = sync({ syncPaths: ["openclaw.json"] });

    expect(result.exitCode).toBe(0);
    expect(result.integration).toBe("merge");
    expect(result.pushed).toBe(true);
    const head = sh(live, ["rev-parse", "HEAD"]).trim();
    expect(sh(remote, ["rev-parse", "main"]).trim()).toBe(head);
    expect(sh(live, ["log", "-1", "--format=%s"]).trim()).toBe("sync: merge origin/main (AlphaClaw)");
    expect(sh(live, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ")).toHaveLength(3);
    expect(fs.readFileSync(path.join(live, "workspace/up.md"), "utf8")).toBe("upstream\n");
    expect(fs.readFileSync(path.join(live, "workspace/half-written.md"), "utf8")).toBe("HALF, still writing");
    expect(sh(live, ["status", "--porcelain"])).toBe(" A workspace/half-written.md\n");
    expect(fs.existsSync(path.join(live, ".git", "rebase-merge"))).toBe(false);
  });

  it("refuses a real conflict without pushing and without leaving in-tree state", () => {
    pushFromOther("openclaw.json", '{"theirs":true}\n');
    write(live, "openclaw.json", '{"mine":true}\n');
    const remoteBefore = sh(remote, ["rev-parse", "main"]);

    const result = sync();

    expect(result.exitCode).toBe(1);
    expect(result.code).toBe("merge_conflict");
    expect(result.paths).toEqual(["openclaw.json"]);
    expect(sh(remote, ["rev-parse", "main"])).toBe(remoteBefore);
    expect(fs.readFileSync(path.join(live, "openclaw.json"), "utf8")).toBe('{"mine":true}\n');
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
      expect(fs.existsSync(path.join(live, ".git", marker))).toBe(false);
    }
    expect(sh(live, ["diff", "--name-only", "--diff-filter=U"])).toBe("");
  });

  it("pushes but warns when a dirty file blocks the fast-forward, then converges", () => {
    pushFromOther("workspace/notes.md", "upstream notes\n");
    write(live, "openclaw.json", '{"x":2}\n');
    write(live, "workspace/notes.md", "dirty local notes\n");

    const result = sync({ syncPaths: ["openclaw.json"] });

    expect(result.exitCode).toBe(0);
    expect(result.code).toBe("live_tree_behind");
    expect(result.outcome).toBe("warning");
    expect(result.liveTreeBehind.paths).toEqual(["workspace/notes.md"]);
    expect(fs.readFileSync(path.join(live, "workspace/notes.md"), "utf8")).toBe("dirty local notes\n");
    expect(sh(remote, ["show", "main:openclaw.json"])).toBe('{"x":2}\n');

    sh(live, ["checkout", "--", "workspace/notes.md"]);
    const next = sync();
    expect(next.code).toBe("ok");
    expect(sh(live, ["rev-parse", "HEAD"])).toBe(sh(remote, ["rev-parse", "main"]));
    expect(fs.readFileSync(path.join(live, "workspace/notes.md"), "utf8")).toBe("upstream notes\n");
  });

  it("never reverts a commit that lands between merge-tree and commit-tree (pinned SHAs)", () => {
    pushFromOther("workspace/up.md", "upstream\n");
    write(live, "openclaw.json", '{"y":1}\n');
    const runner = createRunner(live);
    let injected = false;
    const racingRunner = (args, opts) => {
      const out = runner(args, opts);
      if (args[0] === "merge-tree" && !injected) {
        injected = true;
        write(live, "workspace/agent.md", "agent work\n");
        sh(live, ["add", "workspace/agent.md"]);
        sh(live, ["commit", "-qm", "agent commit"]);
      }
      return out;
    };

    const result = sync({ git: racingRunner });

    expect(injected).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.code).toBe("live_tree_behind");
    expect(fs.readFileSync(path.join(live, "workspace/agent.md"), "utf8")).toBe("agent work\n");
    expect(sh(live, ["log", "-1", "--format=%s"]).trim()).toBe("agent commit");

    const next = sync();
    expect(next.exitCode).toBe(0);
    expect(sh(remote, ["show", "main:workspace/agent.md"])).toBe("agent work\n");
  });

  it("adopts a remote with history before the first commit on a fresh `git init -b main` repo", () => {
    const remoteBefore = sh(remote, ["rev-parse", "main"]).trim();
    const fresh = path.join(root, "fresh");
    sh(root, ["init", "-q", "-b", "main", fresh]);
    sh(fresh, ["remote", "add", "origin", remote]);
    write(fresh, "workspace/first.md", "first\n");

    const result = performGitSync({
      git: createRunner(fresh),
      openclawDir: fresh,
      githubRepo: "owner/repo",
      originUrl: remote,
      commitMessage: "first sync",
      log: () => {},
      error: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.integration).toBe("push");
    expect(() => sh(remote, ["merge-base", "--is-ancestor", remoteBefore, "main"])).not.toThrow();
    expect(sh(remote, ["show", "main:workspace/first.md"])).toBe("first\n");
  });

  it("refuses while another writer's rebase is in progress and names the marker", () => {
    pushFromOther("openclaw.json", '{"theirs":1}\n');
    write(live, "openclaw.json", '{"mine":1}\n');
    sh(live, ["commit", "-qam", "mine"]);
    expect(() => sh(live, ["pull", "-q", "--rebase", "origin", "main"])).toThrow();
    expect(fs.existsSync(path.join(live, ".git", "rebase-merge"))).toBe(true);

    const result = sync({ listOwners: () => [] });

    expect(result.code).toBe("in_progress_operation");
    expect(result.staleState.marker).toBe("rebase-merge");
    expect(result.detail).toContain("no git process is running");
    expect(fs.existsSync(path.join(live, ".git", "rebase-merge"))).toBe(true);
  });

  it("refuses a detached HEAD instead of guessing main", () => {
    sh(live, ["checkout", "-q", "--detach"]);
    const result = sync();
    expect(result.code).toBe("detached_head");
    expect(result.exitCode).toBe(1);
  });

  it("keeps file names with glob characters literal", () => {
    write(live, "workspace/w1.md", "w1\n");
    sh(live, ["add", "workspace/w1.md"]);
    sh(live, ["commit", "-qm", "w1"]);
    write(live, "workspace/w1.md", "w1 dirty, not ours\n");
    write(live, "workspace/w[1].md", "glob name\n");

    const result = sync({ syncPaths: ["workspace/w[1].md"] });

    expect(result.committed).toBe(true);
    expect(sh(live, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("workspace/w[1].md");
    expect(sh(live, ["status", "--porcelain"])).toBe(" M workspace/w1.md\n");
  });

  it("retries index.lock contention and succeeds once it clears", () => {
    write(live, "openclaw.json", '{"z":1}\n');
    const lockFile = path.join(live, ".git", "index.lock");
    fs.writeFileSync(lockFile, "");
    const sleeps = [];
    const result = sync({
      sleepFn: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) fs.rmSync(lockFile, { force: true });
      },
    });
    expect(sleeps).toEqual([250, 500]);
    expect(result.code).toBe("ok");
    expect(result.committed).toBe(true);
  });

  it("reports index_locked when a lock file never clears", () => {
    write(live, "openclaw.json", '{"z":2}\n');
    fs.writeFileSync(path.join(live, ".git", "index.lock"), "");
    let fakeNow = 1_000_000;
    const result = sync({
      nowFn: () => fakeNow,
      sleepFn: (ms) => {
        fakeNow += ms;
      },
    });
    expect(result.code).toBe("index_locked");
    expect(result.paths[0]).toMatch(/index\.lock$/);
  });
});

describe("git writer lock (issue #140)", () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-writer-lock-"));
    sh(root, ["init", "-q", "-b", "main"]);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const hasFlock = spawnSync("flock", ["--version"]).status === 0;

  it("resolves a fixed path in the git common dir", () => {
    expect(resolveWriterLockPath({ git: createRunner(root), openclawDir: root })).toBe(
      path.join(root, ".git", "alphaclaw-writer.lock"),
    );
  });

  it.runIf(hasFlock)("excludes flock(1) users while held, times out, names the holder, and releases", () => {
    const lockPath = path.join(root, ".git", "alphaclaw-writer.lock");
    const lock = acquireWriterLock({ lockPath, waitSeconds: 1, trigger: "scheduled" });
    expect(lock.status).toBe("acquired");
    expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).toBe(1);
    const holder = JSON.parse(fs.readFileSync(`${lockPath}.holder`, "utf8"));
    expect(holder).toMatchObject({ pid: process.pid, trigger: "scheduled" });

    const child = spawnSync(process.execPath, ["-e", `
      const { acquireWriterLock } = require(${JSON.stringify(path.resolve(__dirname, "../../lib/cli/git-writer-lock.js"))});
      const r = acquireWriterLock({ lockPath: ${JSON.stringify(lockPath)}, waitSeconds: 1 });
      process.stdout.write(JSON.stringify({ status: r.status, holderPid: r.holder && r.holder.pid }));
    `], { encoding: "utf8" });
    expect(JSON.parse(child.stdout)).toEqual({ status: "timeout", holderPid: process.pid });

    lock.release();
    expect(fs.existsSync(`${lockPath}.holder`)).toBe(false);
    expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).toBe(0);
  });

  it.runIf(hasFlock)("a git child's backgrounded process never keeps the lock", async () => {
    const lockPath = path.join(root, ".git", "alphaclaw-writer.lock");
    const lock = acquireWriterLock({ lockPath, waitSeconds: 1 });
    const bg = spawn("sleep", ["3"], { detached: true, stdio: "ignore" });
    bg.unref();
    lock.release();
    expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).toBe(0);
    bg.kill();
  });

  it.runIf(hasFlock)("nests only through a fd that really is the lock file", () => {
    const lockPath = path.join(root, ".git", "alphaclaw-writer.lock");
    fs.writeFileSync(lockPath, "");
    const decoy = path.join(root, "decoy");
    fs.writeFileSync(decoy, "");
    const script = (fdTarget) => `
      const fs = require("fs");
      const { spawnSync } = require("child_process");
      const fd = fs.openSync(${JSON.stringify(fdTarget)}, "a");
      spawnSync("flock", ["-x", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
      const r = spawnSync(process.execPath, ["-e", ${JSON.stringify(`
        const { acquireWriterLock } = require(${JSON.stringify(path.resolve(__dirname, "../../lib/cli/git-writer-lock.js"))});
        const r = acquireWriterLock({ lockPath: ${JSON.stringify(lockPath)}, waitSeconds: 1, env: { ALPHACLAW_GIT_LOCK_FD: "3" } });
        process.stdout.write(r.status + ":" + String(r.nested));
      `)}], { stdio: ["ignore", "pipe", "inherit", fd], encoding: "utf8" });
      process.stdout.write(r.stdout);
    `;
    const nested = spawnSync(process.execPath, ["-e", script(lockPath)], { encoding: "utf8" });
    expect(nested.stdout).toBe("acquired:true");
    const forged = spawnSync(process.execPath, ["-e", script(decoy)], { encoding: "utf8" });
    expect(forged.stdout).toBe("acquired:false");
  });

  it("reports unavailable when flock cannot run", () => {
    const lockPath = path.join(root, ".git", "alphaclaw-writer.lock");
    const lock = acquireWriterLock({ lockPath, waitSeconds: 1, flockBin: path.join(root, "no-such-flock") });
    expect(lock.status).toBe("unavailable");
  });
});
