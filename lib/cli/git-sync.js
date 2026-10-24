const fs = require("fs");
const path = require("path");
const { getGitSyncCode } = require("./git-sync-codes");

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

// ALPHACLAW_GIT_SYNC_PATHS: comma- or newline-separated paths the sync may
// commit. Each entry is a literal path (no `:` pathspec magic) inside the
// managed directory.
const parseGitSyncPaths = (rawValue) => {
  const entries = String(rawValue || "")
    .split(/[,\n]/)
    .map((entry) => normalizeGitSyncFilePath(entry))
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith(":") || !validateGitSyncFilePath(entry).ok) {
      return {
        ok: false,
        error: `[alphaclaw] ALPHACLAW_GIT_SYNC_PATHS entry ${JSON.stringify(entry)} must be a plain path inside the managed .openclaw directory`,
      };
    }
  }
  return { ok: true, paths: entries };
};

module.exports = {
  normalizeGitSyncFilePath,
  validateGitSyncFilePath,
  parseGitSyncPaths,
};

// ---------------------------------------------------------------------------
// performGitSync — the git-sync verb's body, with a fake-able runner.
// ---------------------------------------------------------------------------
// Issue #140: the sync shares the checkout with other writers (agents, cron
// scripts, hooks), so it never rewrites the live tree. No pull, no rebase,
// no stash, no `add -A`:
//
//   preflight ── rebase/merge in progress, unmerged paths, detached HEAD? ──▶ REFUSE
//      │
//   ls-remote ── branch absent ─▶ commit, push, done
//      │         unborn HEAD   ─▶ fetch + reset --mixed FETCH_HEAD (adopt)
//   commit ONLY paths with working-tree changes (others' staged-only entries stay staged)
//      │
//   fetch, pin L=HEAD and R=origin/<branch> once
//      ├─ L contains R ─▶ push L
//      ├─ R contains L ─▶ nothing to push
//      └─ diverged ─────▶ merge-tree R L (no worktree) ── conflict ─▶ REFUSE, nothing pushed
//                          └▶ commit-tree -p L -p R ─▶ push
//   push rejected (remote moved) ─▶ re-fetch, up to 3 attempts
//   live tree: merge --ff-only <pushed> ── refused (dirty overlap / HEAD moved) ─▶ warning
//
// Lock-file contention (index.lock & co.) is retried with backoff for up to
// 60 s. The caller holds the cooperative writer lock (git-writer-lock.js).
const kOperationMarkers = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];
const kLockContentionPattern = /Unable to create '([^']+\.lock)': File exists/;
const kLockBackoffInitialMs = 250;
const kLockBackoffMaxMs = 8_000;
const kLockBackoffTotalMs = 60_000;
const kPushAttempts = 3;
const kMaxReportedPaths = 20;

class GitSyncStop extends Error {
  constructor(code, detail, extra = {}) {
    super(detail);
    this.syncCode = code;
    this.detail = detail;
    this.extra = extra;
  }
}

