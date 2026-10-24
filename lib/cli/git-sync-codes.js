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
  held_back: {
    outcome: "warning",
    exitCode: 0,
    notifyAfter: 1,
    headline: "Git sync is holding back large new files",
    action:
      "Everything else was pushed. Move the listed paths out of the workspace or add them to .gitignore; raise ALPHACLAW_GIT_SYNC_MAX_NEW_MB only if they belong in the backup.",
  },
  nested_repo: {
    outcome: "warning",
    exitCode: 0,
    notifyAfter: 1,
    headline: "Git sync is not backing up nested git repositories",
    action:
      "Everything else was pushed, including files the backup already tracks inside a nested repository. Not backed up: a separate repository's own content and history, and the repository behind a pointer (gitlink). Push those repositories to their own remote, or, if their files belong in this backup, remove the nested .git (for a pointer: git rm --cached <path>).",
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

// The git error behind a failed run as ONE plain sentence, for the owner
// notification, the watchdog event, the Doctor card and the General tab.
// Known git messages get a sentence a person can act on; anything else is
// git's own first error line. Never more than one line, never a URL's
// userinfo. Only codes whose detail is git's own output have one: the
// other codes' headline already names the cause, and their detail can name
// live processes, which the General tab must not show.
const kGitOutputCodes = new Set(["failed", "push_failed", "remote_unreachable", "unrelated_histories"]);
const kGitErrorSentences = [
  [/pathspec '([^'\n]*)' did not match/, (file) => `Git could not match "${file}", a path the sync asked it to commit.`],
  [/'([^'\n]*)' does not have a commit checked out/, (file) => `"${file}" is a nested git repository with no commits, so git cannot add it.`],
  [/pathspec '([^'\n]*)' is beyond a symbolic link/, (file) => `"${file}" sits inside a symlinked folder, so git cannot commit it.`],
  [/unable to index file '([^'\n]*)'/, (file) => `Git could not read "${file}" to commit it.`],
  [/No space left on device/i, () => "The disk is full, so git could not write."],
  [/Authentication failed|could not read Username|Invalid username or password|returned error: 40[13]/i, () => "GitHub rejected the sync's credentials."],
  [/Repository not found|returned error: 404/i, () => "GitHub says the repository does not exist or the token cannot see it."],
  [/protected branch|GH006/, () => "GitHub refused the push because the branch is protected."],
  [/Could not resolve host|Failed to connect|Connection timed out|Connection refused/i, () => "The box could not connect to GitHub."],
];
const kMaxSentenceChars = 240;

const describeGitSyncFailure = ({ code, detail } = {}) => {
  if (!kGitOutputCodes.has(kGitSyncCodes[code] ? code : "failed")) return "";
  const text = String(detail || "").replace(/(https?:\/\/)[^/@\s]+@/g, "$1");
  for (const [pattern, sentence] of kGitErrorSentences) {
    const match = pattern.exec(text);
    if (match) return sentence(match[1]).slice(0, kMaxSentenceChars);
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const gitLine = lines.find((line) => /^(fatal|error):/i.test(line));
  const line = (gitLine || lines[0] || "").replace(/^(fatal|error):\s*/i, "").replace(/\s+/g, " ");
  if (!line) return "";
  const sentence = gitLine ? `Git reported: ${line}` : line.charAt(0).toUpperCase() + line.slice(1);
  const bounded = sentence.length > kMaxSentenceChars ? `${sentence.slice(0, kMaxSentenceChars - 1)}…` : sentence;
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`;
};

module.exports = { kGitSyncCodes, getGitSyncCode, isGitSyncSuccess, describeGitSyncFailure };
