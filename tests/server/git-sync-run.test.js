const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  performGitSync,
  hasInProgressRebase,
  parseStatusEntries,
  parseGitSyncPaths,
} = require("../../lib/cli/git-sync");

// git-sync engine command sequence (issue #140; earlier F103/F104), driven
// through a fake git runner that records argv and scripts failures. The
// real-git behavior lives in git-sync-real-git.test.js.
const gitError = (message, { status = 1, stdout = "" } = {}) => {
  const err = new Error(message);
  err.stderr = message;
  err.stdout = stdout;
  err.status = status;
  return err;
};

const createRunner = ({ outputs = {}, fail = {} } = {}) => {
  const calls = [];
  const git = (args, opts = {}) => {
    calls.push({ args: [...args], opts });
    const key = args[0];
    const failure = typeof fail[key] === "function" ? fail[key](args, calls) : fail[key];
    if (failure) throw failure instanceof Error ? failure : gitError(`fatal: ${key} exploded`);
    const output = outputs[key];
    if (typeof output === "function") return output(args, calls);
    if (output !== undefined) return output;
    return "";
  };
  return { git, calls };
};

// A repo on main, origin already correct, one modified file, remote equal to
// the local tip before the commit.
const happyOutputs = (overrides = {}) => ({
  "--version": "git version 2.39.5\n",
  "symbolic-ref": "main\n",
  remote: "https://github.com/owner/repo.git\n",
  config: (args) => (args.includes("user.name") ? "AlphaClaw Agent\n" : "agent@alphaclaw.md\n"),
  status: " M openclaw.json\0",
  "rev-parse": (args) => {
    if (args.includes("--git-dir")) return ".git\n";
    if (args.includes("--show-toplevel")) return "/tmp/openclaw\n";
    if (args.includes("--show-prefix")) return "\n";
    if (args.includes("--short")) return "abc1234\n";
    if (args.some((arg) => arg.startsWith("refs/remotes/origin/"))) return "remote-sha\n";
    return "local-sha\n";
  },
  "merge-base": (args) => {
    if (args[2] === "remote-sha" && args[3] === "local-sha") return "";
    throw gitError("", { status: 1 });
  },
  ...overrides,
});

const baseInput = (overrides = {}) => ({
  fsModule: {
    existsSync: () => false,
    statSync: () => ({ mtimeMs: 0 }),
    lstatSync: () => ({ isDirectory: () => false }),
  },
  openclawDir: "/tmp/openclaw",
  githubRepo: "owner/repo",
  originUrl: "https://github.com/owner/repo.git",
  commitMessage: "hourly sync",
  listOwners: () => [],
  sleepFn: () => {},
  log: vi.fn(),
  error: vi.fn(),
  ...overrides,
});

const subcommands = (calls) => calls.map((c) => c.args[0]);