const describeGitError = (error) =>
  String(error?.stderr || error?.stdout || error?.message || "").trim().slice(0, 400);

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const parseGitVersion = (text) => {
  const match = /(\d+)\.(\d+)/.exec(String(text || ""));
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

const supportsMergeTree = (version) =>
  !version || version.major > 2 || (version.major === 2 && version.minor >= 38);

const ageSeconds = (fsModule, filePath, nowMs) => {
  try {
    return Math.max(0, Math.round((nowMs - fsModule.statSync(filePath).mtimeMs) / 1000));
  } catch {
    return null;
  }
};

const findOperationMarker = (fsModule, gitDir) => {
  for (const marker of kOperationMarkers) {
    const markerPath = path.join(gitDir, marker);
    if (fsModule.existsSync(markerPath)) return { marker, markerPath };
  }
  return null;
};

// Back-compat export: the marker name of an in-progress operation, or null.
const hasInProgressRebase = (fsModule, openclawDir) =>
  findOperationMarker(fsModule, path.join(openclawDir, ".git"))?.marker || null;

// Best-effort list of live git processes working inside the repo, so a
// refusal can say "pid 812 (git rebase) is still running" instead of
// advising an abort that would destroy someone's work.
const listRepoGitProcesses = ({ openclawDir, fsModule = fs }) => {
  const owners = [];
  let repoRoot = "";
  try {
    repoRoot = fsModule.realpathSync(openclawDir);
  } catch {
    return owners;
  }
  let entries = [];
  try {
    entries = fsModule.readdirSync("/proc");
  } catch {
    return owners;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cwd = fsModule.readlinkSync(`/proc/${entry}/cwd`);
      if (cwd !== repoRoot && !cwd.startsWith(`${repoRoot}${path.sep}`)) continue;
      const argv = fsModule.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (path.basename(argv[0] || "") !== "git") continue;
      const subcommand = argv.slice(1).find((arg) => !arg.startsWith("-")) || "";
      owners.push({ pid: Number(entry), cmd: `git ${subcommand}`.trim().slice(0, 40) });
      if (owners.length >= 5) break;
    } catch {}
  }
  return owners;
};

const toNulList = (paths) => `${paths.join("\0")}\0`;

// `git status --porcelain=v1 -z`: "XY path\0" per entry (renames disabled).
// Y != " " means the working tree differs from the index (or the file is
// untracked): those are the sync's candidates. X set with Y blank is an
// entry someone staged and did not touch since; it is left alone.
const parseStatusEntries = (raw) => {
  const candidates = [];
  const untracked = [];
  const deleted = [];
  let skippedStaged = 0;
  for (const entry of String(raw || "").split("\0")) {
    if (entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const filePath = entry.slice(3);
    if (indexStatus === "?") {
      candidates.push(filePath);
      untracked.push(filePath);
    } else if (worktreeStatus !== " ") {
      candidates.push(filePath);
      if (worktreeStatus === "D") deleted.push(filePath);
    } else if (indexStatus !== " ") {
      skippedStaged += 1;
    }
  }
  return { candidates, untracked, deleted, skippedStaged };
};

// Paths cross the status → add → commit hops as raw bytes: git prints a file
// name exactly as stored, which need not be valid UTF-8, and decoding it as
// UTF-8 turns it into a different name that matches no file ("pathspec ...
// did not match"). Runs that carry paths use latin1, a lossless byte-to-char
// mapping, in both directions; only display text is decoded as UTF-8.
const fromPathBytes = (value) => Buffer.from(String(value), "latin1").toString("utf8");
const kPathspecMismatchPattern = /pathspec '[^\n]*' did not match/;
const kCommitAttempts = 2;
const kDefaultMaxUntrackedBytes = 50 * 1024 * 1024;

// Never committed, whatever .gitignore says: OpenClaw's copies of the state
// directory (Doctor/update captures beside it, package and shim backups),
// and the managed directory's secret-bearing state. Matched on raw path
// segments, so a copy is caught wherever it lands in the scan.
const kStateCopySegment = /(\.update-captures$|^\.openclaw\.package-backup-|^\.openclaw\.shim-backup-)/;
const kManagedSecretPaths = [".env", ".alphaclaw/", "credentials/", "identity/", "devices/", "agents/"];
const isProtectedStatePath = (relativePath, managedPrefix = "") => {
  const segments = String(relativePath).split("/").filter(Boolean);
  if (segments.some((segment) => kStateCopySegment.test(segment))) return true;
  if (!String(relativePath).startsWith(managedPrefix)) return false;
  const managedPath = String(relativePath).slice(managedPrefix.length);
  return kManagedSecretPaths.some((entry) =>
    entry.endsWith("/") ? managedPath.startsWith(entry) || `${managedPath}/` === entry : managedPath === entry,
  );
};

const formatBytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
const describeHeldBack = (heldBack) =>
  `${heldBack.slice(0, 3).map((entry) => `${entry.path} (${formatBytes(entry.bytes)})`).join(", ")}${heldBack.length > 3 ? ` and ${heldBack.length - 3} more` : ""}`;

const parseOverwrittenPaths = (text) =>
  String(text || "")
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim())
    .filter(Boolean);

