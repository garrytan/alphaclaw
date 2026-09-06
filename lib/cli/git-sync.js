const normalizeGitSyncFilePath = (requestedFilePath) => {
  const rawPath = String(requestedFilePath || "").trim();
  if (!rawPath) return "";
  return rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
};

const validateGitSyncFilePath = (normalizedFilePath) => {
  if (!normalizedFilePath) return { ok: true };
  if (
    normalizedFilePath.startsWith("/") ||
    normalizedFilePath.startsWith("../") ||
    normalizedFilePath.includes("/../")
  ) {
    return {
      ok: false,
      error: "[alphaclaw] --file must stay within the managed .openclaw directory",
    };
  }
  return { ok: true };
};

module.exports = {
  normalizeGitSyncFilePath,
  validateGitSyncFilePath,
};

// ---------------------------------------------------------------------------
// performGitSync — the git-sync verb's body, with a fake-able runner.
// ---------------------------------------------------------------------------
// Fix wave F103/F104. The old inline implementation (bin/alphaclaw.js) had no
// conflict recovery: ANY `pull --rebase --autostash` failure was logged as
// "remote branch not found" and swallowed, a stopped rebase was left in place
// (permanent wedge on a detached HEAD, every later push rejected), and an
// autostash re-apply conflict exited 0 so conflict-marked openclaw.json and
// workspace files were committed and pushed as a successful sync.
//
//   preflight ── mid-rebase or unmerged paths already? ──▶ STOP (exit 1, touch nothing)
//      │
//   set-url / config ─▶ ls-remote (branch exists?) ──no──▶ skip pull (fresh remote)
//      │                                          yes
//      │                              unborn HEAD? ─▶ fetch + reset --mixed FETCH_HEAD (adopt)
//      │                                           └▶ pull --rebase --autostash
//      │                                                 │ fails ─▶ rebase --abort (ours only), STOP exit 1
//      │                                                 └ unmerged paths after? ─▶ STOP exit 1
//   add / diff --cached / commit / push (argv, `--` before paths)
//
// Non-destructive by construction: the only thing ever aborted is the rebase
// THIS sync started; pre-existing operator state stops the sync instead.
const hasInProgressRebase = (fsModule, openclawDir) => {
  const path = require("path");
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (fsModule.existsSync(path.join(openclawDir, ".git", marker))) return marker;
  }
  return null;
};

const describeGitError = (error) =>
  String(error?.stderr || error?.stdout || error?.message || "").trim().slice(0, 400);

const performGitSync = ({
  git,
  fsModule = require("fs"),
  openclawDir,
  githubRepo,
  originUrl,
  commitMessage,
  filePath = "",
  log = console.log,
  error = console.error,
}) => {
  const inProgress = hasInProgressRebase(fsModule, openclawDir);
  if (inProgress) {
    error(
      `[alphaclaw] git-sync refused: ${openclawDir} has an in-progress git operation (.git/${inProgress}). Finish or abort it manually (git rebase --abort / git merge --abort) — the sync will not touch it.`,
    );
    return 1;
  }
  const unmergedBefore = listUnmergedPaths(git);
  if (unmergedBefore.length > 0) {
    error(
      `[alphaclaw] git-sync refused: ${unmergedBefore.length} unmerged path(s) in ${openclawDir} (${unmergedBefore.slice(0, 3).join(", ")}). Resolve them manually first.`,
    );
    return 1;
  }

  let branch = "main";
  try {
    branch = String(git(["symbolic-ref", "--short", "HEAD"])).trim() || "main";
  } catch {}

  try {
    git(["remote", "set-url", "origin", "--", originUrl]);
    git(["config", "user.name", "AlphaClaw Agent"]);
    git(["config", "user.email", "agent@alphaclaw.md"]);

    let remoteBranchExists = true;
    try {
      git(["ls-remote", "--exit-code", "--heads", "origin", "--", branch], { withAuth: true });
    } catch {
      remoteBranchExists = false;
      log(`[alphaclaw] Remote branch "${branch}" not found, skipping pull`);
    }

    if (remoteBranchExists) {
      const headIsUnborn = (() => {
        try {
          git(["rev-parse", "--verify", "--quiet", "HEAD"]);
          return false;
        } catch {
          return true;
        }
      })();
      if (headIsUnborn) {
        // Fresh local repo against a remote that already has history (the
        // "existing empty repo" GitHub boilerplate case): adopt the remote
        // branch as our base without touching the working tree, so the first
        // commit is a fast-forward instead of an unrelated root the push
        // rejects.
        git(["fetch", "origin", "--", branch], { withAuth: true });
        git(["reset", "--mixed", "FETCH_HEAD"]);
        log(`[alphaclaw] Adopted remote ${branch} as the base for the first sync`);
      } else {
        try {
          git(["pull", "--rebase", "--autostash", "origin", "--", branch], { withAuth: true });
        } catch (pullError) {
          // Abort ONLY the rebase this sync started; local changes come back
          // out of the autostash. Then say what happened — never commit over
          // a half-applied rebase.
          try {
            git(["rebase", "--abort"]);
          } catch {}
          error(
            `[alphaclaw] git-sync failed: pull --rebase from origin/${branch} did not apply cleanly (local changes preserved, nothing committed or pushed). ${describeGitError(pullError)}`,
          );
          return 1;
        }
        const unmergedAfter = listUnmergedPaths(git);
        if (unmergedAfter.length > 0) {
          error(
            `[alphaclaw] git-sync failed: re-applying local changes after the rebase left ${unmergedAfter.length} conflicted file(s) (${unmergedAfter.slice(0, 3).join(", ")}). Resolve them manually; nothing was committed or pushed.`,
          );
          return 1;
        }
      }
    }

    if (filePath) {
      git(["add", "-A", "--", filePath]);
    } else {
      git(["add", "-A"]);
    }
    try {
      git(["diff", "--cached", "--quiet"]);
      log("[alphaclaw] No changes to commit");
      return 0;
    } catch {}
    if (filePath) {
      git(["commit", "-m", commitMessage, "--", filePath]);
    } else {
      git(["commit", "-m", commitMessage]);
    }
    git(["push", "origin", "--", branch], { withAuth: true });
    const hash = String(git(["rev-parse", "--short", "HEAD"])).trim();
    log(`[alphaclaw] Git sync complete (${hash})`);
    log(`[alphaclaw] Commit URL: https://github.com/${githubRepo}/commit/${hash}`);
    return 0;
  } catch (e) {
    error(`[alphaclaw] git-sync failed: ${describeGitError(e)}`);
    return 1;
  }
};

const listUnmergedPaths = (git) => {
  try {
    return String(git(["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

module.exports.performGitSync = performGitSync;
module.exports.hasInProgressRebase = hasInProgressRebase;
