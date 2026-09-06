const fs = require("fs");
const os = require("os");
const path = require("path");

const { performGitSync, hasInProgressRebase } = require("../../lib/cli/git-sync");

// Fix wave F103/F104 — git-sync conflict recovery, driven through a fake git
// runner that records argv and scripts failures per subcommand.
const createRunner = ({ fail = {}, outputs = {} } = {}) => {
  const calls = [];
  const git = (args, opts = {}) => {
    calls.push({ args: [...args], withAuth: opts.withAuth === true });
    const key = args[0] === "diff" && args.includes("--cached") ? "diff-cached" : args[0];
    if (typeof fail[key] === "function" ? fail[key](args, calls) : fail[key]) {
      const err = new Error(`${key} failed`);
      err.stderr = `fatal: ${key} exploded`;
      throw err;
    }
    if (key in outputs) return typeof outputs[key] === "function" ? outputs[key](args) : outputs[key];
    return "";
  };
  return { git, calls };
};

const baseInput = (overrides = {}) => ({
  fsModule: { existsSync: () => false },
  openclawDir: "/tmp/openclaw",
  githubRepo: "owner/repo",
  originUrl: "https://github.com/owner/repo.git",
  commitMessage: "hourly sync",
  log: vi.fn(),
  error: vi.fn(),
  ...overrides,
});

const subcommands = (calls) => calls.map((c) => c.args[0]);

describe("lib/cli/git-sync performGitSync", () => {
  it("happy path: set-url with `--`, pull, add, commit, push — every path operand behind `--`", () => {
    const { git, calls } = createRunner({ fail: { "diff-cached": true } });
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(0);
    expect(calls[0].args).toEqual(["diff", "--name-only", "--diff-filter=U"]);
    expect(calls.find((c) => c.args[0] === "remote").args).toEqual([
      "remote", "set-url", "origin", "--", "https://github.com/owner/repo.git",
    ]);
    expect(calls.find((c) => c.args[0] === "pull").args).toEqual([
      "pull", "--rebase", "--autostash", "origin", "--", "main",
    ]);
    expect(calls.find((c) => c.args[0] === "pull").withAuth).toBe(true);
    expect(calls.find((c) => c.args[0] === "push").args).toEqual(["push", "origin", "--", "main"]);
    expect(subcommands(calls)).toEqual(
      expect.arrayContaining(["ls-remote", "rev-parse", "pull", "diff", "add", "commit", "push"]),
    );
    expect(input.log).toHaveBeenCalledWith(expect.stringContaining("Git sync complete"));
  });

  it("scopes add/commit to the requested file behind `--`", () => {
    const { git, calls } = createRunner({ fail: { "diff-cached": true } });
    expect(performGitSync({ git, ...baseInput({ filePath: "workspace/notes.md" }) })).toBe(0);
    expect(calls.find((c) => c.args[0] === "add").args).toEqual(["add", "-A", "--", "workspace/notes.md"]);
    expect(calls.find((c) => c.args[0] === "commit").args).toEqual([
      "commit", "-m", "hourly sync", "--", "workspace/notes.md",
    ]);
  });

  it("exits 0 with nothing to commit and never pushes", () => {
    const { git, calls } = createRunner();
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(0);
    expect(subcommands(calls)).not.toContain("commit");
    expect(subcommands(calls)).not.toContain("push");
    expect(input.log).toHaveBeenCalledWith("[alphaclaw] No changes to commit");
  });

  it("a missing remote branch only skips the pull (fresh remote) and still commits + pushes", () => {
    const { git, calls } = createRunner({ fail: { "ls-remote": true, "diff-cached": true } });
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(0);
    expect(subcommands(calls)).not.toContain("pull");
    expect(subcommands(calls)).toContain("push");
    expect(input.log).toHaveBeenCalledWith(expect.stringContaining('Remote branch "main" not found'));
  });

  it("a failed pull --rebase aborts ONLY that rebase, commits nothing, pushes nothing, and says why", () => {
    const { git, calls } = createRunner({ fail: { pull: true, "diff-cached": true } });
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(1);
    const pullIdx = calls.findIndex((c) => c.args[0] === "pull");
    expect(calls[pullIdx + 1].args).toEqual(["rebase", "--abort"]);
    expect(subcommands(calls)).not.toContain("add");
    expect(subcommands(calls)).not.toContain("commit");
    expect(subcommands(calls)).not.toContain("push");
    const message = String(input.error.mock.calls[0][0]);
    expect(message).toContain("did not apply cleanly");
    expect(message).toContain("nothing committed or pushed");
    expect(message).toContain("fatal: pull exploded");
    expect(message).not.toContain("not found");
  });

  it("conflict markers left by the autostash re-apply stop the sync before any commit (F103)", () => {
    let pulled = false;
    const { git, calls } = createRunner({
      fail: { "diff-cached": true },
      outputs: {
        diff: (args) =>
          args.includes("--diff-filter=U") && pulled ? "openclaw.json\nworkspace/a.md\n" : "",
      },
    });
    const wrapped = (args, opts) => {
      if (args[0] === "pull") pulled = true;
      return git(args, opts);
    };
    const input = baseInput();
    expect(performGitSync({ git: wrapped, ...input })).toBe(1);
    expect(subcommands(calls)).not.toContain("add");
    expect(subcommands(calls)).not.toContain("commit");
    expect(String(input.error.mock.calls[0][0])).toContain("2 conflicted file(s) (openclaw.json, workspace/a.md)");
  });

  it("refuses to run at all when the repo is already mid-rebase (operator state is never touched)", () => {
    const { git, calls } = createRunner();
    const input = baseInput({
      fsModule: { existsSync: (p) => p.endsWith(path.join(".git", "rebase-merge")) },
    });
    expect(performGitSync({ git, ...input })).toBe(1);
    expect(calls).toEqual([]);
    expect(String(input.error.mock.calls[0][0])).toContain("in-progress git operation (.git/rebase-merge)");
  });

  it("refuses when unmerged paths already exist before the sync", () => {
    const { git, calls } = createRunner({ outputs: { diff: "openclaw.json\n" } });
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(1);
    expect(subcommands(calls)).toEqual(["diff"]);
    expect(String(input.error.mock.calls[0][0])).toContain("unmerged path(s)");
  });

  it("adopts the remote branch on an unborn HEAD (existing empty repo with boilerplate) instead of pulling into it (F104)", () => {
    const { git, calls } = createRunner({
      fail: {
        "rev-parse": (args) => args.includes("--verify"),
        "diff-cached": true,
      },
    });
    const input = baseInput();
    expect(performGitSync({ git, ...input })).toBe(0);
    expect(subcommands(calls)).not.toContain("pull");
    expect(calls.find((c) => c.args[0] === "fetch").args).toEqual(["fetch", "origin", "--", "main"]);
    expect(calls.find((c) => c.args[0] === "reset").args).toEqual(["reset", "--mixed", "FETCH_HEAD"]);
    expect(subcommands(calls)).toContain("push");
    expect(input.log).toHaveBeenCalledWith(expect.stringContaining("Adopted remote main"));
  });

  it("uses the current branch name, not a hardcoded main", () => {
    const { git, calls } = createRunner({
      fail: { "diff-cached": true },
      outputs: { "symbolic-ref": "release\n" },
    });
    expect(performGitSync({ git, ...baseInput() })).toBe(0);
    expect(calls.find((c) => c.args[0] === "push").args).toEqual(["push", "origin", "--", "release"]);
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