describe("lib/cli/git-sync performGitSync", () => {
  it("happy path: scoped commit by pathspec file, fetch, push the pinned SHA — never pull, rebase, stash or add -A", () => {
    const { git, calls } = createRunner({ outputs: happyOutputs() });
    const input = baseInput();
    const result = performGitSync({ git, ...input });
    expect(result).toMatchObject({ code: "ok", exitCode: 0, committed: true, pushed: true, integration: "push" });
    const commit = calls.find((c) => c.args[0] === "commit");
    expect(commit.args).toEqual([
      "commit", "--only", "-m", "hourly sync", "--pathspec-from-file=-", "--pathspec-file-nul",
    ]);
    expect(commit.opts).toMatchObject({ input: "openclaw.json\0", literalPathspecs: true });
    expect(calls.find((c) => c.args[0] === "fetch").args).toEqual([
      "fetch", "origin", "--", "+refs/heads/main:refs/remotes/origin/main",
    ]);
    const push = calls.find((c) => c.args[0] === "push");
    expect(push.args).toEqual(["push", "origin", "--", "local-sha:refs/heads/main"]);
    expect(push.opts.withAuth).toBe(true);
    for (const forbidden of ["pull", "rebase", "stash", "add", "reset", "checkout", "restore"]) {
      expect(subcommands(calls)).not.toContain(forbidden);
    }
    expect(input.log).toHaveBeenCalledWith(expect.stringContaining("Git sync complete (abc1234)"));
  });

  it("only rewrites origin and the identity when they differ", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs({ remote: "https://github.com/old/repo.git\n", config: "" }),
    });
    performGitSync({ git, ...baseInput() });
    expect(calls.find((c) => c.args[1] === "set-url").args).toEqual([
      "remote", "set-url", "origin", "--", "https://github.com/owner/repo.git",
    ]);
    expect(calls.filter((c) => c.args[0] === "config" && c.args[1] !== "--get")).toHaveLength(2);

    const unchanged = createRunner({ outputs: happyOutputs() });
    performGitSync({ git: unchanged.git, ...baseInput() });
    expect(unchanged.calls.some((c) => c.args[1] === "set-url")).toBe(false);
    expect(unchanged.calls.filter((c) => c.args[0] === "config" && c.args[1] !== "--get")).toHaveLength(0);
  });

  it("untracked candidates are registered with add -N before the single commit", () => {
    const { git, calls } = createRunner({ outputs: happyOutputs({ status: "?? workspace/new.md\0 M openclaw.json\0" }) });
    performGitSync({ git, ...baseInput() });
    const add = calls.find((c) => c.args[0] === "add");
    expect(add.args).toEqual(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"]);
    expect(add.opts.input).toBe("workspace/new.md\0");
    expect(calls.find((c) => c.args[0] === "commit").opts.input).toBe("workspace/new.md\0openclaw.json\0");
  });

  it("scans only the managed directory and runs add and commit from the repository's top level", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs({
        status: "?? .openclaw/workspace/new.md\0",
        "rev-parse": (args) => {
          if (args.includes("--show-toplevel")) return "/data\n";
          if (args.includes("--show-prefix")) return ".openclaw/\n";
          return happyOutputs()["rev-parse"](args);
        },
      }),
    });
    performGitSync({ git, ...baseInput({ openclawDir: "/data/.openclaw" }) });
    const status = calls.find((c) => c.args[0] === "status");
    expect(status.args.slice(-2)).toEqual(["--", "."]);
    expect(status.opts.cwd).toBeUndefined();
    for (const subcommand of ["add", "commit"]) {
      const call = calls.find((c) => c.args[0] === subcommand);
      expect(call.opts).toMatchObject({ cwd: "/data", literalPathspecs: true, bytes: true, input: ".openclaw/workspace/new.md\0" });
    }
  });

  it("scopes the candidate listing to --file or ALPHACLAW_GIT_SYNC_PATHS behind `--`", () => {
    const single = createRunner({ outputs: happyOutputs() });
    performGitSync({ git: single.git, ...baseInput({ filePath: "workspace/notes.md" }) });
    expect(single.calls.find((c) => c.args[0] === "status").args.slice(-2)).toEqual(["--", "workspace/notes.md"]);

    const listed = createRunner({ outputs: happyOutputs() });
    performGitSync({ git: listed.git, ...baseInput({ syncPaths: ["openclaw.json", "cron/"] }) });
    expect(listed.calls.find((c) => c.args[0] === "status").args.slice(-3)).toEqual(["--", "openclaw.json", "cron/"]);
  });

  it("nothing to commit still integrates, and pushes nothing when the remote already contains HEAD", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs({
        status: "",
        "rev-parse": (args) => (args.includes("--git-dir") ? ".git\n" : "same-sha\n"),
      }),
    });
    const input = baseInput();
    const result = performGitSync({ git, ...input });
    expect(result).toMatchObject({ code: "ok", committed: false, pushed: false });
    expect(subcommands(calls)).toContain("fetch");
    expect(subcommands(calls)).not.toContain("commit");
    expect(subcommands(calls)).not.toContain("push");
    expect(input.log).toHaveBeenCalledWith("[alphaclaw] No changes to commit");
  });

  it("a missing remote branch (ls-remote exit 2) commits and pushes to create it", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs(),
      fail: { "ls-remote": gitError("", { status: 2 }) },
    });
    const result = performGitSync({ git, ...baseInput() });
    expect(result).toMatchObject({ code: "ok", pushed: true });
    expect(subcommands(calls)).not.toContain("fetch");
    expect(calls.find((c) => c.args[0] === "push").args).toEqual(["push", "origin", "--", "local-sha:refs/heads/main"]);
  });

  it("an ls-remote auth or network failure is remote_unreachable, never 'branch absent'", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs(),
      fail: { "ls-remote": gitError("fatal: Authentication failed", { status: 128 }) },
    });
    const result = performGitSync({ git, ...baseInput() });
    expect(result).toMatchObject({ code: "remote_unreachable", exitCode: 1, outcome: "failed" });
    expect(subcommands(calls)).not.toContain("commit");
    expect(subcommands(calls)).not.toContain("push");
  });

  it("adopts the remote branch on an unborn HEAD BEFORE staging (F104)", () => {
    let adopted = false;
    const { git, calls } = createRunner({
      outputs: happyOutputs({
        reset: () => {
          adopted = true;
          return "";
        },
      }),
      fail: {
        "rev-parse": (args) => !adopted && args.includes("--quiet"),
      },
    });
    const input = baseInput();
    performGitSync({ git, ...input });
    const order = subcommands(calls);
    expect(order.indexOf("reset")).toBeLessThan(order.indexOf("status"));
    expect(calls.find((c) => c.args[0] === "reset").args).toEqual(["reset", "--mixed", "FETCH_HEAD"]);
    expect(input.log).toHaveBeenCalledWith(expect.stringContaining("Adopted remote main"));
  });

  it("uses the current branch name and refuses a detached HEAD instead of assuming main", () => {
    const release = createRunner({ outputs: happyOutputs({ "symbolic-ref": "release\n" }) });
    performGitSync({ git: release.git, ...baseInput() });
    expect(release.calls.find((c) => c.args[0] === "push").args).toEqual([
      "push", "origin", "--", "local-sha:refs/heads/release",
    ]);

    const detached = createRunner({ outputs: happyOutputs(), fail: { "symbolic-ref": true } });
    const result = performGitSync({ git: detached.git, ...baseInput() });
    expect(result).toMatchObject({ code: "detached_head", exitCode: 1 });
    expect(subcommands(detached.calls)).not.toContain("commit");
  });

  it("refuses an in-progress operation, names the owner, and never advises aborting a live one", () => {
    const { git, calls } = createRunner({ outputs: happyOutputs() });
    const input = baseInput({
      fsModule: {
        existsSync: (p) => p.endsWith(path.join(".git", "rebase-merge")),
        statSync: () => ({ mtimeMs: Date.now() - 90_000 }),
      },
      listOwners: () => [{ pid: 812, cmd: "git rebase" }],
    });
    const result = performGitSync({ git, ...input });
    expect(result).toMatchObject({ code: "in_progress_operation", exitCode: 1, outcome: "refused" });
    expect(result.staleState).toMatchObject({ marker: "rebase-merge", owners: [{ pid: 812, cmd: "git rebase" }] });
    expect(result.staleState.ageSeconds).toBeGreaterThanOrEqual(89);
    expect(subcommands(calls)).not.toContain("commit");
    const message = String(input.error.mock.calls[0][0]);
    expect(message).toContain("pid 812 (git rebase)");
    expect(message).toContain("do not abort it while it runs");
  });

  it("refuses when unmerged paths already exist", () => {
    const { git, calls } = createRunner({ outputs: happyOutputs({ diff: "openclaw.json\n" }) });
    const result = performGitSync({ git, ...baseInput() });
    expect(result).toMatchObject({ code: "unmerged_paths", paths: ["openclaw.json"] });
    expect(subcommands(calls)).not.toContain("ls-remote");
  });

  it("diverged: merge-tree of the pinned tips, commit-tree with both parents, push it, fast-forward", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs({
        "merge-base": () => {
          throw gitError("", { status: 1 });
        },
        "merge-tree": "tree-sha\n",
        "commit-tree": "merge-sha\n",
      }),
    });
    const result = performGitSync({ git, ...baseInput() });
    expect(result).toMatchObject({ code: "ok", integration: "merge", pushed: true });
    expect(calls.find((c) => c.args[0] === "merge-tree").args).toEqual([
      "merge-tree", "--write-tree", "--name-only", "--no-messages", "local-sha", "remote-sha",
    ]);
    expect(calls.find((c) => c.args[0] === "commit-tree").args).toEqual([
      "commit-tree", "tree-sha", "-p", "local-sha", "-p", "remote-sha", "-m", "sync: merge origin/main (AlphaClaw)",
    ]);
    expect(calls.find((c) => c.args[0] === "push").args).toEqual(["push", "origin", "--", "merge-sha:refs/heads/main"]);
    expect(calls.find((c) => c.args[0] === "merge").args).toEqual(["merge", "--ff-only", "--no-edit", "merge-sha"]);
  });

  it("diverged on git < 2.38 refuses with git_too_old", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs({
        "--version": "git version 2.34.1\n",
        "merge-base": () => {
          throw gitError("", { status: 1 });
        },
      }),
    });
    const result = performGitSync({ git, ...baseInput() });
    expect(result).toMatchObject({ code: "git_too_old", exitCode: 1 });
    expect(subcommands(calls)).not.toContain("push");
  });

  it("re-fetches and retries when the remote moves between fetch and push, then gives up as push_failed", () => {
    const rejected = gitError(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs");
    const { git, calls } = createRunner({ outputs: happyOutputs(), fail: { push: rejected } });
    const result = performGitSync({ git, ...baseInput() });
    expect(calls.filter((c) => c.args[0] === "fetch")).toHaveLength(3);
    expect(calls.filter((c) => c.args[0] === "push")).toHaveLength(3);
    expect(result).toMatchObject({ code: "push_failed", exitCode: 1, pushed: false });
  });

  it("a protected-branch rejection is push_failed on the first attempt", () => {
    const { git, calls } = createRunner({
      outputs: happyOutputs(),
      fail: { push: gitError("remote: error: GH006: Protected branch update failed") },
    });
    const result = performGitSync({ git, ...baseInput() });
    expect(calls.filter((c) => c.args[0] === "push")).toHaveLength(1);
    expect(result.code).toBe("push_failed");
  });

  it("the deadline turns a hung git child into deadline_exceeded", () => {
    const timedOut = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
    const { git } = createRunner({ outputs: happyOutputs(), fail: { fetch: timedOut } });
    const result = performGitSync({ git, ...baseInput({ deadlineAtMs: Date.now() + 60_000 }) });
    expect(result).toMatchObject({ code: "deadline_exceeded", exitCode: 75 });
  });

  it("passes the remaining budget to every git child", () => {
    const { git, calls } = createRunner({ outputs: happyOutputs() });
    performGitSync({ git, ...baseInput({ deadlineAtMs: Date.now() + 30_000 }) });
    expect(calls.every((c) => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 30_000)).toBe(true);
  });

  it("hasInProgressRebase recognizes every git operation marker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gitsync-"));
    try {
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      expect(hasInProgressRebase(fs, dir)).toBeNull();
      fs.writeFileSync(path.join(dir, ".git", "MERGE_HEAD"), "abc");
      expect(hasInProgressRebase(fs, dir)).toBe("MERGE_HEAD");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("git-sync helpers", () => {
  it("parseStatusEntries takes working-tree changes and untracked files, skips staged-only entries", () => {
    expect(parseStatusEntries(" M a.md\0?? b.md\0A  c.md\0MM d.md\0 D e.md\0 A f.md\0")).toEqual({
      candidates: ["a.md", "b.md", "d.md", "e.md", "f.md"],
      untracked: ["b.md"],
      deleted: ["e.md"],
      skippedStaged: 1,
    });
  });

  it("parseGitSyncPaths splits on commas and newlines and rejects pathspec magic and escapes", () => {
    expect(parseGitSyncPaths("openclaw.json, cron/\n./workspace/")).toEqual({
      ok: true,
      paths: ["openclaw.json", "cron/", "workspace/"],
    });
    expect(parseGitSyncPaths("")).toEqual({ ok: true, paths: [] });
    expect(parseGitSyncPaths(":(glob)**").ok).toBe(false);
    expect(parseGitSyncPaths("../etc").ok).toBe(false);
  });
});
