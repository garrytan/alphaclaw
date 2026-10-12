// One table for every git-sync outcome code (issue #140): the CLI's exit
// status and stderr line, the status file, the server's notifications and
// the Doctor card all read it, so a code can never mean two things.
//
//   outcome     ok | warning (backed up, something to look at) |
//               refused (stopped before changing anything risky) |
//               failed (tried and could not finish)
//   exitCode    0 ok/warning, 1 refused/failed, 75 try-again-later (EX_TEMPFAIL)
//   notifyAfter consecutive runs with this code before one notification
const kGitSyncCodes = Object.freeze({
  ok: {
    outcome: "ok",
    exitCode: 0,
    headline: "Git sync complete",
  },
  live_tree_behind: {
    outcome: "warning",
    exitCode: 0,
    notifyAfter: 3,
    headline: "Pushed, but files on this box are behind GitHub",
    action:
      "Local edits to the listed files block the fast-forward. Commit or discard them; the next sync catches up.",
  },
  in_progress_operation: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked by an unfinished rebase or merge",
    action:
      "Another git writer left a rebase, merge or cherry-pick in progress. Let it finish; if its process is gone, finish or abort it (git rebase --continue / --abort) in the .openclaw directory.",
  },
  unmerged_paths: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked by unresolved conflicts",
    action: "Resolve the conflicted files in the .openclaw directory and commit them.",
  },
  merge_conflict: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked: local and GitHub changes conflict",
    action:
      "Nothing was pushed and the working tree is untouched. Merge origin into the local branch by hand, resolve the listed files and commit.",
  },
  detached_head: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked: the .openclaw checkout is on a detached HEAD",
    action: "Check out the sync branch again (git switch main) in the .openclaw directory.",
  },
  unrelated_histories: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked: the local branch and GitHub share no history",
    action: "Point GITHUB_WORKSPACE_REPO at the right repository, or merge the two histories by hand.",
  },
  git_too_old: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync needs git 2.38+ to merge diverged history",
    action: "Upgrade git in the runtime image (node:24-slim ships 2.39).",
  },
  index_locked: {
    outcome: "refused",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync blocked by a git lock file that never cleared",
    action:
      "A git lock file stayed in place for over a minute. If no git process is running in .openclaw, remove the named lock file.",
  },
  lock_timeout: {
    outcome: "refused",
    exitCode: 75,
    notifyAfter: 3,
    headline: "Git sync skipped: another git writer held the writer lock",
    action: "The next run retries. If this repeats, check which process holds alphaclaw-writer.lock.",
  },
  remote_unreachable: {
    outcome: "failed",
    exitCode: 1,
    notifyAfter: 3,
    headline: "Git sync could not reach GitHub",
    action: "Check GITHUB_TOKEN, GITHUB_WORKSPACE_REPO and network access.",
  },
  push_failed: {
    outcome: "failed",
    exitCode: 1,
    notifyAfter: 3,
    headline: "Git sync could not push to GitHub",
    action: "Check the token's write access and any branch protection on the sync branch.",
  },
  deadline_exceeded: {
    outcome: "failed",
    exitCode: 75,
    notifyAfter: 3,
    headline: "Git sync ran out of time",
    action: "The next run retries. A slow remote or a long lock wait causes this.",
  },
  not_configured: {
    outcome: "failed",
    exitCode: 1,
    notifyAfter: 1,
    headline: "Git sync is not configured",
    action: "Set GITHUB_TOKEN and GITHUB_WORKSPACE_REPO in the Envars tab and make sure git is installed.",
  },
  usage: {
    outcome: "failed",
    exitCode: 2,
    headline: "git-sync was called with invalid arguments",
    action: "Run alphaclaw --help for the git-sync options.",
  },
  failed: {
    outcome: "failed",
    exitCode: 1,
    notifyAfter: 3,
    headline: "Git sync failed",
    action: "See /var/log/openclaw-hourly-sync.log for the git error.",
  },
});

const getGitSyncCode = (code) => kGitSyncCodes[code] || kGitSyncCodes.failed;

const isGitSyncSuccess = (outcome) => outcome === "ok" || outcome === "warning";

module.exports = { kGitSyncCodes, getGitSyncCode, isGitSyncSuccess };
