const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../server/utils/safe-file");
const { acquireWriterLock } = require("./git-writer-lock");
const { getGitSyncCode, isGitSyncSuccess } = require("./git-sync-codes");

// Durable record of the latest git-sync run (issue #140): the CLI writes it
// on every run, the server turns a new failure episode into one notification
// and a Doctor card. It lives in the managed .alphaclaw dir, which the
// whitelist .gitignore keeps out of the synced repo.
//
// An episode is the run of consecutive failures since the last success;
// `firstFailureAt` names it. A warning (pushed, live tree behind) counts as
// a backup success but carries its own `liveTreeBehind.since` episode.
const kGitSyncStatusFileName = "git-sync-status.json";
const kStatusLockWaitSeconds = 5;

const resolveGitSyncStatusPath = (openclawDir) =>
  path.join(openclawDir, ".alphaclaw", kGitSyncStatusFileName);

const readGitSyncStatus = ({ statusPath, fsModule = fs }) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(statusPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const buildNextStatus = ({ previous, result, trigger, lock, nowIso }) => {
  const prev = previous || {};
  const code = result.code || "failed";
  const outcome = result.outcome || getGitSyncCode(code).outcome;
  const success = isGitSyncSuccess(outcome);
  const sameFailure = !success && prev.code === code;
  const prevBehind = prev.liveTreeBehind && typeof prev.liveTreeBehind === "object"
    ? prev.liveTreeBehind
    : null;
  let liveTreeBehind = prevBehind;
  if (result.liveTreeBehind) {
    liveTreeBehind = {
      since: prevBehind?.since || nowIso,
      paths: result.liveTreeBehind.paths || [],
      runs: (Number(prevBehind?.runs) || 0) + 1,
    };
  } else if (success) {
    liveTreeBehind = null;
  }
  return {
    version: 1,
    at: nowIso,
    attemptId: (Number(prev.attemptId) || 0) + 1,
    trigger,
    outcome,
    code,
    detail: String(result.detail || "").slice(0, 600),
    paths: Array.isArray(result.paths) ? result.paths.slice(0, 20) : [],
    shortHash: result.shortHash || "",
    committed: result.committed === true,
    pushed: result.pushed === true,
    integration: result.integration || "none",
    staleState: result.staleState || null,
    skippedStaged: Number(result.skippedStaged) || 0,
    lock,
    consecutiveFailures: success ? 0 : (Number(prev.consecutiveFailures) || 0) + 1,
    sameCodeRuns: success ? 0 : sameFailure ? (Number(prev.sameCodeRuns) || 0) + 1 : 1,
    firstFailureAt: success ? null : prev.firstFailureAt || nowIso,
    lastSuccessAt: success ? nowIso : prev.lastSuccessAt || null,
    lastPushedSha: result.pushed ? result.pushedSha || prev.lastPushedSha || "" : prev.lastPushedSha || "",
    liveTreeBehind,
  };
};

const recordGitSyncRun = ({
  openclawDir,
  result,
  trigger = "caller",
  lock = "acquired",
  fsModule = fs,
  nowFn = Date.now,
  acquireLock = acquireWriterLock,
}) => {
  const statusPath = resolveGitSyncStatusPath(openclawDir);
  let statusLock = null;
  try {
    fsModule.mkdirSync(path.dirname(statusPath), { recursive: true });
    statusLock = acquireLock({
      lockPath: `${statusPath}.lock`,
      waitSeconds: kStatusLockWaitSeconds,
      trigger,
      fsModule,
      recordHolder: false,
    });
    const next = buildNextStatus({
      previous: readGitSyncStatus({ statusPath, fsModule }),
      result,
      trigger,
      lock,
      nowIso: new Date(nowFn()).toISOString(),
    });
    writeFileAtomic(statusPath, `${JSON.stringify(next, null, 2)}\n`, {
      fsModule,
      mode: 0o600,
    });
    return next;
  } catch {
    return null;
  } finally {
    statusLock?.release?.();
  }
};

module.exports = {
  kGitSyncStatusFileName,
  resolveGitSyncStatusPath,
  readGitSyncStatus,
  buildNextStatus,
  recordGitSyncRun,
};