const isPushRejectedByRace = (error) =>
  /\[rejected\]/.test(describeGitError(error)) &&
  /fetch first|non-fast-forward/.test(describeGitError(error));

const formatStaleState = (staleState) => {
  if (!staleState) return "";
  const age = Number.isFinite(staleState.ageSeconds) ? `, ${staleState.ageSeconds}s old` : "";
  const owners = staleState.owners?.length
    ? `; still running: ${staleState.owners.map((owner) => `pid ${owner.pid} (${owner.cmd})`).join(", ")} — do not abort it while it runs`
    : "; no git process is running in the repo";
  return ` (.git/${staleState.marker}${age}${owners})`;
};

const performGitSync = ({
  git,
  fsModule = fs,
  openclawDir,
  githubRepo,
  originUrl,
  commitMessage,
  filePath = "",
  syncPaths = [],
  maxUntrackedBytes = kDefaultMaxUntrackedBytes,
  deadlineAtMs = Infinity,
  nowFn = Date.now,
  sleepFn = sleepSync,
  listOwners = listRepoGitProcesses,
  log = console.log,
  error = console.error,
}) => {
  const result = {
    code: "ok",
    outcome: "ok",
    exitCode: 0,
    detail: "",
    paths: [],
    committed: false,
    pushed: false,
    pushedSha: "",
    shortHash: "",
    integration: "none",
    skippedStaged: 0,
    staleState: null,
    liveTreeBehind: null,
    heldBack: null,
    singleFile: Boolean(filePath),
  };

  const run = (args, opts = {}) => {
    let delayMs = kLockBackoffInitialMs;
    const giveUpAt = Math.min(nowFn() + kLockBackoffTotalMs, deadlineAtMs);
    for (;;) {
      const remainingMs = deadlineAtMs - nowFn();
      if (remainingMs <= 0) {
        throw new GitSyncStop("deadline_exceeded", `ran out of time before git ${args[0]}`);
      }
      try {
        return String(
          git(args, Number.isFinite(remainingMs) ? { ...opts, timeoutMs: remainingMs } : opts) ?? "",
        );
      } catch (gitError) {
        if (opts.bytes && gitError && typeof gitError === "object") {
          for (const stream of ["stderr", "stdout"]) {
            if (typeof gitError[stream] === "string") gitError[stream] = fromPathBytes(gitError[stream]);
          }
        }
        if (gitError?.code === "ETIMEDOUT") {
          throw new GitSyncStop("deadline_exceeded", `git ${args[0]} did not finish in time`);
        }
        const lockMatch = kLockContentionPattern.exec(describeGitError(gitError));
        if (!lockMatch) throw gitError;
        if (nowFn() + delayMs > giveUpAt) {
          const lockAge = ageSeconds(fsModule, lockMatch[1], nowFn());
          throw new GitSyncStop(
            "index_locked",
            `${lockMatch[1]} stayed in place${lockAge === null ? "" : ` (${lockAge}s old)`}`,
            { paths: [lockMatch[1]] },
          );
        }
        sleepFn(delayMs);
        delayMs = Math.min(delayMs * 2, kLockBackoffMaxMs);
      }
    }
  };
  const tryRun = (args, opts) => {
    try {
      return run(args, opts);
    } catch (runError) {
      if (runError instanceof GitSyncStop) throw runError;
      return null;
    }
  };
  const isAncestor = (ancestor, descendant) => {
    try {
      run(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (runError) {
      if (runError?.status === 1) return false;
      throw runError;
    }
  };

  try {
    const version = parseGitVersion(tryRun(["--version"]));
    const gitDir = path.resolve(openclawDir, String(tryRun(["rev-parse", "--git-dir"]) || "").trim() || ".git");
    const assertNoOperation = () => {
      const found = findOperationMarker(fsModule, gitDir);
      if (!found) return;
      const staleState = {
        marker: found.marker,
        ageSeconds: ageSeconds(fsModule, found.markerPath, nowFn()),
        owners: listOwners({ openclawDir, fsModule }),
      };
      throw new GitSyncStop(
        "in_progress_operation",
        `${openclawDir} has an in-progress git operation${formatStaleState(staleState)}. The sync did not touch it.`,
        { staleState },
      );
    };

    assertNoOperation();
    const unmergedBefore = listUnmergedPaths(run);
    if (unmergedBefore.length > 0) {
      throw new GitSyncStop(
        "unmerged_paths",
        `${unmergedBefore.length} unmerged path(s) in ${openclawDir} (${unmergedBefore.slice(0, 3).join(", ")})`,
        { paths: unmergedBefore },
      );
    }

    const branch = String(tryRun(["symbolic-ref", "--short", "-q", "HEAD"]) || "").trim();
    if (!branch) {
      throw new GitSyncStop("detached_head", `${openclawDir} is not on a branch (detached HEAD)`);
    }

    if (String(tryRun(["remote", "get-url", "origin"]) || "").trim() !== originUrl) {
      run(["remote", "set-url", "origin", "--", originUrl]);
    }
    if (String(tryRun(["config", "--get", "user.name"]) || "").trim() !== "AlphaClaw Agent") {
      run(["config", "user.name", "AlphaClaw Agent"]);
    }
    if (String(tryRun(["config", "--get", "user.email"]) || "").trim() !== "agent@alphaclaw.md") {
      run(["config", "user.email", "agent@alphaclaw.md"]);
    }

    let remoteBranchExists = true;
    try {
      run(["ls-remote", "--exit-code", "--heads", "origin", "--", branch], { withAuth: true });
    } catch (lsRemoteError) {
      if (lsRemoteError instanceof GitSyncStop) throw lsRemoteError;
      if (lsRemoteError?.status !== 2) {
        throw new GitSyncStop("remote_unreachable", describeGitError(lsRemoteError));
      }
      remoteBranchExists = false;
      log(`[alphaclaw] Remote branch "${branch}" not found; it will be created`);
    }

    const headExists = () => tryRun(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) !== null;
    if (remoteBranchExists && !headExists()) {
      // Fresh local repo (onboarding's `git init -b main`) against a remote
      // that already has history: adopt the remote branch as our base
      // without touching the working tree, BEFORE committing, so the first
      // commit descends from it instead of starting an unrelated root.
      run(["fetch", "origin", "--", branch], { withAuth: true });
      run(["reset", "--mixed", "FETCH_HEAD"]);
      log(`[alphaclaw] Adopted remote ${branch} as the base for the first sync`);
    }

    // Paths git prints are relative to the repository's top level, which is
    // not the managed directory when .openclaw sits inside a larger
    // repository; add and commit therefore run from the top level. The scan
    // itself stays inside the managed directory (or the configured sync
    // paths), so nothing outside it is ever committed.
    //
    // Only paths git can take reach add and commit: an untracked file that
    // vanished after status, an untracked nested repository with no commit
    // checked out, and a deleted file whose path is now a folder each make
    // git refuse the WHOLE commit. Copies of the state directory and
    // secret-bearing state never reach it, whatever .gitignore says, and a
    // new file or folder above the size limit is held back and reported.
    const scope = ["--", ...(filePath ? [filePath] : syncPaths.length > 0 ? syncPaths : ["."])];
    const topLevel = String(tryRun(["rev-parse", "--show-toplevel"]) || "").trim() || openclawDir;
    const managedPrefix = String(tryRun(["rev-parse", "--show-prefix"], { bytes: true }) || "").replace(/\n$/, "");
    const toFsPath = (relativePath) =>
      Buffer.concat([Buffer.from(`${topLevel}${path.sep}`), Buffer.from(relativePath, "latin1")]);
    const lstat = (relativePath) => {
      try {
        return fsModule.lstatSync(toFsPath(relativePath));
      } catch {
        return null;
      }
    };
    const hasCommitCheckedOut = (relativePath) => {
      const display = fromPathBytes(relativePath);
      if (Buffer.from(display, "utf8").toString("latin1") !== relativePath) return false;
      return tryRun(["-C", path.join(topLevel, display), "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) !== null;
    };
    const readStatus = (untrackedMode) =>
      parseStatusEntries(
        run(
          ["status", "--porcelain=v1", "-z", "--no-renames", `--untracked-files=${untrackedMode}`, ...scope],
          { literalPathspecs: true, bytes: true },
        ),
      );
    const planCommit = () => {
      const status = readStatus("all");
      const isProtected = (relativePath) => isProtectedStatePath(relativePath, managedPrefix);
      const protectedPaths = status.candidates.filter(isProtected);
      const leftOut = [];
      let untracked = status.untracked.filter((relativePath) => {
        if (isProtected(relativePath) || !lstat(relativePath)) return false;
        if (relativePath.endsWith("/") && !hasCommitCheckedOut(relativePath)) {
          leftOut.push(relativePath);
          return false;
        }
        return true;
      });
      // `--untracked-files=normal` names each new file, or each wholly new
      // folder once: those are the units the size limit applies to.
      const heldBack = [];
      if (untracked.length > 0) {
        const roots = new Set(readStatus("normal").untracked);
        const rootOf = new Map();
        const rootBytes = new Map();
        for (const relativePath of untracked) {
          let root = roots.has(relativePath) ? relativePath : null;
          for (let slash = relativePath.indexOf("/"); !root && slash !== -1; slash = relativePath.indexOf("/", slash + 1)) {
            if (roots.has(relativePath.slice(0, slash + 1))) root = relativePath.slice(0, slash + 1);
          }
          if (!root) continue;
          rootOf.set(relativePath, root);
          rootBytes.set(root, (rootBytes.get(root) || 0) + (Number(lstat(relativePath)?.size) || 0));
        }
        const tooLarge = new Set([...rootBytes].filter(([, bytes]) => bytes > maxUntrackedBytes).map(([root]) => root));
        for (const root of tooLarge) heldBack.push({ path: fromPathBytes(root), bytes: rootBytes.get(root) });
        untracked = untracked.filter((relativePath) => !tooLarge.has(rootOf.get(relativePath)));
      }
      const deletedIntoFolder = new Set(
        status.deleted.filter((relativePath) => lstat(relativePath)?.isDirectory?.() === true),
      );
      leftOut.push(...deletedIntoFolder);
      const kept = new Set(untracked);
      const wasUntracked = new Set(status.untracked);
      return {
        candidates: status.candidates.filter((relativePath) =>
          wasUntracked.has(relativePath)
            ? kept.has(relativePath)
            : !deletedIntoFolder.has(relativePath) && !isProtected(relativePath),
        ),
        untracked,
        leftOut,
        protectedPaths,
        heldBack,
        skippedStaged: status.skippedStaged,
      };
    };
    const describePaths = (paths) =>
      `${paths.slice(0, 3).map(fromPathBytes).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
    for (let attempt = 1; ; attempt += 1) {
      const plan = planCommit();
      result.skippedStaged = plan.skippedStaged;
      result.heldBack = plan.heldBack;
      if (plan.protectedPaths.length > 0) {
        log(`[alphaclaw] git-sync never commits state copies or secrets; skipped ${plan.protectedPaths.length} path(s): ${describePaths(plan.protectedPaths)}`);
      }
      if (plan.leftOut.length > 0) {
        log(
          `[alphaclaw] git-sync left out ${plan.leftOut.length} path(s) git cannot commit (a nested repository with no commits, or a deleted file now replaced by a folder): ${describePaths(plan.leftOut)}`,
        );
      }
      if (plan.heldBack.length > 0) {
        log(`[alphaclaw] git-sync held back ${plan.heldBack.length} new path(s) over the size limit: ${describeHeldBack(plan.heldBack)}`);
      }
      if (plan.candidates.length === 0) {
        log("[alphaclaw] No changes to commit");
        break;
      }
      assertNoOperation();
      try {
        if (plan.untracked.length > 0) {
          run(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            input: toNulList(plan.untracked),
            literalPathspecs: true,
            bytes: true,
            cwd: topLevel,
          });
        }
        run(
          ["commit", "--only", "-m", commitMessage, "--pathspec-from-file=-", "--pathspec-file-nul"],
          { input: toNulList(plan.candidates), literalPathspecs: true, bytes: true, cwd: topLevel },
        );
        result.committed = true;
        result.paths = plan.candidates.slice(0, kMaxReportedPaths).map(fromPathBytes);
      } catch (commitError) {
        if (commitError instanceof GitSyncStop) throw commitError;
        const gitMessage = describeGitError(commitError);
        if (/nothing to commit|no changes added/i.test(gitMessage)) {
          log("[alphaclaw] No changes to commit");
        } else if (attempt < kCommitAttempts && kPathspecMismatchPattern.test(gitMessage)) {
          log("[alphaclaw] A file changed while the sync was committing; reading the working tree again");
          continue;
        } else {
          throw commitError;
        }
      }
      break;
    }

    if (!headExists()) return finish(result, { log, error, githubRepo });
    const local = run(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    let target = local;

    if (!remoteBranchExists) {
      try {
        run(["push", "origin", "--", `${local}:refs/heads/${branch}`], { withAuth: true });
      } catch (pushError) {
        if (pushError instanceof GitSyncStop) throw pushError;
        throw new GitSyncStop("push_failed", describeGitError(pushError));
      }
      result.pushed = true;
      result.pushedSha = local;
      result.integration = "push";
    } else {
      for (let attempt = 1; ; attempt += 1) {
        run(["fetch", "origin", "--", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
          withAuth: true,
        });
        const remote = run(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]).trim();
        if (remote === local || isAncestor(local, remote)) {
          target = remote;
          result.integration = remote === local ? "none" : "ff";
          break;
        }
        let candidate = local;
        result.integration = "push";
        if (!isAncestor(remote, local)) {
          if (!supportsMergeTree(version)) {
            throw new GitSyncStop(
              "git_too_old",
              `origin/${branch} and the local branch diverged, and git ${version.major}.${version.minor} cannot merge without touching the working tree`,
            );
          }
          candidate = mergeWithoutWorktree({ run, local, remote, branch });
          result.integration = "merge";
        }
        try {
          run(["push", "origin", "--", `${candidate}:refs/heads/${branch}`], { withAuth: true });
        } catch (pushError) {
          if (pushError instanceof GitSyncStop) throw pushError;
          if (isPushRejectedByRace(pushError) && attempt < kPushAttempts) {
            log(`[alphaclaw] origin/${branch} moved during the sync; retrying (${attempt}/${kPushAttempts})`);
            continue;
          }
          throw new GitSyncStop("push_failed", describeGitError(pushError));
        }
        result.pushed = true;
        result.pushedSha = candidate;
        target = candidate;
        break;
      }
    }

    const head = run(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (head !== target && !isAncestor(target, head)) {
      assertNoOperation();
      try {
        run(["merge", "--ff-only", "--no-edit", target]);
      } catch (mergeError) {
        if (mergeError instanceof GitSyncStop) throw mergeError;
        const blocking = parseOverwrittenPaths(describeGitError(mergeError));
        result.liveTreeBehind = { paths: blocking.slice(0, kMaxReportedPaths) };
        result.code = "live_tree_behind";
        result.detail = blocking.length
          ? `local edits block the fast-forward: ${blocking.slice(0, 3).join(", ")}${blocking.length > 3 ? ` and ${blocking.length - 3} more` : ""}`
          : "the local branch moved during the sync; the next run integrates it";
      }
    }
    result.shortHash = String(tryRun(["rev-parse", "--short", result.pushedSha || head]) || "").trim();
    return finish(result, { log, error, githubRepo });
  } catch (syncError) {
    if (syncError instanceof GitSyncStop) {
      result.code = syncError.syncCode;
      result.detail = syncError.detail;
      if (syncError.extra.paths) result.paths = syncError.extra.paths.slice(0, kMaxReportedPaths);
      if (syncError.extra.staleState) result.staleState = syncError.extra.staleState;
    } else {
      result.code = /unrelated histories/i.test(describeGitError(syncError)) ? "unrelated_histories" : "failed";
      result.detail = describeGitError(syncError);
    }
    return finish(result, { log, error, githubRepo });
  }
};

// merge-tree --write-tree (git >= 2.38) computes the merge in the object
// database only: no index, no working tree, no MERGE_HEAD. Both tips are the
// pinned SHAs; re-reading HEAD here would let a commit that landed in
// between be reverted by the merge.
const mergeWithoutWorktree = ({ run, local, remote, branch }) => {
  let output = "";
  try {
    output = run(["merge-tree", "--write-tree", "--name-only", "--no-messages", local, remote]);
  } catch (mergeError) {
    if (mergeError instanceof GitSyncStop || mergeError?.status !== 1) throw mergeError;
    const conflicted = String(mergeError.stdout || "").split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
    throw new GitSyncStop(
      "merge_conflict",
      `local changes and origin/${branch} conflict in ${conflicted.slice(0, 3).join(", ") || "some files"}${conflicted.length > 3 ? ` and ${conflicted.length - 3} more` : ""}; nothing was pushed and the working tree is untouched`,
      { paths: conflicted },
    );
  }
  const tree = output.split("\n")[0].trim();
  return run([
    "commit-tree",
    tree,
    "-p",
    local,
    "-p",
    remote,
    "-m",
    `sync: merge origin/${branch} (AlphaClaw)`,
  ]).trim();
};

const finish = (result, { log, error, githubRepo }) => {
  if (result.code === "ok" && result.heldBack?.length > 0) {
    result.code = "held_back";
    result.detail = `held back ${describeHeldBack(result.heldBack)}`;
  }
  const codeInfo = getGitSyncCode(result.code);
  result.outcome = codeInfo.outcome;
  result.exitCode = codeInfo.exitCode;
  if (result.outcome === "ok") {
    if (result.pushed && result.shortHash) {
      log(`[alphaclaw] Git sync complete (${result.shortHash})`);
      log(`[alphaclaw] Commit URL: https://github.com/${githubRepo}/commit/${result.shortHash}`);
    } else {
      log("[alphaclaw] Git sync complete (nothing to push)");
    }
    return result;
  }
  const line = `[alphaclaw] git-sync ${result.outcome} (${result.code}): ${codeInfo.headline}. ${result.detail}${codeInfo.action ? ` ${codeInfo.action}` : ""}`;
  if (result.outcome === "warning") log(line);
  else error(line);
  return result;
};

const listUnmergedPaths = (run) => {
  try {
    return String(run(["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (runError) {
    if (runError instanceof GitSyncStop) throw runError;
    return [];
  }
};

module.exports.performGitSync = performGitSync;
module.exports.hasInProgressRebase = hasInProgressRebase;
module.exports.parseStatusEntries = parseStatusEntries;
module.exports.listRepoGitProcesses = listRepoGitProcesses;
module.exports.isProtectedStatePath = isProtectedStatePath;
module.exports.kDefaultMaxUntrackedBytes = kDefaultMaxUntrackedBytes;
